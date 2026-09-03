"""Strict language-to-runtime routing for Indicator script plugins."""

from __future__ import annotations

from app.core.config import runtime_environment

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.plugin_runtime.registry import default_runtime_registry_path


INDICATOR_RUNTIME_ROUTES_SCHEMA_VERSION = 1
INDICATOR_RUNTIME_ROUTES_ENV = "CANDLESCOPE_INDICATOR_RUNTIME_ROUTES"
MAX_INDICATOR_RUNTIME_ROUTES_BYTES = 1024 * 1024
MAX_INDICATOR_RUNTIME_ROUTES = 128

ROUTE_MODE_LEGACY = "legacy"
ROUTE_MODE_SHADOW = "shadow"
ROUTE_MODE_SIDECAR = "sidecar"
ROUTE_MODES = frozenset({ROUTE_MODE_LEGACY, ROUTE_MODE_SHADOW, ROUTE_MODE_SIDECAR})

_IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")


class IndicatorRuntimeRoutesError(RuntimeError):
    """An explicitly configured Indicator runtime route file is invalid."""


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise IndicatorRuntimeRoutesError(f"{label} must be a JSON object")
    return value


def _only_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise IndicatorRuntimeRoutesError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise IndicatorRuntimeRoutesError(
            f"{label} must be a lowercase plugin identifier"
        )
    return value


@dataclass(frozen=True, slots=True)
class IndicatorRuntimeRoute:
    """One immutable language route selected for the application lifetime."""

    language: str
    mode: str
    runtime_id: str | None = None

    def __post_init__(self) -> None:
        language = _identifier(self.language, "route.language")
        if not isinstance(self.mode, str) or self.mode not in ROUTE_MODES:
            raise IndicatorRuntimeRoutesError(
                "route.mode must be legacy, shadow, or sidecar"
            )
        runtime_id = self.runtime_id
        if self.mode == ROUTE_MODE_LEGACY:
            if runtime_id is not None:
                raise IndicatorRuntimeRoutesError(
                    "legacy routes must not declare runtimeId"
                )
        else:
            runtime_id = _identifier(runtime_id, "route.runtimeId")
        object.__setattr__(self, "language", language)
        object.__setattr__(self, "runtime_id", runtime_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "mode": self.mode,
            **({"runtimeId": self.runtime_id} if self.runtime_id is not None else {}),
        }


@dataclass(frozen=True, slots=True)
class IndicatorRuntimeRoutes:
    """Validated runtime routing table with no implicit language fallback."""

    routes: tuple[IndicatorRuntimeRoute, ...]
    source: Path | None = None

    def __post_init__(self) -> None:
        routes = tuple(self.routes)
        if not routes:
            raise IndicatorRuntimeRoutesError("routes must not be empty")
        if len(routes) > MAX_INDICATOR_RUNTIME_ROUTES:
            raise IndicatorRuntimeRoutesError(
                f"routes exceeds {MAX_INDICATOR_RUNTIME_ROUTES} entries"
            )
        if not all(isinstance(route, IndicatorRuntimeRoute) for route in routes):
            raise IndicatorRuntimeRoutesError("routes contains an invalid route")
        languages = [route.language for route in routes]
        if len(set(languages)) != len(languages):
            raise IndicatorRuntimeRoutesError(
                "routes must not contain duplicate languages"
            )
        if "pyne" not in languages:
            raise IndicatorRuntimeRoutesError(
                "routes must explicitly include the current pyne language"
            )
        object.__setattr__(self, "routes", routes)
        if self.source is not None:
            object.__setattr__(
                self,
                "source",
                Path(self.source).expanduser().resolve(strict=False),
            )

    @classmethod
    def legacy_default(cls) -> "IndicatorRuntimeRoutes":
        return cls((IndicatorRuntimeRoute("pyne", ROUTE_MODE_LEGACY),))

    @classmethod
    def first_party_sidecar_default(cls) -> "IndicatorRuntimeRoutes":
        """Phase 8 default: both first-party languages are managed plugins."""
        return cls(
            (
                IndicatorRuntimeRoute(
                    "pyne",
                    ROUTE_MODE_SIDECAR,
                    "candlescope.pyne",
                ),
                IndicatorRuntimeRoute(
                    "pine",
                    ROUTE_MODE_SIDECAR,
                    "candlescope.pine-compat",
                ),
            )
        )

    @classmethod
    def pyne_sidecar_default(cls) -> "IndicatorRuntimeRoutes":
        """Backward-compatible name for the Phase 8 first-party default."""
        return cls.first_party_sidecar_default()

    def for_language(self, language: str) -> IndicatorRuntimeRoute:
        normalized = _identifier(language, "language")
        for route in self.routes:
            if route.language == normalized:
                return route
        raise IndicatorRuntimeRoutesError(
            f"no Indicator runtime route is configured for language {normalized!r}"
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": INDICATOR_RUNTIME_ROUTES_SCHEMA_VERSION,
            "routes": [route.to_wire() for route in self.routes],
        }


