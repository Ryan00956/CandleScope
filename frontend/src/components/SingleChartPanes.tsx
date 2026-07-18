/**
 * SingleChartPanes — lightweight-charts v5 native panes path.
 *
 * Uses one chart instance for the selected main price series and all indicator panes so every
 * series shares the same time scale.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentType,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createLightweightChartAdapter } from "../chart-adapter/chartInstanceBridge";
import {
  createDrawingFrameSnapshotFactory,
  createDrawingViewportSignature,
} from "../chart-adapter/drawingFrameSnapshot";
import type { DrawingFrameSnapshot } from "../chart-adapter/drawingFrameSnapshot.js";
import {
  applyChartPaneAppearance,
  buildChartPaneOptions,
  buildCrosshairOptions,
} from "../chart-adapter/chartPaneLifecycle";
import {
  buildPaneLayoutOptions,
  chartSeriesTypes,
  createChartInstance,
} from "../chart-adapter/lightweightChartSurface";
import {
  applyIndicatorPaneSeriesOrder,
  buildIndicatorSeriesOptions,
  createFutureTimeAxisSeries,
  createIndicatorSeries,
  createMainSeries,
  removeSeriesEntries,
  replaceMainSeries,
  resyncSeriesTimeScaleIndexes,
  shouldPreferIndicatorSetData,
} from "../chart-adapter/seriesLifecycle";
import {
  ensurePane,
  materializePaneLayout,
  readPaneHeights,
  setPaneHeights,
  trimPanes,
} from "../chart-adapter/paneManager";
import { renderFillSeries, renderHlines } from "../chart-adapter/overlaySeriesRenderer";
import { renderMarkers } from "../chart-adapter/markerRenderer";
import { renderBgcolors } from "../chart-adapter/bgcolorPrimitiveRenderer";
import {
  buildMainSeriesProjectionPatch,
  materializeMainSeriesProjectionPatch,
  renderMainSeriesProjectionPatch,
} from "../chart-adapter/projectionSeriesRenderer";
import { createViewportController } from "../chart-adapter/viewportController";
import {
  buildMainSeriesCrosshairValue,
  buildMainSeriesReferenceOptions,
  buildMainSeriesStyleOptions,
  buildIndicatorBarColorMap,
} from "../chart-adapter/mainSeriesModel";
import {
  canReuseFutureTimeAxisData,
  countFutureTimeAxisPointsAfter,
  FUTURE_TIME_AXIS_INITIAL_POINTS,
  planFutureTimeAxis,
  resolveFutureTimeAxisPointCount,
} from "../chart-adapter/futureTimeAxis";
import {
  alignIndicatorBgcolorsToTimes,
  alignIndicatorLinesToTimes,
  alignIndicatorMarkersToTimes,
  applyLineSeriesData,
  buildFillRenderEntries,
  normalizeLineSeriesData,
} from "../chart-adapter/chartSeriesData";
import { normalizeMainChartType } from "../shared/mainChartTypes";
import { parseIntervalSeconds } from "../utils/intervals";
import PaneControlBar from "./PaneControlBar";
import {
  composeDrawingPaneExportLeases,
  drawingPaneIdAfterPointerLeave,
  drawingToolForPane,
  drawingPaneScopeKey,
  reconcileDrawingPaneHostMountKeys,
  resolveDrawingInteractionPaneId,
} from "./drawingPaneSurface";
import {
  buildPaneHeightPlan,
  movePaneInOrder,
  reconcilePaneOrder,
} from "./paneControlModel";
import { planVisibleRangeRestore } from "../features/chart-session/visibleRangeStorage";
import {
  buildPaneConfigKey,
  loadPaneHeights,
  loadPaneOrder,
  savePaneHeights,
  savePaneOrder,
} from "../features/chart-session/paneLayoutStorage";
import { createDrawingLineageIndex } from "../features/chart-representation/drawingLineageIndex";
import {
  buildVisibleRangeSnapshot,
  disposeChartPaneSurface,
  hasCurrentDatasetOwnership,
  isMainPanePlotPointerStart,
  resolveIntervalTransitionReplayData,
  resolveDataTimeSet,
  removedDrawingSubPaneScopeKeys,
  prepareDrawingSurfaceForSeriesReplacement,
  resolveDrawingSurfaceChartTypeBoundary,
  shouldAdvanceDrawingCoordinateGeneration,
  shouldAdvanceIndicatorSeriesReady,
  shouldInvalidateDrawingFrameOnPointerRelease,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport,
} from "./singleChartPaneLifecycle";
import {
  DRAWING_ENGINE_TOOL_IDS,
  loadDrawingEngineHost,
  preloadDrawingEngineHost,
  probeDrawingEnginePresence,
  shouldLoadDrawingEngine,
} from "../features/drawings/drawingEngineLoader";
import { prepareDrawingExportFailClosed } from "../features/drawings/export/drawingExportReadiness";
import {
  drawingToolForAnchorMode,
  supportsDrawingAnchorMode,
} from "../features/drawings/drawingCapabilities";
import {
  cursorOverlayClassForTool,
  cursorStyleForDrawingTool,
  shouldShowCrosshairDetails,
} from "../features/drawings/drawingModel";
import { clearDrawingScopeAuthoritatively } from "../features/drawings/drawingScopePersistence";
import { useDrawingFontMetricRevision } from "../features/drawings/text/drawingFontMetricRevision";
import {
  axisTimeKey,
  buildDisplaySourceTimeIndex,
  buildSurfaceViewportSnapshot,
  createProjector,
  getChartTypeDescriptor,
  isOrdinalAxisTime,
  isLastDisplayTargetForSourceTime,
  planSurfaceViewportRestore,
  ProjectionStore,
  projectPaneDescriptorsToDisplay,
  rememberSurfaceViewport,
  resolveKagiProjectorOptions,
  resolveLineBreakProjectorOptions,
  resolvePointFigureProjectorOptions,
  resolveRenkoProjectorOptions,
  shouldPreserveProjectionViewport,
  selectSurfaceViewportSnapshot,
  sourceTimeFromAxisTime,
} from "../features/chart-representation/index.js";
import { recordPerfEvent } from "../runtime/performance/perfMarks";
import type {
  ChartSeriesInputRow,
  ChartTime,
  FutureTimeAxisPlan,
  IndicatorLine as AdapterIndicatorLine,
  IndicatorSeriesHandle,
  MainSeriesCrosshairValue,
  MainSeriesHandle,
  NormalizedIndicatorDataEntry,
} from "../chart-adapter/chartAdapterTypes.js";
import type { ChartSurfaceHandle, ChartSurfaceVisibleRange } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { ViewportController } from "../chart-adapter/viewportController.js";
import type {
  AxisTime,
  DisplayRow,
  DisplaySourceTimeIndex,
  KagiProjectionOptions,
  LineBreakProjectionOptions,
  PointFigureProjectionOptions,
  RenkoProjectionOptions,
  SourceBar,
  SurfaceViewportSnapshot,
} from "../features/chart-representation/chartRepresentationTypes.js";
import type { VisibleRangeSnapshot as SavedVisibleRangeSnapshot } from "../features/chart-session/chartSessionTypes.js";
import type { DrawingEngineApi, DrawingEngineHostProps } from "../features/drawings/DrawingEngineHost.js";
import type {
  DrawingExportLease,
  DrawingExportPrepareOptions,
  DrawingStylePatch,
} from "../features/drawings/drawingInteractionController.js";
import type { SelectedDrawingMeta } from "../features/drawings/drawingSelectionController.js";
import type { DrawingToolId, FibonacciLevel } from "../features/drawings/drawingTypes.js";
import type { IndicatorSubPane } from "../features/indicators/indicatorPaneProjection.js";
import type {
  IndicatorBarColor,
  IndicatorBgColor,
  IndicatorFill,
  IndicatorHLine,
  IndicatorLine,
  IndicatorMarker,
} from "../features/indicators/indicatorTypes.js";
import type { ChartDataCommitMeta } from "../features/market-data/useChartDataRuntime.js";
import type { LoadMoreLeft } from "../features/market-data/useChartLoadMoreLeft.js";
import type { KlineBar } from "../features/market-data/marketDataTypes.js";
import type { SeriesWindowStore } from "../features/market-data/window/seriesWindowStore.js";
import type { PriceBoxSizeMode } from "../features/settings/chartAppearanceSettings.js";
import type { MainChartType } from "../shared/mainChartTypes.js";
import type { IntervalString } from "../utils/intervals.js";

export interface SingleChartPanesProps {
  seriesStore?: SeriesWindowStore | null;
  symbol: string;
  drawingKeyBase?: string;
  interval: IntervalString;
  loading?: boolean;
  onCrosshairMove?: ((value: MainSeriesCrosshairValue | null) => void) | null;
  onNeedMoreLeft?: LoadMoreLeft | null;
  canLoadMoreLeft?: boolean;
  datasetKey: string;
  upColor: string;
  downColor: string;
  chartType?: MainChartType;
  renkoBoxSizeMode?: PriceBoxSizeMode;
  renkoAtrLength?: number;
  renkoBoxSize?: number;
  pointFigureBoxSizeMode?: PriceBoxSizeMode;
  pointFigureAtrLength?: number;
  pointFigureBoxSize?: number;
  pointFigureReversalAmount?: number;
  kagiReversalMode?: PriceBoxSizeMode;
  kagiAtrLength?: number;
  kagiReversalAmount?: number;
  lineBreakNumberOfLines?: number;
  theme: string;
  customBg: string;
  timezone?: string;
  savedVisibleRange?: SavedVisibleRangeSnapshot | null;
  dataMeta?: ChartDataCommitMeta | null;
  onViewportRangeChange?: ((range: ChartSurfaceVisibleRange) => void) | null;
  onVisibleRangeChange?: ((range: ChartSurfaceVisibleRange) => void) | null;
  drawingTool?: DrawingToolId | null;
  onDrawingToolChange?: ((tool: DrawingToolId | null) => void) | null;
  penColor?: string;
  penSize?: number;
  textFontSize?: number;
  textBold?: boolean;
  textItalic?: boolean;
  fibLevels?: FibonacciLevel[] | null;
  fibInverted?: boolean;
  positionSize?: number;
  drawingSnapEnabled?: boolean;
  onSelectedDrawingChange?: ((drawing: SelectedDrawingMeta | null) => void) | null;
  mainOverlayLines?: IndicatorLine[];
  subPanes?: IndicatorSubPane[];
  indicatorMarkers?: IndicatorMarker[];
  indicatorFills?: IndicatorFill[];
  indicatorHlines?: IndicatorHLine[];
  indicatorBgcolors?: IndicatorBgColor[];
  indicatorBarcolors?: IndicatorBarColor[];
  onRemoveSubPane?: ((pane: IndicatorSubPane) => void) | null;
  invertScale?: boolean;
  onInvertScaleChange?: ((value: boolean) => void) | null;
  priceScaleMode?: number;
  onPriceScaleModeChange?: ((mode: number) => void) | null;
}

type AdapterChart = Parameters<typeof createMainSeries>[0];
type ChartCrosshairParam = Parameters<Parameters<AdapterChart["subscribeCrosshairMove"]>[0]>[0];
type VisibleLogicalRange = Parameters<
  Parameters<ReturnType<AdapterChart["timeScale"]>["subscribeVisibleLogicalRangeChange"]>[0]
>[0];
type FutureTimeAxisSeries = ReturnType<typeof createFutureTimeAxisSeries>;
type ProjectionSettings = RenkoProjectionOptions
  & PointFigureProjectionOptions
  & KagiProjectionOptions
  & LineBreakProjectionOptions;
type DrawingEngineHostComponent = ComponentType<DrawingEngineHostProps>;
type TimerHandle = ReturnType<typeof setTimeout>;
type FutureAxisPlan = Omit<FutureTimeAxisPlan, "key"> & { key: string | null };

interface LookupMap<TKey, TValue> {
  get(key: TKey): TValue | null;
  has(key: TKey): boolean;
}

interface PanePlaceholderEntry {
  anchorKey: string | null;
  series: FutureTimeAxisSeries;
}

interface PanePlaceholderState {
  chart: AdapterChart | null;
  seriesByPane: Map<number, PanePlaceholderEntry>;
}

interface PaneLabelDescriptor {
  id: string;
  label: string;
  marketPane: "funding-rate" | "open-interest" | "liquidations";
}

interface PaneDescriptor {
  id: string;
  paneIndex: number;
  label: string;
  lines: ReturnType<typeof alignIndicatorLinesToTimes>;
  markers: ReturnType<typeof alignIndicatorMarkersToTimes>;
  fills: IndicatorFill[];
  hlines: IndicatorHLine[];
  bgcolors: ReturnType<typeof alignIndicatorBgcolorsToTimes>;
}

interface IndicatorSeriesEntry {
  createdAtMs: number;
  key: string;
  paneId: string;
  paneIndex: number;
  series: IndicatorSeriesHandle;
  lineConfig: AdapterIndicatorLine;
  data: NormalizedIndicatorDataEntry[];
}

interface PaneRenderState {
  markerTargetRef: Parameters<typeof renderMarkers>[0]["markerTargetRef"];
  markerStateRef: Parameters<typeof renderMarkers>[0]["markerStateRef"];
  hlinesRef: Parameters<typeof renderHlines>[0]["hlinesRef"];
  hlinesStateRef: Parameters<typeof renderHlines>[0]["hlinesStateRef"];
  fillSeriesRef: Parameters<typeof renderFillSeries>[0]["fillSeriesRef"];
  fillSeriesStateRef: Parameters<typeof renderFillSeries>[0]["fillSeriesStateRef"];
  bgcolorPrimitiveRef: Parameters<typeof renderBgcolors>[0]["bgcolorPrimitiveRef"];
  bgcolorStateRef: Parameters<typeof renderBgcolors>[0]["bgcolorStateRef"];
}

interface ProjectionStoreWithConfiguration extends ProjectionStore {
  configurationKey: string;
}

type ProjectionCoordinateSnapshot = ReturnType<ProjectionStore["drawingCoordinateSnapshot"]>;

interface ProjectionSnapshotOwner {
  coordinateKey: string;
  drawingProjectionConfig: string | null;
  rawSnapshot: ProjectionCoordinateSnapshot | null;
  snapshot: ProjectionCoordinateSnapshot | null;
  sourceInterval: IntervalString;
  sourceIntervalSeconds: number | null;
}

interface ProjectionRenderContext {
  downColor: string;
  indicatorBarColorMap: ReadonlyMap<ChartTime, string>;
  upColor: string;
}

interface ActiveSurfaceOwner {
  chart: AdapterChart | null;
  datasetKey: string | null;
  paneHeightStorageKey: string | null;
  surfaceConfigKey: string | null;
}

interface PriceScaleContextMenuPosition {
  x: number;
  y: number;
}

interface ChartPointerGestureState {
  kind: "mouse" | "touch" | null;
  mainPanePlotStart: boolean;
  maxHorizontalMovementPx: number;
  maxVerticalMovementPx: number;
  startClientX: number;
  startClientY: number;
  touchIdentifier: number | null;
}

interface AuxiliaryDisplayState {
  datasetKey: string | null;
  rows: DisplayRow[];
  surfaceConfigKey: string | null;
}

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;
// v1 layouts may contain 30px panes produced by sequential setHeight replay.
// Keep the corrected ratio-based layout isolated from those polluted values.
const SINGLE_PANE_HEIGHT_KEY_PREFIX = "single-v2:";
const PRICE_SCALE_CONTEXT_HIT_WIDTH = 96;
const PRICE_SCALE_CONTEXT_MENU_WIDTH = 220;
const PRICE_SCALE_CONTEXT_MENU_HEIGHT = 236;
const PRICE_SCALE_CONTEXT_MENU_MARGIN = 8;
const EMPTY_DERIVED_AUXILIARY_INDEX = buildDisplaySourceTimeIndex([]);
const PRICE_SCALE_MODES = [
  { value: 0, label: "常规", labelEn: "Regular" },
  { value: 1, label: "对数", labelEn: "Logarithmic" },
  { value: 2, label: "百分比", labelEn: "Percentage" },
  { value: 3, label: "基准 100", labelEn: "Indexed to 100" },
];

function resolvePaneHeightLayout(
  storageKey: string | null | undefined,
  subPaneCount: number,
  totalHeight: number,
  mainPaneIndex = 0,
): number[] | null {
  const expectedPaneCount = Math.max(1, subPaneCount + 1);
  const saved = storageKey ? loadPaneHeights()[storageKey] : undefined;
  if (Array.isArray(saved)
    && saved.length === expectedPaneCount
    && saved.every((height) => Number.isFinite(height) && height > 0)) {
    return saved;
  }
  if (subPaneCount <= 0 || !Number.isFinite(totalHeight) || totalHeight <= 0) return null;

  const mainHeight = Math.max(180, Math.round(totalHeight * 0.65));
  const subHeight = Math.max(80, Math.round((totalHeight - mainHeight) / subPaneCount));
  const safeMainPaneIndex = Number.isInteger(mainPaneIndex)
    ? Math.min(Math.max(mainPaneIndex, 0), expectedPaneCount - 1)
    : 0;
  return Array.from(
    { length: expectedPaneCount },
    (_unused, index) => index === safeMainPaneIndex ? mainHeight : subHeight,
  );
}

interface DrawingPaneSurface {
  readonly paneId: string;
  readonly paneIndex: number;
  readonly drawingKey: string;
  readonly coordinateKey: string;
  readonly series: MainSeriesHandle;
  readonly seriesGeneration: number;
}

interface DrawingPresenceState {
  readonly error: Error | null;
  readonly present: boolean;
}

type PaneDrawingHostProps = Omit<
  DrawingEngineHostProps,
  "chartAdapter" | "chartContainerRef" | "onApiChange" | "onSelectedDrawingChange"
>;

interface NativePaneDrawingHostProps {
  readonly component: DrawingEngineHostComponent;
  readonly chartAdapter?: ReturnType<typeof createLightweightChartAdapter>;
  readonly paneId: string;
  readonly paneIndex: number;
  readonly series: MainSeriesHandle;
  readonly chartRef: MutableRefObject<AdapterChart | null>;
  readonly chartContainerRef: MutableRefObject<HTMLDivElement | null>;
  readonly seriesDataRef: MutableRefObject<DisplayRow[]>;
  readonly sourceTimeHorizonRef: MutableRefObject<number | null>;
  readonly sourceIntervalRef: MutableRefObject<IntervalString>;
  readonly sourceIntervalSecondsRef: MutableRefObject<number | null>;
  readonly projectionConfigRef: MutableRefObject<string | null>;
  readonly frameInvalidationRevision: number;
  readonly captureDrawingFrame: (
    paneId: string,
    series: MainSeriesHandle,
    paneIndex: number,
  ) => DrawingFrameSnapshot | null;
  readonly hostProps: PaneDrawingHostProps;
  readonly onPaneApiChange: (
    paneId: string,
    drawingKey: string,
    api: DrawingEngineApi | null,
  ) => void;
  readonly onPaneAdapterChange: (
    paneId: string,
    adapter: ReturnType<typeof createLightweightChartAdapter> | null,
  ) => void;
  readonly onPaneSelectedDrawingChange: (
    paneId: string,
    drawing: SelectedDrawingMeta | null,
  ) => void;
}

/** One independent document/interaction surface attached to one native LWC pane. */
function NativePaneDrawingHost({
  component: DrawingEngineHostComponent,
  chartAdapter: providedChartAdapter,
  paneId,
  paneIndex,
  series,
  chartRef,
  chartContainerRef,
  seriesDataRef,
  sourceTimeHorizonRef,
  sourceIntervalRef,
  sourceIntervalSecondsRef,
  projectionConfigRef,
  frameInvalidationRevision,
  captureDrawingFrame,
  hostProps,
  onPaneApiChange,
  onPaneAdapterChange,
  onPaneSelectedDrawingChange,
}: NativePaneDrawingHostProps) {
  const paneChartAdapter = useMemo(() => createLightweightChartAdapter({
    chartRef,
    seriesRef: series,
    containerRef: chartContainerRef,
    drawingPaneIndexRef: paneIndex,
    seriesDataRef,
    sourceTimeHorizonRef,
    sourceIntervalRef,
    sourceIntervalSecondsRef,
    projectionConfigRef,
    drawingCoordinateSnapshotProvider: () => captureDrawingFrame(paneId, series, paneIndex),
  }), [
    captureDrawingFrame,
    chartContainerRef,
    chartRef,
    paneId,
    paneIndex,
    projectionConfigRef,
    series,
    seriesDataRef,
    sourceIntervalRef,
    sourceIntervalSecondsRef,
    sourceTimeHorizonRef,
  ]);
  // The main chart already owns a stable ref-backed adapter. Reuse it so
  // main-series replacements do not tear down and recreate the drawing worker;
  // subpanes still need their series-specific adapters.
  const chartAdapter = providedChartAdapter ?? paneChartAdapter;
  const handleApiChange = useCallback((api: DrawingEngineApi | null) => {
    onPaneApiChange(paneId, hostProps.drawingKey, api);
  }, [hostProps.drawingKey, onPaneApiChange, paneId]);
  const handleSelectedDrawingChange = useCallback((drawing: SelectedDrawingMeta | null) => {
    onPaneSelectedDrawingChange(paneId, drawing);
  }, [onPaneSelectedDrawingChange, paneId]);

  useEffect(() => {
    onPaneAdapterChange(paneId, chartAdapter);
    return () => onPaneAdapterChange(paneId, null);
  }, [chartAdapter, onPaneAdapterChange, paneId]);

  useEffect(() => {
    if (frameInvalidationRevision <= 0) return;
    chartAdapter.notifyDrawingFrameInvalidation();
  }, [chartAdapter, frameInvalidationRevision]);

  return (
    <DrawingEngineHostComponent
      {...hostProps}
      chartAdapter={chartAdapter}
      chartContainerRef={chartContainerRef}
      onApiChange={handleApiChange}
      onSelectedDrawingChange={handleSelectedDrawingChange}
    />
  );
}

