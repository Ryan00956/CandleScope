/**
 * Pyne Language Support for Monaco Editor
 *
 * Provides:
 *   1. Custom autocompletion for Pyne APIs (ta.*, input.*, color.*, plot, etc.)
 *   2. Hover documentation for all Pyne functions and variables
 *   3. Signature help for function parameters
 *
 * Architecture: We keep Python as the base language for syntax highlighting
 * and layer Pyne-specific intelligence on top via Monaco providers.
 */

import type * as Monaco from "monaco-editor";
import { getLocale, type LocaleId } from "../i18n/index.js";

// ══════════════════════════════════════════════════════════════
//  Pyne API Documentation Database
// ══════════════════════════════════════════════════════════════

export type PyneItemKind =
  | "Variable"
  | "Function"
  | "Method"
  | "Property"
  | "Module"
  | "Snippet";

export interface PyneItem {
  label: string;
  detail: string;
  documentation: string;
  insertText: string;
  kind: PyneItemKind;
}

export interface PyneHoverInfo {
  detail: string;
  documentation: string;
  prefix: string;
}

/**
 * Top-level global variables available in Pyne scripts.
 * @type {PyneItem[]}
 */
const GLOBAL_VARIABLES: PyneItem[] = [
  {
    label: "open",
    detail: "np.ndarray",
    documentation: "开盘价数组 (Open prices)",
    insertText: "open",
    kind: "Variable",
  },
  {
    label: "high",
    detail: "np.ndarray",
    documentation: "最高价数组 (High prices)",
    insertText: "high",
    kind: "Variable",
  },
  {
    label: "low",
    detail: "np.ndarray",
    documentation: "最低价数组 (Low prices)",
    insertText: "low",
    kind: "Variable",
  },
  {
    label: "close",
    detail: "np.ndarray",
    documentation: "收盘价数组 (Close prices)",
    insertText: "close",
    kind: "Variable",
  },
  {
    label: "volume",
    detail: "np.ndarray",
    documentation: "成交量数组 (Volume)",
    insertText: "volume",
    kind: "Variable",
  },
  {
    label: "time",
    detail: "list[int]",
    documentation: "时间戳列表 (Timestamps)",
    insertText: "time",
    kind: "Variable",
  },
  {
    label: "bar_count",
    detail: "int",
    documentation: "K线数量 (Number of bars)",
    insertText: "bar_count",
    kind: "Variable",
  },
  {
    label: "hl2",
    detail: "np.ndarray",
    documentation: "(high + low) / 2",
    insertText: "hl2",
    kind: "Variable",
  },
  {
    label: "hlc3",
    detail: "np.ndarray",
    documentation: "(high + low + close) / 3",
    insertText: "hlc3",
    kind: "Variable",
  },
  {
    label: "ohlc4",
    detail: "np.ndarray",
    documentation: "(open + high + low + close) / 4",
    insertText: "ohlc4",
    kind: "Variable",
  },
  {
    label: "hlcc4",
    detail: "np.ndarray",
    documentation: "(high + low + close × 2) / 4",
    insertText: "hlcc4",
    kind: "Variable",
  },
  {
    label: "np",
    detail: "module",
    documentation: "NumPy 库 (import numpy as np)",
    insertText: "np",
    kind: "Module",
  },
  {
    label: "numpy",
    detail: "module",
    documentation: "NumPy 库",
    insertText: "numpy",
    kind: "Module",
  },
  {
    label: "params",
    detail: "dict",
    documentation: "用户参数字典 (Legacy compatibility)",
    insertText: "params",
    kind: "Variable",
  },
];

/**
 * Top-level global functions available in Pyne scripts.
 * @type {PyneItem[]}
 */
