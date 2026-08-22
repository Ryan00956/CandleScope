from __future__ import annotations

import sys
from pathlib import Path

import pytest
from candlescope_plugin_sdk import AnalyzeRequest, MarketContext

from app.plugin_runtime.errors import PluginRequestError
from app.plugin_runtime.registry import RuntimeProcessSpec, RuntimeRegistry
from app.plugin_runtime.service import RuntimeHostService


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_runtime"
FAKE_SIDECAR = FIXTURE_DIRECTORY / "fake_sidecar.py"


def _spec(
    runtime_id: str,
    mode: str,
    *,
    enabled: bool = True,
    auto_start: bool = True,
    required: bool = False,
) -> RuntimeProcessSpec:
    expected_id = "fake-runtime"
    arguments: tuple[str, ...] = ("-u", str(FAKE_SIDECAR), mode)
    if runtime_id != expected_id:
        # These service tests only need launch failures for noncanonical ids.
        arguments = ("-u", str(FAKE_SIDECAR), "crash-start")
    return RuntimeProcessSpec(
        runtime_id=runtime_id,
        expected_package="candlescope-plugin-fake",
        expected_version="1.2.3",
        executable=Path(sys.executable).resolve(),
        arguments=arguments,
        working_directory=FIXTURE_DIRECTORY,
        enabled=enabled,
        auto_start=auto_start if enabled else False,
        required=required,
        startup_timeout_seconds=0.5,
        request_timeout_seconds=0.2,
        shutdown_timeout_seconds=0.1,
    )


def _service(*specs: RuntimeProcessSpec) -> RuntimeHostService:
    return RuntimeHostService(
        RuntimeRegistry(tuple(specs)),
        host_name="CandleScope",
        host_version="0.3.0",
    )


@pytest.mark.anyio
async def test_empty_and_disabled_hosts_are_noop_and_observable() -> None:
    empty = _service()
    await empty.start()
    assert empty.health_summary() == {
        "status": "ok",
        "configured": 0,
        "enabled": 0,
        "ready": 0,
        "failed": 0,
    }
    await empty.stop()

    disabled = RuntimeHostService.disabled(
        host_name="CandleScope",
        host_version="0.3.0",
    )
    await disabled.start()
    assert disabled.health_summary()["status"] == "disabled"
    with pytest.raises(PluginRequestError) as captured:
        await disabled.descriptor("anything")
    assert captured.value.code == "PLUGIN_HOST_DISABLED"


@pytest.mark.anyio
async def test_optional_autostart_failure_degrades_without_aborting_host() -> None:
    service = _service(_spec("optional-runtime", "crash-start"))

    await service.start()

    summary = service.health_summary()
    assert summary["status"] == "degraded"
    assert summary["failed"] == 1
    diagnostics = service.diagnostics(include_stderr=True)
    assert diagnostics["runtimes"][0]["lastFailure"]["code"] == "PLUGIN_EXITED"
    await service.stop()


@pytest.mark.anyio
async def test_required_autostart_failure_degrades_without_aborting_host() -> None:
    service = _service(
        _spec("fake-runtime", "good"),
        _spec("required-runtime", "crash-start", required=True),
    )

    await service.start()

    summary = service.health_summary()
    assert summary["status"] == "degraded"
    assert summary["failed"] == 1
    assert summary["ready"] == 1
    states = {item["id"]: item["state"] for item in service.diagnostics()["runtimes"]}
    assert states["fake-runtime"] == "ready"
    assert states["required-runtime"] == "failed"
    await service.stop()


@pytest.mark.anyio
async def test_service_routes_typed_requests_and_rejects_unknown_runtime() -> None:
    service = _service(_spec("fake-runtime", "good", auto_start=False))
    await service.start()
    request = AnalyzeRequest(
        source="plot(close)",
        context=MarketContext(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
        ),
    )
    try:
        result = await service.analyze("fake-runtime", request)
        assert result.executable is True
        assert service.health_summary()["ready"] == 1
        with pytest.raises(PluginRequestError) as missing:
            await service.analyze("missing", request)
        assert missing.value.code == "PLUGIN_NOT_FOUND"
    finally:
        await service.stop()
