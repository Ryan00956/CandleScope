"""
Indicator API — powered by the new Indicator Engine.

Endpoints:
  GET  /indicators/registry           → list all registered indicator specs
  GET  /indicators/registry/{name}    → get single indicator spec
  POST /indicators/compute            → compute indicator on provided bars (new engine)

  # Preset-compatible endpoints (for frontend IndicatorPanel)
  GET  /indicators/presets            → list presets (maps to registry)
  GET  /indicators/presets/{id}       → get preset with script (maps to registry)
"""
from __future__ import annotations

import asyncio
import time
import textwrap
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.core import config
from app.core.executors import executors_snapshot, run_indicator, run_pyne_wait
from app.core.runtime_metrics import ws_runtime_metrics
from app.data_engine.data_manager.models import BarData
from app.indicator import registry, IndicatorEngine, create_engine
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.pyne.cache import pyne_cache
from app.indicator.pyne.executor import execute_pyne_script
from app.indicator.pyne.security import PyneSecurityPolicy
from app.indicator.serialization import (
    build_error_payload,
    serialize_indicator_result,
    serialize_pyne_result,
)

router = APIRouter(prefix="/indicators", tags=["indicators"])

# Module-level singletons
_engine = create_engine()
_custom_store = CustomIndicatorStore()


# ── Pydantic models ──────────────────────────────────────────

class ComputeRequest(BaseModel):
    """Request body for indicator computation.

    Supports two modes:
      1. Engine mode: provide ``name`` + ``params`` → uses the new engine
      2. Script mode: provide ``script`` + ``params`` → legacy Python exec
    """
    name: str | None = Field(None, description="Indicator name (e.g. 'MA', 'MACD')")
    mode: str | None = Field(None, description="'builtin' for engine mode or 'script' for Pyne mode")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    exchange: str = Field("binance", description="Exchange context")
    symbol: str = Field("UNKNOWN", description="Symbol for context")
    interval: str = Field("1m", description="Interval for context")
    market_type: str = Field("spot", description="Market type context")
    ohlcv: list[dict[str, Any]] = Field(default_factory=list, description="OHLCV bar data array")
    script: str | None = Field(None, description="Legacy Python script (optional)")
    securityMode: str | None = Field(None, description="'safe', 'research', or 'unsafe' for Pyne scripts")


class CustomIndicatorPayload(BaseModel):
    """Create/update payload for a user-defined indicator."""

    schemaVersion: int = Field(1, description="Custom indicator schema version")
    id: str | None = Field(None, description="Stable custom indicator id")
    kind: str = Field("script", description="'script' or 'custom'")
    name: str = Field(..., description="Display name")
    description: str = Field("", description="Description")
    script: str = Field(..., description="Pyne/Python script")
    params: dict[str, Any] = Field(default_factory=dict, description="Default params")
    paramSchema: list[dict[str, Any]] = Field(default_factory=list, description="Parameter schema")
    renderHints: dict[str, Any] = Field(default_factory=dict, description="Optional rendering hints")
    securityMode: str | None = Field(None, description="Preferred Pyne security mode")


# ═══════════════════════════════════════════════════════════════
#  Registry endpoints (new engine)
# ═══════════════════════════════════════════════════════════════

@router.get("/registry")
async def list_indicators():
    """Return all registered indicator specifications."""
    specs = registry.list_specs()
    return [s.to_dict() for s in specs]


@router.get("/registry/{name}")
async def get_indicator_spec(name: str):
    """Return the spec for a single indicator by name."""
    spec = registry.get_spec(name.upper())
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Indicator '{name}' not found")
    return spec.to_dict()


# ═══════════════════════════════════════════════════════════════
#  Preset-compatible endpoints (for frontend IndicatorPanel)
# ═══════════════════════════════════════════════════════════════

# Script templates that map indicator engine calls to the legacy
# script interface the frontend expects.  The frontend sends these
# scripts back in the compute endpoint, but we intercept them and
# route to the new engine instead.
_ENGINE_SCRIPT_MARKER = "# __ENGINE__:"

