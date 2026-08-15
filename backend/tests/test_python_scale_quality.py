from __future__ import annotations

from pathlib import Path

import pytest

from app.local_data.archive_receipt import ArchiveReceiptError, build_local_archive_receipt
from app.local_data.quality import reject_gap_positions, reject_revision_drift
from app.local_data.service import LocalDatasetService, LocalImportOptions
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent


def _bar(sequence: int, open_ms: int) -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=open_ms + 60_000,
        role="BARS",
        payload={"open_time_ms": open_ms, "close_time_ms": open_ms + 60_000, "close": "1"},
    )


def test_head_mid_tail_gap_duplicate_and_reorder_reject() -> None:
    start = 1_700_000_000_000
    mid = [
        _bar(1, start),
        _bar(2, start + 120_000),
    ]
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        reject_gap_positions(mid, interval_ms=60_000)
    with pytest.raises(MarketDatasetError, match="head"):
        reject_gap_positions(
            [_bar(1, start + 60_000)],
            interval_ms=60_000,
            expected_start_ms=start,
        )
    with pytest.raises(MarketDatasetError, match="tail"):
        reject_gap_positions(
            [_bar(1, start)],
            interval_ms=60_000,
            expected_start_ms=start,
            expected_end_ms=start + 180_000,
        )
    with pytest.raises(MarketDatasetError, match="duplicate"):
        reject_gap_positions([_bar(1, start), _bar(2, start)], interval_ms=60_000)
    with pytest.raises(MarketDatasetError, match="backwards"):
        reject_gap_positions(
            [_bar(1, start + 60_000), _bar(2, start)], interval_ms=60_000
        )


def test_revision_drift_rejects() -> None:
    with pytest.raises(MarketDatasetError, match="DATA_SNAPSHOT_MISMATCH"):
        reject_revision_drift(expected_epoch="sha256:aa", actual_epoch="sha256:bb")
    reject_revision_drift(expected_epoch="sha256:aa", actual_epoch="sha256:aa")


def test_csv_alias_and_parquet_import(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local")
    csv_path = tmp_path / "alias.csv"
    csv_path.write_text(
        "timestamp,Open,High,Low,Close,Volume\n1704067200000,1,2,1,2,3\n",
        encoding="utf-8",
    )
    imported = service.import_csv(
        csv_path,
        LocalImportOptions(name="alias", symbol="BTCUSDT", interval="1m"),
    )
    catalog = service.catalog_entry(imported["dataset_id"])
    assert catalog["source"] == "local_dataset"
    assert catalog["coverage"]["rows"] == 1
    assert catalog["revision"].startswith("sha256:")
    parquet_path = tmp_path / "bars.parquet"
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        pytest.skip("pyarrow missing")
    table = pa.table(
        {
            "time": [1_704_067_260_000],
            "open": [2.0],
            "high": [3.0],
            "low": [2.0],
            "close": [3.0],
            "volume": [4.0],
        }
    )
    pq.write_table(table, parquet_path)
    parquet = service.import_parquet(
        parquet_path,
        LocalImportOptions(name="pq", symbol="ETHUSDT", interval="1m"),
    )
    assert parquet["rows"] == 1


def test_local_archive_receipt_is_offline_and_source_bound(tmp_path: Path) -> None:
    source = tmp_path / "BTCUSDT-1m.csv"
    source.write_text("time,open,high,low,close,volume\n1,1,1,1,1,1\n", encoding="utf-8")
    receipt = build_local_archive_receipt(
        venue="binance",
        market_type="usdm",
        symbol="btcusdt",
        role="BARS",
        source_files={"bars": source},
    )
    assert receipt["online"] is False
    assert receipt["files"]["bars"].startswith("sha256:")
    with pytest.raises(ArchiveReceiptError):
        build_local_archive_receipt(
            venue="binance",
            market_type="usdm",
            symbol="BTCUSDT",
            role="BARS",
            source_files={},
        )
