"""Reference Plugin Platform v2 lifecycle and bidirectional dispatcher."""

from __future__ import annotations

import sys
import traceback
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .constants import (
    CONTROL_TRANSPORT_V1,
    DEFAULT_MAX_IN_FLIGHT,
    HOST_API_V1,
    METHOD_ACTIVATE,
    METHOD_CANCEL,
    METHOD_DEACTIVATE,
    METHOD_DESCRIBE,
    METHOD_EVENT_BATCH,
    METHOD_HANDSHAKE,
    METHOD_HEALTH_CHECK,
    METHOD_HOST_CALL,
    METHOD_INVOKE,
    METHOD_PREPARE_UPGRADE,
    METHOD_SHUTDOWN,
    PLUGIN_PROTOCOL_V2,
    RPC_CAPABILITY_INVALID,
    RPC_CONTRACT_VIOLATION,
    RPC_GENERATION_MISMATCH,
    RPC_HANDSHAKE_REQUIRED,
    RPC_INTERNAL_ERROR,
    RPC_INVALID_PARAMS,
    RPC_INVALID_STATE,
    RPC_METHOD_NOT_FOUND,
    RPC_PROTOCOL_UNSUPPORTED,
    RPC_REQUEST_CANCELLED,
    RPC_REQUEST_ID_IN_USE,
)
from .errors import PlatformContractError, PlatformProtocolError
from .json_codec import normalize_json
from .models import (
    ActivationRequest,
    HandshakeRequest,
    HostCallRequest,
    InvokeRequest,
    PluginManifest,
    RequestContext,
    RuntimeDescriptor,
)
from .rpc import RpcFailure, RpcFrame, RpcId, RpcRequest, RpcSuccess, failure_from_exception


@dataclass(frozen=True, slots=True)
class DeferredInvocation:
    """Ask the dispatcher to retain an invocation until it is cancelled."""

    token: str

    def __post_init__(self) -> None:
        if not isinstance(self.token, str) or not self.token or len(self.token) > 128:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "deferred invocation token must be a non-empty string",
            )


@dataclass(frozen=True, slots=True)
class HostCallInvocation:
    """Suspend an invocation while one capability-broker call is in flight."""

    call: HostCallRequest
    token: str

    def __post_init__(self) -> None:
        if not isinstance(self.call, HostCallRequest):
            raise PlatformContractError("INVALID_CONTRACT", "host call is invalid")
        if not isinstance(self.token, str) or not self.token or len(self.token) > 128:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "host call token must be a non-empty string",
            )


InvocationOutcome = dict[str, Any] | DeferredInvocation | HostCallInvocation


class BasePlatformPlugin(ABC):
    """Small public implementation surface for v2 backend entrypoints."""

    @abstractmethod
    def manifest(self) -> PluginManifest:
        """Return the immutable manifest used to validate the descriptor."""

    @abstractmethod
    def describe(self) -> RuntimeDescriptor:
        """Return only statically declared contributions and permissions."""

    def activate(self, request: ActivationRequest) -> None:
        """Acquire activation-local resources after grants are validated."""

    @abstractmethod
    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        """Invoke one declared contribution."""

    def event_batch(
        self,
        events: tuple[dict[str, Any], ...],
        delivery: dict[str, Any],
    ) -> dict[str, Any]:
        return {"accepted": len(events)}

    def health_check(self) -> dict[str, Any]:
        return {"status": "ready"}

    def cancel(self, token: str) -> None:
        """Cancel plugin-owned work associated with a deferred invocation."""

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> InvocationOutcome:
        raise PlatformProtocolError(
            RPC_CONTRACT_VIOLATION,
            "HOST_CALL_COMPLETION_UNSUPPORTED",
            "Plugin initiated a Host API call but cannot consume its response.",
        )

    def prepare_upgrade(self) -> None:
        """Enter quiescing mode before an upgrade cutover."""

    def deactivate(self, reason: str) -> None:
        """Release all activation-local resources."""

    def shutdown(self) -> None:
        """Release process-owned resources before the sidecar exits."""


@dataclass(slots=True)
class _PendingInvocation:
    request_id: RpcId
    generation: int
    token: str
    request_context: RequestContext
    host_call_id: RpcId | None = None


