"""Stable errors for the opt-in GitHub adapter assessment tooling."""

from __future__ import annotations

from typing import Any


class GitHubImportError(RuntimeError):
    """Fail-closed error exposed by ``candlescope-plugin v3``."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"details": self.details} if self.details else {}),
        }


def github_import_error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> GitHubImportError:
    return GitHubImportError(code, message, details=details)


__all__ = ["GitHubImportError", "github_import_error"]