function preparePaneLayout(chart: AdapterChart | null, {
  storageKey,
  subPaneCount,
  totalHeight,
  mainPaneIndex = 0,
}: {
  storageKey?: string | null;
  subPaneCount?: number;
  totalHeight?: number;
  mainPaneIndex?: number;
} = {}): boolean {
  const resolvedSubPaneCount = subPaneCount ?? -1;
  const resolvedTotalHeight = totalHeight ?? 0;
  if (!chart || !Number.isInteger(resolvedSubPaneCount) || resolvedSubPaneCount < 0) return false;
  for (let paneIndex = 1; paneIndex <= resolvedSubPaneCount; paneIndex += 1) {
    ensurePane(chart, paneIndex);
  }
  const paneHeights = resolvePaneHeightLayout(
    storageKey,
    resolvedSubPaneCount,
    resolvedTotalHeight,
    mainPaneIndex,
  );
  if (!paneHeights) return resolvedSubPaneCount === 0;
  setPaneHeights(chart, paneHeights);
  return true;
}

function resolveMainPaneIndex(
  chart: AdapterChart | null | undefined,
  series: MainSeriesHandle | null | undefined,
  fallback = 0,
): number {
  try {
    const paneIndex = series?.getPane?.()?.paneIndex?.();
    if (typeof paneIndex === "number"
      && Number.isInteger(paneIndex)
      && paneIndex >= 0
      && paneIndex < (chart?.panes?.()?.length ?? 0)) {
      return paneIndex;
    }
  } catch {
    // Fall through to the last materialized index while panes are rebuilding.
  }
  return Number.isInteger(fallback) && fallback >= 0 ? fallback : 0;
}

function moveMainPane(
  chart: AdapterChart | null | undefined,
  series: MainSeriesHandle | null | undefined,
  targetIndex: number,
): number | null {
  const panes = chart?.panes?.() || [];
  if (!series || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= panes.length) {
    return null;
  }
  const currentIndex = resolveMainPaneIndex(chart, series, 0);
  if (currentIndex === targetIndex) return currentIndex;
  try {
    series.getPane().moveTo(targetIndex);
    return resolveMainPaneIndex(chart, series, targetIndex);
  } catch {
    return null;
  }
}

function reindexPanePlaceholderSeries(
  placeholderStateRef: MutableRefObject<PanePlaceholderState>,
): void {
  const state = placeholderStateRef.current;
  if (!state.chart || state.seriesByPane.size === 0) return;
  const next = new Map<number, PanePlaceholderEntry>();
  for (const [fallbackIndex, entry] of state.seriesByPane) {
    let paneIndex = fallbackIndex;
    try {
      const resolved = entry.series.getPane?.()?.paneIndex?.();
      if (Number.isInteger(resolved) && resolved >= 0) paneIndex = resolved;
    } catch {
      // Keep the last known key until LWC finishes the structural mutation.
    }
    next.set(paneIndex, entry);
  }
  state.seriesByPane = next;
}

function ensurePanePlaceholderSeries(
  chart: AdapterChart | null,
  placeholderStateRef: MutableRefObject<PanePlaceholderState>,
  subPaneCount: number,
  anchorTime: AxisTime | null = null,
  { mainPaneIndex = 0 }: { mainPaneIndex?: number } = {},
): void {
  if (!chart || !placeholderStateRef || !Number.isInteger(subPaneCount) || subPaneCount < 0) return;
  if (placeholderStateRef.current.chart !== chart) {
    placeholderStateRef.current = { chart, seriesByPane: new Map() };
  }
  reindexPanePlaceholderSeries(placeholderStateRef);
  const seriesByPane = placeholderStateRef.current.seriesByPane;
  const baseAnchorKey = axisTimeKey(anchorTime);
  const anchorKey = baseAnchorKey && anchorTime && typeof anchorTime === "object"
    ? `${baseAnchorKey}:source:${anchorTime.sourceTime}:ordinal:${anchorTime.sourceOrdinal}`
    : baseAnchorKey;
  for (let paneIndex = 0; paneIndex <= subPaneCount; paneIndex += 1) {
    if (paneIndex === mainPaneIndex) continue;
    ensurePane(chart, paneIndex);
    let entry = seriesByPane.get(paneIndex);
    if (!entry) {
      const series = chart.addSeries(chartSeriesTypes.line, {
        color: "rgba(0, 0, 0, 0)",
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        priceScaleId: "__pane-layout-placeholder",
        title: "",
      }, paneIndex);
      entry = { anchorKey: null, series };
      seriesByPane.set(paneIndex, entry);
    }
    if (anchorKey && anchorTime != null && entry.anchorKey !== anchorKey) {
      entry.series.setData([{ time: anchorTime, value: 0 }]);
      entry.anchorKey = anchorKey;
    }
  }
}

function trimPanePlaceholderSeries(
  chart: AdapterChart | null,
  placeholderStateRef: MutableRefObject<PanePlaceholderState>,
  retainPaneCount: number,
): void {
  if (!chart || placeholderStateRef?.current?.chart !== chart) return;
  reindexPanePlaceholderSeries(placeholderStateRef);
  for (const [paneIndex, entry] of placeholderStateRef.current.seriesByPane) {
    if (paneIndex < retainPaneCount) continue;
    try {
      chart.removeSeries(entry.series);
    } catch {
      // The pane may already have been removed during surface disposal.
    }
    placeholderStateRef.current.seriesByPane.delete(paneIndex);
  }
}

function paneKeyForItem(item: { pane?: string; indicatorId?: string } | null | undefined): string {
  const pane = item?.pane || "main";
  if (pane === "main") return "main";
  if (!item?.indicatorId) return pane;
  return `${pane}-${item.indicatorId}`;
}

function filterItemsForPane<T extends { pane?: string; indicatorId?: string }>(
  items: readonly T[] | null | undefined,
  paneId: string,
): T[] {
  return (items || []).filter((item) => paneKeyForItem(item) === paneId);
}

function filterFillsForLines(
  fills: readonly IndicatorFill[] | null | undefined,
  lines: readonly { id?: string; indicatorId?: string }[] | null | undefined,
): IndicatorFill[] {
  const lineKeys = new Set();
  for (const line of lines || []) {
    if (!line?.id) continue;
    lineKeys.add(`${line.indicatorId || ""}:${line.id}`);
  }
  return (fills || []).filter((fill) => (
    lineKeys.has(`${fill.indicatorId || ""}:${fill.plot1_id}`)
    && lineKeys.has(`${fill.indicatorId || ""}:${fill.plot2_id}`)
  ));
}

function rowsFromStore(store: SeriesWindowStore | null | undefined): KlineBar[] {
  return store?.snapshot?.() || [];
}

function latestFiniteSourceTime(rows: readonly SourceBar[] | null | undefined): number | null {
  if (!rows) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const time = rows[index]?.time;
    if (typeof time === "number" && Number.isFinite(time)) return time;
  }
  return null;
}

function resolveProjectionRuntime(
  chartType: MainChartType,
  rows: readonly SourceBar[],
  settings: ProjectionSettings = {},
) {
  const descriptor = getChartTypeDescriptor(chartType);
  if (descriptor.projectionId === "renko") {
    const options = resolveRenkoProjectorOptions(rows, settings);
    return { descriptor, options, configKey: options.configKey };
  }
  if (descriptor.projectionId === "point-and-figure") {
    const options = resolvePointFigureProjectorOptions(rows, settings);
    return { descriptor, options, configKey: options.configKey };
  }
  if (descriptor.projectionId === "kagi") {
    const options = resolveKagiProjectorOptions(rows, settings);
    return { descriptor, options, configKey: options.configKey };
  }
  if (descriptor.projectionId === "line-break") {
    const options = resolveLineBreakProjectorOptions(rows, settings);
    return { descriptor, options, configKey: options.configKey };
  }
  return { descriptor, options: {}, configKey: descriptor.projectionId };
}

function buildSyntheticChartNotice(
  chartType: MainChartType,
  settings: ProjectionSettings = {},
): { title: string; detail: string } {
  if (chartType === "point-and-figure") {
    const size = settings.mode === "traditional"
      ? `固定箱格 ${settings.boxSize}`
      : `ATR ${settings.atrLength}`;
    return {
      title: "Point & Figure · Close",
      detail: `${size} · ${settings.reversalAmount} 格反转`,
    };
  }
  if (chartType === "kagi") {
    const size = settings.mode === "traditional"
      ? `固定反转距离 ${settings.reversalAmount}`
      : `ATR ${settings.atrLength}`;
    return {
      title: "Kagi · Close",
      detail: `${size} · 经典 Yang/Yin 粗细`,
    };
  }
  if (chartType === "line-break") {
    return {
      title: "Line Break · Close",
      detail: `${settings.numberOfLines} 线突破`,
    };
  }
  const size = settings.mode === "traditional"
    ? `固定砖高 ${settings.boxSize}`
    : `ATR ${settings.atrLength}`;
  return { title: "Renko · Close", detail: size };
}

function createProjectionStore(
  chartType: MainChartType,
  rows: readonly SourceBar[] = [],
  settings: ProjectionSettings = {},
): ProjectionStoreWithConfiguration {
  const runtime = resolveProjectionRuntime(chartType, rows, settings);
  return Object.assign(new ProjectionStore({
    projector: createProjector(runtime.descriptor.projectionId, runtime.options),
  }), { configurationKey: runtime.configKey });
}

function syncSourceDataRefsFromStore({
  store,
  rowsRef,
  rowMapRef,
  rowIndexMapRef,
}: {
  store: SeriesWindowStore | null;
  rowsRef: MutableRefObject<KlineBar[]>;
  rowMapRef: MutableRefObject<LookupMap<number, KlineBar>>;
  rowIndexMapRef: MutableRefObject<LookupMap<number, number>>;
}): void {
  const rows = rowsFromStore(store);
  rowsRef.current = rows;
  rowMapRef.current = {
    get: (time) => store?.getByTime?.(time) || null,
    has: (time) => Boolean(store?.hasTime?.(time)),
  };
  rowIndexMapRef.current = {
    get: (time) => store?.indexOfTime?.(time) ?? -1,
    has: (time) => (store?.indexOfTime?.(time) ?? -1) >= 0,
  };
}

function syncDisplayDataRefsFromProjection({
  store,
  rowsRef,
  rowMapRef,
  rowIndexMapRef,
}: {
  store: ProjectionStoreWithConfiguration;
  rowsRef: MutableRefObject<DisplayRow[]>;
  rowMapRef: MutableRefObject<LookupMap<AxisTime, DisplayRow>>;
  rowIndexMapRef: MutableRefObject<LookupMap<AxisTime, number>>;
}): void {
  const rows = store?.displaySnapshot?.() || [];
  rowsRef.current = rows;
  rowMapRef.current = {
    get: (time) => store?.getDisplayByTime?.(time) || null,
    has: (time) => Boolean(store?.getDisplayByTime?.(time)),
  };
  rowIndexMapRef.current = {
    get: (time) => store?.indexOfDisplayTime?.(time) ?? -1,
    has: (time) => (store?.indexOfDisplayTime?.(time) ?? -1) >= 0,
  };
}

function resolveSourceTime(axisTime: AxisTime | null, displayRow: DisplayRow | null = null): number | null {
  const displaySourceTime = Number(displayRow?.sourceTime);
  if (Number.isFinite(displaySourceTime)) return displaySourceTime;
  const lineageSourceTime = Number(
    displayRow?.customValues?.chartProjection?.sourceToTime
      ?? displayRow?.customValues?.chartProjection?.sourceFromTime,
  );
  if (Number.isFinite(lineageSourceTime)) return lineageSourceTime;
  if (axisTime && typeof axisTime === "object") {
    const axisSourceTime = Number(axisTime.sourceTime);
    return Number.isFinite(axisSourceTime) ? axisSourceTime : null;
  }
  const numericTime = Number(axisTime);
  return Number.isFinite(numericTime) ? numericTime : null;
}

function captureSurfaceViewport(chart: AdapterChart | null, {
  axisMode,
  datasetKey,
  displayRows,
  surfaceConfigKey,
}: {
  axisMode?: string | null;
  datasetKey?: string | null;
  displayRows?: readonly DisplayRow[];
  surfaceConfigKey?: string | null;
} = {}): SurfaceViewportSnapshot | null {
  try {
    const timeScale = chart?.timeScale?.();
    const time = timeScale?.getVisibleRange?.();
    const logical = timeScale?.getVisibleLogicalRange?.();
    const barSpacing = timeScale?.options?.().barSpacing;
    const from = sourceTimeFromAxisTime(time?.from);
    const to = sourceTimeFromAxisTime(time?.to);
    const sourceRange = from != null && to != null
      ? (from <= to ? { from, to } : { from: to, to: from })
      : null;
    return buildSurfaceViewportSnapshot({
      sourceRange,
      ...(axisMode === undefined ? {} : { axisMode }),
      ...(barSpacing === undefined ? {} : { barSpacing }),
      ...(datasetKey === undefined ? {} : { datasetKey }),
      ...(displayRows === undefined ? {} : { displayRows }),
      ...(logical === undefined ? {} : { logicalRange: logical }),
      ...(surfaceConfigKey === undefined ? {} : { surfaceConfigKey }),
    });
  } catch {
    return null;
  }
}

function restoreSurfaceViewport(
  viewportController: ViewportController | null,
  displayRows: readonly DisplayRow[],
  transfer: SurfaceViewportSnapshot | null,
  {
  axisMode,
  datasetKey,
  surfaceConfigKey,
  }: {
    axisMode?: string | null;
    datasetKey?: string | null;
    surfaceConfigKey?: string | null;
  } = {},
): boolean {
  if (!viewportController || !transfer) return false;
  const plan = planSurfaceViewportRestore(displayRows, transfer, {
    axisMode,
    datasetKey,
    surfaceConfigKey,
  });
  if (!plan) return false;
  return viewportController.restoreProjectionRange(plan.logicalRange, {
    barSpacing: plan.barSpacing,
  });
}

function getPaneRenderState(
  mapRef: MutableRefObject<Map<string, PaneRenderState>>,
  paneId: string,
): PaneRenderState {
  const current = mapRef.current.get(paneId);
  if (current) return current;
  const created: PaneRenderState = {
    markerTargetRef: { current: null },
    markerStateRef: { current: { target: null, state: "empty" } },
    hlinesRef: { current: [] },
    hlinesStateRef: { current: { target: null, signature: "unknown" } },
    fillSeriesRef: { current: [] },
    fillSeriesStateRef: {
      current: { chart: null, paneIndex: null, signature: "unknown" },
    },
    bgcolorPrimitiveRef: { current: null },
    bgcolorStateRef: { current: { pane: null, signature: "unknown" } },
  };
  mapRef.current.set(paneId, created);
  return created;
}

const EMPTY_FILL_RENDER_PAYLOAD = {
  entries: [],
  matchedFillCount: 0,
  pointCount: 0,
  signature: "empty",
};

function clearPaneAuxiliaryRenderState(
  chart: AdapterChart,
  paneId: string,
  state: PaneRenderState,
): void {
  renderBgcolors({
    chart,
    pane: null,
    indicatorBgcolors: [],
    bgcolorPrimitiveRef: state.bgcolorPrimitiveRef,
    bgcolorStateRef: state.bgcolorStateRef,
    paneId,
    recordPerfEvent,
  });
  renderMarkers({
    targetSeries: null,
    indicatorMarkers: [],
    markerTargetRef: state.markerTargetRef,
    markerStateRef: state.markerStateRef,
    paneId,
    recordPerfEvent,
  });
  renderHlines({
    series: null,
    indicatorHlines: [],
    hlinesRef: state.hlinesRef,
    hlinesStateRef: state.hlinesStateRef,
    paneId,
    recordPerfEvent,
  });
  renderFillSeries({
    chart,
    fillPayload: EMPTY_FILL_RENDER_PAYLOAD,
    fillSeriesRef: state.fillSeriesRef,
    fillSeriesStateRef: state.fillSeriesStateRef,
    paneId,
    paneIndex: 0,
    definitionsCount: 0,
    recordPerfEvent,
  });
}

function clearAuxiliaryChartState({
  chart,
  indicatorSeriesRef,
  paneRenderStateRef,
  prevIndicatorKeyRef,
  reason,
  retainPaneCount = 1,
}: {
  chart: AdapterChart | null;
  indicatorSeriesRef: MutableRefObject<IndicatorSeriesEntry[]>;
  paneRenderStateRef: MutableRefObject<Map<string, PaneRenderState>>;
  prevIndicatorKeyRef: MutableRefObject<string>;
  reason: string;
  retainPaneCount?: number;
}): void {
  if (chart) {
    for (const [paneId, state] of paneRenderStateRef.current) {
      clearPaneAuxiliaryRenderState(chart, paneId, state);
    }
  }
  paneRenderStateRef.current = new Map();

  const removedSeriesCount = chart
    ? removeSeriesEntries(chart, indicatorSeriesRef.current)
    : 0;
  if (chart) trimPanes(chart, retainPaneCount);
  indicatorSeriesRef.current = [];
  prevIndicatorKeyRef.current = "";
  if (removedSeriesCount > 0) {
    recordPerfEvent("chart.indicatorSeries.remove", {
      paneId: "single-chart",
      reason,
      series: removedSeriesCount,
    });
  }
}

function buildPaneDescriptors({
  dataTimeSet,
  mainOverlayLines,
  paneOrder,
  subPanes,
  indicatorMarkers,
  indicatorFills,
  indicatorHlines,
  indicatorBgcolors,
}: {
  dataTimeSet: ReadonlySet<number>;
  mainOverlayLines: IndicatorLine[];
  paneOrder: readonly string[];
  subPanes: IndicatorSubPane[];
  indicatorMarkers: IndicatorMarker[];
  indicatorFills: IndicatorFill[];
  indicatorHlines: IndicatorHLine[];
  indicatorBgcolors: IndicatorBgColor[];
}): PaneDescriptor[] {
  const mainLines = alignIndicatorLinesToTimes(mainOverlayLines, dataTimeSet);
  const descriptors: PaneDescriptor[] = [{
    id: "main",
    paneIndex: 0,
    label: "",
    lines: mainLines,
    markers: alignIndicatorMarkersToTimes(filterItemsForPane(indicatorMarkers, "main"), dataTimeSet),
    fills: filterFillsForLines(indicatorFills, mainLines),
    hlines: filterItemsForPane(indicatorHlines, "main"),
    bgcolors: alignIndicatorBgcolorsToTimes(filterItemsForPane(indicatorBgcolors, "main"), dataTimeSet),
  }];

  for (const [index, subPane] of subPanes.entries()) {
    const lines = alignIndicatorLinesToTimes(subPane.lines, dataTimeSet);
    descriptors.push({
      id: subPane.id,
      paneIndex: index + 1,
      label: subPane.label,
      lines,
      markers: alignIndicatorMarkersToTimes(filterItemsForPane(indicatorMarkers, subPane.id), dataTimeSet),
      fills: filterFillsForLines(indicatorFills, lines),
      hlines: filterItemsForPane(indicatorHlines, subPane.id),
      bgcolors: alignIndicatorBgcolorsToTimes(filterItemsForPane(indicatorBgcolors, subPane.id), dataTimeSet),
    });
  }

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return paneOrder.flatMap((paneId, paneIndex) => {
    const descriptor = descriptorById.get(paneId);
    return descriptor ? [{ ...descriptor, paneIndex }] : [];
  });
}

