# Donchian / 区间突破

- 假设：收盘突破前 lookback 根最高价做多，跌破最低价做空。
- signal clock：`BAR_CLOSE`。
- warmup：`lookback`。
- 参数范围：lookback ≥ 2。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：突破一定持续、queue exact、实盘批准。
- BAR 与 aggTrade：突破判定只用已完结高低点；aggTrade 不是 raw trade。
- golden：见 `templates/goldens/donchian_breakout.json`。
