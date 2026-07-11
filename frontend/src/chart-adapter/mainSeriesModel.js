import { LineType } from "lightweight-charts";
import {
  isOhlcMainChartType,
  normalizeMainChartType,
} from "../shared/mainChartTypes.js";

const DEFAULT_UP_COLOR = "#22c55e";
const DEFAULT_DOWN_COLOR = "#ef4444";
const PRICE_LINE_COLOR = "#2962ff";
const TRANSPARENT_BODY_COLOR = "rgba(0, 0, 0, 0)";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validClose(row) {
  if (row?.__whitespace) return null;
  return finiteNumber(row?.close);
}

function validOhlc(row) {
  if (row?.__whitespace) return null;
  const open = finiteNumber(row?.open);
  const high = finiteNumber(row?.high);
  const low = finiteNumber(row?.low);
  const close = finiteNumber(row?.close);
  return open == null || high == null || low == null || close == null
    ? null
    : { open, high, low, close };
}

function withCandlestickColor(point, color) {
  if (!color) return point;
  return {
    ...point,
    color,
    borderColor: color,
    wickColor: color,
  };
}

function colorWithAlpha(color, alpha, fallback) {
  const value = String(color || "").trim();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value);
  const longHex = /^#([0-9a-f]{6})$/i.exec(value);
  const hex = longHex?.[1] || (shortHex?.[1]
    ? shortHex[1].split("").map((part) => `${part}${part}`).join("")
    : null);
  if (!hex) return fallback;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function buildIndicatorBarColorMap(indicatorBarcolors = []) {
  const colorMap = new Map();
  for (const group of indicatorBarcolors || []) {
    if (!Array.isArray(group?.data)) continue;
    for (const entry of group.data) {
      if (entry?.time != null && entry.color) colorMap.set(entry.time, entry.color);
    }
  }
  return colorMap;
}

