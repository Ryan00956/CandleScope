/**
 * ChartPane — a single lightweight-charts instance inside a multi-pane layout.
 *
 * Types:
 *   "main"  — candlestick chart + overlay indicators, supports drawing tools
 *   "sub"   — indicator-only pane (line/histogram series), no candlesticks
 *
 * Each pane is an independent createChart() instance. Time-axis and crosshair
 * synchronization is managed by the parent MultiPaneChart.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createLightweightChartAdapter } from "../chart-adapter/chartInstanceBridge";
import { buildChartPaneImperativeHandle } from "../chart-adapter/chartImperativeHandle";
import {
    applyChartPaneAppearance,
    buildCrosshairOptions,
    createChartPaneLifecycle,
} from "../chart-adapter/chartPaneLifecycle";
import { renderFillSeries, renderHlines } from "../chart-adapter/overlaySeriesRenderer";
import { renderMarkers } from "../chart-adapter/markerRenderer";
import { applyBarColors } from "../chart-adapter/barColorRenderer";
import { renderBgcolorOverlay } from "../chart-adapter/bgcolorRenderer";
import { createIndicatorSeries, removeSeriesEntries } from "../chart-adapter/seriesLifecycle";
import {
    loadDrawingEngineHost,
    preloadDrawingEngineHost,
    shouldLoadDrawingEngine,
} from "../features/drawings/drawingEngineLoader";
import { clearSavedDrawings } from "../features/drawings/drawingPersistence";
import { recordPerfEvent } from "../runtime/performance/perfMarks";

function toCandlePoint(d) {
    if (
        d?.__whitespace ||
        d?.open == null ||
        d?.high == null ||
        d?.low == null ||
        d?.close == null
    ) {
        return { time: d.time };
    }
    return { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close };
}

function normalizeLineSeriesData(line) {
    const isHistogram = line?.type === "histogram";
    if (isHistogram && line.colorData && Array.isArray(line.colorData)) {
        const colorMap = new Map();
        for (const cd of line.colorData) colorMap.set(cd.time, cd.color);
        return (line.data || [])
            .filter((d) => d?.time != null && d?.value != null && isFinite(d.value))
            .map((d) => {
                const entry = { time: d.time, value: d.value };
                const c = colorMap.get(d.time);
                if (c) entry.color = c;
                return entry;
            });
    }
    return (line?.data || []).filter(
        (d) => d?.time != null && d?.value != null && isFinite(d.value)
    );
}

function linePointEquals(a, b) {
    return a?.time === b?.time
        && a?.value === b?.value
        && (a?.color || null) === (b?.color || null);
}

function candlePointEquals(a, b) {
    return a?.time === b?.time
        && a?.open === b?.open
        && a?.high === b?.high
        && a?.low === b?.low
        && a?.close === b?.close
        && (a?.color || null) === (b?.color || null)
        && (a?.borderColor || null) === (b?.borderColor || null)
        && (a?.wickColor || null) === (b?.wickColor || null);
}

function canUseTrailingSeriesUpdate(previousData, nextData) {
    if (!previousData?.length || !nextData?.length) return false;
    if (nextData.length < previousData.length || nextData.length > previousData.length + 1) return false;
    if (nextData[0]?.time !== previousData[0]?.time) return false;
    if (nextData[previousData.length - 1]?.time !== previousData[previousData.length - 1]?.time) return false;

    const stableCount = Math.max(0, previousData.length - 1);
    for (let i = 0; i < stableCount; i += 1) {
        if (!linePointEquals(previousData[i], nextData[i])) return false;
    }
    return true;
}

function canUseTrailingCandleUpdate(previousData, nextData) {
    if (!previousData?.length || !nextData?.length) return false;
    if (nextData.length < previousData.length || nextData.length > previousData.length + 1) return false;
    if (nextData[0]?.time !== previousData[0]?.time) return false;
    if (nextData[previousData.length - 1]?.time !== previousData[previousData.length - 1]?.time) return false;

    const stableCount = Math.max(0, previousData.length - 1);
    for (let i = 0; i < stableCount; i += 1) {
        if (!candlePointEquals(previousData[i], nextData[i])) return false;
    }
    return true;
}

function applyLineSeriesData(series, nextData, previousData, detail) {
    if (!nextData?.length) return "empty";
    if (canUseTrailingSeriesUpdate(previousData, nextData)) {
        const start = Math.max(0, previousData.length - 1);
        for (let i = start; i < nextData.length; i += 1) {
            series.update(nextData[i]);
        }
        recordPerfEvent("chart.indicatorSeries.update", {
            ...detail,
            points: nextData.length - start,
            totalPoints: nextData.length,
        });
        return "update";
    }
    series.setData(nextData);
    recordPerfEvent("chart.indicatorSeries.setData", {
        ...detail,
        points: nextData.length,
    });
    return "setData";
}

function lineDataSignature(data = []) {
    return data.map((point) => `${point.time}:${point.value}`).join(";");
}

function buildFillRenderEntries(indicatorFills = [], indicatorLines = [], backgroundColor) {
    if (!indicatorFills?.length || !indicatorLines?.length) {
        return { entries: [], signature: "empty", matchedFillCount: 0, pointCount: 0 };
    }

    const plotDataMap = new Map();
    for (const line of indicatorLines) {
        if (line.id) {
            const scopedKey = `${line.indicatorId || ""}:${line.id}`;
            plotDataMap.set(scopedKey, line.data);
            if (!line.indicatorId && !plotDataMap.has(line.id)) {
                plotDataMap.set(line.id, line.data);
            }
        }
    }

    const entries = [];
    const signatureParts = [];
    let pointCount = 0;

    for (const fillDef of indicatorFills) {
        const { plot1_id, plot2_id } = fillDef;
        const scope = fillDef.indicatorId || "";
        const data1 = plotDataMap.get(`${scope}:${plot1_id}`) || (!scope ? plotDataMap.get(plot1_id) : null);
        const data2 = plotDataMap.get(`${scope}:${plot2_id}`) || (!scope ? plotDataMap.get(plot2_id) : null);
        if (!data1 || !data2 || data1.length === 0 || data2.length === 0) continue;

        const map1 = new Map();
        const map2 = new Map();
        for (const d of data1) {
            if (d?.time != null && d?.value != null && isFinite(d.value)) map1.set(d.time, d.value);
        }
        for (const d of data2) {
            if (d?.time != null && d?.value != null && isFinite(d.value)) map2.set(d.time, d.value);
        }

        const times = [];
        for (const t of map1.keys()) {
            if (map2.has(t)) times.push(t);
        }
        times.sort((a, b) => a - b);
        if (times.length === 0) continue;

        const upperData = times.map((t) => ({
            time: t,
            value: Math.max(map1.get(t), map2.get(t)),
        }));
        const lowerData = times.map((t) => ({
            time: t,
            value: Math.min(map1.get(t), map2.get(t)),
        }));
        const fillColor = fillDef.color || "rgba(59,130,246,0.1)";

        entries.push({ fillColor, backgroundColor, upperData, lowerData });
        pointCount += upperData.length + lowerData.length;
        signatureParts.push([
            scope,
            plot1_id,
            plot2_id,
            fillColor,
            backgroundColor,
            lineDataSignature(upperData),
            lineDataSignature(lowerData),
        ].join("|"));
    }

    return {
        entries,
        signature: signatureParts.length ? signatureParts.join("||") : "empty",
        matchedFillCount: entries.length,
        pointCount,
    };
}

/* ── Component ─────────────────────────────────────────────── */

