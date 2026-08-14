"""Prepare the deterministic local-only M7 browser acceptance dataset."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.local_data.service import LocalDatasetService, LocalImportOptions

START_MS = 1_704_067_200_000
DAY_MS = 86_400_000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    csv_path = root / "m7-bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        + "\n".join(
            f"{START_MS + index * DAY_MS},{100 + index},{104 + index},"
            f"{97 + index},{101 + index},10"
            for index in range(40)
        ),
        encoding="utf-8",
    )
    local = LocalDatasetService(root / "local-data")
    original = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="M7 metrics browser fixture",
            symbol="BTCUSDT",
            interval="1d",
            timestamp_unit="ms",
        ),
    )
    provenance = {
        "provider": "M7_DETERMINISTIC_LOCAL_FIXTURE",
        "source_url": "https://example.invalid/m7-local-fixture",
        "capture_receipt": "m7-browser-fixture-v1",
    }
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    bundle = {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {
            "venue": "binance",
            "market_type": "usdm",
            "symbol": "BTCUSDT",
        },
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": DAY_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": START_MS + index * DAY_MS,
                        "mark_price": str(101 + index),
                        "index_price": str(101 + index),
                    }
                    for index in range(40)
                ],
            },
            "FUNDING": {
                "period_ms": DAY_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": START_MS + index * DAY_MS,
                        "period_id": f"m7-{index}",
                        "funding_rate": "0",
                        "mark_price": str(101 + index),
                    }
                    for index in range(1, 41)
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "effective_from_ms": START_MS,
                        "effective_to_ms": START_MS + 40 * DAY_MS - 1,
                        "rule_version": "m7-browser-rule-v1",
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
    bundle_path = root / "m7-contract-history.json"
    bundle_path.write_text(json.dumps(bundle, sort_keys=True), encoding="utf-8")
    attached = local.import_contract_history(
        bundle_path,
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
    print(
        json.dumps(
            {
                "fixture": "SYNTHETIC_DETERMINISTIC_LOCAL_BROWSER_PATH",
                "network": "FORBIDDEN",
                "dataset": attached,
                "start_time_ms": START_MS,
                "end_time_ms": START_MS + 40 * DAY_MS - 1,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
