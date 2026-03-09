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

import textwrap
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.data_engine.data_manager.models import BarData
from app.indicator import registry, IndicatorEngine, create_engine
from app.indicator.pyne import PyneRuntime

router = APIRouter(prefix="/indicators", tags=["indicators"])

# Module-level singletons
_engine = create_engine()
_pyne = PyneRuntime()


# ── Pydantic models ──────────────────────────────────────────

class ComputeRequest(BaseModel):
    """Request body for indicator computation.

    Supports two modes:
      1. Engine mode: provide ``name`` + ``params`` → uses the new engine
      2. Script mode: provide ``script`` + ``params`` → legacy Python exec
    """
    name: str | None = Field(None, description="Indicator name (e.g. 'MA', 'MACD')")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    symbol: str = Field("UNKNOWN", description="Symbol for context")
    interval: str = Field("1m", description="Interval for context")
    ohlcv: list[dict[str, Any]] = Field(default_factory=list, description="OHLCV bar data array")
    script: str | None = Field(None, description="Legacy Python script (optional)")


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
        # ── Simple Moving Average (SMA) ──────────────────────────
        # 使用滚动窗口计算简单移动平均线
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay=True)

        period = params.get("period", 20)
        source = params.get("source", "close")
        color  = params.get("color", "#f59e0b")

        # 选择数据源
        source_map = {
            "open": open, "high": high, "low": low, "close": close,
            "hl2":  (high + low) / 2,
            "hlc3": (high + low + close) / 3,
            "ohlc4": (open + high + low + close) / 4,
        }
        src = source_map.get(source, close)

        # 计算 SMA — O(n) 滚动求和
        ma = np.full(len(src), np.nan)
        rolling_sum = 0.0
        for i in range(len(src)):
            rolling_sum += src[i]
            if i >= period:
                rolling_sum -= src[i - period]
            if i >= period - 1:
                ma[i] = rolling_sum / period

        add_line(ma, color=color, title=f"MA({period})")
    """),

    "EMA": textwrap.dedent("""\
        # __ENGINE__:EMA
        # ── Exponential Moving Average (EMA) ─────────────────────
        # 使用递归加权计算指数移动平均线
        # EMA_t = α × price + (1 − α) × EMA_{t-1},  α = 2 / (period + 1)
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay=True)

        period = params.get("period", 20)
        source = params.get("source", "close")
        color  = params.get("color", "#3b82f6")

        source_map = {
            "open": open, "high": high, "low": low, "close": close,
            "hl2":  (high + low) / 2,
            "hlc3": (high + low + close) / 3,
            "ohlc4": (open + high + low + close) / 4,
        }
        src = source_map.get(source, close)

        alpha = 2.0 / (period + 1)
        ema = np.full(len(src), np.nan)

        # 前 period 根 K 线用 SMA 初始化
        if len(src) >= period:
            ema[period - 1] = np.mean(src[:period])
            for i in range(period, len(src)):
                ema[i] = alpha * src[i] + (1 - alpha) * ema[i - 1]

        add_line(ema, color=color, title=f"EMA({period})")
    """),

    "BOLL": textwrap.dedent("""\
        # __ENGINE__:BOLL
        # ── Bollinger Bands (BOLL) ───────────────────────────────
        # 中轨 = SMA(period), 上轨 = 中轨 + mult × σ, 下轨 = 中轨 − mult × σ
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay=True)

        period      = params.get("period", 20)
        mult        = params.get("mult", 2.0)
        source      = params.get("source", "close")
        color_mid   = params.get("color_middle", "#f59e0b")
        color_upper = params.get("color_upper", "#ef4444")
        color_lower = params.get("color_lower", "#22c55e")

        source_map = {
            "open": open, "high": high, "low": low, "close": close,
            "hl2":  (high + low) / 2,
            "hlc3": (high + low + close) / 3,
            "ohlc4": (open + high + low + close) / 4,
        }
        src = source_map.get(source, close)

        mid   = np.full(len(src), np.nan)
        upper = np.full(len(src), np.nan)
        lower = np.full(len(src), np.nan)

        for i in range(period - 1, len(src)):
            window = src[i - period + 1 : i + 1]
            mean = np.mean(window)
            std  = np.std(window, ddof=0)      # 总体标准差
            mid[i]   = mean
            upper[i] = mean + mult * std
            lower[i] = mean - mult * std

        add_line(mid,   color=color_mid,   title=f"BOLL Mid({period})")
        add_line(upper, color=color_upper, title="BOLL Upper")
        add_line(lower, color=color_lower, title="BOLL Lower")
    """),

    "RSI": textwrap.dedent("""\
        # __ENGINE__:RSI
        # ── Relative Strength Index (RSI) ────────────────────────
        # 使用 Wilder 平滑法计算 RSI
        # RSI = 100 − 100 / (1 + RS),  RS = avg_gain / avg_loss
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay, pane)

        period = params.get("period", 14)
        source = params.get("source", "close")
        color  = params.get("color", "#a855f7")

        source_map = {
            "open": open, "high": high, "low": low, "close": close,
            "hl2":  (high + low) / 2,
            "hlc3": (high + low + close) / 3,
            "ohlc4": (open + high + low + close) / 4,
        }
        src = source_map.get(source, close)

        rsi = np.full(len(src), np.nan)

        if len(src) > period:
            # 计算价格变化
            deltas = np.diff(src)
            gains = np.where(deltas > 0, deltas, 0.0)
            losses = np.where(deltas < 0, -deltas, 0.0)

            # 初始平均涨跌幅 (前 period 个变化)
            avg_gain = np.mean(gains[:period])
            avg_loss = np.mean(losses[:period])

            if avg_loss == 0:
                rsi[period] = 100.0
            else:
                rsi[period] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

            # Wilder 递推平滑
            for i in range(period, len(deltas)):
                avg_gain = (avg_gain * (period - 1) + gains[i]) / period
                avg_loss = (avg_loss * (period - 1) + losses[i]) / period
                if avg_loss == 0:
                    rsi[i + 1] = 100.0
                else:
                    rsi[i + 1] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

        add_line(rsi, color=color, title=f"RSI({period})", overlay=False, pane="separate")
    """),

    "MACD": textwrap.dedent("""\
        # __ENGINE__:MACD
        # ── MACD (Moving Average Convergence Divergence) ─────────
        # DIF  = EMA(fast) − EMA(slow)
        # DEA  = EMA(signal) of DIF
        # HIST = 2 × (DIF − DEA)
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay, pane, type)

        fast_period   = params.get("fast", 12)
        slow_period   = params.get("slow", 26)
        signal_period = params.get("signal", 9)
        source        = params.get("source", "close")

        source_map = {
            "open": open, "high": high, "low": low, "close": close,
            "hl2":  (high + low) / 2,
            "hlc3": (high + low + close) / 3,
            "ohlc4": (open + high + low + close) / 4,
        }
        src = source_map.get(source, close)
        n = len(src)

        # ── 辅助: 计算 EMA ──
        def calc_ema(data, period):
            ema = np.full(len(data), np.nan)
            if len(data) < period:
                return ema
            ema[period - 1] = np.mean(data[:period])
            alpha = 2.0 / (period + 1)
            for i in range(period, len(data)):
                ema[i] = alpha * data[i] + (1 - alpha) * ema[i - 1]
            return ema

        fast_ema = calc_ema(src, fast_period)
        slow_ema = calc_ema(src, slow_period)

        # DIF = fast_ema − slow_ema
        dif = np.full(n, np.nan)
        for i in range(n):
            if not (np.isnan(fast_ema[i]) or np.isnan(slow_ema[i])):
                dif[i] = fast_ema[i] - slow_ema[i]

        # DEA = EMA(signal) of DIF (从第一个有效 DIF 值开始)
        dea = np.full(n, np.nan)
        hist = np.full(n, np.nan)

        # 找到 DIF 有效值的起始位置
        valid_start = -1
        for i in range(n):
            if not np.isnan(dif[i]):
                valid_start = i
                break

        if valid_start >= 0:
            # 收集有效 DIF 值
            valid_dif = dif[valid_start:]
            dea_part = calc_ema(valid_dif, signal_period)
            for i in range(len(dea_part)):
                idx = valid_start + i
                if not np.isnan(dea_part[i]):
                    dea[idx] = dea_part[i]
                    hist[idx] = 2.0 * (dif[idx] - dea[idx])

        add_line(dif,  color="#3b82f6", title="DIF",       overlay=False, pane="separate")
        add_line(dea,  color="#f59e0b", title="DEA",       overlay=False, pane="separate")
        add_line(hist, color="#22c55e", title="MACD Hist", overlay=False, pane="separate",
                 type="histogram")
    """),

    "ATR": textwrap.dedent("""\
        # __ENGINE__:ATR
        # ── Average True Range (ATR) ─────────────────────────────
        # True Range = max(H−L, |H−prev_close|, |L−prev_close|)
        # ATR = Wilder 平滑 of True Range
        #
        # 可用变量: open, high, low, close, volume, time (numpy 数组)
        # 输出函数: add_line(data, color, title, overlay, pane)

        period = params.get("period", 14)
        color  = params.get("color", "#06b6d4")

        n = len(close)
        atr = np.full(n, np.nan)

        if n > 1:
            # 计算 True Range 序列
            tr = np.empty(n)
            tr[0] = high[0] - low[0]
            for i in range(1, n):
                hl = high[i] - low[i]
                hc = abs(high[i] - close[i - 1])
                lc = abs(low[i] - close[i - 1])
                tr[i] = max(hl, hc, lc)

            # 初始 ATR = 前 period 个 TR 的简单平均
            if n >= period:
                atr[period - 1] = np.mean(tr[:period])

                # Wilder 递推平滑
                for i in range(period, n):
                    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period

        add_line(atr, color=color, title=f"ATR({period})", overlay=False, pane="separate")
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
    # Determine which indicator to use
    indicator_name = req.name
    use_engine = indicator_name is not None

    # Check if script is an engine-backed pseudo-script
    if not use_engine and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
        first_line = req.script.split("\n")[0]
        indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        use_engine = True

    if use_engine and indicator_name:
        return await _compute_engine(indicator_name, req)
    elif req.script:
        return await _compute_script(req)
    else:
        return {"ok": False, "error": "Provide either 'name' or 'script'", "lines": [], "result": None}


