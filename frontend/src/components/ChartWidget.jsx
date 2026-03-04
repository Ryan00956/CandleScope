/**
 * CandleScope 图表组件
 * 使用 Lightweight Charts v5 (TradingView 官方开源库) 渲染K线
 */
import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";

export default function ChartWidget({ data, symbol, interval, loading, onCrosshairMove }) {
    const chartContainerRef = useRef(null);
    const chartRef = useRef(null);
    const candlestickSeriesRef = useRef(null);
    const volumeSeriesRef = useRef(null);

    // ── 初始化图表 ──────────────────────────────────
    useEffect(() => {
        if (!chartContainerRef.current) return;

        const container = chartContainerRef.current;

        const chart = createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { color: "#0a0e17" },
                textColor: "#94a3b8",
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
            },
            grid: {
                vertLines: { color: "rgba(30, 41, 59, 0.5)" },
                horzLines: { color: "rgba(30, 41, 59, 0.5)" },
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

        // K线系列 (v5 API)
        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: "#22c55e",
            downColor: "#ef4444",
            borderDownColor: "#ef4444",
            borderUpColor: "#22c55e",
            wickDownColor: "#ef4444",
            wickUpColor: "#22c55e",
        });

        // 成交量系列 (v5 API)
        const volumeSeries = chart.addSeries(HistogramSeries, {
            priceFormat: { type: "volume" },
            priceScaleId: "volume",
        });

        // 成交量的价格轴设置（底部 20% 高度）
        chart.priceScale("volume").applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
        });

        // 十字光标事件
        chart.subscribeCrosshairMove((param) => {
            if (onCrosshairMove) {
                if (!param.time || !param.seriesData) {
                    onCrosshairMove(null);
                    return;
                }
                const candleData = param.seriesData.get(candlestickSeries);
                const volumeData = param.seriesData.get(volumeSeries);
                if (candleData) {
                    onCrosshairMove({
                        time: param.time,
                        open: candleData.open,
                        high: candleData.high,
                        low: candleData.low,
                        close: candleData.close,
                        volume: volumeData ? volumeData.value : 0,
                    });
                }
            }
        });

        chartRef.current = chart;
        candlestickSeriesRef.current = candlestickSeries;
        volumeSeriesRef.current = volumeSeries;

        // 响应式尺寸适配
        const resizeObserver = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });
        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, []); // 只初始化一次

    // ── 数据更新 ──────────────────────────────────
    useEffect(() => {
        if (!data || data.length === 0) return;
        if (!candlestickSeriesRef.current || !volumeSeriesRef.current) return;

        // K线数据
        const candleData = data.map((d) => ({
            time: d.time,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
        }));

        // 成交量数据（颜色跟随涨跌）
        const volumeData = data.map((d) => ({
            time: d.time,
            value: d.volume,
            color:
                d.close >= d.open
                    ? "rgba(34, 197, 94, 0.35)"
                    : "rgba(239, 68, 68, 0.35)",
        }));

        candlestickSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);

        // 自动滚动到最新
        if (chartRef.current) {
            chartRef.current.timeScale().fitContent();
        }
    }, [data]);

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
                        正在加载 {symbol} {interval} K线数据...
                    </span>
                </div>
            )}
        </div>
    );
}
