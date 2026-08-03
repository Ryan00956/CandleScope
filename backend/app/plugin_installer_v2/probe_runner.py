"""Fresh-parent-process semantic probe for installed v2 entrypoints."""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
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
from app.plugin_core_v2.runtime_providers import (  # noqa: E402
    SandboxRuntime,
    default_runtime_provider_registry,
)
from app.plugin_security_v2.sandbox import SandboxPolicy  # noqa: E402
from app.plugin_security_v2.python_runtime import (  # noqa: E402
    SANDBOX_PYTHON_BOOTSTRAP,
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
    parser.add_argument("--sandbox-policies", type=Path)
    parser.add_argument("--sandbox-python", type=Path)
    parser.add_argument("--sandbox-site-packages", type=Path)
    parser.add_argument("--provider-seam", action="store_true")
    parser.add_argument("--native-provider", action="store_true")
    parser.add_argument("--java-provider", action="store_true")
    parser.add_argument("--managed-runtime-root", type=Path)
    return parser


@dataclass(frozen=True, slots=True)
class _EntrypointLaunch:
    executable: Path
    arguments: tuple[str, ...]
    manage_process_tree: bool = False
    isolated_search_path: bool = False
    max_processes: int = 1


def _sandbox_policies(
    args: argparse.Namespace,
    manifest: PluginManifest,
) -> dict[str, SandboxPolicy]:
    if args.sandbox_policies is None:
        if args.sandbox_python is not None or args.sandbox_site_packages is not None:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "sandbox Python requires sandbox policies",
            )
        return {}
    has_python_runtime = any(
        item.runtime.kind == "python-module" for item in manifest.normalized_entrypoints
    )
    if has_python_runtime and (
        args.sandbox_python is None or args.sandbox_site_packages is None
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "sandbox policies require a pinned Python runtime",
        )
    value = loads_strict(args.sandbox_policies.read_bytes())
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "entrypoints"}
        or value["schemaVersion"] != 1
        or not isinstance(value["entrypoints"], dict)
        or set(value["entrypoints"])
        != {item.id for item in manifest.backend_entrypoints}
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "sandbox probe policy document is invalid",
        )
    try:
        return {
            entrypoint_id: SandboxPolicy.from_wire(policy)
            for entrypoint_id, policy in value["entrypoints"].items()
        }
    except ValueError as exc:
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "sandbox probe policy is invalid",
        ) from exc


def _entrypoint_command(
    args: argparse.Namespace,
    *,
    module: str,
    sandbox_policy: SandboxPolicy | None,
) -> _EntrypointLaunch:
    if sandbox_policy is None:
        return _EntrypointLaunch(
            args.python_executable,
            ("-I", "-u", "-m", module),
        )
    runtime = args.sandbox_python.resolve(strict=True)
    site_packages = args.sandbox_site_packages.resolve(strict=True)
    working = args.working_directory.resolve(strict=True)
    if (
        not runtime.is_file()
        or runtime.is_symlink()
        or not site_packages.is_dir()
        or site_packages.is_symlink()
        or working not in site_packages.parents
    ):
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "sandbox Python runtime paths are invalid",
        )
    return _EntrypointLaunch(
        runtime,
        (
            "-I",
            "-u",
            "-c",
            SANDBOX_PYTHON_BOOTSTRAP,
            str(site_packages),
            module,
        ),
    )


def _provider_entrypoint_launch(
    args: argparse.Namespace,
    *,
    runtime: object,
    sandbox_policy: SandboxPolicy | None,
) -> _EntrypointLaunch:
    managed_registry = None
    if args.java_provider:
        if args.managed_runtime_root is None:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "Java probing requires the exact managed Runtime Registry root",
            )
        from app.plugin_runtime_registry_v3 import build_official_runtime_registry

        managed_registry = build_official_runtime_registry(
            root=args.managed_runtime_root,
            enabled=True,
            network_updates_enabled=False,
        )
    elif args.managed_runtime_root is not None:
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "managed Runtime Registry root requires the Java Provider",
        )
    registry = default_runtime_provider_registry(
        native_enabled=args.native_provider,
        java_enabled=args.java_provider,
        managed_runtime_registry=managed_registry,
    )
    provider = registry.resolve(runtime)
    artifact_path = getattr(runtime, "artifact", None)
    executable = args.python_executable
    artifact_sha256 = None
    if isinstance(artifact_path, str):
        descriptor = loads_strict(args.bundle_descriptor.read_bytes())
        artifacts = (
            descriptor.get("artifacts") if isinstance(descriptor, dict) else None
        )
        matches = (
            [
                item
                for item in artifacts
                if isinstance(item, dict) and item.get("path") == artifact_path
            ]
            if isinstance(artifacts, list)
            else []
        )
        if len(matches) != 1 or not isinstance(matches[0].get("sha256"), str):
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "runtime artifact is missing from the bundle inventory",
            )
        content_root = args.bundle_descriptor.parent.resolve(strict=True)
        executable = content_root.joinpath(*PurePosixPath(artifact_path).parts).resolve(
            strict=True
        )
        if content_root not in executable.parents or not executable.is_file():
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "runtime artifact path is unsafe or missing",
            )
        artifact_sha256 = matches[0]["sha256"]
    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=executable,
        working_directory=args.working_directory,
        artifact_sha256=artifact_sha256,
    )
    sandbox_runtime = (
        SandboxRuntime(
            executable=args.sandbox_python,
            site_packages=args.sandbox_site_packages,
        )
        if sandbox_policy is not None and prepared.runtime_kind == "python-module"
        else None
    )
    launch = provider.build_probe_launch(
        prepared,
        sandbox_runtime=sandbox_runtime,
    )
    return _EntrypointLaunch(
        launch.executable,
        launch.arguments,
        manage_process_tree=launch.manage_process_tree,
        isolated_search_path=launch.isolated_search_path,
        max_processes=launch.max_processes,
    )


