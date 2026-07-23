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


BROKER_STATE_SCHEMA_VERSION = 1
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
class BrokerPersistentState:
    broker_id: str
    vault_backend: str
    policy_epoch: int
    credentials: tuple[CredentialBinding, ...] = ()
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
        pending = tuple(self.pending_deletes)
        if not all(isinstance(item, CredentialBinding) for item in credentials):
            raise ValueError("credentials are invalid")
        if not all(
            isinstance(item, str) and _HEX_32.fullmatch(item) is not None
            for item in pending
        ):
            raise ValueError("pending_deletes are invalid")
        handles = [item.handle_sha256 for item in credentials]
        record_ids = [item.record_id for item in credentials]
        if (
            len(handles) != len(set(handles))
            or len(record_ids) != len(set(record_ids))
            or len(pending) != len(set(pending))
            or set(record_ids).intersection(pending)
        ):
            raise ValueError("Broker state identities are ambiguous")
        object.__setattr__(self, "credentials", credentials)
        object.__setattr__(self, "pending_deletes", pending)

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": BROKER_STATE_SCHEMA_VERSION,
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


class BrokerStateStore:
    def __init__(self, root: Path | str, *, vault_backend: str) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        self.path = self.root / "broker-state-v1.json"
        self.vault_backend = vault_backend

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
        expected = {
            "schemaVersion",
            "brokerId",
            "vaultBackend",
            "policyEpoch",
            "credentials",
            "pendingDeletes",
        }
        _exact(value, expected, "Broker state")
        if value["schemaVersion"] != BROKER_STATE_SCHEMA_VERSION:
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
        return state

    def write(self, state: BrokerPersistentState) -> None:
        if state.vault_backend != self.vault_backend:
            raise broker_error(
                "LIVE_BROKER_VAULT_BACKEND_MISMATCH",
                "Broker state cannot switch vault backend",
                fatal=True,
            )
        encoded = (
            json.dumps(
                state.to_wire(),
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
        if retained == state.credentials:
            return state
        updated = replace(state, credentials=retained)
        self.write(updated)
        return updated
