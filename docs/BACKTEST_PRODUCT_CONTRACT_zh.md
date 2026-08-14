# CandleScope 回测系统产品合同

状态：`PHASE0_CONTRACT_FROZEN_2026_08_14`

合同版本：`backtest.product.v1.phase0`

Phase 0 父提交：`5df19ae76686977f324644e9e62a63b73cf6a743`

配套执行文档：[`BACKTEST_SYSTEM_EXECUTION_zh.md`](BACKTEST_SYSTEM_EXECUTION_zh.md)

机器可读真值：[`backend/tests/fixtures/backtest/contract_golden.json`](../backend/tests/fixtures/backtest/contract_golden.json)

---

## 1. 合同地位与解释规则

本文是策略回测研究产品的产品真值。执行文档说明如何分阶段实现；本文回答“用户最终得到什么、每个精度声明究竟是什么意思、缺数据时必须怎样表现”。

本文使用以下约束词：

- **必须**：产品或数据正确性的硬合同，不能为了演示而降级。
- **应该**：默认行为；若实现需要偏离，必须先修订本文并更新 golden。
- **可以**：非阻塞增强，不得反向削弱硬合同。

若本文与执行文档冲突，以本文为准。执行文档可以规定实施顺序，但不能改写已经冻结的枚举、账户模型、BAR 成交规则、错误码或 Phase 1 数据接口。

Python、TypeScript 和 golden 必须逐值一致。新增、删除或改名必须先修订本合同、同步两端定义并更新 golden；未知值一律拒绝。

---

## 2. 产品结论

CandleScope **必须**同时保留两个不同产品，不得合并成同一个业务对象或同一套页面状态：

| 产品 | 核心对象 | 谁做决策 | 目的 |
| --- | --- | --- | --- |
| K 线回放训练 | `TrainingRun` | 人 | 训练观察、下单和复盘能力 |
| 策略回测研究 | `BacktestStudy` / `BacktestRun` | 策略提供器 | 发现、验证、比较和淘汰策略 |

两者只允许复用不可变市场数据快照、确定性事件时钟、撮合/订单/账本原语、checkpoint 与只读展示组件。

回测核心 **必须** 属于 CandleScope Host。插件只实现策略、脚本语言、模型推理或可替换计算环节，**不得** 拥有市场真相、撮合、账户、绩效指标或审计结果。

---

## 3. 核心名词

| 名词 | 合同含义 |
| --- | --- |
| `BacktestStudy` | 一个研究问题：假设、数据宇宙、切分、搜索空间和预算。它不是一次执行。 |
| `BacktestRun` | 一次冻结身份后的确定性执行。运行中不得改 fidelity、数据快照、策略修订或账户模型。 |
| `StrategyRevision` | 一次可执行策略修订。Run 只引用冻结 revision，永不引用“当前文件”。 |
| `ModelArtifact` | 已冻结的模型产物及其训练 provenance。回测期间不得覆盖。 |
| `MarketDatasetSnapshot` | 不可变、可重复打开的市场数据视图，带 snapshot hash 与质量证明。 |
| `ObservationFrame` | Host 按已批准 `InputPlan` 推送给 Provider 的有界观察，watermark 之后的数据不可见。 |
| `FidelityMode` | 本次 Run 的权威事件等级。它是身份的一部分，不能中途切换。 |
| `ReportLabel` | 报告必须使用的精度用语，不能把粗数据宣传成更细真相。 |
| `eligible_after_sequence` | 新订单最早可被匹配的市场事件序号。当前观察事件本身不可反向成交。 |

---

## 4. 第一版必须交付与明确不做

### 4.1 第一版必须交付

- 单市场、单账户、线性永续、单向持仓的冻结账户模型；
- `BAR_APPROX` 回测，Pyne 策略适配器，参数化运行；
- 经账户模型批准的 Market / Limit / Stop / Stop-Limit；
- 手续费、滑点、最小价格步长、最小数量和名义价值约束；
- 可恢复后台 Run、订单/成交/账本、权益曲线和可信度报告；
- 数据、策略、配置、输出的哈希和版本链；
- 独立回测工作台，不复用回放业务 store；
- 明确的样本内/样本外区间和基础 Study 比较。

### 4.2 第一版明确不做

- 真实订单发送、券商或交易所实盘连接；
- 插件直接访问数据库、任意文件、任意网络或 secrets；
- 用普通 L2 快照模拟真实队列位置；
- 缺少逐笔委托/撤单/撮合数据时提供 `QUEUE_EXACT`；
- 用最终 K 线高低点推断唯一的 K 线内部路径；
- 无界参数穷举、自动找“最佳策略”后直接推荐上线；
- 运行中重新训练并覆盖原模型文件；
- 多节点分布式执行、云端调度和租户计费；
- 把回放训练记录自动当作量化策略训练标签；
- 现货 long-only 与线性永续混用同一账户字段。

