from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
)

from app.plugin_runtime.errors import (
    PluginHostError,
    PluginRemoteError,
    PluginRequestError,
)
from app.plugin_runtime.registry import RuntimeProcessSpec
from app.plugin_runtime.supervisor import RuntimeSupervisor


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_runtime"
FAKE_SIDECAR = FIXTURE_DIRECTORY / "fake_sidecar.py"
HELLO_SIDECAR = FIXTURE_DIRECTORY / "run_hello_runtime.py"


def _fake_spec(mode: str = "good", **overrides: object) -> RuntimeProcessSpec:
    values: dict[str, object] = {
        "runtime_id": "fake-runtime",
        "expected_package": "candlescope-plugin-fake",
        "expected_version": "1.2.3",
        "executable": Path(sys.executable).resolve(),
        "arguments": ("-u", str(FAKE_SIDECAR), mode),
        "working_directory": FIXTURE_DIRECTORY,
        "startup_timeout_seconds": 1.0,
        "request_timeout_seconds": 0.2,
        "shutdown_timeout_seconds": 0.1,
    }
    values.update(overrides)
    return RuntimeProcessSpec(**values)


def _supervisor(spec: RuntimeProcessSpec) -> RuntimeSupervisor:
    return RuntimeSupervisor(
        spec,
        host_name="CandleScope",
        host_version="0.3.0",
    )


def _context() -> MarketContext:
    return MarketContext(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    )


def _analyze_request(*, source: str = "plot(close)") -> AnalyzeRequest:
    return AnalyzeRequest(source=source, context=_context())


def _execute_request() -> ExecuteBatchRequest:
    return ExecuteBatchRequest(
        source="plot(close)",
        context=_context(),
        bars=(
            Bar(
                time=1_700_000_000,
                open=100,
                high=102,
                low=99,
                close=101,
                volume=10,
            ),
            Bar(
                time=1_700_000_060,
                open=101,
                high=103,
                low=100,
                close=102,
                volume=11,
            ),
        ),
    )


@pytest.mark.anyio
async def test_supervisor_runs_a_complete_serialized_session() -> None:
    supervisor = _supervisor(_fake_spec())
    try:
        descriptor = await supervisor.start()
        assert descriptor.id == "fake-runtime"
        assert supervisor.snapshot()["state"] == "ready"
        assert supervisor.snapshot()["pid"] is not None

        analysis = await supervisor.analyze(_analyze_request())
        assert analysis.ok is True
        assert analysis.executable is True

        execution = await supervisor.execute_batch(_execute_request())
        assert execution.ok is True
        assert execution.output is not None
        assert execution.output.series[0].id == "close"
        assert execution.output.series[0].points[-1].value == 102.0
    finally:
        await supervisor.stop()

    snapshot = supervisor.snapshot()
    assert snapshot["state"] == "stopped"
    assert snapshot["pid"] is None
    assert snapshot["requests"] == 5


@pytest.mark.anyio
async def test_host_is_wire_compatible_with_the_real_sdk_hello_runtime() -> None:
    spec = RuntimeProcessSpec(
        runtime_id="hello-runtime",
        expected_package="candlescope-plugin-sdk",
        expected_version="0.1.0",
        executable=Path(sys.executable).resolve(),
        arguments=("-u", str(HELLO_SIDECAR)),
        working_directory=FIXTURE_DIRECTORY,
        startup_timeout_seconds=2.0,
        request_timeout_seconds=1.0,
        shutdown_timeout_seconds=1.0,
    )
    supervisor = _supervisor(spec)
    try:
        descriptor = await supervisor.start()
        assert descriptor.id == "hello-runtime"
        assert set(supervisor.snapshot()["negotiatedFeatures"]) == {
            "source-analysis/1",
            "batch-execution/1",
            "render.line-series/1",
        }
        analysis = await supervisor.analyze(_analyze_request())
        execution = await supervisor.execute_batch(_execute_request())
        assert analysis.executable is True
        assert execution.output is not None
        assert execution.output.schema == "candlescope.render/1"
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_request_timeout_discards_the_process() -> None:
    supervisor = _supervisor(_fake_spec("timeout", request_timeout_seconds=0.05))
    with pytest.raises(PluginHostError) as captured:
        await supervisor.analyze(_analyze_request())

    assert captured.value.code == "PLUGIN_TIMEOUT"
    snapshot = supervisor.snapshot(include_stderr=True)
    assert snapshot["state"] == "failed"
    assert snapshot["pid"] is None
    assert snapshot["lastFailure"]["code"] == "PLUGIN_TIMEOUT"
    await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("bad-json", "PLUGIN_RESPONSE_INVALID_JSON"),
        ("wrong-id", "PLUGIN_RESPONSE_ID_MISMATCH"),
        ("duplicate-key", "PLUGIN_RESPONSE_INVALID_JSON"),
        ("oversize", "PLUGIN_RESPONSE_TOO_LARGE"),
    ],
)
async def test_wire_corruption_fails_closed_and_discards_session(
    mode: str,
    code: str,
) -> None:
    supervisor = _supervisor(_fake_spec(mode, max_message_bytes=1024))
    with pytest.raises(PluginHostError) as captured:
        await supervisor.analyze(_analyze_request())

    assert captured.value.code == code
    assert supervisor.snapshot()["state"] == "failed"
    assert supervisor.snapshot()["pid"] is None
    await supervisor.stop()


