import type { ChartSurfaceVisibleRange } from "../chart-adapter/useChartSurfaceRuntime.js";
import { linePointEquals } from "../chart-adapter/chartSeriesData.js";
import type { IndicatorDataEntry } from "../chart-adapter/chartAdapterTypes.js";
import type { ChartDataCommitMeta } from "../features/market-data/useChartDataRuntime.js";
import type { SeriesWindowStore } from "../features/market-data/window/seriesWindowStore.js";

const EMPTY_DATA_TIME_SET: ReadonlySet<number> = new Set<number>();

export function removedDrawingSubPaneScopeKeys({
  currentBase,
  currentIds,
  previousBase,
  previousIds,
}: Readonly<{
  currentBase: string;
  currentIds: ReadonlySet<string>;
  previousBase: string | null;
  previousIds: ReadonlySet<string>;
}>): string[] {
  if (!currentBase || previousBase !== currentBase) return [];
  const removed: string[] = [];
  for (const previousId of previousIds) {
    if (!currentIds.has(previousId)) removed.push(`${currentBase}__${previousId}`);
  }
  return removed;
}

export function prepareDrawingSurfaceForSeriesReplacement(
  prepare: (() => boolean | void) | null | undefined,
  requestRestore: () => void,
): boolean {
  if (!prepare) return true;
  try {
    if (prepare() !== false) return true;
  } catch {
    // A throwing prepare may already have detached a prefix.
  }
  requestRestore();
  return false;
}

export function resolveDrawingSurfaceChartTypeBoundary(
  beforeValue: string | null | undefined,
  afterValue: string | null | undefined,
): Readonly<{
  kind: "chart-type";
  beforeValue: string;
  afterValue: string;
}> | undefined {
  const before = beforeValue?.trim() || "";
  const after = afterValue?.trim() || "";
  if (!before || !after || before === after) return undefined;
  return Object.freeze({ kind: "chart-type", beforeValue: before, afterValue: after });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface RequestMoreLeftOptions {
  canLoad?: boolean;
  consumedInteractionGeneration?: number;
  hasData?: boolean;
  hasHandler?: boolean;
  interactionGeneration?: number;
  rangeFrom?: number | null;
  triggerBars?: number | null;
  userInteracted?: boolean;
}

export interface LeftHistoryDemandDecision {
  demanded: boolean;
  shouldRequest: boolean;
}

export function resolveLeftHistoryDemand({
  canLoad = false,
  consumedInteractionGeneration = 0,
  hasData = false,
  hasHandler = false,
  rangeFrom,
  triggerBars,
  userInteracted = false,
  interactionGeneration = userInteracted ? 1 : 0,
}: RequestMoreLeftOptions = {}): LeftHistoryDemandDecision {
  const hasUnconsumedInteraction = Number.isSafeInteger(interactionGeneration)
    && interactionGeneration > 0
    && Number.isSafeInteger(consumedInteractionGeneration)
    && interactionGeneration > consumedInteractionGeneration;
  const demanded = Boolean(
    userInteracted
    && hasUnconsumedInteraction
    && hasData
    && hasHandler
    && finiteNumber(rangeFrom)
    && finiteNumber(triggerBars)
    && rangeFrom <= triggerBars
  );
  return { demanded, shouldRequest: demanded && canLoad };
}

export function shouldRequestMoreLeft({
  canLoad = false,
  hasData = false,
  hasHandler = false,
  rangeFrom,
  triggerBars,
  userInteracted = false,
}: RequestMoreLeftOptions = {}): boolean {
  return resolveLeftHistoryDemand({
    canLoad,
    hasData,
    hasHandler,
    ...(rangeFrom === undefined ? {} : { rangeFrom }),
    ...(triggerBars === undefined ? {} : { triggerBars }),
    userInteracted,
  }).shouldRequest;
}

export function shouldRequestRightWindowRestore({
  barCount = 0,
  canLoad = false,
  consumedInteractionGeneration = 0,
  hasHandler = false,
  rangeTo,
  rightTruncated = false,
  triggerBars = 0,
  userInteracted = false,
  interactionGeneration = userInteracted ? 1 : 0,
}: {
  barCount?: number;
  canLoad?: boolean;
  consumedInteractionGeneration?: number;
  hasHandler?: boolean;
  interactionGeneration?: number;
  rangeTo?: number | null;
  rightTruncated?: boolean;
  triggerBars?: number;
  userInteracted?: boolean;
} = {}): boolean {
  if (
    !userInteracted
    || !canLoad
    || !Number.isSafeInteger(interactionGeneration)
    || !Number.isSafeInteger(consumedInteractionGeneration)
    || interactionGeneration <= consumedInteractionGeneration
    || !hasHandler
    || !rightTruncated
    || !Number.isSafeInteger(barCount)
    || barCount <= 0
    || !finiteNumber(rangeTo)
    || !finiteNumber(triggerBars)
  ) return false;
  return rangeTo >= Math.max(0, barCount - 1 - Math.max(0, triggerBars));
}

export function sameIndicatorSeriesData(
  left: readonly IndicatorDataEntry[] | null | undefined,
  right: readonly IndicatorDataEntry[] | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!linePointEquals(left[index], right[index])) return false;
  }
  return true;
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

