"""Stable failures for Plugin Platform v2 packaging and installation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PlatformInstallerBaseError(RuntimeError):
    code: str
    message: str
    plugin_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        RuntimeError.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"pluginId": self.plugin_id} if self.plugin_id else {}),
            **({"details": dict(self.details)} if self.details else {}),
        }


class PlatformBundleError(PlatformInstallerBaseError):
    def __init__(
        self,
        message: str,
        *,
        plugin_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            "PLUGIN_PLATFORM_BUNDLE_INVALID",
            message,
            plugin_id,
            details or {},
        )


class PlatformInstallerError(PlatformInstallerBaseError):
    def __init__(
        self,
        message: str,
        *,
        plugin_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            "PLUGIN_PLATFORM_INSTALLER_FAILED",
            message,
            plugin_id,
            details or {},
        )
