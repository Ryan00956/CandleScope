from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.local_data import LocalDatasetError, LocalDatasetService, LocalImportOptions


CSV_WITH_GAP = """time,open,high,low,close,volume
1704067200000,100,102,99,101,10
1704067260000,101,104,100,103,12
1704067380000,103,105,102,104,8
"""


def _write_csv(path: Path, content: str = CSV_WITH_GAP) -> Path:
    path.write_text(content, encoding="utf-8")
    return path


def test_import_publishes_immutable_revision_and_terminal_gap(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    dataset_id = "local-0123456789abcdef0123456789abcdef"
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv"),
        LocalImportOptions(
            name="BTC sample",
            symbol="BTC-USDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id=dataset_id,
        ),
    )

    assert manifest["dataset_id"] == dataset_id
    assert manifest["data_epoch"].startswith("sha256:")
    assert manifest["rows"] == 3
    assert manifest["excluded_range_count"] == 1
    revision = manifest["data_epoch"].removeprefix("sha256:")
    revision_dir = service.root / dataset_id / revision
    assert {path.name for path in revision_dir.iterdir()} == {
        "bars.sqlite",
        "manifest.json",
        "quality-report.json",
        "import-receipt.json",
    }
    quality = json.loads(
        (revision_dir / "quality-report.json").read_text(encoding="utf-8")
    )
    assert quality["status"] == "accepted_with_gaps"
    assert quality["excluded_ranges"] == [
        {
            "start_ms": 1704067320000,
            "end_ms": 1704067380000,
            "reason": "source_gap",
            "missing_bars": 1,
        }
    ]

    page = service.query(dataset_id, interval="1m", limit=2)
    assert [row["time"] for row in page["data"]] == [1704067260, 1704067380]
    assert page["has_more"] is True
    assert page["retryable"] is False
    assert page["missing_ranges"] == []
    assert page["excluded_ranges"][0]["reason"] == "source_gap"

    older = service.query(
        dataset_id,
        interval="1m",
        limit=2,
        before_ms=page["next_before_ms"],
    )
    assert [row["time"] for row in older["data"]] == [1704067200]
    assert older["history_state"] == "exhausted"
    assert older["terminal_reason"] == "dataset_boundary"


