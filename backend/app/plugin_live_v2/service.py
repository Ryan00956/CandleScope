"""Single-session authoritative state machine for the zero-network Broker."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .accounts import (
    OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    ReadOnlyAccountConnector,
    ReadOnlyAccountProof,
)
from .control import LiveControlLedger
from .errors import LiveBrokerError, broker_error
from .execution import (
    DEMO_EXECUTION_INSTRUMENT,
    DemoSpotExecutionConnector,
    LiveExecutionLedger,
    MAX_DEMO_ORDER_NOTIONAL,
    MAX_DEMO_UNRESOLVED_NOTIONAL,
    MAX_DEMO_UNRESOLVED_ORDERS,
    execution_risk_decision,
)
from .protocol import (
    METHOD_ACCOUNT_DESCRIBE,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_ACCOUNT_REBIND,
    METHOD_BOOTSTRAP,
    METHOD_AUDIT_EXPORT_PAGE,
    METHOD_AUTHORITY_REVOKE,
    METHOD_CONFIRMATION_DESCRIBE,
    METHOD_CONFIRMATION_ISSUE,
    METHOD_CONFIRMATION_PREVIEW,
    METHOD_CONFIRMATION_REVOKE,
    METHOD_CONTROL_KILL,
    METHOD_CONTROL_SET,
    METHOD_CONTROL_STATUS,
    METHOD_CREDENTIAL_DESCRIBE,
    METHOD_CREDENTIAL_PUT,
    METHOD_CREDENTIAL_REVOKE,
    METHOD_EXECUTION_CANCEL,
    METHOD_EXECUTION_DESCRIBE,
    METHOD_EXECUTION_RECONCILE,
    METHOD_EXECUTION_SUBMIT,
    METHOD_HEALTH,
    METHOD_POLICY_ADVANCE,
    METHOD_SHADOW_DESCRIBE,
    METHOD_SHADOW_PREPARE,
    METHOD_SHADOW_RECONCILE,
    METHOD_SHUTDOWN,
    BrokerRequest,
    BrokerResponse,
    success_response,
)
from .journal import ShadowOrderJournal
from .shadow import (
    ORDER_QUERY_STATES,
    OrderQueryProof,
    ReadOnlyOrderQueryConnector,
    ShadowOrderIntent,
)
from .state import (
    AccountBinding,
    BrokerPersistentState,
    BrokerStateStore,
    CredentialBinding,
)
from .trust import (
    LivePublisherTrustStore,
    LiveTrustError,
    PublisherEvidence,
)
from .vault import (
    MAX_CREDENTIAL_BYTES,
    CredentialVault,
    FakeCredentialVault,
    WindowsDpapiCredentialVault,
    wipe_secret,
)


MAX_ACTIVE_CREDENTIALS = 1024
MAX_ACCOUNT_BINDINGS = 1024
_CREDENTIAL_HANDLE = re.compile(r"^cred_[A-Za-z0-9_-]{43}$")
_ACCOUNT_HANDLE = re.compile(r"^acct_[A-Za-z0-9_-]{43}$")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _exact_params(
    params: Mapping[str, Any],
    expected: set[str],
    label: str,
) -> None:
    if set(params) != expected:
        raise broker_error(
            "LIVE_BROKER_PARAMS_INVALID",
            f"{label} fields do not match the method contract",
            details={
                "missingFields": sorted(expected - set(params)),
                "unknownFields": sorted(set(params) - expected),
            },
        )


def _text(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\0" in value
    ):
        raise broker_error(
            "LIVE_BROKER_PARAMS_INVALID",
            f"{label} is invalid",
        )
    return value


class LiveBrokerService:
    """Own policy epoch, credentials, and optionally pinned read-only accounts."""

    def __init__(
        self,
        root: Path | str,
        *,
        vault_backend: str,
        release_lock_path: Path | str,
        read_only_accounts_enabled: bool = False,
        account_connector: ReadOnlyAccountConnector | None = None,
        reconciliation_shadow_enabled: bool = False,
        reconciliation_connector: ReadOnlyOrderQueryConnector | None = None,
        native_control_enabled: bool = False,
        testnet_execution_enabled: bool = False,
        execution_connector: DemoSpotExecutionConnector | None = None,
    ) -> None:
        if not isinstance(read_only_accounts_enabled, bool):
            raise TypeError("read_only_accounts_enabled must be a boolean")
        if not isinstance(reconciliation_shadow_enabled, bool):
            raise TypeError("reconciliation_shadow_enabled must be a boolean")
        if not isinstance(native_control_enabled, bool):
            raise TypeError("native_control_enabled must be a boolean")
        if not isinstance(testnet_execution_enabled, bool):
            raise TypeError("testnet_execution_enabled must be a boolean")
        if reconciliation_shadow_enabled and not read_only_accounts_enabled:
            raise ValueError(
                "reconciliation_shadow_enabled requires read-only accounts"
            )
        if native_control_enabled and not reconciliation_shadow_enabled:
            raise ValueError(
                "native_control_enabled requires reconciliation shadow"
            )
        if testnet_execution_enabled and not native_control_enabled:
            raise ValueError(
                "testnet_execution_enabled requires native Live control"
            )
        if account_connector is not None and not read_only_accounts_enabled:
            raise ValueError(
                "account_connector requires read_only_accounts_enabled"
            )
        if (
            reconciliation_connector is not None
            and not reconciliation_shadow_enabled
        ):
            raise ValueError(
                "reconciliation_connector requires reconciliation shadow"
            )
        if execution_connector is not None and not testnet_execution_enabled:
            raise ValueError(
                "execution_connector requires testnet execution"
            )
        self.root = Path(root).expanduser().resolve(strict=False)
        self.trust_store = LivePublisherTrustStore.from_path(release_lock_path)
        self.state_store = BrokerStateStore(
            self.root,
            vault_backend=vault_backend,
            accounts_enabled=read_only_accounts_enabled,
        )
        self.state = self.state_store.load_or_create()
        if (
            not testnet_execution_enabled
            and any(
                account.permission == "read_trade"
                for account in self.state.accounts
            )
        ):
            raise broker_error(
                "LIVE_EXECUTION_DOWNGRADE_REQUIRED",
                "trade-capable account state requires kill before execution is disabled",
                fatal=True,
            )
        self.vault: CredentialVault
        if vault_backend == "fake":
            self.vault = FakeCredentialVault()
        elif vault_backend == "windows-dpapi":
            self.vault = WindowsDpapiCredentialVault(
                self.root / "vault-v1",
                context=self.state.broker_id.encode("ascii"),
            )
        else:
            raise broker_error(
                "LIVE_BROKER_VAULT_UNAVAILABLE",
                "Broker vault backend is unsupported",
                fatal=True,
            )
        if read_only_accounts_enabled and account_connector is None:
            from .okx_readonly import OkxDemoReadOnlyConnector

            account_connector = OkxDemoReadOnlyConnector(
                execution_scope=testnet_execution_enabled
            )
        expected_connector_id = (
            OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
            if testnet_execution_enabled
            else OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
        )
        if account_connector is not None and (
            account_connector.connector_id
            != expected_connector_id
            or account_connector.network_method_count != 2
        ):
            raise broker_error(
                "LIVE_ACCOUNT_CONNECTOR_REJECTED",
                "read-only account connector does not match the pinned contract",
                fatal=True,
            )
        if reconciliation_shadow_enabled and reconciliation_connector is None:
            from .okx_readonly import OkxDemoOrderQueryConnector

            reconciliation_connector = OkxDemoOrderQueryConnector(
                execution_scope=testnet_execution_enabled
            )
        if reconciliation_connector is not None and (
            reconciliation_connector.connector_id
            != expected_connector_id
            or reconciliation_connector.network_method_count != 1
        ):
            raise broker_error(
                "LIVE_SHADOW_CONNECTOR_REJECTED",
                "reconciliation connector does not match the pinned contract",
                fatal=True,
            )
        if testnet_execution_enabled and execution_connector is None:
            from .okx_execution import OkxDemoSpotExecutionConnector

            execution_connector = OkxDemoSpotExecutionConnector()
        if execution_connector is not None and (
            execution_connector.connector_id
            != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
            or execution_connector.network_method_count != 2
        ):
            raise broker_error(
                "LIVE_EXECUTION_CONNECTOR_REJECTED",
                "execution connector does not match the pinned Demo contract",
                fatal=True,
            )
        self.read_only_accounts_enabled = read_only_accounts_enabled
        self.account_connector = account_connector
        self.reconciliation_shadow_enabled = reconciliation_shadow_enabled
        self.reconciliation_connector = reconciliation_connector
        self.shadow_journal = (
            ShadowOrderJournal(self.root, broker_id=self.state.broker_id)
            if reconciliation_shadow_enabled
            else None
        )
        self.native_control_enabled = native_control_enabled
        self.testnet_execution_enabled = testnet_execution_enabled
        self.execution_connector = execution_connector
        self.control_ledger = (
            LiveControlLedger(
                self.root,
                broker_id=self.state.broker_id,
                policy_epoch=self.state.policy_epoch,
                testnet_execution_enabled=testnet_execution_enabled,
            )
            if native_control_enabled
            else None
        )
        self.execution_ledger = (
            LiveExecutionLedger(
                self.root,
                broker_id=self.state.broker_id,
            )
            if testnet_execution_enabled
            else None
        )
        self._session_id: str | None = None
        self._expected_sequence = 1
        self.shutdown_requested = False
        self._reconcile_vault()

    @property
    def policy_epoch(self) -> int:
        return self.state.policy_epoch

    @property
    def expected_sequence(self) -> int:
        return self._expected_sequence

    def _network_method_count(self) -> int:
        return (
            (
                self.account_connector.network_method_count
                if self.account_connector is not None
                else 0
            )
            + (
                self.reconciliation_connector.network_method_count
                if self.reconciliation_connector is not None
                else 0
            )
            + (
                self.execution_connector.network_method_count
                if self.execution_connector is not None
                else 0
            )
        )

    def _shadow_summary(self) -> dict[str, int]:
        if self.shadow_journal is None:
            return {"journalCount": 0, "unresolvedCount": 0}
        return self.shadow_journal.summary()

    def _execution_summary(self) -> dict[str, int]:
        if self.execution_ledger is None:
            return {"executionCount": 0, "executionUnresolvedCount": 0}
        status = self.execution_ledger.status()
        return {
            "executionCount": status["orderCount"],
            "executionUnresolvedCount": status["unresolvedCount"],
        }

    def _reconcile_vault(self) -> None:
        available = self.vault.list_record_ids()
        self.state = self.state_store.without_missing_records(
            self.state,
            available,
        )
        active = {item.record_id for item in self.state.credentials}
        pending = set(self.state.pending_deletes)
        orphans = available - active - pending
        if orphans:
            updated = replace(
                self.state,
                pending_deletes=tuple(sorted(pending | orphans)),
            )
            self.state_store.write(updated)
            self.state = updated
        self._cleanup_pending_deletes()

    def _cleanup_pending_deletes(self) -> None:
        remaining: list[str] = []
        for record_id in self.state.pending_deletes:
            try:
                self.vault.delete(record_id)
            except LiveBrokerError:
                remaining.append(record_id)
        pending = tuple(sorted(remaining))
        if pending != self.state.pending_deletes:
            updated = replace(self.state, pending_deletes=pending)
            self.state_store.write(updated)
            self.state = updated

    def _bootstrap(self, request: BrokerRequest) -> BrokerResponse:
        if (
            self._session_id is not None
            or request.sequence != 1
            or request.method != METHOD_BOOTSTRAP
            or request.policy_epoch != 0
        ):
            raise broker_error(
                "LIVE_BROKER_BOOTSTRAP_REJECTED",
                "Broker bootstrap must be the first private-pipe request",
                fatal=True,
            )
        _exact_params(request.params, set(), "foundation.bootstrap params")
        self._session_id = request.session_id
        self._expected_sequence = 2
        shadow = self._shadow_summary()
        execution = self._execution_summary()
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "sessionDigest": _sha256_text(request.session_id),
                "vaultBackend": self.vault.backend_name,
                "credentialCount": len(self.state.credentials),
                "accountCount": len(self.state.accounts),
                "readOnlyAccountsEnabled": self.read_only_accounts_enabled,
                "reconciliationShadowEnabled": (
                    self.reconciliation_shadow_enabled
                ),
                "testnetExecutionEnabled": self.testnet_execution_enabled,
                **shadow,
                **execution,
            },
        )

    def _authenticate(self, request: BrokerRequest) -> None:
        if self._session_id is None:
            raise broker_error(
                "LIVE_BROKER_BOOTSTRAP_REQUIRED",
                "Broker private session has not been bootstrapped",
                fatal=True,
            )
        if request.session_id != self._session_id:
            raise broker_error(
                "LIVE_BROKER_SESSION_REJECTED",
                "Broker request session does not match the inherited pipe",
                fatal=True,
            )
        if request.sequence != self._expected_sequence:
            raise broker_error(
                "LIVE_BROKER_SEQUENCE_REJECTED",
                "Broker request sequence is stale, replayed, or out of order",
                fatal=True,
                details={"expectedSequence": self._expected_sequence},
            )
        self._expected_sequence += 1
        if request.method == METHOD_BOOTSTRAP:
            raise broker_error(
                "LIVE_BROKER_BOOTSTRAP_REJECTED",
                "Broker session cannot be bootstrapped twice",
                fatal=True,
            )
        if request.policy_epoch != self.policy_epoch:
            raise broker_error(
                "LIVE_BROKER_POLICY_EPOCH_REJECTED",
                "Broker request policy epoch is stale or from the future",
                details={"currentPolicyEpoch": self.policy_epoch},
            )

    def handle(self, value: Any) -> BrokerResponse:
        request = BrokerRequest.from_wire(value)
        if self._session_id is None:
            return self._bootstrap(request)
        self._authenticate(request)
        if request.method == METHOD_HEALTH:
            return self._health(request)
        if request.method == METHOD_POLICY_ADVANCE:
            return self._advance_policy(request)
        if request.method == METHOD_CREDENTIAL_PUT:
            return self._put_credential(request)
        if request.method == METHOD_CREDENTIAL_DESCRIBE:
            return self._describe_credential(request)
        if request.method == METHOD_CREDENTIAL_REVOKE:
            return self._revoke_credential(request)
        if request.method == METHOD_ACCOUNT_DISCOVER:
            return self._discover_account(request)
        if request.method == METHOD_ACCOUNT_DESCRIBE:
            return self._describe_account(request)
        if request.method == METHOD_ACCOUNT_REBIND:
            return self._rebind_account(request)
        if request.method == METHOD_SHADOW_PREPARE:
            return self._prepare_shadow(request)
        if request.method == METHOD_SHADOW_DESCRIBE:
            return self._describe_shadow(request)
        if request.method == METHOD_SHADOW_RECONCILE:
            return self._reconcile_shadow(request)
        if request.method == METHOD_CONTROL_STATUS:
            return self._control_status(request)
        if request.method == METHOD_CONTROL_SET:
            return self._set_control(request)
        if request.method == METHOD_CONTROL_KILL:
            return self._kill_control(request)
        if request.method == METHOD_AUTHORITY_REVOKE:
            return self._revoke_authority(request)
        if request.method == METHOD_CONFIRMATION_PREVIEW:
            return self._preview_confirmation(request)
        if request.method == METHOD_CONFIRMATION_ISSUE:
            return self._issue_confirmation(request)
        if request.method == METHOD_CONFIRMATION_DESCRIBE:
            return self._describe_confirmation(request)
        if request.method == METHOD_CONFIRMATION_REVOKE:
            return self._revoke_confirmation(request)
        if request.method == METHOD_EXECUTION_DESCRIBE:
            return self._describe_execution(request)
        if request.method == METHOD_EXECUTION_SUBMIT:
            return self._submit_execution(request)
        if request.method == METHOD_EXECUTION_CANCEL:
            return self._cancel_execution(request)
        if request.method == METHOD_EXECUTION_RECONCILE:
            return self._reconcile_execution(request)
        if request.method == METHOD_AUDIT_EXPORT_PAGE:
            return self._audit_export_page(request)
        if request.method == METHOD_SHUTDOWN:
            return self._shutdown(request)
        raise broker_error(
            "LIVE_BROKER_METHOD_DENIED",
            "Broker method is not in the private allowlist",
            fatal=True,
        )

    def _health(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(request.params, set(), "foundation.health params")
        shadow = self._shadow_summary()
        execution = self._execution_summary()
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "status": (
                    "degraded"
                    if self.state.pending_deletes
                    else "ok"
                ),
                "vaultBackend": self.vault.backend_name,
                "credentialCount": len(self.state.credentials),
                "accountCount": len(self.state.accounts),
                "pendingDeleteCount": len(self.state.pending_deletes),
                "readOnlyAccountsEnabled": self.read_only_accounts_enabled,
                "reconciliationShadowEnabled": (
                    self.reconciliation_shadow_enabled
                ),
                "testnetExecutionEnabled": self.testnet_execution_enabled,
                **shadow,
                **execution,
                "networkMethods": self._network_method_count(),
            },
        )

    def _advance_policy(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"nextEpoch", "reason"},
            "policy.advance params",
        )
        next_epoch = request.params["nextEpoch"]
        if (
            isinstance(next_epoch, bool)
            or not isinstance(next_epoch, int)
            or next_epoch != self.policy_epoch + 1
        ):
            raise broker_error(
                "LIVE_BROKER_POLICY_ADVANCE_REJECTED",
                "policy epoch must advance by exactly one",
                details={"currentPolicyEpoch": self.policy_epoch},
            )
        _text(request.params["reason"], "policy.advance reason", maximum=128)
        result = self._advance_policy_state(next_epoch)
        return success_response(
            request.sequence,
            self.policy_epoch,
            result,
        )

    def _advance_policy_state(self, next_epoch: int) -> dict[str, Any]:
        record_ids = {item.record_id for item in self.state.credentials}
        account_count = len(self.state.accounts)
        pending = set(self.state.pending_deletes) | record_ids
        updated = BrokerPersistentState(
            broker_id=self.state.broker_id,
            vault_backend=self.state.vault_backend,
            policy_epoch=next_epoch,
            credentials=(),
            accounts=(),
            pending_deletes=tuple(sorted(pending)),
        )
        self.state_store.write(updated)
        self.state = updated
        self._cleanup_pending_deletes()
        return {
            "advanced": True,
            "revokedCredentialCount": len(record_ids),
            "revokedAccountCount": account_count,
            "pendingDeleteCount": len(self.state.pending_deletes),
        }

    def _put_credential(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"evidence", "label", "secretBase64"},
            "credential.put params",
        )
        if len(self.state.credentials) >= MAX_ACTIVE_CREDENTIALS:
            raise broker_error(
                "LIVE_BROKER_CREDENTIAL_LIMIT",
                "Broker active credential limit has been reached",
            )
        label = _text(
            request.params["label"],
            "credential.put label",
            maximum=128,
        )
        try:
            evidence = PublisherEvidence.from_wire(request.params["evidence"])
            self.trust_store.verify_evidence(evidence)
        except LiveTrustError as exc:
            raise broker_error(
                "LIVE_BROKER_PUBLISHER_REJECTED",
                "credential is not bound to this Host build",
                details={"trustCode": exc.code},
            ) from exc
        encoded = request.params["secretBase64"]
        if (
            not isinstance(encoded, str)
            or not encoded
            or len(encoded) > ((MAX_CREDENTIAL_BYTES + 2) // 3) * 4
        ):
            raise broker_error(
                "LIVE_BROKER_SECRET_INVALID",
                "credential secret encoding is invalid",
            )
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise broker_error(
                "LIVE_BROKER_SECRET_INVALID",
                "credential secret encoding is invalid",
            ) from exc
        secret = bytearray(decoded)
        del decoded
        if not 1 <= len(secret) <= MAX_CREDENTIAL_BYTES:
            wipe_secret(secret)
            raise broker_error(
                "LIVE_BROKER_SECRET_INVALID",
                "credential secret size is outside the supported range",
            )

        handle = f"cred_{secrets.token_urlsafe(32)}"
        record_id = uuid.uuid4().hex
        binding = CredentialBinding(
            record_id=record_id,
            handle_sha256=_sha256_text(handle),
            plugin_id=evidence.plugin_id,
            connector_id=evidence.connector_id,
            publisher_identity=evidence.publisher_identity,
            version=evidence.version,
            bundle_sha256=evidence.bundle_sha256,
            manifest_sha256=evidence.manifest_sha256,
            release_record_sha256=evidence.release_record_sha256,
            release_lock_sha256=evidence.release_lock_sha256,
            label=label,
            created_at=_utc_now(),
            policy_epoch=self.policy_epoch,
        )
        try:
            self.vault.store(record_id, secret)
        finally:
            wipe_secret(secret)
        try:
            updated = replace(
                self.state,
                credentials=(*self.state.credentials, binding),
            )
            self.state_store.write(updated)
        except BaseException:
            try:
                self.vault.delete(record_id)
            except LiveBrokerError:
                pass
            raise
        self.state = updated
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "credentialHandle": handle,
                **self._binding_metadata(binding),
            },
        )

    @staticmethod
    def _binding_metadata(binding: CredentialBinding) -> dict[str, Any]:
        return {
            "pluginId": binding.plugin_id,
            "connectorId": binding.connector_id,
            "publisherIdentity": binding.publisher_identity,
            "version": binding.version,
            "label": binding.label,
            "createdAt": binding.created_at,
            "createdPolicyEpoch": binding.policy_epoch,
        }

    def _handle(self, params: Mapping[str, Any], label: str) -> str:
        handle = _text(params["credentialHandle"], label, maximum=64)
        if _CREDENTIAL_HANDLE.fullmatch(handle) is None:
            raise broker_error(
                "LIVE_BROKER_CREDENTIAL_NOT_FOUND",
                "credential handle is unavailable",
            )
        return handle

    def _find_binding(self, handle: str) -> CredentialBinding | None:
        digest = _sha256_text(handle)
        return next(
            (
                binding
                for binding in self.state.credentials
                if binding.handle_sha256 == digest
            ),
            None,
        )

    def _describe_credential(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"credentialHandle"},
            "credential.describe params",
        )
        handle = self._handle(
            request.params,
            "credential.describe credentialHandle",
        )
        binding = self._find_binding(handle)
        if binding is None or binding.policy_epoch != self.policy_epoch:
            raise broker_error(
                "LIVE_BROKER_CREDENTIAL_NOT_FOUND",
                "credential handle is unavailable",
            )
        return success_response(
            request.sequence,
            self.policy_epoch,
            self._binding_metadata(binding),
        )

    def _revoke_credential(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"credentialHandle"},
            "credential.revoke params",
        )
        handle = self._handle(
            request.params,
            "credential.revoke credentialHandle",
        )
        if self.control_ledger is not None:
            next_epoch = self.policy_epoch + 1
            self._advance_policy_state(next_epoch)
            self.control_ledger.force_killed(
                policy_epoch=next_epoch,
                reason="credential-revoked",
                event_type="authority-revoked",
                scope_type="credential",
                subject_sha256=_sha256_text(handle),
            )
            return success_response(
                request.sequence,
                self.policy_epoch,
                {
                    "revoked": True,
                    "pendingDeleteCount": len(self.state.pending_deletes),
                },
            )
        binding = self._find_binding(handle)
        if binding is None:
            return success_response(
                request.sequence,
                self.policy_epoch,
                {"revoked": True},
            )
        retained = tuple(
            item
            for item in self.state.credentials
            if item.handle_sha256 != binding.handle_sha256
        )
        pending = tuple(
            sorted(set(self.state.pending_deletes) | {binding.record_id})
        )
        updated = replace(
            self.state,
            credentials=retained,
            accounts=tuple(
                replace(item, status="credential-revoked")
                if (
                    item.status == "active"
                    and item.credential_handle_sha256
                    == binding.handle_sha256
                )
                else item
                for item in self.state.accounts
            ),
            pending_deletes=pending,
        )
        self.state_store.write(updated)
        self.state = updated
        self._cleanup_pending_deletes()
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "revoked": True,
                "pendingDeleteCount": len(self.state.pending_deletes),
            },
        )

    def _require_account_connector(self) -> ReadOnlyAccountConnector:
        connector = self.account_connector
        if not self.read_only_accounts_enabled or connector is None:
            raise broker_error(
                "LIVE_ACCOUNTS_DISABLED",
                "read-only Live accounts are disabled",
            )
        return connector

    def _account_credential(
        self,
        params: Mapping[str, Any],
        label: str,
    ) -> CredentialBinding:
        handle = self._handle(params, label)
        binding = self._find_binding(handle)
        if (
            binding is None
            or binding.policy_epoch != self.policy_epoch
            or binding.connector_id
            != (
                OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
                if self.testnet_execution_enabled
                else OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
            )
        ):
            raise broker_error(
                "LIVE_ACCOUNT_CREDENTIAL_UNAVAILABLE",
                "read-only account credential is unavailable",
            )
        self._verify_credential_binding(binding)
        return binding

    def _verify_credential_binding(
        self,
        binding: CredentialBinding,
    ) -> None:
        try:
            self.trust_store.verify_binding_metadata(
                plugin_id=binding.plugin_id,
                connector_id=binding.connector_id,
                publisher_identity=binding.publisher_identity,
                version=binding.version,
                bundle_sha256=binding.bundle_sha256,
                manifest_sha256=binding.manifest_sha256,
                release_record_sha256=binding.release_record_sha256,
                release_lock_sha256=binding.release_lock_sha256,
            )
        except LiveTrustError as exc:
            raise broker_error(
                "LIVE_ACCOUNT_PUBLISHER_REJECTED",
                "read-only account credential is not valid for this Host build",
                details={"trustCode": exc.code},
            ) from exc

    def _discover_proof(
        self,
        binding: CredentialBinding,
    ) -> ReadOnlyAccountProof:
        connector = self._require_account_connector()
        with self.vault.open_secret(binding.record_id) as secret:
            proof = connector.discover(secret)
        expected_permission = (
            "read_trade"
            if self.testnet_execution_enabled
            else "read_only"
        )
        if (
            proof.connector_id != binding.connector_id
            or proof.venue != "okx"
            or proof.environment != "demo"
            or proof.product_scope != "spot"
            or proof.permission != expected_permission
        ):
            raise broker_error(
                "LIVE_ACCOUNT_PROOF_REJECTED",
                "read-only account proof does not match the credential scope",
                fatal=True,
            )
        return proof

    def _stable_account_ref(self, canonical_account_sha256: str) -> str:
        token = base64.urlsafe_b64encode(
            hmac.digest(
                self.state.broker_id.encode("ascii"),
                canonical_account_sha256.encode("ascii"),
                hashlib.sha256,
            )
        ).decode("ascii")
        return f"acct_{token.rstrip('=')}"

    @staticmethod
    def _account_metadata(binding: AccountBinding) -> dict[str, Any]:
        return {
            "pluginId": binding.plugin_id,
            "connectorId": binding.connector_id,
            "publisherIdentity": binding.publisher_identity,
            "version": binding.version,
            "venue": binding.venue,
            "environment": binding.environment,
            "productScope": binding.product_scope,
            "permission": binding.permission,
            "accountMode": binding.account_mode,
            "positionMode": binding.position_mode,
            "status": binding.status,
            "credentialGeneration": binding.credential_generation,
            "assetCount": binding.asset_count,
            "createdAt": binding.created_at,
            "refreshedAt": binding.refreshed_at,
            "createdPolicyEpoch": binding.policy_epoch,
        }

    def _account_handle(
        self,
        params: Mapping[str, Any],
        label: str,
    ) -> str:
        handle = _text(params["accountRef"], label, maximum=64)
        if _ACCOUNT_HANDLE.fullmatch(handle) is None:
            raise broker_error(
                "LIVE_ACCOUNT_NOT_FOUND",
                "read-only account reference is unavailable",
            )
        return handle

    def _find_account(self, account_ref: str) -> AccountBinding | None:
        digest = _sha256_text(account_ref)
        return next(
            (
                binding
                for binding in self.state.accounts
                if binding.account_handle_sha256 == digest
            ),
            None,
        )

    def _current_account_credential(
        self,
        account: AccountBinding,
    ) -> CredentialBinding:
        credential = next(
            (
                item
                for item in self.state.credentials
                if item.handle_sha256
                == account.credential_handle_sha256
            ),
            None,
        )
        if (
            account.status != "active"
            or credential is None
            or credential.policy_epoch != self.policy_epoch
            or credential.connector_id != account.connector_id
        ):
            raise broker_error(
                "LIVE_SHADOW_CREDENTIAL_UNAVAILABLE",
                "shadow reconciliation credential is unavailable",
            )
        self._verify_credential_binding(credential)
        return credential

    def _discover_account(self, request: BrokerRequest) -> BrokerResponse:
        self._require_account_connector()
        _exact_params(
            request.params,
            {"credentialHandle"},
            "account.discover params",
        )
        if len(self.state.accounts) >= MAX_ACCOUNT_BINDINGS:
            raise broker_error(
                "LIVE_ACCOUNT_LIMIT",
                "Broker account binding limit has been reached",
            )
        credential = self._account_credential(
            request.params,
            "account.discover credentialHandle",
        )
        proof = self._discover_proof(credential)
        if any(
            item.canonical_account_sha256
            == proof.canonical_account_sha256
            for item in self.state.accounts
        ):
            raise broker_error(
                "LIVE_ACCOUNT_ALREADY_BOUND",
                "canonical read-only account is already bound",
            )
        account_ref = self._stable_account_ref(
            proof.canonical_account_sha256
        )
        binding = AccountBinding(
            account_handle_sha256=_sha256_text(account_ref),
            canonical_account_sha256=proof.canonical_account_sha256,
            credential_handle_sha256=credential.handle_sha256,
            plugin_id=credential.plugin_id,
            connector_id=credential.connector_id,
            publisher_identity=credential.publisher_identity,
            version=credential.version,
            bundle_sha256=credential.bundle_sha256,
            manifest_sha256=credential.manifest_sha256,
            release_record_sha256=credential.release_record_sha256,
            release_lock_sha256=credential.release_lock_sha256,
            venue=proof.venue,
            environment=proof.environment,
            product_scope=proof.product_scope,
            permission=proof.permission,
            account_mode=proof.account_mode,
            position_mode=proof.position_mode,
            status="active",
            credential_generation=1,
            asset_count=proof.asset_count,
            created_at=proof.observed_at,
            refreshed_at=proof.observed_at,
            policy_epoch=self.policy_epoch,
        )
        updated = replace(
            self.state,
            accounts=(*self.state.accounts, binding),
        )
        self.state_store.write(updated)
        self.state = updated
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "accountRef": account_ref,
                **self._account_metadata(binding),
            },
        )

    def _describe_account(self, request: BrokerRequest) -> BrokerResponse:
        self._require_account_connector()
        _exact_params(
            request.params,
            {"accountRef"},
            "account.describe params",
        )
        account_ref = self._account_handle(
            request.params,
            "account.describe accountRef",
        )
        binding = self._find_account(account_ref)
        if binding is None or binding.policy_epoch != self.policy_epoch:
            raise broker_error(
                "LIVE_ACCOUNT_NOT_FOUND",
                "read-only account reference is unavailable",
            )
        return success_response(
            request.sequence,
            self.policy_epoch,
            self._account_metadata(binding),
        )

    def _rebind_account(self, request: BrokerRequest) -> BrokerResponse:
        self._require_account_connector()
        _exact_params(
            request.params,
            {"accountRef", "credentialHandle"},
            "account.rebind params",
        )
        account_ref = self._account_handle(
            request.params,
            "account.rebind accountRef",
        )
        existing = self._find_account(account_ref)
        if existing is None or existing.policy_epoch != self.policy_epoch:
            raise broker_error(
                "LIVE_ACCOUNT_NOT_FOUND",
                "read-only account reference is unavailable",
            )
        credential = self._account_credential(
            request.params,
            "account.rebind credentialHandle",
        )
        connector_upgrade = (
            self.testnet_execution_enabled
            and existing.connector_id
            == OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
            and credential.connector_id
            == OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
        )
        if (
            credential.handle_sha256 == existing.credential_handle_sha256
            or credential.plugin_id != existing.plugin_id
            or (
                credential.connector_id != existing.connector_id
                and not connector_upgrade
            )
            or credential.publisher_identity != existing.publisher_identity
        ):
            raise broker_error(
                "LIVE_ACCOUNT_REBIND_REJECTED",
                "read-only account credential cannot rebind this account",
            )
        proof = self._discover_proof(credential)
        if (
            proof.canonical_account_sha256
            != existing.canonical_account_sha256
        ):
            raise broker_error(
                "LIVE_ACCOUNT_REBIND_REJECTED",
                "read-only credential belongs to another canonical account",
            )
        rebound = replace(
            existing,
            credential_handle_sha256=credential.handle_sha256,
            connector_id=credential.connector_id,
            version=credential.version,
            bundle_sha256=credential.bundle_sha256,
            manifest_sha256=credential.manifest_sha256,
            release_record_sha256=credential.release_record_sha256,
            release_lock_sha256=credential.release_lock_sha256,
            position_mode=proof.position_mode,
            permission=proof.permission,
            status="active",
            credential_generation=existing.credential_generation + 1,
            asset_count=proof.asset_count,
            refreshed_at=proof.observed_at,
        )
        updated = replace(
            self.state,
            accounts=tuple(
                rebound
                if item.account_handle_sha256
                == existing.account_handle_sha256
                else item
                for item in self.state.accounts
            ),
        )
        self.state_store.write(updated)
        self.state = updated
        return success_response(
            request.sequence,
            self.policy_epoch,
            self._account_metadata(rebound),
        )

    def _require_shadow_journal(self) -> ShadowOrderJournal:
        journal = self.shadow_journal
        if (
            not self.reconciliation_shadow_enabled
            or journal is None
            or self.reconciliation_connector is None
        ):
            raise broker_error(
                "LIVE_RECONCILIATION_SHADOW_DISABLED",
                "query-only reconciliation shadow is disabled",
            )
        return journal

    def _shadow_account(
        self,
        params: Mapping[str, Any],
        label: str,
    ) -> tuple[str, AccountBinding, CredentialBinding]:
        account_ref = self._account_handle(params, label)
        account = self._find_account(account_ref)
        if (
            account is None
            or account.policy_epoch != self.policy_epoch
            or account.status != "active"
        ):
            raise broker_error(
                "LIVE_SHADOW_ACCOUNT_UNAVAILABLE",
                "shadow canonical account is unavailable",
            )
        credential = self._current_account_credential(account)
        return account_ref, account, credential

    @staticmethod
    def _shadow_ref(
        params: Mapping[str, Any],
        label: str,
    ) -> str:
        return _text(params["shadowRef"], label, maximum=64)

    def _prepare_shadow(self, request: BrokerRequest) -> BrokerResponse:
        journal = self._require_shadow_journal()
        _exact_params(
            request.params,
            {"accountRef", "intent"},
            "shadow.prepare params",
        )
        account_ref, account, _credential = self._shadow_account(
            request.params,
            "shadow.prepare accountRef",
        )
        try:
            intent = ShadowOrderIntent.from_wire(request.params["intent"])
        except ValueError as exc:
            raise broker_error(
                "LIVE_SHADOW_INTENT_INVALID",
                "shadow intent does not match the fixed Spot limit contract",
            ) from exc
        shadow_ref, record = journal.prepare(
            account_ref=account_ref,
            account=account,
            intent=intent,
            policy_epoch=self.policy_epoch,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "shadowRef": shadow_ref,
                **record.metadata(),
            },
        )

    def _describe_shadow(self, request: BrokerRequest) -> BrokerResponse:
        journal = self._require_shadow_journal()
        _exact_params(
            request.params,
            {"shadowRef"},
            "shadow.describe params",
        )
        shadow_ref = self._shadow_ref(
            request.params,
            "shadow.describe shadowRef",
        )
        record = journal.describe(shadow_ref)
        return success_response(
            request.sequence,
            self.policy_epoch,
            record.metadata(),
        )

    def _reconcile_shadow(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"accountRef", "shadowRef"},
            "shadow.reconcile params",
        )
        account_ref, account, credential = self._shadow_account(
            request.params,
            "shadow.reconcile accountRef",
        )
        shadow_ref = self._shadow_ref(
            request.params,
            "shadow.reconcile shadowRef",
        )
        observed = self._perform_reconcile(
            account_ref=account_ref,
            account=account,
            credential=credential,
            shadow_ref=shadow_ref,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            observed.metadata(),
        )

    def _perform_reconcile(
        self,
        *,
        account_ref: str,
        account: AccountBinding,
        credential: CredentialBinding,
        shadow_ref: str,
    ) -> Any:
        journal = self._require_shadow_journal()
        connector = self.reconciliation_connector
        assert connector is not None
        querying = journal.begin_reconcile(
            shadow_ref,
            account_ref=account_ref,
            account=account,
        )
        try:
            with self.vault.open_secret(credential.record_id) as secret:
                proof = connector.query_order(
                    secret,
                    instrument_id=querying.instrument_id,
                    client_order_id=querying.client_order_id,
                )
        except LiveBrokerError as exc:
            journal.fail_reconcile(shadow_ref, error_code=exc.code)
            execution = (
                self.execution_ledger.find(shadow_ref)
                if self.execution_ledger is not None
                else None
            )
            if execution is not None:
                self.execution_ledger.fail_query(
                    shadow_ref,
                    error_code=exc.code,
                )
            raise
        observed = journal.complete_reconcile(shadow_ref, proof)
        execution = (
            self.execution_ledger.find(shadow_ref)
            if self.execution_ledger is not None
            else None
        )
        if execution is not None:
            self.execution_ledger.observe_query(shadow_ref, proof)
        return observed

    def _require_control_ledger(self) -> LiveControlLedger:
        ledger = self.control_ledger
        if not self.native_control_enabled or ledger is None:
            raise broker_error(
                "LIVE_NATIVE_CONTROL_DISABLED",
                "Host-native Live control is disabled",
            )
        return ledger

    def _require_execution_ledger(self) -> LiveExecutionLedger:
        ledger = self.execution_ledger
        if (
            not self.testnet_execution_enabled
            or ledger is None
            or self.execution_connector is None
        ):
            raise broker_error(
                "LIVE_TESTNET_EXECUTION_DISABLED",
                "OKX Demo Spot execution is disabled",
            )
        return ledger

    def _control_status(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(request.params, set(), "control.status params")
        return success_response(
            request.sequence,
            self.policy_epoch,
            ledger.status(),
        )

    def _set_control(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(
            request.params,
            {"mode", "reason", "acknowledgeKill"},
            "control.set params",
        )
        mode = request.params["mode"]
        acknowledge = request.params["acknowledgeKill"]
        if mode not in {"armed", "disarmed"} or not isinstance(
            acknowledge, bool
        ):
            raise broker_error(
                "LIVE_CONTROL_PARAMS_INVALID",
                "control mode or acknowledgement is invalid",
            )
        reason = _text(
            request.params["reason"],
            "control.set reason",
            maximum=128,
        )
        status = ledger.set_mode(
            mode,
            policy_epoch=self.policy_epoch,
            reason=reason,
            acknowledge_kill=acknowledge,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            status,
        )

    def _kill_control(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(request.params, {"reason"}, "control.kill params")
        reason = _text(
            request.params["reason"],
            "control.kill reason",
            maximum=128,
        )
        next_epoch = self.policy_epoch + 1
        revoked = self._advance_policy_state(next_epoch)
        status = ledger.force_killed(
            policy_epoch=next_epoch,
            reason=reason,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            {**status, "revocation": revoked},
        )

    def _revoke_authority(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(
            request.params,
            {"scopeType", "subject", "reason"},
            "authority.revoke params",
        )
        scope_type = request.params["scopeType"]
        if scope_type not in {
            "grant",
            "plugin",
            "publisher",
            "credential",
        }:
            raise broker_error(
                "LIVE_CONTROL_PARAMS_INVALID",
                "authority revoke scope is invalid",
            )
        subject = _text(
            request.params["subject"],
            "authority.revoke subject",
            maximum=256,
        )
        if (
            scope_type == "credential"
            and _CREDENTIAL_HANDLE.fullmatch(subject) is None
        ):
            raise broker_error(
                "LIVE_CONTROL_PARAMS_INVALID",
                "credential revoke subject is invalid",
            )
        reason = _text(
            request.params["reason"],
            "authority.revoke reason",
            maximum=128,
        )
        next_epoch = self.policy_epoch + 1
        revoked = self._advance_policy_state(next_epoch)
        status = ledger.force_killed(
            policy_epoch=next_epoch,
            reason=reason,
            event_type="authority-revoked",
            scope_type=scope_type,
            subject_sha256=_sha256_text(subject),
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            {**status, "scopeType": scope_type, "revocation": revoked},
        )

    def _confirmation_metadata(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
    ) -> dict[str, Any]:
        ledger = self._require_control_ledger()
        journal = self._require_shadow_journal()
        if ledger.mode != "armed":
            raise broker_error(
                "LIVE_CONTROL_NOT_ARMED",
                "Live control must be armed before confirmation review",
            )
        account = self._find_account(account_ref)
        if (
            account is None
            or account.status != "active"
            or account.policy_epoch != self.policy_epoch
        ):
            raise broker_error(
                "LIVE_CONFIRMATION_ACCOUNT_UNAVAILABLE",
                "confirmation account binding is unavailable",
            )
        self._current_account_credential(account)
        record = journal.describe(shadow_ref)
        if (
            record.created_policy_epoch != self.policy_epoch
            or record.account_handle_sha256 != _sha256_text(account_ref)
            or record.canonical_account_sha256
            != account.canonical_account_sha256
            or record.credential_handle_sha256
            != account.credential_handle_sha256
            or record.plugin_id != account.plugin_id
            or record.connector_id != account.connector_id
            or record.publisher_identity != account.publisher_identity
            or record.version != account.version
        ):
            raise broker_error(
                "LIVE_CONFIRMATION_INTENT_UNAVAILABLE",
                "shadow intent is stale, reconciled, or bound to another account",
            )
        common = {
            "schemaVersion": "candlescope.live-confirmation-preview/1",
            "intentSha256": record.intent_sha256,
            "pluginId": record.plugin_id,
            "connectorId": record.connector_id,
            "publisherIdentity": record.publisher_identity,
            "version": record.version,
            "clientOrderId": record.client_order_id,
            "instrumentId": record.instrument_id,
            "side": record.side,
            "orderType": record.order_type,
            "quantity": record.quantity,
            "limitPrice": record.limit_price,
            "policyEpoch": self.policy_epoch,
            "controlGeneration": ledger.generation,
            "liveSubmitAvailable": False,
            "liveCancelAvailable": False,
        }
        if not self.testnet_execution_enabled:
            if (
                record.state != "prepared"
                or record.reconcile_attempt_count != 0
            ):
                raise broker_error(
                    "LIVE_CONFIRMATION_INTENT_UNAVAILABLE",
                    "shadow intent is stale, reconciled, or bound to another account",
                )
            return common
        execution_ledger = self._require_execution_ledger()
        if (
            account.connector_id
            != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
            or account.permission != "read_trade"
            or record.connector_id
            != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
            or record.instrument_id != DEMO_EXECUTION_INSTRUMENT
        ):
            raise broker_error(
                "LIVE_EXECUTION_ACCOUNT_UNAVAILABLE",
                "confirmation account is not execution eligible",
            )
        execution = execution_ledger.find(shadow_ref)
        if execution is not None:
            if (
                execution.order_intent_sha256 != record.intent_sha256
                or execution.account_handle_sha256
                != record.account_handle_sha256
                or execution.canonical_account_sha256
                != record.canonical_account_sha256
                or execution.plugin_id != record.plugin_id
                or execution.connector_id != record.connector_id
                or execution.publisher_identity
                != record.publisher_identity
                or execution.client_order_id != record.client_order_id
            ):
                raise broker_error(
                    "LIVE_EXECUTION_IDENTITY_MISMATCH",
                    "execution record does not match the durable shadow",
                    fatal=True,
                )
            if (
                record.state in ORDER_QUERY_STATES
                and execution.state != record.state
                and record.venue_order_id is not None
            ):
                execution = execution_ledger.observe_query(
                    shadow_ref,
                    OrderQueryProof(
                        connector_id=record.connector_id,
                        instrument_id=record.instrument_id,
                        client_order_id=record.client_order_id,
                        venue_order_id=record.venue_order_id,
                        state=record.state,
                        accumulated_fill_size=record.accumulated_fill_size,
                        average_price=record.average_price,
                        observed_at=record.updated_at,
                    ),
                )
        if execution is None:
            if record.state != "prepared" or record.reconcile_attempt_count != 0:
                raise broker_error(
                    "LIVE_CONFIRMATION_ACTION_UNAVAILABLE",
                    "only a never-dispatched prepared shadow can be submitted",
                )
            unresolved_count, unresolved_notional = (
                execution_ledger.unresolved_summary()
            )
            notional, risk_sha256 = execution_risk_decision(
                instrument_id=record.instrument_id,
                side=record.side,
                order_type=record.order_type,
                quantity=record.quantity,
                limit_price=record.limit_price,
                unresolved_count=unresolved_count,
                unresolved_notional=unresolved_notional,
            )
            action = "submit"
            execution_state = "not-started"
        else:
            if (
                execution.state not in {"live", "partially_filled"}
                or record.state != execution.state
                or record.venue_order_id is None
            ):
                raise broker_error(
                    "LIVE_CONFIRMATION_ACTION_UNAVAILABLE",
                    "execution requires reconciliation before another action",
                    details={"executionState": execution.state},
                )
            action = "cancel"
            execution_state = execution.state
            notional = execution.notional
            risk_sha256 = _sha256_text(
                _canonical_json(
                    {
                        "schemaVersion": "candlescope.live-demo-cancel-risk/1",
                        "allow": True,
                        "action": "cancel",
                        "environment": "demo",
                        "instrumentId": execution.instrument_id,
                        "clientOrderId": execution.client_order_id,
                        "orderIntentSha256": execution.order_intent_sha256,
                        "state": execution.state,
                        "policyEpoch": self.policy_epoch,
                        "controlGeneration": ledger.generation,
                    }
                )
            )
        confirmation_sha256 = _sha256_text(
            _canonical_json(
                {
                    "schemaVersion": (
                        "candlescope.live-execution-confirmation/1"
                    ),
                    "action": action,
                    "accountHandleSha256": _sha256_text(account_ref),
                    "shadowHandleSha256": _sha256_text(shadow_ref),
                    "orderIntentSha256": record.intent_sha256,
                    "executionState": execution_state,
                    "riskDecisionSha256": risk_sha256,
                    "policyEpoch": self.policy_epoch,
                    "controlGeneration": ledger.generation,
                }
            )
        )
        return {
            **common,
            "schemaVersion": "candlescope.live-confirmation-preview/2",
            "intentSha256": confirmation_sha256,
            "orderIntentSha256": record.intent_sha256,
            "action": action,
            "executionState": execution_state,
            "notional": notional,
            "riskDecisionSha256": risk_sha256,
            "hardLimits": {
                "instrumentId": DEMO_EXECUTION_INSTRUMENT,
                "maxOrderNotional": str(MAX_DEMO_ORDER_NOTIONAL),
                "maxUnresolvedOrders": MAX_DEMO_UNRESOLVED_ORDERS,
                "maxUnresolvedNotional": str(
                    MAX_DEMO_UNRESOLVED_NOTIONAL
                ),
            },
            "liveSubmitAvailable": action == "submit",
            "liveCancelAvailable": action == "cancel",
        }

    def _preview_confirmation(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(
            request.params,
            {"accountRef", "shadowRef"},
            "confirmation.preview params",
        )
        account_ref = self._account_handle(
            request.params,
            "confirmation.preview accountRef",
        )
        shadow_ref = self._shadow_ref(
            request.params,
            "confirmation.preview shadowRef",
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            self._confirmation_metadata(
                account_ref=account_ref,
                shadow_ref=shadow_ref,
            ),
        )

    def _issue_confirmation(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(
            request.params,
            {
                "accountRef",
                "shadowRef",
                "expectedIntentSha256",
                "expectedPolicyEpoch",
                "expectedControlGeneration",
                "ttlSeconds",
            },
            "confirmation.issue params",
        )
        account_ref = self._account_handle(
            request.params,
            "confirmation.issue accountRef",
        )
        shadow_ref = self._shadow_ref(
            request.params,
            "confirmation.issue shadowRef",
        )
        preview = self._confirmation_metadata(
            account_ref=account_ref,
            shadow_ref=shadow_ref,
        )
        expected_epoch = request.params["expectedPolicyEpoch"]
        expected_generation = request.params["expectedControlGeneration"]
        if (
            request.params["expectedIntentSha256"] != preview["intentSha256"]
            or isinstance(expected_epoch, bool)
            or not isinstance(expected_epoch, int)
            or expected_epoch != preview["policyEpoch"]
            or isinstance(expected_generation, bool)
            or not isinstance(expected_generation, int)
            or expected_generation != preview["controlGeneration"]
        ):
            raise broker_error(
                "LIVE_CONFIRMATION_STALE",
                "confirmation preview is stale",
            )
        metadata = {
            key: preview[key]
            for key in (
                "intentSha256",
                "pluginId",
                "connectorId",
                "publisherIdentity",
                "version",
                "clientOrderId",
                "instrumentId",
                "side",
                "orderType",
                "quantity",
                "limitPrice",
                "policyEpoch",
            )
        }
        receipt_ref, receipt = ledger.issue(
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            metadata=metadata,
            ttl_seconds=request.params["ttlSeconds"],
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "receiptRef": receipt_ref,
                **receipt.public_wire(),
                **(
                    {
                        "schemaVersion": "candlescope.live-confirmation/2",
                        "orderIntentSha256": preview[
                            "orderIntentSha256"
                        ],
                        "action": preview["action"],
                        "executionState": preview["executionState"],
                        "notional": preview["notional"],
                        "riskDecisionSha256": preview[
                            "riskDecisionSha256"
                        ],
                    }
                    if self.testnet_execution_enabled
                    else {}
                ),
                "liveSubmitAvailable": preview[
                    "liveSubmitAvailable"
                ],
                "liveCancelAvailable": preview[
                    "liveCancelAvailable"
                ],
            },
        )

    def _describe_confirmation(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(
            request.params,
            {"receiptRef"},
            "confirmation.describe params",
        )
        receipt_ref = _text(
            request.params["receiptRef"],
            "confirmation.describe receiptRef",
            maximum=64,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            ledger.describe(receipt_ref).public_wire(),
        )

    def _revoke_confirmation(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        _exact_params(
            request.params,
            {"receiptRef", "reason"},
            "confirmation.revoke params",
        )
        receipt_ref = _text(
            request.params["receiptRef"],
            "confirmation.revoke receiptRef",
            maximum=64,
        )
        reason = _text(
            request.params["reason"],
            "confirmation.revoke reason",
            maximum=128,
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            ledger.revoke(receipt_ref, reason=reason).public_wire(),
        )

    def _execution_expected(
        self,
        params: Mapping[str, Any],
        *,
        label: str,
        action: str,
    ) -> tuple[
        str,
        str,
        str,
        AccountBinding,
        CredentialBinding,
        Any,
        dict[str, Any],
    ]:
        account_ref, account, credential = self._shadow_account(
            params,
            f"{label} accountRef",
        )
        shadow_ref = self._shadow_ref(
            params,
            f"{label} shadowRef",
        )
        receipt_ref = _text(
            params["receiptRef"],
            f"{label} receiptRef",
            maximum=64,
        )
        if account.permission != "read_trade" or (
            account.connector_id
            != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
        ):
            raise broker_error(
                "LIVE_EXECUTION_ACCOUNT_UNAVAILABLE",
                "execution account is not bound to the Demo Trade scope",
            )
        preview = self._confirmation_metadata(
            account_ref=account_ref,
            shadow_ref=shadow_ref,
        )
        expected_epoch = params["expectedPolicyEpoch"]
        expected_generation = params["expectedControlGeneration"]
        if (
            preview.get("action") != action
            or params["expectedConfirmationSha256"]
            != preview["intentSha256"]
            or isinstance(expected_epoch, bool)
            or not isinstance(expected_epoch, int)
            or expected_epoch != self.policy_epoch
            or isinstance(expected_generation, bool)
            or not isinstance(expected_generation, int)
            or expected_generation != preview["controlGeneration"]
        ):
            raise broker_error(
                "LIVE_EXECUTION_CONFIRMATION_STALE",
                "execution confirmation preview is stale",
            )
        record = self._require_shadow_journal().describe(shadow_ref)
        return (
            account_ref,
            shadow_ref,
            receipt_ref,
            account,
            credential,
            record,
            preview,
        )

    def _consume_execution_receipt(
        self,
        *,
        receipt_ref: str,
        shadow_ref: str,
        account_ref: str,
        record: Any,
        preview: dict[str, Any],
    ) -> Any:
        ledger = self._require_control_ledger()
        return ledger.consume_for_execution(
            receipt_ref,
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            intent_sha256=preview["intentSha256"],
            plugin_id=record.plugin_id,
            publisher_identity=record.publisher_identity,
            connector_id=record.connector_id,
            policy_epoch=self.policy_epoch,
            control_generation=preview["controlGeneration"],
        )

    def _describe_execution(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_execution_ledger()
        _exact_params(
            request.params,
            {"shadowRef"},
            "execution.describe params",
        )
        shadow_ref = self._shadow_ref(
            request.params,
            "execution.describe shadowRef",
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            ledger.describe(shadow_ref).public_wire(),
        )

    def _submit_execution(self, request: BrokerRequest) -> BrokerResponse:
        execution_ledger = self._require_execution_ledger()
        connector = self.execution_connector
        assert connector is not None
        _exact_params(
            request.params,
            {
                "accountRef",
                "shadowRef",
                "receiptRef",
                "expectedConfirmationSha256",
                "expectedPolicyEpoch",
                "expectedControlGeneration",
            },
            "execution.submit params",
        )
        (
            account_ref,
            shadow_ref,
            receipt_ref,
            account,
            credential,
            record,
            preview,
        ) = self._execution_expected(
            request.params,
            label="execution.submit",
            action="submit",
        )
        receipt = self._consume_execution_receipt(
            receipt_ref=receipt_ref,
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            record=record,
            preview=preview,
        )
        started = execution_ledger.begin_submit(
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            metadata={
                "canonicalAccountSha256": (
                    account.canonical_account_sha256
                ),
                "credentialHandleSha256": (
                    account.credential_handle_sha256
                ),
                "pluginId": record.plugin_id,
                "connectorId": record.connector_id,
                "publisherIdentity": record.publisher_identity,
                "version": account.version,
                "clientOrderId": record.client_order_id,
                "orderIntentSha256": record.intent_sha256,
                "instrumentId": record.instrument_id,
                "side": record.side,
                "orderType": record.order_type,
                "quantity": record.quantity,
                "limitPrice": record.limit_price,
                "policyEpoch": self.policy_epoch,
                "controlGeneration": preview["controlGeneration"],
            },
            receipt_id=receipt.receipt_id,
            confirmation_sha256=preview["intentSha256"],
            risk_decision_sha256=preview["riskDecisionSha256"],
            notional=preview["notional"],
        )
        intent = ShadowOrderIntent(
            idempotency_key="intent_" + "E" * 43,
            instrument_id=started.instrument_id,
            side=started.side,
            order_type=started.order_type,
            quantity=started.quantity,
            limit_price=started.limit_price,
        )
        try:
            with self.vault.open_secret(credential.record_id) as secret:
                proof = connector.submit(
                    secret,
                    intent=intent,
                    client_order_id=started.client_order_id,
                )
        except LiveBrokerError as exc:
            execution_ledger.fail_submit(
                shadow_ref,
                error_code=exc.code,
            )
            raise
        except (OSError, ValueError) as exc:
            execution_ledger.fail_submit(
                shadow_ref,
                error_code="LIVE_EXECUTION_CONNECTOR_INVALID",
            )
            raise broker_error(
                "LIVE_EXECUTION_CONNECTOR_INVALID",
                "execution connector returned an invalid submit result",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        completed = execution_ledger.complete_submit(shadow_ref, proof)
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                **completed.public_wire(),
                "accepted": proof.accepted,
                "action": "submit",
            },
        )

    def _cancel_execution(self, request: BrokerRequest) -> BrokerResponse:
        execution_ledger = self._require_execution_ledger()
        connector = self.execution_connector
        assert connector is not None
        _exact_params(
            request.params,
            {
                "accountRef",
                "shadowRef",
                "receiptRef",
                "expectedConfirmationSha256",
                "expectedPolicyEpoch",
                "expectedControlGeneration",
            },
            "execution.cancel params",
        )
        (
            account_ref,
            shadow_ref,
            receipt_ref,
            account,
            credential,
            record,
            preview,
        ) = self._execution_expected(
            request.params,
            label="execution.cancel",
            action="cancel",
        )
        receipt = self._consume_execution_receipt(
            receipt_ref=receipt_ref,
            shadow_ref=shadow_ref,
            account_ref=account_ref,
            record=record,
            preview=preview,
        )
        started = execution_ledger.begin_cancel(
            shadow_ref,
            account_ref=account_ref,
            credential_handle_sha256=(
                account.credential_handle_sha256
            ),
            version=account.version,
            receipt_id=receipt.receipt_id,
            confirmation_sha256=preview["intentSha256"],
            risk_decision_sha256=preview["riskDecisionSha256"],
            policy_epoch=self.policy_epoch,
            control_generation=preview["controlGeneration"],
        )
        try:
            with self.vault.open_secret(credential.record_id) as secret:
                proof = connector.cancel(
                    secret,
                    instrument_id=started.instrument_id,
                    client_order_id=started.client_order_id,
                )
        except LiveBrokerError as exc:
            execution_ledger.fail_cancel(
                shadow_ref,
                error_code=exc.code,
            )
            raise
        except (OSError, ValueError) as exc:
            execution_ledger.fail_cancel(
                shadow_ref,
                error_code="LIVE_EXECUTION_CONNECTOR_INVALID",
            )
            raise broker_error(
                "LIVE_EXECUTION_CONNECTOR_INVALID",
                "execution connector returned an invalid cancel result",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        completed = execution_ledger.complete_cancel(shadow_ref, proof)
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                **completed.public_wire(),
                "accepted": proof.accepted,
                "action": "cancel",
            },
        )

    def _reconcile_execution(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_execution_ledger()
        _exact_params(
            request.params,
            {"accountRef", "shadowRef"},
            "execution.reconcile params",
        )
        account_ref, account, credential = self._shadow_account(
            request.params,
            "execution.reconcile accountRef",
        )
        if (
            account.permission != "read_trade"
            or account.connector_id
            != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
        ):
            raise broker_error(
                "LIVE_EXECUTION_ACCOUNT_UNAVAILABLE",
                "execution account is unavailable",
            )
        shadow_ref = self._shadow_ref(
            request.params,
            "execution.reconcile shadowRef",
        )
        ledger.describe(shadow_ref)
        shadow = self._perform_reconcile(
            account_ref=account_ref,
            account=account,
            credential=credential,
            shadow_ref=shadow_ref,
        )
        execution = ledger.describe(shadow_ref)
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "schemaVersion": "candlescope.live-execution-reconcile/1",
                "execution": execution.public_wire(),
                "shadow": shadow.metadata(),
            },
        )

    def _audit_export_page(self, request: BrokerRequest) -> BrokerResponse:
        ledger = self._require_control_ledger()
        journal = self._require_shadow_journal()
        execution_ledger = self.execution_ledger
        expected_params = {
            "controlAfterSequence",
            "shadowAfterSequence",
            "controlThroughSequence",
            "shadowThroughSequence",
            "limit",
        }
        if execution_ledger is not None:
            expected_params |= {
                "executionAfterSequence",
                "executionThroughSequence",
            }
        _exact_params(
            request.params,
            expected_params,
            "audit.export.page params",
        )
        values = tuple(request.params.values())
        if not all(
            isinstance(item, int)
            and not isinstance(item, bool)
            and item >= 0
            for item in values
        ):
            raise broker_error(
                "LIVE_AUDIT_EXPORT_PARAMS_INVALID",
                "audit export page values are invalid",
            )
        limit = request.params["limit"]
        if not 1 <= limit <= 16:
            raise broker_error(
                "LIVE_AUDIT_EXPORT_PARAMS_INVALID",
                "audit export page limit is invalid",
            )
        control_status = ledger.status()
        control_head = ledger.event_head()
        shadow_head = journal.event_head()
        execution_head = (
            execution_ledger.event_head()
            if execution_ledger is not None
            else None
        )
        control_through = request.params["controlThroughSequence"]
        shadow_through = request.params["shadowThroughSequence"]
        execution_through = (
            request.params["executionThroughSequence"]
            if execution_ledger is not None
            else 0
        )
        if control_through == 0:
            control_through = control_head["sequence"]
        if shadow_through == 0:
            shadow_through = shadow_head["sequence"]
        if (
            execution_ledger is not None
            and execution_head is not None
            and execution_through == 0
        ):
            execution_through = execution_head["sequence"]
        if (
            control_through > control_head["sequence"]
            or shadow_through > shadow_head["sequence"]
            or request.params["controlAfterSequence"] > control_through
            or request.params["shadowAfterSequence"] > shadow_through
            or (
                execution_ledger is not None
                and execution_head is not None
                and (
                    execution_through > execution_head["sequence"]
                    or request.params["executionAfterSequence"]
                    > execution_through
                )
            )
        ):
            raise broker_error(
                "LIVE_AUDIT_EXPORT_SNAPSHOT_REJECTED",
                "audit export snapshot cursor is invalid",
            )
        control_events = ledger.audit_events(
            after_sequence=request.params["controlAfterSequence"],
            through_sequence=control_through,
            limit=limit,
        )
        shadow_events = journal.audit_events(
            after_sequence=request.params["shadowAfterSequence"],
            through_sequence=shadow_through,
            limit=limit,
        )
        execution_events = (
            execution_ledger.audit_events(
                after_sequence=request.params[
                    "executionAfterSequence"
                ],
                through_sequence=execution_through,
                limit=limit,
            )
            if execution_ledger is not None
            else None
        )
        execution_fields = (
            {
                "executionStatus": execution_ledger.status(),
                "executionHead": {
                    "sequence": execution_through,
                    "sha256": (
                        execution_head["sha256"]
                        if execution_head is not None
                        and execution_through
                        == execution_head["sequence"]
                        else None
                    ),
                },
                "executionEvents": execution_events,
            }
            if execution_ledger is not None
            else {}
        )
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "schemaVersion": (
                    "candlescope.live-audit-page/2"
                    if execution_ledger is not None
                    else "candlescope.live-audit-page/1"
                ),
                "brokerIdSha256": _sha256_text(self.state.broker_id),
                "policyEpoch": self.policy_epoch,
                "controlStatus": control_status,
                "controlHead": {
                    "sequence": control_through,
                    "sha256": (
                        control_head["sha256"]
                        if control_through == control_head["sequence"]
                        else None
                    ),
                },
                "shadowHead": {
                    "sequence": shadow_through,
                    "sha256": (
                        shadow_head["sha256"]
                        if shadow_through == shadow_head["sequence"]
                        else None
                    ),
                },
                "controlEvents": control_events,
                "shadowEvents": shadow_events,
                **execution_fields,
            },
        )

    def _shutdown(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(request.params, set(), "foundation.shutdown params")
        self.shutdown_requested = True
        return success_response(
            request.sequence,
            self.policy_epoch,
            {"stopping": True},
        )

    def close(self) -> None:
        try:
            try:
                try:
                    if self.execution_ledger is not None:
                        self.execution_ledger.close()
                finally:
                    if self.control_ledger is not None:
                        self.control_ledger.close()
            finally:
                if self.shadow_journal is not None:
                    self.shadow_journal.close()
        finally:
            self.vault.close()
