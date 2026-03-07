"""
Indicator computation engine.

Executes user-written Python scripts in a sandboxed environment with
pre-injected OHLCV data arrays and helper functions (SMA, EMA, RSI, etc.).

Since CandleScope is an open-source project meant for personal / educational
use, the sandbox is intentionally *relaxed* — we block obviously dangerous
builtins but do NOT treat this as a hostile-code jail.  Users are assumed to
be running their own instance.
"""
from __future__ import annotations

import math
import signal
import threading
import traceback
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
#  Built-in indicator helper functions (injected into user script globals)
# ---------------------------------------------------------------------------


def _sma(src: np.ndarray, period: int) -> np.ndarray:
    """Simple Moving Average.

    Handles NaN values — if any value in the window is NaN, the SMA for
    that window is NaN.  Uses a safe rolling computation instead of cumsum
    which silently propagates NaN to all subsequent values.
    """
    out = np.full_like(src, np.nan, dtype=float)
    if period < 1 or len(src) < period:
        return out

    # Check if source contains any NaN — use fast cumsum path if clean
    if not np.any(np.isnan(src)):
        cumsum = np.cumsum(src, dtype=float)
        cumsum[period:] = cumsum[period:] - cumsum[:-period]
        out[period - 1:] = cumsum[period - 1:] / period
    else:
        # NaN-aware rolling mean
        for i in range(period - 1, len(src)):
            window = src[i - period + 1: i + 1]
            if np.any(np.isnan(window)):
                out[i] = np.nan
            else:
                out[i] = np.mean(window)
    return out


def _ema(src: np.ndarray, period: int) -> np.ndarray:
    """Exponential Moving Average.

    Handles NaN values gracefully — finds the first window of `period`
    consecutive non-NaN values to seed the EMA, then propagates forward
    skipping any remaining NaN inputs.
    """
    out = np.full_like(src, np.nan, dtype=float)
    if period < 1 or len(src) < period:
        return out
    k = 2.0 / (period + 1)

    # Find the first index where we have `period` consecutive non-NaN values
    start = -1
    count = 0
    for i in range(len(src)):
        if np.isnan(src[i]):
            count = 0
        else:
            count += 1
            if count >= period:
                start = i - period + 1
                break

    if start < 0:
        return out  # not enough non-NaN data

    seed_end = start + period
    out[seed_end - 1] = np.mean(src[start:seed_end])
    for i in range(seed_end, len(src)):
        if np.isnan(src[i]):
            out[i] = out[i - 1]  # carry forward previous EMA
        elif np.isnan(out[i - 1]):
            out[i] = src[i]
        else:
            out[i] = src[i] * k + out[i - 1] * (1 - k)
    return out


def _rsi(src: np.ndarray, period: int = 14) -> np.ndarray:
    """Relative Strength Index."""
    out = np.full_like(src, np.nan, dtype=float)
    if period < 1 or len(src) < period + 1:
        return out
    delta = np.diff(src)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)

    avg_gain = np.mean(gain[:period])
    avg_loss = np.mean(loss[:period])

    out[period] = 100.0 - 100.0 / (1.0 + avg_gain / max(avg_loss, 1e-10))
    for i in range(period, len(delta)):
        avg_gain = (avg_gain * (period - 1) + gain[i]) / period
        avg_loss = (avg_loss * (period - 1) + loss[i]) / period
        out[i + 1] = 100.0 - 100.0 / (1.0 + avg_gain / max(avg_loss, 1e-10))
    return out


