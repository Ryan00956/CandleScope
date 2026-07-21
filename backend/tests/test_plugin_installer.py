from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from app.plugin_runtime.errors import PluginBundleError, PluginInstallerError
from app.plugin_runtime.installer import (
    PluginInstaller,
    _atomic_write_json,
    _installation_lock,
    _subprocess_environment,
)
from app.plugin_runtime.registry import (
    RuntimeProcessSpec,
    RuntimeRegistry,
    load_runtime_registry,
    runtime_registry_to_wire,
)
from app.plugin_runtime.supervisor import RuntimeSupervisor
from tests.plugin_runtime_bundle_testkit import HelloBundleFixture, build_hello_bundle


@pytest.fixture(scope="module")
def hello_bundles(
    tmp_path_factory: pytest.TempPathFactory,
) -> dict[str, HelloBundleFixture]:
    root = tmp_path_factory.mktemp("plugin-bundles")
    return {
        "0.1.0": build_hello_bundle(root / "v1", version="0.1.0"),
        "0.2.0": build_hello_bundle(root / "v2", version="0.2.0"),
        "bad-probe": build_hello_bundle(
            root / "bad-probe",
            analysis_sha256="sha256:" + "0" * 64,
        ),
    }


def _install(
    installer: PluginInstaller,
    fixture: HelloBundleFixture,
    **options: bool,
):
    return installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        **options,
    )


