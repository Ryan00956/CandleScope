from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.local_data.service import LocalDatasetService, LocalImportOptions


def test_runtime_executes_queued_run_from_immutable_local_snapshot(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "bars.csv"
    rows = [
        "time,open,high,low,close,volume",
        "0,10,10,10,10,1",
        "60000,10,10,10,10,1",
        "120000,10,10,10,10,1",
        "180000,10,10,10,10,1",
        "240000,10,10,10,10,1",
        "300000,20,20,20,20,1",
        "360000,20,20,20,20,1",
        "420000,20,20,20,20,1",
    ]
    csv_path.write_text("\n".join(rows), encoding="utf-8")
    local = LocalDatasetService(local_root)
    manifest = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="runtime fixture",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        preview = runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=0,
            end_time_ms=480_000,
            interval="1m",
        )
        created = runtime.service.create_run(
            {
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": manifest["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": 0,
                "end_time_ms": 480_000,
                "interval": "1m",
                "parameters": {"fast": 3, "slow": 5},
            },
            idempotency_key="runtime-e2e",
        )
        deadline = time.monotonic() + 5
        record = created
        while time.monotonic() < deadline:
            record = runtime.service.get_run(str(created["run_id"]))
            if record["state"] in {"COMPLETED", "FAILED"}:
                break
            time.sleep(0.05)
        assert record["state"] == "COMPLETED"
        report = runtime.service.get_report(str(created["run_id"]))
        assert report["hashes"]["report"].startswith("sha256:")
        assert report["report_label"] == "APPROXIMATE"
    finally:
        runtime.shutdown()


def test_runtime_materializes_study_beyond_active_run_ceiling(tmp_path: Path) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "study-bars.csv"
    rows = ["time,open,high,low,close,volume"]
    rows.extend(
        f"{index * 60_000},{100 + index},{101 + index},{99 + index},{100 + index},1"
        for index in range(20)
    )
    csv_path.write_text("\n".join(rows), encoding="utf-8")
    local = LocalDatasetService(local_root)
    manifest = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="study runtime fixture",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_STUDY_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.max_active_runs == 4
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        created = runtime.service.create_study(
            {
                "name": "six-trial-runtime",
                "hypothesis": "queued trials are not concurrent active runs",
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": manifest["data_epoch"],
                "interval": "1m",
                "start_ms": 0,
                "end_ms": 1_200_000,
                "train_ms": 300_000,
                "test_ms": 300_000,
                "step_ms": 300_000,
                "parameter_space": {"fast": [2, 3]},
                "parameters": {"slow": 5, "qty": "1"},
                "max_trials": 6,
            }
        )
        runtime.service.start_study(str(created["study_id"]))
        materialized = runtime.materialize_study(str(created["study_id"]))
        assert len(materialized["trials"]) == 6

        deadline = time.monotonic() + 10
        current = materialized
        while time.monotonic() < deadline:
            current = runtime.service.get_study(str(created["study_id"]))
            if current["state"] in {"COMPLETED", "FAILED", "CANCELLED"}:
                break
            time.sleep(0.05)
        assert current["state"] == "COMPLETED"
        assert {trial["state"] for trial in current["trials"]} == {"COMPLETED"}
    finally:
        runtime.shutdown()


