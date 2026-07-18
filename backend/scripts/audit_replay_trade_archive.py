"""Audit an explicit raw aggTrade archive range for exact replay eligibility."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.trade_audit import audit_archive_path, exact_audit_passed  # noqa: E402


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
        description="Audit checksum, ID continuity and exact eligible windows."
    )
    parser.add_argument("--exchange", required=True, choices=("binance",))
    parser.add_argument("--market-type", required=True, choices=("futures",))
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start", required=True, type=_date)
    parser.add_argument("--end", required=True, type=_date)
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--page-rows", type=int, default=50_000)
    parser.add_argument("--require-exact", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.page_rows < 1 or args.page_rows > 50_000:
        raise SystemExit("--page-rows must be between 1 and 50000")
    try:
        report = audit_archive_path(
            args.archive_dir.resolve(),
            exchange=args.exchange,
            market_type=args.market_type,
            symbol=args.symbol,
            start=args.start,
            end=args.end,
            page_rows=args.page_rows,
        )
    except Exception as exc:
        report = {
            "schema_version": "replay-trade-archive-audit.v1",
            "identity": {
                "exchange": args.exchange,
                "market_type": args.market_type,
                "symbol": args.symbol.upper(),
            },
            "start": args.start.isoformat(),
            "end": args.end.isoformat(),
            "exact": False,
            "error": str(exc),
            "eligible_windows": [],
        }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if args.require_exact and not exact_audit_passed(report):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
