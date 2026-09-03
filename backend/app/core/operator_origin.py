"""Trusted-origin gate for host-authority execution modes."""

from __future__ import annotations

import os
from typing import Any

from app.core.config import CORS_ORIGINS

_PLUGIN_ORIGINS_ENV = "CANDLESCOPE_PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS"
_SAFE_PYNE_MODES = frozenset({"safe", "research"})


def trusted_operator_origins() -> frozenset[str]:
    origins = {item for item in CORS_ORIGINS if item}
    raw = os.getenv(_PLUGIN_ORIGINS_ENV, "")
    origins.update(item.strip() for item in raw.split(",") if item.strip())
    return frozenset(origins)


def origin_from(headers: Any) -> str | None:
    if headers is None:
        return None
    try:
        value = headers.get("origin")
    except Exception:
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def is_trusted_operator_origin(origin: str | None) -> bool:
    return bool(origin) and origin in trusted_operator_origins()


def effective_pyne_security_mode(
    requested: str | None, *, trusted: bool
) -> str | None:
    if requested is None:
        return None
    mode = str(requested).strip().lower()
    if not mode:
        return None
    if mode in _SAFE_PYNE_MODES:
        return mode
    if mode == "unsafe":
        return "unsafe" if trusted else "safe"
    return "safe"


def effective_python_runtime_mode(
    mode: str | None, confirmed: bool, *, trusted: bool
) -> tuple[str, bool]:
    requested = str(mode or "SANDBOXED_LOCAL").strip() or "SANDBOXED_LOCAL"
    if requested == "TRUSTED_LOCAL":
        if not trusted:
            return "SANDBOXED_LOCAL", False
        return "TRUSTED_LOCAL", bool(confirmed)
    if requested == "SANDBOXED_LOCAL":
        return "SANDBOXED_LOCAL", False
    return "SANDBOXED_LOCAL", False
