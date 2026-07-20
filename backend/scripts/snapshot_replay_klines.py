"""Create a consistent replay K-line snapshot with SQLite online backup."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


class SnapshotError(RuntimeError):
    """Raised before an unsafe or invalid snapshot can be published."""


@dataclass(frozen=True, slots=True)
class SnapshotResult:
    source: Path
    destination: Path
    quick_check: str
    size_bytes: int


def _same_file(left: Path, right: Path) -> bool:
    if left == right:
        return True
    if left.exists() and right.exists():
        return os.path.samefile(left, right)
    return False


def _read_only_sqlite_uri(path: Path) -> str:
    return f"{path.as_uri()}?mode=ro"


def _quick_check(connection: sqlite3.Connection) -> str:
    rows = connection.execute("PRAGMA quick_check").fetchall()
    messages = [str(row[0]) for row in rows]
    if messages != ["ok"]:
        raise SnapshotError(
            "snapshot quick_check failed: " + "; ".join(messages or ["no result"])
        )
    return "ok"


def create_snapshot(
    source: str | Path,
    destination: str | Path,
    *,
    require_quick_check: bool = False,
    overwrite: bool = False,
) -> SnapshotResult:
    """Back up ``source`` and atomically publish a verified destination.

    ``quick_check`` is unconditional. ``require_quick_check`` exists so
    operational commands can record that expectation explicitly without ever
    creating a bypass when it is omitted.
    """

    del require_quick_check
    source_path = Path(source).expanduser().resolve()
    destination_path = Path(destination).expanduser().resolve()

    if not source_path.is_file():
        raise SnapshotError(f"source database does not exist: {source_path}")
    if _same_file(source_path, destination_path):
        raise SnapshotError("source and destination resolve to the same file")
    if destination_path.exists() and not overwrite:
        raise SnapshotError(f"destination already exists: {destination_path}")

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_handle = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{destination_path.name}.",
        suffix=".tmp",
        dir=destination_path.parent,
        delete=False,
    )
    temporary_path = Path(temporary_handle.name)
    temporary_handle.close()

    try:
        with closing(
            sqlite3.connect(
                _read_only_sqlite_uri(source_path),
                uri=True,
                timeout=30.0,
            )
        ) as source_connection, closing(
            sqlite3.connect(temporary_path, timeout=30.0)
        ) as target_connection:
            source_connection.backup(target_connection)
            target_connection.commit()
            quick_check = _quick_check(target_connection)

        with temporary_path.open("r+b") as snapshot_file:
            os.fsync(snapshot_file.fileno())

        # Recheck immediately before os.replace so the default no-overwrite
        # contract cannot silently clobber a destination created mid-backup.
        if destination_path.exists() and not overwrite:
            raise SnapshotError(f"destination already exists: {destination_path}")
        os.replace(temporary_path, destination_path)
        return SnapshotResult(
            source=source_path,
            destination=destination_path,
            quick_check=quick_check,
            size_bytes=destination_path.stat().st_size,
        )
    except SnapshotError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise SnapshotError(f"snapshot failed: {exc}") from exc
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            # The primary error remains authoritative. A leftover temp path is
            # named and never published, so a later operator can remove it.
            pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create a consistent, quick-checked replay K-line snapshot.",
    )
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument(
        "--require-quick-check",
        action="store_true",
        help="Record the explicit check requirement (the check always runs).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Atomically replace an existing destination after verification.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = create_snapshot(
            args.source,
            args.destination,
            require_quick_check=args.require_quick_check,
            overwrite=args.overwrite,
        )
    except SnapshotError as exc:
        _parser().exit(2, f"snapshot_replay_klines: error: {exc}\n")
    print(
        json.dumps(
            {
                "source": str(result.source),
                "destination": str(result.destination),
                "quick_check": result.quick_check,
                "size_bytes": result.size_bytes,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
