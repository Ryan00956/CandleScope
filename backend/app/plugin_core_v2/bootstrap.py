"""Environment-controlled bootstrap for the Phase 5 product composition root."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from app.plugin_security_v2.management import LocalManagementGuard

from .errors import core_error
from .runtime import CorePluginPlatform, DisabledCorePluginPlatform


PLUGIN_PLATFORM_V2_ENABLED_ENV = "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED"
PLUGIN_PLATFORM_V2_ROOT_ENV = "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT"
PLUGIN_PLATFORM_V2_TRUST_ENV = "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST"
PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS"
)
PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST"
)
PLUGIN_PLATFORM_V2_PAPER_TRADING_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_PAPER_TRADING_ENABLED"
)
PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED"
)
PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED"
)


def _environment_bool(environ: Mapping[str, str], name: str, *, default: bool) -> bool:
    raw = environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise core_error(
        "PLUGIN_CORE_ENVIRONMENT_INVALID",
        f"{name} must be one of 1/0, true/false, yes/no, or on/off",
    )


def default_platform_root(environ: Mapping[str, str]) -> Path:
    if os.name == "nt" and environ.get("LOCALAPPDATA"):
        return Path(environ["LOCALAPPDATA"]) / "CandleScope" / "plugin-platform-v2"
    home = environ.get("HOME") or str(Path.home())
    return Path(home) / ".candlescope" / "plugin-platform-v2"


def build_core_plugin_platform_from_environment(
    *,
    host_name: str,
    host_version: str,
    environ: Mapping[str, str] | None = None,
) -> CorePluginPlatform | DisabledCorePluginPlatform:
    env = os.environ if environ is None else environ
    if not _environment_bool(env, PLUGIN_PLATFORM_V2_ENABLED_ENV, default=False):
        return DisabledCorePluginPlatform()
    root_value = env.get(PLUGIN_PLATFORM_V2_ROOT_ENV)
    if root_value is not None and not root_value.strip():
        raise core_error(
            "PLUGIN_CORE_ENVIRONMENT_INVALID",
            f"{PLUGIN_PLATFORM_V2_ROOT_ENV} must not be empty",
        )
    trust_level = env.get(PLUGIN_PLATFORM_V2_TRUST_ENV, "local-trusted").strip()
    if trust_level == "untrusted":
        raise core_error(
            "PLUGIN_CORE_SANDBOX_REQUIRED",
            "environment bootstrap cannot infer safe AppContainer runtime roots; inject an explicit SandboxPolicy factory",
        )
    allowlist = tuple(
        sorted(
            {
                item.strip()
                for item in env.get(PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST_ENV, "").split(
                    ","
                )
                if item.strip()
            }
        )
    )
    return CorePluginPlatform(
        root=Path(root_value).expanduser()
        if root_value is not None
        else default_platform_root(env),
        host_name=host_name,
        host_version=host_version,
        trust_level=trust_level,
        approved_startup_plugins=allowlist,
        paper_trading_enabled=_environment_bool(
            env, PLUGIN_PLATFORM_V2_PAPER_TRADING_ENV, default=False
        ),
        live_broker_foundation_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
            default=False,
        ),
        live_account_readonly_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
            default=False,
        ),
    )


def build_management_guard_from_environment(
    *,
    platform: CorePluginPlatform | DisabledCorePluginPlatform,
    environ: Mapping[str, str] | None = None,
) -> LocalManagementGuard | None:
    if isinstance(platform, DisabledCorePluginPlatform):
        return None
    env = os.environ if environ is None else environ
    raw = env.get(
        PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS_ENV,
        "http://127.0.0.1:5173",
    )
    origins = tuple(item.strip() for item in raw.split(",") if item.strip())
    if not origins:
        raise core_error(
            "PLUGIN_CORE_ENVIRONMENT_INVALID",
            "at least one exact loopback management origin is required",
        )
    return LocalManagementGuard(origins)
