"""Import checksum-verified Binance Vision aggregate trades into replay archive."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.trade_import import import_official_date_range  # noqa: E402


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
            "Import Binance official public aggTrades after mandatory SHA-256 "
            "verification. End date is inclusive."
        )
    )
    parser.add_argument("--exchange", default="binance", choices=("binance",))
    parser.add_argument("--market-type", required=True, choices=("futures",))
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start", required=True, type=_date)
    parser.add_argument("--end", required=True, type=_date)
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--require-checksum", action="store_true")
    parser.add_argument("--max-rows-per-file", type=int, default=100_000)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.max_rows_per_file < 1:
        raise SystemExit("--max-rows-per-file must be positive")
    report = import_official_date_range(
        archive_dir=args.archive_dir,
        exchange=args.exchange,
        market_type=args.market_type,
        symbol=args.symbol,
        start=args.start,
        end=args.end,
        require_checksum=args.require_checksum,
        max_rows_per_file=args.max_rows_per_file,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
