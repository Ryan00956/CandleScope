"""Remote replay-history control plane with an on-demand local object cache.

The remote index and immutable catalog manifests define the random-selection
domain.  Parquet presence under ``cache_root`` is deliberately ignored while
building that domain; objects are materialized only when a selected range is
read.  A filesystem origin is useful for an on-host mirror and tests, while an
HTTP(S) origin can point at the same directory layout in object storage.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .canonical import canonical_sha256
from .history_archive import (
    ReplayHistoryArchiveError,
    ReplayHistoryCatalogManifest,
    ReplayHistoryObject,
    ReplayHistoryRepository,
    _atomic_write_json,
    _catalog_directory,
    _digest_token,
    _file_sha256,
    _manifest_from_pointer,
    _manifest_key,
)


REPLAY_HISTORY_REMOTE_INDEX_SCHEMA_VERSION = "replay-history-remote-index.v1"
_MAX_REMOTE_INDEX_BYTES = 16 * 1024 * 1024
_MAX_REMOTE_MANIFEST_BYTES = 64 * 1024 * 1024


class ReplayHistoryOriginUnavailable(ReplayHistoryArchiveError):
    """The configured origin could not currently be reached."""


def _safe_relative_path(value: object, *, field_name: str) -> str:
    text = str(value)
    candidate = Path(text.replace("/", os.sep))
    if (
        not text
        or "\\" in text
        or candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in text.split("/"))
    ):
        raise ReplayHistoryArchiveError(f"{field_name} must be a safe relative path")
    return text


@dataclass(frozen=True, slots=True)
class ReplayRemoteCatalogEntry:
    exchange: str
    market_type: str
    symbol: str
    interval: str
    catalog_epoch: str
    manifest_path: str

    def to_dict(self) -> dict[str, str]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "interval": self.interval,
            "catalog_epoch": self.catalog_epoch,
            "manifest_path": self.manifest_path,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayRemoteCatalogEntry":
        expected = {
            "exchange",
            "market_type",
            "symbol",
            "interval",
            "catalog_epoch",
            "manifest_path",
        }
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "remote replay-history catalog entry fields are incompatible"
            )
        value = cls(
            exchange=str(payload["exchange"]),
            market_type=str(payload["market_type"]),
            symbol=str(payload["symbol"]),
            interval=str(payload["interval"]),
            catalog_epoch=str(payload["catalog_epoch"]),
            manifest_path=_safe_relative_path(
                payload["manifest_path"], field_name="manifest_path"
            ),
        )
        if not value.catalog_epoch.startswith("sha256:") or len(value.catalog_epoch) != 71:
            raise ReplayHistoryArchiveError("remote catalog_epoch is invalid")
        try:
            int(value.catalog_epoch[7:], 16)
        except ValueError as exc:
            raise ReplayHistoryArchiveError("remote catalog_epoch is invalid") from exc
        expected_path = (
            f"catalogs/{value.exchange}/{value.market_type}/{value.symbol}/"
            f"{value.interval}/{_digest_token(value.catalog_epoch)}.json"
        )
        if value.manifest_path != expected_path:
            raise ReplayHistoryArchiveError(
                "remote replay-history manifest path does not match its identity"
            )
        return value


@dataclass(frozen=True, slots=True)
class ReplayRemoteCatalogIndex:
    index_epoch: str
    generated_at_ms: int
    catalogs: tuple[ReplayRemoteCatalogEntry, ...]

    def hash_payload(self) -> dict[str, object]:
        return {
            "schema_version": REPLAY_HISTORY_REMOTE_INDEX_SCHEMA_VERSION,
            "catalogs": [item.to_dict() for item in self.catalogs],
        }

    def to_dict(self) -> dict[str, object]:
        return {
            **self.hash_payload(),
            "index_epoch": self.index_epoch,
            "generated_at_ms": self.generated_at_ms,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayRemoteCatalogIndex":
        expected = {
            "schema_version",
            "index_epoch",
            "generated_at_ms",
            "catalogs",
        }
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "remote replay-history index fields are incompatible"
            )
        if payload["schema_version"] != REPLAY_HISTORY_REMOTE_INDEX_SCHEMA_VERSION:
            raise ReplayHistoryArchiveError(
                "remote replay-history index schema is incompatible"
            )
        raw_catalogs = payload["catalogs"]
        if not isinstance(raw_catalogs, list) or not raw_catalogs:
            raise ReplayHistoryArchiveError(
                "remote replay-history index must contain catalogs"
            )
        catalogs = tuple(
            ReplayRemoteCatalogEntry.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_remote("remote replay-history catalog entry must be an object")
            for item in raw_catalogs
        )
        if tuple(sorted(catalogs, key=_remote_entry_key)) != catalogs:
            raise ReplayHistoryArchiveError(
                "remote replay-history catalogs must be canonically ordered"
            )
        if len({_remote_entry_key(item) for item in catalogs}) != len(catalogs):
            raise ReplayHistoryArchiveError(
                "remote replay-history index contains duplicate catalogs"
            )
        generated_at_ms = payload["generated_at_ms"]
        if (
            isinstance(generated_at_ms, bool)
            or not isinstance(generated_at_ms, int)
            or generated_at_ms < 0
        ):
            raise ReplayHistoryArchiveError("remote generated_at_ms is invalid")
        index = cls(
            index_epoch=str(payload["index_epoch"]),
            generated_at_ms=generated_at_ms,
            catalogs=catalogs,
        )
        if canonical_sha256(index.hash_payload()) != index.index_epoch:
            raise ReplayHistoryArchiveError(
                "remote replay-history index does not match index_epoch"
            )
        return index


def _raise_remote(message: str):
    raise ReplayHistoryArchiveError(message)


def _remote_entry_key(item: ReplayRemoteCatalogEntry) -> tuple[str, str, str, str]:
    return (item.exchange, item.market_type, item.symbol, item.interval)


class ReplayHistoryOrigin:
    """Bounded reader for one filesystem or HTTP(S) archive root."""

    def __init__(self, uri: str | Path, *, timeout_seconds: float = 60.0) -> None:
        raw = str(uri).strip()
        if not raw:
            raise ValueError("replay-history origin URI cannot be empty")
        if timeout_seconds <= 0:
            raise ValueError("replay-history origin timeout must be positive")
        self.timeout_seconds = float(timeout_seconds)
        if isinstance(uri, Path) or (
            len(raw) >= 3 and raw[0].isalpha() and raw[1] == ":" and raw[2] in {"/", "\\"}
        ):
            self.kind = "file"
            self.root = Path(raw).expanduser().resolve()
            self.base_uri = self.root.as_uri().rstrip("/") + "/"
            return
        parsed = urllib.parse.urlparse(raw)
        if parsed.scheme.lower() in {"http", "https"}:
            self.kind = "http"
            self.base_uri = raw.rstrip("/") + "/"
            self.root: Path | None = None
        elif parsed.scheme.lower() == "file":
            path_text = urllib.request.url2pathname(parsed.path)
            if os.name == "nt" and path_text.startswith("/") and len(path_text) > 3:
                if path_text[2] == ":":
                    path_text = path_text[1:]
            self.kind = "file"
            self.root = Path(path_text).expanduser().resolve()
            self.base_uri = self.root.as_uri().rstrip("/") + "/"
        elif parsed.scheme:
            raise ValueError("replay-history origin URI must use file, http, or https")
        else:
            self.kind = "file"
            self.root = Path(raw).expanduser().resolve()
            self.base_uri = self.root.as_uri().rstrip("/") + "/"

    def read_json(self, relative_path: str, *, max_bytes: int) -> Mapping[str, object]:
        encoded = self.read_bytes(relative_path, max_bytes=max_bytes)
        try:
            payload = json.loads(encoded.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReplayHistoryArchiveError(
                "remote replay-history JSON is unreadable"
            ) from exc
        if not isinstance(payload, Mapping):
            raise ReplayHistoryArchiveError(
                "remote replay-history JSON root must be an object"
            )
        return payload

    def read_bytes(self, relative_path: str, *, max_bytes: int) -> bytes:
        relative = _safe_relative_path(relative_path, field_name="origin path")
        if max_bytes < 1:
            raise ValueError("remote read limit must be positive")
        if self.kind == "file":
            assert self.root is not None
            path = self._local_path(relative)
            try:
                stat = path.stat()
                if not path.is_file() or stat.st_size > max_bytes:
                    raise ReplayHistoryArchiveError(
                        "remote replay-history object exceeds its read limit"
                    )
                return path.read_bytes()
            except ReplayHistoryArchiveError:
                raise
            except OSError as exc:
                raise ReplayHistoryOriginUnavailable(
                    "remote replay-history origin is unavailable"
                ) from exc
        request = urllib.request.Request(
            urllib.parse.urljoin(
                self.base_uri,
                urllib.parse.quote(relative, safe="/"),
            ),
            headers={"Accept": "application/json", "User-Agent": "CandleScope-Replay/1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                content_length = response.headers.get("Content-Length")
                if content_length is not None:
                    try:
                        declared_length = int(content_length)
                    except ValueError as exc:
                        raise ReplayHistoryArchiveError(
                            "remote replay-history object length is invalid"
                        ) from exc
                    if declared_length > max_bytes:
                        raise ReplayHistoryArchiveError(
                            "remote replay-history object exceeds its read limit"
                        )
                value = response.read(max_bytes + 1)
        except ReplayHistoryArchiveError:
            raise
        except urllib.error.HTTPError as exc:
            if exc.code in {408, 425, 429} or exc.code >= 500:
                raise ReplayHistoryOriginUnavailable(
                    "remote replay-history origin is temporarily unavailable"
                ) from exc
            raise ReplayHistoryArchiveError(
                "remote replay-history origin rejected a required object"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ReplayHistoryOriginUnavailable(
                "remote replay-history origin is unavailable"
            ) from exc
        if len(value) > max_bytes:
            raise ReplayHistoryArchiveError(
                "remote replay-history object exceeds its read limit"
            )
        return value

    def fetch_object(
        self,
        relative_path: str,
        destination: Path,
        *,
        expected_size_bytes: int | None = None,
        max_bytes: int | None = None,
    ) -> None:
        relative = _safe_relative_path(relative_path, field_name="origin object path")
        for value, field_name in (
            (expected_size_bytes, "expected_size_bytes"),
            (max_bytes, "max_bytes"),
        ):
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 1
            ):
                raise ValueError(f"{field_name} must be a positive integer or null")
        if (
            expected_size_bytes is not None
            and max_bytes is not None
            and expected_size_bytes > max_bytes
        ):
            raise ReplayHistoryArchiveError(
                "remote replay-history object exceeds its configured size limit"
            )
        byte_limit = (
            expected_size_bytes
            if expected_size_bytes is not None
            else max_bytes
        )
        if self.kind == "file":
            source = self._local_path(relative)
            try:
                if not source.is_file() or source.is_symlink():
                    raise ReplayHistoryArchiveError(
                        "remote replay-history object is unavailable"
                    )
                source_size = source.stat().st_size
                if (
                    expected_size_bytes is not None
                    and source_size != expected_size_bytes
                ) or (max_bytes is not None and source_size > max_bytes):
                    raise ReplayHistoryArchiveError(
                        "remote replay-history object failed size/checksum validation"
                    )
                shutil.copyfile(source, destination)
                return
            except ReplayHistoryArchiveError:
                raise
            except OSError as exc:
                raise ReplayHistoryOriginUnavailable(
                    "remote replay-history object could not be copied"
                ) from exc
        request = urllib.request.Request(
            urllib.parse.urljoin(
                self.base_uri,
                urllib.parse.quote(relative, safe="/"),
            ),
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": "CandleScope-Replay/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                content_length_text = response.headers.get("Content-Length")
                if content_length_text is not None:
                    try:
                        content_length = int(content_length_text)
                    except ValueError as exc:
                        raise ReplayHistoryArchiveError(
                            "remote replay-history object length is invalid"
                        ) from exc
                    if (
                        expected_size_bytes is not None
                        and content_length != expected_size_bytes
                    ) or (max_bytes is not None and content_length > max_bytes):
                        raise ReplayHistoryArchiveError(
                            "remote replay-history object failed size/checksum validation"
                        )
                received = 0
                with destination.open("wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        received += len(chunk)
                        if byte_limit is not None and received > byte_limit:
                            raise ReplayHistoryArchiveError(
                                "remote replay-history object exceeds its size limit"
                            )
                        handle.write(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
                if (
                    expected_size_bytes is not None
                    and received != expected_size_bytes
                ):
                    raise ReplayHistoryArchiveError(
                        "remote replay-history object failed size/checksum validation"
                    )
        except urllib.error.HTTPError as exc:
            if exc.code in {408, 425, 429} or exc.code >= 500:
                raise ReplayHistoryOriginUnavailable(
                    "remote replay-history object download is temporarily unavailable"
                ) from exc
            raise ReplayHistoryArchiveError(
                "remote replay-history origin rejected a required object"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ReplayHistoryOriginUnavailable(
                "remote replay-history object download failed"
            ) from exc

    def _local_path(self, relative_path: str) -> Path:
        assert self.root is not None
        path = (self.root / Path(relative_path)).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise ReplayHistoryArchiveError(
                "remote replay-history path escapes the origin root"
            ) from exc
        return path


class RemoteReplayHistoryRepository(ReplayHistoryRepository):
    """Catalog-driven repository whose Parquet bodies are a disposable cache."""

    def __init__(
        self,
        cache_root: str | Path,
        origin_uri: str | Path,
        *,
        refresh_seconds: float = 300.0,
        download_timeout_seconds: float = 60.0,
    ) -> None:
        if refresh_seconds < 0:
            raise ValueError("remote replay-history refresh interval cannot be negative")
        cache = Path(cache_root).expanduser().resolve()
        self.origin = ReplayHistoryOrigin(
            origin_uri,
            timeout_seconds=download_timeout_seconds,
        )
        if self.origin.root is not None and self.origin.root == cache:
            raise ValueError("replay-history origin and local cache must be different")
        self._refresh_seconds = float(refresh_seconds)
        self._next_remote_refresh = 0.0
        self._remote_index_epoch: str | None = None
        self._remote_generated_at_ms: int | None = None
        self._remote_metadata_fallback = False
        self._object_locks_guard = threading.Lock()
        self._object_locks: dict[str, threading.Lock] = {}
        self._remote_metrics = {
            "remote_index_refreshes": 0,
            "remote_metadata_cache_fallbacks": 0,
            "object_cache_hits": 0,
            "object_downloads": 0,
            "object_download_bytes": 0,
            "object_download_failures": 0,
        }
        super().__init__(cache)

    def _refresh(self) -> None:
        now = time.monotonic()
        if self._current and now < self._next_remote_refresh:
            return
        try:
            index, manifests = self._load_origin_snapshot()
            self._cache_remote_snapshot(index, manifests)
            fallback = False
        except ReplayHistoryOriginUnavailable:
            index, manifests = self._load_cached_snapshot()
            fallback = True
        current: dict[tuple[str, str, str, str], ReplayHistoryCatalogManifest] = {}
        for manifest in manifests:
            key = _manifest_key(manifest)
            if key in current:
                raise ReplayHistoryArchiveError(
                    "remote replay-history index contains duplicate current catalogs"
                )
            self._validate_manifest_objects_shallow(manifest)
            current[key] = manifest
        with self._lock:
            self._current = current
            for key, manifest in current.items():
                self._revision_cache[(*key, manifest.catalog_epoch)] = manifest
            self._series_errors = {}
            self._remote_index_epoch = index.index_epoch
            self._remote_generated_at_ms = index.generated_at_ms
            self._remote_metadata_fallback = fallback
            self._next_remote_refresh = now + self._refresh_seconds
            self._metrics["refreshes"] += 1
            self._remote_metrics["remote_index_refreshes"] += 1
            if fallback:
                self._remote_metrics["remote_metadata_cache_fallbacks"] += 1

    def _load_origin_snapshot(
        self,
    ) -> tuple[ReplayRemoteCatalogIndex, tuple[ReplayHistoryCatalogManifest, ...]]:
        index = ReplayRemoteCatalogIndex.from_dict(
            self.origin.read_json("index.json", max_bytes=_MAX_REMOTE_INDEX_BYTES)
        )
        manifests: list[ReplayHistoryCatalogManifest] = []
        for entry in index.catalogs:
            manifest = ReplayHistoryCatalogManifest.from_dict(
                self.origin.read_json(
                    entry.manifest_path,
                    max_bytes=_MAX_REMOTE_MANIFEST_BYTES,
                )
            )
            if _manifest_key(manifest) != _remote_entry_key(entry):
                raise ReplayHistoryArchiveError(
                    "remote replay-history manifest identity does not match its index"
                )
            if manifest.catalog_epoch != entry.catalog_epoch:
                raise ReplayHistoryArchiveError(
                    "remote replay-history manifest revision does not match its index"
                )
            manifests.append(manifest)
        return index, tuple(manifests)

    def _cache_remote_snapshot(
        self,
        index: ReplayRemoteCatalogIndex,
        manifests: tuple[ReplayHistoryCatalogManifest, ...],
    ) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for manifest in manifests:
            directory = _catalog_directory(self.root, manifest.identity, manifest.interval)
            path = directory / f"{_digest_token(manifest.catalog_epoch)}.json"
            if path.is_file():
                existing = ReplayHistoryCatalogManifest.from_dict(
                    _read_local_json(path)
                )
                if existing.to_dict() != manifest.to_dict():
                    raise ReplayHistoryArchiveError(
                        "cached immutable replay-history manifest changed"
                    )
            else:
                _atomic_write_json(path, manifest.to_dict())
        metadata_dir = self.root / "remote-metadata"
        _atomic_write_json(
            metadata_dir / f"{_digest_token(index.index_epoch)}.json",
            index.to_dict(),
        )
        _atomic_write_json(metadata_dir / "current.json", index.to_dict())

    def _load_cached_snapshot(
        self,
    ) -> tuple[ReplayRemoteCatalogIndex, tuple[ReplayHistoryCatalogManifest, ...]]:
        path = self.root / "remote-metadata" / "current.json"
        if not path.is_file():
            raise ReplayHistoryOriginUnavailable(
                "remote replay-history metadata is unavailable and no cache exists"
            )
        index = ReplayRemoteCatalogIndex.from_dict(_read_local_json(path))
        manifests: list[ReplayHistoryCatalogManifest] = []
        for entry in index.catalogs:
            manifest_path = self.root / Path(entry.manifest_path)
            if not manifest_path.is_file():
                raise ReplayHistoryOriginUnavailable(
                    "cached replay-history manifest is unavailable"
                )
            manifest = ReplayHistoryCatalogManifest.from_dict(
                _read_local_json(manifest_path)
            )
            if (
                _manifest_key(manifest) != _remote_entry_key(entry)
                or manifest.catalog_epoch != entry.catalog_epoch
            ):
                raise ReplayHistoryArchiveError(
                    "cached replay-history metadata failed validation"
                )
            manifests.append(manifest)
        return index, tuple(manifests)

    def _validate_manifest_objects_shallow(
        self,
        manifest: ReplayHistoryCatalogManifest,
    ) -> None:
        for item in manifest.objects:
            candidate = (self.root / item.relative_path).resolve()
            expected = (
                self.objects_dir
                / _digest_token(item.object_sha256)[:2]
                / f"{_digest_token(item.object_sha256)}.parquet"
            ).resolve()
            if candidate != expected:
                raise ReplayHistoryArchiveError(
                    "remote replay-history object path is not content-addressed"
                )

    def _object_path(self, item: ReplayHistoryObject) -> Path:
        candidate = (self.root / item.relative_path).resolve()
        expected = (
            self.objects_dir
            / _digest_token(item.object_sha256)[:2]
            / f"{_digest_token(item.object_sha256)}.parquet"
        ).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise ReplayHistoryArchiveError(
                "replay-history cache path escapes the cache root"
            ) from exc
        if candidate != expected or candidate.is_symlink():
            raise ReplayHistoryArchiveError(
                "replay-history cache path is not content-addressed"
            )
        if candidate.exists():
            if not candidate.is_file():
                raise ReplayHistoryArchiveError(
                    "replay-history cached object is not a regular file"
                )
            with self._lock:
                self._remote_metrics["object_cache_hits"] += 1
            return candidate
        token = _digest_token(item.object_sha256)
        with self._object_locks_guard:
            object_lock = self._object_locks.setdefault(token, threading.Lock())
        with object_lock:
            if candidate.is_file() and not candidate.is_symlink():
                with self._lock:
                    self._remote_metrics["object_cache_hits"] += 1
                return candidate
            candidate.parent.mkdir(parents=True, exist_ok=True)
            temporary_dir = self.root / "tmp"
            temporary_dir.mkdir(parents=True, exist_ok=True)
            temporary = temporary_dir / f".{token}.{uuid.uuid4().hex}.tmp"
            try:
                self.origin.fetch_object(
                    item.relative_path,
                    temporary,
                    expected_size_bytes=item.size_bytes,
                )
                stat = temporary.stat()
                if stat.st_size != item.size_bytes or _file_sha256(temporary) != item.object_sha256:
                    raise ReplayHistoryArchiveError(
                        "downloaded replay-history object failed size/checksum validation"
                    )
                os.replace(temporary, candidate)
                with self._lock:
                    self._remote_metrics["object_downloads"] += 1
                    self._remote_metrics["object_download_bytes"] += stat.st_size
            except BaseException:
                with self._lock:
                    self._remote_metrics["object_download_failures"] += 1
                raise
            finally:
                temporary.unlink(missing_ok=True)
        return candidate

    def diagnostics(self, *, redact_paths: bool = False) -> dict[str, object]:
        result = super().diagnostics(redact_paths=redact_paths)
        with self._lock:
            return {
                **result,
                "backend": "replay-history.remote-cache.v1",
                "origin_kind": self.origin.kind,
                "origin": "<redacted>" if redact_paths else self.origin.base_uri,
                "remote_index_epoch": self._remote_index_epoch,
                "remote_generated_at_ms": self._remote_generated_at_ms,
                "remote_metadata_fallback": self._remote_metadata_fallback,
                **self._remote_metrics,
            }


def publish_remote_history_index(
    origin_root: str | Path,
    *,
    now_ms: int | None = None,
) -> ReplayRemoteCatalogIndex:
    """Publish a checksum-bound index over every current catalog pointer."""

    root = Path(origin_root).expanduser().resolve()
    pointers = sorted((root / "catalogs").glob("*/*/*/*/current.json"))
    if not pointers:
        raise ReplayHistoryArchiveError(
            "cannot publish a remote index without current replay-history catalogs"
        )
    entries: list[ReplayRemoteCatalogEntry] = []
    for pointer in pointers:
        manifest = _manifest_from_pointer(pointer)
        manifest_path = (
            _catalog_directory(root, manifest.identity, manifest.interval)
            / f"{_digest_token(manifest.catalog_epoch)}.json"
        )
        entry = ReplayRemoteCatalogEntry(
            exchange=manifest.identity.exchange,
            market_type=manifest.identity.market_type,
            symbol=manifest.identity.symbol,
            interval=manifest.interval,
            catalog_epoch=manifest.catalog_epoch,
            manifest_path=manifest_path.relative_to(root).as_posix(),
        )
        # Round-trip through the strict parser so publisher and reader enforce
        # exactly the same path and digest contract.
        entries.append(ReplayRemoteCatalogEntry.from_dict(entry.to_dict()))
    catalogs = tuple(sorted(entries, key=_remote_entry_key))
    generated = int(time.time() * 1_000) if now_ms is None else int(now_ms)
    draft = ReplayRemoteCatalogIndex(
        index_epoch="sha256:" + "0" * 64,
        generated_at_ms=generated,
        catalogs=catalogs,
    )
    index = ReplayRemoteCatalogIndex(
        index_epoch=canonical_sha256(draft.hash_payload()),
        generated_at_ms=generated,
        catalogs=catalogs,
    )
    _atomic_write_json(root / "index.json", index.to_dict())
    return ReplayRemoteCatalogIndex.from_dict(index.to_dict())


def _read_local_json(path: Path) -> Mapping[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReplayHistoryArchiveError("cached replay-history JSON is unreadable") from exc
    if not isinstance(payload, Mapping):
        raise ReplayHistoryArchiveError(
            "cached replay-history JSON root must be an object"
        )
    return payload


__all__ = [
    "REPLAY_HISTORY_REMOTE_INDEX_SCHEMA_VERSION",
    "RemoteReplayHistoryRepository",
    "ReplayHistoryOrigin",
    "ReplayHistoryOriginUnavailable",
    "ReplayRemoteCatalogEntry",
    "ReplayRemoteCatalogIndex",
    "publish_remote_history_index",
]
