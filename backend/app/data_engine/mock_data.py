"""
模拟数据生成器
当无法连接币安 API 时，提供真实感的模拟 K 线数据
用于开发和演示
"""
import random
import time
import math
import hashlib

def generate_mock_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    count: int = 500,
) -> list[dict]:
    """
    生成确定性的模拟 K 线数据。通过 symbol 作为种子，确保同一币种在不同周期下的价格大致统一。
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

    # 现在的秒级时间戳
    now = int(time.time())
    # 为了让数据看起来是连续的，我们基于固定的时间锚点来生成
    # 比如基于 2024-01-01 00:00:00 (1704067200)
    anchor_time = 1704067200
    
    # 使用 symbol 的 hash 作为种子，保证不同 symbol 不同趋势
    seed = int(hashlib.md5(symbol.upper().encode()).hexdigest(), 16) % 10**8
    rng = random.Random(seed)
    
    # 波动率参数
    volatility = 0.001 if interval_sec <= 3600 else 0.005
    
    records = []
    
    # 模拟从锚点到现在的步数（用于对齐）
    start_step = (now - anchor_time) // interval_sec - count
    
    # 累加步长来计算价格，这样即使请求不同 limit，数据也是对齐的
    # 为了性能，直接从 start_step 推导出一个起始价
    # 这里用一个简单的伪随机方程来模拟
    current_price = base_price * (1 + math.sin(start_step * 0.001) * 0.05 + rng.uniform(-0.02, 0.02))

    for i in range(count):
        step = start_step + i
        t = anchor_time + step * interval_sec
        # 如果生成的时间超过现在，则修正为现在
        if t > now: break

        # 基于 step 生成确定性的波动
        # 使用 rng 控制主要的噪声风格，但结合 step 保证连续性
        walk = math.sin(step * 0.005) * 0.01 + math.cos(step * 0.02) * 0.002
        noise = (random.Random(seed + step).random() - 0.5) * volatility
        
        open_price = current_price
        close_price = open_price * (1 + walk * 0.1 + noise)
        
        high_price = max(open_price, close_price) * (1 + abs(noise) * 0.5)
        low_price = min(open_price, close_price) * (1 - abs(noise) * 0.5)
        
        volume = base_price * (10 + random.Random(seed + step).random() * 90)

        # 精度
        decimals = 2 if base_price >= 1000 else (4 if base_price >= 1 else 8)

        records.append({
            "time": t,
            "open": round(open_price, decimals),
            "high": round(high_price, decimals),
            "low": round(low_price, decimals),
            "close": round(close_price, decimals),
            "volume": round(volume, 2),
        })
        current_price = close_price

    return records
