"""Security control plane for CandleScope Plugin Platform v2."""

from .audit import AuditEvent, AuditLog
from .capabilities import (
    CapabilityBroker,
    CapabilityHandleAuthority,
    CapabilityLease,
    CapabilityMethodPolicy,
)
from .errors import PlatformSecurityError
from .grants import (
    EffectiveGrant,
    GrantMutationResult,
    GrantStore,
    PermissionDiff,
    PermissionDiffItem,
)
from .scope import classify_scope_change, scope_contains
from .python_runtime import PinnedPythonRuntime, prepare_pinned_python_runtime
from .trust import (
    CANONICAL_TRUST_MODES,
    TRUST_ALIASES,
    TRUST_UX_ENABLED_ENV,
    ClaimedLocalInstall,
    PluginTrustService,
    RuntimeAuthorization,
    TrustEvidence,
    canonical_trust_mode,
)
from .sandbox import (
    PreparedSandboxLaunch,
    RestrictedRuntimeProfile,
    SandboxPolicy,
    delete_appcontainer_profile,
    prepare_sandbox_launch,
    restricted_runtime_profile,
    restricted_runtime_profiles_status,
    sandbox_profile_name,
)

__all__ = [
    "AuditEvent",
    "AuditLog",
    "CapabilityBroker",
    "CapabilityHandleAuthority",
    "CapabilityLease",
    "CapabilityMethodPolicy",
    "EffectiveGrant",
    "GrantMutationResult",
    "GrantStore",
    "PermissionDiff",
    "PermissionDiffItem",
    "PinnedPythonRuntime",
    "PluginTrustService",
    "PlatformSecurityError",
    "PreparedSandboxLaunch",
    "RestrictedRuntimeProfile",
    "RuntimeAuthorization",
    "SandboxPolicy",
    "TrustEvidence",
    "ClaimedLocalInstall",
    "TRUST_ALIASES",
    "TRUST_UX_ENABLED_ENV",
    "CANONICAL_TRUST_MODES",
    "canonical_trust_mode",
    "classify_scope_change",
    "delete_appcontainer_profile",
    "prepare_sandbox_launch",
    "prepare_pinned_python_runtime",
    "restricted_runtime_profile",
    "restricted_runtime_profiles_status",
    "sandbox_profile_name",
    "scope_contains",
]
