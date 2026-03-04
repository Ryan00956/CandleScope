"""
模拟数据生成器
当无法连接币安 API 时，提供真实感的模拟 K 线数据
用于开发和演示
"""
import random
import time
import math


def generate_mock_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    count: int = 500,
) -> list[dict]:
    """
    生成模拟的 K 线数据（Lightweight Charts 格式）
    数据包含趋势、波动、成交量等真实特征
    """
    # 不同交易对的基础价格
    base_prices = {
        "BTCUSDT": 87500.0,
        "ETHUSDT": 3200.0,
        "BNBUSDT": 420.0,
        "SOLUSDT": 145.0,
        "DOGEUSDT": 0.12,
    }

    # 时间间隔（秒）
    interval_seconds = {
        "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "2h": 7200, "4h": 14400,
        "1d": 86400, "1w": 604800, "1M": 2592000,
    }

    base_price = base_prices.get(symbol, 50000.0)
    interval_sec = interval_seconds.get(interval, 3600)

    # 从 count 根 K 线前开始
    now = int(time.time())
    start_time = now - (count * interval_sec)

    # 波动率参数（根据周期调整）
    if interval_sec <= 300:       # 1m ~ 5m
        volatility = 0.0008
    elif interval_sec <= 3600:    # 15m ~ 1h
        volatility = 0.003
    elif interval_sec <= 14400:   # 2h ~ 4h
        volatility = 0.008
    else:                          # 1d+
        volatility = 0.02

    records = []
    price = base_price * (1 + random.uniform(-0.1, 0.05))  # 随机起始偏移

    # 生成一个大趋势（模拟牛/熊市）
    trend = random.choice([-1, 1]) * random.uniform(0.00002, 0.00008)

    for i in range(count):
        t = start_time + i * interval_sec

        # 趋势 + 随机噪声 + 周期性波动（模拟日内交易节奏）
        cycle = math.sin(2 * math.pi * i / 48) * volatility * 0.3
        noise = random.gauss(0, volatility)
        change = trend + noise + cycle

        open_price = price
        close_price = open_price * (1 + change)

        # 影线（wick）
        wick_up = abs(random.gauss(0, volatility * 0.6))
        wick_down = abs(random.gauss(0, volatility * 0.6))

        high_price = max(open_price, close_price) * (1 + wick_up)
        low_price = min(open_price, close_price) * (1 - wick_down)

        # 成交量（价格变动大时成交量也大）
        base_volume = base_price * 0.1
        vol_multiplier = 1 + abs(change) * 50 + random.uniform(0, 1)
        volume = base_volume * vol_multiplier

        # 精度
        if base_price >= 1000:
            decimals = 2
        elif base_price >= 1:
            decimals = 4
        else:
            decimals = 8

        records.append({
            "time": t,
            "open": round(open_price, decimals),
            "high": round(high_price, decimals),
            "low": round(low_price, decimals),
            "close": round(close_price, decimals),
            "volume": round(volume, 2),
        })

        price = close_price

        # 偶尔改变趋势方向（模拟反转）
        if random.random() < 0.02:
            trend = -trend * random.uniform(0.5, 1.5)

    return records