---

## 5. 第一版账户模型

第一版 **必须** 只冻结一个账户模型：`LINEAR_PERP_ONE_WAY_V1`。

| 项 | 冻结值 |
| --- | --- |
| 市场类型 | 线性永续（USDT 结算） |
| 持仓模式 | `ONE_WAY` |
| 保证金模式 | `CROSS` |
| 资金费 | `OFF`（BAR MVP）；后续 Phase 才能打开历史资金费 |
| 计价与数量 | `Decimal` 字符串；禁止二进制浮点作为权威值 |
| 未实现盈亏标记 | BAR MVP 使用 bar close；后续可升级为 mark，但必须改身份 |
| 爆仓 / 保险基金 / ADL | 第一版不建模；报告必须写 `UNMODELED` |
| 手续费 | 版本化 maker/taker；按成交名义价值计 |
| 滑点 | 固定 bps，写入 Run 身份 |
| 订单类型 | `MARKET`、`LIMIT`、`STOP`、`STOP_LIMIT` |
| TIF | `GTC`；`IOC`/`FOK`/`POST_ONLY` 第一版不做 |
| 更正 | 账本 append-only；只能追加 compensating record |

现货 long-only **必须** 作为后续独立账户模型引入，不得在本模型上叠加模糊字段。

---

## 6. 精度等级与报告用语

| `FidelityMode` | 权威事件 | `source_event_kind` | `ReportLabel` | 不能声称 |
| --- | --- | --- | --- | --- |
| `BAR_APPROX` | 完结 OHLCV | `BAR` | `APPROXIMATE` | K 线内部唯一顺序、精确止损/限价先后 |
| `TRADE_TAPE` | raw trade | `RAW_TRADE` | `TRADE_SEQUENCE` | 盘口深度、未成交挂单队列 |
| `AGG_TRADE_TAPE` | 聚合成交 | `AGG_TRADE` | `AGGREGATED_TRADE_SEQUENCE` | raw trade、单笔微观顺序、队列 |
| `BOOK_ASSISTED` | trade + 连续 L2 | `TRADE_AND_L2` | `BOOK_ASSISTED` | 自己的真实队列位置 |
| `QUEUE_EXACT` | 逐委托、撤单、撮合与优先级 | `ORDER_LEVEL` | `ORDER_LEVEL_REQUIRED` | 数据之外的隐藏流动性 |

产品页面和导出报告 **必须** 同时显示：`fidelity_mode`、`source_event_kind`、data quality、fill model 与版本、ambiguity/warning 数、未被建模的市场机制、以及“适合/不适合解释什么”。

硬门禁：

- `aggTrade` **不得** 标成 `RAW_TRADE` 或 `TRADE_SEQUENCE`。
- 普通 L2 **不得** 标成 `QUEUE_EXACT`。
- 缺少逐笔委托/撤单/撮合数据时，`QUEUE_EXACT` **必须** 拒绝启动。
- 同一 Run **不得** 混合 BAR 与成交模式。
- 失败后 **不得** 静默退化到更粗模式。

---

## 7. BAR_APPROX 成交规则

默认决策点为 bar close。策略在看到 bar `i` 收盘后发出的新订单，最早只能在 bar `i+1` 成交。

冻结 `bar_fill_policy = BAR_NEXT_BAR_WORST_CASE_V1`：

| 订单 | 成交规则 |
| --- | --- |
| 市价单 | 下一根 bar 的 open 加减冻结滑点 |
| 限价单 | 下一根及后续 bar 穿价才可能成交：买需 `high >= limit`，卖需 `low <= limit`；成交价取 limit |
| 止损单 | 下一根及后续 bar 触发：多头止损需 `low <= stop`，空头止损需 `high >= stop` |
| 止盈/止损同一 bar 都可达 | 默认 `WORST_CASE`：对持仓更不利的一侧先成交，并增加 `ambiguity_count` |
| gap 穿越 | 按 Run 冻结的 `gap_policy`：`REJECT`、`PAUSE` 或研究者明确批准的 `SKIP_WITH_WARNING` |
| 成交量参与 | 第一版默认 `UNMODELED`；启用后限制本订单占 bar volume 的比例 |

可选 OHLC 路径假设 `O-H-L-C`、`O-L-H-C`、`WORST_CASE` 只是 scenario，**不得** 写成历史事实。

通用单事件顺序 **必须** 为：

1. 读取并验证下一个不可变事件；
2. 应用该事件的市场状态变化；
3. 用当前事件处理 `eligible_after_sequence <= current_sequence` 的已有订单；
4. 更新聚合并关闭当前 watermark 处完成的 bar；
5. 生成只含 watermark 以前信息的 `ObservationFrame`；
6. 调用 Provider；
7. Host 将输出转为订单意图并校验；
8. 新订单标记 `eligible_after_sequence = current_sequence + 1`；
9. 写 decision、order、execution、ledger；
10. 按策略写 checkpoint。