def test_installs_into_an_independent_venv_and_is_idempotent(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    installer = PluginInstaller(root=tmp_path / "plugins")
    first = _install(installer, hello_bundles["0.1.0"])

    assert first.changed is True
    assert first.reused_installation is False
    assert first.installation_path.is_dir()
    assert not (first.installation_path / "wheels").exists()
    assert (first.installation_path / "receipt.json").is_file()
    registry = load_runtime_registry(first.registry_path)
    spec = registry.by_id()["hello-runtime"]
    assert spec.managed is not None
    assert spec.managed.installation_id == first.installation_id
    assert spec.managed.bundle_sha256 == hello_bundles["0.1.0"].bundle.sha256
    assert spec.executable != Path(sys.executable).resolve()
    assert spec.executable.is_file()

    async def host_probe() -> None:
        supervisor = RuntimeSupervisor(
            spec,
            host_name="CandleScope",
            host_version="0.3.0",
        )
        try:
            descriptor = await supervisor.start()
            assert descriptor.id == "hello-runtime"
            assert descriptor.version == "0.1.0"
        finally:
            await supervisor.stop()

    asyncio.run(host_probe())
    checked = installer.check("hello-runtime")
    assert checked.activation_id == first.activation_id
    assert checked.bundle_sha256 == hello_bundles["0.1.0"].bundle.sha256

    second = _install(installer, hello_bundles["0.1.0"])
    assert second.changed is False
    assert second.reused_installation is True
    assert second.activation_id == first.activation_id
    assert len(tuple((installer.installs_directory / "hello-runtime").iterdir())) == 1
    assert installer.list_plugins()[0]["runtimeId"] == "hello-runtime"


def test_upgrade_and_exact_rollback_preserve_unrelated_registry_entries(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    installer = PluginInstaller(root=tmp_path / "plugins")
    initial = _install(installer, hello_bundles["0.1.0"])
    registry = load_runtime_registry(installer.registry_path)
    unrelated = RuntimeProcessSpec(
        runtime_id="community-runtime",
        expected_package="community-runtime",
        expected_version="7.0.0",
        executable=Path(sys.executable).resolve(),
        arguments=("-I", "-c", "raise SystemExit(0)"),
    )
    installer.registry_path.write_text(
        json.dumps(
            runtime_registry_to_wire(
                RuntimeRegistry(plugins=(*registry.plugins, unrelated))
            ),
            indent=2,
        ),
        encoding="utf-8",
    )

    upgraded = _install(installer, hello_bundles["0.2.0"], auto_start=True)
    assert upgraded.changed is True
    assert upgraded.activation_id != initial.activation_id
    active = load_runtime_registry(installer.registry_path).by_id()
    assert active["hello-runtime"].expected_version == "0.2.0"
    assert active["community-runtime"] == unrelated

    history_path = (
        installer.history_directory
        / "hello-runtime"
        / "activations"
        / f"{upgraded.activation_id}.json"
    )
    history_bytes = history_path.read_bytes()
    tampered_history = json.loads(history_bytes)
    tampered_history["after"]["version"] = "tampered"
    history_path.write_text(json.dumps(tampered_history), encoding="utf-8")
    registry_before_failed_rollback = installer.registry_path.read_bytes()
    with pytest.raises(PluginInstallerError, match="does not match"):
        installer.rollback("hello-runtime")
    assert installer.registry_path.read_bytes() == registry_before_failed_rollback
    history_path.write_bytes(history_bytes)

    rolled_back = installer.rollback("hello-runtime")
    assert rolled_back.from_activation_id == upgraded.activation_id
    assert rolled_back.to_activation_id == initial.activation_id
    assert rolled_back.removed is False
    active = load_runtime_registry(installer.registry_path).by_id()
    assert active["hello-runtime"].expected_version == "0.1.0"
    assert active["hello-runtime"].auto_start is False
    assert active["community-runtime"] == unrelated

    removed = installer.rollback("hello-runtime")
    assert removed.removed is True
    active = load_runtime_registry(installer.registry_path).by_id()
    assert "hello-runtime" not in active
    assert active["community-runtime"] == unrelated
    assert len(tuple((installer.installs_directory / "hello-runtime").iterdir())) == 2


def test_hash_mismatch_has_no_installer_side_effects(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    root = tmp_path / "plugins"
    installer = PluginInstaller(root=root)

    with pytest.raises(PluginBundleError, match="SHA-256 mismatch"):
        installer.install(
            hello_bundles["0.1.0"].bundle.path,
            expected_sha256="0" * 64,
        )
    assert not root.exists()


def test_probe_mismatch_never_activates_and_cleans_staging(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    installer = PluginInstaller(root=tmp_path / "plugins")

    with pytest.raises(PluginInstallerError, match="analysis probe hash"):
        _install(installer, hello_bundles["bad-probe"])

    assert not installer.registry_path.exists()
    assert not installer.installs_directory.exists()
    assert not installer.staging_directory.exists() or not any(
        installer.staging_directory.iterdir()
    )


def test_corrupt_existing_install_fails_closed_without_registry_change(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    installer = PluginInstaller(root=tmp_path / "plugins")
    installed = _install(installer, hello_bundles["0.1.0"])
    registry_before = installer.registry_path.read_bytes()
    spec = load_runtime_registry(installer.registry_path).by_id()["hello-runtime"]
    spec.executable.unlink()

    with pytest.raises(PluginInstallerError, match="Python executable is missing"):
        _install(installer, hello_bundles["0.1.0"])

    assert installer.registry_path.read_bytes() == registry_before
    assert installed.installation_path.is_dir()


def test_required_policy_must_be_explicitly_autostarted(
    tmp_path: Path,
    hello_bundles: dict[str, HelloBundleFixture],
) -> None:
    installer = PluginInstaller(root=tmp_path / "plugins")

    with pytest.raises(PluginInstallerError, match="enabled with auto-start"):
        _install(installer, hello_bundles["0.1.0"], required=True)
    assert not installer.root.exists()


def test_installer_subprocesses_do_not_inherit_ambient_application_secrets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("CANDLESCOPE_INSTALL_TEST_SECRET", "must-not-cross")
    environment = _subprocess_environment(tmp_path)

    assert "CANDLESCOPE_INSTALL_TEST_SECRET" not in environment
    assert "PYTHONPATH" not in environment
    assert environment["PIP_NO_INDEX"] == "1"
    assert environment["PATH"].split(";" if sys.platform == "win32" else ":")[0] == str(
        tmp_path
    )


def test_cross_process_lock_has_a_bounded_timeout(tmp_path: Path) -> None:
    lock_path = tmp_path / ".installer.lock"

    with _installation_lock(lock_path, 1):
        with pytest.raises(PluginInstallerError, match="timed out"):
            with _installation_lock(lock_path, 0.05):
                pytest.fail("the second lock must not be acquired")


def test_failed_atomic_replace_preserves_previous_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registry = tmp_path / "runtime-registry.json"
    registry.write_bytes(b"previous-state")

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise PermissionError("simulated replace failure")

    monkeypatch.setattr("app.plugin_runtime.installer._replace_file", fail_replace)
    with pytest.raises(PluginInstallerError, match="atomically write"):
        _atomic_write_json(registry, {"schemaVersion": 1, "plugins": []})

    assert registry.read_bytes() == b"previous-state"
    assert not tuple(tmp_path.glob("*.part"))


def test_registry_and_install_root_cannot_use_different_locks(tmp_path: Path) -> None:
    with pytest.raises(PluginInstallerError, match="directly inside"):
        PluginInstaller(
            root=tmp_path / "managed-root",
            registry_path=tmp_path / "other-root" / "registry.json",
        )