# ── Readable reference scripts for built-in indicators ───────
# These are equivalent Python scripts shown to users so they can
# understand the algorithm and use them as templates for custom
# indicators.  The engine marker on line 1 ensures compute still
# routes through the optimised C/engine path at runtime.

_PRESET_SCRIPTS: dict[str, str] = {
    "MA": textwrap.dedent("""\
        # __ENGINE__:MA
        indicator("MA", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        src = input.source(close, "Source")
        line_color = input.color(color.orange, "Color")

        ma = ta.sma(src, period)
        plot(ma, title=f"MA({period})", color=line_color, overlay=True)
    """),

    "EMA": textwrap.dedent("""\
        # __ENGINE__:EMA
        indicator("EMA", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        src = input.source(close, "Source")
        line_color = input.color(color.blue, "Color")

        ema_line = ta.ema(src, period)
        plot(ema_line, title=f"EMA({period})", color=line_color, overlay=True)
    """),

    "BOLL": textwrap.dedent("""\
        # __ENGINE__:BOLL
        indicator("BOLL", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
        src = input.source(close, "Source")
        mid_color = input.color(color.orange, "Middle Color")
        upper_color = input.color(color.red, "Upper Color")
        lower_color = input.color(color.green, "Lower Color")
        fill_color = input.color(color.new(color.blue, 88), "Fill Color")

        upper, middle, lower = ta.bb(src, period, mult)
        upper_plot = plot(upper, title="BOLL Upper", color=upper_color, overlay=True)
        middle_plot = plot(middle, title=f"BOLL Mid({period})", color=mid_color, overlay=True)
        lower_plot = plot(lower, title="BOLL Lower", color=lower_color, overlay=True)
        fill(upper_plot, lower_plot, color=fill_color, title="BOLL Band")
    """),

    "RSI": textwrap.dedent("""\
        # __ENGINE__:RSI
        indicator("RSI", overlay=False)

        period = input.int(14, "Period", minval=1, maxval=200)
        src = input.source(close, "Source")
        line_color = input.color(color.purple, "Color")
        overbought = input.float(70.0, "Overbought", minval=0, maxval=100, step=1)
        oversold = input.float(30.0, "Oversold", minval=0, maxval=100, step=1)

        rsi_line = ta.rsi(src, period)
        plot(rsi_line, title=f"RSI({period})", color=line_color, overlay=False, pane="separate")
        hline(overbought, title="Overbought", color=color.red, pane="separate")
        hline(50, title="Middle", color=color.gray, pane="separate")
        hline(oversold, title="Oversold", color=color.green, pane="separate")
    """),

    "MACD": textwrap.dedent("""\
        # __ENGINE__:MACD
        indicator("MACD", overlay=False)

        fast_period = input.int(12, "Fast Period", minval=1, maxval=200)
        slow_period = input.int(26, "Slow Period", minval=1, maxval=300)
        signal_period = input.int(9, "Signal Period", minval=1, maxval=100)
        src = input.source(close, "Source")
        dif_color = input.color(color.blue, "DIF Color")
        dea_color = input.color(color.orange, "DEA Color")
        hist_up_color = input.color(color.green, "Histogram Up Color")
        hist_down_color = input.color(color.red, "Histogram Down Color")

        dif, dea, hist = ta.macd(src, fast_period, slow_period, signal_period)
        plot(dif, title="DIF", color=dif_color, overlay=False, pane="separate")
        plot(dea, title="DEA", color=dea_color, overlay=False, pane="separate")
        bar(hist, title="MACD Hist", color_up=hist_up_color, color_down=hist_down_color, pane="separate")
        hline(0, title="Zero", color=color.gray, pane="separate")
    """),

    "ATR": textwrap.dedent("""\
        # __ENGINE__:ATR
        indicator("ATR", overlay=False)

        period = input.int(14, "Period", minval=1, maxval=200)
        line_color = input.color(color.aqua, "Color")

        atr_line = ta.atr(period)
        plot(atr_line, title=f"ATR({period})", color=line_color, overlay=False, pane="separate")
    """),

    "VOL": textwrap.dedent("""\
        # __ENGINE__:VOL
        indicator("VOL", overlay=False)

        up_color = input.color(color.green, "Up Color")
        down_color = input.color(color.red, "Down Color")

        volume_colors = color.when(close >= open, up_color, down_color)
        plot(
            volume,
            title="VOL",
            color=volume_colors,
            style=plot.style_histogram,
            overlay=False,
            pane="volume",
        )
    """),
}