const SingleChartPanes = forwardRef<ChartSurfaceHandle, SingleChartPanesProps>(function SingleChartPanes({
  seriesStore = null,
  symbol,
  drawingKeyBase = "",
  interval,
  loading = false,
  onCrosshairMove,
  onNeedMoreLeft,
  canLoadMoreLeft = true,
  datasetKey,
  upColor,
  downColor,
  chartType = "candlestick",
  renkoBoxSizeMode = "atr",
  renkoAtrLength = 14,
  renkoBoxSize = 1,
  pointFigureBoxSizeMode = "atr",
  pointFigureAtrLength = 14,
  pointFigureBoxSize = 1,
  pointFigureReversalAmount = 3,
  kagiReversalMode = "atr",
  kagiAtrLength = 14,
  kagiReversalAmount = 1,
  lineBreakNumberOfLines = 3,
  theme,
  customBg,
  timezone = "Local",
  savedVisibleRange = null,
  dataMeta = null,
  onViewportRangeChange = null,
  onVisibleRangeChange = null,
  drawingTool = null,
  onDrawingToolChange,
  penColor = "#f59e0b",
  penSize = 2,
  textFontSize = 14,
  textBold = false,
  textItalic = false,
  fibLevels = null,
  fibInverted = false,
  positionSize = 1000,
  drawingSnapEnabled = true,
  onSelectedDrawingChange,
  mainOverlayLines = [],
  subPanes = [],
  indicatorMarkers = [],
  indicatorFills = [],
  indicatorHlines = [],
  indicatorBgcolors = [],
  indicatorBarcolors = [],
  onRemoveSubPane = null,
  invertScale = false,
  onInvertScaleChange,
  priceScaleMode = 0,
  onPriceScaleModeChange,
}: SingleChartPanesProps, ref) {
  const drawingFontMetricRevision = useDrawingFontMetricRevision();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cursorOverlayRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<AdapterChart | null>(null);
  const viewportControllerRef = useRef<ViewportController | null>(null);
  const mainSeriesRef = useRef<MainSeriesHandle | null>(null);
  const futureTimeAxisSeriesRef = useRef<FutureTimeAxisSeries | null>(null);
  const futureTimeAxisDataRef = useRef<NonNullable<FutureTimeAxisPlan["data"]>>([]);
  const futureTimeAxisPlanKeyRef = useRef<string | null>(null);
  const futureTimeAxisPointCountRef = useRef(FUTURE_TIME_AXIS_INITIAL_POINTS);
  const futureTimeAxisCoverageFrameRef = useRef<number | null>(null);
  const futureTimeAxisCoveragePendingRef = useRef(false);
  const isChartPointerActiveRef = useRef(false);
  const chartPointerLogicalRangeChangedRef = useRef(false);
  const chartPointerGestureRef = useRef<ChartPointerGestureState>({
    kind: null,
    mainPanePlotStart: false,
    maxHorizontalMovementPx: 0,
    maxVerticalMovementPx: 0,
    startClientX: 0,
    startClientY: 0,
    touchIdentifier: null,
  });
  const indicatorSeriesRef = useRef<IndicatorSeriesEntry[]>([]);
  const panePlaceholderSeriesRef = useRef<PanePlaceholderState>({ chart: null, seriesByPane: new Map() });
  const paneRenderStateRef = useRef<Map<string, PaneRenderState>>(new Map());
  const sourceRowsRef = useRef<KlineBar[]>([]);
  const sourceRowMapRef = useRef<LookupMap<number, KlineBar>>(new Map());
  const sourceRowIndexMapRef = useRef<LookupMap<number, number>>(new Map());
  const displayRowsRef = useRef<DisplayRow[]>([]);
  const displayRowMapRef = useRef<LookupMap<AxisTime, DisplayRow>>(new Map());
  const displayRowIndexMapRef = useRef<LookupMap<AxisTime, number>>(new Map());
  const renderedMainSeriesDataRef = useRef<ChartSeriesInputRow[] | null>([]);
  const renderedMainSeriesGenerationRef = useRef(0);
  const projectionStoreRef = useRef<ProjectionStoreWithConfiguration | null>(null);
  const drawingProjectionSnapshotOwnerRef = useRef<ProjectionSnapshotOwner>({
    coordinateKey: "",
    drawingProjectionConfig: null,
    rawSnapshot: null,
    snapshot: null,
    sourceInterval: interval,
    sourceIntervalSeconds: parseIntervalSeconds(interval),
  });
  const drawingFrameSnapshotFactoriesRef = useRef<Map<
    string,
    ReturnType<typeof createDrawingFrameSnapshotFactory>
  >>(new Map());
  const drawingCoordinateKeyRef = useRef("");
  const drawingThemeKeyRef = useRef("");
  const drawingThemePaletteRef = useRef({ upColor, downColor });
  const drawingPriceProjectionKeyRef = useRef("");
  const projectionGenerationRef = useRef(0);
  const projectionRenderContextRef = useRef<ProjectionRenderContext | null>(null);
  const mainSeriesTypeRef = useRef<MainChartType | null>(null);
  const mainSeriesReferenceRef = useRef<{ series: MainSeriesHandle | null; signature: string }>({ series: null, signature: "" });
  const requestedChartTypeRef = useRef(normalizeMainChartType(chartType));
  const requestedProjectionSettingsRef = useRef<ProjectionSettings | null>(null);
  const pendingSurfaceViewportRef = useRef<SurfaceViewportSnapshot | null>(null);
  const surfaceViewportCacheRef = useRef<Map<string, SurfaceViewportSnapshot>>(new Map());
  const activeSurfaceOwnerRef = useRef<ActiveSurfaceOwner>({
    chart: null,
    datasetKey: null,
    paneHeightStorageKey: null,
    surfaceConfigKey: null,
  });
  const surfaceAxisModeRef = useRef<string>("time");
  const drawingSourceTimeHorizonRef = useRef<number | null>(null);
  const drawingSourceIntervalRef = useRef(interval);
  const drawingSourceIntervalSecondsRef = useRef(parseIntervalSeconds(interval));
  const seriesStoreRef = useRef<SeriesWindowStore | null>(seriesStore);
  const prevIndicatorKeyRef = useRef("");
  const intervalRef = useRef(interval);
  const appliedAppearanceIntervalRef = useRef(interval);
  const isSyncingRef = useRef(false);
  const isRestoringViewportRef = useRef(false);
  const userInteractedRef = useRef(false);
  const hasRestoredRangeRef = useRef(false);
  const lastViewportRestoreSourceRef = useRef<string | null>(null);
  const visibleRangeSaveTimerRef = useRef<TimerHandle | null>(null);
  const activeSubPaneCountRef = useRef(0);
  const activeSubPanesRef = useRef<IndicatorSubPane[]>(subPanes);
  const activePaneIdsRef = useRef<string[]>(["main", ...subPanes.map((pane) => pane.id)]);
  const hoveredPaneIdRef = useRef<string | null>(null);
  const materializedMainPaneIndexRef = useRef(0);
  const paneHeightStorageKeyRef = useRef<string | null>(null);
  const expandedPaneHeightsRef = useRef<Map<string, number>>(new Map());
  const paneLayoutControlledRef = useRef(false);
  const prevSubPaneScopeRef = useRef<{
    base: string | null;
    panes: Map<string, boolean>;
  }>({ base: null, panes: new Map() });
  const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
  const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
  const datasetKeyRef = useRef(datasetKey);
  const surfaceConfigKeyRef = useRef<string | null>(null);
  const drawingProjectionConfigRef = useRef<string | null>(null);
  const onViewportRangeChangeRef = useRef(onViewportRangeChange);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const drawingApiRef = useRef<DrawingEngineApi | null>(null);
  const drawingApisByPaneRef = useRef<Map<string, DrawingEngineApi>>(new Map());
  const drawingAdaptersByPaneRef = useRef<Map<
    string,
    ReturnType<typeof createLightweightChartAdapter>
  >>(new Map());
  const selectedDrawingPaneIdRef = useRef<string | null>(null);
  const selectedDrawingsByPaneRef = useRef<Map<string, SelectedDrawingMeta>>(new Map());
  const drawingsHiddenRef = useRef(false);
  const [seriesReady, setSeriesReady] = useState(0);
  const [paneCrosshairTime, setPaneCrosshairTime] = useState<number | null>(null);
  const [drawingSeriesGeneration, setDrawingSeriesGeneration] = useState(0);
  const [drawingCoordinateGeneration, setDrawingCoordinateGeneration] = useState(0);
  const drawingCoordinateGenerationRef = useRef(0);
  const [auxiliaryDisplayState, setAuxiliaryDisplayState] = useState<AuxiliaryDisplayState>({
    datasetKey: null,
    rows: [],
    surfaceConfigKey: null,
  });
  const publishDrawingProjectionStore = useCallback((store: ProjectionStoreWithConfiguration | null) => {
    const drawingProjectionConfig = store
      ? `${datasetKeyRef.current || ""}:${store.configurationKey}`
      : null;
    const sourceInterval = intervalRef.current;
    const sourceIntervalSeconds = parseIntervalSeconds(intervalRef.current);
    projectionStoreRef.current = store;
    drawingProjectionConfigRef.current = drawingProjectionConfig;
    drawingSourceIntervalRef.current = sourceInterval;
    drawingSourceIntervalSecondsRef.current = sourceIntervalSeconds;
    const rawSnapshot = store?.drawingCoordinateSnapshot?.() || null;
    drawingProjectionSnapshotOwnerRef.current = {
      coordinateKey: `${datasetKeyRef.current || ""}:${surfaceConfigKeyRef.current || "time"}:${drawingCoordinateGenerationRef.current}`,
      drawingProjectionConfig,
      rawSnapshot,
      snapshot: rawSnapshot?.ordinalSeriesIndex
        ? null
        : rawSnapshot ? Object.freeze({ ...rawSnapshot }) : null,
      sourceInterval,
      sourceIntervalSeconds,
    };
  }, []);
  const clearFutureTimeAxis = useCallback(({ force = false, resetPointCount = false } = {}) => {
    const series = futureTimeAxisSeriesRef.current;
    let cleared = true;
    try {
      if (series && (force
        || futureTimeAxisDataRef.current.length > 0
        || futureTimeAxisPlanKeyRef.current)) {
        series.setData([]);
      }
    } catch (error) {
      cleared = false;
      recordPerfEvent("chart.futureTimeAxis.renderError", {
        message: error instanceof Error ? error.message : String(error),
        phase: "clear",
      });
    } finally {
      // Never retain an owned snapshot after Lightweight Charts may have
      // partially mutated the carrier and thrown during setData().
      futureTimeAxisDataRef.current = [];
      futureTimeAxisPlanKeyRef.current = null;
      if (resetPointCount) {
        futureTimeAxisPointCountRef.current = FUTURE_TIME_AXIS_INITIAL_POINTS;
      }
    }
    return cleared;
  }, []);
  const createFutureTimeAxisPlan = useCallback((
    displayRows: DisplayRow[] = displayRowsRef.current,
    { force = false }: { force?: boolean } = {},
  ): FutureAxisPlan => {
    const axisMode = surfaceAxisModeRef.current;
    if (!force && canReuseFutureTimeAxisData({
      axisMode,
      currentData: futureTimeAxisDataRef.current,
      displayRows,
      sourceTimeHorizon: drawingSourceTimeHorizonRef.current,
    })) {
      return {
        changed: false,
        data: null,
        key: futureTimeAxisPlanKeyRef.current,
      };
    }
    return planFutureTimeAxis({
      axisMode,
      currentKey: futureTimeAxisPlanKeyRef.current,
      displayRows,
      pointCount: futureTimeAxisPointCountRef.current,
      sourceInterval: intervalRef.current,
      sourceIntervalSeconds: parseIntervalSeconds(intervalRef.current),
      sourceTimeHorizon: drawingSourceTimeHorizonRef.current,
    });
  }, []);
  const commitFutureTimeAxisPlan = useCallback((plan: FutureAxisPlan, reason: string) => {
    if (!plan?.changed) return false;
    const series = futureTimeAxisSeriesRef.current;
    if (!series || !Array.isArray(plan.data) || plan.key == null) return false;
    series.setData(plan.data);
    futureTimeAxisDataRef.current = plan.data;
    futureTimeAxisPlanKeyRef.current = plan.key;
    recordPerfEvent("chart.futureTimeAxis.setData", {
      axisMode: surfaceAxisModeRef.current,
      points: plan.data.length,
      reason,
    });
    return true;
  }, []);
  const scheduleFutureTimeAxisCoverage = useCallback(() => {
    futureTimeAxisCoveragePendingRef.current = true;
    if (isChartPointerActiveRef.current || futureTimeAxisCoverageFrameRef.current != null) return;
    futureTimeAxisCoverageFrameRef.current = requestAnimationFrame(() => {
      futureTimeAxisCoverageFrameRef.current = null;
      if (isChartPointerActiveRef.current) return;
      futureTimeAxisCoveragePendingRef.current = false;
      const chart = chartRef.current;
      const displayRows = displayRowsRef.current;
      if (!chart || displayRows.length === 0) return;
      const visibleLogicalRange = chart.timeScale?.().getVisibleLogicalRange?.();
      const axisMode = surfaceAxisModeRef.current;
      const availableCount = axisMode === "time"
        ? countFutureTimeAxisPointsAfter(
            futureTimeAxisDataRef.current,
            drawingSourceTimeHorizonRef.current,
          )
        : futureTimeAxisDataRef.current.length;
      const nextCount = resolveFutureTimeAxisPointCount({
        allocatedCount: futureTimeAxisPointCountRef.current,
        contentLastLogical: displayRows.length - 1,
        currentCount: availableCount,
        visibleLogicalRange,
      });
      const previousCount = futureTimeAxisPointCountRef.current;
      if (nextCount <= availableCount && nextCount >= previousCount) return;

      futureTimeAxisPointCountRef.current = nextCount;
      const plan = createFutureTimeAxisPlan(displayRows, { force: true });
      try {
        isSyncingRef.current = true;
        commitFutureTimeAxisPlan(plan, "viewport-extend");
      } catch (error) {
        futureTimeAxisPointCountRef.current = previousCount;
        try { clearFutureTimeAxis({ force: true }); } catch { /* best-effort carrier cleanup */ }
        recordPerfEvent("chart.futureTimeAxis.renderError", {
          message: error instanceof Error ? error.message : String(error),
          phase: "viewport-extend",
        });
      } finally {
        isSyncingRef.current = false;
      }
    });
  }, [clearFutureTimeAxis, commitFutureTimeAxisPlan, createFutureTimeAxisPlan]);
  const [DrawingEngineHost, setDrawingEngineHost] = useState<DrawingEngineHostComponent | null>(null);
  const [drawingEngineLoadError, setDrawingEngineLoadError] = useState<Error | null>(null);
  const [probedDrawingPresence, setProbedDrawingPresence] = useState<ReadonlyMap<
    string,
    DrawingPresenceState
  >>(() => new Map());
  const [retainedDrawingPaneMountKeys, setRetainedDrawingPaneMountKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [isAutoScale, setIsAutoScale] = useState(true);
  const [contextMenu, setContextMenu] = useState<PriceScaleContextMenuPosition | null>(null);
  const [paneOrder, setPaneOrder] = useState<string[]>(() => {
    const stored = loadPaneOrder();
    return stored.includes("main") ? stored : ["main", ...stored];
  });
  const [collapsedPaneIds, setCollapsedPaneIds] = useState<string[]>([]);
  const [hoveredPaneId, setHoveredPaneId] = useState<string | null>(null);
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);

  const resolvedChartType = normalizeMainChartType(chartType);
  const resolvedDescriptor = getChartTypeDescriptor(resolvedChartType);
  const resolvedAxisMode = resolvedDescriptor.axisMode;
  const usesDerivedAxis = resolvedAxisMode === "derived-ordinal";
  const drawingAnchorMode = resolvedDescriptor.drawingAnchorMode;
  const supportsDrawingFeatures = supportsDrawingAnchorMode(drawingAnchorMode);
  const effectiveDrawingTool = drawingToolForAnchorMode(drawingAnchorMode, drawingTool);
  const drawingEngineToolActive = effectiveDrawingTool != null
    && DRAWING_ENGINE_TOOL_IDS.has(effectiveDrawingTool);
  const cursorOverlayClass = cursorOverlayClassForTool(effectiveDrawingTool);
  const showCrosshairDetails = shouldShowCrosshairDetails(effectiveDrawingTool);
  const projectionSettings = useMemo(() => {
    if (resolvedChartType === "renko") {
      return {
        mode: renkoBoxSizeMode,
        atrLength: renkoAtrLength,
        boxSize: renkoBoxSize,
      };
    }
    if (resolvedChartType === "point-and-figure") {
      return {
        mode: pointFigureBoxSizeMode,
        atrLength: pointFigureAtrLength,
        boxSize: pointFigureBoxSize,
        reversalAmount: pointFigureReversalAmount,
      };
    }
    if (resolvedChartType === "kagi") {
      return {
        mode: kagiReversalMode,
        atrLength: kagiAtrLength,
        reversalAmount: kagiReversalAmount,
      };
    }
    if (resolvedChartType === "line-break") {
      return { numberOfLines: lineBreakNumberOfLines };
    }
    return {};
  }, [
    kagiAtrLength,
    kagiReversalAmount,
    kagiReversalMode,
    lineBreakNumberOfLines,
    pointFigureAtrLength,
    pointFigureBoxSize,
    pointFigureBoxSizeMode,
    pointFigureReversalAmount,
    renkoAtrLength,
    renkoBoxSize,
    renkoBoxSizeMode,
    resolvedChartType,
  ]);
  const syntheticChartNotice = buildSyntheticChartNotice(resolvedChartType, projectionSettings);
  const projectionSettingsKey = JSON.stringify(projectionSettings);
  const surfaceConfigKey = resolvedAxisMode === "derived-ordinal"
    ? `${resolvedAxisMode}:${resolvedChartType}:${projectionSettingsKey}`
    : resolvedAxisMode;
  const drawingCoordinateKey = `${datasetKey || ""}:${surfaceConfigKey}:${drawingCoordinateGeneration}`;
  drawingCoordinateKeyRef.current = drawingCoordinateKey;
  drawingThemeKeyRef.current = JSON.stringify([
    theme,
    customBg,
    upColor,
    downColor,
    drawingFontMetricRevision,
  ]);
  drawingThemePaletteRef.current = { upColor, downColor };
  drawingPriceProjectionKeyRef.current = JSON.stringify([invertScale, priceScaleMode]);
  requestedChartTypeRef.current = resolvedChartType;
  requestedProjectionSettingsRef.current = projectionSettings;
  seriesStoreRef.current = seriesStore;
  datasetKeyRef.current = datasetKey;
  surfaceConfigKeyRef.current = surfaceConfigKey;
  const indicatorBarColorMap = useMemo(
    () => buildIndicatorBarColorMap(indicatorBarcolors),
    [indicatorBarcolors],
  );
  const indicatorDatasetOwned = hasCurrentDatasetOwnership({
    dataMeta,
    datasetKey,
    seriesStore,
  });
  const mainSeriesRenderContext = useMemo(() => ({
    downColor,
    indicatorBarColorMap,
    upColor,
  }), [downColor, indicatorBarColorMap, upColor]);
  const drawingScopeBase = drawingKeyBase || symbol;
  const drawingKey = `${drawingScopeBase}__main`;
  const capturePaneDrawingFrame = useCallback((
    paneId: string,
    series: MainSeriesHandle,
    paneIndex: number,
  ): DrawingFrameSnapshot | null => {
    const owner = drawingProjectionSnapshotOwnerRef.current;
    let snapshot = owner.snapshot;
    if (!snapshot && owner.rawSnapshot) {
      const rawSnapshot = owner.rawSnapshot;
      const ownedLineage = rawSnapshot.ordinalSeriesIndex?.seriesData === rawSnapshot.seriesData
        ? rawSnapshot.ordinalSeriesIndex.stableSnapshot()
        : createDrawingLineageIndex(rawSnapshot.seriesData);
      snapshot = Object.freeze({
        ...rawSnapshot,
        indexRevision: ownedLineage.isOrdinal ? ownedLineage.revision : null,
        ordinalSeriesIndex: ownedLineage.isOrdinal ? ownedLineage : null,
      });
      owner.snapshot = snapshot;
    }
    if (!snapshot) return null;
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;
    const rect = container.getBoundingClientRect?.();
    const containerHeight = rect?.height ?? container.clientHeight ?? 0;
    const resolvedPaneIndex = resolveMainPaneIndex(chart, series, paneIndex);
    if (paneId === "main") materializedMainPaneIndexRef.current = resolvedPaneIndex;
    const paneSize = chart.paneSize?.(resolvedPaneIndex);
    const heightCssPx = typeof paneSize?.height === "number"
      && Number.isFinite(paneSize.height)
      && paneSize.height > 0
      ? paneSize.height
      : containerHeight;
    // Drawing primitives and worker bitmaps are pane-local even though input
    // overlays use chart-container coordinates.
    const widthCssPx = typeof paneSize?.width === "number"
      && Number.isFinite(paneSize.width)
      && paneSize.width > 0
      ? paneSize.width
      : rect?.width ?? container.clientWidth ?? 0;
    if (!Number.isFinite(heightCssPx) || heightCssPx <= 0
      || !Number.isFinite(widthCssPx) || widthCssPx <= 0) return null;
    let viewportKey: string | null = null;
    let drawingViewport: {
      horizontalDomain: "logical" | "time";
      minHorizontal: number;
      maxHorizontal: number;
      minPrice: number;
      maxPrice: number;
      minLogical?: number;
      maxLogical?: number;
      priceProjectionSamples?: readonly Readonly<{
        price: number;
        coordinateCssPx: number;
      }>[];
    } | null = null;
    let barSpacing = 1;
    try {
      const timeScale = chart.timeScale();
      const logical = timeScale.getVisibleLogicalRange() || null;
      const visibleTime = timeScale.getVisibleRange() || null;
      const priceAtTop = series.coordinateToPrice(0);
      const priceAtMiddle = series.coordinateToPrice(heightCssPx / 2);
      const priceAtBottom = series.coordinateToPrice(heightCssPx);
      barSpacing = timeScale.options().barSpacing;
      viewportKey = createDrawingViewportSignature({
        barSpacing,
        heightCssPx,
        logicalRange: logical,
        priceAtBottom,
        priceAtMiddle,
        priceAtTop,
        priceProjectionKey: `${drawingPriceProjectionKeyRef.current}:${paneId}`,
        scrollPosition: timeScale.scrollPosition(),
      });
      const topPrice = typeof priceAtTop === "number" && Number.isFinite(priceAtTop)
        ? Number(priceAtTop)
        : null;
      const bottomPrice = typeof priceAtBottom === "number" && Number.isFinite(priceAtBottom)
        ? Number(priceAtBottom)
        : null;
      const middlePrice = typeof priceAtMiddle === "number" && Number.isFinite(priceAtMiddle)
        ? Number(priceAtMiddle)
        : null;
      const axisKind = surfaceAxisModeRef.current === "derived-ordinal"
        ? "derived-ordinal"
        : "time";
      const from = axisKind === "derived-ordinal"
        ? logical?.from ?? null
        : sourceTimeFromAxisTime(visibleTime?.from);
      const to = axisKind === "derived-ordinal"
        ? logical?.to ?? null
        : sourceTimeFromAxisTime(visibleTime?.to);
      if (topPrice !== null && bottomPrice !== null
        && typeof from === "number" && Number.isFinite(from)
        && typeof to === "number" && Number.isFinite(to)) {
        drawingViewport = {
          horizontalDomain: axisKind === "derived-ordinal" ? "logical" : "time",
          minHorizontal: Math.min(from, to),
          maxHorizontal: Math.max(from, to),
          minPrice: Math.min(topPrice, bottomPrice),
          maxPrice: Math.max(topPrice, bottomPrice),
          ...(logical && Number.isFinite(logical.from) && Number.isFinite(logical.to) ? {
            minLogical: Math.min(logical.from, logical.to),
            maxLogical: Math.max(logical.from, logical.to),
          } : {}),
          ...(middlePrice === null ? {} : {
            priceProjectionSamples: Object.freeze([
              Object.freeze({ price: topPrice, coordinateCssPx: 0 }),
              Object.freeze({ price: middlePrice, coordinateCssPx: heightCssPx / 2 }),
              Object.freeze({ price: bottomPrice, coordinateCssPx: heightCssPx }),
            ]),
          }),
        };
      }
    } catch {
      return null;
    }
    if (!viewportKey) return null;
    let factory = drawingFrameSnapshotFactoriesRef.current.get(paneId);
    if (!factory) {
      factory = createDrawingFrameSnapshotFactory();
      drawingFrameSnapshotFactoriesRef.current.set(paneId, factory);
    }
    const baseCoordinateKey = owner.coordinateKey || drawingCoordinateKeyRef.current;
    return factory.capture({
      axisKind: surfaceAxisModeRef.current === "derived-ordinal"
        ? "derived-ordinal"
        : "time",
      barSpacing,
      coordinateKey: paneId === "main" ? baseCoordinateKey : `${baseCoordinateKey}:${paneId}`,
      dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      drawingProjectionConfig: owner.drawingProjectionConfig,
      drawingViewport,
      heightCssPx,
      ordinalSeriesIndex: snapshot.ordinalSeriesIndex,
      projectionKey: owner.drawingProjectionConfig ?? surfaceAxisModeRef.current,
      seriesData: snapshot.seriesData,
      sourceInterval: owner.sourceInterval,
      sourceIntervalSeconds: owner.sourceIntervalSeconds,
      sourceTimeHorizon: snapshot.sourceTimeHorizon,
      surfaceToken: series,
      themePalette: drawingThemePaletteRef.current,
      themeKey: drawingThemeKeyRef.current,
      viewportKey,
      widthCssPx,
    });
  }, []);
  const chartAdapter = useMemo(
    () => createLightweightChartAdapter({
      chartRef,
      seriesRef: mainSeriesRef,
      containerRef,
      drawingPaneIndexRef: materializedMainPaneIndexRef,
      seriesDataRef: displayRowsRef,
      seriesDataMapRef: displayRowMapRef,
      seriesDataIndexRef: displayRowIndexMapRef,
      sourceTimeHorizonRef: drawingSourceTimeHorizonRef,
      sourceIntervalRef: drawingSourceIntervalRef,
      sourceIntervalSecondsRef: drawingSourceIntervalSecondsRef,
      projectionConfigRef: drawingProjectionConfigRef,
      drawingCoordinateSnapshotProvider: () => {
        const series = mainSeriesRef.current;
        return series
          ? capturePaneDrawingFrame("main", series, materializedMainPaneIndexRef.current)
          : null;
      },
    }),
    [capturePaneDrawingFrame],
  );
  const notifyDrawingFrameInvalidation = useCallback(() => {
    chartAdapter.notifyDrawingFrameInvalidation();
    for (const adapter of drawingAdaptersByPaneRef.current.values()) {
      if (adapter !== chartAdapter) adapter.notifyDrawingFrameInvalidation();
    }
  }, [chartAdapter]);

  useEffect(() => {
    if (drawingFontMetricRevision <= 0) return;
    notifyDrawingFrameInvalidation();
  }, [drawingFontMetricRevision, notifyDrawingFrameInvalidation]);

  useEffect(() => {
    onCrosshairMove?.(null);
    setPaneCrosshairTime(null);
  }, [datasetKey, interval, onCrosshairMove, symbol]);

  const dataTimeSet = resolveDataTimeSet(seriesStore);
  const derivedAuxiliaryIndex = useMemo(() => {
    if (!usesDerivedAxis) return EMPTY_DERIVED_AUXILIARY_INDEX;
    if (auxiliaryDisplayState.datasetKey !== datasetKey
      || auxiliaryDisplayState.surfaceConfigKey !== surfaceConfigKey) {
      return EMPTY_DERIVED_AUXILIARY_INDEX;
    }

    return buildDisplaySourceTimeIndex(auxiliaryDisplayState.rows);
  }, [auxiliaryDisplayState, datasetKey, surfaceConfigKey, usesDerivedAxis]);
  const renderDataTimeSet = usesDerivedAxis
    ? derivedAuxiliaryIndex.displayTimeSet
    : dataTimeSet;
  useEffect(() => {
    savePaneOrder(paneOrder);
  }, [paneOrder]);
  const activePaneIds = useMemo(
    () => reconcilePaneOrder(paneOrder, ["main", ...subPanes.map((pane) => pane.id)]),
    [paneOrder, subPanes],
  );
  const activeSubPanes = useMemo(() => {
    const paneById = new Map(subPanes.map((pane) => [pane.id, pane]));
    return activePaneIds
      .flatMap((paneId) => {
        const pane = paneById.get(paneId);
        return pane ? [pane] : [];
      });
  }, [activePaneIds, subPanes]);
  const sourcePaneDescriptors = useMemo(() => buildPaneDescriptors({
    dataTimeSet,
    mainOverlayLines,
    paneOrder: activePaneIds,
    subPanes: activeSubPanes,
    indicatorMarkers,
    indicatorFills,
    indicatorHlines,
    indicatorBgcolors,
  }), [
    dataTimeSet,
    mainOverlayLines,
    activePaneIds,
    activeSubPanes,
    indicatorMarkers,
    indicatorFills,
    indicatorHlines,
    indicatorBgcolors,
  ]);
  const paneDescriptors = useMemo(
    () => {
      if (!usesDerivedAxis) return sourcePaneDescriptors;
      return projectPaneDescriptorsToDisplay(sourcePaneDescriptors, derivedAuxiliaryIndex);
    },
    [derivedAuxiliaryIndex, sourcePaneDescriptors, usesDerivedAxis],
  );
  const activeSubPaneCount = activeSubPanes.length;
  activeSubPaneCountRef.current = activeSubPanes.length;
  activeSubPanesRef.current = activeSubPanes;
  activePaneIdsRef.current = activePaneIds;
  const subPaneIdsKey = useMemo(
    () => activeSubPanes.map((pane) => pane.id).join(","),
    [activeSubPanes],
  );
  const activePaneIdsKey = useMemo(() => activePaneIds.join("\u0000"), [activePaneIds]);
  const desiredMainPaneIndex = Math.max(0, activePaneIds.indexOf("main"));
  useEffect(() => {
    const activeIds = new Set(activePaneIds);
    setCollapsedPaneIds((previous) => {
      const next = previous.filter((paneId) => activeIds.has(paneId));
      return next.length === previous.length ? previous : next;
    });
    setMaximizedPaneId((previous) => previous && !activeIds.has(previous) ? null : previous);
    if (hoveredPaneIdRef.current && !activeIds.has(hoveredPaneIdRef.current)) {
      hoveredPaneIdRef.current = null;
      setHoveredPaneId(null);
    }
  }, [activePaneIds, activePaneIdsKey]);
  useLayoutEffect(() => {
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    if (!chart || !series || (chart.panes?.()?.length ?? 0) < activePaneIds.length) return;
    const previousIndex = resolveMainPaneIndex(chart, series, materializedMainPaneIndexRef.current);
    const materializedIndex = moveMainPane(chart, series, desiredMainPaneIndex);
    if (materializedIndex === null) return;
    materializedMainPaneIndexRef.current = materializedIndex;
    reindexPanePlaceholderSeries(panePlaceholderSeriesRef);
    if (previousIndex !== materializedIndex) {
      materializePaneLayout(chart, containerRef.current, { nudgeAxis: "height" });
      notifyDrawingFrameInvalidation();
    }
  }, [activePaneIds.length, activePaneIdsKey, desiredMainPaneIndex, notifyDrawingFrameInvalidation, seriesReady]);
  const paneHeightStorageKey = useMemo(
    () => `${SINGLE_PANE_HEIGHT_KEY_PREFIX}${buildPaneConfigKey(activeSubPanes.map((pane) => pane.id))}`,
    [activeSubPanes],
  );
  paneHeightStorageKeyRef.current = paneHeightStorageKey;
  const paneLabelDescriptors = activeSubPanes.flatMap<PaneLabelDescriptor>((pane) => (
    pane.dataMarketPane
      ? [{
          id: pane.id,
          label: pane.label,
          marketPane: pane.dataMarketPane,
        }]
      : []
  ));
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const chart = chartRef.current;
    if (!wrapper || !chart || activePaneIds.length === 0) return undefined;

    const syncOverlays = () => {
      const heights = readPaneHeights(chart);
      if (heights.length !== activePaneIds.length) return;
      const overlaysById = new Map<string, HTMLElement[]>();
      for (const element of wrapper.querySelectorAll<HTMLElement>(".pane-overlay-anchor[data-pane-id]")) {
        const paneId = element.dataset.paneId || "";
        const elements = overlaysById.get(paneId) || [];
        elements.push(element);
        overlaysById.set(paneId, elements);
      }
      let paneTop = 0;
      for (const [index, paneId] of activePaneIds.entries()) {
        for (const element of overlaysById.get(paneId) || []) {
          element.style.top = `${paneTop + 6}px`;
        }
        paneTop += heights[index] || 0;
      }
    };

    let trackingFrame: number | null = null;
    let settleFrame: number | null = null;
    const trackPaneResize = () => {
      syncOverlays();
      trackingFrame = requestAnimationFrame(trackPaneResize);
    };
    const startPaneResizeTracking = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)
        || window.getComputedStyle(target).cursor !== "row-resize"
        || trackingFrame !== null) {
        return;
      }
      trackPaneResize();
    };
    const stopPaneResizeTracking = () => {
      if (trackingFrame !== null) {
        cancelAnimationFrame(trackingFrame);
        trackingFrame = null;
      }
      syncOverlays();
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      settleFrame = requestAnimationFrame(syncOverlays);
    };

    syncOverlays();
    const initialFrame = requestAnimationFrame(syncOverlays);
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(syncOverlays)
      : null;
    resizeObserver?.observe(wrapper);
    for (const pane of chart.panes?.() || []) {
      const element = pane.getHTMLElement?.();
      if (element) resizeObserver?.observe(element);
    }
    wrapper.addEventListener("pointerdown", startPaneResizeTracking, true);
    window.addEventListener("pointerup", stopPaneResizeTracking);
    window.addEventListener("pointercancel", stopPaneResizeTracking);
    window.addEventListener("blur", stopPaneResizeTracking);
    window.addEventListener("resize", syncOverlays);
    return () => {
      cancelAnimationFrame(initialFrame);
      if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      resizeObserver?.disconnect();
      wrapper.removeEventListener("pointerdown", startPaneResizeTracking, true);
      window.removeEventListener("pointerup", stopPaneResizeTracking);
      window.removeEventListener("pointercancel", stopPaneResizeTracking);
      window.removeEventListener("blur", stopPaneResizeTracking);
      window.removeEventListener("resize", syncOverlays);
    };
  }, [activePaneIds, activePaneIdsKey, seriesReady, subPaneIdsKey]);

  const saveCurrentPaneHeights = useCallback((
    chart = chartRef.current,
    storageKey = paneHeightStorageKeyRef.current,
  ) => {
    if (paneLayoutControlledRef.current) return false;
    const heights = readPaneHeights(chart);
    if (!storageKey || heights.length <= 1) return false;
    const paneIds = activePaneIdsRef.current;
    if (paneIds.length === heights.length) {
      expandedPaneHeightsRef.current = new Map(
        paneIds.map((paneId, index) => [paneId, heights[index] || 0]),
      );
    }
    try {
      const saved = loadPaneHeights();
      saved[storageKey] = heights;
      savePaneHeights(saved);
      return true;
    } catch {
      return false;
    }
  }, []);

  const materializeRuntimePaneLayout = useCallback((
    chart: AdapterChart | null,
    container: HTMLElement | null,
    options: Parameters<typeof materializePaneLayout>[2] = undefined,
  ) => {
    const previousSyncing = isSyncingRef.current;
    isSyncingRef.current = true;
    try {
      return materializePaneLayout(chart, container, options);
    } finally {
      isSyncingRef.current = previousSyncing;
    }
  }, []);

  useEffect(() => { intervalRef.current = interval; }, [interval]);
  useEffect(() => { onNeedMoreLeftRef.current = onNeedMoreLeft; }, [onNeedMoreLeft]);
  useEffect(() => { canLoadMoreLeftRef.current = canLoadMoreLeft; }, [canLoadMoreLeft]);
  useEffect(() => { onViewportRangeChangeRef.current = onViewportRangeChange; }, [onViewportRangeChange]);
  useEffect(() => { onVisibleRangeChangeRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);

  const captureVisibleRange = useCallback(() => {
    const visibleRange = chartAdapter.getVisibleRange();
    if (!visibleRange) return null;
    const sourceFrom = sourceTimeFromAxisTime(visibleRange.time?.from);
    const sourceTo = sourceTimeFromAxisTime(visibleRange.time?.to);
    const sourceTimeRange = sourceFrom != null && sourceTo != null
      ? { from: Math.min(sourceFrom, sourceTo), to: Math.max(sourceFrom, sourceTo) }
      : null;
    return buildVisibleRangeSnapshot({
      barSpacing: visibleRange.barSpacing,
      logicalRange: visibleRange.logical,
      rightOffset: visibleRange.scrollPosition,
      timeRange: sourceTimeRange,
    });
  }, [chartAdapter]);

  const publishViewportRangeChange = useCallback((visibleRange: ChartSurfaceVisibleRange | null = null) => {
    const range = visibleRange || captureVisibleRange();
    if (range) onViewportRangeChangeRef.current?.(range);
  }, [captureVisibleRange]);

  const scheduleVisibleRangeSave = useCallback((visibleRange: ChartSurfaceVisibleRange | null = null) => {
    const range = visibleRange || captureVisibleRange();
    if (!range) return;
    if (visibleRangeSaveTimerRef.current) clearTimeout(visibleRangeSaveTimerRef.current);
    visibleRangeSaveTimerRef.current = setTimeout(() => {
      visibleRangeSaveTimerRef.current = null;
      onVisibleRangeChangeRef.current?.(range);
    }, VISIBLE_RANGE_SAVE_DEBOUNCE_MS);
  }, [captureVisibleRange]);

  const updateMainSeriesReference = useCallback((
    series: MainSeriesHandle | null,
    rows: ChartSeriesInputRow[],
    nextChartType: MainChartType | null = mainSeriesTypeRef.current,
  ) => {
    if (!series || !nextChartType) return;
    const options = buildMainSeriesReferenceOptions(nextChartType, rows);
    const signature = JSON.stringify(options);
    const previous = mainSeriesReferenceRef.current;
    if (previous.series === series && previous.signature === signature) return;
    if (Object.keys(options).length > 0) series.applyOptions(options);
    mainSeriesReferenceRef.current = { series, signature };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const drawingApisForSurface = drawingApisByPaneRef.current;
    const surfaceViewportCache = surfaceViewportCacheRef.current;
    const initialSubPaneCount = activeSubPaneCountRef.current;
    const initialPaneHeightStorageKey = paneHeightStorageKeyRef.current;

    const options = buildChartPaneOptions({
      container,
      theme,
      customBg,
      timezone,
      interval: intervalRef.current,
      showTimeScale: true,
    });
    options.layout = {
      ...options.layout,
      ...buildPaneLayoutOptions(),
    };

    const initialChartType = requestedChartTypeRef.current;
    const initialDescriptor = getChartTypeDescriptor(initialChartType);
    const initialDatasetKey = datasetKeyRef.current;
    const initialSurfaceConfigKey = surfaceConfigKey;
    const selectedViewport = selectSurfaceViewportSnapshot(
      surfaceViewportCache,
      {
        datasetKey: initialDatasetKey,
        outgoingSnapshot: pendingSurfaceViewportRef.current,
        surfaceConfigKey: initialSurfaceConfigKey,
      },
    );
    pendingSurfaceViewportRef.current = selectedViewport.snapshot;
    const chart = createChartInstance(container, options, {
      axisMode: initialDescriptor.axisMode,
    });
    const wrapper = wrapperRef.current;
    const totalHeight = wrapper?.getBoundingClientRect?.().height || wrapper?.clientHeight || 0;
    appliedAppearanceIntervalRef.current = intervalRef.current;
    const initialRows = rowsFromStore(seriesStoreRef.current);
    drawingSourceTimeHorizonRef.current = latestFiniteSourceTime(initialRows);
    syncSourceDataRefsFromStore({
      store: seriesStoreRef.current,
      rowsRef: sourceRowsRef,
      rowMapRef: sourceRowMapRef,
      rowIndexMapRef: sourceRowIndexMapRef,
    });
    const initialProjectionStore = createProjectionStore(
      initialChartType,
      initialRows,
      requestedProjectionSettingsRef.current || {},
    );
    initialProjectionStore.reset(initialRows);
    publishDrawingProjectionStore(initialProjectionStore);
    projectionGenerationRef.current += 1;
    syncDisplayDataRefsFromProjection({
      store: initialProjectionStore,
      rowsRef: displayRowsRef,
      rowMapRef: displayRowMapRef,
      rowIndexMapRef: displayRowIndexMapRef,
    });
    const placeholderAnchorTime = displayRowsRef.current.at(-1)?.time ?? null;
    ensurePanePlaceholderSeries(
      chart,
      panePlaceholderSeriesRef,
      initialSubPaneCount,
      placeholderAnchorTime,
    );
    setAuxiliaryDisplayState(initialDescriptor.axisMode === "derived-ordinal"
      ? {
          datasetKey: datasetKeyRef.current,
          rows: displayRowsRef.current,
          surfaceConfigKey: surfaceConfigKeyRef.current,
        }
      : { datasetKey: null, rows: [], surfaceConfigKey: null });
    const mainSeries = createMainSeries(chart, {
      chartType: initialChartType,
      data: initialRows,
      upColor,
      downColor,
      paneIndex: 0,
    });
    const futureTimeAxisSeries = createFutureTimeAxisSeries(chart, { paneIndex: 0 });
    chartRef.current = chart;
    activeSurfaceOwnerRef.current = {
      chart,
      datasetKey: initialDatasetKey,
      paneHeightStorageKey: initialPaneHeightStorageKey,
      surfaceConfigKey: initialSurfaceConfigKey,
    };
    viewportControllerRef.current = createViewportController({
      chartProvider: () => chartRef.current,
      contentLogicalRangeProvider: () => {
        const displayLength = displayRowsRef.current.length;
        return displayLength > 0 ? { from: 0, to: displayLength - 1 } : null;
      },
    });
    mainSeriesRef.current = mainSeries;
    futureTimeAxisSeriesRef.current = futureTimeAxisSeries;
    futureTimeAxisDataRef.current = [];
    futureTimeAxisPlanKeyRef.current = null;
    futureTimeAxisPointCountRef.current = FUTURE_TIME_AXIS_INITIAL_POINTS;
    mainSeriesTypeRef.current = initialChartType;
    surfaceAxisModeRef.current = initialDescriptor.axisMode;
    mainSeriesReferenceRef.current = {
      series: mainSeries,
      signature: JSON.stringify(buildMainSeriesReferenceOptions(initialChartType, initialRows)),
    };
    const initialTargetMainPaneIndex = Math.max(0, activePaneIdsRef.current.indexOf("main"));
    materializedMainPaneIndexRef.current = moveMainPane(
      chart,
      mainSeries,
      initialTargetMainPaneIndex,
    ) ?? 0;
    reindexPanePlaceholderSeries(panePlaceholderSeriesRef);
    preparePaneLayout(chart, {
      storageKey: initialPaneHeightStorageKey,
      subPaneCount: initialSubPaneCount,
      totalHeight,
      mainPaneIndex: materializedMainPaneIndexRef.current,
    });
    if (initialSubPaneCount > 0 || materializedMainPaneIndexRef.current !== 0) {
      materializePaneLayout(chart, container, { nudgeAxis: "height" });
    }
    if (pendingSurfaceViewportRef.current && displayRowsRef.current.length > 0) {
      isRestoringViewportRef.current = true;
      try {
        // Apply the remembered target surface before the first painted frame.
        // The later projection-sync restore remains as a fallback in case LWC
        // remaps logical indexes while committing the first complete dataset.
        const restored = restoreSurfaceViewport(
          viewportControllerRef.current,
          displayRowsRef.current,
          pendingSurfaceViewportRef.current,
          {
            axisMode: initialDescriptor.axisMode,
            datasetKey: initialDatasetKey,
            surfaceConfigKey: initialSurfaceConfigKey,
          },
        );
        if (restored) {
          materializePaneLayout(chart, container, { nudgeAxis: "height" });
        }
      } finally {
        isRestoringViewportRef.current = false;
      }
    }
    setSeriesReady((prev) => prev + 1);
    setDrawingSeriesGeneration((prev) => prev + 1);

    const handleCrosshairMove = (param: ChartCrosshairParam) => {
      if (isSyncingRef.current) return;
      if (param.time == null) {
        setPaneCrosshairTime(null);
        onCrosshairMove?.(null);
        return;
      }
      const axisTime = typeof param.time === "number" || isOrdinalAxisTime(param.time)
        ? param.time
        : null;
      if (axisTime == null) {
        setPaneCrosshairTime(null);
        onCrosshairMove?.(null);
        return;
      }
      const displayRow = displayRowMapRef.current.get(axisTime);
      const displayIndex = displayRowIndexMapRef.current.get(axisTime);
      const sourceTime = resolveSourceTime(axisTime, displayRow);
      setPaneCrosshairTime(sourceTime);
      if (!onCrosshairMove) return;
      const sourceRow = sourceTime == null ? null : sourceRowMapRef.current.get(sourceTime);
      const includeVolume = initialDescriptor.axisMode === "time"
        || isLastDisplayTargetForSourceTime(displayRowsRef.current, displayIndex);
      const crosshairValue = buildMainSeriesCrosshairValue(
        sourceTime,
        displayRow || sourceRow,
        { includeVolume, volumeRow: sourceRow },
      );
      if (!crosshairValue) {
        onCrosshairMove(null);
        return;
      }
      onCrosshairMove(crosshairValue);
    };

    const handleVisibleLogicalRangeChange = (range: VisibleLogicalRange) => {
      scheduleFutureTimeAxisCoverage();
      if (isChartPointerActiveRef.current && range) {
        chartPointerLogicalRangeChangedRef.current = true;
      }
      if (!shouldPublishUserViewportRange({
        isProgrammatic: isRestoringViewportRef.current,
        isSyncing: isSyncingRef.current,
        range,
        userInteracted: userInteractedRef.current,
      }) || !range) return;
      const visibleRange = captureVisibleRange();
      publishViewportRangeChange(visibleRange);
      scheduleVisibleRangeSave(visibleRange);
      const currentData = sourceRowsRef.current;
      if (shouldRequestMoreLeft({
        canLoad: canLoadMoreLeftRef.current,
        hasData: currentData?.length > 0,
        hasHandler: Boolean(onNeedMoreLeftRef.current),
        rangeFrom: range.from,
        triggerBars: LEFT_EDGE_TRIGGER_BARS,
        userInteracted: userInteractedRef.current,
      })) {
        const loadMoreLeft = onNeedMoreLeftRef.current;
        const firstRow = currentData[0];
        if (loadMoreLeft && firstRow) void loadMoreLeft(firstRow.time);
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

    return () => {
      const owner = activeSurfaceOwnerRef.current?.chart === chart
        ? activeSurfaceOwnerRef.current
        : {
            chart,
            datasetKey: initialDatasetKey,
            paneHeightStorageKey: initialPaneHeightStorageKey,
            surfaceConfigKey: initialSurfaceConfigKey,
          };
      const outgoingViewport = captureSurfaceViewport(chart, {
        axisMode: initialDescriptor.axisMode,
        datasetKey: owner.datasetKey,
        displayRows: displayRowsRef.current,
        surfaceConfigKey: owner.surfaceConfigKey,
      });
      if (outgoingViewport) {
        rememberSurfaceViewport(surfaceViewportCache, outgoingViewport);
      }
      pendingSurfaceViewportRef.current = outgoingViewport;
      saveCurrentPaneHeights(chart, owner.paneHeightStorageKey);
      if (visibleRangeSaveTimerRef.current) {
        clearTimeout(visibleRangeSaveTimerRef.current);
        visibleRangeSaveTimerRef.current = null;
      }
      // Stop exposing the old chart before touching the underlying LWC
      // instance.  During interval/session transitions its API object can
      // remain reachable briefly even though its internal time points have
      // already been cleared.
      chartRef.current = null;
      if (panePlaceholderSeriesRef.current.chart === chart) {
        panePlaceholderSeriesRef.current = { chart: null, seriesByPane: new Map() };
      }
      activeSurfaceOwnerRef.current = {
        chart: null,
        datasetKey: null,
        paneHeightStorageKey: null,
        surfaceConfigKey: null,
      };
      mainSeriesRef.current = null;
      materializedMainPaneIndexRef.current = 0;
      futureTimeAxisSeriesRef.current = null;
      futureTimeAxisDataRef.current = [];
      futureTimeAxisPlanKeyRef.current = null;
      if (futureTimeAxisCoverageFrameRef.current != null) {
        cancelAnimationFrame(futureTimeAxisCoverageFrameRef.current);
        futureTimeAxisCoverageFrameRef.current = null;
      }
      futureTimeAxisCoveragePendingRef.current = false;
      isChartPointerActiveRef.current = false;
      chartPointerLogicalRangeChangedRef.current = false;
      mainSeriesTypeRef.current = null;
      mainSeriesReferenceRef.current = { series: null, signature: "" };
      sourceRowsRef.current = [];
      sourceRowMapRef.current = new Map();
      sourceRowIndexMapRef.current = new Map();
      displayRowsRef.current = [];
      displayRowMapRef.current = new Map();
      displayRowIndexMapRef.current = new Map();
      renderedMainSeriesDataRef.current = [];
      publishDrawingProjectionStore(null);
      projectionGenerationRef.current += 1;
      projectionRenderContextRef.current = null;
      indicatorSeriesRef.current = [];
      paneRenderStateRef.current = new Map();
      prevIndicatorKeyRef.current = "";
      const viewportController = viewportControllerRef.current;
      viewportControllerRef.current = null;
      viewportController?.dispose();
      try {
        chart.unsubscribeCrosshairMove(handleCrosshairMove);
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      } catch { /* chart may already be disposing */ }
      onCrosshairMove?.(null);
      const drawingBoundary = resolveDrawingSurfaceChartTypeBoundary(
        initialChartType,
        requestedChartTypeRef.current,
      );
      const drawingsPrepared = disposeChartPaneSurface(chart, {
        // Drawing primitives keep a requestUpdate callback supplied by their
        // owning series. Detach them before remove() so a later re-attach
        // cannot enqueue work on this disposed surface.
        beforeRemove: () => {
          let prepared = true;
          for (const api of drawingApisForSurface.values()) {
            try {
              prepared = api.prepareSurfaceDispose(drawingBoundary) !== false && prepared;
            } catch {
              prepared = false;
            }
          }
          return prepared;
        },
        afterRemove: () => {
          for (const api of drawingApisForSurface.values()) {
            try { api.completeSurfaceDispose(); } catch { /* best-effort terminal cleanup */ }
          }
          return true;
        },
      });
      if (!drawingsPrepared) {
        console.warn("[drawing-engine] surface disposal continued after drawing teardown failed closed");
      }
    };
  }, [captureVisibleRange, customBg, downColor, onCrosshairMove, publishDrawingProjectionStore, publishViewportRangeChange, saveCurrentPaneHeights, scheduleFutureTimeAxisCoverage, scheduleVisibleRangeSave, surfaceConfigKey, theme, timezone, upColor]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const markUserInteracted = () => {
      userInteractedRef.current = true;
      viewportControllerRef.current?.markUserInteracting();
    };
    const resetPointerGesture = () => {
      const gesture = chartPointerGestureRef.current;
      gesture.kind = null;
      gesture.mainPanePlotStart = false;
      gesture.maxHorizontalMovementPx = 0;
      gesture.maxVerticalMovementPx = 0;
      gesture.startClientX = 0;
      gesture.startClientY = 0;
      gesture.touchIdentifier = null;
    };
    const beginPointerGesture = (
      kind: ChartPointerGestureState["kind"],
      clientX: number,
      clientY: number,
      touchIdentifier: number | null,
      eligiblePointer: boolean,
    ) => {
      const containerRect = containerRef.current?.getBoundingClientRect?.() ?? null;
      const plotRect = chartAdapter.getMainPanePlotRect?.() ?? null;
      const gesture = chartPointerGestureRef.current;
      gesture.kind = kind;
      gesture.mainPanePlotStart = eligiblePointer
        && !drawingEngineToolActive
        && isMainPanePlotPointerStart({
          clientX,
          clientY,
          containerRect,
          plotRect,
        });
      gesture.maxHorizontalMovementPx = 0;
      gesture.maxVerticalMovementPx = 0;
      gesture.startClientX = clientX;
      gesture.startClientY = clientY;
      gesture.touchIdentifier = touchIdentifier;
      chartPointerLogicalRangeChangedRef.current = false;
      isChartPointerActiveRef.current = true;
      markUserInteracted();
    };
    const markMousePointerActive = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".pane-control-bar")) return;
      beginPointerGesture("mouse", event.clientX, event.clientY, null, event.button === 0);
    };
    const markTouchPointerActive = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest(".pane-control-bar")) return;
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      beginPointerGesture(
        "touch",
        touch?.clientX ?? Number.NaN,
        touch?.clientY ?? Number.NaN,
        touch?.identifier ?? null,
        touch !== null,
      );
    };
    const trackPointerMovement = (clientX: number, clientY: number) => {
      if (!isChartPointerActiveRef.current) return;
      const gesture = chartPointerGestureRef.current;
      gesture.maxHorizontalMovementPx = Math.max(
        gesture.maxHorizontalMovementPx,
        Math.abs(clientX - gesture.startClientX),
      );
      gesture.maxVerticalMovementPx = Math.max(
        gesture.maxVerticalMovementPx,
        Math.abs(clientY - gesture.startClientY),
      );
    };
    const trackMouseMovement = (event: MouseEvent) => {
      if (chartPointerGestureRef.current.kind !== "mouse") return;
      trackPointerMovement(event.clientX, event.clientY);
    };
    const trackTouchMovement = (event: TouchEvent) => {
      const gesture = chartPointerGestureRef.current;
      if (gesture.kind !== "touch" || event.touches.length !== 1) {
        gesture.mainPanePlotStart = false;
        return;
      }
      const touch = event.touches[0];
      if (!touch || touch.identifier !== gesture.touchIdentifier) {
        gesture.mainPanePlotStart = false;
        return;
      }
      trackPointerMovement(touch.clientX, touch.clientY);
    };
    const saveNativePaneHeights = () => {
      if (activeSubPanes.length > 0) saveCurrentPaneHeights();
    };
    const releasePointer = () => {
      const pointerActive = isChartPointerActiveRef.current;
      const logicalRangeChanged = chartPointerLogicalRangeChangedRef.current;
      const gesture = chartPointerGestureRef.current;
      const mainPanePlotStart = gesture.mainPanePlotStart;
      const maxHorizontalMovementPx = gesture.maxHorizontalMovementPx;
      const maxVerticalMovementPx = gesture.maxVerticalMovementPx;
      isChartPointerActiveRef.current = false;
      chartPointerLogicalRangeChangedRef.current = false;
      resetPointerGesture();
      if (!pointerActive) return;
      saveNativePaneHeights();
      if (shouldInvalidateDrawingFrameOnPointerRelease({
        drawingToolActive: drawingEngineToolActive,
        logicalRangeChanged,
        mainPanePlotStart,
        maxHorizontalMovementPx,
        maxVerticalMovementPx,
        pointerActive,
      })) {
        notifyDrawingFrameInvalidation();
      }
      if (futureTimeAxisCoveragePendingRef.current) scheduleFutureTimeAxisCoverage();
    };
    wrapper.addEventListener("wheel", markUserInteracted, { passive: true });
    wrapper.addEventListener("mousedown", markMousePointerActive);
    wrapper.addEventListener("touchstart", markTouchPointerActive, { passive: true });
    window.addEventListener("mousemove", trackMouseMovement);
    window.addEventListener("touchmove", trackTouchMovement, { passive: true });
    window.addEventListener("mouseup", releasePointer);
    window.addEventListener("touchend", releasePointer, { passive: true });
    window.addEventListener("touchcancel", releasePointer, { passive: true });
    window.addEventListener("blur", releasePointer);
    return () => {
      wrapper.removeEventListener("wheel", markUserInteracted);
      wrapper.removeEventListener("mousedown", markMousePointerActive);
      wrapper.removeEventListener("touchstart", markTouchPointerActive);
      window.removeEventListener("mousemove", trackMouseMovement);
      window.removeEventListener("touchmove", trackTouchMovement);
      window.removeEventListener("mouseup", releasePointer);
      window.removeEventListener("touchend", releasePointer);
      window.removeEventListener("touchcancel", releasePointer);
      window.removeEventListener("blur", releasePointer);
      isChartPointerActiveRef.current = false;
      chartPointerLogicalRangeChangedRef.current = false;
      resetPointerGesture();
    };
  }, [
    activeSubPanes.length,
    chartAdapter,
    drawingEngineToolActive,
    notifyDrawingFrameInvalidation,
    saveCurrentPaneHeights,
    scheduleFutureTimeAxisCoverage,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const applyAppearance = () => {
      applyChartPaneAppearance(chart, { theme, customBg, timezone, interval });
      chart.applyOptions({ layout: buildPaneLayoutOptions() });
      appliedAppearanceIntervalRef.current = interval;
      notifyDrawingFrameInvalidation();
    };
    if (appliedAppearanceIntervalRef.current === interval) {
      applyAppearance();
      return undefined;
    }

    const scheduledMainSeries = mainSeriesRef.current;
    const fallbackMainData = renderedMainSeriesDataRef.current;
    const scheduledMainGeneration = renderedMainSeriesGenerationRef.current;
    const frameId = requestAnimationFrame(() => {
      if (chartRef.current !== chart) return;
      try {
        const futureTimeAxisPoints = resyncSeriesTimeScaleIndexes(
          futureTimeAxisSeriesRef.current,
          futureTimeAxisDataRef.current,
        );
        const currentMainSeries = mainSeriesRef.current;
        const currentMainData = renderedMainSeriesDataRef.current;
        const replayMainData = resolveIntervalTransitionReplayData({
          currentData: currentMainData,
          currentGeneration: renderedMainSeriesGenerationRef.current,
          currentSeries: currentMainSeries,
          fallbackData: fallbackMainData,
          scheduledGeneration: scheduledMainGeneration,
          scheduledSeries: scheduledMainSeries,
        });
        const mainPoints = resyncSeriesTimeScaleIndexes(currentMainSeries, replayMainData);
        let indicatorPoints = 0;
        let indicatorSeries = 0;
        for (const entry of indicatorSeriesRef.current) {
          const points = resyncSeriesTimeScaleIndexes(entry.series, entry.data);
          if (points <= 0) continue;
          indicatorPoints += points;
          indicatorSeries += 1;
        }
        if (mainPoints > 0) {
          recordPerfEvent("chart.candleSeries.setData", {
            paneId: "main",
            points: mainPoints,
            reason: "interval-transition-reindex",
          });
        }
        if (futureTimeAxisPoints > 0) {
          recordPerfEvent("chart.futureTimeAxis.setData", {
            paneId: "main",
            points: futureTimeAxisPoints,
            reason: "interval-transition-reindex",
          });
        }
        if (indicatorSeries > 0) {
          recordPerfEvent("chart.indicatorSeries.setData", {
            paneId: "single-chart",
            path: "interval-transition-reindex",
            points: indicatorPoints,
            series: indicatorSeries,
          });
        }
      } catch (error) {
        recordPerfEvent("chart.intervalTransition.reindexError", {
          message: error instanceof Error ? error.message : String(error),
          paneId: "single-chart",
        });
      } finally {
        applyAppearance();
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [chartAdapter, customBg, interval, notifyDrawingFrameInvalidation, theme, timezone]);

  useEffect(() => {
    const activeType = mainSeriesTypeRef.current || resolvedChartType;
    mainSeriesRef.current?.applyOptions({
      ...buildMainSeriesStyleOptions(activeType, { upColor, downColor }),
      crosshairMarkerVisible: showCrosshairDetails && !drawingEngineToolActive,
    });
    notifyDrawingFrameInvalidation();
  }, [downColor, drawingEngineToolActive, notifyDrawingFrameInvalidation, resolvedChartType, seriesReady, showCrosshairDetails, upColor]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      crosshair: buildCrosshairOptions(showCrosshairDetails),
    });
  }, [seriesReady, showCrosshairDetails]);

  useEffect(() => {
    const container = containerRef.current;
    const overlay = cursorOverlayRef.current;
    if (!container || !overlay || !cursorOverlayClass) {
      if (overlay) overlay.style.display = "none";
      return undefined;
    }

    const updateCursor = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        overlay.style.display = "none";
        return;
      }
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const plotRect = chartAdapter.getMainPanePlotRect?.() ?? null;
      if (!plotRect
        || x < plotRect.x
        || y < plotRect.y
        || x > plotRect.x + plotRect.width
        || y > plotRect.y + plotRect.height) {
        overlay.style.display = "none";
        return;
      }
      overlay.style.display = "block";
      overlay.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    };
    const hideCursor = () => {
      overlay.style.display = "none";
    };

    container.addEventListener("pointermove", updateCursor);
    container.addEventListener("pointerenter", updateCursor);
    container.addEventListener("pointerleave", hideCursor);
    return () => {
      hideCursor();
      container.removeEventListener("pointermove", updateCursor);
      container.removeEventListener("pointerenter", updateCursor);
      container.removeEventListener("pointerleave", hideCursor);
    };
  }, [chartAdapter, cursorOverlayClass]);

  useEffect(() => {
    const chart = chartRef.current;
    const previousSeries = mainSeriesRef.current;
    if (!chart
      || !previousSeries
      || !mainSeriesTypeRef.current
      || mainSeriesTypeRef.current === resolvedChartType) return;

    const rows = rowsFromStore(seriesStore);
    const visibleRange = captureVisibleRange();
    const drawingApi = drawingApiRef.current;
    let drawingPreparationAttempted = false;
    let drawingSurfacePrepared = false;
    let mainSeriesReplaced = false;
    try {
      isSyncingRef.current = true;
      const previousType = mainSeriesTypeRef.current;
      const previousDescriptor = getChartTypeDescriptor(previousType);
      const nextDescriptor = getChartTypeDescriptor(resolvedChartType);
      if (previousDescriptor.axisMode !== nextDescriptor.axisMode) {
        throw new Error("switching horizontal-axis modes requires recreating the chart surface");
      }
      const nextProjectionStore = createProjectionStore(
        resolvedChartType,
        rows,
        projectionSettings,
      );
      const projectionPatch = nextProjectionStore.reset(rows);
      const displayRows = nextProjectionStore.displaySnapshot();
      const renderedPatch = buildMainSeriesProjectionPatch({
        displayRows,
        previousSeriesData: [],
        projectionPatch,
        renderOptions: {
          ...mainSeriesRenderContext,
          chartType: resolvedChartType,
        },
      });
      const nextSeriesData = materializeMainSeriesProjectionPatch(renderedPatch);
      if (drawingApi) {
        drawingPreparationAttempted = true;
        drawingSurfacePrepared = prepareDrawingSurfaceForSeriesReplacement(
          () => drawingApi.prepareSurfaceDispose({
            kind: "chart-type",
            beforeValue: previousType,
            afterValue: resolvedChartType,
          }),
          () => setDrawingSeriesGeneration((prev) => prev + 1),
        );
        if (!drawingSurfacePrepared) {
          console.warn("SingleChartPanes: drawing surface blocked the main-series replacement");
          return;
        }
      }
      const result = replaceMainSeries(chart, previousSeries, {
        chartType: resolvedChartType,
        data: rows,
        downColor,
        indicatorBarColorMap,
        paneIndex: resolveMainPaneIndex(
          chart,
          previousSeries,
          materializedMainPaneIndexRef.current,
        ),
        previousSeriesData: renderedMainSeriesDataRef.current,
        seriesData: nextSeriesData,
        upColor,
      });

      mainSeriesRef.current = result.series;
      materializedMainPaneIndexRef.current = resolveMainPaneIndex(
        chart,
        result.series,
        materializedMainPaneIndexRef.current,
      );
      mainSeriesTypeRef.current = result.chartType;
      mainSeriesReplaced = true;
      notifyDrawingFrameInvalidation();
      // Publish drawing invalidation immediately after the irreversible series
      // replacement. Later projection/layout work may throw, but the drawing
      // lifecycle must still receive a generation and rebind every entity.
      drawingApi?.invalidateSurfaceCredentialsForSeriesReplacement();
      setDrawingSeriesGeneration((prev) => prev + 1);
      renderedMainSeriesDataRef.current = result.data;
      renderedMainSeriesGenerationRef.current += 1;
      publishDrawingProjectionStore(nextProjectionStore);
      projectionGenerationRef.current += 1;
      projectionRenderContextRef.current = mainSeriesRenderContext;
      syncSourceDataRefsFromStore({
        store: seriesStore,
        rowsRef: sourceRowsRef,
        rowMapRef: sourceRowMapRef,
        rowIndexMapRef: sourceRowIndexMapRef,
      });
      syncDisplayDataRefsFromProjection({
        store: nextProjectionStore,
        rowsRef: displayRowsRef,
        rowMapRef: displayRowMapRef,
        rowIndexMapRef: displayRowIndexMapRef,
      });
      ensurePanePlaceholderSeries(
        chart,
        panePlaceholderSeriesRef,
        activeSubPaneCountRef.current,
        displayRowsRef.current.at(-1)?.time ?? null,
        { mainPaneIndex: materializedMainPaneIndexRef.current },
      );
      setAuxiliaryDisplayState(nextDescriptor.axisMode === "derived-ordinal"
        ? {
            datasetKey: datasetKeyRef.current,
            rows: displayRowsRef.current,
            surfaceConfigKey: surfaceConfigKeyRef.current,
          }
        : { datasetKey: null, rows: [], surfaceConfigKey: null });
      mainSeriesReferenceRef.current = {
        series: result.series,
        signature: JSON.stringify(buildMainSeriesReferenceOptions(resolvedChartType, rows)),
      };

      if (visibleRange) chartAdapter.restoreVisibleRange(visibleRange);
      recordPerfEvent("chart.mainSeries.switch", {
        bars: result.data.length,
        from: previousType,
        to: resolvedChartType,
      });
      setSeriesReady((prev) => prev + 1);
    } catch (error) {
      if (drawingPreparationAttempted && !mainSeriesReplaced) {
        // replaceMainSeries retained/rolled back the old series after drawings
        // began preparing. Re-enter same-symbol binding after complete,
        // partial, or throwing preparation to restore the retained surface.
        setDrawingSeriesGeneration((prev) => prev + 1);
      }
      console.warn("SingleChartPanes: failed to switch main chart type:", error);
    } finally {
      isSyncingRef.current = false;
    }
  }, [
    captureVisibleRange,
    chartAdapter,
    downColor,
    indicatorBarColorMap,
    mainSeriesRenderContext,
    notifyDrawingFrameInvalidation,
    projectionSettings,
    publishDrawingProjectionStore,
    resolvedChartType,
    seriesStore,
    upColor,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const mainPaneIndex = resolveMainPaneIndex(
      chart,
      mainSeriesRef.current,
      materializedMainPaneIndexRef.current,
    );
    materializedMainPaneIndexRef.current = mainPaneIndex;
    chart.priceScale("right", mainPaneIndex).applyOptions({
      invertScale: !!invertScale,
      mode: priceScaleMode ?? 0,
    });
    notifyDrawingFrameInvalidation();
  }, [invertScale, notifyDrawingFrameInvalidation, priceScaleMode, seriesReady]);

  const resetAutoScale = useCallback(() => {
    try {
      const chart = chartRef.current;
      const mainPaneIndex = resolveMainPaneIndex(
        chart,
        mainSeriesRef.current,
        materializedMainPaneIndexRef.current,
      );
      materializedMainPaneIndexRef.current = mainPaneIndex;
      chart?.priceScale("right", mainPaneIndex).applyOptions({ autoScale: true });
      notifyDrawingFrameInvalidation();
      setIsAutoScale(true);
    } catch { /* */ }
  }, [notifyDrawingFrameInvalidation]);

  const handlePriceScaleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect?.();
    if (!rect) return;
    if (event.clientX < rect.right - PRICE_SCALE_CONTEXT_HIT_WIDTH) return;
    const plotRect = chartAdapter.getMainPanePlotRect?.() ?? null;
    const localY = event.clientY - rect.top;
    if (plotRect && (localY < plotRect.y || localY > plotRect.y + plotRect.height)) return;
    event.preventDefault();
    event.stopPropagation();
    const margin = PRICE_SCALE_CONTEXT_MENU_MARGIN;
    const maxX = Math.max(rect.left + margin, rect.right - PRICE_SCALE_CONTEXT_MENU_WIDTH - margin);
    const maxY = Math.max(rect.top + margin, rect.bottom - PRICE_SCALE_CONTEXT_MENU_HEIGHT - margin);
    setContextMenu({
      x: Math.min(Math.max(event.clientX, rect.left + margin), maxX),
      y: Math.min(Math.max(event.clientY, rect.top + margin), maxY),
    });
  }, [chartAdapter]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const handleClick = () => setContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (pendingSurfaceViewportRef.current?.datasetKey !== datasetKey) {
      pendingSurfaceViewportRef.current = null;
    }
    if (activeSurfaceOwnerRef.current?.chart === chartRef.current) {
      activeSurfaceOwnerRef.current = {
        ...activeSurfaceOwnerRef.current,
        datasetKey,
      };
    }
    if (futureTimeAxisCoverageFrameRef.current != null) {
      cancelAnimationFrame(futureTimeAxisCoverageFrameRef.current);
      futureTimeAxisCoverageFrameRef.current = null;
    }
    futureTimeAxisCoveragePendingRef.current = false;
    clearFutureTimeAxis({ force: true, resetPointCount: true });
    const chart = chartRef.current;
    const subPaneCount = activeSubPaneCountRef.current;
    trimPanePlaceholderSeries(chart, panePlaceholderSeriesRef, subPaneCount + 1);
    clearAuxiliaryChartState({
      chart,
      indicatorSeriesRef,
      paneRenderStateRef,
      prevIndicatorKeyRef,
      reason: "dataset-change",
      retainPaneCount: subPaneCount + 1,
    });
    const wrapper = wrapperRef.current;
    const totalHeight = wrapper?.getBoundingClientRect?.().height || wrapper?.clientHeight || 0;
    const mainPaneIndex = resolveMainPaneIndex(
      chart,
      mainSeriesRef.current,
      materializedMainPaneIndexRef.current,
    );
    materializedMainPaneIndexRef.current = mainPaneIndex;
    ensurePanePlaceholderSeries(
      chart,
      panePlaceholderSeriesRef,
      subPaneCount,
      null,
      { mainPaneIndex },
    );
    preparePaneLayout(chart, {
      storageKey: paneHeightStorageKeyRef.current,
      subPaneCount,
      totalHeight,
      mainPaneIndex,
    });
    if (subPaneCount > 0) {
      materializeRuntimePaneLayout(chart, containerRef.current);
    }
    userInteractedRef.current = false;
    hasRestoredRangeRef.current = false;
    lastViewportRestoreSourceRef.current = null;
    renderedMainSeriesDataRef.current = [];
    drawingSourceTimeHorizonRef.current = null;
    displayRowsRef.current = [];
    displayRowMapRef.current = new Map();
    displayRowIndexMapRef.current = new Map();
    publishDrawingProjectionStore(null);
    setAuxiliaryDisplayState({ datasetKey: null, rows: [], surfaceConfigKey: null });
    projectionGenerationRef.current += 1;
    projectionRenderContextRef.current = null;
    viewportControllerRef.current?.resetSession();
  }, [clearFutureTimeAxis, datasetKey, materializeRuntimePaneLayout, publishDrawingProjectionStore]);

  useEffect(() => {
    const series = mainSeriesRef.current;
    const store = seriesStore;
    if (!series || !store) return undefined;
    const activeChartType = mainSeriesTypeRef.current;
    if (!activeChartType) return undefined;
    const activeRenderOptions = {
      ...mainSeriesRenderContext,
      chartType: activeChartType,
    };
    const rows = rowsFromStore(store);
    drawingSourceTimeHorizonRef.current = latestFiniteSourceTime(rows);
    const desiredProjectionStore = createProjectionStore(
      activeChartType,
      rows,
      projectionSettings,
    );
    const existingProjectionStore = projectionStoreRef.current;
    const canReuseProjection = existingProjectionStore?.configurationKey
      === desiredProjectionStore.configurationKey;
    const projectionStore = canReuseProjection
      ? existingProjectionStore
      : desiredProjectionStore;
    const generation = projectionGenerationRef.current + 1;
    projectionGenerationRef.current = generation;
    if (shouldAdvanceDrawingCoordinateGeneration({
      axisMode: getChartTypeDescriptor(activeChartType).axisMode,
      canReuseProjection,
    })) {
      // Resolved ATR/minTick values can change while the requested settings
      // key stays the same. Cancel transient drawing state across that
      // structural coordinate reprojection even though the series survives.
      drawingCoordinateGenerationRef.current += 1;
      setDrawingCoordinateGeneration(drawingCoordinateGenerationRef.current);
    }
    // Own the mutable store immediately, but keep drawings on the last
    // committed immutable snapshot until the corresponding LWC render wins.
    projectionStoreRef.current = projectionStore;

    try {
      isSyncingRef.current = true;
      syncSourceDataRefsFromStore({
        store,
        rowsRef: sourceRowsRef,
        rowMapRef: sourceRowMapRef,
        rowIndexMapRef: sourceRowIndexMapRef,
      });
      const previousDisplayRows = displayRowsRef.current;
      const projectionPatch = canReuseProjection
        ? projectionStore.applySourceDelta({ type: "replace" }, rows)
        : projectionStore.reset(rows);
      const effectiveProjectionPatch = projectionRenderContextRef.current === mainSeriesRenderContext
        ? projectionPatch
        : { ...projectionPatch, fromOutputIndex: 0 };
      const displayRows = projectionStore.displaySnapshot();
      const axisMode = getChartTypeDescriptor(activeChartType).axisMode;
      const futureTimeAxisPlan = createFutureTimeAxisPlan(displayRows);
      const futureTimeAxisCanCommit = axisMode !== "derived-ordinal"
        || !futureTimeAxisPlan.changed
        || clearFutureTimeAxis({ force: true });
      const renderedPatch = buildMainSeriesProjectionPatch({
        displayRows,
        projectionPatch: effectiveProjectionPatch,
        renderOptions: activeRenderOptions,
        ...(renderedMainSeriesDataRef.current === null
          ? {}
          : { previousSeriesData: renderedMainSeriesDataRef.current }),
      });
      let projectionRendered = false;
      try {
        const renderResult = renderMainSeriesProjectionPatch({
          previousDisplayRows,
          patch: renderedPatch,
          preserveViewport: shouldPreserveProjectionViewport(
            { type: "replace" },
            {
              hasDisplay: previousDisplayRows.length > 0,
              userInteracted: userInteractedRef.current,
            },
          ),
          recordPerfEvent,
          resolveDisplayAnchorIndex: (time) => (
            projectionStore.resolveDisplayAnchorIndex(time)
          ),
          series,
          viewportController: viewportControllerRef.current,
        });
        renderedMainSeriesDataRef.current = renderResult.nextData;
        renderedMainSeriesGenerationRef.current += 1;
        projectionRendered = true;
      } catch (error) {
        // The chart may be partially mutated when both an incremental write
        // and its setData recovery fail. A null cache forces the next delta to
        // rebuild from output index zero instead of compounding that state.
        renderedMainSeriesDataRef.current = null;
        renderedMainSeriesGenerationRef.current += 1;
        recordPerfEvent("chart.candleSeries.renderError", {
          message: error instanceof Error ? error.message : String(error),
          paneId: "main",
          phase: "sync",
        });
      }
      if (projectionRendered && futureTimeAxisCanCommit) {
        try {
          commitFutureTimeAxisPlan(futureTimeAxisPlan, "projection-sync");
        } catch (error) {
          try { clearFutureTimeAxis({ force: true }); } catch { /* best-effort carrier cleanup */ }
          recordPerfEvent("chart.futureTimeAxis.renderError", {
            message: error instanceof Error ? error.message : String(error),
            phase: "projection-sync",
          });
        }
      }
      syncDisplayDataRefsFromProjection({
        store: projectionStore,
        rowsRef: displayRowsRef,
        rowMapRef: displayRowMapRef,
        rowIndexMapRef: displayRowIndexMapRef,
      });
      ensurePanePlaceholderSeries(
        chartRef.current,
        panePlaceholderSeriesRef,
        activeSubPaneCountRef.current,
        displayRows.at(-1)?.time ?? null,
        { mainPaneIndex: materializedMainPaneIndexRef.current },
      );
      if (getChartTypeDescriptor(activeChartType).axisMode === "derived-ordinal"
        && previousDisplayRows !== displayRows) {
        setAuxiliaryDisplayState({
          datasetKey: datasetKeyRef.current,
          rows: displayRows,
          surfaceConfigKey: surfaceConfigKeyRef.current,
        });
      }
      updateMainSeriesReference(series, rows);
      projectionRenderContextRef.current = mainSeriesRenderContext;
      if (projectionRendered) {
        publishDrawingProjectionStore(projectionStore);
        chartAdapter.requestSeriesUpdate();
      }
      if (projectionRendered && pendingSurfaceViewportRef.current && displayRows.length > 0) {
        isRestoringViewportRef.current = true;
        try {
          const restored = restoreSurfaceViewport(
            viewportControllerRef.current,
            displayRows,
            pendingSurfaceViewportRef.current,
            {
              axisMode: surfaceAxisModeRef.current,
              datasetKey: datasetKeyRef.current,
              surfaceConfigKey: surfaceConfigKeyRef.current,
            },
          );
          if (restored) {
            materializeRuntimePaneLayout(
              chartRef.current,
              containerRef.current,
              { nudgeAxis: "height" },
            );
          }
          pendingSurfaceViewportRef.current = null;
        } finally {
          isRestoringViewportRef.current = false;
        }
      }
    } finally {
      isSyncingRef.current = false;
    }

    const unsubscribe = store.subscribe((delta, currentStore) => {
      if (projectionGenerationRef.current !== generation || delta?.type === "noop") return;
      const currentSeries = mainSeriesRef.current;
      if (!currentSeries) return;
      try {
        isSyncingRef.current = true;
        const currentChartType = mainSeriesTypeRef.current || activeChartType;
        const currentRenderOptions = {
          ...mainSeriesRenderContext,
          chartType: currentChartType,
        };
        const rows = rowsFromStore(currentStore);
        const previousSourceTimeHorizon = drawingSourceTimeHorizonRef.current;
        const nextSourceTimeHorizon = latestFiniteSourceTime(rows);
        drawingSourceTimeHorizonRef.current = nextSourceTimeHorizon;
        const sourceTimeHorizonChanged = nextSourceTimeHorizon !== previousSourceTimeHorizon;
        const previousDisplayRows = projectionStore.displaySnapshot();
        const projectionPatch = projectionStore.applySourceDelta(delta, rows);
        const displayRows = projectionStore.displaySnapshot();
        const axisMode = getChartTypeDescriptor(currentChartType).axisMode;
        const futureTimeAxisPlan = createFutureTimeAxisPlan(displayRows);
        const futureTimeAxisCanCommit = axisMode !== "derived-ordinal"
          || !futureTimeAxisPlan.changed
          || clearFutureTimeAxis({ force: true });
        const renderedPatch = buildMainSeriesProjectionPatch({
          displayRows,
          projectionPatch,
          renderOptions: currentRenderOptions,
          ...(renderedMainSeriesDataRef.current === null
            ? {}
            : { previousSeriesData: renderedMainSeriesDataRef.current }),
        });
        let projectionRendered = false;
        try {
          const renderResult = renderMainSeriesProjectionPatch({
            previousDisplayRows,
            patch: renderedPatch,
            preserveViewport: shouldPreserveProjectionViewport(delta, {
              hasDisplay: previousDisplayRows.length > 0,
              userInteracted: userInteractedRef.current,
            }),
            recordPerfEvent,
            resolveDisplayAnchorIndex: (time) => (
              projectionStore.resolveDisplayAnchorIndex(time)
            ),
            series: currentSeries,
            viewportController: viewportControllerRef.current,
          });
          renderedMainSeriesDataRef.current = renderResult.nextData;
          renderedMainSeriesGenerationRef.current += 1;
          projectionRendered = true;
        } catch (error) {
          renderedMainSeriesDataRef.current = null;
          renderedMainSeriesGenerationRef.current += 1;
          recordPerfEvent("chart.candleSeries.renderError", {
            message: error instanceof Error ? error.message : String(error),
            paneId: "main",
            phase: "delta",
          });
        }
        if (projectionRendered && futureTimeAxisCanCommit) {
          try {
            commitFutureTimeAxisPlan(futureTimeAxisPlan, "projection-delta");
          } catch (error) {
            try { clearFutureTimeAxis({ force: true }); } catch { /* best-effort carrier cleanup */ }
            recordPerfEvent("chart.futureTimeAxis.renderError", {
              message: error instanceof Error ? error.message : String(error),
              phase: "projection-delta",
            });
          }
        }
        syncSourceDataRefsFromStore({
          store: currentStore,
          rowsRef: sourceRowsRef,
          rowMapRef: sourceRowMapRef,
          rowIndexMapRef: sourceRowIndexMapRef,
        });
        syncDisplayDataRefsFromProjection({
          store: projectionStore,
          rowsRef: displayRowsRef,
          rowMapRef: displayRowMapRef,
          rowIndexMapRef: displayRowIndexMapRef,
        });
        ensurePanePlaceholderSeries(
          chartRef.current,
          panePlaceholderSeriesRef,
          activeSubPaneCountRef.current,
          displayRows.at(-1)?.time ?? null,
          { mainPaneIndex: materializedMainPaneIndexRef.current },
        );
        if (getChartTypeDescriptor(currentChartType).axisMode === "derived-ordinal"
          && previousDisplayRows !== displayRows) {
          setAuxiliaryDisplayState({
            datasetKey: datasetKeyRef.current,
            rows: displayRows,
            surfaceConfigKey: surfaceConfigKeyRef.current,
          });
        }
        updateMainSeriesReference(currentSeries, rows);
        if (projectionRendered) {
          publishDrawingProjectionStore(projectionStore);
          chartAdapter.requestSeriesUpdate();
        } else if (sourceTimeHorizonChanged
          && getChartTypeDescriptor(currentChartType).axisMode === "derived-ordinal") {
          chartAdapter.requestSeriesUpdate();
        }
      } finally {
        isSyncingRef.current = false;
      }
    });
    return () => { unsubscribe(); };
  }, [chartAdapter, clearFutureTimeAxis, commitFutureTimeAxisPlan, createFutureTimeAxisPlan, mainSeriesRenderContext, materializeRuntimePaneLayout, projectionSettings, publishDrawingProjectionStore, seriesReady, seriesStore, updateMainSeriesReference]);

  useEffect(() => {
    const rows = rowsFromStore(seriesStore);
    if (!shouldRestoreChartViewport({
      dataMeta,
      datasetKey,
      hasRestored: hasRestoredRangeRef.current,
      hasRows: rows.length > 0,
      lastRestoreSource: lastViewportRestoreSourceRef.current,
      userInteracted: userInteractedRef.current,
    })) return;

    const restorePlan = planVisibleRangeRestore(savedVisibleRange, rows, dataMeta);
    let restored = false;
    isRestoringViewportRef.current = true;
    try {
      restored = viewportControllerRef.current?.applySessionRestore(
        restorePlan,
        { sessionKey: datasetKey },
      ) ?? false;
    } finally {
      isRestoringViewportRef.current = false;
    }
    recordPerfEvent("chart.viewport.restore", {
      applied: Boolean(restored),
      bars: rows.length,
      datasetKey,
      mode: restorePlan?.mode || "fit",
      visibleLogicalRange: captureVisibleRange()?.logical || null,
    });
    hasRestoredRangeRef.current = true;
    lastViewportRestoreSourceRef.current = dataMeta?.source || null;
    if (restored) publishViewportRangeChange();
  }, [captureVisibleRange, dataMeta, datasetKey, publishViewportRangeChange, savedVisibleRange, seriesStore]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !indicatorDatasetOwned) return;
    const expectedPaneCount = Math.max(1, paneDescriptors.length);
    const paneCountBefore = chart.panes?.()?.length ?? 1;
    const paneStructureChanged = paneCountBefore !== expectedPaneCount;

    const currentMainPaneIndex = resolveMainPaneIndex(
      chart,
      mainSeriesRef.current,
      materializedMainPaneIndexRef.current,
    );
    ensurePanePlaceholderSeries(
      chart,
      panePlaceholderSeriesRef,
      expectedPaneCount - 1,
      displayRowsRef.current.at(-1)?.time ?? null,
      { mainPaneIndex: currentMainPaneIndex },
    );
    const nextMainPaneIndex = moveMainPane(
      chart,
      mainSeriesRef.current,
      desiredMainPaneIndex,
    );
    materializedMainPaneIndexRef.current = nextMainPaneIndex ?? currentMainPaneIndex;
    reindexPanePlaceholderSeries(panePlaceholderSeriesRef);

    const structuralKey = paneDescriptors
      .flatMap((pane) => (pane.lines || []).map((line) => [
        pane.id,
        pane.paneIndex,
        line.name || "",
        line.id || "",
        line.type || "line",
        line.color || "",
        line.lineWidth || "",
        line.lineStyle || "",
        line.scale || "",
        line.valueFormat || "",
      ].join(":")))
      .join("|");
    const structureChanged = structuralKey !== prevIndicatorKeyRef.current;
    prevIndicatorKeyRef.current = structuralKey;

    const entryKey = (pane: PaneDescriptor, line: AdapterIndicatorLine) => JSON.stringify([
      pane.id,
      pane.paneIndex,
      line.indicatorId || "",
      line.id || line.name || "",
      line.type || "line",
    ]);
    const existingByKey = new Map<string, IndicatorSeriesEntry[]>();
    for (const entry of indicatorSeriesRef.current) {
      const key = entry.key || JSON.stringify([
        entry.paneId,
        entry.paneIndex,
        entry.lineConfig?.indicatorId || "",
        entry.lineConfig?.id || entry.lineConfig?.name || "",
        entry.lineConfig?.type || "line",
      ]);
      const matches = existingByKey.get(key) || [];
      matches.push(entry);
      existingByKey.set(key, matches);
    }

    const nextEntries: IndicatorSeriesEntry[] = [];
    const retainedEntries = new Set<IndicatorSeriesEntry>();
    let createdSeriesCount = 0;
    for (const pane of paneDescriptors) {
      for (const line of pane.lines || []) {
        const key = entryKey(pane, line);
        const matches = existingByKey.get(key) || [];
        const existing = matches.shift() || null;
        const validData = normalizeLineSeriesData(line, renderDataTimeSet);
        const detail = {
          datasetKey,
          indicatorId: line.indicatorId,
          interval,
          paneId: pane.id,
          line: line.name || line.id,
          type: line.type || "line",
        };

        if (existing) {
          existing.series.applyOptions?.(buildIndicatorSeriesOptions(line, {
            crosshairMarkerVisible: showCrosshairDetails && !drawingEngineToolActive,
          }));
          applyLineSeriesData(existing.series, validData, existing.data, {
            ...detail,
            path: "single-fast",
          }, recordPerfEvent, {
            preferSetData: shouldPreferIndicatorSetData({
              createdAtMs: existing.createdAtMs,
              usesDerivedAxis,
            }),
          });
          existing.key = key;
          existing.paneId = pane.id;
          existing.paneIndex = pane.paneIndex;
          existing.lineConfig = line;
          existing.data = validData;
          retainedEntries.add(existing);
          nextEntries.push(existing);
          continue;
        }

        if (validData.length === 0) continue;
        try {
          const series = createIndicatorSeries(chart, line, {
            paneIndex: pane.paneIndex,
            crosshairMarkerVisible: showCrosshairDetails && !drawingEngineToolActive,
          });
          series.setData(validData);
          recordPerfEvent("chart.indicatorSeries.setData", {
            ...detail,
            path: "single-reconcile",
            points: validData.length,
          });
          recordPerfEvent("chart.indicatorSeries.create", {
            paneId: pane.id,
            line: line.name || line.id || nextEntries.length,
            type: line.type || "line",
            path: "single-reconcile",
          });
          nextEntries.push({
            createdAtMs: Date.now(),
            key,
            paneId: pane.id,
            paneIndex: pane.paneIndex,
            series,
            lineConfig: line,
            data: validData,
          });
          createdSeriesCount += 1;
        } catch (err) {
          console.warn("SingleChartPanes: failed to add indicator series:", err);
        }
      }
    }

    const staleEntries = indicatorSeriesRef.current.filter((entry) => !retainedEntries.has(entry));
    const drawingPanesWithReplacingAnchors = new Set(staleEntries
      .filter((entry) => indicatorSeriesRef.current.find((candidate) => (
        candidate.paneId === entry.paneId
      ))?.series === entry.series)
      .map((entry) => entry.paneId));
    for (const paneId of drawingPanesWithReplacingAnchors) {
      try {
        if (drawingApisByPaneRef.current.get(paneId)?.prepareSurfaceDispose() === false) {
          console.warn(`SingleChartPanes: drawing pane ${paneId} did not fully prepare before anchor replacement`);
        }
      } catch (error) {
        console.warn(`SingleChartPanes: drawing pane ${paneId} preparation threw before anchor replacement`, error);
      }
    }
    const removedSeriesCount = removeSeriesEntries(chart, staleEntries);
    for (const paneId of drawingPanesWithReplacingAnchors) {
      drawingApisByPaneRef.current.get(paneId)?.invalidateSurfaceCredentialsForSeriesReplacement();
    }
    if (removedSeriesCount > 0) {
      recordPerfEvent("chart.indicatorSeries.remove", {
        paneId: "single-chart",
        reason: "reconcile",
        series: removedSeriesCount,
      });
    }
    applyIndicatorPaneSeriesOrder(nextEntries);
    indicatorSeriesRef.current = nextEntries;

    trimPanePlaceholderSeries(chart, panePlaceholderSeriesRef, expectedPaneCount);
    trimPanes(chart, expectedPaneCount);
    if (paneStructureChanged) {
      const wrapper = wrapperRef.current;
      const totalHeight = wrapper?.getBoundingClientRect?.().height || wrapper?.clientHeight || 0;
      preparePaneLayout(chart, {
        storageKey: paneHeightStorageKeyRef.current,
        subPaneCount: expectedPaneCount - 1,
        totalHeight,
        mainPaneIndex: materializedMainPaneIndexRef.current,
      });
      materializeRuntimePaneLayout(chart, containerRef.current);
    }
    if (shouldAdvanceIndicatorSeriesReady({
      createdSeriesCount,
      paneStructureChanged,
      removedSeriesCount,
      structureChanged,
    })) {
      setSeriesReady((prev) => prev + 1);
    }
  }, [datasetKey, desiredMainPaneIndex, drawingEngineToolActive, indicatorDatasetOwned, interval, materializeRuntimePaneLayout, paneDescriptors, renderDataTimeSet, seriesReady, showCrosshairDetails, usesDerivedAxis]);

  useEffect(() => {
    const chart = chartRef.current;
    const wrapper = wrapperRef.current;
    if (!chart || !wrapper || activeSubPaneCount === 0) return;
    const expectedPaneCount = activeSubPaneCount + 1;
    if (paneDescriptors.length !== expectedPaneCount
      || chart.panes?.()?.length !== expectedPaneCount) {
      return;
    }

    const totalHeight = wrapper.getBoundingClientRect?.().height || wrapper.clientHeight || 0;
    const paneHeights = resolvePaneHeightLayout(
      paneHeightStorageKey,
      activeSubPaneCount,
      totalHeight,
      materializedMainPaneIndexRef.current,
    );
    if (paneHeights) setPaneHeights(chart, paneHeights);
  }, [activeSubPaneCount, paneDescriptors.length, paneHeightStorageKey, seriesReady, subPaneIdsKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const expectedPaneCount = activeSubPanes.length + 1;
    if (!chart
      || paneDescriptors.length !== expectedPaneCount
      || chart.panes?.()?.length !== expectedPaneCount
      || activeSurfaceOwnerRef.current?.chart !== chart) {
      return;
    }
    activeSurfaceOwnerRef.current = {
      ...activeSurfaceOwnerRef.current,
      paneHeightStorageKey,
    };
  }, [activeSubPanes.length, paneDescriptors.length, paneHeightStorageKey, seriesReady]);

  const captureExpandedPaneHeights = useCallback(() => {
    const heights = readPaneHeights(chartRef.current);
    if (heights.length !== activePaneIds.length) return false;
    expandedPaneHeightsRef.current = new Map(
      activePaneIds.map((paneId, index) => [paneId, heights[index] || 0]),
    );
    return true;
  }, [activePaneIds]);

  const handleMovePane = useCallback((paneId: string, direction: "up" | "down") => {
    const incomingIds = ["main", ...subPanes.map((pane) => pane.id)];
    setPaneOrder((previous) => movePaneInOrder(
      reconcilePaneOrder(previous, incomingIds),
      paneId,
      direction,
    ));
  }, [subPanes]);

  const handleTogglePaneCollapse = useCallback((paneId: string) => {
    const alreadyCollapsed = collapsedPaneIds.includes(paneId);
    if (!alreadyCollapsed && activePaneIds.length - collapsedPaneIds.length <= 1) return;
    if (!paneLayoutControlledRef.current) captureExpandedPaneHeights();
    setMaximizedPaneId(null);
    setCollapsedPaneIds((previous) => alreadyCollapsed
      ? previous.filter((candidate) => candidate !== paneId)
      : [...previous, paneId]);
  }, [activePaneIds.length, captureExpandedPaneHeights, collapsedPaneIds]);

  const handleTogglePaneMaximize = useCallback((paneId: string) => {
    if (activePaneIds.length <= 1) return;
    if (maximizedPaneId !== paneId && !paneLayoutControlledRef.current) {
      captureExpandedPaneHeights();
    }
    setMaximizedPaneId((previous) => previous === paneId ? null : paneId);
  }, [activePaneIds.length, captureExpandedPaneHeights, maximizedPaneId]);

  const handleDeletePane = useCallback((pane: IndicatorSubPane) => {
    if (!pane.owner || !onRemoveSubPane) return;
    setPaneOrder((previous) => previous.filter((paneId) => paneId !== pane.id));
    setCollapsedPaneIds((previous) => previous.filter((paneId) => paneId !== pane.id));
    setMaximizedPaneId((previous) => previous === pane.id ? null : previous);
    onRemoveSubPane(pane);
  }, [onRemoveSubPane]);

  const publishHoveredPaneId = useCallback((paneId: string | null) => {
    if (hoveredPaneIdRef.current === paneId) return;
    hoveredPaneIdRef.current = paneId;
    setHoveredPaneId(paneId);
  }, []);

  const handleChartPanePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      publishHoveredPaneId(null);
      return;
    }
    const panes = chartRef.current?.panes?.() || [];
    const paneIds = activePaneIdsRef.current;
    if (panes.length !== paneIds.length) {
      publishHoveredPaneId(null);
      return;
    }
    let nextPaneId: string | null = null;
    for (const [index, pane] of panes.entries()) {
      const rect = pane.getHTMLElement?.()?.getBoundingClientRect?.() ?? null;
      if (!rect || event.clientY < rect.top || event.clientY > rect.bottom) continue;
      nextPaneId = paneIds[index] ?? null;
      break;
    }
    publishHoveredPaneId(nextPaneId);
  }, [publishHoveredPaneId]);

  const handleChartPanePointerLeave = useCallback(() => {
    publishHoveredPaneId(drawingPaneIdAfterPointerLeave(
      hoveredPaneIdRef.current,
      drawingEngineToolActive,
    ));
  }, [drawingEngineToolActive, publishHoveredPaneId]);

  useEffect(() => {
    const chart = chartRef.current;
    const panes = chart?.panes?.() || [];
    if (!chart
      || panes.length !== activePaneIds.length
      || paneDescriptors.length !== activePaneIds.length) {
      return;
    }
    const currentHeights = readPaneHeights(chart);
    if (currentHeights.length !== activePaneIds.length) return;
    const controlled = collapsedPaneIds.length > 0 || maximizedPaneId !== null;

    if (!controlled) {
      if (!paneLayoutControlledRef.current) return;
      const restoredHeights = activePaneIds.map((paneId, index) => (
        expandedPaneHeightsRef.current.get(paneId) ?? currentHeights[index] ?? 0
      ));
      setPaneHeights(chart, restoredHeights);
      paneLayoutControlledRef.current = false;
      notifyDrawingFrameInvalidation();
      return;
    }

    if (!paneLayoutControlledRef.current) captureExpandedPaneHeights();
    const heightPlan = buildPaneHeightPlan({
      paneIds: activePaneIds,
      currentHeights,
      expandedHeights: expandedPaneHeightsRef.current,
      collapsedPaneIds,
      maximizedPaneId,
    });
    if (!heightPlan) return;
    setPaneHeights(chart, heightPlan);
    paneLayoutControlledRef.current = true;
    notifyDrawingFrameInvalidation();
    recordPerfEvent("chart.paneControls.layout", {
      collapsedPaneIds,
      maximizedPaneId,
      paneIds: activePaneIds,
    });
  }, [
    activePaneIds,
    activePaneIdsKey,
    captureExpandedPaneHeights,
    chartAdapter,
    collapsedPaneIds,
    maximizedPaneId,
    notifyDrawingFrameInvalidation,
    paneDescriptors.length,
    seriesReady,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !indicatorDatasetOwned) return;
    const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
    const activePaneIds = new Set(paneDescriptors.map((pane) => pane.id));

    for (const pane of paneDescriptors) {
      const state = getPaneRenderState(paneRenderStateRef, pane.id);
      const paneApi = chart.panes?.()?.[pane.paneIndex] || null;
      const targetSeries = pane.id === "main"
        ? mainSeriesRef.current
        : indicatorSeriesRef.current.find((entry) => entry.paneId === pane.id)?.series;

      renderBgcolors({
        chart,
        pane: paneApi,
        indicatorBgcolors: pane.bgcolors,
        bgcolorPrimitiveRef: state.bgcolorPrimitiveRef,
        bgcolorStateRef: state.bgcolorStateRef,
        paneId: pane.id,
        recordPerfEvent,
        onError: (err) => console.warn("SingleChartPanes: failed to render bgcolors:", err),
      });
      renderMarkers({
        targetSeries,
        indicatorMarkers: pane.markers,
        markerTargetRef: state.markerTargetRef,
        markerStateRef: state.markerStateRef,
        paneId: pane.id,
        recordPerfEvent,
        onError: (err) => console.warn("SingleChartPanes: failed to set markers:", err),
      });
      renderHlines({
        series: targetSeries,
        indicatorHlines: pane.hlines,
        hlinesRef: state.hlinesRef,
        hlinesStateRef: state.hlinesStateRef,
        paneId: pane.id,
        recordPerfEvent,
        onError: (err) => console.warn("SingleChartPanes: failed to create hline:", err),
      });
      renderFillSeries({
        chart,
        fillPayload: buildFillRenderEntries(pane.fills, pane.lines, bgColor),
        fillSeriesRef: state.fillSeriesRef,
        fillSeriesStateRef: state.fillSeriesStateRef,
        paneId: pane.id,
        paneIndex: pane.paneIndex,
        definitionsCount: pane.fills?.length || 0,
        recordPerfEvent,
        onError: (err) => console.warn("SingleChartPanes: failed to create fill area:", err),
      });
    }

    for (const [paneId, state] of paneRenderStateRef.current) {
      if (activePaneIds.has(paneId)) continue;
      clearPaneAuxiliaryRenderState(chart, paneId, state);
      paneRenderStateRef.current.delete(paneId);
    }
  }, [customBg, indicatorDatasetOwned, paneDescriptors, seriesReady, theme]);

  useEffect(() => {
    const currentBase = drawingKeyBase || symbol;
    const currentPanes = new Map(
      subPanes.map((pane) => [pane.id, Boolean(pane.dataMarketPane)]),
    );
    const previous = prevSubPaneScopeRef.current;
    const removablePreviousIds = new Set<string>();
    for (const [paneId, preserveWhenHidden] of previous.panes) {
      // Market-data studies can disappear temporarily when hidden or when the
      // current product lacks the channel. Preserve their pane drawings so a
      // later supported/visible session can restore the user's work.
      if (!preserveWhenHidden) removablePreviousIds.add(paneId);
    }
    for (const scopeKey of removedDrawingSubPaneScopeKeys({
      currentBase,
      currentIds: new Set(currentPanes.keys()),
      previousBase: previous.base,
      previousIds: removablePreviousIds,
    })) {
      clearDrawingScopeAuthoritatively(scopeKey);
    }
    prevSubPaneScopeRef.current = { base: currentBase, panes: currentPanes };
  }, [drawingKeyBase, subPanes, symbol]);

  const drawingPaneSurfaces = useMemo((): DrawingPaneSurface[] => {
    const surfaces: DrawingPaneSurface[] = [];
    if (mainSeriesRef.current) {
      surfaces.push({
        paneId: "main",
        paneIndex: materializedMainPaneIndexRef.current,
        drawingKey,
        coordinateKey: drawingCoordinateKey,
        series: mainSeriesRef.current,
        seriesGeneration: drawingSeriesGeneration,
      });
    }
    for (const pane of paneDescriptors) {
      if (pane.id === "main") continue;
      const anchor = indicatorSeriesRef.current.find((entry) => entry.paneId === pane.id);
      if (!anchor) continue;
      surfaces.push({
        paneId: pane.id,
        paneIndex: pane.paneIndex,
        drawingKey: drawingPaneScopeKey(drawingScopeBase, pane.id),
        coordinateKey: `${drawingCoordinateKey}:${pane.id}`,
        series: anchor.series,
        seriesGeneration: seriesReady,
      });
    }
    return surfaces;
  }, [
    drawingCoordinateKey,
    drawingKey,
    drawingScopeBase,
    drawingSeriesGeneration,
    paneDescriptors,
    seriesReady,
  ]);
  const drawingPaneScopeSignature = drawingPaneSurfaces
    .map((surface) => `${surface.paneId}\u0000${surface.drawingKey}`)
    .join("\u0001");
  const drawingInteractionPaneId = resolveDrawingInteractionPaneId({
    drawingToolActive: drawingEngineToolActive,
    hoveredPaneId,
    paneIds: drawingPaneSurfaces.map((surface) => surface.paneId),
  });
  const drawingCursorOwnerPaneId = resolveDrawingInteractionPaneId({
    drawingToolActive: true,
    hoveredPaneId,
    paneIds: drawingPaneSurfaces.map((surface) => surface.paneId),
  });
  const drawingPaneAvailableMountKeys = useMemo(() => new Set(supportsDrawingFeatures
    ? drawingPaneSurfaces.map((surface) => surface.drawingKey)
    : []), [drawingPaneSurfaces, supportsDrawingFeatures]);
  const drawingPaneAdmittedMountKeys = new Set(drawingPaneSurfaces
    .filter((surface) => supportsDrawingFeatures && (
      shouldLoadDrawingEngine({
        activeTool: surface.paneId === drawingInteractionPaneId
          ? effectiveDrawingTool
          : null,
        drawingKey: surface.drawingKey,
      })
      || probedDrawingPresence.get(surface.drawingKey)?.present === true
    ))
    .map((surface) => surface.drawingKey));
  const drawingPaneMountKeys = reconcileDrawingPaneHostMountKeys({
    admittedKeys: drawingPaneAdmittedMountKeys,
    availableKeys: drawingPaneAvailableMountKeys,
    retainedKeys: retainedDrawingPaneMountKeys,
  });
  const shouldMountDrawingEngine = drawingPaneMountKeys.size > 0;
  const drawingAnchorReady = drawingPaneSurfaces.length > 0;

  useEffect(() => {
    setRetainedDrawingPaneMountKeys((previous) => reconcileDrawingPaneHostMountKeys({
      admittedKeys: new Set(),
      availableKeys: drawingPaneAvailableMountKeys,
      retainedKeys: previous,
    }));
  }, [drawingPaneAvailableMountKeys]);

  useEffect(() => {
    if (!supportsDrawingFeatures || !drawingPaneScopeSignature) return undefined;
    // An active tool already mounts the engine, whose repository restore is
    // authoritative for every drawable pane. Avoid decoding missing manifests
    // in parallel with those document restores.
    if (drawingEngineToolActive) return undefined;
    let active = true;
    const scopes = drawingPaneSurfaces.map(({ drawingKey: scopeKey }) => scopeKey);
    void Promise.all(scopes.map(async (scopeKey) => {
      if (shouldLoadDrawingEngine({ activeTool: null, drawingKey: scopeKey })) {
        const result: DrawingPresenceState = Object.freeze({ error: null, present: true });
        return [scopeKey, result] as const;
      }
      try {
        const present = await probeDrawingEnginePresence(scopeKey);
        const result: DrawingPresenceState = Object.freeze({ error: null, present });
        return [scopeKey, result] as const;
      } catch (error) {
        const failure = error instanceof Error
          ? error
          : new Error("Drawing presence probe failed", { cause: error });
        const result: DrawingPresenceState = Object.freeze({ error: failure, present: false });
        return [scopeKey, result] as const;
      }
    })).then((entries) => {
      if (!active) return;
      const next = new Map(entries);
      setProbedDrawingPresence(next);
      for (const [scopeKey, result] of entries) {
        if (result.error) {
          console.warn(`SingleChartPanes: drawing presence probe failed closed for ${scopeKey}`, result.error);
        }
      }
    });
    return () => { active = false; };
  }, [drawingEngineToolActive, drawingPaneScopeSignature, drawingPaneSurfaces, supportsDrawingFeatures]);

  useEffect(() => {
    if (!supportsDrawingFeatures
      || DrawingEngineHost
      || !drawingAnchorReady) return undefined;
    if (!shouldMountDrawingEngine && !drawingEngineToolActive) return undefined;
    let cancelled = false;
    preloadDrawingEngineHost();
    void loadDrawingEngineHost().then((module) => {
      if (!cancelled) {
        setDrawingEngineLoadError(null);
        setDrawingEngineHost(() => module.default);
      }
    }).catch((error) => {
      if (!cancelled) {
        setDrawingEngineLoadError(error instanceof Error
          ? error
          : new Error("Drawing engine module failed to load", { cause: error }));
      }
    });
    return () => { cancelled = true; };
  }, [
    DrawingEngineHost,
    drawingAnchorReady,
    drawingEngineToolActive,
    effectiveDrawingTool,
    shouldMountDrawingEngine,
    supportsDrawingFeatures,
  ]);

  const clearAllDrawings = useCallback(() => {
    for (const surface of drawingPaneSurfaces) {
      const api = drawingApisByPaneRef.current.get(surface.paneId);
      if (api) api.clearAll();
      else clearDrawingScopeAuthoritatively(surface.drawingKey);
    }
    selectedDrawingPaneIdRef.current = null;
    selectedDrawingsByPaneRef.current.clear();
    onSelectedDrawingChange?.(null);
  }, [drawingPaneSurfaces, onSelectedDrawingChange]);
  const setDrawingsHidden = useCallback((hidden: boolean) => {
    drawingsHiddenRef.current = !!hidden;
    for (const api of drawingApisByPaneRef.current.values()) api.setHidden(hidden);
  }, []);
  const updateSelectedDrawingStyle = useCallback((patch: DrawingStylePatch) => {
    const paneId = selectedDrawingPaneIdRef.current;
    const api = paneId ? drawingApisByPaneRef.current.get(paneId) : null;
    (api ?? drawingApiRef.current)?.updateSelectedDrawingStyle(patch);
  }, []);
  const prepareDrawingExport = useCallback(async (
    options?: DrawingExportPrepareOptions,
  ): Promise<DrawingExportLease | null> => {
    const leases: DrawingExportLease[] = [];
    try {
      for (const surface of drawingPaneSurfaces) {
        const lease = await prepareDrawingExportFailClosed({
          drawingKey: surface.drawingKey,
          drawingToolActive: drawingEngineToolActive,
          engineLoadError: drawingEngineLoadError,
          getApi: () => drawingApisByPaneRef.current.get(surface.paneId) ?? null,
          hasPresenceHint: () => shouldLoadDrawingEngine({
            activeTool: null,
            drawingKey: surface.drawingKey,
          }),
          probePresence: () => probeDrawingEnginePresence(surface.drawingKey),
          supportsDrawingFeatures,
        }, options);
        if (lease) leases.push(lease);
      }
      return composeDrawingPaneExportLeases(leases);
    } catch (error) {
      const restored = await Promise.allSettled(leases.map((lease) => lease.restore()));
      const restoreFailures: unknown[] = [];
      for (const result of restored) {
        if (result.status === "rejected") restoreFailures.push(result.reason as unknown);
      }
      if (restoreFailures.length > 0) {
        throw new AggregateError(
          [error, ...restoreFailures],
          "Drawing pane export preparation failed and could not fully restore",
        );
      }
      throw error;
    }
  }, [
    drawingEngineLoadError,
    drawingEngineToolActive,
    drawingPaneSurfaces,
    supportsDrawingFeatures,
  ]);
  const handleDrawingApiChange = useCallback((
    paneId: string,
    paneDrawingKey: string,
    api: DrawingEngineApi | null,
  ) => {
    if (api) {
      drawingApisByPaneRef.current.set(paneId, api);
      api.setHidden(drawingsHiddenRef.current);
      setRetainedDrawingPaneMountKeys((previous) => {
        if (previous.has(paneDrawingKey)) return previous;
        const next = new Set(previous);
        next.add(paneDrawingKey);
        return next;
      });
    } else {
      drawingApisByPaneRef.current.delete(paneId);
    }
    if (paneId === "main") drawingApiRef.current = api;
  }, []);
  const handleDrawingAdapterChange = useCallback((
    paneId: string,
    adapter: ReturnType<typeof createLightweightChartAdapter> | null,
  ) => {
    if (adapter) drawingAdaptersByPaneRef.current.set(paneId, adapter);
    else drawingAdaptersByPaneRef.current.delete(paneId);
  }, []);
  const handleSelectedDrawingChange = useCallback((
    paneId: string,
    drawing: SelectedDrawingMeta | null,
  ) => {
    if (drawing) {
      selectedDrawingsByPaneRef.current.set(paneId, drawing);
      selectedDrawingPaneIdRef.current = paneId;
      onSelectedDrawingChange?.(drawing);
      return;
    }
    selectedDrawingsByPaneRef.current.delete(paneId);
    if (selectedDrawingPaneIdRef.current !== paneId) return;
    const fallback = [...selectedDrawingsByPaneRef.current.entries()].at(-1) ?? null;
    selectedDrawingPaneIdRef.current = fallback?.[0] ?? null;
    onSelectedDrawingChange?.(fallback?.[1] ?? null);
  }, [onSelectedDrawingChange]);

  useImperativeHandle(ref, () => ({
    getVisibleRange: captureVisibleRange,
    clearAllDrawings,
    setDrawingsHidden,
    updateSelectedDrawingStyle,
    resetAutoScale,
    prepareExport: prepareDrawingExport,
    getExportSnapshot: () => {
      const rootElement = wrapperRef.current;
      const rootRect = rootElement?.getBoundingClientRect?.() || null;
      const chart = chartRef.current;
      const panes = chart?.panes?.() || [];
      const mainPaneIndex = resolveMainPaneIndex(
        chart,
        mainSeriesRef.current,
        materializedMainPaneIndexRef.current,
      );
      materializedMainPaneIndexRef.current = mainPaneIndex;
      const mainPaneHeight = panes[mainPaneIndex]?.getHeight?.();
      const containerRect = containerRef.current?.getBoundingClientRect?.() || null;
      const mainPlotRect = chartAdapter.getMainPanePlotRect?.() ?? null;
      const fallbackPaneY = panes
        .slice(0, mainPaneIndex)
        .reduce((total, pane) => total + (pane.getHeight?.() || 0), 0);
      const mainPaneY = rootRect && containerRect && mainPlotRect
        ? containerRect.top - rootRect.top + mainPlotRect.y
        : fallbackPaneY;
      const captureRect = panes.length > 1
        && rootRect
        && typeof mainPaneHeight === "number"
        && Number.isFinite(mainPaneHeight)
        && mainPaneHeight > 0
        && Number.isFinite(mainPaneY)
        && mainPaneY >= 0
        ? {
            x: 0,
            y: mainPaneY,
            width: rootRect.width,
            height: Math.min(rootRect.height - mainPaneY, mainPaneHeight),
          }
        : null;
      return {
        rootElement,
        mainPane: {
          paneId: "main",
          paneType: "main",
          rootElement,
          chartElement: containerRef.current,
          rect: rootRect,
          captureRect,
        },
        subPanes: paneDescriptors.filter((pane) => pane.id !== "main").map((pane) => ({ id: pane.id, paneType: "sub" })),
        visibleRange: captureVisibleRange(),
        loading,
      };
    },
    seriesReady,
  }), [
    captureVisibleRange,
    chartAdapter,
    clearAllDrawings,
    loading,
    paneDescriptors,
    prepareDrawingExport,
    resetAutoScale,
    seriesReady,
    setDrawingsHidden,
    updateSelectedDrawingStyle,
  ]);

  return (
    <div
      className="chart-area multi-pane-chart"
      ref={wrapperRef}
      onPointerMove={handleChartPanePointerMove}
      onPointerLeave={handleChartPanePointerLeave}
    >
      <div
        ref={containerRef}
        className="chart-pane"
        data-chart-type={resolvedChartType}
        data-pane-id="single-chart"
        data-pane-type="native-panes"
        onContextMenu={handlePriceScaleContextMenu}
        style={{ cursor: cursorStyleForDrawingTool(effectiveDrawingTool) }}
      />

      {activeSubPanes.filter((pane) => !pane.dataMarketPane).map((pane) => (
        <div
          key={`label-${pane.id}`}
          className="chart-pane-label indicator-pane-label pane-overlay-anchor"
          data-pane-id={pane.id}
          data-pane-collapsed={collapsedPaneIds.includes(pane.id) ? "true" : "false"}
        >
          {pane.label}
        </div>
      ))}

      {paneLabelDescriptors.map((descriptor) => {
        const pane = activeSubPanes.find((candidate) => candidate.id === descriptor.id);
        const exactPoint = paneCrosshairTime === null
          ? null
          : pane?.pointMetadata?.find((point) => point.time === paneCrosshairTime) ?? null;
        const displayPoint = exactPoint ?? (
          paneCrosshairTime === null || pane?.pointMetadataFallback !== "none"
            ? pane?.pointMetadata?.at(-1) ?? null
            : null
        );
        const auxiliaryText = displayPoint
          ? null
          : paneCrosshairTime !== null
            ? pane?.missingPointText ?? pane?.statusText ?? null
            : pane?.statusText ?? null;
        return (
          <div
            key={descriptor.id}
            className="chart-pane-label advanced-market-pane-label pane-overlay-anchor"
            data-market-pane={descriptor.marketPane}
            data-pane-id={descriptor.id}
            data-pane-collapsed={collapsedPaneIds.includes(descriptor.id) ? "true" : "false"}
            role="group"
            aria-label={displayPoint?.accessibilityLabel ?? auxiliaryText ?? descriptor.label}
          >
            <span className="advanced-market-pane-heading">{descriptor.label}</span>
            {displayPoint && (
              <span
                className="advanced-market-pane-value"
                data-appearance={displayPoint.appearance}
              >
                <span>{displayPoint.valueLabel}</span>
                <span className="advanced-market-pane-source">
                  {`${displayPoint.sourceLabel} · ${displayPoint.qualityLabel}`}
                </span>
              </span>
            )}
            {auxiliaryText && (
              <span className="advanced-market-pane-status">{auxiliaryText}</span>
            )}
            {pane?.legendItems && pane.legendItems.length > 0 && (
              <span className="advanced-market-pane-legend" aria-hidden="true">
                {pane.legendItems.map((item) => (
                  <span key={item.id} className="advanced-market-pane-legend-item" title={item.description}>
                    <span
                      className="advanced-market-pane-legend-swatch"
                      data-appearance={item.appearance}
                      style={item.color ? { background: item.color } : undefined}
                    />
                    <span>{item.label}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
        );
      })}

      {activePaneIds.map((paneId) => {
        const pane = paneId === "main"
          ? null
          : activeSubPanes.find((candidate) => candidate.id === paneId) || null;
        const panePosition = activePaneIds.indexOf(paneId);
        const collapsed = collapsedPaneIds.includes(paneId);
        return (
          <PaneControlBar
            key={`controls-${paneId}`}
            paneId={paneId}
            paneLabel={pane?.label || `${symbol} 主图`}
            canMoveUp={panePosition > 0}
            canMoveDown={panePosition >= 0 && panePosition < activePaneIds.length - 1}
            canCollapse={collapsed || activePaneIds.length - collapsedPaneIds.length > 1}
            canMaximize={activePaneIds.length > 1}
            canDelete={Boolean(pane?.owner && onRemoveSubPane)}
            collapsed={collapsed}
            hovered={hoveredPaneId === paneId}
            maximized={maximizedPaneId === paneId}
            onMove={(direction) => handleMovePane(paneId, direction)}
            onToggleCollapse={() => handleTogglePaneCollapse(paneId)}
            onToggleMaximize={() => handleTogglePaneMaximize(paneId)}
            onDelete={() => { if (pane) handleDeletePane(pane); }}
          />
        );
      })}

      {cursorOverlayClass && (
        <div className="chart-pane-cursor-overlay" aria-hidden="true">
          <div
            ref={cursorOverlayRef}
            className={`chart-pane-cursor ${cursorOverlayClass}`}
          />
        </div>
      )}

      {usesDerivedAxis && (
        <div className="synthetic-chart-notice" role="status">
          <strong>{syntheticChartNotice.title}</strong>
          <span>
            {`${syntheticChartNotice.detail} · 指标按原始 K 线映射 · 成交量仅落末个合成点 · 绘图支持绝对时间未来锚点（含自由笔与荧光笔）`}
          </span>
        </div>
      )}

      {contextMenu && (
        <div
          className="price-scale-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`price-scale-menu-item${isAutoScale ? " active" : ""}`}
             onClick={() => {
               const next = !isAutoScale;
               try {
                 const chart = chartRef.current;
                 const mainPaneIndex = resolveMainPaneIndex(
                   chart,
                   mainSeriesRef.current,
                   materializedMainPaneIndexRef.current,
                 );
                 materializedMainPaneIndexRef.current = mainPaneIndex;
                 chart?.priceScale("right", mainPaneIndex).applyOptions({ autoScale: next });
                 notifyDrawingFrameInvalidation();
              } catch { /* */ }
              setIsAutoScale(next);
              setContextMenu(null);
            }}
          >
            <span className="price-scale-menu-check">{isAutoScale ? "✓" : ""}</span>
            <span>自动缩放</span>
            <span className="price-scale-menu-label-en">Auto Scale</span>
          </button>
          {onInvertScaleChange && (
            <button
              type="button"
              className={`price-scale-menu-item${invertScale ? " active" : ""}`}
              onClick={() => {
                onInvertScaleChange(!invertScale);
                setContextMenu(null);
              }}
            >
              <span className="price-scale-menu-check">{invertScale ? "✓" : ""}</span>
              <span>反转坐标轴</span>
              <span className="price-scale-menu-label-en">Invert Scale</span>
            </button>
          )}
          <div className="price-scale-menu-divider" />
          {PRICE_SCALE_MODES.map((mode) => (
            <button
              type="button"
              key={mode.value}
              className={`price-scale-menu-item${priceScaleMode === mode.value ? " active" : ""}`}
              onClick={() => {
                onPriceScaleModeChange?.(mode.value);
                setContextMenu(null);
              }}
            >
              <span className="price-scale-menu-check">{priceScaleMode === mode.value ? "✓" : ""}</span>
              <span>{mode.label}</span>
              <span className="price-scale-menu-label-en">{mode.labelEn}</span>
            </button>
          ))}
        </div>
      )}

      {DrawingEngineHost && shouldMountDrawingEngine && drawingPaneSurfaces
        .filter((surface) => drawingPaneMountKeys.has(surface.drawingKey))
        .map((surface) => (
          <NativePaneDrawingHost
            key={surface.drawingKey}
            component={DrawingEngineHost}
            {...(surface.paneId === "main" ? { chartAdapter } : {})}
            paneId={surface.paneId}
            paneIndex={surface.paneIndex}
            series={surface.series}
            chartRef={chartRef}
            chartContainerRef={containerRef}
            seriesDataRef={displayRowsRef}
            sourceTimeHorizonRef={drawingSourceTimeHorizonRef}
            sourceIntervalRef={drawingSourceIntervalRef}
            sourceIntervalSecondsRef={drawingSourceIntervalSecondsRef}
            projectionConfigRef={drawingProjectionConfigRef}
            frameInvalidationRevision={
              drawingFontMetricRevision + drawingSeriesGeneration + seriesReady
            }
            captureDrawingFrame={capturePaneDrawingFrame}
            hostProps={{
              activeTool: drawingToolForPane(
                effectiveDrawingTool,
                drawingInteractionPaneId,
                surface.paneId,
              ),
              manageChartCursor: surface.paneId === drawingCursorOwnerPaneId,
              ...(onDrawingToolChange === undefined ? {} : { onToolChange: onDrawingToolChange }),
              penColor,
              penSize,
              textFontSize,
              textBold,
              textItalic,
              fibLevels,
              fibInverted,
              positionSize,
              drawingSnapEnabled,
              drawingKey: surface.drawingKey,
              drawingSeriesGeneration: surface.seriesGeneration,
              drawingChartType: resolvedChartType,
              drawingInterval: interval,
              drawingCoordinateKey: surface.coordinateKey,
              drawingAnchorMode,
              initialHidden: drawingsHiddenRef.current,
            }}
            onPaneApiChange={handleDrawingApiChange}
            onPaneAdapterChange={handleDrawingAdapterChange}
            onPaneSelectedDrawingChange={handleSelectedDrawingChange}
          />
        ))}

      {loading && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <span className="loading-text">Loading {symbol} {interval} klines...</span>
        </div>
      )}
    </div>
  );
});

export default memo(SingleChartPanes);
