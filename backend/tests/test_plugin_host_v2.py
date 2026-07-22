from __future__ import annotations

import asyncio
import copy
import sys
from pathlib import Path
from typing import Any

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    HOST_API_V1,
    CapabilityGrant,
    ContributionDescriptor,
    HostCallRequest,
    PluginManifest,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import hello_manifest

from app.plugin_host import (
    EntrypointProcessSpec,
    EntrypointSupervisor,
    PlatformHostRemoteError,
    PlatformHostRequestError,
    PlatformHostStateError,
    PlatformHostTransportError,
)
from app.plugin_platform import ContributionRegistry, PluginManager


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_platform_v2"
FAKE_PLATFORM = FIXTURE_DIRECTORY / "fake_platform_sidecar.py"
FULL_HELLO_ID = "candlescope.hello-command.hello"


def _host_call_manifest() -> PluginManifest:
    value = hello_manifest().to_wire()
    value["plugin"] = {
        **value["plugin"],
        "id": "candlescope.host-call",
        "name": "Host Call",
    }
    value["permissions"]["optional"] = [{"id": "notifications.show", "scope": {}}]
    value["probes"] = []
    return PluginManifest.from_wire(value)


def _renamed_manifest(plugin_id: str, name: str) -> PluginManifest:
    value = copy.deepcopy(hello_manifest().to_wire())
    value["plugin"] = {**value["plugin"], "id": plugin_id, "name": name}
    value["probes"] = []
    return PluginManifest.from_wire(value)


def _supervisor(
    mode: str = "good",
    *,
    manifest: PluginManifest | None = None,
    host_apis: tuple[str, ...] = (),
    host_call_handler=None,
    **overrides: object,
) -> EntrypointSupervisor:
    selected_manifest = manifest or hello_manifest()
    values: dict[str, object] = {
        "plugin_id": selected_manifest.plugin.id,
        "entrypoint_id": "main",
        "executable": Path(sys.executable).resolve(),
        "arguments": ("-u", str(FAKE_PLATFORM), mode),
        "working_directory": FIXTURE_DIRECTORY,
        "startup_timeout_seconds": 1.0,
        "request_timeout_seconds": 0.2,
        "shutdown_timeout_seconds": 0.2,
    }
    values.update(overrides)
    return EntrypointSupervisor(
        EntrypointProcessSpec(**values),
        selected_manifest,
        host_name="CandleScope",
        host_version="0.4.0",
        host_apis=host_apis,
        host_call_handler=host_call_handler,
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("arguments", "not-a-tuple"),
        ("max_message_bytes", 1024.5),
        ("max_stderr_bytes", True),
        ("max_in_flight", True),
        ("max_host_calls", True),
        ("request_timeout_seconds", float("nan")),
        ("restart_window_seconds", float("inf")),
        ("trust_level", "internet-trusted"),
    ],
)
def test_entrypoint_process_limits_reject_ambiguous_runtime_values(
    field: str,
    value: object,
) -> None:
    values: dict[str, object] = {
        "plugin_id": "candlescope.hello-command",
        "entrypoint_id": "main",
        "executable": Path(sys.executable).resolve(),
        "arguments": ("-u", str(FAKE_PLATFORM), "good"),
        field: value,
    }
    with pytest.raises(ValueError):
        EntrypointProcessSpec(**values)


