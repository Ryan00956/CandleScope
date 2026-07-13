import { chartSeriesTypes } from "./lightweightChartSurface.js";
import { createHighLowSeriesPaneView } from "./highLowSeries.js";
import { createKagiSeriesPaneView } from "./kagiSeries.js";
import { createPointFigureSeriesPaneView } from "./pointFigureSeries.js";
import { buildMainSeriesData, buildMainSeriesOptions } from "./mainSeriesModel.js";
import { getChartTypeDescriptor } from "../features/chart-representation/chartTypeRegistry.js";
import { normalizeMainChartType } from "../shared/mainChartTypes.js";
import type {
  IChartApiBase,
  ISeriesApi,
} from "lightweight-charts";
import type { MainChartType } from "../shared/mainChartTypes.js";
import type {
  ChartSeriesInputRow,
  ChartTime,
  IndicatorBarcolorGroup,
  IndicatorSeriesDefinition,
  IndicatorSeriesHandle,
  MainSeriesHandle,
} from "./chartAdapterTypes.js";

export const INDICATOR_SERIES_INCREMENTAL_GRACE_MS = 1_500;

type AdapterChart = IChartApiBase<ChartTime>;
type FutureAxisSeries = ISeriesApi<"Line", ChartTime>;

function addDynamicMainSeries(
  chart: AdapterChart,
  method: "addSeries" | "addCustomSeries",
  ...args: unknown[]
): MainSeriesHandle {
  const series: unknown = Reflect.apply(chart[method], chart, args);
  return series as MainSeriesHandle;
}

function setDynamicSeriesData(
  series: MainSeriesHandle,
  data: ChartSeriesInputRow[],
): void {
  Reflect.apply(series.setData, series, [data]);
}

function isBuiltInRendererId(
  rendererId: string,
): rendererId is keyof typeof chartSeriesTypes {
  return Object.prototype.hasOwnProperty.call(chartSeriesTypes, rendererId);
}

