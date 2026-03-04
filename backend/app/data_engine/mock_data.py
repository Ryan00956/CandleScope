"""
模拟数据生成器
当无法连接币安 API 时，提供真实感的模拟 K 线数据
用于开发和演示
"""
import random
import time
import math
import hashlib

def _get_price_at_minute(symbol_seed: int, base_price: float, minute_step: int) -> float:
    """
    给定一个分钟级别的 step，返回该分钟的确定性价格。
    所有 interval 共享同一条价格曲线，确保同一时刻价格一致。
    """
    # 用 symbol_seed + 分钟step 生成确定性噪声
    rng = random.Random(symbol_seed + minute_step)
    # 长周期趋势 + 中周期波动 + 短周期噪声
    trend = math.sin(minute_step * 0.00002) * 0.08      # ±8% 超长周期
    cycle = math.sin(minute_step * 0.0003) * 0.03        # ±3% 中周期
    noise = (rng.random() - 0.5) * 0.001                 # ±0.05% 每分钟随机
    factor = 1.0 + trend + cycle + noise
    return base_price * factor


def generate_mock_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    count: int = 500,
) -> list[dict]:
    """
    生成确定性的模拟 K 线数据。
    核心原理：基于一条按分钟步进的共享价格曲线，不同 interval 只是在不同
    时间粒度上采样，从而保证同一时刻（尤其是最新K线的 close）在所有周期
    下都完全一致。
    """
    # 不同交易对的基础价格
    base_prices = {
        "BTCUSDT": 92500.0,
        "ETHUSDT": 3350.0,
        "BNBUSDT": 580.0,
        "SOLUSDT": 185.0,
        "DOGEUSDT": 0.18,
    }

    # 时间间隔（秒）
    interval_seconds = {
        "1s": 1, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
        "1h": 3600, "2h": 7200, "4h": 14400,
        "1d": 86400, "1w": 604800, "1M": 2592000,
    }

    base_price = base_prices.get(symbol.upper(), 50000.0)
    interval_sec = interval_seconds.get(interval, 3600)

    now = int(time.time())
    # 锚点: 2024-01-01 00:00:00 UTC
    anchor_time = 1704067200

    # 使用 symbol 的 hash 作为种子
    seed = int(hashlib.md5(symbol.upper().encode()).hexdigest(), 16) % 10**8

    # 精度
    decimals = 2 if base_price >= 1000 else (4 if base_price >= 1 else 8)

    # ---- 计算每根K线的时间对齐 ----
    # 最后一根K线的开盘时间 = 当前时间往下对齐到 interval 边界
    latest_open = anchor_time + ((now - anchor_time) // interval_sec) * interval_sec
    # 第一根K线的开盘时间
    first_open = latest_open - (count - 1) * interval_sec

    records = []

    # 每个 interval 内采样的分钟数（用于计算 OHLC）
    # 为了性能，大 interval 不逐分钟采样，而是按固定采样点模拟
    interval_minutes = max(interval_sec // 60, 1)
    # 采样点数量：最多 60 个采样点，最少 1 个
    sample_count = min(interval_minutes, 60)

    for i in range(count):
        bar_open_time = first_open + i * interval_sec
        if bar_open_time > now:
            break

        # 该 K 线的结束时间（不超过当前时间）
        bar_close_time = min(bar_open_time + interval_sec, now)

        # 将该区间内的时间转换为分钟 step
        open_minute = (bar_open_time - anchor_time) // 60
        close_minute = (bar_close_time - anchor_time) // 60

        # 计算 open 和 close 价格（共享曲线）
        open_price = _get_price_at_minute(seed, base_price, open_minute)
        close_price = _get_price_at_minute(seed, base_price, close_minute)

        # 在区间内采样若干点来估算 high / low
        high_price = max(open_price, close_price)
        low_price = min(open_price, close_price)

        if sample_count > 1 and close_minute > open_minute:
            step = max((close_minute - open_minute) // sample_count, 1)
            for m in range(open_minute, close_minute + 1, step):
                p = _get_price_at_minute(seed, base_price, m)
                if p > high_price:
                    high_price = p
                if p < low_price:
                    low_price = p

        # 给 high/low 加一点影线
        bar_rng = random.Random(seed + open_minute)
        wick = bar_rng.random() * 0.001  # 0~0.1% 影线
        high_price *= (1 + wick)
        low_price *= (1 - wick)

        # 成交量
        volume = base_price * (10 + bar_rng.random() * 90)

        records.append({
            "time": bar_open_time,
            "open": round(open_price, decimals),
            "high": round(high_price, decimals),
            "low": round(low_price, decimals),
            "close": round(close_price, decimals),
            "volume": round(volume, 2),
        })

    return records
