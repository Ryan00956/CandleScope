"""Opaque capability handles and bounded Host API dispatch for platform v2."""

from __future__ import annotations

import hashlib
import inspect
import math
import secrets
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    CapabilityGrant,
    HostCallRequest,
    PluginManifest,
    RuntimeDescriptor,
    canonical_dumps,
    normalize_json,
)

from .audit import AuditLog
from .errors import PlatformSecurityError, security_error
from .grants import EffectiveGrant, GrantStore
from .scope import normalize_scope, scope_contains


ScopeExtractor = Callable[[dict[str, Any]], dict[str, Any]]
CapabilityHandler = Callable[
    [HostCallRequest], Awaitable[dict[str, Any]] | dict[str, Any]
]
CapabilityLeaseHandler = Callable[
    [HostCallRequest, "CapabilityLease"],
    Awaitable[dict[str, Any]] | dict[str, Any],
]


def _fingerprint(handle: str) -> str:
    return hashlib.sha256(handle.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CapabilityLease:
    handle_fingerprint: str
    plugin_id: str
    entrypoint_id: str
    instance_id: str
    generation: int
    permission_id: str
    scope: dict[str, Any]
    contribution_ids: tuple[str, ...]
    store_revision: int
    bundle_sha256: str
    publisher_identity: str
    confirmation_version: int
    issued_monotonic: float
    expires_monotonic: float

    def summary(self) -> dict[str, Any]:
        return {
            "handleFingerprint": self.handle_fingerprint,
            "pluginId": self.plugin_id,
            "entrypointId": self.entrypoint_id,
            "instanceId": self.instance_id,
            "generation": self.generation,
            "permissionId": self.permission_id,
            "scope": dict(self.scope),
            "contributionIds": list(self.contribution_ids),
            "storeRevision": self.store_revision,
            "bundleSha256": self.bundle_sha256,
            "publisherIdentity": self.publisher_identity,
            "confirmationVersion": self.confirmation_version,
        }


class CapabilityHandleAuthority:
    """Mint unguessable in-memory handles bound to one activation generation."""

    def __init__(
        self,
        audit_log: AuditLog,
        *,
        default_ttl_seconds: float = 3_600.0,
        max_active_handles: int = 4_096,
        grant_store: GrantStore | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if (
            isinstance(default_ttl_seconds, bool)
            or not isinstance(default_ttl_seconds, (int, float))
            or not math.isfinite(default_ttl_seconds)
            or not 1.0 <= default_ttl_seconds <= 86_400.0
        ):
            raise ValueError("default_ttl_seconds is outside the supported range")
        if (
            isinstance(max_active_handles, bool)
            or not isinstance(max_active_handles, int)
            or not 1 <= max_active_handles <= 65_536
        ):
            raise ValueError("max_active_handles is outside the supported range")
        self.audit_log = audit_log
        self.default_ttl_seconds = float(default_ttl_seconds)
        self.max_active_handles = max_active_handles
        self.grant_store = grant_store
        self._clock = clock
        self._leases: dict[str, CapabilityLease] = {}
        self._revoked: deque[str] = deque(maxlen=8_192)
        self._revoked_set: set[str] = set()

    @property
    def active_count(self) -> int:
        self._purge_expired()
        return len(self._leases)

    def _remember_revoked(self, fingerprint: str) -> None:
        if fingerprint in self._revoked_set:
            return
        if len(self._revoked) == self._revoked.maxlen:
            expired = self._revoked.popleft()
            self._revoked_set.discard(expired)
        self._revoked.append(fingerprint)
        self._revoked_set.add(fingerprint)

    def _purge_expired(self) -> None:
        now = self._clock()
        for fingerprint, lease in tuple(self._leases.items()):
            if lease.expires_monotonic <= now:
                self._leases.pop(fingerprint, None)
                self._remember_revoked(fingerprint)

    @staticmethod
    def _manifest_requests(
        manifest: PluginManifest,
    ) -> dict[str, tuple[str, dict[str, Any]]]:
        return {
            request.id: (kind, dict(request.scope))
            for kind, values in (
                ("required", manifest.permissions.required),
                ("optional", manifest.permissions.optional),
            )
            for request in values
        }

    def mint_grants(
        self,
        *,
        manifest: PluginManifest,
        descriptor: RuntimeDescriptor,
        entrypoint_id: str,
        instance_id: str,
        generation: int,
        effective_grants: tuple[EffectiveGrant, ...],
        ttl_seconds: float | None = None,
        trace_id: str | None = None,
    ) -> tuple[CapabilityGrant, ...]:
        self._purge_expired()
        requests = self._manifest_requests(manifest)
        values = tuple(effective_grants)
        if len({item.permission_id for item in values}) != len(values):
            raise security_error(
                "CAPABILITY_GRANT_INVALID",
                "effective grants contain duplicate permissions",
                plugin_id=manifest.plugin.id,
            )
        by_id = {item.permission_id: item for item in values}
        missing = sorted(set(descriptor.required_permissions) - set(by_id))
        unexpected = sorted(set(by_id) - set(requests))
        if missing or unexpected:
            raise security_error(
                "CAPABILITY_GRANT_INVALID",
                "effective grants do not satisfy the runtime descriptor",
                plugin_id=manifest.plugin.id,
                details={"missing": missing, "unexpected": unexpected},
            )
        for permission_id, grant in by_id.items():
            requested_kind, requested_scope = requests[permission_id]
            if grant.plugin_id != manifest.plugin.id or grant.kind != requested_kind:
                raise security_error(
                    "CAPABILITY_GRANT_BINDING_INVALID",
                    "effective grant identity or kind does not match the manifest",
                    plugin_id=manifest.plugin.id,
                    details={"permissionId": permission_id},
                )
            if not scope_contains(requested_scope, grant.scope):
                raise security_error(
                    "CAPABILITY_SCOPE_INVALID",
                    "effective grant exceeds the manifest request",
                    plugin_id=manifest.plugin.id,
                    details={"permissionId": permission_id},
                )
            if requested_kind == "required" and not scope_contains(
                grant.scope, requested_scope
            ):
                raise security_error(
                    "CAPABILITY_REQUIRED_SCOPE_INCOMPLETE",
                    "required permission is only partially granted",
                    plugin_id=manifest.plugin.id,
                    details={"permissionId": permission_id},
                )
        if len(self._leases) + len(values) > self.max_active_handles:
            raise security_error(
                "CAPABILITY_HANDLE_QUOTA_EXCEEDED",
                "active capability handle quota is exhausted",
                plugin_id=manifest.plugin.id,
            )
        ttl = self.default_ttl_seconds if ttl_seconds is None else float(ttl_seconds)
        if not 1.0 <= ttl <= self.default_ttl_seconds:
            raise security_error(
                "CAPABILITY_TTL_INVALID",
                "capability TTL exceeds the Host policy",
                plugin_id=manifest.plugin.id,
            )
        issued = self._clock()
        contribution_ids = tuple(item.id for item in descriptor.contributions)
        raw: list[CapabilityGrant] = []
        created: list[str] = []
        try:
            for permission_id in sorted(by_id):
                grant = by_id[permission_id]
                handle = "caph_" + secrets.token_urlsafe(32)
                fingerprint = _fingerprint(handle)
                if fingerprint in self._leases or fingerprint in self._revoked_set:
                    raise security_error(
                        "CAPABILITY_HANDLE_COLLISION",
                        "unable to mint a unique capability handle",
                        plugin_id=manifest.plugin.id,
                    )
                lease = CapabilityLease(
                    fingerprint,
                    manifest.plugin.id,
                    entrypoint_id,
                    instance_id,
                    generation,
                    permission_id,
                    normalize_scope(grant.scope, path="capability.scope"),
                    contribution_ids,
                    grant.store_revision,
                    grant.bundle_sha256,
                    grant.publisher_identity,
                    grant.confirmation_version,
                    issued,
                    issued + ttl,
                )
                self._leases[fingerprint] = lease
                created.append(fingerprint)
                raw.append(CapabilityGrant(handle, permission_id, dict(lease.scope)))
            event_trace = trace_id or f"capability-mint-{uuid.uuid4().hex}"
            self.audit_log.append(
                category="capability",
                action="mint",
                outcome="allowed",
                trace_id=event_trace,
                plugin_id=manifest.plugin.id,
                data={
                    "entrypointId": entrypoint_id,
                    "instanceId": instance_id,
                    "generation": generation,
                    "permissions": sorted(by_id),
                    "handleFingerprints": created,
                    "ttlSeconds": ttl,
                },
            )
            return tuple(raw)
        except BaseException:
            for fingerprint in created:
                self._leases.pop(fingerprint, None)
                self._remember_revoked(fingerprint)
            raise

    def validate(
        self,
        call: HostCallRequest,
        grant: CapabilityGrant,
        *,
        plugin_id: str,
        entrypoint_id: str,
        instance_id: str,
        generation: int,
    ) -> CapabilityLease:
        self._purge_expired()
        fingerprint = _fingerprint(call.capability_handle)
        lease = self._leases.get(fingerprint)
        if lease is None:
            reason = "revoked" if fingerprint in self._revoked_set else "unknown"
            self._audit_validation_denied(
                call,
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
                instance_id=instance_id,
                generation=generation,
                handle_fingerprint=fingerprint,
                reason=reason,
            )
            raise security_error(
                "CAPABILITY_HANDLE_INVALID",
                "capability handle is unknown, expired, or revoked",
                plugin_id=plugin_id,
                details={"reason": reason},
            )
        if (
            lease.plugin_id != plugin_id
            or lease.entrypoint_id != entrypoint_id
            or lease.instance_id != instance_id
            or lease.generation != generation
            or call.request_context.generation != generation
            or call.request_context.contribution_id not in lease.contribution_ids
            or lease.permission_id != grant.permission_id
            or lease.scope != grant.scope
        ):
            self._audit_validation_denied(
                call,
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
                instance_id=instance_id,
                generation=generation,
                handle_fingerprint=fingerprint,
                reason="binding",
            )
            raise security_error(
                "CAPABILITY_HANDLE_INVALID",
                "capability handle binding does not match the active request",
                plugin_id=plugin_id,
            )
        if self.grant_store is not None and not self.grant_store.is_effective_binding(
            plugin_id=lease.plugin_id,
            permission_id=lease.permission_id,
            scope=lease.scope,
            bundle_sha256=lease.bundle_sha256,
            publisher_identity=lease.publisher_identity,
            confirmation_version=lease.confirmation_version,
        ):
            self._leases.pop(fingerprint, None)
            self._remember_revoked(fingerprint)
            self._audit_revoke(
                (lease,),
                "grant-binding",
                call.request_context.trace_id,
            )
            self._audit_validation_denied(
                call,
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
                instance_id=instance_id,
                generation=generation,
                handle_fingerprint=fingerprint,
                reason="grant-changed",
            )
            raise security_error(
                "CAPABILITY_HANDLE_INVALID",
                "capability handle is no longer granted",
                plugin_id=plugin_id,
                details={"reason": "grant-changed"},
            )
        return lease

    def _audit_validation_denied(
        self,
        call: HostCallRequest,
        *,
        plugin_id: str,
        entrypoint_id: str,
        instance_id: str,
        generation: int,
        handle_fingerprint: str,
        reason: str,
    ) -> None:
        self.audit_log.append(
            category="capability",
            action="validate",
            outcome="denied",
            trace_id=call.request_context.trace_id,
            plugin_id=plugin_id,
            data={
                "entrypointId": entrypoint_id,
                "instanceId": instance_id,
                "generation": generation,
                "contributionId": call.request_context.contribution_id,
                "method": call.method,
                "handleFingerprint": handle_fingerprint,
                "reason": reason,
            },
        )

    def revoke_handle(self, handle: str, *, trace_id: str | None = None) -> bool:
        fingerprint = _fingerprint(handle)
        lease = self._leases.pop(fingerprint, None)
        self._remember_revoked(fingerprint)
        if lease is None:
            return False
        self._audit_revoke((lease,), "handle", trace_id)
        return True

    def revoke_instance(
        self,
        plugin_id: str,
        entrypoint_id: str,
        instance_id: str,
        generation: int,
        *,
        trace_id: str | None = None,
    ) -> int:
        leases = tuple(
            item
            for item in self._leases.values()
            if item.plugin_id == plugin_id
            and item.entrypoint_id == entrypoint_id
            and item.instance_id == instance_id
            and item.generation == generation
        )
        for lease in leases:
            self._leases.pop(lease.handle_fingerprint, None)
            self._remember_revoked(lease.handle_fingerprint)
        if leases:
            self._audit_revoke(leases, "instance", trace_id)
        return len(leases)

    def revoke_plugin(self, plugin_id: str, *, trace_id: str | None = None) -> int:
        leases = tuple(
            item for item in self._leases.values() if item.plugin_id == plugin_id
        )
        for lease in leases:
            self._leases.pop(lease.handle_fingerprint, None)
            self._remember_revoked(lease.handle_fingerprint)
        if leases:
            self._audit_revoke(leases, "plugin", trace_id)
        return len(leases)

    def _audit_revoke(
        self,
        leases: tuple[CapabilityLease, ...],
        target: str,
        trace_id: str | None,
    ) -> None:
        first = leases[0]
        self.audit_log.append(
            category="capability",
            action="revoke",
            outcome="allowed",
            trace_id=trace_id or f"capability-revoke-{uuid.uuid4().hex}",
            plugin_id=first.plugin_id,
            data={
                "target": target,
                "entrypointId": first.entrypoint_id,
                "instanceId": first.instance_id,
                "generation": first.generation,
                "handleFingerprints": sorted(
                    item.handle_fingerprint for item in leases
                ),
            },
        )


@dataclass(frozen=True, slots=True)
class CapabilityMethodPolicy:
    method: str
    permission_id: str
    handler: CapabilityHandler | None = None
    scope_extractor: ScopeExtractor = lambda _params: {}
    require_user_action: bool = False
    max_calls_per_minute: int = 60
    max_calls_per_activation: int = 1_000
    handler_with_lease: CapabilityLeaseHandler | None = None

    def __post_init__(self) -> None:
        if (
            not self.method
            or not self.permission_id
            or (self.handler is None) == (self.handler_with_lease is None)
            or (self.handler is not None and not callable(self.handler))
            or (
                self.handler_with_lease is not None
                and not callable(self.handler_with_lease)
            )
        ):
            raise ValueError("capability method policy identity is invalid")
        if not callable(self.scope_extractor):
            raise ValueError("scope_extractor must be callable")
        if (
            isinstance(self.max_calls_per_minute, bool)
            or not isinstance(self.max_calls_per_minute, int)
            or not 1 <= self.max_calls_per_minute <= 100_000
        ):
            raise ValueError("max_calls_per_minute is outside the supported range")
        if (
            isinstance(self.max_calls_per_activation, bool)
            or not isinstance(self.max_calls_per_activation, int)
            or not 1 <= self.max_calls_per_activation <= 1_000_000
        ):
            raise ValueError("max_calls_per_activation is outside the supported range")


class CapabilityBroker:
    """Validate a lease, scope, rate, quota, and trace before Host dispatch."""

    def __init__(
        self,
        authority: CapabilityHandleAuthority,
        audit_log: AuditLog,
        *,
        max_request_bytes: int = 256 * 1024,
        max_response_bytes: int = 256 * 1024,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        for label, value in (
            ("max_request_bytes", max_request_bytes),
            ("max_response_bytes", max_response_bytes),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 1 <= value <= 16 * 1024 * 1024
            ):
                raise ValueError(f"{label} is outside the supported range")
        self.authority = authority
        self.audit_log = audit_log
        self.max_request_bytes = max_request_bytes
        self.max_response_bytes = max_response_bytes
        self._clock = clock
        self._policies: dict[str, CapabilityMethodPolicy] = {}
        self._recent_calls: dict[tuple[str, str, str], deque[float]] = defaultdict(
            deque
        )
        self._activation_calls: dict[tuple[str, str, int, str], int] = defaultdict(int)

    def register(self, policy: CapabilityMethodPolicy) -> None:
        if policy.method in self._policies:
            raise ValueError("capability method is already registered")
        self._policies[policy.method] = policy

    async def handle(
        self,
        call: HostCallRequest,
        grant: CapabilityGrant,
        lease: CapabilityLease,
    ) -> dict[str, Any]:
        started = self._clock()
        try:
            policy = self._policies.get(call.method)
            if policy is None:
                raise security_error(
                    "CAPABILITY_METHOD_DENIED",
                    "Host method is not registered",
                    plugin_id=lease.plugin_id,
                )
            if policy.permission_id != grant.permission_id:
                raise security_error(
                    "CAPABILITY_PERMISSION_MISMATCH",
                    "Host method does not belong to the supplied capability",
                    plugin_id=lease.plugin_id,
                )
            if policy.require_user_action and not call.request_context.user_action:
                raise security_error(
                    "CAPABILITY_USER_ACTION_REQUIRED",
                    "Host method requires a current user action",
                    plugin_id=lease.plugin_id,
                )
            request_bytes = len(canonical_dumps(call.params).encode("utf-8"))
            if request_bytes > self.max_request_bytes:
                raise security_error(
                    "CAPABILITY_REQUEST_QUOTA_EXCEEDED",
                    "Host method request exceeds the byte quota",
                    plugin_id=lease.plugin_id,
                )
            required_scope = normalize_scope(
                policy.scope_extractor(dict(call.params)),
                path="host.call.requiredScope",
            )
            if not scope_contains(lease.scope, required_scope):
                raise security_error(
                    "CAPABILITY_SCOPE_DENIED",
                    "Host method request exceeds the granted scope",
                    plugin_id=lease.plugin_id,
                    details={"permissionId": lease.permission_id},
                )
            self._consume_budget(policy, lease)
            if policy.handler_with_lease is not None:
                result = policy.handler_with_lease(call, lease)
            else:
                assert policy.handler is not None
                result = policy.handler(call)
            if inspect.isawaitable(result):
                result = await result
            normalized = normalize_json(result, path="host.call.result")
            if not isinstance(normalized, dict):
                raise security_error(
                    "CAPABILITY_RESULT_INVALID",
                    "Host method must return a JSON object",
                    plugin_id=lease.plugin_id,
                )
            response_bytes = len(canonical_dumps(normalized).encode("utf-8"))
            if response_bytes > self.max_response_bytes:
                raise security_error(
                    "CAPABILITY_RESPONSE_QUOTA_EXCEEDED",
                    "Host method response exceeds the byte quota",
                    plugin_id=lease.plugin_id,
                )
            self._audit_call(
                call,
                lease,
                outcome="allowed",
                data={
                    "requestBytes": request_bytes,
                    "responseBytes": response_bytes,
                    "durationMicros": max(
                        0, int((self._clock() - started) * 1_000_000)
                    ),
                },
            )
            return normalized
        except PlatformSecurityError as exc:
            self._audit_call(
                call,
                lease,
                outcome="denied",
                data={"code": exc.code},
            )
            raise
        except Exception as exc:
            self._audit_call(
                call,
                lease,
                outcome="error",
                data={
                    "code": "CAPABILITY_HANDLER_FAILED",
                    "errorType": type(exc).__name__,
                },
            )
            raise

    def _consume_budget(
        self, policy: CapabilityMethodPolicy, lease: CapabilityLease
    ) -> None:
        now = self._clock()
        rate_key = (lease.plugin_id, lease.instance_id, policy.method)
        recent = self._recent_calls[rate_key]
        while recent and recent[0] <= now - 60.0:
            recent.popleft()
        if len(recent) >= policy.max_calls_per_minute:
            raise security_error(
                "CAPABILITY_RATE_LIMITED",
                "Host method rate limit is exhausted",
                plugin_id=lease.plugin_id,
            )
        quota_key = (
            lease.plugin_id,
            lease.instance_id,
            lease.generation,
            policy.method,
        )
        if self._activation_calls[quota_key] >= policy.max_calls_per_activation:
            raise security_error(
                "CAPABILITY_CALL_QUOTA_EXCEEDED",
                "Host method activation quota is exhausted",
                plugin_id=lease.plugin_id,
            )
        recent.append(now)
        self._activation_calls[quota_key] += 1

    def revoke_instance(self, lease: CapabilityLease) -> None:
        prefix = (lease.plugin_id, lease.instance_id)
        for key in tuple(self._recent_calls):
            if key[:2] == prefix:
                self._recent_calls.pop(key, None)
        for key in tuple(self._activation_calls):
            if key[:2] == prefix:
                self._activation_calls.pop(key, None)

    def _audit_call(
        self,
        call: HostCallRequest,
        lease: CapabilityLease,
        *,
        outcome: str,
        data: dict[str, Any],
    ) -> None:
        self.audit_log.append(
            category="capability",
            action="host.call",
            outcome=outcome,
            trace_id=call.request_context.trace_id,
            plugin_id=lease.plugin_id,
            data={
                "entrypointId": lease.entrypoint_id,
                "instanceId": lease.instance_id,
                "generation": lease.generation,
                "contributionId": call.request_context.contribution_id,
                "permissionId": lease.permission_id,
                "method": call.method,
                "handleFingerprint": lease.handle_fingerprint,
                **data,
            },
        )
