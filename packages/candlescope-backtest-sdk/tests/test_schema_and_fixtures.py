from __future__ import annotations

import json
from pathlib import Path

import jsonschema

from candlescope_backtest_sdk import Observation, StrategyContext, encode_output
from candlescope_backtest_sdk.schema import bundle_schema

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"


def test_fixture_manifests_match_bundle_schema() -> None:
    schema = bundle_schema()
    jsonschema.Draft202012Validator.check_schema(schema)
    names = ("sma_cross", "rsi_reversion", "breakout")
    for name in names:
        manifest = json.loads((FIXTURES / name / "strategy.json").read_text(encoding="utf-8"))
        jsonschema.validate(manifest, schema)


def test_fixtures_only_depend_on_stdlib_and_sdk() -> None:
    for path in FIXTURES.rglob("strategy.py"):
        text = path.read_text(encoding="utf-8")
        assert "import " in text
        assert "candlescope_backtest_sdk" in text
        assert "app." not in text
        assert "requests" not in text
        assert "sqlite3" not in text


def test_sma_fixture_returns_target_position() -> None:
    import sys

    sys.path.insert(0, str(FIXTURES / "sma_cross"))
    from strategy import Strategy

    strategy = Strategy()
    strategy.prepare(
        StrategyContext(
            run_id="bt_1",
            revision_id="rev_1",
            parameters={"fast": 2, "slow": 3},
        )
    )
    from candlescope_backtest_sdk import Bar

    def frame(sequence: int, close: str) -> Observation:
        return Observation(
            run_id="bt_1",
            revision_id="rev_1",
            generation=1,
            sequence=sequence,
            event_time_ms=sequence * 60_000,
            watermark_ms=sequence * 60_000,
            phase="STEP",
            market={"symbol": "BTCUSDT"},
            bar=Bar(
                open_time_ms=(sequence - 1) * 60_000,
                close_time_ms=sequence * 60_000,
                open=close,
                high=close,
                low=close,
                close=close,
                volume="1",
            ),
        )

    strategy.warmup(frame(1, "10"))
    strategy.warmup(frame(2, "10"))
    output = strategy.step(frame(3, "20"))
    wire = encode_output(3, output)
    assert wire["kind"] == "TARGET_POSITION"
    assert wire["payload"]["quantity"] in {"1", "-1"}
