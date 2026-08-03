from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.plugin_installer_v2.errors import (
    MultiRuntimeFeatureDisabledError,
    PlatformInstallerError,
    RuntimeProviderUnavailableError,
)
from app.plugin_installer_v2.installer import PlatformPluginInstaller
from app.plugin_installer_v2.registry import load_activation_registry
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
from tests.plugin_platform_multi_runtime_testkit import build_v3_runtime_bundle


def test_v3_install_feature_off_fails_before_state_or_code_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "bundle", "java-jar")
    product = tmp_path / "product"
    installer = PlatformPluginInstaller(root=product, multi_runtime_enabled=False)

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("Phase 1 must not prepare or execute schema-v3 code")

    monkeypatch.setattr(installer, "_create_installation", forbidden)
    with pytest.raises(MultiRuntimeFeatureDisabledError) as failure:
        installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )

    assert failure.value.code == "PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED"
    assert failure.value.details == {
        "runtimeKinds": ["java-jar"],
        "feature": "multi-runtime",
    }
    assert not product.exists()


def test_v3_install_feature_on_still_has_no_provider_in_phase1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "bundle", "native-executable")
    product = tmp_path / "product"
    installer = PlatformPluginInstaller(root=product, multi_runtime_enabled=True)

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("Phase 1 must not prepare or execute schema-v3 code")

    monkeypatch.setattr(installer, "_create_installation", forbidden)
    with pytest.raises(RuntimeProviderUnavailableError) as failure:
        installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
        )

    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE"
    assert failure.value.details == {"runtimeKinds": ["native-executable"]}
    assert not product.exists()


def test_multi_runtime_environment_flag_defaults_off_and_is_strict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED", raising=False)
    assert (
        PlatformPluginInstaller(root=tmp_path / "default").multi_runtime_enabled
        is False
    )
    monkeypatch.setenv("CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED", "1")
    assert (
        PlatformPluginInstaller(root=tmp_path / "enabled").multi_runtime_enabled is True
    )
    monkeypatch.setenv("CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED", "sometimes")
    with pytest.raises(PlatformInstallerError, match="must be one of"):
        PlatformPluginInstaller(root=tmp_path / "invalid")


def test_v2_install_writes_registry_v3_with_normalized_python_identity(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    installer = PlatformPluginInstaller(
        root=tmp_path / "product",
        multi_runtime_enabled=False,
    )
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    registry = load_activation_registry(installer.registry_path)
    record = registry.by_id()[installed.plugin_id]
    entrypoint = record.entrypoints[0]
    raw = json.loads(installer.registry_path.read_text(encoding="utf-8"))

    assert raw["schemaVersion"] == 3
    assert raw["plugins"][0]["schemaVersion"] == 3
    assert entrypoint.runtime_kind == "python-module"
    assert entrypoint.runtime_id == "python-v2-compat"
    assert entrypoint.artifact_sha256 == fixture.bundle.sha256
    assert (
        entrypoint.module == "candlescope_plugin_sdk.platform_v2.examples.hello_command"
    )
    assert installer.check(installed.plugin_id).state == "active"
