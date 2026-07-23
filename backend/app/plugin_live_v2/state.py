"""Crash-safe policy epoch and opaque credential metadata for the Broker."""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app.plugin_host.framing import JsonLineError, strict_json_loads

from .errors import broker_error


BROKER_STATE_SCHEMA_VERSION = 2
BROKER_STATE_SCHEMA_V1 = 1
MAX_BROKER_STATE_BYTES = 1024 * 1024
_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")


def _string(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\0" in value
    ):
        raise broker_error(
            "LIVE_BROKER_STATE_INVALID",
            f"{label} is invalid",
            fatal=True,
        )
    return value


def _exact(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise broker_error(
            "LIVE_BROKER_STATE_INVALID",
            f"{label} fields do not match the state schema",
            fatal=True,
        )


@dataclass(frozen=True, slots=True)
class CredentialBinding:
    record_id: str
    handle_sha256: str
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    bundle_sha256: str
    manifest_sha256: str
    release_record_sha256: str
    release_lock_sha256: str
    label: str
    created_at: str
    policy_epoch: int

    def __post_init__(self) -> None:
        if not isinstance(self.record_id, str) or _HEX_32.fullmatch(
            self.record_id
        ) is None:
            raise ValueError("record_id is invalid")
        if not isinstance(self.handle_sha256, str) or _SHA256.fullmatch(
            self.handle_sha256
        ) is None:
            raise ValueError("handle_sha256 is invalid")
        for value in (self.plugin_id, self.connector_id):
            if not isinstance(value, str) or _ID.fullmatch(value) is None:
                raise ValueError("binding identity is invalid")
        for value in (
            self.bundle_sha256,
            self.manifest_sha256,
            self.release_record_sha256,
            self.release_lock_sha256,
        ):
            if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
                raise ValueError("binding digest is invalid")
        if (
            not isinstance(self.publisher_identity, str)
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
            or not isinstance(self.version, str)
            or not self.version
            or len(self.version) > 64
            or not isinstance(self.label, str)
            or not self.label
            or len(self.label) > 128
            or not isinstance(self.created_at, str)
            or not self.created_at
            or len(self.created_at) > 64
            or isinstance(self.policy_epoch, bool)
            or not isinstance(self.policy_epoch, int)
            or self.policy_epoch < 0
        ):
            raise ValueError("binding metadata is invalid")

    def to_wire(self) -> dict[str, Any]:
        return {
            "recordId": self.record_id,
            "handleSha256": self.handle_sha256,
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
            "releaseRecordSha256": self.release_record_sha256,
            "releaseLockSha256": self.release_lock_sha256,
            "label": self.label,
            "createdAt": self.created_at,
            "policyEpoch": self.policy_epoch,
        }

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "CredentialBinding":
        if not isinstance(value, dict):
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                f"{label} must be an object",
                fatal=True,
            )
        expected = {
            "recordId",
            "handleSha256",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "bundleSha256",
            "manifestSha256",
            "releaseRecordSha256",
            "releaseLockSha256",
            "label",
            "createdAt",
            "policyEpoch",
        }
        _exact(value, expected, label)
        try:
            return cls(
                record_id=_string(value["recordId"], f"{label}.recordId", maximum=32),
                handle_sha256=_string(
                    value["handleSha256"], f"{label}.handleSha256", maximum=71
                ),
                plugin_id=_string(
                    value["pluginId"], f"{label}.pluginId", maximum=128
                ),
                connector_id=_string(
                    value["connectorId"], f"{label}.connectorId", maximum=128
                ),
                publisher_identity=_string(
                    value["publisherIdentity"],
                    f"{label}.publisherIdentity",
                    maximum=256,
                ),
                version=_string(value["version"], f"{label}.version", maximum=64),
                bundle_sha256=_string(
                    value["bundleSha256"], f"{label}.bundleSha256", maximum=71
                ),
                manifest_sha256=_string(
                    value["manifestSha256"], f"{label}.manifestSha256", maximum=71
                ),
                release_record_sha256=_string(
                    value["releaseRecordSha256"],
                    f"{label}.releaseRecordSha256",
                    maximum=71,
                ),
                release_lock_sha256=_string(
                    value["releaseLockSha256"],
                    f"{label}.releaseLockSha256",
                    maximum=71,
                ),
                label=_string(value["label"], f"{label}.label", maximum=128),
                created_at=_string(
                    value["createdAt"], f"{label}.createdAt", maximum=64
                ),
                policy_epoch=value["policyEpoch"],
            )
        except ValueError as exc:
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                f"{label} is invalid",
                fatal=True,
            ) from exc


