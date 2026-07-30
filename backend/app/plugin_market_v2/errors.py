"""Stable failures for the Phase 6 market consumer layer."""

from __future__ import annotations

from typing import Any

from app.plugin_security_v2.errors import PlatformSecurityError, security_error


def market_error(
    code: str,
    message: str,
    *,
    plugin_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> PlatformSecurityError:
    return security_error(
        code,
        message,
        plugin_id=plugin_id,
        details=details or {},
    )


__all__ = ["market_error"]