const GLOBAL_FUNCTIONS: PyneItem[] = [
  // ── Drawing functions ──
  {
    label: "plot",
    detail: "(data, title, color, linewidth, style, pane) → PlotRef",
    documentation: [
      "绘制一条线到图表。",
      "",
      "**参数:**",
      "- `data` — 数据数组 (np.ndarray)",
      "- `title` — 线条名称",
      '- `color` — 颜色 (如 `color.orange`, `"#f59e0b"`)',
      "- `linewidth` — 线宽 (默认 2)",
      '- `style` — 线型: `"solid"`, `"dashed"`, `"dotted"`',
      '- `pane` — 窗格: `"main"` 或 `"separate"`',
      "",
      "**返回:** PlotRef (可用于 `fill()`)",
      "",
      "```python",
      'plot(ta.sma(close, 20), title="SMA", color=color.orange)',
      "```",
    ].join("\n"),
    insertText: 'plot(${1:data}, title="${2:Line}", color=${3:color.orange})',
    kind: "Function",
  },
  {
    label: "hline",
    detail: "(price, title, color, linestyle) → HlineRef",
    documentation: [
      "绘制水平参考线。",
      "",
      "**参数:**",
      "- `price` — 价格水平 (float)",
      "- `title` — 名称",
      "- `color` — 颜色",
      '- `linestyle` — `"solid"`, `"dashed"`, `"dotted"`',
      "",
      "```python",
      'hline(70, "超买", color=color.red, linestyle="dashed")',
      'hline(30, "超卖", color=color.green, linestyle="dashed")',
      "```",
    ].join("\n"),
    insertText: 'hline(${1:70}, "${2:Level}", color=${3:color.gray})',
    kind: "Function",
  },
  {
    label: "fill",
    detail: "(plot1, plot2, color) → void",
    documentation: [
      "填充两条线之间的区域。",
      "",
      "**参数:**",
      "- `plot1` — 第一个 plot() 返回值",
      "- `plot2` — 第二个 plot() 返回值",
      "- `color` — 填充颜色 (支持透明度)",
      "",
      "```python",
      'p1 = plot(upper, "Upper", color=color.red)',
      'p2 = plot(lower, "Lower", color=color.green)',
      'fill(p1, p2, color="rgba(59,130,246,0.1)")',
      "```",
    ].join("\n"),
    insertText:
      'fill(${1:plot1}, ${2:plot2}, color="${3:rgba(59,130,246,0.1)}")',
    kind: "Function",
  },
  {
    label: "bar",
    detail: "(data, title, color_up, color_down, pane) → void",
    documentation: [
      "绘制柱状图 (histogram)。",
      "",
      "**参数:**",
      "- `data` — 数据数组",
      "- `title` — 名称",
      "- `color_up` — 正值颜色 (默认绿色)",
      "- `color_down` — 负值颜色 (默认红色)",
      '- `pane` — 窗格 (默认 `"separate"`)',
      "",
      "```python",
      "_, _, hist = ta.macd(close)",
      'bar(hist, "MACD Hist", color_up=color.green, color_down=color.red)',
      "```",
    ].join("\n"),
    insertText: 'bar(${1:data}, "${2:Histogram}")',
    kind: "Function",
  },
  {
    label: "marker",
    detail: "(condition, shape, color, text, size) → void",
    documentation: [
      "在满足条件的 K 线上添加标记。",
      "",
      "**参数:**",
      "- `condition` — 布尔数组 (哪些位置需要标记)",
      '- `shape` — `"triangle_up"`, `"triangle_down"`, `"circle"`, `"cross"`',
      "- `color` — 标记颜色",
      "- `text` — 标记文字",
      "",
      "```python",
      'marker(crossover(fast, slow), shape="triangle_up",',
      '       color=color.green, text="买入")',
      "```",
    ].join("\n"),
    insertText:
      'marker(${1:condition}, shape="${2:triangle_up}", color=${3:color.green}, text="${4:Signal}")',
    kind: "Function",
  },
  {
    label: "bgcolor",
    detail: "(condition, color) → void",
    documentation: [
      "条件背景着色。",
      "",
      "```python",
      'bgcolor(ta.rsi(close, 14) > 70, color="rgba(239,68,68,0.1)")',
      "```",
    ].join("\n"),
    insertText: 'bgcolor(${1:condition}, color="${2:rgba(59,130,246,0.1)}")',
    kind: "Function",
  },
  {
    label: "barcolor",
    detail: "(colors) → void",
    documentation: [
      "按 K 线着色。`colors` 是一个颜色字符串数组。",
      "",
      "```python",
      "barcolor(np.where(close > open, color.green, color.red))",
      "```",
    ].join("\n"),
    insertText: "barcolor(${1:np.where(close > open, color.green, color.red)})",
    kind: "Function",
  },
  {
    label: "indicator",
    detail: "(title, overlay, shorttitle) → void",
    documentation: [
      "声明指标元数据（可选）。",
      "",
      "```python",
      'indicator("My RSI", overlay=False)',
      "```",
    ].join("\n"),
    insertText: 'indicator("${1:My Indicator}", overlay=${2:True})',
    kind: "Function",
  },
  // ── Utility functions (global) ──
  {
    label: "crossover",
    detail: "(a, b) → np.ndarray[bool]",
    documentation:
      "金叉检测 — 当 a 从下方穿越 b 时为 True\n\n```python\ncrossover(fast_ma, slow_ma)\n```",
    insertText: "crossover(${1:a}, ${2:b})",
    kind: "Function",
  },
  {
    label: "crossunder",
    detail: "(a, b) → np.ndarray[bool]",
    documentation:
      "死叉检测 — 当 a 从上方穿越 b 时为 True\n\n```python\ncrossunder(fast_ma, slow_ma)\n```",
    insertText: "crossunder(${1:a}, ${2:b})",
    kind: "Function",
  },
  {
    label: "highest",
    detail: "(src, period) → np.ndarray",
    documentation:
      "滚动最高值\n\n```python\nhighest(high, 20)  # 20周期最高\n```",
    insertText: "highest(${1:high}, ${2:20})",
    kind: "Function",
  },
  {
    label: "lowest",
    detail: "(src, period) → np.ndarray",
    documentation:
      "滚动最低值\n\n```python\nlowest(low, 20)  # 20周期最低\n```",
    insertText: "lowest(${1:low}, ${2:20})",
    kind: "Function",
  },
  {
    label: "change",
    detail: "(src, period=1) → np.ndarray",
    documentation: "价格变化量 (src[i] - src[i-period])",
    insertText: "change(${1:close}, ${2:1})",
    kind: "Function",
  },
  {
    label: "roc",
    detail: "(src, period=1) → np.ndarray",
    documentation: "变化率百分比 (Rate of Change %)",
    insertText: "roc(${1:close}, ${2:1})",
    kind: "Function",
  },
  {
    label: "na",
    detail: "(value) → float",
    documentation: "返回 NaN 值，用于标记无效数据",
    insertText: "na(${1:value})",
    kind: "Function",
  },
  {
    label: "nz",
    detail: "(value, replacement=0) → value",
    documentation:
      "将 NaN 替换为指定值 (默认 0)\n\n```python\nnz(ta.sma(close, 50), close)  # NaN时用close替代\n```",
    insertText: "nz(${1:value}, ${2:0})",
    kind: "Function",
  },
  {
    label: "shift",
    detail: "(src, n) → np.ndarray",
    documentation:
      "将数组平移 n 个位置 (正数向右/过去)\n\n```python\nyesterday_close = shift(close, 1)\n```",
    insertText: "shift(${1:close}, ${2:1})",
    kind: "Function",
  },
  {
    label: "barssince",
    detail: "(condition) → np.ndarray",
    documentation: "距离条件上次为 True 的 bar 数",
    insertText: "barssince(${1:condition})",
    kind: "Function",
  },
  {
    label: "valuewhen",
    detail: "(condition, src, occurrence=0) → np.ndarray",
    documentation: "条件为 True 时的源值",
    insertText: "valuewhen(${1:condition}, ${2:close}, ${3:0})",
    kind: "Function",
  },
  {
    label: "cum",
    detail: "(src) → np.ndarray",
    documentation: "累积求和",
    insertText: "cum(${1:src})",
    kind: "Function",
  },
  {
    label: "rising",
    detail: "(src, n) → np.ndarray[bool]",
    documentation: "连续上涨 n 个 bar",
    insertText: "rising(${1:close}, ${2:3})",
    kind: "Function",
  },
  {
    label: "falling",
    detail: "(src, n) → np.ndarray[bool]",
    documentation: "连续下跌 n 个 bar",
    insertText: "falling(${1:close}, ${2:3})",
    kind: "Function",
  },
  // ── Legacy compatibility ──
  {
    label: "add_line",
    detail: "(data, color, title, overlay, pane, type) → void",
    documentation: [
      "⚠️ 旧版函数 — 建议使用 `plot()` 代替",
      "",
      "```python",
      "# 旧写法",
      'add_line(ma, color="#f59e0b", title="MA")',
      "# 新写法",
      'plot(ma, title="MA", color=color.orange)',
      "```",
    ].join("\n"),
    insertText: 'add_line(${1:data}, color="${2:#f59e0b}", title="${3:Line}")',
    kind: "Function",
  },
];

