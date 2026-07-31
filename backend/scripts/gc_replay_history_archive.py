from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.archive_pins import persisted_bar_archive_reference  # noqa: E402
from app.replay.history_archive import (  # noqa: E402
    ReplayHistoryArchiveRuntimeLease,
    ReplayHistoryArchiveWriter,
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pin-aware replay-history mark-and-sweep garbage collection.",
    )
    parser.add_argument("--archive-dir", type=Path, required=True)
    parser.add_argument("--replay-db", type=Path, required=True)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="delete unreachable immutable manifests and objects",
    )
    return parser.parse_args()


def _pinned_revisions(path: Path) -> tuple[str, ...]:
    uri = f"{path.expanduser().resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        table = connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'replay_archive_pin'
            """
        ).fetchone()
        if table is None:
            raise RuntimeError(
                "replay_archive_pin is missing; garbage collection refused"
            )
        revisions = {
            str(row[0])
            for row in connection.execute(
                """
                SELECT DISTINCT source_revision
                FROM replay_archive_pin
                ORDER BY source_revision
                """
            ).fetchall()
        }
        for session_id, snapshot_ref_json, snapshot_blob in connection.execute(
            """
            SELECT session_id, snapshot_ref_json, snapshot_blob
            FROM replay_dataset_ref
            ORDER BY session_id
            """
        ).fetchall():
            try:
                reference = persisted_bar_archive_reference(
                    snapshot_ref_json,
                    snapshot_blob,
                    strict=True,
                )
            except ValueError as exc:
                raise RuntimeError(
                    f"session {session_id} has an invalid archive pin; "
                    "garbage collection refused"
                ) from exc
            if reference is not None:
                revisions.add(str(reference["source_revision"]))
        return tuple(sorted(revisions))


def main() -> int:
    args = _arguments()
    lease = (
        ReplayHistoryArchiveRuntimeLease(args.archive_dir)
        if args.apply
        else None
    )
    if lease is not None:
        lease.acquire()
    try:
        pins = _pinned_revisions(args.replay_db)
        report = ReplayHistoryArchiveWriter(args.archive_dir).collect_garbage(
            pinned_revisions=pins,
            dry_run=not args.apply,
        )
    finally:
        if lease is not None:
            lease.release()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
