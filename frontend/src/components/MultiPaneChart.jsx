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
import { clearSavedDrawings } from "../services/drawingStorage";

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;
const DRAWING_TOOL_IDS = new Set(["pen", "eraser", "line-segment", "line-ray", "line-infinite", "text", "position-long", "position-short"]);

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
    fibLevels,
    fibInverted = false,
    positionSize = 1000,
    // Indicator data — computed by useIndicators (multi-pane version)
    // mainOverlayLines: [{data, color, ...}]  — overlay lines for main chart
    // subPanes: [{id, label, lines: [...]}]    — each sub pane with its lines
    mainOverlayLines = [],
    subPanes = [],
    // Extended Pyne drawing outputs
    indicatorMarkers = [],
    indicatorFills = [],
    indicatorHlines = [],
    indicatorBgcolors = [],
    indicatorBarcolors = [],
    // Price scale inversion (main pane only)
    invertScale = false,
    onInvertScaleChange,
    // Price scale mode (main pane only): 0=Normal, 1=Logarithmic, 2=Percentage, 3=IndexedTo100
    priceScaleMode = 0,
    onPriceScaleModeChange,
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

    const markUserInteracted = useCallback(() => {
        userInteractedRef.current = true;
    }, []);

    const syncLogicalRangeAcrossPanes = useCallback((range, sourcePaneId = null) => {
        if (!range) return;

        if (mainPaneRef.current && sourcePaneId !== "main") {
            mainPaneRef.current.setVisibleLogicalRange(range);
        }
        for (const [id, paneRef] of subPaneRefs.current.entries()) {
            if (id !== sourcePaneId && paneRef) {
                paneRef.setVisibleLogicalRange(range);
            }
        }
    }, []);

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

        userInteractedRef.current = false;
        hasRestoredRangeRef.current = false;
        if (visibleRangeSaveTimerRef.current) {
            clearTimeout(visibleRangeSaveTimerRef.current);
            visibleRangeSaveTimerRef.current = null;
        }
    }, [datasetKey]);

    // ── Clean up localStorage drawings when sub-panes are removed ──
    const prevSubPaneIdsRef = useRef(new Set());

    useEffect(() => {
        const currentIds = new Set(subPanes.map((p) => p.id));

        // Find pane IDs that existed before but are now gone
        for (const prevId of prevSubPaneIdsRef.current) {
            if (!currentIds.has(prevId)) {
                // Sub-pane was removed — clear its orphaned drawing storage
                clearSavedDrawings(`${symbol}__${prevId}`);
            }
        }

        prevSubPaneIdsRef.current = currentIds;
    }, [subPanes, symbol]);

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        wrapper.addEventListener("wheel", markUserInteracted, { passive: true });
        wrapper.addEventListener("mousedown", markUserInteracted);
        wrapper.addEventListener("touchstart", markUserInteracted, { passive: true });

        return () => {
            wrapper.removeEventListener("wheel", markUserInteracted);
            wrapper.removeEventListener("mousedown", markUserInteracted);
            wrapper.removeEventListener("touchstart", markUserInteracted);
        };
    }, [markUserInteracted]);

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

    // ── Ensure sub-panes inherit the current visible range after data changes ──
    useEffect(() => {
        if (!mainPaneRef.current || subPanes.length === 0) return;
        // Schedule sync to allow new chart panes to finish initializing and auto-fitting
        const handle = setTimeout(() => {
            const range = mainPaneRef.current.getVisibleLogicalRange?.();
            if (range) {
                syncLogicalRangeAcrossPanes(range, "main");
            }
        }, 50);
        return () => clearTimeout(handle);
    }, [subPanes, timeAlignment, datasetKey, syncLogicalRangeAcrossPanes]);

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

    // Counter to signal series creation (already declared)

    // ── Expose API via ref ──
    useImperativeHandle(ref, () => ({
        getVisibleRange: () => {
            const mp = mainPaneRef.current;
            if (!mp) return null;
            return mp.getVisibleRange();
        },
        clearAllDrawings: () => {
            if (mainPaneRef.current?.clearAllDrawings) {
                mainPaneRef.current.clearAllDrawings();
            }
            for (const subPane of subPaneRefs.current.values()) {
                if (subPane?.clearAllDrawings) {
                    subPane.clearAllDrawings();
                }
            }
        },
        seriesReady,
    }), [seriesReady]);

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

        if (userInteractedRef.current) {
            scheduleVisibleRangeSave();
        }

        // Check for need-more-left
        // NOTE: canLoadMoreLeftRef already prevents concurrent calls
        // (it becomes false when loadingMoreLeft=true), so we don't
        // need an extra dedupe guard based on the oldest time value.
        // Previously a requestedOldestRef guard blocked retrigger when
        // fetchKlinesBefore returned 0 bars (e.g. backfill pending),
        // causing the "drag left doesn't load" bug.
        if (onNeedMoreLeftRef.current && canLoadMoreLeftRef.current && range.from <= LEFT_EDGE_TRIGGER_BARS) {
            const currentData = dataRef.current;
            if (currentData?.length > 0) {
                const oldest = currentData[0].time;
                onNeedMoreLeftRef.current(oldest);
            }
        }

        // Sync all other panes
        syncLogicalRangeAcrossPanes(range, sourcePaneId);
    }, [scheduleVisibleRangeSave, syncLogicalRangeAcrossPanes]);

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
    // This is called via the ref callback (React commit phase), BEFORE
    // the ChartPane useEffect creates the chart. So we only store the
    // imperative handle here; the actual chart/series refs are populated
    // by the onMainChartCreated callback below.
    const handleMainPaneReady = useCallback((paneRef) => {
        if (!paneRef) return;
        mainPaneRef.current = paneRef;
    }, []);

    // ── Called by ChartPane's useEffect AFTER chart + series are created ──
    const onMainChartCreated = useCallback(({ chartRef: cRef, seriesRef: sRef }) => {
        setSeriesReady((prev) => prev + 1);

        // Notify parent for indicator system
        if (onChartReady) {
            onChartReady({ chartRef: cRef, seriesRef: sRef });
        }
    }, [onChartReady]);

    // ── Restore visible range on first data load ──
    useEffect(() => {
        if (!data?.length || hasRestoredRangeRef.current) return;
        if (!mainPaneRef.current) return;

        const rangeToRestore = savedVisibleRangeRef.current;
        let restored = false;

        if (Number.isFinite(rangeToRestore?.barSpacing)) {
            mainPaneRef.current.applyTimeScaleOptions({ barSpacing: rangeToRestore.barSpacing });
        }

        if (rangeToRestore?.time) {
            try {
                mainPaneRef.current.setVisibleTimeRange(rangeToRestore.time);
                restored = true;
            } catch { /* */ }
        }

        if (!restored && rangeToRestore?.logical) {
            try {
                syncLogicalRangeAcrossPanes(rangeToRestore.logical);
                restored = true;
            } catch { /* */ }
        }

        if (Number.isFinite(rangeToRestore?.scrollPosition)) {
            mainPaneRef.current.setScrollPosition(rangeToRestore.scrollPosition, false);
        }

        if (!restored) {
            mainPaneRef.current.fitContent();
        }

        const syncedRange = mainPaneRef.current.getVisibleLogicalRange?.();
        if (syncedRange) {
            syncLogicalRangeAcrossPanes(syncedRange);
        }

        hasRestoredRangeRef.current = true;
    }, [data, datasetKey, syncLogicalRangeAcrossPanes]);

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
                style={{ flex: paneHeightPercents.main || 100 }}
            >
                <ChartPane
                    ref={mainPaneRefCallback}
                    symbol={symbol}
                    paneId="main"
                    paneType="main"
                    data={data}
                    datasetKey={datasetKey}
                    indicatorLines={mainOverlayLines}
                    showTimeScale={subPanes.length === 0}
                    upColor={upColor}
                    downColor={downColor}
                    theme={theme}
                    customBg={customBg}
                    timezone={timezone}
                    interval={interval}
                    invertScale={invertScale}
                    onInvertScaleChange={onInvertScaleChange}
                    priceScaleMode={priceScaleMode}
                    onPriceScaleModeChange={onPriceScaleModeChange}
                    onVisibleLogicalRangeChange={handleVisibleLogicalRangeChange}
                    onCrosshairMove={handleMainCrosshairMove}
                    onCrosshairSync={handleCrosshairSync}
                    onChartCreated={onMainChartCreated}
                    indicatorMarkers={indicatorMarkers}
                    indicatorFills={indicatorFills}
                    indicatorHlines={indicatorHlines}
                    indicatorBgcolors={indicatorBgcolors}
                    indicatorBarcolors={indicatorBarcolors}
                    drawingTool={drawingTool}
                    penColor={penColor}
                    penSize={penSize}
                    textFontSize={textFontSize}
                    textBold={textBold}
                    textItalic={textItalic}
                    fibLevels={fibLevels}
                    fibInverted={fibInverted}
                    positionSize={positionSize}
                />
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
                            style={{ flex: heightPct }}
                        >
                            <ChartPane
                                ref={(node) => {
                                    if (node) subPaneRefs.current.set(subPane.id, node);
                                    else subPaneRefs.current.delete(subPane.id);
                                }}
                                paneId={subPane.id}
                                symbol={symbol}
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
                                drawingTool={drawingTool}
                                penColor={penColor}
                                penSize={penSize}
                                textFontSize={textFontSize}
                                textBold={textBold}
                                textItalic={textItalic}
                                fibLevels={fibLevels}
                                fibInverted={fibInverted}
                                positionSize={positionSize}
                            />
                        </div>
                    </div>
                );
            })}

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
