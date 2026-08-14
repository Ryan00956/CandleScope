from __future__ import annotations

import ast
import sys
import types
from pathlib import Path

import pytest

if "pyne_runtime" not in sys.modules:
    _stub = types.ModuleType("pyne_runtime")
    _stub.__version__ = "0.3.0rc2"
    _stub.REQUEST_SECURITY_API = "request.security"
    _stub.REQUEST_SECURITY_LOWER_TF_API = "request.security.lower"
    sys.modules["pyne_runtime"] = _stub

from candlescope_plugin_sdk.strategy_provider_v1.models import ObservationFrame
from candlescope_plugin_sdk.strategy_provider_v1.session import (
    StrategyProviderError,
    StrategyProviderSession,
    canonical_hash,
)

from candlescope_plugin_pyne import SMA_CROSS_SOURCE, PyneStrategyProvider, source_hash


SOURCE_ROOT = Path(__file__).parents[1] / "src" / "candlescope_plugin_pyne"


def _frame(sequence: int, close: str, *, time: int | None = None) -> ObservationFrame:
    stamp = time if time is not None else 1_700_000_000 + sequence * 60
    bar = {
        "time": stamp,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": "1",
    }
    return ObservationFrame(
        run_id="bt_pyne",
        sequence=sequence,
        event_time_ms=stamp * 1000,
        watermark_ms=stamp * 1000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash(bar),
        bar=bar,
    )


def _session() -> StrategyProviderSession:
    provider = PyneStrategyProvider()
    session = StrategyProviderSession(provider, run_id="bt_pyne")
    session.prepare(
        {
            "inputPlan": {"roles": ["BARS"]},
            "source": SMA_CROSS_SOURCE,
            "parameters": {"fast": 3, "slow": 5},
        }
    )
    return session


def test_sma_cross_session_matches_batch_prefixes() -> None:
    closes = ["10", "10", "10", "10", "10", "20", "20"]
    session = _session()
    outputs = []
    for index, close in enumerate(closes, start=1):
        outputs.append(session.step(_frame(index, close)))
    assert outputs[5] is not None
    assert outputs[5].kind == "TARGET_POSITION"
    assert outputs[5].payload["targetExposure"] == "1"
    replayed = _session()
    for index, close in enumerate(closes, start=1):
        again = replayed.step(_frame(index, close))
        left = None if outputs[index - 1] is None else outputs[index - 1].output_hash
        right = None if again is None else again.output_hash
        assert left == right


def test_snapshot_restore_replays_the_same_state() -> None:
    session = _session()
    for index, close in enumerate(["10", "10", "10", "10", "10", "20"], start=1):
        session.step(_frame(index, close))
    original_hash = session.provider.identity()["sourceHash"]
    snap = session.snapshot()
    restored_provider = PyneStrategyProvider()
    restored = StrategyProviderSession(restored_provider, run_id="bt_pyne")
    restored.restore(snap)
    assert restored_provider.identity()["sourceHash"] == original_hash
    assert original_hash == source_hash(session.provider.snapshot()["source"])
    next_output = restored.step(_frame(7, "20", time=1_700_000_000 + 7 * 60))
    continued = _session()
    for index, close in enumerate(["10", "10", "10", "10", "10", "20", "20"], start=1):
        last = continued.step(_frame(index, close))
    assert (None if next_output is None else next_output.output_hash) == (
        None if last is None else last.output_hash
    )


def test_syntax_error_from_executor_is_structured() -> None:
    def boom(source, bars, params, options):
        raise StrategyProviderError("PYNE_RUNTIME_ERROR", "unexpected token")

    provider = PyneStrategyProvider(executor=boom)
    session = StrategyProviderSession(provider, run_id="bt_pyne")
    session.prepare({"inputPlan": {"roles": ["BARS"]}, "source": "indicator("})
    with pytest.raises(StrategyProviderError, match="PYNE_RUNTIME_ERROR"):
        session.step(_frame(1, "10"))


def test_provider_module_does_not_import_host_or_live_clients() -> None:
    tree = ast.parse((SOURCE_ROOT / "strategy_provider.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    forbidden = ("app", "socket", "requests", "httpx", "aiohttp")
    assert not any(
        item == name or item.startswith(name + ".") for item in imported for name in forbidden
    )
