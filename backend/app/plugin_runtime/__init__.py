"""CandleScope script-runtime plugin host."""

from .bootstrap import build_runtime_host_from_environment
from .bundle import (
    BUNDLE_EXTENSION,
    BUNDLE_SCHEMA_VERSION,
    BundleManifest,
    VerifiedBundle,
    build_plugin_bundle,
    inspect_plugin_bundle,
    verify_plugin_bundle,
)
from .errors import (
    PluginBundleError,
    PluginHostError,
    PluginInstallerError,
    PluginRegistryError,
    PluginRemoteError,
    PluginRequestError,
    PluginTransportError,
)
from .registry import (
    ManagedRuntimeIdentity,
    RUNTIME_REGISTRY_SCHEMA_VERSION,
    RuntimeProcessSpec,
    RuntimeRegistry,
    load_runtime_registry,
    runtime_process_spec_to_wire,
    runtime_registry_from_wire,
    runtime_registry_to_wire,
)
from .installer import (
    CheckResult,
    InstallResult,
    PluginInstaller,
    RollbackResult,
)
from .service import RuntimeHostService
from .supervisor import RuntimeSupervisor

__all__ = [
    "BUNDLE_EXTENSION",
    "BUNDLE_SCHEMA_VERSION",
    "BundleManifest",
    "CheckResult",
    "InstallResult",
    "PluginHostError",
    "PluginInstaller",
    "PluginBundleError",
    "PluginInstallerError",
    "PluginRegistryError",
    "PluginRemoteError",
    "PluginRequestError",
    "PluginTransportError",
    "ManagedRuntimeIdentity",
    "RUNTIME_REGISTRY_SCHEMA_VERSION",
    "RuntimeHostService",
    "RuntimeProcessSpec",
    "RuntimeRegistry",
    "RuntimeSupervisor",
    "RollbackResult",
    "VerifiedBundle",
    "build_plugin_bundle",
    "build_runtime_host_from_environment",
    "load_runtime_registry",
    "inspect_plugin_bundle",
    "runtime_process_spec_to_wire",
    "runtime_registry_from_wire",
    "runtime_registry_to_wire",
    "verify_plugin_bundle",
]
