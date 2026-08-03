from __future__ import annotations

import ctypes
import json
import os
import sys
import uuid
from pathlib import Path

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    NativeExecutableRuntime,
    PlatformContractError,
    PluginManifest,
)

from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_core_v2.runtime_providers import (
    NATIVE_EXECUTABLE_PROVIDER_VERSION,
    NativeExecutableProvider,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderError,
    default_runtime_provider_registry,
)
from app.plugin_host import (
    EntrypointProcessSpec,
    EntrypointSupervisor,
    PlatformHostTransportError,
)
from app.plugin_host.process import plugin_environment
from app.plugin_installer_v2.errors import (
    PlatformInstallerError,
    RuntimeProviderUnavailableError,
)
from app.plugin_installer_v2.installer import PlatformPluginInstaller
from app.plugin_installer_v2.registry import load_activation_registry
from app.plugin_security_v2 import (
    SandboxPolicy,
    delete_appcontainer_profile,
)
from tests.plugin_platform_native_testkit import (
    NATIVE_PLUGIN_ID,
    NATIVE_TRANSCRIPT_SHA256,
    NativeReferenceBuild,
    build_native_reference_bundle,
    build_python_fallback_bundle,
    compile_native_reference,
    host_platform,
    native_reference_manifest,
)


@pytest.fixture(scope="session")
def native_reference_build(
    tmp_path_factory: pytest.TempPathFactory,
) -> NativeReferenceBuild:
    return compile_native_reference(tmp_path_factory.mktemp("phase3-native-build"))


def _runtime(*, artifact: str | None = None) -> NativeExecutableRuntime:
    operating_system, architecture = host_platform()
    executable = artifact or (
        "runtime/candlescope-native-reference.exe"
        if operating_system == "windows"
        else "runtime/candlescope-native-reference"
    )
    return NativeExecutableRuntime(
        artifact=executable,
        operating_systems=(operating_system,),
        architectures=(architecture,),
        args=("--jsonl",),
    )


def _native_supervisor(
    build: NativeReferenceBuild,
    mode: str,
    *,
    request_timeout_seconds: float = 0.25,
    startup_timeout_seconds: float = 0.4,
    max_stderr_bytes: int = 32 * 1024,
) -> EntrypointSupervisor:
    manifest = PluginManifest.from_wire(
        native_reference_manifest(mode=mode, include_probe=False)
    )
    arguments = ("--jsonl",)
    if mode != "good":
        arguments += ("--mode", mode)
    return EntrypointSupervisor(
        EntrypointProcessSpec(
            plugin_id=NATIVE_PLUGIN_ID,
            entrypoint_id="main",
            executable=build.executable,
            arguments=arguments,
            working_directory=build.executable.parent,
            startup_timeout_seconds=startup_timeout_seconds,
            request_timeout_seconds=request_timeout_seconds,
            shutdown_timeout_seconds=0.25,
            max_restart_attempts=0,
            max_stderr_bytes=max_stderr_bytes,
            manage_process_tree=True,
            isolated_search_path=True,
            max_processes=1,
        ),
        manifest,
        host_name="CandleScope",
        host_version="0.4.0",
    )


def _process_has_exited(process_id: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x00100000, False, process_id)
    if not handle:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


def test_native_feature_flag_defaults_off_is_strict_and_controls_registration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flag = "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED"
    monkeypatch.delenv(flag, raising=False)
    disabled = PlatformPluginInstaller(
        root=tmp_path / "default",
        multi_runtime_enabled=True,
    )
    assert disabled.native_runtime_enabled is False
    assert disabled.runtime_provider_registry.kinds == ("python-module",)

    monkeypatch.setenv(flag, "1")
    enabled = PlatformPluginInstaller(
        root=tmp_path / "enabled",
        multi_runtime_enabled=True,
    )
    assert enabled.native_runtime_enabled is True
    assert enabled.runtime_provider_registry.kinds == (
        "native-executable",
        "python-module",
    )
    assert default_runtime_provider_registry(native_enabled=True).kinds == (
        "native-executable",
        "python-module",
    )

    monkeypatch.setenv(flag, "sometimes")
    with pytest.raises(PlatformInstallerError, match="must be one of"):
        PlatformPluginInstaller(root=tmp_path / "invalid")


