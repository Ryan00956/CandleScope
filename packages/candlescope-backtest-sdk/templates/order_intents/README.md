# 显式 Market / Limit / Stop / Stop-Limit

- 假设：按 BAR 轮转四种订单意图，证明 Host 拥有接受/拒绝和成交。
- signal clock：`BAR_CLOSE`。
- warmup：0。
- 参数范围：无。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：返回意图等于已接受订单或成交；Limit/Stop 在 BAR 上不是盘口真相。
- BAR 与 aggTrade：Market 在 BAR 上按 Host 路径假设成交；Stop/Limit 需要 Host 规则，不是 raw trade。
- golden：见 `templates/goldens/order_intents.json`。