@dataclass(frozen=True, slots=True)
class AccountBinding:
    account_handle_sha256: str
    canonical_account_sha256: str
    credential_handle_sha256: str
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    bundle_sha256: str
    manifest_sha256: str
    release_record_sha256: str
    release_lock_sha256: str
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
    policy_epoch: int

    def __post_init__(self) -> None:
        for value in (
            self.account_handle_sha256,
            self.canonical_account_sha256,
            self.credential_handle_sha256,
            self.bundle_sha256,
            self.manifest_sha256,
            self.release_record_sha256,
            self.release_lock_sha256,
        ):
            if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
                raise ValueError("account binding digest is invalid")
        for value in (self.plugin_id, self.connector_id):
            if not isinstance(value, str) or _ID.fullmatch(value) is None:
                raise ValueError("account binding identity is invalid")
        if (
            not isinstance(self.publisher_identity, str)
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
            or not isinstance(self.version, str)
            or not self.version
            or len(self.version) > 64
            or self.venue != "okx"
            or self.environment != "demo"
            or self.product_scope != "spot"
            or self.permission != "read_only"
            or self.account_mode != "spot"
            or self.position_mode not in {"net_mode", "long_short_mode"}
            or self.status not in {"active", "credential-revoked"}
            or isinstance(self.credential_generation, bool)
            or not isinstance(self.credential_generation, int)
            or not 1 <= self.credential_generation <= (1 << 31) - 1
            or isinstance(self.asset_count, bool)
            or not isinstance(self.asset_count, int)
            or not 0 <= self.asset_count <= 10_000
            or not isinstance(self.created_at, str)
            or not self.created_at
            or len(self.created_at) > 64
            or not isinstance(self.refreshed_at, str)
            or not self.refreshed_at
            or len(self.refreshed_at) > 64
            or isinstance(self.policy_epoch, bool)
            or not isinstance(self.policy_epoch, int)
            or self.policy_epoch < 0
        ):
            raise ValueError("account binding metadata is invalid")

    def to_wire(self) -> dict[str, Any]:
        return {
            "accountHandleSha256": self.account_handle_sha256,
            "canonicalAccountSha256": self.canonical_account_sha256,
            "credentialHandleSha256": self.credential_handle_sha256,
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
            "releaseRecordSha256": self.release_record_sha256,
            "releaseLockSha256": self.release_lock_sha256,
            "venue": self.venue,
            "environment": self.environment,
            "productScope": self.product_scope,
            "permission": self.permission,
            "accountMode": self.account_mode,
            "positionMode": self.position_mode,
            "status": self.status,
            "credentialGeneration": self.credential_generation,
            "assetCount": self.asset_count,
            "createdAt": self.created_at,
            "refreshedAt": self.refreshed_at,
            "policyEpoch": self.policy_epoch,
        }

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "AccountBinding":
        if not isinstance(value, dict):
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                f"{label} must be an object",
                fatal=True,
            )
        expected = {
            "accountHandleSha256",
            "canonicalAccountSha256",
            "credentialHandleSha256",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "bundleSha256",
            "manifestSha256",
            "releaseRecordSha256",
            "releaseLockSha256",
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
            "policyEpoch",
        }
        _exact(value, expected, label)
        try:
            return cls(
                account_handle_sha256=_string(
                    value["accountHandleSha256"],
                    f"{label}.accountHandleSha256",
                    maximum=71,
                ),
                canonical_account_sha256=_string(
                    value["canonicalAccountSha256"],
                    f"{label}.canonicalAccountSha256",
                    maximum=71,
                ),
                credential_handle_sha256=_string(
                    value["credentialHandleSha256"],
                    f"{label}.credentialHandleSha256",
                    maximum=71,
                ),
                plugin_id=_string(
                    value["pluginId"], f"{label}.pluginId", maximum=128
                ),
                connector_id=_string(
                    value["connectorId"], f"{label}.connectorId", maximum=128
                ),
                publisher_identity=_string(
                    value["publisherIdentity"],
                    f"{label}.publisherIdentity",
                    maximum=256,
                ),
                version=_string(value["version"], f"{label}.version", maximum=64),
                bundle_sha256=_string(
                    value["bundleSha256"], f"{label}.bundleSha256", maximum=71
                ),
                manifest_sha256=_string(
                    value["manifestSha256"],
                    f"{label}.manifestSha256",
                    maximum=71,
                ),
                release_record_sha256=_string(
                    value["releaseRecordSha256"],
                    f"{label}.releaseRecordSha256",
                    maximum=71,
                ),
                release_lock_sha256=_string(
                    value["releaseLockSha256"],
                    f"{label}.releaseLockSha256",
                    maximum=71,
                ),
                venue=_string(value["venue"], f"{label}.venue", maximum=16),
                environment=_string(
                    value["environment"], f"{label}.environment", maximum=16
                ),
                product_scope=_string(
                    value["productScope"], f"{label}.productScope", maximum=16
                ),
                permission=_string(
                    value["permission"], f"{label}.permission", maximum=32
                ),
                account_mode=_string(
                    value["accountMode"], f"{label}.accountMode", maximum=32
                ),
                position_mode=_string(
                    value["positionMode"], f"{label}.positionMode", maximum=32
                ),
                status=_string(value["status"], f"{label}.status", maximum=32),
                credential_generation=value["credentialGeneration"],
                asset_count=value["assetCount"],
                created_at=_string(
                    value["createdAt"], f"{label}.createdAt", maximum=64
                ),
                refreshed_at=_string(
                    value["refreshedAt"], f"{label}.refreshedAt", maximum=64
                ),
                policy_epoch=value["policyEpoch"],
            )
        except ValueError as exc:
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                f"{label} is invalid",
                fatal=True,
            ) from exc


