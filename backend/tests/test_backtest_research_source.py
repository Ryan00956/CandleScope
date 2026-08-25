from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.v1.backtests import RunCreateRequest, router as backtests_router
from app.backtest.errors import BacktestError
from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.local_data import LocalImportOptions
from app.research_data.contracts import FrozenResearchContext


CSV = """time,open,high,low,close,volume
1704067200000,100,102,99,101,10
1704067260000,101,104,100,103,12
1704067380000,103,105,102,104,8
"""


def _runtime(tmp_path: Path) -> BacktestRuntime:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHART_CONTEXT_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    return BacktestRuntime.start(settings, local_data_dir=tmp_path / "local")


def _import_csv(runtime: BacktestRuntime, tmp_path: Path) -> dict:
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(CSV, encoding="utf-8")
    return runtime.local_data.import_csv(
        csv_path,
        LocalImportOptions(
            name="BTC sample",
            symbol="BTC-USDT",
            interval="1m",
            timestamp_unit="ms",
            dataset_id="local-0123456789abcdef0123456789abcdef",
        ),
    )


def test_imported_preview_assembles_frozen_context_without_inventing_snapshot(
    tmp_path: Path,
) -> None:
    runtime = _runtime(tmp_path)
    try:
        manifest = _import_csv(runtime, tmp_path)
        frozen = runtime.freeze_imported_research_context(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            interval=manifest["interval"],
            start_time_ms=int(manifest["first_open_ms"]),
            end_time_ms=int(manifest["last_open_ms"]) + 59_999,
            symbol=manifest["symbol"],
        )
        assert isinstance(frozen, FrozenResearchContext)
        assert frozen.source_kind == "IMPORTED_DATASET"
        assert frozen.dataset_id == manifest["dataset_id"]
        assert frozen.data_epoch == manifest["data_epoch"]
        assert frozen.snapshot_hash.startswith("sha256:")
        assert frozen.capability_summary["fidelityCeiling"] == "BAR_APPROX"
        preview = runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=int(manifest["first_open_ms"]),
            end_time_ms=int(manifest["last_open_ms"]) + 59_999,
            interval="1m",
            fidelity_mode="BAR_APPROX",
            exchange="local",
            market_type="spot",
        )
        assert frozen.snapshot_hash == preview["snapshot_hash"]
        assert "TRADE_TAPE" not in (preview.get("fidelity_capabilities") or [])
    finally:
        runtime.shutdown()


def test_stale_data_epoch_fails_before_run_create(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    app = FastAPI()
    app.include_router(backtests_router, prefix="/api/v1")
    app.state.backtest_runtime = runtime
    app.state.backtest_service = runtime.service
    try:
        manifest = _import_csv(runtime, tmp_path)
        frozen = runtime.freeze_imported_research_context(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            interval=manifest["interval"],
            start_time_ms=int(manifest["first_open_ms"]),
            end_time_ms=int(manifest["last_open_ms"]) + 59_999,
            symbol=manifest["symbol"],
        )
        client = TestClient(app)
        stale = client.post(
            "/api/v1/backtests/runs/validate",
            json={
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": frozen.dataset_id,
                "data_epoch": "sha256:" + "0" * 64,
                "snapshot_hash": frozen.snapshot_hash,
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": frozen.start_time_ms,
                "end_time_ms": frozen.end_time_ms,
                "interval": frozen.interval,
                "symbol": frozen.symbol,
                "exchange": "local",
                "market_type": "spot",
            },
        )
        assert stale.status_code == 400, stale.text
        assert stale.json()["error"]["code"] in {
            "DATA_SNAPSHOT_MISMATCH",
            "DATA_QUALITY_FAILED",
            "dataset_revision_changed",
        }
        matching = client.post(
            "/api/v1/backtests/runs/validate",
            json={
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": frozen.dataset_id,
                "data_epoch": frozen.data_epoch,
                "snapshot_hash": frozen.snapshot_hash,
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": frozen.start_time_ms,
                "end_time_ms": frozen.end_time_ms,
                "interval": frozen.interval,
                "symbol": frozen.symbol,
                "exchange": "local",
                "market_type": "spot",
            },
        )
        assert matching.status_code == 200, matching.text
        assert matching.json()["snapshot"]["snapshot_hash"] == frozen.snapshot_hash
        assert "source_kind" not in matching.json()
        assert "sourceKind" not in matching.json()
    finally:
        runtime.shutdown()


def test_run_schema_has_no_source_kind_fork() -> None:
    assert "source_kind" not in RunCreateRequest.model_fields
    assert "sourceKind" not in RunCreateRequest.model_fields
    try:
        RunCreateRequest(
            strategy_revision_id="builtin-sma-cross-v1",
            dataset_id="local-0123456789abcdef0123456789abcdef",
            data_epoch="sha256:" + "a" * 64,
            snapshot_hash="sha256:" + "b" * 64,
            fidelity_mode="BAR_APPROX",
            start_time_ms=1,
            end_time_ms=2,
            source_kind="IMPORTED_DATASET",
        )
        raise AssertionError("source_kind must be forbidden on Run create")
    except ValidationError:
        pass


def test_imported_precise_fidelity_is_unsupported(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        manifest = _import_csv(runtime, tmp_path)
        try:
            runtime.preview_snapshot(
                dataset_id=manifest["dataset_id"],
                data_epoch=manifest["data_epoch"],
                start_time_ms=int(manifest["first_open_ms"]),
                end_time_ms=int(manifest["last_open_ms"]) + 59_999,
                interval="1m",
                fidelity_mode="AGG_TRADE_EXECUTION",
                exchange="local",
                market_type="spot",
            )
            raise AssertionError("imported CSV must not preview trade tape")
        except BacktestError as exc:
            assert exc.code in {"FIDELITY_UNSUPPORTED", "DATA_QUALITY_FAILED"}
    finally:
        runtime.shutdown()
