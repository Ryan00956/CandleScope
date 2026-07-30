"""Protocol error types with stable JSON-RPC and symbolic codes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .constants import RPC_INVALID_PARAMS


@dataclass(slots=True)
class ProtocolError(Exception):
    """An expected protocol failure safe to return to a plugin host."""

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


def invalid_params(message: str, *, field_name: str | None = None) -> ProtocolError:
    data = {"field": field_name} if field_name else {}
    return ProtocolError(
        RPC_INVALID_PARAMS,
        "INVALID_PARAMS",
        message,
        data,
    )
