import { chartSeriesTypes } from "./lightweightChartSurface.js";
import { buildMainSeriesData, buildMainSeriesOptions } from "./mainSeriesModel.js";
import { normalizeMainChartType } from "../shared/mainChartTypes.js";

export function createMainSeries(chart, {
  chartType,
  data = [],
  downColor,
  paneIndex,
  upColor,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  return chart.addSeries(
    chartSeriesTypes[resolvedType],
    buildMainSeriesOptions(resolvedType, { upColor, downColor }, data),
    paneIndex,
  );
}

export function replaceMainSeries(chart, previousSeries, {
  chartType,
  data = [],
  downColor,
  indicatorBarColorMap = null,
  indicatorBarcolors = [],
  paneIndex,
  upColor,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  const seriesData = buildMainSeriesData(data, {
    chartType: resolvedType,
    downColor,
    indicatorBarColorMap,
    indicatorBarcolors,
    upColor,
  });
  const previousOrder = previousSeries?.seriesOrder?.();
  const series = createMainSeries(chart, {
    chartType: resolvedType,
    data,
    downColor,
    paneIndex,
    upColor,
  });

  try {
    series.setData(seriesData);
    if (Number.isFinite(previousOrder) && typeof series.setSeriesOrder === "function") {
      series.setSeriesOrder(previousOrder);
    }
    chart.removeSeries(previousSeries);
  } catch (error) {
    try { chart.removeSeries(series); } catch { /* best-effort rollback */ }
    throw error;
  }

  return { chartType: resolvedType, data: seriesData, series };
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
