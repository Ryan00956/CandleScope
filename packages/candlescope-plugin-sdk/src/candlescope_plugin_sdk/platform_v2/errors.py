"""Stable contract and JSON-RPC failures for Plugin Platform v2."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PlatformContractError(ValueError):
    """A deterministic public-model validation failure."""

    code: str
    message: str
    path: str | None = None

    def __post_init__(self) -> None:
        ValueError.__init__(self, self.message)


@dataclass(slots=True)
class PlatformProtocolError(Exception):
    """An expected protocol failure safe to return across the control plane."""

    rpc_code: int
    code: str
    message: str
    data: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)

    def to_wire(self) -> dict[str, Any]:
        return {
            "code": self.rpc_code,
            "message": self.message,
            "data": {**self.data, "code": self.code},
        }


def contract_error(message: str, *, path: str | None = None) -> PlatformContractError:
    return PlatformContractError("INVALID_CONTRACT", message, path)
