"""Structured indicator error helpers."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class IndicatorError:
    """Frontend-facing error detail shared by HTTP and WebSocket payloads."""

    code: str
    message: str
    line: int | None = None
    column: int | None = None
    hint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
        }
        if self.line is not None:
            payload["line"] = self.line
        if self.column is not None:
            payload["column"] = self.column
        if self.hint:
            payload["hint"] = self.hint
        return payload


def error_detail(
    code: str,
    message: str,
    *,
    line: int | None = None,
    column: int | None = None,
    hint: str | None = None,
) -> dict[str, Any]:
    return IndicatorError(
        code=code,
        message=message,
        line=line,
        column=column,
        hint=hint,
    ).to_dict()