def test_native_provider_verifies_inventory_binary_and_exact_launch_target(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    operating_system, architecture = host_platform()
    installation = tmp_path / "installation"
    artifact = (
        installation / "content" / "runtime" / native_reference_build.executable.name
    )
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(native_reference_build.executable.read_bytes())
    inventory = RuntimeArtifact(
        relative_path=f"runtime/{artifact.name}",
        path=artifact,
        role="native-executable",
        sha256=native_reference_build.sha256,
        size=artifact.stat().st_size,
        operating_systems=(operating_system,),
        architectures=(architecture,),
    )
    request = RuntimeInstallationRequest(
        installation=installation,
        host_executable=Path(sys.executable),
        wheel_paths=(),
        distributions=(),
        runtime_ids=("native-host",),
        artifacts=(inventory,),
    )
    provider = NativeExecutableProvider()
    bindings = provider.prepare_installation(
        request,
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("native preparation must not execute a package manager")
        ),
    )
    assert len(bindings) == 1
    assert bindings[0].provider_version == NATIVE_EXECUTABLE_PROVIDER_VERSION
    assert bindings[0].runtime_identity.startswith("sha256:")

    prepared = provider.prepare_runtime(
        runtime=_runtime(artifact=f"runtime/{artifact.name}"),
        executable=artifact,
        working_directory=installation,
        artifact_sha256=native_reference_build.sha256,
    )
    launch = provider.build_runtime_launch(prepared)
    assert launch.executable == artifact.resolve(strict=True)
    assert launch.arguments == ("--jsonl",)
    assert launch.manage_process_tree is True
    assert launch.isolated_search_path is True
    assert launch.max_processes == 1
    assert plugin_environment(str(artifact.parent), isolated_search_path=True)[
        "PATH"
    ] == str(artifact.parent)

    artifact.write_bytes(artifact.read_bytes() + b"tampered")
    with pytest.raises(RuntimeProviderError) as mismatch:
        provider.verify_installation(request, lambda *args, **kwargs: b"")
    assert mismatch.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH"


