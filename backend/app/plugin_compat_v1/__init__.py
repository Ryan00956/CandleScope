"""Host-owned compatibility bridge for the frozen v1 script runtime platform."""

from .bridge import (
    COMPATIBILITY_CATALOG_SCHEMA_VERSION,
    COMPATIBILITY_CONTRIBUTION_KIND,
    COMPATIBILITY_PREVIEW_SCHEMA_VERSION,
    COMPATIBILITY_STATE_SCHEMA_VERSION,
    V1ScriptRuntimeCompatibilityBridge,
)

__all__ = [
    "COMPATIBILITY_CATALOG_SCHEMA_VERSION",
    "COMPATIBILITY_CONTRIBUTION_KIND",
    "COMPATIBILITY_PREVIEW_SCHEMA_VERSION",
    "COMPATIBILITY_STATE_SCHEMA_VERSION",
    "V1ScriptRuntimeCompatibilityBridge",
]