/**
 * ta.* — Technical Analysis functions.
 */
const TA_FUNCTIONS: PyneItem[] = [
  // ── Moving Averages ──
  {
    label: "sma",
    detail: "(src, period) → np.ndarray",
    documentation:
      "简单移动平均线 (Simple Moving Average)\n\n```python\nta.sma(close, 20)\n```",
    insertText: "sma(${1:close}, ${2:20})",
    kind: "Method",
  },
  {
    label: "ema",
    detail: "(src, period) → np.ndarray",
    documentation:
      "指数移动平均线 (Exponential Moving Average)\n\nEMA_t = α × price + (1 − α) × EMA_{t-1}, α = 2/(period+1)\n\n```python\nta.ema(close, 20)\n```",
    insertText: "ema(${1:close}, ${2:20})",
    kind: "Method",
  },
  {
    label: "wma",
    detail: "(src, period) → np.ndarray",
    documentation:
      "加权移动平均线 (Weighted Moving Average)\n\n权重: [1, 2, ..., period]\n\n```python\nta.wma(close, 20)\n```",
    insertText: "wma(${1:close}, ${2:20})",
    kind: "Method",
  },
  {
    label: "rma",
    detail: "(src, period) → np.ndarray",
    documentation:
      "Wilder 平滑移动平均 (Running Moving Average)\n\n用于 RSI 和 ATR 内部计算。α = 1/period\n\n```python\nta.rma(close, 14)\n```",
    insertText: "rma(${1:close}, ${2:14})",
    kind: "Method",
  },
  {
    label: "vwma",
    detail: "(src, period, volume?) → np.ndarray",
    documentation:
      "成交量加权移动平均 (Volume-Weighted MA)\n\n```python\nta.vwma(close, 20)\n```",
    insertText: "vwma(${1:close}, ${2:20})",
    kind: "Method",
  },
  // ── Oscillators ──
  {
    label: "rsi",
    detail: "(src, period=14) → np.ndarray",
    documentation:
      '相对强弱指标 (RSI)\n\nRSI = 100 − 100/(1 + RS)\n\n```python\nrsi = ta.rsi(close, 14)\nplot(rsi, "RSI", color=color.purple, pane="separate")\nhline(70, color=color.red)\nhline(30, color=color.green)\n```',
    insertText: "rsi(${1:close}, ${2:14})",
    kind: "Method",
  },
  {
    label: "stoch",
    detail: "(close, high?, low?, k=14, d=3, smooth=3) → (K, D)",
    documentation:
      '随机指标 (Stochastic Oscillator)\n\n返回 (K%, D%) 元组\n\n```python\nk, d = ta.stoch(close, high, low, 14)\nplot(k, "K%", color=color.blue)\nplot(d, "D%", color=color.orange)\n```',
    insertText: "stoch(${1:close}, ${2:high}, ${3:low}, ${4:14})",
    kind: "Method",
  },
  {
    label: "cci",
    detail: "(high?, low?, close?, period=20) → np.ndarray",
    documentation:
      '商品通道指数 (Commodity Channel Index)\n\n```python\ncci = ta.cci(period=20)\nplot(cci, "CCI")\n```',
    insertText: "cci(period=${1:20})",
    kind: "Method",
  },
  {
    label: "mfi",
    detail: "(period=14) → np.ndarray",
    documentation:
      '资金流量指数 (Money Flow Index)\n\n```python\nplot(ta.mfi(14), "MFI", pane="separate")\n```',
    insertText: "mfi(${1:14})",
    kind: "Method",
  },
  // ── Trend ──
  {
    label: "macd",
    detail: "(src, fast=12, slow=26, signal=9) → (DIF, DEA, hist)",
    documentation: [
      "MACD 指标",
      "",
      "- DIF = EMA(fast) − EMA(slow)",
      "- DEA = EMA(signal) of DIF",
      "- histogram = 2 × (DIF − DEA)",
      "",
      "```python",
      "dif, dea, hist = ta.macd(close, 12, 26, 9)",
      'plot(dif, "DIF", color=color.blue)',
      'plot(dea, "DEA", color=color.orange)',
      'bar(hist, "MACD Hist")',
      "```",
    ].join("\n"),
    insertText: "macd(${1:close}, ${2:12}, ${3:26}, ${4:9})",
    kind: "Method",
  },
  {
    label: "adx",
    detail: "(high?, low?, close?, period=14) → np.ndarray",
    documentation:
      '平均趋向指数 (ADX)\n\n```python\nplot(ta.adx(period=14), "ADX", pane="separate")\n```',
    insertText: "adx(period=${1:14})",
    kind: "Method",
  },
  {
    label: "supertrend",
    detail: "(period=10, mult=3.0) → (line, direction)",
    documentation: [
      "超级趋势指标 (Supertrend)",
      "",
      "返回 (supertrend_line, direction) 元组",
      "direction: 1=上涨, -1=下跌",
      "",
      "```python",
      "st, dir = ta.supertrend(10, 3.0)",
      'plot(st, "Supertrend", color=np.where(dir > 0, color.green, color.red))',
      "```",
    ].join("\n"),
    insertText: "supertrend(${1:10}, ${2:3.0})",
    kind: "Method",
  },
  // ── Volatility ──
  {
    label: "tr",
    detail: "(high?, low?, close?) → np.ndarray",
    documentation:
      '真实波幅 (True Range)\n\nTR = max(H−L, |H−prev_close|, |L−prev_close|)\n\n```python\nplot(ta.tr(), "TR", pane="separate")\n```',
    insertText: "tr()",
    kind: "Method",
  },
  {
    label: "atr",
    detail: "(period=14) → np.ndarray",
    documentation:
      '平均真实波幅 (Average True Range)\n\nATR = Wilder 平滑 of TR\n\n```python\nplot(ta.atr(14), "ATR(14)", pane="separate")\n```',
    insertText: "atr(${1:14})",
    kind: "Method",
  },
  {
    label: "bb",
    detail: "(src, period=20, mult=2.0) → (upper, mid, lower)",
    documentation: [
      "布林带 (Bollinger Bands)",
      "",
      "返回 (upper, middle, lower) 元组",
      "",
      "```python",
      "upper, mid, lower = ta.bb(close, 20, 2)",
      'p1 = plot(upper, "Upper", color=color.red)',
      'plot(mid, "Mid", color=color.orange)',
      'p2 = plot(lower, "Lower", color=color.green)',
      'fill(p1, p2, color="rgba(59,130,246,0.05)")',
      "```",
    ].join("\n"),
    insertText: "bb(${1:close}, ${2:20}, ${3:2.0})",
    kind: "Method",
  },
  {
    label: "stdev",
    detail: "(src, period) → np.ndarray",
    documentation:
      "滚动标准差 (Standard Deviation)\n\n```python\nta.stdev(close, 20)\n```",
    insertText: "stdev(${1:close}, ${2:20})",
    kind: "Method",
  },
  {
    label: "keltner",
    detail: "(period=20, mult=1.5) → (upper, mid, lower)",
    documentation:
      "肯特纳通道 (Keltner Channel)\n\n```python\nupper, mid, lower = ta.keltner(20, 1.5)\n```",
    insertText: "keltner(${1:20}, ${2:1.5})",
    kind: "Method",
  },
  {
    label: "donchian",
    detail: "(period=20) → (upper, mid, lower)",
    documentation:
      "唐奇安通道 (Donchian Channel)\n\n```python\nupper, mid, lower = ta.donchian(20)\n```",
    insertText: "donchian(${1:20})",
    kind: "Method",
  },
  // ── Volume ──
  {
    label: "obv",
    detail: "(close?, volume?) → np.ndarray",
    documentation:
      '能量潮指标 (On-Balance Volume)\n\n```python\nplot(ta.obv(), "OBV", pane="separate")\n```',
    insertText: "obv()",
    kind: "Method",
  },
  {
    label: "volume_sma",
    detail: "(volume?, period=20) → np.ndarray",
    documentation:
      '成交量简单均线\n\n```python\nplot(ta.volume_sma(volume, 20), "Vol MA")\n```',
    insertText: "volume_sma(${1:volume}, ${2:20})",
    kind: "Method",
  },
  // ── Utility proxies ──
  {
    label: "crossover",
    detail: "(a, b) → np.ndarray[bool]",
    documentation: "金叉 (a 从下穿越 b)",
    insertText: "crossover(${1:a}, ${2:b})",
    kind: "Method",
  },
  {
    label: "crossunder",
    detail: "(a, b) → np.ndarray[bool]",
    documentation: "死叉 (a 从上穿越 b)",
    insertText: "crossunder(${1:a}, ${2:b})",
    kind: "Method",
  },
  {
    label: "highest",
    detail: "(src, period) → np.ndarray",
    documentation: "滚动最高值",
    insertText: "highest(${1:high}, ${2:20})",
    kind: "Method",
  },
  {
    label: "lowest",
    detail: "(src, period) → np.ndarray",
    documentation: "滚动最低值",
    insertText: "lowest(${1:low}, ${2:20})",
    kind: "Method",
  },
  {
    label: "change",
    detail: "(src, period=1) → np.ndarray",
    documentation: "变化量",
    insertText: "change(${1:close}, ${2:1})",
    kind: "Method",
  },
  {
    label: "pivothigh",
    detail: "(src, left, right) → np.ndarray",
    documentation:
      "枢轴高点检测\n\n```python\nph = ta.pivothigh(high, 5, 5)\n```",
    insertText: "pivothigh(${1:high}, ${2:5}, ${3:5})",
    kind: "Method",
  },
  {
    label: "pivotlow",
    detail: "(src, left, right) → np.ndarray",
    documentation:
      "枢轴低点检测\n\n```python\npl = ta.pivotlow(low, 5, 5)\n```",
    insertText: "pivotlow(${1:low}, ${2:5}, ${3:5})",
    kind: "Method",
  },
];

