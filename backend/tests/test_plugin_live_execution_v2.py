from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import httpx
from fastapi import FastAPI

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.bootstrap import (
    PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
    PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
    PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV,
    PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
    PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV,
    build_core_plugin_platform_from_environment,
)
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2.registry import (
    ActivationRecord,
    EntrypointActivation,
)
from app.plugin_live_v2 import (
    LIVE_BROKER_METHODS,
    LIVE_EXECUTION_FILENAME,
    OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
    LiveBrokerController,
    LiveBrokerError,
    LiveExecutionLedger,
    LivePublisherTrustStore,
    PublisherEvidence,
    verify_live_audit_export,
)
from app.plugin_live_v2.accounts import ReadOnlyAccountProof
from app.plugin_live_v2.errors import broker_error
from app.plugin_live_v2.execution import (
    ExecutionMutationProof,
    execution_risk_decision,
)
from app.plugin_live_v2.okx_execution import (
    MAX_SUBMIT_EXPIRY_SECONDS,
    OkxDemoSpotExecutionConnector,
)
from app.plugin_live_v2.okx_readonly import (
    OKX_ORDER_CANCEL_PATH,
    OKX_ORDER_SUBMIT_PATH,
    OkxHttpResponse,
    encode_okx_demo_credential,
)
from app.plugin_live_v2.protocol import (
    LIVE_BROKER_PROTOCOL_VERSION,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_AUDIT_EXPORT_PAGE,
    METHOD_BOOTSTRAP,
    METHOD_CONFIRMATION_ISSUE,
    METHOD_CONFIRMATION_PREVIEW,
    METHOD_CONTROL_KILL,
    METHOD_CONTROL_SET,
    METHOD_CREDENTIAL_PUT,
    METHOD_EXECUTION_CANCEL,
    METHOD_EXECUTION_RECONCILE,
    METHOD_EXECUTION_SUBMIT,
    METHOD_SHADOW_PREPARE,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_live_v2.shadow import (
    OrderQueryProof,
    ShadowOrderIntent,
)
from app.plugin_security_v2.management import LocalManagementGuard
from scripts.archive_live_execution_v1 import (
    archive_live_execution_ledger,
)
from tests.plugin_platform_bundle_testkit import (
    build_hello_platform_bundle,
)


@dataclass(frozen=True, slots=True)
class _PinnedExecutionFixture:
    lock_path: Path
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
        activation_id="live-execution-test",
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


def _build_fixture(root: Path) -> _PinnedExecutionFixture:
    bundle = build_hello_platform_bundle(root / "bundle").bundle
    identity = bundle.manifest.plugin
    lock_path = root / "live-release-lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "connectors": [
                    {
                        "connectorId": (OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID),
                        "pluginId": identity.id,
                        "version": identity.version,
                        "publisher": identity.publisher,
                        "bundleSha256": bundle.sha256,
                        "manifestSha256": bundle.manifest_sha256,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    trust = LivePublisherTrustStore.from_path(lock_path)
    evidence = trust.issue_for_verified_activation(
        _activation(bundle, root),
        bundle,
        connector_id=OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
        trust_level="first-party-pinned",
    )
    return _PinnedExecutionFixture(lock_path, evidence)


@pytest.fixture(scope="module")
def pinned_execution_fixture(
    tmp_path_factory: pytest.TempPathFactory,
) -> _PinnedExecutionFixture:
    return _build_fixture(tmp_path_factory.mktemp("live-execution-pinned"))


def _request(
    sequence: int,
    session_id: str,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    policy_epoch: int = 0,
) -> dict[str, Any]:
    return {
        "protocolVersion": LIVE_BROKER_PROTOCOL_VERSION,
        "sequence": sequence,
        "sessionId": session_id,
        "method": method,
        "policyEpoch": policy_epoch,
        "params": dict(params or {}),
    }


class _FakeExecutionAccountConnector:
    connector_id = OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
    network_method_count = 2

    def __init__(self, secret: bytes) -> None:
        self.secret = secret
        self.calls = 0

    def discover(self, secret: bytearray) -> ReadOnlyAccountProof:
        assert bytes(secret) == self.secret
        self.calls += 1
        return ReadOnlyAccountProof(
            connector_id=self.connector_id,
            venue="okx",
            environment="demo",
            product_scope="spot",
            canonical_account_sha256="sha256:" + "a" * 64,
            permission="read_trade",
            account_mode="spot",
            position_mode="net_mode",
            asset_count=2,
            observed_at="2026-07-23T01:02:03.000Z",
        )


class _FakeExecutionQueryConnector:
    connector_id = OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
    network_method_count = 1

    def __init__(self, states: list[str]) -> None:
        self.states = list(states)
        self.calls: list[tuple[bytes, str, str]] = []

    def query_order(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> OrderQueryProof:
        self.calls.append((bytes(secret), instrument_id, client_order_id))
        state = self.states.pop(0)
        return OrderQueryProof(
            connector_id=self.connector_id,
            instrument_id=instrument_id,
            client_order_id=client_order_id,
            venue_order_id="123456789",
            state=state,
            accumulated_fill_size=("0.0002" if state == "partially_filled" else "0"),
            average_price=("42000" if state == "partially_filled" else None),
            observed_at="2026-07-23T01:03:04.000Z",
        )


class _FakeExecutionConnector:
    connector_id = OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
    network_method_count = 2

    def __init__(
        self,
        *,
        submit_error: LiveBrokerError | None = None,
    ) -> None:
        self.submit_error = submit_error
        self.submit_calls: list[tuple[bytes, ShadowOrderIntent, str]] = []
        self.cancel_calls: list[tuple[bytes, str, str]] = []

    def submit(
        self,
        secret: bytearray,
        *,
        intent: ShadowOrderIntent,
        client_order_id: str,
    ) -> ExecutionMutationProof:
        self.submit_calls.append((bytes(secret), intent, client_order_id))
        if self.submit_error is not None:
            raise self.submit_error
        return ExecutionMutationProof(
            action="submit",
            accepted=True,
            instrument_id=intent.instrument_id,
            client_order_id=client_order_id,
            venue_order_id="123456789",
            venue_code="0",
            observed_at="2026-07-23T01:02:04.000Z",
        )

    def cancel(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> ExecutionMutationProof:
        self.cancel_calls.append((bytes(secret), instrument_id, client_order_id))
        return ExecutionMutationProof(
            action="cancel",
            accepted=True,
            instrument_id=instrument_id,
            client_order_id=client_order_id,
            venue_order_id="123456789",
            venue_code="0",
            observed_at="2026-07-23T01:04:04.000Z",
        )


class _RecordingPostTransport:
    def __init__(
        self,
        *,
        envelope_code: str = "0",
        item_code: str = "0",
    ) -> None:
        self.calls: list[tuple[str, dict[str, str], bytes]] = []
        self.envelope_code = envelope_code
        self.item_code = item_code

    def post(
        self,
        target: str,
        *,
        headers: Any,
        body: bytes,
    ) -> OkxHttpResponse:
        copied = dict(headers)
        self.calls.append((target, copied, body))
        request = json.loads(body)
        response = {
            "code": self.envelope_code,
            "msg": "",
            "data": (
                [
                    {
                        "ordId": ("123456789" if self.item_code == "0" else ""),
                        "clOrdId": request["clOrdId"],
                        "sCode": self.item_code,
                        "sMsg": ("" if self.item_code == "0" else "request timeout"),
                        "ts": "1784768524000",
                    }
                ]
                if self.envelope_code == "0"
                else []
            ),
            "inTime": "1784768524000000",
            "outTime": "1784768524000100",
        }
        return OkxHttpResponse(
            200,
            (("Content-Type", "application/json"),),
            json.dumps(response, separators=(",", ":")).encode("ascii"),
        )


def _credential() -> bytearray:
    return bytearray(
        encode_okx_demo_credential(
            api_key="demo-key",
            secret_key="demo-secret",
            passphrase="demo-passphrase",
        )
    )


def test_wp_f_protocol_is_demo_execution_only() -> None:
    assert {
        "execution.describe",
        "execution.submit",
        "execution.cancel",
        "execution.reconcile",
    }.issubset(LIVE_BROKER_METHODS)
    assert {
        "execution.amend",
        "execution.batch",
        "funds.transfer",
        "funds.withdraw",
        "network.request",
    }.isdisjoint(LIVE_BROKER_METHODS)


def test_wp_f_adds_no_plugin_sdk_or_iframe_execution_surface() -> None:
    repository = Path(__file__).resolve().parents[2]
    sdk_source = repository / "packages" / "candlescope-plugin-sdk" / "src"
    sdk_text = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(sdk_source.rglob("*.py"))
    )
    sandbox_bridge = (
        repository
        / "frontend"
        / "src"
        / "features"
        / "plugins"
        / "pluginSandboxBridge.ts"
    ).read_text(encoding="utf-8")
    for forbidden in (
        OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
        "execution.submit",
        "execution.cancel",
        "/manage/live/execution",
    ):
        assert forbidden not in sdk_text
        assert forbidden not in sandbox_bridge


def test_wp_f_flag_requires_wp_e_and_first_party_pinned_trust(
    tmp_path: Path,
) -> None:
    base = {
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "platform"),
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
        PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV: "1",
    }
    with pytest.raises(CorePluginError) as missing_control:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ=base,
        )
    assert missing_control.value.code == "PLUGIN_LIVE_EXECUTION_CONTROL_REQUIRED"
    all_flags = {
        **base,
        PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV: "1",
    }
    with pytest.raises(CorePluginError) as trust:
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="test",
            environ={
                **all_flags,
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "local-trusted",
            },
        )
    assert trust.value.code == "PLUGIN_LIVE_BROKER_TRUST_REQUIRED"
    platform = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="test",
        environ=all_flags,
    )
    assert isinstance(platform, CorePluginPlatform)
    assert platform.live_testnet_execution_enabled is True
    assert platform.live_broker.testnet_execution_enabled is True


