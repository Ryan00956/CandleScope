from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings


def _service(tmp_path: Path) -> BacktestService:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    return BacktestService.start(settings, now_ms=10)


def _context(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "source_workspace_id": "workspace-main",
        "source_cell_id": "cell-main",
        "strategy_draft_id": "draft-12345678",
        "strategy_revision_id": "builtin-sma-cross-v1",
        "parameters": {"fast": 3, "slow": 5},
        "quick_preset_id": "crypto-perp-conservative-v1",
        "chart_session": {
            "exchange": "binance",
            "market_type": "usdm",
            "symbol": "BTCUSDT",
            "interval": "15m",
        },
        "range": {
            "mode": "CUSTOM",
            "start_time_ms": 1_700_000_000_000,
            "end_time_ms": 1_700_086_400_000,
        },
        "dataset_identity": {
            "dataset_id": "local-0123456789abcdef0123456789abcdef",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
        },
        "latest_run_id": None,
        "baseline_run_id": None,
    }
    payload.update(overrides)
    return payload


def test_research_context_is_immutable_and_integrity_checked(tmp_path: Path) -> None:
    service = _service(tmp_path)
    try:
        created = service.create_research_launch_context(_context(), now_ms=20)
        assert str(created["context_id"]).startswith("brc_")
        assert created["schema_version"] == (
            "candlescope.backtest-research-launch-context/1"
        )
        restored = service.get_research_launch_context(str(created["context_id"]))
        assert restored == created
        row = service.repository.get_research_launch_context(str(created["context_id"]))
        assert row is not None
        mutated = json.loads(str(row["payload_json"]))
        mutated["parameters"]["fast"] = 99
        service.repository.connection.execute(
            "UPDATE backtest_research_launch_contexts SET payload_json = ? WHERE context_id = ?",
            (json.dumps(mutated), created["context_id"]),
        )
        service.repository.connection.commit()
        with pytest.raises(BacktestError, match="IDENTITY_MUTATION"):
            service.get_research_launch_context(str(created["context_id"]))
    finally:
        service.shutdown()


def test_research_context_rejects_unknown_authoritative_ids(tmp_path: Path) -> None:
    service = _service(tmp_path)
    try:
        with pytest.raises(BacktestError, match="unknown run"):
            service.create_research_launch_context(
                _context(latest_run_id="bt_missing_12345678")
            )
        with pytest.raises(BacktestError, match="unknown strategy revision"):
            service.create_research_launch_context(
                _context(strategy_revision_id="rev-missing")
            )
    finally:
        service.shutdown()


def test_research_context_http_round_trip_and_validation(tmp_path: Path) -> None:
    service = _service(tmp_path)
    api = FastAPI()
    from app.api.v1.backtests import router

    api.include_router(router, prefix="/api/v1")
    api.state.backtest_service = service
    api.state.runtime_mode = "LOCAL_OFFLINE"
    client = TestClient(api)
    try:
        capabilities = client.get("/api/v1/backtests/capabilities")
        assert capabilities.status_code == 200
        assert capabilities.json()["runtime_mode"] == "LOCAL_OFFLINE"
        assert capabilities.json()["flags"]["BACKTEST_REPLAY_TRAINING_AVAILABLE"] is False
        api.state.replay_service = type(
            "ReplayServiceProbe", (), {"training": object()}
        )()
        assert client.get("/api/v1/backtests/capabilities").json()["flags"][
            "BACKTEST_REPLAY_TRAINING_AVAILABLE"
        ] is True
        created = client.post(
            "/api/v1/backtests/research/contexts",
            json=_context(entry_task="PARAMETER_ROBUSTNESS"),
        )
        assert created.status_code == 200, created.text
        assert created.json()["entry_task"] == "PARAMETER_ROBUSTNESS"
        context_id = created.json()["context_id"]
        restored = client.get(f"/api/v1/backtests/research/contexts/{context_id}")
        assert restored.status_code == 200
        assert restored.json() == created.json()
        invalid = client.post(
            "/api/v1/backtests/research/contexts",
            json=_context(parameters={}, extra="forbidden"),
        )
        assert invalid.status_code == 422
        invalid_task = client.post(
            "/api/v1/backtests/research/contexts",
            json=_context(entry_task="NOT_A_RESEARCH_TASK"),
        )
        assert invalid_task.status_code == 422
        missing = client.get(
            "/api/v1/backtests/research/contexts/brc_missing_12345678"
        )
        assert missing.status_code == 400
    finally:
        service.shutdown()


def test_schema_v7_rollback_is_empty_only_and_preserves_contexts_on_refusal(
    tmp_path: Path,
) -> None:
    from app.backtest.research_context_rollback import rollback_research_contexts

    empty_root = tmp_path / "empty"
    empty_root.mkdir()
    empty_path = empty_root / "backtest.db"
    empty = _service(empty_root)
    empty.shutdown()
    receipt = rollback_research_contexts(empty_path)
    assert receipt == {
        "schemaVersion": 6,
        "droppedResearchContexts": True,
        "researchContextRows": 0,
    }
    connection = sqlite3.connect(empty_path)
    assert connection.execute(
        "SELECT schema_version FROM backtest_schema_meta"
    ).fetchone()[0] == 6
    assert connection.execute(
        "SELECT 1 FROM sqlite_master WHERE name='backtest_research_launch_contexts'"
    ).fetchone() is None
    connection.close()

    populated_root = tmp_path / "populated"
    populated_root.mkdir()
    populated_path = populated_root / "backtest.db"
    populated = _service(populated_root)
    context = populated.create_research_launch_context(_context(), now_ms=30)
    populated.shutdown()
    with pytest.raises(RuntimeError, match="context rows exist"):
        rollback_research_contexts(populated_path)
    connection = sqlite3.connect(populated_path)
    assert connection.execute(
        "SELECT schema_version FROM backtest_schema_meta"
    ).fetchone()[0] == 7
    assert connection.execute(
        "SELECT COUNT(*) FROM backtest_research_launch_contexts"
    ).fetchone()[0] == 1
    connection.close()
    assert context["context_id"]
