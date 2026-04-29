/**
 * CandleScope chart widget based on Lightweight Charts.
 *
 * ALL drawing (freehand pen, lines, eraser) is handled via the native
 * Plugin API (ISeriesPrimitive), rendered directly inside the chart's
 * Canvas pipeline — zero lag on pan/zoom, no DOM overlays needed.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useCallback, useState } from "react";
import { createChart, CandlestickSeries } from "lightweight-charts";
import { useDrawing } from "../hooks/useDrawing";
import TextEditOverlay from "./TextEditOverlay";
import TextFormatBar from "./TextFormatBar";

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;

const DRAWING_TOOL_IDS = new Set(["pen", "eraser", "line-segment", "line-ray", "line-infinite", "text"]);

function buildLocalizationOptions(timezone = "Local", interval = "1h") {
    const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
    try {
        const tooltipFormatOptions = {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        };

        const datePartsOptions = {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
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
                timeFormatter: (timestamp) => tooltipFormatter.format(new Date(timestamp * 1000)),
            },
            timeScale: {
                tickMarkFormatter: (timestamp, tickMarkType, _locale) => {
                    const parts = partsFormatter.formatToParts(new Date(timestamp * 1000));
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
                            return `${hour}:${min}`;
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
    return {
        time: d.time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
    };
}

const ChartWidget = forwardRef(function ChartWidget({
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
    onDrawingToolChange,
    penColor = "#f59e0b",
    penSize = 2,
    textFontSize = 14,
    textBold = false,
    textItalic = false,
    // Indicator callback — fires when chart + series are (re)created
    onChartReady = null,
}, ref) {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);
    const candlestickSeriesRef = useRef(null);

    const dataRef = useRef([]);
    // Map for efficient time → data lookup (used by crosshair for volume)
    const dataMapRef = useRef(new Map());
    const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
    const canLoadMoreLeftRef = useRef(canLoadMoreLeft);

    const userInteractedRef = useRef(false);
    const lastCrosshairSignatureRef = useRef(null);
    const prevDataMetaRef = useRef({
        datasetKey: null,
        first: null,
        last: null,
        length: 0,
    });

    // Counter that increments each time the chart series is (re)created,
    // used to signal useDrawing that it should restore/re-attach primitives.
    const [seriesReady, setSeriesReady] = useState(0);

    // Refs for visible range tracking
    const savedVisibleRangeRef = useRef(savedVisibleRange);
    const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
    const visibleRangeSaveTimerRef = useRef(null);
    const hasRestoredRangeRef = useRef(false);

    useEffect(() => {
        savedVisibleRangeRef.current = savedVisibleRange;
    }, [savedVisibleRange]);

    useEffect(() => {
        onVisibleRangeChangeRef.current = onVisibleRangeChange;
    }, [onVisibleRangeChange]);

    useEffect(() => {
        dataRef.current = data || [];
        // Build time→data map for crosshair volume lookup
        const map = new Map();
        for (const d of (data || [])) {
            map.set(d.time, d);
        }
        dataMapRef.current = map;
    }, [data]);

    useEffect(() => {
        onNeedMoreLeftRef.current = onNeedMoreLeft;
    }, [onNeedMoreLeft]);

    useEffect(() => {
        canLoadMoreLeftRef.current = canLoadMoreLeft;
    }, [canLoadMoreLeft]);

    useEffect(() => {

        userInteractedRef.current = false;
        lastCrosshairSignatureRef.current = null;
        hasRestoredRangeRef.current = false;
        if (visibleRangeSaveTimerRef.current) {
            clearTimeout(visibleRangeSaveTimerRef.current);
            visibleRangeSaveTimerRef.current = null;
        }
        prevDataMetaRef.current = { datasetKey: null, first: null, last: null, length: 0 };
    }, [datasetKey]);

    // ── All drawing via native Plugin API ──
    const {
        clearAll,
        editingTextId,
        editingTextValue,
        editingTextPos,
        setEditingTextValue,
        commitTextEditing,
        cancelTextEditing,
        editInputRef,
        selectedTextSnapshot,
        selectedTextBox,
        updateSelectedText,
        deleteSelected,
    } = useDrawing({
        chartRef,
        seriesRef: candlestickSeriesRef,
        chartContainerRef,
        activeTool: drawingTool,
        onToolChange: onDrawingToolChange,
        penColor,
        penSize,
        textFontSize,
        textBold,
        textItalic,
        symbol,
        seriesReady,
    });
    const [chartContainerWidth, setChartContainerWidth] = useState(0);

    useEffect(() => {
        const el = chartContainerRef.current;
        if (!el) return;

        const updateWidth = () => setChartContainerWidth(el.clientWidth || 0);
        updateWidth();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", updateWidth);
            return () => window.removeEventListener("resize", updateWidth);
        }

        const ro = new ResizeObserver(updateWidth);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Expose getVisibleRange + clearAll + chart internals to parent via ref
    useImperativeHandle(ref, () => ({
        getVisibleRange: () => {
            if (!chartRef.current) return null;
            try {
                const logicalRange = chartRef.current.timeScale().getVisibleLogicalRange();
                const timeRange = chartRef.current.timeScale().getVisibleRange();
                return {
                    logical: logicalRange,
                    time: timeRange,
                };
            } catch {
                return null;
            }
        },
        clearAllDrawings: clearAll,
        // Expose refs for indicator system
        chartRef,
        seriesRef: candlestickSeriesRef,
        seriesReady,
    }), [clearAll, seriesReady]);

    // Debounced visible range save
    const scheduleVisibleRangeSave = useCallback(() => {
        if (visibleRangeSaveTimerRef.current) {
            clearTimeout(visibleRangeSaveTimerRef.current);
        }
        visibleRangeSaveTimerRef.current = setTimeout(() => {
            if (!chartRef.current || !onVisibleRangeChangeRef.current) return;
            try {
                const logicalRange = chartRef.current.timeScale().getVisibleLogicalRange();
                const timeRange = chartRef.current.timeScale().getVisibleRange();
                if (logicalRange && timeRange) {
                    onVisibleRangeChangeRef.current({
                        logical: logicalRange,
                        time: timeRange,
                    });
                }
            } catch {
                // Ignore errors during range save
            }
        }, VISIBLE_RANGE_SAVE_DEBOUNCE_MS);
    }, []);

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const container = chartContainerRef.current;
        const localizationOptions = buildLocalizationOptions(timezone, interval);
        const chart = createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { color: theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17") },
                textColor: theme === "light" ? "#1e293b" : "#94a3b8",
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
                horzLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
            },
            crosshair: {
                mode: 0, // Normal — follow mouse freely, don't snap to candle price
                vertLine: {
                    color: "rgba(59, 130, 246, 0.4)",
                    width: 1,
                    style: 2,
                    labelBackgroundColor: "#3b82f6",
                },
                horzLine: {
                    color: "rgba(59, 130, 246, 0.4)",
                    width: 1,
                    style: 2,
                    labelBackgroundColor: "#3b82f6",
                },
            },
            rightPriceScale: {
                alignLabels: false,
                entireTextOnly: true,
                borderColor: "#1e293b",
                scaleMargins: { top: 0.05, bottom: 0.35 },
            },
            ...(localizationOptions.localization ? { localization: localizationOptions.localization } : {}),
            timeScale: {
                borderColor: "#1e293b",
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                barSpacing: 8,
                ...(localizationOptions.timeScale ? { tickMarkFormatter: localizationOptions.timeScale.tickMarkFormatter } : {}),
            },
            handleScroll: { vertTouchDrag: false },
        });

        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: upColor || "#22c55e",
            downColor: downColor || "#ef4444",
            borderDownColor: downColor || "#ef4444",
            borderUpColor: upColor || "#22c55e",
            wickDownColor: downColor || "#ef4444",
            wickUpColor: upColor || "#22c55e",
        });

        chart.subscribeCrosshairMove((param) => {
            if (!onCrosshairMove) return;
            if (!param.time || !param.seriesData) {
                if (lastCrosshairSignatureRef.current !== null) {
                    lastCrosshairSignatureRef.current = null;
                    onCrosshairMove(null);
                }
                return;
            }

            const candleData = param.seriesData.get(candlestickSeries);
            if (!candleData) return;

            // Look up volume from raw data (volume is now rendered by indicator system)
            const rawItem = dataMapRef.current.get(param.time);
            const volume = rawItem ? rawItem.volume : 0;

            const snapshot = {
                time: param.time,
                open: candleData.open,
                high: candleData.high,
                low: candleData.low,
                close: candleData.close,
                volume,
            };
            const signature = `${snapshot.time}|${snapshot.open}|${snapshot.high}|${snapshot.low}|${snapshot.close}|${snapshot.volume}`;
            if (lastCrosshairSignatureRef.current === signature) return;

            lastCrosshairSignatureRef.current = signature;
            onCrosshairMove(snapshot);
        });

        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
            if (!logicalRange) return;

            if (userInteractedRef.current) {
                scheduleVisibleRangeSave();
            }

            if (!onNeedMoreLeftRef.current || !canLoadMoreLeftRef.current) return;
            if (!userInteractedRef.current) return;
            if (logicalRange.from > LEFT_EDGE_TRIGGER_BARS) return;

            const currentData = dataRef.current;
            if (!currentData || currentData.length === 0) return;

            const oldestLoadedTime = currentData[0].time;
            onNeedMoreLeftRef.current(oldestLoadedTime);
        });

        chartRef.current = chart;
        candlestickSeriesRef.current = candlestickSeries;

        // Signal useDrawing that chart + series are ready for primitive attachment
        setSeriesReady((prev) => prev + 1);

        // Notify parent about chart/series refs for indicator rendering
        if (onChartReady) {
            onChartReady({ chartRef, seriesRef: candlestickSeriesRef });
        }

        const markUserInteracted = () => {
            userInteractedRef.current = true;
        };
        container.addEventListener("wheel", markUserInteracted, { passive: true });
        container.addEventListener("mousedown", markUserInteracted);
        container.addEventListener("touchstart", markUserInteracted, { passive: true });

        const resizeObserver = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });
        resizeObserver.observe(container);

        return () => {
            if (onVisibleRangeChangeRef.current) {
                try {
                    const logicalRange = chart.timeScale().getVisibleLogicalRange();
                    const timeRange = chart.timeScale().getVisibleRange();
                    if (logicalRange && timeRange) {
                        onVisibleRangeChangeRef.current({
                            logical: logicalRange,
                            time: timeRange,
                        });
                    }
                } catch {
                    // Ignore
                }
            }
            if (visibleRangeSaveTimerRef.current) {
                clearTimeout(visibleRangeSaveTimerRef.current);
            }
            resizeObserver.disconnect();
            container.removeEventListener("wheel", markUserInteracted);
            container.removeEventListener("mousedown", markUserInteracted);
            container.removeEventListener("touchstart", markUserInteracted);
            chart.remove();
            chartRef.current = null;
            candlestickSeriesRef.current = null;
        };
    }, []);

    const updateSeriesData = (klines) => {
        if (!candlestickSeriesRef.current) return;
        try {
            const deduped = [];
            const seen = new Set();
            for (const d of klines) {
                if (!seen.has(d.time)) {
                    seen.add(d.time);
                    deduped.push(d);
                }
            }
            deduped.sort((a, b) => a.time - b.time);
            candlestickSeriesRef.current.setData(deduped.map((d) => toCandlePoint(d)));
        } catch (err) {
            console.error("ChartWidget setData error:", err);
        }
    };

    const updateLatestBars = (klines, barCount = 2) => {
        if (!candlestickSeriesRef.current || !klines?.length) return;
        try {
            const start = Math.max(0, klines.length - barCount);
            for (let i = start; i < klines.length; i += 1) {
                const point = klines[i];
                candlestickSeriesRef.current.update(toCandlePoint(point));
            }
        } catch (err) {
            console.error("ChartWidget update error, falling back to setData:", err);
            updateSeriesData(klines);
        }
    };

    useEffect(() => {
        if (!chartRef.current) return;

        const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
        const textColor = theme === "light" ? "#1e293b" : "#94a3b8";
        const localizationOptions = buildLocalizationOptions(timezone, interval);

        chartRef.current.applyOptions({
            layout: { background: { color: bgColor }, textColor },
            grid: {
                vertLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
                horzLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
            },
            ...(localizationOptions.localization ? { localization: localizationOptions.localization } : {}),
            ...(localizationOptions.timeScale
                ? { timeScale: { tickMarkFormatter: localizationOptions.timeScale.tickMarkFormatter } }
                : {}),
        });
    }, [theme, customBg, timezone, interval]);

    useEffect(() => {
        if (!candlestickSeriesRef.current) return;

        candlestickSeriesRef.current.applyOptions({
            upColor,
            downColor,
            borderDownColor: downColor,
            borderUpColor: upColor,
            wickDownColor: downColor,
            wickUpColor: upColor,
        });

        if (data && data.length > 0) {
            updateSeriesData(data);
        }
    }, [upColor, downColor]);

    useEffect(() => {
        if (!data || data.length === 0) return;

        const prev = prevDataMetaRef.current;
        const first = data[0].time;
        const last = data[data.length - 1].time;
        const datasetChanged = prev.datasetKey !== datasetKey;
        const shouldFullReplace =
            datasetChanged ||
            prev.length === 0 ||
            prev.first === null ||
            first !== prev.first ||
            data.length < prev.length ||
            data.length - prev.length > 2;

        if (shouldFullReplace) {
            updateSeriesData(data);
        } else {
            updateLatestBars(data, 2);
        }

        if (datasetChanged && chartRef.current && !hasRestoredRangeRef.current) {
            const rangeToRestore = savedVisibleRangeRef.current;
            const timeScale = chartRef.current.timeScale();
            let restored = false;

            if (rangeToRestore?.logical) {
                try {
                    timeScale.setVisibleLogicalRange(rangeToRestore.logical);
                    restored = true;
                } catch {
                    // Fallback to time range below.
                }
            }

            if (!restored && rangeToRestore?.time) {
                try {
                    timeScale.setVisibleRange(rangeToRestore.time);
                    restored = true;
                } catch {
                    // Fallback to fitContent below.
                }
            }

            if (!restored) {
                timeScale.fitContent();
            }

            hasRestoredRangeRef.current = true;
        }



        prevDataMetaRef.current = {
            datasetKey,
            first,
            last,
            length: data.length,
        };
    }, [data, datasetKey]);

    // Determine cursor style for drawing tools
    const isDrawingActive = DRAWING_TOOL_IDS.has(drawingTool);
    const cursorStyle = isDrawingActive ? "crosshair" : undefined;

    return (
        <div className="chart-area">
            <div
                ref={chartContainerRef}
                className="chart-container"
                id="chart-container"
                style={cursorStyle ? { cursor: cursorStyle } : undefined}
            />
            {/* Inline text editor overlay */}
            {editingTextId && editingTextPos && (
                <TextEditOverlay
                    box={editingTextPos}
                    value={editingTextValue}
                    onChange={setEditingTextValue}
                    onCommit={commitTextEditing}
                    onCancel={cancelTextEditing}
                    fontSize={selectedTextSnapshot?.fontSize ?? textFontSize}
                    fontFamily={selectedTextSnapshot?.fontFamily}
                    bold={selectedTextSnapshot?.bold ?? textBold}
                    italic={selectedTextSnapshot?.italic ?? textItalic}
                    underline={selectedTextSnapshot?.underline ?? false}
                    align={selectedTextSnapshot?.align ?? "left"}
                    color={selectedTextSnapshot?.color ?? penColor}
                    bgColor={selectedTextSnapshot?.bgColor ?? null}
                    borderColor={selectedTextSnapshot?.borderColor ?? null}
                    padding={selectedTextSnapshot?.padding ?? 6}
                    widthPx={selectedTextSnapshot?.widthPx ?? null}
                    inputRef={editInputRef}
                />
            )}
            {!editingTextId && selectedTextSnapshot && selectedTextBox && (
                <TextFormatBar
                    position={{
                        x: selectedTextBox.x,
                        y: Math.max(2, selectedTextBox.y - 44),
                    }}
                    snapshot={selectedTextSnapshot}
                    onPatch={updateSelectedText}
                    onDelete={deleteSelected}
                    containerWidth={chartContainerWidth}
                />
            )}
            {loading && (
                <div className="loading-overlay">
                    <div className="loading-spinner" />
                    <span className="loading-text">
                        Loading {symbol} {interval} klines...
                    </span>
                </div>
            )}
        </div>
    );
});

export default ChartWidget;