def test_worker_bootstrap_opens_execution_only_under_exact_flag(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    root = tmp_path / "execution-worker"
    controller = LiveBrokerController(
        enabled=True,
        root=root,
        release_lock_path=pinned_execution_fixture.lock_path,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
        native_control_enabled=True,
        testnet_execution_enabled=True,
    )

    async def scenario() -> None:
        await controller.start()
        try:
            health = await controller.health()
            assert health["testnetExecutionEnabled"] is True
            assert health["networkMethods"] == 5
            assert health["executionCount"] == 0
            assert health["executionUnresolvedCount"] == 0
            status = await controller.control_status()
            assert status["liveSubmitAvailable"] is True
            assert status["liveCancelAvailable"] is True
            assert status["liveTransferAvailable"] is False
            exported = await controller.export_audit()
            assert exported["schemaVersion"] == ("candlescope.live-audit-export/2")
            assert exported["liveMutationMethodsAvailable"] is True
            assert exported["executionHead"] == {
                "sequence": 0,
                "sha256": None,
            }
        finally:
            await controller.stop()

    asyncio.run(scenario())
    assert (root / LIVE_EXECUTION_FILENAME).is_file()


def test_okx_demo_connector_signs_exact_submit_and_cancel_contract() -> None:
    transport = _RecordingPostTransport()
    moment = datetime(2026, 7, 23, 1, 2, 3, tzinfo=UTC)
    connector = OkxDemoSpotExecutionConnector(
        transport=transport,
        clock=lambda: moment,
    )
    client_order_id = "A" * 32
    secret = _credential()
    intent = ShadowOrderIntent(
        idempotency_key="intent_" + "B" * 43,
        instrument_id="BTC-USDT",
        side="buy",
        order_type="limit",
        quantity="0.001",
        limit_price="42000",
    )
    submitted = connector.submit(
        secret,
        intent=intent,
        client_order_id=client_order_id,
    )
    canceled = connector.cancel(
        secret,
        instrument_id="BTC-USDT",
        client_order_id=client_order_id,
    )
    assert submitted.accepted is True
    assert canceled.accepted is True
    assert [call[0] for call in transport.calls] == [
        OKX_ORDER_SUBMIT_PATH,
        OKX_ORDER_CANCEL_PATH,
    ]
    submit_target, submit_headers, submit_body = transport.calls[0]
    assert submit_target == OKX_ORDER_SUBMIT_PATH
    assert submit_headers["x-simulated-trading"] == "1"
    assert (
        int(submit_headers["expTime"])
        == int(moment.timestamp() * 1000) + MAX_SUBMIT_EXPIRY_SECONDS * 1000
    )
    expected_signature = base64.b64encode(
        hmac.digest(
            b"demo-secret",
            (
                submit_headers["OK-ACCESS-TIMESTAMP"].encode("ascii")
                + b"POST"
                + OKX_ORDER_SUBMIT_PATH.encode("ascii")
                + submit_body
            ),
            hashlib.sha256,
        )
    ).decode("ascii")
    assert submit_headers["OK-ACCESS-SIGN"] == expected_signature
    assert json.loads(submit_body) == {
        "clOrdId": client_order_id,
        "instId": "BTC-USDT",
        "ordType": "limit",
        "px": "42000",
        "side": "buy",
        "sz": "0.001",
        "tdMode": "cash",
    }
    _, cancel_headers, cancel_body = transport.calls[1]
    assert "expTime" not in cancel_headers
    assert json.loads(cancel_body) == {
        "clOrdId": client_order_id,
        "instId": "BTC-USDT",
    }


@pytest.mark.parametrize(
    ("envelope_code", "item_code"),
    [
        ("50004", "0"),
        ("0", "50004"),
    ],
)
def test_okx_demo_timeout_code_is_never_terminal_rejection(
    envelope_code: str,
    item_code: str,
) -> None:
    connector = OkxDemoSpotExecutionConnector(
        transport=_RecordingPostTransport(
            envelope_code=envelope_code,
            item_code=item_code,
        ),
        clock=lambda: datetime(2026, 7, 23, 1, 2, 3, tzinfo=UTC),
    )
    intent = ShadowOrderIntent(
        idempotency_key="intent_" + "B" * 43,
        instrument_id="BTC-USDT",
        side="buy",
        order_type="limit",
        quantity="0.001",
        limit_price="42000",
    )
    with pytest.raises(LiveBrokerError) as unknown:
        connector.submit(
            _credential(),
            intent=intent,
            client_order_id="A" * 32,
        )
    assert unknown.value.code == "LIVE_EXECUTION_RESULT_UNKNOWN"


@pytest.mark.parametrize(
    ("quantity", "price", "unresolved_count", "unresolved_notional"),
    [
        ("0.003", "42000", 0, "0"),
        ("0.001", "42000", 2, "0"),
        ("0.001", "42000", 1, "170"),
    ],
)
def test_demo_risk_envelope_rejects_each_hard_cap(
    quantity: str,
    price: str,
    unresolved_count: int,
    unresolved_notional: str,
) -> None:
    with pytest.raises(LiveBrokerError) as rejected:
        execution_risk_decision(
            instrument_id="BTC-USDT",
            side="buy",
            order_type="limit",
            quantity=quantity,
            limit_price=price,
            unresolved_count=unresolved_count,
            unresolved_notional=Decimal(unresolved_notional),
        )
    assert rejected.value.code == "LIVE_EXECUTION_RISK_REJECTED"


def _execution_metadata() -> dict[str, Any]:
    return {
        "canonicalAccountSha256": "sha256:" + "a" * 64,
        "credentialHandleSha256": "sha256:" + "b" * 64,
        "pluginId": "com.test.plugin",
        "connectorId": OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
        "publisherIdentity": "publisher:test",
        "version": "1.0.0",
        "clientOrderId": "C" * 32,
        "orderIntentSha256": "sha256:" + "d" * 64,
        "instrumentId": "BTC-USDT",
        "side": "buy",
        "orderType": "limit",
        "quantity": "0.001",
        "limitPrice": "42000",
        "policyEpoch": 0,
        "controlGeneration": 1,
    }


def test_execution_ledger_recovers_inflight_submit_as_unknown(
    tmp_path: Path,
) -> None:
    root = tmp_path / "execution-ledger"
    shadow_ref = "shdw_" + "D" * 43
    ledger = LiveExecutionLedger(root, broker_id="e" * 32)
    try:
        started = ledger.begin_submit(
            shadow_ref=shadow_ref,
            account_ref="acct_" + "F" * 43,
            metadata=_execution_metadata(),
            receipt_id="1" * 32,
            confirmation_sha256="sha256:" + "2" * 64,
            risk_decision_sha256="sha256:" + "3" * 64,
            notional="42",
        )
        assert started.state == "submitting"
    finally:
        ledger.close()
    reopened = LiveExecutionLedger(root, broker_id="e" * 32)
    try:
        recovered = reopened.describe(shadow_ref)
        assert recovered.state == "unknown"
        assert recovered.public_wire()["reconciliationRequired"] is True
        assert reopened.status()["unresolvedNotional"] == "42"
        assert reopened.event_head()["sequence"] == 2
        assert (root / LIVE_EXECUTION_FILENAME).is_file()
    finally:
        reopened.close()


def test_execution_ledger_recovers_inflight_cancel_without_retry(
    tmp_path: Path,
) -> None:
    root = tmp_path / "cancel-recovery"
    shadow_ref = "shdw_" + "G" * 43
    account_ref = "acct_" + "H" * 43
    ledger = LiveExecutionLedger(root, broker_id="f" * 32)
    try:
        ledger.begin_submit(
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            metadata=_execution_metadata(),
            receipt_id="1" * 32,
            confirmation_sha256="sha256:" + "2" * 64,
            risk_decision_sha256="sha256:" + "3" * 64,
            notional="42",
        )
        ledger.complete_submit(
            shadow_ref,
            ExecutionMutationProof(
                action="submit",
                accepted=True,
                instrument_id="BTC-USDT",
                client_order_id="C" * 32,
                venue_order_id="123456789",
                venue_code="0",
                observed_at="2026-07-23T01:02:04Z",
            ),
        )
        ledger.observe_query(
            shadow_ref,
            OrderQueryProof(
                connector_id=OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
                instrument_id="BTC-USDT",
                client_order_id="C" * 32,
                venue_order_id="123456789",
                state="live",
                accumulated_fill_size="0",
                average_price=None,
                observed_at="2026-07-23T01:03:04Z",
            ),
        )
        started = ledger.begin_cancel(
            shadow_ref,
            account_ref=account_ref,
            credential_handle_sha256="sha256:" + "b" * 64,
            version="1.0.0",
            receipt_id="4" * 32,
            confirmation_sha256="sha256:" + "5" * 64,
            risk_decision_sha256="sha256:" + "6" * 64,
            policy_epoch=0,
            control_generation=2,
        )
        assert started.state == "canceling"
    finally:
        ledger.close()
    reopened = LiveExecutionLedger(root, broker_id="f" * 32)
    try:
        recovered = reopened.describe(shadow_ref)
        assert recovered.state == "cancel_unknown"
        assert recovered.cancel_attempt_count == 1
        assert recovered.public_wire()["reconciliationRequired"] is True
    finally:
        reopened.close()


def test_execution_ledger_rejects_event_hash_tampering(
    tmp_path: Path,
) -> None:
    root = tmp_path / "tampered-ledger"
    ledger = LiveExecutionLedger(root, broker_id="1" * 32)
    try:
        ledger.begin_submit(
            shadow_ref="shdw_" + "J" * 43,
            account_ref="acct_" + "K" * 43,
            metadata=_execution_metadata(),
            receipt_id="1" * 32,
            confirmation_sha256="sha256:" + "2" * 64,
            risk_decision_sha256="sha256:" + "3" * 64,
            notional="42",
        )
    finally:
        ledger.close()
    connection = sqlite3.connect(root / LIVE_EXECUTION_FILENAME)
    try:
        connection.execute(
            "UPDATE execution_event SET event_sha256 = ? WHERE sequence = 1",
            ("sha256:" + "0" * 64,),
        )
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(LiveBrokerError) as invalid:
        LiveExecutionLedger(root, broker_id="1" * 32)
    assert invalid.value.code == "LIVE_EXECUTION_LEDGER_INVALID"


def _call(
    service: LiveBrokerService,
    *,
    sequence: int,
    session: str,
    method: str,
    params: dict[str, Any] | None = None,
    policy_epoch: int = 0,
) -> dict[str, Any]:
    response = service.handle(
        _request(
            sequence,
            session,
            method,
            params,
            policy_epoch=policy_epoch,
        )
    )
    assert response.result is not None
    return response.result


def _service_setup(
    root: Path,
    fixture: _PinnedExecutionFixture,
    *,
    execution_connector: _FakeExecutionConnector | None = None,
) -> tuple[
    LiveBrokerService,
    _FakeExecutionConnector,
    _FakeExecutionQueryConnector,
    bytes,
]:
    secret = b"execution-test-secret"
    mutation = execution_connector or _FakeExecutionConnector()
    query = _FakeExecutionQueryConnector(["live", "canceled"])
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=_FakeExecutionAccountConnector(secret),
        reconciliation_shadow_enabled=True,
        reconciliation_connector=query,
        native_control_enabled=True,
        testnet_execution_enabled=True,
        execution_connector=mutation,
    )
    return service, mutation, query, secret


