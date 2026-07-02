/**
 * SingleChartPanes — lightweight-charts v5 native panes path.
 *
 * Uses one chart instance for main candles and all indicator panes so every
 * series shares the same time scale.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createLightweightChartAdapter } from "../chart-adapter/chartInstanceBridge";
import { applyChartPaneAppearance, buildChartPaneOptions } from "../chart-adapter/chartPaneLifecycle";
import { buildPaneLayoutOptions, createChartInstance } from "../chart-adapter/lightweightChartSurface";
import { createIndicatorSeries, createMainSeries, removeSeriesEntries } from "../chart-adapter/seriesLifecycle";
import { ensurePane, readPaneHeights, setPaneHeights } from "../chart-adapter/paneManager";
import { renderFillSeries, renderHlines } from "../chart-adapter/overlaySeriesRenderer";
import { renderMarkers } from "../chart-adapter/markerRenderer";
import { renderBgcolors } from "../chart-adapter/bgcolorPrimitiveRenderer";
import { applyBarColors } from "../chart-adapter/barColorRenderer";
import {
  alignIndicatorBgcolorsToTimes,
  alignIndicatorLinesToTimes,
  alignIndicatorMarkersToTimes,
  applyLineSeriesData,
  buildFillRenderEntries,
  canUseTrailingCandleUpdate,
  normalizeLineSeriesData,
  toCandlePoint,
} from "../chart-adapter/chartSeriesData";
import { planVisibleRangeRestore } from "../features/chart-session/visibleRangeStorage";
import { buildPaneConfigKey, loadPaneHeights, savePaneHeights } from "../features/chart-session/paneLayoutStorage";
import {
  loadDrawingEngineHost,
  preloadDrawingEngineHost,
  shouldLoadDrawingEngine,
} from "../features/drawings/drawingEngineLoader";
import { clearSavedDrawings } from "../features/drawings/drawingPersistence";
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

function buildTimeSet(data) {
  return new Set((data || []).map((item) => item?.time).filter((time) => time != null));
}

function readVisibleRangeSnapshot(chart) {
  const timeScale = chart?.timeScale?.();
  if (!timeScale) return null;
  const options = timeScale.options?.();
  const time = timeScale.getVisibleRange();
  const logical = timeScale.getVisibleLogicalRange();
  const scrollPosition = timeScale.scrollPosition?.();
  if (!time && !logical && !Number.isFinite(scrollPosition)) return null;
  return {
    time,
    logical,
    scrollPosition,
    barSpacing: options?.barSpacing,
  };
}

function restoreVisibleRangeSnapshotNow(chart, snapshot) {
  const timeScale = chart?.timeScale?.();
  if (!timeScale || !snapshot) return false;
  if (Number.isFinite(snapshot.barSpacing)) {
    timeScale.applyOptions({ barSpacing: snapshot.barSpacing });
  }
  if (snapshot.time) {
    try {
      timeScale.setVisibleRange(snapshot.time);
      return true;
    } catch { /* fall through */ }
  }
  if (Number.isFinite(snapshot.scrollPosition)) {
    timeScale.scrollToPosition(snapshot.scrollPosition, false);
    return true;
  }
  if (snapshot.logical) {
    try {
      timeScale.setVisibleLogicalRange(snapshot.logical);
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

function restoreVisibleRangeSnapshot(chart, snapshot) {
  const restored = restoreVisibleRangeSnapshotNow(chart, snapshot);
  if (typeof window !== "undefined" && window.requestAnimationFrame && snapshot) {
    window.requestAnimationFrame(() => {
      restoreVisibleRangeSnapshotNow(chart, snapshot);
    });
  }
  return restored;
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

const SingleChartPanes = forwardRef(function SingleChartPanes({
  data,
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
  theme,
  customBg,
  timezone = "Local",
  savedVisibleRange = null,
  dataMeta = null,
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
  const mainSeriesRef = useRef(null);
  const indicatorSeriesRef = useRef([]);
  const paneRenderStateRef = useRef(new Map());
  const dataRef = useRef([]);
  const dataMapRef = useRef(new Map());
  const dataIndexMapRef = useRef(new Map());
  const prevCandleDataRef = useRef([]);
  const prevBarcoloredDataRef = useRef([]);
  const prevIndicatorKeyRef = useRef("");
  const intervalRef = useRef(interval);
  const isSyncingRef = useRef(false);
  const userInteractedRef = useRef(false);
  const hasRestoredRangeRef = useRef(false);
  const visibleRangeSaveTimerRef = useRef(null);
  const prevSubPaneIdsRef = useRef(new Set());
  const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
  const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  const drawingApiRef = useRef(null);
  const drawingsHiddenRef = useRef(false);
  const [seriesReady, setSeriesReady] = useState(0);
  const [DrawingEngineHost, setDrawingEngineHost] = useState(null);
  const [isAutoScale, setIsAutoScale] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);

  const drawingKey = `${drawingKeyBase || symbol}__main`;
  const chartAdapter = useMemo(
    () => createLightweightChartAdapter({
      chartRef,
      seriesRef: mainSeriesRef,
      seriesDataRef: dataRef,
      seriesDataMapRef: dataMapRef,
      seriesDataIndexRef: dataIndexMapRef,
    }),
    [],
  );

  useEffect(() => {
    onCrosshairMove?.(null);
  }, [datasetKey, interval, onCrosshairMove, symbol]);

  const dataTimeSet = useMemo(() => buildTimeSet(data), [data]);
  const paneDescriptors = useMemo(() => buildPaneDescriptors({
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
  const subPaneIdsKey = useMemo(() => subPanes.map((p) => p.id).join(","), [subPanes]);
  const paneHeightStorageKey = useMemo(
    () => `${SINGLE_PANE_HEIGHT_KEY_PREFIX}${buildPaneConfigKey(subPanes.map((p) => p.id))}`,
    [subPanes],
  );

  useEffect(() => { dataRef.current = data || []; }, [data]);
  useEffect(() => { intervalRef.current = interval; }, [interval]);
  useEffect(() => { onNeedMoreLeftRef.current = onNeedMoreLeft; }, [onNeedMoreLeft]);
  useEffect(() => { canLoadMoreLeftRef.current = canLoadMoreLeft; }, [canLoadMoreLeft]);
  useEffect(() => { onVisibleRangeChangeRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);

  useEffect(() => {
    const map = new Map();
    const indexMap = new Map();
    for (let index = 0; index < (data || []).length; index += 1) {
      const d = data[index];
      map.set(d.time, d);
      indexMap.set(d.time, index);
    }
    dataMapRef.current = map;
    dataIndexMapRef.current = indexMap;
  }, [data]);

  const scheduleVisibleRangeSave = useCallback(() => {
    if (visibleRangeSaveTimerRef.current) clearTimeout(visibleRangeSaveTimerRef.current);
    visibleRangeSaveTimerRef.current = setTimeout(() => {
      const chart = chartRef.current;
      if (!chart || !onVisibleRangeChangeRef.current) return;
      const timeScale = chart.timeScale();
      const range = {
        logical: timeScale.getVisibleLogicalRange(),
        time: timeScale.getVisibleRange(),
        barSpacing: timeScale.options().barSpacing,
        scrollPosition: timeScale.scrollPosition(),
      };
      if (range.logical && range.time) onVisibleRangeChangeRef.current(range);
    }, VISIBLE_RANGE_SAVE_DEBOUNCE_MS);
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

    const chart = createChartInstance(container, options);
    const mainSeries = createMainSeries(chart, { upColor, downColor, paneIndex: 0 });
    chartRef.current = chart;
    mainSeriesRef.current = mainSeries;
    setSeriesReady((prev) => prev + 1);

    const handleCrosshairMove = (param) => {
      if (isSyncingRef.current || !onCrosshairMove) return;
      if (!param.time || !param.seriesData) {
        onCrosshairMove(null);
        return;
      }
      const cd = param.seriesData.get(mainSeries);
      if (!cd || cd.open == null || cd.high == null || cd.low == null || cd.close == null) {
        onCrosshairMove(null);
        return;
      }
      const rawItem = dataMapRef.current.get(param.time);
      onCrosshairMove({
        time: param.time,
        open: cd.open,
        high: cd.high,
        low: cd.low,
        close: cd.close,
        volume: rawItem ? rawItem.volume : 0,
      });
    };

    const handleVisibleLogicalRangeChange = (range) => {
      if (isSyncingRef.current || !range) return;
      if (userInteractedRef.current) scheduleVisibleRangeSave();
      if (onNeedMoreLeftRef.current && canLoadMoreLeftRef.current && range.from <= LEFT_EDGE_TRIGGER_BARS) {
        const currentData = dataRef.current;
        if (currentData?.length > 0) onNeedMoreLeftRef.current(currentData[0].time);
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      onCrosshairMove?.(null);
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      indicatorSeriesRef.current = [];
    };
  }, [customBg, downColor, onCrosshairMove, scheduleVisibleRangeSave, theme, timezone, upColor]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const markUserInteracted = () => { userInteractedRef.current = true; };
    const saveNativePaneHeights = () => {
      const chart = chartRef.current;
      if (!chart || subPanes.length === 0) return;
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
  }, [paneHeightStorageKey, subPanes.length]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyChartPaneAppearance(chart, { theme, customBg, timezone, interval });
    chart.applyOptions({ layout: buildPaneLayoutOptions() });
  }, [customBg, interval, theme, timezone]);

  useEffect(() => {
    mainSeriesRef.current?.applyOptions({
      upColor,
      downColor,
      borderDownColor: downColor,
      borderUpColor: upColor,
      wickDownColor: downColor,
      wickUpColor: upColor,
    });
  }, [downColor, upColor]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("right", 0).applyOptions({
      invertScale: !!invertScale,
      mode: priceScaleMode ?? 0,
    });
  }, [invertScale, priceScaleMode]);

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
    prevCandleDataRef.current = [];
    prevBarcoloredDataRef.current = [];
    mainSeriesRef.current?.setData([]);
  }, [datasetKey]);

  useEffect(() => {
    const series = mainSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !data?.length) return;

    const candleData = data.map(toCandlePoint);
    const canUseTrailingUpdate = canUseTrailingCandleUpdate(prevCandleDataRef.current, candleData);
    const visibleRangeSnapshot = !canUseTrailingUpdate && prevCandleDataRef.current.length > 0
      ? readVisibleRangeSnapshot(chart)
      : null;
    try {
      isSyncingRef.current = true;
      if (canUseTrailingUpdate) {
        const start = Math.max(0, prevCandleDataRef.current.length - 1);
        for (let i = start; i < candleData.length; i += 1) series.update(candleData[i]);
        recordPerfEvent("chart.candleSeries.update", {
          paneId: "main",
          reason: "single-chart-trailing",
          points: candleData.length - start,
          totalPoints: candleData.length,
        });
      } else {
        series.setData(candleData);
        recordPerfEvent("chart.candleSeries.setData", {
          paneId: "main",
          reason: "single-chart-full",
          points: candleData.length,
        });
        restoreVisibleRangeSnapshot(chart, visibleRangeSnapshot);
      }
      prevCandleDataRef.current = candleData;
    } finally {
      isSyncingRef.current = false;
    }
  }, [data]);

  useEffect(() => {
    applyBarColors({
      series: mainSeriesRef.current,
      data,
      indicatorBarcolors,
      prevBarcoloredDataRef,
      isSyncingRef,
      paneId: "main",
      recordPerfEvent,
      toCandlePoint,
      canUseTrailingCandleUpdate,
      onError: (err, phase) => console.warn(
        phase === "clear" ? "SingleChartPanes: failed to clear barcolors:" : "SingleChartPanes: failed to apply barcolors:",
        err,
      ),
    });
  }, [data, indicatorBarcolors]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data?.length || hasRestoredRangeRef.current) return;

    const restorePlan = planVisibleRangeRestore(savedVisibleRange, data, dataMeta);
    let restored = false;

    if (restorePlan.barSpacing != null) {
      chart.timeScale().applyOptions({ barSpacing: restorePlan.barSpacing });
    }
    if (restorePlan.mode === "time") {
      try {
        chart.timeScale().setVisibleRange(restorePlan.timeRange);
        restored = true;
      } catch { /* */ }
    }
    if (!restored && restorePlan.mode === "logical") {
      try {
        chart.timeScale().setVisibleLogicalRange(restorePlan.logicalRange);
        restored = true;
      } catch { /* */ }
    }
    if (restored && restorePlan.scrollPosition != null) {
      chart.timeScale().scrollToPosition(restorePlan.scrollPosition, false);
    }
    if (!restored) chart.timeScale().fitContent();
    hasRestoredRangeRef.current = true;
  }, [data, dataMeta, datasetKey, savedVisibleRange]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const expectedPaneCount = Math.max(1, paneDescriptors.length);

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
    setSeriesReady((prev) => prev + 1);
  }, [dataTimeSet, drawingTool, paneDescriptors]);

  useEffect(() => {
    const chart = chartRef.current;
    const wrapper = wrapperRef.current;
    if (!chart || !wrapper || subPanes.length === 0) return;

    const saved = loadPaneHeights()[paneHeightStorageKey];
    if (Array.isArray(saved) && saved.length >= paneDescriptors.length) {
      setPaneHeights(chart, saved);
      return;
    }

    const totalHeight = wrapper.getBoundingClientRect?.().height || wrapper.clientHeight || 0;
    if (!Number.isFinite(totalHeight) || totalHeight <= 0) return;
    const mainHeight = Math.max(180, Math.round(totalHeight * 0.65));
    const subHeight = Math.max(80, Math.round((totalHeight - mainHeight) / Math.max(1, subPanes.length)));
    setPaneHeights(chart, [mainHeight, ...subPanes.map(() => subHeight)]);
  }, [paneDescriptors.length, paneHeightStorageKey, subPaneIdsKey, subPanes]);

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

  const shouldMountDrawingEngine = shouldLoadDrawingEngine({ activeTool: drawingTool, drawingKey });
  const drawingAnchorReady = !!mainSeriesRef.current;

  useEffect(() => {
    if (DrawingEngineHost || seriesReady <= 0 || !drawingAnchorReady) return undefined;
    if (!shouldMountDrawingEngine && !DRAWING_TOOL_IDS.has(drawingTool)) return undefined;
    let cancelled = false;
    preloadDrawingEngineHost();
    loadDrawingEngineHost().then((module) => {
      if (!cancelled) setDrawingEngineHost(() => module.default);
    });
    return () => { cancelled = true; };
  }, [DrawingEngineHost, drawingAnchorReady, drawingTool, seriesReady, shouldMountDrawingEngine]);

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
    getVisibleRange: () => {
      const chart = chartRef.current;
      if (!chart) return null;
      const timeScale = chart.timeScale();
      return {
        logical: timeScale.getVisibleLogicalRange(),
        time: timeScale.getVisibleRange(),
        barSpacing: timeScale.options().barSpacing,
        scrollPosition: timeScale.scrollPosition(),
      };
    },
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
      visibleRange: chartAdapter.getVisibleRange(),
      loading,
    }),
    seriesReady,
  }), [
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
    <div className="chart-area multi-pane-chart" ref={wrapperRef}>
      <div
        ref={containerRef}
        className="chart-pane"
        data-pane-id="single-chart"
        data-pane-type="native-panes"
        onContextMenu={handlePriceScaleContextMenu}
      />

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

export default SingleChartPanes;