def _build_preset_script(name: str, spec_dict: dict) -> str:
    """Build a readable reference script for a built-in indicator.

    If a hand-written script is available in ``_PRESET_SCRIPTS``, return it.
    Otherwise fall back to a minimal engine-marker stub.
    """
    if name.upper() in _PRESET_SCRIPTS:
        return _PRESET_SCRIPTS[name.upper()]
    return f"{_ENGINE_SCRIPT_MARKER}{name}\n# This indicator is computed by the built-in engine.\n# Parameters are configured via the params panel."


def _spec_to_preset(spec_dict: dict) -> dict:
    """Convert an IndicatorSpec dict to the preset format the frontend expects."""
    name = spec_dict["name"]

    # Determine pane target from the actual indicator class metadata
    cls = registry.get(name)
    pane_target = "sub"  # default to sub-pane
    if cls is not None:
        try:
            instance = cls(params=spec_dict.get("params", {}))
            meta = instance.get_meta()
            if meta.pane.value == "main":
                pane_target = "main"
            else:
                pane_target = "sub"
        except Exception:
            pass

    return {
        "id": name.lower(),
        "name": spec_dict.get("display_name") or name,
        "engineName": name,  # registry key for compute API (e.g. "BOLL", "MA")
        "description": spec_dict.get("description", ""),
        "category": spec_dict.get("category", ""),
        "script": _build_preset_script(name, spec_dict),
        "params": spec_dict.get("params", {}),
        "paramSchema": spec_dict.get("paramSchema", []),
        "outputs": spec_dict.get("outputs", []),
        "is_builtin": spec_dict.get("is_builtin", True),
        "defaultEnabled": name == "VOL",  # auto-enable volume
        "paneTarget": pane_target,  # "main" = overlay on price chart, "sub" = separate pane
    }


