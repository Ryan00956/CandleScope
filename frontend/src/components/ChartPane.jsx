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
import { forwardRef, useEffect, useImperativeHandle, useRef, useCallback, useState } from "react";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries } from "lightweight-charts";

/* ── Localization helpers (shared with old ChartWidget) ─────── */

function buildLocalizationOptions(timezone = "Local", interval = "1h") {
    const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
    try {
        const axisFormatOptions = {
            year: "numeric", month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false,
        };
        const tooltipFormatOptions = {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        };
        if (timeZoneOpt) {
            axisFormatOptions.timeZone = timeZoneOpt;
            tooltipFormatOptions.timeZone = timeZoneOpt;
        }
        const axisFormatter = new Intl.DateTimeFormat("en-GB", axisFormatOptions);
        const tooltipFormatter = new Intl.DateTimeFormat("en-GB", tooltipFormatOptions);
        const isDailyOrLarger = interval.endsWith("d") || interval.endsWith("w") || interval.endsWith("M");
        const isMonthly = interval.endsWith("M");
        return {
            localization: {
                timeFormatter: (ts) => tooltipFormatter.format(new Date(ts * 1000)),
            },
            timeScale: {
                tickMarkFormatter: (ts) => {
                    const parts = axisFormatter.formatToParts(new Date(ts * 1000));
                    const get = (t) => parts.find((p) => p.type === t)?.value;
                    if (isMonthly) return `${get("month")} ${get("year")}`;
                    if (isDailyOrLarger) return `${get("day")} ${get("month")} ${get("year")}`;
                    if (get("hour") === "00" && get("minute") === "00") return `${get("day")} ${get("month")}`;
                    return `${get("hour")}:${get("minute")}`;
                },
            },
        };
    } catch {
        return {};
    }
}

function toCandlePoint(d) {
    return { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close };
}

/* ── Component ─────────────────────────────────────────────── */

