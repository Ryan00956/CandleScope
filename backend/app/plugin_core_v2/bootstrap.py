"""Environment-controlled bootstrap for the Phase 5 product composition root."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from app.plugin_security_v2 import TRUST_UX_ENABLED_ENV
from app.plugin_security_v2.management import LocalManagementGuard
from app.plugin_runtime_registry_v3 import (
    RUNTIME_REGISTRY_ENABLED_ENV,
    RUNTIME_REGISTRY_NETWORK_UPDATES_ENV,
)
from app.plugin_marketplace_v2 import (
    MarketplaceError,
    MarketplaceRoot,
    load_marketplace_roots_bytes,
)

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
PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED"
)
PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENABLED"
)
PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENABLED"
)
PLUGIN_PLATFORM_V2_MARKETPLACE_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED"
)
PLUGIN_PLATFORM_V2_MARKETPLACE_ROOTS_ENV = (
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ROOTS"
)
DEFAULT_MARKETPLACE_ROOTS = (
    Path(__file__).resolve().parents[1] / "official-marketplace-roots.json"
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


def marketplace_roots_from_environment(
    environ: Mapping[str, str],
) -> tuple[MarketplaceRoot, ...]:
    configured = environ.get(PLUGIN_PLATFORM_V2_MARKETPLACE_ROOTS_ENV)
    if configured is not None and not configured.strip():
        raise core_error(
            "PLUGIN_CORE_ENVIRONMENT_INVALID",
            f"{PLUGIN_PLATFORM_V2_MARKETPLACE_ROOTS_ENV} must not be empty",
        )
    path = (
        Path(configured).expanduser().resolve(strict=False)
        if configured is not None
        else DEFAULT_MARKETPLACE_ROOTS
    )
    try:
        if path.is_symlink() or not path.is_file():
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ROOTS_INVALID",
                "marketplace roots must be a regular file",
            )
        return load_marketplace_roots_bytes(path.read_bytes())
    except (OSError, MarketplaceError) as exc:
        raise core_error(
            "PLUGIN_CORE_MARKETPLACE_ROOTS_INVALID",
            "build-pinned marketplace roots could not be loaded",
            details={"errorType": type(exc).__name__},
        ) from exc


def build_core_plugin_platform_from_environment(
    *,
    host_name: str,
    host_version: str,
    environ: Mapping[str, str] | None = None,
) -> CorePluginPlatform | DisabledCorePluginPlatform:
    env = os.environ if environ is None else environ
    if not _environment_bool(env, PLUGIN_PLATFORM_V2_ENABLED_ENV, default=True):
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
        live_reconciliation_shadow_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
            default=False,
        ),
        live_native_control_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV,
            default=False,
        ),
        live_testnet_execution_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV,
            default=False,
        ),
        marketplace_enabled=_environment_bool(
            env,
            PLUGIN_PLATFORM_V2_MARKETPLACE_ENV,
            default=False,
        ),
        marketplace_roots=marketplace_roots_from_environment(env),
        runtime_registry_enabled=_environment_bool(
            env, RUNTIME_REGISTRY_ENABLED_ENV, default=False
        ),
        runtime_registry_network_updates_enabled=_environment_bool(
            env, RUNTIME_REGISTRY_NETWORK_UPDATES_ENV, default=False
        ),
        trust_ux_enabled=_environment_bool(env, TRUST_UX_ENABLED_ENV, default=False),
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
