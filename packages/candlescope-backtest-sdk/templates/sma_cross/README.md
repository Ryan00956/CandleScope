# SMA 交叉多空

- 假设：快均线上穿慢均线做多，下穿做空。
- signal clock：`BAR_CLOSE`。
- warmup：`max(fast, slow)`。
- 参数范围：fast ≥ 2，slow > fast（研究时自行约束）。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：实盘批准、K 线内部唯一路径、raw trade、queue exact。
- BAR 与 aggTrade：BAR 只在收盘决策；aggTrade 只解释随后聚合成交，不是盘口排队。
- golden：见 `templates/goldens/sma_cross.json`。