export function shouldPreferIndicatorSetData({
  createdAtMs,
  nowMs = Date.now(),
  usesDerivedAxis = false,
}: {
  createdAtMs?: unknown;
  nowMs?: unknown;
  usesDerivedAxis?: boolean;
} = {}): boolean {
  if (usesDerivedAxis) return true;
  if (createdAtMs == null || nowMs == null) return true;
  const created = Number(createdAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return true;
  return now - created < INDICATOR_SERIES_INCREMENTAL_GRACE_MS;
}

export function resyncSeriesTimeScaleIndexes(
  series: MainSeriesHandle | null | undefined,
  data: ChartSeriesInputRow[] | null | undefined,
): number {
  if (typeof series?.setData !== "function") return 0;
  if (!Array.isArray(data) || data.length === 0) return 0;

  // Lightweight Charts v5 keeps logical-index lookup state per series. During
  // a multi-pane interval transition, series can update the shared time scale
  // just before interval-specific chart options trigger a full repaint.
  // Replaying CandleScope's complete render snapshot refreshes that lookup
  // state without dropping whitespace or custom-series fields that are not
  // recoverable through the public series.data() projection.
  setDynamicSeriesData(series, data);
  return data.length;
}

export function createMainSeries(chart: AdapterChart, {
  chartType,
  data = [],
  downColor,
  paneIndex,
  upColor,
}: {
  chartType?: MainChartType | string | null;
  data?: ChartSeriesInputRow[];
  downColor?: string;
  paneIndex?: number;
  upColor?: string;
} = {}): MainSeriesHandle {
  const resolvedType = normalizeMainChartType(chartType);
  const options = buildMainSeriesOptions(resolvedType, { upColor, downColor }, data);
  const rendererId = getChartTypeDescriptor(resolvedType).rendererId;
  if (rendererId === "high-low") {
    return addDynamicMainSeries(
      chart,
      "addCustomSeries",
      createHighLowSeriesPaneView(),
      options,
      paneIndex,
    );
  }
  if (rendererId === "point-and-figure") {
    return addDynamicMainSeries(
      chart,
      "addCustomSeries",
      createPointFigureSeriesPaneView(),
      options,
      paneIndex,
    );
  }
  if (rendererId === "kagi") {
    return addDynamicMainSeries(
      chart,
      "addCustomSeries",
      createKagiSeriesPaneView(),
      options,
      paneIndex,
    );
  }
  if (!isBuiltInRendererId(rendererId)) {
    throw new Error(`unknown main-series renderer: ${rendererId}`);
  }
  const seriesType = chartSeriesTypes[rendererId];
  return addDynamicMainSeries(chart, "addSeries", seriesType, options, paneIndex);
}

export function createFutureTimeAxisSeries(
  chart: AdapterChart,
  { paneIndex = 0 }: { paneIndex?: number } = {},
): FutureAxisSeries {
  return chart.addSeries(chartSeriesTypes.line, {
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    title: "",
    visible: false,
  }, paneIndex);
}

export function replaceMainSeries(chart: AdapterChart, previousSeries: MainSeriesHandle, {
  chartType,
  data = [],
  downColor,
  indicatorBarColorMap = null,
  indicatorBarcolors = [],
  paneIndex,
  previousSeriesData = null,
  seriesData = null,
  upColor,
}: {
  chartType?: MainChartType | string | null;
  data?: ChartSeriesInputRow[];
  downColor?: string;
  indicatorBarColorMap?: ReadonlyMap<ChartTime, string> | null;
  indicatorBarcolors?: IndicatorBarcolorGroup[];
  paneIndex?: number;
  previousSeriesData?: ChartSeriesInputRow[] | null;
  seriesData?: ChartSeriesInputRow[] | null;
  upColor?: string;
} = {}): {
  chartType: MainChartType;
  data: ChartSeriesInputRow[];
  series: MainSeriesHandle;
} {
  const resolvedType = normalizeMainChartType(chartType);
  const nextSeriesData = Array.isArray(seriesData)
    ? seriesData
    : buildMainSeriesData(data, {
      chartType: resolvedType,
      downColor,
      indicatorBarColorMap,
      indicatorBarcolors,
      upColor,
    });
  const previousOrder = previousSeries?.seriesOrder?.();
  const rollbackData = Array.isArray(previousSeriesData)
    ? previousSeriesData
    : (typeof previousSeries?.data === "function"
      ? Reflect.apply(previousSeries.data, previousSeries, [])
      : null);
  const series = createMainSeries(chart, {
    chartType: resolvedType,
    data,
    downColor,
    paneIndex,
    upColor,
  });

  try {
    // Avoid registering the same time points on two main-series instances at
    // once. Lightweight Charts can otherwise leave stale logical indexes when
    // the old series is removed, especially while another pane shares the
    // time scale.
    previousSeries?.setData?.([]);
    setDynamicSeriesData(series, nextSeriesData);
    if (Number.isFinite(previousOrder) && typeof series.setSeriesOrder === "function") {
      series.setSeriesOrder(previousOrder);
    }
    chart.removeSeries(previousSeries);
  } catch (error) {
    try { chart.removeSeries(series); } catch { /* best-effort rollback */ }
    try {
      if (Array.isArray(rollbackData)) {
        Reflect.apply(previousSeries.setData, previousSeries, [rollbackData]);
      }
    } catch { /* best-effort rollback */ }
    throw error;
  }

  return { chartType: resolvedType, data: nextSeriesData, series };
}

export function buildIndicatorSeriesOptions(
  line: IndicatorSeriesDefinition | null | undefined,
  { crosshairMarkerVisible = true }: { crosshairMarkerVisible?: boolean } = {},
): Record<string, unknown> {
  const isHistogram = line?.type === "histogram";
  const options: Record<string, unknown> = {
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

  return options;
}

export function createIndicatorSeries(
  chart: AdapterChart,
  line: IndicatorSeriesDefinition,
  {
    crosshairMarkerVisible = true,
    paneIndex,
  }: { crosshairMarkerVisible?: boolean; paneIndex?: number } = {},
): IndicatorSeriesHandle {
  const isHistogram = line?.type === "histogram";
  const seriesType = isHistogram ? chartSeriesTypes.histogram : chartSeriesTypes.line;
  const options = buildIndicatorSeriesOptions(line, { crosshairMarkerVisible });

  const series: unknown = Reflect.apply(chart.addSeries, chart, [
    seriesType,
    options,
    paneIndex,
  ]);
  return series as IndicatorSeriesHandle;
}

export function removeSeriesEntries(
  chart: AdapterChart,
  entries: Array<{ series: IndicatorSeriesHandle }> = [],
): number {
  let removed = 0;
  for (const entry of entries) {
    try {
      // Invalidate pending pane views before detaching the series. Hosted
      // indicator snapshots can rebuild several line series within one frame;
      // removing populated series directly lets Lightweight Charts render a
      // stale view against an already-empty bar store.
      Reflect.apply(entry.series.setData, entry.series, [[]]);
    } catch {
      // Continue with detach; the series may already be partially torn down.
    }
    try {
      chart.removeSeries(entry.series);
      removed += 1;
    } catch {
      // Chart cleanup is best-effort because series may already be detached.
    }
  }
  return removed;
}
