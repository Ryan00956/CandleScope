# ADR-BACKTEST-011：Study V2 与一次性样本外验证

- 状态：Accepted
- 日期：2026-08-15
- 基线：`acf9a1cd97ae4cb24e14dd2feb96a28dc6135fb4`

## 决策

新增 Study 身份 `BACKTEST_WALK_FORWARD_V2` 与选择协议
`TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2`。旧 Study 未声明该身份时继续走 legacy V1；不得用
新实现重解释已有 Study、Run 或报告。

V2 冻结 hypothesis、数据 snapshot、train/test/holdout 窗口、purge/embargo、参数空间、sampler/seed、
objective/constraints/tie-break、候选和总 Run 预算、账户/成交/费用/指标模型及 benchmark。test 窗口不得
重叠；每个 fold 只能以 TRAIN 报告选择一次参数，selection receipt 为 append-only、带 canonical hash，
receipt 写入后才允许创建唯一 TestRun。TestRun 与 holdout 报告不是选择函数的输入。
所有窗口冻结为 `START_INCLUSIVE_END_EXCLUSIVE_V2`；API 可以接收精确的 exclusive 边界或最后一根
bar 的 inclusive close，后者在创建 Study 时规范化为 exclusive 身份，其他非对齐边界失败关闭。

第一批 objective 只允许 `NET_RETURN`、`SHARPE`、`CALMAR`、`EXPECTANCY`。候选必须先通过完整交易数、
最大回撤、覆盖率、ambiguity/rejected 比例和可选成本 +25% 后仍为正等冻结约束；无交易或违反约束的
候选不得获胜。objective 相同时按最大回撤升序、参数 hash 升序确定性决胜。

## OOS 与 holdout

OOS 报告 `candlescope.backtest-oos-report/1` 只接受 `run_role=TEST` 且绑定已封存 receipt 的 Run，按 fold
顺序拼接归一化日权益。它同时记录 train/test 落差、参数邻域、成本与延迟敏感性、bootstrap、市场阶段、
buy-and-hold 与 always-flat 基准以及 selection-bias 警告。报告及其 hash 不包含 holdout。

可选 holdout 在研究期间只允许从 `SEALED` 原子转换到 `REVEALED` 一次；揭示 receipt
`candlescope.backtest-holdout-reveal/1` 带 hash，随后最多创建一个 HOLDOUT Run。holdout 不得回写 fold
选择或 OOS 报告。

## 持久化、恢复与取消

schema v3 显式持久化 `Study -> Fold -> TrainTrial -> SelectionReceipt -> TestRun`，并另存 holdout 与 OOS。
worker 重启从持久化状态继续；唯一约束和幂等装配禁止重复 TestRun 或重复揭示。取消只停止规划新 Run，
已完成 Train/Test 报告和 receipt 保留。预算只能受已有全局上限与 Study 冻结值收紧，不能运行中放大。

## 后果

Study V2 只用于研究证据，不构成 paper/live/生产批准。所有生产 flags 继续默认关闭。schema v3 回滚到
v2 仅允许在数据库不存在 V2 Study 数据、服务停止并先写独立备份时执行；否则失败关闭并要求显式数据
迁移或清理授权。
