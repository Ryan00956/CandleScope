"""Host-owned contracts for the Phase 5 contribution and event surface."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
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
    }
)

PUBLIC_EVENT_SCHEMAS: dict[str, dict[str, type]] = {
    "candlescope.app.ready/1": {"hostVersion": str},
    "candlescope.app.stopping/1": {"reason": str},
    "candlescope.plugin.enabled/1": {"pluginId": str},
    "candlescope.plugin.disabled/1": {"pluginId": str},
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


@dataclass(frozen=True, slots=True)
class CoreContribution:
    plugin_id: str
    id: str
    full_id: str
    kind: str
    title: str
    entrypoint_id: str
    configuration: dict[str, Any]

    def to_catalog(self) -> dict[str, Any]:
        return {
            "id": self.full_id,
            "localId": self.id,
            "kind": self.kind,
            "title": self.title,
            "entrypointId": self.entrypoint_id,
            "configuration": dict(self.configuration),
        }


def _validate_core_configuration(plugin_id: str, item: Contribution) -> dict[str, Any]:
    config = dict(item.configuration)
    if item.kind == "command/1":
        _exact_keys(
            config,
            allowed={"requiresUserAction", "inputSchema"},
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
    elif item.kind == "chart-layer/1":
        _exact_keys(
            config,
            allowed={"target", "zOrder", "maxItems", "maxBytes", "maxTextChars"},
            label="chart layer configuration",
            plugin_id=plugin_id,
            contribution_id=item.id,
        )
        target = config.get("target", "main-chart")
        z_order = config.get("zOrder", "above-series")
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
    else:
        raise AssertionError(
            "core configuration validator received an unsupported kind"
        )
    normalized = normalize_json(config, path="contribution.configuration")
    assert isinstance(normalized, dict)
    return normalized


def core_contributions(manifest: PluginManifest) -> tuple[CoreContribution, ...]:
    result: list[CoreContribution] = []
    for item in manifest.contributions:
        if item.kind not in CORE_CONTRIBUTION_KINDS:
            continue
        result.append(
            CoreContribution(
                plugin_id=manifest.plugin.id,
                id=item.id,
                full_id=f"{manifest.plugin.id}.{item.id}",
                kind=item.kind,
                title=item.title,
                entrypoint_id=item.entrypoint,
                configuration=_validate_core_configuration(manifest.plugin.id, item),
            )
        )
    return tuple(result)


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
