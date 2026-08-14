from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api.v1.backtests import _require_contract_snapshot
from app.backtest.errors import BacktestError
from app.backtest.runtime import _bar_execution_events, _snapshot_wire
from app.local_data.service import (
    LocalDatasetError,
    LocalDatasetService,
    LocalImportOptions,
)
from app.market_dataset.adapters.contract_aux import (
    AUX_ROLES,
    validate_contract_history,
)
from app.market_dataset.adapters.local_bar import LocalBarSnapshotProvider
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import MarketDatasetError
from app.market_dataset.snapshot import MarketEvent

START = 1_704_067_200_000
MINUTE = 60_000
END = START + 3 * MINUTE - 1


def _bundle() -> dict[str, object]:
    marks = [
        {
            "event_time_ms": START + index * MINUTE,
            "mark_price": str(100 + index),
            "index_price": str(100 + index),
        }
        for index in range(3)
    ]
    funding = [
        {
            "settlement_time_ms": START + index * MINUTE,
            "period_id": f"period-{index}",
            "funding_rate": "0.0001",
            "mark_price": str(100 + index),
        }
        for index in range(1, 4)
    ]
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    rules = [
        {
            "effective_from_ms": START,
            "effective_to_ms": START + MINUTE - 1,
            "rule_version": "btc-rule-v1",
            "contract_multiplier": "1",
            "price_tick": "0.1",
            "quantity_step": "0.001",
            "min_quantity": "0.001",
            "max_quantity": "1000",
            "min_notional": "5",
            "maintenance_tiers": [tier],
        },
        {
            "effective_from_ms": START + MINUTE,
            "effective_to_ms": END,
            "rule_version": "btc-rule-v2",
            "contract_multiplier": "1",
            "price_tick": "0.1",
            "quantity_step": "0.001",
            "min_quantity": "0.001",
            "max_quantity": "1000",
            "min_notional": "5",
            "maintenance_tiers": [tier],
        },
    ]
    provenance = {
        "provider": "TEST_PINNED_PUBLIC_ARCHIVE",
        "source_url": "https://example.invalid/pinned",
        "capture_receipt": "fixture-receipt",
    }
    return {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {
            "venue": "binance",
            "market_type": "usdm",
            "symbol": "BTCUSDT",
        },
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": MINUTE,
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": marks,
            },
            "FUNDING": {
                "period_ms": MINUTE,
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": funding,
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": rules,
            },
        },
    }