/**
 * input.* — Parameter declaration functions.
 */
const INPUT_FUNCTIONS: PyneItem[] = [
  {
    label: "int",
    detail: "(default, title, minval?, maxval?, step?) → int",
    documentation: [
      "声明整数参数，自动在前端生成输入控件。",
      "",
      "```python",
      'period = input.int(20, "周期", minval=1, maxval=500)',
      "```",
    ].join("\n"),
    insertText: 'int(${1:20}, "${2:Period}", minval=${3:1})',
    kind: "Method",
  },
  {
    label: "float",
    detail: "(default, title, minval?, maxval?, step?) → float",
    documentation:
      '声明浮点数参数\n\n```python\nmult = input.float(2.0, "倍数", step=0.1)\n```',
    insertText: 'float(${1:2.0}, "${2:Multiplier}", step=${3:0.1})',
    kind: "Method",
  },
  {
    label: "bool",
    detail: "(default, title) → bool",
    documentation:
      '声明布尔参数\n\n```python\nshow = input.bool(True, "显示线条")\n```',
    insertText: 'bool(${1:True}, "${2:Show}")',
    kind: "Method",
  },
  {
    label: "string",
    detail: "(default, title, options?) → str",
    documentation:
      '声明字符串参数 (可选提供选项列表)\n\n```python\nma_type = input.string("EMA", "MA类型", options=["SMA", "EMA", "WMA"])\n```',
    insertText:
      'string("${1:SMA}", "${2:Type}", options=[${3:"SMA", "EMA", "WMA"}])',
    kind: "Method",
  },
  {
    label: "source",
    detail: "(default, title) → np.ndarray",
    documentation:
      '声明数据源参数 (传入 close/open/high/low/hl2 等)\n\n```python\nsrc = input.source(close, "数据源")\n```',
    insertText: 'source(${1:close}, "${2:Source}")',
    kind: "Method",
  },
  {
    label: "color",
    detail: "(default, title) → str",
    documentation:
      '声明颜色参数\n\n```python\ncol = input.color("#f59e0b", "线条颜色")\n```',
    insertText: 'color("${1:#f59e0b}", "${2:Color}")',
    kind: "Method",
  },
];

