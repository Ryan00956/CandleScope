# Backtest M8 阶段执行计划（2026-08-15）

## 基线与范围

- 分支：`codex/backtest-foundation`
- 父提交：`acf9a1cd97ae4cb24e14dd2feb96a28dc6135fb4`
- 启动状态：工作树清洁；M7 提交、证据和退出门禁已核对。
- 旧 Study focused baseline：`7 passed`。
- 阶段范围只包含 M8「Study V2 与真正 Walk-forward」；不实现 M9 策略修订工作流或 M11 多市场组合。

## 冻结合同

1. 新建 Study V2 使用 `BACKTEST_WALK_FORWARD_V2`，旧 Study 不改变语义。
2. 每 fold 的顺序只能是 `TrainTrial -> immutable SelectionReceipt -> one TestRun`；test 数据、test report hash 和 test run id 不进入选择输入。
3. fold 冻结 train/test、purge、embargo；可选 holdout 与所有 fold 隔离，并且只能生成一份 reveal receipt 和一个 Run。
4. 子 Run 使用 M7 `/2`、Decimal 权威指标、账户 V2、成交 V2、同 snapshot/cost/benchmark；Train 为 `IN_SAMPLE`，Test/Holdout 为 `OUT_OF_SAMPLE`。
5. 选择支持 `NET_RETURN/SHARPE/CALMAR/EXPECTANCY`，先应用冻结硬约束，再按 objective 和冻结 tie-break 选择；无交易、指标为 null、运行失败或违反约束者不可获胜。
6. OOS 报告只能读取每 fold 唯一 TestRun，不能混入 TrainTrial 或 Holdout；浏览器不重新计算选择或绩效公式。
7. selection receipt append-only 且 hash 可重算；相同冻结身份、seed、snapshot 和预算产生相同 receipt hash。
8. 生产 flags 与高精度 flags 继续默认关闭；不联网补数据，不把 BAR/aggTrade 提升为不存在的精度。

## 实施步骤

### A. 身份、公式和迁移

- 新增 Study V2 模块，冻结 fold、sampler、candidate budget、objective、constraints、tie-break、账户/成交/费用/benchmark 和 selection protocol。
- SQLite schema 加法迁移，显式表：Study Fold、TrainTrial、SelectionReceipt、Holdout、OOS report；旧 studies/trials/reports 不重写。
- 提供 schema 升级与可验证 rollback drill；旧数据库升级、旧 Study 读取和 `/1`/`/2` 报告读取必须兼容。

### B. 选择与稳健性

- 从 `/2` Host 报告读取 objective 和约束：最小完整交易、最大回撤、最低覆盖、ambiguity/rejected 比例、成本 +25% 后为正。
- 多空样本不足为显式 warning；参数邻域、成本/延迟敏感性、固定 seed bootstrap、selection-bias warning、train/test gap、市场阶段与 buy-and-hold/always-flat 进入 Study/OOS 证据。
- receipt hash 排除 Study/Run UUID、时间戳和 test 数据，只绑定冻结研究身份与 train 候选评估。

### C. 调度、恢复与取消

- `start` 幂等落盘 folds/candidates；materializer 只创建缺失 TrainRun。
- 所有 train 终态后才写一次 receipt；receipt 已存在时只复用，不重选。
- receipt 后只创建一次 TestRun；重启通过确定性 idempotency key 恢复，不重复 test/holdout。
- 取消后不再规划新 Run，取消未终态子 Run并保留完成报告与 receipt；总 Run 预算必须小于等于 frozen ceiling，运行时只能收紧。

### D. OOS 与 Holdout

- 拼接 TestRun 的 mark-to-market 日权益为规范化 OOS 曲线，记录每 fold test 指标、train/test gap、benchmark 与 regime。
- 可选 holdout 在 OOS 完成前保持 sealed；显式 reveal 首次冻结参数与 receipt，重复调用返回同一证据，不能生成第二次揭示。

### E. API 与 UI

- 扩展 Study API schema、详情、OOS 和 holdout reveal 路径；V1 响应继续可读。
- UI 先填写 hypothesis，再配置 RSI24 参数空间、fold/purge/embargo、objective/constraints/seed/budget/holdout。
- 展示明确 Train/Test/Holdout 时间线、TRAIN-only 参数热图标识、每 fold selected params/receipt/Test result、拼接 OOS equity 和“不是实盘批准”。

### F. 测试与验收

- focused：选择无 test 泄漏、同 seed receipt、约束优先、OOS 仅 TestRun、holdout once、取消/恢复/预算、迁移/旧读取、hash 重算。
- 产品集成：deterministic local RSI24 Study 完成多个 fold，真实 Runtime/SQLite/报告，不使用模拟最终权益代替产品路径。
- 运行相关后端回归，前端 typecheck/lint/focused/full/build。
- 使用真实浏览器创建 RSI24 Study，观察 Train->Select->Test、fold 详情、OOS 曲线、下载/刷新恢复；保存截图、manifest、DB/hash/log。
- M8 未定义独立吞吐/soak 数值门槛；恢复与任务模型必须走真实产品路径，且不得用私有微基准替代。

## 风险、停止条件与回滚

- 风险：旧单表 trial 状态机误触 V2、receipt 竞争写入、test 在重启后重复、指标 null 被当 0、OOS 混入 train、schema 降级不兼容。
- 缓解：新版本分派、数据库唯一约束、确定性 idempotency、null fail-closed、role 校验、迁移/rollback fixture。
- 停止条件：任何 test 数据参与选择、receipt 不可复现、无交易候选获胜、OOS 含非 TestRun、holdout 可重复揭示、worker 恢复重复 Run、旧 Study 不可读、必须放宽断言/预算/数据质量才能通过。
- 回滚：阶段提交可独立 revert；schema rollback 只允许在验证无 M8 活跃任务并完成备份/证据导出后执行。生产 flags 默认关闭，因此本阶段不做生产迁移或启用。