const CHART_PAN_MIN_HORIZONTAL_DISTANCE_PX = 4;
const MAIN_PANE_PLOT_EDGE_GUARD_PX = 4;
const CHART_WHEEL_MIN_DELTA = 0.01;

export function isMainPanePlotPointerStart({
  clientX,
  clientY,
  containerRect,
  plotRect,
}: {
  clientX?: number | null;
  clientY?: number | null;
  containerRect?: Readonly<{ left: number; top: number }> | null;
  plotRect?: Readonly<{ height: number; width: number; x: number; y: number }> | null;
} = {}): boolean {
  if (!finiteNumber(clientX)
    || !finiteNumber(clientY)
    || !finiteNumber(containerRect?.left)
    || !finiteNumber(containerRect?.top)
    || !finiteNumber(plotRect?.x)
    || !finiteNumber(plotRect?.y)
    || !finiteNumber(plotRect?.width)
    || !finiteNumber(plotRect?.height)
    || plotRect.width <= MAIN_PANE_PLOT_EDGE_GUARD_PX * 2
    || plotRect.height <= MAIN_PANE_PLOT_EDGE_GUARD_PX * 2) return false;
  const localX = clientX - containerRect.left;
  const localY = clientY - containerRect.top;
  return localX >= plotRect.x + MAIN_PANE_PLOT_EDGE_GUARD_PX
    && localX < plotRect.x + plotRect.width - MAIN_PANE_PLOT_EDGE_GUARD_PX
    && localY >= plotRect.y + MAIN_PANE_PLOT_EDGE_GUARD_PX
    && localY < plotRect.y + plotRect.height - MAIN_PANE_PLOT_EDGE_GUARD_PX;
}

export function shouldInvalidateDrawingFrameOnPointerRelease({
  drawingToolActive = false,
  logicalRangeChanged = false,
  mainPanePlotStart = false,
  maxHorizontalMovementPx = 0,
  maxVerticalMovementPx = 0,
  pointerActive = false,
}: {
  drawingToolActive?: boolean;
  logicalRangeChanged?: boolean;
  mainPanePlotStart?: boolean;
  maxHorizontalMovementPx?: number;
  maxVerticalMovementPx?: number;
  pointerActive?: boolean;
} = {}): boolean {
  if (!pointerActive) return false;
  return !isConfirmedMainPaneHorizontalPan({
    drawingToolActive,
    logicalRangeChanged,
    mainPanePlotStart,
    maxHorizontalMovementPx,
    maxVerticalMovementPx,
    pointerActive,
  });
}

export function isConfirmedMainPaneHorizontalPan({
  drawingToolActive = false,
  logicalRangeChanged = false,
  mainPanePlotStart = false,
  maxHorizontalMovementPx = 0,
  maxVerticalMovementPx = 0,
  pointerActive = false,
}: {
  drawingToolActive?: boolean;
  logicalRangeChanged?: boolean;
  mainPanePlotStart?: boolean;
  maxHorizontalMovementPx?: number;
  maxVerticalMovementPx?: number;
  pointerActive?: boolean;
} = {}): boolean {
  if (!pointerActive) return false;
  const horizontalMovement = finiteNumber(maxHorizontalMovementPx)
    ? Math.abs(maxHorizontalMovementPx)
    : 0;
  const verticalMovement = finiteNumber(maxVerticalMovementPx)
    ? Math.abs(maxVerticalMovementPx)
    : 0;
  return logicalRangeChanged
    && !drawingToolActive
    && mainPanePlotStart
    && horizontalMovement >= CHART_PAN_MIN_HORIZONTAL_DISTANCE_PX
    && horizontalMovement > verticalMovement;
}

export function shouldIssueHistoryTicketForWheel({
  deltaX = 0,
  deltaY = 0,
  drawingToolActive = false,
  mainPanePlotStart = false,
}: {
  deltaX?: number;
  deltaY?: number;
  drawingToolActive?: boolean;
  mainPanePlotStart?: boolean;
} = {}): boolean {
  if (drawingToolActive || !mainPanePlotStart) return false;
  const horizontalDelta = finiteNumber(deltaX) ? Math.abs(deltaX) : 0;
  const verticalDelta = finiteNumber(deltaY) ? Math.abs(deltaY) : 0;
  return Math.max(horizontalDelta, verticalDelta) >= CHART_WHEEL_MIN_DELTA;
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
  {
    afterRemove,
    beforeRemove,
  }: {
    afterRemove?: (() => boolean | void) | null;
    beforeRemove?: (() => boolean | void) | null;
  } = {},
): boolean {
  if (!chart) return true;

  let drawingsPrepared = true;
  try {
    drawingsPrepared = beforeRemove?.() !== false;
  } catch {
    drawingsPrepared = false;
  }

  try {
    chart.applyOptions?.({ autoSize: false });
  } catch {
    // The chart may already be partially disposed.
  }

  let removed = false;
  try {
    if (chart.remove) {
      chart.remove();
      removed = true;
    }
  } catch {
    // Best-effort teardown.
  }
  // The effect will never reuse this chart object, even when remove() throws
  // after partially destroying it. Always invalidate drawing credentials so a
  // replacement surface cannot mistake old-series objects for attachments.
  let drawingsCompleted = true;
  try {
    drawingsCompleted = afterRemove?.() !== false;
  } catch {
    drawingsCompleted = false;
  }
  return drawingsPrepared && drawingsCompleted && removed;
}
