"""Verify and import one operator-captured exact account-history archive."""

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
from app.replay.training.account_history import (  # noqa: E402
    AccountHistoryArchiveManager,
)
from app.replay.training.storage import TrainingRunStore  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate an operator-captured one-way linear account-history SQLite "
            "archive, copy the exact object into replay-owned storage, and retain "
            "its checksum-bound manifest. Runtime use remains gated by "
            "REPLAY_ACCOUNT_HISTORY_ENABLED."
        )
    )
    parser.add_argument("--replay-db", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--archive-root", type=Path)
    parser.add_argument(
        "--max-archive-bytes",
        type=int,
        default=137_438_953_472,
        help="Aggregate local account-history storage budget (default: 128 GiB).",
    )
    return parser


async def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.max_archive_bytes < 1:
        raise ValueError("--max-archive-bytes must be positive")
    store = ReplaySQLiteStore(args.replay_db.resolve())
    training = TrainingRunStore(store)
    try:
        await training.start()
        manager = AccountHistoryArchiveManager(
            store,
            enabled=True,
            max_archive_bytes=args.max_archive_bytes,
            root=None if args.archive_root is None else args.archive_root.resolve(),
        )
        await manager.start()
        archive = await manager.import_archive(
            args.archive.resolve(),
            trusted_origin="OPERATOR_VERIFIED_CAPTURE",
        )
        inventory = await manager.list_archives()
        items = inventory["items"]
        if not isinstance(items, list):
            raise TypeError("account-history inventory items must be a list")
        return {
            "protocol": "replay.account-history.import.v1",
            "archive": archive,
            "inventory_summary": {
                "feature_enabled": inventory["feature_enabled"],
                "max_archive_bytes": inventory["max_archive_bytes"],
                "archive_count": len(items),
                "ready_archive_count": sum(
                    1
                    for item in items
                    if isinstance(item, dict) and item.get("health") == "READY"
                ),
                "total_bytes": sum(
                    int(item["byte_size"])
                    for item in items
                    if isinstance(item, dict)
                ),
            },
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
