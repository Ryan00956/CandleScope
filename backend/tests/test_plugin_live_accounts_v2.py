from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import socket
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.plugin_core_v2.bootstrap import (
    PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
    PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
    build_core_plugin_platform_from_environment,
)
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_host.framing import strict_json_loads
from app.plugin_installer_v2.registry import ActivationRecord, EntrypointActivation
from app.plugin_live_v2 import (
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    LiveBrokerController,
    LiveBrokerError,
    LivePublisherTrustStore,
    PublisherEvidence,
)
from app.plugin_live_v2.accounts import ReadOnlyAccountProof
from app.plugin_live_v2.okx_readonly import (
    OKX_ACCOUNT_BALANCE_PATH,
    OKX_ACCOUNT_CONFIG_PATH,
    OkxDemoReadOnlyConnector,
    OkxHttpResponse,
    OkxPinnedHttpsTransport,
    encode_okx_demo_credential,
    parse_okx_demo_credential,
    resolve_public_okx_addresses,
)
from app.plugin_live_v2.protocol import (
    LIVE_BROKER_PROTOCOL_VERSION,
    METHOD_ACCOUNT_DESCRIBE,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_ACCOUNT_REBIND,
    METHOD_BOOTSTRAP,
    METHOD_CREDENTIAL_PUT,
    METHOD_CREDENTIAL_REVOKE,
    METHOD_POLICY_ADVANCE,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_live_v2.state import (
    BROKER_STATE_SCHEMA_VERSION,
    BrokerStateStore,
)
from scripts.downgrade_live_broker_state_v2_to_v1 import (
    downgrade_live_broker_state,
)
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


@dataclass(frozen=True, slots=True)
class _PinnedAccountFixture:
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
        activation_id="live-account-test",
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
def pinned_account_fixture(
    tmp_path_factory: pytest.TempPathFactory,
) -> _PinnedAccountFixture:
    root = tmp_path_factory.mktemp("live-account-pinned")
    bundle = build_hello_platform_bundle(root / "bundle").bundle
    identity = bundle.manifest.plugin
    lock_path = root / "live-release-lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "connectors": [
                    {
                        "connectorId": OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
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
        connector_id=OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
        trust_level="first-party-pinned",
    )
    return _PinnedAccountFixture(lock_path, trust, evidence)


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


def _proof(identity: str, *, asset_count: int = 2) -> ReadOnlyAccountProof:
    return ReadOnlyAccountProof(
        connector_id=OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
        venue="okx",
        environment="demo",
        product_scope="spot",
        canonical_account_sha256=(
            f"sha256:{hashlib.sha256(identity.encode('ascii')).hexdigest()}"
        ),
        permission="read_only",
        account_mode="spot",
        position_mode="net_mode",
        asset_count=asset_count,
        observed_at="2026-07-23T01:02:03.000Z",
    )


class _FakeAccountConnector:
    connector_id = OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
    network_method_count = 2

    def __init__(self) -> None:
        self.proofs: dict[bytes, ReadOnlyAccountProof] = {}
        self.seen: list[bytes] = []

    def discover(self, secret: bytearray) -> ReadOnlyAccountProof:
        value = bytes(secret)
        self.seen.append(value)
        return self.proofs[value]


class _RecordingTransport:
    def __init__(
        self,
        *,
        permission: str = "read_only",
        uid: str = "44705892343619584",
        main_uid: str = "44705892343619584",
    ) -> None:
        self.permission = permission
        self.uid = uid
        self.main_uid = main_uid
        self.calls: list[tuple[str, dict[str, str]]] = []

    def get(
        self,
        path: str,
        *,
        headers: Any,
    ) -> OkxHttpResponse:
        copied = dict(headers)
        self.calls.append((path, copied))
        if path == OKX_ACCOUNT_CONFIG_PATH:
            data = [
                {
                    "uid": self.uid,
                    "mainUid": self.main_uid,
                    "perm": self.permission,
                    "acctLv": "1",
                    "posMode": "net_mode",
                }
            ]
        elif path == OKX_ACCOUNT_BALANCE_PATH:
            data = [{"details": [{"ccy": "BTC"}, {"ccy": "USDT"}]}]
        else:
            raise AssertionError(f"unexpected path: {path}")
        body = json.dumps(
            {"code": "0", "msg": "", "data": data},
            separators=(",", ":"),
        ).encode()
        return OkxHttpResponse(
            200,
            (("Content-Type", "application/json"),),
            body,
        )


def test_okx_connector_signs_only_two_demo_read_paths() -> None:
    transport = _RecordingTransport()
    fixed = datetime(2026, 7, 23, 1, 2, 3, 456000, tzinfo=UTC)
    connector = OkxDemoReadOnlyConnector(
        transport=transport,
        clock=lambda: fixed,
    )
    secret = bytearray(
        encode_okx_demo_credential(
            api_key="ApiKey_123456",
            secret_key="Secret_123456",
            passphrase="Passphrase_123",
        )
    )
    proof = connector.discover(secret)

    assert [path for path, _headers in transport.calls] == [
        OKX_ACCOUNT_CONFIG_PATH,
        OKX_ACCOUNT_BALANCE_PATH,
    ]
    timestamp = "2026-07-23T01:02:03.456Z"
    expected_signature = base64.b64encode(
        hmac.digest(
            b"Secret_123456",
            f"{timestamp}GET{OKX_ACCOUNT_CONFIG_PATH}".encode("ascii"),
            hashlib.sha256,
        )
    ).decode("ascii")
    first_headers = transport.calls[0][1]
    assert first_headers["OK-ACCESS-SIGN"] == expected_signature
    assert first_headers["x-simulated-trading"] == "1"
    assert set(first_headers) == {
        "Accept",
        "OK-ACCESS-KEY",
        "OK-ACCESS-PASSPHRASE",
        "OK-ACCESS-SIGN",
        "OK-ACCESS-TIMESTAMP",
        "User-Agent",
        "x-simulated-trading",
    }
    expected_canonical = hashlib.sha256(
        b"okx\0demo\0spot\0"
        + b"44705892343619584"
        + b"\0"
        + b"44705892343619584"
    ).hexdigest()
    assert proof.canonical_account_sha256 == f"sha256:{expected_canonical}"
    assert proof.asset_count == 2
    assert proof.permission == "read_only"
    assert "ApiKey_123456" not in repr(proof)
    assert "Secret_123456" not in repr(proof)


@pytest.mark.parametrize(
    "permission",
    ["trade", "withdraw", "read_only,trade", "read_only,withdraw"],
)
def test_okx_connector_rejects_escalated_api_key_permissions(
    permission: str,
) -> None:
    connector = OkxDemoReadOnlyConnector(
        transport=_RecordingTransport(permission=permission),
        clock=lambda: datetime(2026, 7, 23, tzinfo=UTC),
    )
    secret = bytearray(
        encode_okx_demo_credential(
            api_key="ApiKey_123456",
            secret_key="Secret_123456",
            passphrase="Passphrase_123",
        )
    )
    with pytest.raises(LiveBrokerError) as captured:
        connector.discover(secret)
    assert captured.value.code == "LIVE_ACCOUNT_PERMISSION_REJECTED"
    assert "ApiKey_123456" not in str(captured.value)
    assert "Secret_123456" not in str(captured.value)


def test_okx_credential_parser_is_exact_and_redacted() -> None:
    encoded = encode_okx_demo_credential(
        api_key="ApiKey_123456",
        secret_key="Secret_123456",
        passphrase="Passphrase_123",
    )
    parsed = parse_okx_demo_credential(encoded)
    assert repr(parsed) == "OkxDemoCredential(<redacted>)"

    duplicate = (
        b'{"apiKey":"ApiKey_123456","apiKey":"OtherKey_123",'
        b'"environment":"demo","passphrase":"Passphrase_123",'
        b'"schemaVersion":1,"secretKey":"Secret_123456","venue":"okx"}'
    )
    with pytest.raises(LiveBrokerError) as captured:
        parse_okx_demo_credential(duplicate)
    assert captured.value.code == "LIVE_ACCOUNT_CREDENTIAL_INVALID"


def test_okx_transport_rejects_unpinned_path_headers_and_private_dns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = OkxPinnedHttpsTransport(
        resolver=lambda _host, _port: ("203.0.113.1",)
    )
    with pytest.raises(LiveBrokerError) as path_error:
        transport.get("/api/v5/trade/orders", headers={})
    assert path_error.value.code == "LIVE_ACCOUNT_PATH_DENIED"

    with pytest.raises(LiveBrokerError) as header_error:
        transport.get(OKX_ACCOUNT_CONFIG_PATH, headers={})
    assert header_error.value.code == "LIVE_ACCOUNT_HEADERS_DENIED"

    private_transport = OkxPinnedHttpsTransport(
        resolver=lambda _host, _port: ("127.0.0.1",)
    )
    with pytest.raises(LiveBrokerError) as injected_dns_error:
        private_transport.get(
            OKX_ACCOUNT_CONFIG_PATH,
            headers={
                "Accept": "application/json",
                "OK-ACCESS-KEY": "ApiKey_123456",
                "OK-ACCESS-PASSPHRASE": "Passphrase_123",
                "OK-ACCESS-SIGN": "signature",
                "OK-ACCESS-TIMESTAMP": "2026-07-23T01:02:03.000Z",
                "User-Agent": "CandleScope-Live-Broker/1",
                "x-simulated-trading": "1",
            },
        )
    assert injected_dns_error.value.code == "LIVE_ACCOUNT_DNS_REJECTED"

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))
        ],
    )
    with pytest.raises(LiveBrokerError) as dns_error:
        resolve_public_okx_addresses("openapi.okx.com", 443)
    assert dns_error.value.code == "LIVE_ACCOUNT_DNS_REJECTED"
    assert dns_error.value.fatal is True


