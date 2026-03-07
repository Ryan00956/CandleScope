/**
 * MultiPaneChart — TradingView-style multi-pane chart container.
 *
 * Creates independent chart instances per pane (main + N sub-panes for
 * separate/volume indicators), synchronizes time-axis scrolling and
 * crosshair across all panes, and supports draggable resizers between panes.
 *
 * Drawing tools are applied to the main pane only.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ChartPane from "./ChartPane";
import PaneResizer from "./PaneResizer";
import { useDrawing } from "../hooks/useDrawing";

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;
const DRAWING_TOOL_IDS = new Set(["pen", "eraser", "line-segment", "line-ray", "line-infinite", "text"]);

const PANE_HEIGHTS_KEY = "candlescope-pane-heights";
const MIN_PANE_HEIGHT = 60; // px

function loadPaneHeights() {
    try { return JSON.parse(localStorage.getItem(PANE_HEIGHTS_KEY)) || {}; } catch { return {}; }
}
function savePaneHeights(h) {
    localStorage.setItem(PANE_HEIGHTS_KEY, JSON.stringify(h));
}

/**
 * Build a stable pane config key from indicator IDs so we can persist heights.
 */
function paneConfigKey(subPaneIds) {
    return subPaneIds.sort().join(",");
}

const MultiPaneChart = forwardRef(function MultiPaneChart({
    data,
    symbol,
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
    onVisibleRangeChange = null,
    // Drawing props
    drawingTool = null,
    penColor = "#f59e0b",
    penSize = 2,
    textFontSize = 14,
    textBold = false,
    textItalic = false,
    // Indicator data — computed by useIndicators (multi-pane version)
    // mainOverlayLines: [{data, color, ...}]  — overlay lines for main chart
    // subPanes: [{id, label, lines: [...]}]    — each sub pane with its lines
    mainOverlayLines = [],
    subPanes = [],
    // Callback: fires when main chart is ready, passes refs to parent
    onChartReady = null,
}, ref) {
    const wrapperRef = useRef(null);
    const mainPaneRef = useRef(null);
    const subPaneRefs = useRef(new Map()); // paneId → ref

    // Data refs
    const dataRef = useRef([]);
    const dataMapRef = useRef(new Map());
    const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
    const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
    const requestedOldestRef = useRef(null);
    const userInteractedRef = useRef(false);

    // Visible range persistence
    const savedVisibleRangeRef = useRef(savedVisibleRange);
    const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
    const visibleRangeSaveTimerRef = useRef(null);
    const hasRestoredRangeRef = useRef(false);

    // Crosshair sync — fully imperative (no React state), direct ref calls

    // Pane height ratios (percentage of total)
    // Main pane always exists; sub panes are dynamic
    const [paneHeightPercents, setPaneHeightPercents] = useState(() => {
        // Default: main=70%, sub panes split remaining 30%
        return { main: 70 };
    });

    // ── Track the total container height for px ↔ % conversion ──
    const containerHeightRef = useRef(600);

    // Counter to signal drawing system
    const [seriesReady, setSeriesReady] = useState(0);

    // Refs
    useEffect(() => { dataRef.current = data || []; }, [data]);
    useEffect(() => {
        const map = new Map();
        for (const d of (data || [])) map.set(d.time, d);
        dataMapRef.current = map;
    }, [data]);
    useEffect(() => { onNeedMoreLeftRef.current = onNeedMoreLeft; }, [onNeedMoreLeft]);
    useEffect(() => { canLoadMoreLeftRef.current = canLoadMoreLeft; }, [canLoadMoreLeft]);
    useEffect(() => { savedVisibleRangeRef.current = savedVisibleRange; }, [savedVisibleRange]);
    useEffect(() => { onVisibleRangeChangeRef.current = onVisibleRangeChange; }, [onVisibleRangeChange]);

    // Reset on dataset change
    useEffect(() => {
        requestedOldestRef.current = null;
        userInteractedRef.current = false;
        hasRestoredRangeRef.current = false;
        if (visibleRangeSaveTimerRef.current) {
            clearTimeout(visibleRangeSaveTimerRef.current);
            visibleRangeSaveTimerRef.current = null;
        }
    }, [datasetKey]);

    // ── Compute pane height percentages when subPanes change ──
    useEffect(() => {
        const subCount = subPanes.length;
        if (subCount === 0) {
            setPaneHeightPercents({ main: 100 });
            return;
        }

        // Try to load saved heights
        const saved = loadPaneHeights();
        const key = paneConfigKey(subPanes.map((p) => p.id));
        if (saved[key]) {
            setPaneHeightPercents(saved[key]);
            return;
        }

        // Default distribution: main 65%, sub panes split the rest
        const subHeight = 35 / subCount;
        const heights = { main: 65 };
        for (const p of subPanes) {
            heights[p.id] = subHeight;
        }
        setPaneHeightPercents(heights);
    }, [subPanes.length, subPanes.map((p) => p.id).join(",")]);

    // ── Measure container height ──
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const ro = new ResizeObserver((entries) => {
            containerHeightRef.current = entries[0].contentRect.height;
        });
        ro.observe(wrapper);
        return () => ro.disconnect();
    }, []);

    // ── Drawing tools (main pane only) ──
    const mainChartRef = useRef(null);  // will be set to main pane's chartRef
    const mainSeriesRef = useRef(null); // will be set to main pane's seriesRef
    const mainContainerRef = useRef(null);

    const {
        clearAll,
        editingTextId,
        editingTextValue,
        editingTextPos,
        setEditingTextValue,
        commitTextEditing,
        cancelTextEditing,
        editInputRef,
    } = useDrawing({
        chartRef: mainChartRef,
        seriesRef: mainSeriesRef,
        chartContainerRef: mainContainerRef,
        activeTool: drawingTool,
        penColor,
        penSize,
        textFontSize,
        textBold,
        textItalic,
        symbol,
        seriesReady,
    });

    // ── Expose API via ref ──
    useImperativeHandle(ref, () => ({
        getVisibleRange: () => {
            const mp = mainPaneRef.current;
            if (!mp) return null;
            return mp.getVisibleRange();
        },
        clearAllDrawings: clearAll,
        chartRef: mainChartRef,
        seriesRef: mainSeriesRef,
        seriesReady,
    }), [clearAll, seriesReady]);

    // ── Debounced visible range save ──
    const scheduleVisibleRangeSave = useCallback(() => {
        if (visibleRangeSaveTimerRef.current) clearTimeout(visibleRangeSaveTimerRef.current);
        visibleRangeSaveTimerRef.current = setTimeout(() => {
            const mp = mainPaneRef.current;
            if (!mp || !onVisibleRangeChangeRef.current) return;
            try {
                const range = mp.getVisibleRange();
                if (range?.logical && range?.time) {
                    onVisibleRangeChangeRef.current(range);
                }
            } catch { /* */ }
        }, VISIBLE_RANGE_SAVE_DEBOUNCE_MS);
    }, []);

    // ── Time scale sync: when one pane scrolls, sync all others ──
    const handleVisibleLogicalRangeChange = useCallback(({ paneId: sourcePaneId, range }) => {
        if (!range) return;

        // Mark user interaction
        userInteractedRef.current = true;
        scheduleVisibleRangeSave();

        // Check for need-more-left
        if (onNeedMoreLeftRef.current && canLoadMoreLeftRef.current && range.from <= LEFT_EDGE_TRIGGER_BARS) {
            const currentData = dataRef.current;
            if (currentData?.length > 0) {
                const oldest = currentData[0].time;
                if (requestedOldestRef.current !== oldest) {
                    requestedOldestRef.current = oldest;
                    onNeedMoreLeftRef.current(oldest);
                }
            }
        }

        // Sync all other panes
        if (mainPaneRef.current && sourcePaneId !== "main") {
            mainPaneRef.current.setVisibleLogicalRange(range);
        }
        for (const [id, paneRef] of subPaneRefs.current.entries()) {
            if (id !== sourcePaneId && paneRef) {
                paneRef.setVisibleLogicalRange(range);
            }
        }
    }, [scheduleVisibleRangeSave]);

    // ── Crosshair sync: imperatively sync all other panes (no React state) ──
    const handleCrosshairSync = useCallback(({ paneId: sourcePaneId, time }) => {
        // Sync main pane
        if (sourcePaneId !== "main" && mainPaneRef.current) {
            mainPaneRef.current.syncCrosshair(time);
        }
        // Sync all sub panes
        for (const [id, paneRef] of subPaneRefs.current.entries()) {
            if (id !== sourcePaneId && paneRef) {
                paneRef.syncCrosshair(time);
            }
        }
    }, []);

    // ── Main pane crosshair → OHLCV header display ──
    const handleMainCrosshairMove = useCallback((snapshot) => {
        if (!onCrosshairMove) return;
        if (!snapshot) {
            onCrosshairMove(null);
            return;
        }
        // Enrich with volume from raw data
        const rawItem = dataMapRef.current.get(snapshot.time);
        const volume = rawItem ? rawItem.volume : 0;
        onCrosshairMove({ ...snapshot, volume });
    }, [onCrosshairMove]);

    // ── When main pane chart is created, wire up refs for drawing ──
    const handleMainPaneReady = useCallback((paneRef) => {
        if (!paneRef) return;
        mainPaneRef.current = paneRef;
        // Get the internal chart/series refs for drawing tools
        const cRef = paneRef.getChartRef();
        const sRef = paneRef.getSeriesRef();
        if (cRef) mainChartRef.current = cRef.current;
        if (sRef) mainSeriesRef.current = sRef.current;

        // Set up a mutation-like pattern: we need mainChartRef to be a ref whose .current
        // points to the chart. Since useDrawing expects ref-to-ref pattern:
        mainChartRef.current = cRef?.current || null;
        mainSeriesRef.current = sRef?.current || null;

        setSeriesReady((prev) => prev + 1);

        // Notify parent for indicator system
        if (onChartReady) {
            // Create wrapper refs that always resolve to the pane's chart/series
            const chartRefWrapper = { current: cRef?.current || null };
            const seriesRefWrapper = { current: sRef?.current || null };
            onChartReady({ chartRef: chartRefWrapper, seriesRef: seriesRefWrapper });
        }
    }, [onChartReady]);

    // ── Restore visible range on first data load ──
    useEffect(() => {
        if (!data?.length || hasRestoredRangeRef.current) return;
        if (!mainPaneRef.current) return;

        const rangeToRestore = savedVisibleRangeRef.current;
        let restored = false;

        if (rangeToRestore?.logical) {
            try {
                mainPaneRef.current.setVisibleLogicalRange(rangeToRestore.logical);
                restored = true;
            } catch { /* */ }
        }

        if (!restored) {
            mainPaneRef.current.fitContent();
        }

        hasRestoredRangeRef.current = true;
    }, [data, datasetKey]);

    // ── Resizer logic: redistribute height between pane[i] and pane[i+1] ──
    const handleResize = useCallback((abovePaneId, belowPaneId, deltaY) => {
        const totalHeight = containerHeightRef.current;
        if (totalHeight <= 0) return;
        const deltaPct = (deltaY / totalHeight) * 100;

        setPaneHeightPercents((prev) => {
            const above = (prev[abovePaneId] || 50) + deltaPct;
            const below = (prev[belowPaneId] || 50) - deltaPct;
            const minPct = (MIN_PANE_HEIGHT / totalHeight) * 100;

            if (above < minPct || below < minPct) return prev;
            return { ...prev, [abovePaneId]: above, [belowPaneId]: below };
        });
    }, []);

    const handleResizeEnd = useCallback(() => {
        // Persist heights
        if (subPanes.length > 0) {
            const key = paneConfigKey(subPanes.map((p) => p.id));
            const saved = loadPaneHeights();
            saved[key] = paneHeightPercents;
            savePaneHeights(saved);
        }
    }, [subPanes, paneHeightPercents]);

    // ── Set main pane container ref for drawing ──
    const mainPaneContainerCallback = useCallback((node) => {
        mainContainerRef.current = node;
    }, []);

    // ── Build the ordered list of panes + resizers ──
    const allPaneIds = useMemo(() => {
        const ids = ["main"];
        for (const p of subPanes) ids.push(p.id);
        return ids;
    }, [subPanes]);

    // ── Compute time alignment array for sub-pane crosshair sync ──
    // This is the full sorted/deduplicated list of time values from main chart data.
    // Sub-panes use this to create an invisible alignment series so that
    // setCrosshairPosition maps time→logical identically to the main chart.
    const timeAlignment = useMemo(() => {
        if (!data || data.length === 0) return null;
        const seen = new Set();
        const times = [];
        for (const d of data) {
            if (!seen.has(d.time)) {
                seen.add(d.time);
                times.push(d.time);
            }
        }
        times.sort((a, b) => a - b);
        return times;
    }, [data]);

    // Determine cursor for drawing tools
    const isDrawingActive = DRAWING_TOOL_IDS.has(drawingTool);
    const cursorStyle = isDrawingActive ? "crosshair" : undefined;

    // ── Ref callback for main chart pane element ──
    const mainPaneRefCallback = useCallback((node) => {
        if (node) {
            // The ChartPane ref gives us the imperative handle
            handleMainPaneReady(node);
        }
    }, [handleMainPaneReady]);

    return (
        <div className="chart-area multi-pane-chart" ref={wrapperRef}>
            {/* Main Pane */}
            <div
                className="chart-pane-wrapper"
                style={{ height: `${paneHeightPercents.main || 100}%` }}
                ref={mainPaneContainerCallback}
            >
                <ChartPane
                    ref={mainPaneRefCallback}
                    paneId="main"
                    paneType="main"
                    data={data}
                    indicatorLines={mainOverlayLines}
                    showTimeScale={subPanes.length === 0}
                    upColor={upColor}
                    downColor={downColor}
                    theme={theme}
                    customBg={customBg}
                    timezone={timezone}
                    interval={interval}
                    onVisibleLogicalRangeChange={handleVisibleLogicalRangeChange}
                    onCrosshairMove={handleMainCrosshairMove}
                    onCrosshairSync={handleCrosshairSync}
                />
                {cursorStyle && (
                    <div className="chart-pane-cursor-overlay" style={{ cursor: cursorStyle }} />
                )}
            </div>

            {/* Sub Panes with Resizers */}
            {subPanes.map((subPane, idx) => {
                const abovePaneId = idx === 0 ? "main" : subPanes[idx - 1].id;
                const isLast = idx === subPanes.length - 1;
                const heightPct = paneHeightPercents[subPane.id] || (35 / subPanes.length);

                return (
                    <div key={subPane.id} style={{ display: "contents" }}>
                        {/* Resizer between above pane and this pane */}
                        <PaneResizer
                            onResize={(deltaY) => handleResize(abovePaneId, subPane.id, deltaY)}
                            onResizeEnd={handleResizeEnd}
                        />
                        <div
                            className="chart-pane-wrapper"
                            style={{ height: `${heightPct}%` }}
                        >
                            <ChartPane
                                ref={(node) => {
                                    if (node) subPaneRefs.current.set(subPane.id, node);
                                    else subPaneRefs.current.delete(subPane.id);
                                }}
                                paneId={subPane.id}
                                paneType="sub"
                                paneLabel={subPane.label}
                                timeAlignment={timeAlignment}
                                indicatorLines={subPane.lines}
                                showTimeScale={isLast}
                                theme={theme}
                                customBg={customBg}
                                timezone={timezone}
                                interval={interval}
                                onVisibleLogicalRangeChange={handleVisibleLogicalRangeChange}
                                onCrosshairSync={handleCrosshairSync}
                            />
                        </div>
                    </div>
                );
            })}

            {/* Inline text editor overlay (drawing) */}
            {editingTextId && editingTextPos && (
                <div
                    className="text-edit-overlay"
                    style={{ position: "absolute", left: editingTextPos.x, top: editingTextPos.y, zIndex: 100 }}
                >
                    <input
                        ref={editInputRef}
                        className="text-edit-input"
                        type="text"
                        value={editingTextValue}
                        onChange={(e) => setEditingTextValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitTextEditing(); }
                            if (e.key === "Escape") { e.preventDefault(); cancelTextEditing(); }
                        }}
                        onBlur={() => commitTextEditing()}
                        style={{
                            fontSize: textFontSize,
                            fontWeight: textBold ? "bold" : "normal",
                            fontStyle: textItalic ? "italic" : "normal",
                            color: penColor,
                        }}
                    />
                </div>
            )}

            {/* Loading overlay */}
            {loading && (
                <div className="loading-overlay">
                    <div className="loading-spinner" />
                    <span className="loading-text">Loading {symbol} {interval} klines...</span>
                </div>
            )}
        </div>
    );
});

export default MultiPaneChart;
