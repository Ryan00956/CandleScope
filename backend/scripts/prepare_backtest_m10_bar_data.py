"""Create and import the deterministic 200k-BAR M10 product workload."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.local_data.service import LocalDatasetService, LocalImportOptions  # noqa: E402

SCHEMA = "candlescope.backtest-m10-bar-data/2"
ROWS = 200_000
STUDY_ROWS = 1_200
STUDY_BAR_MS = 86_400_000


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-data-receipt", required=True, type=Path)
    parser.add_argument("--local-data-dir", required=True, type=Path)
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    real = json.loads(args.real_data_receipt.read_text(encoding="utf-8"))
    start_ms = int(real["workloads"][0]["dataset"]["start_time_ms"])
    start_ms -= start_ms % 60_000
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with args.csv.open("w", encoding="utf-8", newline="\n") as handle:
        header = "time,open,high,low,close,volume\n"
        handle.write(header)
        digest.update(header.encode())
        previous = 100
        for index in range(ROWS):
            phase = index % 48
            close = 76 + phase if phase < 24 else 124 - (phase - 24)
            row = (
                f"{start_ms + index * 60_000},{previous},{max(previous, close) + 1},"
                f"{min(previous, close) - 1},{close},100\n"
            )
            handle.write(row)
            digest.update(row.encode())
            previous = close
    local = LocalDatasetService(args.local_data_dir)
    manifest = local.import_csv(
        args.csv,
        LocalImportOptions(
            name="M10 deterministic 200k BAR workload",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    study_csv = args.csv.with_name("study-1200.csv")
    study_rows: list[str] = []
    previous = 130
    for index in range(STUDY_ROWS):
        phase = index % 40
        close = 130 - 3 * phase if phase < 20 else 70 + 3 * (phase - 20)
        study_rows.append(
            f"{start_ms + index * STUDY_BAR_MS},{previous},{max(previous, close) + 2},"
            f"{min(previous, close) - 2},{close},100"
        )
        previous = close
    study_csv.write_text(
        "time,open,high,low,close,volume\n" + "\n".join(study_rows) + "\n",
        encoding="utf-8",
    )
    study_original = local.import_csv(
        study_csv,
        LocalImportOptions(
            name="M10 deterministic Study V2 workload",
            symbol="BTCUSDT",
            interval="1d",
            timestamp_unit="ms",
        ),
    )
    provenance = {
        "provider": "M10_DETERMINISTIC_LOCAL_FIXTURE",
        "source_url": "local-only://m10-study-v2",
        "capture_receipt": "m10-study-v2-fixture-v1",
    }
    prices = [
        130 - 3 * (index % 40)
        if index % 40 < 20
        else 70 + 3 * ((index % 40) - 20)
        for index in range(STUDY_ROWS)
    ]
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    contract_bundle = {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {
            "venue": "binance",
            "market_type": "usdm",
            "symbol": "BTCUSDT",
        },
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": STUDY_BAR_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": start_ms + index * STUDY_BAR_MS,
                        "mark_price": str(price),
                        "index_price": str(price),
                    }
                    for index, price in enumerate(prices)
                ],
            },
            "FUNDING": {
                "period_ms": STUDY_BAR_MS,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": start_ms + index * STUDY_BAR_MS,
                        "period_id": f"m10-{index}",
                        "funding_rate": "0",
                        "mark_price": str(prices[min(index, STUDY_ROWS - 1)]),
                    }
                    for index in range(1, STUDY_ROWS + 1)
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "effective_from_ms": start_ms,
                        "effective_to_ms": start_ms + STUDY_ROWS * STUDY_BAR_MS - 1,
                        "rule_version": "m10-study-rule-v1",
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
    contract_path = args.csv.with_name("study-contract-history.json")
    contract_path.write_text(
        json.dumps(contract_bundle, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    study_manifest = local.import_contract_history(
        contract_path,
        dataset_id=str(study_original["dataset_id"]),
        data_epoch=str(study_original["data_epoch"]),
    )
    receipt = {
        "schemaVersion": SCHEMA,
        "generator": "SAWTOOTH_48_V1",
        "rowCount": ROWS,
        "startTimeMs": start_ms,
        "endTimeMs": start_ms + ROWS * 60_000,
        "csv": str(args.csv.resolve()),
        "csvSha256": digest.hexdigest(),
        "manifest": manifest,
        "study": {
            "generator": "RSI_SWING_40_V1",
            "rowCount": STUDY_ROWS,
            "startTimeMs": start_ms,
            "endTimeMs": start_ms + STUDY_ROWS * STUDY_BAR_MS,
            "barDurationMs": STUDY_BAR_MS,
            "csv": str(study_csv.resolve()),
            "contractHistory": str(contract_path.resolve()),
            "manifest": study_manifest,
        },
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
