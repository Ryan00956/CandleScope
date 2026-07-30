from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from candlescope_plugin_sdk.platform_v2.examples.hello_command import hello_manifest

from app.plugin_host import EntrypointProcessSpec, EntrypointSupervisor
from app.plugin_platform import PluginManager


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_platform_v2"
HELLO_COMMAND = FIXTURE_DIRECTORY / "run_hello_command.py"
FULL_HELLO_ID = "candlescope.hello-command.hello"


def _hello_supervisor(**overrides: object) -> EntrypointSupervisor:
    values: dict[str, object] = {
        "plugin_id": "candlescope.hello-command",
        "entrypoint_id": "main",
        "executable": Path(sys.executable).resolve(),
        "arguments": ("-u", str(HELLO_COMMAND)),
        "working_directory": FIXTURE_DIRECTORY,
        "auto_start": True,
        "required": True,
        "startup_timeout_seconds": 2.0,
        "request_timeout_seconds": 1.0,
        "shutdown_timeout_seconds": 1.0,
    }
    values.update(overrides)
    return EntrypointSupervisor(
        EntrypointProcessSpec(**values),
        hello_manifest(),
        host_name="CandleScope",
        host_version="0.4.0",
    )


@pytest.mark.anyio
async def test_real_hello_command_activates_in_memory_and_invokes_by_full_id() -> None:
    supervisor = _hello_supervisor()
    manager = PluginManager((supervisor,))
    try:
        await manager.start()

        assert manager.health_summary() == {
            "status": "ok",
            "configured": 1,
            "enabled": 1,
            "active": 1,
            "failed": 0,
            "contributions": 1,
        }
        assert manager.diagnostics()["contributions"][0]["id"] == FULL_HELLO_ID
        result = await manager.invoke(
            FULL_HELLO_ID,
            {"name": "Phase 2"},
            user_action=True,
            trace_id="phase2-hello-1",
        )
        assert result == {
            "message": "Hello, Phase 2!",
            "contributionId": "hello",
        }
        assert await supervisor.health_check() == {"status": "ready", "pending": 0}
        assert await supervisor.event_batch(
            ({"type": "phase2.test"},),
            {"mode": "at-most-once"},
        ) == {"accepted": 1}
    finally:
        await manager.stop()

    assert supervisor.snapshot()["state"] == "stopped"
    assert supervisor.snapshot()["transport"] is None


@pytest.mark.anyio
async def test_reactivation_is_monotonic_and_stale_removal_cannot_erase_new_owner() -> (
    None
):
    supervisor = _hello_supervisor(auto_start=False)
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        first_generation = supervisor.generation
        await manager.deactivate(
            "candlescope.hello-command",
            "main",
            reason="generation test",
        )
        await manager.activate("candlescope.hello-command", "main")
        second_generation = supervisor.generation

        assert (first_generation, second_generation) == (1, 2)
        assert (
            manager.contributions.remove_owner(
                plugin_id="candlescope.hello-command",
                entrypoint_id="main",
                generation=first_generation,
            )
            is False
        )
        result = await manager.invoke(
            FULL_HELLO_ID,
            {},
            user_action=True,
            trace_id="phase2-generation-2",
        )
        assert result["message"] == "Hello, world!"
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_removed_owner_accepts_a_fresh_replacement_supervisor() -> None:
    first = _hello_supervisor(auto_start=False)
    manager = PluginManager((first,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        assert first.generation == 1
        assert await manager.remove_plugin("candlescope.hello-command") == 1

        replacement = _hello_supervisor(auto_start=False)
        await manager.add_supervisors((replacement,))
        await manager.activate("candlescope.hello-command", "main")

        assert replacement.generation == 1
        result = await manager.invoke(
            FULL_HELLO_ID,
            {"name": "replacement"},
            user_action=True,
            trace_id="phase10-replacement-generation",
        )
        assert result["message"] == "Hello, replacement!"
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_cancelled_deferred_invoke_is_correlated_and_session_remains_usable() -> (
    None
):
    supervisor = _hello_supervisor(auto_start=False)
    manager = PluginManager((supervisor,))
    try:
        await manager.activate("candlescope.hello-command", "main")
        pending = asyncio.create_task(
            manager.invoke(
                FULL_HELLO_ID,
                {"name": "later", "defer": True},
                user_action=True,
                trace_id="phase2-cancel-1",
            )
        )
        for _ in range(100):
            transport = supervisor.snapshot()["transport"]
            if transport is not None and transport["pending"] == 1:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("deferred invocation did not become pending")

        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        for _ in range(100):
            health = await supervisor.health_check()
            if health["pending"] == 0:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("cancel did not clear the plugin invocation")

        result = await manager.invoke(
            FULL_HELLO_ID,
            {"name": "still alive"},
            user_action=True,
            trace_id="phase2-after-cancel",
        )
        assert result["message"] == "Hello, still alive!"
    finally:
        await manager.stop()
