from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from threading import Event

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
    assert page["verified_contiguous"] is False

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


def _interval_csv(*, rows: int = 12, missing: set[int] | None = None) -> str:
    content = ["time,open,high,low,close,volume"]
    for index in range(rows):
        if index in (missing or set()):
            continue
        timestamp = 1_704_067_200_000 + index * 15 * 60_000
        content.append(
            f"{timestamp},{100 + index},{102 + index},{99 + index},"
            f"{101 + index},{10 + index}"
        )
    return "\n".join(content) + "\n"


def test_query_resamples_complete_integer_multiple_intervals(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv", _interval_csv()),
        LocalImportOptions(
            name="BTC sample",
            symbol="BTC-USDT",
            interval="15m",
            timestamp_unit="ms",
        ),
    )

    thirty = service.query(manifest["dataset_id"], interval="30m", limit=10)
    assert thirty["derived"] is True
    assert thirty["source_interval"] == "15m"
    assert thirty["aggregation_factor"] == 2
    assert thirty["count"] == 6
    assert thirty["data"][0] == {
        "time": 1_704_067_200,
        "open": 100.0,
        "high": 103.0,
        "low": 99.0,
        "close": 102.0,
        "volume": 21.0,
        "is_closed": True,
        "quote_volume": None,
        "taker_buy_base": None,
        "taker_buy_quote": None,
        "trades": None,
    }
    assert service.query(manifest["dataset_id"], interval="1h", limit=10)[
        "count"
    ] == 3

    ninety = service.query(manifest["dataset_id"], interval="90m", limit=1)
    assert ninety["count"] == 1
    assert ninety["has_more"] is True
    assert ninety["data"][0]["time"] == 1_704_072_600
    older = service.query(
        manifest["dataset_id"],
        interval="90m",
        limit=1,
        before_ms=ninety["next_before_ms"],
    )
    assert older["data"][0]["time"] == 1_704_067_200
    assert older["has_more"] is False

    with pytest.raises(LocalDatasetError) as error:
        service.query(manifest["dataset_id"], interval="89m", limit=10)
    assert error.value.code == "interval_not_composable"
    assert "not an integer multiple" in str(error.value)


@pytest.mark.parametrize(
    ("query_interval", "expected_times", "expected_closes"),
    [
        (
            "1m",
            [1_704_067_200, 1_704_067_260, 1_704_067_320, 1_704_067_380],
            [11.0, 12.0, 13.0, 14.0],
        ),
        ("2m", [1_704_067_200, 1_704_067_320], [12.0, 14.0]),
    ],
)
def test_query_pins_one_revision_during_concurrent_activation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    query_interval: str,
    expected_times: list[int],
    expected_closes: list[float],
) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    dataset_id = "local-0123456789abcdef0123456789abcdef"
    first = service.import_csv(
        _write_csv(
            tmp_path / "first.csv",
            "time,open,high,low,close,volume\n"
            "1704067200000,10,12,9,11,1\n"
            "1704067260000,11,13,10,12,2\n"
            "1704067320000,12,14,11,13,3\n"
            "1704067380000,13,15,12,14,4\n",
        ),
        LocalImportOptions(
            name="Revision one",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id=dataset_id,
        ),
    )
    second = service.import_csv(
        _write_csv(
            tmp_path / "second.csv",
            "time,open,high,low,close,volume\n"
            "1704067200000,100,102,99,101,10\n"
            "1704067260000,101,103,100,102,20\n"
            "1704067440000,104,106,103,105,30\n"
            "1704067500000,105,107,104,106,40\n",
        ),
        LocalImportOptions(
            name="Revision two",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id=dataset_id,
        ),
    )
    service.activate_revision(
        dataset_id,
        data_epoch=first["data_epoch"],
        expected_current_epoch=second["data_epoch"],
    )

    revision_pinned = Event()
    continue_query = Event()
    original_active_revision = service._active_revision

    def pause_after_pinning(
        requested_dataset_id: str,
    ) -> tuple[dict[str, object], Path]:
        resolved = original_active_revision(requested_dataset_id)
        if not revision_pinned.is_set():
            revision_pinned.set()
            assert continue_query.wait(timeout=5)
        return resolved

    monkeypatch.setattr(service, "_active_revision", pause_after_pinning)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            service.query,
            dataset_id,
            interval=query_interval,
            limit=10,
        )
        assert revision_pinned.wait(timeout=5)
        try:
            service.activate_revision(
                dataset_id,
                data_epoch=second["data_epoch"],
                expected_current_epoch=first["data_epoch"],
            )
        finally:
            continue_query.set()
        page = future.result(timeout=5)

    assert page["data_epoch"] == first["data_epoch"]
    assert page["availability_revision"] == first["data_epoch"]
    assert page["excluded_ranges"] == []
    assert page["verified_contiguous"] is True
    assert [row["time"] for row in page["data"]] == expected_times
    assert [row["close"] for row in page["data"]] == expected_closes
    assert service.get_manifest(dataset_id)["data_epoch"] == second["data_epoch"]


def test_resampling_omits_incomplete_gap_buckets(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(tmp_path / "bars.csv", _interval_csv(rows=8, missing={3})),
        LocalImportOptions(
            name="BTC with one missing component",
            symbol="BTC-USDT",
            interval="15m",
            timestamp_unit="ms",
        ),
    )

    hourly = service.query(manifest["dataset_id"], interval="1h", limit=10)

    assert [row["time"] for row in hourly["data"]] == [1_704_070_800]
    assert hourly["resampling"] == {
        "policy": "complete_buckets_only",
        "incomplete_buckets_omitted": True,
    }
    assert hourly["verified_contiguous"] is False


def test_canonical_derived_bars_keep_decimal_text(tmp_path: Path) -> None:
    service = LocalDatasetService(tmp_path / "local-data")
    manifest = service.import_csv(
        _write_csv(
            tmp_path / "precise.csv",
            "time,open,high,low,close,volume\n"
            "1704067200000,100.1,102.25,99.5,101.0,1.25\n"
            "1704068100000,101.0,103.75,100.25,102.5,2.5\n",
        ),
        LocalImportOptions(
            name="precise",
            symbol="BTC-USDT",
            interval="15m",
            timestamp_unit="ms",
        ),
    )
    _manifest, bars = service.load_canonical_bars(
        manifest["dataset_id"],
        data_epoch=manifest["data_epoch"],
        interval="30m",
    )
    assert bars[0]["high"] == "103.75"
    assert bars[0]["low"] == "99.5"
    assert bars[0]["volume"] == "3.75"
    assert "." not in str(bars[0]["high"]) or "e" not in str(bars[0]["high"]).lower()


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
    with pytest.raises(LocalDatasetError) as error:
        service.query(manifest["dataset_id"], interval="4h", limit=10)
    assert error.value.code == "interval_alignment_incompatible"
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
    derived = service.query(manifest["dataset_id"], interval="2d", limit=10)
    assert derived["derived"] is True
    assert derived["volume_available"] is False
    assert [row["volume"] for row in derived["data"]] == [None]
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