/**
 * color.* — Color constants and helpers.
 */
const COLOR_MEMBERS: PyneItem[] = [
  {
    label: "red",
    detail: '"#ef4444"',
    documentation: "红色",
    insertText: "red",
    kind: "Property",
  },
  {
    label: "green",
    detail: '"#22c55e"',
    documentation: "绿色",
    insertText: "green",
    kind: "Property",
  },
  {
    label: "blue",
    detail: '"#3b82f6"',
    documentation: "蓝色",
    insertText: "blue",
    kind: "Property",
  },
  {
    label: "orange",
    detail: '"#f59e0b"',
    documentation: "橙色",
    insertText: "orange",
    kind: "Property",
  },
  {
    label: "purple",
    detail: '"#a855f7"',
    documentation: "紫色",
    insertText: "purple",
    kind: "Property",
  },
  {
    label: "yellow",
    detail: '"#eab308"',
    documentation: "黄色",
    insertText: "yellow",
    kind: "Property",
  },
  {
    label: "cyan",
    detail: '"#06b6d4"',
    documentation: "青色",
    insertText: "cyan",
    kind: "Property",
  },
  {
    label: "white",
    detail: '"#ffffff"',
    documentation: "白色",
    insertText: "white",
    kind: "Property",
  },
  {
    label: "black",
    detail: '"#000000"',
    documentation: "黑色",
    insertText: "black",
    kind: "Property",
  },
  {
    label: "gray",
    detail: '"#787b86"',
    documentation: "灰色",
    insertText: "gray",
    kind: "Property",
  },
  {
    label: "lime",
    detail: '"#00e676"',
    documentation: "亮绿",
    insertText: "lime",
    kind: "Property",
  },
  {
    label: "aqua",
    detail: '"#00bcd4"',
    documentation: "水色",
    insertText: "aqua",
    kind: "Property",
  },
  {
    label: "teal",
    detail: '"#009688"',
    documentation: "青绿",
    insertText: "teal",
    kind: "Property",
  },
  {
    label: "maroon",
    detail: '"#880e4f"',
    documentation: "栗色",
    insertText: "maroon",
    kind: "Property",
  },
  {
    label: "fuchsia",
    detail: '"#e040fb"',
    documentation: "品红",
    insertText: "fuchsia",
    kind: "Property",
  },
  {
    label: "silver",
    detail: '"#b2b5be"',
    documentation: "银色",
    insertText: "silver",
    kind: "Property",
  },
  {
    label: "navy",
    detail: '"#1a237e"',
    documentation: "藏蓝",
    insertText: "navy",
    kind: "Property",
  },
  {
    label: "olive",
    detail: '"#808000"',
    documentation: "橄榄",
    insertText: "olive",
    kind: "Property",
  },
  {
    label: "new",
    detail: "(hex_color, transparency) → str",
    documentation:
      '创建带透明度的颜色\n\ntransparency: 0=不透明, 100=完全透明\n\n```python\ncolor.new("#ef4444", 80)  # 80%透明的红色\ncolor.new(color.blue, 50) # 50%透明的蓝色\n```',
    insertText: 'new("${1:#ef4444}", ${2:50})',
    kind: "Method",
  },
];

/**
 * math.* — Array-aware math functions.
 */
