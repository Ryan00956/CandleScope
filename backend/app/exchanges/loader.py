from __future__ import annotations

from app.core.config import getenv as app_getenv

import importlib
from typing import Any

from .plugin import ExchangePlugin
from .registry import ExchangeRegistry


EXTERNAL_EXCHANGE_PLUGINS_ENV = "CANDLESCOPE_EXCHANGE_PLUGINS"


def load_external_plugins_from_env(
    registry: ExchangeRegistry,
    *,
    env_value: str | None = None,
) -> None:
    """Load optional out-of-tree exchange plugins from an environment list.

    ``CANDLESCOPE_EXCHANGE_PLUGINS`` is a comma-separated list. Each item can be
    ``module.path`` or ``module.path:factory``. If no factory is supplied, the
    loader looks for ``create_plugin`` first, then ``plugin``.
    """

    raw = (
        app_getenv(EXTERNAL_EXCHANGE_PLUGINS_ENV, "")
        if env_value is None
        else env_value
    )
    specs = [item.strip() for item in raw.split(",") if item.strip()]
    if not specs:
        return
    fingerprint = "\n".join(specs)
    if registry.has_external_loader_fingerprint(fingerprint):
        return
    registry.mark_external_loader_fingerprint(fingerprint)

    for spec in specs:
        try:
            plugin = load_external_plugin(spec)
            registry.register(plugin, source=f"external:{spec}")
        except Exception as exc:
            registry.record_load_error(spec, source=f"external:{spec}", error=exc)


def load_external_plugin(spec: str) -> ExchangePlugin:
    module_name, _, attr_name = spec.partition(":")
    if not module_name:
        raise ValueError("External exchange plugin spec must include a module name")

    module = importlib.import_module(module_name)
    factory = _resolve_plugin_factory(module, attr_name or None)
    plugin = factory() if callable(factory) else factory
    if not _looks_like_plugin(plugin):
        raise TypeError(
            f"External exchange plugin {spec!r} did not produce an ExchangePlugin-like object"
        )
    return plugin


def _resolve_plugin_factory(module: Any, attr_name: str | None) -> Any:
    if attr_name:
        if not hasattr(module, attr_name):
            raise AttributeError(f"Module {module.__name__!r} has no attribute {attr_name!r}")
        return getattr(module, attr_name)
    if hasattr(module, "create_plugin"):
        return getattr(module, "create_plugin")
    if hasattr(module, "plugin"):
        return getattr(module, "plugin")
    raise AttributeError(
        f"Module {module.__name__!r} must expose create_plugin() or plugin"
    )


def _looks_like_plugin(plugin: Any) -> bool:
    required = (
        "id",
        "name",
        "adapter",
        "capabilities",
        "protocol",
        "normalizer",
        "symbol_normalizer",
        "rate_limit_policy",
        "pagination_policy",
        "realtime_policy",
        "price_stream_type",
    )
    return all(hasattr(plugin, name) for name in required)
