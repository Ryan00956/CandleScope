"""Replay training v2 error contract."""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping


class TrainingRunError(Exception):
    """Stable replay.v2 domain failure with an HTTP-safe status."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 409,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = MappingProxyType(dict(details or {}))

    def to_payload(self) -> dict[str, object]:
        return {
            "protocol": "replay.v2",
            "error": {
                "code": self.code,
                "message": self.message,
                "details": dict(self.details),
            },
        }


__all__ = ["TrainingRunError"]