const MATH_MEMBERS: PyneItem[] = [
  {
    label: "abs",
    detail: "(x) → array|float",
    documentation: "绝对值",
    insertText: "abs(${1:x})",
    kind: "Method",
  },
  {
    label: "log",
    detail: "(x) → array|float",
    documentation: "自然对数",
    insertText: "log(${1:x})",
    kind: "Method",
  },
  {
    label: "log10",
    detail: "(x) → array|float",
    documentation: "常用对数",
    insertText: "log10(${1:x})",
    kind: "Method",
  },
  {
    label: "sqrt",
    detail: "(x) → array|float",
    documentation: "平方根",
    insertText: "sqrt(${1:x})",
    kind: "Method",
  },
  {
    label: "exp",
    detail: "(x) → array|float",
    documentation: "指数函数 e^x",
    insertText: "exp(${1:x})",
    kind: "Method",
  },
  {
    label: "pow",
    detail: "(base, exp) → array|float",
    documentation: "幂运算",
    insertText: "pow(${1:base}, ${2:exp})",
    kind: "Method",
  },
  {
    label: "ceil",
    detail: "(x) → array|float",
    documentation: "向上取整",
    insertText: "ceil(${1:x})",
    kind: "Method",
  },
  {
    label: "floor",
    detail: "(x) → array|float",
    documentation: "向下取整",
    insertText: "floor(${1:x})",
    kind: "Method",
  },
  {
    label: "round",
    detail: "(x, precision=0) → array|float",
    documentation: "四舍五入",
    insertText: "round(${1:x})",
    kind: "Method",
  },
  {
    label: "max",
    detail: "(a, b) → array|float",
    documentation: "最大值（支持数组）",
    insertText: "max(${1:a}, ${2:b})",
    kind: "Method",
  },
  {
    label: "min",
    detail: "(a, b) → array|float",
    documentation: "最小值（支持数组）",
    insertText: "min(${1:a}, ${2:b})",
    kind: "Method",
  },
  {
    label: "sign",
    detail: "(x) → array|float",
    documentation: "符号函数 (-1, 0, 1)",
    insertText: "sign(${1:x})",
    kind: "Method",
  },
  {
    label: "avg",
    detail: "(*args) → array|float",
    documentation: "多个值的平均\n\n```python\nmath.avg(high, low, close)\n```",
    insertText: "avg(${1:a}, ${2:b})",
    kind: "Method",
  },
  {
    label: "sum",
    detail: "(src, period) → np.ndarray",
    documentation: "滚动求和",
    insertText: "sum(${1:src}, ${2:20})",
    kind: "Method",
  },
  {
    label: "sin",
    detail: "(x) → array|float",
    documentation: "正弦",
    insertText: "sin(${1:x})",
    kind: "Method",
  },
  {
    label: "cos",
    detail: "(x) → array|float",
    documentation: "余弦",
    insertText: "cos(${1:x})",
    kind: "Method",
  },
  {
    label: "tan",
    detail: "(x) → array|float",
    documentation: "正切",
    insertText: "tan(${1:x})",
    kind: "Method",
  },
  {
    label: "pi",
    detail: "3.14159...",
    documentation: "圆周率 π",
    insertText: "pi",
    kind: "Property",
  },
  {
    label: "e",
    detail: "2.71828...",
    documentation: "自然常数 e",
    insertText: "e",
    kind: "Property",
  },
];

// ══════════════════════════════════════════════════════════════
//  Snippet Templates
// ══════════════════════════════════════════════════════════════

const SNIPPET_ITEMS: PyneItem[] = [
  {
    label: "snippet: SMA indicator",
    detail: "简单移动平均线模板",
    documentation: "快速创建一个 SMA 指标脚本",
    insertText: [
      'indicator("SMA", overlay=True)',
      "",
      'length = input.int(20, "Period", minval=1)',
      'src = input.source(close, "Source")',
      "",
      'plot(ta.sma(src, length), title="SMA", color=color.orange)',
      "",
    ].join("\n"),
    kind: "Snippet",
  },
  {
    label: "snippet: MACD indicator",
    detail: "MACD 指标模板",
    documentation: "快速创建一个 MACD 指标脚本",
    insertText: [
      'indicator("MACD", overlay=False)',
      "",
      'fast = input.int(12, "Fast")',
      'slow = input.int(26, "Slow")',
      'signal = input.int(9, "Signal")',
      "",
      "dif, dea, hist = ta.macd(close, fast, slow, signal)",
      "",
      'plot(dif, "DIF", color=color.blue)',
      'plot(dea, "DEA", color=color.orange)',
      'bar(hist, "MACD Hist")',
      "hline(0, color=color.gray)",
      "",
    ].join("\n"),
    kind: "Snippet",
  },
  {
    label: "snippet: RSI indicator",
    detail: "RSI 指标模板",
    documentation: "快速创建一个 RSI 指标脚本",
    insertText: [
      'indicator("RSI", overlay=False)',
      "",
      'length = input.int(14, "Period")',
      "",
      "rsi = ta.rsi(close, length)",
      'plot(rsi, "RSI", color=color.purple)',
      'hline(70, "超买", color=color.red, linestyle="dashed")',
      'hline(30, "超卖", color=color.green, linestyle="dashed")',
      "",
    ].join("\n"),
    kind: "Snippet",
  },
  {
    label: "snippet: Bollinger Bands",
    detail: "布林带模板",
    documentation: "快速创建一个布林带指标脚本",
    insertText: [
      'indicator("Bollinger Bands", overlay=True)',
      "",
      'length = input.int(20, "Period")',
      'mult = input.float(2.0, "Multiplier", step=0.1)',
      "",
      "upper, mid, lower = ta.bb(close, length, mult)",
      "",
      'p1 = plot(upper, "Upper", color=color.red)',
      'plot(mid, "Mid", color=color.orange)',
      'p2 = plot(lower, "Lower", color=color.green)',
      'fill(p1, p2, color="rgba(59,130,246,0.05)")',
      "",
    ].join("\n"),
    kind: "Snippet",
  },
  {
    label: "snippet: MA Cross Strategy",
    detail: "均线交叉策略模板",
    documentation: "快速创建均线金叉/死叉信号脚本",
    insertText: [
      'indicator("MA Cross", overlay=True)',
      "",
      'fast_len = input.int(10, "Fast Period")',
      'slow_len = input.int(30, "Slow Period")',
      "",
      "fast = ta.ema(close, fast_len)",
      "slow = ta.ema(close, slow_len)",
      "",
      'plot(fast, "Fast EMA", color=color.green)',
      'plot(slow, "Slow EMA", color=color.red)',
      "",
      'marker(crossover(fast, slow), shape="triangle_up", color=color.green, text="买入")',
      'marker(crossunder(fast, slow), shape="triangle_down", color=color.red, text="卖出")',
      "",
    ].join("\n"),
    kind: "Snippet",
  },
];

