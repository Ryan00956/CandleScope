"""CandleScope script-runtime plugin host."""

from .bootstrap import build_runtime_host_from_environment
from .errors import (
    PluginHostError,
    PluginRegistryError,
    PluginRemoteError,
    PluginRequestError,
    PluginTransportError,
)
from .registry import (
    RUNTIME_REGISTRY_SCHEMA_VERSION,
    RuntimeProcessSpec,
    RuntimeRegistry,
    load_runtime_registry,
)
from .service import RuntimeHostService
from .supervisor import RuntimeSupervisor

__all__ = [
    "PluginHostError",
    "PluginRegistryError",
    "PluginRemoteError",
    "PluginRequestError",
    "PluginTransportError",
    "RUNTIME_REGISTRY_SCHEMA_VERSION",
    "RuntimeHostService",
    "RuntimeProcessSpec",
    "RuntimeRegistry",
    "RuntimeSupervisor",
    "build_runtime_host_from_environment",
    "load_runtime_registry",
]
