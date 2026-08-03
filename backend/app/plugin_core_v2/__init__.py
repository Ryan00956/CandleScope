"""Public Plugin Platform exports without eager product-root imports.

Keeping this package initializer lazy lets installer and probe processes import
the language-neutral Runtime Provider contracts without loading the API,
marketplace, trading, and product composition roots.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

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

_EXPORTS = {
    "CORE_CONTRIBUTION_KINDS": (".contracts", "CORE_CONTRIBUTION_KINDS"),
    "PUBLIC_EVENT_SCHEMAS": (".contracts", "PUBLIC_EVENT_SCHEMAS"),
    "CoreContribution": (".contracts", "CoreContribution"),
    "CorePluginError": (".errors", "CorePluginError"),
    "CorePluginPlatform": (".runtime", "CorePluginPlatform"),
    "DisabledCorePluginPlatform": (".runtime", "DisabledCorePluginPlatform"),
    "build_core_plugin_platform_from_environment": (
        ".bootstrap",
        "build_core_plugin_platform_from_environment",
    ),
    "build_management_guard_from_environment": (
        ".bootstrap",
        "build_management_guard_from_environment",
    ),
    "core_contributions": (".contracts", "core_contributions"),
    "create_core_plugin_router": (".api", "create_core_plugin_router"),
}


def __getattr__(name: str) -> Any:
    target = _EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attribute = target
    value = getattr(import_module(module_name, __name__), attribute)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted({*globals(), *__all__})
