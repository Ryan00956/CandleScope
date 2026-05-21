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
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, AreaSeries } from "lightweight-charts";
import { shouldLoadDrawingEngine } from "../hooks/useDrawingController";
import { clearSavedDrawings } from "../services/drawingStorage";
import { recordPerfEvent } from "../runtime/performance/perfMarks";

/* ── Localization helpers (shared with old ChartWidget) ─────── */

function buildLocalizationOptions(timezone = "Local", interval = "1h") {
    const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
    try {
        const showSeconds = /^\d+s$/.test(String(interval));
        const tooltipFormatOptions = {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        };
        const datePartsOptions = {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        };
        if (timeZoneOpt) {
            tooltipFormatOptions.timeZone = timeZoneOpt;
            datePartsOptions.timeZone = timeZoneOpt;
        }
        const tooltipFormatter = new Intl.DateTimeFormat("en-GB", tooltipFormatOptions);
        const partsFormatter = new Intl.DateTimeFormat("en-GB", datePartsOptions);

        // TickMarkType enum: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
        return {
            localization: {
                timeFormatter: (ts) => tooltipFormatter.format(new Date(ts * 1000)),
            },
            timeScale: {
                tickMarkFormatter: (ts, tickMarkType) => {
                    const parts = partsFormatter.formatToParts(new Date(ts * 1000));
                    const get = (t) => parts.find((p) => p.type === t)?.value;
                    const year = get("year");
                    const month = get("month");
                    const day = get("day");
                    const hour = get("hour");
                    const min = get("minute");
                    const sec = get("second");

                    switch (tickMarkType) {
                        case 0: // Year
                            return year;
                        case 1: // Month
                            return `${month} '${year.slice(-2)}`;
                        case 2: // DayOfMonth
                            return `${day} ${month}`;
                        case 3: // Time
                            return showSeconds ? `${hour}:${min}:${sec}` : `${hour}:${min}`;
                        case 4: // TimeWithSeconds
                            return `${hour}:${min}:${sec}`;
                        default:
                            return `${day} ${month}`;
                    }
                },
            },
        };
    } catch {
        return {};
    }
}

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

