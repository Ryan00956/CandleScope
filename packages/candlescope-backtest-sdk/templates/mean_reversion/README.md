# 均值回归

- 假设：收盘低于均线 − band 做多，高于均线 + band 做空。
- signal clock：`BAR_CLOSE`。
- warmup：`lookback`。
- 参数范围：lookback ≥ 2，band > 0。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：均值必然回归、实盘批准、无成本。
- BAR 与 aggTrade：偏离用已收盘价；成交由 Host 按所选精度解释。
- golden：见 `templates/goldens/mean_reversion.json`。
