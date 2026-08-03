from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from candlescope_plugin_sdk.platform_v2 import PythonModuleRuntime

from app.plugin_core_v2.runtime_providers import (
    PYTHON_MODULE_PROVIDER_VERSION,
    RUNTIME_PROVIDER_API_VERSION,
    PythonModuleProvider,
    RuntimeInstallationRequest,
    RuntimeProviderError,
    RuntimeProviderRegistry,
    SandboxRuntime,
)
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2.errors import (
    PlatformInstallerBaseError,
    PlatformInstallerError,
    RuntimeProviderReceiptMismatchError,
    RuntimeProviderUnavailableError,
)
from app.plugin_installer_v2.installer import PlatformPluginInstaller
from app.plugin_installer_v2.registry import load_activation_registry
from app.plugin_security_v2.python_runtime import SANDBOX_PYTHON_BOOTSTRAP
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
from tests.plugin_platform_multi_runtime_testkit import (
    build_v3_runtime_bundle,
    read_v3_manifest,
)


def _provider_stub(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "api_version": RUNTIME_PROVIDER_API_VERSION,
        "kind": "python-module",
        "provider_version": "1.0.0",
    }
    values.update(
        {
            name: lambda *args, **kwargs: None
            for name in (
                "validate_runtime",
                "prepare_installation",
                "verify_installation",
                "prepare_runtime",
                "build_probe_launch",
                "build_runtime_launch",
            )
        }
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def test_provider_registry_fails_closed_for_duplicates_unknown_and_versions() -> None:
    provider = _provider_stub()
    with pytest.raises(RuntimeProviderError) as duplicate:
        RuntimeProviderRegistry((provider, provider))
    assert duplicate.value.code == "PLUGIN_RUNTIME_PROVIDER_DUPLICATE"

    with pytest.raises(RuntimeProviderError) as incompatible:
        RuntimeProviderRegistry((_provider_stub(api_version=99),))
    assert incompatible.value.code == "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE"

    with pytest.raises(RuntimeProviderError) as incomplete:
        RuntimeProviderRegistry((_provider_stub(build_runtime_launch=None),))
    assert incomplete.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"

    registry = RuntimeProviderRegistry((provider,))
    with pytest.raises(RuntimeProviderError) as unknown:
        registry.get("java-jar")
    assert unknown.value.code == "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE"
    assert unknown.value.details == {"runtimeKinds": ["java-jar"]}


def test_python_provider_preserves_v2_command_and_places_v3_args_before_module(
    tmp_path: Path,
) -> None:
    provider = PythonModuleProvider()
    runtime = PythonModuleRuntime(
        module="candlescope_plugin_sdk.platform_v2.examples.hello_command",
        runtime_id="python-v2-compat",
    )
    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=Path(sys.executable),
        working_directory=tmp_path,
        artifact_sha256="sha256:" + "1" * 64,
    )
    launch = provider.build_runtime_launch(prepared)
    assert launch.executable == Path(sys.executable).resolve(strict=False)
    assert launch.arguments == (
        "-I",
        "-u",
        "-m",
        "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    )
    assert launch.working_directory == tmp_path.resolve(strict=False)
    assert launch.provider_version == PYTHON_MODULE_PROVIDER_VERSION

    v3_runtime = PythonModuleRuntime(
        module="candlescope_plugin_sdk.platform_v2.examples.hello_command",
        runtime_id="python-3-13",
        interpreter_args=("-X", "utf8"),
    )
    v3_prepared = provider.prepare_runtime(
        runtime=v3_runtime,
        executable=Path(sys.executable),
        working_directory=tmp_path,
        artifact_sha256="sha256:" + "2" * 64,
    )
    v3_launch = provider.build_probe_launch(v3_prepared)
    assert v3_launch.arguments == (
        "-I",
        "-u",
        "-X",
        "utf8",
        "-m",
        "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    )
    with pytest.raises(RuntimeProviderError) as unsafe_args:
        provider.validate_runtime(
            PythonModuleRuntime(
                module="safe.module",
                runtime_id="python-local",
                interpreter_args=("-c", "print('bypass')"),
            )
        )
    assert unsafe_args.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"
    for terminating_argument in ("-h", "-i", "-V"):
        with pytest.raises(RuntimeProviderError) as terminating:
            provider.validate_runtime(
                PythonModuleRuntime(
                    module="safe.module",
                    runtime_id="python-local",
                    interpreter_args=(terminating_argument,),
                )
            )
        assert terminating.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"

    site_packages = tmp_path / "venv" / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    sandbox_launch = provider.build_runtime_launch(
        v3_prepared,
        sandbox_runtime=SandboxRuntime(
            executable=Path(sys.executable),
            site_packages=site_packages,
            runtime_identity="sha256:" + "3" * 64,
        ),
    )
    assert sandbox_launch.arguments == (
        "-I",
        "-u",
        "-X",
        "utf8",
        "-c",
        SANDBOX_PYTHON_BOOTSTRAP,
        str(site_packages.resolve(strict=True)),
        "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    )


def test_installation_request_is_language_neutral_but_python_requires_wheels(
    tmp_path: Path,
) -> None:
    installation = tmp_path / "installation"
    installation.mkdir()
    request = RuntimeInstallationRequest(
        installation=installation,
        host_executable=Path(sys.executable),
        wheel_paths=(),
        distributions=(),
        runtime_ids=("native-local",),
    )
    assert request.wheel_paths == ()
    assert request.distributions == ()

    with pytest.raises(RuntimeProviderError) as unsupported_shape:
        PythonModuleProvider().verify_installation(request, lambda *args, **kwargs: b"")
    assert unsupported_shape.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"


def test_installer_preserves_provider_version_incompatibility(
    tmp_path: Path,
) -> None:
    manifest = read_v3_manifest("python-module")
    fixture = build_v3_runtime_bundle(
        tmp_path / "bundle",
        "python-module",
        manifest=manifest,
    )

    def incompatible(_runtime: object) -> None:
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
            "provider API version is incompatible",
        )

    registry = SimpleNamespace(get=incompatible, resolve=incompatible)
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=True,
        runtime_provider_registry=registry,
    )
    with pytest.raises(PlatformInstallerBaseError) as failure:
        installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
        )
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE"


