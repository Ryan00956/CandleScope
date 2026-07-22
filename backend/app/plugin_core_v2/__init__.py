"""Phase 5 minimum general Plugin Platform product root."""

from .api import create_core_plugin_router
from .bootstrap import (
    build_core_plugin_platform_from_environment,
    build_management_guard_from_environment,
)
from .contracts import (
    CORE_CONTRIBUTION_KINDS,
    PUBLIC_EVENT_SCHEMAS,
    CoreContribution,
    core_contributions,
)
from .errors import CorePluginError
from .runtime import CorePluginPlatform, DisabledCorePluginPlatform

__all__ = [
    "CORE_CONTRIBUTION_KINDS",
    "PUBLIC_EVENT_SCHEMAS",
    "CoreContribution",
    "CorePluginError",
    "CorePluginPlatform",
    "DisabledCorePluginPlatform",
    "build_core_plugin_platform_from_environment",
    "build_management_guard_from_environment",
    "core_contributions",
    "create_core_plugin_router",
]
