from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import app.plugin_installer_v2.installer as installer_module
from app.plugin_installer_v2.bundle import build_platform_bundle
from app.plugin_installer_v2.cli import main as installer_cli_main
from app.plugin_installer_v2.errors import PlatformBundleError, PlatformInstallerError
from app.plugin_installer_v2.installer import PlatformPluginInstaller
from app.plugin_installer_v2.registry import load_activation_registry
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


def test_install_quick_repeat_upgrade_and_power_safe_rollback(tmp_path: Path) -> None:
    first_bundle = build_hello_platform_bundle(tmp_path / "bundle-v1", version="0.1.0")
    second_bundle = build_hello_platform_bundle(tmp_path / "bundle-v2", version="0.2.0")
    root = tmp_path / "managed"
    root.mkdir()
    legacy_registry = root / "runtime-registry.json"
    legacy_bytes = b'{"schemaVersion":1,"plugins":[]}\n'
    legacy_registry.write_bytes(legacy_bytes)
    installer = PlatformPluginInstaller(root=root)

    first = installer.install(
        first_bundle.bundle.path,
        expected_sha256=first_bundle.bundle.sha256,
        enabled=True,
    )
    assert first.changed is True
    assert first.reused_installation is False
    assert first.state == "active"
    assert first.installation_path.is_dir()
    assert installer.registry_path.name == "platform-registry-v2.json"
    assert legacy_registry.read_bytes() == legacy_bytes
    receipt = json.loads(
        (first.installation_path / "receipt.json").read_text(encoding="utf-8")
    )
    assert receipt["probe"]["entrypoints"][0]["mode"] == "activated"
    assert receipt["probe"]["entrypoints"][0]["descriptorSha256"].startswith("sha256:")
    assert receipt["probe"]["semanticProbes"] == [
        {
            "id": "hello-transcript",
            "entrypointId": "main",
            "sha256": first_bundle.manifest["probes"][0]["sha256"],
        }
    ]

    registry_before_repeat = installer.registry_path.read_bytes()
    venv_marker = first.installation_path / "venv" / "pyvenv.cfg"
    marker_before_repeat = venv_marker.stat().st_mtime_ns
    repeated = installer.install(
        first_bundle.bundle.path,
        expected_sha256=first_bundle.bundle.sha256,
        enabled=True,
    )
    assert repeated.changed is False
    assert repeated.reused_installation is True
    assert repeated.activation_id == first.activation_id
    assert installer.registry_path.read_bytes() == registry_before_repeat
    assert venv_marker.stat().st_mtime_ns == marker_before_repeat
    installer.grant_store.path.unlink()
    grants_reconciled = installer.install(
        first_bundle.bundle.path,
        expected_sha256=first_bundle.bundle.sha256,
        enabled=True,
    )
    assert grants_reconciled.changed is True
    assert grants_reconciled.activation_id == first.activation_id
    assert installer.registry_path.read_bytes() == registry_before_repeat
    grants_before_failed_upgrade = installer.grant_store.path.read_bytes()

    original_replace = installer_module._replace_file

    def fail_registry_replace(source: Path, destination: Path) -> None:
        if destination == installer.registry_path:
            raise OSError("simulated power loss before registry replace")
        original_replace(source, destination)

    original_compensation = installer._compensate_state_transaction

    def simulate_process_loss(**_kwargs: object) -> None:
        return None

    installer._compensate_state_transaction = simulate_process_loss  # type: ignore[method-assign]
    installer_module._replace_file = fail_registry_replace
    try:
        with pytest.raises(PlatformInstallerError, match="atomically write"):
            installer.install(
                second_bundle.bundle.path,
                expected_sha256=second_bundle.bundle.sha256,
                enabled=True,
            )
    finally:
        installer_module._replace_file = original_replace
        installer._compensate_state_transaction = original_compensation  # type: ignore[method-assign]
    assert installer.registry_path.read_bytes() == registry_before_repeat
    assert installer.grant_store.path.read_bytes() != grants_before_failed_upgrade
    assert installer.state_transaction_path.is_file()

    installer = PlatformPluginInstaller(root=root)
    assert not installer.state_transaction_path.exists()
    assert installer.grant_store.path.read_bytes() == grants_before_failed_upgrade
    assert load_activation_registry(installer.registry_path).by_id()[
        first.plugin_id
    ].version == ("0.1.0")
    compensation_receipts = sorted(
        (installer.history_directory / first.plugin_id / "compensations").glob("*.json")
    )
    assert len(compensation_receipts) == 1
    compensated_upgrade = json.loads(
        compensation_receipts[0].read_text(encoding="utf-8")
    )
    assert compensated_upgrade["outcome"] == "compensated"
    assert compensated_upgrade["uncommittedHistoryPolicy"] == "retained-audit-only"
    assert (
        installer.history_directory
        / first.plugin_id
        / "activations"
        / f"{compensated_upgrade['attemptedActivationId']}.json"
    ).is_file()
    assert installer.rollback_status(first.plugin_id) == {
        "available": True,
        "target": {"state": "uninstalled", "version": None},
    }

    upgraded = installer.install(
        second_bundle.bundle.path,
        expected_sha256=second_bundle.bundle.sha256,
        enabled=True,
    )
    assert upgraded.changed is True
    assert upgraded.reused_installation is True
    assert upgraded.activation_id != first.activation_id
    assert (
        load_activation_registry(installer.registry_path)
        .by_id()[first.plugin_id]
        .version
        == "0.2.0"
    )
    registry_before_power_loss = installer.registry_path.read_bytes()
    grants_before_failed_rollback = installer.grant_store.path.read_bytes()
    installer_module._replace_file = fail_registry_replace
    try:
        with pytest.raises(PlatformInstallerError, match="atomically write"):
            installer.rollback(first.plugin_id)
    finally:
        installer_module._replace_file = original_replace
    assert installer.registry_path.read_bytes() == registry_before_power_loss
    assert installer.grant_store.path.read_bytes() == grants_before_failed_rollback
    assert (
        load_activation_registry(installer.registry_path)
        .by_id()[first.plugin_id]
        .version
        == "0.2.0"
    )
    assert (
        len(
            tuple(
                (installer.history_directory / first.plugin_id / "compensations").glob(
                    "*.json"
                )
            )
        )
        == 2
    )
    assert installer.rollback_status(first.plugin_id) == {
        "available": True,
        "target": {"state": "active", "version": "0.1.0"},
    }

    rolled_back = installer.rollback(first.plugin_id)
    assert rolled_back.from_activation_id == upgraded.activation_id
    assert rolled_back.to_activation_id == first.activation_id
    assert rolled_back.removed is False
    active = load_activation_registry(installer.registry_path).by_id()[first.plugin_id]
    assert active.version == "0.1.0"
    assert (
        installer.check(first.plugin_id).probe["entrypoints"][0]["mode"] == "activated"
    )

    disabled = installer.disable(first.plugin_id)
    assert disabled.state == "disabled"
    assert installer.enable(first.plugin_id).state == "active"
    removed = installer.uninstall(first.plugin_id)
    assert removed.state is None
    assert removed.installation_retained is True
    assert first.installation_path.is_dir()
    assert (
        first.plugin_id not in load_activation_registry(installer.registry_path).by_id()
    )
    assert legacy_registry.read_bytes() == legacy_bytes


