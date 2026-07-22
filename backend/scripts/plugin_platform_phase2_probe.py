"""Run the Phase 2 in-memory Hello Command Host slice as real processes."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
sys.path.insert(0, str(BACKEND_ROOT))
sys.path.insert(0, str(SDK_SOURCE))

from candlescope_plugin_sdk.platform_v2 import PLUGIN_PROTOCOL_V2  # noqa: E402
from candlescope_plugin_sdk.platform_v2.examples.hello_command import (  # noqa: E402
    hello_manifest,
    main as hello_main,
)

from app.plugin_host import EntrypointProcessSpec, EntrypointSupervisor  # noqa: E402
from app.plugin_platform import PluginManager  # noqa: E402


FULL_HELLO_ID = "candlescope.hello-command.hello"


async def run_probe() -> dict[str, Any]:
    manifest = hello_manifest()
    supervisor = EntrypointSupervisor(
        EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            executable=Path(sys.executable).resolve(),
            arguments=("-u", str(Path(__file__).resolve()), "--sidecar"),
            working_directory=BACKEND_ROOT,
            auto_start=True,
            required=True,
            startup_timeout_seconds=3.0,
            request_timeout_seconds=2.0,
            shutdown_timeout_seconds=1.0,
        ),
        manifest,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.start()
        generation = supervisor.generation
        invoked = await manager.invoke(
            FULL_HELLO_ID,
            {"name": "Plugin Platform v2"},
            user_action=True,
            trace_id="phase2-real-process-probe",
        )
        event_batch = await supervisor.event_batch(
            ({"type": "phase2.probe"},),
            {"mode": "at-most-once"},
        )
        health = await supervisor.health_check()
        active_summary = manager.health_summary()
    finally:
        await manager.stop()
    return {
        "schemaVersion": 1,
        "protocol": PLUGIN_PROTOCOL_V2,
        "contributionId": FULL_HELLO_ID,
        "generation": generation,
        "invoke": invoked,
        "eventBatch": event_batch,
        "health": health,
        "activeSummary": active_summary,
        "stoppedState": supervisor.snapshot()["state"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.sidecar:
        return hello_main()
    result = asyncio.run(run_probe())
    print(
        json.dumps(
            result,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
