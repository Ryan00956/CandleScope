import requests
import pandas as pd
import time
from datetime import datetime, timedelta

# 币安的k线数据下载器

# BASE_URL = "https://api.binance.me"

def choose_base_url() -> str:
    """检测当前公网 IP 所在国家（返回国家代码，如 CN、US、SG）"""
    country = "CN"  # ✅ 先定义默认值，避免未定义情况
    try:
        r = requests.get("https://ipapi.co/json/", timeout=10)
        if r.status_code == 200:
            country = r.json().get("country", "UNKNOWN")
    except Exception as e:
        print("IP检测失败：", e)
    print(r.status_code)
    print("当前检测国家代码:", country)

    if country == "CN":
        return "https://api.binance.me"
    else:
        return "https://api.binance.com"



def fetch_binance_klines(
        symbol : str = "BTCUSDT",
        interval : str = "1m",
        limit : int = 100,
        start_ms : int | None = None,
        end_ms : int | None = None,
)->pd.DataFrame:
    """
    拉取币安现货K线为 pandas.DataFrame（时间升序）
    列：Open, High, Low, Close, Volume, QuoteVolume, Trades, TakerBuyBase, TakerBuyQuote
    索引：DatetimeIndex（UTC毫秒）
    """
    base_url="https://api.binance.me"
    assert 1 <= limit <= 1000 , "request too many klines,please ensure 1 <= limit <= 1000"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    if start_ms is not None:
        params["startTime"] = start_ms
    if end_ms is not None:
        params["endTime"] = end_ms

    url = f"{base_url}/api/v3/klines"
    retries = 5
    test=0
    changed_url=False
    for i in range(retries):
        try:
            r = requests.get(url, params=params,timeout=5)
            r.raise_for_status()
            data = r.json()
            break
        except requests.exceptions.Timeout as e:
            if test == 2 :
                url=f"https://api.binance.me/api/v3/klines"
                continue
            print("⏰ Request timed out, retrying in 3s...")
            time.sleep(3)
        except requests.exceptions.HTTPError as e:

            code = e.response.status_code
            print(f"HTTP Error {code}: {e.response.reason}")
            if code == 429:
                print("⚠️ Too many requests — waiting 60s...")
                time.sleep(60)
            elif code == 418:
                print("🚫 IP banned — stop requesting.")
                break
            elif code == 403:
                print("❌ Forbidden — server rejected access.")
                break
            elif code == 451 :
                if changed_url :
                    print("🌍 Access blocked by region — Binance API not available in your country.")
                    break
                url=f"https://api.binance.me/api/v3/klines"
                changed_url=True
                continue


            elif code == 500 or code == 503:
                print("💥 Binance service temporarily unavailable.")
                time.sleep(10)
            else:
                print("Unhandled error, stopping.")
                break
        finally:
                test+=1


    # 币安返回每根K线的字段顺序（数组形式）：
    # [ openTime, open, high, low, close, volume,
    #   closeTime, quoteAssetVolume, numberOfTrades,
    #   takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore ]
    # 我们转成 DataFrame 并改成常用列名
    try:
        cols = [
            "openTime", "Open", "High", "Low", "Close", "Volume",
            "closeTime", "QuoteVolume", "Trades",
            "TakerBuyBase", "TakerBuyQuote", "_ignore"
        ]
        df = pd.DataFrame(data, columns=cols)
        df["openTimeStamp"]=df["openTime"]
        df["closeTimeStamp"]=df["closeTime"]
        df["closeTimeStamp"] = pd.to_numeric(df["closeTimeStamp"], errors="coerce", downcast="integer")
        df["openTimeStamp"] = pd.to_numeric(df["openTimeStamp"], errors="coerce", downcast="integer")
        df["openTime"]=pd.to_datetime(df["openTime"], unit="ms",utc=True)
        df["closeTime"]=pd.to_datetime(df["closeTime"], unit="ms",utc=True)
        for c in ["Open","High","Low","Close","Volume","QuoteVolume","TakerBuyBase","TakerBuyQuote"]:
            df[c]=pd.to_numeric(df[c], errors="coerce")
        df["Trades"] = pd.to_numeric(df["Trades"], errors="coerce", downcast="integer")
        df=df.set_index("openTime").sort_index()
        df.index.name = "Date"
        df.drop(columns=["_ignore"], inplace=True)
        return df
    except Exception as e:
        print("data fetch failed",e)


def fetch_binance_klines_history(
        symbol : str = "BTCUSDT",
        interval : str = "1m",
        limit : int = 100,
        days: int =7
) -> pd.DataFrame:

    end_time=int(time.time()*1000)
    start_time=end_time-days*24*60*60*1000
    start_time=align_to_interval(start_time,interval)
    all_df=[]

    while True:
        df=fetch_binance_klines(
            symbol=symbol,
            interval=interval,
            limit=limit,
            start_ms=start_time,
            end_ms=end_time,
        )
        if   df is None or df.empty:
            break
        all_df.append(df)
        oldest=int(df["openTimeStamp"].iloc[0])
        if oldest <= start_time:
            break
        end_time=oldest
        time.sleep(0.5)
    if not all_df :
        return pd.DataFrame()

    big_df = pd.concat(all_df).sort_index().drop_duplicates()
    return big_df

def align_to_interval(time_stamps:int,interval:int)->int:
    unit=interval[-1]
    value=int(interval[:-1])
    dt=datetime.utcfromtimestamp(time_stamps//1000)
    # 1761733834 000
    if unit == "m":
        ms_per_interval=value*60*1000
        return (time_stamps//ms_per_interval)*ms_per_interval
    elif unit == "h":
        ms_per_interval=value*60*1000*60
        return (time_stamps//ms_per_interval)*ms_per_interval
    elif unit == "d":
        aligned=datetime(dt.year, dt.month, dt.day)
        return int(aligned.timestamp()*1000)
    elif unit == "w":
        aligned = datetime(dt.year, dt.month, dt.day) - timedelta(days=dt.weekday())
        return int(aligned.timestamp()*1000)
    elif unit == "M":
        aligned = datetime(dt.year, dt.month, 1)
        return int(aligned.timestamp() * 1000)
    elif unit == "y":
        aligned = datetime(dt.year, 1, 1)
    else:
        raise ValueError(f"Unsupported interval: {interval}")



if __name__ == "__main__":
    # base_url = choose_base_url()
    df = fetch_binance_klines_history("BTCUSDT", "1h", days=3)
    print(df.head())
    print(df.tail())
    df.to_csv("BTCUSDT_1m.csv")



