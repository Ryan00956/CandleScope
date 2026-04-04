"""
币安现货数据采集器（重构版 v2）
  1. 所有硬编码参数提取到 config
  2. 自动遍历所有节点，直到成功
  3. 支持代理 (HTTP_PROXY 环境变量)
  4. 返回标准化的 dict 列表（方便 JSON 序列化）
"""
import os
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
from app.core.config import (
    BINANCE_BASE_URL, BINANCE_BASE_URLS,
    REQUEST_TIMEOUT, MAX_RETRIES, RATE_LIMIT_SLEEP,
    get_effective_proxy, load_proxy_settings,
)

# 缓存上一次成功的 base_url，避免每次都从头遍历
_last_working_url: str | None = None


def _fetch_with_current_proxy(url: str, params: dict, timeout: int) -> requests.Response:
    """Resolve proxy per request so runtime setting changes take effect immediately."""
    mode = load_proxy_settings().get("mode", "system")
    if mode == "none":
        # ``requests`` otherwise falls back to env proxies automatically.
        with requests.Session() as session:
            session.trust_env = False
            return session.get(url, params=params, timeout=timeout)

    proxy = get_effective_proxy()
    if proxy:
        proxies = {"http": proxy, "https": proxy}
        return requests.get(url, params=params, timeout=timeout, proxies=proxies)
    return requests.get(url, params=params, timeout=timeout)


def _try_fetch_klines(base_url: str, params: dict, timeout: int) -> list | None:
    """尝试从指定 base_url 获取 K 线数据，成功返回 list，失败返回 None"""
    global _last_working_url
    url = f"{base_url}/api/v3/klines"
    try:
        r = _fetch_with_current_proxy(url, params, timeout)
        if r.status_code == 200:
            _last_working_url = base_url
            return r.json()
        else:
            print(f"   WARN {base_url} -> HTTP {r.status_code}")
            return None
    except requests.exceptions.Timeout:
        print(f"   TIMEOUT {base_url}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"   ERROR {base_url} -> {e}")
        return None


def fetch_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1m",
    limit: int = 500,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> pd.DataFrame | None:
    """
    拉取币安现货K线数据，返回 pandas DataFrame（时间升序）
    自动遍历所有可用节点，直到成功
    """
    assert 1 <= limit <= 1000, "limit 必须在 1~1000 之间"

    params = {"symbol": symbol, "interval": interval, "limit": limit}
    if start_ms is not None:
        params["startTime"] = start_ms
    if end_ms is not None:
        params["endTime"] = end_ms

    data = None

    # 构建尝试顺序：上次成功的 URL 优先，然后是默认 URL，再遍历其余
    urls_to_try = []
    if _last_working_url:
        urls_to_try.append(_last_working_url)
    if BINANCE_BASE_URL not in urls_to_try:
        urls_to_try.append(BINANCE_BASE_URL)
    for u in BINANCE_BASE_URLS:
        if u not in urls_to_try:
            urls_to_try.append(u)

    for attempt in range(MAX_RETRIES):
        print(f"KLINE_REQUEST [{attempt+1}/{MAX_RETRIES}] {symbol} {interval} limit={limit}")

        for base_url in urls_to_try:
            result = _try_fetch_klines(base_url, params, REQUEST_TIMEOUT)
            if result is not None:
                data = result
                break

        if data is not None:
            break

        # 所有节点都失败了，等一下再重试
        if attempt < MAX_RETRIES - 1:
            print(f"   ALL_ENDPOINTS_FAILED, retry in 3s (attempt {attempt+2})")
            time.sleep(3)

    if data is None:
        return None

    # 解析 K 线数据
    cols = [
        "openTime", "Open", "High", "Low", "Close", "Volume",
        "closeTime", "QuoteVolume", "Trades",
        "TakerBuyBase", "TakerBuyQuote", "_ignore",
    ]
    df = pd.DataFrame(data, columns=cols)

    # 保留原始时间戳（毫秒）
    df["openTimeStamp"] = pd.to_numeric(df["openTime"], errors="coerce")
    df["closeTimeStamp"] = pd.to_numeric(df["closeTime"], errors="coerce")

    # 转换为 datetime
    df["openTime"] = pd.to_datetime(df["openTime"], unit="ms", utc=True)
    df["closeTime"] = pd.to_datetime(df["closeTime"], unit="ms", utc=True)

    # 数值列类型转换
    numeric_cols = ["Open", "High", "Low", "Close", "Volume",
                    "QuoteVolume", "TakerBuyBase", "TakerBuyQuote"]
    for c in numeric_cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["Trades"] = pd.to_numeric(df["Trades"], errors="coerce", downcast="integer")

    # 设置索引
    df = df.set_index("openTime").sort_index()
    df.index.name = "Date"
    df.drop(columns=["_ignore"], inplace=True)

    return df


def fetch_klines_history(
    symbol: str = "BTCUSDT",
    interval: str = "1m",
    limit: int = 500,
    days: int = 7,
) -> pd.DataFrame:
    """
    拉取多天历史K线，自动分页
    """
    end_time = int(time.time() * 1000)
    start_time = end_time - days * 24 * 60 * 60 * 1000
    all_dfs: list[pd.DataFrame] = []

    while True:
        df = fetch_klines(
            symbol=symbol,
            interval=interval,
            limit=limit,
            end_ms=end_time,
        )
        if df is None or df.empty:
            break

        all_dfs.append(df)
        oldest = int(df["openTimeStamp"].iloc[0])

        if oldest <= start_time:
            break

        end_time = oldest
        time.sleep(0.2)  # 避免触发频率限制

    if not all_dfs:
        return pd.DataFrame()

    big_df = pd.concat(all_dfs).sort_index().drop_duplicates()
    return big_df


def df_to_lightweight_charts(df: pd.DataFrame) -> list[dict]:
    """
    将 DataFrame 转换为 Lightweight Charts 所需的格式
    [{time: unix_timestamp, open, high, low, close, volume}, ...]
    """
    if df is None or df.empty:
        return []

    records = []
    for idx, row in df.iterrows():
        records.append({
            "time": int(row["openTimeStamp"]) // 1000,  # LWC 需要秒级时间戳
            "open": round(float(row["Open"]), 8),
            "high": round(float(row["High"]), 8),
            "low": round(float(row["Low"]), 8),
            "close": round(float(row["Close"]), 8),
            "volume": round(float(row["Volume"]), 8),
        })
    return records
