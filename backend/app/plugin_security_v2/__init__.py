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
from .sandbox import (
    PreparedSandboxLaunch,
    SandboxPolicy,
    delete_appcontainer_profile,
    prepare_sandbox_launch,
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
    "PlatformSecurityError",
    "PreparedSandboxLaunch",
    "SandboxPolicy",
    "classify_scope_change",
    "delete_appcontainer_profile",
    "prepare_sandbox_launch",
    "sandbox_profile_name",
    "scope_contains",
]
