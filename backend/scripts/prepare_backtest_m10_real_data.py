"""Import explicit local Binance ZIPs and freeze honest M10 aggTrade workloads."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.storage.raw_trade_archive import ParquetRawAggTradeArchive  # noqa: E402
from app.replay.trade_import import (  # noqa: E402
    file_sha256,
    import_local_verified_day,
    iter_verified_agg_trade_rows,
)

SCHEMA = "candlescope.backtest-m10-real-data/1"
SOURCE_ROOT = "https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT"
NAME = re.compile(r"^BTCUSDT-aggTrades-(\d{4}-\d{2}-\d{2})\.zip$")
TARGETS = (1_000_000, 2_000_000)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--max-rows-per-file", type=int, default=100_000)
    return parser


def main() -> int:
    args = _parser().parse_args()
    source_dir = args.source_dir.resolve()
    archive_dir = args.archive_dir.resolve()
    zips: list[tuple[date, Path]] = []
    for path in source_dir.glob("BTCUSDT-aggTrades-*.zip"):
        match = NAME.fullmatch(path.name)
        if match:
            zips.append((date.fromisoformat(match.group(1)), path))
    zips.sort()
    if not zips:
        raise SystemExit("no explicit local BTCUSDT aggTrade ZIPs found")
    if args.max_rows_per_file < 1:
        raise SystemExit("--max-rows-per-file must be positive")

    archive = ParquetRawAggTradeArchive(
        archive_dir, max_rows_per_file=args.max_rows_per_file
    )
    sources: list[dict[str, object]] = []
    previous_last_id: int | None = None
    first_time_ms: int | None = None
    selected: dict[int, tuple[int, int]] = {}
    completed_count = 0
    group_time: int | None = None
    group_count = 0

    def finish_group() -> None:
        nonlocal completed_count
        if group_time is None:
            return
        completed_count += group_count
        for target in TARGETS:
            if completed_count <= target:
                selected[target] = (group_time, completed_count)

    for day, zip_path in zips:
        checksum_path = zip_path.with_name(zip_path.name + ".CHECKSUM")
        if not checksum_path.is_file():
            raise SystemExit(f"missing official checksum: {checksum_path}")
        source_url = f"{SOURCE_ROOT}/{zip_path.name}"
        accepted, metadata = import_local_verified_day(
            archive,
            zip_path=zip_path,
            checksum_path=checksum_path,
            source_url=source_url,
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            day=day,
        )
        if previous_last_id is not None and metadata.first_agg_trade_id != previous_last_id + 1:
            raise SystemExit("official day boundary aggTrade IDs are not contiguous")
        previous_last_id = metadata.last_agg_trade_id
        sources.append(
            {
                "day": day.isoformat(),
                "zip": str(zip_path),
                "sourceUrl": source_url,
                "sha256": file_sha256(zip_path),
                "rowCount": metadata.row_count,
                "firstAggTradeId": metadata.first_agg_trade_id,
                "lastAggTradeId": metadata.last_agg_trade_id,
                "acceptedRows": accepted,
            }
        )
        for row in iter_verified_agg_trade_rows(
            zip_path,
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            day=day,
        ):
            row_time = int(row["trade_time_ms"])
            first_time_ms = row_time if first_time_ms is None else first_time_ms
            if group_time is None:
                group_time = row_time
            if row_time != group_time:
                finish_group()
                group_time = row_time
                group_count = 0
            group_count += 1
    finish_group()

    if first_time_ms is None or any(target not in selected for target in TARGETS):
        raise SystemExit("verified ZIPs do not contain both M10 workloads")
    workloads: list[dict[str, object]] = []
    for target in TARGETS:
        end_time_ms, selected_rows = selected[target]
        dataset = archive.freeze_dataset(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            start_time_ms=first_time_ms,
            end_time_ms=end_time_ms,
        )
        if dataset.row_count != selected_rows or dataset.row_count > target:
            raise SystemExit("frozen workload does not match complete timestamp groups")
        workloads.append(
            {
                "targetRows": target,
                "actualRows": dataset.row_count,
                "timestampAtomicShortfall": target - dataset.row_count,
                "dataset": dataset.to_dict(),
            }
        )

    receipt = {
        "schemaVersion": SCHEMA,
        "sourcePolicy": "EXPLICIT_LOCAL_OFFICIAL_ZIP_CHECKSUM_REQUIRED",
        "networkFetchPerformedByThisScript": False,
        "sources": sources,
        "totalVerifiedRows": sum(int(item["rowCount"]) for item in sources),
        "workloads": workloads,
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
