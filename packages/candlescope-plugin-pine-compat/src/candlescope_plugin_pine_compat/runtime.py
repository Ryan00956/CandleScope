"""Public-protocol bridge from CandleScope requests to Pine Compat Runtime.

The bridge intentionally targets the public ``pine-compat-runtime==0.2.0``
Release.  That release is a closed-bar batch engine: protocol v1 does not
advertise forming-bar or incremental execution and the bridge rejects those
inputs instead of approximating their semantics.
"""

from __future__ import annotations

import importlib
from importlib import metadata as importlib_metadata
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_HISTOGRAM_SERIES_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
    AnalyzeRequest,
    AnalyzeResult,
    BaseRuntimePlugin,
    Diagnostic,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    ProtocolError,
    RenderCollections,
    RenderOutput,
    RuntimeDescriptor,
)


RUNTIME_ID = "candlescope.pine-compat"
PLUGIN_NAME = "Pine Compatibility Runtime"
PLUGIN_PACKAGE = "candlescope-plugin-pine-compat"
PLUGIN_VERSION = "0.2.0"
ENGINE_PACKAGE = "pine-compat-runtime"
ENGINE_MODULE = "pine_compat"
EXPECTED_ENGINE_VERSION = "0.2.0"
UNKNOWN_SOURCE_VERSION = "0.0.0+unknown"

PINE_ANALYSIS_SCHEMA_VERSION = 5
PINE_RUNTIME_SCHEMA_VERSION = 8
PINE_RENDER_METADATA_VERSION = 1
MAX_BARS = 100_000
MAX_OUTPUT_SERIES = 1_024
MAX_OUTPUT_POINTS = 5_000_000

_PALETTE = (
    "#2962ff",
    "#f59e0b",
    "#10b981",
    "#ef4444",
    "#8b5cf6",
    "#06b6d4",
    "#ec4899",
    "#84cc16",
)
_HOST_BLOCKED_PREFIXES = (
    "strategy",
    "request.",
    "syminfo.",
    "timeframe.",
    "session.",
    "ticker.",
    "label.",
    "line.",
    "linefill.",
    "box.",
    "table.",
    "polyline.",
    "chart.",
    "import",
    "library",
)
_HOST_BLOCKED_EXACT = {"plotbar", "plotcandle", "plotchar", "plotarrow"}
_HOST_CHART_SYMBOL_FEATURES = frozenset(
    {"syminfo.prefix", "syminfo.ticker", "syminfo.tickerid"}
)
_HOST_CHART_TIMEFRAME_FEATURES = frozenset(
    {
        "timeframe.isdaily",
        "timeframe.isdwm",
        "timeframe.isintraday",
        "timeframe.isminutes",
        "timeframe.ismonthly",
        "timeframe.isseconds",
        "timeframe.isweekly",
        "timeframe.multiplier",
        "timeframe.period",
    }
)
_PINE_SECONDS_MULTIPLIERS = frozenset({1, 5, 10, 15, 30, 45})
_PINE_CONTEXT_TOKEN_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_CANDLESCOPE_INTERVAL_RE = re.compile(r"^(\d+)([smhdwM])$")
_UNMAPPABLE_OUTPUT_KEYS = (
    "plotChars",
    "plotArrows",
    "plotBars",
    "plotCandles",
    "labels",
    "lines",
    "lineFills",
    "polylines",
    "boxes",
    "tables",
    "strategy",
)
_PANE_DISPLAYS = {"display.all", "display.pane"}
_HIDDEN_DISPLAYS = {"display.none"}
_UNSUPPORTED_DISPLAYS = {
    "display.data_window",
    "display.price_scale",
    "display.status_line",
}


@dataclass(slots=True)
class BridgeError(ValueError):
    code: str
    message: str
    hint: str | None = None
    data: dict[str, Any] | None = None
    span: dict[str, int] | None = None

    def __str__(self) -> str:
        return self.message

    def diagnostic(self) -> Diagnostic:
        return Diagnostic(
            code=self.code,
            severity="error",
            message=self.message,
            hint=self.hint,
            span=self.span,
            data=dict(self.data or {}),
        )


def _engine_version() -> str:
    try:
        value = importlib_metadata.version(ENGINE_PACKAGE)
    except importlib_metadata.PackageNotFoundError:
        return UNKNOWN_SOURCE_VERSION
    return str(value or UNKNOWN_SOURCE_VERSION)


def _load_engine() -> Any:
    return importlib.import_module(ENGINE_MODULE)


def _engine_contract() -> tuple[Any, str]:
    engine = _load_engine()
    version = _engine_version()
    if version not in {EXPECTED_ENGINE_VERSION, UNKNOWN_SOURCE_VERSION}:
        raise RuntimeError(
            f"{PLUGIN_PACKAGE} requires {ENGINE_PACKAGE} "
            f"{EXPECTED_ENGINE_VERSION}, found {version}"
        )
    expected = {
        "ANALYSIS_SCHEMA_VERSION": PINE_ANALYSIS_SCHEMA_VERSION,
        "RUNTIME_SCHEMA_VERSION": PINE_RUNTIME_SCHEMA_VERSION,
        "RENDER_METADATA_VERSION": PINE_RENDER_METADATA_VERSION,
    }
    drift = [
        f"{name}={getattr(engine, name, None)!r} (expected {value})"
        for name, value in expected.items()
        if getattr(engine, name, None) != value
    ]
    if drift:
        raise RuntimeError("pine-compat-runtime schema mismatch: " + ", ".join(drift))
    if not callable(getattr(engine, "analyze_script", None)) or not callable(
        getattr(engine, "run_script", None)
    ):
        raise RuntimeError("pine-compat-runtime is missing its public batch API")
    return engine, version