def _entrypoint_launch(
    args: argparse.Namespace,
    manifest: PluginManifest,
    *,
    entrypoint_id: str,
    sandbox_policy: SandboxPolicy | None,
) -> _EntrypointLaunch:
    normalized = {item.id: item for item in manifest.normalized_entrypoints}[
        entrypoint_id
    ]
    if args.provider_seam:
        return _provider_entrypoint_launch(
            args,
            runtime=normalized.runtime,
            sandbox_policy=sandbox_policy,
        )
    declared = {item.id: item for item in manifest.backend_entrypoints}[entrypoint_id]
    module = getattr(declared, "python_module", None)
    if not isinstance(module, str):
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "schema-v3 probing requires the Runtime Provider seam",
        )
    return _entrypoint_command(
        args,
        module=module,
        sandbox_policy=sandbox_policy,
    )


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
    sandbox_policy: SandboxPolicy | None,
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
    launch = _entrypoint_launch(
        args,
        manifest,
        entrypoint_id=entrypoint_id,
        sandbox_policy=sandbox_policy,
    )
    process = ManagedSidecarProcess(
        SidecarProcessSpec(
            identity=f"semantic-probe:{manifest.plugin.id}:{entrypoint_id}",
            executable=launch.executable,
            arguments=launch.arguments,
            working_directory=args.working_directory,
            max_message_bytes=MAX_PROBE_MESSAGE_BYTES,
            trust_level="untrusted" if sandbox_policy is not None else "local-trusted",
            sandbox_policy=sandbox_policy,
            manage_process_tree=launch.manage_process_tree,
            isolated_search_path=launch.isolated_search_path,
            max_processes=launch.max_processes,
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
    except (JsonLineError, TimeoutError) as exc:
        stderr = process.stderr_tail.strip()
        raise RuntimeError(
            "semantic probe transport failed"
            + (f": {stderr[-2_048:]}" if stderr else "")
        ) from exc
    finally:
        await process.terminate()
    actual_hashes = [canonical_sha256(item) for item in responses]
    if actual_hashes != expected_hashes:
        raise PlatformContractError(
            "INVALID_CONTRACT", "control transcript response hashes do not match"
        )
    return canonical_sha256(responses)


async def _semantic_probes(
    args: argparse.Namespace,
    manifest: PluginManifest,
    sandbox_policies: dict[str, SandboxPolicy],
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
            sandbox_policy=sandbox_policies.get(probe.entrypoint),
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
    sandbox_policies = _sandbox_policies(args, manifest)
    semantic_probes = await _semantic_probes(args, manifest, sandbox_policies)
    results: list[dict[str, Any]] = []
    activate = not manifest.permissions.required
    for entrypoint in manifest.backend_entrypoints:
        sandbox_policy = sandbox_policies.get(entrypoint.id)
        launch = _entrypoint_launch(
            args,
            manifest,
            entrypoint_id=entrypoint.id,
            sandbox_policy=sandbox_policy,
        )
        spec = EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id=entrypoint.id,
            executable=launch.executable,
            arguments=launch.arguments,
            working_directory=args.working_directory,
            enabled=True,
            max_restart_attempts=0,
            startup_timeout_seconds=15.0,
            request_timeout_seconds=15.0,
            shutdown_timeout_seconds=3.0,
            trust_level="untrusted" if sandbox_policy is not None else "local-trusted",
            sandbox_policy=sandbox_policy,
            manage_process_tree=launch.manage_process_tree,
            isolated_search_path=launch.isolated_search_path,
            max_processes=launch.max_processes,
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
