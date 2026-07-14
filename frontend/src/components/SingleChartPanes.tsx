/**
 * SingleChartPanes — lightweight-charts v5 native panes path.
 *
 * Uses one chart instance for the selected main price series and all indicator panes so every
 * series shares the same time scale.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type {
  ComponentType,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
} from "react";
import { createLightweightChartAdapter } from "../chart-adapter/chartInstanceBridge";
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
import { planVisibleRangeRestore } from "../features/chart-session/visibleRangeStorage";
import { buildPaneConfigKey, loadPaneHeights, savePaneHeights } from "../features/chart-session/paneLayoutStorage";
import {
  buildVisibleRangeSnapshot,
  disposeChartPaneSurface,
  hasCurrentDatasetOwnership,
  resolveIntervalTransitionReplayData,
  resolveDataTimeSet,
  shouldAdvanceDrawingCoordinateGeneration,
  shouldAdvanceIndicatorSeriesReady,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport,
} from "./singleChartPaneLifecycle";
import {
  DRAWING_ENGINE_TOOL_IDS,
  loadDrawingEngineHost,
  preloadDrawingEngineHost,
  shouldLoadDrawingEngine,
} from "../features/drawings/drawingEngineLoader";
import {
  drawingToolForAnchorMode,
  supportsDrawingAnchorMode,
} from "../features/drawings/drawingCapabilities";
import {
  cursorOverlayClassForTool,
  cursorStyleForDrawingTool,
  shouldShowCrosshairDetails,
} from "../features/drawings/drawingModel";
import { clearSavedDrawings } from "../features/drawings/drawingPersistence";
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
import type { DrawingStylePatch } from "../features/drawings/drawingInteractionController.js";
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

interface PaneLabelPosition {
  id: string;
  label: string;
  marketPane: "funding-rate" | "open-interest";
  top: number;
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

interface ProjectionSnapshotOwner {
  drawingProjectionConfig: string | null;
  sourceInterval: IntervalString;
  sourceIntervalSeconds: number | null;
  store: ProjectionStoreWithConfiguration | null;
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
  return [mainHeight, ...Array.from({ length: subPaneCount }, () => subHeight)];
}

function preparePaneLayout(chart: AdapterChart | null, {
  storageKey,
  subPaneCount,
  totalHeight,
}: {
  storageKey?: string | null;
  subPaneCount?: number;
  totalHeight?: number;
} = {}): boolean {
  const resolvedSubPaneCount = subPaneCount ?? -1;
  const resolvedTotalHeight = totalHeight ?? 0;
  if (!chart || !Number.isInteger(resolvedSubPaneCount) || resolvedSubPaneCount < 0) return false;
  for (let paneIndex = 1; paneIndex <= resolvedSubPaneCount; paneIndex += 1) {
    ensurePane(chart, paneIndex);
  }
  const paneHeights = resolvePaneHeightLayout(storageKey, resolvedSubPaneCount, resolvedTotalHeight);
  if (!paneHeights) return resolvedSubPaneCount === 0;
  setPaneHeights(chart, paneHeights);
  return true;
}

function ensurePanePlaceholderSeries(
  chart: AdapterChart | null,
  placeholderStateRef: MutableRefObject<PanePlaceholderState>,
  subPaneCount: number,
  anchorTime: AxisTime | null = null,
): void {
  if (!chart || !placeholderStateRef || !Number.isInteger(subPaneCount) || subPaneCount < 0) return;
  if (placeholderStateRef.current.chart !== chart) {
    placeholderStateRef.current = { chart, seriesByPane: new Map() };
  }
  const seriesByPane = placeholderStateRef.current.seriesByPane;
  const baseAnchorKey = axisTimeKey(anchorTime);
  const anchorKey = baseAnchorKey && anchorTime && typeof anchorTime === "object"
    ? `${baseAnchorKey}:source:${anchorTime.sourceTime}:ordinal:${anchorTime.sourceOrdinal}`
    : baseAnchorKey;
  for (let paneIndex = 1; paneIndex <= subPaneCount; paneIndex += 1) {
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
  subPanes,
  indicatorMarkers,
  indicatorFills,
  indicatorHlines,
  indicatorBgcolors,
}: {
  dataTimeSet: ReadonlySet<number>;
  mainOverlayLines: IndicatorLine[];
  subPanes: IndicatorSubPane[];
  indicatorMarkers: IndicatorMarker[];
  indicatorFills: IndicatorFill[];
  indicatorHlines: IndicatorHLine[];
  indicatorBgcolors: IndicatorBgColor[];
}): PaneDescriptor[] {
  const mainLines = alignIndicatorLinesToTimes(mainOverlayLines, dataTimeSet);
  const descriptors = [{
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

  return descriptors;
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
  invertScale = false,
  onInvertScaleChange,
  priceScaleMode = 0,
  onPriceScaleModeChange,
}: SingleChartPanesProps, ref) {
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
    drawingProjectionConfig: null,
    sourceInterval: interval,
    sourceIntervalSeconds: parseIntervalSeconds(interval),
    store: null,
  });
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
  const paneHeightStorageKeyRef = useRef<string | null>(null);
  const prevSubPaneIdsRef = useRef<Set<string>>(new Set());
  const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
  const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
  const datasetKeyRef = useRef(datasetKey);
  const surfaceConfigKeyRef = useRef<string | null>(null);
  const drawingProjectionConfigRef = useRef<string | null>(null);
  const onViewportRangeChangeRef = useRef(onViewportRangeChange);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const drawingApiRef = useRef<DrawingEngineApi | null>(null);
  const drawingsHiddenRef = useRef(false);
  const [seriesReady, setSeriesReady] = useState(0);
  const [drawingSeriesGeneration, setDrawingSeriesGeneration] = useState(0);
  const [drawingCoordinateGeneration, setDrawingCoordinateGeneration] = useState(0);
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
    drawingProjectionSnapshotOwnerRef.current = {
      drawingProjectionConfig,
      sourceInterval,
      sourceIntervalSeconds,
      store,
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
  const [isAutoScale, setIsAutoScale] = useState(true);
  const [contextMenu, setContextMenu] = useState<PriceScaleContextMenuPosition | null>(null);
  const [paneLabelPositions, setPaneLabelPositions] = useState<PaneLabelPosition[]>([]);

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
  const drawingKey = `${drawingKeyBase || symbol}__main`;
  const chartAdapter = useMemo(
    () => createLightweightChartAdapter({
      chartRef,
      seriesRef: mainSeriesRef,
      seriesDataRef: displayRowsRef,
      seriesDataMapRef: displayRowMapRef,
      seriesDataIndexRef: displayRowIndexMapRef,
      sourceTimeHorizonRef: drawingSourceTimeHorizonRef,
      sourceIntervalRef: drawingSourceIntervalRef,
      sourceIntervalSecondsRef: drawingSourceIntervalSecondsRef,
      projectionConfigRef: drawingProjectionConfigRef,
      drawingCoordinateSnapshotProvider: () => {
        const owner = drawingProjectionSnapshotOwnerRef.current;
        const snapshot = owner.store?.drawingCoordinateSnapshot?.() || null;
        return snapshot ? {
          ...snapshot,
          drawingProjectionConfig: owner.drawingProjectionConfig,
          sourceInterval: owner.sourceInterval,
          sourceIntervalSeconds: owner.sourceIntervalSeconds,
        } : null;
      },
    }),
    [],
  );

  useEffect(() => {
    onCrosshairMove?.(null);
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
  const sourcePaneDescriptors = useMemo(() => buildPaneDescriptors({
    dataTimeSet,
    mainOverlayLines,
    subPanes,
    indicatorMarkers,
    indicatorFills,
    indicatorHlines,
    indicatorBgcolors,
  }), [
    dataTimeSet,
    mainOverlayLines,
    subPanes,
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
  const activeSubPanes = subPanes;
  activeSubPaneCountRef.current = activeSubPanes.length;
  const subPaneIdsKey = useMemo(
    () => activeSubPanes.map((pane) => pane.id).join(","),
    [activeSubPanes],
  );
  const paneHeightStorageKey = useMemo(
    () => `${SINGLE_PANE_HEIGHT_KEY_PREFIX}${buildPaneConfigKey(activeSubPanes.map((pane) => pane.id))}`,
    [activeSubPanes],
  );
  paneHeightStorageKeyRef.current = paneHeightStorageKey;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const chart = chartRef.current;
    if (!wrapper || !chart) {
      setPaneLabelPositions([]);
      return undefined;
    }

    const syncLabels = () => {
      const heights = readPaneHeights(chart);
      if (heights.length !== activeSubPanes.length + 1) return;
      let paneTop = heights[0] || 0;
      const next: PaneLabelPosition[] = [];
      for (const [index, pane] of activeSubPanes.entries()) {
        if (pane.dataMarketPane) {
          next.push({
            id: pane.id,
            label: pane.label,
            marketPane: pane.dataMarketPane,
            top: paneTop + 6,
          });
        }
        paneTop += heights[index + 1] || 0;
      }
      setPaneLabelPositions((previous) => (
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      ));
    };

    const frame = requestAnimationFrame(syncLabels);
    wrapper.addEventListener("pointerup", syncLabels);
    window.addEventListener("resize", syncLabels);
    return () => {
      cancelAnimationFrame(frame);
      wrapper.removeEventListener("pointerup", syncLabels);
      window.removeEventListener("resize", syncLabels);
    };
  }, [activeSubPanes, paneHeightStorageKey, seriesReady]);

  const saveCurrentPaneHeights = useCallback((
    chart = chartRef.current,
    storageKey = paneHeightStorageKeyRef.current,
  ) => {
    const heights = readPaneHeights(chart);
    if (!storageKey || heights.length <= 1) return false;
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
    preparePaneLayout(chart, {
      storageKey: initialPaneHeightStorageKey,
      subPaneCount: initialSubPaneCount,
      totalHeight,
    });
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
    if (initialSubPaneCount > 0) materializePaneLayout(chart, container);
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
      if (isSyncingRef.current || !onCrosshairMove) return;
      if (param.time == null) {
        onCrosshairMove(null);
        return;
      }
      const axisTime = typeof param.time === "number" || isOrdinalAxisTime(param.time)
        ? param.time
        : null;
      if (axisTime == null) {
        onCrosshairMove(null);
        return;
      }
      const displayRow = displayRowMapRef.current.get(axisTime);
      const displayIndex = displayRowIndexMapRef.current.get(axisTime);
      const sourceTime = resolveSourceTime(axisTime, displayRow);
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
      futureTimeAxisSeriesRef.current = null;
      futureTimeAxisDataRef.current = [];
      futureTimeAxisPlanKeyRef.current = null;
      if (futureTimeAxisCoverageFrameRef.current != null) {
        cancelAnimationFrame(futureTimeAxisCoverageFrameRef.current);
        futureTimeAxisCoverageFrameRef.current = null;
      }
      futureTimeAxisCoveragePendingRef.current = false;
      isChartPointerActiveRef.current = false;
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
      disposeChartPaneSurface(chart, {
        // Drawing primitives keep a requestUpdate callback supplied by their
        // owning series. Detach them before remove() so a later re-attach
        // cannot enqueue work on this disposed surface.
        beforeRemove: () => drawingApiRef.current?.prepareSurfaceDispose?.(),
      });
    };
  }, [captureVisibleRange, customBg, downColor, onCrosshairMove, publishDrawingProjectionStore, publishViewportRangeChange, saveCurrentPaneHeights, scheduleFutureTimeAxisCoverage, scheduleVisibleRangeSave, surfaceConfigKey, theme, timezone, upColor]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const markUserInteracted = () => {
      userInteractedRef.current = true;
      viewportControllerRef.current?.markUserInteracting();
    };
    const markPointerActive = () => {
      isChartPointerActiveRef.current = true;
      markUserInteracted();
    };
    const saveNativePaneHeights = () => {
      if (activeSubPanes.length > 0) saveCurrentPaneHeights();
    };
    const releasePointer = () => {
      if (!isChartPointerActiveRef.current) return;
      isChartPointerActiveRef.current = false;
      saveNativePaneHeights();
      if (futureTimeAxisCoveragePendingRef.current) scheduleFutureTimeAxisCoverage();
    };
    wrapper.addEventListener("wheel", markUserInteracted, { passive: true });
    wrapper.addEventListener("mousedown", markPointerActive);
    wrapper.addEventListener("touchstart", markPointerActive, { passive: true });
    window.addEventListener("mouseup", releasePointer);
    window.addEventListener("touchend", releasePointer, { passive: true });
    window.addEventListener("touchcancel", releasePointer, { passive: true });
    window.addEventListener("blur", releasePointer);
    return () => {
      wrapper.removeEventListener("wheel", markUserInteracted);
      wrapper.removeEventListener("mousedown", markPointerActive);
      wrapper.removeEventListener("touchstart", markPointerActive);
      window.removeEventListener("mouseup", releasePointer);
      window.removeEventListener("touchend", releasePointer);
      window.removeEventListener("touchcancel", releasePointer);
      window.removeEventListener("blur", releasePointer);
      isChartPointerActiveRef.current = false;
    };
  }, [activeSubPanes.length, saveCurrentPaneHeights, scheduleFutureTimeAxisCoverage]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const applyAppearance = () => {
      applyChartPaneAppearance(chart, { theme, customBg, timezone, interval });
      chart.applyOptions({ layout: buildPaneLayoutOptions() });
      appliedAppearanceIntervalRef.current = interval;
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
  }, [customBg, interval, theme, timezone]);

  useEffect(() => {
    const activeType = mainSeriesTypeRef.current || resolvedChartType;
    mainSeriesRef.current?.applyOptions({
      ...buildMainSeriesStyleOptions(activeType, { upColor, downColor }),
      crosshairMarkerVisible: showCrosshairDetails && !drawingEngineToolActive,
    });
  }, [downColor, drawingEngineToolActive, resolvedChartType, seriesReady, showCrosshairDetails, upColor]);

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
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
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
  }, [cursorOverlayClass]);

  useEffect(() => {
    const chart = chartRef.current;
    const previousSeries = mainSeriesRef.current;
    if (!chart
      || !previousSeries
      || !mainSeriesTypeRef.current
      || mainSeriesTypeRef.current === resolvedChartType) return;

    const rows = rowsFromStore(seriesStore);
    const visibleRange = captureVisibleRange();
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
      const result = replaceMainSeries(chart, previousSeries, {
        chartType: resolvedChartType,
        data: rows,
        downColor,
        indicatorBarColorMap,
        paneIndex: 0,
        previousSeriesData: renderedMainSeriesDataRef.current,
        seriesData: nextSeriesData,
        upColor,
      });

      mainSeriesRef.current = result.series;
      mainSeriesTypeRef.current = result.chartType;
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
      setDrawingSeriesGeneration((prev) => prev + 1);
    } catch (error) {
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
    projectionSettings,
    publishDrawingProjectionStore,
    resolvedChartType,
    seriesStore,
    upColor,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("right", 0).applyOptions({
      invertScale: !!invertScale,
      mode: priceScaleMode ?? 0,
    });
  }, [invertScale, priceScaleMode, seriesReady]);

  const resetAutoScale = useCallback(() => {
    try {
      chartRef.current?.priceScale("right", 0).applyOptions({ autoScale: true });
      setIsAutoScale(true);
    } catch { /* */ }
  }, []);

  const handlePriceScaleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect?.();
    if (!rect) return;
    if (event.clientX < rect.right - PRICE_SCALE_CONTEXT_HIT_WIDTH) return;
    event.preventDefault();
    event.stopPropagation();
    const margin = PRICE_SCALE_CONTEXT_MENU_MARGIN;
    const maxX = Math.max(rect.left + margin, rect.right - PRICE_SCALE_CONTEXT_MENU_WIDTH - margin);
    const maxY = Math.max(rect.top + margin, rect.bottom - PRICE_SCALE_CONTEXT_MENU_HEIGHT - margin);
    setContextMenu({
      x: Math.min(Math.max(event.clientX, rect.left + margin), maxX),
      y: Math.min(Math.max(event.clientY, rect.top + margin), maxY),
    });
  }, []);

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
    ensurePanePlaceholderSeries(chart, panePlaceholderSeriesRef, subPaneCount);
    preparePaneLayout(chart, {
      storageKey: paneHeightStorageKeyRef.current,
      subPaneCount,
      totalHeight,
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
    publishDrawingProjectionStore(projectionStore);
    if (shouldAdvanceDrawingCoordinateGeneration({
      axisMode: getChartTypeDescriptor(activeChartType).axisMode,
      canReuseProjection,
    })) {
      // Resolved ATR/minTick values can change while the requested settings
      // key stays the same. Cancel transient drawing state across that
      // structural coordinate reprojection even though the series survives.
      setDrawingCoordinateGeneration((previous) => previous + 1);
    }

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
        if (sourceTimeHorizonChanged
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

    ensurePanePlaceholderSeries(
      chart,
      panePlaceholderSeriesRef,
      expectedPaneCount - 1,
      displayRowsRef.current.at(-1)?.time ?? null,
    );

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
    const removedSeriesCount = removeSeriesEntries(chart, staleEntries);
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
  }, [datasetKey, drawingEngineToolActive, indicatorDatasetOwned, interval, materializeRuntimePaneLayout, paneDescriptors, renderDataTimeSet, seriesReady, showCrosshairDetails, usesDerivedAxis]);

  useEffect(() => {
    const chart = chartRef.current;
    const wrapper = wrapperRef.current;
    if (!chart || !wrapper || activeSubPanes.length === 0) return;
    const expectedPaneCount = activeSubPanes.length + 1;
    if (paneDescriptors.length !== expectedPaneCount
      || chart.panes?.()?.length !== expectedPaneCount) {
      return;
    }

    const totalHeight = wrapper.getBoundingClientRect?.().height || wrapper.clientHeight || 0;
    const paneHeights = resolvePaneHeightLayout(
      paneHeightStorageKey,
      activeSubPanes.length,
      totalHeight,
    );
    if (paneHeights) setPaneHeights(chart, paneHeights);
  }, [activeSubPanes, paneDescriptors.length, paneHeightStorageKey, seriesReady, subPaneIdsKey]);

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
    const currentIds = new Set(subPanes.map((p) => p.id));
    for (const prevId of prevSubPaneIdsRef.current) {
      if (!currentIds.has(prevId)) clearSavedDrawings(`${drawingKeyBase || symbol}__${prevId}`);
    }
    prevSubPaneIdsRef.current = currentIds;
  }, [drawingKeyBase, subPanes, symbol]);

  const shouldMountDrawingEngine = supportsDrawingFeatures
    && shouldLoadDrawingEngine({ activeTool: effectiveDrawingTool, drawingKey });
  const drawingAnchorReady = !!mainSeriesRef.current;

  useEffect(() => {
    if (!supportsDrawingFeatures
      || DrawingEngineHost
      || drawingSeriesGeneration <= 0
      || !drawingAnchorReady) return undefined;
    if (!shouldMountDrawingEngine && !drawingEngineToolActive) return undefined;
    let cancelled = false;
    preloadDrawingEngineHost();
    void loadDrawingEngineHost().then((module) => {
      if (!cancelled) setDrawingEngineHost(() => module.default);
    });
    return () => { cancelled = true; };
  }, [
    DrawingEngineHost,
    drawingAnchorReady,
    drawingSeriesGeneration,
    drawingEngineToolActive,
    effectiveDrawingTool,
    shouldMountDrawingEngine,
    supportsDrawingFeatures,
  ]);

  const clearAllDrawings = useCallback(() => {
    drawingApiRef.current?.clearAll?.();
  }, []);
  const setDrawingsHidden = useCallback((hidden: boolean) => {
    drawingsHiddenRef.current = !!hidden;
    drawingApiRef.current?.setHidden?.(hidden);
  }, []);
  const updateSelectedDrawingStyle = useCallback((patch: DrawingStylePatch) => {
    drawingApiRef.current?.updateSelectedDrawingStyle?.(patch);
  }, []);
  const prepareDrawingExport = useCallback(() => {
    drawingApiRef.current?.prepareExport?.();
  }, []);
  const handleDrawingApiChange = useCallback((api: DrawingEngineApi | null) => {
    drawingApiRef.current = api;
  }, []);

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
      const panes = chartRef.current?.panes?.() || [];
      const mainPaneHeight = panes[0]?.getHeight?.();
      const captureRect = panes.length > 1
        && rootRect
        && typeof mainPaneHeight === "number"
        && Number.isFinite(mainPaneHeight)
        && mainPaneHeight > 0
        ? {
            x: 0,
            y: 0,
            width: rootRect.width,
            height: Math.min(rootRect.height, mainPaneHeight),
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
    <div className="chart-area multi-pane-chart" ref={wrapperRef}>
      <div
        ref={containerRef}
        className="chart-pane"
        data-chart-type={resolvedChartType}
        data-pane-id="single-chart"
        data-pane-type="native-panes"
        onContextMenu={handlePriceScaleContextMenu}
        style={{ cursor: cursorStyleForDrawingTool(effectiveDrawingTool) }}
      />

      {paneLabelPositions.map((position) => (
        <div
          key={position.id}
          className="chart-pane-label advanced-market-pane-label"
          data-market-pane={position.marketPane}
          data-pane-id={position.id}
          style={{ top: position.top }}
        >
          {position.label}
        </div>
      ))}

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
                chartRef.current?.priceScale("right", 0).applyOptions({ autoScale: next });
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

      {DrawingEngineHost && shouldMountDrawingEngine && (
        <DrawingEngineHost
          chartAdapter={chartAdapter}
          chartContainerRef={containerRef}
          activeTool={effectiveDrawingTool}
          {...(onDrawingToolChange === undefined ? {} : { onToolChange: onDrawingToolChange })}
          penColor={penColor}
          penSize={penSize}
          textFontSize={textFontSize}
          textBold={textBold}
          textItalic={textItalic}
          fibLevels={fibLevels}
          fibInverted={fibInverted}
          positionSize={positionSize}
          drawingSnapEnabled={drawingSnapEnabled}
          drawingKey={drawingKey}
          drawingSeriesGeneration={drawingSeriesGeneration}
          drawingCoordinateKey={drawingCoordinateKey}
          drawingAnchorMode={drawingAnchorMode}
          initialHidden={drawingsHiddenRef.current}
          onApiChange={handleDrawingApiChange}
          {...(onSelectedDrawingChange === undefined ? {} : { onSelectedDrawingChange })}
        />
      )}

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
