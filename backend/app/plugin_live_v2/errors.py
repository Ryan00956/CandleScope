"""Sanitized errors shared by the private Live Broker foundation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class LiveBrokerError(Exception):
    code: str
    message: str
    fatal: bool = False
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)

    def to_wire(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "fatal": self.fatal,
            **({"details": dict(self.details)} if self.details else {}),
        }


def broker_error(
    code: str,
    message: str,
    *,
    fatal: bool = False,
    details: dict[str, Any] | None = None,
) -> LiveBrokerError:
    return LiveBrokerError(code, message, fatal, details or {})