async def _compute_engine(name: str, req: ComputeRequest) -> dict:
    """Compute using the new indicator engine."""
    name = name.upper()

    if not registry.has(name):
        return {"ok": False, "error": f"Indicator '{name}' not registered", "lines": [], "result": None}

    ohlcv = req.ohlcv
    if not ohlcv:
        return {"ok": False, "error": "No OHLCV data provided", "lines": [], "result": None}
    if len(ohlcv) > 50_000:
        return {"ok": False, "error": "Too many data points (max 50000)", "lines": [], "result": None}

    try:
        bars = [BarData.from_dict(d) for d in ohlcv]
    except (KeyError, ValueError, TypeError) as exc:
        return {"ok": False, "error": f"Invalid OHLCV data: {exc}", "lines": [], "result": None}

    try:
        result = _engine.compute(
            symbol=req.symbol,
            interval=req.interval,
            indicator_name=name,
            params=req.params,
            bars=bars,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "lines": [], "result": None}

    if result is None:
        return {"ok": False, "error": f"Indicator '{name}' computation returned None", "lines": [], "result": None}

    if result.error:
        return {"ok": False, "error": result.error, "lines": [], "result": result.to_dict()}

    return {
        "ok": True,
        "error": None,
        "lines": result.lines,  # flat list of output dicts for frontend
        "result": result.to_dict(),
    }


async def _compute_script(req: ComputeRequest) -> dict:
    """Compute using Pyne runtime (with full legacy backward compatibility).

    The Pyne runtime provides a rich Pine-style namespace including
    ta.*, input.*, plot(), color.*, math.*, crossover(), etc.
    Legacy scripts using add_line() continue to work unchanged.
    """
    result = _pyne.execute(
        script=req.script,
        ohlcv=req.ohlcv,
        params=req.params or {},
    )

    response: dict = {
        "ok": result.ok,
        "error": result.error,
        "lines": result.lines,
        "result": result.output if result.output else None,
    }

    # Pass through extended output types for frontend rendering
    output = result.output or {}
    if output.get("markers"):
        response["markers"] = output["markers"]
    if output.get("fills"):
        response["fills"] = output["fills"]
    if output.get("hlines"):
        response["hlines"] = output["hlines"]
    if output.get("bgcolors"):
        response["bgcolors"] = output["bgcolors"]
    if output.get("barcolors"):
        response["barcolors"] = output["barcolors"]

    # Pass param_schema for dynamic UI generation (from input.* calls)
    if result.param_schema:
        response["param_schema"] = result.param_schema

    # Pass indicator metadata
    if result.meta:
        response["meta"] = result.meta

    return response