/* ── Price scale mode constants ────────────────────────────── */
const PRICE_SCALE_MODES = [
    { value: 0, label: "常规", labelEn: "Regular" },
    { value: 1, label: "对数", labelEn: "Logarithmic" },
    { value: 2, label: "百分比", labelEn: "Percentage" },
    { value: 3, label: "基准100", labelEn: "Indexed to 100" },
];

const PASSIVE_CURSOR_TOOL_IDS = new Set(["cursor-default", "cursor-crosshair", "cursor-dot", "cursor-highlighter", "cursor-plain"]);
const CUSTOM_POINTER_TOOL_IDS = new Set(["cursor-dot", "cursor-highlighter"]);
const HIDDEN_CROSSHAIR_TOOL_IDS = new Set(["cursor-dot", "cursor-highlighter", "cursor-plain"]);

function getCursorStyleForTool(tool) {
    if (!tool) return "default";
    if (PASSIVE_CURSOR_TOOL_IDS.has(tool)) {
        if (tool === "cursor-crosshair") return "crosshair";
        if (CUSTOM_POINTER_TOOL_IDS.has(tool)) return "none";
        return "default";
    }
    return "crosshair";
}

function getCustomPointerClass(tool) {
    if (tool === "cursor-dot") return "chart-pane-cursor-dot";
    if (tool === "cursor-highlighter") return "chart-pane-cursor-highlighter";
    return "";
}

function shouldShowCrosshairDetails(tool) {
    return !HIDDEN_CROSSHAIR_TOOL_IDS.has(tool);
}

function shouldShowIndicatorCrosshairMarker(lineConfig, tool) {
    return lineConfig?.type !== "histogram" && shouldShowCrosshairDetails(tool);
}