def test_untrusted_entrypoint_requires_an_os_sandbox_policy() -> None:
    with pytest.raises(ValueError, match="OS sandbox"):
        EntrypointProcessSpec(
            plugin_id="candlescope.hello-command",
            entrypoint_id="main",
            executable=Path(sys.executable).resolve(),
            trust_level="untrusted",
        )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("crash-start", "PLUGIN_PLATFORM_EXITED"),
        ("stdout-pollution", "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON"),
        ("oversize", "PLUGIN_PLATFORM_RESPONSE_TOO_LARGE"),
        ("duplicate-key", "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON"),
        ("wrong-id", "PLUGIN_PLATFORM_PROTOCOL_VIOLATION"),
    ],
)
async def test_startup_process_and_wire_faults_fail_closed(
    mode: str, code: str
) -> None:
    supervisor = _supervisor(mode, max_message_bytes=1024)
    try:
        with pytest.raises(PlatformHostTransportError) as captured:
            await supervisor.start()
        assert captured.value.code == code
        assert supervisor.snapshot()["state"] == "failed"
        assert supervisor.snapshot()["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_host_rejects_a_runtime_that_accepts_missing_required_host_apis() -> None:
    supervisor = _supervisor(
        "accept-missing-host-api",
        manifest=_host_call_manifest(),
        host_apis=(),
    )
    try:
        with pytest.raises(PlatformHostTransportError) as unsupported:
            await supervisor.start()
        assert unsupported.value.code == "PLUGIN_PLATFORM_HOST_API_UNSUPPORTED"
        assert unsupported.value.details == {
            "missingHostApis": ["candlescope.host-api/1"]
        }
        assert supervisor.snapshot()["state"] == "failed"
    finally:
        await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("hang-invoke", "PLUGIN_PLATFORM_TIMEOUT"),
        ("crash-invoke", "PLUGIN_PLATFORM_EXITED"),
        ("stale-invoke", "PLUGIN_PLATFORM_PROTOCOL_VIOLATION"),
    ],
)
async def test_active_transport_faults_never_publish_a_business_result(
    mode: str,
    code: str,
) -> None:
    supervisor = _supervisor(mode)
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        with pytest.raises(PlatformHostTransportError) as captured:
            await manager.invoke(
                FULL_HELLO_ID,
                {"name": "must not publish"},
                user_action=True,
                trace_id=f"phase2-fault-{mode}",
            )
        assert captured.value.code == code
        assert supervisor.snapshot()["state"] == "failed"
        with pytest.raises(PlatformHostRequestError) as stale:
            await manager.invoke(
                FULL_HELLO_ID,
                {},
                user_action=True,
                trace_id=f"phase2-stale-{mode}",
            )
        assert stale.value.code == "PLUGIN_PLATFORM_CONTRIBUTION_NOT_FOUND"
        assert manager.diagnostics()["contributions"] == []
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_invoke_result_is_rejected_after_its_generation_is_deactivated() -> None:
    supervisor = _supervisor(
        "late-success-after-deactivate",
        request_timeout_seconds=1.0,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        pending = asyncio.create_task(
            manager.invoke(
                FULL_HELLO_ID,
                {"name": "must remain stale"},
                user_action=True,
                trace_id="phase2-deactivate-race",
            )
        )
        for _ in range(100):
            if supervisor.snapshot()["transport"]["pending"] == 1:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("invoke did not become pending")

        await manager.deactivate(
            "candlescope.hello-command",
            "main",
            reason="generation race test",
        )
        with pytest.raises(PlatformHostStateError) as stale:
            await pending
        assert stale.value.code == "PLUGIN_PLATFORM_STALE_GENERATION"
        assert manager.diagnostics()["contributions"] == []
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_restart_storm_opens_the_entrypoint_circuit() -> None:
    supervisor = _supervisor(
        "crash-start",
        max_restart_attempts=1,
        restart_window_seconds=60,
    )
    try:
        for _ in range(2):
            with pytest.raises(PlatformHostTransportError) as captured:
                await supervisor.start()
            assert captured.value.code == "PLUGIN_PLATFORM_EXITED"
        with pytest.raises(PlatformHostRequestError) as limited:
            await supervisor.start()
        assert limited.value.code == "PLUGIN_PLATFORM_RESTART_LIMIT"
        snapshot = supervisor.snapshot()
        assert snapshot["starts"] == 2
        assert snapshot["restarts"] == 1
        assert snapshot["state"] == "failed"
    finally:
        await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("hang-activate", "PLUGIN_PLATFORM_TIMEOUT"),
        ("bad-activate", "PLUGIN_PLATFORM_ACTIVATION_INVALID"),
    ],
)
async def test_uncertain_or_invalid_activation_discards_the_session(
    mode: str,
    code: str,
) -> None:
    supervisor = _supervisor(
        mode,
        startup_timeout_seconds=0.1 if mode == "hang-activate" else 1.0,
    )
    try:
        with pytest.raises(PlatformHostTransportError) as failed:
            await supervisor.activate()
        assert failed.value.code == code
        assert supervisor.snapshot()["state"] == "failed"
        assert supervisor.snapshot()["generation"] == 0
        assert supervisor.snapshot()["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_remote_activation_error_discards_the_uncertain_session() -> None:
    supervisor = _supervisor("remote-error-activate")
    try:
        with pytest.raises(PlatformHostRemoteError) as failed:
            await supervisor.activate()
        assert failed.value.details["remoteCode"] == "INJECTED_LIFECYCLE_ERROR"
        assert supervisor.snapshot()["state"] == "failed"
        assert supervisor.snapshot()["generation"] == 0
        assert supervisor.snapshot()["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "operation", "code"),
    [
        ("bad-deactivate", "deactivate", "PLUGIN_PLATFORM_DEACTIVATION_INVALID"),
        ("bad-upgrade", "upgrade", "PLUGIN_PLATFORM_UPGRADE_INVALID"),
    ],
)
async def test_invalid_lifecycle_results_discard_the_session(
    mode: str,
    operation: str,
    code: str,
) -> None:
    supervisor = _supervisor(mode)
    try:
        await supervisor.activate()
        with pytest.raises(PlatformHostTransportError) as failed:
            if operation == "deactivate":
                await supervisor.deactivate("invalid lifecycle test")
            else:
                await supervisor.prepare_upgrade()
        assert failed.value.code == code
        assert supervisor.snapshot()["state"] == "failed"
        assert supervisor.snapshot()["generation"] == 0
        assert supervisor.snapshot()["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "operation"),
    [
        ("remote-error-deactivate", "deactivate"),
        ("remote-error-upgrade", "upgrade"),
    ],
)
async def test_remote_lifecycle_error_discards_the_uncertain_session(
    mode: str,
    operation: str,
) -> None:
    supervisor = _supervisor(mode)
    try:
        await supervisor.activate()
        with pytest.raises(PlatformHostRemoteError) as failed:
            if operation == "deactivate":
                await supervisor.deactivate("remote lifecycle test")
            else:
                await supervisor.prepare_upgrade()
        assert failed.value.details["remoteCode"] == "INJECTED_LIFECYCLE_ERROR"
        assert supervisor.snapshot()["state"] == "failed"
        assert supervisor.snapshot()["generation"] == 0
        assert supervisor.snapshot()["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_idle_process_exit_revokes_generation_owned_contributions() -> None:
    supervisor = _supervisor("exit-after-activate")
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        for _ in range(100):
            if supervisor.state == "failed":
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("idle process exit was not observed")

        assert manager.health_summary()["contributions"] == 0
        assert manager.diagnostics()["contributions"] == []
        assert supervisor.snapshot()["generation"] == 0
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_bidirectional_host_call_supports_reentrant_host_requests() -> None:
    holder: dict[str, EntrypointSupervisor] = {}

    async def broker(
        call: HostCallRequest,
        grant: CapabilityGrant,
    ) -> dict[str, Any]:
        assert call.method == "notifications.show"
        assert grant.permission_id == "notifications.show"
        health = await holder["supervisor"].health_check()
        return {"shown": True, "health": health["status"]}

    manifest = _host_call_manifest()
    supervisor = _supervisor(
        "host-call",
        manifest=manifest,
        host_apis=(HOST_API_V1,),
        host_call_handler=broker,
        request_timeout_seconds=1.0,
    )
    holder["supervisor"] = supervisor
    manager = PluginManager((supervisor,))
    try:
        await manager.activate(
            "candlescope.host-call",
            "main",
            capabilities=(
                CapabilityGrant(
                    handle="cap-notify",
                    permission_id="notifications.show",
                ),
            ),
        )
        result = await manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase2-reentrant-host-call",
        )
        assert result == {
            "notified": True,
            "receipt": {"shown": True, "health": "ready"},
            "token": "notify:phase2-reentrant-host-call",
        }
        assert supervisor.snapshot()["transport"]["hostCalls"] == 1
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_unknown_or_revoked_capability_handle_fails_without_killing_session() -> (
    None
):
    supervisor = _supervisor(
        "host-call",
        manifest=_host_call_manifest(),
        host_apis=(HOST_API_V1,),
        request_timeout_seconds=1.0,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.host-call", "main")
        with pytest.raises(PlatformHostRemoteError) as denied:
            await manager.invoke(
                "candlescope.host-call.hello",
                {},
                user_action=True,
                trace_id="phase2-no-capability",
            )
        assert denied.value.details["remoteCode"] == "CAPABILITY_HANDLE_INVALID"
        assert supervisor.snapshot()["state"] == "active"
        assert await supervisor.health_check() == {"status": "ready"}
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_host_call_result_is_dropped_after_generation_revocation() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def broker(
        call: HostCallRequest,
        grant: CapabilityGrant,
    ) -> dict[str, Any]:
        assert call.method == grant.permission_id
        entered.set()
        await release.wait()
        return {"sensitiveReceipt": "must-not-cross-revocation"}

    supervisor = _supervisor(
        "host-call",
        manifest=_host_call_manifest(),
        host_apis=(HOST_API_V1,),
        host_call_handler=broker,
        request_timeout_seconds=1.0,
    )
    manager = PluginManager((supervisor,))
    capabilities = (
        CapabilityGrant(
            handle="cap-notify",
            permission_id="notifications.show",
        ),
    )
    await manager.activate(
        "candlescope.host-call",
        "main",
        capabilities=capabilities,
    )
    pending = asyncio.create_task(
        manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase2-revoked-host-call",
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), timeout=1.0)
        await manager.deactivate(
            "candlescope.host-call",
            "main",
            reason="revoke capability generation",
        )
        cancelled = await asyncio.gather(pending, return_exceptions=True)
        assert isinstance(cancelled[0], PlatformHostRemoteError)

        release.set()
        for _ in range(100):
            transport = supervisor.snapshot()["transport"]
            if transport["hostCallsPending"] == 0:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("revoked Host call handler did not settle")
        assert supervisor.snapshot()["state"] == "handshaken"
        assert supervisor.snapshot()["transport"]["fatalError"] is None

        await manager.activate(
            "candlescope.host-call",
            "main",
            capabilities=capabilities,
        )
        result = await manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase2-host-call-after-reactivate",
        )
        assert result["notified"] is True
        assert supervisor.snapshot()["starts"] == 1
    finally:
        release.set()
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await manager.stop()


