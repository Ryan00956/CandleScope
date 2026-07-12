/**
 * SingleChartPanes — lightweight-charts v5 native panes path.
 *
 * Uses one chart instance for the selected main price series and all indicator panes so every
 * series shares the same time scale.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createLightweightChartAdapter } from "../chart-adapter/chartInstanceBridge";
import { applyChartPaneAppearance, buildChartPaneOptions } from "../chart-adapter/chartPaneLifecycle";
import { buildPaneLayoutOptions, createChartInstance } from "../chart-adapter/lightweightChartSurface";
import {
  createIndicatorSeries,
  createMainSeries,
  removeSeriesEntries,
  replaceMainSeries,
} from "../chart-adapter/seriesLifecycle";
import { ensurePane, readPaneHeights, setPaneHeights } from "../chart-adapter/paneManager";
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
  alignIndicatorBgcolorsToTimes,
  alignIndicatorLinesToTimes,
  alignIndicatorMarkersToTimes,
  applyLineSeriesData,
  buildFillRenderEntries,
  normalizeLineSeriesData,
} from "../chart-adapter/chartSeriesData";
import { normalizeMainChartType } from "../shared/mainChartTypes";
import { planVisibleRangeRestore } from "../features/chart-session/visibleRangeStorage";
import { buildPaneConfigKey, loadPaneHeights, savePaneHeights } from "../features/chart-session/paneLayoutStorage";
import {
  buildVisibleRangeSnapshot,
  resolveDataTimeSet,
  shouldAdvanceIndicatorSeriesReady,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport,
} from "./singleChartPaneLifecycle";
import {
  loadDrawingEngineHost,
  preloadDrawingEngineHost,
  shouldLoadDrawingEngine,
} from "../features/drawings/drawingEngineLoader";
import { clearSavedDrawings } from "../features/drawings/drawingPersistence";
import {
  createProjector,
  getChartTypeDescriptor,
  mapSourceTimeRangeToDisplayLogicalRange,
  ProjectionStore,
  resolveKagiProjectorOptions,
  resolveLineBreakProjectorOptions,
  resolvePointFigureProjectorOptions,
  resolveRenkoProjectorOptions,
  sourceTimeFromAxisTime,
} from "../features/chart-representation/index.js";
import { recordPerfEvent } from "../runtime/performance/perfMarks";

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;
const DRAWING_TOOL_IDS = new Set(["pen", "highlighter", "eraser", "line-segment", "line-ray", "line-infinite", "line-horizontal", "line-vertical", "line-cross", "angle-measure", "shape-rectangle", "shape-ellipse", "text", "fibonacci", "position-long", "position-short"]);
const SINGLE_PANE_HEIGHT_KEY_PREFIX = "single:";
const PRICE_SCALE_CONTEXT_HIT_WIDTH = 96;
const PRICE_SCALE_CONTEXT_MENU_WIDTH = 220;
const PRICE_SCALE_CONTEXT_MENU_HEIGHT = 236;
const PRICE_SCALE_CONTEXT_MENU_MARGIN = 8;
const PRICE_SCALE_MODES = [
  { value: 0, label: "常规", labelEn: "Regular" },
  { value: 1, label: "对数", labelEn: "Logarithmic" },
  { value: 2, label: "百分比", labelEn: "Percentage" },
  { value: 3, label: "基准 100", labelEn: "Indexed to 100" },
];

function paneKeyForItem(item) {
  const pane = item?.pane || "main";
  if (pane === "main") return "main";
  if (!item?.indicatorId) return pane;
  return `${pane}-${item.indicatorId}`;
}

function filterItemsForPane(items, paneId) {
  return (items || []).filter((item) => paneKeyForItem(item) === paneId);
}

function filterFillsForLines(fills, lines) {
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

function rowsFromStore(store) {
  return store?.snapshot?.() || [];
}

function resolveProjectionRuntime(chartType, rows, settings = {}) {
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

function buildSyntheticChartNotice(chartType, settings = {}) {
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

function createProjectionStore(chartType, rows = [], settings = {}) {
  const runtime = resolveProjectionRuntime(chartType, rows, settings);
  const store = new ProjectionStore({
    projector: createProjector(runtime.descriptor.projectionId, runtime.options),
  });
  store.configurationKey = runtime.configKey;
  return store;
}

function syncSourceDataRefsFromStore({ store, rowsRef, rowMapRef, rowIndexMapRef }) {
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

function syncDisplayDataRefsFromProjection({ store, rowsRef, rowMapRef, rowIndexMapRef }) {
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

function resolveSourceTime(axisTime, displayRow = null) {
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

function captureSurfaceViewport(chart, axisMode) {
  try {
    const timeScale = chart?.timeScale?.();
    const time = timeScale?.getVisibleRange?.();
    const logical = timeScale?.getVisibleLogicalRange?.();
    const from = sourceTimeFromAxisTime(time?.from);
    const to = sourceTimeFromAxisTime(time?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return {
      axisMode,
      barSpacing: timeScale.options?.().barSpacing,
      logicalSpan: Number.isFinite(logical?.from) && Number.isFinite(logical?.to)
        ? Math.max(0, logical.to - logical.from)
        : null,
      sourceRange: from <= to ? { from, to } : { from: to, to: from },
    };
  } catch {
    return null;
  }
}

function restoreSurfaceViewport(viewportController, displayRows, transfer, axisMode) {
  if (!viewportController || !transfer) return false;
  const logical = mapSourceTimeRangeToDisplayLogicalRange(displayRows, transfer.sourceRange);
  const range = logical && logical.to > logical.from
    ? logical
    : (logical ? { from: logical.from - 5, to: logical.to + 5 } : null);
  return viewportController.restoreProjectionRange(range, {
    barSpacing: transfer.axisMode === axisMode ? transfer.barSpacing : null,
  });
}

function shouldPreserveProjectionViewport(delta) {
  const type = delta?.type;
  const hasTrim = (delta?.trimmedLeft || 0) > 0 || (delta?.trimmedRight || 0) > 0;
  return type === "prepend"
    || type === "mid-merge"
    || ((type === "tick" || type === "append") && hasTrim);
}

function getPaneRenderState(mapRef, paneId) {
  let state = mapRef.current.get(paneId);
  if (!state) {
    state = {
      markerTargetRef: { current: null },
      markerStateRef: { current: { target: null, state: "unknown" } },
      hlinesRef: { current: [] },
      hlinesStateRef: { current: { target: null, signature: "unknown" } },
      fillSeriesRef: { current: [] },
      fillSeriesStateRef: { current: { chart: null, signature: "unknown" } },
      bgcolorPrimitiveRef: { current: null },
      bgcolorStateRef: { current: { pane: null, signature: "unknown" } },
    };
    mapRef.current.set(paneId, state);
  }
  return state;
}

function buildPaneDescriptors({
  dataTimeSet,
  mainOverlayLines,
  subPanes,
  indicatorMarkers,
  indicatorFills,
  indicatorHlines,
  indicatorBgcolors,
}) {
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

  for (let index = 0; index < subPanes.length; index += 1) {
    const subPane = subPanes[index];
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

const DERIVED_MAIN_PANE_DESCRIPTOR = Object.freeze({
  id: "main",
  paneIndex: 0,
  label: "",
  lines: [],
  markers: [],
  fills: [],
  hlines: [],
  bgcolors: [],
});

const SingleChartPanes = forwardRef(function SingleChartPanes({
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
  fibLevels,
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
}, ref) {
  const wrapperRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const viewportControllerRef = useRef(null);
  const mainSeriesRef = useRef(null);
  const indicatorSeriesRef = useRef([]);
  const paneRenderStateRef = useRef(new Map());
  const sourceRowsRef = useRef([]);
  const sourceRowMapRef = useRef(new Map());
  const sourceRowIndexMapRef = useRef(new Map());
  const displayRowsRef = useRef([]);
  const displayRowMapRef = useRef(new Map());
  const displayRowIndexMapRef = useRef(new Map());
  const renderedMainSeriesDataRef = useRef([]);
  const projectionStoreRef = useRef(null);
  const projectionGenerationRef = useRef(0);
  const projectionRenderContextRef = useRef(null);
  const mainSeriesTypeRef = useRef(null);
  const mainSeriesReferenceRef = useRef({ series: null, signature: "" });
  const requestedChartTypeRef = useRef(normalizeMainChartType(chartType));
  const requestedProjectionSettingsRef = useRef(null);
  const pendingSurfaceViewportRef = useRef(null);
  const surfaceAxisModeRef = useRef("time");
  const seriesStoreRef = useRef(seriesStore);
  const prevIndicatorKeyRef = useRef("");
  const intervalRef = useRef(interval);
  const isSyncingRef = useRef(false);
  const isRestoringViewportRef = useRef(false);
  const userInteractedRef = useRef(false);
  const hasRestoredRangeRef = useRef(false);
  const lastViewportRestoreSourceRef = useRef(null);
  const visibleRangeSaveTimerRef = useRef(null);
  const prevSubPaneIdsRef = useRef(new Set());
  const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
  const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
  const onViewportRangeChangeRef = useRef(onViewportRangeChange);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const drawingApiRef = useRef(null);
  const drawingsHiddenRef = useRef(false);
  const [seriesReady, setSeriesReady] = useState(0);
  const [DrawingEngineHost, setDrawingEngineHost] = useState(null);
  const [isAutoScale, setIsAutoScale] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);

  const resolvedChartType = normalizeMainChartType(chartType);
  const resolvedDescriptor = getChartTypeDescriptor(resolvedChartType);
  const resolvedAxisMode = resolvedDescriptor.axisMode;
  const supportsAuxiliaryChartFeatures = resolvedAxisMode === "time";
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
  requestedChartTypeRef.current = resolvedChartType;
  requestedProjectionSettingsRef.current = projectionSettings;
  seriesStoreRef.current = seriesStore;
  const indicatorBarColorMap = useMemo(
    () => buildIndicatorBarColorMap(indicatorBarcolors),
    [indicatorBarcolors],
  );
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
    }),
    [],
  );

  useEffect(() => {
    onCrosshairMove?.(null);
  }, [datasetKey, interval, onCrosshairMove, symbol]);

  const dataTimeSet = resolveDataTimeSet(seriesStore);
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
    () => (supportsAuxiliaryChartFeatures
      ? sourcePaneDescriptors
      : [DERIVED_MAIN_PANE_DESCRIPTOR]),
    [sourcePaneDescriptors, supportsAuxiliaryChartFeatures],
  );
  const activeSubPanes = useMemo(
    () => (supportsAuxiliaryChartFeatures ? subPanes : []),
    [subPanes, supportsAuxiliaryChartFeatures],
  );
  const subPaneIdsKey = useMemo(
    () => activeSubPanes.map((pane) => pane.id).join(","),
    [activeSubPanes],
  );
  const paneHeightStorageKey = useMemo(
    () => `${SINGLE_PANE_HEIGHT_KEY_PREFIX}${buildPaneConfigKey(activeSubPanes.map((pane) => pane.id))}`,
    [activeSubPanes],
  );

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
    const sourceTimeRange = Number.isFinite(sourceFrom) && Number.isFinite(sourceTo)
      ? { from: Math.min(sourceFrom, sourceTo), to: Math.max(sourceFrom, sourceTo) }
      : null;
    return buildVisibleRangeSnapshot({
      barSpacing: visibleRange.barSpacing,
      logicalRange: visibleRange.logical,
      rightOffset: visibleRange.scrollPosition,
      timeRange: sourceTimeRange,
    });
  }, [chartAdapter]);

  const publishViewportRangeChange = useCallback((visibleRange = null) => {
    const range = visibleRange || captureVisibleRange();
    if (range) onViewportRangeChangeRef.current?.(range);
  }, [captureVisibleRange]);

  const scheduleVisibleRangeSave = useCallback((visibleRange = null) => {
    const range = visibleRange || captureVisibleRange();
    if (!range) return;
    if (visibleRangeSaveTimerRef.current) clearTimeout(visibleRangeSaveTimerRef.current);
    visibleRangeSaveTimerRef.current = setTimeout(() => {
      visibleRangeSaveTimerRef.current = null;
      onVisibleRangeChangeRef.current?.(range);
    }, VISIBLE_RANGE_SAVE_DEBOUNCE_MS);
  }, [captureVisibleRange]);

  const updateMainSeriesReference = useCallback((series, rows, nextChartType = mainSeriesTypeRef.current) => {
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
    const chart = createChartInstance(container, options, {
      axisMode: initialDescriptor.axisMode,
    });
    const initialRows = rowsFromStore(seriesStoreRef.current);
    syncSourceDataRefsFromStore({
      store: seriesStoreRef.current,
      rowsRef: sourceRowsRef,
      rowMapRef: sourceRowMapRef,
      rowIndexMapRef: sourceRowIndexMapRef,
    });
    const initialProjectionStore = createProjectionStore(
      initialChartType,
      initialRows,
      requestedProjectionSettingsRef.current,
    );
    initialProjectionStore.reset(initialRows);
    projectionStoreRef.current = initialProjectionStore;
    projectionGenerationRef.current += 1;
    syncDisplayDataRefsFromProjection({
      store: initialProjectionStore,
      rowsRef: displayRowsRef,
      rowMapRef: displayRowMapRef,
      rowIndexMapRef: displayRowIndexMapRef,
    });
    const mainSeries = createMainSeries(chart, {
      chartType: initialChartType,
      data: initialRows,
      upColor,
      downColor,
      paneIndex: 0,
    });
    chartRef.current = chart;
    viewportControllerRef.current = createViewportController({
      chartProvider: () => chartRef.current,
    });
    mainSeriesRef.current = mainSeries;
    mainSeriesTypeRef.current = initialChartType;
    surfaceAxisModeRef.current = initialDescriptor.axisMode;
    mainSeriesReferenceRef.current = {
      series: mainSeries,
      signature: JSON.stringify(buildMainSeriesReferenceOptions(initialChartType, initialRows)),
    };
    setSeriesReady((prev) => prev + 1);

    const handleCrosshairMove = (param) => {
      if (isSyncingRef.current || !onCrosshairMove) return;
      if (param.time == null) {
        onCrosshairMove(null);
        return;
      }
      const displayRow = displayRowMapRef.current.get(param.time);
      const sourceTime = resolveSourceTime(param.time, displayRow);
      const sourceRow = sourceTime == null ? null : sourceRowMapRef.current.get(sourceTime);
      const crosshairValue = buildMainSeriesCrosshairValue(
        sourceTime,
        displayRow || sourceRow,
        { includeVolume: supportsAuxiliaryChartFeatures, volumeRow: sourceRow },
      );
      if (!crosshairValue) {
        onCrosshairMove(null);
        return;
      }
      onCrosshairMove(crosshairValue);
    };

    const handleVisibleLogicalRangeChange = (range) => {
      if (!shouldPublishUserViewportRange({
        isProgrammatic: isRestoringViewportRef.current,
        isSyncing: isSyncingRef.current,
        range,
        userInteracted: userInteractedRef.current,
      })) return;
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
        onNeedMoreLeftRef.current(currentData[0].time);
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

    return () => {
      pendingSurfaceViewportRef.current = captureSurfaceViewport(
        chart,
        initialDescriptor.axisMode,
      );
      if (visibleRangeSaveTimerRef.current) {
        clearTimeout(visibleRangeSaveTimerRef.current);
        visibleRangeSaveTimerRef.current = null;
      }
      // Stop exposing the old chart before touching the underlying LWC
      // instance.  During interval/session transitions its API object can
      // remain reachable briefly even though its internal time points have
      // already been cleared.
      chartRef.current = null;
      mainSeriesRef.current = null;
      mainSeriesTypeRef.current = null;
      mainSeriesReferenceRef.current = { series: null, signature: "" };
      sourceRowsRef.current = [];
      sourceRowMapRef.current = new Map();
      sourceRowIndexMapRef.current = new Map();
      displayRowsRef.current = [];
      displayRowMapRef.current = new Map();
      displayRowIndexMapRef.current = new Map();
      renderedMainSeriesDataRef.current = [];
      projectionStoreRef.current = null;
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
      try {
        chart.remove();
      } catch { /* best-effort teardown */ }
    };
  }, [captureVisibleRange, customBg, downColor, onCrosshairMove, publishViewportRangeChange, scheduleVisibleRangeSave, supportsAuxiliaryChartFeatures, surfaceConfigKey, theme, timezone, upColor]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const markUserInteracted = () => {
      userInteractedRef.current = true;
      viewportControllerRef.current?.markUserInteracting();
    };
    const saveNativePaneHeights = () => {
      const chart = chartRef.current;
      if (!chart || activeSubPanes.length === 0) return;
      const heights = readPaneHeights(chart);
      if (heights.length === 0) return;
      const saved = loadPaneHeights();
      saved[paneHeightStorageKey] = heights;
      savePaneHeights(saved);
    };
    wrapper.addEventListener("wheel", markUserInteracted, { passive: true });
    wrapper.addEventListener("mousedown", markUserInteracted);
    wrapper.addEventListener("touchstart", markUserInteracted, { passive: true });
    wrapper.addEventListener("mouseup", saveNativePaneHeights);
    return () => {
      wrapper.removeEventListener("wheel", markUserInteracted);
      wrapper.removeEventListener("mousedown", markUserInteracted);
      wrapper.removeEventListener("touchstart", markUserInteracted);
      wrapper.removeEventListener("mouseup", saveNativePaneHeights);
    };
  }, [activeSubPanes.length, paneHeightStorageKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyChartPaneAppearance(chart, { theme, customBg, timezone, interval });
    chart.applyOptions({ layout: buildPaneLayoutOptions() });
  }, [customBg, interval, theme, timezone]);

  useEffect(() => {
    const activeType = mainSeriesTypeRef.current || resolvedChartType;
    mainSeriesRef.current?.applyOptions(
      buildMainSeriesStyleOptions(activeType, { upColor, downColor }),
    );
  }, [downColor, resolvedChartType, upColor]);

  useEffect(() => {
    const chart = chartRef.current;
    const previousSeries = mainSeriesRef.current;
    if (!chart || !previousSeries || mainSeriesTypeRef.current === resolvedChartType) return;

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
      projectionStoreRef.current = nextProjectionStore;
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

  const handlePriceScaleContextMenu = useCallback((event) => {
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
    const handleKey = (event) => {
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
    userInteractedRef.current = false;
    hasRestoredRangeRef.current = false;
    lastViewportRestoreSourceRef.current = null;
    renderedMainSeriesDataRef.current = [];
    displayRowsRef.current = [];
    displayRowMapRef.current = new Map();
    displayRowIndexMapRef.current = new Map();
    projectionStoreRef.current = null;
    projectionGenerationRef.current += 1;
    projectionRenderContextRef.current = null;
    viewportControllerRef.current?.resetSession();
  }, [datasetKey]);

  useEffect(() => {
    const series = mainSeriesRef.current;
    const store = seriesStore;
    if (!series || !store) return undefined;
    const activeChartType = mainSeriesTypeRef.current;
    const activeRenderOptions = {
      ...mainSeriesRenderContext,
      chartType: activeChartType,
    };
    const rows = rowsFromStore(store);
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
      const renderedPatch = buildMainSeriesProjectionPatch({
        displayRows,
        previousSeriesData: renderedMainSeriesDataRef.current,
        projectionPatch: effectiveProjectionPatch,
        renderOptions: activeRenderOptions,
      });
      let projectionRendered = false;
      try {
        const renderResult = renderMainSeriesProjectionPatch({
          indexOfDisplayTime: (time) => projectionStore.indexOfDisplayTime(time),
          previousDisplayRows,
          patch: renderedPatch,
          recordPerfEvent,
          series,
          viewportController: viewportControllerRef.current,
        });
        renderedMainSeriesDataRef.current = renderResult.nextData;
        projectionRendered = true;
      } catch (error) {
        // The chart may be partially mutated when both an incremental write
        // and its setData recovery fail. A null cache forces the next delta to
        // rebuild from output index zero instead of compounding that state.
        renderedMainSeriesDataRef.current = null;
        recordPerfEvent("chart.candleSeries.renderError", {
          message: error instanceof Error ? error.message : String(error),
          paneId: "main",
          phase: "sync",
        });
      }
      syncDisplayDataRefsFromProjection({
        store: projectionStore,
        rowsRef: displayRowsRef,
        rowMapRef: displayRowMapRef,
        rowIndexMapRef: displayRowIndexMapRef,
      });
      updateMainSeriesReference(series, rows);
      projectionRenderContextRef.current = mainSeriesRenderContext;
      if (projectionRendered && pendingSurfaceViewportRef.current && displayRows.length > 0) {
        isRestoringViewportRef.current = true;
        try {
          restoreSurfaceViewport(
            viewportControllerRef.current,
            displayRows,
            pendingSurfaceViewportRef.current,
            surfaceAxisModeRef.current,
          );
          pendingSurfaceViewportRef.current = null;
        } finally {
          isRestoringViewportRef.current = false;
        }
      }
    } finally {
      isSyncingRef.current = false;
    }

    return store.subscribe((delta, currentStore) => {
      if (projectionGenerationRef.current !== generation || delta?.type === "noop") return;
      const currentSeries = mainSeriesRef.current;
      if (!currentSeries) return;
      try {
        isSyncingRef.current = true;
        const currentRenderOptions = {
          ...mainSeriesRenderContext,
          chartType: mainSeriesTypeRef.current,
        };
        const rows = rowsFromStore(currentStore);
        const previousDisplayRows = projectionStore.displaySnapshot();
        const projectionPatch = projectionStore.applySourceDelta(delta, rows);
        const displayRows = projectionStore.displaySnapshot();
        const renderedPatch = buildMainSeriesProjectionPatch({
          displayRows,
          previousSeriesData: renderedMainSeriesDataRef.current,
          projectionPatch,
          renderOptions: currentRenderOptions,
        });
        try {
          const renderResult = renderMainSeriesProjectionPatch({
            indexOfDisplayTime: (time) => projectionStore.indexOfDisplayTime(time),
            previousDisplayRows,
            patch: renderedPatch,
            preserveViewport: shouldPreserveProjectionViewport(delta),
            recordPerfEvent,
            series: currentSeries,
            viewportController: viewportControllerRef.current,
          });
          renderedMainSeriesDataRef.current = renderResult.nextData;
        } catch (error) {
          renderedMainSeriesDataRef.current = null;
          recordPerfEvent("chart.candleSeries.renderError", {
            message: error instanceof Error ? error.message : String(error),
            paneId: "main",
            phase: "delta",
          });
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
        updateMainSeriesReference(currentSeries, rows);
      } finally {
        isSyncingRef.current = false;
      }
    });
  }, [mainSeriesRenderContext, projectionSettings, seriesReady, seriesStore, updateMainSeriesReference]);

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
      );
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
    if (!chart) return;
    const expectedPaneCount = Math.max(1, paneDescriptors.length);
    const paneCountBefore = chart.panes?.()?.length ?? 1;
    const paneStructureChanged = paneCountBefore !== expectedPaneCount;

    for (let paneIndex = 1; paneIndex < expectedPaneCount; paneIndex += 1) {
      ensurePane(chart, paneIndex);
    }

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

    if (!structureChanged && indicatorSeriesRef.current.length > 0) {
      for (const entry of indicatorSeriesRef.current) {
        const line = paneDescriptors
          .find((pane) => pane.id === entry.paneId)
          ?.lines
          ?.find((candidate) => (candidate.id || candidate.name) === (entry.lineConfig.id || entry.lineConfig.name));
        if (!line) continue;
        const validData = normalizeLineSeriesData(line, dataTimeSet);
        applyLineSeriesData(entry.series, validData, entry.data, {
          datasetKey,
          indicatorId: line.indicatorId,
          interval,
          paneId: entry.paneId,
          line: line.name || line.id,
          type: line.type || "line",
          path: "single-fast",
        }, recordPerfEvent);
        entry.lineConfig = line;
        entry.data = validData;
      }
      return;
    }

    const removedSeriesCount = removeSeriesEntries(chart, indicatorSeriesRef.current);
    if (removedSeriesCount > 0) {
      recordPerfEvent("chart.indicatorSeries.remove", {
        paneId: "single-chart",
        reason: "rebuild",
        series: removedSeriesCount,
      });
    }
    indicatorSeriesRef.current = [];

    let createdSeriesCount = 0;
    for (const pane of paneDescriptors) {
      for (const line of pane.lines || []) {
        if (!line.data?.length) continue;
        try {
          const series = createIndicatorSeries(chart, line, {
            paneIndex: pane.paneIndex,
            crosshairMarkerVisible: !DRAWING_TOOL_IDS.has(drawingTool),
          });
          const validData = normalizeLineSeriesData(line, dataTimeSet);
          if (validData.length > 0) {
            series.setData(validData);
            recordPerfEvent("chart.indicatorSeries.setData", {
              datasetKey,
              indicatorId: line.indicatorId,
              interval,
              paneId: pane.id,
              line: line.name || line.id,
              type: line.type || "line",
              path: "single-rebuild",
              points: validData.length,
            });
          }
          recordPerfEvent("chart.indicatorSeries.create", {
            paneId: pane.id,
            line: line.name || line.id || indicatorSeriesRef.current.length,
            type: line.type || "line",
            path: "single-rebuild",
          });
          indicatorSeriesRef.current.push({ paneId: pane.id, paneIndex: pane.paneIndex, series, lineConfig: line, data: validData });
          createdSeriesCount += 1;
        } catch (err) {
          console.warn("SingleChartPanes: failed to add indicator series:", err);
        }
      }
    }

    const panes = chart.panes?.() || [];
    for (let paneIndex = panes.length - 1; paneIndex >= expectedPaneCount; paneIndex -= 1) {
      try {
        chart.removePane(paneIndex);
      } catch { /* */ }
    }
    if (shouldAdvanceIndicatorSeriesReady({
      createdSeriesCount,
      paneStructureChanged,
      removedSeriesCount,
      structureChanged,
    })) {
      setSeriesReady((prev) => prev + 1);
    }
  }, [dataTimeSet, datasetKey, drawingTool, interval, paneDescriptors, seriesReady]);

  useEffect(() => {
    const chart = chartRef.current;
    const wrapper = wrapperRef.current;
    if (!chart || !wrapper || activeSubPanes.length === 0) return;

    const saved = loadPaneHeights()[paneHeightStorageKey];
    if (Array.isArray(saved) && saved.length >= paneDescriptors.length) {
      setPaneHeights(chart, saved);
      return;
    }

    const totalHeight = wrapper.getBoundingClientRect?.().height || wrapper.clientHeight || 0;
    if (!Number.isFinite(totalHeight) || totalHeight <= 0) return;
    const mainHeight = Math.max(180, Math.round(totalHeight * 0.65));
    const subHeight = Math.max(80, Math.round((totalHeight - mainHeight) / Math.max(1, activeSubPanes.length)));
    setPaneHeights(chart, [mainHeight, ...activeSubPanes.map(() => subHeight)]);
  }, [activeSubPanes, paneDescriptors.length, paneHeightStorageKey, seriesReady, subPaneIdsKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");

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
  }, [customBg, paneDescriptors, seriesReady, theme]);

  useEffect(() => {
    const currentIds = new Set(subPanes.map((p) => p.id));
    for (const prevId of prevSubPaneIdsRef.current) {
      if (!currentIds.has(prevId)) clearSavedDrawings(`${drawingKeyBase || symbol}__${prevId}`);
    }
    prevSubPaneIdsRef.current = currentIds;
  }, [drawingKeyBase, subPanes, symbol]);

  const shouldMountDrawingEngine = supportsAuxiliaryChartFeatures
    && shouldLoadDrawingEngine({ activeTool: drawingTool, drawingKey });
  const drawingAnchorReady = !!mainSeriesRef.current;

  useEffect(() => {
    if (!supportsAuxiliaryChartFeatures
      || DrawingEngineHost
      || seriesReady <= 0
      || !drawingAnchorReady) return undefined;
    if (!shouldMountDrawingEngine && !DRAWING_TOOL_IDS.has(drawingTool)) return undefined;
    let cancelled = false;
    preloadDrawingEngineHost();
    loadDrawingEngineHost().then((module) => {
      if (!cancelled) setDrawingEngineHost(() => module.default);
    });
    return () => { cancelled = true; };
  }, [DrawingEngineHost, drawingAnchorReady, drawingTool, seriesReady, shouldMountDrawingEngine, supportsAuxiliaryChartFeatures]);

  const clearAllDrawings = useCallback(() => {
    drawingApiRef.current?.clearAll?.();
  }, []);
  const setDrawingsHidden = useCallback((hidden) => {
    drawingsHiddenRef.current = !!hidden;
    drawingApiRef.current?.setHidden?.(hidden);
  }, []);
  const updateSelectedDrawingStyle = useCallback((patch) => {
    drawingApiRef.current?.updateSelectedDrawingStyle?.(patch);
  }, []);
  const prepareDrawingExport = useCallback(() => {
    drawingApiRef.current?.prepareExport?.();
  }, []);

  useImperativeHandle(ref, () => ({
    getVisibleRange: captureVisibleRange,
    clearAllDrawings,
    setDrawingsHidden,
    updateSelectedDrawingStyle,
    resetAutoScale,
    prepareExport: prepareDrawingExport,
    getExportSnapshot: () => ({
      rootElement: wrapperRef.current,
      mainPane: {
        paneId: "main",
        paneType: "main",
        rootElement: wrapperRef.current,
        chartElement: containerRef.current,
        rect: wrapperRef.current?.getBoundingClientRect?.() || null,
      },
      subPanes: paneDescriptors.filter((pane) => pane.id !== "main").map((pane) => ({ id: pane.id, paneType: "sub" })),
      visibleRange: captureVisibleRange(),
      loading,
    }),
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
      />

      {!supportsAuxiliaryChartFeatures && (
        <div className="synthetic-chart-notice" role="status">
          <strong>{syntheticChartNotice.title}</strong>
          <span>
            {`${syntheticChartNotice.detail} · 指标、成交量和绘图暂不显示`}
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
          activeTool={drawingTool}
          onToolChange={onDrawingToolChange}
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
          seriesReady={seriesReady}
          initialHidden={drawingsHiddenRef.current}
          onApiChange={(api) => { drawingApiRef.current = api; }}
          onSelectedDrawingChange={onSelectedDrawingChange}
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