const ChartPane = forwardRef(function ChartPane({
    symbol,
    drawingKeyBase,
    paneId,
    paneType = "main",       // "main" | "sub"
    paneLabel = "",           // e.g. "RSI(14)" — shown as watermark or label
    data,                     // OHLCV data (main pane) or null (sub panes get data via indicator lines)
    datasetKey,               // incremented on symbol/interval change — triggers full reset
    timeAlignment,            // full time array from main chart data for crosshair alignment
    indicatorLines = [],      // [{data, color, lineWidth, lineStyle, type, colorData, name}]
    showTimeScale = true,     // only the bottom-most pane shows time axis
    // Chart appearance
    upColor, downColor, theme, customBg, timezone, interval,
    // Price scale inversion (main pane only)
    invertScale = false,
    onInvertScaleChange,
    // Price scale mode (main pane only): 0=Normal, 1=Logarithmic, 2=Percentage, 3=IndexedTo100
    priceScaleMode = 0,
    onPriceScaleModeChange,
    // Drawing props
    drawingTool,
    onDrawingToolChange,
    penColor,
    penSize,
    textFontSize,
    textBold,
    textItalic,
    fibLevels,
    fibInverted,
    positionSize,
    drawingSnapEnabled = true,
    // Selection style sync (main pane only): called when the currently
    // selected drawing changes so the global toolbar can mirror its style.
    onSelectedDrawingChange,
    // Sync callbacks (called by this pane, handled by parent)
    onVisibleLogicalRangeChange,
    onCrosshairMove: onCrosshairMoveExternal,
    onCrosshairSync,          // called with {time, point} for cross-pane sync
    onChartCreated,           // called after chart+series are created
    // Extended Pyne drawing outputs (already filtered to this pane by parent)
    indicatorMarkers = [],    // [{data: [{time, position, color, shape, text}], indicatorId}]
    indicatorFills = [],      // [{plot1_id, plot2_id, color, indicatorId}]
    indicatorHlines = [],     // [{price, title, color, linestyle, indicatorId}]
    indicatorBgcolors = [],   // [{data: [{time, color}], indicatorId}]
    indicatorBarcolors = [],  // [{data: [{time, color}], indicatorId}]
}, ref) {
    const paneRootRef = useRef(null);
    const containerRef = useRef(null);
    const cursorOverlayRef = useRef(null);
    const chartRef = useRef(null);
    const mainSeriesRef = useRef(null);      // CandlestickSeries (main pane only)
    const alignmentSeriesRef = useRef(null); // invisible series for crosshair alignment (sub panes)
    const drawingAnchorSeriesRef = useRef(null); // dynamic ref: first indicator series for drawing (sub panes)
    const indicatorSeriesRef = useRef([]);   // [{series, lineConfig}]
    const prevDataRef = useRef({ length: 0, first: null, last: null });
    const prevDatasetKeyRef = useRef(null);  // track datasetKey for reset detection
    const isSyncingRef = useRef(false);      // prevent sync loops
    const [seriesReady, setSeriesReady] = useState(0);
    const drawingSeriesRef = paneType === "main" ? mainSeriesRef : drawingAnchorSeriesRef;
    const chartAdapter = useMemo(
        () => createLightweightChartAdapter({ chartRef, seriesRef: drawingSeriesRef }),
        [drawingSeriesRef],
    );

    /* ── Auto-scale state ──────────────────────────────────── */
    const [isAutoScale, setIsAutoScale] = useState(true);
    const autoScaleRef = useRef(true);       // mirror for event handlers

    const resetAutoScale = useCallback(() => {
        const chart = chartRef.current;
        if (!chart) return;
        try {
            chart.priceScale("right").applyOptions({ autoScale: true });
        } catch { /* */ }
        autoScaleRef.current = true;
        setIsAutoScale(true);
    }, []);

    /* ── Create chart ──────────────────────────────────────── */

    useEffect(() => {
        if (!containerRef.current) return;
        const lifecycle = createChartPaneLifecycle({
            container: containerRef.current,
            paneId,
            paneType,
            theme,
            customBg,
            timezone,
            interval,
            showTimeScale,
            upColor,
            downColor,
            chartAdapter,
            refs: {
                chartRef,
                mainSeriesRef,
                alignmentSeriesRef,
                drawingAnchorSeriesRef,
                indicatorSeriesRef,
                isSyncingRef,
                autoScaleRef,
            },
            handlers: {
                onChartCreated,
                onCrosshairMoveExternal,
                onCrosshairSync,
                onVisibleLogicalRangeChange,
                setContextMenu,
                setIsAutoScale,
                setSeriesReady,
            },
        });

        return lifecycle.dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chart instance is created once; runtime option changes are applied by follow-up effects.
    }, []); // created once

    /* ── Update theme / appearance ─────────────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        applyChartPaneAppearance(chart, { theme, customBg, timezone, interval });
    }, [theme, customBg, timezone, interval]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.applyOptions({
            crosshair: buildCrosshairOptions(shouldShowCrosshairDetails(drawingTool)),
        });
    }, [drawingTool]);

    useEffect(() => {
        const container = containerRef.current;
        const overlay = cursorOverlayRef.current;
        if (!container || !overlay || !CUSTOM_POINTER_TOOL_IDS.has(drawingTool)) {
            if (overlay) overlay.style.display = "none";
            return undefined;
        }

        const updateCursor = (event) => {
            if (event.touches) return;
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

        container.addEventListener("mousemove", updateCursor);
        container.addEventListener("mouseenter", updateCursor);
        container.addEventListener("mouseleave", hideCursor);

        return () => {
            hideCursor();
            container.removeEventListener("mousemove", updateCursor);
            container.removeEventListener("mouseenter", updateCursor);
            container.removeEventListener("mouseleave", hideCursor);
        };
    }, [drawingTool]);

    /* ── Update candle colors (main pane only) ─────────────── */

    useEffect(() => {
        if (paneType !== "main" || !mainSeriesRef.current) return;
        mainSeriesRef.current.applyOptions({
            upColor, downColor,
            borderDownColor: downColor, borderUpColor: upColor,
            wickDownColor: downColor, wickUpColor: upColor,
        });
    }, [upColor, downColor, paneType]);

    /* ── Update candle data (main pane) ────────────────────── */

    // Reset tracking state when datasetKey changes (symbol or interval switch).
    // This ensures the first data load after a switch ALWAYS triggers a full
    // setData() + auto-scale reset, preventing stale Y-axis ranges.
    useEffect(() => {
        if (paneType !== "main") return;
        if (prevDatasetKeyRef.current !== null && prevDatasetKeyRef.current !== datasetKey) {
            // Dataset changed — reset tracking and clear old series data
            prevDataRef.current = { length: 0, first: null, last: null };

            // Clear stale candle data from the series immediately so the old
            // price range doesn't persist on the Y-axis during the transition.
            if (mainSeriesRef.current) {
                try {
                    isSyncingRef.current = true;
                    mainSeriesRef.current.setData([]);
                } catch { /* */ } finally {
                    isSyncingRef.current = false;
                }
            }

            // Force auto-scale back on so the Y-axis adapts to the new data
            const chart = chartRef.current;
            if (chart) {
                try {
                    chart.priceScale("right").applyOptions({ autoScale: true });
                } catch { /* */ }
            }
            autoScaleRef.current = true;
            setIsAutoScale(true);
        }
        prevDatasetKeyRef.current = datasetKey;
    }, [datasetKey, paneType]);

    useEffect(() => {
        if (paneType !== "main" || !mainSeriesRef.current || !data?.length) return;

        const prev = prevDataRef.current;
        const first = data[0].time;
        const last = data[data.length - 1].time;

        // A normal trailing update/append occurs if:
        // 1. Array length is same (update to current bar) OR length increased by 1 (new bar added)
        // 2. The first item's time hasn't changed
        // 3. The time of the element at the OLD last index matches the old last time.
        // If these don't hold, it means data was inserted in the middle or left, so we must full replace.
        const isNormalTrailingUpdate =
            prev.length > 0 &&
            data.length >= prev.length &&
            data.length <= prev.length + 1 &&
            data[0].time === prev.first &&
            data[prev.length - 1].time === prev.last;

        const shouldFullReplace = !isNormalTrailingUpdate;

        // Capture the user's current time-based visible range BEFORE setData,
        // so that left-prepend backfills (drag into blank area) don't shift
        // the visible window. lightweight-charts' setData() resets/reinterprets
        // the logical range; restoring by time keeps the same bars in view
        // regardless of how many bars were prepended on the left.
        // Skip on first load (prev.length === 0) to preserve the saved-range
        // restoration path in MultiPaneChart.
        const chart = chartRef.current;
        let prevTimeRange = null;
        if (shouldFullReplace && prev.length > 0 && chart) {
            try {
                prevTimeRange = chart.timeScale().getVisibleRange();
            } catch { /* */ }
        }

        try {
            isSyncingRef.current = true;
            if (shouldFullReplace) {
                const deduped = [];
                const seen = new Set();
                for (const d of data) {
                    if (!seen.has(d.time)) { seen.add(d.time); deduped.push(d); }
                }
                deduped.sort((a, b) => a.time - b.time);
                mainSeriesRef.current.setData(deduped.map(toCandlePoint));
                recordPerfEvent("chart.candleSeries.setData", {
                    paneId,
                    reason: prev.length > 0 ? "full-replace" : "initial",
                    points: deduped.length,
                });

                // Restore the pre-setData time window so the chart doesn't
                // visually jump after a left-side backfill prepend. Kept
                // inside the isSyncingRef guard so the resulting logical
                // range event does NOT propagate to MultiPaneChart (which
                // would otherwise re-trigger onNeedMoreLeft / save the
                // shifted range).
                if (prevTimeRange
                    && Number.isFinite(prevTimeRange.from)
                    && Number.isFinite(prevTimeRange.to)) {
                    try {
                        chart.timeScale().setVisibleRange(prevTimeRange);
                    } catch { /* range may be out of bounds; ignore */ }
                }
            } else {
                const start = Math.max(0, prev.length - 1);
                for (let i = start; i < data.length; i++) {
                    mainSeriesRef.current.update(toCandlePoint(data[i]));
                }
                recordPerfEvent("chart.candleSeries.update", {
                    paneId,
                    points: data.length - start,
                    totalPoints: data.length,
                });
            }
        } catch (err) {
            console.error("ChartPane candle setData error:", err);
        } finally {
            isSyncingRef.current = false;
        }

        prevDataRef.current = { length: data.length, first, last };
    }, [data, paneId, paneType]);

    /* ── Update alignment series data (sub panes) ─────────── */

    useEffect(() => {
        if (paneType !== "sub" || !alignmentSeriesRef.current || !timeAlignment?.length) return;
        try {
            isSyncingRef.current = true;
            // Set whitespace data covering the full time range of the main chart.
            // Using value:0 with an invisible series ensures time→logical mapping
            // is identical across all panes.
            const alignData = timeAlignment.map((t) => ({ time: t, value: 0 }));
            alignmentSeriesRef.current.setData(alignData);
        } catch (err) {
            console.warn("ChartPane: failed to set alignment series data:", err);
        } finally {
            isSyncingRef.current = false;
        }
    }, [timeAlignment, paneType]);

    /* ── Update price scale inversion (main pane only) ─────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart || paneType !== "main") return;
        try {
            chart.priceScale("right").applyOptions({ invertScale: !!invertScale });
        } catch { /* */ }
    }, [invertScale, paneType]);

    /* ── Update price scale mode (main pane only) ──────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart || paneType !== "main") return;
        try {
            chart.priceScale("right").applyOptions({ mode: priceScaleMode });
        } catch { /* */ }
    }, [priceScaleMode, paneType]);

    /* ── Right-click context menu state (main pane only) ───── */
    const [contextMenu, setContextMenu] = useState(null); // { x, y } or null

    // Close context menu on outside click or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const handleClick = () => setContextMenu(null);
        const handleKey = (e) => { if (e.key === "Escape") setContextMenu(null); };
        // Use setTimeout to avoid the same click that opened the menu from closing it
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

    /* ── Update time scale visibility ──────────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.applyOptions({ timeScale: { visible: showTimeScale } });
    }, [showTimeScale]);

    /* ── Render indicator lines ────────────────────────────── */

    // Track previous indicator line identity to detect structural changes
    const prevIndicatorKeyRef = useRef("");

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        // Build a structural key: how many lines, their names/types/colors
        // If this hasn't changed, we only need to update data, not recreate series.
        const structuralKey = (indicatorLines || [])
            .map((l) => `${l.name || ""}:${l.type || "line"}:${l.color || ""}`)
            .join("|");

        const structureChanged = structuralKey !== prevIndicatorKeyRef.current;
        prevIndicatorKeyRef.current = structuralKey;

        if (!structureChanged && indicatorSeriesRef.current.length > 0) {
            // Structure is the same — just update data in-place (fast path)
            const lines = indicatorLines || [];
            for (let idx = 0; idx < indicatorSeriesRef.current.length; idx++) {
                const { series } = indicatorSeriesRef.current[idx];
                const line = lines[idx];
                if (!line || !line.data || line.data.length === 0) continue;

                try {
                    const isHistogram = line.type === "histogram";
                    if (!isHistogram) {
                        series.applyOptions({
                            crosshairMarkerVisible: shouldShowIndicatorCrosshairMarker(line, drawingTool),
                        });
                    }

                    const validData = normalizeLineSeriesData(line);

                    if (validData.length > 0) {
                        isSyncingRef.current = true;
                        try {
                            applyLineSeriesData(
                                series,
                                validData,
                                indicatorSeriesRef.current[idx].data,
                                {
                                    paneId,
                                    line: line.name || line.id || idx,
                                    type: line.type || "line",
                                    path: "fast",
                                },
                            );
                        } finally {
                            isSyncingRef.current = false;
                        }
                    }

                    // Update lineConfig ref
                    indicatorSeriesRef.current[idx].lineConfig = line;
                    indicatorSeriesRef.current[idx].data = validData;
                } catch (err) {
                    console.warn("ChartPane: failed to update indicator series data:", err);
                }
            }

            // Ensure drawing anchor is set (covers first-time indicator arrival)
            if (paneType === "sub" && !drawingAnchorSeriesRef.current && indicatorSeriesRef.current.length > 0) {
                drawingAnchorSeriesRef.current = indicatorSeriesRef.current[0].series;
                setSeriesReady((prev) => prev + 1);
            }
            return;
        }

        // Structure changed — full rebuild
        // Remove old indicator series
        const removedSeriesCount = removeSeriesEntries(chart, indicatorSeriesRef.current);
        if (removedSeriesCount > 0) {
            recordPerfEvent("chart.indicatorSeries.remove", {
                paneId,
                reason: "rebuild",
                series: removedSeriesCount,
            });
        }
        indicatorSeriesRef.current = [];

        if (!indicatorLines || indicatorLines.length === 0) {
            // No indicator lines left — clear drawing anchor
            if (paneType === "sub") {
                drawingAnchorSeriesRef.current = null;
            }
            return;
        }

        for (const line of indicatorLines) {
            if (!line.data || line.data.length === 0) continue;

            try {
                const series = createIndicatorSeries(chart, line, {
                    crosshairMarkerVisible: shouldShowIndicatorCrosshairMarker(line, drawingTool),
                });
                recordPerfEvent("chart.indicatorSeries.create", {
                    paneId,
                    line: line.name || line.id || indicatorSeriesRef.current.length,
                    type: line.type || "line",
                    path: "rebuild",
                });

                const validData = normalizeLineSeriesData(line);

                if (validData.length > 0) {
                    isSyncingRef.current = true;
                    try {
                        series.setData(validData);
                        recordPerfEvent("chart.indicatorSeries.setData", {
                            paneId,
                            line: line.name || line.id || indicatorSeriesRef.current.length,
                            type: line.type || "line",
                            path: "rebuild",
                            points: validData.length,
                        });
                    } finally {
                        isSyncingRef.current = false;
                    }
                }

                indicatorSeriesRef.current.push({ series, lineConfig: line, data: validData });
            } catch (err) {
                console.warn("ChartPane: failed to add indicator series:", err);
            }
        }

        // Update drawing anchor to the first indicator series for sub-pane drawings.
        // This ensures coordinate mapping uses the indicator's actual price range,
        // so drawings maintain stable positions across timeframe switches.
        if (paneType === "sub" && indicatorSeriesRef.current.length > 0) {
            const newAnchor = indicatorSeriesRef.current[0].series;
            if (drawingAnchorSeriesRef.current !== newAnchor) {
                drawingAnchorSeriesRef.current = newAnchor;
                setSeriesReady((prev) => prev + 1); // trigger re-attachment in useDrawing
            }
        }
    }, [indicatorLines, paneId, paneType, drawingTool]);

    /* ── Apply indicator markers ───────────────────────────── */
    // Lightweight Charts supports setMarkers() on any series.
    // Main pane uses the candle series; sub panes use the first indicator series.
    const markerTargetRef = useRef(null);
    const markerStateRef = useRef({ target: null, state: "unknown" });

    useEffect(() => {
        const targetSeries = paneType === "main"
            ? mainSeriesRef.current
            : drawingAnchorSeriesRef.current;
        renderMarkers({
            targetSeries,
            indicatorMarkers,
            markerTargetRef,
            markerStateRef,
            paneId,
            recordPerfEvent,
            onError: (err) => console.warn("ChartPane: failed to set markers:", err),
        });
    }, [indicatorMarkers, indicatorLines, paneId, paneType]);

    /* ── Apply hlines (horizontal price lines) ─────────────── */
    // We use createPriceLine() on the pane's anchor series for each hline.
    const hlinesRef = useRef([]); // track created price line objects
    const hlinesStateRef = useRef({ target: null, signature: "unknown" });

    useEffect(() => {
        const series = paneType === "main"
            ? mainSeriesRef.current
            : drawingAnchorSeriesRef.current;
        renderHlines({
            series,
            indicatorHlines,
            hlinesRef,
            hlinesStateRef,
            paneId,
            recordPerfEvent,
            onError: (err) => console.warn("ChartPane: failed to create hline:", err),
        });
    }, [indicatorHlines, paneId, paneType, seriesReady]);

    /* ── Apply barcolors (per-bar candle coloring) ─────────── */
    // Lightweight Charts CandlestickSeries doesn't support per-bar color
    // via setData natively, but we can do it by re-setting data with color
    // fields. We rebuild candle data with color overrides when barcolors change.
    const prevBarcoloredDataRef = useRef([]);

    useEffect(() => {
        if (paneType !== "main") return;
        applyBarColors({
            series: mainSeriesRef.current,
            data,
            indicatorBarcolors,
            prevBarcoloredDataRef,
            isSyncingRef,
            paneId,
            recordPerfEvent,
            toCandlePoint,
            canUseTrailingCandleUpdate,
            onError: (err, phase) => console.warn(
                phase === "clear"
                    ? "ChartPane: failed to clear barcolors:"
                    : "ChartPane: failed to apply barcolors:",
                err,
            ),
        });
    }, [indicatorBarcolors, data, paneId, paneType]);

    /* ── Apply fill() between two indicator lines ─────────── */
    // Lightweight Charts doesn't have a native "area between two lines" API.
    // We approximate fill by creating an invisible AreaSeries that renders
    // the shaded region between the two plot lines' data by using the
    // topColor/bottomColor of two stacked area series.
    //
    // Approach: For each fill(plot1, plot2), we create TWO area series:
    //   1. Upper area (plot1 data) with filled color above baseline
    //   2. Lower area (plot2 data) that masks/clips the fill
    // Actually the simplest correct approach for lightweight-charts:
    //   - We find plot1 and plot2 data arrays, compute the band between
    //     them, and render it as a single area series with lineColor
    //     transparent and topColor/bottomColor set to the fill color.
    //
    // Simpler approach used here: Create an area series between the two
    // lines by setting one as `value` and the other as `lineBase`. But
    // lightweight-charts AreaSeries doesn't support dynamic lineBase.
    //
    // Final practical approach: We use TWO stacked area series:
    //   - areaUpper: value = max(plot1, plot2), lineColor transparent
    //   - areaLower: value = min(plot1, plot2), fills the gap
    // This creates a visual band effect.

    const fillSeriesRef = useRef([]); // track fill area series
    const fillSeriesStateRef = useRef({ chart: null, signature: "unknown" });

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
        const fillPayload = buildFillRenderEntries(indicatorFills, indicatorLines, bgColor);
        renderFillSeries({
            chart,
            fillPayload,
            fillSeriesRef,
            fillSeriesStateRef,
            paneId,
            definitionsCount: indicatorFills?.length || 0,
            recordPerfEvent,
            onError: (err) => console.warn("ChartPane: failed to create fill area:", err),
        });
    }, [indicatorFills, indicatorLines, paneId, theme, customBg]);

    /* ── Apply bgcolors (background color regions) ─────────── */
    // We render bgcolor using a HistogramSeries with very large values to
    // simulate background coloring. The bars are drawn behind other series.
    //
    // Alternative approach: We use an invisible AreaSeries with the fill
    // color, plotted at a very high value to cover the visible area.
    //
    // Practical approach used here: We create colored rectangular overlays
    // using a canvas element positioned over the chart, redrawing on scroll.

    const bgCanvasRef = useRef(null);
    const bgAnimFrameRef = useRef(null);

    useEffect(() => {
        return renderBgcolorOverlay({
            chart: chartRef.current,
            container: containerRef.current,
            indicatorBgcolors,
            bgCanvasRef,
            bgAnimFrameRef,
            paneId,
            recordPerfEvent,
        });
    }, [indicatorBgcolors, paneId]);

    /* ── Drawing state and hooks ───────────────────────────── */

    const drawingKey = paneType === "main"
        ? (drawingKeyBase || symbol)
        : `${drawingKeyBase || symbol}__${paneId}`;

    const drawingApiRef = useRef(null);
    const drawingsHiddenRef = useRef(false);
    const [DrawingEngineHost, setDrawingEngineHost] = useState(null);
    const drawingAnchorReady = paneType === "main"
        ? !!mainSeriesRef.current
        : !!drawingAnchorSeriesRef.current;
    const shouldMountDrawingEngine =
        seriesReady > 0 &&
        drawingAnchorReady &&
        shouldLoadDrawingEngine({ activeTool: drawingTool, drawingKey });

    useEffect(() => {
        if (DrawingEngineHost || seriesReady <= 0 || !drawingAnchorReady) return undefined;

        let cancelled = false;
        const startPreload = () => {
            if (cancelled) return;
            preloadDrawingEngineHost();
        };

        if (typeof window.requestIdleCallback === "function") {
            const idleId = window.requestIdleCallback(startPreload, { timeout: 1000 });
            return () => {
                cancelled = true;
                window.cancelIdleCallback?.(idleId);
            };
        }

        const timerId = window.setTimeout(startPreload, 250);
        return () => {
            cancelled = true;
            window.clearTimeout(timerId);
        };
    }, [DrawingEngineHost, drawingAnchorReady, seriesReady]);

    useEffect(() => {
        if (!shouldMountDrawingEngine || DrawingEngineHost) return undefined;
        let cancelled = false;
        loadDrawingEngineHost().then((module) => {
            if (!cancelled) setDrawingEngineHost(() => module.default);
        });
        return () => {
            cancelled = true;
        };
    }, [DrawingEngineHost, shouldMountDrawingEngine]);

    const handleDrawingApiChange = useCallback((api) => {
        drawingApiRef.current = api;
        if (api) api.setHidden?.(drawingsHiddenRef.current);
    }, []);

    const clearAllDrawings = useCallback(() => {
        if (drawingApiRef.current?.clearAll) {
            drawingApiRef.current.clearAll();
        } else {
            clearSavedDrawings(drawingKey);
            onSelectedDrawingChange?.(null);
        }
    }, [drawingKey, onSelectedDrawingChange]);

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

    /* ── Imperative handle ─────────────────────────────────── */

    useImperativeHandle(ref, () => buildChartPaneImperativeHandle({
        paneId,
        paneType,
        paneRootRef,
        containerRef,
        chartRef,
        alignmentSeriesRef,
        mainSeriesRef,
        indicatorSeriesRef,
        isSyncingRef,
        clearAllDrawings,
        setDrawingsHidden,
        updateSelectedDrawingStyle,
        prepareDrawingExport,
        resetAutoScale,
    }), [resetAutoScale, clearAllDrawings, setDrawingsHidden, updateSelectedDrawingStyle, prepareDrawingExport, paneId, paneType]);

    return (
        <div ref={paneRootRef} className="chart-pane" data-pane-id={paneId} data-pane-type={paneType}>
            {/* Pane label (for sub panes) */}
            {paneType === "sub" && paneLabel && (
                <div className="chart-pane-label">{paneLabel}</div>
            )}
            <div
                ref={containerRef}
                className="chart-pane-container"
                style={{ cursor: getCursorStyleForTool(drawingTool) }}
            />
            {CUSTOM_POINTER_TOOL_IDS.has(drawingTool) && (
                <div className="chart-pane-cursor-overlay" aria-hidden="true">
                    <div
                        ref={cursorOverlayRef}
                        className={`chart-pane-cursor ${getCustomPointerClass(drawingTool)}`}
                    />
                </div>
            )}

            {DrawingEngineHost && shouldMountDrawingEngine && (
                <DrawingEngineHost
                    key={`${drawingKey}:pointer-events`}
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
                    onApiChange={handleDrawingApiChange}
                    onSelectedDrawingChange={onSelectedDrawingChange}
                />
            )}

            {/* Price scale mode context menu (main pane only) */}
            {paneType === "main" && contextMenu && (
                <div
                    className="price-scale-context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <button
                        className={`price-scale-menu-item${isAutoScale ? " active" : ""}`}
                        onClick={() => {
                            const newAuto = !isAutoScale;
                            try {
                                chartRef.current?.priceScale("right").applyOptions({ autoScale: newAuto });
                            } catch { /* */ }
                            autoScaleRef.current = newAuto;
                            setIsAutoScale(newAuto);
                            setContextMenu(null);
                        }}
                    >
                        <span className="price-scale-menu-check">{isAutoScale ? "✓" : ""}</span>
                        <span>自动缩放</span>
                        <span className="price-scale-menu-label-en">Auto Scale</span>
                    </button>
                    {onInvertScaleChange && (
                        <button
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
                            key={mode.value}
                            className={`price-scale-menu-item${priceScaleMode === mode.value ? " active" : ""}`}
                            onClick={() => {
                                if (onPriceScaleModeChange) onPriceScaleModeChange(mode.value);
                                setContextMenu(null);
                            }}
                        >
                            <span className="price-scale-menu-check">
                                {priceScaleMode === mode.value ? "✓" : ""}
                            </span>
                            <span>{mode.label}</span>
                            <span className="price-scale-menu-label-en">{mode.labelEn}</span>
                        </button>
                    ))}
                </div>
            )}

        </div>
    );
});

export default ChartPane;
