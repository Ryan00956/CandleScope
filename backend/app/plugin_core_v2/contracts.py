"""Host-owned contracts for Plugin Platform v2 contribution surfaces."""

from __future__ import annotations

import ipaddress
import math
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    Contribution,
    PluginManifest,
    canonical_dumps,
    normalize_json,
)

from .errors import core_error


CORE_CONTRIBUTION_KINDS = frozenset(
    {
        "command/1",
        "settings/1",
        "notification/1",
        "event-subscriber/1",
        "job/1",
        "chart-layer/1",
        "chart-layer/2",
        "view/1",
        "http-endpoint/1",
        "symbol-provider/1",
        "market-data-provider/1",
        "account-provider/1",
        "order-executor/1",
    }
)

PUBLIC_EVENT_SCHEMAS: dict[str, dict[str, type]] = {
    "candlescope.app.ready/1": {"hostVersion": str},
    "candlescope.app.stopping/1": {"reason": str},
    "candlescope.plugin.enabled/1": {"pluginId": str},
    "candlescope.plugin.disabled/1": {"pluginId": str},
    "candlescope.chart.context-changed/1": {
        "chartId": str,
        "revision": int,
        "active": bool,
    },
}

_COMMON_SCHEMA_KEYS = frozenset({"type", "enum", "title", "description", "default"})
_TYPE_SCHEMA_KEYS = {
    "object": frozenset({"properties", "required", "additionalProperties"}),
    "array": frozenset({"items", "minItems", "maxItems"}),
    "string": frozenset({"minLength", "maxLength"}),
    "number": frozenset({"minimum", "maximum"}),
    "integer": frozenset({"minimum", "maximum"}),
    "boolean": frozenset(),
    "null": frozenset(),
}
_SAFE_SCHEMA_KEYS = frozenset().union(_COMMON_SCHEMA_KEYS, *_TYPE_SCHEMA_KEYS.values())
_SCHEMA_TYPES = frozenset(
    {"object", "array", "string", "number", "integer", "boolean", "null"}
)
_CHANNELS = frozenset({"toast"})
_SEVERITIES = frozenset({"info", "success", "warning", "error"})
_COMMAND_PLACEMENTS = frozenset({"commandPalette", "topToolbar", "chartContextMenu"})
_VIEW_SLOTS = frozenset({"sidePanel", "bottomPanel", "statusArea"})
_VIEW_RENDERERS = frozenset({"table", "list", "detail", "status"})
_SANDBOX_VIEW_SLOTS = frozenset({"sidePanel", "bottomPanel"})
_SANDBOX_FRONTEND_SLOTS = {
    "sidePanel": "side-panel",
    "bottomPanel": "bottom-panel",
}
_VIEW_FORMATS = frozenset(
    {"text", "number", "percent", "price", "boolean", "timestamp"}
)
_VIEW_FIELD = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_LOCALE_ID = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")
_DOMAIN = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$")
_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
_HTTP_METHODS = frozenset({"GET", "POST"})
_EXCHANGE_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_MARKET_TYPE_ID = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_INTERVAL_ID = re.compile(r"^[1-9][0-9]{0,5}[smhdwM]$")
_PROVIDER_DATA_PLANE = "candlescope.stream/1"
_PROVIDER_CHANNEL_KINDS = frozenset({"kline", "full_depth"})
_PROVIDER_QUALITY_LEVELS = frozenset(
    {"authoritative", "verified", "best-effort", "synthetic"}
)
_PAPER_PROTOCOL = "candlescope.paper/1"
_PAPER_ORDER_TYPES = frozenset({"market", "limit"})
_PAPER_BROKER_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_PAPER_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PAPER_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9._:-]{0,63}$")
_PAPER_ASSET = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,31}$")
_PAPER_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


def _fail(message: str, *, plugin_id: str, contribution_id: str) -> None:
    raise core_error(
        "PLUGIN_CORE_CONTRIBUTION_INVALID",
        message,
        plugin_id=plugin_id,
        details={"contributionId": contribution_id},
    )


