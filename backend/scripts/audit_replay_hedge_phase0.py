"""Create a read-only Phase 0 replay data and recovery-scope inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "replay.hedge-phase0.data-inventory.v1"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _path_entry(path: Path) -> dict[str, object]:
    resolved = path.resolve()
    if not resolved.exists():
        return {"path": str(resolved), "exists": False}
    stat = resolved.stat()
    entry: dict[str, object] = {
        "path": str(resolved),
        "exists": True,
        "kind": "directory" if resolved.is_dir() else "file",
        "size_bytes": stat.st_size if resolved.is_file() else None,
        "modified_at_ns": stat.st_mtime_ns,
    }
    if resolved.is_file():
        entry["sha256"] = _sha256_file(resolved)
    return entry


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _scalar(connection: sqlite3.Connection, sql: str) -> object:
    row = connection.execute(sql).fetchone()
    return None if row is None else row[0]


def inspect_replay_database(path: Path) -> dict[str, object]:
    resolved = path.resolve()
    entry = _path_entry(resolved)
    if not resolved.is_file():
        return {**entry, "sqlite": None, "sidecars": []}

    uri = f"file:{resolved.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=5) as connection:
        connection.execute("PRAGMA query_only = ON")
        quick_check = [str(row[0]) for row in connection.execute("PRAGMA quick_check")]
        foreign_key_rows = [
            list(row) for row in connection.execute("PRAGMA foreign_key_check")
        ]
        training_schema = (
            _scalar(
                connection,
                "SELECT version FROM replay_training_schema_version WHERE singleton = 1",
            )
            if _table_exists(connection, "replay_training_schema_version")
            else None
        )
        run_count = (
            int(_scalar(connection, "SELECT COUNT(*) FROM replay_training_run") or 0)
            if _table_exists(connection, "replay_training_run")
            else 0
        )
        session_count = (
            int(_scalar(connection, "SELECT COUNT(*) FROM replay_session") or 0)
            if _table_exists(connection, "replay_session")
            else 0
        )
        position_modes: dict[str, int] = {}
        if _table_exists(connection, "replay_training_rule"):
            for mode, count in connection.execute(
                """
                SELECT COALESCE(json_extract(rule_json, '$.position_mode'), 'LEGACY_UNSPECIFIED'),
                       COUNT(*)
                FROM replay_training_rule
                GROUP BY 1
                ORDER BY 1
                """
            ):
                position_modes[str(mode)] = int(count)
        run_rows: list[dict[str, object]] = []
        if _table_exists(connection, "replay_training_run"):
            for run_id, name, state, created_at_ms in connection.execute(
                """
                SELECT run_id, name, state, created_at_ms
                FROM replay_training_run
                ORDER BY created_at_ms, run_id
                """
            ):
                run_rows.append(
                    {
                        "run_id": str(run_id),
                        "name": str(name),
                        "state": str(state),
                        "created_at_ms": int(created_at_ms),
                    }
                )

    sidecars = [_path_entry(Path(f"{resolved}{suffix}")) for suffix in ("-wal", "-shm")]
    return {
        **entry,
        "sqlite": {
            "quick_check": quick_check,
            "foreign_key_violation_count": len(foreign_key_rows),
            "training_schema_version": training_schema,
            "run_count": run_count,
            "session_count": session_count,
            "position_mode_rule_counts": position_modes,
            "explicit_hedge_rule_count": position_modes.get("HEDGE", 0),
            "runs": run_rows,
        },
        "sidecars": sidecars,
    }


def inspect_archive_root(label: str, path: Path) -> dict[str, object]:
    resolved = path.resolve()
    if not resolved.exists():
        return {"label": label, "path": str(resolved), "exists": False}
    if not resolved.is_dir():
        raise ValueError(f"archive root is not a directory: {resolved}")

    digest = hashlib.sha256()
    count = 0
    total = 0
    for item in sorted(
        (candidate for candidate in resolved.rglob("*") if candidate.is_file()),
        key=lambda candidate: candidate.relative_to(resolved).as_posix(),
    ):
        relative = item.relative_to(resolved).as_posix()
        stat = item.stat()
        count += 1
        total += stat.st_size
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
        digest.update(b"\n")
    return {
        "label": label,
        "path": str(resolved),
        "exists": True,
        "file_count": count,
        "size_bytes": total,
        "metadata_inventory_sha256": f"sha256:{digest.hexdigest()}",
        "content_hash_scope": "PATH_SIZE_MTIME_ONLY",
    }


def build_inventory(
    *,
    replay_database: Path,
    archive_roots: list[tuple[str, Path]],
    captured_at: str,
) -> dict[str, object]:
    database = inspect_replay_database(replay_database)
    roots = [inspect_archive_root(label, path) for label, path in archive_roots]
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "captured_at": captured_at,
        "read_only": True,
        "replay_database": database,
        "archive_roots": roots,
        "migration_gate": {
            "explicit_hedge_rule_count": (
                database.get("sqlite", {}).get("explicit_hedge_rule_count", 0)
                if isinstance(database.get("sqlite"), dict)
                else 0
            ),
            "formal_hedge_runs_require_explicit_migration": True,
        },
        "recovery_scope": {
            "database_backup_method": "STOP_WRITERS_THEN_SQLITE_BACKUP_API_AND_SHA256",
            "database_files": [
                database["path"],
                *[sidecar["path"] for sidecar in database.get("sidecars", [])],
            ],
            "archive_roots": [root["path"] for root in roots if root.get("exists")],
            "restore_checks": [
                "SHA256_MATCH",
                "SQLITE_QUICK_CHECK_OK",
                "SQLITE_FOREIGN_KEY_CHECK_EMPTY",
                "TRAINING_SCHEMA_VERSION_MATCH",
                "RUN_AND_ARCHIVE_REF_COUNTS_MATCH",
            ],
            "phase0_action": "INVENTORY_ONLY_NO_COPY_NO_DELETE",
        },
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    payload["inventory_sha256"] = f"sha256:{hashlib.sha256(canonical).hexdigest()}"
    return payload


def _parse_archive_root(value: str) -> tuple[str, Path]:
    label, separator, raw_path = value.partition("=")
    if not separator or not label or not raw_path:
        raise argparse.ArgumentTypeError("archive root must use LABEL=PATH")
    return label, Path(raw_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay-db", type=Path, required=True)
    parser.add_argument(
        "--archive-root",
        action="append",
        type=_parse_archive_root,
        default=[],
        help="Repeatable LABEL=PATH replay archive root",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--captured-at",
        default=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = build_inventory(
        replay_database=args.replay_db,
        archive_roots=args.archive_root,
        captured_at=args.captured_at,
    )
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
