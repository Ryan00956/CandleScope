from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Iterable

from .base import ExchangeAdapter
from .contracts import validate_exchange_capabilities
from .models import serialize_exchange_capabilities
from .plugin import BuiltinExchangePlugin, ExchangePlugin


SUPPORTED_PLUGIN_API_MAJOR = 1
SUPPORTED_CAPABILITY_SCHEMA_VERSION = 3


class ExchangePluginRegistrationError(ValueError):
    """Raised when an exchange plugin cannot be safely registered."""


class _LegacyCapabilitySnapshot:
    """Detached, copyable snapshot for plugin-owned schema-v1 documents."""

    __slots__ = ("_payload",)

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = copy.deepcopy(payload)

    def __getattr__(self, name: str) -> Any:
        payload = object.__getattribute__(self, "_payload")
        if name not in payload:
            raise AttributeError(name)
        return copy.deepcopy(payload[name])

    def __deepcopy__(self, memo: dict[int, Any]) -> _LegacyCapabilitySnapshot:
        snapshot = type(self)(self._payload)
        memo[id(self)] = snapshot
        return snapshot

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self._payload)


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
    rate_limit_rules: list[dict[str, Any]] = field(default_factory=list)
    capability_summary: dict[str, int] = field(default_factory=dict)
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
            "rate_limit_rules": list(self.rate_limit_rules),
            "capability_summary": dict(self.capability_summary),
            "error": self.error,
        }


class ExchangeRegistry:
    """Simple in-process registry for exchange plugins.

    The old adapter-centric API is kept for compatibility while callers move
    toward the plugin entry points.
    """

    def __init__(self) -> None:
        self._plugins: dict[str, ExchangePlugin] = {}
        self._capabilities: dict[str, Any] = {}
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
            capabilities = _snapshot_capabilities(self._assert_compatible(plugin))
            status = self._status_for_plugin(
                plugin,
                capabilities,
                source=source,
            )
        except Exception as exc:
            self.record_load_error(
                getattr(plugin, "id", "unknown"),
                source=source,
                error=exc,
            )
            raise
        self._plugins[plugin.id] = plugin
        self._capabilities[plugin.id] = capabilities
        self._load_statuses[plugin.id] = status

    def has(self, exchange: str) -> bool:
        return exchange.strip().lower() in self._plugins

    def unregister(
        self,
        exchange: str,
        *,
        expected_plugin: ExchangePlugin | None = None,
    ) -> bool:
        """Remove only the expected dynamic plugin without disturbing replacements."""

        key = exchange.strip().lower()
        current = self._plugins.get(key)
        if current is None:
            return False
        if expected_plugin is not None and current is not expected_plugin:
            return False
        self._plugins.pop(key, None)
        self._capabilities.pop(key, None)
        self._load_statuses.pop(key, None)
        return True

    def get(self, exchange: str) -> ExchangeAdapter:
        return self.get_plugin(exchange).adapter()

    def get_plugin(self, exchange: str) -> ExchangePlugin:
        key = exchange.strip().lower()
        if key not in self._plugins:
            raise KeyError(f"Unknown exchange: {exchange}")
        return self._plugins[key]

    def get_capabilities(self, exchange: str) -> Any:
        """Return the capability document validated at registration time."""

        key = exchange.strip().lower()
        if key not in self._capabilities:
            raise KeyError(f"Unknown exchange: {exchange}")
        return copy.deepcopy(self._capabilities[key])

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
    def _assert_compatible(plugin: ExchangePlugin) -> Any:
        capabilities = plugin.capabilities()
        if getattr(capabilities, "exchange", None) != plugin.id:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} capabilities.exchange must match plugin id"
            )
        api_version = getattr(capabilities, "plugin_api_version", None)
        api_major = _parse_major_version(api_version)
        if api_major != SUPPORTED_PLUGIN_API_MAJOR:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} uses unsupported exchange plugin API "
                f"{api_version!r}; supported major is "
                f"{SUPPORTED_PLUGIN_API_MAJOR}"
            )
        schema_version = getattr(capabilities, "capability_schema_version", 1)
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} capability schema must be a non-boolean integer"
            )
        if schema_version > SUPPORTED_CAPABILITY_SCHEMA_VERSION:
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} uses capability schema "
                f"{schema_version}; supported version is "
                f"{SUPPORTED_CAPABILITY_SCHEMA_VERSION}"
            )
        validation = validate_exchange_capabilities(capabilities, plugin_id=plugin.id)
        errors = [issue for issue in validation.issues if issue.severity == "error"]
        if errors:
            details = "; ".join(f"{issue.code}: {issue.message}" for issue in errors)
            raise ExchangePluginRegistrationError(
                f"Plugin {plugin.id!r} has invalid capabilities: {details}"
            )
        return capabilities

    @staticmethod
    def _status_for_plugin(
        plugin: ExchangePlugin,
        capabilities: Any,
        *,
        source: str,
    ) -> ExchangePluginLoadStatus:
        rate_limit_policy = plugin.rate_limit_policy()
        return ExchangePluginLoadStatus(
            plugin_id=plugin.id,
            source=source,
            status="loaded",
            api_version=capabilities.plugin_api_version,
            capability_schema_version=getattr(capabilities, "capability_schema_version", 1),
            protocol_class=_qualified_class_name(plugin.protocol()),
            adapter_class=_qualified_class_name(plugin.adapter()),
            policy_classes={
                "rate_limit": _qualified_class_name(rate_limit_policy),
                "pagination": _qualified_class_name(plugin.pagination_policy()),
                "realtime": _qualified_class_name(plugin.realtime_policy()),
                "symbol": _qualified_class_name(plugin.symbol_normalizer()),
            },
            rate_limit_rules=_rate_limit_rule_summaries(rate_limit_policy),
            capability_summary=_capability_summary(capabilities),
        )


