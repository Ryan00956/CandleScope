"""Request error types."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class PyneRequestError(Exception):
    """Stable runtime error raised by host-backed request helpers."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "PYNE_UNSUPPORTED_FEATURE",
        category: str | None = None,
        request_context: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.category = category
        self.request_context = dict(request_context or {})

    def with_request_context(self, **context: Any) -> "PyneRequestError":
        self.request_context = {**context, **self.request_context}
        return self


class PyneInvalidSymbolError(Exception):
    """Provider-side signal for Pine-like invalid symbol handling."""

    def __init__(self, symbol: str, *, message: str | None = None) -> None:
        super().__init__(message or str(symbol))
        self.symbol = str(symbol)
