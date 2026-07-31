"""Build a revision-bound exact BAR/aggTrade random-selection index."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.storage.raw_trade_archive import (  # noqa: E402
    ParquetRawAggTradeArchive,
)
from app.replay.history_archive import ReplayHistoryRepository  # noqa: E402
from app.replay.trade_audit import inclusive_date_bounds  # noqa: E402
from app.replay.trade_compatibility import (  # noqa: E402
    build_trade_bar_compatibility,
)


def _date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("date must use canonical YYYY-MM-DD")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Audit aggTrade-derived BARs against one immutable replay BAR "
            "revision and publish compact compatible ranges."
        )
    )
    parser.add_argument("--exchange", required=True, choices=("binance",))
    parser.add_argument("--market-type", required=True, choices=("futures",))
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--start", required=True, type=_date)
    parser.add_argument("--end", required=True, type=_date)
    parser.add_argument("--trade-archive-dir", required=True, type=Path)
    parser.add_argument("--bar-archive-dir", required=True, type=Path)
    parser.add_argument("--bar-source-revision")
    parser.add_argument("--page-rows", type=int, default=50_000)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repository = ReplayHistoryRepository(args.bar_archive_dir.resolve())
    revision = args.bar_source_revision
    if revision is None:
        matches = [
            item
            for item in repository.list_all_series(custom_only=False)
            if (
                item["exchange"],
                item["market_type"],
                item["symbol"],
                item["interval"],
            )
            == (
                args.exchange,
                args.market_type,
                args.symbol.upper(),
                args.interval,
            )
        ]
        if len(matches) != 1 or not matches[0].get("source_revision"):
            raise SystemExit(
                "exactly one revision-bound BAR archive series is required"
            )
        revision = str(matches[0]["source_revision"])
    start_ms, end_ms = inclusive_date_bounds(args.start, args.end)
    archive = ParquetRawAggTradeArchive(
        args.trade_archive_dir.resolve(),
        max_scan_rows=5_000_000,
        max_physical_scan_rows=10_000_000,
    )
    report = build_trade_bar_compatibility(
        archive,
        repository,
        exchange=args.exchange,
        market_type=args.market_type,
        symbol=args.symbol,
        interval=args.interval,
        start_time_ms=start_ms,
        end_time_ms=end_ms,
        bar_source_revision=revision,
        page_rows=args.page_rows,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