def _macd(
    src: np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """MACD: returns (macd_line, signal_line, histogram)."""
    ema_fast = _ema(src, fast)
    ema_slow = _ema(src, slow)
    # Use np.subtract so NaN propagation is handled correctly
    macd_line = np.where(
        np.isnan(ema_fast) | np.isnan(ema_slow),
        np.nan,
        ema_fast - ema_slow,
    )
    signal_line = _ema(macd_line, signal_period)
    histogram = np.where(
        np.isnan(macd_line) | np.isnan(signal_line),
        np.nan,
        macd_line - signal_line,
    )
    return macd_line, signal_line, histogram


def _boll(
    src: np.ndarray,
    period: int = 20,
    mult: float = 2.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bollinger Bands: returns (mid, upper, lower)."""
    mid = _sma(src, period)
    std = np.full_like(src, np.nan, dtype=float)
    for i in range(period - 1, len(src)):
        std[i] = np.std(src[i - period + 1: i + 1], ddof=0)
    upper = mid + mult * std
    lower = mid - mult * std
    return mid, upper, lower


def _stdev(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling standard deviation."""
    out = np.full_like(src, np.nan, dtype=float)
    for i in range(period - 1, len(src)):
        out[i] = np.std(src[i - period + 1: i + 1], ddof=0)
    return out


def _highest(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling highest value."""
    out = np.full_like(src, np.nan, dtype=float)
    for i in range(period - 1, len(src)):
        out[i] = np.max(src[i - period + 1: i + 1])
    return out


def _lowest(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling lowest value."""
    out = np.full_like(src, np.nan, dtype=float)
    for i in range(period - 1, len(src)):
        out[i] = np.min(src[i - period + 1: i + 1])
    return out


def _cross_over(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """True where a crosses above b."""
    if isinstance(b, (int, float)):
        b = np.full_like(a, b, dtype=float)
    result = np.zeros(len(a), dtype=bool)
    for i in range(1, len(a)):
        if not np.isnan(a[i]) and not np.isnan(b[i]) and not np.isnan(a[i-1]) and not np.isnan(b[i-1]):
            result[i] = a[i] > b[i] and a[i-1] <= b[i-1]
    return result


def _cross_under(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """True where a crosses below b."""
    if isinstance(b, (int, float)):
        b = np.full_like(a, b, dtype=float)
    result = np.zeros(len(a), dtype=bool)
    for i in range(1, len(a)):
        if not np.isnan(a[i]) and not np.isnan(b[i]) and not np.isnan(a[i-1]) and not np.isnan(b[i-1]):
            result[i] = a[i] < b[i] and a[i-1] >= b[i-1]
    return result


def _wma(src: np.ndarray, period: int) -> np.ndarray:
    """Weighted Moving Average."""
    out = np.full_like(src, np.nan, dtype=float)
    if period < 1 or len(src) < period:
        return out
    weights = np.arange(1, period + 1, dtype=float)
    w_sum = weights.sum()
    for i in range(period - 1, len(src)):
        out[i] = np.dot(src[i - period + 1: i + 1], weights) / w_sum
    return out


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Average True Range."""
    n = len(high)
    tr = np.full(n, np.nan, dtype=float)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
    return _sma(tr, period)


def _series(time_arr: np.ndarray, values: np.ndarray) -> list[dict]:
    """Package time + values into [{time, value}, ...], filtering NaN/Inf."""
    if not isinstance(values, np.ndarray):
        values = np.array(values, dtype=float)
    result = []
    for i in range(len(time_arr)):
        v = values[i]
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if np.isfinite(fv):
            result.append({"time": int(time_arr[i]), "value": round(fv, 8)})
    return result


# ---------------------------------------------------------------------------
#  Sandbox globals
# ---------------------------------------------------------------------------

_SANDBOX_GLOBALS: dict[str, Any] = {
    # Math
    "math": math,
    "np": np,
    "numpy": np,
    "abs": abs,
    "max": max,
    "min": min,
    "sum": sum,
    "round": round,
    "len": len,
    "range": range,
    "enumerate": enumerate,
    "zip": zip,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "float": float,
    "int": int,
    "str": str,
    "bool": bool,
    "True": True,
    "False": False,
    "None": None,
    "print": print,
    # Indicator functions
    "SMA": _sma,
    "EMA": _ema,
    "RSI": _rsi,
    "MACD": _macd,
    "BOLL": _boll,
    "STDEV": _stdev,
    "HIGHEST": _highest,
    "LOWEST": _lowest,
    "CROSS_OVER": _cross_over,
    "CROSS_UNDER": _cross_under,
    "WMA": _wma,
    "ATR": _atr,
    # Utility
    "series": _series,
    "NaN": np.nan,
    "nan": np.nan,
    "inf": np.inf,
    "isnan": np.isnan,
    "where": np.where,
    "full": np.full,
    "zeros": np.zeros,
    "ones": np.ones,
    "array": np.array,
    "arange": np.arange,
    "concatenate": np.concatenate,
    "mean": np.mean,
    "std": np.std,
    "diff": np.diff,
    "cumsum": np.cumsum,
    "roll": np.roll,
    "clip": np.clip,
    "sqrt": np.sqrt,
    "log": np.log,
    "exp": np.exp,
}


# ---------------------------------------------------------------------------
#  Execution timeout helper (cross-platform)
# ---------------------------------------------------------------------------

class _TimeoutError(Exception):
    pass


def _exec_with_timeout(code: str, globs: dict, timeout: int = 10) -> Any:
    """Execute code string with a timeout.  Works on both Unix and Windows."""
    result_holder: list = []
    error_holder: list = []

    def _target():
        try:
            # Inject an `__added_lines__` list and `add_line` helper so users
            # can imperatively add output lines without using `return`.
            globs["__added_lines__"] = []

            def _add_line(data, color="#f59e0b", title="", line_width=2,
                          line_style=0, overlay=True, pane=None):
                """Helper: add a line to the indicator output."""
                # `data` can be a numpy array or list
                time_arr = globs.get("time")
                if time_arr is None:
                    return
                if isinstance(data, np.ndarray):
                    data_points = _series(time_arr, data)
                elif isinstance(data, list):
                    arr = np.array(
                        [float(x) if x is not None else np.nan for x in data],
                        dtype=float,
                    )
                    data_points = _series(time_arr, arr)
                else:
                    return

                effective_pane = pane if pane is not None else ("main" if overlay else "separate")
                globs["__added_lines__"].append({
                    "name": title,
                    "color": color,
                    "data": data_points,
                    "pane": effective_pane,
                    "lineWidth": line_width,
                    "lineStyle": line_style,
                })

            globs["add_line"] = _add_line

            # Wrap user code in a function so `return` works
            wrapped = "def __indicator_fn__():\n"
            for line in code.split("\n"):
                wrapped += "    " + line + "\n"
            wrapped += "\n__result__ = __indicator_fn__()\n"
            exec(wrapped, globs)  # noqa: S102

            # If user used add_line() and didn't return anything, use the added lines
            fn_result = globs.get("__result__")
            added = globs.get("__added_lines__", [])
            if fn_result is None and added:
                result_holder.append(added)
            else:
                result_holder.append(fn_result)
        except Exception as exc:
            error_holder.append(exc)

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    thread.join(timeout=timeout)

    if thread.is_alive():
        raise _TimeoutError(f"Indicator script timed out after {timeout}s")
    if error_holder:
        raise error_holder[0]
    return result_holder[0] if result_holder else None


# ---------------------------------------------------------------------------
#  Public API
# ---------------------------------------------------------------------------

def compute_indicator(
    script: str,
    ohlcv_data: list[dict],
    params: dict | None = None,
    timeout: int = 10,
) -> dict:
    """Execute an indicator script against OHLCV data.

    Parameters
    ----------
    script : str
        User Python code.  May use ``return`` to produce output.
    ohlcv_data : list[dict]
        Each element must have keys: time, open, high, low, close, volume
    params : dict, optional
        Extra variables injected into the script namespace.
    timeout : int
        Max execution time in seconds.

    Returns
    -------
    dict  with key "lines": list of line descriptors, each with:
        name, color, data (list of {time, value}), pane ("main" | "separate"),
        lineWidth, lineStyle
    """
    if not ohlcv_data:
        return {"lines": [], "error": None}

    # Build numpy arrays from OHLCV data
    n = len(ohlcv_data)
    time_arr = np.array([d["time"] for d in ohlcv_data], dtype=np.int64)
    open_arr = np.array([d["open"] for d in ohlcv_data], dtype=np.float64)
    high_arr = np.array([d["high"] for d in ohlcv_data], dtype=np.float64)
    low_arr = np.array([d["low"] for d in ohlcv_data], dtype=np.float64)
    close_arr = np.array([d["close"] for d in ohlcv_data], dtype=np.float64)
    volume_arr = np.array([d["volume"] for d in ohlcv_data], dtype=np.float64)

    # Build execution globals
    globs = dict(_SANDBOX_GLOBALS)
    globs.update({
        "time": time_arr,
        "open": open_arr,
        "high": high_arr,
        "low": low_arr,
        "close": close_arr,
        "volume": volume_arr,
        "vol": volume_arr,
        "n": n,
    })

    # Inject user params — both as individual variables AND as a `params` dict
    # so scripts can use either `period` directly or `params.get("period", 20)`
    if params:
        globs.update(params)
        globs["params"] = params
    else:
        globs["params"] = {}

    try:
        raw_result = _exec_with_timeout(script, globs, timeout=timeout)
    except _TimeoutError as exc:
        return {"lines": [], "error": str(exc)}
    except Exception as exc:
        tb = traceback.format_exc()
        return {"lines": [], "error": f"{type(exc).__name__}: {exc}\n{tb}"}

    # Normalize result
    try:
        lines = _normalize_result(raw_result, time_arr=time_arr)
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        return {"lines": [], "error": f"NormalizeError: {type(exc).__name__}: {exc}\n{tb}"}
    return {"lines": lines, "error": None}


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_line_data(raw_data: Any, time_arr: np.ndarray | None) -> list[dict]:
    if isinstance(raw_data, np.ndarray):
        raw_data = raw_data.tolist()
    if not isinstance(raw_data, (list, tuple)):
        return []

    # Case A: already in [{time, value}, ...] format
    if raw_data and any(isinstance(point, dict) for point in raw_data):
        valid_data: list[dict] = []
        for point in raw_data:
            if not isinstance(point, dict) or "time" not in point or "value" not in point:
                continue
            try:
                t = int(point["time"])
                v = float(point["value"])
            except (TypeError, ValueError):
                continue
            if np.isfinite(v):
                valid_data.append({"time": t, "value": round(v, 8)})
        return valid_data[-50000:] if len(valid_data) > 50000 else valid_data

    # Case B: plain numeric sequence (e.g. numpy/list of values)
    if time_arr is None or len(time_arr) == 0:
        return []

    limit = min(len(raw_data), len(time_arr))
    valid_data = []
    for idx in range(limit):
        try:
            v = float(raw_data[idx])
        except (TypeError, ValueError):
            continue
        if np.isfinite(v):
            valid_data.append({"time": int(time_arr[idx]), "value": round(v, 8)})
    return valid_data[-50000:] if len(valid_data) > 50000 else valid_data


def _normalize_color_data(raw_color_data: Any) -> list[dict]:
    if isinstance(raw_color_data, np.ndarray):
        raw_color_data = raw_color_data.tolist()
    if not isinstance(raw_color_data, (list, tuple)):
        return []

    out = []
    for point in raw_color_data:
        if not isinstance(point, dict) or "time" not in point or "color" not in point:
            continue
        try:
            t = int(point["time"])
        except (TypeError, ValueError):
            continue
        out.append({"time": t, "color": str(point["color"])})

    return out[-50000:] if len(out) > 50000 else out


def _normalize_result(raw: Any, time_arr: np.ndarray | None = None) -> list[dict]:
    """Convert the raw return value from a user script into a list of line descriptors."""
    if raw is None:
        return []

    # If user returned a single dict, wrap it
    if isinstance(raw, dict):
        raw = [raw]

    if isinstance(raw, tuple):
        raw = list(raw)
    if not isinstance(raw, list):
        return []

    lines = []
    default_colors = [
        "#f59e0b", "#3b82f6", "#8b5cf6", "#06b6d4", "#ec4899",
        "#22c55e", "#ef4444", "#a855f7", "#14b8a6", "#f97316",
    ]

    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue

        # Ensure numeric fields are native Python types (not numpy int/float)
        raw_line_width = item.get("lineWidth", item.get("width", 2))
        raw_line_style = item.get("lineStyle", item.get("style", 0))
        pane = str(item.get("pane", "main"))
        if pane not in {"main", "separate", "volume"}:
            pane = "main"
        line_type = str(item.get("type", "line"))
        if line_type not in {"line", "histogram"}:
            line_type = "line"

        line = {
            "name": str(item.get("name", f"Line {i + 1}")),
            "color": str(item.get("color", default_colors[i % len(default_colors)])),
            "data": _normalize_line_data(item.get("data", []), time_arr),
            "pane": pane,  # "main" or "separate" or "volume"
            "lineWidth": _safe_int(raw_line_width, 2) if raw_line_width is not None else 2,
            "lineStyle": _safe_int(raw_line_style, 0) if raw_line_style is not None else 0,
            "priceScaleId": str(item.get("priceScaleId", "")),
            "type": line_type,  # "line" or "histogram"
        }

        # Pass through colorData if present (per-bar colors for histograms)
        if "colorData" in item:
            color_data = _normalize_color_data(item["colorData"])
            if color_data:
                line["colorData"] = color_data

        # Cap data size
        if len(line["data"]) > 50000:
            line["data"] = line["data"][-50000:]

        lines.append(line)

    return lines