@pytest.mark.anyio
async def test_well_formed_remote_error_keeps_session_usable() -> None:
    supervisor = _supervisor(_fake_spec("remote-error"))
    try:
        with pytest.raises(PluginRemoteError) as captured:
            await supervisor.analyze(_analyze_request())
        assert captured.value.details["remoteCode"] == "INVALID_PARAMS"
        snapshot = supervisor.snapshot()
        assert snapshot["state"] == "ready"
        assert snapshot["remoteErrors"] == 1
        assert snapshot["failures"] == 0
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_invalid_typed_result_discards_session() -> None:
    supervisor = _supervisor(_fake_spec("bad-result"))
    with pytest.raises(PluginHostError) as captured:
        await supervisor.analyze(_analyze_request())

    assert captured.value.code == "PLUGIN_RESULT_INVALID"
    assert supervisor.snapshot()["state"] == "failed"
    await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("identity-mismatch", "PLUGIN_IDENTITY_MISMATCH"),
        ("descriptor-changed", "PLUGIN_DESCRIPTOR_CHANGED"),
        ("crash-start", "PLUGIN_EXITED"),
    ],
)
async def test_startup_identity_and_liveness_are_verified(mode: str, code: str) -> None:
    supervisor = _supervisor(_fake_spec(mode))
    with pytest.raises(PluginHostError) as captured:
        await supervisor.start()

    assert captured.value.code == code
    assert supervisor.snapshot()["state"] == "failed"
    await supervisor.stop()


@pytest.mark.anyio
async def test_crash_restart_budget_opens_a_circuit() -> None:
    supervisor = _supervisor(
        _fake_spec(
            "crash",
            max_restart_attempts=1,
            restart_window_seconds=60,
        )
    )
    for _ in range(2):
        with pytest.raises(PluginHostError) as captured:
            await supervisor.analyze(_analyze_request())
        assert captured.value.code == "PLUGIN_EXITED"

    with pytest.raises(PluginRequestError) as limited:
        await supervisor.analyze(_analyze_request())
    assert limited.value.code == "PLUGIN_RESTART_LIMIT"
    snapshot = supervisor.snapshot()
    assert snapshot["starts"] == 2
    assert snapshot["restarts"] == 1
    await supervisor.stop()


@pytest.mark.anyio
async def test_stderr_is_bounded_and_ambient_secret_is_not_inherited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CANDLESCOPE_TEST_SECRET", "must-not-cross-boundary")
    supervisor = _supervisor(_fake_spec("stderr-flood", max_stderr_bytes=1024))
    try:
        descriptor = await supervisor.start()
        assert descriptor.meta["secretPresent"] is False
        await asyncio.sleep(0.05)
        snapshot = supervisor.snapshot(include_stderr=True)
        assert len(snapshot["stderrTail"].encode("utf-8")) <= 1024
        assert set(snapshot["stderrTail"]) <= {"S"}
        assert "stderrTail" not in supervisor.snapshot()
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_oversized_local_request_is_rejected_without_killing_session() -> None:
    supervisor = _supervisor(_fake_spec(max_message_bytes=1024))
    try:
        await supervisor.start()
        with pytest.raises(PluginRequestError) as captured:
            await supervisor.analyze(_analyze_request(source="x" * 5000))
        assert captured.value.code == "PLUGIN_REQUEST_TOO_LARGE"
        assert supervisor.snapshot()["state"] == "ready"
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_shutdown_timeout_forces_process_termination() -> None:
    supervisor = _supervisor(
        _fake_spec("ignore-shutdown", shutdown_timeout_seconds=0.05)
    )
    await supervisor.start()

    await supervisor.stop()

    snapshot = supervisor.snapshot()
    assert snapshot["state"] == "stopped"
    assert snapshot["pid"] is None
    assert snapshot["lastFailure"]["code"] == "PLUGIN_SHUTDOWN_TIMEOUT"