def _descriptor() -> RuntimeDescriptor:
    _engine, version = _engine_contract()
    starter = (
        '//@version=6\nindicator("My Indicator", overlay=true)\n\n'
        'length = input.int(20, "Length", minval=1)\n'
        'ma = ta.sma(close, length)\nplot(ma, "MA", color=color.orange)\n'
    )
    chart_context = {
        "symbolFeatures": sorted(_HOST_CHART_SYMBOL_FEATURES),
        "timeframeFeatures": sorted(_HOST_CHART_TIMEFRAME_FEATURES),
    }
    return RuntimeDescriptor(
        id=RUNTIME_ID,
        name=PLUGIN_NAME,
        version=PLUGIN_VERSION,
        package=PLUGIN_PACKAGE,
        languages=(
            LanguageDescriptor(
                id="pine",
                name="Pine Script",
                extensions=(".pine",),
                aliases=("pine", "pinescript"),
            ),
        ),
        features=(
            FEATURE_SOURCE_ANALYSIS_V1,
            FEATURE_BATCH_EXECUTION_V1,
            FEATURE_RENDER_LINE_SERIES_V1,
            FEATURE_RENDER_HISTOGRAM_SERIES_V1,
            FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
        ),
        required_host_features=(
            FEATURE_BATCH_EXECUTION_V1,
            FEATURE_RENDER_LINE_SERIES_V1,
            FEATURE_RENDER_HISTOGRAM_SERIES_V1,
            FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
        ),
        meta={
            "engine": ENGINE_PACKAGE,
            "engineVersion": version,
            "expectedEngineVersion": EXPECTED_ENGINE_VERSION,
            "engineVersionVerified": version == EXPECTED_ENGINE_VERSION,
            "analysisSchemaVersion": PINE_ANALYSIS_SCHEMA_VERSION,
            "runtimeSchemaVersion": PINE_RUNTIME_SCHEMA_VERSION,
            "renderMetadataVersion": PINE_RENDER_METADATA_VERSION,
            "executorBoundary": "sidecar-inline",
            "sourceSnapshot": False,
            "closedBarsOnly": True,
            "formingBar": False,
            "incremental": False,
            "historyPlanning": "host-range-warmup",
            "hostCapabilities": {"chartContext": chart_context},
            "renderCoverage": [
                "plot.line",
                "plot.histogram",
                "plot.columns",
                "plotshape.supported-subset",
                "hline",
                "fill",
                "bgcolor",
                "barcolor",
                "alert",
            ],
            "unsupportedRenderKinds": list(_UNMAPPABLE_OUTPUT_KEYS),
            "ui": {
                "languages": {
                    "pine": {
                        "monacoLanguage": "pine",
                        "starterSource": starter,
                    }
                }
            },
        },
    )


def pine_chart_symbol(context: Any) -> str | None:
    exchange = str(context.exchange or "").strip().upper()
    symbol = str(context.symbol or "").strip().upper()
    market_type = str(context.market_type or "").strip().lower()
    if (
        not exchange
        or not symbol
        or exchange == "UNKNOWN"
        or symbol == "UNKNOWN"
        or not _PINE_CONTEXT_TOKEN_RE.fullmatch(exchange)
        or not _PINE_CONTEXT_TOKEN_RE.fullmatch(symbol)
    ):
        return None
    if market_type == "spot":
        ticker = symbol
    elif market_type in {"futures", "swap"}:
        if exchange == "BINANCE":
            ticker = symbol if symbol.endswith(".P") else f"{symbol}.P"
        elif symbol.endswith(("-SWAP", "-PERP", ".P")):
            ticker = symbol
        else:
            return None
    else:
        return None
    return f"{exchange}:{ticker}"


def pine_chart_timeframe(context: Any) -> str | None:
    match = _CANDLESCOPE_INTERVAL_RE.fullmatch(str(context.interval or "").strip())
    if not match:
        return None
    multiplier = int(match.group(1))
    unit = match.group(2)
    if multiplier <= 0:
        return None
    if unit == "s":
        return f"{multiplier}S" if multiplier in _PINE_SECONDS_MULTIPLIERS else None
    if unit == "m":
        return str(multiplier) if multiplier <= 1440 else None
    if unit == "h":
        minutes = multiplier * 60
        return str(minutes) if minutes <= 1440 else None
    limit, suffix = {"d": (365, "D"), "w": (52, "W"), "M": (12, "M")}[unit]
    if multiplier > limit:
        return None
    return suffix if multiplier == 1 else f"{multiplier}{suffix}"


def _host_bindings(context: Any) -> dict[str, str | None]:
    return {
        "chartSymbol": pine_chart_symbol(context),
        "chartTimeframe": pine_chart_timeframe(context),
    }


def _span(value: Any) -> dict[str, int] | None:
    if not isinstance(value, Mapping):
        return None
    result = {
        key: item
        for key, item in value.items()
        if key in {"line", "column", "endLine", "endColumn"}
        and isinstance(item, int)
        and not isinstance(item, bool)
    }
    return result or None


def _native_diagnostic(value: Any) -> Diagnostic:
    item = value if isinstance(value, Mapping) else {}
    severity = str(item.get("severity") or "error").lower()
    if severity not in {"error", "warning", "info"}:
        severity = "error"
    return Diagnostic(
        code=str(item.get("code") or "PINE_ANALYSIS_ERROR"),
        severity=severity,
        message=str(item.get("message") or "Pine analysis failed."),
        hint=(str(item["hint"]) if item.get("hint") else None),
        span=_span(item.get("span")),
    )


def _feature_is_host_blocked(
    feature: str,
    *,
    chart_symbol: str | None,
    chart_timeframe: str | None,
) -> bool:
    normalized = feature.strip().lower()
    if normalized in _HOST_CHART_SYMBOL_FEATURES and chart_symbol is not None:
        return False
    if normalized in _HOST_CHART_TIMEFRAME_FEATURES and chart_timeframe is not None:
        return False
    return normalized in _HOST_BLOCKED_EXACT or any(
        normalized == prefix.rstrip(".") or normalized.startswith(prefix)
        for prefix in _HOST_BLOCKED_PREFIXES
    )


