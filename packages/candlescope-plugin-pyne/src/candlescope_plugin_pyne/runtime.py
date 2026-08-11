"""Public-protocol bridge from CandleScope requests to Pyne Runtime."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

import pyne_runtime
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


RUNTIME_ID = "candlescope.pyne"
PLUGIN_NAME = "Pyne Runtime"
PLUGIN_PACKAGE = "candlescope-plugin-pyne"
PLUGIN_VERSION = "0.3.0.dev0"
EXPECTED_PYNE_VERSION = "0.3.0rc2"
UNKNOWN_SOURCE_VERSION = "0.0.0+unknown"

_SECURITY_MODE_KEYS = ("securityMode", "security_mode")
_SECURITY_MODES = frozenset({"safe", "research", "unsafe"})
_INVALID_IDENTIFIER = re.compile(r"[^a-z0-9._-]+")


class BridgeOutputError(ValueError):
    """Raised when Pyne returns data that cannot be represented by Render IR v1."""


def _engine_version() -> str:
    value = getattr(pyne_runtime, "__version__", UNKNOWN_SOURCE_VERSION)
    return str(value or UNKNOWN_SOURCE_VERSION)


def _descriptor() -> RuntimeDescriptor:
    actual_engine_version = _engine_version()
    if actual_engine_version not in {EXPECTED_PYNE_VERSION, UNKNOWN_SOURCE_VERSION}:
        raise RuntimeError(
            "candlescope-plugin-pyne requires pyne-runtime "
            f"{EXPECTED_PYNE_VERSION}, found {actual_engine_version}"
        )
    return RuntimeDescriptor(
        id=RUNTIME_ID,
        name=PLUGIN_NAME,
        version=PLUGIN_VERSION,
        package=PLUGIN_PACKAGE,
        languages=(
            LanguageDescriptor(
                id="pyne",
                name="Pyne",
                extensions=(".pyne",),
                aliases=("pyne",),
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
            "engine": "pyne-runtime",
            "engineVersion": actual_engine_version,
            "expectedEngineVersion": EXPECTED_PYNE_VERSION,
            "engineVersionVerified": actual_engine_version == EXPECTED_PYNE_VERSION,
            "executorBoundary": "sidecar-inline",
            "renderCoverage": [
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
            ],
            "unsupportedRenderKinds": [],
            "extensionProtocols": [
                "candlescope.pyne-session/2",
                "candlescope.pyne-data-broker/1",
            ],
            "v1Fallback": {
                "protocol": "candlescope.script-runtime/1",
                "method": "executeBatch",
                "sessionState": False,
                "brokeredData": False,
            },
        },
    )


def _options_error(message: str) -> Diagnostic:
    return Diagnostic(
        code="PYNE_BRIDGE_OPTIONS_INVALID",
        severity="error",
        message=message,
        hint="Use securityMode safe, research, or unsafe.",
    )


def _requested_security_mode(options: Mapping[str, Any]) -> str | None:
    supplied = [(key, options[key]) for key in _SECURITY_MODE_KEYS if key in options]
    if not supplied:
        return None
    if not all(isinstance(value, str) for _, value in supplied):
        raise ValueError("securityMode must be a string")
    normalized = {value.strip().lower() for _, value in supplied}
    if len(normalized) != 1:
        raise ValueError("securityMode and security_mode must not conflict")
    security_mode = normalized.pop()
    if security_mode not in _SECURITY_MODES:
        raise ValueError("securityMode must be safe, research, or unsafe")
    return security_mode


def _settings_for(context: Any, options: Mapping[str, Any]) -> Any:
    security_mode = _requested_security_mode(options)
    settings = pyne_runtime.PyneSettings.from_env()
    prefix = context.exchange.strip().upper()
    return replace(
        settings,
        security_mode=security_mode or settings.security_mode,
        executor_mode="inline",
        syminfo={
            "ticker": context.symbol,
            "tickerid": f"{prefix}:{context.symbol}",
            "prefix": prefix,
            "type": context.market_type,
        },
        timeframe=context.interval,
    )


def _diagnostic_from_mapping(
    value: Any,
    *,
    fallback_code: str,
    fallback_message: str,
) -> Diagnostic:
    data = value if isinstance(value, Mapping) else {}
    code = str(data.get("code") or fallback_code)
    message = str(data.get("message") or fallback_message)
    span: dict[str, int] = {}
    for key in ("line", "column"):
        item = data.get(key)
        if isinstance(item, int) and not isinstance(item, bool):
            span[key] = item
    diagnostic_data: dict[str, Any] = {}
    docs_url = data.get("docsUrl")
    if isinstance(docs_url, str) and docs_url:
        diagnostic_data["docsUrl"] = docs_url
    hint = data.get("hint")
    return Diagnostic(
        code=code,
        severity="warning" if code == "PYNE_MIGRATION_HINT" else "error",
        message=message,
        hint=hint if isinstance(hint, str) and hint.strip() else None,
        span=span or None,
        data=diagnostic_data,
    )


def _bridge_failure(code: str, message: str, *, hint: str | None = None) -> ExecuteBatchResult:
    return ExecuteBatchResult(
        ok=False,
        diagnostics=(
            Diagnostic(
                code=code,
                severity="error",
                message=message,
                hint=hint,
            ),
        ),
    )


def _series_identifier(raw_value: Any, index: int, used: set[str]) -> str:
    raw = str(raw_value or "").strip().lower()
    normalized = _INVALID_IDENTIFIER.sub("-", raw).strip("._-")
    if not normalized or not normalized[0].isalnum():
        normalized = f"series-{index}"
    normalized = normalized[:64].rstrip("._-") or f"series-{index}"
    candidate = normalized
    suffix = 2
    while candidate in used:
        marker = f"-{suffix}"
        candidate = f"{normalized[: 64 - len(marker)].rstrip('._-')}{marker}"
        suffix += 1
    used.add(candidate)
    return candidate


def _line_style(line: Mapping[str, Any]) -> dict[str, Any]:
    style: dict[str, Any] = {}
    color = line.get("color")
    if isinstance(color, str) and color.strip():
        style["color"] = color
    for source_key, target_key in (
        ("lineWidth", "lineWidth"),
        ("linewidth", "lineWidth"),
        ("lineStyle", "lineStyle"),
        ("zIndex", "zIndex"),
    ):
        value = line.get(source_key)
        if (
            target_key not in style
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
        ):
            style[target_key] = value
    color_data = line.get("colorData")
    if (
        isinstance(color_data, Sequence)
        and not isinstance(color_data, (str, bytes))
        and all(item is None or isinstance(item, str) for item in color_data)
    ):
        style["colorData"] = list(color_data)
    return style


def _line_series(value: Any, index: int, used: set[str]) -> LineSeries:
    if not isinstance(value, Mapping):
        raise BridgeOutputError(f"Pyne line {index} must be an object")
    raw_points = value.get("data")
    if isinstance(raw_points, (str, bytes)) or not isinstance(raw_points, Sequence):
        raise BridgeOutputError(f"Pyne line {index} data must be an array")
    points: list[LinePoint] = []
    for point_index, raw_point in enumerate(raw_points):
        if not isinstance(raw_point, Mapping):
            raise BridgeOutputError(f"Pyne line {index} point {point_index} must be an object")
        try:
            points.append(
                LinePoint(
                    time=raw_point.get("time"),
                    value=raw_point.get("value"),
                    color=raw_point.get("color"),
                )
            )
        except Exception as exc:
            raise BridgeOutputError(f"Pyne line {index} point {point_index} is invalid") from exc
    raw_id = value.get("id") or value.get("name") or value.get("title")
    series_id = _series_identifier(raw_id, index, used)
    raw_title = value.get("name") or value.get("title") or value.get("id")
    title = str(raw_title).strip() if raw_title is not None else ""
    pane = value.get("pane", "main")
    scale = value.get("scale", "right")
    if not title:
        title = f"Series {index}"
    if not isinstance(pane, str) or not pane.strip():
        raise BridgeOutputError(f"Pyne line {index} pane must be a string")
    if not isinstance(scale, str) or not scale.strip():
        raise BridgeOutputError(f"Pyne line {index} scale must be a string")
    return LineSeries(
        id=series_id,
        title=title,
        points=tuple(points),
        pane=pane,
        scale=scale,
        style=_line_style(value),
        series_type=value.get("type", "line"),
    )


def _normalize_engine_output(result: Any) -> None:
    """Match Pyne's public histogram normalization before protocol mapping."""
    for line in getattr(result, "lines", None) or []:
        if not isinstance(line, Mapping) or line.get("type") != "histogram":
            continue
        default_color = line.get("color")
        for point in line.get("data") or []:
            if isinstance(point, dict) and point.get("color") == default_color:
                point.pop("color", None)