def test_v2_provider_and_rollback_paths_have_equivalent_activation_and_probe(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    provider_installer = PlatformPluginInstaller(
        root=tmp_path / "provider",
        runtime_provider_seam_enabled=True,
    )
    rollback_installer = PlatformPluginInstaller(
        root=tmp_path / "rollback",
        runtime_provider_seam_enabled=False,
    )

    provider_result = provider_installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    rollback_result = rollback_installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    provider_record = load_activation_registry(
        provider_installer.registry_path
    ).by_id()[provider_result.plugin_id]
    rollback_record = load_activation_registry(
        rollback_installer.registry_path
    ).by_id()[rollback_result.plugin_id]
    provider_entrypoint = provider_record.entrypoints[0]
    rollback_entrypoint = rollback_record.entrypoints[0]

    assert (
        provider_entrypoint.id,
        provider_entrypoint.module,
        provider_entrypoint.runtime_kind,
        provider_entrypoint.runtime_id,
        provider_entrypoint.arguments,
    ) == (
        rollback_entrypoint.id,
        rollback_entrypoint.module,
        rollback_entrypoint.runtime_kind,
        rollback_entrypoint.runtime_id,
        rollback_entrypoint.arguments,
    )
    assert provider_entrypoint.executable.name == rollback_entrypoint.executable.name
    provider_receipt = json.loads(
        (provider_result.installation_path / "receipt.json").read_text(encoding="utf-8")
    )
    rollback_receipt = json.loads(
        (rollback_result.installation_path / "receipt.json").read_text(encoding="utf-8")
    )
    assert provider_receipt["schemaVersion"] == 3
    assert provider_receipt["runtimeProviders"] == [
        {
            "runtimeKind": "python-module",
            "runtimeId": "python-v2-compat",
            "providerVersion": PYTHON_MODULE_PROVIDER_VERSION,
            "runtimeIdentity": provider_receipt["runtimeProviders"][0][
                "runtimeIdentity"
            ],
        }
    ]
    assert provider_receipt["runtimeProviders"][0]["runtimeIdentity"].startswith(
        "sha256:"
    )
    assert rollback_receipt["schemaVersion"] == 2
    assert "runtimeProviders" not in rollback_receipt
    assert provider_receipt["probe"] == rollback_receipt["probe"]
    assert provider_installer.check(provider_result.plugin_id).state == "active"
    assert rollback_installer.check(rollback_result.plugin_id).state == "active"
    assert (
        PlatformPluginInstaller(
            root=rollback_installer.root,
            runtime_provider_seam_enabled=True,
        )
        .check(rollback_result.plugin_id)
        .state
        == "active"
    )
    assert (
        PlatformPluginInstaller(
            root=provider_installer.root,
            runtime_provider_seam_enabled=False,
        )
        .check(provider_result.plugin_id)
        .state
        == "active"
    )


@pytest.mark.anyio
async def test_schema_v3_python_installs_only_with_both_gates_enabled(
    tmp_path: Path,
) -> None:
    manifest = read_v3_manifest("python-module")
    manifest["backend"]["entrypoints"][0]["runtime"]["module"] = (
        "candlescope_plugin_sdk.platform_v2.examples.hello_command"
    )
    manifest["contributions"] = [
        {
            "id": "hello",
            "kind": "command/1",
            "title": "Say hello",
            "entrypoint": "main",
            "configuration": {},
        }
    ]
    fixture = build_v3_runtime_bundle(
        tmp_path / "bundle",
        "python-module",
        manifest=manifest,
    )

    with pytest.raises(RuntimeProviderUnavailableError):
        PlatformPluginInstaller(
            root=tmp_path / "rollback",
            multi_runtime_enabled=True,
            runtime_provider_seam_enabled=False,
        ).install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
        )

    installer = PlatformPluginInstaller(
        root=tmp_path / "provider",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
    )
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    record = load_activation_registry(installer.registry_path).by_id()[
        installed.plugin_id
    ]
    assert record.entrypoints[0].runtime_kind == "python-module"
    assert record.entrypoints[0].runtime_id == "python-3-13"
    assert record.entrypoints[0].arguments == ("-X", "utf8")
    assert installer.check(installed.plugin_id).state == "active"
    platform = CorePluginPlatform(
        root=installer.root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
    )
    await platform.start()
    try:
        supervisor = platform.manager.supervisor(installed.plugin_id, "main")
        assert supervisor.state == "stopped"
        result = await platform.invoke_command(
            "candlescope.fixture-python.hello",
            {"name": "Phase 2"},
            user_action=True,
            trace_id="multi-runtime-phase2-v3-python",
        )
        assert result["message"] == "Hello, Phase 2!"
        assert supervisor.state == "active"
    finally:
        await platform.stop()
    assert platform.manager.owner_keys() == ()