def test_native_provider_rejects_scripts_platform_mismatch_and_substitution(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    operating_system, architecture = host_platform()
    other_operating_system = "linux" if operating_system != "linux" else "windows"
    provider = NativeExecutableProvider()
    with pytest.raises(RuntimeProviderError) as mismatch:
        provider.validate_runtime(
            NativeExecutableRuntime(
                artifact="runtime/reference.exe",
                operating_systems=(other_operating_system,),
                architectures=(architecture,),
            )
        )
    assert mismatch.value.code == "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH"

    with pytest.raises(PlatformContractError):
        NativeExecutableRuntime(
            artifact="runtime/reference.ps1",
            operating_systems=(operating_system,),
            architectures=(architecture,),
        )

    installation = tmp_path / "installation"
    artifact = (
        installation / "content" / "runtime" / native_reference_build.executable.name
    )
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(native_reference_build.executable.read_bytes())
    prepared = provider.prepare_runtime(
        runtime=_runtime(artifact=f"runtime/{artifact.name}"),
        executable=artifact,
        working_directory=installation,
        artifact_sha256=native_reference_build.sha256,
    )
    from app.plugin_core_v2.runtime_providers import SandboxRuntime

    with pytest.raises(RuntimeProviderError) as substitution:
        provider.build_runtime_launch(
            prepared,
            sandbox_runtime=SandboxRuntime(
                executable=Path(sys.executable),
                site_packages=tmp_path,
            ),
        )
    assert substitution.value.code == "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID"


def test_real_native_bundle_installs_checks_and_quick_repeats(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    fixture = build_native_reference_bundle(tmp_path / "bundle", native_reference_build)
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
    )
    first = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    second = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    record = load_activation_registry(installer.registry_path).by_id()[first.plugin_id]
    entrypoint = record.entrypoints[0]
    receipt = json.loads(
        (first.installation_path / "receipt.json").read_text(encoding="utf-8")
    )

    assert first.state == "active"
    assert second.changed is False
    assert second.reused_installation is True
    assert receipt["schemaVersion"] == 3
    assert receipt["runtimeProviders"] == [
        {
            "runtimeKind": "native-executable",
            "runtimeId": "native-host",
            "providerVersion": NATIVE_EXECUTABLE_PROVIDER_VERSION,
            "runtimeIdentity": receipt["runtimeProviders"][0]["runtimeIdentity"],
        }
    ]
    assert entrypoint.runtime_kind == "native-executable"
    assert entrypoint.runtime_id == "native-host"
    assert entrypoint.module is None
    assert entrypoint.artifact == entrypoint.executable
    assert entrypoint.artifact_sha256 == native_reference_build.sha256
    assert not (first.installation_path / "venv").exists()
    checked = installer.check(first.plugin_id)
    assert checked.state == "active"
    assert checked.probe["semanticProbes"] == [
        {
            "entrypointId": "main",
            "id": "native-control",
            "sha256": NATIVE_TRANSCRIPT_SHA256,
        }
    ]


def test_native_flag_off_is_exact_unavailable_error_with_no_fallback(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    fixture = build_native_reference_bundle(tmp_path / "bundle", native_reference_build)
    product = tmp_path / "product"
    installer = PlatformPluginInstaller(
        root=product,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    with pytest.raises(RuntimeProviderUnavailableError) as failure:
        installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
        )
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE"
    assert failure.value.details == {"runtimeKinds": ["native-executable"]}
    assert not product.exists()


@pytest.mark.anyio
async def test_existing_native_activation_is_unavailable_when_flag_turns_off(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    fixture = build_native_reference_bundle(tmp_path / "bundle", native_reference_build)
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=True,
        native_runtime_enabled=True,
    )
    installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    platform = CorePluginPlatform(
        root=installer.root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    await platform.start()
    try:
        catalog = platform.catalog()
        plugin = next(
            item for item in catalog["plugins"] if item["id"] == NATIVE_PLUGIN_ID
        )
        assert catalog["platform"]["status"] == "degraded"
        assert plugin["state"] == "active"
        assert plugin["enabled"] is True
        assert plugin["available"] is False
        assert plugin["unavailableReason"] == "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE"
        assert plugin["contributions"] == []
        assert plugin["runtime"]["entrypoints"] == []
        assert platform.manager.owner_keys() == ()
    finally:
        await platform.stop()


def test_installed_native_artifact_tamper_fails_static_verification(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    fixture = build_native_reference_bundle(tmp_path / "bundle", native_reference_build)
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=True,
        native_runtime_enabled=True,
    )
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
    )
    record = load_activation_registry(installer.registry_path).by_id()[
        installed.plugin_id
    ]
    artifact = record.entrypoints[0].artifact
    assert artifact is not None
    artifact.write_bytes(artifact.read_bytes() + b"tampered-after-install")

    with pytest.raises(PlatformInstallerError, match="managed content hash mismatch"):
        installer._verify_installation(installed.installation_path)


@pytest.mark.anyio
async def test_trusted_native_core_invokes_health_and_stops_job_tree(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    fixture = build_native_reference_bundle(tmp_path / "bundle", native_reference_build)
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=True,
        native_runtime_enabled=True,
    )
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    platform = CorePluginPlatform(
        root=installer.root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
    )
    process_id = 0
    await platform.start()
    try:
        result = await platform.invoke_command(
            f"{NATIVE_PLUGIN_ID}.hello",
            {"name": "Native Phase 3"},
            user_action=True,
            trace_id="multi-runtime-phase3-native",
        )
        assert result == {
            "contributionId": "hello",
            "message": "Hello, Native Phase 3!",
        }
        supervisor = platform.manager.supervisor(installed.plugin_id, "main")
        assert supervisor.spec.executable.name == native_reference_build.executable.name
        assert supervisor.spec.arguments == ("--jsonl",)
        assert supervisor.spec.manage_process_tree is True
        assert supervisor.spec.isolated_search_path is True
        assert supervisor.spec.max_processes == 1
        assert await supervisor.health_check() == {"pending": 0, "status": "ready"}
        snapshot = supervisor.snapshot()
        assert snapshot["transport"]["processTreeControl"] is True
        process_id = snapshot["transport"]["pid"]
        assert isinstance(process_id, int) and process_id > 0
    finally:
        await platform.stop()
    assert platform.manager.owner_keys() == ()
    assert _process_has_exited(process_id)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "expected_code"),
    [
        ("crash-start", "PLUGIN_PLATFORM_EXITED"),
        ("hang-start", "PLUGIN_PLATFORM_TIMEOUT"),
        ("stdout-pollution", "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON"),
        ("invalid-utf8", "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON"),
        ("stderr-flood", "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED"),
    ],
)
async def test_native_startup_faults_are_bounded_and_diagnosable(
    native_reference_build: NativeReferenceBuild,
    mode: str,
    expected_code: str,
) -> None:
    supervisor = _native_supervisor(
        native_reference_build,
        mode,
        max_stderr_bytes=4 * 1024,
    )
    try:
        with pytest.raises(PlatformHostTransportError) as failure:
            await supervisor.start()
        assert failure.value.code == expected_code
        snapshot = supervisor.snapshot(include_stderr=True)
        assert snapshot["state"] == "failed"
        assert snapshot["lastFailure"]["code"] == expected_code
        if mode == "stderr-flood":
            assert snapshot["stderrTail"]
    finally:
        await supervisor.stop()


