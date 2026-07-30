"""Stable errors for the CandleScope runtime-plugin host."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PluginHostError(RuntimeError):
    """Base error carrying a stable host-owned symbolic code."""

    code: str
    message: str
    runtime_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        RuntimeError.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"runtimeId": self.runtime_id} if self.runtime_id is not None else {}),
            **({"details": dict(self.details)} if self.details else {}),
        }


class PluginRegistryError(PluginHostError):
    """The activation registry is missing, malformed, or unsafe."""

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            code="PLUGIN_REGISTRY_INVALID",
            message=message,
            details=details or {},
        )


class PluginRequestError(PluginHostError):
    """A host-side request is invalid and was not sent to the sidecar."""


class PluginRemoteError(PluginHostError):
    """A well-formed JSON-RPC error returned by a healthy sidecar."""


class PluginTransportError(PluginHostError):
    """A fatal process or wire failure that invalidates the session."""


class PluginBundleError(PluginHostError):
    """A .cspkg archive or its manifest failed strict verification."""

    def __init__(
        self,
        message: str,
        *,
        runtime_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            code="PLUGIN_BUNDLE_INVALID",
            message=message,
            runtime_id=runtime_id,
            details=details or {},
        )


class PluginInstallerError(PluginHostError):
    """A verified bundle could not be installed, checked, or rolled back."""

    def __init__(
        self,
        message: str,
        *,
        runtime_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            code="PLUGIN_INSTALLER_FAILED",
            message=message,
            runtime_id=runtime_id,
            details=details or {},
        )
