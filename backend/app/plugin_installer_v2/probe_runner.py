"""Fresh-parent-process semantic probe for installed v2 entrypoints."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = BACKEND_ROOT.parent
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
for candidate in (BACKEND_ROOT, SDK_SOURCE):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from candlescope_plugin_sdk.platform_v2 import (  # noqa: E402
    HOST_API_V1,
    JsonLimits,
    PlatformContractError,
    PluginManifest,
    canonical_dumps,
    canonical_sha256,
    loads_strict,
)

from app.plugin_host import (  # noqa: E402
    EntrypointProcessSpec,
    EntrypointSupervisor,
    JsonLineError,
    ManagedSidecarProcess,
    SidecarProcessSpec,
)


MAX_PROBE_MESSAGE_BYTES = 1024 * 1024
ASSET_JSON_LIMITS = JsonLimits(
    max_message_bytes=4 * 1024 * 1024,
    max_depth=32,
    max_container_items=20_000,
    max_string_bytes=1024 * 1024,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--bundle-descriptor", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True, dest="python_executable")
    parser.add_argument("--working-directory", type=Path, required=True)
    parser.add_argument("--host-version", required=True)
    return parser


def _probe_assets(args: argparse.Namespace) -> dict[str, Path]:
    descriptor = loads_strict(args.bundle_descriptor.read_bytes())
    if not isinstance(descriptor, dict) or not isinstance(
        descriptor.get("probeAssets"), list
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT", "bundle descriptor probeAssets are invalid"
        )
    content_root = args.bundle_descriptor.parent.resolve(strict=False)
    assets: dict[str, Path] = {}
    for item in descriptor["probeAssets"]:
        if (
            not isinstance(item, dict)
            or set(item) != {"id", "path"}
            or not isinstance(item["id"], str)
            or not isinstance(item["path"], str)
            or item["id"] in assets
        ):
            raise PlatformContractError(
                "INVALID_CONTRACT", "bundle descriptor probe asset is invalid"
            )
        target = content_root.joinpath(*item["path"].split("/")).resolve(strict=False)
        if content_root not in target.parents or not target.is_file():
            raise PlatformContractError(
                "INVALID_CONTRACT", "bundle descriptor probe path is unsafe"
            )
        assets[item["id"]] = target
    return assets


async def _replay_control_transcript(
    args: argparse.Namespace,
    manifest: PluginManifest,
    *,
    entrypoint_id: str,
    asset_path: Path,
) -> str:
    transcript = loads_strict(asset_path.read_bytes(), limits=ASSET_JSON_LIMITS)
    if not isinstance(transcript, dict) or not isinstance(
        transcript.get("requests"), list
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT", "control transcript requests are invalid"
        )
    requests = transcript["requests"]
    if not requests or not all(isinstance(item, dict) for item in requests):
        raise PlatformContractError(
            "INVALID_CONTRACT", "control transcript must contain requests"
        )
    expected = transcript.get("expected")
    expected_hashes = (
        expected.get("responseSha256") if isinstance(expected, dict) else None
    )
    if (
        not isinstance(expected_hashes, list)
        or not expected_hashes
        or not all(isinstance(item, str) for item in expected_hashes)
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT", "control transcript response hashes are invalid"
        )
    entrypoints = {item.id: item for item in manifest.backend_entrypoints}
    entrypoint = entrypoints[entrypoint_id]
    process = ManagedSidecarProcess(
        SidecarProcessSpec(
            identity=f"semantic-probe:{manifest.plugin.id}:{entrypoint_id}",
            executable=args.python_executable,
            arguments=("-I", "-u", "-m", entrypoint.python_module),
            working_directory=args.working_directory,
            max_message_bytes=MAX_PROBE_MESSAGE_BYTES,
        )
    )
    responses: list[Any] = []
    try:
        await process.start()
        connection = process.connection
        if connection is None:
            raise RuntimeError("semantic probe process has no JSONL connection")

        async def send_requests() -> None:
            for request in requests:
                payload = canonical_dumps(request).encode("utf-8")
                await asyncio.wait_for(connection.write(payload), timeout=15.0)

        async def read_responses() -> None:
            for _ in expected_hashes:
                response_bytes = await asyncio.wait_for(connection.read(), timeout=15.0)
                responses.append(loads_strict(response_bytes))

        send_task = asyncio.create_task(send_requests())
        read_task = asyncio.create_task(read_responses())
        try:
            await asyncio.gather(send_task, read_task)
        finally:
            for task in (send_task, read_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(send_task, read_task, return_exceptions=True)
        raw_process = process.process
        if raw_process is None:
            raise RuntimeError("semantic probe process disappeared")
        await asyncio.wait_for(raw_process.wait(), timeout=3.0)
        try:
            extra = await asyncio.wait_for(connection.read(), timeout=0.1)
        except JsonLineError as exc:
            if exc.code != "EOF":
                raise
        else:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                f"control transcript produced an extra response: {extra[:128]!r}",
            )
    finally:
        await process.terminate()
    actual_hashes = [canonical_sha256(item) for item in responses]
    if actual_hashes != expected_hashes:
        raise PlatformContractError(
            "INVALID_CONTRACT", "control transcript response hashes do not match"
        )
    return canonical_sha256(responses)


async def _semantic_probes(
    args: argparse.Namespace, manifest: PluginManifest
) -> list[dict[str, str]]:
    assets = _probe_assets(args)
    results: list[dict[str, str]] = []
    for probe in manifest.probes:
        if probe.kind != "controlTranscript" or probe.id not in assets:
            raise PlatformContractError(
                "INVALID_CONTRACT", "manifest probe is unsupported or has no asset"
            )
        actual = await _replay_control_transcript(
            args,
            manifest,
            entrypoint_id=probe.entrypoint,
            asset_path=assets[probe.id],
        )
        if actual != probe.sha256:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                f"semantic probe digest mismatch for {probe.id}",
            )
        results.append(
            {
                "id": probe.id,
                "entrypointId": probe.entrypoint,
                "sha256": actual,
            }
        )
    if set(assets) != {item.id for item in manifest.probes}:
        raise PlatformContractError(
            "INVALID_CONTRACT", "bundle and manifest probe IDs do not match"
        )
    return results


async def _probe(args: argparse.Namespace) -> dict[str, Any]:
    value = loads_strict(args.manifest.read_bytes())
    manifest = PluginManifest.from_wire(value)
    semantic_probes = await _semantic_probes(args, manifest)
    results: list[dict[str, Any]] = []
    activate = not manifest.permissions.required
    for entrypoint in manifest.backend_entrypoints:
        spec = EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id=entrypoint.id,
            executable=args.python_executable,
            arguments=("-I", "-u", "-m", entrypoint.python_module),
            working_directory=args.working_directory,
            enabled=True,
            max_restart_attempts=0,
            startup_timeout_seconds=15.0,
            request_timeout_seconds=15.0,
            shutdown_timeout_seconds=3.0,
        )
        supervisor = EntrypointSupervisor(
            spec,
            manifest,
            host_name="CandleScope",
            host_version=args.host_version,
            host_apis=(HOST_API_V1,),
        )
        try:
            descriptor = await supervisor.start()
            mode = "described"
            health: dict[str, Any] | None = None
            if activate:
                await supervisor.activate(())
                health = await supervisor.health_check()
                await supervisor.deactivate("installation probe complete")
                mode = "activated"
            results.append(
                {
                    "entrypointId": entrypoint.id,
                    "descriptorSha256": canonical_sha256(descriptor.to_wire()),
                    "mode": mode,
                    **(
                        {"healthSha256": canonical_sha256(health)}
                        if health is not None
                        else {}
                    ),
                }
            )
        finally:
            await supervisor.stop()
    return {
        "schemaVersion": 1,
        "pluginId": manifest.plugin.id,
        "manifestContractSha256": manifest.canonical_sha256,
        "semanticProbes": semantic_probes,
        "entrypoints": results,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        payload = asyncio.run(_probe(args))
    except (OSError, JsonLineError, PlatformContractError, RuntimeError) as exc:
        error = {
            "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc)[:2048],
            },
        }
        print(canonical_dumps(error), file=sys.stderr, flush=True)
        return 1
    print(canonical_dumps({"ok": True, "probe": payload}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