@pytest.mark.anyio
async def test_native_stderr_overflow_diagnostic_is_stable_under_repetition(
    native_reference_build: NativeReferenceBuild,
) -> None:
    observed: list[str] = []
    for _ in range(20):
        supervisor = _native_supervisor(
            native_reference_build,
            "stderr-flood",
            max_stderr_bytes=4 * 1024,
        )
        try:
            with pytest.raises(PlatformHostTransportError) as failure:
                await supervisor.start()
            observed.append(failure.value.code)
        finally:
            await supervisor.stop()
    assert observed == ["PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED"] * 20


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mode", "expected_code"),
    [
        ("crash-invoke", "PLUGIN_PLATFORM_EXITED"),
        ("hang-invoke", "PLUGIN_PLATFORM_TIMEOUT"),
    ],
)
async def test_native_invoke_faults_never_publish_results(
    native_reference_build: NativeReferenceBuild,
    mode: str,
    expected_code: str,
) -> None:
    supervisor = _native_supervisor(native_reference_build, mode)
    try:
        await supervisor.start()
        await supervisor.activate(())
        with pytest.raises(PlatformHostTransportError) as failure:
            await supervisor.invoke(
                "hello",
                {"name": "must not publish"},
                user_action=True,
                trace_id=f"phase3-{mode}",
            )
        assert failure.value.code == expected_code
        assert supervisor.snapshot()["state"] == "failed"
    finally:
        await supervisor.stop()


@pytest.mark.anyio
@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object gate")
async def test_windows_job_denies_native_child_and_leaves_no_root_process(
    native_reference_build: NativeReferenceBuild,
) -> None:
    supervisor = _native_supervisor(native_reference_build, "spawn-child")
    process_id = 0
    try:
        await supervisor.start()
        await supervisor.activate(())
        snapshot = supervisor.snapshot()
        process_id = snapshot["transport"]["pid"]
        assert snapshot["transport"]["processTreeControl"] is True
        result = await supervisor.invoke(
            "hello",
            {"name": "Job Object"},
            user_action=True,
            trace_id="phase3-job-object",
        )
        assert result["childPid"] == 0
    finally:
        await supervisor.stop()
    assert _process_has_exited(process_id)