export function toMainSeriesPoint(row, {
  chartType,
  downColor = DEFAULT_DOWN_COLOR,
  indicatorColor = null,
  previousClose = null,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  const time = row?.time;
  const finish = (point) => (row?.customValues
    ? { ...point, customValues: row.customValues }
    : point);
  if (row?.__whitespace || time == null) return finish({ time });

  if (isOhlcMainChartType(resolvedType)) {
    const ohlc = validOhlc(row);
    if (!ohlc) return finish({ time });
    const point = { time, ...ohlc };

    if (resolvedType === "high-low") {
      return finish(indicatorColor ? { ...point, color: indicatorColor } : point);
    }

    if (resolvedType === "hollow-candlestick") {
      const reference = finiteNumber(previousClose);
      const trendColor = indicatorColor || (
        reference == null ? (ohlc.close >= ohlc.open ? upColor : downColor)
          : (ohlc.close >= reference ? upColor : downColor)
      );
      return finish({
        ...point,
        color: ohlc.close >= ohlc.open ? TRANSPARENT_BODY_COLOR : trendColor,
        borderColor: trendColor,
        wickColor: trendColor,
      });
    }

    if (!indicatorColor) return finish(point);
    if (resolvedType === "bar") return finish({ ...point, color: indicatorColor });
    return finish(withCandlestickColor(point, indicatorColor));
  }

  const close = validClose(row);
  if (close == null) return finish({ time });
  if (resolvedType !== "histogram") return finish({ time, value: close });

  const reference = finiteNumber(previousClose);
  return finish({
    time,
    value: close,
    color: indicatorColor || (reference == null || close >= reference ? upColor : downColor),
  });
}

function previousCloseBefore(rows, startIndex) {
  for (let index = Math.min(startIndex - 1, rows.length - 1); index >= 0; index -= 1) {
    const close = validClose(rows[index]);
    if (close != null) return close;
  }
  return null;
}

export function createMainSeriesPointConverter(rows = [], {
  chartType,
  downColor = DEFAULT_DOWN_COLOR,
  indicatorBarColorMap = null,
  indicatorBarcolors = [],
  startIndex = 0,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  const colorMap = indicatorBarColorMap || buildIndicatorBarColorMap(indicatorBarcolors);
  let previousClose = previousCloseBefore(rows, startIndex);

  return (row) => {
    const close = validClose(row);
    const indicatorColor = colorMap.get(row?.time) || null;
    const point = toMainSeriesPoint(row, {
      chartType: resolvedType,
      downColor,
      indicatorColor,
      previousClose,
      upColor,
    });
    if (close != null) previousClose = close;
    return point;
  };
}

export function buildMainSeriesData(rows = [], options = {}) {
  const toPoint = createMainSeriesPointConverter(rows, { ...options, startIndex: 0 });
  return (rows || []).map(toPoint);
}

function finiteCloses(rows = []) {
  const closes = [];
  for (const row of rows || []) {
    const close = validClose(row);
    if (close != null) closes.push(close);
  }
  return closes;
}

export function buildMainSeriesReferenceOptions(chartType, rows = []) {
  const resolvedType = normalizeMainChartType(chartType);
  if (resolvedType !== "baseline" && resolvedType !== "histogram") return {};

  if (resolvedType === "baseline") {
    for (const row of rows || []) {
      const close = validClose(row);
      if (close != null) return { baseValue: { type: "price", price: close } };
    }
    return {};
  }

  const closes = finiteCloses(rows);
  if (closes.length === 0) return {};
  let minimum = closes[0];
  let maximum = closes[0];
  for (let index = 1; index < closes.length; index += 1) {
    minimum = Math.min(minimum, closes[index]);
    maximum = Math.max(maximum, closes[index]);
  }
  const spread = maximum - minimum;
  const padding = spread > 0
    ? spread * 0.08
    : Math.max(Math.abs(minimum) * 0.005, 1e-8);
  const candidate = minimum - padding;
  const base = minimum > 0 ? Math.max(minimum * 0.01, candidate) : candidate;
  return { base };
}

export function buildMainSeriesStyleOptions(chartType, {
  downColor = DEFAULT_DOWN_COLOR,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  if (resolvedType === "point-and-figure") {
    return { upColor, downColor, lineWidth: 2 };
  }
  if (resolvedType === "kagi") {
    return { upColor, downColor, lineWidth: 2, thickLineWidth: 4 };
  }
  if (resolvedType === "line-break") {
    return {
      upColor,
      downColor,
      borderDownColor: downColor,
      borderUpColor: upColor,
      wickVisible: false,
    };
  }
  if (resolvedType === "candlestick"
    || resolvedType === "hollow-candlestick"
    || resolvedType === "heikin-ashi"
    || resolvedType === "renko") {
    return {
      upColor,
      downColor,
      borderDownColor: downColor,
      borderUpColor: upColor,
      wickDownColor: downColor,
      wickUpColor: upColor,
    };
  }
  if (resolvedType === "bar") {
    return {
      upColor,
      downColor,
      openVisible: true,
      thinBars: true,
    };
  }
  if (resolvedType === "high-low") {
    return { color: PRICE_LINE_COLOR };
  }
  if (resolvedType === "line"
    || resolvedType === "line-with-markers"
    || resolvedType === "step-line") {
    return {
      color: PRICE_LINE_COLOR,
      lineWidth: 2,
      lineType: resolvedType === "step-line" ? LineType.WithSteps : LineType.Simple,
      pointMarkersVisible: resolvedType === "line-with-markers",
      ...(resolvedType === "line-with-markers" ? { pointMarkersRadius: 3 } : {}),
      crosshairMarkerVisible: true,
    };
  }
  if (resolvedType === "area") {
    return {
      lineColor: PRICE_LINE_COLOR,
      lineWidth: 2,
      topColor: "rgba(41, 98, 255, 0.38)",
      bottomColor: "rgba(41, 98, 255, 0.04)",
      crosshairMarkerVisible: true,
    };
  }
  if (resolvedType === "baseline") {
    return {
      topLineColor: upColor,
      topFillColor1: colorWithAlpha(upColor, 0.28, "rgba(34, 197, 94, 0.28)"),
      topFillColor2: colorWithAlpha(upColor, 0.05, "rgba(34, 197, 94, 0.05)"),
      bottomLineColor: downColor,
      bottomFillColor1: colorWithAlpha(downColor, 0.05, "rgba(239, 68, 68, 0.05)"),
      bottomFillColor2: colorWithAlpha(downColor, 0.28, "rgba(239, 68, 68, 0.28)"),
      lineWidth: 2,
    };
  }
  return { color: upColor };
}

export function buildMainSeriesOptions(chartType, options = {}, rows = []) {
  return {
    ...buildMainSeriesStyleOptions(chartType, options),
    ...buildMainSeriesReferenceOptions(chartType, rows),
  };
}

export function buildMainSeriesCrosshairValue(time, displayRow, {
  includeVolume = true,
  volumeRow = displayRow,
} = {}) {
  const open = finiteNumber(displayRow?.open);
  const high = finiteNumber(displayRow?.high);
  const low = finiteNumber(displayRow?.low);
  const close = finiteNumber(displayRow?.close);
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return {
    time,
    open,
    high,
    low,
    close,
    volume: includeVolume ? (finiteNumber(volumeRow?.volume) || 0) : null,
  };
}
