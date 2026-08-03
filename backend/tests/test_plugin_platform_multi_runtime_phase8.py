from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from candlescope_plugin_sdk.platform_v2 import PluginManifest, WasmComponentRuntime

from app.plugin_core_v2.runtime_providers import (
    WASM_COMPONENT_PROVIDER_VERSION,
    WASM_LINEAR_MEMORY_BYTES,
    WASM_PROCESS_FUEL,
    WASM_RUNTIME_ENABLED_ENV,
    WASMTIME_FIXED_ARGUMENTS,
    WASMTIME_RUNTIME_ID,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderError,
    RuntimeSupplyBinding,
    WasmComponentProvider,
    default_runtime_provider_registry,
)
from app.plugin_host.transport import _wasmtime_exit_failure
from app.plugin_runtime_registry_v3 import (
    OFFICIAL_REGISTRY_V4_PATH,
    OFFICIAL_REGISTRY_V5_PATH,
    OFFICIAL_ROOTS_PATH,
    OFFICIAL_ROOTS_V4_PATH,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)
from app.plugin_security_v2 import restricted_runtime_profile


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = REPOSITORY_ROOT / "examples" / "plugin-platform-wasm-rust"


def _sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class _ManagedWasmRegistry:
    def __init__(self, executable: Path) -> None:
        self.calls: list[tuple[str, str, bool]] = []
        self.supply = RuntimeSupplyBinding(
            source="host-managed",
            runtime_id=WASMTIME_RUNTIME_ID,
            runtime_kind="wasm",
            version="47.0.3",
            executable=executable,
            artifact_sha256="sha256:" + "1" * 64,
            artifact_size=13_283_825,
            probe_sha256="sha256:" + "2" * 64,
            verification_status="verified",
            reproducible=True,
            registry_id="candlescope.reference-runtime",
            registry_revision=5,
            registry_sha256="sha256:" + "3" * 64,
            source_url=(
                "https://github.com/bytecodealliance/wasmtime/releases/download/"
                "v47.0.3/wasmtime-v47.0.3-x86_64-windows.zip"
            ),
            license_spdx="Apache-2.0 WITH LLVM-exception",
        )

    def ensure(self, runtime_id: str, kind: str, *, offline: bool = False) -> object:
        self.calls.append((runtime_id, kind, offline))
        return SimpleNamespace(supply=self.supply, executable=self.supply.executable)


def _fixture(
    tmp_path: Path,
) -> tuple[
    WasmComponentProvider, WasmComponentRuntime, RuntimeInstallationRequest, Path
]:
    wasmtime = tmp_path / ("wasmtime.exe" if sys.platform == "win32" else "wasmtime")
    wasmtime.write_bytes(b"managed-wasmtime-fixture")
    component = tmp_path / "install" / "content" / "runtime" / "main.wasm"
    component.parent.mkdir(parents=True)
    component.write_bytes((REFERENCE_ROOT / "runtime" / "main.wasm").read_bytes())
    runtime = WasmComponentRuntime(
        artifact="runtime/main.wasm",
        runtime_id=WASMTIME_RUNTIME_ID,
        export="wasi:cli.run",
        wasi_profile="wasi-preview2",
    )
    artifact = RuntimeArtifact(
        relative_path="runtime/main.wasm",
        path=component,
        role="wasm-component",
        sha256=_sha(component),
        size=component.stat().st_size,
        operating_systems=("linux", "windows"),
        architectures=("x86_64",),
    )
    request = RuntimeInstallationRequest(
        installation=tmp_path / "install",
        host_executable=Path(sys.executable),
        wheel_paths=(),
        distributions=(),
        runtime_ids=(WASMTIME_RUNTIME_ID,),
        artifacts=(artifact,),
        entry_artifacts=(artifact.relative_path,),
    )
    return (
        WasmComponentProvider(_ManagedWasmRegistry(wasmtime)),
        runtime,
        request,
        component,
    )


def test_revision5_adds_exact_windows_and_linux_wasmtime_releases() -> None:
    roots4 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V4_PATH.read_bytes())
    roots5 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    revision4 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V4_PATH.read_bytes(), roots4
    )
    revision5 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V5_PATH.read_bytes(), roots5
    )

    assert len(roots4) == 4
    assert len(roots5) == 5
    assert revision5.revision == 5
    assert revision5.previous_registry_sha256 == revision4.sha256
    releases = [
        item for item in revision5.runtimes if item.runtime_id == WASMTIME_RUNTIME_ID
    ]
    assert [(item.operating_system, item.archive_format) for item in releases] == [
        ("linux", "tar.xz"),
        ("windows", "zip"),
    ]
    assert {item.version for item in releases} == {"47.0.3"}
    assert {item.license_spdx for item in releases} == {
        "Apache-2.0 WITH LLVM-exception"
    }
    for release in releases:
        assert [item.projection for item in release.evidence] == [
            "github-release-asset-v1",
            "raw",
            "raw",
            "github-git-commit-v1",
        ]
        assert release.legal_directory == "."
        assert release.legal_file_count == 1


