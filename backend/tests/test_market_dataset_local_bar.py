from __future__ import annotations

from pathlib import Path

import pytest

from app.local_data import LocalDatasetService, LocalImportOptions
from app.market_dataset.adapters.local_bar import LocalBarSnapshotProvider
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import MarketDatasetError

CSV = """time,open,high,low,close,volume
1704067200000,100,102,99,101,10
1704067260000,101,104,100,103,12
1704067380000,103,105,102,104,8
"""


def _write_and_import(tmp_path: Path) -> tuple[LocalDatasetService, dict]:
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(CSV, encoding="utf-8")
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        csv_path,
        LocalImportOptions(
            name="BTC sample",
            symbol="BTC-USDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id="local-0123456789abcdef0123456789abcdef",
        ),
    )
    return service, manifest


def _ref(manifest: dict, **overrides: object) -> DatasetRef:
    payload = {
        "dataset_id": manifest["dataset_id"],
        "data_epoch": manifest["data_epoch"],
        "snapshot_hash": "",
        "venue": "local",
        "market_type": "imported",
        "symbol": manifest["symbol"],
        "start_time_ms": 0,
        "end_time_ms": 2_000_000_000_000,
        "roles": ("BARS", "INSTRUMENT_RULES"),
        "interval": "1m",
        "calendar_id": "UTC_FIXED",
        "source": "local_csv",
        "retention_policy": "user_local",
    }
    payload.update(overrides)
    return DatasetRef(**payload)  # type: ignore[arg-type]


def test_same_revision_opens_with_identical_hash(tmp_path: Path) -> None:
    service, manifest = _write_and_import(tmp_path)
    provider = LocalBarSnapshotProvider(service)
    first = provider.open(_ref(manifest))
    second = provider.open(_ref(manifest, snapshot_hash=first.snapshot_hash))
    assert first.snapshot_hash == second.snapshot_hash
    assert first.row_count == 3
    assert first.fidelity_capabilities == ("BAR_APPROX",)
    first_events = [event.payload for event in first.cursor()]
    second_events = [event.payload for event in second.cursor()]
    assert first_events == second_events
    first.close()
    second.close()


def test_wrong_snapshot_hash_fails_closed(tmp_path: Path) -> None:
    service, manifest = _write_and_import(tmp_path)
    provider = LocalBarSnapshotProvider(service)
    with pytest.raises(MarketDatasetError, match="DATA_SNAPSHOT_MISMATCH"):
        provider.open(_ref(manifest, snapshot_hash="sha256:" + "0" * 64))


def test_trade_role_is_unsupported_on_local_bar_adapter(tmp_path: Path) -> None:
    service, manifest = _write_and_import(tmp_path)
    provider = LocalBarSnapshotProvider(service)
    with pytest.raises(MarketDatasetError, match="FIDELITY_UNSUPPORTED"):
        provider.open(_ref(manifest, roles=("TRADES",)))


def test_cursor_does_not_include_bars_outside_requested_window(tmp_path: Path) -> None:
    service, manifest = _write_and_import(tmp_path)
    provider = LocalBarSnapshotProvider(service)
    snapshot = provider.open(
        _ref(manifest, start_time_ms=1704067260000, end_time_ms=1704067260000)
    )
    events = list(snapshot.cursor())
    assert len(events) == 1
    assert events[0].payload["open_time_ms"] == 1704067260000