@pytest.mark.anyio
async def test_shutdown_cancels_a_pending_host_call_without_deadlock() -> None:
    entered = asyncio.Event()

    async def broker(
        call: HostCallRequest,
        grant: CapabilityGrant,
    ) -> dict[str, Any]:
        assert call.method == grant.permission_id
        entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    supervisor = _supervisor(
        "host-call",
        manifest=_host_call_manifest(),
        host_apis=(HOST_API_V1,),
        host_call_handler=broker,
        request_timeout_seconds=2.0,
    )
    manager = PluginManager((supervisor,))
    await manager.activate(
        "candlescope.host-call",
        "main",
        capabilities=(
            CapabilityGrant(
                handle="cap-notify",
                permission_id="notifications.show",
            ),
        ),
    )
    pending = asyncio.create_task(
        manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase2-stop-host-call",
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=1.0)

    await asyncio.wait_for(manager.stop(), timeout=2.0)
    outcome = await asyncio.gather(pending, return_exceptions=True)

    assert isinstance(outcome[0], (PlatformHostRemoteError, PlatformHostTransportError))
    assert supervisor.snapshot()["state"] == "stopped"


@pytest.mark.anyio
async def test_cancelled_shutdown_still_closes_the_process_session() -> None:
    supervisor = _supervisor(
        "hang-shutdown",
        request_timeout_seconds=1.0,
        shutdown_timeout_seconds=10.0,
    )
    try:
        await supervisor.activate()
        stopping = asyncio.create_task(supervisor.stop())
        for _ in range(100):
            if supervisor.snapshot()["state"] == "stopping":
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("shutdown request did not become pending")

        stopping.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stopping
        snapshot = supervisor.snapshot()
        assert snapshot["state"] == "stopped"
        assert snapshot["generation"] == 0
        assert snapshot["transport"] is None
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_concurrent_requests_share_one_reader_without_response_cross_talk() -> (
    None
):
    supervisor = _supervisor("good", request_timeout_seconds=1.0, max_in_flight=32)
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        results = await asyncio.gather(
            *(
                manager.invoke(
                    FULL_HELLO_ID,
                    {"name": f"request-{index}"},
                    user_action=True,
                    trace_id=f"phase2-concurrent-{index}",
                )
                for index in range(24)
            )
        )
        assert [item["message"] for item in results] == [
            f"Hello, request-{index}!" for index in range(24)
        ]
        assert supervisor.snapshot()["transport"]["pending"] == 0
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_host_call_limit_fails_the_session_without_spawning_rejection_queue() -> (
    None
):
    entered = asyncio.Event()

    async def broker(
        call: HostCallRequest,
        grant: CapabilityGrant,
    ) -> dict[str, Any]:
        assert call.method == grant.permission_id
        entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    supervisor = _supervisor(
        "host-call",
        manifest=_host_call_manifest(),
        host_apis=(HOST_API_V1,),
        host_call_handler=broker,
        request_timeout_seconds=2.0,
        max_in_flight=4,
        max_host_calls=1,
    )
    manager = PluginManager((supervisor,))
    await manager.activate(
        "candlescope.host-call",
        "main",
        capabilities=(
            CapabilityGrant(
                handle="cap-notify",
                permission_id="notifications.show",
            ),
        ),
    )
    first = asyncio.create_task(
        manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase2-host-call-limit-first",
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), timeout=1.0)
        with pytest.raises(PlatformHostTransportError) as overflow:
            await manager.invoke(
                "candlescope.host-call.hello",
                {},
                user_action=True,
                trace_id="phase2-host-call-limit-second",
            )
        assert overflow.value.code == "PLUGIN_PLATFORM_PROTOCOL_VIOLATION"
        first_result = await asyncio.gather(first, return_exceptions=True)
        assert isinstance(first_result[0], PlatformHostTransportError)
        assert supervisor.snapshot()["state"] == "failed"
    finally:
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        await manager.stop()