def test_wasm_provider_is_default_off_and_requires_exact_managed_runtime() -> None:
    shape = SimpleNamespace(ensure=lambda *_args, **_kwargs: None)
    assert (
        "wasm-component"
        not in default_runtime_provider_registry(
            managed_runtime_registry=shape,
            wasm_enabled=False,
        ).kinds
    )
    assert (
        "wasm-component"
        in default_runtime_provider_registry(
            managed_runtime_registry=shape,
            wasm_enabled=True,
        ).kinds
    )
    assert WASM_RUNTIME_ENABLED_ENV == "CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED"
    with pytest.raises(RuntimeProviderError) as failure:
        WasmComponentProvider(shape).validate_runtime(
            WasmComponentRuntime(
                artifact="runtime/main.wasm",
                runtime_id="wasmtime-other",
                export="other",
                wasi_profile="wasi-preview1",
            )
        )
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"


def test_wasm_provider_validates_component_and_builds_a_fixed_launch(
    tmp_path: Path,
) -> None:
    provider, runtime, request, component = _fixture(tmp_path)
    binding = provider.prepare_installation(request, lambda *_args, **_kwargs: b"")[0]
    assert binding.provider_version == WASM_COMPONENT_PROVIDER_VERSION
    assert binding.runtime_supply is not None
    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=component,
        working_directory=request.installation,
        artifact_sha256=_sha(component),
    )
    launch = provider.build_runtime_launch(prepared)
    assert launch.arguments[:-2] == WASMTIME_FIXED_ARGUMENTS
    assert launch.arguments[-2] == "--"
    assert launch.arguments[-1] == str(component.resolve())
    assert launch.manage_process_tree is True
    assert launch.isolated_search_path is True
    assert launch.max_processes == 1
    assert launch.failure_classifier == "wasmtime-v1"
    assert launch.terminate_on_cancel is True

    component.write_bytes(b"\0asm\x01\0\0\0")
    with pytest.raises(RuntimeProviderError) as failure:
        provider.verify_installation(request, lambda *_args, **_kwargs: b"")
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID"


def test_wasmtime_policy_has_no_ambient_capability_flags() -> None:
    arguments = set(WASMTIME_FIXED_ARGUMENTS)
    expected_config = (
        "--config=NUL" if sys.platform == "win32" else "--config=/dev/null"
    )
    assert expected_config in arguments
    assert "-Ccache=n" in arguments
    assert "-Sinherit-network=n" in arguments
    assert "-Sallow-ip-name-lookup=n" in arguments
    assert "-Stcp=n" in arguments
    assert "-Sudp=n" in arguments
    assert "-Sinherit-env=n" in arguments
    assert "-Shttp=n" in arguments
    assert "-Sthreads=n" in arguments
    assert "-Wthreads=n" in arguments
    assert "-Wshared-memory=n" in arguments
    assert not any("--dir" in item or "-Scwd=" in item for item in arguments)
    assert WASM_LINEAR_MEMORY_BYTES == 64 * 1024 * 1024
    assert WASM_PROCESS_FUEL == 1_000_000_000


def test_wasmtime_failures_have_stable_diagnostics() -> None:
    assert (
        _wasmtime_exit_failure("wasm trap: all fuel consumed by WebAssembly")[0]
        == "PLUGIN_WASM_FUEL_EXHAUSTED"
    )
    assert (
        _wasmtime_exit_failure("forcing trap when growing memory to 67174400 bytes")[0]
        == "PLUGIN_WASM_MEMORY_LIMIT_EXCEEDED"
    )
    assert (
        _wasmtime_exit_failure("wasm trap: wasm `unreachable` instruction executed")[0]
        == "PLUGIN_WASM_TRAP"
    )
    assert _wasmtime_exit_failure("ordinary process failure") is None


def test_reference_manifest_sdk_lock_and_restricted_profile_are_frozen() -> None:
    manifest = PluginManifest.from_wire(
        json.loads((REFERENCE_ROOT / "manifest.json").read_bytes())
    )
    runtime = manifest.normalized_entrypoints[0].runtime
    assert isinstance(runtime, WasmComponentRuntime)
    assert runtime.runtime_id == WASMTIME_RUNTIME_ID
    assert runtime.export == "wasi:cli.run"
    assert runtime.wasi_profile == "wasi-preview2"
    assert runtime.args == ()
    lock = json.loads((REFERENCE_ROOT / "supply-chain.lock.json").read_bytes())
    component = REFERENCE_ROOT / "runtime" / "main.wasm"
    assert component.read_bytes()[:8] == b"\0asm\r\0\x01\0"
    assert lock["artifacts"]["main.wasm"] == {
        "sha256": _sha(component),
        "size": component.stat().st_size,
    }
    assert lock["dependencies"] == []
    assert lock["offline"] is True
    assert lock["reproducibleBuilds"] == 2
    assert lock["transcriptResponses"] == 12
    sbom = json.loads((REFERENCE_ROOT / "sbom" / "cyclonedx.json").read_bytes())
    assert sbom["metadata"]["component"]["name"] == manifest.plugin.id
    assert sbom["metadata"]["component"]["version"] == manifest.plugin.version
    profile = restricted_runtime_profile("wasm-component")
    assert profile.profile_id == "restricted-wasm-v1"
    assert profile.memory_limit_bytes == 256 * 1024 * 1024
    assert profile.max_processes == 1