// ══════════════════════════════════════════════════════════════
//  Hover Documentation Map (for quick lookup)
// ══════════════════════════════════════════════════════════════

/** Build a lookup map from all Pyne items for hover provider */
function buildHoverMap(): Map<string, PyneHoverInfo> {
  const map = new Map<string, PyneHoverInfo>();
  // Globals
  for (const item of [...GLOBAL_VARIABLES, ...GLOBAL_FUNCTIONS]) {
    map.set(item.label, {
      detail: item.detail,
      documentation: item.documentation,
      prefix: "",
    });
  }
  // ta.*
  for (const item of TA_FUNCTIONS) {
    map.set(`ta.${item.label}`, {
      detail: item.detail,
      documentation: item.documentation,
      prefix: "ta.",
    });
  }
  // input.*
  for (const item of INPUT_FUNCTIONS) {
    map.set(`input.${item.label}`, {
      detail: item.detail,
      documentation: item.documentation,
      prefix: "input.",
    });
  }
  // color.*
  for (const item of COLOR_MEMBERS) {
    map.set(`color.${item.label}`, {
      detail: item.detail,
      documentation: item.documentation,
      prefix: "color.",
    });
  }
  // math.*
  for (const item of MATH_MEMBERS) {
    map.set(`math.${item.label}`, {
      detail: item.detail,
      documentation: item.documentation,
      prefix: "math.",
    });
  }
  return map;
}

const HOVER_MAP = buildHoverMap();

const PYNE_ENGLISH_GLOBAL_DOCS: Readonly<Record<string, string>> = {
  open: "Open-price series.",
  high: "High-price series.",
  low: "Low-price series.",
  close: "Close-price series.",
  volume: "Volume series.",
  time: "Bar timestamp list.",
  bar_count: "Number of bars available to the script.",
  params: "Legacy-compatible user parameter dictionary.",
  np: "NumPy module, available as `np`.",
  numpy: "NumPy module.",
};

function englishPyneDocumentation(key: string, detail: string): string {
  const known = PYNE_ENGLISH_GLOBAL_DOCS[key];
  if (known) return known;
  if (key.startsWith("ta.")) {
    return `Technical-analysis function \`${key}\`. Use the signature \`${detail}\` for its supported parameters and return value.`;
  }
  if (key.startsWith("input.")) {
    return `Declares a user-configurable Pyne input with \`${key}\`. Use the signature \`${detail}\` for supported options.`;
  }
  if (key.startsWith("color.")) {
    return key === "color.new"
      ? "Creates a color with explicit transparency. Transparency ranges from 0 (opaque) to 100 (fully transparent)."
      : `Named Pyne color \`${key}\`.`;
  }
  if (key.startsWith("math.")) {
    return `Pyne math API \`${key}\`. Use the signature \`${detail}\` for supported inputs and output.`;
  }
  if (key.startsWith("snippet:")) return `Ready-to-edit Pyne template: ${key.slice("snippet:".length).trim()}.`;
  return `Pyne chart-scripting API \`${key}\`. Use the signature \`${detail}\` for supported parameters and return value.`;
}

function englishPyneDetail(key: string, detail: string): string {
  if (!/[\p{Script=Han}]/u.test(detail)) return detail;
  if (key.startsWith("snippet:")) return `${key.slice("snippet:".length).trim()} template`;
  return `${key} API`;
}

function englishPyneInsertText(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    超买: "Overbought",
    超卖: "Oversold",
    买入: "Buy",
    卖出: "Sell",
    周期: "Period",
    倍数: "Multiplier",
    显示线条: "Show line",
    数据源: "Source",
    线条颜色: "Line color",
    MA类型: "MA type",
  };
  return value.replace(/[\p{Script=Han}]+/gu, (word) => labels[word] ?? "Label");
}

export function localizePyneItem(
  item: PyneItem,
  key = item.label,
  locale: LocaleId = getLocale(),
): PyneItem {
  if (locale === "zh-CN") return item;
  return {
    ...item,
    detail: englishPyneDetail(key, item.detail),
    documentation: englishPyneDocumentation(key, item.detail),
    insertText: englishPyneInsertText(item.insertText),
  };
}

function isPyneEditorModel(model: Monaco.editor.ITextModel): boolean {
  return model.uri.path.toLowerCase().endsWith(".pyne");
}

// ══════════════════════════════════════════════════════════════
//  Export: Registration function
// ══════════════════════════════════════════════════════════════

/**
 * Register Pyne language support on a Monaco instance.
 *
 * Call this once after Monaco is loaded (via `onMount` or `beforeMount`).
 * Returns a dispose function to clean up providers.
 *
 * @param {import('monaco-editor')} monaco - The monaco-editor instance
 * @returns {() => void} Dispose function
 */
