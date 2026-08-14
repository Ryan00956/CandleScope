from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from app.local_data import LocalDatasetError, LocalDatasetService, LocalImportOptions
from app.market_dataset.adapters.local_bar import LocalBarSnapshotProvider
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import MarketDatasetError
from app.simulation.kernel import SimulationKernel


def _write(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def test_duplicate_and_gap_are_quality_failures(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    with pytest.raises(LocalDatasetError, match="duplicate"):
        service.import_csv(
            _write(
                tmp_path / "dup.csv",
                "time,open,high,low,close,volume\n"
                "1704067200000,1,2,1,2,3\n"
                "1704067200000,2,3,2,3,4\n",
            ),
            LocalImportOptions(name="dup", symbol="X", interval="1m", timestamp_unit="ms"),
        )
    manifest = service.import_csv(
        _write(
            tmp_path / "gap.csv",
            "time,open,high,low,close,volume\n"
            "1704067200000,100,102,99,101,10\n"
            "1704067320000,103,105,102,104,8\n",
        ),
        LocalImportOptions(name="gap", symbol="X", interval="1m", timestamp_unit="ms"),
    )
    assert manifest["excluded_range_count"] == 1
    page = service.query(manifest["dataset_id"], interval="1m", limit=10)
    assert page["verified_contiguous"] is False

    ref = DatasetRef(
        dataset_id=manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        snapshot_hash="",
        venue="local",
        market_type="imported",
        symbol="X",
        start_time_ms=0,
        end_time_ms=2_000_000_000_000,
        roles=("BARS",),
        interval="1m",
        calendar_id="UTC_FIXED",
        source="local_csv",
        retention_policy="user_local",
    )
    snapshot = LocalBarSnapshotProvider(service).open(ref)
    events = tuple(snapshot.cursor())
    assert [event.sequence for event in events] == [1, 3]
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        SimulationKernel(gap_policy="REJECT").run(events, lambda *_: [])


def test_snapshot_hash_mismatch_and_offline_revision_identity(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write(
            tmp_path / "bars.csv",
            "time,open,high,low,close,volume\n1704067200000,100,102,99,101,10\n",
        ),
        LocalImportOptions(
            name="one",
            symbol="BTC-USDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id="local-0123456789abcdef0123456789abcdef",
        ),
    )
    ref = DatasetRef(
        dataset_id=manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        snapshot_hash="sha256:" + "00" * 32,
        venue="local",
        market_type="imported",
        symbol="BTC-USDT",
        start_time_ms=0,
        end_time_ms=2_000_000_000_000,
        roles=("BARS", "INSTRUMENT_RULES"),
        interval="1m",
        calendar_id="UTC_FIXED",
        source="local_csv",
        retention_policy="user_local",
    )
    with pytest.raises(MarketDatasetError, match="DATA_SNAPSHOT_MISMATCH"):
        LocalBarSnapshotProvider(service).open(ref)
    opened = LocalBarSnapshotProvider(service).open(replace(ref, snapshot_hash=""))
    again = LocalBarSnapshotProvider(service).open(
        replace(ref, snapshot_hash=opened.snapshot_hash)
    )
    assert opened.snapshot_hash == again.snapshot_hash