@pytest.mark.anyio
async def test_disabling_native_flag_then_rollback_restores_python_activation(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    python = build_python_fallback_bundle(tmp_path / "python")
    native = build_native_reference_bundle(tmp_path / "native", native_reference_build)
    root = tmp_path / "product"
    enabled = PlatformPluginInstaller(
        root=root,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
    )
    python_result = enabled.install(
        python.bundle.path,
        expected_sha256=python.bundle.sha256,
        enabled=True,
    )
    native_result = enabled.install(
        native.bundle.path,
        expected_sha256=native.bundle.sha256,
        enabled=True,
    )
    assert native_result.installation_id != python_result.installation_id

    disabled = PlatformPluginInstaller(
        root=root,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    rolled_back = disabled.rollback(NATIVE_PLUGIN_ID)
    record = load_activation_registry(disabled.registry_path).by_id()[NATIVE_PLUGIN_ID]
    assert rolled_back.removed is False
    assert record.installation_id == python_result.installation_id
    assert record.entrypoints[0].runtime_kind == "python-module"
    assert record.entrypoints[0].module == (
        "candlescope_plugin_sdk.platform_v2.examples.hello_command"
    )
    assert record.entrypoints[0].artifact is None

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    await platform.start()
    try:
        result = await platform.invoke_command(
            f"{NATIVE_PLUGIN_ID}.hello",
            {"name": "Python rollback"},
            user_action=True,
            trace_id="phase3-python-rollback",
        )
        assert result["message"] == "Hello, Python rollback!"
        supervisor = platform.manager.supervisor(NATIVE_PLUGIN_ID, "main")
        assert supervisor.spec.executable.name.casefold().startswith("python")
    finally:
        await platform.stop()


@pytest.mark.anyio
@pytest.mark.skipif(os.name != "nt", reason="Windows AppContainer gate")
async def test_native_reference_runs_in_real_appcontainer(
    tmp_path: Path,
    native_reference_build: NativeReferenceBuild,
) -> None:
    outside_file = tmp_path / "outside-secret.txt"
    outside_file.write_text("must remain outside the plugin sandbox", encoding="utf-8")
    fixture = build_native_reference_bundle(
        tmp_path / "bundle",
        native_reference_build,
        mode="sandbox-probe",
        include_probe=False,
        extra_args=(
            "--outside-executable",
            str(native_reference_build.executable),
            "--outside-file",
            str(outside_file),
        ),
    )
    profile_name = f"CandleScope.Phase3.{uuid.uuid4().hex[:20]}"
    product = tmp_path / "product"

    def probe_policy(
        _bundle: object, installation: Path, _entrypoint: str
    ) -> SandboxPolicy:
        return SandboxPolicy(
            profile_name,
            installation,
            tmp_path / "probe-private",
            tmp_path / "probe-runtime",
            memory_limit_bytes=256 * 1024 * 1024,
            cpu_rate_percent=50,
            cpu_time_seconds=30,
            disk_limit_bytes=8 * 1024 * 1024,
            max_processes=1,
            max_wall_seconds=45,
        )

    def runtime_policy(
        record: object, _bundle: object, entrypoint_id: str
    ) -> SandboxPolicy:
        entrypoint = next(
            item for item in record.entrypoints if item.id == entrypoint_id
        )
        return SandboxPolicy(
            profile_name,
            entrypoint.working_directory,
            tmp_path / "runtime-private",
            tmp_path / "runtime-state",
            memory_limit_bytes=256 * 1024 * 1024,
            cpu_rate_percent=50,
            cpu_time_seconds=30,
            disk_limit_bytes=8 * 1024 * 1024,
            max_processes=1,
            max_wall_seconds=45,
        )

    try:
        installer = PlatformPluginInstaller(
            root=product,
            multi_runtime_enabled=True,
            native_runtime_enabled=True,
            execution_trust_resolver=lambda _bundle: "untrusted",
            probe_sandbox_factory=probe_policy,
        )
        installed = installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
        platform = CorePluginPlatform(
            root=product,
            host_name="CandleScope",
            host_version="0.4.0",
            trust_level="untrusted",
            sandbox_factory=runtime_policy,
            multi_runtime_enabled=True,
            runtime_provider_seam_enabled=True,
            native_runtime_enabled=True,
        )
        process_id = 0
        await platform.start()
        try:
            result = await platform.invoke_command(
                f"{NATIVE_PLUGIN_ID}.hello",
                {"name": "AppContainer"},
                user_action=True,
                trace_id="phase3-native-appcontainer",
            )
            assert result["message"] == "Hello, AppContainer!"
            assert result["externalExecutableStarted"] is False
            assert result["externalFileRead"] is False
            supervisor = platform.manager.supervisor(installed.plugin_id, "main")
            snapshot = supervisor.snapshot()
            assert supervisor.spec.trust_level == "untrusted"
            assert supervisor.spec.sandbox_policy is not None
            assert snapshot["transport"]["processTreeControl"] is True
            process_id = snapshot["transport"]["pid"]
        finally:
            await platform.stop()
        assert _process_has_exited(process_id)
        configs = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in (tmp_path / "runtime-state").glob("launch-*/config.json")
        ]
        assert len(configs) == 1
        config = configs[0]
        record = load_activation_registry(installer.registry_path).by_id()[
            installed.plugin_id
        ]
        artifact = record.entrypoints[0].artifact
        assert artifact is not None
        assert Path(config["command"][0]).resolve(strict=True) == artifact
        assert config["limits"]["activeProcesses"] == 1
        assert config["appContainerSid"].startswith("S-1-15-2-")
        assert config["environment"]["PATH"].split(os.pathsep) == [
            str(artifact.parent),
            str(Path(os.environ["SYSTEMROOT"]) / "System32"),
        ]
    finally:
        delete_appcontainer_profile(profile_name)