@router.get("/presets")
async def list_presets():
    """List all indicator presets (maps registry → preset format for frontend)."""
    specs = registry.list_specs()
    return [_spec_to_preset(s.to_dict()) for s in specs]


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str):
    """Get a single preset with full script (maps registry → preset format)."""
    name = preset_id.upper()
    spec = registry.get_spec(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Preset '{preset_id}' not found")
    return _spec_to_preset(spec.to_dict())


# ═══════════════════════════════════════════════════════════════
#  Custom indicator CRUD
# ═══════════════════════════════════════════════════════════════

@router.get("/custom")
async def list_custom_indicators():
    """List all user-saved custom indicators."""
    try:
        return _custom_store.list()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/custom")
async def save_custom_indicator(payload: CustomIndicatorPayload):
    """Create or update a user-saved custom indicator."""
    try:
        data = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        return _custom_store.upsert(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/custom/{indicator_id}")
async def delete_custom_indicator(indicator_id: str):
    """Delete a user-saved custom indicator."""
    try:
        deleted = _custom_store.delete(indicator_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Custom indicator '{indicator_id}' not found")
    return {"ok": True, "id": indicator_id}


@router.get("/pyne/security")
async def get_pyne_security_policy():
    """Return the default Pyne security policy advertised to the UI."""
    return PyneSecurityPolicy.from_config().to_public_dict()


def _resolve_runtime_engine(request: Request | None) -> IndicatorEngine:
    """Prefer the app-wide runtime engine when the endpoint is called via ASGI."""
    if request is not None:
        try:
            engine = getattr(request.app.state, "indicator_engine", None)
            if isinstance(engine, IndicatorEngine):
                return engine
        except Exception:
            pass
    return _engine


def _build_diagnostics_snapshot(
    *,
    engine: IndicatorEngine,
    store: CustomIndicatorStore,
) -> dict[str, Any]:
    """Build a compact, stable diagnostics payload for support/debugging."""
    custom_error = None
    custom_count = 0
    try:
        custom_count = len(store.list())
    except ValueError as exc:
        custom_error = str(exc)

    policy = PyneSecurityPolicy.from_config().to_public_dict()

    return {
        "ok": True,
        "schemaVersion": 1,
        "generatedAt": int(time.time()),
        "registry": {
            "count": len(registry.list_names()),
            "indicators": registry.list_names(),
        },
        "engine": engine.snapshot(),
        "customIndicators": {
            "count": custom_count,
            "path": str(store.path),
            "error": custom_error,
        },
        "pyne": {
            "security": policy,
            "executor": {
                "mode": config.PYNE_EXECUTOR_MODE,
                "timeoutSeconds": config.PYNE_EXEC_TIMEOUT_SECONDS,
                "processGraceSeconds": config.PYNE_PROCESS_GRACE_SECONDS,
            },
            "limits": {
                "maxBars": config.PYNE_MAX_BARS,
                "maxOutputSeries": config.PYNE_MAX_OUTPUT_SERIES,
                "maxOutputPoints": config.PYNE_MAX_OUTPUT_POINTS,
            },
            "cache": pyne_cache.stats(),
        },
        "websocket": {
            "maxSubscriptions": config.INDICATOR_WS_MAX_SUBSCRIPTIONS,
            "queueSize": config.INDICATOR_WS_QUEUE_SIZE,
            "heartbeatSeconds": config.INDICATOR_WS_HEARTBEAT_SECONDS,
            "metrics": ws_runtime_metrics.snapshot(),
        },
        "executors": executors_snapshot(),
    }


@router.get("/diagnostics")
async def get_indicator_diagnostics(request: Request):
    """Return a read-only diagnostics snapshot for the indicator subsystem."""
    return _build_diagnostics_snapshot(
        engine=_resolve_runtime_engine(request),
        store=_custom_store,
    )


# ═══════════════════════════════════════════════════════════════
#  Compute endpoint — unified
# ═══════════════════════════════════════════════════════════════

@router.post("/compute")
async def compute(req: ComputeRequest):
    """Compute an indicator on the provided OHLCV data.

    Supports two modes:
      1. If ``name`` is provided (or script starts with ENGINE marker),
         uses the new indicator engine.
      2. If only ``script`` is provided, runs legacy Python exec mode.

    Returns ``{ok, error, lines, result}`` — ``lines`` is the flat list
    for direct frontend rendering, ``result`` is the full structured output.
    """
    mode = req.mode.strip().lower() if req.mode else None
    if mode and mode not in {"builtin", "script"}:
        return build_error_payload(
            "INVALID_MODE",
            "mode must be 'builtin' or 'script'",
            hint="内置指标使用 mode='builtin'，自定义 Pyne 脚本使用 mode='script'。",
        )

    indicator_name = req.name

    if mode == "script":
        if not req.script:
            return build_error_payload(
                "PYNE_SCRIPT_REQUIRED",
                "Script mode requires 'script'",
                hint="请提交 Pyne 脚本文本，或切换到 builtin 模式。",
            )
        return await _compute_script(req)

    if mode == "builtin":
        if not indicator_name and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
            first_line = req.script.split("\n")[0]
            indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        if not indicator_name:
            return build_error_payload(
                "INDICATOR_NAME_REQUIRED",
                "Builtin mode requires 'name'",
                hint="请传入内置指标名称，例如 MA、MACD、RSI。",
            )
        return await _compute_engine(indicator_name, req)

    # Legacy mode: preserve old behavior for existing frontend/localStorage data.
    use_engine = indicator_name is not None
    if not use_engine and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
        first_line = req.script.split("\n")[0]
        indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        use_engine = True

    if use_engine and indicator_name:
        return await _compute_engine(indicator_name, req)
    if req.script:
        return await _compute_script(req)
    return build_error_payload(
        "INDICATOR_REQUEST_EMPTY",
        "Provide either 'name' or 'script'",
        hint="内置指标传 name，自定义指标传 script。",
    )


async def _compute_engine(name: str, req: ComputeRequest) -> dict:
    """Compute using the new indicator engine."""
    name = name.upper()

    if not registry.has(name):
        return build_error_payload(
            "INDICATOR_NOT_FOUND",
            f"Indicator '{name}' not registered",
            hint="请检查指标名称是否存在于 /api/v1/indicators/registry。",
        )

    ohlcv = req.ohlcv
    if not ohlcv:
        return build_error_payload(
            "INVALID_OHLCV",
            "No OHLCV data provided",
            hint="请确认前端已经加载 K 线数据后再计算指标。",
        )
    if len(ohlcv) > 50_000:
        return build_error_payload(
            "INVALID_OHLCV",
            "Too many data points (max 50000)",
            hint="请缩小历史窗口，或为后端指标计算增加分页/窗口策略。",
        )

    try:
        bars = [BarData.from_dict(d) for d in ohlcv]
    except (KeyError, ValueError, TypeError) as exc:
        return build_error_payload(
            "INVALID_OHLCV",
            f"Invalid OHLCV data: {exc}",
            hint="OHLCV 每根 K 线需要包含 time/open/high/low/close/volume。",
        )

    try:
        result = await _run_indicator_http_compute(
            _compute_builtin_once,
            name,
            req,
            bars,
        )
    except asyncio.TimeoutError:
        return build_error_payload(
            "INDICATOR_COMPUTE_TIMEOUT",
            f"Indicator compute exceeded {config.INDICATOR_HTTP_TIMEOUT_SECONDS:g}s timeout",
            hint="指标计算超时，请缩小历史窗口或优化参数。",
        )
    except Exception as exc:
        return build_error_payload(
            "INDICATOR_COMPUTE_FAILED",
            str(exc),
            hint="内置指标计算失败，请检查参数类型和历史数据长度。",
        )

    if result is None:
        return build_error_payload(
            "INDICATOR_RESULT_EMPTY",
            f"Indicator '{name}' computation returned None",
        )

    return serialize_indicator_result(result)


async def _compute_script(req: ComputeRequest) -> dict:
    """Compute using Pyne runtime (with full legacy backward compatibility).

    The Pyne runtime provides a rich Pine-style namespace including
    ta.*, input.*, plot(), color.*, math.*, crossover(), etc.
    Legacy scripts using add_line() continue to work unchanged.
    """
    try:
        result = await _run_indicator_http_compute(
            execute_pyne_script,
            executor_kind="pyne",
            script=req.script,
            ohlcv=req.ohlcv,
            params=req.params or {},
            security_mode=req.securityMode,
        )
    except asyncio.TimeoutError:
        return build_error_payload(
            "PYNE_TIMEOUT",
            f"Pyne script exceeded {config.INDICATOR_HTTP_TIMEOUT_SECONDS:g}s HTTP timeout",
            hint="脚本执行超时，请减少循环、缩小窗口，或调整 INDICATOR_HTTP_TIMEOUT_SECONDS。",
        )

    return serialize_pyne_result(result)


async def _run_indicator_http_compute(func, *args, executor_kind: str = "indicator", **kwargs):
    """Run heavy HTTP indicator work off the event loop with a hard wait cap."""
    runner = run_pyne_wait if executor_kind == "pyne" else run_indicator
    return await asyncio.wait_for(
        runner(func, *args, **kwargs),
        timeout=max(float(config.INDICATOR_HTTP_TIMEOUT_SECONDS), 0.1),
    )


def _compute_builtin_once(name: str, req: ComputeRequest, bars: list[BarData]):
    """Compute a builtin indicator without touching the runtime IndicatorEngine.

    HTTP compute is one-shot work. Using a temporary engine keeps it isolated
    from the app-wide realtime IndicatorEngine, whose cached instances are
    mutated by WebSocket subscriptions and DataManager events.
    """
    engine = create_engine()
    try:
        return engine.compute(
            symbol=req.symbol,
            interval=req.interval,
            market_type=req.market_type,
            indicator_name=name,
            params=req.params,
            bars=bars,
            exchange=req.exchange,
        )
    finally:
        engine.stop()
