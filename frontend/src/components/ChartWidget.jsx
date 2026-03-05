/**
 * CandleScope chart widget based on Lightweight Charts.
 *
 * ALL drawing (freehand pen, lines, eraser) is handled via the native
 * Plugin API (ISeriesPrimitive), rendered directly inside the chart's
 * Canvas pipeline — zero lag on pan/zoom, no DOM overlays needed.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useCallback } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";
import { useDrawing } from "../hooks/useDrawing";

const LEFT_EDGE_TRIGGER_BARS = 15;
const VISIBLE_RANGE_SAVE_DEBOUNCE_MS = 500;

const DRAWING_TOOL_IDS = new Set(["pen", "eraser", "line-segment", "line-ray", "line-infinite", "text"]);

function buildLocalizationOptions(timezone = "Local") {
    const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
    try {
        const axisFormatOptions = {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            month: "short",
            day: "numeric",
        };
        const tooltipFormatOptions = {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        };

        if (timeZoneOpt) {
            axisFormatOptions.timeZone = timeZoneOpt;
            tooltipFormatOptions.timeZone = timeZoneOpt;
        }

        const axisFormatter = new Intl.DateTimeFormat("en-GB", axisFormatOptions);
        const tooltipFormatter = new Intl.DateTimeFormat("en-GB", tooltipFormatOptions);

        return {
            localization: {
                timeFormatter: (timestamp) => tooltipFormatter.format(new Date(timestamp * 1000)),
            },
            timeScale: {
                tickMarkFormatter: (timestamp) => {
                    const parts = axisFormatter.formatToParts(new Date(timestamp * 1000));
                    const hour = parts.find((p) => p.type === "hour")?.value;
                    const min = parts.find((p) => p.type === "minute")?.value;
                    const day = parts.find((p) => p.type === "day")?.value;
                    const month = parts.find((p) => p.type === "month")?.value;
                    if (hour === "00" && min === "00") return `${day} ${month}`;
                    return `${hour}:${min}`;
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

function toVolumePoint(d, upColor, downColor) {
    return {
        time: d.time,
        value: d.volume,
        color: d.close >= d.open ? `${upColor}55` : `${downColor}55`,
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
    penColor = "#f59e0b",
    penSize = 2,
    textFontSize = 14,
    textBold = false,
    textItalic = false,
}, ref) {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);
    const candlestickSeriesRef = useRef(null);
    const volumeSeriesRef = useRef(null);

    const dataRef = useRef([]);
    const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
    const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
    const requestedOldestRef = useRef(null);
    const userInteractedRef = useRef(false);
    const lastCrosshairSignatureRef = useRef(null);
    const prevDataMetaRef = useRef({
        datasetKey: null,
        first: null,
        last: null,
        length: 0,
    });

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
    }, [data]);

    useEffect(() => {
        onNeedMoreLeftRef.current = onNeedMoreLeft;
    }, [onNeedMoreLeft]);

    useEffect(() => {
        canLoadMoreLeftRef.current = canLoadMoreLeft;
    }, [canLoadMoreLeft]);

    useEffect(() => {
        requestedOldestRef.current = null;
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
    } = useDrawing({
        chartRef,
        seriesRef: candlestickSeriesRef,
        chartContainerRef,
        activeTool: drawingTool,
        penColor,
        penSize,
        textFontSize,
        textBold,
        textItalic,
    });

    // Expose getVisibleRange + clearAll to parent via ref
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
    }), [clearAll]);

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
        const localizationOptions = buildLocalizationOptions(timezone);
        const chart = createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { color: theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17") },
                textColor: theme === "light" ? "#1e293b" : "#94a3b8",
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
            },
            grid: {
                vertLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
                horzLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
            },
            crosshair: {
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
                borderColor: "#1e293b",
                scaleMargins: { top: 0.1, bottom: 0.25 },
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

        const volumeSeries = chart.addSeries(HistogramSeries, {
            priceFormat: { type: "volume" },
            priceScaleId: "volume",
        });
        chart.priceScale("volume").applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
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
            const volumeData = param.seriesData.get(volumeSeries);
            if (!candleData) return;

            const snapshot = {
                time: param.time,
                open: candleData.open,
                high: candleData.high,
                low: candleData.low,
                close: candleData.close,
                volume: volumeData ? volumeData.value : 0,
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
            if (requestedOldestRef.current === oldestLoadedTime) return;

            requestedOldestRef.current = oldestLoadedTime;
            onNeedMoreLeftRef.current(oldestLoadedTime);
        });

        chartRef.current = chart;
        candlestickSeriesRef.current = candlestickSeries;
        volumeSeriesRef.current = volumeSeries;

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
            volumeSeriesRef.current = null;
        };
    }, []);

    const updateSeriesData = (klines) => {
        if (!candlestickSeriesRef.current || !volumeSeriesRef.current) return;
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
            volumeSeriesRef.current.setData(deduped.map((d) => toVolumePoint(d, upColor, downColor)));
        } catch (err) {
            console.error("ChartWidget setData error:", err);
        }
    };

    const updateLatestBars = (klines, barCount = 2) => {
        if (!candlestickSeriesRef.current || !volumeSeriesRef.current || !klines?.length) return;
        try {
            const start = Math.max(0, klines.length - barCount);
            for (let i = start; i < klines.length; i += 1) {
                const point = klines[i];
                candlestickSeriesRef.current.update(toCandlePoint(point));
                volumeSeriesRef.current.update(toVolumePoint(point, upColor, downColor));
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
        const localizationOptions = buildLocalizationOptions(timezone);

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
    }, [theme, customBg, timezone]);

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

        if (prev.first !== null && first < prev.first) {
            requestedOldestRef.current = null;
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
                <div
                    className="text-edit-overlay"
                    style={{
                        position: "absolute",
                        left: editingTextPos.x,
                        top: editingTextPos.y,
                        zIndex: 100,
                    }}
                >
                    <input
                        ref={editInputRef}
                        className="text-edit-input"
                        type="text"
                        value={editingTextValue}
                        onChange={(e) => setEditingTextValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                commitTextEditing();
                            }
                            if (e.key === "Escape") {
                                e.preventDefault();
                                cancelTextEditing();
                            }
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
