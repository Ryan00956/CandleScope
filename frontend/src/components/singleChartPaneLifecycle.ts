import type { ChartSurfaceVisibleRange } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { ChartDataCommitMeta } from "../features/market-data/useChartDataRuntime.js";
import type { SeriesWindowStore } from "../features/market-data/window/seriesWindowStore.js";

const EMPTY_DATA_TIME_SET: ReadonlySet<number> = new Set<number>();

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface RequestMoreLeftOptions {
  canLoad?: boolean;
  hasData?: boolean;
  hasHandler?: boolean;
  rangeFrom?: number | null;
  triggerBars?: number | null;
  userInteracted?: boolean;
}

export function shouldRequestMoreLeft({
  canLoad = false,
  hasData = false,
  hasHandler = false,
  rangeFrom,
  triggerBars,
  userInteracted = false,
}: RequestMoreLeftOptions = {}): boolean {
  return Boolean(
    userInteracted
    && canLoad
    && hasData
    && hasHandler
    && finiteNumber(rangeFrom)
    && finiteNumber(triggerBars)
    && rangeFrom <= triggerBars
  );
}

export function resolveDataTimeSet(
  seriesStore: Pick<SeriesWindowStore, "timeSet"> | null | undefined,
): ReadonlySet<number> {
  return seriesStore?.timeSet?.() || EMPTY_DATA_TIME_SET;
}

export function hasCurrentDatasetOwnership({
  dataMeta,
  datasetKey,
  seriesStore,
}: {
  dataMeta?: Pick<ChartDataCommitMeta, "optimistic" | "seriesKey"> | null;
  datasetKey?: string | null;
  seriesStore?: Pick<SeriesWindowStore, "seriesKey"> | null;
} = {}): boolean {
  return Boolean(
    datasetKey
    && !dataMeta?.optimistic
    && dataMeta?.seriesKey === datasetKey
    && seriesStore?.seriesKey === datasetKey
  );
}

export function resolveIntervalTransitionReplayData<TData, TSeries>({
  currentData,
  currentGeneration,
  currentSeries,
  fallbackData,
  scheduledGeneration,
  scheduledSeries,
}: {
  currentData: TData;
  currentGeneration: number;
  currentSeries: TSeries;
  fallbackData: TData;
  scheduledGeneration: number;
  scheduledSeries: TSeries;
}): TData {
  if (
    currentSeries !== scheduledSeries
    || currentGeneration !== scheduledGeneration
  ) {
    return currentData;
  }
  return fallbackData;
}

export function buildVisibleRangeSnapshot({
  barSpacing,
  logicalRange,
  rightOffset,
  timeRange,
}: {
  barSpacing?: number | null;
  logicalRange?: { from?: number | null; to?: number | null } | null;
  rightOffset?: number | null;
  timeRange?: { from?: number | null; to?: number | null } | null;
} = {}): ChartSurfaceVisibleRange | null {
  const snapshot: ChartSurfaceVisibleRange = {};
  if (finiteNumber(barSpacing)) snapshot.barSpacing = barSpacing;
  if (finiteNumber(rightOffset)) snapshot.rightOffset = rightOffset;

  if (finiteNumber(timeRange?.from) && finiteNumber(timeRange?.to)) {
    snapshot.time = { from: timeRange.from, to: timeRange.to };
    snapshot.rightmostTime = timeRange.to;
  }

  if (finiteNumber(logicalRange?.from) && finiteNumber(logicalRange?.to)) {
    snapshot.logical = { from: logicalRange.from, to: logicalRange.to };
  }

  return snapshot.time || snapshot.logical ? snapshot : null;
}

export function shouldPublishUserViewportRange({
  isProgrammatic = false,
  isSyncing = false,
  range = null,
  userInteracted = false,
}: {
  isProgrammatic?: boolean;
  isSyncing?: boolean;
  range?: object | null;
  userInteracted?: boolean;
} = {}): boolean {
  return Boolean(range && userInteracted && !isProgrammatic && !isSyncing);
}

export function shouldRestoreChartViewport({
  dataMeta,
  datasetKey,
  hasRestored = false,
  hasRows = false,
  lastRestoreSource = null,
  userInteracted = false,
}: {
  dataMeta?: Pick<ChartDataCommitMeta, "seriesKey" | "source" | "status"> | null;
  datasetKey?: string | null;
  hasRestored?: boolean;
  hasRows?: boolean;
  lastRestoreSource?: string | null;
  userInteracted?: boolean;
} = {}): boolean {
  const readyForDataset = Boolean(
    hasRows
    && dataMeta?.status === "ready"
    && dataMeta?.seriesKey === datasetKey
  );
  if (!readyForDataset) return false;
  if (userInteracted) return false;
  if (!hasRestored) return true;

  const source = String(dataMeta?.source || "");
  const previousSource = String(lastRestoreSource || "");
  return source.startsWith("initial-history")
    && !previousSource.startsWith("initial-history");
}

export function shouldAdvanceIndicatorSeriesReady({
  createdSeriesCount = 0,
  paneStructureChanged = false,
  removedSeriesCount = 0,
  structureChanged = false,
}: {
  createdSeriesCount?: number;
  paneStructureChanged?: boolean;
  removedSeriesCount?: number;
  structureChanged?: boolean;
} = {}): boolean {
  return Boolean(
    structureChanged
    || paneStructureChanged
    || removedSeriesCount > 0
    || createdSeriesCount > 0
  );
}

export function shouldAdvanceDrawingCoordinateGeneration({
  axisMode,
  canReuseProjection = true,
}: {
  axisMode?: string | null;
  canReuseProjection?: boolean;
} = {}): boolean {
  return axisMode === "derived-ordinal" && !canReuseProjection;
}

/**
 * Tear down a Lightweight Charts surface without leaving its auto-size
 * observer able to enqueue work against already-disposed canvas bindings.
 * Both operations are best-effort because cleanup can run after a partial
 * chart construction failure.
 */
export function disposeChartPaneSurface(
  chart: {
    applyOptions?(options: { autoSize: boolean }): unknown;
    remove?(): unknown;
  } | null | undefined,
  { beforeRemove }: { beforeRemove?: (() => void) | null } = {},
): void {
  if (!chart) return;

  try {
    beforeRemove?.();
  } catch {
    // Drawing teardown is best-effort; chart disposal must still continue.
  }

  try {
    chart.applyOptions?.({ autoSize: false });
  } catch {
    // The chart may already be partially disposed.
  }

  try {
    chart.remove?.();
  } catch {
    // Best-effort teardown.
  }
}
