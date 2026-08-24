"""Prepare the deterministic, network-free chart-first Phase 5 browser fixture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.local_data.service import LocalDatasetService


START_MS = 1_704_067_200_000
HOUR_MS = 3_600_000
DATASET_IDS = {
    "spot": "local-55555555555555555555555555555555",
    "futures": "local-66666666666666666666666666666666",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--market-type",
        choices=tuple(DATASET_IDS),
        default="spot",
        help="Canonical chart market type to freeze (default: spot).",
    )
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    closes = (
        [100] * 8
        + [102, 104, 106, 108, 110, 112]
        + [112] * 8
        + [109, 106, 103, 100, 97, 94]
        + [94] * 8
        + [97, 100, 103, 106, 109, 112]
        + [112] * 18
    )
    rows = [
        {
            "open_time_ms": START_MS + index * HOUR_MS,
            "open": str(close),
            "high": str(close + 2),
            "low": str(close - 2),
            "close": str(close),
            "volume": "1000",
            "is_closed": True,
        }
        for index, close in enumerate(closes)
    ]
    service = LocalDatasetService(root / "local-data")
    dataset = service.freeze_host_bars(
        rows,
        dataset_id=DATASET_IDS[args.market_type],
        name="Chart-first Phase 5 local browser fixture",
        exchange="binance",
        # Use the canonical ChartSession value. Binance USD-M normalizes to
        # ``futures`` before the resolver performs exact manifest matching.
        market_type=args.market_type,
        symbol="BTCUSDT",
        interval="1h",
        chart_context_hash="sha256:phase5-browser-fixture",
    )
    print(
        json.dumps(
            {
                "fixture": "SYNTHETIC_DETERMINISTIC_LOCAL_CHART_FIRST_PHASE5",
                "network": "FORBIDDEN",
                "dataset": dataset,
                "start_time_ms": START_MS,
                "end_time_ms": START_MS + len(rows) * HOUR_MS - 1,
                "row_count": len(rows),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
