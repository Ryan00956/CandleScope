"""Stable identifiers and bounds for the additive Plugin Platform v2 SDK."""

from __future__ import annotations


PLUGIN_PROTOCOL_V2 = "candlescope.plugin/2"
HOST_API_V1 = "candlescope.host-api/1"
UI_BRIDGE_V1 = "candlescope.ui-bridge/1"
CONTROL_TRANSPORT_V1 = "jsonl/1"
JSONRPC_VERSION = "2.0"
MANIFEST_SCHEMA_VERSION_V2 = 2
MANIFEST_SCHEMA_VERSION_V3 = 3
# Backward-compatible public alias. Existing callers and schema-v2 fixtures
# intentionally continue to resolve this name to version 2.
MANIFEST_SCHEMA_VERSION = MANIFEST_SCHEMA_VERSION_V2
PLATFORM_SDK_API_VERSION = "0.1.0"

RUNTIME_KIND_PYTHON_MODULE = "python-module"
RUNTIME_KIND_NATIVE_EXECUTABLE = "native-executable"
RUNTIME_KIND_JAVA_JAR = "java-jar"
RUNTIME_KIND_NODE_MODULE = "node-module"
RUNTIME_KIND_WASM_COMPONENT = "wasm-component"
RUNTIME_KINDS = frozenset(
    {
        RUNTIME_KIND_PYTHON_MODULE,
        RUNTIME_KIND_NATIVE_EXECUTABLE,
        RUNTIME_KIND_JAVA_JAR,
        RUNTIME_KIND_NODE_MODULE,
        RUNTIME_KIND_WASM_COMPONENT,
    }
)
PYTHON_V2_COMPAT_RUNTIME_ID = "python-v2-compat"
SUPPORTED_OPERATING_SYSTEMS = frozenset({"linux", "macos", "windows"})
SUPPORTED_ARCHITECTURES = frozenset({"arm64", "x86_64"})

DEFAULT_MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024
DEFAULT_MAX_JSON_DEPTH = 32
DEFAULT_MAX_CONTAINER_ITEMS = 10_000
DEFAULT_MAX_STRING_BYTES = 256 * 1024
DEFAULT_MAX_IN_FLIGHT = 32
DEFAULT_MAX_UI_BRIDGE_MESSAGE_BYTES = 32 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991

METHOD_HANDSHAKE = "handshake"
METHOD_DESCRIBE = "describe"
METHOD_ACTIVATE = "activate"
METHOD_INVOKE = "invoke"
METHOD_EVENT_BATCH = "eventBatch"
METHOD_HEALTH_CHECK = "healthCheck"
METHOD_CANCEL = "cancel"
METHOD_DEACTIVATE = "deactivate"
METHOD_PREPARE_UPGRADE = "prepareUpgrade"
METHOD_SHUTDOWN = "shutdown"
METHOD_HOST_CALL = "host.call"

HOST_TO_PLUGIN_METHODS = frozenset(
    {
        METHOD_HANDSHAKE,
        METHOD_DESCRIBE,
        METHOD_ACTIVATE,
        METHOD_INVOKE,
        METHOD_EVENT_BATCH,
        METHOD_HEALTH_CHECK,
        METHOD_CANCEL,
        METHOD_DEACTIVATE,
        METHOD_PREPARE_UPGRADE,
        METHOD_SHUTDOWN,
    }
)

ACTIVATION_EVENTS = frozenset(
    {
        "onCommand",
        "onView",
        "onSchedule",
        "onMarketSubscription",
        "onStartup",
    }
)
RESOURCE_PROFILES = frozenset({"minimal", "standard", "service"})
FRONTEND_SURFACE_TYPES = frozenset({"declarative", "sandbox"})
PROBE_KINDS = frozenset({"controlTranscript"})

RPC_PARSE_ERROR = -32700
RPC_INVALID_REQUEST = -32600
RPC_METHOD_NOT_FOUND = -32601
RPC_INVALID_PARAMS = -32602
RPC_INTERNAL_ERROR = -32603
RPC_HANDSHAKE_REQUIRED = -32101
RPC_PROTOCOL_UNSUPPORTED = -32102
RPC_INVALID_STATE = -32103
RPC_GENERATION_MISMATCH = -32104
RPC_REQUEST_ID_IN_USE = -32105
RPC_CAPABILITY_INVALID = -32106
RPC_CONTRACT_VIOLATION = -32107
RPC_REQUEST_CANCELLED = -32800