def test_failed_install_compensation_preserves_concurrent_grant_mutation(
    tmp_path: Path,
) -> None:
    initial = build_hello_platform_bundle(
        tmp_path / "initial",
        version="0.1.0",
        required_permission=True,
    )
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    installed = installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
    )
    installer.grant_permission(
        installed.plugin_id,
        "market.bars.read",
        scope={"symbols": ["BTCUSDT"]},
    )
    installer.enable(installed.plugin_id)
    active_before = load_activation_registry(installer.registry_path).by_id()[
        installed.plugin_id
    ]

    entered_commit = threading.Event()
    release_commit = threading.Event()
    original_commit = installer._commit_registry_change

    def fail_update_commit(registry, plugin_id, before, after):
        if after is not None and after.activation_id != active_before.activation_id:
            entered_commit.set()
            assert release_commit.wait(timeout=10)
            raise OSError("simulated registry failure after grant reconciliation")
        return original_commit(registry, plugin_id, before, after)

    installer._commit_registry_change = fail_update_commit  # type: ignore[method-assign]
    mutation_started = threading.Event()
    grant_arguments = {
        "bundle_sha256": initial.bundle.sha256,
        "manifest_sha256": initial.bundle.manifest_sha256,
        "publisher_identity": installer._publisher_identity(initial.bundle),
    }

    def deny_current_grant():
        mutation_started.set()
        return installer.grant_store.deny(
            initial.bundle.manifest,
            permission_id="market.bars.read",
            **grant_arguments,
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            upgrade = executor.submit(
                installer.install,
                initial.bundle.path,
                expected_sha256=initial.bundle.sha256,
            )
            assert entered_commit.wait(timeout=10)
            mutation = executor.submit(deny_current_grant)
            assert mutation_started.wait(timeout=5)
            assert mutation.done() is False
            release_commit.set()
            with pytest.raises(
                OSError,
                match="simulated registry failure after grant reconciliation",
            ):
                upgrade.result(timeout=10)
            assert mutation.result(timeout=10).changed is True
    finally:
        release_commit.set()
        installer._commit_registry_change = original_commit  # type: ignore[method-assign]

    assert not installer.state_transaction_path.exists()
    summary = installer.permission_summary(installed.plugin_id)[0]
    assert summary["permissions"][0]["decision"] == "denied"
    active = load_activation_registry(installer.registry_path).by_id()[
        installed.plugin_id
    ]
    assert active == active_before


def test_interrupted_activation_restore_recovers_to_the_original_savepoint(
    tmp_path: Path,
) -> None:
    initial = build_hello_platform_bundle(
        tmp_path / "initial",
        version="0.1.0",
    )
    update = build_hello_platform_bundle(
        tmp_path / "update",
        version="0.2.0",
    )
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root)
    installed = installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
        enabled=True,
    )
    savepoint = installer.capture_activation_state(installed.plugin_id)
    upgraded = installer.install(
        update.bundle.path,
        expected_sha256=update.bundle.sha256,
        enabled=True,
    )

    original_replace = installer_module._replace_file
    original_compensation = installer._compensate_state_transaction

    def fail_restore_registry_replace(source: Path, destination: Path) -> None:
        if destination == installer.registry_path:
            raise OSError("simulated power loss during activation restore")
        original_replace(source, destination)

    def simulate_process_loss(**_kwargs: object) -> None:
        return None

    installer_module._replace_file = fail_restore_registry_replace
    installer._compensate_state_transaction = simulate_process_loss  # type: ignore[method-assign]
    try:
        with pytest.raises(PlatformInstallerError, match="atomically write"):
            installer.restore_activation_state(
                savepoint,
                expected_activation_id=upgraded.activation_id,
                expected_grant_record_sha256=upgraded.grant_record_sha256,
            )
    finally:
        installer_module._replace_file = original_replace
        installer._compensate_state_transaction = original_compensation  # type: ignore[method-assign]

    assert installer.state_transaction_path.is_file()
    assert load_activation_registry(installer.registry_path).by_id()[
        installed.plugin_id
    ].version == ("0.2.0")

    recovered = PlatformPluginInstaller(root=root)
    assert not recovered.state_transaction_path.exists()
    assert (
        load_activation_registry(recovered.registry_path).by_id()[installed.plugin_id]
        == savepoint.activation
    )
    assert recovered.grant_store.load().by_id()[installed.plugin_id] == savepoint.grant


