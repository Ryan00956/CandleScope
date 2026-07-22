"""Host-owned namespaced private storage with logical quotas and snapshots."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    canonical_dumps,
    canonical_sha256,
    loads_strict,
    normalize_json,
)

from .errors import CorePluginError, core_error


STORAGE_SCHEMA_VERSION = 1
SNAPSHOT_SCHEMA_VERSION = 1
DEFAULT_STORAGE_QUOTA_BYTES = 8 * 1024 * 1024
MAX_PLATFORM_QUOTA_BYTES = 64 * 1024 * 1024
MAX_SNAPSHOT_BYTES = MAX_PLATFORM_QUOTA_BYTES * 2
MAX_JSON_VALUE_BYTES = 256 * 1024
MAX_BLOB_BYTES = 192 * 1024
MAX_MIGRATION_OPERATIONS = 256
SNAPSHOT_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_SNAPSHOT_BYTES,
    max_depth=32,
    max_container_items=500_000,
    max_string_bytes=512 * 1024,
)
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _validate_name(value: str, label: str) -> str:
    if not isinstance(value, str) or _NAME.fullmatch(value) is None:
        raise core_error("PLUGIN_STORAGE_KEY_INVALID", f"{label} is invalid")
    return value


def _json_bytes(value: Any, *, label: str) -> tuple[Any, bytes]:
    normalized = normalize_json(value, path=label)
    encoded = canonical_dumps(normalized).encode("utf-8")
    if len(encoded) > MAX_JSON_VALUE_BYTES:
        raise core_error("PLUGIN_STORAGE_VALUE_TOO_LARGE", f"{label} is too large")
    return normalized, encoded


def _quota(value: int | None) -> int:
    selected = DEFAULT_STORAGE_QUOTA_BYTES if value is None else value
    if (
        isinstance(selected, bool)
        or not isinstance(selected, int)
        or not 1 <= selected <= MAX_PLATFORM_QUOTA_BYTES
    ):
        raise core_error("PLUGIN_STORAGE_QUOTA_INVALID", "storage quota is invalid")
    return selected


def _write_snapshot(path: Path, value: dict[str, Any]) -> None:
    payload = (canonical_dumps(value, limits=SNAPSHOT_JSON_LIMITS) + "\n").encode(
        "utf-8"
    )
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise core_error(
            "PLUGIN_STORAGE_SNAPSHOT_TOO_LARGE", "snapshot exceeds its size limit"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise core_error("PLUGIN_STORAGE_ROOT_UNSAFE", "snapshot root is a symlink")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        raise core_error(
            "PLUGIN_STORAGE_SNAPSHOT_FAILED", f"unable to write snapshot: {exc}"
        ) from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def _read_snapshot(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise core_error(
            "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot must be a regular file"
        )
    try:
        size = path.stat().st_size
        if not 0 < size <= MAX_SNAPSHOT_BYTES:
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot has an invalid size"
            )
        value = loads_strict(path.read_bytes(), limits=SNAPSHOT_JSON_LIMITS)
    except CorePluginError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise core_error(
            "PLUGIN_STORAGE_SNAPSHOT_INVALID", f"unable to read snapshot: {exc}"
        ) from exc
    if not isinstance(value, dict):
        raise core_error(
            "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot root must be an object"
        )
    return value


@dataclass(frozen=True, slots=True)
class StorageNamespace:
    plugin_id: str
    publisher_identity: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.plugin_id, str)
            or not self.plugin_id
            or len(self.plugin_id) > 128
            or not isinstance(self.publisher_identity, str)
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
        ):
            raise ValueError("private storage namespace identity is invalid")

    @property
    def publisher_key(self) -> str:
        return hashlib.sha256(self.publisher_identity.encode("utf-8")).hexdigest()[:32]

    def to_wire(self) -> dict[str, str]:
        return {
            "pluginId": self.plugin_id,
            "publisherIdentityHash": self.publisher_key,
        }


class PluginPrivateStorage:
    """SQLite-backed KV/document/blob namespaces never selected by plugin input."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        if self.root.exists() and self.root.is_symlink():
            raise core_error(
                "PLUGIN_STORAGE_ROOT_UNSAFE", "private storage root is a symlink"
            )
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks_guard = threading.Lock()
        self._locks: dict[tuple[str, str], threading.RLock] = {}

    def _lock(self, namespace: StorageNamespace) -> threading.RLock:
        key = (namespace.publisher_key, namespace.plugin_id)
        with self._locks_guard:
            return self._locks.setdefault(key, threading.RLock())

    def _directory(self, namespace: StorageNamespace) -> Path:
        directory = self.root / namespace.publisher_key / namespace.plugin_id
        expected_parent = (self.root / namespace.publisher_key).resolve(strict=False)
        if directory.resolve(strict=False).parent != expected_parent:
            raise core_error(
                "PLUGIN_STORAGE_NAMESPACE_INVALID", "storage namespace escaped its root"
            )
        if expected_parent.exists() and expected_parent.is_symlink():
            raise core_error(
                "PLUGIN_STORAGE_ROOT_UNSAFE", "publisher storage root is a symlink"
            )
        if directory.exists() and directory.is_symlink():
            raise core_error(
                "PLUGIN_STORAGE_ROOT_UNSAFE", "plugin storage root is a symlink"
            )
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _database_path(self, namespace: StorageNamespace) -> Path:
        return self._directory(namespace) / "storage-v1.sqlite"

    @contextmanager
    def _connection(self, namespace: StorageNamespace) -> Iterator[sqlite3.Connection]:
        path = self._database_path(namespace)
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise core_error(
                "PLUGIN_STORAGE_ROOT_UNSAFE", "storage database path is unsafe"
            )
        connection = sqlite3.connect(path, timeout=2.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_version INTEGER NOT NULL,
                    data_version INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO metadata(singleton, schema_version, data_version)
                    VALUES (1, 1, 0);
                CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY,
                    value_json BLOB NOT NULL,
                    logical_bytes INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    name TEXT PRIMARY KEY,
                    value_json BLOB NOT NULL,
                    revision INTEGER NOT NULL,
                    logical_bytes INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS blobs (
                    name TEXT PRIMARY KEY,
                    media_type TEXT NOT NULL,
                    content BLOB NOT NULL,
                    logical_bytes INTEGER NOT NULL
                );
                """
            )
            metadata = connection.execute(
                "SELECT schema_version FROM metadata WHERE singleton = 1"
            ).fetchone()
            if metadata is None or metadata["schema_version"] != STORAGE_SCHEMA_VERSION:
                raise core_error(
                    "PLUGIN_STORAGE_SCHEMA_INVALID",
                    "private storage schema is unsupported",
                )
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _usage(connection: sqlite3.Connection) -> int:
        return sum(
            int(
                connection.execute(
                    f"SELECT COALESCE(SUM(logical_bytes), 0) FROM {table}"
                ).fetchone()[0]
            )
            for table in ("kv", "documents", "blobs")
        )

    @staticmethod
    def _assert_quota(connection: sqlite3.Connection, quota_bytes: int) -> int:
        usage = PluginPrivateStorage._usage(connection)
        if usage > quota_bytes:
            raise core_error(
                "PLUGIN_STORAGE_QUOTA_EXCEEDED",
                "private storage logical quota would be exceeded",
                details={"usageBytes": usage, "quotaBytes": quota_bytes},
            )
        return usage

    def summary(
        self, namespace: StorageNamespace, *, quota_bytes: int | None = None
    ) -> dict[str, Any]:
        quota = _quota(quota_bytes)
        with self._lock(namespace), self._connection(namespace) as connection:
            counts = {
                table: int(
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                )
                for table in ("kv", "documents", "blobs")
            }
            data_version = int(
                connection.execute(
                    "SELECT data_version FROM metadata WHERE singleton = 1"
                ).fetchone()[0]
            )
            return {
                "usageBytes": self._usage(connection),
                "quotaBytes": quota,
                "dataVersion": data_version,
                "counts": counts,
            }

    def kv_get(self, namespace: StorageNamespace, key: str) -> dict[str, Any]:
        key = _validate_name(key, "KV key")
        with self._lock(namespace), self._connection(namespace) as connection:
            row = connection.execute(
                "SELECT value_json FROM kv WHERE key = ?", (key,)
            ).fetchone()
            return {
                "found": row is not None,
                **({"value": json.loads(row[0])} if row else {}),
            }

    def kv_put(
        self,
        namespace: StorageNamespace,
        key: str,
        value: Any,
        *,
        quota_bytes: int | None = None,
    ) -> dict[str, Any]:
        key = _validate_name(key, "KV key")
        normalized, encoded = _json_bytes(value, label="storage.kv.value")
        quota = _quota(quota_bytes)
        logical = len(key.encode("utf-8")) + len(encoded)
        with self._lock(namespace), self._connection(namespace) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "INSERT INTO kv(key, value_json, logical_bytes) VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, logical_bytes=excluded.logical_bytes",
                    (key, encoded, logical),
                )
                usage = self._assert_quota(connection, quota)
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return {
            "stored": True,
            "key": key,
            "value": normalized,
            "usageBytes": usage,
            "quotaBytes": quota,
        }

    def kv_delete(self, namespace: StorageNamespace, key: str) -> dict[str, Any]:
        key = _validate_name(key, "KV key")
        with self._lock(namespace), self._connection(namespace) as connection:
            cursor = connection.execute("DELETE FROM kv WHERE key = ?", (key,))
            return {"deleted": cursor.rowcount > 0, "key": key}

    def document_get(self, namespace: StorageNamespace, name: str) -> dict[str, Any]:
        name = _validate_name(name, "document name")
        with self._lock(namespace), self._connection(namespace) as connection:
            row = connection.execute(
                "SELECT value_json, revision FROM documents WHERE name = ?", (name,)
            ).fetchone()
            return {
                "found": row is not None,
                **(
                    {
                        "value": json.loads(row["value_json"]),
                        "revision": row["revision"],
                    }
                    if row
                    else {}
                ),
            }

    def document_put(
        self,
        namespace: StorageNamespace,
        name: str,
        value: Any,
        *,
        quota_bytes: int | None = None,
        if_revision: int | None = None,
    ) -> dict[str, Any]:
        name = _validate_name(name, "document name")
        normalized, encoded = _json_bytes(value, label="storage.document.value")
        quota = _quota(quota_bytes)
        logical = len(name.encode("utf-8")) + len(encoded) + 8
        with self._lock(namespace), self._connection(namespace) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = connection.execute(
                    "SELECT revision FROM documents WHERE name = ?", (name,)
                ).fetchone()
                current_revision = int(current[0]) if current else 0
                if if_revision is not None and (
                    isinstance(if_revision, bool)
                    or not isinstance(if_revision, int)
                    or if_revision != current_revision
                ):
                    raise core_error(
                        "PLUGIN_STORAGE_REVISION_CONFLICT",
                        "document revision does not match",
                        details={"currentRevision": current_revision},
                    )
                revision = current_revision + 1
                connection.execute(
                    "INSERT INTO documents(name, value_json, revision, logical_bytes) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json, revision=excluded.revision, logical_bytes=excluded.logical_bytes",
                    (name, encoded, revision, logical),
                )
                usage = self._assert_quota(connection, quota)
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return {
            "stored": True,
            "name": name,
            "value": normalized,
            "revision": revision,
            "usageBytes": usage,
            "quotaBytes": quota,
        }

    def document_delete(self, namespace: StorageNamespace, name: str) -> dict[str, Any]:
        name = _validate_name(name, "document name")
        with self._lock(namespace), self._connection(namespace) as connection:
            cursor = connection.execute("DELETE FROM documents WHERE name = ?", (name,))
            return {"deleted": cursor.rowcount > 0, "name": name}

    def blob_get(self, namespace: StorageNamespace, name: str) -> dict[str, Any]:
        name = _validate_name(name, "blob name")
        with self._lock(namespace), self._connection(namespace) as connection:
            row = connection.execute(
                "SELECT media_type, content FROM blobs WHERE name = ?", (name,)
            ).fetchone()
            return {
                "found": row is not None,
                **(
                    {
                        "mediaType": row["media_type"],
                        "base64": base64.b64encode(row["content"]).decode("ascii"),
                        "size": len(row["content"]),
                    }
                    if row
                    else {}
                ),
            }

    def blob_put(
        self,
        namespace: StorageNamespace,
        name: str,
        base64_value: str,
        media_type: str,
        *,
        quota_bytes: int | None = None,
    ) -> dict[str, Any]:
        name = _validate_name(name, "blob name")
        if (
            not isinstance(media_type, str)
            or not 1 <= len(media_type) <= 128
            or re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", media_type) is None
        ):
            raise core_error(
                "PLUGIN_STORAGE_VALUE_INVALID", "blob media type is invalid"
            )
        try:
            content = base64.b64decode(base64_value, validate=True)
        except (ValueError, TypeError) as exc:
            raise core_error(
                "PLUGIN_STORAGE_VALUE_INVALID", "blob content is not canonical base64"
            ) from exc
        if len(content) > MAX_BLOB_BYTES:
            raise core_error(
                "PLUGIN_STORAGE_VALUE_TOO_LARGE", "blob exceeds the per-value limit"
            )
        quota = _quota(quota_bytes)
        logical = (
            len(name.encode("utf-8")) + len(media_type.encode("ascii")) + len(content)
        )
        with self._lock(namespace), self._connection(namespace) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "INSERT INTO blobs(name, media_type, content, logical_bytes) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET media_type=excluded.media_type, content=excluded.content, logical_bytes=excluded.logical_bytes",
                    (name, media_type, content, logical),
                )
                usage = self._assert_quota(connection, quota)
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return {
            "stored": True,
            "name": name,
            "size": len(content),
            "usageBytes": usage,
            "quotaBytes": quota,
        }

    def blob_delete(self, namespace: StorageNamespace, name: str) -> dict[str, Any]:
        name = _validate_name(name, "blob name")
        with self._lock(namespace), self._connection(namespace) as connection:
            cursor = connection.execute("DELETE FROM blobs WHERE name = ?", (name,))
            return {"deleted": cursor.rowcount > 0, "name": name}

    def list_names(
        self,
        namespace: StorageNamespace,
        kind: str,
        *,
        after: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        table, column = {
            "kv": ("kv", "key"),
            "document": ("documents", "name"),
            "blob": ("blobs", "name"),
        }.get(kind, (None, None))
        if table is None or column is None:
            raise core_error(
                "PLUGIN_STORAGE_KIND_INVALID", "storage list kind is invalid"
            )
        if after is not None:
            after = _validate_name(after, "storage cursor")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 256
        ):
            raise core_error(
                "PLUGIN_STORAGE_LIMIT_INVALID", "storage list limit is invalid"
            )
        with self._lock(namespace), self._connection(namespace) as connection:
            rows = connection.execute(
                f"SELECT {column} FROM {table} WHERE {column} > ? ORDER BY {column} LIMIT ?",
                (after or "", limit + 1),
            ).fetchall()
        names = [str(row[0]) for row in rows[:limit]]
        return {
            "items": names,
            "next": names[-1] if len(rows) > limit and names else None,
        }

    def _export_payload(self, connection: sqlite3.Connection) -> dict[str, Any]:
        return {
            "dataVersion": int(
                connection.execute(
                    "SELECT data_version FROM metadata WHERE singleton = 1"
                ).fetchone()[0]
            ),
            "kv": [
                {
                    "key": row["key"],
                    "value": json.loads(row["value_json"]),
                }
                for row in connection.execute(
                    "SELECT key, value_json FROM kv ORDER BY key"
                )
            ],
            "documents": [
                {
                    "name": row["name"],
                    "value": json.loads(row["value_json"]),
                    "revision": row["revision"],
                }
                for row in connection.execute(
                    "SELECT name, value_json, revision FROM documents ORDER BY name"
                )
            ],
            "blobs": [
                {
                    "name": row["name"],
                    "mediaType": row["media_type"],
                    "base64": base64.b64encode(row["content"]).decode("ascii"),
                }
                for row in connection.execute(
                    "SELECT name, media_type, content FROM blobs ORDER BY name"
                )
            ],
        }

    def _snapshot_path(self, namespace: StorageNamespace, snapshot_id: str) -> Path:
        return self._directory(namespace) / "snapshots" / f"{snapshot_id}.json"

    def _create_snapshot_locked(
        self, namespace: StorageNamespace, connection: sqlite3.Connection, *, label: str
    ) -> dict[str, Any]:
        if not isinstance(label, str) or not 1 <= len(label) <= 128:
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot label is invalid"
            )
        payload = self._export_payload(connection)
        snapshot_id = f"snapshot-{uuid.uuid4().hex}"
        document = {
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "snapshotId": snapshot_id,
            "namespace": namespace.to_wire(),
            "label": label,
            "createdAt": _utc_now(),
            "payloadSha256": canonical_sha256(payload, limits=SNAPSHOT_JSON_LIMITS),
            "payload": payload,
        }
        path = self._snapshot_path(namespace, snapshot_id)
        if path.parent.exists() and path.parent.is_symlink():
            raise core_error("PLUGIN_STORAGE_ROOT_UNSAFE", "snapshot root is a symlink")
        _write_snapshot(path, document)
        return {
            "snapshotId": snapshot_id,
            "createdAt": document["createdAt"],
            "dataVersion": payload["dataVersion"],
        }

    def create_snapshot(
        self, namespace: StorageNamespace, *, label: str
    ) -> dict[str, Any]:
        with self._lock(namespace), self._connection(namespace) as connection:
            return self._create_snapshot_locked(namespace, connection, label=label)

    def _load_snapshot(
        self, namespace: StorageNamespace, snapshot_id: str
    ) -> dict[str, Any]:
        if re.fullmatch(r"snapshot-[0-9a-f]{32}", snapshot_id) is None:
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot ID is invalid"
            )
        document = _read_snapshot(self._snapshot_path(namespace, snapshot_id))
        expected = {
            "schemaVersion",
            "snapshotId",
            "namespace",
            "label",
            "createdAt",
            "payloadSha256",
            "payload",
        }
        if (
            not isinstance(document, dict)
            or set(document) != expected
            or document["schemaVersion"] != SNAPSHOT_SCHEMA_VERSION
            or document["snapshotId"] != snapshot_id
            or document["namespace"] != namespace.to_wire()
            or canonical_sha256(document["payload"], limits=SNAPSHOT_JSON_LIMITS)
            != document["payloadSha256"]
        ):
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot integrity check failed"
            )
        return document

    def _replace_from_payload(
        self, connection: sqlite3.Connection, payload: dict[str, Any], quota_bytes: int
    ) -> None:
        if not isinstance(payload, dict) or set(payload) != {
            "dataVersion",
            "kv",
            "documents",
            "blobs",
        }:
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot payload shape is invalid"
            )
        connection.execute("DELETE FROM kv")
        connection.execute("DELETE FROM documents")
        connection.execute("DELETE FROM blobs")
        for item in payload["kv"]:
            self._put_kv_on_connection(connection, item["key"], item["value"])
        for item in payload["documents"]:
            self._put_document_on_connection(
                connection, item["name"], item["value"], revision=item["revision"]
            )
        for item in payload["blobs"]:
            self._put_blob_on_connection(
                connection, item["name"], item["base64"], item["mediaType"]
            )
        data_version = payload["dataVersion"]
        if (
            isinstance(data_version, bool)
            or not isinstance(data_version, int)
            or data_version < 0
        ):
            raise core_error(
                "PLUGIN_STORAGE_SNAPSHOT_INVALID", "snapshot data version is invalid"
            )
        connection.execute(
            "UPDATE metadata SET data_version = ? WHERE singleton = 1", (data_version,)
        )
        self._assert_quota(connection, quota_bytes)

    def restore_snapshot(
        self,
        namespace: StorageNamespace,
        snapshot_id: str,
        *,
        quota_bytes: int | None = None,
    ) -> dict[str, Any]:
        quota = _quota(quota_bytes)
        with self._lock(namespace):
            document = self._load_snapshot(namespace, snapshot_id)
            with self._connection(namespace) as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._replace_from_payload(connection, document["payload"], quota)
                    connection.execute("COMMIT")
                except BaseException:
                    connection.execute("ROLLBACK")
                    raise
        return {
            "restored": True,
            "snapshotId": snapshot_id,
            "dataVersion": document["payload"]["dataVersion"],
        }

    @staticmethod
    def _put_kv_on_connection(
        connection: sqlite3.Connection, key: str, value: Any
    ) -> None:
        key = _validate_name(key, "KV key")
        _, encoded = _json_bytes(value, label="storage.kv.value")
        connection.execute(
            "INSERT INTO kv(key, value_json, logical_bytes) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, logical_bytes=excluded.logical_bytes",
            (key, encoded, len(key.encode("utf-8")) + len(encoded)),
        )

    @staticmethod
    def _put_document_on_connection(
        connection: sqlite3.Connection,
        name: str,
        value: Any,
        *,
        revision: int | None = None,
    ) -> None:
        name = _validate_name(name, "document name")
        _, encoded = _json_bytes(value, label="storage.document.value")
        if revision is None:
            row = connection.execute(
                "SELECT revision FROM documents WHERE name = ?", (name,)
            ).fetchone()
            revision = (int(row[0]) if row else 0) + 1
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise core_error(
                "PLUGIN_STORAGE_REVISION_CONFLICT", "document revision is invalid"
            )
        connection.execute(
            "INSERT INTO documents(name, value_json, revision, logical_bytes) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json, revision=excluded.revision, logical_bytes=excluded.logical_bytes",
            (name, encoded, revision, len(name.encode("utf-8")) + len(encoded) + 8),
        )

    @staticmethod
    def _put_blob_on_connection(
        connection: sqlite3.Connection, name: str, base64_value: str, media_type: str
    ) -> None:
        name = _validate_name(name, "blob name")
        if (
            not isinstance(media_type, str)
            or re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", media_type) is None
        ):
            raise core_error(
                "PLUGIN_STORAGE_VALUE_INVALID", "blob media type is invalid"
            )
        try:
            content = base64.b64decode(base64_value, validate=True)
        except (ValueError, TypeError) as exc:
            raise core_error(
                "PLUGIN_STORAGE_VALUE_INVALID", "blob content is invalid"
            ) from exc
        if len(content) > MAX_BLOB_BYTES:
            raise core_error(
                "PLUGIN_STORAGE_VALUE_TOO_LARGE", "blob exceeds the per-value limit"
            )
        connection.execute(
            "INSERT INTO blobs(name, media_type, content, logical_bytes) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET media_type=excluded.media_type, content=excluded.content, logical_bytes=excluded.logical_bytes",
            (
                name,
                media_type,
                content,
                len(name.encode("utf-8"))
                + len(media_type.encode("ascii"))
                + len(content),
            ),
        )

    def migrate(
        self,
        namespace: StorageNamespace,
        *,
        expected_version: int,
        target_version: int,
        operations: list[dict[str, Any]],
        quota_bytes: int | None = None,
    ) -> dict[str, Any]:
        if (
            isinstance(expected_version, bool)
            or not isinstance(expected_version, int)
            or expected_version < 0
            or isinstance(target_version, bool)
            or not isinstance(target_version, int)
            or target_version <= expected_version
            or not isinstance(operations, list)
            or len(operations) > MAX_MIGRATION_OPERATIONS
        ):
            raise core_error(
                "PLUGIN_STORAGE_MIGRATION_INVALID", "migration metadata is invalid"
            )
        quota = _quota(quota_bytes)
        with self._lock(namespace), self._connection(namespace) as connection:
            current = int(
                connection.execute(
                    "SELECT data_version FROM metadata WHERE singleton = 1"
                ).fetchone()[0]
            )
            if current != expected_version:
                raise core_error(
                    "PLUGIN_STORAGE_MIGRATION_VERSION_CONFLICT",
                    "migration expected version does not match",
                    details={"currentVersion": current},
                )
            snapshot = self._create_snapshot_locked(
                namespace,
                connection,
                label=f"before-migration-{expected_version}-to-{target_version}",
            )
            connection.execute("BEGIN IMMEDIATE")
            try:
                for operation in operations:
                    self._apply_migration_operation(connection, operation)
                self._assert_quota(connection, quota)
                connection.execute(
                    "UPDATE metadata SET data_version = ? WHERE singleton = 1",
                    (target_version,),
                )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return {
            "migrated": True,
            "fromVersion": expected_version,
            "toVersion": target_version,
            "snapshotId": snapshot["snapshotId"],
        }

    def _apply_migration_operation(
        self, connection: sqlite3.Connection, operation: dict[str, Any]
    ) -> None:
        if not isinstance(operation, dict) or not isinstance(operation.get("op"), str):
            raise core_error(
                "PLUGIN_STORAGE_MIGRATION_INVALID", "migration operation is invalid"
            )
        kind = operation["op"]
        if kind == "putKv" and set(operation) == {"op", "key", "value"}:
            self._put_kv_on_connection(connection, operation["key"], operation["value"])
        elif kind == "deleteKv" and set(operation) == {"op", "key"}:
            connection.execute(
                "DELETE FROM kv WHERE key = ?",
                (_validate_name(operation["key"], "KV key"),),
            )
        elif kind == "putDocument" and set(operation) == {"op", "name", "value"}:
            self._put_document_on_connection(
                connection, operation["name"], operation["value"]
            )
        elif kind == "deleteDocument" and set(operation) == {"op", "name"}:
            connection.execute(
                "DELETE FROM documents WHERE name = ?",
                (_validate_name(operation["name"], "document name"),),
            )
        elif kind == "putBlob" and set(operation) == {
            "op",
            "name",
            "base64",
            "mediaType",
        }:
            self._put_blob_on_connection(
                connection,
                operation["name"],
                operation["base64"],
                operation["mediaType"],
            )
        elif kind == "deleteBlob" and set(operation) == {"op", "name"}:
            connection.execute(
                "DELETE FROM blobs WHERE name = ?",
                (_validate_name(operation["name"], "blob name"),),
            )
        else:
            raise core_error(
                "PLUGIN_STORAGE_MIGRATION_INVALID",
                "migration operation shape is invalid",
            )
