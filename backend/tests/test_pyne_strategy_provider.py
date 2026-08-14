from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "packages" / "candlescope-plugin-pyne" / "src"))
sys.path.insert(0, str(REPO / "packages" / "candlescope-plugin-sdk" / "src"))
if "pyne_runtime" not in sys.modules:
    _stub = types.ModuleType("pyne_runtime")
    _stub.__version__ = "0.3.0rc2"
    _stub.REQUEST_SECURITY_API = "request.security"
    _stub.REQUEST_SECURITY_LOWER_TF_API = "request.security.lower"
    sys.modules["pyne_runtime"] = _stub

from candlescope_plugin_pyne.strategy_provider import SMA_CROSS_SOURCE, PyneStrategyProvider
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _events() -> tuple[MarketEvent, ...]:
    closes = (10, 10, 10, 10, 10, 20, 20, 20)
    events = []
    for index, close in enumerate(closes, start=1):
        events.append(
            MarketEvent(
                sequence=index,
                event_time_ms=(1_700_000_000 + index * 60) * 1000,
                role="BARS",
                payload={
                    "open_time_ms": (1_700_000_000 + (index - 1) * 60) * 1000,
                    "close_time_ms": (1_700_000_000 + index * 60) * 1000,
                    "open": str(close),
                    "high": str(close),
                    "low": str(close),
                    "close": str(close),
                    "volume": "1",
                    "time": 1_700_000_000 + index * 60,
                },
            )
        )
    return tuple(events)


def _payload() -> dict[str, object]:
    return {
        "strategy_revision_id": "pyne-sma-cross",
        "dataset_id": "local-0123456789abcdef0123456789abcdef",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 1,
        "end_time_ms": 2,
        "source": SMA_CROSS_SOURCE,
        "parameters": {"fast": 3, "slow": 5},
    }


def test_pyne_bar_run_completes_and_host_owns_fills(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    created = service.create_run(_payload(), idempotency_key="pyne-1", now_ms=2)
    completed = service.execute_bar_run(
        created["run_id"],
        events=_events(),
        provider=PyneStrategyProvider(),
        now_ms=3,
    )
    assert completed["state"] == "COMPLETED"
    fills = completed["result"]["fills"]
    assert fills
    assert fills[0]["reason"] == "NEXT_BAR_OPEN"
    assert fills[0]["sequence"] == 7
    assert "provider" not in str(fills[0]).lower() or fills[0]["reason"] != "PROVIDER"
    rerun = BacktestService.start(_settings(tmp_path / "b"), now_ms=1)
    again = rerun.create_run(_payload(), idempotency_key="pyne-2", now_ms=2)
    second = rerun.execute_bar_run(again["run_id"], events=_events(), provider=PyneStrategyProvider(), now_ms=3)
    assert second["result"]["report_hash"] == completed["result"]["report_hash"]
    service.shutdown()
    rerun.shutdown()


def test_workbench_entrypoint_does_not_request_live_data() -> None:
    source = Path(
        REPO
        / "packages"
        / "candlescope-plugin-pyne-workbench"
        / "src"
        / "candlescope_plugin_pyne_workbench"
        / "strategy_entrypoint.py"
    ).read_text(encoding="utf-8")
    assert "market.bars.read" not in source
    assert "chart.context.read" not in source
    assert "create_provider" in source


def test_provider_cannot_emit_host_fills() -> None:
    provider = PyneStrategyProvider()
    assert not hasattr(provider, "fill")
    assert not hasattr(provider, "place_order")
