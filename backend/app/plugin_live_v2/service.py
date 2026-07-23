"""Single-session authoritative state machine for the zero-network Broker."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import LiveBrokerError, broker_error
from .protocol import (
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
_CREDENTIAL_HANDLE = re.compile(r"^cred_[A-Za-z0-9_-]{43}$")


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
    """Own policy epoch and credentials without any network operation."""

    def __init__(
        self,
        root: Path | str,
        *,
        vault_backend: str,
        release_lock_path: Path | str,
    ) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        self.trust_store = LivePublisherTrustStore.from_path(release_lock_path)
        self.state_store = BrokerStateStore(
            self.root,
            vault_backend=vault_backend,
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
        if request.method == METHOD_SHUTDOWN:
            return self._shutdown(request)
        raise broker_error(
            "LIVE_BROKER_METHOD_DENIED",
            "Broker method is not in the zero-network allowlist",
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
                "pendingDeleteCount": len(self.state.pending_deletes),
                "networkMethods": 0,
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
        pending = set(self.state.pending_deletes) | record_ids
        updated = BrokerPersistentState(
            broker_id=self.state.broker_id,
            vault_backend=self.state.vault_backend,
            policy_epoch=next_epoch,
            credentials=(),
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
