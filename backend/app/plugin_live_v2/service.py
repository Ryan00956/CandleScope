"""Single-session authoritative state machine for the zero-network Broker."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .accounts import (
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    ReadOnlyAccountConnector,
    ReadOnlyAccountProof,
)
from .errors import LiveBrokerError, broker_error
from .protocol import (
    METHOD_ACCOUNT_DESCRIBE,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_ACCOUNT_REBIND,
    METHOD_BOOTSTRAP,
    METHOD_CREDENTIAL_DESCRIBE,
    METHOD_CREDENTIAL_PUT,
    METHOD_CREDENTIAL_REVOKE,
    METHOD_HEALTH,
    METHOD_POLICY_ADVANCE,
    METHOD_SHUTDOWN,
    BrokerRequest,
    BrokerResponse,
    success_response,
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
    ) -> None:
        if not isinstance(read_only_accounts_enabled, bool):
            raise TypeError("read_only_accounts_enabled must be a boolean")
        if account_connector is not None and not read_only_accounts_enabled:
            raise ValueError(
                "account_connector requires read_only_accounts_enabled"
            )
        self.root = Path(root).expanduser().resolve(strict=False)
        self.trust_store = LivePublisherTrustStore.from_path(release_lock_path)
        self.state_store = BrokerStateStore(
            self.root,
            vault_backend=vault_backend,
            accounts_enabled=read_only_accounts_enabled,
        )
        self.state = self.state_store.load_or_create()
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

            account_connector = OkxDemoReadOnlyConnector()
        if account_connector is not None and (
            account_connector.connector_id
            != OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
            or account_connector.network_method_count != 2
        ):
            raise broker_error(
                "LIVE_ACCOUNT_CONNECTOR_REJECTED",
                "read-only account connector does not match the pinned contract",
                fatal=True,
            )
        self.read_only_accounts_enabled = read_only_accounts_enabled
        self.account_connector = account_connector
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
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "sessionDigest": _sha256_text(request.session_id),
                "vaultBackend": self.vault.backend_name,
                "credentialCount": len(self.state.credentials),
                "accountCount": len(self.state.accounts),
                "readOnlyAccountsEnabled": self.read_only_accounts_enabled,
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
        if request.method == METHOD_SHUTDOWN:
            return self._shutdown(request)
        raise broker_error(
            "LIVE_BROKER_METHOD_DENIED",
            "Broker method is not in the private allowlist",
            fatal=True,
        )

    def _health(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(request.params, set(), "foundation.health params")
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
                "networkMethods": (
                    self.account_connector.network_method_count
                    if self.account_connector is not None
                    else 0
                ),
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
        return success_response(
            request.sequence,
            self.policy_epoch,
            {
                "advanced": True,
                "revokedCredentialCount": len(record_ids),
                "revokedAccountCount": account_count,
                "pendingDeleteCount": len(self.state.pending_deletes),
            },
        )

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
            != OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
        ):
            raise broker_error(
                "LIVE_ACCOUNT_CREDENTIAL_UNAVAILABLE",
                "read-only account credential is unavailable",
            )
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
        return binding

    def _discover_proof(
        self,
        binding: CredentialBinding,
    ) -> ReadOnlyAccountProof:
        connector = self._require_account_connector()
        with self.vault.open_secret(binding.record_id) as secret:
            proof = connector.discover(secret)
        if (
            proof.connector_id != binding.connector_id
            or proof.venue != "okx"
            or proof.environment != "demo"
            or proof.product_scope != "spot"
            or proof.permission != "read_only"
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
        if (
            credential.handle_sha256 == existing.credential_handle_sha256
            or credential.plugin_id != existing.plugin_id
            or credential.connector_id != existing.connector_id
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
            version=credential.version,
            bundle_sha256=credential.bundle_sha256,
            manifest_sha256=credential.manifest_sha256,
            release_record_sha256=credential.release_record_sha256,
            release_lock_sha256=credential.release_lock_sha256,
            position_mode=proof.position_mode,
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

    def _shutdown(self, request: BrokerRequest) -> BrokerResponse:
        _exact_params(request.params, set(), "foundation.shutdown params")
        self.shutdown_requested = True
        return success_response(
            request.sequence,
            self.policy_epoch,
            {"stopping": True},
        )

    def close(self) -> None:
        self.vault.close()
