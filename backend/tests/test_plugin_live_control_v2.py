from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.bootstrap import (
    PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
    PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
    PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV,
    PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
    build_core_plugin_platform_from_environment,
)
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_live_v2 import (
    LIVE_BROKER_METHODS,
    LiveBrokerController,
    LiveBrokerError,
    LiveAuditExportError,
    verify_live_audit_export,
)
from app.plugin_live_v2.control import (
    LIVE_CONTROL_FILENAME,
    LiveControlLedger,
)
from app.plugin_live_v2.protocol import (
    METHOD_ACCOUNT_DISCOVER,
    METHOD_AUDIT_EXPORT_PAGE,
    METHOD_CONFIRMATION_ISSUE,
    METHOD_CONFIRMATION_PREVIEW,
    METHOD_CONTROL_KILL,
    METHOD_CONTROL_SET,
    METHOD_CREDENTIAL_PUT,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_security_v2.management import LocalManagementGuard
from scripts.archive_live_control_v1 import archive_live_control_ledger
from tests.test_plugin_live_shadow_v2 import (
    _FakeAccountConnector,
    _FakeQueryConnector,
    _PinnedShadowFixture,
    _account_proof,
    _bind_account,
    _build_pinned_shadow_fixture,
    _prepare,
    _request,
)


@pytest.fixture(scope="module")
def pinned_shadow_fixture(
    tmp_path_factory: pytest.TempPathFactory,
) -> _PinnedShadowFixture:
    return _build_pinned_shadow_fixture(
        tmp_path_factory.mktemp("live-control-pinned")
    )


def _metadata(policy_epoch: int = 0) -> dict[str, object]:
    return {
        "intentSha256": "sha256:" + "c" * 64,
        "pluginId": "com.test.plugin",
        "connectorId": "candlescope.test.connector",
        "publisherIdentity": "publisher:test",
        "version": "1.0.0",
        "clientOrderId": "C" * 32,
        "instrumentId": "BTC-USDT",
        "side": "buy",
        "orderType": "limit",
        "quantity": "1",
        "limitPrice": "42000",
        "policyEpoch": policy_epoch,
    }


def test_wp_e_protocol_has_no_live_mutation_or_receipt_consume_method() -> None:
    assert {
        "control.status",
        "control.set",
        "control.kill",
        "authority.revoke",
        "confirmation.preview",
        "confirmation.issue",
        "confirmation.describe",
        "confirmation.revoke",
        "audit.export.page",
    }.issubset(LIVE_BROKER_METHODS)
    assert {
        "trade.submit",
        "trade.cancel",
        "trade.amend",
        "funds.transfer",
        "funds.withdraw",
        "confirmation.consume",
        "network.request",
    }.isdisjoint(LIVE_BROKER_METHODS)


def test_native_control_flag_requires_wp_d_and_pinned_trust(
    tmp_path: Path,
) -> None:
    base = {
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
        "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "platform"),
        PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV: "1",
    }
    with pytest.raises(CorePluginError) as missing_shadow:
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
    assert missing_shadow.value.code == "PLUGIN_LIVE_CONTROL_SHADOW_REQUIRED"

    all_flags = {
        **base,
        PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV: "1",
        PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV: "1",
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
        environ={
            **all_flags,
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
        },
    )
    assert platform.live_native_control_enabled is True
    assert platform.live_broker.native_control_enabled is True


def test_control_ledger_persists_and_receipt_consumes_exactly_once(
    tmp_path: Path,
) -> None:
    root = tmp_path / "control"
    ledger = LiveControlLedger(root, broker_id="a" * 32, policy_epoch=0)
    account_ref = "acct_" + "A" * 43
    shadow_ref = "shdw_" + "B" * 43
    try:
        assert ledger.status()["mode"] == "disarmed"
        armed = ledger.set_mode(
            "armed",
            policy_epoch=0,
            reason="explicit-user-arm",
            acknowledge_kill=False,
        )
        assert armed["mode"] == "armed"
        assert armed["generation"] == 1
        receipt_ref, receipt = ledger.issue(
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            metadata=_metadata(),
            ttl_seconds=60,
        )
        assert receipt.state == "issued"
        assert receipt_ref not in (root / LIVE_CONTROL_FILENAME).read_bytes().decode(
            "latin1"
        )
        consumed = ledger.consume_for_execution(
            receipt_ref,
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            intent_sha256=receipt.intent_sha256,
            plugin_id=receipt.plugin_id,
            publisher_identity=receipt.publisher_identity,
            connector_id=receipt.connector_id,
            policy_epoch=receipt.policy_epoch,
            control_generation=receipt.control_generation,
        )
        assert consumed.state == "consumed"
        with pytest.raises(LiveBrokerError) as spent:
            ledger.consume_for_execution(
                receipt_ref,
                shadow_ref=shadow_ref,
                account_ref=account_ref,
                intent_sha256=receipt.intent_sha256,
                plugin_id=receipt.plugin_id,
                publisher_identity=receipt.publisher_identity,
                connector_id=receipt.connector_id,
                policy_epoch=receipt.policy_epoch,
                control_generation=receipt.control_generation,
            )
        assert spent.value.code == "LIVE_CONFIRMATION_REJECTED"
    finally:
        ledger.close()

    reopened = LiveControlLedger(root, broker_id="a" * 32, policy_epoch=0)
    try:
        assert reopened.status()["mode"] == "armed"
        assert reopened.describe(receipt_ref).state == "consumed"
    finally:
        reopened.close()


def test_confirmation_issue_deduplicates_and_consume_race_has_one_winner(
    tmp_path: Path,
) -> None:
    root = tmp_path / "consume-race"
    broker_id = "9" * 32
    shadow_ref = "shdw_" + "R" * 43
    account_ref = "acct_" + "S" * 43
    ledger = LiveControlLedger(root, broker_id=broker_id, policy_epoch=0)
    try:
        ledger.set_mode(
            "armed",
            policy_epoch=0,
            reason="race-test-arm",
            acknowledge_kill=False,
        )
        receipt_ref, receipt = ledger.issue(
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            metadata=_metadata(),
            ttl_seconds=120,
        )
        with pytest.raises(LiveBrokerError) as duplicate:
            ledger.issue(
                shadow_ref=shadow_ref,
                account_ref=account_ref,
                metadata=_metadata(),
                ttl_seconds=120,
            )
        assert duplicate.value.code == "LIVE_CONFIRMATION_ALREADY_ISSUED"
    finally:
        ledger.close()

    barrier = threading.Barrier(2)

    def consume() -> str:
        concurrent = LiveControlLedger(
            root,
            broker_id=broker_id,
            policy_epoch=0,
        )
        try:
            barrier.wait(timeout=5)
            try:
                concurrent.consume_for_execution(
                    receipt_ref,
                    shadow_ref=shadow_ref,
                    account_ref=account_ref,
                    intent_sha256=receipt.intent_sha256,
                    plugin_id=receipt.plugin_id,
                    publisher_identity=receipt.publisher_identity,
                    connector_id=receipt.connector_id,
                    policy_epoch=receipt.policy_epoch,
                    control_generation=receipt.control_generation,
                )
            except LiveBrokerError as exc:
                return exc.code
            return "consumed"
        finally:
            concurrent.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = sorted(
            future.result(timeout=10)
            for future in (executor.submit(consume), executor.submit(consume))
        )
    assert outcomes == ["LIVE_CONFIRMATION_REJECTED", "consumed"]

    reopened = LiveControlLedger(root, broker_id=broker_id, policy_epoch=0)
    try:
        assert reopened.describe(receipt_ref).state == "consumed"
        assert reopened.status()["confirmationCounts"]["consumed"] == 1
    finally:
        reopened.close()


def test_expiry_disarm_kill_and_epoch_recovery_are_fail_closed(
    tmp_path: Path,
) -> None:
    root = tmp_path / "lifecycle"
    now = datetime(2026, 7, 23, 1, 2, 3, tzinfo=UTC)
    ledger = LiveControlLedger(root, broker_id="b" * 32, policy_epoch=0)
    try:
        ledger.set_mode(
            "armed",
            policy_epoch=0,
            reason="arm",
            acknowledge_kill=False,
        )
        first_ref, _first = ledger.issue(
            shadow_ref="shdw_" + "C" * 43,
            account_ref="acct_" + "D" * 43,
            metadata=_metadata(),
            ttl_seconds=15,
            now=now,
        )
        assert (
            ledger.describe(first_ref, now=now + timedelta(seconds=16)).state
            == "expired"
        )
        second_ref, _second = ledger.issue(
            shadow_ref="shdw_" + "E" * 43,
            account_ref="acct_" + "F" * 43,
            metadata=_metadata(),
            ttl_seconds=60,
            now=now,
        )
        disarmed = ledger.set_mode(
            "disarmed",
            policy_epoch=0,
            reason="user-disarm",
            acknowledge_kill=False,
        )
        assert disarmed["mode"] == "disarmed"
        assert ledger.describe(second_ref).state == "revoked"
        killed = ledger.force_killed(
            policy_epoch=1,
            reason="global-kill",
        )
        assert killed["mode"] == "killed"
        with pytest.raises(LiveBrokerError) as acknowledgement:
            ledger.set_mode(
                "armed",
                policy_epoch=1,
                reason="arm-after-kill",
                acknowledge_kill=False,
            )
        assert acknowledgement.value.code == "LIVE_CONTROL_KILL_ACK_REQUIRED"
    finally:
        ledger.close()

    recovered = LiveControlLedger(root, broker_id="b" * 32, policy_epoch=2)
    try:
        status = recovered.status()
        assert status["mode"] == "killed"
        assert status["policyEpoch"] == 2
        assert status["generation"] >= 3
    finally:
        recovered.close()


def test_control_event_tamper_rejects_restart(tmp_path: Path) -> None:
    root = tmp_path / "tamper"
    ledger = LiveControlLedger(root, broker_id="c" * 32, policy_epoch=0)
    ledger.set_mode(
        "armed",
        policy_epoch=0,
        reason="arm",
        acknowledge_kill=False,
    )
    ledger.close()
    connection = sqlite3.connect(root / LIVE_CONTROL_FILENAME)
    connection.execute(
        "UPDATE control_event SET payload_json = ? WHERE sequence = 2",
        ('{"generation":1,"mode":"disarmed","policyEpoch":0}',),
    )
    connection.commit()
    connection.close()

    with pytest.raises(LiveBrokerError) as tampered:
        LiveControlLedger(root, broker_id="c" * 32, policy_epoch=0)
    assert tampered.value.code == "LIVE_CONTROL_LEDGER_INVALID"
    assert tampered.value.fatal is True


def test_control_schema_tamper_rejects_restart(tmp_path: Path) -> None:
    root = tmp_path / "schema-tamper"
    ledger = LiveControlLedger(root, broker_id="8" * 32, policy_epoch=0)
    ledger.close()
    connection = sqlite3.connect(root / LIVE_CONTROL_FILENAME)
    connection.execute("ALTER TABLE confirmation ADD COLUMN injected TEXT")
    connection.commit()
    connection.close()

    with pytest.raises(LiveBrokerError) as tampered:
        LiveControlLedger(root, broker_id="8" * 32, policy_epoch=0)
    assert tampered.value.code == "LIVE_CONTROL_LEDGER_INVALID"
    assert tampered.value.fatal is True


def test_service_preview_issue_kill_and_audit_are_query_only_and_redacted(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    secret = b"WP-E-SECRET-CANARY-20260723"
    other_secret = b"WP-E-OTHER-ACCOUNT-CANARY"
    account_connector = _FakeAccountConnector()
    account_connector.proofs[secret] = _account_proof("live-control")
    account_connector.proofs[other_secret] = _account_proof(
        "live-control-other"
    )
    root = tmp_path / "service"
    service = LiveBrokerService(
        root,
        vault_backend="fake",
        release_lock_path=pinned_shadow_fixture.lock_path,
        read_only_accounts_enabled=True,
        account_connector=account_connector,
        reconciliation_shadow_enabled=True,
        reconciliation_connector=_FakeQueryConnector(),
        native_control_enabled=True,
    )
    session = "sess_" + "E" * 43
    account_ref, _credential_ref, sequence = _bind_account(
        service,
        fixture=pinned_shadow_fixture,
        session_id=session,
        secret=secret,
    )
    shadow = _prepare(
        service,
        sequence=sequence,
        session_id=session,
        account_ref=account_ref,
        idempotency_key="intent_" + "E" * 43,
    )
    sequence += 1
    other_put = service.handle(
        _request(
            sequence,
            session,
            METHOD_CREDENTIAL_PUT,
            0,
            {
                "evidence": pinned_shadow_fixture.evidence.to_wire(),
                "label": "WP-E other account",
                "secretBase64": base64.b64encode(other_secret).decode("ascii"),
            },
        )
    )
    assert other_put.result is not None
    sequence += 1
    other_discovered = service.handle(
        _request(
            sequence,
            session,
            METHOD_ACCOUNT_DISCOVER,
            0,
            {
                "credentialHandle": other_put.result["credentialHandle"],
            },
        )
    )
    assert other_discovered.result is not None
    other_account_ref = other_discovered.result["accountRef"]
    sequence += 1
    try:
        armed = service.handle(
            _request(
                sequence,
                session,
                METHOD_CONTROL_SET,
                0,
                {
                    "mode": "armed",
                    "reason": "host-native-user-action",
                    "acknowledgeKill": False,
                },
            )
        )
        assert armed.result is not None
        assert armed.result["mode"] == "armed"
        sequence += 1
        with pytest.raises(LiveBrokerError) as account_mismatch:
            service.handle(
                _request(
                    sequence,
                    session,
                    METHOD_CONFIRMATION_PREVIEW,
                    0,
                    {
                        "accountRef": other_account_ref,
                        "shadowRef": shadow["shadowRef"],
                    },
                )
            )
        assert (
            account_mismatch.value.code
            == "LIVE_CONFIRMATION_INTENT_UNAVAILABLE"
        )
        sequence += 1
        preview = service.handle(
            _request(
                sequence,
                session,
                METHOD_CONFIRMATION_PREVIEW,
                0,
                {
                    "accountRef": account_ref,
                    "shadowRef": shadow["shadowRef"],
                },
            )
        )
        assert preview.result is not None
        assert preview.result["intentSha256"] == shadow["intentSha256"]
        assert preview.result["liveSubmitAvailable"] is False
        sequence += 1
        with pytest.raises(LiveBrokerError) as stale_epoch:
            service.handle(
                _request(
                    sequence,
                    session,
                    METHOD_CONFIRMATION_ISSUE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": shadow["shadowRef"],
                        "expectedIntentSha256": preview.result[
                            "intentSha256"
                        ],
                        "expectedPolicyEpoch": (
                            preview.result["policyEpoch"] + 1
                        ),
                        "expectedControlGeneration": preview.result[
                            "controlGeneration"
                        ],
                        "ttlSeconds": 60,
                    },
                )
            )
        assert stale_epoch.value.code == "LIVE_CONFIRMATION_STALE"
        sequence += 1
        with pytest.raises(LiveBrokerError) as stale_generation:
            service.handle(
                _request(
                    sequence,
                    session,
                    METHOD_CONFIRMATION_ISSUE,
                    0,
                    {
                        "accountRef": account_ref,
                        "shadowRef": shadow["shadowRef"],
                        "expectedIntentSha256": preview.result[
                            "intentSha256"
                        ],
                        "expectedPolicyEpoch": preview.result["policyEpoch"],
                        "expectedControlGeneration": (
                            preview.result["controlGeneration"] + 1
                        ),
                        "ttlSeconds": 60,
                    },
                )
            )
        assert stale_generation.value.code == "LIVE_CONFIRMATION_STALE"
        sequence += 1
        issued = service.handle(
            _request(
                sequence,
                session,
                METHOD_CONFIRMATION_ISSUE,
                0,
                {
                    "accountRef": account_ref,
                    "shadowRef": shadow["shadowRef"],
                    "expectedIntentSha256": preview.result["intentSha256"],
                    "expectedPolicyEpoch": preview.result["policyEpoch"],
                    "expectedControlGeneration": preview.result[
                        "controlGeneration"
                    ],
                    "ttlSeconds": 60,
                },
            )
        )
        assert issued.result is not None
        assert issued.result["state"] == "issued"
        assert issued.result["liveSubmitAvailable"] is False
        assert service._network_method_count() == 3
        sequence += 1
        killed = service.handle(
            _request(
                sequence,
                session,
                METHOD_CONTROL_KILL,
                0,
                {"reason": "operator-global-kill"},
            )
        )
        assert killed.policy_epoch == 1
        assert killed.result is not None
        assert killed.result["mode"] == "killed"
        assert not service.state.credentials
        assert not service.state.accounts
        sequence += 1
        page = service.handle(
            _request(
                sequence,
                session,
                METHOD_AUDIT_EXPORT_PAGE,
                1,
                {
                    "controlAfterSequence": 0,
                    "shadowAfterSequence": 0,
                    "controlThroughSequence": 0,
                    "shadowThroughSequence": 0,
                    "limit": 16,
                },
            )
        )
        assert page.result is not None
        encoded = repr(page.result).encode("utf-8")
        assert secret not in encoded
        assert other_secret not in encoded
        assert account_ref.encode("ascii") not in encoded
        assert shadow["shadowRef"].encode("ascii") not in encoded
        assert issued.result["receiptRef"].encode("ascii") not in encoded
        assert page.result["controlHead"]["sequence"] >= 5
        assert page.result["shadowHead"]["sequence"] == 1
    finally:
        service.close()


def test_private_worker_persists_control_and_exports_without_network(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    audit_export: dict[str, object] | None = None
    controller = LiveBrokerController(
        enabled=True,
        root=tmp_path / "worker",
        release_lock_path=pinned_shadow_fixture.lock_path,
        trust_store=pinned_shadow_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
        native_control_enabled=True,
    )

    async def scenario() -> None:
        nonlocal audit_export
        await controller.start()
        try:
            status = await controller.control_status()
            assert status["mode"] == "disarmed"
            assert controller.status()["networkMethods"] == 3
            armed = await controller.set_control_mode(
                "armed",
                reason="worker-integration",
            )
            assert armed["mode"] == "armed"
            killed = await controller.kill_control(reason="worker-kill")
            assert killed["mode"] == "killed"
            assert controller.policy_epoch == 1
            exported = await controller.export_audit()
            audit_export = exported
            assert exported["schemaVersion"] == (
                "candlescope.live-audit-export/1"
            )
            assert exported["liveMutationMethodsAvailable"] is False
            assert exported["shadowEvents"] == []
            assert exported["controlHead"]["sequence"] >= 3
            assert exported["exportSha256"].startswith("sha256:")
            assert verify_live_audit_export(exported)["exportSha256"] == (
                exported["exportSha256"]
            )
            tampered = json.loads(json.dumps(exported))
            tampered["controlEvents"][1]["payload"]["mode"] = "disarmed"
            with pytest.raises(LiveAuditExportError):
                verify_live_audit_export(tampered)
            leaked = json.loads(json.dumps(exported))
            leaked["redaction"]["debug"] = (
                "acct_" + "A" * 43
            )
            with pytest.raises(LiveAuditExportError):
                verify_live_audit_export(leaked)
        finally:
            await controller.stop()
        await controller.start()
        try:
            restarted = await controller.control_status()
            assert restarted["mode"] == "killed"
            assert restarted["policyEpoch"] == 1
        finally:
            await controller.stop()

    asyncio.run(scenario())
    assert audit_export is not None
    audit_path = tmp_path / "live-audit-export.json"
    audit_path.write_text(
        json.dumps(audit_export, sort_keys=True),
        encoding="utf-8",
    )
    archive_path = tmp_path / "rollback" / "live-control-v1.zip"
    archived = archive_live_control_ledger(
        tmp_path / "worker",
        audit_export_path=audit_path,
        archive_path=archive_path,
        confirm_killed=True,
        remove_source=True,
    )
    assert archived["archivePath"] == str(archive_path.resolve())
    assert archived["controlHead"] == audit_export["controlHead"]
    assert archive_path.is_file()
    assert not (tmp_path / "worker" / LIVE_CONTROL_FILENAME).exists()


def test_native_control_flag_off_creates_no_control_ledger(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    root = tmp_path / "flag-off-worker"
    controller = LiveBrokerController(
        enabled=True,
        root=root,
        release_lock_path=pinned_shadow_fixture.lock_path,
        trust_store=pinned_shadow_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
        native_control_enabled=False,
    )

    async def scenario() -> None:
        await controller.start()
        try:
            status = controller.control_status_cached()
            assert status["available"] is False
            assert status["mode"] == "disabled"
            assert not (root / LIVE_CONTROL_FILENAME).exists()
            with pytest.raises(LiveBrokerError) as disabled:
                await controller.control_status()
            assert disabled.value.code == "LIVE_NATIVE_CONTROL_DISABLED"
        finally:
            await controller.stop()

    asyncio.run(scenario())


def test_host_api_guards_control_kill_revoke_and_audit_export(
    tmp_path: Path,
    pinned_shadow_fixture: _PinnedShadowFixture,
) -> None:
    root = tmp_path / "host-api"
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        trust_level="first-party-pinned",
        live_broker_foundation_enabled=True,
        live_account_readonly_enabled=True,
        live_reconciliation_shadow_enabled=True,
        live_native_control_enabled=True,
    )
    platform.live_broker = LiveBrokerController(
        enabled=True,
        root=root / "live-broker-v1",
        release_lock_path=pinned_shadow_fixture.lock_path,
        trust_store=pinned_shadow_fixture.trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
        native_control_enabled=True,
    )
    guard = LocalManagementGuard(
        ("http://127.0.0.1",),
        session_token="phase11e-session-token-0123456789abcdef",
        csrf_token="phase11e-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(
        app=app,
        client=("127.0.0.1", 43220),
    )

    async def scenario() -> None:
        await platform.start()
        try:
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://127.0.0.1",
            ) as client:
                public = await client.get(
                    "/api/v2/plugins/live/control/status"
                )
                assert public.status_code == 200
                assert public.json()["mode"] == "disarmed"
                denied = await client.post(
                    "/api/v2/plugins/manage/live/control",
                    json={
                        "mode": "armed",
                        "reason": "denied",
                        "acknowledgeKill": False,
                    },
                )
                assert denied.status_code == 403
                malformed = await client.post(
                    "/api/v2/plugins/manage/live/control",
                    headers=guard.trusted_headers(user_action="malformed"),
                    json={"mode": "armed", "reason": "missing-ack"},
                )
                assert malformed.status_code == 400
                armed = await client.post(
                    "/api/v2/plugins/manage/live/control",
                    headers=guard.trusted_headers(user_action="arm-live"),
                    json={
                        "mode": "armed",
                        "reason": "operator-arm",
                        "acknowledgeKill": False,
                    },
                )
                assert armed.status_code == 200
                assert armed.json()["mode"] == "armed"
                killed = await client.post(
                    "/api/v2/plugins/manage/live/kill",
                    headers=guard.trusted_headers(user_action="kill-live"),
                    json={"reason": "operator-emergency-stop"},
                )
                assert killed.status_code == 200
                assert killed.json()["mode"] == "killed"
                assert killed.json()["liveSubmitAvailable"] is False
                revoked = await client.post(
                    "/api/v2/plugins/manage/live/revoke",
                    headers=guard.trusted_headers(
                        user_action="revoke-publisher"
                    ),
                    json={
                        "scopeType": "publisher",
                        "subject": "publisher:test",
                        "reason": "publisher-revoked",
                    },
                )
                assert revoked.status_code == 200
                assert revoked.json()["scopeType"] == "publisher"
                exported = await client.get(
                    "/api/v2/plugins/manage/live/audit-export",
                    headers=guard.trusted_headers(),
                )
                assert exported.status_code == 200
                assert exported.headers["cache-control"] == "no-store"
                assert exported.headers[
                    "x-candlescope-content-sha256"
                ].startswith("sha256:")
                payload = exported.json()
                assert payload["schemaVersion"] == (
                    "candlescope.live-audit-export/1"
                )
                assert payload["liveMutationMethodsAvailable"] is False
                assert payload["redaction"] == {
                    "opaqueHandlesIncluded": False,
                    "credentialMaterialIncluded": False,
                    "authenticationDataIncluded": False,
                    "rawVenueOrderIdsIncluded": False,
                    "rawNetworkResponsesIncluded": False,
                }
                assert (
                    await client.post(
                        "/api/v2/plugins/manage/live/orders/submit",
                        headers=guard.trusted_headers(
                            user_action="forbidden-submit"
                        ),
                        json={},
                    )
                ).status_code == 404
        finally:
            await platform.stop()

    asyncio.run(scenario())
