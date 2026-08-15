# snapshot / restore 示例

- 假设：均线状态必须可冻结和恢复，checkpoint 后决策与连续运行一致。
- signal clock：`BAR_CLOSE`。
- warmup：`max(fast, slow)`。
- 参数范围：fast ≥ 2，slow ≥ 3。
- 支持的 fidelity：`BAR_APPROX`、`AGG_TRADE_EXECUTION`。
- 不能声称：snapshot 可写 Host 账户或数据库；restore 可读取未来 bar。
- BAR 与 aggTrade：状态只含已观察收盘价；Host 拥有 checkpoint 身份。
- golden：见 `templates/goldens/snapshot_restore.json`。
