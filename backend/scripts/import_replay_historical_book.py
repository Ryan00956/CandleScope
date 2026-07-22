"""Verify and import one operator-captured historical L2 archive."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.storage import ReplaySQLiteStore  # noqa: E402
from app.replay.training.historical_book import (  # noqa: E402
    HistoricalBookArchiveManager,
)
from app.replay.training.storage import TrainingRunStore  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate Binance USD-M snapshot/diff-depth continuity, copy the exact "
            "SQLite object into replay-owned storage, and retain a checksum-bound "
            "rehydration manifest."
        )
    )
    parser.add_argument("--replay-db", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--archive-root", type=Path)
    parser.add_argument(
        "--max-archive-bytes",
        type=int,
        default=1_099_511_627_776,
        help="Aggregate local historical-book storage budget (default: 1 TiB).",
    )
    parser.add_argument(
        "--trusted-origin",
        default="OPERATOR_VERIFIED_CAPTURE",
        help="Bounded provenance label stored with the immutable manifest.",
    )
    return parser


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.max_archive_bytes < 1:
        raise ValueError("--max-archive-bytes must be positive")
    store = ReplaySQLiteStore(args.replay_db.resolve())
    training = TrainingRunStore(store)
    try:
        await training.start()
        manager = HistoricalBookArchiveManager(
            store,
            enabled=True,
            max_archive_bytes=args.max_archive_bytes,
            root=None if args.archive_root is None else args.archive_root.resolve(),
        )
        await manager.start()
        archive = await manager.import_archive(
            args.archive.resolve(),
            trusted_origin=args.trusted_origin,
        )
        inventory = await manager.list_archives()
        return {
            "protocol": "replay.historical-book.import.v1",
            "archive": archive,
            "inventory_summary": inventory["summary"],
        }
    finally:
        await store.close()


def main() -> int:
    args = build_parser().parse_args()
    result = asyncio.run(_run(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
