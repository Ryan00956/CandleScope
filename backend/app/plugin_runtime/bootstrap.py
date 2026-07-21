"""Environment-driven bootstrap for the optional runtime-plugin host."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from .errors import PluginRegistryError
from .registry import (
    default_runtime_registry_path,
    load_runtime_registry,
)
from .service import RuntimeHostService


PLUGIN_HOST_ENABLED_ENV = "CANDLESCOPE_PLUGIN_HOST_ENABLED"
RUNTIME_REGISTRY_ENV = "CANDLESCOPE_RUNTIME_REGISTRY"


def _environment_bool(
    environ: Mapping[str, str],
    name: str,
    *,
    default: bool,
) -> bool:
    raw = environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise PluginRegistryError(
        f"{name} must be one of 1/0, true/false, yes/no, or on/off"
    )


def build_runtime_host_from_environment(
    *,
    host_name: str,
    host_version: str,
    environ: Mapping[str, str] | None = None,
) -> RuntimeHostService:
    env = os.environ if environ is None else environ
    enabled = _environment_bool(env, PLUGIN_HOST_ENABLED_ENV, default=True)
    if not enabled:
        return RuntimeHostService.disabled(
            host_name=host_name,
            host_version=host_version,
        )

    override = env.get(RUNTIME_REGISTRY_ENV)
    if override is not None and not override.strip():
        raise PluginRegistryError(f"{RUNTIME_REGISTRY_ENV} must not be empty")
    registry_path = (
        Path(override).expanduser()
        if override is not None
        else default_runtime_registry_path(env)
    )
    registry = load_runtime_registry(
        registry_path,
        allow_missing=override is None,
    )
    return RuntimeHostService(
        registry,
        host_name=host_name,
        host_version=host_version,
    )