def _render_collections(output: Any) -> RenderCollections | None:
    if output is None:
        return RenderCollections()
    if not isinstance(output, Mapping):
        raise BridgeOutputError("Pyne result output must be an object")
    collections = {
        key: value for key, value in output.items() if key != "meta" and value not in (None, [], {})
    }
    return RenderCollections.from_wire(collections)


def _render_output(result: Any) -> RenderOutput:
    _normalize_engine_output(result)
    raw_lines = getattr(result, "lines", None)
    if isinstance(raw_lines, (str, bytes)) or not isinstance(raw_lines, Sequence):
        raise BridgeOutputError("Pyne result lines must be an array")
    used: set[str] = set()
    series = tuple(_line_series(line, index, used) for index, line in enumerate(raw_lines, 1))
    result_meta = getattr(result, "meta", None)
    pyne_output = getattr(result, "output", None)
    output_meta = pyne_output.get("meta", {}) if isinstance(pyne_output, Mapping) else {}
    if not isinstance(output_meta, Mapping):
        raise BridgeOutputError("Pyne output meta must be an object")
    if result_meta is not None and not isinstance(result_meta, Mapping):
        raise BridgeOutputError("Pyne result meta must be an object")
    collections = _render_collections(pyne_output)
    if series and collections is not None and not (collections.lines or collections.histograms):
        raise BridgeOutputError("Pyne output omitted structured line data for rendered series")
    return RenderOutput(
        series=series,
        collections=collections,
        meta=dict(output_meta),
    )


