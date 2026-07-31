"""Audit one immutable replay-history catalog without touching live SQLite."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.history_archive import (  # noqa: E402
    ReplayHistoryArchiveError,
    ReplayHistoryRepository,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a replay-history manifest, summarize its continuity "
            "index, and optionally hash every referenced Parquet object."
        )
    )
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--exchange", default="binance")
    parser.add_argument("--market-type", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--source-revision")
    parser.add_argument("--verify-objects", action="store_true")
    parser.add_argument("--max-gap-samples", type=int, default=20)
    return parser


def audit(args: argparse.Namespace) -> dict[str, object]:
    if args.max_gap_samples < 0 or args.max_gap_samples > 1_000:
        raise ReplayHistoryArchiveError(
            "--max-gap-samples must be between 0 and 1000"
        )
    repository = ReplayHistoryRepository(args.archive_dir)
    summary = repository.describe_catalog(
        args.symbol,
        args.interval,
        exchange=args.exchange,
        market_type=args.market_type,
        source_revision=args.source_revision,
    )
    revision = str(summary["catalog_epoch"])
    gaps = repository.scan_gaps_at_revision(
        revision,
        args.symbol,
        args.interval,
        start_ms=int(summary["earliest_open_ms"]),
        end_ms=int(summary["latest_open_ms"]),
        exchange=args.exchange,
        market_type=args.market_type,
        limit=1,
    )
    object_verification = (
        repository.verify_catalog_objects(
            args.symbol,
            args.interval,
            exchange=args.exchange,
            market_type=args.market_type,
            source_revision=revision,
        )
        if args.verify_objects
        else {
            "catalog_epoch": revision,
            "verified": False,
            "reason": "object_hash_verification_not_requested",
        }
    )
    return {
        "schema_version": "replay-history-audit-report.v1",
        "archive_dir": str(args.archive_dir.expanduser().resolve()),
        "catalog": summary,
        "continuity": {
            "gap_count": gaps["gap_count"],
            "missing_bars": gaps["missing_bars"],
            "scanned_bars": gaps["scanned_bars"],
            "coverage_indexed": gaps["coverage_indexed"],
            "gap_samples": list(gaps["gaps"])[: args.max_gap_samples],
            "gap_samples_truncated": int(gaps["gap_count"])
            > args.max_gap_samples,
        },
        "objects": object_verification,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = audit(args)
    except (ReplayHistoryArchiveError, OSError, ValueError) as exc:
        parser.exit(2, f"audit_replay_history: error: {exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