def _analyze_native(source: str, context: Any) -> tuple[dict[str, Any], tuple[Diagnostic, ...]]:
    engine, _version = _engine_contract()
    raw = engine.analyze_script(source)
    if not isinstance(raw, Mapping):
        raise BridgeError("PINE_ANALYSIS_OUTPUT_INVALID", "Pine analysis must return an object.")
    analysis = dict(raw)
    if analysis.get("schemaVersion") != PINE_ANALYSIS_SCHEMA_VERSION:
        raise BridgeError(
            "PINE_SCHEMA_MISMATCH",
            "pine-compat-runtime analysis schema is incompatible with this plugin.",
            hint=(
                f"Expected {PINE_ANALYSIS_SCHEMA_VERSION}; "
                f"received {analysis.get('schemaVersion')!r}."
            ),
        )
    diagnostics = [_native_diagnostic(item) for item in analysis.get("diagnostics") or []]
    compatibility = analysis.get("compatibility")
    compatibility = compatibility if isinstance(compatibility, Mapping) else {}
    unsupported = [
        item
        for item in compatibility.get("unsupported") or []
        if isinstance(item, Mapping)
    ]
    if unsupported:
        features = sorted({str(item.get("feature") or "unknown") for item in unsupported})
        first = unsupported[0]
        diagnostics.append(
            Diagnostic(
                code="PINE_UNSUPPORTED_FEATURE",
                severity="error",
                message=f"pine-compat-runtime does not support: {', '.join(features)}",
                hint=str(first.get("reason") or "Rewrite the script or use a supported feature."),
                span=_span(first.get("span")),
                data={"unsupportedFeatures": features},
            )
        )
    bindings = _host_bindings(context)
    supported = [
        item for item in compatibility.get("supported") or [] if isinstance(item, Mapping)
    ]
    blocked = [
        item
        for item in supported
        if _feature_is_host_blocked(
            str(item.get("feature") or ""),
            chart_symbol=bindings["chartSymbol"],
            chart_timeframe=bindings["chartTimeframe"],
        )
    ]
    if blocked:
        features = sorted({str(item.get("feature") or "unknown") for item in blocked})
        diagnostics.append(
            Diagnostic(
                code="PINE_HOST_CAPABILITY_UNSUPPORTED",
                severity="error",
                message=f"CandleScope Pine protocol v1 does not host: {', '.join(features)}",
                hint=(
                    "Protocol v1 supports closed-bar indicator batches only; "
                    "context requests, strategies, imports, and native objects stay disabled."
                ),
                span=_span(blocked[0].get("span")),
                data={"blockedFeatures": features},
            )
        )
    if not bool(analysis.get("executable")) and not any(
        item.severity == "error" for item in diagnostics
    ):
        diagnostics.append(
            Diagnostic(
                code="PINE_NOT_EXECUTABLE",
                severity="error",
                message="Pine analysis did not produce an executable indicator.",
            )
        )
    return analysis, tuple(diagnostics)


def _normalize_bars(request: ExecuteBatchRequest) -> tuple[list[dict[str, float | int]], list[int]]:
    if len(request.bars) > MAX_BARS:
        raise BridgeError(
            "PINE_INPUT_LIMIT_EXCEEDED",
            f"Too many Pine bars: {len(request.bars)} > {MAX_BARS}",
        )
    runtime_bars: list[dict[str, float | int]] = []
    host_times: list[int] = []
    previous_runtime_time: int | None = None
    for index, bar in enumerate(request.bars):
        if not bar.is_closed:
            raise BridgeError(
                "PINE_CLOSED_BARS_REQUIRED",
                f"Pine protocol v1 received a forming bar at index {index}.",
                hint="Wait for BAR_CLOSED or use a future realtime protocol revision.",
            )
        timestamp = bar.time
        if timestamp <= 0:
            raise BridgeError("PINE_INVALID_INPUT", f"OHLCV bar {index} has non-positive time")
        if timestamp < 100_000_000_000:
            host_time = timestamp
            runtime_time = timestamp * 1000
        else:
            if timestamp >= 10_000_000_000_000 or timestamp % 1000 != 0:
                raise BridgeError(
                    "PINE_INVALID_INPUT",
                    f"OHLCV bar {index} must use whole seconds or milliseconds",
                )
            runtime_time = timestamp
            host_time = timestamp // 1000
        if previous_runtime_time is not None and runtime_time <= previous_runtime_time:
            relation = "duplicate" if runtime_time == previous_runtime_time else "unsorted"
            raise BridgeError(
                "PINE_INVALID_INPUT",
                f"OHLCV bar times must be strictly increasing ({relation} at index {index})",
            )
        if bar.high < max(bar.open, bar.low, bar.close):
            raise BridgeError("PINE_INVALID_INPUT", f"OHLCV bar {index} has an invalid high")
        if bar.low > min(bar.open, bar.high, bar.close):
            raise BridgeError("PINE_INVALID_INPUT", f"OHLCV bar {index} has an invalid low")
        if bar.volume < 0:
            raise BridgeError("PINE_INVALID_INPUT", f"OHLCV bar {index} has negative volume")
        previous_runtime_time = runtime_time
        host_times.append(host_time)
        runtime_bars.append(
            {
                "time": runtime_time,
                "open": bar.open,
                "high": bar.high,
                "low": bar.low,
                "close": bar.close,
                "volume": bar.volume,
            }
        )
    return runtime_bars, host_times


