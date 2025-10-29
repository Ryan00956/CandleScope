import pandas as pd
a=pd.read_csv("binance_eth_1d_1years.csv")
a["datetime"]=pd.to_datetime(a["datetime"])
a.set_index("datetime", inplace=True)
print(a)
monthly = a['close'].resample('W').mean()
print(monthly)