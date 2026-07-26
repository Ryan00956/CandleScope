from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app import main as main_module
from app.first_party_plugin_bootstrap import FirstPartyPluginBootstrapResult
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


class _RoutingService:
    def __init__(self) -> None:
        self.start_calls = 0
        self.stop_calls = 0
        self.fail_start = False
        self.catalog_projector: Any | None = None

    async def start(self) -> None:
        self.start_calls += 1
        if self.fail_start:
            raise RuntimeError("indicator routing failed")

    async def stop(self) -> None:
        self.stop_calls += 1

    def bind_catalog_projector(self, projector: Any) -> None:
        self.catalog_projector = projector

    def compatibility_source_catalog(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "defaultLanguage": "pyne",
            "languages": [],
            "runtimes": [],
        }

    def snapshot(self) -> dict[str, Any]:
        return {
            "started": self.start_calls > 0 and not self.fail_start,
            "routes": [
                {
                    "language": "pyne",
                    "mode": "sidecar",
                    "runtimeId": "candlescope.pyne",
                }
            ],
            "counts": {"sidecar": 0},
        }


def _patch_startup_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    host: _Host,
    platform_root: Path,
    routing: _RoutingService | None = None,
) -> _RoutingService:
    import app.plugin_runtime as plugin_runtime_module
    import app.first_party_plugin_bootstrap as first_party_bootstrap_module
    import app.indicator.runtime_service as runtime_service_module

    routing = routing or _RoutingService()

    for name in (
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT", str(platform_root))

    monkeypatch.setattr(main_module, "EventLoopLagMonitor", _LagMonitor)
    monkeypatch.setattr(main_module, "init_klines_storage", lambda: None)
    monkeypatch.setattr(main_module, "init_market_metrics_storage", lambda: None)
    monkeypatch.setattr(main_module, "init_trade_flow_storage", lambda _path: None)
    monkeypatch.setattr(main_module, "init_liquidation_storage", lambda _path: None)
    monkeypatch.setattr(
        first_party_bootstrap_module,
        "ensure_first_party_plugins_from_environment",
        lambda **_kwargs: FirstPartyPluginBootstrapResult(
            status="ready",
            runtime_id="candlescope.pyne",
            version="0.2.0",
        ),
    )
    monkeypatch.setattr(
        plugin_runtime_module,
        "build_runtime_host_from_environment",
        lambda **_kwargs: host,
    )
    monkeypatch.setattr(
        runtime_service_module,
        "build_indicator_runtime_service_from_environment",
        lambda **_kwargs: routing,
    )

    async def _refresh() -> dict[str, int]:
        return {"binance": 1}

    import app.api.v1.symbols as symbols_module

    monkeypatch.setattr(symbols_module, "refresh_exchange_metadata", _refresh)
    return routing


@pytest.mark.anyio
async def test_application_lifecycle_owns_plugin_host_and_health_summary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    host = _Host()
    routing = _patch_startup_dependencies(monkeypatch, host, tmp_path / "plugins")

    async def _init_data_manager() -> None:
        main_module.app.state.data_manager = None

    monkeypatch.setattr(main_module, "_init_data_manager", _init_data_manager)
    await main_module.startup_event()
    try:
        assert host.start_calls == 1
        assert routing.start_calls == 1
        assert callable(routing.catalog_projector)
        assert main_module.app.state.plugin_runtime_host is host
        assert main_module.app.state.indicator_runtime_service is routing
        assert main_module.app.state.plugin_v1_compatibility.indicator_source is routing
        assert main_module.app.state.plugin_platform_v2.health_summary()["status"] == "ok"
        health = await main_module.health_check()
        assert health["plugin_runtimes"] == host.health_summary()
        assert health["plugin_platform_v2"] == {
            "status": "ok",
            "enabled": True,
            "started": True,
            "installed": 0,
            "activeRecords": 0,
            "runningEntrypoints": 0,
            "subscriptions": 0,
            "jobs": 0,
            "failedPlugins": 0,
        }
        assert set(health["plugin_runtimes"]) == {
            "status",
            "configured",
            "enabled",
            "ready",
            "failed",
        }
        assert health["first_party_plugin_bootstrap"] == {
            "status": "ready",
            "runtimeId": "candlescope.pyne",
            "version": "0.2.0",
            "changed": False,
            "downloaded": False,
        }
        assert health["indicator_runtime_routing"]["routes"] == [
            {
                "language": "pyne",
                "mode": "sidecar",
                "runtimeId": "candlescope.pyne",
            }
        ]
    finally:
        await main_module.shutdown_event()
    assert host.stop_calls == 1
    assert routing.stop_calls == 1


@pytest.mark.anyio
async def test_startup_failure_reclaims_started_plugin_host(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    host = _Host()
    routing = _patch_startup_dependencies(monkeypatch, host, tmp_path / "plugins")

    async def _fail_data_manager() -> None:
        raise RuntimeError("fatal data-engine configuration")

    monkeypatch.setattr(main_module, "_init_data_manager", _fail_data_manager)
    with pytest.raises(RuntimeError, match="fatal data-engine configuration"):
        await main_module.startup_event()

    assert host.start_calls == 1
    assert host.stop_calls == 1
    assert routing.start_calls == 1
    assert routing.stop_calls == 1
    lag_monitor = main_module.app.state.event_loop_lag_monitor
    assert lag_monitor.stopped is True


@pytest.mark.anyio
async def test_plugin_host_startup_failure_stops_lag_monitor(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    host = _Host()
    routing = _patch_startup_dependencies(monkeypatch, host, tmp_path / "plugins")

    async def _fail_start() -> None:
        host.start_calls += 1
        raise RuntimeError("required plugin failed")

    monkeypatch.setattr(host, "start", _fail_start)
    with pytest.raises(RuntimeError, match="required plugin failed"):
        await main_module.startup_event()

    assert host.start_calls == 1
    assert routing.start_calls == 0
    assert main_module.app.state.event_loop_lag_monitor.stopped is True


@pytest.mark.anyio
async def test_indicator_routing_startup_failure_reclaims_plugin_host(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    host = _Host()
    routing = _RoutingService()
    routing.fail_start = True
    _patch_startup_dependencies(
        monkeypatch,
        host,
        tmp_path / "plugins",
        routing,
    )

    with pytest.raises(RuntimeError, match="indicator routing failed"):
        await main_module.startup_event()

    assert routing.start_calls == 1
    assert host.start_calls == 1
    assert host.stop_calls == 1
    assert main_module.app.state.event_loop_lag_monitor.stopped is True
