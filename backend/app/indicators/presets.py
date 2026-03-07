"""
Built-in indicator presets.

Each preset is a dict with:
  id, name, description, category, script, params (default values),
  paramSchema (for the UI to render controls).
"""
from __future__ import annotations

PRESET_INDICATORS: list[dict] = [
    # ── Moving Averages ──────────────────────────────────────
    {
        "id": "sma",
        "name": "SMA",
        "description": "简单移动平均线",
        "category": "趋势",
        "script": (
            "ma = SMA(close, period)\n"
            "return {\"name\": f\"SMA({period})\", \"color\": color, \"data\": series(time, ma)}"
        ),
        "params": {"period": 20, "color": "#f59e0b"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 500, "default": 20},
            {"key": "color", "label": "颜色", "type": "color", "default": "#f59e0b"},
        ],
    },
    {
        "id": "ema",
        "name": "EMA",
        "description": "指数移动平均线",
        "category": "趋势",
        "script": (
            "ma = EMA(close, period)\n"
            "return {\"name\": f\"EMA({period})\", \"color\": color, \"data\": series(time, ma)}"
        ),
        "params": {"period": 20, "color": "#3b82f6"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 500, "default": 20},
            {"key": "color", "label": "颜色", "type": "color", "default": "#3b82f6"},
        ],
    },
    {
        "id": "wma",
        "name": "WMA",
        "description": "加权移动平均线",
        "category": "趋势",
        "script": (
            "ma = WMA(close, period)\n"
            "return {\"name\": f\"WMA({period})\", \"color\": color, \"data\": series(time, ma)}"
        ),
        "params": {"period": 20, "color": "#8b5cf6"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 500, "default": 20},
            {"key": "color", "label": "颜色", "type": "color", "default": "#8b5cf6"},
        ],
    },
    {
        "id": "double_ma",
        "name": "双均线",
        "description": "快慢两条移动平均线",
        "category": "趋势",
        "script": (
            "ma_fast = SMA(close, fast)\n"
            "ma_slow = SMA(close, slow)\n"
            "return [\n"
            "    {\"name\": f\"MA({fast})\", \"color\": fast_color, \"data\": series(time, ma_fast)},\n"
            "    {\"name\": f\"MA({slow})\", \"color\": slow_color, \"data\": series(time, ma_slow)},\n"
            "]"
        ),
        "params": {"fast": 5, "slow": 20, "fast_color": "#f59e0b", "slow_color": "#3b82f6"},
        "paramSchema": [
            {"key": "fast", "label": "快线周期", "type": "int", "min": 2, "max": 200, "default": 5},
            {"key": "slow", "label": "慢线周期", "type": "int", "min": 2, "max": 500, "default": 20},
            {"key": "fast_color", "label": "快线颜色", "type": "color", "default": "#f59e0b"},
            {"key": "slow_color", "label": "慢线颜色", "type": "color", "default": "#3b82f6"},
        ],
    },
    # ── Oscillators ──────────────────────────────────────────
    {
        "id": "rsi",
        "name": "RSI",
        "description": "相对强弱指标 (独立面板)",
        "category": "震荡",
        "script": (
            "rsi = RSI(close, period)\n"
            "return {\"name\": f\"RSI({period})\", \"color\": color, \"data\": series(time, rsi), \"pane\": \"separate\"}"
        ),
        "params": {"period": 14, "color": "#8b5cf6"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 100, "default": 14},
            {"key": "color", "label": "颜色", "type": "color", "default": "#8b5cf6"},
        ],
    },
    {
        "id": "macd",
        "name": "MACD",
        "description": "指数平滑异同移动平均线 (独立面板)",
        "category": "震荡",
        "script": (
            "macd_line, signal_line, hist = MACD(close, fast, slow, signal)\n"
            "return [\n"
            "    {\"name\": \"MACD\", \"color\": \"#3b82f6\", \"data\": series(time, macd_line), \"pane\": \"separate\"},\n"
            "    {\"name\": \"Signal\", \"color\": \"#f59e0b\", \"data\": series(time, signal_line), \"pane\": \"separate\"},\n"
            "    {\"name\": \"Histogram\", \"color\": \"#22c55e\", \"data\": series(time, hist), \"pane\": \"separate\", \"type\": \"histogram\"},\n"
            "]"
        ),
        "params": {"fast": 12, "slow": 26, "signal": 9},
        "paramSchema": [
            {"key": "fast", "label": "快线", "type": "int", "min": 2, "max": 100, "default": 12},
            {"key": "slow", "label": "慢线", "type": "int", "min": 2, "max": 200, "default": 26},
            {"key": "signal", "label": "信号线", "type": "int", "min": 2, "max": 100, "default": 9},
        ],
    },
    # ── Volatility ───────────────────────────────────────────
    {
        "id": "boll",
        "name": "布林带",
        "description": "Bollinger Bands (上中下三轨)",
        "category": "波动",
        "script": (
            "mid, upper, lower = BOLL(close, period, mult)\n"
            "return [\n"
            "    {\"name\": \"上轨\", \"color\": \"#ef4444\", \"data\": series(time, upper), \"lineStyle\": 2},\n"
            "    {\"name\": \"中轨\", \"color\": \"#94a3b8\", \"data\": series(time, mid)},\n"
            "    {\"name\": \"下轨\", \"color\": \"#22c55e\", \"data\": series(time, lower), \"lineStyle\": 2},\n"
            "]"
        ),
        "params": {"period": 20, "mult": 2.0},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 200, "default": 20},
            {"key": "mult", "label": "倍数", "type": "float", "min": 0.5, "max": 5.0, "step": 0.1, "default": 2.0},
        ],
    },
    {
        "id": "atr",
        "name": "ATR",
        "description": "平均真实波幅 (独立面板)",
        "category": "波动",
        "script": (
            "atr_val = ATR(high, low, close, period)\n"
            "return {\"name\": f\"ATR({period})\", \"color\": color, \"data\": series(time, atr_val), \"pane\": \"separate\"}"
        ),
        "params": {"period": 14, "color": "#06b6d4"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 100, "default": 14},
            {"key": "color", "label": "颜色", "type": "color", "default": "#06b6d4"},
        ],
    },
    # ── Volume ───────────────────────────────────────────────
    {
        "id": "vol",
        "name": "成交量",
        "description": "成交量柱状图 (默认显示)",
        "category": "成交量",
        "defaultEnabled": True,
        "script": (
            "# Volume histogram: color by candle direction\n"
            "colors = []\n"
            "for i in range(n):\n"
            "    if close[i] >= open[i]:\n"
            "        colors.append(up_color + '55')\n"
            "    else:\n"
            "        colors.append(down_color + '55')\n"
            "return {\"name\": \"VOL\", \"data\": series(time, volume), \"pane\": \"volume\","
            " \"type\": \"histogram\", \"color\": \"#26a69a55\","
            " \"colorData\": [{\"time\": int(time[i]), \"color\": colors[i]} for i in range(n)]}"
        ),
        "params": {"up_color": "#22c55e", "down_color": "#ef4444"},
        "paramSchema": [
            {"key": "up_color", "label": "涨色", "type": "color", "default": "#22c55e"},
            {"key": "down_color", "label": "跌色", "type": "color", "default": "#ef4444"},
        ],
    },
    {
        "id": "vol_sma",
        "name": "成交量均线",
        "description": "成交量简单移动平均 (成交量图)",
        "category": "成交量",
        "script": (
            "v_ma = SMA(volume, period)\n"
            "return {\"name\": f\"Vol MA({period})\", \"color\": color, \"data\": series(time, v_ma), \"pane\": \"volume\"}"
        ),
        "params": {"period": 20, "color": "#a855f7"},
        "paramSchema": [
            {"key": "period", "label": "周期", "type": "int", "min": 2, "max": 200, "default": 20},
            {"key": "color", "label": "颜色", "type": "color", "default": "#a855f7"},
        ],
    },
]


def get_preset_by_id(preset_id: str) -> dict | None:
    """Return a preset indicator by its id, or None if not found."""
    for p in PRESET_INDICATORS:
        if p["id"] == preset_id:
            return p
    return None
