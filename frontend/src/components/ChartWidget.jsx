/**
 * CandleScope chart widget based on Lightweight Charts.
 */
import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";

const LEFT_EDGE_TRIGGER_BARS = 15;

export default function ChartWidget({
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
}) {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);
    const candlestickSeriesRef = useRef(null);
    const volumeSeriesRef = useRef(null);

    const dataRef = useRef([]);
    const onNeedMoreLeftRef = useRef(onNeedMoreLeft);
    const canLoadMoreLeftRef = useRef(canLoadMoreLeft);
    const requestedOldestRef = useRef(null);
    const userInteractedRef = useRef(false);
    const prevDataMetaRef = useRef({
        datasetKey: null,
        first: null,
        last: null,
        length: 0,
    });

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
        prevDataMetaRef.current = { datasetKey, first: null, last: null, length: 0 };
    }, [datasetKey]);

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const container = chartContainerRef.current;
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
            timeScale: {
                borderColor: "#1e293b",
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                barSpacing: 8,
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
                onCrosshairMove(null);
                return;
            }

            const candleData = param.seriesData.get(candlestickSeries);
            const volumeData = param.seriesData.get(volumeSeries);
            if (!candleData) return;

            onCrosshairMove({
                time: param.time,
                open: candleData.open,
                high: candleData.high,
                low: candleData.low,
                close: candleData.close,
                volume: volumeData ? volumeData.value : 0,
            });
        });

        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
            if (!logicalRange) return;
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

        const candleData = klines.map((d) => ({
            time: d.time,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
        }));

        const volumeData = klines.map((d) => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? `${upColor}55` : `${downColor}55`,
        }));

        candlestickSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);
    };

    useEffect(() => {
        if (!chartRef.current || !candlestickSeriesRef.current) return;

        const bgColor = theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17");
        const textColor = theme === "light" ? "#1e293b" : "#94a3b8";

        chartRef.current.applyOptions({
            layout: { background: { color: bgColor }, textColor },
            grid: {
                vertLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
                horzLines: { color: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)" },
            },
        });

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
    }, [upColor, downColor, theme, customBg, data]);

    useEffect(() => {
        if (!data || data.length === 0) return;
        updateSeriesData(data);

        const first = data[0].time;
        const last = data[data.length - 1].time;
        const prev = prevDataMetaRef.current;

        const isPrepend =
            prev.datasetKey === datasetKey &&
            prev.length > 0 &&
            first < prev.first &&
            last === prev.last;

        if (!isPrepend && chartRef.current) {
            chartRef.current.timeScale().fitContent();
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

    return (
        <div className="chart-area">
            <div
                ref={chartContainerRef}
                className="chart-container"
                id="chart-container"
            />
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
}