def _normalize_overrides(params: Mapping[str, Any], analysis: Mapping[str, Any]) -> dict[int, Any]:
    inputs = {
        int(item["callSiteId"]): item
        for item in analysis.get("inputs") or []
        if isinstance(item, Mapping) and isinstance(item.get("callSiteId"), int)
    }
    overrides: dict[int, Any] = {}
    for raw_key, value in params.items():
        try:
            key = int(raw_key)
        except (TypeError, ValueError) as exc:
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter key {raw_key!r} is not an input callSiteId integer",
            ) from exc
        if key < 0 or raw_key.strip() != str(key):
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter key {raw_key!r} is not a canonical input callSiteId",
            )
        if key not in inputs:
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter {key} does not match an input in this script",
            )
        if isinstance(value, float) and not math.isfinite(value):
            raise BridgeError("PINE_INVALID_PARAMS", f"Pine parameter {key} must be finite")
        if not isinstance(value, (str, int, float, bool)):
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter {key} must be a string, number, or boolean",
            )
        spec = inputs[key]
        name = str(spec.get("name") or "input")
        if name in {"input.int", "input.time"} and (
            isinstance(value, bool) or not isinstance(value, int)
        ):
            raise BridgeError("PINE_INVALID_PARAMS", f"Pine parameter {key} must be an integer")
        if name in {"input.float", "input.price"} and (
            isinstance(value, bool) or not isinstance(value, (int, float))
        ):
            raise BridgeError("PINE_INVALID_PARAMS", f"Pine parameter {key} must be numeric")
        if name == "input.bool" and not isinstance(value, bool):
            raise BridgeError("PINE_INVALID_PARAMS", f"Pine parameter {key} must be boolean")
        if name == "input.color" and (
            isinstance(value, bool) or not isinstance(value, (int, str))
        ):
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter {key} must be a color integer or string",
            )
        if name == "input.color" and isinstance(value, int) and not 0 <= value <= 0xFFFFFFFF:
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter {key} color integer must fit in u32",
            )
        if name == "input.source":
            raise BridgeError(
                "PINE_INVALID_PARAMS",
                f"Pine parameter {key} cannot override input.source in this host",
            )
        if name in {
            "input.string",
            "input.symbol",
            "input.timeframe",
            "input.session",
            "input.text_area",
        } and not isinstance(value, str):
            raise BridgeError("PINE_INVALID_PARAMS", f"Pine parameter {key} must be a string")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            minimum = spec.get("min")
            maximum = spec.get("max")
            if isinstance(minimum, (int, float)) and value < minimum:
                raise BridgeError(
                    "PINE_INVALID_PARAMS", f"Pine parameter {key} is below its minimum"
                )
            if isinstance(maximum, (int, float)) and value > maximum:
                raise BridgeError(
                    "PINE_INVALID_PARAMS", f"Pine parameter {key} is above its maximum"
                )
        options = spec.get("options")
        if isinstance(options, list) and options and value not in options:
            raise BridgeError(
                "PINE_INVALID_PARAMS", f"Pine parameter {key} is not one of its options"
            )
        overrides[key] = value
    return overrides


def _infer_pane(source: str, render_hints: Mapping[str, Any] | None) -> str:
    target = str((render_hints or {}).get("paneTarget") or "").strip().lower()
    if target in {"main", "overlay"}:
        return "main"
    if target in {"separate", "pane", "indicator"}:
        return "separate"
    declaration = re.search(r"\bindicator\s*\((.*?)\)", source, re.IGNORECASE | re.DOTALL)
    if declaration and re.search(
        r"\boverlay\s*=\s*true\b", declaration.group(1), re.IGNORECASE
    ):
        return "main"
    return "separate"


def _css_color(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value:
        return value
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return fallback
    has_alpha_flag = bool(value & (1 << 32))
    payload = value & 0xFFFFFFFF
    if not has_alpha_flag and payload <= 0xFFFFFF:
        return f"#{payload:06x}"
    red = (payload >> 24) & 0xFF
    green = (payload >> 16) & 0xFF
    blue = (payload >> 8) & 0xFF
    alpha = (payload & 0xFF) / 255
    return f"rgba({red},{green},{blue},{alpha:.3f})"


def _value_at(values: Any, index: int) -> Any:
    return values[index] if isinstance(values, list) and index < len(values) else None


def _visible_source_index(index: int, total: int, show_last: int | None) -> bool:
    return show_last is None or index >= max(total - show_last, 0)


def _target_time(host_times: list[int], index: int, offset: int) -> int | None:
    target = index + offset
    return host_times[target] if 0 <= target < len(host_times) else None


def _render_settings(item: Mapping[str, Any], *, base_pane: str, fallback_title: str) -> dict[str, Any]:
    offset = item.get("offset", 0)
    show_last = item.get("showLast")
    if isinstance(offset, bool) or not isinstance(offset, int):
        raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"{fallback_title} has invalid offset")
    if show_last is not None and (
        isinstance(show_last, bool) or not isinstance(show_last, int) or show_last < 0
    ):
        raise BridgeError(
            "PINE_RUNTIME_OUTPUT_INVALID", f"{fallback_title} has invalid show_last"
        )
    display = str(item.get("display") or "display.all").lower()
    if display in _UNSUPPORTED_DISPLAYS or display not in _PANE_DISPLAYS | _HIDDEN_DISPLAYS:
        raise BridgeError(
            "PINE_HOST_DISPLAY_UNSUPPORTED",
            f"CandleScope cannot faithfully host Pine display mode {display!r}",
        )
    force_overlay = item.get("forceOverlay", False)
    if not isinstance(force_overlay, bool):
        raise BridgeError(
            "PINE_RUNTIME_OUTPUT_INVALID", f"{fallback_title} has invalid force_overlay"
        )
    title = item.get("title")
    if title in {None, ""}:
        title = fallback_title
    if not isinstance(title, str):
        raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"{fallback_title} has invalid title")
    return {
        "offset": offset,
        "showLast": show_last,
        "paneVisible": display in _PANE_DISPLAYS,
        "pane": "main" if force_overlay else base_pane,
        "title": title,
    }