@dataclass(frozen=True, slots=True)
class BrokerPersistentState:
    broker_id: str
    vault_backend: str
    policy_epoch: int
    credentials: tuple[CredentialBinding, ...] = ()
    accounts: tuple[AccountBinding, ...] = ()
    pending_deletes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.broker_id, str) or _HEX_32.fullmatch(
            self.broker_id
        ) is None:
            raise ValueError("broker_id is invalid")
        if self.vault_backend not in {"fake", "windows-dpapi"}:
            raise ValueError("vault_backend is invalid")
        if (
            isinstance(self.policy_epoch, bool)
            or not isinstance(self.policy_epoch, int)
            or self.policy_epoch < 0
        ):
            raise ValueError("policy_epoch is invalid")
        credentials = tuple(self.credentials)
        accounts = tuple(self.accounts)
        pending = tuple(self.pending_deletes)
        if not all(isinstance(item, CredentialBinding) for item in credentials):
            raise ValueError("credentials are invalid")
        if not all(isinstance(item, AccountBinding) for item in accounts):
            raise ValueError("accounts are invalid")
        if not all(
            isinstance(item, str) and _HEX_32.fullmatch(item) is not None
            for item in pending
        ):
            raise ValueError("pending_deletes are invalid")
        handles = [item.handle_sha256 for item in credentials]
        record_ids = [item.record_id for item in credentials]
        account_handles = [item.account_handle_sha256 for item in accounts]
        canonical_accounts = [item.canonical_account_sha256 for item in accounts]
        credential_handles = set(handles)
        if (
            len(handles) != len(set(handles))
            or len(record_ids) != len(set(record_ids))
            or len(account_handles) != len(set(account_handles))
            or len(canonical_accounts) != len(set(canonical_accounts))
            or len(pending) != len(set(pending))
            or set(record_ids).intersection(pending)
            or any(item.policy_epoch != self.policy_epoch for item in credentials)
            or any(item.policy_epoch != self.policy_epoch for item in accounts)
            or any(
                item.status == "active"
                and item.credential_handle_sha256 not in credential_handles
                for item in accounts
            )
        ):
            raise ValueError("Broker state identities are ambiguous")
        object.__setattr__(self, "credentials", credentials)
        object.__setattr__(self, "accounts", accounts)
        object.__setattr__(self, "pending_deletes", pending)

    def to_wire(
        self,
        *,
        schema_version: int = BROKER_STATE_SCHEMA_VERSION,
    ) -> dict[str, Any]:
        if schema_version not in {
            BROKER_STATE_SCHEMA_V1,
            BROKER_STATE_SCHEMA_VERSION,
        }:
            raise ValueError("Broker state schema version is unsupported")
        if schema_version == BROKER_STATE_SCHEMA_V1 and self.accounts:
            raise ValueError("Broker state v1 cannot contain account bindings")
        value = {
            "schemaVersion": schema_version,
            "brokerId": self.broker_id,
            "vaultBackend": self.vault_backend,
            "policyEpoch": self.policy_epoch,
            "credentials": [
                item.to_wire()
                for item in sorted(
                    self.credentials, key=lambda binding: binding.handle_sha256
                )
            ],
            "pendingDeletes": sorted(self.pending_deletes),
        }
        if schema_version == BROKER_STATE_SCHEMA_VERSION:
            value["accounts"] = [
                item.to_wire()
                for item in sorted(
                    self.accounts,
                    key=lambda binding: binding.account_handle_sha256,
                )
            ]
        return value


