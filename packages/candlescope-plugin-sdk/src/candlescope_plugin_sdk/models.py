"""Typed wire models for ``candlescope.script-runtime/1``."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .constants import PROTOCOL_V1, RENDER_IR_V1
from .errors import invalid_params


_IDENTIFIER_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_SEVERITIES = frozenset({"error", "warning", "info"})
_SERIES_TYPES = frozenset({"line", "histogram"})
_RENDER_COLLECTION_FIELDS = (
    "lines",
    "histograms",
    "markers",
    "hlines",
    "fills",
    "bgcolors",
    "labels",
    "barcolors",
    "signals",
    "strategy",
    "objects",
    "object_events",
)


def _mapping(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise invalid_params(f"{field_name} must be an object", field_name=field_name)
    if not all(isinstance(key, str) for key in value):
        raise invalid_params(
            f"{field_name} keys must be strings",
            field_name=field_name,
        )
    return value


def _plain_dict(value: Any, field_name: str) -> dict[str, Any]:
    return dict(_mapping(value, field_name))


def _string(value: Any, field_name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise invalid_params(f"{field_name} must be a string", field_name=field_name)
    if not allow_empty and not value.strip():
        raise invalid_params(f"{field_name} must not be empty", field_name=field_name)
    return value


def _string_tuple(
    value: Any,
    field_name: str,
    *,
    allow_empty: bool = True,
) -> tuple[str, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise invalid_params(f"{field_name} must be an array", field_name=field_name)
    items = tuple(_string(item, f"{field_name}[]") for item in value)
    if not allow_empty and not items:
        raise invalid_params(f"{field_name} must not be empty", field_name=field_name)
    if len(set(items)) != len(items):
        raise invalid_params(
            f"{field_name} must not contain duplicates",
            field_name=field_name,
        )
    return items


def _identifier(value: Any, field_name: str) -> str:
    item = _string(value, field_name)
    if not _IDENTIFIER_RE.fullmatch(item):
        raise invalid_params(
            f"{field_name} must be a lowercase plugin identifier",
            field_name=field_name,
        )
    return item


def _integer(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise invalid_params(f"{field_name} must be an integer", field_name=field_name)
    return value


def _number(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid_params(f"{field_name} must be a number", field_name=field_name)
    number = float(value)
    if not math.isfinite(number):
        raise invalid_params(f"{field_name} must be finite", field_name=field_name)
    return number


def _json_value(value: Any, field_name: str, *, depth: int = 0) -> Any:
    """Return a detached JSON value or fail before it reaches the wire."""
    if depth > 32:
        raise invalid_params(f"{field_name} exceeds the maximum nesting depth")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise invalid_params(f"{field_name} numbers must be finite")
        return value
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise invalid_params(f"{field_name} keys must be strings")
        return {
            key: _json_value(item, f"{field_name}.{key}", depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [_json_value(item, f"{field_name}[]", depth=depth + 1) for item in value]
    raise invalid_params(f"{field_name} must contain JSON-compatible values")


def _json_records(value: Any, field_name: str) -> tuple[dict[str, Any], ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise invalid_params(f"{field_name} must be an array", field_name=field_name)
    records: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        record = _json_value(item, f"{field_name}[{index}]")
        if not isinstance(record, dict):
            raise invalid_params(
                f"{field_name}[{index}] must be an object",
                field_name=field_name,
            )
        records.append(record)
    return tuple(records)


@dataclass(frozen=True, slots=True)
class LanguageDescriptor:
    id: str
    name: str
    extensions: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _identifier(self.id, "language.id"))
        object.__setattr__(self, "name", _string(self.name, "language.name"))
        object.__setattr__(
            self,
            "extensions",
            _string_tuple(self.extensions, "language.extensions"),
        )
        object.__setattr__(
            self,
            "aliases",
            _string_tuple(self.aliases, "language.aliases"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "extensions": list(self.extensions),
            "aliases": list(self.aliases),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "LanguageDescriptor":
        data = _mapping(value, "language")
        return cls(
            id=data.get("id"),
            name=data.get("name"),
            extensions=_string_tuple(
                data.get("extensions", []),
                "language.extensions",
            ),
            aliases=_string_tuple(data.get("aliases", []), "language.aliases"),
        )


@dataclass(frozen=True, slots=True)
class RuntimeDescriptor:
    id: str
    name: str
    version: str
    package: str
    languages: tuple[LanguageDescriptor, ...]
    features: tuple[str, ...]
    required_host_features: tuple[str, ...]
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _identifier(self.id, "runtime.id"))
        object.__setattr__(self, "name", _string(self.name, "runtime.name"))
        object.__setattr__(self, "version", _string(self.version, "runtime.version"))
        object.__setattr__(self, "package", _string(self.package, "runtime.package"))
        languages = tuple(self.languages)
        if not languages or not all(isinstance(item, LanguageDescriptor) for item in languages):
            raise invalid_params(
                "runtime.languages must contain at least one language descriptor",
                field_name="runtime.languages",
            )
        if len({item.id for item in languages}) != len(languages):
            raise invalid_params(
                "runtime.languages must have unique ids",
                field_name="runtime.languages",
            )
        object.__setattr__(self, "languages", languages)
        features = _string_tuple(self.features, "runtime.features", allow_empty=False)
        required = _string_tuple(
            self.required_host_features,
            "runtime.requiredHostFeatures",
        )
        missing = sorted(set(required) - set(features))
        if missing:
            raise invalid_params(
                "runtime.requiredHostFeatures must be declared in runtime.features",
                field_name="runtime.requiredHostFeatures",
            )
        object.__setattr__(self, "features", features)
        object.__setattr__(self, "required_host_features", required)
        object.__setattr__(self, "meta", _plain_dict(self.meta, "runtime.meta"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "package": self.package,
            "languages": [item.to_wire() for item in self.languages],
            "features": list(self.features),
            "requiredHostFeatures": list(self.required_host_features),
            "meta": dict(self.meta),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RuntimeDescriptor":
        data = _mapping(value, "runtime")
        languages = data.get("languages")
        if isinstance(languages, (str, bytes)) or not isinstance(languages, Sequence):
            raise invalid_params(
                "runtime.languages must be an array",
                field_name="runtime.languages",
            )
        return cls(
            id=data.get("id"),
            name=data.get("name"),
            version=data.get("version"),
            package=data.get("package"),
            languages=tuple(LanguageDescriptor.from_wire(item) for item in languages),
            features=_string_tuple(data.get("features", []), "runtime.features"),
            required_host_features=_string_tuple(
                data.get("requiredHostFeatures", []),
                "runtime.requiredHostFeatures",
            ),
            meta=_plain_dict(data.get("meta", {}), "runtime.meta"),
        )


@dataclass(frozen=True, slots=True)
class HandshakeRequest:
    protocols: tuple[str, ...]
    host_name: str
    host_version: str
    host_features: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "protocols",
            _string_tuple(self.protocols, "handshake.protocols", allow_empty=False),
        )
        object.__setattr__(
            self,
            "host_name",
            _string(self.host_name, "handshake.host.name"),
        )
        object.__setattr__(
            self,
            "host_version",
            _string(self.host_version, "handshake.host.version"),
        )
        object.__setattr__(
            self,
            "host_features",
            _string_tuple(self.host_features, "handshake.hostFeatures"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocols": list(self.protocols),
            "host": {"name": self.host_name, "version": self.host_version},
            "hostFeatures": list(self.host_features),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "HandshakeRequest":
        data = _mapping(value, "handshake")
        host = _mapping(data.get("host"), "handshake.host")
        return cls(
            protocols=_string_tuple(
                data.get("protocols", []),
                "handshake.protocols",
                allow_empty=False,
            ),
            host_name=_string(host.get("name"), "handshake.host.name"),
            host_version=_string(host.get("version"), "handshake.host.version"),
            host_features=_string_tuple(
                data.get("hostFeatures", []),
                "handshake.hostFeatures",
            ),
        )


@dataclass(frozen=True, slots=True)
class HandshakeResult:
    runtime: RuntimeDescriptor
    negotiated_features: tuple[str, ...]
    protocol: str = PROTOCOL_V1

    def __post_init__(self) -> None:
        if not isinstance(self.runtime, RuntimeDescriptor):
            raise invalid_params("handshakeResult.runtime is invalid")
        protocol = _string(self.protocol, "handshakeResult.protocol")
        if protocol != PROTOCOL_V1:
            raise invalid_params(
                f"handshakeResult.protocol must be {PROTOCOL_V1}",
                field_name="handshakeResult.protocol",
            )
        negotiated = _string_tuple(
            self.negotiated_features,
            "handshakeResult.negotiatedFeatures",
        )
        missing = sorted(set(negotiated) - set(self.runtime.features))
        if missing:
            raise invalid_params(
                "negotiated features must be supported by the runtime",
                field_name="handshakeResult.negotiatedFeatures",
            )
        object.__setattr__(self, "protocol", protocol)
        object.__setattr__(self, "negotiated_features", negotiated)

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "runtime": self.runtime.to_wire(),
            "negotiatedFeatures": list(self.negotiated_features),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "HandshakeResult":
        data = _mapping(value, "handshakeResult")
        protocol = _string(data.get("protocol"), "handshakeResult.protocol")
        return cls(
            protocol=protocol,
            runtime=RuntimeDescriptor.from_wire(data.get("runtime")),
            negotiated_features=_string_tuple(
                data.get("negotiatedFeatures", []),
                "handshakeResult.negotiatedFeatures",
            ),
        )


@dataclass(frozen=True, slots=True)
class MarketContext:
    exchange: str
    market_type: str
    symbol: str
    interval: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "exchange", _string(self.exchange, "context.exchange"))
        object.__setattr__(
            self,
            "market_type",
            _string(self.market_type, "context.marketType"),
        )
        object.__setattr__(self, "symbol", _string(self.symbol, "context.symbol"))
        object.__setattr__(self, "interval", _string(self.interval, "context.interval"))

    def to_wire(self) -> dict[str, str]:
        return {
            "exchange": self.exchange,
            "marketType": self.market_type,
            "symbol": self.symbol,
            "interval": self.interval,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "MarketContext":
        data = _mapping(value, "context")
        return cls(
            exchange=data.get("exchange"),
            market_type=data.get("marketType"),
            symbol=data.get("symbol"),
            interval=data.get("interval"),
        )


@dataclass(frozen=True, slots=True)
class Bar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_closed: bool = True

    def __post_init__(self) -> None:
        object.__setattr__(self, "time", _integer(self.time, "bar.time"))
        for field_name in ("open", "high", "low", "close", "volume"):
            object.__setattr__(
                self, field_name, _number(getattr(self, field_name), f"bar.{field_name}")
            )
        if not isinstance(self.is_closed, bool):
            raise invalid_params("bar.isClosed must be a boolean", field_name="bar.isClosed")

    def to_wire(self) -> dict[str, Any]:
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "isClosed": self.is_closed,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "Bar":
        data = _mapping(value, "bar")
        return cls(
            time=data.get("time"),
            open=data.get("open"),
            high=data.get("high"),
            low=data.get("low"),
            close=data.get("close"),
            volume=data.get("volume"),
            is_closed=data.get("isClosed", True),
        )


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    severity: str
    message: str
    hint: str | None = None
    span: dict[str, int] | None = None
    data: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "code", _string(self.code, "diagnostic.code"))
        severity = _string(self.severity, "diagnostic.severity")
        if severity not in _SEVERITIES:
            raise invalid_params(
                "diagnostic.severity must be error, warning, or info",
                field_name="diagnostic.severity",
            )
        object.__setattr__(self, "severity", severity)
        object.__setattr__(self, "message", _string(self.message, "diagnostic.message"))
        if self.hint is not None:
            object.__setattr__(self, "hint", _string(self.hint, "diagnostic.hint"))
        if self.span is not None:
            raw_span = _mapping(self.span, "diagnostic.span")
            span = {
                key: _integer(value, f"diagnostic.span.{key}") for key, value in raw_span.items()
            }
            object.__setattr__(self, "span", span)
        object.__setattr__(self, "data", _plain_dict(self.data, "diagnostic.data"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            **({"hint": self.hint} if self.hint is not None else {}),
            **({"span": dict(self.span)} if self.span is not None else {}),
            "data": dict(self.data),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "Diagnostic":
        data = _mapping(value, "diagnostic")
        return cls(
            code=data.get("code"),
            severity=data.get("severity"),
            message=data.get("message"),
            hint=data.get("hint"),
            span=(
                dict(_mapping(data["span"], "diagnostic.span"))
                if data.get("span") is not None
                else None
            ),
            data=_plain_dict(data.get("data", {}), "diagnostic.data"),
        )


def _diagnostics(value: Any, field_name: str = "diagnostics") -> tuple[Diagnostic, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise invalid_params(f"{field_name} must be an array", field_name=field_name)
    return tuple(Diagnostic.from_wire(item) for item in value)


@dataclass(frozen=True, slots=True)
class AnalyzeRequest:
    source: str
    context: MarketContext
    options: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source",
            _string(self.source, "analyze.source", allow_empty=True),
        )
        if not isinstance(self.context, MarketContext):
            raise invalid_params("analyze.context is invalid", field_name="analyze.context")
        object.__setattr__(
            self,
            "options",
            _plain_dict(self.options, "analyze.options"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "context": self.context.to_wire(),
            "options": dict(self.options),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "AnalyzeRequest":
        data = _mapping(value, "analyze")
        return cls(
            source=_string(data.get("source"), "analyze.source", allow_empty=True),
            context=MarketContext.from_wire(data.get("context")),
            options=_plain_dict(data.get("options", {}), "analyze.options"),
        )


@dataclass(frozen=True, slots=True)
class AnalyzeResult:
    ok: bool
    executable: bool
    diagnostics: tuple[Diagnostic, ...] = ()
    inputs: tuple[dict[str, Any], ...] = ()
    dependencies: tuple[dict[str, Any], ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.ok, bool) or not isinstance(self.executable, bool):
            raise invalid_params("analyze result flags must be boolean")
        if self.executable and not self.ok:
            raise invalid_params("executable analysis result must be ok")
        diagnostics = tuple(self.diagnostics)
        if not all(isinstance(item, Diagnostic) for item in diagnostics):
            raise invalid_params("analyze result diagnostics are invalid")
        if not self.ok and not any(item.severity == "error" for item in diagnostics):
            raise invalid_params("failed analysis result requires an error diagnostic")
        object.__setattr__(self, "diagnostics", diagnostics)
        object.__setattr__(
            self,
            "inputs",
            tuple(_plain_dict(item, "analyzeResult.inputs[]") for item in self.inputs),
        )
        object.__setattr__(
            self,
            "dependencies",
            tuple(_plain_dict(item, "analyzeResult.dependencies[]") for item in self.dependencies),
        )
        object.__setattr__(self, "meta", _plain_dict(self.meta, "analyzeResult.meta"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "executable": self.executable,
            "diagnostics": [item.to_wire() for item in self.diagnostics],
            "inputs": [dict(item) for item in self.inputs],
            "dependencies": [dict(item) for item in self.dependencies],
            "meta": dict(self.meta),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "AnalyzeResult":
        data = _mapping(value, "analyzeResult")
        if not isinstance(data.get("ok"), bool) or not isinstance(data.get("executable"), bool):
            raise invalid_params("analyze result flags must be boolean")
        inputs = data.get("inputs", [])
        dependencies = data.get("dependencies", [])
        if isinstance(inputs, (str, bytes)) or not isinstance(inputs, Sequence):
            raise invalid_params("analyzeResult.inputs must be an array")
        if isinstance(dependencies, (str, bytes)) or not isinstance(dependencies, Sequence):
            raise invalid_params("analyzeResult.dependencies must be an array")
        return cls(
            ok=data["ok"],
            executable=data["executable"],
            diagnostics=_diagnostics(data.get("diagnostics", [])),
            inputs=tuple(_plain_dict(item, "analyzeResult.inputs[]") for item in inputs),
            dependencies=tuple(
                _plain_dict(item, "analyzeResult.dependencies[]") for item in dependencies
            ),
            meta=_plain_dict(data.get("meta", {}), "analyzeResult.meta"),
        )


@dataclass(frozen=True, slots=True)
class ExecuteBatchRequest:
    source: str
    context: MarketContext
    bars: tuple[Bar, ...]
    params: dict[str, Any] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source",
            _string(self.source, "executeBatch.source", allow_empty=True),
        )
        if not isinstance(self.context, MarketContext):
            raise invalid_params(
                "executeBatch.context is invalid",
                field_name="executeBatch.context",
            )
        bars = tuple(self.bars)
        if not all(isinstance(bar, Bar) for bar in bars):
            raise invalid_params(
                "executeBatch.bars must contain Bar values",
                field_name="executeBatch.bars",
            )
        object.__setattr__(self, "bars", bars)
        object.__setattr__(
            self,
            "params",
            _plain_dict(self.params, "executeBatch.params"),
        )
        object.__setattr__(
            self,
            "options",
            _plain_dict(self.options, "executeBatch.options"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "context": self.context.to_wire(),
            "bars": [bar.to_wire() for bar in self.bars],
            "params": dict(self.params),
            "options": dict(self.options),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ExecuteBatchRequest":
        data = _mapping(value, "executeBatch")
        bars = data.get("bars")
        if isinstance(bars, (str, bytes)) or not isinstance(bars, Sequence):
            raise invalid_params(
                "executeBatch.bars must be an array", field_name="executeBatch.bars"
            )
        return cls(
            source=_string(
                data.get("source"),
                "executeBatch.source",
                allow_empty=True,
            ),
            context=MarketContext.from_wire(data.get("context")),
            bars=tuple(Bar.from_wire(item) for item in bars),
            params=_plain_dict(data.get("params", {}), "executeBatch.params"),
            options=_plain_dict(data.get("options", {}), "executeBatch.options"),
        )


@dataclass(frozen=True, slots=True)
class LinePoint:
    time: int
    value: float | None
    color: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "time", _integer(self.time, "point.time"))
        if self.value is not None:
            object.__setattr__(self, "value", _number(self.value, "point.value"))
        if self.color is not None:
            object.__setattr__(self, "color", _string(self.color, "point.color"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "time": self.time,
            "value": self.value,
            **({"color": self.color} if self.color is not None else {}),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "LinePoint":
        data = _mapping(value, "point")
        return cls(
            time=data.get("time"),
            value=data.get("value"),
            color=data.get("color"),
        )


@dataclass(frozen=True, slots=True)
class LineSeries:
    id: str
    title: str
    points: tuple[LinePoint, ...]
    pane: str = "main"
    scale: str = "right"
    style: dict[str, Any] = field(default_factory=dict)
    series_type: str = "line"

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _identifier(self.id, "series.id"))
        object.__setattr__(self, "title", _string(self.title, "series.title"))
        points = tuple(self.points)
        if not all(isinstance(point, LinePoint) for point in points):
            raise invalid_params("series.data must contain line points")
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "pane", _string(self.pane, "series.pane"))
        object.__setattr__(self, "scale", _string(self.scale, "series.scale"))
        object.__setattr__(self, "style", _plain_dict(self.style, "series.style"))
        series_type = _string(self.series_type, "series.type")
        if series_type not in _SERIES_TYPES:
            raise invalid_params(
                "series.type must be line or histogram",
                field_name="series.type",
            )
        object.__setattr__(self, "series_type", series_type)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.series_type,
            "title": self.title,
            "pane": self.pane,
            "scale": self.scale,
            "style": dict(self.style),
            "data": [point.to_wire() for point in self.points],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "LineSeries":
        data = _mapping(value, "series")
        if data.get("type") not in _SERIES_TYPES:
            raise invalid_params(
                "series.type must be line or histogram",
                field_name="series.type",
            )
        points = data.get("data")
        if isinstance(points, (str, bytes)) or not isinstance(points, Sequence):
            raise invalid_params("series.data must be an array", field_name="series.data")
        return cls(
            id=data.get("id"),
            title=data.get("title"),
            points=tuple(LinePoint.from_wire(item) for item in points),
            pane=data.get("pane", "main"),
            scale=data.get("scale", "right"),
            style=_plain_dict(data.get("style", {}), "series.style"),
            series_type=data.get("type"),
        )


@dataclass(frozen=True, slots=True)
class RenderCollections:
    """Standard, JSON-only structured render collections.

    The field names belong to CandleScope's public Render IR. Runtime-private
    Python objects and arbitrary collection names are deliberately rejected.
    """

    lines: tuple[dict[str, Any], ...] = ()
    histograms: tuple[dict[str, Any], ...] = ()
    markers: tuple[dict[str, Any], ...] = ()
    hlines: tuple[dict[str, Any], ...] = ()
    fills: tuple[dict[str, Any], ...] = ()
    bgcolors: tuple[dict[str, Any], ...] = ()
    labels: tuple[dict[str, Any], ...] = ()
    barcolors: tuple[dict[str, Any], ...] = ()
    signals: tuple[dict[str, Any], ...] = ()
    strategy: dict[str, Any] | None = None
    objects: dict[str, Any] | None = None
    object_events: tuple[dict[str, Any], ...] = ()

    def __post_init__(self) -> None:
        for field_name in _RENDER_COLLECTION_FIELDS:
            value = getattr(self, field_name)
            if field_name in {"strategy", "objects"}:
                if value is None:
                    continue
                normalized = _json_value(value, f"collections.{field_name}")
                if not isinstance(normalized, dict):
                    raise invalid_params(
                        f"collections.{field_name} must be an object",
                        field_name=f"collections.{field_name}",
                    )
            else:
                normalized = _json_records(value, f"collections.{field_name}")
            object.__setattr__(self, field_name, normalized)

    @property
    def is_empty(self) -> bool:
        return all(
            getattr(self, field_name) in ((), None, {}) for field_name in _RENDER_COLLECTION_FIELDS
        )

    def to_wire(self) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for field_name in _RENDER_COLLECTION_FIELDS:
            value = getattr(self, field_name)
            if value in ((), None, {}):
                continue
            wire_name = "objectEvents" if field_name == "object_events" else field_name
            output[wire_name] = (
                [dict(item) for item in value]
                if isinstance(value, tuple)
                else _json_value(value, f"collections.{field_name}")
            )
        return output

    @classmethod
    def from_wire(cls, value: Any) -> "RenderCollections":
        data = _mapping(value, "collections")
        normalized = dict(data)
        if "objectEvents" in normalized:
            if "object_events" in normalized:
                raise invalid_params("collections contains duplicate object events")
            normalized["object_events"] = normalized.pop("objectEvents")
        unknown = sorted(set(normalized) - set(_RENDER_COLLECTION_FIELDS))
        if unknown:
            raise invalid_params(
                "collections contains unsupported fields: " + ", ".join(unknown),
                field_name="collections",
            )
        return cls(**normalized)


@dataclass(frozen=True, slots=True)
class RenderOutput:
    series: tuple[LineSeries, ...] = ()
    collections: RenderCollections | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    schema: str = RENDER_IR_V1

    def __post_init__(self) -> None:
        if self.schema != RENDER_IR_V1:
            raise invalid_params(
                f"render schema must be {RENDER_IR_V1}",
                field_name="output.schema",
            )
        series = tuple(self.series)
        if not all(isinstance(item, LineSeries) for item in series):
            raise invalid_params("output.series must contain line series")
        if len({item.id for item in series}) != len(series):
            raise invalid_params("output.series ids must be unique")
        object.__setattr__(self, "series", series)
        if self.collections is not None and not isinstance(self.collections, RenderCollections):
            raise invalid_params("output.collections is invalid")
        object.__setattr__(self, "meta", _plain_dict(self.meta, "output.meta"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "series": [item.to_wire() for item in self.series],
            **({"collections": self.collections.to_wire()} if self.collections is not None else {}),
            "meta": dict(self.meta),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RenderOutput":
        data = _mapping(value, "output")
        series = data.get("series")
        if isinstance(series, (str, bytes)) or not isinstance(series, Sequence):
            raise invalid_params("output.series must be an array", field_name="output.series")
        return cls(
            schema=data.get("schema"),
            series=tuple(LineSeries.from_wire(item) for item in series),
            collections=(
                RenderCollections.from_wire(data["collections"])
                if data.get("collections") is not None
                else None
            ),
            meta=_plain_dict(data.get("meta", {}), "output.meta"),
        )


@dataclass(frozen=True, slots=True)
class ExecuteBatchResult:
    ok: bool
    output: RenderOutput | None = None
    diagnostics: tuple[Diagnostic, ...] = ()
    inputs: tuple[dict[str, Any], ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.ok, bool):
            raise invalid_params("executeBatch result ok must be boolean")
        if self.ok and self.output is None:
            raise invalid_params("successful executeBatch result requires output")
        if self.output is not None and not isinstance(self.output, RenderOutput):
            raise invalid_params("executeBatch result output is invalid")
        if not self.ok and self.output is not None:
            raise invalid_params("failed executeBatch result must not contain output")
        diagnostics = tuple(self.diagnostics)
        if not all(isinstance(item, Diagnostic) for item in diagnostics):
            raise invalid_params("executeBatch result diagnostics are invalid")
        if not self.ok and not any(item.severity == "error" for item in diagnostics):
            raise invalid_params("failed executeBatch result requires an error diagnostic")
        object.__setattr__(self, "diagnostics", diagnostics)
        object.__setattr__(
            self,
            "inputs",
            tuple(_json_value(item, "executeBatchResult.inputs[]") for item in self.inputs),
        )
        if not all(isinstance(item, dict) for item in self.inputs):
            raise invalid_params("executeBatch result inputs must contain objects")
        object.__setattr__(self, "meta", _plain_dict(self.meta, "executeBatchResult.meta"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "output": self.output.to_wire() if self.output is not None else None,
            "diagnostics": [item.to_wire() for item in self.diagnostics],
            **({"inputs": [dict(item) for item in self.inputs]} if self.inputs else {}),
            "meta": dict(self.meta),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ExecuteBatchResult":
        data = _mapping(value, "executeBatchResult")
        if not isinstance(data.get("ok"), bool):
            raise invalid_params("executeBatchResult.ok must be boolean")
        output = data.get("output")
        return cls(
            ok=data["ok"],
            output=RenderOutput.from_wire(output) if output is not None else None,
            diagnostics=_diagnostics(data.get("diagnostics", [])),
            inputs=tuple(_json_records(data.get("inputs", []), "executeBatchResult.inputs")),
            meta=_plain_dict(data.get("meta", {}), "executeBatchResult.meta"),
        )