def test_broker_state_migrates_v1_to_v2_atomically(tmp_path: Path) -> None:
    root = tmp_path / "state-migration"
    root.mkdir()
    path = root / "broker-state-v1.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "brokerId": "a" * 32,
                "vaultBackend": "fake",
                "policyEpoch": 0,
                "credentials": [],
                "pendingDeletes": [],
            }
        ),
        encoding="utf-8",
    )
    state = BrokerStateStore(
        root,
        vault_backend="fake",
        accounts_enabled=True,
    ).load_or_create()
    assert state.accounts == ()
    migrated = strict_json_loads(path.read_bytes(), max_message_bytes=1024 * 1024)
    assert migrated["schemaVersion"] == BROKER_STATE_SCHEMA_VERSION
    assert migrated["accounts"] == []


def test_feature_off_preserves_v1_state_schema(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    root = tmp_path / "feature-off-state"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_account_fixture.lock_path,
    )
    try:
        assert service.account_connector is None
    finally:
        service.close()
    state = strict_json_loads(
        (root / "broker-state-v1.json").read_bytes(),
        max_message_bytes=1024 * 1024,
    )
    assert state["schemaVersion"] == 1
    assert "accounts" not in state


def test_service_discovers_rebinds_revokes_and_hides_canonical_identity(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    connector = _FakeAccountConnector()
    connector.proofs[b"credential-one"] = _proof("main/one")
    connector.proofs[b"credential-two"] = _proof("main/one", asset_count=3)
    connector.proofs[b"credential-other"] = _proof("main/other")
    root = tmp_path / "service"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_account_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=connector,
    )
    session = "sess_" + "C" * 43

    def put(sequence: int, secret: bytes) -> str:
        response = service.handle(
            _request(
                sequence,
                session,
                METHOD_CREDENTIAL_PUT,
                0,
                {
                    "evidence": pinned_account_fixture.evidence.to_wire(),
                    "label": f"credential-{sequence}",
                    "secretBase64": base64.b64encode(secret).decode("ascii"),
                },
            )
        )
        assert response.result is not None
        return str(response.result["credentialHandle"])

    try:
        service.handle(_request(1, session, METHOD_BOOTSTRAP, 0))
        first = put(2, b"credential-one")
        discovered = service.handle(
            _request(
                3,
                session,
                METHOD_ACCOUNT_DISCOVER,
                0,
                {"credentialHandle": first},
            )
        )
        assert discovered.result is not None
        account_ref = str(discovered.result["accountRef"])
        assert account_ref.startswith("acct_")
        assert discovered.result["credentialGeneration"] == 1
        assert discovered.result["assetCount"] == 2

        described = service.handle(
            _request(
                4,
                session,
                METHOD_ACCOUNT_DESCRIBE,
                0,
                {"accountRef": account_ref},
            )
        )
        assert described.result is not None
        assert described.result["status"] == "active"

        with pytest.raises(LiveBrokerError) as duplicate:
            service.handle(
                _request(
                    5,
                    session,
                    METHOD_ACCOUNT_DISCOVER,
                    0,
                    {"credentialHandle": first},
                )
            )
        assert duplicate.value.code == "LIVE_ACCOUNT_ALREADY_BOUND"

        second = put(6, b"credential-two")
        rebound = service.handle(
            _request(
                7,
                session,
                METHOD_ACCOUNT_REBIND,
                0,
                {
                    "accountRef": account_ref,
                    "credentialHandle": second,
                },
            )
        )
        assert rebound.result is not None
        assert rebound.result["credentialGeneration"] == 2
        assert rebound.result["assetCount"] == 3

        other = put(8, b"credential-other")
        with pytest.raises(LiveBrokerError) as cross_account:
            service.handle(
                _request(
                    9,
                    session,
                    METHOD_ACCOUNT_REBIND,
                    0,
                    {
                        "accountRef": account_ref,
                        "credentialHandle": other,
                    },
                )
            )
        assert cross_account.value.code == "LIVE_ACCOUNT_REBIND_REJECTED"

        service.handle(
            _request(
                10,
                session,
                METHOD_CREDENTIAL_REVOKE,
                0,
                {"credentialHandle": second},
            )
        )
        revoked = service.handle(
            _request(
                11,
                session,
                METHOD_ACCOUNT_DESCRIBE,
                0,
                {"accountRef": account_ref},
            )
        )
        assert revoked.result is not None
        assert revoked.result["status"] == "credential-revoked"

        with pytest.raises(LiveBrokerError) as revoked_rebind:
            service.handle(
                _request(
                    12,
                    session,
                    METHOD_ACCOUNT_REBIND,
                    0,
                    {
                        "accountRef": account_ref,
                        "credentialHandle": second,
                    },
                )
            )
        assert revoked_rebind.value.code == "LIVE_ACCOUNT_CREDENTIAL_UNAVAILABLE"

        advanced = service.handle(
            _request(
                13,
                session,
                METHOD_POLICY_ADVANCE,
                0,
                {"nextEpoch": 1, "reason": "account-policy-revoke"},
            )
        )
        assert advanced.result is not None
        assert advanced.result["revokedAccountCount"] == 1
        assert service.state.accounts == ()

        with pytest.raises(LiveBrokerError) as stale_account:
            service.handle(
                _request(
                    14,
                    session,
                    METHOD_ACCOUNT_DESCRIBE,
                    1,
                    {"accountRef": account_ref},
                )
            )
        assert stale_account.value.code == "LIVE_ACCOUNT_NOT_FOUND"
    finally:
        service.close()

    state_bytes = (root / "broker-state-v1.json").read_bytes()
    for canary in (
        b"credential-one",
        b"credential-two",
        b"credential-other",
        b"main/one",
        b"main/other",
    ):
        assert canary not in state_bytes


