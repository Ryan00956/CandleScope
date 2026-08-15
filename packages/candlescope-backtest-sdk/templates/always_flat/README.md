# 始终空仓基准

- 假设：始终目标仓位 0，用作对照。
- signal clock：`BAR_CLOSE`。
- warmup：0。
- 参数范围：无。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：空仓等于零风险资金曲线（仍可能有费用场景）。
- BAR 与 aggTrade：决策为空仓；Host 不应因此发明成交。
- golden：见 `templates/goldens/always_flat.json`。