def _prepare_execution(
    service: LiveBrokerService,
    fixture: _PinnedExecutionFixture,
    secret: bytes,
    *,
    session: str,
) -> tuple[str, str, dict[str, Any], int]:
    _call(
        service,
        sequence=1,
        session=session,
        method=METHOD_BOOTSTRAP,
    )
    credential = _call(
        service,
        sequence=2,
        session=session,
        method=METHOD_CREDENTIAL_PUT,
        params={
            "evidence": fixture.evidence.to_wire(),
            "label": "OKX Demo Read plus Trade",
            "secretBase64": base64.b64encode(secret).decode("ascii"),
        },
    )
    account = _call(
        service,
        sequence=3,
        session=session,
        method=METHOD_ACCOUNT_DISCOVER,
        params={"credentialHandle": credential["credentialHandle"]},
    )
    shadow = _call(
        service,
        sequence=4,
        session=session,
        method=METHOD_SHADOW_PREPARE,
        params={
            "accountRef": account["accountRef"],
            "intent": {
                "idempotencyKey": "intent_" + "I" * 43,
                "instrumentId": "BTC-USDT",
                "side": "buy",
                "orderType": "limit",
                "quantity": "0.001",
                "limitPrice": "42000",
            },
        },
    )
    _call(
        service,
        sequence=5,
        session=session,
        method=METHOD_CONTROL_SET,
        params={
            "mode": "armed",
            "reason": "explicit-demo-test",
            "acknowledgeKill": False,
        },
    )
    preview = _call(
        service,
        sequence=6,
        session=session,
        method=METHOD_CONFIRMATION_PREVIEW,
        params={
            "accountRef": account["accountRef"],
            "shadowRef": shadow["shadowRef"],
        },
    )
    return account["accountRef"], shadow["shadowRef"], preview, 7


