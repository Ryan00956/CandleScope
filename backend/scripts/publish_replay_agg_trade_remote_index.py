"""Publish the lightweight remote verified-aggTrade receipt index."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.remote_trade_archive import (  # noqa: E402
    publish_remote_agg_trade_index,
    sync_official_agg_trade_availability,
)


def _date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("date must use canonical YYYY-MM-DD")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Optionally sync Binance's lightweight official daily availability, "
            "then build trade-index.json from availability and immutable receipts."
        )
    )
    parser.add_argument("--archive-dir", type=Path, required=True)
    parser.add_argument(
        "--sync-binance-symbol",
        action="append",
        default=[],
        metavar="SYMBOL",
        help="Sync one full USD-M futures aggTrade listing before publishing.",
    )
    parser.add_argument("--as-of-date", type=_date)
    parser.add_argument("--timeout-seconds", type=float, default=60.0)
    args = parser.parse_args()
    if args.timeout_seconds <= 0:
        raise SystemExit("--timeout-seconds must be positive")
    availability = []
    for symbol in args.sync_binance_symbol:
        availability.append(
            sync_official_agg_trade_availability(
                args.archive_dir,
                exchange="binance",
                market_type="futures",
                symbol=symbol,
                as_of_date=args.as_of_date,
                timeout_seconds=args.timeout_seconds,
            ).to_dict()
        )
    index = publish_remote_agg_trade_index(args.archive_dir)
    print(
        json.dumps(
            {"availability": availability, "index": index.to_dict()},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
