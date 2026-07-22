"""Stable failures for the Phase 5 core Plugin Platform runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class CorePluginError(RuntimeError):
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


def core_error(
    code: str,
    message: str,
    *,
    plugin_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> CorePluginError:
    return CorePluginError(code, message, plugin_id, details or {})
