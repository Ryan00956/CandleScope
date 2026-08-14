from __future__ import annotations

import pytest

from tests.backtest_contract.spec import (
    BoundedBarView,
    ContractError,
    ReferenceBarKernel,
    sample_bars,
)


def test_observation_view_cannot_see_future_bars() -> None:
    bars = sample_bars()
    view = BoundedBarView(tuple(bars[:2]), watermark_ms=bars[1].close_time_ms)
    assert view[1].sequence == 2
    with pytest.raises(ContractError, match="LOOKAHEAD_VIOLATION"):
        _ = view[2]


def test_new_market_order_cannot_fill_on_the_observed_bar() -> None:
    bars = sample_bars()
    seen_closes: list[str] = []

    def strategy(view: BoundedBarView) -> list[dict]:
        seen_closes.append(str(view[-1].close))
        if view[-1].sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    result = ReferenceBarKernel().run(bars, strategy)
    assert seen_closes[0] == "105"
    assert result["fills"][0]["sequence"] == 2
    assert result["fills"][0]["reason"] == "NEXT_BAR_OPEN"
    assert str(result["fills"][0]["price"]) == "105.0105"


def test_warmup_outputs_are_not_tradable() -> None:
    bars = sample_bars()

    def always_buy(view: BoundedBarView) -> list[dict]:
        return [{"side": "BUY", "type": "MARKET", "qty": "1"}]

    warmed = ReferenceBarKernel().run(bars, always_buy, warmup_bars=1)
    live = ReferenceBarKernel().run(bars, always_buy, warmup_bars=0)
    assert [fill["sequence"] for fill in warmed["fills"]] == [3, 4]
    assert [fill["sequence"] for fill in live["fills"]] == [2, 3, 4]


def test_training_artifact_cannot_see_past_its_horizon() -> None:
    from app.backtest.strategy.artifacts import FeatureSchema, ModelArtifact
    from app.backtest.strategy.external import assert_no_lookahead
    from app.backtest.strategy.protocol import ObservationFrame, StrategyProviderError, canonical_hash

    artifact = ModelArtifact(
        model_artifact_id="feat-1",
        format="ONNX",
        artifact_hash="sha256:" + "ab" * 32,
        feature_schema=FeatureSchema(version="feat/1", names=("close",)),
        max_visible_time_ms=1_000,
        reproducibility_class="DETERMINISTIC",
    )
    frame = ObservationFrame(
        run_id="bt",
        sequence=2,
        event_time_ms=2_000,
        watermark_ms=2_000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash({"close": "1"}),
        bar={"close": "1"},
        features={"close": "1"},
    )
    with pytest.raises(StrategyProviderError, match="LOOKAHEAD_VIOLATION"):
        assert_no_lookahead(frame, artifact)


def test_existing_orders_match_before_new_decision() -> None:
    bars = sample_bars()

    def strategy(view: BoundedBarView) -> list[dict]:
        if view[-1].sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    kernel = ReferenceBarKernel()
    kernel.run(bars, strategy)
    assert kernel.event_trace.index("match:2") < kernel.event_trace.index("decide:2")
    assert kernel.fills[0].sequence == 2
