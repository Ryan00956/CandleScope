/**
 * CandleScope 图表组件
 * 使用 Lightweight Charts v5 (TradingView 官方开源库) 渲染K线
 */
import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";

export default function ChartWidget({ data, symbol, interval, loading, onCrosshairMove, upColor, downColor, theme, customBg }) {
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
                background: { color: theme === 'light' ? '#ffffff' : (theme === 'custom' ? customBg : '#0a0e17') },
                textColor: theme === 'light' ? '#1e293b' : '#94a3b8',
                fontFamily: "'Inter', sans-serif",
                fontSize: 12,
            },
            grid: {
                vertLines: { color: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(30, 41, 59, 0.5)' },
                horzLines: { color: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(30, 41, 59, 0.5)' },
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
            upColor: upColor || "#22c55e",
            downColor: downColor || "#ef4444",
            borderDownColor: downColor || "#ef4444",
            borderUpColor: upColor || "#22c55e",
            wickDownColor: downColor || "#ef4444",
            wickUpColor: upColor || "#22c55e",
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

    // ── 响应颜色和主题变化 ───────────────────────────────
    useEffect(() => {
        if (!chartRef.current || !candlestickSeriesRef.current) return;

        const bgColor = theme === 'light' ? '#ffffff' : (theme === 'custom' ? customBg : '#0a0e17');
        const textColor = theme === 'light' ? '#1e293b' : '#94a3b8';

        chartRef.current.applyOptions({
            layout: { background: { color: bgColor }, textColor },
            grid: {
                vertLines: { color: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(30, 41, 59, 0.5)' },
                horzLines: { color: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(30, 41, 59, 0.5)' },
            }
        });

        candlestickSeriesRef.current.applyOptions({
            upColor: upColor,
            downColor: downColor,
            borderDownColor: downColor,
            borderUpColor: upColor,
            wickDownColor: downColor,
            wickUpColor: upColor,
        });

        // 强制触发一次数据更新以刷新成交量颜色
        if (data && data.length > 0) {
            updateSeriesData(data);
        }
    }, [upColor, downColor, theme, customBg, data]); // Added data to dependencies for updateSeriesData call

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
            color: d.close >= d.open ? `${upColor}55` : `${downColor}55`, // 使用半透明颜色
        }));

        candlestickSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);
    };

    // ── 数据更新 ──────────────────────────────────
    useEffect(() => {
        if (!data || data.length === 0) return;
        updateSeriesData(data);

        // 自动滚动到最新
        if (chartRef.current) {
            chartRef.current.timeScale().fitContent();
        }
    }, [data, upColor, downColor]); // Added upColor, downColor to dependencies for updateSeriesData call

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