def test_provider_receipt_identity_tamper_fails_verification(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    installer = PlatformPluginInstaller(root=tmp_path / "product")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
    )
    receipt_path = installed.installation_path / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["runtimeProviders"][0]["runtimeIdentity"] = "sha256:" + "0" * 64
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    with pytest.raises(RuntimeProviderReceiptMismatchError) as mismatch:
        installer._verify_installation(installed.installation_path)
    assert mismatch.value.code == "PLUGIN_RUNTIME_PROVIDER_RECEIPT_MISMATCH"


def test_provider_seam_environment_flag_defaults_on_and_is_strict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flag = "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED"
    monkeypatch.delenv(flag, raising=False)
    assert PlatformPluginInstaller(
        root=tmp_path / "default"
    ).runtime_provider_seam_enabled
    monkeypatch.setenv(flag, "0")
    assert not PlatformPluginInstaller(
        root=tmp_path / "disabled"
    ).runtime_provider_seam_enabled
    monkeypatch.setenv(flag, "sometimes")
    with pytest.raises(PlatformInstallerError, match="must be one of"):
        PlatformPluginInstaller(root=tmp_path / "invalid")


def test_supervisor_remains_language_neutral() -> None:
    source = (
        Path(__file__).parents[1] / "app" / "plugin_host" / "supervisor.py"
    ).read_text(encoding="utf-8")
    assert "runtime_providers" not in source
    assert "PythonModuleProvider" not in source
    assert "arguments: tuple[str, ...] = ()" in source
