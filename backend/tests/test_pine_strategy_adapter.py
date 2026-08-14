from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.backtest.strategy.pine_adapter import (
    MATRIX_VERSION,
    PINE_LONG_FLAT_SOURCE,
    PineStrategyProvider,
    analyze_pine_strategy,
)
from app.backtest.strategy.protocol import (
    ObservationFrame,
    StrategyProviderError,
    StrategyProviderSession,
    canonical_hash,
)
from app.backtest.strategy.pyne_adapter import PyneHostPlanner
from candlescope_plugin_sdk.constants import PROTOCOL_V1


def _frame(sequence: int, close: str) -> ObservationFrame:
    bar = {"close": close}
    return ObservationFrame(
        run_id="bt_pine",
        sequence=sequence,
        event_time_ms=sequence * 1000,
        watermark_ms=sequence * 1000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash(bar),
        bar=bar,
    )


def test_unsupported_pine_strategy_is_rejected() -> None:
    rejected = analyze_pine_strategy("strategy('x')\nstrategy.order('o', strategy.long)")
    assert "strategy.order" in rejected
    provider = PineStrategyProvider()
    with pytest.raises(StrategyProviderError, match="unsupported"):
        provider.prepare({"source": "strategy('x', calc_on_every_tick=true)"})


def test_supported_subset_is_deterministic_and_not_tv_equivalent() -> None:
    first = StrategyProviderSession(PineStrategyProvider(), run_id="bt_pine")
    second = StrategyProviderSession(PineStrategyProvider(), run_id="bt_pine")
    for session in (first, second):
        session.prepare({"inputPlan": {"roles": ["BARS"]}, "source": PINE_LONG_FLAT_SOURCE})
        session.step(_frame(1, "101"))
    assert first.close() == second.close()
    output = StrategyProviderSession(PineStrategyProvider(), run_id="bt_pine")
    output.prepare({"inputPlan": {"roles": ["BARS"]}, "source": PINE_LONG_FLAT_SOURCE})
    wire = output.step(_frame(1, "101"))
    assert wire is not None
    assert wire.payload["targetExposure"] == "1"
    assert wire.payload["matrixVersion"] == MATRIX_VERSION
    assert output.provider.identity()["tradingViewEquivalent"] is False
    assert PyneHostPlanner().plan(wire)[0]["side"] == "BUY"


def test_pine_indicator_runtime_contract_is_unchanged() -> None:
    assert PROTOCOL_V1 == "candlescope.script-runtime/1"


def test_public_long_flat_golden_corpus() -> None:
    golden = json.loads(
        (
            Path(__file__).resolve().parent / "fixtures" / "backtest" / "pine_long_flat_golden.json"
        ).read_text(encoding="utf-8")
    )
    assert golden["tradingViewEquivalent"] is False
    session = StrategyProviderSession(PineStrategyProvider(), run_id="bt_pine")
    session.prepare({"inputPlan": {"roles": ["BARS"]}, "source": PINE_LONG_FLAT_SOURCE})
    for case in golden["cases"]:
        output = session.step(_frame(int(case["sequence"]), str(case["close"])))
        assert output is not None
        assert output.payload["targetExposure"] == case["targetExposure"]
        assert output.payload["matrixVersion"] == golden["matrixVersion"]
    assert session.provider.identity()["tradingViewEquivalent"] is False