def _exact_keys(
    value: dict[str, Any],
    *,
    allowed: set[str] | frozenset[str],
    required: set[str] | frozenset[str] = frozenset(),
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> None:
    missing = sorted(set(required) - set(value))
    unknown = sorted(set(value) - set(allowed))
    if missing or unknown:
        _fail(
            f"{label} has an invalid shape"
            + (f"; missing={missing}" if missing else "")
            + (f"; unknown={unknown}" if unknown else ""),
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )


def _bounded_int(
    value: Any,
    *,
    minimum: int,
    maximum: int,
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        _fail(
            f"{label} must be an integer from {minimum} to {maximum}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return value


def _bounded_number(
    value: Any,
    *,
    minimum: float,
    maximum: float,
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= float(value) <= maximum
    ):
        _fail(
            f"{label} must be a finite number from {minimum} to {maximum}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return float(value)


def _paper_decimal(
    value: Any,
    *,
    label: str,
    plugin_id: str,
    contribution_id: str,
    positive: bool = False,
) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 128
        or _PAPER_DECIMAL.fullmatch(value) is None
    ):
        _fail(
            f"{label} must be a canonical decimal string",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        _fail(
            f"{label} must be a finite decimal",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    normalized = format(parsed, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized != value or (positive and parsed <= 0):
        _fail(
            f"{label} is not a canonical bounded decimal",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return value


def validate_settings_schema(
    schema: dict[str, Any],
    *,
    plugin_id: str,
    contribution_id: str,
    depth: int = 0,
) -> dict[str, Any]:
    """Validate the bounded JSON Schema subset rendered by native settings UI."""

    if depth > 8 or not isinstance(schema, dict):
        _fail(
            "settings schema must be an object with depth at most 8",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        schema,
        allowed=_SAFE_SCHEMA_KEYS,
        required={"type"},
        label="settings schema",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    schema_type = schema.get("type")
    if schema_type not in _SCHEMA_TYPES:
        _fail(
            "settings schema type is unsupported",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        schema,
        allowed=_COMMON_SCHEMA_KEYS | _TYPE_SCHEMA_KEYS[schema_type],
        required={"type"},
        label=f"{schema_type} settings schema",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if "title" in schema and (
        not isinstance(schema["title"], str) or len(schema["title"]) > 128
    ):
        _fail(
            "settings schema title is invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if "description" in schema and (
        not isinstance(schema["description"], str) or len(schema["description"]) > 512
    ):
        _fail(
            "settings schema description is invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if "enum" in schema:
        enum = schema["enum"]
        if not isinstance(enum, list) or not 1 <= len(enum) <= 64:
            _fail(
                "settings schema enum is invalid",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        normalized = [
            normalize_json(item, path="settings.schema.enum") for item in enum
        ]
        if len({canonical_dumps(item) for item in normalized}) != len(normalized):
            _fail(
                "settings schema enum contains duplicates",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    if schema_type == "object":
        properties = schema.get("properties", {})
        if not isinstance(properties, dict) or len(properties) > 64:
            _fail(
                "settings schema properties must be a bounded object",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        if schema.get("additionalProperties", False) is not False:
            _fail(
                "settings schema must set additionalProperties to false",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        for key, child in properties.items():
            if not isinstance(key, str) or not re.fullmatch(
                r"[A-Za-z][A-Za-z0-9_.-]{0,63}", key
            ):
                _fail(
                    "settings property name is invalid",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                )
            validate_settings_schema(
                child,
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                depth=depth + 1,
            )
        required = schema.get("required", [])
        if (
            not isinstance(required, list)
            or not all(isinstance(item, str) for item in required)
            or len(set(required)) != len(required)
            or not set(required) <= set(properties)
        ):
            _fail(
                "settings schema required list is invalid",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    elif schema_type == "array":
        if "items" not in schema:
            _fail(
                "array settings require items",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        validate_settings_schema(
            schema["items"],
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            depth=depth + 1,
        )
        for key in ("minItems", "maxItems"):
            if key in schema:
                _bounded_int(
                    schema[key],
                    minimum=0,
                    maximum=256,
                    label=f"settings schema {key}",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                )
        if schema.get("minItems", 0) > schema.get("maxItems", 256):
            _fail(
                "settings schema minItems exceeds maxItems",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    elif schema_type == "string":
        for key in ("minLength", "maxLength"):
            if key in schema:
                _bounded_int(
                    schema[key],
                    minimum=0,
                    maximum=16_384,
                    label=f"settings schema {key}",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                )
        if schema.get("minLength", 0) > schema.get("maxLength", 16_384):
            _fail(
                "settings schema minLength exceeds maxLength",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    elif schema_type in {"number", "integer"}:
        for key in ("minimum", "maximum"):
            if key in schema:
                _bounded_number(
                    schema[key],
                    minimum=-1e15,
                    maximum=1e15,
                    label=f"settings schema {key}",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                )
        if schema.get("minimum", -1e15) > schema.get("maximum", 1e15):
            _fail(
                "settings schema minimum exceeds maximum",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    normalized = normalize_json(schema, path="settings.schema")
    assert isinstance(normalized, dict)
    for item in normalized.get("enum", []):
        validate_settings_value(
            normalized,
            item,
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            path="settings.schema.enum[]",
        )
    if "default" in normalized:
        validate_settings_value(
            normalized,
            normalized["default"],
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return normalized


def validate_settings_value(
    schema: dict[str, Any],
    value: Any,
    *,
    plugin_id: str,
    contribution_id: str,
    path: str = "settings",
) -> Any:
    value = normalize_json(value, path=path)
    schema_type = schema["type"]
    valid_type = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "number": lambda item: (
            not isinstance(item, bool) and isinstance(item, (int, float))
        ),
        "integer": lambda item: not isinstance(item, bool) and isinstance(item, int),
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }[schema_type]
    if not valid_type(value):
        _fail(
            f"{path} does not match schema type {schema_type}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if "enum" in schema and value not in schema["enum"]:
        _fail(
            f"{path} is outside the schema enum",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if schema_type == "object":
        assert isinstance(value, dict)
        properties = schema.get("properties", {})
        unknown = sorted(set(value) - set(properties))
        missing = sorted(set(schema.get("required", [])) - set(value))
        if unknown or missing:
            _fail(
                f"{path} has invalid fields; missing={missing}, unknown={unknown}",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        return {
            key: validate_settings_value(
                properties[key],
                item,
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                path=f"{path}.{key}",
            )
            for key, item in value.items()
        }
    if schema_type == "array":
        assert isinstance(value, list)
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 256):
            _fail(
                f"{path} length is outside schema bounds",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        return [
            validate_settings_value(
                schema["items"],
                item,
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                path=f"{path}[{index}]",
            )
            for index, item in enumerate(value)
        ]
    if schema_type == "string":
        assert isinstance(value, str)
        if (
            not schema.get("minLength", 0)
            <= len(value)
            <= schema.get("maxLength", 16_384)
        ):
            _fail(
                f"{path} length is outside schema bounds",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    if schema_type in {"number", "integer"}:
        assert isinstance(value, (int, float)) and not isinstance(value, bool)
        if not schema.get("minimum", -1e15) <= value <= schema.get("maximum", 1e15):
            _fail(
                f"{path} is outside schema bounds",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    return value


def _localized_text(
    value: Any,
    *,
    maximum: int,
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        _fail(
            f"{label} must be bounded non-blank text",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return value


def _validate_schema_localization(
    value: Any,
    schema: dict[str, Any],
    *,
    plugin_id: str,
    contribution_id: str,
    depth: int = 0,
) -> dict[str, Any]:
    if not isinstance(value, dict) or not value or depth > 8:
        _fail(
            "schema localization is invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        value,
        allowed={"title", "description", "enumLabels", "properties", "items"},
        label="schema localization",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    result: dict[str, Any] = {}
    if "title" in value:
        result["title"] = _localized_text(
            value["title"],
            maximum=256,
            label="localized schema title",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if "description" in value:
        result["description"] = _localized_text(
            value["description"],
            maximum=2_048,
            label="localized schema description",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if "enumLabels" in value:
        labels = value["enumLabels"]
        enum_values = schema.get("enum")
        if (
            not isinstance(labels, list)
            or not isinstance(enum_values, list)
            or not labels
            or len(labels) != len(enum_values)
            or len(labels) > 64
        ):
            _fail(
                "localized schema enum labels do not match the declared enum",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        result["enumLabels"] = [
            _localized_text(
                label,
                maximum=256,
                label="localized schema enum label",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
            for label in labels
        ]
    if "properties" in value:
        properties = value["properties"]
        schema_properties = schema.get("properties")
        if (
            not isinstance(properties, dict)
            or not properties
            or len(properties) > 128
            or not isinstance(schema_properties, dict)
            or not set(properties) <= set(schema_properties)
        ):
            _fail(
                "localized schema properties do not match the declared schema",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        result["properties"] = {
            name: _validate_schema_localization(
                localized,
                schema_properties[name],
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                depth=depth + 1,
            )
            for name, localized in properties.items()
        }
    if "items" in value:
        schema_items = schema.get("items")
        if not isinstance(schema_items, dict):
            _fail(
                "localized schema items require declared array items",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        result["items"] = _validate_schema_localization(
            value["items"],
            schema_items,
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            depth=depth + 1,
        )
    if not result:
        _fail(
            "schema localization must contain display text",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return result


def _localized_labels(
    value: Any,
    known_ids: set[str],
    *,
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> dict[str, str]:
    if (
        not isinstance(value, dict)
        or not value
        or len(value) > 64
        or not set(value) <= known_ids
    ):
        _fail(
            f"{label} localization does not match declared ids",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return {
        key: _localized_text(
            text,
            maximum=256,
            label=label,
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
        for key, text in value.items()
    }


def _validate_contribution_localizations(
    plugin_id: str,
    item: Contribution,
    config: dict[str, Any],
) -> dict[str, Any]:
    embedded_declared = "localizations" in item.configuration
    embedded = item.configuration.get("localizations")
    if item.localizations and embedded_declared:
        _fail(
            "contribution localizations must use exactly one manifest location",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    raw = item.localizations if item.localizations else embedded
    if not raw:
        return {}
    if not isinstance(raw, dict) or len(raw) > 16 or any(
        not isinstance(locale, str) or _LOCALE_ID.fullmatch(locale) is None
        for locale in raw
    ) or len({locale.lower() for locale in raw}) != len(raw):
        _fail(
            "contribution localization locales are invalid",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    result: dict[str, Any] = {}
    for locale, candidate in raw.items():
        if not isinstance(candidate, dict) or not candidate:
            _fail(
                "contribution localization must be a non-empty object",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        allowed = {"title"}
        schema: dict[str, Any] | None = None
        if item.kind == "command/1" and isinstance(config.get("inputSchema"), dict):
            allowed.add("schema")
            schema = config["inputSchema"]
        elif item.kind == "settings/1":
            allowed.add("schema")
            schema = config["schema"]
        elif item.kind == "view/1" and config.get("renderer") != "sandbox":
            allowed.update({"fields", "emptyState"})
        elif item.kind == "symbol-provider/1":
            allowed.update({"displayName", "marketTypes"})
        elif item.kind == "account-provider/1":
            allowed.add("accounts")
        _exact_keys(
            candidate,
            allowed=allowed,
            label="contribution localization",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        localized: dict[str, Any] = {}
        if "title" in candidate:
            localized["title"] = _localized_text(
                candidate["title"],
                maximum=256,
                label="localized contribution title",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "schema" in candidate:
            if schema is None:
                _fail(
                    "schema localization requires a declared UI schema",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            localized["schema"] = _validate_schema_localization(
                candidate["schema"],
                schema,
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "fields" in candidate:
            localized["fields"] = _localized_labels(
                candidate["fields"],
                {field["field"] for field in config["fields"]},
                label="view field",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "emptyState" in candidate:
            localized["emptyState"] = _localized_text(
                candidate["emptyState"],
                maximum=256,
                label="localized empty state",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "displayName" in candidate:
            localized["displayName"] = _localized_text(
                candidate["displayName"],
                maximum=128,
                label="localized provider display name",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "marketTypes" in candidate:
            localized["marketTypes"] = _localized_labels(
                candidate["marketTypes"],
                {market["id"] for market in config["marketTypes"]},
                label="market type",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "accounts" in candidate:
            localized["accounts"] = _localized_labels(
                candidate["accounts"],
                {account["id"] for account in config["accounts"]},
                label="paper account",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if not localized:
            _fail(
                "contribution localization must contain display text",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        result[locale] = localized
    normalized = normalize_json(result, path="contribution.localizations")
    assert isinstance(normalized, dict)
    return normalized


@dataclass(frozen=True, slots=True)
class CoreContribution:
    plugin_id: str
    id: str
    full_id: str
    kind: str
    title: str
    entrypoint_id: str
    configuration: dict[str, Any]
    localizations: dict[str, Any] = field(default_factory=dict)

    def to_catalog(self) -> dict[str, Any]:
        return {
            "id": self.full_id,
            "localId": self.id,
            "kind": self.kind,
            "title": self.title,
            "entrypointId": self.entrypoint_id,
            "configuration": dict(self.configuration),
            **({"localizations": dict(self.localizations)} if self.localizations else {}),
        }


def _validate_file_inputs(
    value: Any,
    schema: dict[str, Any] | None,
    *,
    plugin_id: str,
    contribution_id: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 8 or schema is None:
        _fail(
            "command fileInputs require a bounded inputSchema",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    properties = schema.get("properties", {})
    required_fields = set(schema.get("required", []))
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            _fail(
                "command file input must be an object",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        _exact_keys(
            item,
            allowed={"field", "mode", "accept", "maxBytes", "suggestedName"},
            required={"field", "mode", "accept", "maxBytes"},
            label="command file input",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
        field_name = item["field"]
        mode = item["mode"]
        accept = item["accept"]
        suggested_name = item.get("suggestedName")
        field_schema = (
            properties.get(field_name) if isinstance(field_name, str) else None
        )
        if (
            not isinstance(field_name, str)
            or _VIEW_FIELD.fullmatch(field_name) is None
            or field_name not in required_fields
            or not isinstance(field_schema, dict)
            or field_schema.get("type") != "string"
            or mode not in {"open", "save"}
            or not isinstance(accept, list)
            or not 1 <= len(accept) <= 16
            or len(set(accept)) != len(accept)
            or not all(
                isinstance(media_type, str)
                and media_type == media_type.lower()
                and _MEDIA_TYPE.fullmatch(media_type)
                for media_type in accept
            )
            or (mode == "open" and suggested_name is not None)
            or (
                mode == "save"
                and (
                    not isinstance(suggested_name, str)
                    or _FILE_NAME.fullmatch(suggested_name) is None
                    or suggested_name in {".", ".."}
                )
            )
        ):
            _fail(
                "command file input metadata is invalid",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        result.append(
            {
                "field": field_name,
                "mode": mode,
                "accept": list(accept),
                "maxBytes": _bounded_int(
                    item["maxBytes"],
                    minimum=1,
                    maximum=128 * 1024,
                    label="file input maxBytes",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                ),
                **(
                    {"suggestedName": suggested_name}
                    if suggested_name is not None
                    else {}
                ),
            }
        )
    if len({item["field"] for item in result}) != len(result):
        _fail(
            "command fileInputs contain duplicate fields",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if sum(item["mode"] == "save" for item in result) > 1:
        _fail(
            "Phase 9 commands support at most one save destination",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return result


def _provider_string(
    value: Any,
    *,
    label: str,
    plugin_id: str,
    contribution_id: str,
    maximum: int = 128,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        _fail(
            f"{label} must be a bounded canonical string",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return value


def _provider_string_list(
    value: Any,
    *,
    label: str,
    plugin_id: str,
    contribution_id: str,
    minimum: int,
    maximum: int,
    pattern: re.Pattern[str] | None = None,
) -> list[str]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail(
            f"{label} must contain {minimum} to {maximum} unique strings",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    result = [
        _provider_string(
            item,
            label=label,
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            maximum=64,
            pattern=pattern,
        )
        for item in value
    ]
    if len(set(result)) != len(result):
        _fail(
            f"{label} must contain {minimum} to {maximum} unique strings",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return result


def _validate_symbol_provider_configuration(
    config: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> dict[str, Any]:
    _exact_keys(
        config,
        allowed={
            "exchange",
            "displayName",
            "marketTypes",
            "maxPageSize",
            "cacheTtlSeconds",
        },
        required={
            "exchange",
            "displayName",
            "marketTypes",
            "maxPageSize",
            "cacheTtlSeconds",
        },
        label="symbol provider configuration",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    exchange = _provider_string(
        config["exchange"],
        label="provider exchange",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=64,
        pattern=_EXCHANGE_ID,
    )
    display_name = _provider_string(
        config["displayName"],
        label="provider displayName",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=128,
    )
    raw_markets = config["marketTypes"]
    if not isinstance(raw_markets, list) or not 1 <= len(raw_markets) <= 16:
        _fail(
            "provider marketTypes must contain 1 to 16 entries",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    markets: list[dict[str, str]] = []
    for raw in raw_markets:
        if not isinstance(raw, dict):
            _fail(
                "provider market type must be an object",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        _exact_keys(
            raw,
            allowed={"id", "productType", "label", "calendarId", "timezone"},
            required={"id", "productType", "label", "calendarId", "timezone"},
            label="provider market type",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
        markets.append(
            {
                key: _provider_string(
                    raw[key],
                    label=f"provider market type {key}",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                    maximum=64,
                    pattern=_MARKET_TYPE_ID if key == "id" else None,
                )
                for key in ("id", "productType", "label", "calendarId", "timezone")
            }
        )
    if len({item["id"] for item in markets}) != len(markets):
        _fail(
            "provider marketTypes contain duplicate ids",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return {
        "exchange": exchange,
        "displayName": display_name,
        "marketTypes": markets,
        "maxPageSize": _bounded_int(
            config["maxPageSize"],
            minimum=1,
            maximum=500,
            label="provider maxPageSize",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        ),
        "cacheTtlSeconds": _bounded_int(
            config["cacheTtlSeconds"],
            minimum=1,
            maximum=86_400,
            label="provider cacheTtlSeconds",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        ),
    }


def _validate_market_provider_channel(
    value: Any, *, plugin_id: str, contribution_id: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(
            "market-data provider channel must be an object",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        value,
        allowed={
            "kind",
            "marketTypes",
            "history",
            "realtime",
            "intervals",
            "delivery",
            "finality",
            "corrections",
            "snapshot",
            "delta",
            "sequence",
            "resync",
            "maxDepthLevels",
            "maxPageSize",
            "maxBatch",
            "pollIntervalMs",
            "ratePerMinute",
            "maxConcurrent",
        },
        required={
            "kind",
            "marketTypes",
            "history",
            "realtime",
            "intervals",
            "delivery",
            "finality",
            "corrections",
            "maxPageSize",
            "maxBatch",
            "pollIntervalMs",
            "ratePerMinute",
            "maxConcurrent",
        },
        label="market-data provider channel",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    kind = _provider_string(
        value["kind"],
        label="market-data provider channel kind",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=32,
    )
    if kind not in _PROVIDER_CHANNEL_KINDS:
        _fail(
            "market-data provider channel kind is unsupported",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    for key in ("history", "realtime", "corrections"):
        if not isinstance(value[key], bool):
            _fail(
                f"market-data provider channel {key} must be boolean",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    if not value["history"] and not value["realtime"]:
        _fail(
            "market-data provider channel must support history or realtime",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    market_types = _provider_string_list(
        value["marketTypes"],
        label="market-data provider marketTypes",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        minimum=1,
        maximum=16,
        pattern=_MARKET_TYPE_ID,
    )
    intervals = _provider_string_list(
        value["intervals"],
        label="market-data provider intervals",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        minimum=1 if kind == "kline" else 0,
        maximum=64 if kind == "kline" else 0,
        pattern=_INTERVAL_ID,
    )
    if kind == "kline":
        if value["delivery"] != "append" or value["finality"] not in {
            "explicit",
            "inferred",
        }:
            _fail(
                "kline providers require append delivery and declared finality",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        if any(
            key in value
            for key in ("snapshot", "delta", "sequence", "resync", "maxDepthLevels")
        ):
            _fail(
                "kline providers contain full-depth-only fields",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    else:
        if value["history"] is not False or value["corrections"] is not False:
            _fail(
                "Phase 10 full-depth providers are realtime-only and not correctable",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        if not all(isinstance(value.get(key), bool) for key in ("snapshot", "delta")):
            _fail(
                "full-depth snapshot and delta flags must be boolean",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        if (
            value["delivery"] != "ordered_delta"
            or value["finality"] != "explicit"
            or value["snapshot"] is not True
            or value["delta"] is not True
            or value.get("sequence") != "range"
            or value.get("resync") != "snapshot_replay"
        ):
            _fail(
                "full-depth providers require snapshot, ordered linked deltas, and snapshot replay",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    result = {
        "kind": kind,
        "marketTypes": market_types,
        "history": value["history"],
        "realtime": value["realtime"],
        "intervals": intervals,
        "delivery": value["delivery"],
        "finality": value["finality"],
        "corrections": value["corrections"],
    }
    for key, minimum, maximum in (
        ("maxPageSize", 1, 5_000),
        ("maxBatch", 1, 256),
        ("pollIntervalMs", 10, 60_000),
        ("ratePerMinute", 1, 60_000),
        ("maxConcurrent", 1, 32),
    ):
        result[key] = _bounded_int(
            value[key],
            minimum=minimum,
            maximum=maximum,
            label=f"market-data provider {key}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if kind == "full_depth":
        result.update(
            {
                "snapshot": value["snapshot"],
                "delta": value["delta"],
                "sequence": value["sequence"],
                "resync": value["resync"],
                "maxDepthLevels": _bounded_int(
                    value.get("maxDepthLevels"),
                    minimum=1,
                    maximum=5_000,
                    label="market-data provider maxDepthLevels",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                ),
            }
        )
    return result


def _validate_market_provider_configuration(
    config: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> dict[str, Any]:
    _exact_keys(
        config,
        allowed={"exchange", "dataPlane", "channels", "sourceQuality"},
        required={"exchange", "dataPlane", "channels", "sourceQuality"},
        label="market-data provider configuration",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    exchange = _provider_string(
        config["exchange"],
        label="provider exchange",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=64,
        pattern=_EXCHANGE_ID,
    )
    if config["dataPlane"] != _PROVIDER_DATA_PLANE:
        _fail(
            "market-data provider dataPlane is unsupported",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    raw_channels = config["channels"]
    if not isinstance(raw_channels, list) or not 1 <= len(raw_channels) <= 16:
        _fail(
            "market-data provider channels must contain 1 to 16 entries",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    channels = [
        _validate_market_provider_channel(
            raw, plugin_id=plugin_id, contribution_id=contribution_id
        )
        for raw in raw_channels
    ]
    channel_keys = [
        (item["kind"], market_type)
        for item in channels
        for market_type in item["marketTypes"]
    ]
    if len(set(channel_keys)) != len(channel_keys):
        _fail(
            "market-data provider channels overlap by kind and market type",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    quality = config["sourceQuality"]
    if not isinstance(quality, dict):
        _fail(
            "market-data provider sourceQuality must be an object",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        quality,
        allowed={"quality", "finality", "timestamp"},
        required={"quality", "finality", "timestamp"},
        label="market-data provider sourceQuality",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    normalized_quality = {
        key: _provider_string(
            quality[key],
            label=f"market-data provider sourceQuality {key}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            maximum=32,
        )
        for key in ("quality", "finality", "timestamp")
    }
    if (
        normalized_quality["quality"] not in _PROVIDER_QUALITY_LEVELS
        or normalized_quality["finality"] not in {"explicit", "inferred"}
        or normalized_quality["timestamp"] not in {"exchange", "provider", "host"}
    ):
        _fail(
            "market-data provider sourceQuality is unsupported",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return {
        "exchange": exchange,
        "dataPlane": _PROVIDER_DATA_PLANE,
        "channels": channels,
        "sourceQuality": normalized_quality,
    }


def _validate_paper_account_configuration(
    config: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> dict[str, Any]:
    _exact_keys(
        config,
        allowed={"brokerId", "displayName", "environment", "accounts"},
        required={"brokerId", "displayName", "environment", "accounts"},
        label="paper account provider configuration",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if config["environment"] != "paper":
        _fail(
            "Phase 11A account providers must declare the paper environment",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    broker_id = _provider_string(
        config["brokerId"],
        label="paper brokerId",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=64,
        pattern=_PAPER_BROKER_ID,
    )
    display_name = _provider_string(
        config["displayName"],
        label="paper displayName",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=128,
    )
    raw_accounts = config["accounts"]
    if not isinstance(raw_accounts, list) or not 1 <= len(raw_accounts) <= 16:
        _fail(
            "paper accounts must contain 1 to 16 entries",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    accounts: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_accounts):
        if not isinstance(raw, dict):
            _fail(
                "paper account must be an object",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        _exact_keys(
            raw,
            allowed={"id", "label", "baseCurrency", "initialBalances"},
            required={"id", "label", "baseCurrency", "initialBalances"},
            label="paper account",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
        balances = raw["initialBalances"]
        if not isinstance(balances, list) or not 1 <= len(balances) <= 32:
            _fail(
                "paper initialBalances must contain 1 to 32 entries",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        normalized_balances: list[dict[str, str]] = []
        for balance in balances:
            if not isinstance(balance, dict):
                _fail(
                    "paper initial balance must be an object",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                )
            _exact_keys(
                balance,
                allowed={"asset", "available"},
                required={"asset", "available"},
                label="paper initial balance",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
            normalized_balances.append(
                {
                    "asset": _provider_string(
                        balance["asset"],
                        label="paper balance asset",
                        plugin_id=plugin_id,
                        contribution_id=contribution_id,
                        maximum=32,
                        pattern=_PAPER_ASSET,
                    ),
                    "available": _paper_decimal(
                        balance["available"],
                        label="paper balance available",
                        plugin_id=plugin_id,
                        contribution_id=contribution_id,
                    ),
                }
            )
        if len({item["asset"] for item in normalized_balances}) != len(
            normalized_balances
        ):
            _fail(
                "paper initial balances contain duplicate assets",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        base_currency = _provider_string(
            raw["baseCurrency"],
            label="paper account baseCurrency",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            maximum=32,
            pattern=_PAPER_ASSET,
        )
        if base_currency not in {item["asset"] for item in normalized_balances}:
            _fail(
                "paper baseCurrency requires an initial balance",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        accounts.append(
            {
                "id": _provider_string(
                    raw["id"],
                    label="paper account id",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                    maximum=128,
                    pattern=_PAPER_ACCOUNT_ID,
                ),
                "label": _provider_string(
                    raw["label"],
                    label="paper account label",
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                    maximum=128,
                ),
                "baseCurrency": base_currency,
                "initialBalances": normalized_balances,
            }
        )
    if len({item["id"] for item in accounts}) != len(accounts):
        _fail(
            "paper accounts contain duplicate ids",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return {
        "brokerId": broker_id,
        "displayName": display_name,
        "environment": "paper",
        "accounts": accounts,
    }


def _validate_paper_executor_configuration(
    config: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> dict[str, Any]:
    _exact_keys(
        config,
        allowed={
            "brokerId",
            "environment",
            "protocol",
            "orderTypes",
            "symbols",
            "limits",
            "maxQuoteAgeMs",
        },
        required={
            "brokerId",
            "environment",
            "protocol",
            "orderTypes",
            "symbols",
            "limits",
            "maxQuoteAgeMs",
        },
        label="paper order executor configuration",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if config["environment"] != "paper" or config["protocol"] != _PAPER_PROTOCOL:
        _fail(
            "Phase 11A executors require the paper/1 protocol",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    broker_id = _provider_string(
        config["brokerId"],
        label="paper brokerId",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        maximum=64,
        pattern=_PAPER_BROKER_ID,
    )
    order_types = _provider_string_list(
        config["orderTypes"],
        label="paper orderTypes",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        minimum=1,
        maximum=len(_PAPER_ORDER_TYPES),
    )
    if not set(order_types) <= _PAPER_ORDER_TYPES:
        _fail(
            "paper orderTypes are unsupported",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    raw_symbols = config["symbols"]
    if not isinstance(raw_symbols, list) or not 1 <= len(raw_symbols) <= 128:
        _fail(
            "paper symbols must contain 1 to 128 entries",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    symbols: list[dict[str, str]] = []
    symbol_keys = {
        "symbol",
        "marketType",
        "baseAsset",
        "quoteAsset",
        "priceTick",
        "quantityStep",
        "minQuantity",
        "maxQuantity",
        "minNotional",
        "maxNotional",
    }
    for raw in raw_symbols:
        if not isinstance(raw, dict):
            _fail(
                "paper symbol must be an object",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        _exact_keys(
            raw,
            allowed=symbol_keys,
            required=symbol_keys,
            label="paper symbol",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
        item = {
            "symbol": _provider_string(
                raw["symbol"],
                label="paper symbol",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                maximum=64,
                pattern=_PAPER_SYMBOL,
            ),
            "marketType": _provider_string(
                raw["marketType"],
                label="paper marketType",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                maximum=32,
                pattern=_MARKET_TYPE_ID,
            ),
            "baseAsset": _provider_string(
                raw["baseAsset"],
                label="paper baseAsset",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                maximum=32,
                pattern=_PAPER_ASSET,
            ),
            "quoteAsset": _provider_string(
                raw["quoteAsset"],
                label="paper quoteAsset",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                maximum=32,
                pattern=_PAPER_ASSET,
            ),
        }
        for name in (
            "priceTick",
            "quantityStep",
            "minQuantity",
            "maxQuantity",
            "minNotional",
            "maxNotional",
        ):
            item[name] = _paper_decimal(
                raw[name],
                label=f"paper symbol {name}",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                positive=True,
            )
        if (
            Decimal(item["minQuantity"]) > Decimal(item["maxQuantity"])
            or Decimal(item["minNotional"]) > Decimal(item["maxNotional"])
            or item["baseAsset"] == item["quoteAsset"]
        ):
            _fail(
                "paper symbol bounds are inconsistent",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
        symbols.append(item)
    if len({(item["symbol"], item["marketType"]) for item in symbols}) != len(symbols):
        _fail(
            "paper symbols contain duplicate market keys",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    limits = config["limits"]
    limit_keys = {
        "maxOrderQuantity",
        "maxOrderNotional",
        "maxPositionNotional",
        "maxOpenOrders",
        "maxOrdersPerMinute",
        "allowShort",
    }
    if not isinstance(limits, dict):
        _fail(
            "paper limits must be an object",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _exact_keys(
        limits,
        allowed=limit_keys,
        required=limit_keys,
        label="paper limits",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if not isinstance(limits["allowShort"], bool):
        _fail(
            "paper allowShort must be boolean",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    if limits["allowShort"]:
        _fail(
            "Phase 11A does not permit short selling",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    normalized_limits = {
        key: _paper_decimal(
            limits[key],
            label=f"paper limits {key}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
            positive=True,
        )
        for key in ("maxOrderQuantity", "maxOrderNotional", "maxPositionNotional")
    }
    normalized_limits.update(
        {
            "maxOpenOrders": _bounded_int(
                limits["maxOpenOrders"],
                minimum=1,
                maximum=1024,
                label="paper maxOpenOrders",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            ),
            "maxOrdersPerMinute": _bounded_int(
                limits["maxOrdersPerMinute"],
                minimum=1,
                maximum=10_000,
                label="paper maxOrdersPerMinute",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            ),
            "allowShort": limits["allowShort"],
        }
    )
    if any(
        Decimal(item["maxQuantity"]) > Decimal(normalized_limits["maxOrderQuantity"])
        or Decimal(item["maxNotional"]) > Decimal(normalized_limits["maxOrderNotional"])
        for item in symbols
    ):
        _fail(
            "paper symbol bounds exceed executor limits",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return {
        "brokerId": broker_id,
        "environment": "paper",
        "protocol": _PAPER_PROTOCOL,
        "orderTypes": order_types,
        "symbols": symbols,
        "limits": normalized_limits,
        "maxQuoteAgeMs": _bounded_int(
            config["maxQuoteAgeMs"],
            minimum=100,
            maximum=60_000,
            label="paper maxQuoteAgeMs",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        ),
    }


def _validate_core_configuration(plugin_id: str, item: Contribution) -> dict[str, Any]:
    config = dict(item.configuration)
    config.pop("localizations", None)
    if item.kind == "symbol-provider/1":
        config = _validate_symbol_provider_configuration(
            config,
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    elif item.kind == "market-data-provider/1":
        config = _validate_market_provider_configuration(
            config,
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    elif item.kind == "account-provider/1":
        config = _validate_paper_account_configuration(
            config,
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    elif item.kind == "order-executor/1":
        config = _validate_paper_executor_configuration(
            config,
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
    elif item.kind == "command/1":
        _exact_keys(
            config,
            allowed={"requiresUserAction", "inputSchema", "placements", "fileInputs"},
            label="command configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        if "requiresUserAction" in config and not isinstance(
            config["requiresUserAction"], bool
        ):
            _fail(
                "requiresUserAction must be boolean",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if "inputSchema" in config:
            config["inputSchema"] = validate_settings_schema(
                config["inputSchema"], plugin_id=plugin_id, contribution_id=item.id
            )
            if config["inputSchema"]["type"] != "object":
                _fail(
                    "command input schema root must be object",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
        if "fileInputs" in config:
            if config.get("requiresUserAction", True) is not True:
                _fail(
                    "commands with fileInputs must require a user action",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            config["fileInputs"] = _validate_file_inputs(
                config["fileInputs"],
                config.get("inputSchema"),
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        placements = config.get("placements", ["commandPalette"])
        if (
            not isinstance(placements, list)
            or not placements
            or len(placements) > len(_COMMAND_PLACEMENTS)
            or not all(isinstance(value, str) for value in placements)
            or len(set(placements)) != len(placements)
            or not set(placements) <= _COMMAND_PLACEMENTS
        ):
            _fail(
                "command placements are invalid",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config["placements"] = placements
    elif item.kind == "settings/1":
        _exact_keys(
            config,
            allowed={"schema", "defaults"},
            required={"schema"},
            label="settings configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        schema = validate_settings_schema(
            config["schema"], plugin_id=plugin_id, contribution_id=item.id
        )
        if schema["type"] != "object":
            _fail(
                "settings contribution root schema must be object",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        defaults = validate_settings_value(
            schema,
            config.get("defaults", {}),
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        config = {"schema": schema, "defaults": defaults}
    elif item.kind == "notification/1":
        _exact_keys(
            config,
            allowed={"channels", "severities"},
            label="notification configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        channels = config.get("channels", ["toast"])
        severities = config.get("severities", ["info", "success", "warning", "error"])
        if (
            not isinstance(channels, list)
            or not channels
            or len(set(channels)) != len(channels)
            or not set(channels) <= _CHANNELS
            or not isinstance(severities, list)
            or not severities
            or len(set(severities)) != len(severities)
            or not set(severities) <= _SEVERITIES
        ):
            _fail(
                "notification channels or severities are invalid",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {"channels": channels, "severities": severities}
    elif item.kind == "event-subscriber/1":
        _exact_keys(
            config,
            allowed={"events", "queueCapacity", "maxBatch", "maxLatencyMs"},
            required={"events"},
            label="event subscriber configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        events = config["events"]
        if (
            not isinstance(events, list)
            or not events
            or not all(isinstance(event, str) for event in events)
            or len(set(events)) != len(events)
            or not set(events) <= set(PUBLIC_EVENT_SCHEMAS)
        ):
            _fail(
                "event subscriber requests unsupported public events",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {
            "events": events,
            "queueCapacity": _bounded_int(
                config.get("queueCapacity", 64),
                minimum=1,
                maximum=1024,
                label="queueCapacity",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxBatch": _bounded_int(
                config.get("maxBatch", 16),
                minimum=1,
                maximum=64,
                label="maxBatch",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxLatencyMs": _bounded_int(
                config.get("maxLatencyMs", 50),
                minimum=1,
                maximum=1000,
                label="maxLatencyMs",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
        }
    elif item.kind == "job/1":
        _exact_keys(
            config,
            allowed={
                "schedule",
                "timeoutSeconds",
                "maxAttempts",
                "backoffSeconds",
                "runOnStartup",
            },
            label="job configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        schedule = config.get("schedule")
        if schedule is not None:
            if not isinstance(schedule, dict):
                _fail(
                    "job schedule must be an object",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            _exact_keys(
                schedule,
                allowed={"intervalSeconds"},
                required={"intervalSeconds"},
                label="job schedule",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
            schedule = {
                "intervalSeconds": _bounded_number(
                    schedule["intervalSeconds"],
                    minimum=1.0,
                    maximum=86_400.0,
                    label="intervalSeconds",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            }
        if "runOnStartup" in config and not isinstance(config["runOnStartup"], bool):
            _fail(
                "runOnStartup must be boolean",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {
            **({"schedule": schedule} if schedule is not None else {}),
            "timeoutSeconds": _bounded_number(
                config.get("timeoutSeconds", 30.0),
                minimum=0.1,
                maximum=300.0,
                label="timeoutSeconds",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxAttempts": _bounded_int(
                config.get("maxAttempts", 3),
                minimum=1,
                maximum=10,
                label="maxAttempts",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "backoffSeconds": _bounded_number(
                config.get("backoffSeconds", 1.0),
                minimum=0.1,
                maximum=60.0,
                label="backoffSeconds",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "runOnStartup": config.get("runOnStartup", False),
        }
    elif item.kind == "http-endpoint/1":
        _exact_keys(
            config,
            allowed={
                "methods",
                "responseMode",
                "maxRequestBytes",
                "maxResponseBytes",
                "maxConcurrent",
                "ratePerMinute",
            },
            required={
                "methods",
                "responseMode",
                "maxRequestBytes",
                "maxResponseBytes",
                "maxConcurrent",
                "ratePerMinute",
            },
            label="HTTP endpoint configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        methods = config["methods"]
        if (
            not isinstance(methods, list)
            or not methods
            or len(set(methods)) != len(methods)
            or not all(isinstance(method, str) for method in methods)
            or not set(methods) <= _HTTP_METHODS
            or config["responseMode"] not in {"buffered", "server-events"}
        ):
            _fail(
                "HTTP endpoint methods or response mode are invalid",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {
            "methods": methods,
            "responseMode": config["responseMode"],
            "maxRequestBytes": _bounded_int(
                config["maxRequestBytes"],
                minimum=0,
                maximum=128 * 1024,
                label="HTTP endpoint maxRequestBytes",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxResponseBytes": _bounded_int(
                config["maxResponseBytes"],
                minimum=1,
                maximum=128 * 1024,
                label="HTTP endpoint maxResponseBytes",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxConcurrent": _bounded_int(
                config["maxConcurrent"],
                minimum=1,
                maximum=16,
                label="HTTP endpoint maxConcurrent",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "ratePerMinute": _bounded_int(
                config["ratePerMinute"],
                minimum=1,
                maximum=10_000,
                label="HTTP endpoint ratePerMinute",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
        }
    elif item.kind in {"chart-layer/1", "chart-layer/2"}:
        allowed = {"target", "zOrder", "maxItems", "maxBytes", "maxTextChars"}
        if item.kind == "chart-layer/2":
            allowed.add("maxPoints")
        _exact_keys(
            config,
            allowed=allowed,
            label="chart layer configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        target = config.get("target", "main-chart")
        z_order = config.get("zOrder", "above-series")
        max_points = config.get("maxPoints", 20_000)
        if target != "main-chart" or z_order not in {
            "above-series",
            "below-series",
        }:
            _fail(
                "chart layer target or zOrder is unsupported",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {
            "target": target,
            "zOrder": z_order,
            "maxItems": _bounded_int(
                config.get("maxItems", 500),
                minimum=1,
                maximum=5_000,
                label="maxItems",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxBytes": _bounded_int(
                config.get("maxBytes", 128 * 1024),
                minimum=1_024,
                maximum=1024 * 1024,
                label="maxBytes",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "maxTextChars": _bounded_int(
                config.get("maxTextChars", 128),
                minimum=1,
                maximum=1_024,
                label="maxTextChars",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
        }
        if item.kind == "chart-layer/2":
            config["maxPoints"] = _bounded_int(
                max_points,
                minimum=2,
                maximum=100_000,
                label="maxPoints",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
    elif item.kind == "view/1" and config.get("renderer") == "sandbox":
        _exact_keys(
            config,
            allowed={"slot", "renderer", "surface"},
            required={"slot", "renderer", "surface"},
            label="sandbox view configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        slot = config["slot"]
        surface = config["surface"]
        if (
            slot not in _SANDBOX_VIEW_SLOTS
            or config["renderer"] != "sandbox"
            or not isinstance(surface, str)
            or not _VIEW_FIELD.fullmatch(surface)
        ):
            _fail(
                "sandbox view slot or surface is unsupported",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {"slot": slot, "renderer": "sandbox", "surface": surface}
    elif item.kind == "view/1":
        _exact_keys(
            config,
            allowed={
                "slot",
                "renderer",
                "source",
                "fields",
                "maxItems",
                "emptyState",
                "primaryCommand",
            },
            required={"slot", "renderer", "source", "fields"},
            label="view configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        slot = config["slot"]
        renderer = config["renderer"]
        if slot not in _VIEW_SLOTS or renderer not in _VIEW_RENDERERS:
            _fail(
                "view slot or renderer is unsupported",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if slot == "statusArea" and renderer != "status":
            _fail(
                "statusArea views must use the status renderer",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        if slot != "statusArea" and renderer == "status":
            _fail(
                "status renderer is restricted to statusArea",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        source = config["source"]
        if not isinstance(source, dict):
            _fail(
                "view source must be an object",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        _exact_keys(
            source,
            allowed={"kind", "name", "path"},
            required={"kind", "name"},
            label="view source",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        source_path = source.get("path", [])
        if (
            source.get("kind") != "storage.document"
            or not isinstance(source.get("name"), str)
            or not _VIEW_FIELD.fullmatch(source["name"])
            or not isinstance(source_path, list)
            or len(source_path) > 8
            or not all(
                isinstance(value, str) and _VIEW_FIELD.fullmatch(value)
                for value in source_path
            )
        ):
            _fail(
                "view source is invalid",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        raw_fields = config["fields"]
        if not isinstance(raw_fields, list) or not 1 <= len(raw_fields) <= 16:
            _fail(
                "view fields must be a bounded array",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        fields: list[dict[str, str]] = []
        for raw_field in raw_fields:
            if not isinstance(raw_field, dict):
                _fail(
                    "view field must be an object",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            _exact_keys(
                raw_field,
                allowed={"field", "label", "format"},
                required={"field", "label"},
                label="view field",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
            field_name = raw_field["field"]
            label = raw_field["label"]
            field_format = raw_field.get("format", "text")
            if (
                not isinstance(field_name, str)
                or not _VIEW_FIELD.fullmatch(field_name)
                or not isinstance(label, str)
                or not label
                or label != label.strip()
                or len(label) > 128
                or field_format not in _VIEW_FORMATS
            ):
                _fail(
                    "view field metadata is invalid",
                    plugin_id=plugin_id,
                    contribution_id=item.id,
                )
            fields.append({"field": field_name, "label": label, "format": field_format})
        if len({value["field"] for value in fields}) != len(fields):
            _fail(
                "view fields contain duplicates",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        empty_state = config.get("emptyState", "No data")
        primary_command = config.get("primaryCommand")
        if (
            not isinstance(empty_state, str)
            or not empty_state
            or empty_state != empty_state.strip()
            or len(empty_state) > 256
            or (
                primary_command is not None
                and (
                    not isinstance(primary_command, str)
                    or not _VIEW_FIELD.fullmatch(primary_command)
                )
            )
        ):
            _fail(
                "view text or primary command is invalid",
                plugin_id=plugin_id,
                contribution_id=item.id,
            )
        config = {
            "slot": slot,
            "renderer": renderer,
            "source": {
                "kind": "storage.document",
                "name": source["name"],
                "path": source_path,
            },
            "fields": fields,
            "maxItems": _bounded_int(
                config.get("maxItems", 50),
                minimum=1,
                maximum=200,
                label="maxItems",
                plugin_id=plugin_id,
                contribution_id=item.id,
            ),
            "emptyState": empty_state,
            **(
                {"primaryCommand": primary_command}
                if primary_command is not None
                else {}
            ),
        }
    else:
        raise AssertionError(
            "core configuration validator received an unsupported kind"
        )
    normalized = normalize_json(config, path="contribution.configuration")
    assert isinstance(normalized, dict)
    return normalized


def _scope_list(
    value: Any,
    *,
    allowed: frozenset[str] | None,
    minimum: int,
    maximum: int,
    label: str,
    plugin_id: str,
    contribution_id: str,
) -> list[str]:
    if (
        not isinstance(value, list)
        or not minimum <= len(value) <= maximum
        or not all(isinstance(item, str) for item in value)
        or len(set(value)) != len(value)
        or (allowed is not None and not set(value) <= allowed)
    ):
        _fail(
            f"{label} is invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    return value


def _validate_network_scope(
    scope: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> None:
    _exact_keys(
        scope,
        allowed={
            "schemes",
            "domains",
            "ports",
            "methods",
            "maxRequestBytes",
            "maxResponseBytes",
            "maxRedirects",
            "maxConcurrent",
            "ratePerMinute",
        },
        required={
            "schemes",
            "domains",
            "ports",
            "methods",
            "maxRequestBytes",
            "maxResponseBytes",
            "maxRedirects",
            "maxConcurrent",
            "ratePerMinute",
        },
        label="network.connect scope",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    schemes = _scope_list(
        scope["schemes"],
        allowed=frozenset({"https"}),
        minimum=1,
        maximum=1,
        label="network schemes",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if schemes != ["https"]:
        _fail(
            "Phase 9 network scope is HTTPS-only",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    domains = _scope_list(
        scope["domains"],
        allowed=None,
        minimum=1,
        maximum=32,
        label="network domains",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    for domain in domains:
        try:
            ipaddress.ip_address(domain)
        except ValueError:
            is_ip = False
        else:
            is_ip = True
        if (
            domain != domain.lower()
            or _DOMAIN.fullmatch(domain) is None
            or is_ip
            or "*" in domain
        ):
            _fail(
                "network domains must be exact lowercase DNS names",
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
    ports = scope["ports"]
    if (
        not isinstance(ports, list)
        or not 1 <= len(ports) <= 16
        or len(set(ports)) != len(ports)
        or not all(
            not isinstance(port, bool) and isinstance(port, int) and 1 <= port <= 65535
            for port in ports
        )
    ):
        _fail(
            "network ports are invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _scope_list(
        scope["methods"],
        allowed=_HTTP_METHODS,
        minimum=1,
        maximum=len(_HTTP_METHODS),
        label="network methods",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    for key, minimum, maximum in (
        ("maxRequestBytes", 0, 128 * 1024),
        ("maxResponseBytes", 1, 128 * 1024),
        ("maxRedirects", 0, 8),
        ("maxConcurrent", 1, 16),
        ("ratePerMinute", 1, 10_000),
    ):
        _bounded_int(
            scope[key],
            minimum=minimum,
            maximum=maximum,
            label=f"network {key}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )


def _validate_file_scope(
    scope: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> None:
    _exact_keys(
        scope,
        allowed={"mediaTypes", "maxBytes", "ttlSeconds"},
        required={"mediaTypes", "maxBytes", "ttlSeconds"},
        label="user-selected file scope",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    media_types = _scope_list(
        scope["mediaTypes"],
        allowed=None,
        minimum=1,
        maximum=16,
        label="file mediaTypes",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if not all(
        value == value.lower() and _MEDIA_TYPE.fullmatch(value) for value in media_types
    ):
        _fail(
            "file mediaTypes are invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _bounded_int(
        scope["maxBytes"],
        minimum=1,
        maximum=128 * 1024,
        label="file maxBytes",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    _bounded_int(
        scope["ttlSeconds"],
        minimum=1,
        maximum=600,
        label="file ttlSeconds",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )


def _validate_endpoint_scope(
    scope: dict[str, Any], *, plugin_id: str, contribution_id: str
) -> None:
    _exact_keys(
        scope,
        allowed={
            "endpoints",
            "methods",
            "maxRequestBytes",
            "maxResponseBytes",
            "maxConcurrent",
            "ratePerMinute",
        },
        required={
            "endpoints",
            "methods",
            "maxRequestBytes",
            "maxResponseBytes",
            "maxConcurrent",
            "ratePerMinute",
        },
        label="HTTP endpoint scope",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    endpoints = _scope_list(
        scope["endpoints"],
        allowed=None,
        minimum=1,
        maximum=32,
        label="HTTP endpoint IDs",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    if not all(_VIEW_FIELD.fullmatch(item) for item in endpoints):
        _fail(
            "HTTP endpoint IDs are invalid",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )
    _scope_list(
        scope["methods"],
        allowed=_HTTP_METHODS,
        minimum=1,
        maximum=len(_HTTP_METHODS),
        label="HTTP endpoint methods",
        plugin_id=plugin_id,
        contribution_id=contribution_id,
    )
    for key, minimum, maximum in (
        ("maxRequestBytes", 0, 128 * 1024),
        ("maxResponseBytes", 1, 128 * 1024),
        ("maxConcurrent", 1, 16),
        ("ratePerMinute", 1, 10_000),
    ):
        _bounded_int(
            scope[key],
            minimum=minimum,
            maximum=maximum,
            label=f"HTTP endpoint {key}",
            plugin_id=plugin_id,
            contribution_id=contribution_id,
        )


def _validate_phase9_permissions(
    manifest: PluginManifest, contributions: tuple[CoreContribution, ...]
) -> None:
    requests = {
        item.id: item.scope
        for item in (*manifest.permissions.required, *manifest.permissions.optional)
    }
    fallback_id = contributions[0].id if contributions else "permissions"
    if "network.connect" in requests:
        _validate_network_scope(
            requests["network.connect"],
            plugin_id=manifest.plugin.id,
            contribution_id=fallback_id,
        )
    for permission_id in (
        "filesystem.open-user-selected",
        "filesystem.save-user-selected",
    ):
        if permission_id in requests:
            _validate_file_scope(
                requests[permission_id],
                plugin_id=manifest.plugin.id,
                contribution_id=fallback_id,
            )
    if "http.endpoint.serve" in requests:
        _validate_endpoint_scope(
            requests["http.endpoint.serve"],
            plugin_id=manifest.plugin.id,
            contribution_id=fallback_id,
        )
    for contribution in contributions:
        if contribution.kind == "command/1":
            for item in contribution.configuration.get("fileInputs", []):
                permission_id = (
                    "filesystem.open-user-selected"
                    if item["mode"] == "open"
                    else "filesystem.save-user-selected"
                )
                scope = requests.get(permission_id)
                if (
                    scope is None
                    or not set(item["accept"]) <= set(scope["mediaTypes"])
                    or item["maxBytes"] > scope["maxBytes"]
                ):
                    _fail(
                        "command file input exceeds its requested permission scope",
                        plugin_id=manifest.plugin.id,
                        contribution_id=contribution.id,
                    )
        if contribution.kind == "http-endpoint/1":
            scope = requests.get("http.endpoint.serve")
            config = contribution.configuration
            if (
                scope is None
                or contribution.id not in scope["endpoints"]
                or not set(config["methods"]) <= set(scope["methods"])
                or config["maxRequestBytes"] > scope["maxRequestBytes"]
                or config["maxResponseBytes"] > scope["maxResponseBytes"]
                or config["maxConcurrent"] > scope["maxConcurrent"]
                or config["ratePerMinute"] > scope["ratePerMinute"]
            ):
                _fail(
                    "HTTP endpoint exceeds its requested permission scope",
                    plugin_id=manifest.plugin.id,
                    contribution_id=contribution.id,
                )


def _validate_phase11_permissions(
    manifest: PluginManifest, contributions: tuple[CoreContribution, ...]
) -> None:
    paper = tuple(
        item
        for item in contributions
        if item.kind in {"account-provider/1", "order-executor/1"}
    )
    if not paper:
        return
    required = {item.id: item.scope for item in manifest.permissions.required}
    requested = {
        item.id: item.scope
        for item in (*manifest.permissions.required, *manifest.permissions.optional)
    }
    forbidden = sorted(
        set(requested)
        & {"network.connect", "secrets.use", "trade.submit", "trade.cancel"}
    )
    if forbidden:
        _fail(
            "Phase 11A paper plugins cannot request live credentials, network, or live trading permissions",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    if not {"accounts.read", "trade.simulate"} <= set(required):
        _fail(
            "paper account and executor contributions require accounts.read and trade.simulate",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    account_scope = required["accounts.read"]
    trade_scope = required["trade.simulate"]
    if not isinstance(account_scope, dict) or not isinstance(trade_scope, dict):
        _fail(
            "paper permission scopes must be objects",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    _exact_keys(
        account_scope,
        allowed={"brokers", "accounts"},
        required={"brokers", "accounts"},
        label="accounts.read scope",
        plugin_id=manifest.plugin.id,
        contribution_id=paper[0].id,
    )
    account_brokers = _scope_list(
        account_scope["brokers"],
        allowed=None,
        minimum=1,
        maximum=16,
        label="accounts.read brokers",
        plugin_id=manifest.plugin.id,
        contribution_id=paper[0].id,
    )
    account_ids = _scope_list(
        account_scope["accounts"],
        allowed=None,
        minimum=1,
        maximum=64,
        label="accounts.read accounts",
        plugin_id=manifest.plugin.id,
        contribution_id=paper[0].id,
    )
    if not all(_PAPER_BROKER_ID.fullmatch(item) for item in account_brokers) or not all(
        _PAPER_ACCOUNT_ID.fullmatch(item) for item in account_ids
    ):
        _fail(
            "accounts.read scope identifiers are invalid",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    trade_keys = {
        "brokers",
        "accounts",
        "symbols",
        "marketTypes",
        "orderTypes",
        "maxOrderQuantity",
        "maxOrderNotional",
        "maxPositionNotional",
        "maxOpenOrders",
        "maxOrdersPerMinute",
        "allowShort",
    }
    _exact_keys(
        trade_scope,
        allowed=trade_keys,
        required=trade_keys,
        label="trade.simulate scope",
        plugin_id=manifest.plugin.id,
        contribution_id=paper[0].id,
    )
    trade_lists: dict[str, list[str]] = {}
    for key, maximum in (
        ("brokers", 16),
        ("accounts", 64),
        ("symbols", 128),
        ("marketTypes", 32),
        ("orderTypes", 2),
    ):
        trade_lists[key] = _scope_list(
            trade_scope[key],
            allowed=None,
            minimum=1,
            maximum=maximum,
            label=f"trade.simulate {key}",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    if (
        not all(_PAPER_BROKER_ID.fullmatch(item) for item in trade_lists["brokers"])
        or not all(
            _PAPER_ACCOUNT_ID.fullmatch(item) for item in trade_lists["accounts"]
        )
        or not all(_PAPER_SYMBOL.fullmatch(item) for item in trade_lists["symbols"])
        or not all(
            _MARKET_TYPE_ID.fullmatch(item) for item in trade_lists["marketTypes"]
        )
        or not set(trade_lists["orderTypes"]) <= _PAPER_ORDER_TYPES
        or not isinstance(trade_scope["allowShort"], bool)
    ):
        _fail(
            "trade.simulate scope identifiers or enums are invalid",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
        )
    trade_limits = {
        key: _paper_decimal(
            trade_scope[key],
            label=f"trade.simulate {key}",
            plugin_id=manifest.plugin.id,
            contribution_id=paper[0].id,
            positive=True,
        )
        for key in ("maxOrderQuantity", "maxOrderNotional", "maxPositionNotional")
    }
    trade_limits.update(
        {
            "maxOpenOrders": _bounded_int(
                trade_scope["maxOpenOrders"],
                minimum=1,
                maximum=1024,
                label="trade.simulate maxOpenOrders",
                plugin_id=manifest.plugin.id,
                contribution_id=paper[0].id,
            ),
            "maxOrdersPerMinute": _bounded_int(
                trade_scope["maxOrdersPerMinute"],
                minimum=1,
                maximum=10_000,
                label="trade.simulate maxOrdersPerMinute",
                plugin_id=manifest.plugin.id,
                contribution_id=paper[0].id,
            ),
            "allowShort": trade_scope["allowShort"],
        }
    )
    for item in paper:
        broker_id = item.configuration["brokerId"]
        if broker_id not in account_brokers or broker_id not in trade_lists["brokers"]:
            _fail(
                "paper broker exceeds its requested permission scope",
                plugin_id=manifest.plugin.id,
                contribution_id=item.id,
            )
        if item.kind == "account-provider/1":
            configured_accounts = {
                account["id"] for account in item.configuration["accounts"]
            }
            if not configured_accounts <= set(
                account_ids
            ) or not configured_accounts <= set(trade_lists["accounts"]):
                _fail(
                    "paper accounts exceed their requested permission scopes",
                    plugin_id=manifest.plugin.id,
                    contribution_id=item.id,
                )
            continue
        config = item.configuration
        limits = config["limits"]
        if (
            not {symbol["symbol"] for symbol in config["symbols"]}
            <= set(trade_lists["symbols"])
            or not {symbol["marketType"] for symbol in config["symbols"]}
            <= set(trade_lists["marketTypes"])
            or not set(config["orderTypes"]) <= set(trade_lists["orderTypes"])
            or any(
                Decimal(limits[key]) > Decimal(trade_limits[key])
                for key in (
                    "maxOrderQuantity",
                    "maxOrderNotional",
                    "maxPositionNotional",
                )
            )
            or limits["maxOpenOrders"] > trade_limits["maxOpenOrders"]
            or limits["maxOrdersPerMinute"] > trade_limits["maxOrdersPerMinute"]
            or (limits["allowShort"] and not trade_limits["allowShort"])
        ):
            _fail(
                "paper executor exceeds its requested trade.simulate scope",
                plugin_id=manifest.plugin.id,
                contribution_id=item.id,
            )


def core_contributions(manifest: PluginManifest) -> tuple[CoreContribution, ...]:
    result: list[CoreContribution] = []
    for item in manifest.contributions:
        if item.kind not in CORE_CONTRIBUTION_KINDS:
            continue
        configuration = _validate_core_configuration(manifest.plugin.id, item)
        result.append(
            CoreContribution(
                plugin_id=manifest.plugin.id,
                id=item.id,
                full_id=f"{manifest.plugin.id}.{item.id}",
                kind=item.kind,
                title=item.title,
                entrypoint_id=item.entrypoint,
                configuration=configuration,
                localizations=_validate_contribution_localizations(
                    manifest.plugin.id, item, configuration
                ),
            )
        )
    command_ids = {item.id for item in result if item.kind == "command/1"}
    for item in result:
        primary_command = item.configuration.get("primaryCommand")
        if primary_command is not None and primary_command not in command_ids:
            _fail(
                "view primaryCommand must reference a command in the same plugin",
                plugin_id=manifest.plugin.id,
                contribution_id=item.id,
            )
    symbol_providers = {
        item.configuration["exchange"]: item
        for item in result
        if item.kind == "symbol-provider/1"
    }
    market_providers = {
        item.configuration["exchange"]: item
        for item in result
        if item.kind == "market-data-provider/1"
    }
    provider_entries = [
        item
        for item in result
        if item.kind in {"symbol-provider/1", "market-data-provider/1"}
    ]
    if (
        len(symbol_providers)
        != sum(item.kind == "symbol-provider/1" for item in provider_entries)
        or len(market_providers)
        != sum(item.kind == "market-data-provider/1" for item in provider_entries)
        or set(symbol_providers) != set(market_providers)
    ):
        contribution = provider_entries[0] if provider_entries else None
        if contribution is not None:
            _fail(
                "each provider exchange requires exactly one symbol and one market-data contribution",
                plugin_id=manifest.plugin.id,
                contribution_id=contribution.id,
            )
    for exchange, market_provider in market_providers.items():
        symbol_provider = symbol_providers[exchange]
        declared_markets = {
            item["id"] for item in symbol_provider.configuration["marketTypes"]
        }
        channel_markets = {
            market_type
            for channel in market_provider.configuration["channels"]
            for market_type in channel["marketTypes"]
        }
        if (
            not channel_markets <= declared_markets
            or market_provider.entrypoint_id != symbol_provider.entrypoint_id
        ):
            _fail(
                "provider channels must use declared markets and the paired entrypoint",
                plugin_id=manifest.plugin.id,
                contribution_id=market_provider.id,
            )
    account_providers = {
        item.configuration["brokerId"]: item
        for item in result
        if item.kind == "account-provider/1"
    }
    order_executors = {
        item.configuration["brokerId"]: item
        for item in result
        if item.kind == "order-executor/1"
    }
    paper_entries = [
        item
        for item in result
        if item.kind in {"account-provider/1", "order-executor/1"}
    ]
    if (
        len(account_providers)
        != sum(item.kind == "account-provider/1" for item in paper_entries)
        or len(order_executors)
        != sum(item.kind == "order-executor/1" for item in paper_entries)
        or set(account_providers) != set(order_executors)
    ):
        contribution = paper_entries[0] if paper_entries else None
        if contribution is not None:
            _fail(
                "each paper broker requires exactly one account provider and one order executor",
                plugin_id=manifest.plugin.id,
                contribution_id=contribution.id,
            )
    for broker_id, executor in order_executors.items():
        accounts = account_providers[broker_id]
        if executor.entrypoint_id != accounts.entrypoint_id:
            _fail(
                "paired paper contributions must use the same entrypoint",
                plugin_id=manifest.plugin.id,
                contribution_id=executor.id,
            )
    sandbox_views = {
        item.id: item
        for item in result
        if item.kind == "view/1" and item.configuration.get("renderer") == "sandbox"
    }
    sandbox_surfaces = {
        item.id: item
        for item in (
            manifest.frontend.surfaces if manifest.frontend is not None else ()
        )
        if item.type == "sandbox"
    }
    if set(sandbox_views) != set(sandbox_surfaces):
        unmatched = sorted(set(sandbox_views) ^ set(sandbox_surfaces))
        _fail(
            "sandbox views must exactly match declared frontend surfaces",
            plugin_id=manifest.plugin.id,
            contribution_id=unmatched[0],
        )
    for surface_id, contribution in sandbox_views.items():
        surface = sandbox_surfaces[surface_id]
        if (
            contribution.configuration["surface"] != surface_id
            or surface.slot
            != _SANDBOX_FRONTEND_SLOTS[contribution.configuration["slot"]]
            or not surface.entry.lower().endswith(".html")
        ):
            _fail(
                "sandbox frontend surface does not match its view contribution",
                plugin_id=manifest.plugin.id,
                contribution_id=contribution.id,
            )
    values = tuple(result)
    _validate_phase9_permissions(manifest, values)
    _validate_phase11_permissions(manifest, values)
    return values


def validate_public_event(event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    schema = PUBLIC_EVENT_SCHEMAS.get(event_id)
    if schema is None:
        raise core_error(
            "PLUGIN_PUBLIC_EVENT_UNKNOWN", "public event is not registered"
        )
    normalized = normalize_json(payload, path="publicEvent.payload")
    if not isinstance(normalized, dict) or set(normalized) != set(schema):
        raise core_error(
            "PLUGIN_PUBLIC_EVENT_INVALID", "public event payload shape is invalid"
        )
    if any(
        not isinstance(normalized[key], expected) for key, expected in schema.items()
    ):
        raise core_error(
            "PLUGIN_PUBLIC_EVENT_INVALID", "public event payload type is invalid"
        )
    return normalized