def _is_active(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(float(value)) and float(value) != 0.0
    return bool(value)


def _marker_position(value: Any) -> str | None:
    normalized = str(value or "abovebar").lower().removeprefix("location.")
    if normalized in {"belowbar", "bottom"}:
        return "below"
    if normalized in {"abovebar", "top"}:
        return "above"
    return None


def _marker_size(value: Any) -> int | None:
    return {
        "tiny": 1,
        "small": 2,
        "normal": 3,
        "large": 4,
        "huge": 5,
        "auto": 2,
    }.get(str(value or "size.auto").lower().removeprefix("size."))


def _pine_line_style(value: Any) -> int:
    normalized = str(value or "hline.style_solid").lower()
    styles = {
        "hline.style_solid": 0,
        "hline.style_dotted": 1,
        "hline.style_dashed": 2,
    }
    if normalized not in styles:
        raise BridgeError(
            "PINE_HOST_RENDER_STYLE_UNSUPPORTED", f"Unsupported hline style: {normalized}"
        )
    return styles[normalized]


def _input_type(name: str) -> str:
    return {
        "input.int": "int",
        "input.float": "float",
        "input.bool": "bool",
        "input.string": "string",
        "input.color": "color",
        "input.source": "source",
        "input.timeframe": "timeframe",
        "input.symbol": "symbol",
        "input.session": "session",
        "input.time": "time",
        "input.price": "float",
        "input.text_area": "string",
    }.get(name, "string")


def _param_schema(analysis: Mapping[str, Any], overrides: Mapping[int, Any]) -> tuple[dict[str, Any], ...]:
    schema: list[dict[str, Any]] = []
    for raw in analysis.get("inputs") or []:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("callSiteId"), int):
            continue
        call_site_id = int(raw["callSiteId"])
        name = str(raw.get("name") or "input")
        title = str(raw.get("title") or f"Input {call_site_id}")
        item: dict[str, Any] = {
            "id": str(call_site_id),
            "key": str(call_site_id),
            "callSiteId": call_site_id,
            "type": _input_type(name),
            "title": title,
            "label": title,
            "pineInput": name,
        }
        for key in ("default", "min", "max", "step", "options"):
            if raw.get(key) is not None:
                item[key] = raw[key]
        if call_site_id in overrides:
            item["current"] = overrides[call_site_id]
        elif raw.get("default") is not None:
            item["current"] = raw["default"]
        schema.append(item)
    return tuple(schema)


def _line_series(record: Mapping[str, Any], *, histogram: bool) -> LineSeries:
    points = tuple(
        LinePoint(time=point["time"], value=point.get("value"), color=point.get("color"))
        for point in record.get("data") or []
        if isinstance(point, Mapping)
    )
    color = record.get("color_up") if histogram else record.get("color")
    style: dict[str, Any] = {
        "color": color or _PALETTE[0],
        "lineWidth": record.get("linewidth", 1),
        "lineStyle": record.get("linestyle", 0),
    }
    if record.get("colorData"):
        style["colorData"] = record["colorData"]
    return LineSeries(
        id=str(record["id"]),
        title=str(record.get("title") or record["id"]),
        points=points,
        pane=str(record.get("pane") or "separate"),
        style=style,
        series_type="histogram" if histogram else "line",
    )


