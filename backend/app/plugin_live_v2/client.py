"""Host-side owner of the private Live Broker worker process."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.plugin_host.framing import (
    JsonLineError,
    compact_json_bytes,
    strict_json_loads,
)
from app.plugin_host.process import ManagedSidecarProcess, SidecarProcessSpec

from .errors import LiveBrokerError, broker_error
from .protocol import (
    MAX_BROKER_MESSAGE_BYTES,
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
)
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


def _sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


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
            "networkMethods": 2 if self.read_only_accounts_enabled else 0,
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
            ):
                raise broker_error(
                    "LIVE_BROKER_BOOTSTRAP_REJECTED",
                    "Broker bootstrap proof does not match the private session",
                    fatal=True,
                )
            self._state = "ready"
        except BaseException as exc:
            self._last_error_code = (
                exc.code
                if isinstance(exc, LiveBrokerError)
                else "LIVE_BROKER_START_FAILED"
            )
            self._state = "failed"
            await self._terminate_locked()
            raise

    async def _terminate_locked(self) -> None:
        managed = self._managed
        self._managed = None
        self._session_id = None
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
                    "networkMethods",
                },
                "foundation.health result",
            )
            counts = (
                result["credentialCount"],
                result["accountCount"],
                result["pendingDeleteCount"],
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
                or result["networkMethods"]
                != (2 if self.read_only_accounts_enabled else 0)
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