@pytest.mark.anyio
async def test_in_flight_capacity_fails_fast_without_an_unbounded_waiter_queue() -> (
    None
):
    supervisor = _supervisor(
        "good",
        request_timeout_seconds=1.0,
        max_in_flight=2,
        max_host_calls=2,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        pending = [
            asyncio.create_task(
                manager.invoke(
                    FULL_HELLO_ID,
                    {"name": f"pending-{index}", "defer": True},
                    user_action=True,
                    trace_id=f"phase2-capacity-{index}",
                )
            )
            for index in range(2)
        ]
        for _ in range(100):
            transport = supervisor.snapshot()["transport"]
            if transport["pending"] == 2:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("requests did not fill the in-flight capacity")

        with pytest.raises(PlatformHostRequestError) as full:
            await manager.invoke(
                FULL_HELLO_ID,
                {},
                user_action=True,
                trace_id="phase2-capacity-overflow",
            )
        assert full.value.code == "PLUGIN_PLATFORM_IN_FLIGHT_LIMIT"

        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_stderr_is_bounded_and_ambient_secrets_do_not_cross_process_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CANDLESCOPE_TEST_SECRET", "must-not-cross-boundary")
    environment_probe = _supervisor("environment-probe")
    try:
        await environment_probe.activate()
        assert environment_probe.snapshot()["state"] == "active"
    finally:
        await environment_probe.stop()

    stderr_probe = _supervisor("stderr-flood", max_stderr_bytes=1024)
    try:
        with pytest.raises(PlatformHostTransportError):
            await stderr_probe.activate()
        snapshot = stderr_probe.snapshot(include_stderr=True)
        stderr_tail = snapshot["stderrTail"]
        assert len(stderr_tail.encode("utf-8")) <= 1024
        assert set(stderr_tail) <= {"S"}
        assert "stderrTail" not in stderr_probe.snapshot()
    finally:
        await stderr_probe.stop()

    crashed_probe = _supervisor("stderr-crash-start", max_stderr_bytes=1024)
    try:
        with pytest.raises(PlatformHostTransportError):
            await crashed_probe.start()
        snapshot = crashed_probe.snapshot(include_stderr=True)
        assert snapshot["transport"] is None
        assert 0 < len(snapshot["stderrTail"].encode("utf-8")) <= 1024
        assert "stderrTail" not in crashed_probe.snapshot()
    finally:
        await crashed_probe.stop()


@pytest.mark.anyio
async def test_required_failure_rolls_back_started_entries_and_optional_failure_is_local() -> (
    None
):
    good = _supervisor("good", auto_start=True, required=True)
    optional = _supervisor(
        "good",
        manifest=_renamed_manifest("example.optional-bad", "Optional Bad"),
        auto_start=True,
        required=False,
    )
    manager = PluginManager((good, optional))
    try:
        await manager.start()
        assert manager.health_summary() == {
            "status": "degraded",
            "configured": 2,
            "enabled": 2,
            "active": 1,
            "failed": 1,
            "contributions": 1,
        }
        assert good.snapshot()["state"] == "active"
        assert optional.snapshot()["state"] == "stopped"
        assert manager.diagnostics()["activationFailures"][0]["cause"]["code"] == (
            "PLUGIN_PLATFORM_DESCRIPTOR_INVALID"
        )
    finally:
        await manager.stop()

    good = _supervisor("good", auto_start=True, required=True)
    required = _supervisor(
        "good",
        manifest=_renamed_manifest("example.required-bad", "Required Bad"),
        auto_start=True,
        required=True,
    )
    manager = PluginManager((good, required))
    with pytest.raises(PlatformHostStateError) as failed:
        await manager.start()
    assert failed.value.code == "PLUGIN_PLATFORM_REQUIRED_START_FAILED"
    assert manager.diagnostics()["contributions"] == []
    assert good.snapshot()["state"] == "stopped"
    await manager.stop()


@pytest.mark.anyio
async def test_optional_activation_configuration_failure_closes_idle_sidecar() -> None:
    manifest = _host_call_manifest()
    supervisor = _supervisor(
        "host-call",
        manifest=manifest,
        host_apis=(HOST_API_V1,),
        auto_start=True,
        required=False,
    )
    manager = PluginManager(
        (supervisor,),
        activation_capabilities={
            supervisor.owner_key: (
                CapabilityGrant(
                    handle="cap-invalid",
                    permission_id="filesystem.read",
                ),
            )
        },
    )
    try:
        await manager.start()
        assert manager.health_summary() == {
            "status": "degraded",
            "configured": 1,
            "enabled": 1,
            "active": 0,
            "failed": 1,
            "contributions": 0,
        }
        assert supervisor.snapshot()["state"] == "stopped"
        assert supervisor.snapshot()["transport"] is None
        failure = manager.diagnostics()["activationFailures"][0]
        assert failure["cause"]["code"] == "PLUGIN_PLATFORM_CAPABILITIES_INVALID"
    finally:
        await manager.stop()


def test_contribution_registry_rejects_conflicts_and_stale_owner_updates() -> None:
    registry = ContributionRegistry()
    registry.replace_owner(
        plugin_id="example.plugin",
        entrypoint_id="main",
        generation=1,
        contributions=(
            ContributionDescriptor(
                id="shared",
                kind="command/1",
                title="Shared",
                entrypoint="main",
            ),
        ),
    )
    with pytest.raises(PlatformHostRequestError) as conflict:
        registry.replace_owner(
            plugin_id="example.plugin",
            entrypoint_id="secondary",
            generation=1,
            contributions=(
                ContributionDescriptor(
                    id="shared",
                    kind="command/1",
                    title="Shared Again",
                    entrypoint="secondary",
                ),
            ),
        )
    assert conflict.value.code == "PLUGIN_PLATFORM_CONTRIBUTION_CONFLICT"
    with pytest.raises(PlatformHostStateError) as stale:
        registry.replace_owner(
            plugin_id="example.plugin",
            entrypoint_id="main",
            generation=1,
            contributions=(
                ContributionDescriptor(
                    id="shared",
                    kind="command/1",
                    title="Stale",
                    entrypoint="main",
                ),
            ),
        )
    assert stale.value.code == "PLUGIN_PLATFORM_STALE_GENERATION"
