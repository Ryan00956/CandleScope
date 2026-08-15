# Wilder RSI24 多空

- 假设：Wilder RSI 进入超卖做多、进入超买做空。
- signal clock：`BAR_CLOSE`。
- warmup：`length` 根已完结 K 线。
- 参数范围：length ≥ 2，oversold < overbought。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：TradingView 等价、实盘批准、K 线内唯一路径。
- BAR 与 aggTrade：信号只看已收盘 RSI；aggTrade 只解释 Host 随后撮合。
- golden：见 `templates/goldens/rsi_wilder_24.json`。