def _normalize_output(
    raw_value: Any,
    *,
    source: str,
    host_times: list[int],
    analysis: Mapping[str, Any],
    overrides: Mapping[int, Any],
    render_hints: Mapping[str, Any] | None,
    host_bindings: Mapping[str, str | None],
) -> tuple[RenderOutput, tuple[dict[str, Any], ...], dict[str, Any]]:
    if not isinstance(raw_value, Mapping):
        raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine runtime output must be an object")
    raw = dict(raw_value)
    if raw.get("schemaVersion") != PINE_RUNTIME_SCHEMA_VERSION:
        raise BridgeError(
            "PINE_SCHEMA_MISMATCH",
            "pine-compat-runtime execution schema is incompatible with this plugin.",
            hint=(
                f"Expected {PINE_RUNTIME_SCHEMA_VERSION}; "
                f"received {raw.get('schemaVersion')!r}."
            ),
        )
    unsupported = [key for key in _UNMAPPABLE_OUTPUT_KEYS if raw.get(key)]
    if unsupported:
        raise BridgeError(
            "PINE_HOST_OUTPUT_UNSUPPORTED",
            "CandleScope Pine protocol v1 cannot render output collections: "
            + ", ".join(unsupported),
            hint=(
                "Use plot, the supported plotshape subset, hline, fill, bgcolor, "
                "barcolor, or alert."
            ),
            data={"unsupportedOutputCollections": unsupported},
        )
    runtime_diagnostics = [
        item for item in raw.get("diagnostics") or [] if isinstance(item, Mapping)
    ]
    if runtime_diagnostics:
        first = runtime_diagnostics[0]
        raise BridgeError(
            str(first.get("code") or "PINE_RUNTIME_DIAGNOSTIC"),
            str(first.get("message") or "Pine runtime reported a diagnostic"),
            span=_span(first.get("span")),
        )

    pane = _infer_pane(source, render_hints)
    lines: list[dict[str, Any]] = []
    histograms: list[dict[str, Any]] = []
    markers: list[dict[str, Any]] = []
    bgcolors: list[dict[str, Any]] = []
    barcolors: list[dict[str, Any]] = []
    hlines: list[dict[str, Any]] = []
    fills: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []

    for plot_index, plot_value in enumerate(raw.get("plots") or []):
        if not isinstance(plot_value, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine plot must be an object")
        plot = dict(plot_value)
        plot_id = plot.get("id", plot_index)
        settings = _render_settings(plot, base_pane=pane, fallback_title=f"Plot {plot_id}")
        style = str(plot.get("style") or "plot.style_line").lower()
        histogram = style in {"plot.style_histogram", "plot.style_columns"}
        if style != "plot.style_line" and not histogram:
            raise BridgeError(
                "PINE_HOST_RENDER_STYLE_UNSUPPORTED",
                f"CandleScope cannot faithfully render {style}",
                hint="Protocol v1 supports line, histogram, and columns plots.",
                data={"plotId": plot_id, "plotStyle": style},
            )
        line_width = plot.get("lineWidth", 1)
        if isinstance(line_width, bool) or not isinstance(line_width, int) or line_width <= 0:
            raise BridgeError(
                "PINE_RUNTIME_OUTPUT_INVALID", f"Plot {plot_id} has invalid linewidth"
            )
        hist_base = plot.get("histBase", 0)
        if (
            isinstance(hist_base, bool)
            or not isinstance(hist_base, (int, float))
            or not math.isfinite(float(hist_base))
        ):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"Plot {plot_id} has invalid histbase")
        values = plot.get("values") or []
        colors = plot.get("colors") or []
        if not isinstance(values, list) or not isinstance(colors, list):
            raise BridgeError(
                "PINE_RUNTIME_OUTPUT_INVALID", f"Plot {plot_id} values/colors must be arrays"
            )
        default_color = _PALETTE[plot_index % len(_PALETTE)]
        has_default_color = False
        data: list[dict[str, Any]] = []
        color_data: list[dict[str, Any]] = []
        for index, value in enumerate(values):
            if index >= len(host_times) or not _visible_source_index(
                index, len(host_times), settings["showLast"]
            ):
                continue
            target_time = _target_time(host_times, index, settings["offset"])
            if target_time is None or not (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            ):
                continue
            point: dict[str, Any] = {"time": target_time, "value": value}
            color_value = _value_at(colors, index)
            if color_value is not None:
                point_color = _css_color(color_value, default_color)
                point["color"] = point_color
                color_data.append({"time": target_time, "color": point_color})
                if not has_default_color:
                    default_color = point_color
                    has_default_color = True
            data.append(point)
        record: dict[str, Any] = {
            "id": f"pine-plot-{plot_id}",
            "title": settings["title"],
            "pane": settings["pane"],
            "data": data,
            "linewidth": line_width,
            "linestyle": 0,
            "base": float(hist_base),
            "trackPrice": bool(plot.get("trackPrice", False)),
            "visible": settings["paneVisible"],
        }
        if color_data:
            record["colorData"] = color_data
            record["per_bar_color"] = True
        if histogram:
            record["color_up"] = default_color
            record["color_down"] = default_color
            histograms.append(record)
        else:
            record["color"] = default_color
            lines.append(record)

    def add_marker_series(item: Mapping[str, Any], index: int) -> None:
        marker_id = item.get("id", index)
        settings = _render_settings(
            item, base_pane=pane, fallback_title=f"plotshape {marker_id}"
        )
        if not settings["paneVisible"]:
            return
        values = item.get("values") or []
        if not isinstance(values, list):
            raise BridgeError(
                "PINE_RUNTIME_OUTPUT_INVALID", f"plotshape {marker_id} values must be an array"
            )
        points: list[dict[str, Any]] = []
        default_color = _PALETTE[(len(lines) + len(histograms) + index) % len(_PALETTE)]
        for value_index, value in enumerate(values):
            if value_index >= len(host_times) or not _visible_source_index(
                value_index, len(host_times), settings["showLast"]
            ):
                continue
            target_time = _target_time(host_times, value_index, settings["offset"])
            if target_time is None:
                continue
            location_value = _value_at(item.get("locations"), value_index)
            absolute = str(location_value or "").lower().endswith("absolute")
            active = (
                value is not None
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                if absolute
                else _is_active(value)
            )
            if not active:
                continue
            shape = str(
                _value_at(item.get("styles"), value_index) or "shape.xcross"
            ).lower().removeprefix("shape.")
            shape_map = {
                "circle": "circle",
                "square": "square",
                "triangleup": "arrowUp",
                "triangledown": "arrowDown",
                "arrowup": "arrowUp",
                "arrowdown": "arrowDown",
            }
            if shape not in shape_map:
                raise BridgeError(
                    "PINE_HOST_RENDER_STYLE_UNSUPPORTED",
                    f"CandleScope cannot faithfully render plotshape style {shape!r}",
                    data={"markerId": marker_id, "markerStyle": shape},
                )
            position = "atPrice" if absolute else _marker_position(location_value)
            if position is None:
                raise BridgeError(
                    "PINE_HOST_RENDER_STYLE_UNSUPPORTED",
                    f"CandleScope cannot faithfully render plotshape location {location_value!r}",
                    data={"markerId": marker_id},
                )
            point_color = _css_color(
                _value_at(item.get("colors"), value_index), default_color
            )
            text = str(_value_at(item.get("texts"), value_index) or "")
            text_color = _value_at(item.get("textColors"), value_index)
            if text and text_color is not None and _css_color(text_color, point_color) != point_color:
                raise BridgeError(
                    "PINE_HOST_RENDER_STYLE_UNSUPPORTED",
                    "CandleScope markers cannot use a text color different from the shape color",
                    data={"markerId": marker_id},
                )
            size = _marker_size(_value_at(item.get("sizes"), value_index))
            if size is None:
                raise BridgeError(
                    "PINE_HOST_RENDER_STYLE_UNSUPPORTED",
                    f"CandleScope cannot render plotshape size at index {value_index}",
                )
            point = {
                "time": target_time,
                "shape": shape_map[shape],
                "color": point_color,
                "text": text,
                "position": position,
                "size": size,
                "pane": settings["pane"],
            }
            if absolute and isinstance(value, (int, float)) and not isinstance(value, bool):
                point["value"] = value
            points.append(point)
        if points:
            first = points[0]
            markers.append(
                {
                    "id": f"pine-plotshape-{marker_id}",
                    "title": settings["title"],
                    "shape": first["shape"],
                    "color": first["color"],
                    "text": first["text"],
                    "position": first["position"],
                    "size": first["size"],
                    "pane": settings["pane"],
                    "data": points,
                }
            )

    for index, item in enumerate(raw.get("plotShapes") or []):
        if not isinstance(item, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine plotshape must be an object")
        add_marker_series(item, index)

    for index, item in enumerate(raw.get("bgColors") or []):
        if not isinstance(item, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine bgcolor must be an object")
        item_id = item.get("id", index)
        settings = _render_settings(item, base_pane=pane, fallback_title=f"Background {item_id}")
        if not settings["paneVisible"]:
            continue
        regions = []
        for value_index, value in enumerate(item.get("values") or []):
            if value_index >= len(host_times) or value is None or not _visible_source_index(
                value_index, len(host_times), settings["showLast"]
            ):
                continue
            target = _target_time(host_times, value_index, settings["offset"])
            if target is not None:
                regions.append(
                    {"time": target, "color": _css_color(value, "rgba(59,130,246,0.1)")}
                )
        if regions:
            bgcolors.append(
                {
                    "id": f"pine-bgcolor-{item_id}",
                    "title": settings["title"],
                    "color": regions[0]["color"],
                    "pane": settings["pane"],
                    "regions": regions,
                }
            )

    for index, item in enumerate(raw.get("barColors") or []):
        if not isinstance(item, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine barcolor must be an object")
        item_id = item.get("id", index)
        settings = _render_settings(item, base_pane="main", fallback_title=f"Bars {item_id}")
        if not settings["paneVisible"]:
            continue
        data = []
        for value_index, value in enumerate(item.get("values") or []):
            if value_index >= len(host_times) or value is None or not _visible_source_index(
                value_index, len(host_times), settings["showLast"]
            ):
                continue
            target = _target_time(host_times, value_index, settings["offset"])
            if target is not None:
                data.append({"time": target, "color": _css_color(value, "#787b86")})
        if data:
            barcolors.append(
                {"id": f"pine-barcolor-{item_id}", "title": settings["title"], "data": data}
            )

    raw_hlines: dict[Any, dict[str, Any]] = {}
    for index, item in enumerate(raw.get("hlines") or []):
        if not isinstance(item, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine hline must be an object")
        item_id = item.get("id", index)
        price = item.get("price")
        if (
            isinstance(price, bool)
            or not isinstance(price, (int, float))
            or not math.isfinite(float(price))
        ):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"HLine {item_id} has invalid price")
        settings = _render_settings(item, base_pane=pane, fallback_title=f"HLine {item_id}")
        raw_hlines[item_id] = {**item, "_settings": settings}
        if settings["paneVisible"]:
            hlines.append(
                {
                    "id": f"pine-hline-{item_id}",
                    "price": price,
                    "title": settings["title"],
                    "color": _css_color(item.get("color"), "#787b86"),
                    "linestyle": _pine_line_style(item.get("lineStyle")),
                    "linewidth": int(item.get("lineWidth", 1)),
                    "pane": settings["pane"],
                }
            )

    hidden_hlines: set[Any] = set()
    for index, item in enumerate(raw.get("fills") or []):
        if not isinstance(item, Mapping):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", "Pine fill must be an object")
        item_id = item.get("id", index)
        settings = _render_settings(item, base_pane=pane, fallback_title=f"Fill {item_id}")
        if not settings["paneVisible"]:
            continue
        first_id = item.get("firstId")
        second_id = item.get("secondId")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (first_id, second_id)):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"Fill {item_id} has invalid endpoints")
        endpoint_ids: list[str] = []
        for endpoint, is_hline in (
            (first_id, bool(item.get("firstIsHLine", first_id in raw_hlines))),
            (second_id, bool(item.get("secondIsHLine", second_id in raw_hlines))),
        ):
            if is_hline:
                source_hline = raw_hlines.get(endpoint)
                if source_hline is None:
                    raise BridgeError(
                        "PINE_RUNTIME_OUTPUT_INVALID", f"Fill {item_id} references missing hline"
                    )
                local_id = f"pine-hline-fill-{endpoint}"
                endpoint_ids.append(local_id)
                if endpoint not in hidden_hlines:
                    lines.append(
                        {
                            "id": local_id,
                            "title": f"Fill endpoint {endpoint}",
                            "color": "rgba(0,0,0,0)",
                            "linewidth": 1,
                            "linestyle": 0,
                            "pane": settings["pane"],
                            "visible": False,
                            "data": [
                                {"time": timestamp, "value": source_hline["price"]}
                                for timestamp in host_times
                            ],
                        }
                    )
                    hidden_hlines.add(endpoint)
            else:
                local_id = f"pine-plot-{endpoint}"
                if not any(record.get("id") == local_id for record in (*lines, *histograms)):
                    raise BridgeError(
                        "PINE_RUNTIME_OUTPUT_INVALID", f"Fill {item_id} references missing plot"
                    )
                endpoint_ids.append(local_id)
        fill_gaps = item.get("fillGaps", True)
        if not isinstance(fill_gaps, bool):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"Fill {item_id} has invalid fillgaps")
        color_values = item.get("colors") or []
        if not isinstance(color_values, list):
            raise BridgeError("PINE_RUNTIME_OUTPUT_INVALID", f"Fill {item_id} colors must be an array")
        fallback_color = "rgba(59,130,246,0.12)"
        color_data = []
        for value_index, value in enumerate(color_values):
            if value_index >= len(host_times) or value is None or not _visible_source_index(
                value_index, len(host_times), settings["showLast"]
            ):
                continue
            color = _css_color(value, fallback_color)
            if not color_data:
                fallback_color = color
            color_data.append({"time": host_times[value_index], "color": color})
        if color_values and not color_data:
            continue
        fill = {
            "id": f"pine-fill-{item_id}",
            "plot1_id": endpoint_ids[0],
            "plot2_id": endpoint_ids[1],
            "title": settings["title"],
            "color": fallback_color,
            "fillGaps": fill_gaps,
            "pane": settings["pane"],
        }
        if color_data:
            fill["colorData"] = color_data
        fills.append(fill)

    for index, alert in enumerate(raw.get("alerts") or []):
        if not isinstance(alert, Mapping):
            continue
        bar_index = alert.get("barIndex")
        event_time = (
            host_times[bar_index]
            if isinstance(bar_index, int) and 0 <= bar_index < len(host_times)
            else int(alert.get("time") or 0) // 1000
        )
        message = str(alert.get("message") or "Pine alert")
        signals.append(
            {
                "id": f"pine-alert-{alert.get('id', index)}-{index}",
                "name": str(alert.get("source") or "alert"),
                "side": "alert",
                "message": message,
                "pane": pane,
                "data": [
                    {
                        "time": event_time,
                        "side": "alert",
                        "name": "alert",
                        "message": message,
                    }
                ],
            }
        )

    series_count = sum(
        len(value)
        for value in (lines, histograms, markers, bgcolors, barcolors, hlines, fills, signals)
    )
    point_count = (
        sum(len(item.get("data") or []) for item in (*lines, *histograms, *markers, *barcolors, *signals))
        + sum(len(item.get("regions") or []) for item in bgcolors)
        + len(hlines)
        + len(fills)
    )
    if series_count > MAX_OUTPUT_SERIES or point_count > MAX_OUTPUT_POINTS:
        raise BridgeError(
            "PINE_OUTPUT_LIMIT_EXCEEDED",
            (
                f"Pine output exceeds limits: series={series_count}/{MAX_OUTPUT_SERIES}, "
                f"points={point_count}/{MAX_OUTPUT_POINTS}"
            ),
        )
    series = tuple(_line_series(item, histogram=False) for item in lines) + tuple(
        _line_series(item, histogram=True) for item in histograms
    )
    collections = RenderCollections(
        lines=tuple(lines),
        histograms=tuple(histograms),
        markers=tuple(markers),
        hlines=tuple(hlines),
        fills=tuple(fills),
        bgcolors=tuple(bgcolors),
        barcolors=tuple(barcolors),
        signals=tuple(signals),
    )
    supported_features = [
        str(item.get("feature"))
        for item in (analysis.get("compatibility") or {}).get("supported", [])
        if isinstance(item, Mapping) and item.get("feature")
    ]
    meta = {
        "engine": ENGINE_PACKAGE,
        "runtimeSchemaVersion": PINE_RUNTIME_SCHEMA_VERSION,
        "analysisSchemaVersion": PINE_ANALYSIS_SCHEMA_VERSION,
        "renderMetadataVersion": raw.get("renderMetadataVersion"),
        "renderMetadata": (
            "pine-native"
            if raw.get("renderMetadataVersion") == PINE_RENDER_METADATA_VERSION
            else "host-defaults"
        ),
        "languageVersion": analysis.get("languageVersion"),
        "closedBarsOnly": True,
        "formingBar": False,
        "incremental": False,
        "pane": pane,
        "supportedFeatures": supported_features,
        "outputSeries": series_count,
        "outputPoints": point_count,
        "hostBindings": dict(host_bindings),
    }
    return (
        RenderOutput(series=series, collections=collections, meta=meta),
        _param_schema(analysis, overrides),
        meta,
    )