def test_import_rejects_duplicates_without_publishing(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    csv_path = _write_csv(
        tmp_path / "duplicate.csv",
        "time,open,high,low,close,volume\n"
        "1704067200000,1,2,1,2,3\n"
        "1704067200000,2,3,2,3,4\n",
    )

    with pytest.raises(LocalDatasetError, match="duplicate timestamp"):
        service.import_csv(
            csv_path,
            LocalImportOptions(
                name="bad",
                symbol="BAD",
                interval="1m",
                timestamp_unit="ms",
            ),
        )

    assert service.list_datasets() == []


def test_query_rejects_interval_not_present_in_dataset(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv"),
        LocalImportOptions(
            name="BTC sample",
            symbol="BTC-USDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )

    with pytest.raises(LocalDatasetError) as error:
        service.query(manifest["dataset_id"], interval="5m", limit=10)
    assert error.value.code == "interval_not_available"


def test_import_accepts_tradingview_column_case_and_session_phase(
    tmp_path: Path,
) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(
            tmp_path / "tradingview.csv",
            "time,open,high,low,close,Volume\n"
            "1762779600,4097.47,4106.01,4074.07,4083.477,311188\n"
            "1762786800,4083.467,4095.751,4077.595,4094.88,286978\n"
            "1762801200,4095.001,4115.83,4093.17,4110.087,222317\n",
        ),
        LocalImportOptions(
            name="TradingView GOLD",
            symbol="TVC:GOLD",
            interval="2h",
            timestamp_unit="s",
        ),
    )

    assert manifest["rows"] == 3
    assert manifest["alignment"] == "fixed_epoch"
    assert manifest["alignment_offset_ms"] == 3_600_000
    assert manifest["excluded_range_count"] == 1
    revision = manifest["data_epoch"].removeprefix("sha256:")
    receipt = json.loads(
        (
            service.root / manifest["dataset_id"] / revision / "import-receipt.json"
        ).read_text(encoding="utf-8")
    )
    assert receipt["columns"]["volume_column"] == "Volume"


def test_import_rejects_timestamp_phase_change(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    csv_path = _write_csv(
        tmp_path / "phase-change.csv",
        "time,open,high,low,close,Volume\n1762779600,1,2,1,2,3\n1762790400,2,3,2,3,4\n",
    )

    with pytest.raises(LocalDatasetError, match="timestamp phase"):
        service.import_csv(
            csv_path,
            LocalImportOptions(
                name="bad phase",
                symbol="BAD",
                interval="2h",
                timestamp_unit="s",
            ),
        )


def test_import_preserves_missing_volume_as_unavailable(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(
            tmp_path / "ohlc-only.csv",
            "time,open,high,low,close\n"
            "1739577600,97500,98000,97000,97750\n"
            "1739664000,97750,99000,97500,98500\n",
        ),
        LocalImportOptions(
            name="TradingView OHLC only",
            symbol="BINANCE:BTCUSDT",
            interval="1d",
            timestamp_unit="s",
        ),
    )

    assert manifest["schema_version"] == 2
    assert manifest["volume_available"] is False
    page = service.query(manifest["dataset_id"], interval="1d", limit=10)
    assert page["volume_available"] is False
    assert [row["volume"] for row in page["data"]] == [None, None]
    revision = manifest["data_epoch"].removeprefix("sha256:")
    quality = json.loads(
        (
            service.root / manifest["dataset_id"] / revision / "quality-report.json"
        ).read_text(encoding="utf-8")
    )
    assert quality["missing_volume_rows"] == 2


def test_import_can_require_volume(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    with pytest.raises(LocalDatasetError, match="columns not found: volume"):
        service.import_csv(
            _write_csv(
                tmp_path / "ohlc-only.csv",
                "time,open,high,low,close\n1739577600,97500,98000,97000,97750\n",
            ),
            LocalImportOptions(
                name="Volume required",
                symbol="BINANCE:BTCUSDT",
                interval="1d",
                timestamp_unit="s",
                volume_required=True,
            ),
        )


def test_resolve_event_times_is_revision_scoped_and_gap_aware(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(
            tmp_path / "events-bars.csv",
            "time,open,high,low,close\n"
            "1704067200000,100,102,99,101\n"
            "1704067260000,101,103,100,102\n"
            "1704067380000,103,105,102,104\n",
        ),
        LocalImportOptions(
            name="Event mapping",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )

    exact = service.resolve_event_times(
        manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        times_ms=[1704067200000, 1704067230000],
        mode="exact",
    )
    assert exact["matched"] == 1
    assert exact["results"][0]["bar_open_ms"] == 1704067200000
    assert exact["results"][1]["matched"] is False

    containing = service.resolve_event_times(
        manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        times_ms=[1704067230000, 1704067330000],
        mode="containing",
    )
    assert containing["results"][0]["bar_open_ms"] == 1704067200000
    assert containing["results"][0]["delta_ms"] == 30000
    assert containing["results"][1]["matched"] is False

    with pytest.raises(LocalDatasetError) as stale:
        service.resolve_event_times(
            manifest["dataset_id"],
            data_epoch="sha256:" + "0" * 64,
            times_ms=[1704067200000],
            mode="exact",
        )
    assert stale.value.code == "dataset_revision_changed"


def test_library_revision_quality_compare_rollback_and_trash(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    first = service.import_csv(
        _write_csv(
            tmp_path / "first.csv",
            "time,open,high,low,close\n1704067200000,1,2,1,2\n1704067260000,2,3,2,3\n",
        ),
        LocalImportOptions(
            name="Version one",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    renamed = service.update_library_metadata(
        first["dataset_id"], name="Research set", archived=True
    )
    assert renamed["name"] == "Research set"
    assert renamed["archived"] is True
    assert service.list_datasets() == []
    assert service.list_datasets(include_archived=True)[0]["name"] == "Research set"

    second = service.import_csv(
        _write_csv(
            tmp_path / "second.csv",
            "time,open,high,low,close\n"
            "1704067200000,1,2,1,2\n"
            "1704067260000,2,4,2,4\n"
            "1704067320000,4,5,4,5\n",
        ),
        LocalImportOptions(
            name="Ignored revision label",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id=first["dataset_id"],
        ),
    )
    assert second["name"] == "Research set"
    assert second["revision_count"] == 2
    comparison = service.compare_revisions(
        first["dataset_id"],
        left_epoch=first["data_epoch"],
        right_epoch=second["data_epoch"],
    )
    assert comparison["added"] == 1
    assert comparison["changed"] == 1
    assert comparison["unchanged"] == 1
    details = service.revision_details(first["dataset_id"], second["data_epoch"])
    assert details["quality"]["status"] == "accepted"

    rolled_back = service.activate_revision(
        first["dataset_id"],
        data_epoch=first["data_epoch"],
        expected_current_epoch=second["data_epoch"],
    )
    assert rolled_back["data_epoch"] == first["data_epoch"]
    entry = service.trash_dataset(first["dataset_id"])
    assert service.list_datasets(include_archived=True) == []
    restored = service.restore_trash(entry["trash_id"])
    assert restored["dataset_id"] == first["dataset_id"]
    assert restored["data_epoch"] == first["data_epoch"]


def test_project_package_round_trip_and_collision_remap(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv"),
        LocalImportOptions(
            name="Portable project",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    package = service.export_project_package(
        manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        client_state={"events": [{"label": "FOMC"}], "indicators": [{"name": "MA"}]},
    )
    assert package.suffix == ".csproject"

    imported = service.import_project_package(package)
    assert imported["identity_changed"] is True
    assert imported["dataset_id"] != manifest["dataset_id"]
    assert imported["dataset"]["data_epoch"] == manifest["data_epoch"]
    assert imported["client_state"]["events"][0]["label"] == "FOMC"
    assert (
        service.query(imported["dataset_id"], interval="1m", limit=10)["count"]
        == manifest["rows"]
    )


def test_new_revision_rejects_identity_change(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv"),
        LocalImportOptions(
            name="Identity",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    with pytest.raises(LocalDatasetError) as error:
        service.import_csv(
            _write_csv(tmp_path / "other.csv"),
            LocalImportOptions(
                name="Identity",
                symbol="ETHUSDT",
                interval="1m",
                timestamp_unit="ms",
                dataset_id=manifest["dataset_id"],
            ),
        )
    assert error.value.code == "dataset_identity_mismatch"