---

## 8. 领域对象与状态机

### 8.1 Run 状态

只允许：

```text
DRAFT -> VALIDATING -> QUEUED -> PREPARING -> RUNNING
      -> PAUSING -> PAUSED -> RUNNING
      -> COMPLETING -> COMPLETED
      -> CANCELLING -> CANCELLED
      -> FAILED
```

`COMPLETED` **必须** 同时满足：事件耗尽、Provider 正常关闭、订单收尾策略完成、账本平衡、指标构建成功、报告 hash 写入。仅仅 Job 退出不算完成。

### 8.2 不可变身份

一次 Run 启动后 **必须** 冻结：

- `run_id`、可选 `study_id/trial_id`；
- `strategy_revision_id`、可选 `model_artifact_id`；
- `dataset_snapshot_hashes`；
- `fidelity_mode` 与 `source_event_kind`；
- 起止时间、warmup 区间、评估区间；
- 参数 canonical JSON/hash；
- 账户、费用、滑点、fill、风险配置及 hash；
- engine/schema versions；
- seed 与 `reproducibility_class`。

运行中改其中任一项 **必须** 失败，而不是生成“差不多”的新身份。

---

## 9. Phase 1 数据接口

Phase 1 **必须** 实现只读 `MarketDatasetSnapshotProvider`，且不得被后续回测 Phase 改字段名。

`DatasetRef` 至少包含：

- `dataset_id`
- `data_epoch`
- `snapshot_hash`
- `venue`、`market_type`、`symbol`
- `start_time_ms`、`end_time_ms`
- 请求的数据 `roles`
- 可选 `interval`
- `calendar_id`
- `source` 与 `retention_policy`

`MarketDatasetSnapshot` **必须** 返回：canonical schema/version、实际覆盖区间、行数、首尾序列、每个 role 的内容 hash、gap/duplicate/out-of-order/invalid 统计、provenance、精度能力声明、只读可重复迭代游标、关闭接口。

数据 role：`BARS`、`TRADES`、`MARK_INDEX`、`FUNDING`、`INSTRUMENT_RULES`、`ORDER_BOOK`、`ORDER_EVENTS`、`CUSTOM_FEATURES`。

硬门禁：

- snapshot hash 必须与实际内容一致；
- 时间戳严格单调，同毫秒 tie-break 已定义；
- BAR 重采样只允许源 interval 的更大整数倍，且只输出完整连续 bucket；
- 不得在线静默补数；
- 自定义特征若训练可见时间超过 run 结束时间，必须拒绝。

---

## 10. Strategy Provider

新增贡献点 `strategy-provider/1`，**不得** 修改 `candlescope.script-runtime/1` 语义。

Host 方法顺序：`describe` → `prepare` → `warmup` → 重复 `step` / `onExecutionReport` → `snapshot` / `restore` → `close`。

输出只允许：`SIGNAL`、`TARGET_POSITION`、`ORDER_INTENT`。

Provider **不得**：

- 申请任意历史 `market-data.query`；
- 直接写订单、成交、持仓、余额、数据库或报告；
- 在 warmup 阶段产生可成交输出。

---

## 11. 错误码

未知错误码必须 fail closed。第一版冻结：

| 码 | 含义 |
| --- | --- |
| `DATA_SNAPSHOT_MISMATCH` | 声明的 snapshot hash 与内容不一致 |
| `DATA_GAP_REJECTED` | 缺口且 gap policy 为 REJECT |
| `DATA_QUALITY_FAILED` | 重复、乱序、非法行或身份不一致 |
| `LOOKAHEAD_VIOLATION` | 策略或特征看到 watermark 之后的数据 |
| `FIDELITY_UNSUPPORTED` | 数据无法支撑请求的精度 |
| `FIDELITY_MISLABEL` | 试图用更粗数据宣称更细报告标签 |
| `IDENTITY_MUTATION` | 运行中修改冻结身份 |
| `PROVIDER_PROTOCOL_VIOLATION` | schema、generation、未知字段或越权 |
| `PROVIDER_TIMEOUT` | 非幂等 step 超时 |
| `PROVIDER_CRASH_UNRECOVERABLE` | 无 snapshot 的 Provider 崩溃 |
| `PROVIDER_UNAUTHORIZED_WRITE` | Provider 试图写 Host 真相 |
| `ORDER_REJECTED_RULES` | 价格/数量/名义价值规则拒绝 |
| `ORDER_REJECTED_RISK` | 风险或资金校验拒绝 |
| `ACCOUNT_INSOLVENT` | 账户无法继续 |
| `LEDGER_IMBALANCE` | 账本不平 |
| `HASH_MISMATCH` | 重算 hash 不一致 |
| `CHECKPOINT_CORRUPT` | checkpoint 不完整或 hash 失败 |
| `FLAG_DISABLED` | 总开关或子开关关闭 |
| `BUDGET_EXCEEDED` | 超出冻结资源上限 |
| `SCHEMA_UNKNOWN_FIELD` | JSON 含未知 required 语义字段 |
| `STUDY_SPLIT_LEAK` | 样本外泄漏 |
| `ONLINE_LEARNING_FORBIDDEN` | 未授权在线学习 |