class PineCompatRuntimePlugin(BaseRuntimePlugin):
    """Expose the independently released Pine engine through protocol v1."""

    def describe(self) -> RuntimeDescriptor:
        return _descriptor()

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        try:
            analysis, diagnostics = _analyze_native(request.source, request.context)
        except BridgeError as exc:
            return AnalyzeResult(ok=False, executable=False, diagnostics=(exc.diagnostic(),))
        except Exception as exc:
            return AnalyzeResult(
                ok=False,
                executable=False,
                diagnostics=(
                    Diagnostic(
                        code="PINE_BRIDGE_ANALYSIS_FAILED",
                        severity="error",
                        message="Pine source analysis failed unexpectedly.",
                        data={"exceptionType": type(exc).__name__},
                    ),
                ),
            )
        executable = bool(analysis.get("executable")) and not any(
            item.severity == "error" for item in diagnostics
        )
        bindings = _host_bindings(request.context)
        return AnalyzeResult(
            ok=executable,
            executable=executable,
            diagnostics=diagnostics,
            inputs=tuple(
                dict(item)
                for item in analysis.get("inputs") or []
                if isinstance(item, Mapping)
            ),
            meta={
                "engine": ENGINE_PACKAGE,
                "nativeExecutable": bool(analysis.get("executable")),
                "analysisSchemaVersion": analysis.get("schemaVersion"),
                "languageVersion": analysis.get("languageVersion"),
                "languageVersionOrigin": analysis.get("languageVersionOrigin"),
                "dialect": analysis.get("dialect"),
                "scriptMode": analysis.get("scriptMode"),
                "closedBarsOnly": True,
                "formingBar": False,
                "incremental": False,
                "hostBindings": bindings,
                "compatibility": dict(analysis.get("compatibility") or {}),
            },
        )

    def execute_batch(self, request: ExecuteBatchRequest) -> ExecuteBatchResult:
        try:
            analysis, diagnostics = _analyze_native(request.source, request.context)
            error = next((item for item in diagnostics if item.severity == "error"), None)
            if error is not None:
                return ExecuteBatchResult(ok=False, diagnostics=diagnostics)
            runtime_bars, host_times = _normalize_bars(request)
            overrides = _normalize_overrides(request.params, analysis)
            bindings = _host_bindings(request.context)
            engine, _version = _engine_contract()
            options: dict[str, Any] = {"input_overrides": overrides}
            if bindings["chartSymbol"] is not None:
                options["chart_symbol"] = bindings["chartSymbol"]
            if bindings["chartTimeframe"] is not None:
                options["chart_timeframe"] = bindings["chartTimeframe"]
            raw = engine.run_script(request.source, runtime_bars, **options)
            render_hints = request.options.get("renderHints")
            if not isinstance(render_hints, Mapping):
                render_hints = None
            output, inputs, meta = _normalize_output(
                raw,
                source=request.source,
                host_times=host_times,
                analysis=analysis,
                overrides=overrides,
                render_hints=render_hints,
                host_bindings=bindings,
            )
            return ExecuteBatchResult(
                ok=True,
                output=output,
                diagnostics=tuple(item for item in diagnostics if item.severity != "error"),
                inputs=inputs,
                meta=meta,
            )
        except BridgeError as exc:
            return ExecuteBatchResult(ok=False, diagnostics=(exc.diagnostic(),))
        except (ProtocolError, TypeError, ValueError) as exc:
            return ExecuteBatchResult(
                ok=False,
                diagnostics=(
                    Diagnostic(
                        code="PINE_BRIDGE_OUTPUT_INVALID",
                        severity="error",
                        message=(
                            "Pine returned output that cannot be represented by Render IR v1."
                        ),
                        hint=str(exc),
                    ),
                ),
            )
        except Exception as exc:
            return ExecuteBatchResult(
                ok=False,
                diagnostics=(
                    Diagnostic(
                        code="PINE_BRIDGE_EXECUTION_FAILED",
                        severity="error",
                        message="Pine execution failed unexpectedly.",
                        hint=(
                            f"The runtime raised {type(exc).__name__}; "
                            "inspect the plugin health logs."
                        ),
                    ),
                ),
            )


__all__ = [
    "EXPECTED_ENGINE_VERSION",
    "PLUGIN_VERSION",
    "RUNTIME_ID",
    "PineCompatRuntimePlugin",
    "pine_chart_symbol",
    "pine_chart_timeframe",
]
