"""Structured Pyne error helpers."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


DOCS_BASE_URL = "https://github.com/Ryan00956/pyne-runtime/tree/main/docs"


ERROR_HINTS: dict[str, str] = {
    "PYNE_SYNTAX_ERROR": (
        "Check the reported line for Python syntax issues such as indentation, "
        "unclosed parentheses, commas, or assignment syntax."
    ),
    "PYNE_RUNTIME_ERROR": (
        "Check variable names, function arguments, and whether custom arrays align "
        "with the OHLCV data length."
    ),
    "PYNE_IMPORT_BLOCKED": (
        "Safe mode blocks imports. Remove the import, use a built-in Pyne helper, "
        "or run with research mode and an explicit allowed_imports list."
    ),
    "PYNE_TIMEOUT": (
        "Reduce loops or data size, or increase timeout_seconds only for trusted scripts."
    ),
    "PYNE_OUTPUT_LIMIT_EXCEEDED": (
        "Reduce plot, marker, or bar outputs, or lower the number of emitted points."
    ),
    "PYNE_INVALID_OHLCV": (
        "Provide at least one OHLCV bar with time, open, high, low, close, and volume."
    ),
    "PYNE_INVALID_SYMBOL": (
        "Check the requested symbol or use ignore_invalid_symbol=True when missing symbols are expected."
    ),
    "PYNE_INVALID_PARAM": "Check script input declarations and provided params.",
    "PYNE_MIGRATION_HINT": "Use Pyne's Python-native alternatives for Pine-specific syntax patterns.",
    "PYNE_LENGTH_MISMATCH": "Make sure custom arrays have the same length as the OHLCV input.",
    "PYNE_UNSUPPORTED_FEATURE": "This Pyne feature is not supported by the current runtime.",
    "PYNE_PROCESS_FAILED": (
        "The worker process exited unexpectedly. Check third-party imports, native "
        "extensions, and resource usage."
    ),
    "PYNE_PROCESS_SERIALIZATION_ERROR": (
        "Process mode can only receive pickle-serializable scripts, data, params, "
        "settings, and host-provided objects such as data providers."
    ),
    "PYNE_SECURITY_ERROR": "The selected Pyne security policy rejected the script.",
}


ERROR_DOCS: dict[str, str] = {
    code: f"{DOCS_BASE_URL}/reference/error_codes.md#{code.lower().replace('_', '-')}"
    for code in ERROR_HINTS
}


@dataclass(frozen=True)
class PyneErrorDetail:
    code: str
    message: str
    line: int | None = None
    column: int | None = None
    hint: str | None = None
    docs_url: str | None = None

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
        if self.docs_url:
            payload["docsUrl"] = self.docs_url
        return payload


def error_detail(
    code: str,
    message: str,
    *,
    line: int | None = None,
    column: int | None = None,
    hint: str | None = None,
    docs_url: str | None = None,
) -> dict[str, Any]:
    return PyneErrorDetail(
        code=code,
        message=message,
        line=line,
        column=column,
        hint=hint or ERROR_HINTS.get(code),
        docs_url=docs_url or ERROR_DOCS.get(code),
    ).to_dict()


def error_hint(code: str) -> str | None:
    return ERROR_HINTS.get(code)


def error_docs_url(code: str) -> str | None:
    return ERROR_DOCS.get(code)


def classify_security_error(message: str) -> str:
    if "output series" in message or "output points" in message or "Drawing object limit" in message:
        return "PYNE_OUTPUT_LIMIT_EXCEEDED"
    if "Import" in message or "import" in message:
        return "PYNE_IMPORT_BLOCKED"
    return "PYNE_SECURITY_ERROR"
