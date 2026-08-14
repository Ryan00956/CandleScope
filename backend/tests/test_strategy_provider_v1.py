from __future__ import annotations

import json

import pytest

from app.backtest.strategy.host_adapter import StrategyHostAdapter
from app.backtest.strategy.protocol import (
    CONTRIBUTION_KIND,
    CrashProvider,
    DeterministicFakeProvider,
    ObservationFrame,
    StrategyProviderError,
    StrategyProviderSession,
    TimeoutProvider,
    canonical_hash,
)
from candlescope_plugin_sdk.constants import PROTOCOL_V1


def _frame(sequence: int, *, close: str = "101", phase: str = "EVALUATION") -> ObservationFrame:
    bar = {"close": close, "open_time_ms": sequence * 60_000}
    return ObservationFrame(
        run_id="bt_test",
        sequence=sequence,
        event_time_ms=sequence * 60_000,
        watermark_ms=sequence * 60_000,
        phase=phase,
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash(bar),
        bar=bar,
    )


def test_script_runtime_protocol_is_unchanged() -> None:
    assert PROTOCOL_V1 == "candlescope.script-runtime/1"
    assert CONTRIBUTION_KIND == "strategy-provider/1"


def test_fake_provider_session_is_deterministic() -> None:
    first = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    second = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    for session in (first, second):
        session.prepare({"inputPlan": {"roles": ["BARS"]}})
        session.warmup(_frame(1, phase="WARMUP"))
        session.step(_frame(2))
    assert first.snapshot()["hash"] == second.snapshot()["hash"]
    assert first.close() == second.close()


def test_warmup_cannot_trade_and_future_event_is_rejected() -> None:
    session = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    session.prepare({"inputPlan": {"roles": ["BARS"]}})
    session.warmup(_frame(1, phase="WARMUP"))
    future = ObservationFrame(
        run_id="bt_test",
        sequence=2,
        event_time_ms=3_000,
        watermark_ms=2_000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash="sha256:x",
    )
    with pytest.raises(StrategyProviderError, match="LOOKAHEAD_VIOLATION"):
        session.step(future)


def test_stale_generation_and_nan_payload_fail_closed() -> None:
    session = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    session.prepare({"inputPlan": {"roles": ["BARS"]}})
    with pytest.raises(StrategyProviderError, match="PROVIDER_PROTOCOL_VIOLATION"):
        session.on_execution_report({"generation": 99, "accepted": True})
    with pytest.raises(ValueError):
        json.dumps({"score": float("nan")}, allow_nan=False)


def test_crash_and_timeout_providers_fail_closed() -> None:
    crash = StrategyProviderSession(CrashProvider(), run_id="bt_test")
    crash.prepare({"inputPlan": {"roles": ["BARS"]}})
    with pytest.raises(StrategyProviderError, match="PROVIDER_CRASH_UNRECOVERABLE"):
        crash.step(_frame(1))
    timeout = StrategyProviderSession(TimeoutProvider(), run_id="bt_test")
    timeout.prepare({"inputPlan": {"roles": ["BARS"]}})
    with pytest.raises(StrategyProviderError, match="PROVIDER_TIMEOUT"):
        timeout.step(_frame(1))


def test_host_adapter_rejects_provider_writes() -> None:
    session = StrategyProviderSession(DeterministicFakeProvider(), run_id="bt_test")
    adapter = StrategyHostAdapter(session, step_timeout_s=1)
    adapter.start({"roles": ["BARS"]})
    output = adapter.observe(
        sequence=1,
        event_time_ms=1000,
        watermark_ms=1000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        bar={"close": "101"},
    )
    assert output is not None
    assert output["kind"] == "SIGNAL"
    with pytest.raises(StrategyProviderError, match="PROVIDER_UNAUTHORIZED_WRITE"):
        adapter.reject_host_write("orders")