class PlatformDispatcher:
    """Stateful v2 dispatcher with bounded in-flight and generation ownership."""

    def __init__(
        self,
        plugin: BasePlatformPlugin,
        *,
        max_in_flight: int = DEFAULT_MAX_IN_FLIGHT,
    ) -> None:
        if not isinstance(plugin, BasePlatformPlugin):
            raise TypeError("plugin must implement BasePlatformPlugin")
        if (
            isinstance(max_in_flight, bool)
            or not isinstance(max_in_flight, int)
            or max_in_flight < 1
        ):
            raise ValueError("max_in_flight must be a positive integer")
        self._plugin = plugin
        self._max_in_flight = max_in_flight
        self._manifest: PluginManifest | None = None
        self._descriptor: RuntimeDescriptor | None = None
        self._state = "created"
        self._generation = 0
        self._highest_generation = 0
        self._instance_id: str | None = None
        self._negotiated_host_apis: tuple[str, ...] = ()
        self._capabilities: dict[str, str] = {}
        self._pending: dict[RpcId, _PendingInvocation] = {}
        self._host_calls: dict[RpcId, RpcId] = {}
        self._next_host_call_id = 1

    @property
    def shutdown_requested(self) -> bool:
        return self._state == "closed"

    @property
    def state(self) -> str:
        return self._state

    @property
    def generation(self) -> int:
        return self._generation

    def handle(self, frame: RpcFrame) -> tuple[RpcFrame, ...]:
        try:
            if isinstance(frame, RpcRequest):
                return self._handle_request(frame)
            return self._handle_host_response(frame)
        except PlatformContractError as exc:
            raise PlatformProtocolError(
                RPC_INVALID_PARAMS,
                exc.code,
                exc.message,
                {"path": exc.path} if exc.path else {},
            ) from exc

    def _handle_request(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        if self._state == "closed":
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "SESSION_CLOSED",
                "The plugin session is already closed.",
            )
        if request.id in self._pending:
            raise PlatformProtocolError(
                RPC_REQUEST_ID_IN_USE,
                "REQUEST_ID_IN_USE",
                "A request with this id is still in flight.",
                {"requestId": request.id},
            )
        if request.method == METHOD_HANDSHAKE:
            return (self._handshake(request),)
        if self._state == "created":
            raise PlatformProtocolError(
                RPC_HANDSHAKE_REQUIRED,
                "HANDSHAKE_REQUIRED",
                "handshake must complete before other methods",
            )
        if request.method == METHOD_DESCRIBE:
            self._require_control_generation(request, allow_zero=True)
            return (
                RpcSuccess(request.id, self._runtime_descriptor().to_wire(), request.generation),
            )
        if request.method == METHOD_ACTIVATE:
            return (self._activate(request),)
        if request.method == METHOD_INVOKE:
            return self._invoke(request)
        if request.method == METHOD_EVENT_BATCH:
            return (self._event_batch(request),)
        if request.method == METHOD_HEALTH_CHECK:
            self._require_current_generation(request)
            result = normalize_json(self._plugin.health_check(), path="healthCheck.result")
            if not isinstance(result, dict):
                raise PlatformContractError(
                    "INVALID_CONTRACT",
                    "health_check() must return an object",
                )
            return (RpcSuccess(request.id, result, request.generation),)
        if request.method == METHOD_CANCEL:
            return self._cancel(request)
        if request.method == METHOD_DEACTIVATE:
            return self._deactivate(request)
        if request.method == METHOD_PREPARE_UPGRADE:
            return self._prepare_upgrade(request)
        if request.method == METHOD_SHUTDOWN:
            return self._shutdown(request)
        raise PlatformProtocolError(
            RPC_METHOD_NOT_FOUND,
            "METHOD_NOT_FOUND",
            f"Unknown Plugin Platform method: {request.method}",
            {"method": request.method},
        )

    def _handshake(self, request: RpcRequest) -> RpcSuccess:
        if self._state != "created":
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "HANDSHAKE_ALREADY_COMPLETED",
                "handshake may only be completed once per process session",
            )
        if request.generation != 0:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "handshake must use generation 0",
            )
        handshake = HandshakeRequest.from_wire(request.params)
        if PLUGIN_PROTOCOL_V2 not in handshake.protocols:
            raise PlatformProtocolError(
                RPC_PROTOCOL_UNSUPPORTED,
                "PROTOCOL_UNSUPPORTED",
                f"Host did not offer required protocol {PLUGIN_PROTOCOL_V2}.",
                {"supportedProtocols": [PLUGIN_PROTOCOL_V2]},
            )
        if CONTROL_TRANSPORT_V1 not in handshake.transports:
            raise PlatformProtocolError(
                RPC_PROTOCOL_UNSUPPORTED,
                "TRANSPORT_UNSUPPORTED",
                f"Host did not offer required transport {CONTROL_TRANSPORT_V1}.",
                {"supportedTransports": [CONTROL_TRANSPORT_V1]},
            )
        descriptor = self._runtime_descriptor()
        if handshake.entrypoint_id != descriptor.entrypoint_id:
            raise PlatformProtocolError(
                RPC_CONTRACT_VIOLATION,
                "ENTRYPOINT_MISMATCH",
                "Host requested an entrypoint not owned by this process.",
                {"entrypointId": handshake.entrypoint_id},
            )
        offered = set(handshake.host_apis)
        missing = sorted(set(descriptor.required_host_apis) - offered)
        if missing:
            raise PlatformProtocolError(
                RPC_PROTOCOL_UNSUPPORTED,
                "HOST_API_UNSUPPORTED",
                "Host is missing APIs required by this entrypoint.",
                {"missingHostApis": missing},
            )
        negotiated = tuple(
            item
            for item in descriptor.required_host_apis + descriptor.optional_host_apis
            if item in offered
        )
        self._negotiated_host_apis = negotiated
        self._state = "handshaken"
        return RpcSuccess(
            request.id,
            {
                "protocol": PLUGIN_PROTOCOL_V2,
                "transport": CONTROL_TRANSPORT_V1,
                "descriptor": descriptor.to_wire(),
                "negotiatedHostApis": list(negotiated),
            },
            0,
        )

    def _activate(self, request: RpcRequest) -> RpcSuccess:
        if self._state != "handshaken":
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "ACTIVATION_STATE_INVALID",
                "activate requires a handshaken inactive session",
            )
        activation = ActivationRequest.from_wire(request.params)
        if request.generation != activation.generation:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "activate envelope and params generations differ",
            )
        if activation.generation <= self._highest_generation:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "STALE_GENERATION",
                "activation generation must increase monotonically",
                {"highestGeneration": self._highest_generation},
            )
        descriptor = self._runtime_descriptor()
        required = set(descriptor.required_permissions)
        allowed = required | set(descriptor.optional_permissions)
        granted = {item.permission_id for item in activation.capabilities}
        missing = sorted(required - granted)
        unexpected = sorted(granted - allowed)
        if missing or unexpected:
            raise PlatformProtocolError(
                RPC_CAPABILITY_INVALID,
                "CAPABILITY_GRANTS_INVALID",
                "Activation grants do not match the static descriptor.",
                {"missing": missing, "unexpected": unexpected},
            )
        self._plugin.activate(activation)
        self._generation = activation.generation
        self._highest_generation = activation.generation
        self._instance_id = activation.instance_id
        self._capabilities = {item.handle: item.permission_id for item in activation.capabilities}
        self._state = "active"
        return RpcSuccess(
            request.id,
            {
                "ok": True,
                "instanceId": activation.instance_id,
                "generation": activation.generation,
            },
            request.generation,
        )

    def _invoke(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        self._require_active(request)
        if self._state == "quiescing":
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "PLUGIN_QUIESCING",
                "New invocations are rejected while preparing an upgrade.",
            )
        if len(self._pending) >= self._max_in_flight:
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "IN_FLIGHT_LIMIT",
                "The plugin has reached its bounded in-flight request limit.",
                {"maxInFlight": self._max_in_flight},
            )
        invocation = InvokeRequest.from_wire(request.params)
        if invocation.request_context.generation != request.generation:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "requestContext generation does not match the envelope",
            )
        contributions = {item.id for item in self._runtime_descriptor().contributions}
        if invocation.contribution_id not in contributions:
            raise PlatformProtocolError(
                RPC_CONTRACT_VIOLATION,
                "CONTRIBUTION_NOT_DECLARED",
                "invoke references a contribution absent from the descriptor",
                {"contributionId": invocation.contribution_id},
            )
        outcome = self._plugin.invoke(invocation)
        if isinstance(outcome, DeferredInvocation):
            self._pending[request.id] = _PendingInvocation(
                request_id=request.id,
                generation=request.generation,
                token=outcome.token,
                request_context=invocation.request_context,
            )
            return ()
        if isinstance(outcome, HostCallInvocation):
            return self._begin_host_call(request, invocation, outcome)
        result = normalize_json(outcome, path="invoke.result")
        if not isinstance(result, dict):
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "invoke() must return an object or a deferred outcome",
            )
        return (RpcSuccess(request.id, result, request.generation),)

    def _begin_host_call(
        self,
        request: RpcRequest,
        invocation: InvokeRequest,
        outcome: HostCallInvocation,
    ) -> tuple[RpcFrame, ...]:
        call = outcome.call
        if HOST_API_V1 not in self._negotiated_host_apis:
            raise PlatformProtocolError(
                RPC_PROTOCOL_UNSUPPORTED,
                "HOST_API_NOT_NEGOTIATED",
                f"{HOST_API_V1} was not negotiated",
            )
        if call.request_context != invocation.request_context:
            raise PlatformProtocolError(
                RPC_CONTRACT_VIOLATION,
                "HOST_CALL_CONTEXT_MISMATCH",
                "host.call must retain the originating requestContext",
            )
        permission = self._capabilities.get(call.capability_handle)
        if permission is None:
            raise PlatformProtocolError(
                RPC_CAPABILITY_INVALID,
                "CAPABILITY_HANDLE_INVALID",
                "host.call used an unknown or revoked capability handle",
            )
        host_call_id = f"plugin:{self._highest_generation}:{self._next_host_call_id}"
        self._next_host_call_id += 1
        pending = _PendingInvocation(
            request_id=request.id,
            generation=request.generation,
            token=outcome.token,
            request_context=invocation.request_context,
            host_call_id=host_call_id,
        )
        self._pending[request.id] = pending
        self._host_calls[host_call_id] = request.id
        return (
            RpcRequest(
                id=host_call_id,
                method=METHOD_HOST_CALL,
                params=call.to_wire(),
                generation=request.generation,
            ),
        )

    def _handle_host_response(
        self,
        response: RpcSuccess | RpcFailure,
    ) -> tuple[RpcFrame, ...]:
        original_id = self._host_calls.get(response.id)
        if original_id is None:
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "HOST_CALL_NOT_PENDING",
                "Received a response for an unknown or cancelled host.call.",
                {"requestId": response.id},
            )
        pending = self._pending.get(original_id)
        if pending is None or pending.host_call_id != response.id:
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "HOST_CALL_NOT_PENDING",
                "Received a response for an inconsistent host.call correlation.",
                {"requestId": response.id},
            )
        if response.generation != pending.generation or response.generation != self._generation:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "STALE_HOST_CALL_RESPONSE",
                "host.call response belongs to a stale generation",
            )
        try:
            outcome = self._plugin.complete_host_call(pending.token, response)
            if isinstance(outcome, HostCallInvocation):
                if outcome.call.request_context != pending.request_context:
                    raise PlatformProtocolError(
                        RPC_CONTRACT_VIOLATION,
                        "HOST_CALL_CONTEXT_MISMATCH",
                        "chained host.call must retain the originating requestContext",
                    )
                if outcome.call.capability_handle not in self._capabilities:
                    raise PlatformProtocolError(
                        RPC_CAPABILITY_INVALID,
                        "CAPABILITY_HANDLE_INVALID",
                        "chained host.call used an unknown or revoked capability handle",
                    )
                self._host_calls.pop(response.id, None)
                next_host_call_id = f"plugin:{self._highest_generation}:{self._next_host_call_id}"
                self._next_host_call_id += 1
                pending.token = outcome.token
                pending.host_call_id = next_host_call_id
                self._host_calls[next_host_call_id] = original_id
                return (
                    RpcRequest(
                        id=next_host_call_id,
                        method=METHOD_HOST_CALL,
                        params=outcome.call.to_wire(),
                        generation=pending.generation,
                    ),
                )
            if isinstance(outcome, DeferredInvocation):
                self._host_calls.pop(response.id, None)
                pending.token = outcome.token
                pending.host_call_id = None
                return ()
            result = normalize_json(outcome, path="invoke.result")
            if not isinstance(result, dict):
                raise PlatformContractError(
                    "INVALID_CONTRACT",
                    "complete_host_call() must return an object",
                )
            completed: RpcFrame = RpcSuccess(original_id, result, pending.generation)
        except PlatformProtocolError as exc:
            completed = failure_from_exception(original_id, pending.generation, exc)
        except PlatformContractError as exc:
            completed = failure_from_exception(
                original_id,
                pending.generation,
                PlatformProtocolError(
                    RPC_CONTRACT_VIOLATION,
                    exc.code,
                    "Plugin returned an invalid host.call completion result.",
                    {"path": exc.path} if exc.path else {},
                ),
            )
        except Exception:
            traceback.print_exc(file=sys.stderr)
            completed = failure_from_exception(
                original_id,
                pending.generation,
                PlatformProtocolError(
                    RPC_INTERNAL_ERROR,
                    "INTERNAL_ERROR",
                    "Plugin raised an unexpected exception.",
                ),
            )
        self._host_calls.pop(response.id, None)
        self._pending.pop(original_id, None)
        return (completed,)

    def _event_batch(self, request: RpcRequest) -> RpcSuccess:
        self._require_active(request)
        data = self._exact_params(request.params, {"events", "delivery"}, "eventBatch")
        raw_events = data["events"]
        if isinstance(raw_events, (str, bytes)) or not isinstance(raw_events, Sequence):
            raise PlatformContractError("INVALID_CONTRACT", "eventBatch.events must be an array")
        events: list[dict[str, Any]] = []
        for index, event in enumerate(raw_events):
            normalized = normalize_json(event, path=f"eventBatch.events[{index}]")
            if not isinstance(normalized, dict):
                raise PlatformContractError(
                    "INVALID_CONTRACT",
                    f"eventBatch.events[{index}] must be an object",
                )
            events.append(normalized)
        delivery = normalize_json(data["delivery"], path="eventBatch.delivery")
        if not isinstance(delivery, dict):
            raise PlatformContractError("INVALID_CONTRACT", "eventBatch.delivery must be an object")
        result = normalize_json(
            self._plugin.event_batch(tuple(events), delivery),
            path="eventBatch.result",
        )
        if not isinstance(result, dict):
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "event_batch() must return an object",
            )
        return RpcSuccess(request.id, result, request.generation)

    def _cancel(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        self._require_current_generation(request)
        data = self._exact_params(request.params, {"requestId"}, "cancel")
        target = data["requestId"]
        if isinstance(target, bool) or not isinstance(target, (str, int)):
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "cancel.requestId must be a string or integer",
            )
        pending = self._pending.pop(target, None)
        if pending is None:
            return (
                RpcSuccess(
                    request.id,
                    {"cancelled": False, "requestId": target},
                    request.generation,
                ),
            )
        if pending.host_call_id is not None:
            self._host_calls.pop(pending.host_call_id, None)
        self._plugin.cancel(pending.token)
        cancelled = PlatformProtocolError(
            RPC_REQUEST_CANCELLED,
            "REQUEST_CANCELLED",
            "The invocation was cancelled by the host.",
        )
        return (
            failure_from_exception(target, pending.generation, cancelled),
            RpcSuccess(
                request.id,
                {"cancelled": True, "requestId": target},
                request.generation,
            ),
        )

    def _prepare_upgrade(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        self._require_active(request)
        self._exact_params(request.params, set(), "prepareUpgrade")
        self._state = "quiescing"
        cancelled = self._cancel_all("Plugin is quiescing for upgrade.")
        self._plugin.prepare_upgrade()
        return (*cancelled, RpcSuccess(request.id, {"ok": True}, request.generation))

    def _deactivate(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        self._require_active(request)
        data = self._exact_params(request.params, {"reason"}, "deactivate")
        reason = data["reason"]
        if not isinstance(reason, str) or not reason or len(reason) > 256:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "deactivate.reason must be a non-empty string",
            )
        cancelled = self._cancel_all("Plugin was deactivated.")
        self._plugin.deactivate(reason)
        response = RpcSuccess(request.id, {"ok": True}, request.generation)
        self._state = "handshaken"
        self._generation = 0
        self._instance_id = None
        self._capabilities.clear()
        return (*cancelled, response)

    def _shutdown(self, request: RpcRequest) -> tuple[RpcFrame, ...]:
        if self._state in {"active", "quiescing"}:
            self._require_current_generation(request)
        elif request.generation != 0:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "inactive shutdown must use generation 0",
            )
        self._exact_params(request.params, set(), "shutdown")
        cancelled = self._cancel_all("Plugin process is shutting down.")
        self._plugin.shutdown()
        response = RpcSuccess(request.id, {"ok": True}, request.generation)
        self._state = "closed"
        return (*cancelled, response)

    def _cancel_all(self, message: str) -> tuple[RpcFailure, ...]:
        frames: list[RpcFailure] = []
        for request_id, pending in tuple(self._pending.items()):
            self._plugin.cancel(pending.token)
            if pending.host_call_id is not None:
                self._host_calls.pop(pending.host_call_id, None)
            frames.append(
                failure_from_exception(
                    request_id,
                    pending.generation,
                    PlatformProtocolError(
                        RPC_REQUEST_CANCELLED,
                        "REQUEST_CANCELLED",
                        message,
                    ),
                )
            )
        self._pending.clear()
        return tuple(frames)

    def _require_active(self, request: RpcRequest) -> None:
        if self._state not in {"active", "quiescing"}:
            raise PlatformProtocolError(
                RPC_INVALID_STATE,
                "PLUGIN_NOT_ACTIVE",
                "This method requires an active plugin generation.",
            )
        self._require_current_generation(request)

    def _require_current_generation(self, request: RpcRequest) -> None:
        if request.generation != self._generation or self._generation < 1:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "Request does not belong to the active generation.",
                {"activeGeneration": self._generation},
            )

    def _require_control_generation(self, request: RpcRequest, *, allow_zero: bool) -> None:
        if self._state in {"active", "quiescing"}:
            self._require_current_generation(request)
        elif not allow_zero or request.generation != 0:
            raise PlatformProtocolError(
                RPC_GENERATION_MISMATCH,
                "GENERATION_MISMATCH",
                "Inactive control requests must use generation 0.",
            )

    @staticmethod
    def _exact_params(
        value: Mapping[str, Any],
        required: set[str],
        path: str,
    ) -> Mapping[str, Any]:
        keys = set(value)
        missing = sorted(required - keys)
        unknown = sorted(keys - required)
        if missing:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                f"{path} is missing required fields: {', '.join(missing)}",
                path,
            )
        if unknown:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                f"{path} contains unknown fields: {', '.join(unknown)}",
                path,
            )
        return value

    def _manifest_value(self) -> PluginManifest:
        if self._manifest is None:
            manifest = self._plugin.manifest()
            if not isinstance(manifest, PluginManifest):
                raise PlatformProtocolError(
                    RPC_CONTRACT_VIOLATION,
                    "PLUGIN_CONTRACT_VIOLATION",
                    "Plugin manifest() must return PluginManifest.",
                )
            self._manifest = manifest
        return self._manifest

    def _runtime_descriptor(self) -> RuntimeDescriptor:
        if self._descriptor is None:
            descriptor = self._plugin.describe()
            if not isinstance(descriptor, RuntimeDescriptor):
                raise PlatformProtocolError(
                    RPC_CONTRACT_VIOLATION,
                    "PLUGIN_CONTRACT_VIOLATION",
                    "Plugin describe() must return RuntimeDescriptor.",
                )
            try:
                self._manifest_value().validate_descriptor(descriptor)
            except PlatformContractError as exc:
                raise PlatformProtocolError(
                    RPC_CONTRACT_VIOLATION,
                    "DESCRIPTOR_MANIFEST_MISMATCH",
                    exc.message,
                ) from exc
            self._descriptor = descriptor
        return self._descriptor