def _parse_major_version(version: str) -> int:
    try:
        return int(str(version).split(".", 1)[0])
    except (TypeError, ValueError) as exc:
        raise ExchangePluginRegistrationError(
            f"Invalid exchange plugin API version: {version!r}"
        ) from exc


def _snapshot_capabilities(capabilities: Any) -> Any:
    schema_version = getattr(capabilities, "capability_schema_version", 1)
    if schema_version == 1:
        payload = serialize_exchange_capabilities(capabilities)
        return _LegacyCapabilitySnapshot(payload)
    return copy.deepcopy(capabilities)


def _qualified_class_name(obj: object) -> str:
    cls = obj.__class__
    return f"{cls.__module__}.{cls.__name__}"


def _rate_limit_rule_summaries(policy: object) -> list[dict[str, Any]]:
    rules = getattr(policy, "endpoint_rules", ()) or ()
    summaries: list[dict[str, Any]] = []
    for rule in rules:
        to_dict = getattr(rule, "to_dict", None)
        if callable(to_dict):
            summaries.append(to_dict())
            continue
        summaries.append(
            {
                "name": getattr(rule, "name", ""),
                "bucket_key": getattr(rule, "bucket_key", ""),
                "endpoint": getattr(rule, "endpoint", None),
                "market_types": list(getattr(rule, "market_types", ()) or ()),
                "algorithm": getattr(rule, "algorithm", ""),
                "capacity": getattr(rule, "capacity", None),
                "refill_interval_seconds": getattr(
                    rule,
                    "refill_interval_seconds",
                    None,
                ),
                "max_concurrency": getattr(rule, "max_concurrency", None),
                "cooldown_seconds": getattr(rule, "cooldown_seconds", None),
            }
        )
    return summaries


def _capability_summary(capabilities: object) -> dict[str, int]:
    channels = tuple(getattr(capabilities, "channels", ()) or ())
    summary = {
        "channel_declarations": len(channels),
        "market_channel_pairs": 0,
        "realtime_pairs": 0,
        "history_pairs": 0,
        "websocket_pairs": 0,
        "ordered_delta_pairs": 0,
    }
    for channel in channels:
        market_count = len(tuple(getattr(channel, "market_types", ()) or ()))
        summary["market_channel_pairs"] += market_count
        if getattr(channel, "realtime", False) is True:
            summary["realtime_pairs"] += market_count
        if getattr(channel, "history", False) is True:
            summary["history_pairs"] += market_count
        transports = {
            getattr(item, "value", item)
            for item in (getattr(channel, "realtime_transports", ()) or ())
        }
        if "websocket" in transports:
            summary["websocket_pairs"] += market_count
        delivery = getattr(channel, "delivery", None)
        if getattr(delivery, "value", delivery) == "ordered_delta":
            summary["ordered_delta_pairs"] += market_count
    return summary


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