def _issue(
    service: LiveBrokerService,
    *,
    sequence: int,
    session: str,
    account_ref: str,
    shadow_ref: str,
    preview: dict[str, Any],
) -> dict[str, Any]:
    return _call(
        service,
        sequence=sequence,
        session=session,
        method=METHOD_CONFIRMATION_ISSUE,
        params={
            "accountRef": account_ref,
            "shadowRef": shadow_ref,
            "expectedIntentSha256": preview["intentSha256"],
            "expectedPolicyEpoch": preview["policyEpoch"],
            "expectedControlGeneration": preview["controlGeneration"],
            "ttlSeconds": 60,
        },
    )


def _mutate_params(
    *,
    account_ref: str,
    shadow_ref: str,
    preview: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any]:
    return {
        "accountRef": account_ref,
        "shadowRef": shadow_ref,
        "receiptRef": receipt["receiptRef"],
        "expectedConfirmationSha256": preview["intentSha256"],
        "expectedPolicyEpoch": preview["policyEpoch"],
        "expectedControlGeneration": preview["controlGeneration"],
    }


def test_service_submit_reconcile_cancel_is_two_receipt_demo_flow(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    observed: list[tuple[str, str, int]] = []

    class _PersistObserver(_FakeExecutionConnector):
        service: LiveBrokerService

        def submit(
            self,
            secret: bytearray,
            *,
            intent: ShadowOrderIntent,
            client_order_id: str,
        ) -> ExecutionMutationProof:
            ledger = self.service.execution_ledger
            control = self.service.control_ledger
            assert ledger is not None
            assert control is not None
            record = next(
                item
                for item in ledger.connection.execute(
                    "SELECT state FROM execution_order"
                )
            )
            observed.append(
                (
                    "submit",
                    record["state"],
                    control.status()["confirmationCounts"]["consumed"],
                )
            )
            return super().submit(
                secret,
                intent=intent,
                client_order_id=client_order_id,
            )

        def cancel(
            self,
            secret: bytearray,
            *,
            instrument_id: str,
            client_order_id: str,
        ) -> ExecutionMutationProof:
            ledger = self.service.execution_ledger
            control = self.service.control_ledger
            assert ledger is not None
            assert control is not None
            record = next(
                item
                for item in ledger.connection.execute(
                    "SELECT state FROM execution_order"
                )
            )
            observed.append(
                (
                    "cancel",
                    record["state"],
                    control.status()["confirmationCounts"]["consumed"],
                )
            )
            return super().cancel(
                secret,
                instrument_id=instrument_id,
                client_order_id=client_order_id,
            )

    observer = _PersistObserver()
    root = tmp_path / "service-flow"
    service, mutation, query, secret = _service_setup(
        root,
        pinned_execution_fixture,
        execution_connector=observer,
    )
    observer.service = service
    session = "sess_" + "S" * 43
    try:
        account_ref, shadow_ref, submit_preview, sequence = _prepare_execution(
            service,
            pinned_execution_fixture,
            secret,
            session=session,
        )
        assert submit_preview["schemaVersion"].endswith("/2")
        assert submit_preview["action"] == "submit"
        assert submit_preview["notional"] == "42"
        submit_receipt = _issue(
            service,
            sequence=sequence,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=submit_preview,
        )
        submitted = _call(
            service,
            sequence=sequence + 1,
            session=session,
            method=METHOD_EXECUTION_SUBMIT,
            params=_mutate_params(
                account_ref=account_ref,
                shadow_ref=shadow_ref,
                preview=submit_preview,
                receipt=submit_receipt,
            ),
        )
        assert submitted["action"] == "submit"
        assert submitted["accepted"] is True
        assert submitted["state"] == "unknown"
        assert submitted["reconciliationRequired"] is True
        reconciled = _call(
            service,
            sequence=sequence + 2,
            session=session,
            method=METHOD_EXECUTION_RECONCILE,
            params={
                "accountRef": account_ref,
                "shadowRef": shadow_ref,
            },
        )
        assert reconciled["execution"]["state"] == "live"
        cancel_preview = _call(
            service,
            sequence=sequence + 3,
            session=session,
            method=METHOD_CONFIRMATION_PREVIEW,
            params={
                "accountRef": account_ref,
                "shadowRef": shadow_ref,
            },
        )
        assert cancel_preview["action"] == "cancel"
        assert cancel_preview["intentSha256"] != submit_preview["intentSha256"]
        cancel_receipt = _issue(
            service,
            sequence=sequence + 4,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=cancel_preview,
        )
        canceled = _call(
            service,
            sequence=sequence + 5,
            session=session,
            method=METHOD_EXECUTION_CANCEL,
            params=_mutate_params(
                account_ref=account_ref,
                shadow_ref=shadow_ref,
                preview=cancel_preview,
                receipt=cancel_receipt,
            ),
        )
        assert canceled["state"] == "cancel_unknown"
        final = _call(
            service,
            sequence=sequence + 6,
            session=session,
            method=METHOD_EXECUTION_RECONCILE,
            params={
                "accountRef": account_ref,
                "shadowRef": shadow_ref,
            },
        )
        assert final["execution"]["state"] == "canceled"
        assert final["execution"]["terminal"] is True
        assert len(mutation.submit_calls) == 1
        assert len(mutation.cancel_calls) == 1
        assert len(query.calls) == 2
        assert observed == [
            ("submit", "submitting", 1),
            ("cancel", "canceling", 2),
        ]
    finally:
        service.close()
    persisted = b"".join(
        path.read_bytes() for path in sorted(root.iterdir()) if path.is_file()
    )
    assert secret not in persisted
    assert b"execution-test-secret" not in persisted


def test_submit_transport_failure_is_unknown_and_never_retried(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    mutation = _FakeExecutionConnector(
        submit_error=broker_error(
            "LIVE_EXECUTION_TRANSPORT_FAILED",
            "test transport failed",
        )
    )
    service, _, _, secret = _service_setup(
        tmp_path / "service-failure",
        pinned_execution_fixture,
        execution_connector=mutation,
    )
    session = "sess_" + "T" * 43
    try:
        account_ref, shadow_ref, preview, sequence = _prepare_execution(
            service,
            pinned_execution_fixture,
            secret,
            session=session,
        )
        receipt = _issue(
            service,
            sequence=sequence,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=preview,
        )
        with pytest.raises(LiveBrokerError) as failed:
            _call(
                service,
                sequence=sequence + 1,
                session=session,
                method=METHOD_EXECUTION_SUBMIT,
                params=_mutate_params(
                    account_ref=account_ref,
                    shadow_ref=shadow_ref,
                    preview=preview,
                    receipt=receipt,
                ),
            )
        assert failed.value.code == "LIVE_EXECUTION_TRANSPORT_FAILED"
        assert len(mutation.submit_calls) == 1
        execution = service.execution_ledger
        assert execution is not None
        assert execution.describe(shadow_ref).state == "unknown"
        with pytest.raises(LiveBrokerError) as blocked:
            _call(
                service,
                sequence=sequence + 2,
                session=session,
                method=METHOD_CONFIRMATION_PREVIEW,
                params={
                    "accountRef": account_ref,
                    "shadowRef": shadow_ref,
                },
            )
        assert blocked.value.code == "LIVE_CONFIRMATION_ACTION_UNAVAILABLE"
        assert len(mutation.submit_calls) == 1
    finally:
        service.close()


def test_global_kill_linearizes_before_next_execution_network_call(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    service, mutation, _, secret = _service_setup(
        tmp_path / "service-kill",
        pinned_execution_fixture,
    )
    session = "sess_" + "W" * 43
    try:
        account_ref, shadow_ref, preview, sequence = _prepare_execution(
            service,
            pinned_execution_fixture,
            secret,
            session=session,
        )
        receipt = _issue(
            service,
            sequence=sequence,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=preview,
        )
        _call(
            service,
            sequence=sequence + 1,
            session=session,
            method=METHOD_CONTROL_KILL,
            params={"reason": "emergency-stop-before-submit"},
        )
        with pytest.raises(LiveBrokerError) as killed:
            _call(
                service,
                sequence=sequence + 2,
                session=session,
                method=METHOD_EXECUTION_SUBMIT,
                policy_epoch=1,
                params=_mutate_params(
                    account_ref=account_ref,
                    shadow_ref=shadow_ref,
                    preview=preview,
                    receipt=receipt,
                ),
            )
        assert killed.value.code == "LIVE_SHADOW_ACCOUNT_UNAVAILABLE"
        assert mutation.submit_calls == []
        assert service.execution_ledger is not None
        assert service.execution_ledger.status()["orderCount"] == 0
    finally:
        service.close()


def _audit_export_from_page(page: dict[str, Any]) -> dict[str, Any]:
    body = {
        "schemaVersion": "candlescope.live-audit-export/2",
        "generatedAt": "2026-07-23T01:10:00Z",
        "brokerIdSha256": page["brokerIdSha256"],
        "policyEpoch": page["policyEpoch"],
        "controlStatus": page["controlStatus"],
        "controlHead": page["controlHead"],
        "shadowHead": page["shadowHead"],
        "executionStatus": page["executionStatus"],
        "controlEvents": page["controlEvents"],
        "shadowEvents": page["shadowEvents"],
        "executionHead": page["executionHead"],
        "executionEvents": page["executionEvents"],
        "redaction": {
            "opaqueHandlesIncluded": False,
            "credentialMaterialIncluded": False,
            "authenticationDataIncluded": False,
            "rawVenueOrderIdsIncluded": False,
            "rawNetworkResponsesIncluded": False,
        },
        "liveMutationMethodsAvailable": True,
    }
    return {
        **body,
        "exportSha256": "sha256:"
        + hashlib.sha256(
            json.dumps(
                body,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest(),
    }


def test_execution_audit_v2_is_redacted_and_offline_verifiable(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    service, _, _, secret = _service_setup(
        tmp_path / "service-audit",
        pinned_execution_fixture,
    )
    session = "sess_" + "U" * 43
    try:
        account_ref, shadow_ref, preview, sequence = _prepare_execution(
            service,
            pinned_execution_fixture,
            secret,
            session=session,
        )
        receipt = _issue(
            service,
            sequence=sequence,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=preview,
        )
        _call(
            service,
            sequence=sequence + 1,
            session=session,
            method=METHOD_EXECUTION_SUBMIT,
            params=_mutate_params(
                account_ref=account_ref,
                shadow_ref=shadow_ref,
                preview=preview,
                receipt=receipt,
            ),
        )
        page = _call(
            service,
            sequence=sequence + 2,
            session=session,
            method=METHOD_AUDIT_EXPORT_PAGE,
            params={
                "controlAfterSequence": 0,
                "shadowAfterSequence": 0,
                "executionAfterSequence": 0,
                "controlThroughSequence": 0,
                "shadowThroughSequence": 0,
                "executionThroughSequence": 0,
                "limit": 16,
            },
        )
        assert page["schemaVersion"] == "candlescope.live-audit-page/2"
        exported = _audit_export_from_page(page)
        assert verify_live_audit_export(exported) == exported
        raw = json.dumps(exported, sort_keys=True)
        assert account_ref not in raw
        assert shadow_ref not in raw
        assert receipt["receiptRef"] not in raw
        assert "123456789" not in raw
    finally:
        service.close()


def test_execution_rollback_requires_kill_export_and_unresolved_review(
    tmp_path: Path,
    pinned_execution_fixture: _PinnedExecutionFixture,
) -> None:
    root = tmp_path / "service-rollback"
    service, _, _, secret = _service_setup(
        root,
        pinned_execution_fixture,
    )
    session = "sess_" + "V" * 43
    try:
        account_ref, shadow_ref, preview, sequence = _prepare_execution(
            service,
            pinned_execution_fixture,
            secret,
            session=session,
        )
        receipt = _issue(
            service,
            sequence=sequence,
            session=session,
            account_ref=account_ref,
            shadow_ref=shadow_ref,
            preview=preview,
        )
        _call(
            service,
            sequence=sequence + 1,
            session=session,
            method=METHOD_EXECUTION_SUBMIT,
            params=_mutate_params(
                account_ref=account_ref,
                shadow_ref=shadow_ref,
                preview=preview,
                receipt=receipt,
            ),
        )
        killed = _call(
            service,
            sequence=sequence + 2,
            session=session,
            method=METHOD_CONTROL_KILL,
            params={"reason": "wp-f-rollback"},
        )
        assert killed["mode"] == "killed"
        assert service.policy_epoch == 1
        page = _call(
            service,
            sequence=sequence + 3,
            session=session,
            method=METHOD_AUDIT_EXPORT_PAGE,
            policy_epoch=1,
            params={
                "controlAfterSequence": 0,
                "shadowAfterSequence": 0,
                "executionAfterSequence": 0,
                "controlThroughSequence": 0,
                "shadowThroughSequence": 0,
                "executionThroughSequence": 0,
                "limit": 16,
            },
        )
        exported = _audit_export_from_page(page)
        verify_live_audit_export(exported)
    finally:
        service.close()
    audit_path = tmp_path / "wp-f-audit.json"
    audit_path.write_text(
        json.dumps(exported, sort_keys=True),
        encoding="utf-8",
    )
    archive_path = tmp_path / "rollback" / "live-execution-v1.zip"
    with pytest.raises(ValueError, match="manual-review"):
        archive_live_execution_ledger(
            root,
            audit_export_path=audit_path,
            archive_path=archive_path,
            confirm_killed=True,
            remove_source=True,
        )
    result = archive_live_execution_ledger(
        root,
        audit_export_path=audit_path,
        archive_path=archive_path,
        confirm_killed=True,
        confirm_unresolved_manual_review=True,
        remove_source=True,
    )
    assert result["unresolvedCount"] == 1
    assert archive_path.is_file()
    assert not (root / LIVE_EXECUTION_FILENAME).exists()


def _execution_wire(*, action: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schemaVersion": "candlescope.live-execution-record/1",
        "pluginId": "candlescope.okx-demo",
        "connectorId": OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
        "publisherIdentity": "publisher:test",
        "version": "1.0.0",
        "clientOrderId": "C" * 32,
        "orderIntentSha256": "sha256:" + "1" * 64,
        "instrumentId": "BTC-USDT",
        "side": "buy",
        "orderType": "limit",
        "quantity": "0.001",
        "limitPrice": "42000",
        "notional": "42",
        "state": "unknown",
        "priorState": None,
        "submitAttemptCount": 1,
        "cancelAttemptCount": 0,
        "venueOrderIdSha256": "sha256:" + "2" * 64,
        "lastReceiptId": "3" * 32,
        "lastConfirmationSha256": "sha256:" + "4" * 64,
        "lastRiskDecisionSha256": "sha256:" + "5" * 64,
        "lastErrorCode": None,
        "createdAt": "2026-07-23T01:02:03Z",
        "updatedAt": "2026-07-23T01:02:04Z",
        "policyEpoch": 0,
        "controlGeneration": 1,
        "terminal": False,
        "reconciliationRequired": True,
    }
    if action is not None:
        value |= {"accepted": True, "action": action}
    return value


def test_host_execution_api_is_guarded_exact_and_flag_closed(
    tmp_path: Path,
) -> None:
    platform = CorePluginPlatform(
        root=tmp_path / "host-api",
        host_name="CandleScope",
        host_version="0.4.0",
        trust_level="first-party-pinned",
        live_broker_foundation_enabled=True,
        live_account_readonly_enabled=True,
        live_reconciliation_shadow_enabled=True,
        live_native_control_enabled=True,
        live_testnet_execution_enabled=True,
    )
    calls: list[tuple[str, dict[str, Any]]] = []

    async def describe_live_execution(
        *,
        shadow_ref: str,
    ) -> dict[str, Any]:
        calls.append(("describe", {"shadow_ref": shadow_ref}))
        return _execution_wire()

    async def submit_live_execution(
        **values: Any,
    ) -> dict[str, Any]:
        calls.append(("submit", dict(values)))
        return _execution_wire(action="submit")

    async def cancel_live_execution(
        **values: Any,
    ) -> dict[str, Any]:
        calls.append(("cancel", dict(values)))
        return _execution_wire(action="cancel")

    async def reconcile_live_execution(
        **values: Any,
    ) -> dict[str, Any]:
        calls.append(("reconcile", dict(values)))
        return {
            "schemaVersion": "candlescope.live-execution-reconcile/1",
            "execution": _execution_wire(),
            "shadow": {},
        }

    platform.describe_live_execution = describe_live_execution  # type: ignore[method-assign]
    platform.submit_live_execution = submit_live_execution  # type: ignore[method-assign]
    platform.cancel_live_execution = cancel_live_execution  # type: ignore[method-assign]
    platform.reconcile_live_execution = reconcile_live_execution  # type: ignore[method-assign]
    guard = LocalManagementGuard(
        ("http://127.0.0.1",),
        session_token="phase11f-session-token-0123456789abcdef",
        csrf_token="phase11f-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(
        app=app,
        client=("127.0.0.1", 43221),
    )
    body = {
        "accountRef": "acct_" + "A" * 43,
        "shadowRef": "shdw_" + "B" * 43,
        "receiptRef": "livecfm_" + "C" * 43,
        "expectedConfirmationSha256": "sha256:" + "d" * 64,
        "expectedPolicyEpoch": 0,
        "expectedControlGeneration": 1,
    }

    async def scenario() -> None:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
        ) as client:
            denied = await client.post(
                "/api/v2/plugins/manage/live/execution/submit",
                json=body,
            )
            assert denied.status_code == 403
            malformed = await client.post(
                "/api/v2/plugins/manage/live/execution/submit",
                headers=guard.trusted_headers(user_action="malformed"),
                json={**body, "unknown": True},
            )
            assert malformed.status_code == 400
            submitted = await client.post(
                "/api/v2/plugins/manage/live/execution/submit",
                headers=guard.trusted_headers(user_action="explicit-demo-submit"),
                json=body,
            )
            assert submitted.status_code == 200
            assert submitted.json()["action"] == "submit"
            canceled = await client.post(
                "/api/v2/plugins/manage/live/execution/cancel",
                headers=guard.trusted_headers(user_action="explicit-demo-cancel"),
                json=body,
            )
            assert canceled.status_code == 200
            assert canceled.json()["action"] == "cancel"
            reconciled = await client.post(
                "/api/v2/plugins/manage/live/execution/reconcile",
                headers=guard.trusted_headers(user_action="explicit-demo-reconcile"),
                json={
                    "accountRef": body["accountRef"],
                    "shadowRef": body["shadowRef"],
                },
            )
            assert reconciled.status_code == 200
            described = await client.get(
                f"/api/v2/plugins/manage/live/execution/{body['shadowRef']}",
                headers=guard.trusted_headers(),
            )
            assert described.status_code == 200
            platform.live_testnet_execution_enabled = False
            closed = await client.post(
                "/api/v2/plugins/manage/live/execution/submit",
                headers=guard.trusted_headers(user_action="flag-closed"),
                json=body,
            )
            assert closed.status_code == 404

    asyncio.run(scenario())
    assert [name for name, _ in calls] == [
        "submit",
        "cancel",
        "reconcile",
        "describe",
    ]
    assert calls[0][1]["trace_id"] == ("management-explicit-demo-submit")
