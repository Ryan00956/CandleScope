"""
Indicator Types — core data structures for the indicator engine.

Defines:
  * ``IndicatorKey``    — unique identifier for an indicator instance
  * ``IndicatorMeta``   — metadata describing an indicator (overlay, outputs, etc.)
  * ``IndicatorOutput`` — a single output series (name + data points)
  * ``IndicatorResult`` — complete result envelope for one indicator instance
  * ``IndicatorParam``  — parameter schema for UI rendering
  * ``IndicatorSpec``   — full specification of a registered indicator type
"""
from __future__ import annotations

import enum
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


# ═══════════════════════════════════════════════════════════════
#  Indicator Key — unique instance identifier
# ═══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class IndicatorKey:
    """Immutable unique identifier for an indicator instance.

    Two instances with the same key are guaranteed to produce identical
    results, so the engine can safely deduplicate and share them.

    Examples::

        key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20, "source": "close"})
        # key.uid → "BTCUSDT:1m:MA:a3f1c8..."
    """
    symbol: str
    interval: str
    indicator_name: str
    params: dict[str, Any] = field(default_factory=dict)
    market_type: str = "spot"

    def __post_init__(self) -> None:
        object.__setattr__(self, "symbol", self.symbol.upper().strip())
        object.__setattr__(self, "interval", self.interval.strip())
        object.__setattr__(self, "market_type", self.market_type.strip().lower())
        object.__setattr__(self, "indicator_name", self.indicator_name.upper().strip())
        # Freeze params into a hashable form
        if isinstance(self.params, dict):
            object.__setattr__(self, "params", _freeze_dict(self.params))

    @property
    def params_hash(self) -> str:
        """Deterministic short hash of params."""
        raw = json.dumps(dict(self.params), sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:12]

    @property
    def uid(self) -> str:
        """Human-readable unique ID including market type."""
        return f"{self.market_type}:{self.symbol}:{self.interval}:{self.indicator_name}:{self.params_hash}"

    @property
    def series_topic(self) -> str:
        """DataManager topic string matching ``SeriesKey.topic`` semantics."""
        base = f"{self.symbol}@{self.interval}"
        if self.market_type != "spot":
            return f"{self.market_type}:{base}"
        return base

    def __str__(self) -> str:
        return self.uid

    def __hash__(self) -> int:
        return hash(self.uid)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, IndicatorKey):
            return NotImplemented
        return self.uid == other.uid


def _freeze_dict(d: dict) -> dict:
    """Return a new dict with all mutable values converted to immutable."""
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out[k] = _freeze_dict(v)
        elif isinstance(v, list):
            out[k] = tuple(v)
        else:
            out[k] = v
    return out


# ═══════════════════════════════════════════════════════════════
#  Indicator Metadata
# ═══════════════════════════════════════════════════════════════


class PaneType(str, enum.Enum):
    """Where the indicator is rendered on the chart."""
    MAIN = "main"           # overlay on the candlestick chart
    SEPARATE = "separate"   # separate pane below the chart
    VOLUME = "volume"       # volume pane


class SeriesType(str, enum.Enum):
    """Visual type of the output series."""
    LINE = "line"
    HISTOGRAM = "histogram"


@dataclass(slots=True)
class IndicatorMeta:
    """Metadata describing an indicator type.

    Used by the frontend to decide rendering (overlay vs separate pane,
    precision, warmup blanks, etc.) and by the engine for lifecycle
    management.
    """
    name: str                               # display name, e.g. "MA"
    category: str = ""                      # e.g. "趋势", "震荡", "波动"
    description: str = ""
    pane: PaneType = PaneType.MAIN          # default rendering pane
    overlay: bool = True                    # overlay on price chart?
    precision: int = 8                      # decimal places for output values
    warmup_period: int = 0                  # bars needed before valid output
    version: str = "1.0"


# ═══════════════════════════════════════════════════════════════
#  Indicator Parameter Schema
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class IndicatorParam:
    """Schema for a single indicator parameter.

    Used to generate configuration UIs and validate user input.
    """
    key: str                    # parameter name, e.g. "period"
    label: str = ""             # display label, e.g. "周期"
    type: str = "int"           # "int", "float", "color", "string", "bool"
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None  # for select/dropdown

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "key": self.key,
            "label": self.label or self.key,
            "type": self.type,
            "default": self.default,
        }
        if self.min is not None:
            d["min"] = self.min
        if self.max is not None:
            d["max"] = self.max
        if self.step is not None:
            d["step"] = self.step
        if self.options is not None:
            d["options"] = self.options
        return d


