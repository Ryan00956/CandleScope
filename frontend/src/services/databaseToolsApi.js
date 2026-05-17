const MOCK_NOW_MS = Date.UTC(2026, 4, 16, 8, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const MOCK_SERIES = [
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "1m",
        totalCount: 428360,
        earliestOpenMs: MOCK_NOW_MS - 298 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 45 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "healthy",
    },
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "5m",
        totalCount: 86112,
        earliestOpenMs: MOCK_NOW_MS - 299 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 5 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 50 * 1000,
        gapCount: 1,
        missingBars: 12,
        status: "gap",
    },
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "1h",
        totalCount: 12020,
        earliestOpenMs: MOCK_NOW_MS - 501 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 60 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 2 * 60 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "healthy",
    },
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "ETHUSDT",
        interval: "1m",
        totalCount: 190540,
        earliestOpenMs: MOCK_NOW_MS - 132 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 12 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 12 * 60 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "stale",
    },
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "ETHUSDT",
        interval: "15m",
        totalCount: 18760,
        earliestOpenMs: MOCK_NOW_MS - 195 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 15 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 8 * 60 * 1000,
        gapCount: 3,
        missingBars: 23,
        status: "gap",
    },
    {
        exchange: "binance",
        marketType: "spot",
        symbol: "SOLUSDT",
        interval: "1m",
        totalCount: 43120,
        earliestOpenMs: MOCK_NOW_MS - 30 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 2 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 90 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "healthy",
    },
    {
        exchange: "binance",
        marketType: "futures",
        symbol: "BTCUSDT",
        interval: "1m",
        totalCount: 93200,
        earliestOpenMs: MOCK_NOW_MS - 65 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 30 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "healthy",
    },
    {
        exchange: "binance",
        marketType: "futures",
        symbol: "ETHUSDT",
        interval: "5m",
        totalCount: 28790,
        earliestOpenMs: MOCK_NOW_MS - 100 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 45 * 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 45 * 60 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "stale",
    },
    {
        exchange: "okx",
        marketType: "spot",
        symbol: "BTC-USDT",
        interval: "1m",
        totalCount: 20680,
        earliestOpenMs: MOCK_NOW_MS - 15 * DAY_MS,
        latestOpenMs: MOCK_NOW_MS - 60 * 1000,
        lastUpdatedMs: MOCK_NOW_MS - 60 * 1000,
        gapCount: 0,
        missingBars: 0,
        status: "healthy",
    },
];

function wait(ms = 240) {
    return new Promise(resolve => {
        window.setTimeout(resolve, ms);
    });
}

function cloneSeries(series) {
    return series.map(item => ({ ...item }));
}

export async function fetchDatabaseSeries({ exchange = "", marketType = "" } = {}) {
    await wait();
    const normalizedExchange = String(exchange || "").toLowerCase();
    const normalizedMarketType = String(marketType || "").toLowerCase();
    const series = MOCK_SERIES.filter(item => {
        if (normalizedExchange && item.exchange !== normalizedExchange) return false;
        if (normalizedMarketType && item.marketType !== normalizedMarketType) return false;
        return true;
    });
    return {
        mode: "mock",
        generatedAtMs: MOCK_NOW_MS,
        storageSizeBytes: series.reduce((total, item) => total + item.totalCount * 200, 0),
        series: cloneSeries(series),
    };
}

export async function scanDatabaseSeriesGaps(seriesKey) {
    await wait(320);
    const missingBars = Number(seriesKey?.missingBars || 0);
    return {
        status: missingBars > 0 ? "warning" : "ok",
        message: missingBars > 0 ? "发现缺口，等待后端扫描接口接入" : "未发现明显缺口",
        gapCount: Number(seriesKey?.gapCount || 0),
        missingBars,
    };
}

export async function requestDatabaseBackfill({ seriesKey, targetEndMs }) {
    await wait(420);
    const latestOpenMs = Number(seriesKey?.latestOpenMs || 0);
    const targetMs = Number(targetEndMs || 0);
    if (!targetMs || targetMs <= latestOpenMs) {
        return {
            status: "already_complete",
            message: "当前覆盖已经到达目标位置",
            currentLatestMs: latestOpenMs,
            targetEndMs: targetMs,
            estimatedBars: 0,
        };
    }
    return {
        status: "started",
        message: "已创建模拟补全任务，等待真实后端接入",
        currentLatestMs: latestOpenMs,
        targetEndMs: targetMs,
        estimatedBars: Number(seriesKey?.estimatedBars || 0),
    };
}

export async function deleteDatabaseSeries(seriesKey) {
    await wait(360);
    return {
        status: "ok",
        message: "已模拟删除该周期数据",
        deletedBars: Number(seriesKey?.totalCount || 0),
    };
}

export async function deleteDatabaseSymbol({ symbol, intervals = [] }) {
    await wait(420);
    const deletedBars = intervals.reduce((total, item) => total + Number(item.totalCount || 0), 0);
    return {
        status: "ok",
        message: "已模拟删除该商品的全部周期数据",
        symbol,
        deletedBars,
        deletedSeries: intervals.length,
    };
}
