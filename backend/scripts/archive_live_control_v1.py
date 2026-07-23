"""Verify, checkpoint, and archive the WP-E Live control ledger for rollback."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
for source_root in (BACKEND_ROOT, SDK_SOURCE):
    source = str(source_root)
    if source not in sys.path:
        sys.path.insert(0, source)

from app.plugin_host.framing import strict_json_loads  # noqa: E402
from app.plugin_live_v2 import verify_live_audit_export  # noqa: E402
from app.plugin_live_v2.control import (  # noqa: E402
    LIVE_CONTROL_FILENAME,
    LiveControlLedger,
)
from app.plugin_live_v2.worker import BrokerDirectoryLock  # noqa: E402


MAX_AUDIT_EXPORT_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_SOURCE_BYTES = 256 * 1024 * 1024
ARCHIVE_MANIFEST_SCHEMA = "candlescope.live-control-archive/1"
_CHUNK_BYTES = 1024 * 1024


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _sha256_text(value: str) -> str:
    return _sha256_bytes(value.encode("utf-8"))


def _hash_stream(stream: BinaryIO) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while True:
        block = stream.read(_CHUNK_BYTES)
        if not block:
            break
        size += len(block)
        if size > MAX_ARCHIVE_SOURCE_BYTES:
            raise ValueError("Live control archive source exceeds its byte limit")
        digest.update(block)
    return size, f"sha256:{digest.hexdigest()}"


def _hash_file(path: Path) -> tuple[int, str]:
    with path.open("rb") as stream:
        return _hash_stream(stream)


def _read_audit_export(path: Path) -> tuple[bytes, dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Live audit export path is unsafe")
    payload = path.read_bytes()
    if not payload or len(payload) > MAX_AUDIT_EXPORT_BYTES:
        raise ValueError("Live audit export size is invalid")
    value = strict_json_loads(
        payload,
        max_message_bytes=MAX_AUDIT_EXPORT_BYTES,
    )
    return payload, verify_live_audit_export(value)


def _read_control_identity(path: Path) -> tuple[str, int]:
    uri = f"{path.as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5.0)
    try:
        row = connection.execute(
            """
            SELECT broker_id, policy_epoch
            FROM control_meta
            WHERE singleton = 1
            """
        ).fetchone()
    finally:
        connection.close()
    if (
        row is None
        or not isinstance(row[0], str)
        or not isinstance(row[1], int)
        or isinstance(row[1], bool)
        or row[1] < 0
    ):
        raise ValueError("Live control identity is invalid")
    return row[0], row[1]


def _copy_exclusive(source: Path, destination: Path) -> None:
    created = False
    try:
        with destination.open("xb") as output_stream:
            created = True
            with source.open("rb") as input_stream:
                shutil.copyfileobj(
                    input_stream,
                    output_stream,
                    length=_CHUNK_BYTES,
                )
            output_stream.flush()
            os.fsync(output_stream.fileno())
    except BaseException:
        if created:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def _verify_archive(
    archive_path: Path,
    manifest: dict[str, Any],
    audit_payload: bytes,
) -> None:
    expected_names = {"manifest.json", "live-audit-export.json"}
    expected_names.update(
        f"state/{item['name']}"
        for item in manifest["files"]
        if item["present"]
    )
    with zipfile.ZipFile(archive_path, "r") as archive:
        if set(archive.namelist()) != expected_names:
            raise ValueError("Live control archive members are invalid")
        encoded_manifest = archive.read("manifest.json")
        archived_manifest = strict_json_loads(
            encoded_manifest,
            max_message_bytes=1024 * 1024,
        )
        if archived_manifest != manifest:
            raise ValueError("Live control archive manifest is invalid")
        if archive.read("live-audit-export.json") != audit_payload:
            raise ValueError("Live control archive audit export is invalid")
        for item in manifest["files"]:
            if not item["present"]:
                continue
            with archive.open(f"state/{item['name']}", "r") as stream:
                size, digest = _hash_stream(stream)
            if size != item["size"] or digest != item["sha256"]:
                raise ValueError("Live control archive member digest is invalid")


def archive_live_control_ledger(
    root: Path | str,
    *,
    audit_export_path: Path | str,
    archive_path: Path | str,
    confirm_killed: bool = False,
    remove_source: bool = False,
) -> dict[str, Any]:
    """Archive one validated killed ledger while the Broker directory is locked."""

    if confirm_killed is not True:
        raise ValueError("explicit killed-state confirmation is required")
    broker_root = Path(root).expanduser().resolve(strict=False)
    audit_path = Path(audit_export_path).expanduser().resolve(strict=True)
    destination = Path(archive_path).expanduser().resolve(strict=False)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Live control archive path already exists")
    source_paths = tuple(
        broker_root / f"{LIVE_CONTROL_FILENAME}{suffix}"
        for suffix in ("", "-wal", "-shm")
    )
    main_path = source_paths[0]
    if main_path.is_symlink() or not main_path.is_file():
        raise ValueError("Live control ledger is unavailable")
    if audit_path in source_paths or destination in source_paths:
        raise ValueError("Live control archive paths overlap the ledger")
    audit_payload, verified = _read_audit_export(audit_path)
    control_status = verified["controlStatus"]
    if (
        control_status["mode"] != "killed"
        or control_status["outstandingConfirmationCount"] != 0
    ):
        raise ValueError("Live audit export does not prove a killed ledger")

    try:
        lock = BrokerDirectoryLock(broker_root)
        lock.__enter__()
    except OSError as exc:
        raise ValueError("Live Broker must be stopped before archive") from exc
    try:
        broker_id, policy_epoch = _read_control_identity(main_path)
        if (
            _sha256_text(broker_id) != verified["brokerIdSha256"]
            or policy_epoch != verified["policyEpoch"]
        ):
            raise ValueError("Live audit export does not match the ledger")
        ledger = LiveControlLedger(
            broker_root,
            broker_id=broker_id,
            policy_epoch=policy_epoch,
        )
        try:
            status = ledger.status()
            if status != control_status or status["mode"] != "killed":
                raise ValueError("Live control projection changed after export")
            checkpoint = ledger.connection.execute(
                "PRAGMA wal_checkpoint(TRUNCATE)"
            ).fetchone()
            if checkpoint is None or checkpoint[0] != 0:
                raise ValueError("Live control WAL checkpoint failed")
        finally:
            ledger.close()

        file_manifest: list[dict[str, Any]] = []
        for path in source_paths:
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise ValueError("Live control ledger path is unsafe")
            if path.exists():
                size, digest = _hash_file(path)
                file_manifest.append(
                    {
                        "name": path.name,
                        "present": True,
                        "size": size,
                        "sha256": digest,
                    }
                )
            else:
                file_manifest.append(
                    {
                        "name": path.name,
                        "present": False,
                        "size": 0,
                        "sha256": None,
                    }
                )
        manifest: dict[str, Any] = {
            "schemaVersion": ARCHIVE_MANIFEST_SCHEMA,
            "createdAt": _utc_now(),
            "sourceRootSha256": _sha256_text(str(broker_root)),
            "auditExportSha256": _sha256_bytes(audit_payload),
            "brokerIdSha256": verified["brokerIdSha256"],
            "policyEpoch": verified["policyEpoch"],
            "controlHead": verified["controlHead"],
            "sourceRemovalRequested": remove_source,
            "files": file_manifest,
        }
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(
            f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with zipfile.ZipFile(
                temporary,
                "x",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            ) as archive:
                archive.writestr(
                    "manifest.json",
                    json.dumps(
                        manifest,
                        ensure_ascii=True,
                        allow_nan=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                    + b"\n",
                )
                archive.writestr(
                    "live-audit-export.json",
                    audit_payload,
                )
                for path, item in zip(source_paths, file_manifest, strict=True):
                    if item["present"]:
                        archive.write(path, f"state/{path.name}")
            with temporary.open("r+b") as stream:
                stream.flush()
                os.fsync(stream.fileno())
            try:
                _copy_exclusive(temporary, destination)
                _verify_archive(destination, manifest, audit_payload)
            except BaseException:
                try:
                    destination.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
        finally:
            temporary.unlink(missing_ok=True)

        removed: list[str] = []
        if remove_source:
            for path, item in zip(source_paths, file_manifest, strict=True):
                if item["present"] and _hash_file(path) != (
                    item["size"],
                    item["sha256"],
                ):
                    raise ValueError(
                        "Live control source changed during archive"
                    )
            for path in (source_paths[1], source_paths[2], source_paths[0]):
                if path.exists():
                    path.unlink()
                    removed.append(path.name)
            if any(path.exists() or path.is_symlink() for path in source_paths):
                raise ValueError("Live control source removal was incomplete")
        return {
            "schemaVersion": ARCHIVE_MANIFEST_SCHEMA,
            "archivePath": str(destination),
            "archiveSha256": _hash_file(destination)[1],
            "auditExportSha256": manifest["auditExportSha256"],
            "controlHead": verified["controlHead"],
            "policyEpoch": policy_epoch,
            "removedSourceFiles": sorted(removed),
        }
    finally:
        lock.__exit__(None, None, None)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--audit-export", required=True, type=Path)
    parser.add_argument("--archive-path", required=True, type=Path)
    parser.add_argument(
        "--confirm-killed",
        action="store_true",
        help="confirm that global kill was invoked before the Broker stopped",
    )
    parser.add_argument(
        "--confirm-remove-source",
        action="store_true",
        help="remove the checkpointed SQLite trio only after archive verification",
    )
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    result = archive_live_control_ledger(
        arguments.root,
        audit_export_path=arguments.audit_export,
        archive_path=arguments.archive_path,
        confirm_killed=arguments.confirm_killed,
        remove_source=arguments.confirm_remove_source,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