---

## 12. Feature flags 与资源上限

所有生产入口默认关闭。非法布尔值必须启动失败。

| Flag | 默认 | 作用 |
| --- | --- | --- |
| `BACKTEST_ENABLED` | `0` | 总开关；为 0 时不注册 API、不创建 DB、不启动 worker |
| `VITE_BACKTEST_ENTRY_ENABLED` | `0` | 前端入口，不是安全边界 |
| `BACKTEST_BAR_ENABLED` | `0` | BAR 回测 |
| `BACKTEST_TRADE_TAPE_ENABLED` | `0` | 成交回测 |
| `BACKTEST_BOOK_ASSISTED_ENABLED` | `0` | 盘口辅助 |
| `BACKTEST_STUDY_ENABLED` | `0` | Study / 参数搜索 |
| `BACKTEST_EXTERNAL_PROVIDER_ENABLED` | `0` | ONNX / 本地 Python / gRPC |
| `BACKTEST_ONLINE_LEARNING_ENABLED` | `0` | 在线学习 |
| `BACKTEST_MULTI_MARKET_ENABLED` | `0` | 多市场 |
| `BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED` | `0` | 回放对照桥 |

资源上限是冻结安全天花板，环境变量只能收紧，不能放大：

| 名 | 上限 |
| --- | --- |
| `BACKTEST_MAX_ACTIVE_RUNS` | 4 |
| `BACKTEST_MAX_CONCURRENT_STUDIES` | 1 |
| `BACKTEST_MAX_TRIALS_PER_STUDY` | 64 |
| `BACKTEST_MAX_BAR_ROWS` | 200000 |
| `BACKTEST_MAX_TRADE_EVENTS` | 2000000 |
| `BACKTEST_MAX_WARMUP_BARS` | 5000 |
| `BACKTEST_MAX_HORIZON_DAYS` | 365 |
| `BACKTEST_CHECKPOINT_EVENT_INTERVAL` | 10000 |
| `BACKTEST_PROVIDER_STEP_TIMEOUT_MS` | 2000 |
| `BACKTEST_MAX_PROVIDER_STATE_BYTES` | 8388608 |
| `BACKTEST_MAX_REPORT_BYTES` | 16777216 |
| `BACKTEST_WORKER_MEMORY_MB` | 2048 |
| `BACKTEST_MAX_RUN_SECONDS` | 14400 |

`BACKTEST_DB_PATH` 默认 `data/backtest.db`，**必须** 与 K 线库和 replay 库隔离。

---

## 13. 与现有系统的边界

- 不得导入或复用 `TrainingRun`、回放 controller、隐藏时间或训练笔记 store。
- 不得修改 `candlescope.script-runtime/1`。
- 不得整枝合并 `codex/local-offline-mode`；Phase 1 只能语义移植数据底座提交。
- 不得把 local-offline 工作区里的插件 release / lock / README 噪声带入回测分支。
- 回测输出不得直接触发 paper/live。

---

## 14. 未决问题与 owner

以下问题不得改变 Phase 1 数据接口；它们都有明确延期阶段。

| 问题 | 决定窗口 | Owner |
| --- | --- | --- |
| 现货 long-only 是否作为第二账户模型 | Phase 8 之后 | 产品 + 账户模型 |
| Pine strategy 成交语义细节 | Phase 11 | Pine runtime |
| 外部 gRPC 模型的网络授权粒度 | Phase 9 | 插件安全 |
| 回放对照桥的揭盲 UX | Phase 6 之后，flag 关闭 | 回放 + 回测 |
| `QUEUE_EXACT` 所需原始委托数据源 | Phase 12 之后 | 数据平台 |

---

## 15. Definition of Done（合同层）

Phase 0 完成标准：

- [x] 产品对象、精度、账户、BAR 规则、错误码、flags 与 Phase 1 数据接口已写入本文；
- [x] golden fixture 与本文枚举一致；
- [x] 无前视、确定性、精度门禁有可执行合同测试；
- [x] 架构测试证明 Host 回测实现尚未存在；
- [x] 所有 flags 默认关闭；
- [x] 干净 worktree 不含 main / local-offline 的既有脏变更。
