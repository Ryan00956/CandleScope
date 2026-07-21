from __future__ import annotations

from typing import Any

import pytest

from app import main as main_module
from app.plugin_runtime import RuntimeHostService
from app.plugin_runtime.registry import RuntimeRegistry


class _LagMonitor:
    def __init__(self, *, interval_seconds: float) -> None:
        self.interval_seconds = interval_seconds
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    def snapshot(self) -> dict[str, str]:
        return {"status": "ok"}


class _Host(RuntimeHostService):
    def __init__(self) -> None:
        super().__init__(
            RuntimeRegistry(),
            host_name="CandleScope",
            host_version="0.3.0",
        )
        self.start_calls = 0
        self.stop_calls = 0

    async def start(self) -> None:
        self.start_calls += 1

    async def stop(self) -> None:
        self.stop_calls += 1

    def health_summary(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "configured": 1,
            "enabled": 1,
            "ready": 1,
            "failed": 0,
        }


def _patch_startup_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    host: _Host,
) -> None:
    import app.plugin_runtime as plugin_runtime_module

    monkeypatch.setattr(main_module, "EventLoopLagMonitor", _LagMonitor)
    monkeypatch.setattr(main_module, "init_klines_storage", lambda: None)
    monkeypatch.setattr(main_module, "init_market_metrics_storage", lambda: None)
    monkeypatch.setattr(main_module, "init_trade_flow_storage", lambda _path: None)
    monkeypatch.setattr(main_module, "init_liquidation_storage", lambda _path: None)
    monkeypatch.setattr(
        plugin_runtime_module,
        "build_runtime_host_from_environment",
        lambda **_kwargs: host,
    )

    async def _refresh() -> dict[str, int]:
        return {"binance": 1}

    import app.api.v1.symbols as symbols_module

    monkeypatch.setattr(symbols_module, "refresh_exchange_metadata", _refresh)


@pytest.mark.anyio
async def test_application_lifecycle_owns_plugin_host_and_health_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    host = _Host()
    _patch_startup_dependencies(monkeypatch, host)

    async def _init_data_manager() -> None:
        main_module.app.state.data_manager = None

    monkeypatch.setattr(main_module, "_init_data_manager", _init_data_manager)
    await main_module.startup_event()
    try:
        assert host.start_calls == 1
        assert main_module.app.state.plugin_runtime_host is host
        health = await main_module.health_check()
        assert health["plugin_runtimes"] == host.health_summary()
        assert set(health["plugin_runtimes"]) == {
            "status",
            "configured",
            "enabled",
            "ready",
            "failed",
        }
    finally:
        await main_module.shutdown_event()
    assert host.stop_calls == 1


@pytest.mark.anyio
async def test_startup_failure_reclaims_started_plugin_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    host = _Host()
    _patch_startup_dependencies(monkeypatch, host)

    async def _fail_data_manager() -> None:
        raise RuntimeError("fatal data-engine configuration")

    monkeypatch.setattr(main_module, "_init_data_manager", _fail_data_manager)
    with pytest.raises(RuntimeError, match="fatal data-engine configuration"):
        await main_module.startup_event()

    assert host.start_calls == 1
    assert host.stop_calls == 1
    lag_monitor = main_module.app.state.event_loop_lag_monitor
    assert lag_monitor.stopped is True


@pytest.mark.anyio
async def test_plugin_host_startup_failure_stops_lag_monitor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    host = _Host()
    _patch_startup_dependencies(monkeypatch, host)

    async def _fail_start() -> None:
        host.start_calls += 1
        raise RuntimeError("required plugin failed")

    monkeypatch.setattr(host, "start", _fail_start)
    with pytest.raises(RuntimeError, match="required plugin failed"):
        await main_module.startup_event()

    assert host.start_calls == 1
    assert main_module.app.state.event_loop_lag_monitor.stopped is True