# ═══════════════════════════════════════════════════════════════
#  Indicator Output
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class OutputPoint:
    """A single data point in an indicator output series."""
    timestamp: int      # Unix seconds
    value: float | None


@dataclass(slots=True)
class IndicatorOutput:
    """A named output series from an indicator.

    One indicator can produce multiple outputs, e.g. MACD produces
    "dif", "dea", "hist".

    Attributes:
        name:        Output name, e.g. "ma", "dif", "upper"
        display_name: Human-readable name, e.g. "MA(20)", "DIF"
        series_type: Line or histogram
        pane:        Where to render
        color:       Default rendering color
        line_width:  Default line width
        line_style:  0=solid, 1=dotted, 2=dashed, 3=large-dashed, 4=sparse-dotted
        data:        The actual data points
        color_data:  Per-bar colors (for histogram coloring)
    """
    name: str
    display_name: str = ""
    series_type: SeriesType = SeriesType.LINE
    pane: PaneType = PaneType.MAIN
    color: str = "#f59e0b"
    line_width: int = 2
    line_style: int = 0
    data: list[OutputPoint] = field(default_factory=list)
    color_data: list[dict] | None = None  # [{timestamp, color}, ...]

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "name": self.display_name or self.name,
            "color": self.color,
            "type": self.series_type.value,
            "pane": self.pane.value,
            "lineWidth": self.line_width,
            "lineStyle": self.line_style,
            "data": [
                {"time": p.timestamp, "value": round(p.value, 8) if p.value is not None else None}
                for p in self.data
                if p.value is not None
            ],
        }
        if self.color_data:
            d["colorData"] = self.color_data
        return d

    @property
    def latest_value(self) -> float | None:
        """Return the most recent non-None value."""
        for i in range(len(self.data) - 1, -1, -1):
            if self.data[i].value is not None:
                return self.data[i].value
        return None


# ═══════════════════════════════════════════════════════════════
#  Indicator Result — complete envelope
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class IndicatorResult:
    """Complete result for one indicator instance.

    This is the standard output envelope sent to consumers
    (frontend, strategy engine, alert system, etc.).
    """
    key: IndicatorKey
    meta: IndicatorMeta
    outputs: dict[str, IndicatorOutput] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "indicator_id": self.key.uid,
            "name": self.meta.name,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "market_type": self.key.market_type,
            "params": dict(self.key.params),
            "outputs": {
                name: output.to_dict()
                for name, output in self.outputs.items()
            },
            "meta": {
                "category": self.meta.category,
                "description": self.meta.description,
                "pane": self.meta.pane.value,
                "overlay": self.meta.overlay,
                "precision": self.meta.precision,
                "warmup_period": self.meta.warmup_period,
                "version": self.meta.version,
            },
            "error": self.error,
        }

    @property
    def lines(self) -> list[dict]:
        """Flat list of output dicts — compatible with frontend rendering."""
        return [output.to_dict() for output in self.outputs.values()]

    def get_latest(self) -> dict[str, float | None]:
        """Return latest values for all outputs."""
        return {
            name: output.latest_value
            for name, output in self.outputs.items()
        }


# ═══════════════════════════════════════════════════════════════
#  Indicator Spec — full type specification for the registry
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class IndicatorSpec:
    """Full specification of a registered indicator type.

    This is what the registry stores and what the frontend uses
    to build configuration UIs.
    """
    name: str                                   # unique name, e.g. "MA"
    display_name: str = ""                      # e.g. "简单移动平均线"
    description: str = ""
    category: str = ""
    input_specs: list[str] = field(default_factory=lambda: ["close"])
    output_specs: list[str] = field(default_factory=lambda: ["value"])
    param_schema: list[IndicatorParam] = field(default_factory=list)
    default_params: dict[str, Any] = field(default_factory=dict)
    meta: IndicatorMeta | None = None
    is_builtin: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "display_name": self.display_name or self.name,
            "description": self.description,
            "category": self.category,
            "inputs": self.input_specs,
            "outputs": self.output_specs,
            "params": self.default_params,
            "paramSchema": [p.to_dict() for p in self.param_schema],
            "is_builtin": self.is_builtin,
        }
