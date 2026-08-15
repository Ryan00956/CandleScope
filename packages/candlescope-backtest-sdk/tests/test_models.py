from __future__ import annotations

import pytest

from candlescope_backtest_sdk import (
    Bar,
    Observation,
    OrderIntent,
    PythonStrategyContractError,
    Signal,
    TargetPosition,
    encode_output,
    encode_snapshot,
)


def _observation() -> Observation:
    return Observation(
        run_id="bt_1",
        revision_id="rev_1",
        generation=1,
        sequence=3,
        event_time_ms=1_700_000_180_000,
        watermark_ms=1_700_000_180_000,
        phase="STEP",
        market={"symbol": "BTCUSDT", "venue": "BINANCE"},
        bar=Bar(
            open_time_ms=1_700_000_120_000,
            close_time_ms=1_700_000_180_000,
            open="100",
            high="101",
            low="99",
            close="100.5",
            volume="2",
        ),
        features={"close": "100.5"},
        account_view={"equity": "10000"},
    )


def test_observation_wire_is_stable() -> None:
    wire = _observation().to_wire()
    parsed = Observation.from_wire(wire)
    assert parsed.sequence == 3
    assert parsed.bar.close == "100.5"
    assert wire["schemaVersion"] == "candlescope.python-strategy-observation/1"
    assert wire["inputHash"].startswith("sha256:")


def test_unknown_observation_field_is_rejected() -> None:
    wire = _observation().to_wire()
    wire["futureBars"] = []
    with pytest.raises(PythonStrategyContractError, match="UNKNOWN_FIELD"):
        Observation.from_wire(wire)


def test_nan_quantity_is_rejected() -> None:
    with pytest.raises(PythonStrategyContractError, match="NON_FINITE_NUMBER"):
        TargetPosition(quantity="NaN")


def test_three_outputs_encode_with_echoed_sequence() -> None:
    signal = encode_output(3, Signal(direction="LONG", score="0.5"))
    target = encode_output(3, TargetPosition(quantity="1"))
    intent = encode_output(
        3,
        OrderIntent(side="BUY", type="LIMIT", quantity="1", limit_price="100"),
    )
    assert signal["kind"] == "SIGNAL"
    assert target["payload"]["quantity"] == "1"
    assert intent["payload"]["type"] == "LIMIT"
    assert signal["sequence"] == target["sequence"] == intent["sequence"] == 3


def test_snapshot_must_be_json_encodable() -> None:
    encoded = encode_snapshot({"closes": ["1", "2"]})
    assert encoded["hash"].startswith("sha256:")
    with pytest.raises(PythonStrategyContractError, match="SNAPSHOT_NOT_JSON"):
        encode_snapshot({"bad": object()})
