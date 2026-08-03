"""Stable fail-closed errors for the Host-managed Runtime Registry."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class RuntimeRegistryError(RuntimeError):
    """A bounded Runtime Registry failure safe to expose in diagnostics."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"details": dict(self.details)} if self.details else {}),
        }


def registry_error(
    code: str,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
) -> RuntimeRegistryError:
    return RuntimeRegistryError(code, message, details=details)
