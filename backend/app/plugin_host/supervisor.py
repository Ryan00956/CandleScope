"""Lifecycle, generation, and circuit-breaker ownership for one v2 entrypoint."""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from candlescope_plugin_sdk.platform_v2 import (
    CONTROL_TRANSPORT_V1,
    PLUGIN_PROTOCOL_V2,
    ActivationRequest,
    CapabilityGrant,
    HandshakeRequest,
    HostCallRequest,
    InvokeRequest,
    PlatformContractError,
    PluginManifest,
    RequestContext,
    RuntimeDescriptor,
    normalize_json,
)
from candlescope_plugin_sdk.platform_v2.constants import (
    METHOD_ACTIVATE,
    METHOD_DEACTIVATE,
    METHOD_DESCRIBE,
    METHOD_EVENT_BATCH,
    METHOD_HANDSHAKE,
    METHOD_HEALTH_CHECK,
    METHOD_INVOKE,
    METHOD_PREPARE_UPGRADE,
    METHOD_SHUTDOWN,
)

from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityHandleAuthority,
)
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.grants import EffectiveGrant
from app.plugin_security_v2.sandbox import SandboxPolicy

from .errors import (
    PlatformHostError,
    PlatformHostRemoteError,
    PlatformHostRequestError,
    PlatformHostStateError,
    PlatformHostTransportError,
)
from .process import SidecarProcessSpec
from .transport import PlatformV2Transport


STATE_DISABLED = "disabled"
STATE_STOPPED = "stopped"
STATE_STARTING = "starting"
STATE_HANDSHAKEN = "handshaken"
STATE_ACTIVE = "active"
STATE_QUIESCING = "quiescing"
STATE_DEACTIVATING = "deactivating"
STATE_STOPPING = "stopping"
STATE_FAILED = "failed"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


GrantedHostCallHandler = Callable[
    [HostCallRequest, CapabilityGrant],
    Awaitable[dict[str, Any]],
]


@dataclass(frozen=True, slots=True)
class EntrypointProcessSpec:
    plugin_id: str
    entrypoint_id: str
    executable: Path
    arguments: tuple[str, ...] = ()
    working_directory: Path | None = None
    enabled: bool = True
    auto_start: bool = False
    required: bool = False
    startup_timeout_seconds: float = 5.0
    request_timeout_seconds: float = 10.0
    shutdown_timeout_seconds: float = 2.0
    max_message_bytes: int = 1024 * 1024
    max_stderr_bytes: int = 64 * 1024
    max_in_flight: int = 32
    max_host_calls: int = 8
    max_restart_attempts: int = 3
    restart_window_seconds: float = 60.0
    sandbox_policy: SandboxPolicy | None = None
    trust_level: str = "local-trusted"

    def __post_init__(self) -> None:
        if not isinstance(self.plugin_id, str) or not self.plugin_id:
            raise ValueError("plugin_id must be a non-empty string")
        if not isinstance(self.entrypoint_id, str) or not self.entrypoint_id:
            raise ValueError("entrypoint_id must be a non-empty string")
        if not isinstance(self.enabled, bool):
            raise ValueError("enabled must be a boolean")
        if not isinstance(self.auto_start, bool):
            raise ValueError("auto_start must be a boolean")
        if not isinstance(self.required, bool):
            raise ValueError("required must be a boolean")
        for name in (
            "startup_timeout_seconds",
            "request_timeout_seconds",
            "shutdown_timeout_seconds",
            "restart_window_seconds",
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value <= 0
            ):
                raise ValueError(f"{name} must be positive")
        if (
            isinstance(self.max_restart_attempts, bool)
            or not isinstance(self.max_restart_attempts, int)
            or not 0 <= self.max_restart_attempts <= 100
        ):
            raise ValueError("max_restart_attempts is outside the supported range")
        SidecarProcessSpec(
            identity=f"{self.plugin_id}:{self.entrypoint_id}",
            executable=self.executable,
            arguments=self.arguments,
            working_directory=self.working_directory,
            max_message_bytes=self.max_message_bytes,
            max_stderr_bytes=self.max_stderr_bytes,
            sandbox_policy=self.sandbox_policy,
            trust_level=self.trust_level,
        )
        if (
            isinstance(self.max_in_flight, bool)
            or not isinstance(self.max_in_flight, int)
            or not 1 <= self.max_in_flight <= 1024
        ):
            raise ValueError("max_in_flight is outside the supported range")
        if (
            isinstance(self.max_host_calls, bool)
            or not isinstance(self.max_host_calls, int)
            or not 1 <= self.max_host_calls <= self.max_in_flight
        ):
            raise ValueError("max_host_calls is outside the supported range")

    def process_spec(self) -> SidecarProcessSpec:
        return SidecarProcessSpec(
            identity=f"{self.plugin_id}:{self.entrypoint_id}",
            executable=self.executable,
            arguments=self.arguments,
            working_directory=self.working_directory,
            max_message_bytes=self.max_message_bytes,
            max_stderr_bytes=self.max_stderr_bytes,
            sandbox_policy=self.sandbox_policy,
            trust_level=self.trust_level,
        )


