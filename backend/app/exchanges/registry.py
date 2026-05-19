from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from .base import ExchangeAdapter
from .plugin import BuiltinExchangePlugin, ExchangePlugin


SUPPORTED_PLUGIN_API_MAJOR = 1
SUPPORTED_CAPABILITY_SCHEMA_VERSION = 1


class ExchangePluginRegistrationError(ValueError):
    """Raised when an exchange plugin cannot be safely registered."""


@dataclass(slots=True)
class ExchangePluginLoadStatus:
    """Registry-visible load/registration status for one plugin source."""

    plugin_id: str
    source: str
    status: str
    api_version: str = ""
    capability_schema_version: int | None = None
    protocol_class: str = ""
    adapter_class: str = ""
    policy_classes: dict[str, str] = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "plugin_id": self.plugin_id,
            "source": self.source,
            "status": self.status,
            "api_version": self.api_version,
            "capability_schema_version": self.capability_schema_version,
            "protocol_class": self.protocol_class,
            "adapter_class": self.adapter_class,
            "policy_classes": dict(self.policy_classes),
            "error": self.error,
        }


class ExchangeRegistry:
    """Simple in-process registry for exchange plugins.

    The old adapter-centric API is kept for compatibility while callers move
    toward the plugin entry points.
    """

    def __init__(self) -> None:
        self._plugins: dict[str, ExchangePlugin] = {}
        self._load_statuses: dict[str, ExchangePluginLoadStatus] = {}
        self._external_loader_fingerprints: set[str] = set()

    def register(
        self,
        plugin_or_adapter: ExchangePlugin | ExchangeAdapter,
        *,
        source: str = "builtin",
    ) -> None:
        plugin = self._coerce_plugin(plugin_or_adapter)
        try:
            self._assert_compatible(plugin)
        except Exception as exc:
            self.record_load_error(
                getattr(plugin, "id", "unknown"),
                source=source,
                error=exc,
            )
            raise
        self._plugins[plugin.id] = plugin
        self._load_statuses[plugin.id] = self._status_for_plugin(plugin, source=source)

    def has(self, exchange: str) -> bool:
        return exchange.strip().lower() in self._plugins

    def get(self, exchange: str) -> ExchangeAdapter:
        return self.get_plugin(exchange).adapter()

    def get_plugin(self, exchange: str) -> ExchangePlugin:
        key = exchange.strip().lower()
        if key not in self._plugins:
            raise KeyError(f"Unknown exchange: {exchange}")
        return self._plugins[key]

    def list(self) -> list[ExchangeAdapter]:
        return [plugin.adapter() for plugin in self.list_plugins()]

    def list_plugins(self) -> list[ExchangePlugin]:
        return sorted(self._plugins.values(), key=lambda plugin: plugin.id)

    def items(self) -> Iterable[tuple[str, ExchangeAdapter]]:
        return ((plugin.id, plugin.adapter()) for plugin in self.list_plugins())

    def plugin_items(self) -> Iterable[tuple[str, ExchangePlugin]]:
        return ((plugin.id, plugin) for plugin in self.list_plugins())

    def diagnostics(self) -> dict:
        statuses = sorted(self._load_statuses.values(), key=lambda item: item.plugin_id)
        return {
            "supported_plugin_api_major": SUPPORTED_PLUGIN_API_MAJOR,
            "supported_capability_schema_version": SUPPORTED_CAPABILITY_SCHEMA_VERSION,
            "count": len(statuses),
            "plugins": [status.to_dict() for status in statuses],
        }

    def record_load_error(self, plugin_id: str, *, source: str, error: Exception | str) -> None:
        self._load_statuses[plugin_id] = ExchangePluginLoadStatus(
            plugin_id=plugin_id,
            source=source,
            status="error",
            error=str(error),
        )

    def has_external_loader_fingerprint(self, fingerprint: str) -> bool:
        return fingerprint in self._external_loader_fingerprints

    def mark_external_loader_fingerprint(self, fingerprint: str) -> None:
        self._external_loader_fingerprints.add(fingerprint)

    @staticmethod
    def _coerce_plugin(plugin_or_adapter: ExchangePlugin | ExchangeAdapter) -> ExchangePlugin:
        adapter_method = getattr(plugin_or_adapter, "adapter", None)
        if callable(adapter_method):
            return plugin_or_adapter  # type: ignore[return-value]

        adapter = plugin_or_adapter  # type: ignore[assignment]
        return BuiltinExchangePlugin(adapter)

    @staticmethod
    def _assert_compatible(plugin: ExchangePlugin) -> None:
        capabilities = plugin.capabilities()
        if capabilities.exchange != plugin.id:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} capabilities.exchange must match plugin id"
            )
        api_major = _parse_major_version(capabilities.plugin_api_version)
        if api_major != SUPPORTED_PLUGIN_API_MAJOR:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} uses unsupported exchange plugin API "
                f"{capabilities.plugin_api_version!r}; supported major is "
                f"{SUPPORTED_PLUGIN_API_MAJOR}"
            )
        if capabilities.capability_schema_version > SUPPORTED_CAPABILITY_SCHEMA_VERSION:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} uses capability schema "
                f"{capabilities.capability_schema_version}; supported version is "
                f"{SUPPORTED_CAPABILITY_SCHEMA_VERSION}"
            )

    @staticmethod
    def _status_for_plugin(plugin: ExchangePlugin, *, source: str) -> ExchangePluginLoadStatus:
        capabilities = plugin.capabilities()
        return ExchangePluginLoadStatus(
            plugin_id=plugin.id,
            source=source,
            status="loaded",
            api_version=capabilities.plugin_api_version,
            capability_schema_version=capabilities.capability_schema_version,
            protocol_class=_qualified_class_name(plugin.protocol()),
            adapter_class=_qualified_class_name(plugin.adapter()),
            policy_classes={
                "rate_limit": _qualified_class_name(plugin.rate_limit_policy()),
                "pagination": _qualified_class_name(plugin.pagination_policy()),
                "realtime": _qualified_class_name(plugin.realtime_policy()),
                "symbol": _qualified_class_name(plugin.symbol_normalizer()),
            },
        )


def _parse_major_version(version: str) -> int:
    try:
        return int(str(version).split(".", 1)[0])
    except (TypeError, ValueError) as exc:
        raise ExchangePluginRegistrationError(
            f"Invalid exchange plugin API version: {version!r}"
        ) from exc


def _qualified_class_name(obj: object) -> str:
    cls = obj.__class__
    return f"{cls.__module__}.{cls.__name__}"


_registry = ExchangeRegistry()


def get_exchange_registry() -> ExchangeRegistry:
    return _registry


def bootstrap_default_adapters() -> ExchangeRegistry:
    if not _registry.has("binance"):
        from .plugins.binance import create_plugin

        _registry.register(create_plugin(), source="builtin:binance")
    if not _registry.has("okx"):
        from .plugins.okx import create_plugin

        _registry.register(create_plugin(), source="builtin:okx")
    from .loader import load_external_plugins_from_env

    load_external_plugins_from_env(_registry)
    return _registry
