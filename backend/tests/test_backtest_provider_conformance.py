from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import (
    DeterministicFakeProvider,
    ObservationFrame,
    StrategyOutput,
    StrategyProviderError,
    StrategyProviderSession,
    canonical_hash,
)
from app.core.config import load_backtest_settings


def _frame(sequence: int) -> ObservationFrame:
    bar = {"close": "101"}
    return ObservationFrame(
        run_id="bt_test",
        sequence=sequence,
        event_time_ms=sequence * 1000,
        watermark_ms=sequence * 1000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash(bar),
        bar=bar,
    )


def test_unknown_output_kind_and_out_of_order_sequence_fail_closed() -> None:
    with pytest.raises(ValueError, match="unsupported"):
        StrategyOutput(
            sequence=1,
            kind="FILL",
            payload={},
            state_hash="sha256:a",
            output_hash="sha256:b",
        )
    session = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    session.prepare({"inputPlan": {"roles": ["BARS"]}})
    session.step(_frame(2))
    with pytest.raises(StrategyProviderError, match="sequence|watermark"):
        session.step(_frame(1))


def test_incompatible_snapshot_is_rejected() -> None:
    session = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    with pytest.raises(StrategyProviderError, match="snapshot incompatible"):
        session.restore({"generation": 1})


def test_canonical_encoding_is_stable_and_rejects_nan() -> None:
    assert canonical_hash({"b": 1, "a": 2}) == canonical_hash({"a": 2, "b": 1})
    with pytest.raises(ValueError):
        json.dumps({"score": float("nan")}, allow_nan=False)


def test_http_unknown_run_field_is_rejected(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    api = FastAPI()
    from app.api.v1.backtests import router

    api.include_router(router, prefix="/api/v1")
    api.state.backtest_service = service
    client = TestClient(api)
    response = client.post(
        "/api/v1/backtests/runs/validate",
        json={
            "strategy_revision_id": "rev",
            "dataset_id": "ds-0123456789abcdef0123456789abcdef",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": 1,
            "end_time_ms": 2,
            "extra_secret": "nope",
        },
    )
    assert response.status_code == 422
    service.shutdown()
