"""Runtime plugin interface and negotiated method dispatcher."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .constants import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
    METHOD_ANALYZE,
    METHOD_DESCRIBE,
    METHOD_EXECUTE_BATCH,
    METHOD_HANDSHAKE,
    METHOD_SHUTDOWN,
    PROTOCOL_V1,
    RPC_FEATURE_UNSUPPORTED,
    RPC_HANDSHAKE_ALREADY_COMPLETED,
    RPC_HANDSHAKE_REQUIRED,
    RPC_INTERNAL_ERROR,
    RPC_METHOD_NOT_FOUND,
    RPC_PROTOCOL_UNSUPPORTED,
    RPC_SESSION_CLOSED,
)
from .errors import ProtocolError
from .models import (
    AnalyzeRequest,
    AnalyzeResult,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    HandshakeRequest,
    HandshakeResult,
    RuntimeDescriptor,
)


class BaseRuntimePlugin(ABC):
    """Small implementation surface for community script runtimes."""

    @abstractmethod
    def describe(self) -> RuntimeDescriptor:
        """Return the immutable descriptor advertised during handshake."""

    @abstractmethod
    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        """Analyze source without executing market-data work."""

    @abstractmethod
    def execute_batch(self, request: ExecuteBatchRequest) -> ExecuteBatchResult:
        """Execute source over one bounded OHLCV batch."""

    def shutdown(self) -> None:
        """Release runtime-owned resources before the sidecar exits."""


class RuntimeDispatcher:
    """Stateful v1 session dispatcher shared by JSON and test transports."""

    def __init__(self, plugin: BaseRuntimePlugin) -> None:
        self._plugin = plugin
        self._descriptor: RuntimeDescriptor | None = None
        self._handshake_complete = False
        self._shutdown_requested = False
        self._negotiated_features: tuple[str, ...] = ()

    @property
    def handshake_complete(self) -> bool:
        return self._handshake_complete

    @property
    def shutdown_requested(self) -> bool:
        return self._shutdown_requested

    @property
    def negotiated_features(self) -> tuple[str, ...]:
        return self._negotiated_features

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._shutdown_requested:
            raise ProtocolError(
                RPC_SESSION_CLOSED,
                "SESSION_CLOSED",
                "The runtime session is already closed.",
            )
        if method == METHOD_HANDSHAKE:
            return self._handshake(params)
        if not self._handshake_complete:
            raise ProtocolError(
                RPC_HANDSHAKE_REQUIRED,
                "HANDSHAKE_REQUIRED",
                "handshake must complete before invoking runtime methods.",
            )
        if method == METHOD_DESCRIBE:
            return self._runtime_descriptor().to_wire()
        if method == METHOD_ANALYZE:
            self._require_feature(FEATURE_SOURCE_ANALYSIS_V1)
            result = self._plugin.analyze(AnalyzeRequest.from_wire(params))
            return self._checked_result(result, AnalyzeResult, METHOD_ANALYZE).to_wire()
        if method == METHOD_EXECUTE_BATCH:
            self._require_feature(FEATURE_BATCH_EXECUTION_V1)
            self._require_feature(FEATURE_RENDER_LINE_SERIES_V1)
            result = self._plugin.execute_batch(ExecuteBatchRequest.from_wire(params))
            return self._checked_result(
                result,
                ExecuteBatchResult,
                METHOD_EXECUTE_BATCH,
            ).to_wire()
        if method == METHOD_SHUTDOWN:
            self._plugin.shutdown()
            self._shutdown_requested = True
            return {"ok": True}
        raise ProtocolError(
            RPC_METHOD_NOT_FOUND,
            "METHOD_NOT_FOUND",
            f"Unknown runtime method: {method}",
            {"method": method},
        )

    def _handshake(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._handshake_complete:
            raise ProtocolError(
                RPC_HANDSHAKE_ALREADY_COMPLETED,
                "HANDSHAKE_ALREADY_COMPLETED",
                "handshake may only be invoked once per sidecar session.",
            )
        request = HandshakeRequest.from_wire(params)
        if PROTOCOL_V1 not in request.protocols:
            raise ProtocolError(
                RPC_PROTOCOL_UNSUPPORTED,
                "PROTOCOL_UNSUPPORTED",
                f"Host did not offer required protocol {PROTOCOL_V1}.",
                {"supportedProtocols": [PROTOCOL_V1]},
            )
        descriptor = self._runtime_descriptor()
        host_features = set(request.host_features)
        missing = sorted(set(descriptor.required_host_features) - host_features)
        if missing:
            raise ProtocolError(
                RPC_FEATURE_UNSUPPORTED,
                "HOST_FEATURE_UNSUPPORTED",
                "Host is missing features required by this runtime.",
                {"missingFeatures": missing},
            )
        negotiated = tuple(feature for feature in descriptor.features if feature in host_features)
        self._negotiated_features = negotiated
        self._handshake_complete = True
        return HandshakeResult(
            runtime=descriptor,
            negotiated_features=negotiated,
        ).to_wire()

    def _runtime_descriptor(self) -> RuntimeDescriptor:
        if self._descriptor is None:
            descriptor = self._plugin.describe()
            if not isinstance(descriptor, RuntimeDescriptor):
                raise ProtocolError(
                    RPC_INTERNAL_ERROR,
                    "PLUGIN_CONTRACT_VIOLATION",
                    "Plugin describe() must return RuntimeDescriptor.",
                )
            self._descriptor = descriptor
        return self._descriptor

    def _require_feature(self, feature: str) -> None:
        if feature not in self._negotiated_features:
            raise ProtocolError(
                RPC_FEATURE_UNSUPPORTED,
                "FEATURE_NOT_NEGOTIATED",
                f"Feature was not negotiated for this session: {feature}",
                {"feature": feature},
            )

    @staticmethod
    def _checked_result(result: Any, expected_type: type[Any], method: str) -> Any:
        if isinstance(result, expected_type):
            return result
        raise ProtocolError(
            RPC_INTERNAL_ERROR,
            "PLUGIN_CONTRACT_VIOLATION",
            f"Plugin {method}() returned an invalid result type.",
        )