def test_failed_second_entrypoint_never_creates_partial_activation(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(
        tmp_path / "bundle", bad_second_entrypoint=True
    )
    installer = PlatformPluginInstaller(root=tmp_path / "managed")

    with pytest.raises(
        PlatformInstallerError, match="fresh-process platform Host probe"
    ):
        installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
    assert not installer.registry_path.exists()
    assert not installer._installation_path(
        fixture.bundle.manifest.plugin.id, fixture.bundle.installation_id
    ).exists()
    assert not installer.staging_directory.exists() or not any(
        installer.staging_directory.iterdir()
    )


def test_required_permissions_remain_staged_until_explicit_grant(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle", required_permission=True)
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )

    assert installed.state == "staged"
    assert installed.enabled is False
    receipt = json.loads((installed.installation_path / "receipt.json").read_text())
    assert receipt["probe"]["entrypoints"][0]["mode"] == "described"
    assert receipt["probe"]["semanticProbes"] == []
    registry_before = installer.registry_path.read_bytes()
    with pytest.raises(PlatformInstallerError, match="not fully resolved"):
        installer.enable(installed.plugin_id)
    assert installer.registry_path.read_bytes() == registry_before
    assert (
        installer_cli_main(
            [
                "--root",
                str(installer.root),
                "--json",
                "permissions",
                installed.plugin_id,
            ]
        )
        == 0
    )
    permissions = json.loads(capsys.readouterr().out)
    assert permissions["grants"][0]["permissions"][0]["decision"] == "pending"
    assert (
        installer_cli_main(
            [
                "--root",
                str(installer.root),
                "--json",
                "grant",
                installed.plugin_id,
                "market.bars.read",
                "--scope-json",
                '{"symbols":["BTCUSDT"]}',
            ]
        )
        == 0
    )
    granted = json.loads(capsys.readouterr().out)["permissionChange"]
    assert granted["activationReady"] is True
    assert granted["activationState"] == "staged"
    assert installer.enable(installed.plugin_id).state == "active"
    revoked = installer.revoke_permission(
        installed.plugin_id,
        "market.bars.read",
    )
    assert revoked.activation_ready is False
    assert revoked.activation_state == "staged"
    assert revoked.state_changed is True


def test_semantic_transcript_drift_fails_before_activation(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    transcript_path = fixture.source_directory / "probes" / "hello-transcript.json"
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    invoke = next(item for item in transcript["requests"] if item["id"] == "invoke-1")
    invoke["params"]["input"]["name"] = "Drifted behavior"
    transcript_path.write_text(json.dumps(transcript), encoding="utf-8")
    drifted = build_platform_bundle(
        fixture.source_directory, tmp_path / "drifted.cspkg"
    )
    installer = PlatformPluginInstaller(root=tmp_path / "managed")

    with pytest.raises(
        PlatformInstallerError, match="fresh-process platform Host probe"
    ):
        installer.install(
            drifted.path,
            expected_sha256=drifted.sha256,
            enabled=True,
        )
    assert not installer.registry_path.exists()


def test_permission_expansion_and_rollback_both_remain_staged_until_confirmed(
    tmp_path: Path,
) -> None:
    initial = build_hello_platform_bundle(
        tmp_path / "initial",
        version="0.1.0",
        required_permission=True,
    )
    expanded = build_hello_platform_bundle(
        tmp_path / "expanded",
        version="0.2.0",
        required_permission=True,
        required_symbols=("BTCUSDT", "ETHUSDT"),
    )
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    first = installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
        enabled=True,
    )
    installer.grant_permission(
        first.plugin_id,
        "market.bars.read",
        scope={"symbols": ["BTCUSDT"]},
    )
    assert installer.enable(first.plugin_id).state == "active"

    upgrade = installer.install(
        expanded.bundle.path,
        expected_sha256=expanded.bundle.sha256,
        enabled=True,
    )
    assert upgrade.state == "staged"
    assert upgrade.activation_ready is False
    assert upgrade.permission_diff["requiresConfirmation"] is True
    assert (
        installer.permission_summary(first.plugin_id)[0]["permissions"][0]["decision"]
        == "pending"
    )

    rolled_back = installer.rollback(first.plugin_id)
    assert rolled_back.to_activation_id != first.activation_id
    restored = load_activation_registry(installer.registry_path).by_id()[
        first.plugin_id
    ]
    assert restored.version == "0.1.0"
    assert restored.state == "staged"
    assert restored.enabled is False


def test_pinned_hash_failure_has_no_store_side_effects_and_legacy_path_is_refused(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root)

    with pytest.raises(PlatformBundleError, match="SHA-256 mismatch"):
        installer.install(fixture.bundle.path, expected_sha256="0" * 64)
    assert not root.exists()
    with pytest.raises(PlatformInstallerError, match="legacy"):
        PlatformPluginInstaller(
            root=root,
            registry_path=root / "runtime-registry.json",
        )
