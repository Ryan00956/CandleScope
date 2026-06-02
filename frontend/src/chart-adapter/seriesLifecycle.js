import { chartSeriesTypes } from "./lightweightChartSurface.js";

export function createMainSeries(chart, { upColor, downColor, paneIndex } = {}) {
  return chart.addSeries(chartSeriesTypes.candlestick, {
    upColor: upColor || "#22c55e",
    downColor: downColor || "#ef4444",
    borderDownColor: downColor || "#ef4444",
    borderUpColor: upColor || "#22c55e",
    wickDownColor: downColor || "#ef4444",
    wickUpColor: upColor || "#22c55e",
  }, paneIndex);
}

export function createIndicatorSeries(chart, line, { crosshairMarkerVisible = true, paneIndex } = {}) {
  const isHistogram = line?.type === "histogram";
  const seriesType = isHistogram ? chartSeriesTypes.histogram : chartSeriesTypes.line;
  const options = {
    color: line?.color || "#f59e0b",
    lineWidth: isHistogram ? undefined : (line?.lineWidth || 2),
    lineStyle: isHistogram ? undefined : (line?.lineStyle || 0),
    title: "",
    visible: true,
    priceScaleId: "right",
    lastValueVisible: false,
    priceLineVisible: false,
  };

  if (!isHistogram) {
    options.crosshairMarkerVisible = crosshairMarkerVisible;
  }

  if (isHistogram) {
    options.priceFormat = { type: "volume" };
  }

  return chart.addSeries(seriesType, options, paneIndex);
}

export function removeSeriesEntries(chart, entries = []) {
  let removed = 0;
  for (const entry of entries) {
    try {
      chart.removeSeries(entry.series);
      removed += 1;
    } catch {
      // Chart cleanup is best-effort because series may already be detached.
    }
  }
  return removed;
}