export function registerPyneLanguageSupport(monaco: typeof Monaco): () => void {
  const disposables: Monaco.IDisposable[] = [];

  // ── 1. Completion Provider ────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider("python", {
      triggerCharacters: ["."],
      provideCompletionItems(model, position) {
        if (!isPyneEditorModel(model)) return { suggestions: [] };
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        // Check if user typed "ta."
        if (/\bta\.\s*$/.test(textUntilPosition)) {
          return {
            suggestions: TA_FUNCTIONS.map((sourceItem) => {
              const item = localizePyneItem(sourceItem, `ta.${sourceItem.label}`);
              return ({
              label: item.label,
              kind: monacoCompletionKind(monaco, item.kind),
              detail: `ta.${item.label}${item.detail}`,
              documentation: { value: item.documentation, isTrusted: true },
              insertText: item.insertText,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: `0_${item.label}`,
              });
            }),
          };
        }

        // Check if user typed "input."
        if (/\binput\.\s*$/.test(textUntilPosition)) {
          return {
            suggestions: INPUT_FUNCTIONS.map((sourceItem) => {
              const item = localizePyneItem(sourceItem, `input.${sourceItem.label}`);
              return ({
              label: item.label,
              kind: monacoCompletionKind(monaco, item.kind),
              detail: `input.${item.label}${item.detail}`,
              documentation: { value: item.documentation, isTrusted: true },
              insertText: item.insertText,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: `0_${item.label}`,
              });
            }),
          };
        }

        // Check if user typed "color."
        if (/\bcolor\.\s*$/.test(textUntilPosition)) {
          return {
            suggestions: COLOR_MEMBERS.map((sourceItem) => {
              const item = localizePyneItem(sourceItem, `color.${sourceItem.label}`);
              return ({
              label: item.label,
              kind: monacoCompletionKind(monaco, item.kind),
              detail: item.detail,
              documentation: { value: item.documentation, isTrusted: true },
              insertText: item.insertText,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: `0_${item.label}`,
              });
            }),
          };
        }

        // Check if user typed "math."
        if (/\bmath\.\s*$/.test(textUntilPosition)) {
          return {
            suggestions: MATH_MEMBERS.map((sourceItem) => {
              const item = localizePyneItem(sourceItem, `math.${sourceItem.label}`);
              return ({
              label: item.label,
              kind: monacoCompletionKind(monaco, item.kind),
              detail: item.detail,
              documentation: { value: item.documentation, isTrusted: true },
              insertText: item.insertText,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: `0_${item.label}`,
              });
            }),
          };
        }

        // Default: global variables + functions + snippets
        const suggestions: Monaco.languages.CompletionItem[] = [];

        for (const sourceItem of GLOBAL_VARIABLES) {
          const item = localizePyneItem(sourceItem);
          suggestions.push({
            label: item.label,
            kind: monacoCompletionKind(monaco, item.kind),
            detail: item.detail,
            documentation: { value: item.documentation, isTrusted: true },
            insertText: item.insertText,
            range,
            sortText: `1_${item.label}`,
          });
        }

        for (const sourceItem of GLOBAL_FUNCTIONS) {
          const item = localizePyneItem(sourceItem);
          suggestions.push({
            label: item.label,
            kind: monacoCompletionKind(monaco, item.kind),
            detail: item.detail,
            documentation: { value: item.documentation, isTrusted: true },
            insertText: item.insertText,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: `2_${item.label}`,
          });
        }

        // Namespace triggers
        for (const ns of ["ta", "input", "color", "math"]) {
          const english = getLocale() === "en";
          suggestions.push({
            label: ns,
            kind: monaco.languages.CompletionItemKind.Module,
            detail: english ? `${ns}.* — type "${ns}." to list members` : `${ns}.* — 输入 "${ns}." 查看方法`,
            documentation: {
              value: english ? `Type \`${ns}.\` to trigger completion.` : `输入 \`${ns}.\` 触发自动补全`,
              isTrusted: true,
            },
            insertText: `${ns}.`,
            range,
            sortText: `0_${ns}`,
            command: { id: "editor.action.triggerSuggest", title: "trigger" },
          });
        }

        // Snippets
        for (const sourceItem of SNIPPET_ITEMS) {
          const item = localizePyneItem(sourceItem);
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: item.detail,
            documentation: { value: item.documentation, isTrusted: true },
            insertText: item.insertText,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: `9_${item.label}`,
          });
        }

        return { suggestions };
      },
    }),
  );

  // ── 2. Hover Provider ─────────────────────────────────────
  disposables.push(
    monaco.languages.registerHoverProvider("python", {
      provideHover(model, position) {
        if (!isPyneEditorModel(model)) return null;
        const word = model.getWordAtPosition(position);
        if (!word) return null;

        const line = model.getLineContent(position.lineNumber);
        const wordText = word.word;

        // Try to match "namespace.word" pattern
        const beforeWord = line.substring(0, word.startColumn - 1);
        const nsMatch = beforeWord.match(/\b(ta|input|color|math)\.\s*$/);
        const fullKey = nsMatch ? `${nsMatch[1]}.${wordText}` : wordText;

        const info = HOVER_MAP.get(fullKey);
        if (!info) return null;

        const localizedDocumentation = getLocale() === "en"
          ? englishPyneDocumentation(fullKey, info.detail)
          : info.documentation;

        const headerLine = nsMatch
          ? `**${nsMatch[1]}.${wordText}** ${info.detail}`
          : `**${wordText}** ${info.detail}`;

        return {
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          },
          contents: [{ value: headerLine }, { value: localizedDocumentation }],
        };
      },
    }),
  );

  // ── 3. Return dispose function ────────────────────────────
  return () => {
    for (const d of disposables) {
      d.dispose();
    }
  };
}

// ── Helper ──────────────────────────────────────────────────

function monacoCompletionKind(
  monaco: typeof Monaco,
  kind: PyneItemKind,
): Monaco.languages.CompletionItemKind {
  const map: Record<PyneItemKind, Monaco.languages.CompletionItemKind> = {
    Variable: monaco.languages.CompletionItemKind.Variable,
    Function: monaco.languages.CompletionItemKind.Function,
    Method: monaco.languages.CompletionItemKind.Method,
    Property: monaco.languages.CompletionItemKind.Property,
    Module: monaco.languages.CompletionItemKind.Module,
    Snippet: monaco.languages.CompletionItemKind.Snippet,
  };
  return map[kind];
}

export default registerPyneLanguageSupport;