class PyneRuntimePlugin(BaseRuntimePlugin):
    """Expose the independently released Pyne engine through protocol v1."""

    def describe(self) -> RuntimeDescriptor:
        return _descriptor()

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        try:
            settings = _settings_for(request.context, request.options)
        except (TypeError, ValueError) as exc:
            diagnostic = _options_error(str(exc))
            return AnalyzeResult(
                ok=False,
                executable=False,
                diagnostics=(diagnostic,),
            )
        try:
            raw_diagnostics = pyne_runtime.validate(request.source, settings=settings)
        except Exception as exc:
            return AnalyzeResult(
                ok=False,
                executable=False,
                diagnostics=(
                    Diagnostic(
                        code="PYNE_BRIDGE_ANALYSIS_FAILED",
                        severity="error",
                        message="Pyne source analysis failed unexpectedly.",
                        data={"exceptionType": type(exc).__name__},
                    ),
                ),
            )
        diagnostics = tuple(
            _diagnostic_from_mapping(
                item,
                fallback_code="PYNE_VALIDATION_ERROR",
                fallback_message="Pyne rejected the script.",
            )
            for item in raw_diagnostics
        )
        executable = not any(item.severity == "error" for item in diagnostics)
        return AnalyzeResult(
            ok=executable,
            executable=executable,
            diagnostics=diagnostics,
            meta={"engine": "pyne-runtime"},
        )

    def execute_batch(self, request: ExecuteBatchRequest) -> ExecuteBatchResult:
        try:
            settings = _settings_for(request.context, request.options)
        except (TypeError, ValueError) as exc:
            return ExecuteBatchResult(ok=False, diagnostics=(_options_error(str(exc)),))
        bars = [
            {
                "time": bar.time,
                "open": bar.open,
                "high": bar.high,
                "low": bar.low,
                "close": bar.close,
                "volume": bar.volume,
            }
            for bar in request.bars
        ]
        try:
            result = pyne_runtime.execute_pyne_script(
                script=request.source,
                ohlcv=bars,
                params=dict(request.params),
                settings=settings,
                executor_mode="inline",
            )
        except Exception as exc:
            return _bridge_failure(
                "PYNE_BRIDGE_EXECUTION_FAILED",
                "Pyne execution failed unexpectedly.",
                hint=f"The runtime raised {type(exc).__name__}; inspect the plugin health logs.",
            )
        if not bool(getattr(result, "ok", False)):
            detail = getattr(result, "error_detail", None)
            if not isinstance(detail, Mapping):
                detail = {
                    "code": getattr(result, "code", None),
                    "message": getattr(result, "error", None),
                    "line": getattr(result, "line", None),
                    "column": getattr(result, "column", None),
                    "hint": getattr(result, "hint", None),
                }
            return ExecuteBatchResult(
                ok=False,
                diagnostics=(
                    _diagnostic_from_mapping(
                        detail,
                        fallback_code="PYNE_RUNTIME_ERROR",
                        fallback_message="Pyne could not execute the script.",
                    ),
                ),
            )
        try:
            output = _render_output(result)
        except (BridgeOutputError, ProtocolError, TypeError, ValueError) as exc:
            return _bridge_failure(
                "PYNE_BRIDGE_OUTPUT_INVALID",
                "Pyne returned output that cannot be represented by Render IR v1.",
                hint=str(exc),
            )
        raw_inputs = getattr(result, "param_schema", None) or []
        if isinstance(raw_inputs, (str, bytes)) or not isinstance(raw_inputs, Sequence):
            return _bridge_failure(
                "PYNE_BRIDGE_OUTPUT_INVALID",
                "Pyne returned an invalid parameter schema.",
            )
        result_meta = getattr(result, "meta", None) or {}
        if not isinstance(result_meta, Mapping):
            return _bridge_failure(
                "PYNE_BRIDGE_OUTPUT_INVALID",
                "Pyne returned invalid result metadata.",
            )
        try:
            return ExecuteBatchResult(
                ok=True,
                output=output,
                inputs=tuple(raw_inputs),
                meta=dict(result_meta),
            )
        except (ProtocolError, TypeError, ValueError) as exc:
            return _bridge_failure(
                "PYNE_BRIDGE_OUTPUT_INVALID",
                "Pyne returned output that cannot be represented by Render IR v1.",
                hint=str(exc),
            )
