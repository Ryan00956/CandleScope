"""Fail-closed errors for Plugin Platform v2 security controls."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PlatformSecurityError(Exception):
    code: str
    message: str
    plugin_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"pluginId": self.plugin_id} if self.plugin_id is not None else {}),
            **({"details": dict(self.details)} if self.details else {}),
        }


def security_error(
    code: str,
    message: str,
    *,
    plugin_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> PlatformSecurityError:
    return PlatformSecurityError(code, message, plugin_id, details or {})
