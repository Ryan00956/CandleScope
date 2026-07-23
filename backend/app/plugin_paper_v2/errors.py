"""Typed fail-closed errors for Host-owned Paper trading."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class PaperTradingError(Exception):
    code: str
    message: str
    plugin_id: str | None = None
    details: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"pluginId": self.plugin_id} if self.plugin_id is not None else {}),
            **({"details": dict(self.details)} if self.details else {}),
        }


def paper_error(
    code: str,
    message: str,
    *,
    plugin_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> PaperTradingError:
    return PaperTradingError(code, message, plugin_id, details)


__all__ = ["PaperTradingError", "paper_error"]
