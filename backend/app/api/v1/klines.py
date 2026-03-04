"""
K线数据 API 路由 (v1)
支持真实数据和模拟数据（自动降级）
"""
from fastapi import APIRouter, Query, HTTPException

from app.data_engine.collectors.binance.spot_fetcher import (
    fetch_klines,
    fetch_klines_history,
    df_to_lightweight_charts,
)
from app.data_engine.mock_data import generate_mock_klines

router = APIRouter(prefix="/klines", tags=["K线数据"])

# 支持的时间周期
VALID_INTERVALS = [
    "1s", "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
]

# 不同周期对应的默认拉取天数
INTERVAL_DAYS = {
    "1m": 1, "3m": 2, "5m": 3, "15m": 7, "30m": 14,
    "1h": 30, "2h": 60, "4h": 90,
    "1d": 365, "1w": 365, "1M": 365,
}


@router.get("/")
async def get_klines(
    symbol: str = Query("BTCUSDT", description="交易对，如 BTCUSDT"),
    interval: str = Query("1m", description="时间周期"),
    limit: int = Query(500, ge=1, le=1000, description="K线数量"),
):
    """
    获取最新的K线数据（单次请求，最多 1000 根）
    如果无法连接交易所，自动返回模拟数据
    """
    if interval not in VALID_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的时间周期: {interval}，支持: {VALID_INTERVALS}",
        )

    # 尝试获取真实数据
    try:
        df = fetch_klines(symbol=symbol, interval=interval, limit=limit)
        if df is not None and not df.empty:
            return {
                "symbol": symbol,
                "interval": interval,
                "count": len(df),
                "source": "binance",
                "data": df_to_lightweight_charts(df),
            }
    except Exception as e:
        print(f"⚠️ 真实数据获取失败: {e}")

    # 降级到模拟数据
    print(f"📊 使用模拟数据: {symbol} {interval}")
    mock_data = generate_mock_klines(symbol=symbol, interval=interval, count=limit)
    return {
        "symbol": symbol,
        "interval": interval,
        "count": len(mock_data),
        "source": "mock",
        "data": mock_data,
    }


@router.get("/history")
async def get_klines_history(
    symbol: str = Query("BTCUSDT", description="交易对"),
    interval: str = Query("1h", description="时间周期"),
    days: int = Query(7, ge=1, le=365, description="拉取天数"),
):
    """
    获取历史K线数据（自动分页，可拉取多天）
    如果无法连接交易所，自动返回模拟数据
    """
    if interval not in VALID_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的时间周期: {interval}",
        )

    # 尝试获取真实数据
    try:
        df = fetch_klines_history(symbol=symbol, interval=interval, days=days)
        if df is not None and not df.empty:
            return {
                "symbol": symbol,
                "interval": interval,
                "days": days,
                "count": len(df),
                "source": "binance",
                "data": df_to_lightweight_charts(df),
            }
    except Exception as e:
        print(f"⚠️ 历史数据获取失败: {e}")

    # 降级到模拟数据（按天数估算 K 线数量）
    interval_seconds = {
        "1s": 1, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "8h": 28800,
        "12h": 43200, "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2592000,
    }
    sec = interval_seconds.get(interval, 3600)
    count = min(int(days * 86400 / sec), 2000)

    print(f"📊 使用模拟数据: {symbol} {interval} {days}天 ≈ {count} 根")
    mock_data = generate_mock_klines(symbol=symbol, interval=interval, count=count)
    return {
        "symbol": symbol,
        "interval": interval,
        "days": days,
        "count": len(mock_data),
        "source": "mock",
        "data": mock_data,
    }
