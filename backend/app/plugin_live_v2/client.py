"""Host-side owner of the private Live Broker worker process."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.plugin_host.framing import (
    JsonLineError,
    compact_json_bytes,
    strict_json_loads,
)
from app.plugin_host.process import ManagedSidecarProcess, SidecarProcessSpec

from .audit_export import LiveAuditExportError, verify_live_audit_export
from .errors import LiveBrokerError, broker_error
from .protocol import (
    MAX_BROKER_MESSAGE_BYTES,
    METHOD_AUDIT_EXPORT_PAGE,
    METHOD_ACCOUNT_DESCRIBE,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_ACCOUNT_REBIND,
    METHOD_BOOTSTRAP,
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
    METHOD_HEALTH,
    METHOD_POLICY_ADVANCE,
    METHOD_SHADOW_DESCRIBE,
    METHOD_SHADOW_PREPARE,
    METHOD_SHADOW_RECONCILE,
    METHOD_SHUTDOWN,
    BrokerRequest,
    BrokerResponse,
)
from .shadow import ShadowOrderIntent, canonical_positive_decimal
from .trust import (
    DEFAULT_LIVE_RELEASE_LOCK_PATH,
    LivePublisherTrustStore,
    PublisherEvidence,
)
from .vault import MAX_CREDENTIAL_BYTES


DEFAULT_BROKER_REQUEST_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class CredentialHandle:
    opaque_ref: str = field(repr=False)
    plugin_id: str = ""
    connector_id: str = ""
    publisher_identity: str = ""
    version: str = ""
    label: str = ""
    created_at: str = ""
    created_policy_epoch: int = 0

    def __repr__(self) -> str:
        return (
            "CredentialHandle("
            f"plugin_id={self.plugin_id!r}, "
            f"connector_id={self.connector_id!r}, "
            f"label={self.label!r}, "
            f"created_policy_epoch={self.created_policy_epoch!r})"
        )


@dataclass(frozen=True, slots=True)
class CredentialDescription:
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    label: str
    created_at: str
    created_policy_epoch: int


@dataclass(frozen=True, slots=True)
class AccountHandle:
    opaque_ref: str = field(repr=False)
    plugin_id: str = ""
    connector_id: str = ""
    publisher_identity: str = ""
    version: str = ""
    venue: str = ""
    environment: str = ""
    product_scope: str = ""
    permission: str = ""
    account_mode: str = ""
    position_mode: str = ""
    status: str = ""
    credential_generation: int = 0
    asset_count: int = 0
    created_at: str = ""
    refreshed_at: str = ""
    created_policy_epoch: int = 0

    def __repr__(self) -> str:
        return (
            "AccountHandle("
            f"connector_id={self.connector_id!r}, "
            f"venue={self.venue!r}, "
            f"environment={self.environment!r}, "
            f"status={self.status!r}, "
            f"credential_generation={self.credential_generation!r})"
        )


@dataclass(frozen=True, slots=True)
class AccountDescription:
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    venue: str
    environment: str
    product_scope: str
    permission: str
    account_mode: str
    position_mode: str
    status: str
    credential_generation: int
    asset_count: int
    created_at: str
    refreshed_at: str
    created_policy_epoch: int


@dataclass(frozen=True, slots=True)
class ShadowOrderHandle:
    opaque_ref: str = field(repr=False)
    plugin_id: str = ""
    connector_id: str = ""
    publisher_identity: str = ""
    version: str = ""
    client_order_id: str = ""
    intent_sha256: str = ""
    instrument_id: str = ""
    side: str = ""
    order_type: str = ""
    quantity: str = ""
    limit_price: str = ""
    state: str = ""
    venue_order_id: str | None = None
    accumulated_fill_size: str = "0"
    average_price: str | None = None
    reconcile_attempt_count: int = 0
    created_at: str = ""
    updated_at: str = ""
    created_policy_epoch: int = 0

    def __repr__(self) -> str:
        return (
            "ShadowOrderHandle("
            f"connector_id={self.connector_id!r}, "
            f"client_order_id={self.client_order_id!r}, "
            f"instrument_id={self.instrument_id!r}, "
            f"state={self.state!r}, "
            f"reconcile_attempt_count={self.reconcile_attempt_count!r})"
        )


@dataclass(frozen=True, slots=True)
class ShadowOrderDescription:
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    client_order_id: str
    intent_sha256: str
    instrument_id: str
    side: str
    order_type: str
    quantity: str
    limit_price: str
    state: str
    venue_order_id: str | None
    accumulated_fill_size: str
    average_price: str | None
    reconcile_attempt_count: int
    created_at: str
    updated_at: str
    created_policy_epoch: int


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


def _exact_result(
    value: dict[str, Any],
    expected: set[str],
    label: str,
) -> None:
    if set(value) != expected:
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            f"{label} fields do not match the private contract",
            fatal=True,
        )


def _description(value: dict[str, Any]) -> CredentialDescription:
    expected = {
        "pluginId",
        "connectorId",
        "publisherIdentity",
        "version",
        "label",
        "createdAt",
        "createdPolicyEpoch",
    }
    _exact_result(value, expected, "credential metadata")
    strings = (
        value["pluginId"],
        value["connectorId"],
        value["publisherIdentity"],
        value["version"],
        value["label"],
        value["createdAt"],
    )
    if (
        not all(isinstance(item, str) and item for item in strings)
        or isinstance(value["createdPolicyEpoch"], bool)
        or not isinstance(value["createdPolicyEpoch"], int)
        or value["createdPolicyEpoch"] < 0
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "credential metadata values are invalid",
            fatal=True,
        )
    return CredentialDescription(
        plugin_id=value["pluginId"],
        connector_id=value["connectorId"],
        publisher_identity=value["publisherIdentity"],
        version=value["version"],
        label=value["label"],
        created_at=value["createdAt"],
        created_policy_epoch=value["createdPolicyEpoch"],
    )


def _account_description(value: dict[str, Any]) -> AccountDescription:
    expected = {
        "pluginId",
        "connectorId",
        "publisherIdentity",
        "version",
        "venue",
        "environment",
        "productScope",
        "permission",
        "accountMode",
        "positionMode",
        "status",
        "credentialGeneration",
        "assetCount",
        "createdAt",
        "refreshedAt",
        "createdPolicyEpoch",
    }
    _exact_result(value, expected, "account metadata")
    strings = (
        value["pluginId"],
        value["connectorId"],
        value["publisherIdentity"],
        value["version"],
        value["venue"],
        value["environment"],
        value["productScope"],
        value["permission"],
        value["accountMode"],
        value["positionMode"],
        value["status"],
        value["createdAt"],
        value["refreshedAt"],
    )
    integers = (
        value["credentialGeneration"],
        value["assetCount"],
        value["createdPolicyEpoch"],
    )
    if (
        not all(isinstance(item, str) and item for item in strings)
        or not all(
            isinstance(item, int) and not isinstance(item, bool) and item >= 0
            for item in integers
        )
        or value["credentialGeneration"] < 1
        or value["assetCount"] > 10_000
        or value["venue"] != "okx"
        or value["environment"] != "demo"
        or value["productScope"] != "spot"
        or value["status"] not in {"active", "credential-revoked"}
        or value["permission"] != "read_only"
        or value["accountMode"] != "spot"
        or value["positionMode"] not in {"net_mode", "long_short_mode"}
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "account metadata values are invalid",
            fatal=True,
        )
    return AccountDescription(
        plugin_id=value["pluginId"],
        connector_id=value["connectorId"],
        publisher_identity=value["publisherIdentity"],
        version=value["version"],
        venue=value["venue"],
        environment=value["environment"],
        product_scope=value["productScope"],
        permission=value["permission"],
        account_mode=value["accountMode"],
        position_mode=value["positionMode"],
        status=value["status"],
        credential_generation=value["credentialGeneration"],
        asset_count=value["assetCount"],
        created_at=value["createdAt"],
        refreshed_at=value["refreshedAt"],
        created_policy_epoch=value["createdPolicyEpoch"],
    )


def _shadow_description(value: dict[str, Any]) -> ShadowOrderDescription:
    expected = {
        "pluginId",
        "connectorId",
        "publisherIdentity",
        "version",
        "clientOrderId",
        "intentSha256",
        "instrumentId",
        "side",
        "orderType",
        "quantity",
        "limitPrice",
        "state",
        "venueOrderId",
        "accumulatedFillSize",
        "averagePrice",
        "reconcileAttemptCount",
        "createdAt",
        "updatedAt",
        "createdPolicyEpoch",
    }
    _exact_result(value, expected, "shadow order metadata")
    strings = (
        value["pluginId"],
        value["connectorId"],
        value["publisherIdentity"],
        value["version"],
        value["clientOrderId"],
        value["intentSha256"],
        value["instrumentId"],
        value["side"],
        value["orderType"],
        value["quantity"],
        value["limitPrice"],
        value["state"],
        value["accumulatedFillSize"],
        value["createdAt"],
        value["updatedAt"],
    )
    integers = (
        value["reconcileAttemptCount"],
        value["createdPolicyEpoch"],
    )
    if (
        not all(isinstance(item, str) and item for item in strings)
        or not all(
            isinstance(item, int) and not isinstance(item, bool) and item >= 0
            for item in integers
        )
        or re.fullmatch(r"[A-Za-z0-9]{32}", value["clientOrderId"]) is None
        or re.fullmatch(r"sha256:[0-9a-f]{64}", value["intentSha256"])
        is None
        or value["state"]
        not in {
            "prepared",
            "querying",
            "unknown",
            "live",
            "partially_filled",
            "filled",
            "canceled",
            "mmp_canceled",
        }
        or (
            value["venueOrderId"] is not None
            and (
                not isinstance(value["venueOrderId"], str)
                or re.fullmatch(r"[0-9]{1,32}", value["venueOrderId"])
                is None
            )
        )
        or (
            value["averagePrice"] is not None
            and not isinstance(value["averagePrice"], str)
        )
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "shadow order metadata values are invalid",
            fatal=True,
        )
    try:
        ShadowOrderIntent(
            idempotency_key="intent_" + "A" * 43,
            instrument_id=value["instrumentId"],
            side=value["side"],
            order_type=value["orderType"],
            quantity=value["quantity"],
            limit_price=value["limitPrice"],
        )
        if value["accumulatedFillSize"] != "0":
            canonical_positive_decimal(
                value["accumulatedFillSize"],
                "accumulated fill size",
            )
        if value["averagePrice"] is not None:
            canonical_positive_decimal(value["averagePrice"], "average price")
    except ValueError as exc:
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "shadow order metadata values are invalid",
            fatal=True,
        ) from exc
    return ShadowOrderDescription(
        plugin_id=value["pluginId"],
        connector_id=value["connectorId"],
        publisher_identity=value["publisherIdentity"],
        version=value["version"],
        client_order_id=value["clientOrderId"],
        intent_sha256=value["intentSha256"],
        instrument_id=value["instrumentId"],
        side=value["side"],
        order_type=value["orderType"],
        quantity=value["quantity"],
        limit_price=value["limitPrice"],
        state=value["state"],
        venue_order_id=value["venueOrderId"],
        accumulated_fill_size=value["accumulatedFillSize"],
        average_price=value["averagePrice"],
        reconcile_attempt_count=value["reconcileAttemptCount"],
        created_at=value["createdAt"],
        updated_at=value["updatedAt"],
        created_policy_epoch=value["createdPolicyEpoch"],
    )


def _validated_control_status(value: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "schemaVersion",
        "available",
        "mode",
        "generation",
        "policyEpoch",
        "updatedAt",
        "outstandingConfirmationCount",
        "confirmationCounts",
        "eventSequence",
        "eventSha256",
        "liveSubmitAvailable",
        "liveCancelAvailable",
        "liveTransferAvailable",
    }
    _exact_result(value, expected, "Live control status")
    counts = value["confirmationCounts"]
    if (
        value["schemaVersion"] != "candlescope.live-control-status/1"
        or value["available"] is not True
        or value["mode"] not in {"disarmed", "armed", "killed"}
        or not isinstance(value["updatedAt"], str)
        or not value["updatedAt"]
        or not isinstance(counts, dict)
        or set(counts) != {"consumed", "expired", "issued", "revoked"}
        or any(
            isinstance(item, bool)
            or not isinstance(item, int)
            or item < 0
            for item in (
                value["generation"],
                value["policyEpoch"],
                value["outstandingConfirmationCount"],
                value["eventSequence"],
                *counts.values(),
            )
        )
        or counts["issued"] != value["outstandingConfirmationCount"]
        or (
            value["eventSha256"] is not None
            and (
                not isinstance(value["eventSha256"], str)
                or re.fullmatch(r"sha256:[0-9a-f]{64}", value["eventSha256"])
                is None
            )
        )
        or value["liveSubmitAvailable"] is not False
        or value["liveCancelAvailable"] is not False
        or value["liveTransferAvailable"] is not False
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "Live control status values are invalid",
            fatal=True,
        )
    return dict(value)


def _validated_confirmation_preview(value: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "schemaVersion",
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
        "controlGeneration",
        "liveSubmitAvailable",
        "liveCancelAvailable",
    }
    _exact_result(value, expected, "Live confirmation preview")
    strings = (
        value["intentSha256"],
        value["pluginId"],
        value["connectorId"],
        value["publisherIdentity"],
        value["version"],
        value["clientOrderId"],
        value["instrumentId"],
        value["side"],
        value["orderType"],
        value["quantity"],
        value["limitPrice"],
    )
    if (
        value["schemaVersion"] != "candlescope.live-confirmation-preview/1"
        or not all(isinstance(item, str) and item for item in strings)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", value["intentSha256"])
        is None
        or re.fullmatch(r"[A-Za-z0-9]{32}", value["clientOrderId"]) is None
        or value["side"] not in {"buy", "sell"}
        or value["orderType"] != "limit"
        or any(
            isinstance(item, bool)
            or not isinstance(item, int)
            or item < 0
            for item in (
                value["policyEpoch"],
                value["controlGeneration"],
            )
        )
        or value["liveSubmitAvailable"] is not False
        or value["liveCancelAvailable"] is not False
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "Live confirmation preview values are invalid",
            fatal=True,
        )
    return dict(value)


def _validated_confirmation(value: dict[str, Any], *, issued: bool) -> dict[str, Any]:
    expected = {
        "schemaVersion",
        "receiptId",
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
        "controlGeneration",
        "state",
        "issuedAt",
        "expiresAt",
        "resolvedAt",
    }
    if issued:
        expected |= {
            "receiptRef",
            "liveSubmitAvailable",
            "liveCancelAvailable",
        }
    _exact_result(value, expected, "Live confirmation receipt")
    if (
        value["schemaVersion"] != "candlescope.live-confirmation/1"
        or not isinstance(value["receiptId"], str)
        or re.fullmatch(r"[0-9a-f]{32}", value["receiptId"]) is None
        or not isinstance(value["intentSha256"], str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", value["intentSha256"])
        is None
        or value["state"] not in {"issued", "consumed", "revoked", "expired"}
        or any(
            isinstance(item, bool)
            or not isinstance(item, int)
            or item < 0
            for item in (
                value["policyEpoch"],
                value["controlGeneration"],
            )
        )
        or not all(
            isinstance(value[key], str) and value[key]
            for key in (
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
                "issuedAt",
                "expiresAt",
            )
        )
        or (
            value["resolvedAt"] is not None
            and not isinstance(value["resolvedAt"], str)
        )
        or (
            issued
            and (
                not isinstance(value["receiptRef"], str)
                or re.fullmatch(
                    r"livecfm_[A-Za-z0-9_-]{43}",
                    value["receiptRef"],
                )
                is None
                or value["liveSubmitAvailable"] is not False
                or value["liveCancelAvailable"] is not False
            )
        )
    ):
        raise broker_error(
            "LIVE_BROKER_RESPONSE_INVALID",
            "Live confirmation receipt values are invalid",
            fatal=True,
        )
    return dict(value)


class LiveBrokerController:
    """Start no process when disabled; own exactly one private worker when enabled."""

    def __init__(
        self,
        *,
        enabled: bool,
        root: Path | str,
        release_lock_path: Path | str = DEFAULT_LIVE_RELEASE_LOCK_PATH,
        trust_store: LivePublisherTrustStore | None = None,
        vault_backend: str = "windows-dpapi",
        allow_test_backend: bool = False,
        read_only_accounts_enabled: bool = False,
        reconciliation_shadow_enabled: bool = False,
        native_control_enabled: bool = False,
        request_timeout_seconds: float = DEFAULT_BROKER_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be a boolean")
        if vault_backend not in {"windows-dpapi", "fake"}:
            raise ValueError("vault_backend is unsupported")
        if vault_backend == "fake" and not allow_test_backend:
            raise ValueError("fake vault backend requires explicit test authorization")
        if not isinstance(read_only_accounts_enabled, bool):
            raise TypeError("read_only_accounts_enabled must be a boolean")
        if read_only_accounts_enabled and not enabled:
            raise ValueError(
                "read_only_accounts_enabled requires the Broker foundation"
            )
        if not isinstance(reconciliation_shadow_enabled, bool):
            raise TypeError("reconciliation_shadow_enabled must be a boolean")
        if (
            reconciliation_shadow_enabled
            and not read_only_accounts_enabled
        ):
            raise ValueError(
                "reconciliation_shadow_enabled requires read-only accounts"
            )
        if not isinstance(native_control_enabled, bool):
            raise TypeError("native_control_enabled must be a boolean")
        if native_control_enabled and not reconciliation_shadow_enabled:
            raise ValueError(
                "native_control_enabled requires reconciliation shadow"
            )
        if (
            isinstance(request_timeout_seconds, bool)
            or not isinstance(request_timeout_seconds, (int, float))
            or not 0.1 <= float(request_timeout_seconds) <= 60.0
        ):
            raise ValueError("request_timeout_seconds is outside the supported range")
        self.enabled = enabled
        self.root = Path(root).expanduser().resolve(strict=False)
        self.release_lock_path = (
            Path(release_lock_path).expanduser().resolve(strict=False)
        )
        if trust_store is not None and not isinstance(
            trust_store, LivePublisherTrustStore
        ):
            raise TypeError("trust_store must be LivePublisherTrustStore")
        self.trust_store = trust_store
        self.vault_backend = vault_backend
        self.read_only_accounts_enabled = read_only_accounts_enabled
        self.reconciliation_shadow_enabled = reconciliation_shadow_enabled
        self.native_control_enabled = native_control_enabled
        self.request_timeout_seconds = float(request_timeout_seconds)
        self._worker_path = Path(__file__).with_name("worker.py").resolve(
            strict=False
        )
        self._managed: ManagedSidecarProcess | None = None
        self._session_id: str | None = None
        self._next_sequence = 1
        self._policy_epoch = 0
        self._state = "disabled" if not enabled else "stopped"
        self._last_error_code: str | None = None
        self._last_stderr_tail = ""
        self._restart_count = 0
        self._control_status: dict[str, Any] = self._unavailable_control_status()
        self._operation_lock = asyncio.Lock()

    @property
    def process(self) -> asyncio.subprocess.Process | None:
        return self._managed.process if self._managed is not None else None

    @property
    def process_spec(self) -> SidecarProcessSpec | None:
        return self._managed.spec if self._managed is not None else None

    @property
    def policy_epoch(self) -> int:
        return self._policy_epoch

    @property
    def stderr_tail(self) -> str:
        return (
            self._managed.stderr_tail
            if self._managed is not None
            else self._last_stderr_tail
        )

    def _unavailable_control_status(self) -> dict[str, Any]:
        return {
            "schemaVersion": "candlescope.live-control-status/1",
            "available": False,
            "mode": "unavailable" if self.native_control_enabled else "disabled",
            "generation": 0,
            "policyEpoch": self._policy_epoch,
            "updatedAt": None,
            "outstandingConfirmationCount": 0,
            "confirmationCounts": {
                "consumed": 0,
                "expired": 0,
                "issued": 0,
                "revoked": 0,
            },
            "eventSequence": 0,
            "eventSha256": None,
            "liveSubmitAvailable": False,
            "liveCancelAvailable": False,
            "liveTransferAvailable": False,
        }

    def control_status_cached(self) -> dict[str, Any]:
        return dict(self._control_status)

    def status(self) -> dict[str, Any]:
        process = self.process
        return {
            "enabled": self.enabled,
            "state": self._state,
            "running": bool(process is not None and process.returncode is None),
            "pid": (
                process.pid
                if process is not None and process.returncode is None
                else None
            ),
            "policyEpoch": self._policy_epoch,
            "restartCount": self._restart_count,
            "lastErrorCode": self._last_error_code,
            "vaultBackend": self.vault_backend if self.enabled else None,
            "readOnlyAccountsEnabled": self.read_only_accounts_enabled,
            "reconciliationShadowEnabled": (
                self.reconciliation_shadow_enabled
            ),
            "nativeControlEnabled": self.native_control_enabled,
            "control": dict(self._control_status),
            "networkMethods": (
                3
                if self.reconciliation_shadow_enabled
                else 2
                if self.read_only_accounts_enabled
                else 0
            ),
        }

    def _new_process(self) -> ManagedSidecarProcess:
        specification = SidecarProcessSpec(
            identity="candlescope-live-broker-foundation",
            executable=Path(sys.executable),
            arguments=(
                "-I",
                "-u",
                str(self._worker_path),
                str(self.root),
                self.vault_backend,
                str(self.release_lock_path),
                (
                    "accounts-on"
                    if self.read_only_accounts_enabled
                    else "accounts-off"
                ),
                (
                    "shadow-on"
                    if self.reconciliation_shadow_enabled
                    else "shadow-off"
                ),
                (
                    "control-on"
                    if self.native_control_enabled
                    else "control-off"
                ),
            ),
            working_directory=self._worker_path.parents[2],
            max_message_bytes=MAX_BROKER_MESSAGE_BYTES,
            max_stderr_bytes=16 * 1024,
            trust_level="first-party-pinned",
        )
        return ManagedSidecarProcess(specification)

    def _load_trust_store(self) -> LivePublisherTrustStore:
        loaded = LivePublisherTrustStore.from_path(self.release_lock_path)
        configured = self.trust_store
        if (
            configured is not None
            and configured.release_lock.lock_sha256
            != loaded.release_lock.lock_sha256
        ):
            raise broker_error(
                "LIVE_BROKER_RELEASE_LOCK_MISMATCH",
                "configured trust store does not match the Broker release lock",
                fatal=True,
            )
        self.trust_store = loaded if configured is None else configured
        return self.trust_store

    async def start(self) -> None:
        async with self._operation_lock:
            await self._start_locked()

    async def _start_locked(self) -> None:
        if not self.enabled:
            return
        process = self.process
        if process is not None and process.returncode is None:
            return
        if self.vault_backend == "windows-dpapi" and os.name != "nt":
            self._state = "unavailable"
            self._last_error_code = "LIVE_BROKER_VAULT_UNAVAILABLE"
            raise broker_error(
                "LIVE_BROKER_VAULT_UNAVAILABLE",
                "Windows DPAPI Broker foundation is unavailable on this platform",
                fatal=True,
            )
        self._load_trust_store()
        self._managed = self._new_process()
        self._session_id = f"sess_{secrets.token_urlsafe(32)}"
        self._next_sequence = 1
        self._policy_epoch = 0
        self._state = "starting"
        self._last_error_code = None
        self._last_stderr_tail = ""
        try:
            await self._managed.start()
            result = await self._exchange_locked(
                METHOD_BOOTSTRAP,
                {},
                request_epoch=0,
            )
            _exact_result(
                result,
                {
                    "sessionDigest",
                    "vaultBackend",
                    "credentialCount",
                    "accountCount",
                    "readOnlyAccountsEnabled",
                    "reconciliationShadowEnabled",
                    "journalCount",
                    "unresolvedCount",
                },
                "foundation.bootstrap result",
            )
            if (
                result["sessionDigest"] != _sha256_text(self._session_id)
                or result["vaultBackend"] != self.vault_backend
                or isinstance(result["credentialCount"], bool)
                or not isinstance(result["credentialCount"], int)
                or result["credentialCount"] < 0
                or isinstance(result["accountCount"], bool)
                or not isinstance(result["accountCount"], int)
                or result["accountCount"] < 0
                or result["readOnlyAccountsEnabled"]
                is not self.read_only_accounts_enabled
                or result["reconciliationShadowEnabled"]
                is not self.reconciliation_shadow_enabled
                or isinstance(result["journalCount"], bool)
                or not isinstance(result["journalCount"], int)
                or result["journalCount"] < 0
                or isinstance(result["unresolvedCount"], bool)
                or not isinstance(result["unresolvedCount"], int)
                or result["unresolvedCount"] < 0
                or result["unresolvedCount"] > result["journalCount"]
                or (
                    not self.reconciliation_shadow_enabled
                    and (
                        result["journalCount"] != 0
                        or result["unresolvedCount"] != 0
                    )
                )
            ):
                raise broker_error(
                    "LIVE_BROKER_BOOTSTRAP_REJECTED",
                    "Broker bootstrap proof does not match the private session",
                    fatal=True,
                )
            if self.native_control_enabled:
                control = await self._exchange_locked(
                    METHOD_CONTROL_STATUS,
                    {},
                )
                self._control_status = _validated_control_status(control)
            else:
                self._control_status = self._unavailable_control_status()
            self._state = "ready"
        except BaseException as exc:
            self._last_error_code = (
                exc.code
                if isinstance(exc, LiveBrokerError)
                else "LIVE_BROKER_START_FAILED"
            )
            self._state = "failed"
            self._control_status = self._unavailable_control_status()
            await self._terminate_locked()
            raise

    async def _terminate_locked(self) -> None:
        managed = self._managed
        self._managed = None
        self._session_id = None
        self._control_status = self._unavailable_control_status()
        if managed is not None:
            await managed.terminate()
            self._last_stderr_tail = managed.stderr_tail

    async def _exchange_locked(
        self,
        method: str,
        params: dict[str, Any],
        *,
        request_epoch: int | None = None,
    ) -> dict[str, Any]:
        managed = self._managed
        process = self.process
        session_id = self._session_id
        if (
            managed is None
            or managed.connection is None
            or process is None
            or process.returncode is not None
            or session_id is None
        ):
            error = broker_error(
                "LIVE_BROKER_NOT_RUNNING",
                "Live Broker foundation is not running",
                fatal=True,
            )
            self._last_error_code = error.code
            self._state = "failed"
            await self._terminate_locked()
            raise error
        sequence = self._next_sequence
        self._next_sequence += 1
        request = BrokerRequest(
            sequence=sequence,
            session_id=session_id,
            method=method,
            policy_epoch=(
                self._policy_epoch if request_epoch is None else request_epoch
            ),
            params=params,
        )
        try:
            payload = compact_json_bytes(
                request.to_wire(),
                max_message_bytes=MAX_BROKER_MESSAGE_BYTES,
            )
            await managed.connection.write(payload)
            response_payload = await asyncio.wait_for(
                managed.connection.read(),
                timeout=self.request_timeout_seconds,
            )
            response_value = strict_json_loads(
                response_payload,
                max_message_bytes=MAX_BROKER_MESSAGE_BYTES,
            )
            response = BrokerResponse.from_wire(response_value)
            if response.sequence != sequence:
                raise broker_error(
                    "LIVE_BROKER_RESPONSE_INVALID",
                    "Broker response sequence does not match its request",
                    fatal=True,
                )
            self._policy_epoch = response.policy_epoch
            if not response.ok:
                if response.error is None:
                    raise broker_error(
                        "LIVE_BROKER_RESPONSE_INVALID",
                        "Broker failure omitted its error",
                        fatal=True,
                    )
                raise response.error
            if response.result is None:
                raise broker_error(
                    "LIVE_BROKER_RESPONSE_INVALID",
                    "Broker success omitted its result",
                    fatal=True,
                )
            return response.result
        except LiveBrokerError as exc:
            if exc.fatal:
                self._last_error_code = exc.code
                self._state = "failed"
                await self._terminate_locked()
            raise
        except (JsonLineError, TimeoutError, OSError) as exc:
            error = broker_error(
                "LIVE_BROKER_TRANSPORT_FAILED",
                "Live Broker private transport failed",
                fatal=True,
                details={"errorType": type(exc).__name__},
            )
            self._last_error_code = error.code
            self._state = "failed"
            await self._terminate_locked()
            raise error from exc

    async def health(self) -> dict[str, Any]:
        async with self._operation_lock:
            result = await self._exchange_locked(METHOD_HEALTH, {})
            _exact_result(
                result,
                {
                    "status",
                    "vaultBackend",
                    "credentialCount",
                    "accountCount",
                    "pendingDeleteCount",
                    "readOnlyAccountsEnabled",
                    "reconciliationShadowEnabled",
                    "journalCount",
                    "unresolvedCount",
                    "networkMethods",
                },
                "foundation.health result",
            )
            counts = (
                result["credentialCount"],
                result["accountCount"],
                result["pendingDeleteCount"],
                result["journalCount"],
                result["unresolvedCount"],
                result["networkMethods"],
            )
            if (
                result["status"] not in {"ok", "degraded"}
                or result["vaultBackend"] != self.vault_backend
                or not all(
                    isinstance(item, int)
                    and not isinstance(item, bool)
                    and item >= 0
                    for item in counts
                )
                or result["readOnlyAccountsEnabled"]
                is not self.read_only_accounts_enabled
                or result["reconciliationShadowEnabled"]
                is not self.reconciliation_shadow_enabled
                or result["unresolvedCount"] > result["journalCount"]
                or (
                    not self.reconciliation_shadow_enabled
                    and (
                        result["journalCount"] != 0
                        or result["unresolvedCount"] != 0
                    )
                )
                or result["networkMethods"]
                != (
                    3
                    if self.reconciliation_shadow_enabled
                    else 2
                    if self.read_only_accounts_enabled
                    else 0
                )
            ):
                raise broker_error(
                    "LIVE_BROKER_RESPONSE_INVALID",
                    "Broker health values are invalid",
                    fatal=True,
                )
            return result

    async def put_credential(
        self,
        evidence: PublisherEvidence,
        secret: bytes | bytearray,
        *,
        label: str,
    ) -> CredentialHandle:
        trust_store = self.trust_store or self._load_trust_store()
        trust_store.verify_evidence(evidence)
        if (
            not isinstance(secret, (bytes, bytearray))
            or not 1 <= len(secret) <= MAX_CREDENTIAL_BYTES
        ):
            raise broker_error(
                "LIVE_BROKER_SECRET_INVALID",
                "credential secret size is outside the supported range",
            )
        if (
            not isinstance(label, str)
            or not label
            or label != label.strip()
            or len(label) > 128
            or "\0" in label
        ):
            raise broker_error(
                "LIVE_BROKER_PARAMS_INVALID",
                "credential label is invalid",
            )
        encoded = base64.b64encode(secret).decode("ascii")
        try:
            async with self._operation_lock:
                result = await self._exchange_locked(
                    METHOD_CREDENTIAL_PUT,
                    {
                        "evidence": evidence.to_wire(),
                        "label": label,
                        "secretBase64": encoded,
                    },
                )
        finally:
            del encoded
        expected = {
            "credentialHandle",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "label",
            "createdAt",
            "createdPolicyEpoch",
        }
        _exact_result(result, expected, "credential.put result")
        handle = result.pop("credentialHandle")
        if (
            not isinstance(handle, str)
            or not handle.startswith("cred_")
            or len(handle) != 48
        ):
            raise broker_error(
                "LIVE_BROKER_RESPONSE_INVALID",
                "Broker returned an invalid credential handle",
                fatal=True,
            )
        description = _description(result)
        return CredentialHandle(
            opaque_ref=handle,
            plugin_id=description.plugin_id,
            connector_id=description.connector_id,
            publisher_identity=description.publisher_identity,
            version=description.version,
            label=description.label,
            created_at=description.created_at,
            created_policy_epoch=description.created_policy_epoch,
        )

    async def describe_credential(
        self,
        handle: CredentialHandle,
    ) -> CredentialDescription:
        if not isinstance(handle, CredentialHandle):
            raise TypeError("handle must be CredentialHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CREDENTIAL_DESCRIBE,
                {"credentialHandle": handle.opaque_ref},
            )
        return _description(result)

    async def revoke_credential(self, handle: CredentialHandle) -> None:
        if not isinstance(handle, CredentialHandle):
            raise TypeError("handle must be CredentialHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CREDENTIAL_REVOKE,
                {"credentialHandle": handle.opaque_ref},
            )
        if result.get("revoked") is not True or not set(result).issubset(
            {"revoked", "pendingDeleteCount"}
        ):
            raise broker_error(
                "LIVE_BROKER_RESPONSE_INVALID",
                "Broker revoke result is invalid",
                fatal=True,
            )

    def _require_read_only_accounts(self) -> None:
        if not self.read_only_accounts_enabled:
            raise broker_error(
                "LIVE_ACCOUNTS_DISABLED",
                "read-only Live accounts are disabled",
            )

    async def discover_account(
        self,
        credential: CredentialHandle,
    ) -> AccountHandle:
        self._require_read_only_accounts()
        if not isinstance(credential, CredentialHandle):
            raise TypeError("credential must be CredentialHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_ACCOUNT_DISCOVER,
                {"credentialHandle": credential.opaque_ref},
            )
        expected = {
            "accountRef",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "venue",
            "environment",
            "productScope",
            "permission",
            "accountMode",
            "positionMode",
            "status",
            "credentialGeneration",
            "assetCount",
            "createdAt",
            "refreshedAt",
            "createdPolicyEpoch",
        }
        _exact_result(result, expected, "account.discover result")
        account_ref = result.pop("accountRef")
        if (
            not isinstance(account_ref, str)
            or not account_ref.startswith("acct_")
            or len(account_ref) != 48
        ):
            raise broker_error(
                "LIVE_BROKER_RESPONSE_INVALID",
                "Broker returned an invalid account reference",
                fatal=True,
            )
        description = _account_description(result)
        return AccountHandle(
            opaque_ref=account_ref,
            plugin_id=description.plugin_id,
            connector_id=description.connector_id,
            publisher_identity=description.publisher_identity,
            version=description.version,
            venue=description.venue,
            environment=description.environment,
            product_scope=description.product_scope,
            permission=description.permission,
            account_mode=description.account_mode,
            position_mode=description.position_mode,
            status=description.status,
            credential_generation=description.credential_generation,
            asset_count=description.asset_count,
            created_at=description.created_at,
            refreshed_at=description.refreshed_at,
            created_policy_epoch=description.created_policy_epoch,
        )

    async def describe_account(
        self,
        account: AccountHandle,
    ) -> AccountDescription:
        self._require_read_only_accounts()
        if not isinstance(account, AccountHandle):
            raise TypeError("account must be AccountHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_ACCOUNT_DESCRIBE,
                {"accountRef": account.opaque_ref},
            )
        return _account_description(result)

    async def rebind_account(
        self,
        account: AccountHandle,
        credential: CredentialHandle,
    ) -> AccountDescription:
        self._require_read_only_accounts()
        if not isinstance(account, AccountHandle):
            raise TypeError("account must be AccountHandle")
        if not isinstance(credential, CredentialHandle):
            raise TypeError("credential must be CredentialHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_ACCOUNT_REBIND,
                {
                    "accountRef": account.opaque_ref,
                    "credentialHandle": credential.opaque_ref,
                },
            )
        return _account_description(result)

    def _require_reconciliation_shadow(self) -> None:
        if not self.reconciliation_shadow_enabled:
            raise broker_error(
                "LIVE_RECONCILIATION_SHADOW_DISABLED",
                "query-only reconciliation shadow is disabled",
            )

    @staticmethod
    def _shadow_handle_from_description(
        shadow_ref: str,
        description: ShadowOrderDescription,
    ) -> ShadowOrderHandle:
        return ShadowOrderHandle(
            opaque_ref=shadow_ref,
            plugin_id=description.plugin_id,
            connector_id=description.connector_id,
            publisher_identity=description.publisher_identity,
            version=description.version,
            client_order_id=description.client_order_id,
            intent_sha256=description.intent_sha256,
            instrument_id=description.instrument_id,
            side=description.side,
            order_type=description.order_type,
            quantity=description.quantity,
            limit_price=description.limit_price,
            state=description.state,
            venue_order_id=description.venue_order_id,
            accumulated_fill_size=description.accumulated_fill_size,
            average_price=description.average_price,
            reconcile_attempt_count=description.reconcile_attempt_count,
            created_at=description.created_at,
            updated_at=description.updated_at,
            created_policy_epoch=description.created_policy_epoch,
        )

    async def prepare_shadow_order(
        self,
        account: AccountHandle,
        intent: ShadowOrderIntent,
    ) -> ShadowOrderHandle:
        self._require_reconciliation_shadow()
        if not isinstance(account, AccountHandle):
            raise TypeError("account must be AccountHandle")
        if not isinstance(intent, ShadowOrderIntent):
            raise TypeError("intent must be ShadowOrderIntent")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_SHADOW_PREPARE,
                {
                    "accountRef": account.opaque_ref,
                    "intent": {
                        "idempotencyKey": intent.idempotency_key,
                        **intent.canonical_wire(),
                    },
                },
            )
        expected = {
            "shadowRef",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "clientOrderId",
            "intentSha256",
            "instrumentId",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
            "state",
            "venueOrderId",
            "accumulatedFillSize",
            "averagePrice",
            "reconcileAttemptCount",
            "createdAt",
            "updatedAt",
            "createdPolicyEpoch",
        }
        _exact_result(result, expected, "shadow.prepare result")
        shadow_ref = result.pop("shadowRef")
        if (
            not isinstance(shadow_ref, str)
            or not shadow_ref.startswith("shdw_")
            or len(shadow_ref) != 48
        ):
            raise broker_error(
                "LIVE_BROKER_RESPONSE_INVALID",
                "Broker returned an invalid shadow order reference",
                fatal=True,
            )
        return self._shadow_handle_from_description(
            shadow_ref,
            _shadow_description(result),
        )

    async def describe_shadow_order(
        self,
        shadow: ShadowOrderHandle,
    ) -> ShadowOrderDescription:
        self._require_reconciliation_shadow()
        if not isinstance(shadow, ShadowOrderHandle):
            raise TypeError("shadow must be ShadowOrderHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_SHADOW_DESCRIBE,
                {"shadowRef": shadow.opaque_ref},
            )
        return _shadow_description(result)

    async def reconcile_shadow_order(
        self,
        account: AccountHandle,
        shadow: ShadowOrderHandle,
    ) -> ShadowOrderDescription:
        self._require_reconciliation_shadow()
        if not isinstance(account, AccountHandle):
            raise TypeError("account must be AccountHandle")
        if not isinstance(shadow, ShadowOrderHandle):
            raise TypeError("shadow must be ShadowOrderHandle")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_SHADOW_RECONCILE,
                {
                    "accountRef": account.opaque_ref,
                    "shadowRef": shadow.opaque_ref,
                },
            )
        return _shadow_description(result)

    def _require_native_control(self) -> None:
        if not self.native_control_enabled:
            raise broker_error(
                "LIVE_NATIVE_CONTROL_DISABLED",
                "Host-native Live control is disabled",
            )

    async def control_status(self) -> dict[str, Any]:
        self._require_native_control()
        async with self._operation_lock:
            result = await self._exchange_locked(METHOD_CONTROL_STATUS, {})
            self._control_status = _validated_control_status(result)
            return dict(self._control_status)

    async def set_control_mode(
        self,
        mode: str,
        *,
        reason: str,
        acknowledge_kill: bool = False,
    ) -> dict[str, Any]:
        self._require_native_control()
        if mode not in {"armed", "disarmed"}:
            raise ValueError("mode must be armed or disarmed")
        if (
            not isinstance(reason, str)
            or not reason
            or reason != reason.strip()
            or len(reason) > 128
        ):
            raise ValueError("reason is invalid")
        if not isinstance(acknowledge_kill, bool):
            raise TypeError("acknowledge_kill must be a boolean")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONTROL_SET,
                {
                    "mode": mode,
                    "reason": reason,
                    "acknowledgeKill": acknowledge_kill,
                },
            )
            self._control_status = _validated_control_status(result)
            return dict(self._control_status)

    async def kill_control(self, *, reason: str) -> dict[str, Any]:
        self._require_native_control()
        if (
            not isinstance(reason, str)
            or not reason
            or reason != reason.strip()
            or len(reason) > 128
        ):
            raise ValueError("reason is invalid")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONTROL_KILL,
                {"reason": reason},
            )
            revocation = result.pop("revocation", None)
            revoked_count = result.pop("revokedConfirmationCount", None)
            self._control_status = _validated_control_status(result)
            if (
                not isinstance(revocation, dict)
                or revocation.get("advanced") is not True
                or isinstance(revoked_count, bool)
                or not isinstance(revoked_count, int)
                or revoked_count < 0
            ):
                raise broker_error(
                    "LIVE_BROKER_RESPONSE_INVALID",
                    "Live kill response is invalid",
                    fatal=True,
                )
            return {
                **self._control_status,
                "revokedConfirmationCount": revoked_count,
                "revocation": revocation,
            }

    async def revoke_authority(
        self,
        *,
        scope_type: str,
        subject: str,
        reason: str,
    ) -> dict[str, Any]:
        self._require_native_control()
        if scope_type not in {
            "grant",
            "plugin",
            "publisher",
            "credential",
        }:
            raise ValueError("scope_type is invalid")
        if (
            not isinstance(subject, str)
            or not subject
            or subject != subject.strip()
            or len(subject) > 256
            or not isinstance(reason, str)
            or not reason
            or reason != reason.strip()
            or len(reason) > 128
        ):
            raise ValueError("authority revoke values are invalid")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_AUTHORITY_REVOKE,
                {
                    "scopeType": scope_type,
                    "subject": subject,
                    "reason": reason,
                },
            )
            returned_scope = result.pop("scopeType", None)
            revocation = result.pop("revocation", None)
            revoked_count = result.pop("revokedConfirmationCount", None)
            self._control_status = _validated_control_status(result)
            if (
                returned_scope != scope_type
                or not isinstance(revocation, dict)
                or revocation.get("advanced") is not True
                or isinstance(revoked_count, bool)
                or not isinstance(revoked_count, int)
                or revoked_count < 0
            ):
                raise broker_error(
                    "LIVE_BROKER_RESPONSE_INVALID",
                    "Live authority revoke response is invalid",
                    fatal=True,
                )
            return {
                **self._control_status,
                "scopeType": returned_scope,
                "revokedConfirmationCount": revoked_count,
                "revocation": revocation,
            }

    @staticmethod
    def _opaque_live_refs(account_ref: str, shadow_ref: str) -> None:
        if (
            not isinstance(account_ref, str)
            or re.fullmatch(r"acct_[A-Za-z0-9_-]{43}", account_ref) is None
            or not isinstance(shadow_ref, str)
            or re.fullmatch(r"shdw_[A-Za-z0-9_-]{43}", shadow_ref) is None
        ):
            raise ValueError("Live account or shadow reference is invalid")

    async def preview_confirmation(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
    ) -> dict[str, Any]:
        self._require_native_control()
        self._opaque_live_refs(account_ref, shadow_ref)
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONFIRMATION_PREVIEW,
                {"accountRef": account_ref, "shadowRef": shadow_ref},
            )
        return _validated_confirmation_preview(result)

    async def issue_confirmation(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
        expected_intent_sha256: str,
        expected_policy_epoch: int,
        expected_control_generation: int,
        ttl_seconds: int = 60,
    ) -> dict[str, Any]:
        self._require_native_control()
        self._opaque_live_refs(account_ref, shadow_ref)
        if (
            not isinstance(expected_intent_sha256, str)
            or re.fullmatch(
                r"sha256:[0-9a-f]{64}",
                expected_intent_sha256,
            )
            is None
            or any(
                isinstance(item, bool)
                or not isinstance(item, int)
                or item < 0
                for item in (
                    expected_policy_epoch,
                    expected_control_generation,
                )
            )
            or isinstance(ttl_seconds, bool)
            or not isinstance(ttl_seconds, int)
            or not 15 <= ttl_seconds <= 120
        ):
            raise ValueError("confirmation issue values are invalid")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONFIRMATION_ISSUE,
                {
                    "accountRef": account_ref,
                    "shadowRef": shadow_ref,
                    "expectedIntentSha256": expected_intent_sha256,
                    "expectedPolicyEpoch": expected_policy_epoch,
                    "expectedControlGeneration": expected_control_generation,
                    "ttlSeconds": ttl_seconds,
                },
            )
            confirmation = _validated_confirmation(result, issued=True)
            status = await self._exchange_locked(METHOD_CONTROL_STATUS, {})
            self._control_status = _validated_control_status(status)
        return confirmation

    async def describe_confirmation(self, receipt_ref: str) -> dict[str, Any]:
        self._require_native_control()
        if (
            not isinstance(receipt_ref, str)
            or re.fullmatch(r"livecfm_[A-Za-z0-9_-]{43}", receipt_ref)
            is None
        ):
            raise ValueError("receipt_ref is invalid")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONFIRMATION_DESCRIBE,
                {"receiptRef": receipt_ref},
            )
        return _validated_confirmation(result, issued=False)

    async def revoke_confirmation(
        self,
        receipt_ref: str,
        *,
        reason: str,
    ) -> dict[str, Any]:
        self._require_native_control()
        if (
            not isinstance(receipt_ref, str)
            or re.fullmatch(r"livecfm_[A-Za-z0-9_-]{43}", receipt_ref)
            is None
            or not isinstance(reason, str)
            or not reason
            or reason != reason.strip()
            or len(reason) > 128
        ):
            raise ValueError("confirmation revoke values are invalid")
        async with self._operation_lock:
            result = await self._exchange_locked(
                METHOD_CONFIRMATION_REVOKE,
                {"receiptRef": receipt_ref, "reason": reason},
            )
            confirmation = _validated_confirmation(result, issued=False)
            status = await self._exchange_locked(METHOD_CONTROL_STATUS, {})
            self._control_status = _validated_control_status(status)
        return confirmation

    async def export_audit(self) -> dict[str, Any]:
        self._require_native_control()
        control_after = 0
        shadow_after = 0
        control_through = 0
        shadow_through = 0
        control_events: list[dict[str, Any]] = []
        shadow_events: list[dict[str, Any]] = []
        broker_id_sha256: str | None = None
        control_head: dict[str, Any] | None = None
        shadow_head: dict[str, Any] | None = None
        control_status: dict[str, Any] | None = None
        async with self._operation_lock:
            while True:
                result = await self._exchange_locked(
                    METHOD_AUDIT_EXPORT_PAGE,
                    {
                        "controlAfterSequence": control_after,
                        "shadowAfterSequence": shadow_after,
                        "controlThroughSequence": control_through,
                        "shadowThroughSequence": shadow_through,
                        "limit": 16,
                    },
                )
                expected = {
                    "schemaVersion",
                    "brokerIdSha256",
                    "policyEpoch",
                    "controlStatus",
                    "controlHead",
                    "shadowHead",
                    "controlEvents",
                    "shadowEvents",
                }
                _exact_result(result, expected, "Live audit page")
                if (
                    result["schemaVersion"]
                    != "candlescope.live-audit-page/1"
                    or not isinstance(result["controlEvents"], list)
                    or not isinstance(result["shadowEvents"], list)
                    or len(result["controlEvents"]) > 16
                    or len(result["shadowEvents"]) > 16
                ):
                    raise broker_error(
                        "LIVE_BROKER_RESPONSE_INVALID",
                        "Live audit page is invalid",
                        fatal=True,
                    )
                page_control_head = result["controlHead"]
                page_shadow_head = result["shadowHead"]
                if (
                    not isinstance(page_control_head, dict)
                    or set(page_control_head) != {"sequence", "sha256"}
                    or not isinstance(page_shadow_head, dict)
                    or set(page_shadow_head) != {"sequence", "sha256"}
                ):
                    raise broker_error(
                        "LIVE_BROKER_RESPONSE_INVALID",
                        "Live audit page head is invalid",
                        fatal=True,
                    )
                if control_head is None:
                    broker_id_sha256 = result["brokerIdSha256"]
                    control_head = dict(page_control_head)
                    shadow_head = dict(page_shadow_head)
                    control_through = control_head["sequence"]
                    shadow_through = shadow_head["sequence"]
                    control_status = _validated_control_status(
                        result["controlStatus"]
                    )
                elif (
                    result["brokerIdSha256"] != broker_id_sha256
                    or page_control_head != control_head
                    or page_shadow_head != shadow_head
                    or result["controlStatus"] != control_status
                ):
                    raise broker_error(
                        "LIVE_AUDIT_EXPORT_SNAPSHOT_CHANGED",
                        "Live audit snapshot changed during export",
                        fatal=True,
                    )
                control_events.extend(result["controlEvents"])
                shadow_events.extend(result["shadowEvents"])
                if result["controlEvents"]:
                    last_control = result["controlEvents"][-1]
                    if not isinstance(last_control, dict):
                        raise broker_error(
                            "LIVE_BROKER_RESPONSE_INVALID",
                            "Live control audit event is invalid",
                            fatal=True,
                        )
                    control_after = last_control.get("sequence", -1)
                if result["shadowEvents"]:
                    last_shadow = result["shadowEvents"][-1]
                    if (
                        not isinstance(last_shadow, dict)
                        or not isinstance(last_shadow.get("event"), dict)
                    ):
                        raise broker_error(
                            "LIVE_BROKER_RESPONSE_INVALID",
                            "Live shadow audit event is invalid",
                            fatal=True,
                        )
                    shadow_after = last_shadow["event"].get("sequence", -1)
                if (
                    control_after == control_through
                    and shadow_after == shadow_through
                ):
                    break
                if (
                    not result["controlEvents"]
                    and control_after < control_through
                ) or (
                    not result["shadowEvents"]
                    and shadow_after < shadow_through
                ):
                    raise broker_error(
                        "LIVE_BROKER_RESPONSE_INVALID",
                        "Live audit page omitted source events",
                        fatal=True,
                    )
            assert broker_id_sha256 is not None
            assert control_head is not None
            assert shadow_head is not None
            assert control_status is not None
            self._control_status = dict(control_status)
            body = {
                "schemaVersion": "candlescope.live-audit-export/1",
                "generatedAt": datetime.now(UTC).isoformat().replace(
                    "+00:00", "Z"
                ),
                "brokerIdSha256": broker_id_sha256,
                "policyEpoch": self._policy_epoch,
                "controlStatus": control_status,
                "controlHead": control_head,
                "shadowHead": shadow_head,
                "controlEvents": control_events,
                "shadowEvents": shadow_events,
                "redaction": {
                    "opaqueHandlesIncluded": False,
                    "credentialMaterialIncluded": False,
                    "authenticationDataIncluded": False,
                    "rawVenueOrderIdsIncluded": False,
                    "rawNetworkResponsesIncluded": False,
                },
                "liveMutationMethodsAvailable": False,
            }
            exported = {
                **body,
                "exportSha256": _sha256_text(_canonical_json(body)),
            }
            try:
                return verify_live_audit_export(exported)
            except LiveAuditExportError as exc:
                raise broker_error(
                    "LIVE_AUDIT_EXPORT_INVALID",
                    "Live audit export failed source-chain validation",
                    fatal=True,
                ) from exc

    async def advance_policy(self, *, reason: str) -> int:
        if (
            not isinstance(reason, str)
            or not reason
            or reason != reason.strip()
            or len(reason) > 128
        ):
            raise broker_error(
                "LIVE_BROKER_PARAMS_INVALID",
                "policy advance reason is invalid",
            )
        async with self._operation_lock:
            next_epoch = self._policy_epoch + 1
            result = await self._exchange_locked(
                METHOD_POLICY_ADVANCE,
                {"nextEpoch": next_epoch, "reason": reason},
            )
        _exact_result(
            result,
            {
                "advanced",
                "revokedCredentialCount",
                "revokedAccountCount",
                "pendingDeleteCount",
            },
            "policy.advance result",
        )
        counts = (
            result["revokedCredentialCount"],
            result["revokedAccountCount"],
            result["pendingDeleteCount"],
        )
        if (
            result["advanced"] is not True
            or self._policy_epoch != next_epoch
            or not all(
                isinstance(item, int)
                and not isinstance(item, bool)
                and item >= 0
                for item in counts
            )
        ):
            raise broker_error(
                "LIVE_BROKER_RESPONSE_INVALID",
                "Broker did not advance policy epoch as requested",
                fatal=True,
            )
        return self._policy_epoch

    async def stop(self) -> None:
        async with self._operation_lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        process = self.process
        if process is not None and process.returncode is None and self._session_id:
            try:
                result = await self._exchange_locked(METHOD_SHUTDOWN, {})
                if result != {"stopping": True}:
                    raise broker_error(
                        "LIVE_BROKER_RESPONSE_INVALID",
                        "Broker shutdown result is invalid",
                        fatal=True,
                    )
            except (LiveBrokerError, JsonLineError, OSError, TimeoutError):
                pass
        await self._terminate_locked()
        self._state = "disabled" if not self.enabled else "stopped"

    async def restart(self) -> None:
        async with self._operation_lock:
            if not self.enabled:
                return
            await self._stop_locked()
            self._restart_count += 1
            await self._start_locked()