def _write_json(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _dataset(tmp_path: Path) -> tuple[LocalDatasetService, dict[str, object]]:
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        f"{START},100,101,99,100,1\n"
        f"{START + MINUTE},100,102,100,101,1\n"
        f"{START + 2 * MINUTE},101,103,101,102,1\n",
        encoding="utf-8",
    )
    service = LocalDatasetService(tmp_path / "local")
    manifest = service.import_csv(
        csv_path,
        LocalImportOptions(
            name="BTC real-window fixture",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    return service, manifest


def _ref(manifest: dict[str, object], *, snapshot_hash: str = "") -> DatasetRef:
    return DatasetRef(
        dataset_id=str(manifest["dataset_id"]),
        data_epoch=str(manifest["data_epoch"]),
        snapshot_hash=snapshot_hash,
        venue="binance",
        market_type="usdm",
        symbol="BTCUSDT",
        start_time_ms=START,
        end_time_ms=END,
        roles=("BARS", *AUX_ROLES),
        interval="1m",
        calendar_id="UTC_FIXED",
        source="local_immutable",
        retention_policy="user_local",
    )


def test_import_creates_new_revision_and_replays_deterministically(
    tmp_path: Path,
) -> None:
    service, original = _dataset(tmp_path)
    bundle_path = _write_json(tmp_path / "contract.json", _bundle())
    attached = service.import_contract_history(
        bundle_path,
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
    assert attached["data_epoch"] != original["data_epoch"]
    assert attached["parent_data_epoch"] == original["data_epoch"]
    assert set(attached["contract_history"]["roles"]) == set(AUX_ROLES)

    provider = LocalBarSnapshotProvider(service)
    first = provider.open(_ref(attached))
    first_events = tuple(first.cursor())
    second = provider.open(_ref(attached))
    assert tuple(second.cursor()) == first_events
    assert second.snapshot_hash == first.snapshot_hash
    assert first.quality["contract_data"]["status"] == "complete"
    assert set(first.role_hashes) == {"BARS", *AUX_ROLES}
    at_boundary = [
        event.role for event in first_events if event.event_time_ms == START + MINUTE
    ]
    assert at_boundary[:3] == ["INSTRUMENT_RULES", "MARK_INDEX", "FUNDING"]


def test_missing_bundle_previews_missing_but_required_open_fails(
    tmp_path: Path,
) -> None:
    service, manifest = _dataset(tmp_path)
    preview = LocalBarSnapshotProvider(service).open(
        _ref(manifest), allow_incomplete_contract=True
    )
    assert preview.quality["contract_data"]["status"] == "missing"
    with pytest.raises(MarketDatasetError, match="DATA_ROLE_MISSING"):
        LocalBarSnapshotProvider(service).open(_ref(manifest))


def test_deleted_mark_row_fails_manifest_and_preview_closed(tmp_path: Path) -> None:
    service, original = _dataset(tmp_path)
    attached = service.import_contract_history(
        _write_json(tmp_path / "contract.json", _bundle()),
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
    revision = str(attached["data_epoch"]).removeprefix("sha256:")
    bundle_path = (
        service.root / str(attached["dataset_id"]) / revision / "contract-history.json"
    )
    payload = json.loads(bundle_path.read_text(encoding="utf-8"))
    del payload["roles"]["MARK_INDEX"]["records"][1]
    bundle_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(MarketDatasetError, match="DATA_SNAPSHOT_MISMATCH"):
        LocalBarSnapshotProvider(service).open(_ref(attached))
    incomplete = LocalBarSnapshotProvider(service).open(
        _ref(attached), allow_incomplete_contract=True
    )
    assert incomplete.quality["contract_data"]["status"] == "partial"
    with pytest.raises(BacktestError, match="historical contract roles"):
        _require_contract_snapshot(
            _snapshot_wire(incomplete),
            "HISTORICAL_CONTRACT_V1",
        )

    with pytest.raises(LocalDatasetError, match="contract history"):
        service._validate_packaged_revision(
            bundle_path.parent,
            str(attached["dataset_id"]),
        )


def test_funding_settlement_jitter_within_declared_tolerance_is_complete() -> None:
    payload = _bundle()
    payload["roles"]["FUNDING"]["settlement_tolerance_ms"] = 1_000
    payload["roles"]["FUNDING"]["records"][1]["settlement_time_ms"] += 8
    payload["roles"]["FUNDING"]["records"][2]["settlement_time_ms"] += 12

    descriptor = validate_contract_history(payload)

    assert descriptor.role_quality["FUNDING"]["status"] == "complete"
    assert descriptor.role_quality["FUNDING"]["coverage_start_ms"] == START
    assert descriptor.role_quality["FUNDING"]["first_event_ms"] == START + MINUTE
    assert (
        descriptor.role_quality["FUNDING"]["last_event_ms"] == START + 3 * MINUTE + 12
    )
    roles = descriptor.canonical_payload["roles"]
    assert roles["FUNDING"]["settlement_tolerance_ms"] == 1_000


def test_combined_snapshot_projects_only_real_bar_gaps_to_execution_clock() -> None:
    bars = (
        MarketEvent(4, START + MINUTE - 1, "BARS", {"open_time_ms": START}),
        MarketEvent(
            8, START + 2 * MINUTE - 1, "BARS", {"open_time_ms": START + MINUTE}
        ),
        MarketEvent(
            11, START + 4 * MINUTE - 1, "BARS", {"open_time_ms": START + 3 * MINUTE}
        ),
    )
    auxiliary = MarketEvent(5, START + MINUTE, "FUNDING", {"funding_rate": "0"})

    projected = _bar_execution_events(
        (bars[0], auxiliary, bars[1], bars[2]),
        interval_name="1m",
    )

    assert [event.sequence for event in projected] == [1, 2, 4]


@pytest.mark.parametrize("mutation", ["duplicate_funding", "mark_gap", "rule_overlap"])
def test_quality_contract_rejects_duplicate_gap_and_overlap(mutation: str) -> None:
    payload = _bundle()
    roles = payload["roles"]
    if mutation == "duplicate_funding":
        roles["FUNDING"]["records"][1]["period_id"] = "period-1"
    elif mutation == "mark_gap":
        roles["MARK_INDEX"]["records"][1]["event_time_ms"] += 1
    else:
        roles["INSTRUMENT_RULES"]["records"][1]["effective_from_ms"] -= 1
    if mutation == "mark_gap":
        descriptor = validate_contract_history(payload)
        assert descriptor.role_quality["MARK_INDEX"]["status"] == "partial"
    else:
        with pytest.raises(MarketDatasetError):
            validate_contract_history(payload)