function buildHlineSignature(indicatorHlines = []) {
    if (!indicatorHlines?.length) return "empty";
    return indicatorHlines
        .map((hl) => [
            hl.price ?? "",
            hl.color || "#787b86",
            hl.linestyle ?? "dashed",
            hl.title || "",
        ].join(":"))
        .join("|");
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

function buildCrosshairOptions(visible = true) {
    return {
        mode: 0, // Normal — follow mouse freely, don't snap to candle price
        vertLine: {
            color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
            labelBackgroundColor: "#3b82f6",
            visible,
            labelVisible: visible,
        },
        horzLine: {
            color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
            labelBackgroundColor: "#3b82f6",
            visible,
            labelVisible: visible,
        },
    };
}

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
    onChartCreated,           // called after chart+series are created, passes { chartRef, seriesRef }
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
        const container = containerRef.current;
        const loc = buildLocalizationOptions(timezone, interval);
        const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
        const textColor = theme === "light" ? "#1e293b" : "#94a3b8";
        const gridColor = theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)";

        const chart = createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { color: bgColor },
                textColor,
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: gridColor },
                horzLines: { color: gridColor },
            },
            crosshair: buildCrosshairOptions(true),
            rightPriceScale: {
                alignLabels: false,
                entireTextOnly: true,
                borderColor: theme === "light" ? "#e2e8f0" : "#1e293b",
                scaleMargins: { top: 0.05, bottom: 0.05 },
                autoScale: true,
                minimumWidth: 80,
            },
            ...(loc.localization ? { localization: loc.localization } : {}),
            timeScale: {
                borderColor: theme === "light" ? "#e2e8f0" : "#1e293b",
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                barSpacing: 8,
                visible: showTimeScale,
                ...(loc.timeScale ? { tickMarkFormatter: loc.timeScale.tickMarkFormatter } : {}),
            },
            handleScroll: { vertTouchDrag: false },
        });

        // Main pane: add candlestick series
        let mainSeries = null;
        if (paneType === "main") {
            mainSeries = chart.addSeries(CandlestickSeries, {
                upColor: upColor || "#22c55e",
                downColor: downColor || "#ef4444",
                borderDownColor: downColor || "#ef4444",
                borderUpColor: upColor || "#22c55e",
                wickDownColor: downColor || "#ef4444",
                wickUpColor: upColor || "#22c55e",
            });
            mainSeriesRef.current = mainSeries;
        }

        // Sub panes: create an invisible alignment series with full time range
        // This ensures setCrosshairPosition maps time→logical consistently
        // across all panes regardless of indicator data length differences.
        if (paneType === "sub") {
            const alignSeries = chart.addSeries(LineSeries, {
                color: "transparent",
                lineWidth: 0,
                priceScaleId: "",           // don't participate in price scale
                lastValueVisible: false,
                priceLineVisible: false,
                crosshairMarkerVisible: false,
                visible: false,
            });
            alignmentSeriesRef.current = alignSeries;
            // Drawing anchor will be set to the first indicator series once available.
            // This ensures coordinate mapping uses the indicator's actual price range.
            drawingAnchorSeriesRef.current = null;
        }

        // Subscribe to crosshair for sync
        chart.subscribeCrosshairMove((param) => {
            if (isSyncingRef.current) return;

            // Notify parent for cross-pane sync
            if (onCrosshairSync) {
                onCrosshairSync({
                    paneId,
                    time: param.time || null,
                    point: param.point || null,
                    logical: param.logical,
                });
            }

            // Main pane crosshair → OHLCV display
            if (paneType === "main" && onCrosshairMoveExternal && mainSeries) {
                if (!param.time || !param.seriesData) {
                    onCrosshairMoveExternal(null);
                    return;
                }
                const cd = param.seriesData.get(mainSeries);
                if (!cd) return;
                if (cd.open == null || cd.high == null || cd.low == null || cd.close == null) {
                    onCrosshairMoveExternal(null);
                    return;
                }
                onCrosshairMoveExternal({
                    time: param.time,
                    open: cd.open,
                    high: cd.high,
                    low: cd.low,
                    close: cd.close,
                });
            }
        });

        // Subscribe to visible range changes for sync
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (isSyncingRef.current) return;
            if (range && onVisibleLogicalRangeChange) {
                onVisibleLogicalRangeChange({ paneId, range });
            }
        });

        chartRef.current = chart;

        // Notify parent that chart + series are ready
        if (onChartCreated) {
            onChartCreated({ chartRef, seriesRef: mainSeriesRef, containerRef });
        }
        setSeriesReady((prev) => prev + 1);

        // Resize observer
        const ro = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            if (width > 0 && height > 0) {
                chart.applyOptions({ width, height });
            }
        });
        ro.observe(container);

        // ── Auto-scale detection ──────────────────────────────
        // Detect manual price-axis dragging: when the user drags on the
        // price scale area (right side of the chart), lightweight-charts
        // automatically sets autoScale to false. We detect this by
        // monitoring mousedown+mousemove on the price scale area.
        //
        // The price scale occupies the rightmost ~80px of the container.
        // We detect a vertical drag there as a manual scale gesture.
        let priceScaleDragStartY = null;
        let isPriceScaleDragging = false;

        const handleMouseDown = (e) => {
            // Check if the mouse is in the price scale area (right edge)
            const rect = container.getBoundingClientRect();
            const priceScaleWidth = 80; // matches minimumWidth
            if (e.clientX >= rect.right - priceScaleWidth) {
                priceScaleDragStartY = e.clientY;
                isPriceScaleDragging = false;
            }
        };

        const handleMouseMove = (e) => {
            if (priceScaleDragStartY !== null) {
                const delta = Math.abs(e.clientY - priceScaleDragStartY);
                if (delta > 3) {
                    isPriceScaleDragging = true;
                }
            }
        };

        const handleMouseUp = () => {
            if (isPriceScaleDragging && autoScaleRef.current) {
                // User dragged on price scale → manual scaling activated
                autoScaleRef.current = false;
                setIsAutoScale(false);
            }
            priceScaleDragStartY = null;
            isPriceScaleDragging = false;
        };

        // Double-click on price scale → restore auto-scale
        const handleDblClick = (e) => {
            const rect = container.getBoundingClientRect();
            const priceScaleWidth = 80;
            if (e.clientX >= rect.right - priceScaleWidth) {
                chart.priceScale("right").applyOptions({ autoScale: true });
                autoScaleRef.current = true;
                setIsAutoScale(true);
            }
        };

        // ── Right-click on price scale area → show context menu (main pane only) ──
        const handleContextMenu = (e) => {
            if (paneType !== "main") return;
            const rect = container.getBoundingClientRect();
            const priceScaleWidth = 80;
            if (e.clientX >= rect.right - priceScaleWidth) {
                e.preventDefault();
                e.stopPropagation();

                let x = e.clientX - rect.left;
                let y = e.clientY - rect.top;
                const menuWidth = 180; // matches .price-scale-context-menu min-width
                const menuHeight = 220; // approximate height of the 6 menu items + divider

                if (x + menuWidth > rect.width) {
                    x = rect.width - menuWidth - 4;
                }

                if (y + menuHeight > rect.height) {
                    y = Math.max(0, rect.height - menuHeight - 4);
                }

                setContextMenu({ x, y });
            }
        };

        container.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        container.addEventListener("dblclick", handleDblClick);
        container.addEventListener("contextmenu", handleContextMenu);

        return () => {
            container.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            container.removeEventListener("dblclick", handleDblClick);
            container.removeEventListener("contextmenu", handleContextMenu);
            ro.disconnect();
            chart.remove();
            chartRef.current = null;
            mainSeriesRef.current = null;
            drawingAnchorSeriesRef.current = null;
            indicatorSeriesRef.current = [];
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chart instance is created once; runtime option changes are applied by follow-up effects.
    }, []); // created once

    /* ── Update theme / appearance ─────────────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
        const textColor = theme === "light" ? "#1e293b" : "#94a3b8";
        const gridColor = theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)";
        const borderColor = theme === "light" ? "#e2e8f0" : "#1e293b";
        const loc = buildLocalizationOptions(timezone, interval);

        chart.applyOptions({
            layout: { background: { color: bgColor }, textColor },
            grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
            rightPriceScale: { borderColor },
            timeScale: { borderColor },
            ...(loc.localization ? { localization: loc.localization } : {}),
            ...(loc.timeScale ? { timeScale: { tickMarkFormatter: loc.timeScale.tickMarkFormatter } } : {}),
        });
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
        const removedSeriesCount = indicatorSeriesRef.current.length;
        for (const { series } of indicatorSeriesRef.current) {
            try { chart.removeSeries(series); } catch { /* */ }
        }
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

            const isHistogram = line.type === "histogram";
            const SeriesType = isHistogram ? HistogramSeries : LineSeries;

            const opts = {
                color: line.color || "#f59e0b",
                lineWidth: isHistogram ? undefined : (line.lineWidth || 2),
                lineStyle: isHistogram ? undefined : (line.lineStyle || 0),
                title: "",
                visible: true,
                priceScaleId: "right",
                lastValueVisible: false,
                priceLineVisible: false,
            };

            if (!isHistogram) {
                opts.crosshairMarkerVisible = shouldShowIndicatorCrosshairMarker(line, drawingTool);
            }

            if (isHistogram) {
                opts.priceFormat = { type: "volume" };
            }

            try {
                const series = chart.addSeries(SeriesType, opts);
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
        if (markerTargetRef.current && markerTargetRef.current !== targetSeries) {
            try { markerTargetRef.current.setMarkers([]); } catch { /* */ }
            markerStateRef.current = { target: null, state: "empty" };
            recordPerfEvent("chart.markerSeries.clear", {
                paneId,
                reason: "target-change",
            });
        }
        markerTargetRef.current = targetSeries;
        if (!targetSeries) return;
        if (!indicatorMarkers || indicatorMarkers.length === 0) {
            const markerState = markerStateRef.current;
            if (markerState.target !== targetSeries || markerState.state !== "empty") {
                try { targetSeries.setMarkers([]); } catch { /* */ }
                markerStateRef.current = { target: targetSeries, state: "empty" };
                recordPerfEvent("chart.markerSeries.clear", {
                    paneId,
                    reason: "empty",
                });
            }
            return;
        }

        // Flatten all marker sources into a single sorted array
        const SHAPE_MAP = {
            triangleup: "arrowUp",
            triangle_up: "arrowUp",
            arrow_up: "arrowUp",
            triangledown: "arrowDown",
            triangle_down: "arrowDown",
            arrow_down: "arrowDown",
            circle: "circle",
            cross: "circle",
            diamond: "circle",
            xcross: "circle",
        };
        const POS_MAP = {
            above: "aboveBar",
            below: "belowBar",
            abovebar: "aboveBar",
            belowbar: "belowBar",
            top: "aboveBar",
            bottom: "belowBar",
        };

        const allMarkers = [];
        for (const group of indicatorMarkers) {
            if (!group.data || !Array.isArray(group.data)) continue;
            for (const m of group.data) {
                if (m.time == null) continue;
                allMarkers.push({
                    time: m.time,
                    position: POS_MAP[m.position] || m.position || "aboveBar",
                    color: m.color || "#f59e0b",
                    shape: SHAPE_MAP[m.shape] || m.shape || "circle",
                    text: m.text || "",
                });
            }
        }

        // Sort markers by time (required by lightweight-charts)
        allMarkers.sort((a, b) => a.time - b.time);

        try {
            targetSeries.setMarkers(allMarkers);
            markerStateRef.current = { target: targetSeries, state: "markers" };
            recordPerfEvent("chart.markerSeries.setMarkers", {
                paneId,
                groups: indicatorMarkers.length,
                markers: allMarkers.length,
            });
        } catch (err) {
            console.warn("ChartPane: failed to set markers:", err);
        }
    }, [indicatorMarkers, indicatorLines, paneId, paneType]);

    /* ── Apply hlines (horizontal price lines) ─────────────── */
    // We use createPriceLine() on the pane's anchor series for each hline.
    const hlinesRef = useRef([]); // track created price line objects
    const hlinesStateRef = useRef({ target: null, signature: "unknown" });

    useEffect(() => {
        const series = paneType === "main"
            ? mainSeriesRef.current
            : drawingAnchorSeriesRef.current;
        const signature = buildHlineSignature(indicatorHlines);

        if (hlinesStateRef.current.target === series && hlinesStateRef.current.signature === signature) {
            return;
        }

        // Remove previous hlines
        const removedHlines = hlinesRef.current.length;
        for (const item of hlinesRef.current) {
            try { item.series.removePriceLine(item.priceLine); } catch { /* */ }
        }
        if (removedHlines > 0) {
            recordPerfEvent("chart.hline.remove", {
                paneId,
                hlines: removedHlines,
            });
        }
        hlinesRef.current = [];
        hlinesStateRef.current = { target: series, signature };

        if (!series) return;
        if (!indicatorHlines || indicatorHlines.length === 0) return;

        const LINESTYLE_MAP = { solid: 0, dotted: 1, dashed: 2, large_dashed: 3, sparse_dotted: 4 };
        let createdHlines = 0;

        for (const hl of indicatorHlines) {
            if (hl.price == null || !isFinite(hl.price)) continue;
            try {
                const pl = series.createPriceLine({
                    price: hl.price,
                    color: hl.color || "#787b86",
                    lineWidth: 1,
                    lineStyle: typeof hl.linestyle === "number" ? hl.linestyle : (LINESTYLE_MAP[hl.linestyle] ?? 2),
                    axisLabelVisible: true,
                    title: hl.title || "",
                });
                hlinesRef.current.push({ series, priceLine: pl });
                createdHlines += 1;
            } catch (err) {
                console.warn("ChartPane: failed to create hline:", err);
            }
        }
        recordPerfEvent("chart.hline.create", {
            paneId,
            hlines: createdHlines,
            definitions: indicatorHlines.length,
        });
    }, [indicatorHlines, paneId, paneType, seriesReady]);

    /* ── Apply barcolors (per-bar candle coloring) ─────────── */
    // Lightweight Charts CandlestickSeries doesn't support per-bar color
    // via setData natively, but we can do it by re-setting data with color
    // fields. We rebuild candle data with color overrides when barcolors change.
    const prevBarcoloredDataRef = useRef([]);

    useEffect(() => {
        if (paneType !== "main" || !mainSeriesRef.current || !data?.length) return;
        if (!indicatorBarcolors || indicatorBarcolors.length === 0) {
            if (prevBarcoloredDataRef.current.length > 0) {
                const plainData = data.map(toCandlePoint);
                try {
                    isSyncingRef.current = true;
                    mainSeriesRef.current.setData(plainData);
                    recordPerfEvent("chart.candleSeries.setData", {
                        paneId,
                        reason: "barcolor-clear",
                        points: plainData.length,
                    });
                } catch (err) {
                    console.warn("ChartPane: failed to clear barcolors:", err);
                } finally {
                    isSyncingRef.current = false;
                    prevBarcoloredDataRef.current = [];
                }
            }
            return;
        }

        // Build a time→color map from all barcolor sources
        const colorMap = new Map();
        for (const group of indicatorBarcolors) {
            if (!group.data || !Array.isArray(group.data)) continue;
            for (const bc of group.data) {
                if (bc.time != null && bc.color) {
                    colorMap.set(bc.time, bc.color);
                }
            }
        }
        if (colorMap.size === 0) {
            prevBarcoloredDataRef.current = [];
            return;
        }

        // Re-set candle data with per-bar color overrides
        try {
            isSyncingRef.current = true;
            const coloredData = data.map((d) => {
                const point = toCandlePoint(d);
                if (point.open == null || point.high == null || point.low == null || point.close == null) {
                    return point;
                }
                const c = colorMap.get(d.time);
                if (c) {
                    return {
                        ...point,
                        color: c, borderColor: c, wickColor: c,
                    };
                }
                return point;
            });
            if (canUseTrailingCandleUpdate(prevBarcoloredDataRef.current, coloredData)) {
                const start = Math.max(0, prevBarcoloredDataRef.current.length - 1);
                for (let i = start; i < coloredData.length; i += 1) {
                    mainSeriesRef.current.update(coloredData[i]);
                }
                recordPerfEvent("chart.candleSeries.update", {
                    paneId,
                    reason: "barcolor-trailing",
                    points: coloredData.length - start,
                    totalPoints: coloredData.length,
                });
            } else {
                mainSeriesRef.current.setData(coloredData);
                recordPerfEvent("chart.candleSeries.setData", {
                    paneId,
                    reason: "barcolor-full",
                    points: coloredData.length,
                });
            }
            prevBarcoloredDataRef.current = coloredData;
        } catch (err) {
            console.warn("ChartPane: failed to apply barcolors:", err);
        } finally {
            isSyncingRef.current = false;
        }
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

        if (
            fillSeriesStateRef.current.chart === chart
            && fillSeriesStateRef.current.signature === fillPayload.signature
        ) {
            return;
        }

        // Remove previous fill series
        const removedFillSeries = fillSeriesRef.current.length;
        for (const fs of fillSeriesRef.current) {
            try { chart.removeSeries(fs); } catch { /* */ }
        }
        if (removedFillSeries > 0) {
            recordPerfEvent("chart.fillSeries.remove", {
                paneId,
                series: removedFillSeries,
            });
        }
        fillSeriesRef.current = [];
        fillSeriesStateRef.current = { chart, signature: fillPayload.signature };

        if (fillPayload.entries.length === 0) return;

        let createdFillSeries = 0;
        for (const entry of fillPayload.entries) {
            try {
                // Create area series for the upper boundary (max of the two)
                const areaSeries = chart.addSeries(AreaSeries, {
                    lineColor: "transparent",
                    lineWidth: 0,
                    topColor: entry.fillColor,
                    bottomColor: "transparent",
                    priceScaleId: "right",
                    lastValueVisible: false,
                    priceLineVisible: false,
                    crosshairMarkerVisible: false,
                });

                areaSeries.setData(entry.upperData);
                fillSeriesRef.current.push(areaSeries);
                createdFillSeries += 1;

                // Create second area series for the lower boundary (masks the bottom)
                const lowerSeries = chart.addSeries(AreaSeries, {
                    lineColor: "transparent",
                    lineWidth: 0,
                    topColor: entry.backgroundColor,
                    bottomColor: entry.backgroundColor,
                    priceScaleId: "right",
                    lastValueVisible: false,
                    priceLineVisible: false,
                    crosshairMarkerVisible: false,
                });

                lowerSeries.setData(entry.lowerData);
                fillSeriesRef.current.push(lowerSeries);
                createdFillSeries += 1;
            } catch (err) {
                console.warn("ChartPane: failed to create fill area:", err);
            }
        }
        recordPerfEvent("chart.fillSeries.create", {
            paneId,
            fills: fillPayload.matchedFillCount,
            definitions: indicatorFills?.length || 0,
            series: createdFillSeries,
            points: fillPayload.pointCount,
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
        const chart = chartRef.current;
        const container = containerRef.current;
        if (!chart || !container) return;
        if (!indicatorBgcolors || indicatorBgcolors.length === 0) {
            // Remove existing canvas if no bgcolors
            if (bgCanvasRef.current) {
                try { bgCanvasRef.current.remove(); } catch { /* */ }
                bgCanvasRef.current = null;
                recordPerfEvent("chart.bgcolorOverlay.remove", { paneId });
            }
            return;
        }

        // Create or reuse canvas overlay
        let canvas = bgCanvasRef.current;
        if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.className = "bgcolor-overlay-canvas";
            canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
            container.style.position = "relative";
            // Insert canvas as first child so it's behind chart elements
            container.insertBefore(canvas, container.firstChild);
            bgCanvasRef.current = canvas;
            recordPerfEvent("chart.bgcolorOverlay.create", { paneId });
        }

        // Build time→color map from all bgcolor sources
        const colorRegions = []; // [{time, color}]
        for (const bg of indicatorBgcolors) {
            if (!bg.regions || !Array.isArray(bg.regions)) continue;
            const bgColor = bg.color || "rgba(59,130,246,0.1)";
            for (const region of bg.regions) {
                if (region.time != null) {
                    colorRegions.push({ time: region.time, color: bgColor });
                }
            }
        }
        if (colorRegions.length === 0) return;

        const timeColorMap = new Map();
        for (const r of colorRegions) {
            timeColorMap.set(r.time, r.color);
        }

        // Render function — called on scroll/resize
        const renderBg = () => {
            const timeScale = chart.timeScale();
            const rect = container.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;

            // Update canvas size
            const dpr = window.devicePixelRatio || 1;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";

            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return;
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx2d.clearRect(0, 0, w, h);

            // Get visible range
            const visibleRange = timeScale.getVisibleRange();
            if (!visibleRange) return;

            // For each colored region, compute x coordinates and draw
            let visibleRegions = 0;
            for (const [time, color] of timeColorMap) {
                if (time < visibleRange.from || time > visibleRange.to) continue;

                const x = timeScale.timeToCoordinate(time);
                if (x === null || x === undefined) continue;
                visibleRegions += 1;

                // Get bar width from barSpacing
                const barSpacing = timeScale.options().barSpacing || 8;
                const barW = Math.max(1, barSpacing - 1);

                ctx2d.fillStyle = color;
                ctx2d.fillRect(x - barW / 2, 0, barW, h);
            }
            recordPerfEvent("chart.bgcolorOverlay.render", {
                paneId,
                regions: timeColorMap.size,
                visibleRegions,
                width: Math.round(w),
                height: Math.round(h),
            });
        };

        // Initial render
        renderBg();

        // Re-render on visible range changes
        const onRangeChange = () => {
            if (bgAnimFrameRef.current) cancelAnimationFrame(bgAnimFrameRef.current);
            bgAnimFrameRef.current = requestAnimationFrame(renderBg);
        };

        const tsObj = chart.timeScale();
        tsObj.subscribeVisibleLogicalRangeChange(onRangeChange);

        // Also re-render on resize
        const ro = new ResizeObserver(onRangeChange);
        ro.observe(container);

        return () => {
            tsObj.unsubscribeVisibleLogicalRangeChange(onRangeChange);
            ro.disconnect();
            if (bgAnimFrameRef.current) cancelAnimationFrame(bgAnimFrameRef.current);
        };
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
        if (!shouldMountDrawingEngine || DrawingEngineHost) return undefined;
        let cancelled = false;
        import("./DrawingEngineHost").then((module) => {
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

    useImperativeHandle(ref, () => ({
        clearAllDrawings,
        setDrawingsHidden,
        updateSelectedDrawingStyle,
        getChart: () => chartRef.current,
        getMainSeries: () => mainSeriesRef.current,
        getChartRef: () => chartRef,
        getSeriesRef: () => mainSeriesRef,
        prepareExport: () => {
            prepareDrawingExport();
        },
        getExportSnapshot: () => {
            const rootElement = paneRootRef.current;
            const chartElement = containerRef.current;
            return {
                paneId,
                paneType,
                rootElement,
                chartElement,
                chart: chartRef.current,
                rect: rootElement?.getBoundingClientRect?.() || null,
            };
        },
        /** Imperatively sync crosshair from another pane — no React re-render needed */
        syncCrosshair: (time) => {
            const chart = chartRef.current;
            if (!chart) return;
            isSyncingRef.current = true;
            try {
                if (time == null) {
                    chart.clearCrosshairPosition();
                } else {
                    // Prefer the alignment series (sub panes) for consistent
                    // time→logical mapping, fall back to main/indicator series.
                    const series =
                        alignmentSeriesRef.current ||
                        mainSeriesRef.current ||
                        indicatorSeriesRef.current[0]?.series;
                    if (series) {
                        chart.setCrosshairPosition(undefined, time, series);
                    }
                }
            } catch {
                // Ignore — time might not be in the series data
            }
            isSyncingRef.current = false;
        },
        setVisibleLogicalRange: (range) => {
            const chart = chartRef.current;
            if (!chart || !range) return;
            isSyncingRef.current = true;
            try {
                chart.timeScale().setVisibleLogicalRange(range);
            } catch { /* */ }
            isSyncingRef.current = false;
        },
        fitContent: () => {
            const chart = chartRef.current;
            if (!chart) return;
            try { chart.timeScale().fitContent(); } catch { /* */ }
        },
        getVisibleLogicalRange: () => {
            const chart = chartRef.current;
            if (!chart) return null;
            try { return chart.timeScale().getVisibleLogicalRange(); } catch { return null; }
        },
        getVisibleRange: () => {
            const chart = chartRef.current;
            if (!chart) return null;
            try {
                const timeScale = chart.timeScale();
                return {
                    logical: timeScale.getVisibleLogicalRange(),
                    time: timeScale.getVisibleRange(),
                    barSpacing: timeScale.options().barSpacing,
                    scrollPosition: timeScale.scrollPosition(),
                };
            } catch { return null; }
        },
        setVisibleTimeRange: (range) => {
            const chart = chartRef.current;
            if (!chart || !range) return;
            isSyncingRef.current = true;
            try {
                chart.timeScale().setVisibleRange(range);
            } catch { /* */ }
            isSyncingRef.current = false;
        },
        setScrollPosition: (position, animated = false) => {
            const chart = chartRef.current;
            if (!chart || !Number.isFinite(position)) return;
            isSyncingRef.current = true;
            try {
                chart.timeScale().scrollToPosition(position, animated);
            } catch { /* */ }
            isSyncingRef.current = false;
        },
        applyTimeScaleOptions: (opts) => {
            const chart = chartRef.current;
            if (!chart) return;
            try { chart.timeScale().applyOptions(opts); } catch { /* */ }
        },
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
                    chartRef={chartRef}
                    seriesRef={paneType === "main" ? mainSeriesRef : drawingAnchorSeriesRef}
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
