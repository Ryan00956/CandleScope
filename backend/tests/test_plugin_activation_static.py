from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from app.plugin_installer_v2.errors import PlatformInstallerError
from app.plugin_installer_v2.installer import (
    InstallationReceipt,
    PlatformPluginInstaller,
)
from app.plugin_installer_v2.registry import ActivationRecord, EntrypointActivation
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


def test_static_activation_verification_binds_all_immutable_identity_fields(
    tmp_path: Path,
) -> None:
    # This verifier promises not to execute the plugin. Supply actual bundle,
    # receipt and content bytes, with a deliberately non-executable launcher.
    # Real venv creation, probes and upgrades remain in test_plugin_installer_v2.
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    bundle = fixture.bundle
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    installation = (
        installer.installs_directory
        / bundle.manifest.plugin.id
        / bundle.installation_id
    )
    bundle.extract_to(installation / "content")
    shutil.copyfile(bundle.path, installation / "bundle.cspkg")
    receipt = InstallationReceipt.from_bundle(bundle, probe={})
    (installation / "receipt.json").write_text(
        json.dumps(receipt.to_wire()), encoding="utf-8"
    )
    python = installer._venv_python(installation)
    python.parent.mkdir(parents=True)
    python.write_bytes(b"Static fixture only; this is not an executable.")
    record = ActivationRecord(
        plugin_id=bundle.manifest.plugin.id,
        name=bundle.manifest.plugin.name,
        version=bundle.manifest.plugin.version,
        publisher=bundle.manifest.plugin.publisher,
        installation_id=bundle.installation_id,
        bundle_sha256=bundle.sha256,
        manifest_sha256=bundle.manifest_sha256,
        activation_id="static-test",
        activated_at="2026-09-02T00:00:00Z",
        state="active",
        enabled=True,
        restart_required=False,
        required_permissions=(),
        entrypoints=tuple(
            EntrypointActivation(
                id=entrypoint.id,
                executable=python,
                module=entrypoint.python_module,
                working_directory=installation,
                artifact_sha256=bundle.sha256,
            )
            for entrypoint in bundle.manifest.backend_entrypoints
        ),
    )

    verified, verified_path = installer.verify_activation_static(record)
    assert verified.sha256 == fixture.bundle.sha256
    assert verified_path == installation
    with pytest.raises(PlatformInstallerError, match="immutable installation"):
        installer.verify_activation_static(replace(record, name="Spoofed Name"))
    with pytest.raises(PlatformInstallerError, match="immutable installation"):
        installer.verify_activation_static(
            replace(record, required_permissions=("notifications.show",))
        )
    python.unlink()
    with pytest.raises(PlatformInstallerError, match="Python is missing"):
        installer.verify_activation_static(record)