const ChartPane = forwardRef(function ChartPane({
    paneId,
    paneType = "main",       // "main" | "sub"
    paneLabel = "",           // e.g. "RSI(14)" — shown as watermark or label
    data,                     // OHLCV data (main pane) or null (sub panes get data via indicator lines)
    indicatorLines = [],      // [{data, color, lineWidth, lineStyle, type, colorData, name}]
    showTimeScale = true,     // only the bottom-most pane shows time axis
    // Chart appearance
    upColor, downColor, theme, customBg, timezone, interval,
    // Sync callbacks (called by this pane, handled by parent)
    onVisibleLogicalRangeChange,
    onCrosshairMove: onCrosshairMoveExternal,
    onCrosshairSync,          // called with {time, point} for cross-pane sync
    // Crosshair sync from other panes
    syncCrosshairTime,        // time value from another pane's crosshair
}, ref) {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const mainSeriesRef = useRef(null);      // CandlestickSeries (main pane only)
    const indicatorSeriesRef = useRef([]);   // [{series, lineConfig}]
    const prevDataRef = useRef({ length: 0, first: null, last: null });
    const isSyncingRef = useRef(false);      // prevent sync loops

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
            },
            grid: {
                vertLines: { color: gridColor },
                horzLines: { color: gridColor },
            },
            crosshair: {
                vertLine: {
                    color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
                    labelBackgroundColor: "#3b82f6",
                },
                horzLine: {
                    color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
                    labelBackgroundColor: "#3b82f6",
                },
            },
            rightPriceScale: {
                alignLabels: false,
                entireTextOnly: true,
                borderColor: theme === "light" ? "#e2e8f0" : "#1e293b",
                scaleMargins: { top: 0.05, bottom: 0.05 },
                autoScale: true,
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

        // Resize observer
        const ro = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            if (width > 0 && height > 0) {
                chart.applyOptions({ width, height });
            }
        });
        ro.observe(container);

        return () => {
            ro.disconnect();
            chart.remove();
            chartRef.current = null;
            mainSeriesRef.current = null;
            indicatorSeriesRef.current = [];
        };
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

    useEffect(() => {
        if (paneType !== "main" || !mainSeriesRef.current || !data?.length) return;

        const prev = prevDataRef.current;
        const first = data[0].time;
        const last = data[data.length - 1].time;
        const shouldFullReplace =
            prev.length === 0 || prev.first !== first ||
            data.length < prev.length || data.length - prev.length > 2;

        try {
            if (shouldFullReplace) {
                const deduped = [];
                const seen = new Set();
                for (const d of data) {
                    if (!seen.has(d.time)) { seen.add(d.time); deduped.push(d); }
                }
                deduped.sort((a, b) => a.time - b.time);
                mainSeriesRef.current.setData(deduped.map(toCandlePoint));
            } else {
                const start = Math.max(0, data.length - 2);
                for (let i = start; i < data.length; i++) {
                    mainSeriesRef.current.update(toCandlePoint(data[i]));
                }
            }
        } catch (err) {
            console.error("ChartPane candle setData error:", err);
        }

        prevDataRef.current = { length: data.length, first, last };
    }, [data, paneType]);

    /* ── Update time scale visibility ──────────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.applyOptions({ timeScale: { visible: showTimeScale } });
    }, [showTimeScale]);

    /* ── Render indicator lines ────────────────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        // Remove old indicator series
        for (const { series } of indicatorSeriesRef.current) {
            try { chart.removeSeries(series); } catch { /* */ }
        }
        indicatorSeriesRef.current = [];

        if (!indicatorLines || indicatorLines.length === 0) return;

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

            if (isHistogram) {
                opts.priceFormat = { type: "volume" };
            }

            try {
                const series = chart.addSeries(SeriesType, opts);

                // Build data with optional per-bar colors
                let validData;
                if (isHistogram && line.colorData && Array.isArray(line.colorData)) {
                    const colorMap = new Map();
                    for (const cd of line.colorData) colorMap.set(cd.time, cd.color);
                    validData = line.data
                        .filter((d) => d?.time != null && d?.value != null && isFinite(d.value))
                        .map((d) => {
                            const entry = { time: d.time, value: d.value };
                            const c = colorMap.get(d.time);
                            if (c) entry.color = c;
                            return entry;
                        });
                } else {
                    validData = line.data.filter(
                        (d) => d?.time != null && d?.value != null && isFinite(d.value)
                    );
                }

                if (validData.length > 0) {
                    series.setData(validData);
                }

                indicatorSeriesRef.current.push({ series, lineConfig: line });
            } catch (err) {
                console.warn("ChartPane: failed to add indicator series:", err);
            }
        }
    }, [indicatorLines]);

    /* ── Sync crosshair from other panes ───────────────────── */

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart || syncCrosshairTime === undefined) return;

        isSyncingRef.current = true;
        try {
            if (syncCrosshairTime == null) {
                chart.clearCrosshairPosition();
            } else {
                // Set crosshair at the synced time
                // We use setCrosshairPosition with the time value
                // The series doesn't matter much, but we need one for the API
                const series = mainSeriesRef.current || indicatorSeriesRef.current[0]?.series;
                if (series) {
                    chart.setCrosshairPosition(undefined, syncCrosshairTime, series);
                }
            }
        } catch {
            // Ignore — time might not be in the series data
        }
        isSyncingRef.current = false;
    }, [syncCrosshairTime]);

    /* ── Imperative handle ─────────────────────────────────── */

    useImperativeHandle(ref, () => ({
        getChart: () => chartRef.current,
        getMainSeries: () => mainSeriesRef.current,
        getChartRef: () => chartRef,
        getSeriesRef: () => mainSeriesRef,
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
                return {
                    logical: chart.timeScale().getVisibleLogicalRange(),
                    time: chart.timeScale().getVisibleRange(),
                };
            } catch { return null; }
        },
        applyTimeScaleOptions: (opts) => {
            const chart = chartRef.current;
            if (!chart) return;
            try { chart.timeScale().applyOptions(opts); } catch { /* */ }
        },
    }), []);

    return (
        <div className="chart-pane" data-pane-id={paneId} data-pane-type={paneType}>
            {/* Pane label (for sub panes) */}
            {paneType === "sub" && paneLabel && (
                <div className="chart-pane-label">{paneLabel}</div>
            )}
            <div ref={containerRef} className="chart-pane-container" />
        </div>
    );
});

export default ChartPane;