def test_wp_c_state_downgrade_requires_confirmation_and_keeps_backup(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    connector = _FakeAccountConnector()
    connector.proofs[b"downgrade-credential"] = _proof("downgrade/account")
    root = tmp_path / "downgrade"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_account_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=connector,
    )
    session = "sess_" + "G" * 43
    try:
        service.handle(_request(1, session, METHOD_BOOTSTRAP, 0))
        put = service.handle(
            _request(
                2,
                session,
                METHOD_CREDENTIAL_PUT,
                0,
                {
                    "evidence": pinned_account_fixture.evidence.to_wire(),
                    "label": "downgrade credential",
                    "secretBase64": base64.b64encode(
                        b"downgrade-credential"
                    ).decode("ascii"),
                },
            )
        )
        assert put.result is not None
        service.handle(
            _request(
                3,
                session,
                METHOD_ACCOUNT_DISCOVER,
                0,
                {"credentialHandle": put.result["credentialHandle"]},
            )
        )
    finally:
        service.close()

    state_path = root / "broker-state-v1.json"
    before = state_path.read_bytes()
    backup = tmp_path / "backups" / "broker-state-v2.json"
    with pytest.raises(ValueError, match="explicit drop confirmation"):
        downgrade_live_broker_state(root, backup_path=backup)
    assert state_path.read_bytes() == before
    assert not backup.exists()

    result = downgrade_live_broker_state(
        root,
        backup_path=backup,
        confirm_drop_account_bindings=True,
    )
    assert result["droppedAccountBindingCount"] == 1
    assert result["retainedCredentialCount"] == 1
    assert backup.read_bytes() == before
    downgraded = strict_json_loads(
        state_path.read_bytes(),
        max_message_bytes=1024 * 1024,
    )
    assert downgraded["schemaVersion"] == 1
    assert "accounts" not in downgraded
    assert len(downgraded["credentials"]) == 1


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI is Windows-only")
def test_readonly_account_binding_survives_dpapi_service_restart(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    connector = _FakeAccountConnector()
    canary = b"CANDLESCOPE-WPC-DPAPI-RESTART-CANARY-20260723"
    connector.proofs[canary] = _proof("restart/account")
    root = tmp_path / "dpapi-account-restart"
    first_service = LiveBrokerService(
        root,
        vault_backend="windows-dpapi",
        release_lock_path=pinned_account_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=connector,
    )
    first_session = "sess_" + "H" * 43
    try:
        first_service.handle(_request(1, first_session, METHOD_BOOTSTRAP, 0))
        put = first_service.handle(
            _request(
                2,
                first_session,
                METHOD_CREDENTIAL_PUT,
                0,
                {
                    "evidence": pinned_account_fixture.evidence.to_wire(),
                    "label": "restart credential",
                    "secretBase64": base64.b64encode(canary).decode("ascii"),
                },
            )
        )
        assert put.result is not None
        discovered = first_service.handle(
            _request(
                3,
                first_session,
                METHOD_ACCOUNT_DISCOVER,
                0,
                {"credentialHandle": put.result["credentialHandle"]},
            )
        )
        assert discovered.result is not None
        account_ref = discovered.result["accountRef"]
    finally:
        first_service.close()

    reopened = LiveBrokerService(
        root,
        vault_backend="windows-dpapi",
        release_lock_path=pinned_account_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=connector,
    )
    second_session = "sess_" + "I" * 43
    try:
        reopened.handle(_request(1, second_session, METHOD_BOOTSTRAP, 0))
        described = reopened.handle(
            _request(
                2,
                second_session,
                METHOD_ACCOUNT_DESCRIBE,
                0,
                {"accountRef": account_ref},
            )
        )
        assert described.result is not None
        assert described.result["status"] == "active"
        assert described.result["credentialGeneration"] == 1
    finally:
        reopened.close()

    for path in root.rglob("*"):
        if path.is_file():
            assert canary not in path.read_bytes()


def test_account_methods_fail_closed_when_feature_is_disabled(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    service = LiveBrokerService(
        tmp_path / "disabled",
        vault_backend="fake",
        release_lock_path=pinned_account_fixture.lock_path,
    )
    session = "sess_" + "D" * 43
    try:
        service.handle(_request(1, session, METHOD_BOOTSTRAP, 0))
        with pytest.raises(LiveBrokerError) as captured:
            service.handle(
                _request(
                    2,
                    session,
                    METHOD_ACCOUNT_DISCOVER,
                    0,
                    {"credentialHandle": "cred_" + "A" * 43},
                )
            )
        assert captured.value.code == "LIVE_ACCOUNTS_DISABLED"
        assert service.account_connector is None
    finally:
        service.close()


def test_controller_starts_readonly_worker_without_network_until_discovery(
    tmp_path: Path,
    pinned_account_fixture: _PinnedAccountFixture,
) -> None:
    controller = LiveBrokerController(
        enabled=True,
        root=tmp_path / "controller",
        release_lock_path=pinned_account_fixture.lock_path,
        trust_store=pinned_account_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
    )

    async def scenario() -> None:
        await controller.start()
        health = await controller.health()
        assert health["readOnlyAccountsEnabled"] is True
        assert health["networkMethods"] == 2
        assert health["accountCount"] == 0
        await controller.stop()

    import asyncio

    asyncio.run(scenario())


def test_core_readonly_flag_requires_foundation_and_first_party(
    tmp_path: Path,
) -> None:
    common = {
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "platform"),
        PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV: "1",
    }
    with pytest.raises(CorePluginError) as foundation_error:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={**common, "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "local-trusted"},
        )
    assert foundation_error.value.code == "PLUGIN_LIVE_ACCOUNT_FOUNDATION_REQUIRED"

    with pytest.raises(CorePluginError) as trust_error:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={
                **common,
                PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "local-trusted",
            },
        )
    assert trust_error.value.code == "PLUGIN_LIVE_BROKER_TRUST_REQUIRED"

    platform = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="test",
        environ={
            **common,
            PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
        },
    )
    assert platform is not None
    assert platform.live_account_readonly_enabled is True
    assert platform.live_broker.read_only_accounts_enabled is True
