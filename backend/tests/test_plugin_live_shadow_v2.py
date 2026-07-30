from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.plugin_core_v2.bootstrap import (
    PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
    PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
    PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
    build_core_plugin_platform_from_environment,
)
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_installer_v2.registry import (
    ActivationRecord,
    EntrypointActivation,
)
from app.plugin_live_v2 import (
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    LiveBrokerController,
    LiveBrokerError,
    LivePublisherTrustStore,
    PublisherEvidence,
)
from app.plugin_live_v2.accounts import ReadOnlyAccountProof
from app.plugin_live_v2.errors import broker_error
from app.plugin_live_v2.journal import (
    SHADOW_JOURNAL_FILENAME,
    ShadowOrderJournal,
)
from app.plugin_live_v2.okx_readonly import (
    OKX_ORDER_QUERY_PATH,
    OkxDemoOrderQueryConnector,
    OkxHttpResponse,
    OkxPinnedHttpsTransport,
    build_okx_order_query_target,
    encode_okx_demo_credential,
)
from app.plugin_live_v2.protocol import (
    LIVE_BROKER_PROTOCOL_VERSION,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_BOOTSTRAP,
    METHOD_CREDENTIAL_PUT,
    METHOD_CREDENTIAL_REVOKE,
    METHOD_HEALTH,
    METHOD_POLICY_ADVANCE,
    METHOD_SHADOW_DESCRIBE,
    METHOD_SHADOW_PREPARE,
    METHOD_SHADOW_RECONCILE,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_live_v2.shadow import (
    OrderQueryProof,
    ShadowOrderIntent,
)
from scripts.downgrade_live_broker_state_v2_to_v1 import (
    downgrade_live_broker_state,
)
from tests.plugin_platform_bundle_testkit import (
    build_hello_platform_bundle,
)


@dataclass(frozen=True, slots=True)
class _PinnedShadowFixture:
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
        activation_id="live-shadow-test",
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


def _build_pinned_shadow_fixture(root: Path) -> _PinnedShadowFixture:
    bundle = build_hello_platform_bundle(root / "bundle").bundle
    identity = bundle.manifest.plugin
    lock_path = root / "live-release-lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "connectors": [
                    {
                        "connectorId": (
                            OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
                        ),
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
    return _PinnedShadowFixture(lock_path, trust, evidence)


@pytest.fixture(scope="module")
def pinned_shadow_fixture(
    tmp_path_factory: pytest.TempPathFactory,
) -> _PinnedShadowFixture:
    return _build_pinned_shadow_fixture(
        tmp_path_factory.mktemp("live-shadow-pinned")
    )


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


def _account_proof(identity: str) -> ReadOnlyAccountProof:
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
        asset_count=2,
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


class _FakeQueryConnector:
    connector_id = OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
    network_method_count = 1

    def __init__(
        self,
        *,
        state: str = "filled",
        error: BaseException | None = None,
        returned_client_order_id: str | None = None,
    ) -> None:
        self.state = state
        self.error = error
        self.returned_client_order_id = returned_client_order_id
        self.seen: list[tuple[bytes, str, str]] = []

    def query_order(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> OrderQueryProof:
        self.seen.append(
            (bytes(secret), instrument_id, client_order_id)
        )
        if self.error is not None:
            raise self.error
        return OrderQueryProof(
            connector_id=self.connector_id,
            instrument_id=instrument_id,
            client_order_id=(
                self.returned_client_order_id or client_order_id
            ),
            venue_order_id="123456789",
            state=self.state,
            accumulated_fill_size=(
                "0" if self.state == "live" else "1"
            ),
            average_price=(
                None if self.state == "live" else "42000"
            ),
            observed_at="2026-07-23T01:03:04.000Z",
        )


class _RecordingOrderTransport:
    def __init__(
        self,
        *,
        returned_client_order_id: str | None = None,
        code: str = "0",
        state: str = "partially_filled",
        accumulated_fill_size: str = "0.2500",
        average_price: str = "42000.00",
    ) -> None:
        self.returned_client_order_id = returned_client_order_id
        self.code = code
        self.state = state
        self.accumulated_fill_size = accumulated_fill_size
        self.average_price = average_price
        self.calls: list[tuple[str, dict[str, str]]] = []

    def get(
        self,
        target: str,
        *,
        headers: Any,
    ) -> OkxHttpResponse:
        self.calls.append((target, dict(headers)))
        match = re.fullmatch(
            re.escape(OKX_ORDER_QUERY_PATH)
            + r"\?instId=([A-Z0-9-]+)&clOrdId=([A-Za-z0-9]{32})",
            target,
        )
        if match is None:
            raise AssertionError(f"unexpected order query target: {target}")
        instrument_id, client_order_id = match.groups()
        data = (
            [
                {
                    "instId": instrument_id,
                    "clOrdId": (
                        self.returned_client_order_id
                        or client_order_id
                    ),
                    "ordId": "987654321",
                    "state": self.state,
                    "accFillSz": self.accumulated_fill_size,
                    "avgPx": self.average_price,
                }
            ]
            if self.code == "0"
            else []
        )
        body = json.dumps(
            {
                "code": self.code,
                "msg": "" if self.code == "0" else "Order does not exist",
                "data": data,
                "inTime": "1",
                "outTime": "2",
            },
            separators=(",", ":"),
        ).encode("ascii")
        return OkxHttpResponse(
            200,
            (("Content-Type", "application/json"),),
            body,
        )


def _bind_account(
    service: LiveBrokerService,
    *,
    fixture: _PinnedShadowFixture,
    session_id: str,
    secret: bytes,
    sequence: int = 1,
) -> tuple[str, str, int]:
    service.handle(
        _request(sequence, session_id, METHOD_BOOTSTRAP, 0)
    )
    put = service.handle(
        _request(
            sequence + 1,
            session_id,
            METHOD_CREDENTIAL_PUT,
            0,
            {
                "evidence": fixture.evidence.to_wire(),
                "label": "WP-D query-only credential",
                "secretBase64": base64.b64encode(secret).decode("ascii"),
            },
        )
    )
    assert put.result is not None
    discovered = service.handle(
        _request(
            sequence + 2,
            session_id,
            METHOD_ACCOUNT_DISCOVER,
            0,
            {"credentialHandle": put.result["credentialHandle"]},
        )
    )
    assert discovered.result is not None
    return (
        str(discovered.result["accountRef"]),
        str(put.result["credentialHandle"]),
        sequence + 3,
    )


def _intent(
    idempotency_key: str,
    *,
    quantity: str = "1",
) -> dict[str, str]:
    return {
        "idempotencyKey": idempotency_key,
        "instrumentId": "BTC-USDT",
        "side": "buy",
        "orderType": "limit",
        "quantity": quantity,
        "limitPrice": "42000",
    }


def _prepare(
    service: LiveBrokerService,
    *,
    sequence: int,
    session_id: str,
    account_ref: str,
    idempotency_key: str,
    quantity: str = "1",
) -> dict[str, Any]:
    response = service.handle(
        _request(
            sequence,
            session_id,
            METHOD_SHADOW_PREPARE,
            0,
            {
                "accountRef": account_ref,
                "intent": _intent(
                    idempotency_key,
                    quantity=quantity,
                ),
            },
        )
    )
    assert response.result is not None
    return response.result


def test_okx_query_connector_uses_one_exact_signed_demo_get() -> None:
    transport = _RecordingOrderTransport()
    fixed = datetime(2026, 7, 23, 1, 2, 3, 456000, tzinfo=UTC)
    connector = OkxDemoOrderQueryConnector(
        transport=transport,
        clock=lambda: fixed,
    )
    client_order_id = "CS" + "A" * 30
    credential = encode_okx_demo_credential(
        api_key="api-key-123",
        secret_key="secret-key-123",
        passphrase="passphrase-123",
    )

    proof = connector.query_order(
        bytearray(credential),
        instrument_id="BTC-USDT",
        client_order_id=client_order_id,
    )

    target = (
        f"{OKX_ORDER_QUERY_PATH}"
        f"?instId=BTC-USDT&clOrdId={client_order_id}"
    )
    assert len(transport.calls) == 1
    called_target, headers = transport.calls[0]
    assert called_target == target
    assert headers["x-simulated-trading"] == "1"
    expected_signature = base64.b64encode(
        hmac.digest(
            b"secret-key-123",
            (
                "2026-07-23T01:02:03.456Z"
                f"GET{target}"
            ).encode("ascii"),
            hashlib.sha256,
        )
    ).decode("ascii")
    assert headers["OK-ACCESS-SIGN"] == expected_signature
    assert proof.client_order_id == client_order_id
    assert proof.state == "partially_filled"
    assert proof.accumulated_fill_size == "0.25"
    assert proof.average_price == "42000"
    assert connector.network_method_count == 1


def test_okx_query_target_and_transport_fail_closed() -> None:
    client_order_id = "CS" + "B" * 30
    target = build_okx_order_query_target(
        "BTC-USDT",
        client_order_id,
    )
    assert target.endswith(f"clOrdId={client_order_id}")
    with pytest.raises(LiveBrokerError) as invalid_identity:
        build_okx_order_query_target("btc-usdt", client_order_id)
    assert invalid_identity.value.code == "LIVE_SHADOW_QUERY_PARAMS_INVALID"

    transport = OkxPinnedHttpsTransport(
        resolver=lambda _host, _port: ("127.0.0.1",)
    )
    headers = {
        "Accept": "application/json",
        "OK-ACCESS-KEY": "api-key-123",
        "OK-ACCESS-PASSPHRASE": "passphrase-123",
        "OK-ACCESS-SIGN": "signature",
        "OK-ACCESS-TIMESTAMP": "2026-07-23T01:02:03.456Z",
        "User-Agent": "CandleScope-Live-Broker/1",
        "x-simulated-trading": "1",
    }
    with pytest.raises(LiveBrokerError) as private_dns:
        transport.get(target, headers=headers)
    assert private_dns.value.code == "LIVE_ACCOUNT_DNS_REJECTED"
    assert private_dns.value.fatal is True

    with pytest.raises(LiveBrokerError) as extra_query:
        transport.get(f"{target}&ordId=1", headers=headers)
    assert extra_query.value.code == "LIVE_ACCOUNT_PATH_DENIED"
    assert extra_query.value.fatal is True


def test_okx_query_connector_rejects_unresolved_or_inconsistent_result() -> None:
    credential = bytearray(
        encode_okx_demo_credential(
            api_key="api-key-123",
            secret_key="secret-key-123",
            passphrase="passphrase-123",
        )
    )
    client_order_id = "CS" + "C" * 30
    unresolved = OkxDemoOrderQueryConnector(
        transport=_RecordingOrderTransport(code="51603")
    )
    with pytest.raises(LiveBrokerError) as missing:
        unresolved.query_order(
            credential,
            instrument_id="BTC-USDT",
            client_order_id=client_order_id,
        )
    assert missing.value.code == "LIVE_SHADOW_QUERY_UNRESOLVED"
    assert missing.value.details == {"venueCode": "51603"}

    inconsistent = OkxDemoOrderQueryConnector(
        transport=_RecordingOrderTransport(
            state="live",
            accumulated_fill_size="0.25",
            average_price="42000",
        )
    )
    with pytest.raises(LiveBrokerError) as malformed:
        inconsistent.query_order(
            credential,
            instrument_id="BTC-USDT",
            client_order_id=client_order_id,
        )
    assert malformed.value.code == "LIVE_SHADOW_QUERY_RESPONSE_INVALID"


def test_shadow_journal_is_idempotent_stable_terminal_and_redacted(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    secret = b"WP-D-SECRET-CANARY-20260723"
    idempotency_key = "intent_" + "D" * 43
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof("shadow/stable")
    query_connector = _FakeQueryConnector()
    root = tmp_path / "stable"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    session = "sess_" + "D" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    account = service.state.accounts[0]
    broker_id = service.state.broker_id
    try:
        first = _prepare(
            service,
            sequence=sequence,
            session_id=session,
            account_ref=account_ref,
            idempotency_key=idempotency_key,
        )
        second = _prepare(
            service,
            sequence=sequence + 1,
            session_id=session,
            account_ref=account_ref,
            idempotency_key=idempotency_key,
        )
        assert first == second
        assert first["state"] == "prepared"
        assert re.fullmatch(r"[A-Za-z0-9]{32}", first["clientOrderId"])
        assert first["clientOrderId"].startswith("CS")

        with pytest.raises(LiveBrokerError) as conflict:
            _prepare(
                service,
                sequence=sequence + 2,
                session_id=session,
                account_ref=account_ref,
                idempotency_key=idempotency_key,
                quantity="2",
            )
        assert conflict.value.code == "LIVE_SHADOW_IDEMPOTENCY_CONFLICT"

        reconciled = service.handle(
            _request(
                sequence + 3,
                session,
                METHOD_SHADOW_RECONCILE,
                0,
                {
                    "accountRef": account_ref,
                    "shadowRef": first["shadowRef"],
                },
            )
        )
        assert reconciled.result is not None
        assert reconciled.result["state"] == "filled"
        assert reconciled.result["reconcileAttemptCount"] == 1
        assert query_connector.seen == [
            (secret, "BTC-USDT", first["clientOrderId"])
        ]

        described = service.handle(
            _request(
                sequence + 4,
                session,
                METHOD_SHADOW_DESCRIBE,
                0,
                {"shadowRef": first["shadowRef"]},
            )
        )
        assert described.result == reconciled.result

        with pytest.raises(LiveBrokerError) as terminal:
            service.handle(
                _request(
                    sequence + 5,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": first["shadowRef"],
                    },
                )
            )
        assert terminal.value.code == "LIVE_SHADOW_RECONCILE_REJECTED"

        health = service.handle(
            _request(sequence + 6, session, METHOD_HEALTH, 0)
        )
        assert health.result is not None
        assert health.result["networkMethods"] == 3
        assert health.result["journalCount"] == 1
        assert health.result["unresolvedCount"] == 0
    finally:
        service.close()

    journal_path = root / SHADOW_JOURNAL_FILENAME
    journal_bytes = journal_path.read_bytes()
    for canary in (
        secret,
        account_ref.encode("ascii"),
        idempotency_key.encode("ascii"),
    ):
        assert canary not in journal_bytes

    reopened = ShadowOrderJournal(root, broker_id=broker_id)
    try:
        shadow_ref, record = reopened.prepare(
            account_ref=account_ref,
            account=account,
            intent=ShadowOrderIntent.from_wire(_intent(idempotency_key)),
            policy_epoch=0,
        )
        assert shadow_ref == first["shadowRef"]
        assert record.client_order_id == first["clientOrderId"]
        assert record.state == "filled"
        assert reopened.summary() == {
            "journalCount": 1,
            "unresolvedCount": 0,
        }
    finally:
        reopened.close()


@pytest.mark.parametrize(
    ("query_connector", "expected_code"),
    [
        (
            _FakeQueryConnector(
                error=broker_error(
                    "LIVE_SHADOW_QUERY_UNRESOLVED",
                    "query was inconclusive",
                )
            ),
            "LIVE_SHADOW_QUERY_UNRESOLVED",
        ),
        (
            _FakeQueryConnector(
                returned_client_order_id="X" * 32,
            ),
            "LIVE_SHADOW_QUERY_MISMATCH",
        ),
    ],
)
def test_query_failure_or_identity_mismatch_stays_unknown(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
    query_connector: _FakeQueryConnector,
    expected_code: str,
) -> None:
    secret = expected_code.encode("ascii")
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof(expected_code)
    service = LiveBrokerService(
        tmp_path / expected_code.casefold(),
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    session = "sess_" + ("E" if expected_code.endswith("UNRESOLVED") else "F") * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    try:
        prepared = _prepare(
            service,
            sequence=sequence,
            session_id=session,
            account_ref=account_ref,
            idempotency_key=(
                "intent_"
                + (
                    "E"
                    if expected_code.endswith("UNRESOLVED")
                    else "F"
                )
                * 43
            ),
        )
        with pytest.raises(LiveBrokerError) as captured:
            service.handle(
                _request(
                    sequence + 1,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
        assert captured.value.code == expected_code

        described = service.handle(
            _request(
                sequence + 2,
                session,
                METHOD_SHADOW_DESCRIBE,
                0,
                {"shadowRef": prepared["shadowRef"]},
            )
        )
        assert described.result is not None
        assert described.result["state"] == "unknown"
        assert described.result["reconcileAttemptCount"] == 1
        if expected_code == "LIVE_SHADOW_QUERY_UNRESOLVED":
            query_connector.error = None
            query_connector.state = "live"
            retried = service.handle(
                _request(
                    sequence + 3,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
            assert retried.result is not None
            assert retried.result["state"] == "live"
            assert retried.result["reconcileAttemptCount"] == 2
    finally:
        service.close()


class _SimulatedWorkerCrash(BaseException):
    pass


def test_interrupted_query_recovers_to_unknown_on_reopen(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    secret = b"WP-D-CRASH-CANARY"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof("shadow/crash")
    query_connector = _FakeQueryConnector(
        error=_SimulatedWorkerCrash("simulated process exit")
    )
    root = tmp_path / "crash-recovery"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    session = "sess_" + "G" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    prepared = _prepare(
        service,
        sequence=sequence,
        session_id=session,
        account_ref=account_ref,
        idempotency_key="intent_" + "G" * 43,
    )
    broker_id = service.state.broker_id
    try:
        with pytest.raises(_SimulatedWorkerCrash):
            service.handle(
                _request(
                    sequence + 1,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
        assert service.shadow_journal is not None
        assert (
            service.shadow_journal.describe(prepared["shadowRef"]).state
            == "querying"
        )
    finally:
        service.close()

    reopened = ShadowOrderJournal(root, broker_id=broker_id)
    try:
        recovered = reopened.describe(prepared["shadowRef"])
        assert recovered.state == "unknown"
        assert recovered.reconcile_attempt_count == 1
        event_types = [
            row["event_type"]
            for row in reopened.connection.execute(
                "SELECT event_type FROM journal_event ORDER BY sequence"
            )
        ]
        assert event_types == [
            "prepared",
            "reconcile-started",
            "reconcile-recovered-unknown",
        ]
    finally:
        reopened.close()


def test_response_received_before_persist_crash_recovers_to_unknown(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = b"WP-D-POST-RESPONSE-CRASH"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof(
        "shadow/post-response"
    )
    query_connector = _FakeQueryConnector(state="live")
    root = tmp_path / "post-response-crash"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    session = "sess_" + "M" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    prepared = _prepare(
        service,
        sequence=sequence,
        session_id=session,
        account_ref=account_ref,
        idempotency_key="intent_" + "M" * 43,
    )
    broker_id = service.state.broker_id
    journal = service.shadow_journal
    assert journal is not None

    def crash_before_persist(
        _shadow_ref: str,
        _proof: OrderQueryProof,
    ) -> Any:
        raise _SimulatedWorkerCrash("post-response persistence crash")

    monkeypatch.setattr(
        journal,
        "complete_reconcile",
        crash_before_persist,
    )
    try:
        with pytest.raises(_SimulatedWorkerCrash):
            service.handle(
                _request(
                    sequence + 1,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
        assert len(query_connector.seen) == 1
        assert journal.describe(prepared["shadowRef"]).state == "querying"
    finally:
        service.close()
        monkeypatch.undo()

    reopened = ShadowOrderJournal(root, broker_id=broker_id)
    try:
        recovered = reopened.describe(prepared["shadowRef"])
        assert recovered.state == "unknown"
        assert recovered.venue_order_id is None
        assert recovered.reconcile_attempt_count == 1
    finally:
        reopened.close()


def test_journal_rejects_hash_chain_and_schema_tampering(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    hash_root = tmp_path / "hash-tamper"
    secret = b"WP-D-HASH-TAMPER"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof("shadow/hash-tamper")
    service = LiveBrokerService(
        hash_root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=_FakeQueryConnector(),
    )
    session = "sess_" + "L" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    broker_id = service.state.broker_id
    _prepare(
        service,
        sequence=sequence,
        session_id=session,
        account_ref=account_ref,
        idempotency_key="intent_" + "L" * 43,
    )
    service.close()

    connection = sqlite3.connect(hash_root / SHADOW_JOURNAL_FILENAME)
    original_payload = connection.execute(
        "SELECT payload_json FROM journal_event WHERE sequence = 1"
    ).fetchone()[0]
    connection.execute(
        "UPDATE journal_event SET payload_json = '{}' WHERE sequence = 1"
    )
    connection.commit()
    connection.close()
    with pytest.raises(LiveBrokerError) as hash_error:
        ShadowOrderJournal(hash_root, broker_id=broker_id)
    assert hash_error.value.code == "LIVE_SHADOW_JOURNAL_INVALID"
    assert hash_error.value.fatal is True

    connection = sqlite3.connect(hash_root / SHADOW_JOURNAL_FILENAME)
    connection.execute(
        "UPDATE journal_event SET payload_json = ? WHERE sequence = 1",
        (original_payload,),
    )
    connection.execute(
        """
        UPDATE shadow_order
        SET accumulated_fill_size = '2', average_price = '42000'
        """
    )
    connection.commit()
    connection.close()
    with pytest.raises(LiveBrokerError) as projection_error:
        ShadowOrderJournal(hash_root, broker_id=broker_id)
    assert projection_error.value.code == "LIVE_SHADOW_JOURNAL_INVALID"

    schema_root = tmp_path / "schema-tamper"
    journal = ShadowOrderJournal(schema_root, broker_id="a" * 32)
    journal.close()
    connection = sqlite3.connect(
        schema_root / SHADOW_JOURNAL_FILENAME
    )
    connection.execute("PRAGMA user_version=2")
    connection.commit()
    connection.close()
    with pytest.raises(LiveBrokerError) as schema_error:
        ShadowOrderJournal(schema_root, broker_id="a" * 32)
    assert schema_error.value.code == "LIVE_SHADOW_JOURNAL_INVALID"
    assert schema_error.value.fatal is True

    unsafe_root = tmp_path / "unsafe-sidecar"
    unsafe_root.mkdir()
    (unsafe_root / f"{SHADOW_JOURNAL_FILENAME}-wal").mkdir()
    with pytest.raises(LiveBrokerError) as unsafe_error:
        ShadowOrderJournal(unsafe_root, broker_id="a" * 32)
    assert unsafe_error.value.code == "LIVE_SHADOW_JOURNAL_PATH_UNSAFE"
    assert unsafe_error.value.fatal is True


def test_feature_off_preserves_wp_c_and_downgrade_refuses_wp_d_journal(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    account_connector = _FakeAccountConnector()
    wp_c_root = tmp_path / "wp-c-only"
    service = LiveBrokerService(
        wp_c_root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
    )
    session = "sess_" + "H" * 43
    try:
        service.handle(_request(1, session, METHOD_BOOTSTRAP, 0))
        health = service.handle(_request(2, session, METHOD_HEALTH, 0))
        assert health.result is not None
        assert health.result["networkMethods"] == 2
        assert health.result["reconciliationShadowEnabled"] is False
        assert health.result["journalCount"] == 0
        assert service.reconciliation_connector is None
        assert service.shadow_journal is None
        with pytest.raises(LiveBrokerError) as disabled:
            service.handle(
                _request(
                    3,
                    session,
                    METHOD_SHADOW_PREPARE,
                    0,
                    {},
                )
            )
        assert (
            disabled.value.code
            == "LIVE_RECONCILIATION_SHADOW_DISABLED"
        )
    finally:
        service.close()
    assert not (wp_c_root / SHADOW_JOURNAL_FILENAME).exists()

    wp_d_root = tmp_path / "wp-d"
    enabled = LiveBrokerService(
        wp_d_root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=_FakeAccountConnector(),
        reconciliation_shadow_enabled=True,
        reconciliation_connector=_FakeQueryConnector(),
    )
    enabled.close()
    backup = tmp_path / "backup" / "broker-state-v2.json"
    with pytest.raises(ValueError, match="must be archived"):
        downgrade_live_broker_state(
            wp_d_root,
            backup_path=backup,
            confirm_drop_account_bindings=True,
        )
    assert not backup.exists()
    assert (wp_d_root / SHADOW_JOURNAL_FILENAME).exists()


def test_shadow_rejects_cross_account_revoked_credential_and_stale_epoch(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    first_secret = b"WP-D-FIRST-ACCOUNT"
    second_secret = b"WP-D-SECOND-ACCOUNT"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[first_secret] = _account_proof("first")
    account_connector.proofs[second_secret] = _account_proof("second")
    service = LiveBrokerService(
        tmp_path / "binding-gates",
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=_FakeQueryConnector(state="live"),
    )
    session = "sess_" + "I" * 43
    first_ref, first_credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=first_secret,
    )
    try:
        second_put = service.handle(
            _request(
                sequence,
                session,
                METHOD_CREDENTIAL_PUT,
                0,
                {
                    "evidence": pinned_shadow_fixture.evidence.to_wire(),
                    "label": "second account",
                    "secretBase64": base64.b64encode(
                        second_secret
                    ).decode("ascii"),
                },
            )
        )
        assert second_put.result is not None
        second_discovered = service.handle(
            _request(
                sequence + 1,
                session,
                METHOD_ACCOUNT_DISCOVER,
                0,
                {
                    "credentialHandle": second_put.result[
                        "credentialHandle"
                    ]
                },
            )
        )
        assert second_discovered.result is not None
        second_ref = second_discovered.result["accountRef"]
        prepared = _prepare(
            service,
            sequence=sequence + 2,
            session_id=session,
            account_ref=first_ref,
            idempotency_key="intent_" + "I" * 43,
        )

        with pytest.raises(LiveBrokerError) as cross_account:
            service.handle(
                _request(
                    sequence + 3,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": second_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
        assert cross_account.value.code == "LIVE_SHADOW_ACCOUNT_MISMATCH"

        service.handle(
            _request(
                sequence + 4,
                session,
                METHOD_CREDENTIAL_REVOKE,
                0,
                {"credentialHandle": first_credential_ref},
            )
        )
        with pytest.raises(LiveBrokerError) as revoked:
            service.handle(
                _request(
                    sequence + 5,
                    session,
                    METHOD_SHADOW_RECONCILE,
                    0,
                    {
                        "accountRef": first_ref,
                        "shadowRef": prepared["shadowRef"],
                    },
                )
            )
        assert revoked.value.code == "LIVE_SHADOW_ACCOUNT_UNAVAILABLE"

        service.handle(
            _request(
                sequence + 6,
                session,
                METHOD_POLICY_ADVANCE,
                0,
                {"nextEpoch": 1, "reason": "WP-D stale epoch gate"},
            )
        )
        with pytest.raises(LiveBrokerError) as stale:
            service.handle(
                _request(
                    sequence + 7,
                    session,
                    METHOD_SHADOW_DESCRIBE,
                    0,
                    {"shadowRef": prepared["shadowRef"]},
                )
            )
        assert stale.value.code == "LIVE_BROKER_POLICY_EPOCH_REJECTED"
    finally:
        service.close()


def test_core_shadow_flag_requires_wp_c_foundation_and_pinned_trust(
    tmp_path: Path,
) -> None:
    base = {
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "platform"),
        PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV: "1",
    }
    with pytest.raises(CorePluginError) as account_error:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={
                **base,
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": (
                    "first-party-pinned"
                ),
            },
        )
    assert account_error.value.code == "PLUGIN_LIVE_SHADOW_ACCOUNT_REQUIRED"

    with pytest.raises(CorePluginError) as foundation_error:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={
                **base,
                PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV: "1",
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": (
                    "first-party-pinned"
                ),
            },
        )
    assert (
        foundation_error.value.code
        == "PLUGIN_LIVE_ACCOUNT_FOUNDATION_REQUIRED"
    )

    all_flags = {
        **base,
        PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
    }
    with pytest.raises(CorePluginError) as trust_error:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={
                **all_flags,
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "local-trusted",
            },
        )
    assert trust_error.value.code == "PLUGIN_LIVE_BROKER_TRUST_REQUIRED"

    platform = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="test",
        environ={
            **all_flags,
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
        },
    )
    assert platform.live_reconciliation_shadow_enabled is True
    assert platform.live_broker.reconciliation_shadow_enabled is True
    assert platform.live_broker.status()["networkMethods"] == 3


def test_controller_starts_shadow_worker_without_network_io(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    root = tmp_path / "controller"
    controller = LiveBrokerController(
        enabled=True,
        root=root,
        release_lock_path=pinned_shadow_fixture.lock_path,
        trust_store=pinned_shadow_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
    )

    async def scenario() -> None:
        await controller.start()
        health = await controller.health()
        assert health["readOnlyAccountsEnabled"] is True
        assert health["reconciliationShadowEnabled"] is True
        assert health["networkMethods"] == 3
        assert health["journalCount"] == 0
        assert health["unresolvedCount"] == 0
        await controller.stop()

    asyncio.run(scenario())
    assert (root / SHADOW_JOURNAL_FILENAME).exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI is Windows-only")
def test_shadow_journal_and_binding_survive_dpapi_restart(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    secret = b"WP-D-DPAPI-RESTART-CANARY-20260723"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof("shadow/restart")
    query_connector = _FakeQueryConnector(state="live")
    root = tmp_path / "dpapi-restart"
    first = LiveBrokerService(
        root,
        vault_backend="windows-dpapi",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    first_session = "sess_" + "J" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        first,
        fixture=pinned_shadow_fixture,
        session_id=first_session,
        secret=secret,
    )
    prepared = _prepare(
        first,
        sequence=sequence,
        session_id=first_session,
        account_ref=account_ref,
        idempotency_key="intent_" + "J" * 43,
    )
    first.close()

    reopened = LiveBrokerService(
        root,
        vault_backend="windows-dpapi",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query_connector,
    )
    second_session = "sess_" + "K" * 43
    try:
        bootstrap = reopened.handle(
            _request(1, second_session, METHOD_BOOTSTRAP, 0)
        )
        assert bootstrap.result is not None
        assert bootstrap.result["journalCount"] == 1
        described = reopened.handle(
            _request(
                2,
                second_session,
                METHOD_SHADOW_DESCRIBE,
                0,
                {"shadowRef": prepared["shadowRef"]},
            )
        )
        assert described.result is not None
        assert described.result["clientOrderId"] == prepared["clientOrderId"]
        reconciled = reopened.handle(
            _request(
                3,
                second_session,
                METHOD_SHADOW_RECONCILE,
                0,
                {
                    "accountRef": account_ref,
                    "shadowRef": prepared["shadowRef"],
                },
            )
        )
        assert reconciled.result is not None
        assert reconciled.result["state"] == "live"
    finally:
        reopened.close()

    for path in root.rglob("*"):
        if path.is_file():
            assert secret not in path.read_bytes()