def default_indicator_runtime_routes_path(
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Place routing next to the activation registry without mixing schemas."""
    return default_runtime_registry_path(environ).with_name(
        "indicator-runtime-routes.json"
    )


def load_indicator_runtime_routes(
    path: Path,
    *,
    allow_missing: bool = False,
) -> IndicatorRuntimeRoutes:
    route_path = Path(path).expanduser().resolve(strict=False)
    if not route_path.exists():
        if allow_missing:
            return IndicatorRuntimeRoutes.first_party_sidecar_default()
        raise IndicatorRuntimeRoutesError(
            f"Indicator runtime routes file does not exist: {route_path}"
        )
    if not route_path.is_file():
        raise IndicatorRuntimeRoutesError(
            f"Indicator runtime routes path is not a file: {route_path}"
        )
    try:
        size = route_path.stat().st_size
        if size > MAX_INDICATOR_RUNTIME_ROUTES_BYTES:
            raise IndicatorRuntimeRoutesError(
                "Indicator runtime routes file exceeds the 1 MiB limit"
            )
        raw = route_path.read_text(encoding="utf-8")
        data = json.loads(
            raw,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except IndicatorRuntimeRoutesError:
        raise
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise IndicatorRuntimeRoutesError(
            f"failed to read Indicator runtime routes {route_path}: {exc}"
        ) from exc

    root = _mapping(data, "routes file")
    _only_keys(root, {"schemaVersion", "routes"}, "routes file")
    if root.get("schemaVersion") != INDICATOR_RUNTIME_ROUTES_SCHEMA_VERSION:
        raise IndicatorRuntimeRoutesError("routes file schemaVersion must be 1")
    raw_routes = root.get("routes")
    if isinstance(raw_routes, (str, bytes)) or not isinstance(raw_routes, Sequence):
        raise IndicatorRuntimeRoutesError("routes must be a JSON array")

    routes: list[IndicatorRuntimeRoute] = []
    for index, raw_route in enumerate(raw_routes):
        route = _mapping(raw_route, f"routes[{index}]")
        _only_keys(
            route,
            {"language", "mode", "runtimeId"},
            f"routes[{index}]",
        )
        routes.append(
            IndicatorRuntimeRoute(
                language=route.get("language"),
                mode=route.get("mode"),
                runtime_id=route.get("runtimeId"),
            )
        )
    return IndicatorRuntimeRoutes(tuple(routes), source=route_path)


def load_indicator_runtime_routes_from_environment(
    environ: Mapping[str, str] | None = None,
) -> IndicatorRuntimeRoutes:
    env = runtime_environment() if environ is None else environ
    override = env.get(INDICATOR_RUNTIME_ROUTES_ENV)
    if override is not None and not override.strip():
        raise IndicatorRuntimeRoutesError(
            f"{INDICATOR_RUNTIME_ROUTES_ENV} must not be empty"
        )
    path = (
        Path(override).expanduser()
        if override is not None
        else default_indicator_runtime_routes_path(env)
    )
    return load_indicator_runtime_routes(path, allow_missing=override is None)


__all__ = [
    "INDICATOR_RUNTIME_ROUTES_ENV",
    "INDICATOR_RUNTIME_ROUTES_SCHEMA_VERSION",
    "IndicatorRuntimeRoute",
    "IndicatorRuntimeRoutes",
    "IndicatorRuntimeRoutesError",
    "ROUTE_MODE_LEGACY",
    "ROUTE_MODE_SHADOW",
    "ROUTE_MODE_SIDECAR",
    "default_indicator_runtime_routes_path",
    "load_indicator_runtime_routes",
    "load_indicator_runtime_routes_from_environment",
]
