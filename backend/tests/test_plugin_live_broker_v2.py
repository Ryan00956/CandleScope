from __future__ import annotations

import ast
import asyncio
import base64
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app.plugin_core_v2.bootstrap import (
    PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
    build_core_plugin_platform_from_environment,
)
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_host.framing import JsonLineError, strict_json_loads
from app.plugin_host.process import plugin_environment
from app.plugin_installer_v2.registry import ActivationRecord, EntrypointActivation
from app.plugin_live_v2 import (
    LIVE_BROKER_METHODS,
    LIVE_BROKER_PROTOCOL_VERSION,
    CredentialHandle,
    LiveBrokerController,
    LiveBrokerError,
    LivePublisherTrustStore,
    PublisherEvidence,
    WindowsDpapiCredentialVault,
)
from app.plugin_live_v2.protocol import (
    METHOD_BOOTSTRAP,
    METHOD_HEALTH,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_paper_v2 import PluginPaperRuntime
from app.plugin_security_v2.audit import AuditLog
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


@dataclass(frozen=True, slots=True)
class _PinnedFixture:
    lock_path: Path
    trust_store: LivePublisherTrustStore
    evidence: PublisherEvidence


def _activation(bundle: Any, root: Path) -> ActivationRecord:
    identity = bundle.manifest.plugin
    entrypoint = bundle.manifest.backend_entrypoints[0]
    return ActivationRecord(
        plugin_id=identity.id,
        name=identity.name,
        version=identity.version,
        publisher=identity.publisher,
        installation_id=bundle.installation_id,
        bundle_sha256=bundle.sha256,
        manifest_sha256=bundle.manifest_sha256,
        activation_id="live-broker-test",
        activated_at="2026-07-23T00:00:00Z",
        state="active",
        enabled=True,
        restart_required=False,
        required_permissions=(),
        entrypoints=(
            EntrypointActivation(
                id=entrypoint.id,
                executable=Path(sys.executable),
                module=entrypoint.python_module,
                working_directory=root,
            ),
        ),
    )


@pytest.fixture(scope="module")
def pinned_fixture(tmp_path_factory: pytest.TempPathFactory) -> _PinnedFixture:
    root = tmp_path_factory.mktemp("live-broker-pinned")
    bundle = build_hello_platform_bundle(root / "bundle").bundle
    identity = bundle.manifest.plugin
    lock_path = root / "live-release-lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "connectors": [
                    {
                        "connectorId": "candlescope.test-live",
                        "pluginId": identity.id,
                        "version": identity.version,
                        "publisher": identity.publisher,
                        "bundleSha256": bundle.sha256,
                        "manifestSha256": bundle.manifest_sha256,
                    }
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    trust = LivePublisherTrustStore.from_path(lock_path)
    evidence = trust.issue_for_verified_activation(
        _activation(bundle, root),
        bundle,
        connector_id="candlescope.test-live",
        trust_level="first-party-pinned",
    )
    return _PinnedFixture(lock_path, trust, evidence)


def _request(
    sequence: int,
    session_id: str,
    method: str,
    policy_epoch: int,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "protocolVersion": LIVE_BROKER_PROTOCOL_VERSION,
        "sequence": sequence,
        "sessionId": session_id,
        "method": method,
        "policyEpoch": policy_epoch,
        "params": dict(params or {}),
    }


def test_protocol_allowlist_adds_only_read_only_account_and_shadow_surface() -> None:
    assert LIVE_BROKER_METHODS == {
        "foundation.bootstrap",
        "foundation.health",
        "policy.advance",
        "credential.put",
        "credential.describe",
        "credential.revoke",
        "account.discover",
        "account.describe",
        "account.rebind",
        "shadow.prepare",
        "shadow.describe",
        "shadow.reconcile",
        "foundation.shutdown",
    }
    forbidden = {
        "network",
        "http",
        "query",
        "sign",
        "submit",
        "cancel",
        "order",
        "trade",
    }
    assert not any(
        token in method
        for method in LIVE_BROKER_METHODS
        for token in forbidden
    )


def test_broker_network_imports_are_isolated_to_okx_readonly_connector() -> None:
    package = Path(__file__).parents[1] / "app" / "plugin_live_v2"
    banned_roots = {
        "aiohttp",
        "ccxt",
        "http",
        "requests",
        "socket",
        "urllib",
        "websockets",
    }
    violations: list[str] = []
    for path in sorted(package.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".", 1)[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                roots = {node.module.split(".", 1)[0]}
            else:
                continue
            for root in sorted(roots & banned_roots):
                if path.name != "okx_readonly.py" or root not in {
                    "http",
                    "socket",
                }:
                    violations.append(f"{path.name}:{node.lineno}:{root}")
    assert violations == []


def test_strict_framing_rejects_duplicate_json_keys() -> None:
    with pytest.raises(JsonLineError) as captured:
        strict_json_loads(
            b'{"sequence":1,"sequence":2}',
            max_message_bytes=1024,
        )
    assert captured.value.code == "INVALID_JSON"


def test_service_rejects_replay_and_stale_policy_epoch(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    session_id = "sess_" + "A" * 43
    service = LiveBrokerService(
        tmp_path / "replay",
        vault_backend="fake",
        release_lock_path=pinned_fixture.lock_path,
    )
    try:
        assert service.handle(
            _request(1, session_id, METHOD_BOOTSTRAP, 0)
        ).ok
        assert service.handle(
            _request(2, session_id, METHOD_HEALTH, 0)
        ).ok
        with pytest.raises(LiveBrokerError) as replayed:
            service.handle(_request(2, session_id, METHOD_HEALTH, 0))
        assert replayed.value.code == "LIVE_BROKER_SEQUENCE_REJECTED"
        assert replayed.value.fatal is True
    finally:
        service.close()

    service = LiveBrokerService(
        tmp_path / "epoch",
        vault_backend="fake",
        release_lock_path=pinned_fixture.lock_path,
    )
    try:
        service.handle(_request(1, session_id, METHOD_BOOTSTRAP, 0))
        advanced = service.handle(
            _request(
                2,
                session_id,
                "policy.advance",
                0,
                {"nextEpoch": 1, "reason": "test revoke"},
            )
        )
        assert advanced.policy_epoch == 1
        with pytest.raises(LiveBrokerError) as stale:
            service.handle(_request(3, session_id, METHOD_HEALTH, 0))
        assert stale.value.code == "LIVE_BROKER_POLICY_EPOCH_REJECTED"
        assert stale.value.fatal is False
        assert service.handle(
            _request(4, session_id, METHOD_HEALTH, 1)
        ).ok
    finally:
        service.close()


def test_feature_off_creates_no_process_pipe_vault_or_handle(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    root = tmp_path / "feature-off"
    controller = LiveBrokerController(
        enabled=False,
        root=root,
        release_lock_path=pinned_fixture.lock_path,
        trust_store=pinned_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
    )

    async def scenario() -> None:
        await controller.start()
        assert controller.process is None
        assert controller.process_spec is None
        assert controller.status() == {
            "enabled": False,
            "state": "disabled",
            "running": False,
            "pid": None,
            "policyEpoch": 0,
            "restartCount": 0,
            "lastErrorCode": None,
            "vaultBackend": None,
            "readOnlyAccountsEnabled": False,
            "reconciliationShadowEnabled": False,
            "networkMethods": 0,
        }
        await controller.stop()

    asyncio.run(scenario())
    assert not root.exists()


def test_feature_off_does_not_require_worker_or_release_lock_assets(
    tmp_path: Path,
) -> None:
    root = tmp_path / "feature-off-missing-assets"
    controller = LiveBrokerController(
        enabled=False,
        root=root,
        release_lock_path=tmp_path / "missing-release-lock.json",
    )
    assert controller.process is None
    assert controller.trust_store is None
    assert controller.status()["state"] == "disabled"
    assert not root.exists()


def test_private_worker_uses_opaque_handles_and_never_returns_secret(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    root = tmp_path / "fake-worker"
    controller = LiveBrokerController(
        enabled=True,
        root=root,
        release_lock_path=pinned_fixture.lock_path,
        trust_store=pinned_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
    )
    canary = bytearray(b"CANDLESCOPE-LIVE-SECRET-CANARY-20260723")
    encoded_canary = base64.b64encode(canary)

    async def scenario() -> None:
        await controller.start()
        assert controller.status()["state"] == "ready"
        health = await controller.health()
        assert health["networkMethods"] == 0
        handle = await controller.put_credential(
            pinned_fixture.evidence,
            canary,
            label="test credential",
        )
        assert isinstance(handle, CredentialHandle)
        assert handle.opaque_ref.startswith("cred_")
        assert handle.opaque_ref not in repr(handle)
        assert canary.decode() not in repr(handle)
        description = await controller.describe_credential(handle)
        assert description.plugin_id == pinned_fixture.evidence.plugin_id
        assert description.connector_id == pinned_fixture.evidence.connector_id
        assert not hasattr(description, "secret")
        assert not hasattr(handle, "secret")
        specification = controller.process_spec
        assert specification is not None
        command = "\0".join(specification.command).encode()
        assert bytes(canary) not in command
        assert encoded_canary not in command
        assert bytes(canary) not in controller.stderr_tail.encode()
        persisted_state = (root / "broker-state-v1.json").read_bytes()
        assert handle.opaque_ref.encode() not in persisted_state
        assert bytes(canary) not in persisted_state
        assert encoded_canary not in persisted_state
        await controller.revoke_credential(handle)
        await controller.revoke_credential(handle)
        with pytest.raises(LiveBrokerError) as missing:
            await controller.describe_credential(handle)
        assert missing.value.code == "LIVE_BROKER_CREDENTIAL_NOT_FOUND"
        await controller.stop()

    asyncio.run(scenario())
    inherited_environment = "\0".join(
        f"{key}={value}"
        for key, value in plugin_environment(str(Path(sys.executable).parent)).items()
    ).encode()
    assert bytes(canary) not in inherited_environment
    assert encoded_canary not in inherited_environment
    for path in root.rglob("*"):
        if path.is_file():
            payload = path.read_bytes()
            assert bytes(canary) not in payload
            assert encoded_canary not in payload


def test_policy_advance_revokes_every_opaque_handle(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    controller = LiveBrokerController(
        enabled=True,
        root=tmp_path / "advance",
        release_lock_path=pinned_fixture.lock_path,
        trust_store=pinned_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
    )

    async def scenario() -> None:
        await controller.start()
        handle = await controller.put_credential(
            pinned_fixture.evidence,
            b"epoch-secret",
            label="epoch credential",
        )
        assert await controller.advance_policy(reason="test global revoke") == 1
        with pytest.raises(LiveBrokerError) as missing:
            await controller.describe_credential(handle)
        assert missing.value.code == "LIVE_BROKER_CREDENTIAL_NOT_FOUND"
        health = await controller.health()
        assert health["credentialCount"] == 0
        await controller.stop()

    asyncio.run(scenario())


def test_broker_crash_is_fail_closed_and_paper_runtime_is_unchanged(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    controller = LiveBrokerController(
        enabled=True,
        root=tmp_path / "crash",
        release_lock_path=pinned_fixture.lock_path,
        trust_store=pinned_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
    )

    async def invoke(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {}

    paper = PluginPaperRuntime(
        root=tmp_path / "paper",
        audit_log=AuditLog(tmp_path / "paper-audit"),
        invoke=invoke,
    )

    async def scenario() -> None:
        await controller.start()
        before = paper.status()
        process = controller.process
        assert process is not None
        process.kill()
        await process.wait()
        with pytest.raises(LiveBrokerError) as failed:
            await controller.health()
        assert failed.value.code == "LIVE_BROKER_NOT_RUNNING"
        assert paper.status() == before
        await controller.restart()
        assert (await controller.health())["status"] == "ok"
        await controller.stop()
        await paper.stop()

    asyncio.run(scenario())


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI is Windows-only")
def test_windows_dpapi_vault_encrypts_at_rest_and_reopens(
    tmp_path: Path,
) -> None:
    root = tmp_path / "dpapi"
    record_id = "a" * 32
    canary = bytearray(b"CANDLESCOPE-DPAPI-CANARY-20260723")
    vault = WindowsDpapiCredentialVault(root, context=b"test-broker")
    vault.store(record_id, canary)
    ciphertext = (root / f"{record_id}.dpapi").read_bytes()
    assert bytes(canary) not in ciphertext
    assert base64.b64encode(canary) not in ciphertext
    with vault.open_secret(record_id) as opened:
        assert opened == canary
    vault.close()

    reopened = WindowsDpapiCredentialVault(root, context=b"test-broker")
    with reopened.open_secret(record_id) as opened:
        assert opened == canary
    wrong_context = WindowsDpapiCredentialVault(root, context=b"wrong-broker")
    with pytest.raises(LiveBrokerError) as rejected:
        with wrong_context.open_secret(record_id):
            pass
    assert rejected.value.code == "LIVE_BROKER_VAULT_UNPROTECT_FAILED"
    reopened.delete(record_id)
    assert reopened.list_record_ids() == set()


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI is Windows-only")
def test_windows_worker_restart_preserves_ciphertext_not_plaintext(
    tmp_path: Path,
    pinned_fixture: _PinnedFixture,
) -> None:
    root = tmp_path / "dpapi-worker"
    controller = LiveBrokerController(
        enabled=True,
        root=root,
        release_lock_path=pinned_fixture.lock_path,
        trust_store=pinned_fixture.trust_store,
        vault_backend="windows-dpapi",
    )
    canary = bytearray(b"CANDLESCOPE-WORKER-RESTART-CANARY-20260723")

    async def scenario() -> None:
        await controller.start()
        handle = await controller.put_credential(
            pinned_fixture.evidence,
            canary,
            label="restart credential",
        )
        await controller.restart()
        description = await controller.describe_credential(handle)
        assert description.label == "restart credential"
        await controller.revoke_credential(handle)
        await controller.stop()

    asyncio.run(scenario())
    for path in root.rglob("*"):
        if path.is_file():
            assert bytes(canary) not in path.read_bytes()


def test_core_environment_keeps_broker_foundation_default_off(
    tmp_path: Path,
) -> None:
    platform = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "default"),
        },
    )
    assert isinstance(platform, CorePluginPlatform)
    assert platform.live_broker_foundation_enabled is False
    assert platform.live_broker.status()["state"] == "disabled"
    assert platform.live_broker.process is None

    enabled = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "enabled"),
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
            PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
        },
    )
    assert isinstance(enabled, CorePluginPlatform)
    assert enabled.live_broker_foundation_enabled is True
    assert enabled.live_broker.status()["state"] == "stopped"
    assert enabled.live_broker.process is None


def test_core_rejects_live_broker_foundation_without_first_party_trust(
    tmp_path: Path,
) -> None:
    with pytest.raises(CorePluginError, match="pinned first-party") as captured:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="0.4.0",
            environ={
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path),
                PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
            },
        )
    assert captured.value.code == "PLUGIN_LIVE_BROKER_TRUST_REQUIRED"


@pytest.mark.skipif(os.name != "nt", reason="production Broker vault is Windows-only")
def test_core_composition_starts_and_stops_broker_foundation(
    tmp_path: Path,
) -> None:
    platform = CorePluginPlatform(
        root=tmp_path,
        host_name="CandleScope",
        host_version="0.4.0",
        trust_level="first-party-pinned",
        live_broker_foundation_enabled=True,
    )

    async def scenario() -> None:
        await platform.start()
        assert platform.live_broker.status()["state"] == "ready"
        assert (await platform.live_broker.health())["networkMethods"] == 0
        assert platform.paper.status()["brokers"] == []
        await platform.stop()
        assert platform.live_broker.process is None

    asyncio.run(scenario())