class BrokerStateStore:
    def __init__(
        self,
        root: Path | str,
        *,
        vault_backend: str,
        accounts_enabled: bool = False,
    ) -> None:
        if not isinstance(accounts_enabled, bool):
            raise TypeError("accounts_enabled must be a boolean")
        self.root = Path(root).expanduser().resolve(strict=False)
        self.path = self.root / "broker-state-v1.json"
        self.vault_backend = vault_backend
        self.accounts_enabled = accounts_enabled
        self._write_schema_version = (
            BROKER_STATE_SCHEMA_VERSION
            if accounts_enabled
            else BROKER_STATE_SCHEMA_V1
        )

    def load_or_create(self) -> BrokerPersistentState:
        if not self.path.exists():
            state = BrokerPersistentState(
                broker_id=uuid.uuid4().hex,
                vault_backend=self.vault_backend,
                policy_epoch=0,
            )
            self.write(state)
            return state
        try:
            raw = self.path.read_bytes()
            value = strict_json_loads(
                raw,
                max_message_bytes=MAX_BROKER_STATE_BYTES,
            )
        except (OSError, JsonLineError) as exc:
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "unable to read Broker state",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        if not isinstance(value, dict):
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "Broker state must be an object",
                fatal=True,
            )
        schema_version = value.get("schemaVersion")
        expected = {
            "schemaVersion",
            "brokerId",
            "vaultBackend",
            "policyEpoch",
            "credentials",
            "pendingDeletes",
        }
        if schema_version == BROKER_STATE_SCHEMA_VERSION:
            expected.add("accounts")
        _exact(value, expected, "Broker state")
        if schema_version not in {
            BROKER_STATE_SCHEMA_V1,
            BROKER_STATE_SCHEMA_VERSION,
        }:
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "Broker state schemaVersion is unsupported",
                fatal=True,
            )
        if not isinstance(value["credentials"], list) or not isinstance(
            value["pendingDeletes"], list
        ):
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "Broker state collections are invalid",
                fatal=True,
            )
        if schema_version == BROKER_STATE_SCHEMA_VERSION and not isinstance(
            value["accounts"], list
        ):
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "Broker state accounts are invalid",
                fatal=True,
            )
        try:
            state = BrokerPersistentState(
                broker_id=_string(
                    value["brokerId"], "Broker state brokerId", maximum=32
                ),
                vault_backend=_string(
                    value["vaultBackend"],
                    "Broker state vaultBackend",
                    maximum=32,
                ),
                policy_epoch=value["policyEpoch"],
                credentials=tuple(
                    CredentialBinding.from_wire(
                        item, f"Broker state credentials[{index}]"
                    )
                    for index, item in enumerate(value["credentials"])
                ),
                accounts=tuple(
                    AccountBinding.from_wire(
                        item, f"Broker state accounts[{index}]"
                    )
                    for index, item in enumerate(
                        value["accounts"]
                        if schema_version == BROKER_STATE_SCHEMA_VERSION
                        else ()
                    )
                ),
                pending_deletes=tuple(
                    _string(
                        item,
                        f"Broker state pendingDeletes[{index}]",
                        maximum=32,
                    )
                    for index, item in enumerate(value["pendingDeletes"])
                ),
            )
        except ValueError as exc:
            raise broker_error(
                "LIVE_BROKER_STATE_INVALID",
                "Broker state values are invalid",
                fatal=True,
            ) from exc
        if state.vault_backend != self.vault_backend:
            raise broker_error(
                "LIVE_BROKER_VAULT_BACKEND_MISMATCH",
                "Broker state is bound to another vault backend",
                fatal=True,
            )
        if schema_version == BROKER_STATE_SCHEMA_VERSION:
            self._write_schema_version = BROKER_STATE_SCHEMA_VERSION
        elif self.accounts_enabled:
            self._write_schema_version = BROKER_STATE_SCHEMA_VERSION
            self.write(state)
        return state

    def write(self, state: BrokerPersistentState) -> None:
        if state.vault_backend != self.vault_backend:
            raise broker_error(
                "LIVE_BROKER_VAULT_BACKEND_MISMATCH",
                "Broker state cannot switch vault backend",
                fatal=True,
            )
        schema_version = (
            BROKER_STATE_SCHEMA_VERSION
            if state.accounts
            else self._write_schema_version
        )
        encoded = (
            json.dumps(
                state.to_wire(schema_version=schema_version),
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
        if len(encoded) > MAX_BROKER_STATE_BYTES:
            raise broker_error(
                "LIVE_BROKER_STATE_LIMIT",
                "Broker state exceeded its hard size limit",
                fatal=True,
            )
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(
            f".{self.path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("xb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            self._write_schema_version = schema_version
        except OSError as exc:
            raise broker_error(
                "LIVE_BROKER_STATE_WRITE_FAILED",
                "unable to atomically persist Broker state",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def without_missing_records(
        self,
        state: BrokerPersistentState,
        available_record_ids: set[str],
    ) -> BrokerPersistentState:
        retained = tuple(
            item
            for item in state.credentials
            if item.record_id in available_record_ids
        )
        retained_handles = {item.handle_sha256 for item in retained}
        accounts = tuple(
            replace(item, status="credential-revoked")
            if (
                item.status == "active"
                and item.credential_handle_sha256 not in retained_handles
            )
            else item
            for item in state.accounts
        )
        if retained == state.credentials and accounts == state.accounts:
            return state
        updated = replace(
            state,
            credentials=retained,
            accounts=accounts,
        )
        self.write(updated)
        return updated
