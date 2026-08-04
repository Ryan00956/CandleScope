"""Opt-in local-only aggregate stability counters for Marketplace v2."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    loads_strict,
)

from app.plugin_security_v2.storage import atomic_write_json, security_lock

from .errors import MarketplaceError


TELEMETRY_SCHEMA_VERSION = "candlescope.marketplace-telemetry/1"
MAX_TELEMETRY_BYTES = 512 * 1024
_RUNTIME_KINDS = frozenset(
    {
        "python-module",
        "native-executable",
        "java-jar",
        "node-module",
        "wasm-component",
        "mixed",
        "none",
    }
)
_OPERATIONS = frozenset(
    {
        "refresh",
        "cache-reuse",
        "prepare",
        "apply",
        "activate",
        "observation",
        "rollback",
        "revocation-quarantine",
    }
)
_OUTCOMES = frozenset({"success", "failure", "quarantined"})
_LIMITS = JsonLimits(
    max_message_bytes=MAX_TELEMETRY_BYTES,
    max_depth=8,
    max_container_items=10_000,
    max_string_bytes=1_024,
)


def _empty() -> dict[str, Any]:
    return {
        "schemaVersion": TELEMETRY_SCHEMA_VERSION,
        "uploadEnabled": False,
        "privacy": {
            "identifiers": False,
            "strategyInputs": False,
            "accounts": False,
            "pluginPrivateData": False,
        },
        "counters": [],
    }


def _validate(value: Any) -> dict[str, Any]:
    expected_privacy = {
        "identifiers": False,
        "strategyInputs": False,
        "accounts": False,
        "pluginPrivateData": False,
    }
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "uploadEnabled", "privacy", "counters"}
        or value.get("schemaVersion") != TELEMETRY_SCHEMA_VERSION
        or value.get("uploadEnabled") is not False
        or value.get("privacy") != expected_privacy
        or not isinstance(value.get("counters"), list)
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TELEMETRY_INVALID",
            "Marketplace telemetry file violates its local aggregate schema",
        )
    keys: list[tuple[str, str, str]] = []
    for item in value["counters"]:
        if (
            not isinstance(item, dict)
            or set(item) != {"runtimeKind", "operation", "outcome", "count"}
            or item.get("runtimeKind") not in _RUNTIME_KINDS
            or item.get("operation") not in _OPERATIONS
            or item.get("outcome") not in _OUTCOMES
            or isinstance(item.get("count"), bool)
            or not isinstance(item.get("count"), int)
            or not 0 < item["count"] <= 2**63 - 1
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_TELEMETRY_INVALID",
                "Marketplace telemetry contains a non-aggregate counter",
            )
        keys.append((item["runtimeKind"], item["operation"], item["outcome"]))
    if keys != sorted(keys) or len(set(keys)) != len(keys):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TELEMETRY_INVALID",
            "Marketplace telemetry counters must be sorted and unique",
        )
    return value


@dataclass(frozen=True, slots=True)
class MarketplaceTelemetry:
    path: Path
    lock_path: Path
    enabled: bool

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return _empty()
        if self.path.is_symlink() or not self.path.is_file():
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_TELEMETRY_INVALID",
                "Marketplace telemetry must be a regular local file",
            )
        try:
            value = loads_strict(self.path.read_bytes(), limits=_LIMITS)
        except (OSError, PlatformContractError) as exc:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_TELEMETRY_INVALID",
                "Marketplace telemetry is not strict bounded JSON",
            ) from exc
        return _validate(value)

    def record(self, runtime_kind: str, operation: str, outcome: str) -> None:
        if not self.enabled:
            return
        if (
            runtime_kind not in _RUNTIME_KINDS
            or operation not in _OPERATIONS
            or outcome not in _OUTCOMES
        ):
            raise ValueError("Marketplace telemetry counter dimensions are invalid")
        with security_lock(self.lock_path):
            value = self._read()
            counters = {
                (item["runtimeKind"], item["operation"], item["outcome"]): item["count"]
                for item in value["counters"]
            }
            key = (runtime_kind, operation, outcome)
            counters[key] = counters.get(key, 0) + 1
            value["counters"] = [
                {
                    "runtimeKind": dimensions[0],
                    "operation": dimensions[1],
                    "outcome": dimensions[2],
                    "count": count,
                }
                for dimensions, count in sorted(counters.items())
            ]
            _validate(value)
            atomic_write_json(self.path, value)

    def public_status(self) -> dict[str, Any]:
        value = self._read() if self.enabled else _empty()
        return {
            "enabled": self.enabled,
            "uploadEnabled": False,
            "storage": "local-aggregate-only",
            "privacy": dict(value["privacy"]),
            "counters": list(value["counters"]),
        }