def test_runtime_background_coordinator_materializes_study_without_http_work(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "background-study.csv"
    rows = ["time,open,high,low,close,volume"]
    rows.extend(
        f"{index * 60_000},{100 + index},{101 + index},{99 + index},{100 + index},1"
        for index in range(12)
    )
    csv_path.write_text("\n".join(rows), encoding="utf-8")
    manifest = LocalDatasetService(local_root).import_csv(
        csv_path,
        LocalImportOptions(
            name="background study",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_STUDY_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        study = runtime.service.create_study(
            {
                "name": "background",
                "hypothesis": "durable coordinator",
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": manifest["data_epoch"],
                "interval": "1m",
                "start_ms": 0,
                "end_ms": 720_000,
                "train_ms": 240_000,
                "test_ms": 240_000,
                "step_ms": 240_000,
                "parameter_space": {"fast": [2]},
                "parameters": {"slow": 3},
                "max_trials": 1,
            }
        )
        runtime.service.start_study(str(study["study_id"]))
        deadline = time.monotonic() + 8
        current = runtime.service.get_study(str(study["study_id"]))
        while time.monotonic() < deadline and current["state"] == "RUNNING":
            time.sleep(0.05)
            current = runtime.service.get_study(str(study["study_id"]))
        assert current["state"] == "COMPLETED"
        assert len(current["trials"]) == 1
        assert current["trials"][0]["state"] == "COMPLETED"
    finally:
        runtime.shutdown()


def test_runtime_command_script_produces_chart_markers_trades_and_equity(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "command-bars.csv"
    rows = ["time,open,high,low,close,volume"]
    rows.extend(
        f"{index * 60_000},{100 + index},{101 + index},{99 + index},{100 + index},1"
        for index in range(12)
    )
    csv_path.write_text("\n".join(rows), encoding="utf-8")
    manifest = LocalDatasetService(local_root).import_csv(
        csv_path,
        LocalImportOptions(
            name="command runtime fixture",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        preview = runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=0,
            end_time_ms=720_000,
            interval="1m",
        )
        created = runtime.service.create_run(
            {
                "strategy_revision_id": "builtin-order-command-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": manifest["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": 0,
                "end_time_ms": 720_000,
                "interval": "1m",
                "strategy_source": json.dumps(
                    {
                        "commands": [
                            {"sequence": 2, "action": "OPEN_LONG", "qty": "1"},
                            {"sequence": 6, "action": "CLOSE_LONG", "qty": "1"},
                        ]
                    }
                ),
                "output_mode": "ORDER_INTENT",
                "taker_fee_bps": "4",
            },
            idempotency_key="runtime-command-e2e",
        )
        deadline = time.monotonic() + 8
        record = created
        while time.monotonic() < deadline:
            record = runtime.service.get_run(str(created["run_id"]))
            if record["state"] in {"COMPLETED", "FAILED"}:
                break
            time.sleep(0.05)
        assert record["state"] == "COMPLETED"
        report = runtime.service.get_report(str(created["run_id"]))
        assert report["metrics"]["fill_count"] == 2
        assert report["metrics"]["trade_count"] == 1
        assert len(report["equity_curve"]) == 12
        assert report["account"]["fees_paid"] != "0"
        chart = runtime.chart_data(str(created["run_id"]))
        assert len(chart["bars"]) == 12
        assert len(chart["fills"]) == 2
        assert chart["symbol"] == "BTCUSDT"
    finally:
        runtime.shutdown()


def test_runtime_executes_verified_aggregate_trade_snapshot(tmp_path: Path) -> None:
    start_ms = 1_780_000_000_000
    archive_dir = tmp_path / "agg-trades"
    rows = [
        {
            "exchange": "binance",
            "market_type": "usdm",
            "symbol": "BTCUSDT",
            "agg_trade_id": 1_000 + index,
            "first_trade_id": 2_000 + index,
            "last_trade_id": 2_000 + index,
            "price": 100 + index,
            "quantity": 1,
            "trade_time_ms": start_ms + index * 1_000,
            "event_time_ms": start_ms + index * 1_000,
            "received_at_ms": start_ms + index * 1_000 + 1,
            "is_buyer_maker": index % 2 == 0,
            "source": "binance_public_archive",
        }
        for index in range(24)
    ]
    day = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).date().isoformat()
    writer = ParquetRawAggTradeArchive(archive_dir, max_rows_per_file=8)
    writer.import_verified_day(
        rows,
        VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="usdm",
            symbol="BTCUSDT",
            date=day,
            source_url="https://data.binance.vision/fixture.zip",
            source_file="fixture.zip",
            source_checksum_sha256="a" * 64,
            row_count=len(rows),
            first_agg_trade_id=1_000,
            last_agg_trade_id=1_023,
            first_trade_time_ms=start_ms,
            last_trade_time_ms=start_ms + 23_000,
        ),
    )

    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "trade-anchor.csv"
    csv_rows = ["time,open,high,low,close,volume"]
    csv_rows.extend(
        f"{start_ms + index * 1_000},{100 + index},{100 + index},{100 + index},{100 + index},1"
        for index in range(24)
    )
    csv_path.write_text("\n".join(csv_rows), encoding="utf-8")
    manifest = LocalDatasetService(local_root).import_csv(
        csv_path,
        LocalImportOptions(
            name="trade anchor",
            symbol="BTCUSDT",
            interval="1s",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(
        settings,
        local_data_dir=local_root,
        trade_archive_dir=archive_dir,
    )
    try:
        preview = runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=start_ms,
            end_time_ms=start_ms + 23_000,
            interval="1s",
            fidelity_mode="AGG_TRADE_TAPE",
            exchange="binance",
            market_type="usdm",
        )
        assert preview["row_count"] == 24
        assert preview["data_epoch"] != manifest["data_epoch"]
        created = runtime.service.create_run(
            {
                "strategy_revision_id": "builtin-order-command-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": preview["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "AGG_TRADE_TAPE",
                "start_time_ms": start_ms,
                "end_time_ms": start_ms + 23_000,
                "interval": "1s",
                "exchange": "binance",
                "market_type": "usdm",
                "strategy_source": json.dumps(
                    {
                        "commands": [
                            {"sequence": 2, "action": "OPEN_LONG", "qty": "1"},
                            {"sequence": 10, "action": "CLOSE_LONG", "qty": "1"},
                        ]
                    }
                ),
                "output_mode": "ORDER_INTENT",
            },
            idempotency_key="runtime-trade-e2e",
        )
        deadline = time.monotonic() + 8
        record = created
        while time.monotonic() < deadline:
            record = runtime.service.get_run(str(created["run_id"]))
            if record["state"] in {"COMPLETED", "FAILED"}:
                break
            time.sleep(0.05)
        assert record["state"] == "COMPLETED", record
        report = runtime.service.get_report(str(created["run_id"]))
        assert report["report_label"] == "AGGREGATED_TRADE_SEQUENCE"
        assert report["metrics"]["trade_count"] == 1
        chart = runtime.chart_data(str(created["run_id"]))
        assert len(chart["bars"]) == 24
        assert len(chart["fills"]) == 2
    finally:
        runtime.shutdown()
