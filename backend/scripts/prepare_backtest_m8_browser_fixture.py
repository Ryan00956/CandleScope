"""Prepare deterministic local-only RSI24 Study V2 browser data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.local_data.service import LocalDatasetService, LocalImportOptions

START_MS = 1_704_067_200_000
DAY_MS = 86_400_000
ROWS = 220


def _close(index: int) -> int:
    phase = index % 40
    return 130 - 3 * phase if phase < 20 else 70 + 3 * (phase - 20)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    csv_path = root / "m8-rsi24-bars.csv"
    rows = []
    previous = _close(0)
    for index in range(ROWS):
        close = _close(index)
        open_price = previous
        rows.append(
            f"{START_MS + index * DAY_MS},{open_price},{max(open_price, close) + 2},"
            f"{min(open_price, close) - 2},{close},100"
        )
        previous = close
    csv_path.write_text(
        "time,open,high,low,close,volume\n" + "\n".join(rows), encoding="utf-8"
    )
    local = LocalDatasetService(root / "local-data")
    original = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="M8 RSI24 Study V2 fixture",
            symbol="BTCUSDT",
            interval="1d",
            timestamp_unit="ms",
        ),
    )
    provenance = {
        "provider": "M8_DETERMINISTIC_LOCAL_FIXTURE",
        "source_url": "https://example.invalid/m8-local-fixture",
        "capture_receipt": "m8-browser-fixture-v1",
    }
    prices = [_close(index) for index in range(ROWS)]
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    bundle = {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {"venue": "binance", "market_type": "usdm", "symbol": "BTCUSDT"},
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": DAY_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": START_MS + index * DAY_MS,
                        "mark_price": str(price),
                        "index_price": str(price),
                    }
                    for index, price in enumerate(prices)
                ],
            },
            "FUNDING": {
                "period_ms": DAY_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": START_MS + index * DAY_MS,
                        "period_id": f"m8-{index}",
                        "funding_rate": "0",
                        "mark_price": str(prices[min(index, ROWS - 1)]),
                    }
                    for index in range(1, ROWS + 1)
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "effective_from_ms": START_MS,
                        "effective_to_ms": START_MS + ROWS * DAY_MS - 1,
                        "rule_version": "m8-browser-rule-v1",
                        "contract_multiplier": "1",
                        "price_tick": "0.1",
                        "quantity_step": "0.001",
                        "min_quantity": "0.001",
                        "max_quantity": "1000",
                        "min_notional": "5",
                        "maintenance_tiers": [tier],
                    }
                ],
            },
        },
    }
    bundle_path = root / "m8-contract-history.json"
    bundle_path.write_text(json.dumps(bundle, sort_keys=True), encoding="utf-8")
    attached = local.import_contract_history(
        bundle_path,
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
    print(
        json.dumps(
            {
                "fixture": "SYNTHETIC_DETERMINISTIC_RSI24_STUDY_V2",
                "network": "FORBIDDEN",
                "dataset": attached,
                "start_time_ms": START_MS,
                "end_time_ms": START_MS + ROWS * DAY_MS - 1,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