class EntrypointSupervisor:
    """Own one immutable manifest entrypoint and all of its process generations."""

    def __init__(
        self,
        spec: EntrypointProcessSpec,
        manifest: PluginManifest,
        *,
        host_name: str,
        host_version: str,
        host_apis: tuple[str, ...] = (),
        host_call_handler: GrantedHostCallHandler | None = None,
        capability_authority: CapabilityHandleAuthority | None = None,
        capability_broker: CapabilityBroker | None = None,
    ) -> None:
        if not isinstance(manifest, PluginManifest):
            raise TypeError("manifest must be PluginManifest")
        if manifest.plugin.id != spec.plugin_id:
            raise ValueError("process spec plugin_id does not match manifest")
        entrypoints = {item.id for item in manifest.backend_entrypoints}
        if spec.entrypoint_id not in entrypoints:
            raise ValueError("process spec entrypoint_id is absent from manifest")
        if not isinstance(host_name, str) or not host_name:
            raise ValueError("host_name must be a non-empty string")
        if not isinstance(host_version, str) or not host_version:
            raise ValueError("host_version must be a non-empty string")
        if not all(isinstance(item, str) and item for item in host_apis):
            raise ValueError("host_apis must contain non-empty strings")
        if len(set(host_apis)) != len(host_apis):
            raise ValueError("host_apis must not contain duplicates")
        if capability_broker is not None and capability_authority is None:
            raise ValueError("capability_broker requires capability_authority")
        if (
            capability_broker is not None
            and capability_broker.authority is not capability_authority
        ):
            raise ValueError("capability broker and authority do not match")
        if capability_broker is not None and host_call_handler is not None:
            raise ValueError(
                "capability_broker and legacy host_call_handler are mutually exclusive"
            )
        self.spec = spec
        self.manifest = manifest
        self.host_name = host_name
        self.host_version = host_version
        self.host_apis = tuple(host_apis)
        self._host_call_handler = host_call_handler
        self._capability_authority = capability_authority
        self._capability_broker = capability_broker
        self._state = STATE_STOPPED if spec.enabled else STATE_DISABLED
        self._lifecycle_lock = asyncio.Lock()
        self._transport: PlatformV2Transport | None = None
        self._descriptor: RuntimeDescriptor | None = None
        self._negotiated_host_apis: tuple[str, ...] = ()
        self._generation = 0
        self._highest_generation = 0
        self._instance_id: str | None = None
        self._grants: dict[str, CapabilityGrant] = {}
        self._restart_times: deque[float] = deque()
        self._launch_attempts = 0
        self._start_count = 0
        self._restart_count = 0
        self._request_count = 0
        self._remote_error_count = 0
        self._failure_count = 0
        self._recorded_failures: set[tuple[int, str]] = set()
        self._last_failure: dict[str, Any] | None = None
        self._last_remote_error: dict[str, Any] | None = None
        self._last_stderr_tail = ""
        self._started_at: str | None = None
        self._last_request_at: str | None = None

    @property
    def plugin_id(self) -> str:
        return self.spec.plugin_id

    @property
    def entrypoint_id(self) -> str:
        return self.spec.entrypoint_id

    @property
    def owner_key(self) -> tuple[str, str]:
        return (self.plugin_id, self.entrypoint_id)

    @property
    def state(self) -> str:
        self._refresh_transport_failure()
        return self._state

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def descriptor_value(self) -> RuntimeDescriptor | None:
        return self._descriptor

    async def start(self) -> RuntimeDescriptor:
        async with self._lifecycle_lock:
            return await self._ensure_started_locked()

    async def _ensure_started_locked(self) -> RuntimeDescriptor:
        self._refresh_transport_failure()
        if not self.spec.enabled:
            raise self._request_error(
                "PLUGIN_PLATFORM_DISABLED", "entrypoint is disabled"
            )
        if self._state in {STATE_HANDSHAKEN, STATE_ACTIVE, STATE_QUIESCING}:
            if self._descriptor is not None and self._transport is not None:
                return self._descriptor
        await self._close_transport_locked()
        self._consume_restart_budget()
        self._state = STATE_STARTING
        self._last_stderr_tail = ""
        self._descriptor = None
        self._negotiated_host_apis = ()
        self._generation = 0
        self._instance_id = None
        self._grants.clear()
        transport = PlatformV2Transport(
            self.spec.process_spec(),
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
            host_call_handler=self._handle_host_call,
            max_in_flight=self.spec.max_in_flight,
            max_host_calls=self.spec.max_host_calls,
        )
        self._transport = transport
        self._start_count += 1
        self._started_at = _utc_now()
        try:
            await transport.start()
            handshake = HandshakeRequest(
                protocols=(PLUGIN_PROTOCOL_V2,),
                host_name=self.host_name,
                host_version=self.host_version,
                entrypoint_id=self.entrypoint_id,
                host_apis=self.host_apis,
                transports=(CONTROL_TRANSPORT_V1,),
            )
            handshake_raw = await self._request_locked(
                METHOD_HANDSHAKE,
                handshake.to_wire(),
                generation=0,
                timeout=self.spec.startup_timeout_seconds,
            )
            descriptor, negotiated = self._parse_handshake(handshake_raw)
            described_raw = await self._request_locked(
                METHOD_DESCRIBE,
                {},
                generation=0,
                timeout=self.spec.startup_timeout_seconds,
            )
            described = self._parse_descriptor(described_raw)
            if described != descriptor:
                raise self._transport_error(
                    "PLUGIN_PLATFORM_DESCRIPTOR_CHANGED",
                    "runtime descriptor changed after handshake",
                )
            self._descriptor = descriptor
            self._negotiated_host_apis = negotiated
            self._state = STATE_HANDSHAKEN
            return descriptor
        except asyncio.CancelledError:
            error = self._transport_error(
                "PLUGIN_PLATFORM_START_CANCELLED",
                "entrypoint startup was cancelled",
            )
            await self._fail_locked(error)
            raise
        except PlatformHostError as exc:
            await self._fail_locked(exc)
            raise
        except (OSError, ValueError, PlatformContractError) as exc:
            error = self._transport_error(
                "PLUGIN_PLATFORM_START_FAILED",
                "unable to start and negotiate the entrypoint",
                details={"exceptionType": type(exc).__name__},
            )
            await self._fail_locked(error)
            raise error from exc

    def _parse_handshake(
        self,
        value: dict[str, Any],
    ) -> tuple[RuntimeDescriptor, tuple[str, ...]]:
        expected_keys = {"protocol", "transport", "descriptor", "negotiatedHostApis"}
        if set(value) != expected_keys:
            raise self._transport_error(
                "PLUGIN_PLATFORM_HANDSHAKE_INVALID",
                "handshake result contains missing or unknown fields",
            )
        if value["protocol"] != PLUGIN_PROTOCOL_V2:
            raise self._transport_error(
                "PLUGIN_PLATFORM_PROTOCOL_UNSUPPORTED",
                "entrypoint selected an unsupported protocol",
            )
        if value["transport"] != CONTROL_TRANSPORT_V1:
            raise self._transport_error(
                "PLUGIN_PLATFORM_TRANSPORT_UNSUPPORTED",
                "entrypoint selected an unsupported control transport",
            )
        descriptor = self._parse_descriptor(value["descriptor"])
        raw_negotiated = value["negotiatedHostApis"]
        if not isinstance(raw_negotiated, list) or not all(
            isinstance(item, str) for item in raw_negotiated
        ):
            raise self._transport_error(
                "PLUGIN_PLATFORM_HANDSHAKE_INVALID",
                "negotiatedHostApis must be an array of strings",
            )
        negotiated = tuple(raw_negotiated)
        declared_host_apis = (
            descriptor.required_host_apis + descriptor.optional_host_apis
        )
        if len(set(declared_host_apis)) != len(declared_host_apis):
            raise self._transport_error(
                "PLUGIN_PLATFORM_DESCRIPTOR_INVALID",
                "entrypoint descriptor contains duplicate Host API declarations",
            )
        missing_required = sorted(
            set(descriptor.required_host_apis) - set(self.host_apis)
        )
        if missing_required:
            raise self._transport_error(
                "PLUGIN_PLATFORM_HOST_API_UNSUPPORTED",
                "Host does not provide APIs required by the entrypoint",
                details={"missingHostApis": missing_required},
            )
        expected = tuple(item for item in declared_host_apis if item in self.host_apis)
        if negotiated != expected:
            raise self._transport_error(
                "PLUGIN_PLATFORM_HOST_API_NEGOTIATION_INVALID",
                "entrypoint returned an invalid Host API negotiation",
                details={"expected": list(expected), "actual": list(negotiated)},
            )
        return descriptor, negotiated

    def _parse_descriptor(self, value: Any) -> RuntimeDescriptor:
        try:
            descriptor = RuntimeDescriptor.from_wire(value)
            self.manifest.validate_descriptor(descriptor)
        except PlatformContractError as exc:
            raise self._transport_error(
                "PLUGIN_PLATFORM_DESCRIPTOR_INVALID",
                "entrypoint descriptor does not match its immutable manifest",
                details={"contractCode": exc.code, "path": exc.path},
            ) from exc
        if descriptor.plugin_id != self.plugin_id:
            raise self._transport_error(
                "PLUGIN_PLATFORM_IDENTITY_MISMATCH",
                "entrypoint descriptor plugin id does not match the process spec",
            )
        if descriptor.entrypoint_id != self.entrypoint_id:
            raise self._transport_error(
                "PLUGIN_PLATFORM_IDENTITY_MISMATCH",
                "entrypoint descriptor id does not match the process spec",
            )
        return descriptor

    async def activate(
        self,
        capabilities: tuple[CapabilityGrant, ...] = (),
        *,
        effective_grants: tuple[EffectiveGrant, ...] = (),
        capability_ttl_seconds: float | None = None,
    ) -> RuntimeDescriptor:
        async with self._lifecycle_lock:
            descriptor = await self._ensure_started_locked()
            if self._state != STATE_HANDSHAKEN:
                raise self._state_error(
                    "PLUGIN_PLATFORM_ACTIVATION_STATE_INVALID",
                    "entrypoint must be inactive before activation",
                )
            self._highest_generation += 1
            generation = self._highest_generation
            instance_id = f"instance-{uuid4().hex}"
            supplied_grants = tuple(capabilities)
            effective = tuple(effective_grants)
            if supplied_grants and effective:
                raise self._request_error(
                    "PLUGIN_PLATFORM_CAPABILITIES_INVALID",
                    "raw and effective grants must not be mixed",
                )
            if self._capability_authority is not None:
                if supplied_grants:
                    raise self._request_error(
                        "PLUGIN_PLATFORM_CAPABILITIES_INVALID",
                        "raw capability handles cannot be injected when an authority is configured",
                    )
                try:
                    grants = self._capability_authority.mint_grants(
                        manifest=self.manifest,
                        descriptor=descriptor,
                        entrypoint_id=self.entrypoint_id,
                        instance_id=instance_id,
                        generation=generation,
                        effective_grants=effective,
                        ttl_seconds=capability_ttl_seconds,
                    )
                except PlatformSecurityError as exc:
                    raise self._request_error(
                        exc.code,
                        exc.message,
                        details=exc.details,
                    ) from exc
            else:
                if effective:
                    raise self._request_error(
                        "PLUGIN_PLATFORM_CAPABILITIES_INVALID",
                        "effective grants require a capability authority",
                    )
                grants = supplied_grants
            try:
                self._validate_grants(descriptor, grants)
            except BaseException:
                self._revoke_capabilities(instance_id, generation)
                raise
            activation = ActivationRequest(instance_id, generation, grants)
            try:
                result = await self._lifecycle_request_locked(
                    METHOD_ACTIVATE,
                    activation.to_wire(),
                    generation=generation,
                    timeout=self.spec.startup_timeout_seconds,
                )
            except BaseException:
                self._revoke_capabilities(instance_id, generation)
                raise
            expected = {
                "ok": True,
                "instanceId": instance_id,
                "generation": generation,
            }
            if result != expected:
                error = self._transport_error(
                    "PLUGIN_PLATFORM_ACTIVATION_INVALID",
                    "entrypoint returned an invalid activation result",
                )
                self._revoke_capabilities(instance_id, generation)
                await self._fail_locked(error)
                raise error
            transport = self._transport
            if transport is None:
                self._revoke_capabilities(instance_id, generation)
                raise self._transport_error(
                    "PLUGIN_PLATFORM_NOT_RUNNING",
                    "entrypoint transport disappeared during activation",
                )
            self._generation = generation
            self._instance_id = instance_id
            self._grants = {item.handle: item for item in grants}
            transport.set_active_generation(generation)
            self._state = STATE_ACTIVE
            return descriptor

    def _validate_grants(
        self,
        descriptor: RuntimeDescriptor,
        grants: tuple[CapabilityGrant, ...],
    ) -> None:
        if not all(isinstance(item, CapabilityGrant) for item in grants):
            raise self._request_error(
                "PLUGIN_PLATFORM_CAPABILITIES_INVALID",
                "capabilities must contain CapabilityGrant values",
            )
        required = set(descriptor.required_permissions)
        allowed = required | set(descriptor.optional_permissions)
        granted = {item.permission_id for item in grants}
        missing = sorted(required - granted)
        unexpected = sorted(granted - allowed)
        if (
            len({item.handle for item in grants}) != len(grants)
            or len(granted) != len(grants)
            or missing
            or unexpected
        ):
            raise self._request_error(
                "PLUGIN_PLATFORM_CAPABILITIES_INVALID",
                "capability grants do not match the descriptor",
                details={"missing": missing, "unexpected": unexpected},
            )

    async def invoke(
        self,
        contribution_id: str,
        input_value: dict[str, Any],
        *,
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        generation, descriptor = self._active_snapshot()
        declared = {item.id for item in descriptor.contributions}
        if contribution_id not in declared:
            raise self._request_error(
                "PLUGIN_PLATFORM_CONTRIBUTION_NOT_FOUND",
                "contribution is absent from the active descriptor",
                details={"contributionId": contribution_id},
            )
        try:
            request_context = RequestContext(
                contribution_id=contribution_id,
                user_action=user_action,
                generation=generation,
                trace_id=trace_id,
            )
            invocation = InvokeRequest(contribution_id, input_value, request_context)
        except PlatformContractError as exc:
            raise self._request_error(
                "PLUGIN_PLATFORM_REQUEST_INVALID",
                exc.message,
                details={"contractCode": exc.code, "path": exc.path},
            ) from exc
        result = await self._request(
            METHOD_INVOKE,
            invocation.to_wire(),
            generation=generation,
            timeout=self.spec.request_timeout_seconds,
        )
        self._ensure_generation_current(generation)
        return result

    def _ensure_generation_current(self, generation: int) -> None:
        self._refresh_transport_failure()
        if self._generation != generation or self._state not in {
            STATE_ACTIVE,
            STATE_QUIESCING,
        }:
            raise self._state_error(
                "PLUGIN_PLATFORM_STALE_GENERATION",
                "request completed after its activation generation was revoked",
            )

    async def health_check(self) -> dict[str, Any]:
        generation, _ = self._active_snapshot()
        result = await self._request(
            METHOD_HEALTH_CHECK,
            {},
            generation=generation,
            timeout=self.spec.request_timeout_seconds,
        )
        self._ensure_generation_current(generation)
        return result

    async def event_batch(
        self,
        events: tuple[dict[str, Any], ...],
        delivery: dict[str, Any],
    ) -> dict[str, Any]:
        generation, _ = self._active_snapshot()
        try:
            normalized_events = normalize_json(list(events), path="eventBatch.events")
            normalized_delivery = normalize_json(delivery, path="eventBatch.delivery")
        except PlatformContractError as exc:
            raise self._request_error(
                "PLUGIN_PLATFORM_REQUEST_INVALID",
                exc.message,
                details={"contractCode": exc.code, "path": exc.path},
            ) from exc
        if not isinstance(normalized_events, list) or not all(
            isinstance(item, dict) for item in normalized_events
        ):
            raise self._request_error(
                "PLUGIN_PLATFORM_REQUEST_INVALID",
                "eventBatch.events must contain objects",
            )
        if not isinstance(normalized_delivery, dict):
            raise self._request_error(
                "PLUGIN_PLATFORM_REQUEST_INVALID",
                "eventBatch.delivery must be an object",
            )
        result = await self._request(
            METHOD_EVENT_BATCH,
            {"events": normalized_events, "delivery": normalized_delivery},
            generation=generation,
            timeout=self.spec.request_timeout_seconds,
        )
        self._ensure_generation_current(generation)
        return result

    async def prepare_upgrade(self) -> dict[str, Any]:
        async with self._lifecycle_lock:
            if self._state != STATE_ACTIVE:
                raise self._state_error(
                    "PLUGIN_PLATFORM_NOT_ACTIVE",
                    "prepareUpgrade requires an active entrypoint",
                )
            generation = self._generation
            self._state = STATE_QUIESCING
            try:
                result = await self._lifecycle_request_locked(
                    METHOD_PREPARE_UPGRADE,
                    {},
                    generation=generation,
                    timeout=self.spec.request_timeout_seconds,
                )
            except BaseException:
                if self._state == STATE_QUIESCING:
                    self._state = STATE_ACTIVE
                raise
            if result != {"ok": True}:
                error = self._transport_error(
                    "PLUGIN_PLATFORM_UPGRADE_INVALID",
                    "entrypoint returned an invalid prepareUpgrade result",
                )
                await self._fail_locked(error)
                raise error
            return result

    async def deactivate(self, reason: str) -> None:
        async with self._lifecycle_lock:
            await self._deactivate_locked(reason)

    async def _deactivate_locked(self, reason: str) -> None:
        if self._state not in {STATE_ACTIVE, STATE_QUIESCING}:
            if self._state in {STATE_HANDSHAKEN, STATE_STOPPED, STATE_DISABLED}:
                return
            raise self._state_error(
                "PLUGIN_PLATFORM_NOT_ACTIVE",
                "deactivate requires an active entrypoint",
            )
        generation = self._generation
        previous = self._state
        self._state = STATE_DEACTIVATING
        try:
            result = await self._lifecycle_request_locked(
                METHOD_DEACTIVATE,
                {"reason": reason},
                generation=generation,
                timeout=self.spec.shutdown_timeout_seconds,
            )
        except BaseException:
            if self._state == STATE_DEACTIVATING:
                self._state = previous
            raise
        if result != {"ok": True}:
            error = self._transport_error(
                "PLUGIN_PLATFORM_DEACTIVATION_INVALID",
                "entrypoint returned an invalid deactivate result",
            )
            await self._fail_locked(error)
            raise error
        self._revoke_capabilities(self._instance_id, generation)
        self._generation = 0
        self._instance_id = None
        self._grants.clear()
        if self._transport is not None:
            self._transport.set_active_generation(0)
        self._state = STATE_HANDSHAKEN

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            transport = self._transport
            if transport is None:
                self._state = STATE_STOPPED if self.spec.enabled else STATE_DISABLED
                return
            try:
                previous_state = self._state
                shutdown_generation = self._generation if self._generation > 0 else 0
                if previous_state in {STATE_ACTIVE, STATE_QUIESCING}:
                    with contextlib.suppress(PlatformHostError):
                        await self._deactivate_locked("Host is stopping")
                    shutdown_generation = (
                        self._generation if self._generation > 0 else 0
                    )
                if self._transport is None:
                    return
                self._state = STATE_STOPPING
                if transport.fatal_error is None:
                    try:
                        transport.expect_process_exit()
                        result = await self._request_locked(
                            METHOD_SHUTDOWN,
                            {},
                            generation=shutdown_generation,
                            timeout=self.spec.shutdown_timeout_seconds,
                        )
                        if result != {"ok": True}:
                            raise self._transport_error(
                                "PLUGIN_PLATFORM_SHUTDOWN_INVALID",
                                "entrypoint returned an invalid shutdown result",
                            )
                    except asyncio.CancelledError:
                        self._record_failure(
                            self._transport_error(
                                "PLUGIN_PLATFORM_SHUTDOWN_CANCELLED",
                                "entrypoint shutdown was cancelled",
                            )
                        )
                        raise
                    except PlatformHostError as exc:
                        self._record_failure(exc)
            finally:
                try:
                    await self._close_transport_locked()
                finally:
                    self._revoke_capabilities(
                        self._instance_id,
                        self._generation,
                    )
                    self._descriptor = None
                    self._negotiated_host_apis = ()
                    self._generation = 0
                    self._instance_id = None
                    self._grants.clear()
                    self._state = STATE_STOPPED if self.spec.enabled else STATE_DISABLED

    async def _handle_host_call(
        self,
        call: HostCallRequest,
    ) -> dict[str, Any]:
        if self._state not in {STATE_ACTIVE, STATE_QUIESCING}:
            raise self._request_error(
                "CAPABILITY_HANDLE_INVALID",
                "host.call was issued outside an active generation",
            )
        if call.request_context.generation != self._generation:
            raise self._request_error(
                "GENERATION_MISMATCH",
                "host.call request context is stale",
            )
        descriptor = self._descriptor
        if descriptor is None or call.request_context.contribution_id not in {
            item.id for item in descriptor.contributions
        }:
            raise self._request_error(
                "CAPABILITY_HANDLE_INVALID",
                "host.call contribution is not active",
            )
        grant = self._grants.get(call.capability_handle)
        if grant is None:
            raise self._request_error(
                "CAPABILITY_HANDLE_INVALID",
                "host.call used an unknown or revoked capability handle",
            )
        if self._capability_authority is not None:
            instance_id = self._instance_id
            broker = self._capability_broker
            if instance_id is None or broker is None:
                raise self._request_error(
                    "CAPABILITY_HANDLE_INVALID",
                    "no capability broker is configured for this entrypoint",
                )
            try:
                lease = self._capability_authority.validate(
                    call,
                    grant,
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    instance_id=instance_id,
                    generation=self._generation,
                )
                return await broker.handle(call, grant, lease)
            except PlatformSecurityError as exc:
                raise self._request_error(
                    exc.code,
                    exc.message,
                    details=exc.details,
                ) from exc
        if self._host_call_handler is None:
            raise self._request_error(
                "CAPABILITY_HANDLE_INVALID",
                "no capability broker is configured for this entrypoint",
            )
        return await self._host_call_handler(call, grant)

    def _revoke_capabilities(
        self,
        instance_id: str | None,
        generation: int,
    ) -> None:
        authority = self._capability_authority
        if authority is None or instance_id is None or generation < 1:
            return
        with contextlib.suppress(PlatformSecurityError):
            authority.revoke_instance(
                self.plugin_id,
                self.entrypoint_id,
                instance_id,
                generation,
            )

    def _active_snapshot(self) -> tuple[int, RuntimeDescriptor]:
        self._refresh_transport_failure()
        if (
            self._state != STATE_ACTIVE
            or self._generation < 1
            or self._descriptor is None
        ):
            raise self._state_error(
                "PLUGIN_PLATFORM_NOT_ACTIVE",
                "entrypoint is not active",
            )
        return self._generation, self._descriptor

    async def _request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        generation: int,
        timeout: float,
    ) -> dict[str, Any]:
        try:
            return await self._request_locked(
                method,
                params,
                generation=generation,
                timeout=timeout,
            )
        except PlatformHostTransportError as exc:
            async with self._lifecycle_lock:
                if self._transport is not None:
                    await self._fail_locked(exc)
            raise

    async def _request_locked(
        self,
        method: str,
        params: dict[str, Any],
        *,
        generation: int,
        timeout: float,
    ) -> dict[str, Any]:
        transport = self._transport
        if transport is None:
            raise self._transport_error(
                "PLUGIN_PLATFORM_NOT_RUNNING",
                "entrypoint transport is unavailable",
            )
        self._request_count += 1
        self._last_request_at = _utc_now()
        try:
            return await transport.request(
                method,
                params,
                generation=generation,
                timeout=timeout,
            )
        except PlatformHostRemoteError as exc:
            self._remote_error_count += 1
            self._last_remote_error = {**exc.to_dict(), "at": _utc_now()}
            raise

    async def _lifecycle_request_locked(
        self,
        method: str,
        params: dict[str, Any],
        *,
        generation: int,
        timeout: float,
    ) -> dict[str, Any]:
        try:
            return await self._request_locked(
                method,
                params,
                generation=generation,
                timeout=timeout,
            )
        except asyncio.CancelledError:
            error = self._transport_error(
                "PLUGIN_PLATFORM_LIFECYCLE_CANCELLED",
                f"entrypoint lifecycle request {method!r} was cancelled",
                details={"method": method},
            )
            await self._fail_locked(error)
            raise
        except (PlatformHostRemoteError, PlatformHostTransportError) as exc:
            await self._fail_locked(exc)
            raise

    def _consume_restart_budget(self) -> None:
        now = time.monotonic()
        cutoff = now - self.spec.restart_window_seconds
        while self._restart_times and self._restart_times[0] < cutoff:
            self._restart_times.popleft()
        if self._launch_attempts:
            if len(self._restart_times) >= self.spec.max_restart_attempts:
                error = self._request_error(
                    "PLUGIN_PLATFORM_RESTART_LIMIT",
                    "entrypoint restart circuit is open",
                    details={
                        "maxRestartAttempts": self.spec.max_restart_attempts,
                        "restartWindowSeconds": self.spec.restart_window_seconds,
                    },
                )
                self._state = STATE_FAILED
                self._record_failure(error)
                raise error
            self._restart_times.append(now)
            self._restart_count += 1
        self._launch_attempts += 1

    async def _fail_locked(self, error: PlatformHostError) -> None:
        self._state = STATE_FAILED
        self._record_failure(error)
        await self._close_transport_locked()
        self._revoke_capabilities(self._instance_id, self._generation)
        self._generation = 0
        self._instance_id = None
        self._grants.clear()

    def _record_failure(self, error: PlatformHostError) -> None:
        token = (self._highest_generation or self._launch_attempts, error.code)
        if token in self._recorded_failures:
            return
        self._recorded_failures.add(token)
        self._failure_count += 1
        self._last_failure = {**error.to_dict(), "at": _utc_now()}

    async def _close_transport_locked(self) -> None:
        transport = self._transport
        self._transport = None
        if transport is not None:
            try:
                await transport.close()
            finally:
                self._last_stderr_tail = transport.stderr_tail

    def _refresh_transport_failure(self) -> None:
        transport = self._transport
        if transport is None or transport.fatal_error is None:
            return
        if self._state not in {STATE_FAILED, STATE_STOPPED, STATE_DISABLED}:
            self._state = STATE_FAILED
            self._record_failure(transport.fatal_error)
            self._revoke_capabilities(self._instance_id, self._generation)
            self._generation = 0
            self._instance_id = None
            self._grants.clear()

    def _request_error(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> PlatformHostRequestError:
        return PlatformHostRequestError(
            code=code,
            message=message,
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
            details=details or {},
        )

    def _state_error(self, code: str, message: str) -> PlatformHostStateError:
        return PlatformHostStateError(
            code=code,
            message=message,
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
        )

    def _transport_error(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> PlatformHostTransportError:
        return PlatformHostTransportError(
            code=code,
            message=message,
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
            details=details or {},
            fatal=True,
        )

    def snapshot(self, *, include_stderr: bool = False) -> dict[str, Any]:
        self._refresh_transport_failure()
        transport = self._transport
        return {
            "pluginId": self.plugin_id,
            "entrypointId": self.entrypoint_id,
            "state": self._state,
            "enabled": self.spec.enabled,
            "autoStart": self.spec.auto_start,
            "required": self.spec.required,
            "protocol": PLUGIN_PROTOCOL_V2,
            "generation": self._generation,
            "highestGeneration": self._highest_generation,
            "instanceId": self._instance_id,
            "starts": self._start_count,
            "restarts": self._restart_count,
            "requests": self._request_count,
            "remoteErrors": self._remote_error_count,
            "failures": self._failure_count,
            "startedAt": self._started_at,
            "lastRequestAt": self._last_request_at,
            "negotiatedHostApis": list(self._negotiated_host_apis),
            "capabilityCount": len(self._grants),
            "descriptor": self._descriptor.to_wire() if self._descriptor else None,
            "lastFailure": dict(self._last_failure) if self._last_failure else None,
            "lastRemoteError": (
                dict(self._last_remote_error) if self._last_remote_error else None
            ),
            **(
                {
                    "stderrTail": (
                        transport.stderr_tail
                        if transport is not None
                        else self._last_stderr_tail
                    )
                }
                if include_stderr
                else {}
            ),
            "transport": (
                transport.snapshot(include_stderr=include_stderr)
                if transport is not None
                else None
            ),
        }
