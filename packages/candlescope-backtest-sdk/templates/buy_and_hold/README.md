# 买入并持有基准

- 假设：始终目标多头 1 手，用作对照而不是交易系统。
- signal clock：`BAR_CLOSE`。
- warmup：0。
- 参数范围：无。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：无风险、无回撤、实盘批准。
- BAR 与 aggTrade：开仓时机仍由 Host 撮合解释，不是“已经持有”。
- golden：见 `templates/goldens/buy_and_hold.json`。
