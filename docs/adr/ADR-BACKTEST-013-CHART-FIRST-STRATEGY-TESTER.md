# ADR-BACKTEST-013：Chart-first Strategy Tester 合同与双层体验边界

- 状态：Accepted for implementation; Phase 0 visual gate approved
- 日期：2026-08-24
- 基线：`f8a195e7844f1c8afaa073bea620588a863477e3`
- 工作树：`H:\program\CandleScope-backtest-chart-first`
- 分支：`codex/backtest-chart-first-ux`
- 执行合同：[BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md](../BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md)
- Phase 0 证据：[BACKTEST_CHART_FIRST_PHASE0_RESULT_20260824_zh.md](../evidence/BACKTEST_CHART_FIRST_PHASE0_RESULT_20260824_zh.md)

## 背景

现有 `/backtest.html` 已拥有不可变数据、Host-owned Run/Study、BAR/aggTrade 精度、
可信报告、Python First 和发布级失败关闭合同，但它把内部研究对象直接暴露给普通用户。
普通用户的第一目标是在当前图表中快速修改脚本、运行、查看成交与结果；高级研究仍需要
独立全屏工作台。两层体验必须共享图表与行情能力，同时禁止复用可变页面 runtime。

## 决策

### 1. 产品对象与入口

1. `BacktestRun`、`Study` 与 replay `TrainingRun` 保持三个独立对象；ID、状态机、账户、
   checkpoint、报告和 UI store 均不互换。
2. 普通模式入口位于当前活动图表顶部，名称为“策略”；打开 source-neutral
   `MarketWorkspaceFrame.bottomPanel`，不先跳转 `/backtest.html`。
3. 普通模式只暴露脚本、当前图表上下文、一个“运行”主操作和结果。主路径禁止出现
   dataset、data epoch、snapshot、revision、Run ID、provider kind 或账户模型。
4. `/backtest.html` 迁移为高级研究入口。Python 信任确认、批量 Study、优化、完整审计和
   外部模型只进入高级页。

### 2. 能力共享，runtime 隔离

普通行情页与高级研究页共享图表 renderer、pane、价格/时间轴、Host 行情与规范存储接口、
品种/周期选择、指标、绘图、外部标记、主题、i18n 和可访问性能力。

两页不得共享 React store、WebSocket 对象或 refs、回测账户、订单、Run/Study 状态、轮询、
AbortController、编辑器状态或 chart-session。每个已附着的图表单元格按需拥有独立
`ChartStrategyTesterRuntime`；未附着单元格不得创建 runtime。底层物理行情资源只能由 Host
lease/连接协调层去重。

### 3. 普通模式状态与数据行为

冻结 `UNATTACHED`、`START_CHOOSER`、`EDITING`、`VALIDATING`、`NEEDS_DATA`、
`QUEUED`、`RUNNING`、`COMPLETED`、`STALE`、`ERROR`。首次打开只展示“使用策略模板、
打开最近脚本、粘贴已有代码”；用户选入口后才懒加载 Monaco。

symbol、interval、exchange、market type、策略内容/参数、range、fidelity、费用/执行预设或
任何冻结执行身份变化时，旧结果立即进入 `STALE`，同一渲染帧隐藏旧标记。旧汇总可以保留，
但必须明确标记为过期。前端不得伪造后端终态，也不得在无用户授权时联网补数据。

### 4. 可信解释合同

冻结 `TradeExplanationV1`（`schema=TRADE_EXPLANATION_V1`）与
`canonicalization=JCS_SHA256_V1`。解释只能来自决定时 provider/compiler/Host 结构化证据，
禁止用大模型或事后规则生成原因。

`JCS_SHA256_V1` 的输入是除 `evidenceHash` 外的完整 typed object：UTF-8、对象 key 字典序、
数组保持原顺序、无无意义空白，输出小写十六进制 SHA-256。时间和 ordinal 必须是 JavaScript
safe integer；策略数值使用规范十进制字符串，展开科学计数法、去除无意义零并把 `-0` 变为
`0`；拒绝 NaN、Infinity 与超范围整数。

V1 固定预算：canonical payload 64 KiB、最多 64 个 conditions、128 个 variables、key 最多
128 UTF-8 bytes、单个字符串值最多 2 KiB。conditions 按编译器稳定源码顺序，variables 按
key 排序后进入预算。稳定截断必须记录 omissions 并返回 `PARTIAL`；非法字段、哈希不匹配或
无法规范化必须返回 `UNAVAILABLE`，不得显示成完整可信解释。

### 5. 可比较性与交易对齐

冻结 `comparison_context_hash`，纳入 exchange/market/symbol/interval、dataset/data epoch/
snapshot、range、fidelity、账户/资金/仓位/杠杆、费用/funding/slippage/latency/execution
revision、metrics version、provider/compiler/runtime/ABI/Host adapter、确定性 seed/RNG policy
和会改变事件顺序的 builder revision。策略源码/revision 与策略参数不进入该 hash。

冻结 `RUN_COMPARE_V3`：净收益、最大回撤、交易次数的 before/after/delta，参数差异，
decision/fill hash 差异，新增/消失/保持交易数量，fingerprint version、alignment status、
occurrence count、成本差异与不可比较原因。

交易级差只接受 Host 生成的 `TRADE_FINGERPRINT_V2`：使用与 `JCS_SHA256_V1` 相同的 typed
canonical JSON，包含 symbol、side、entry/exit decision time、同时间 decision ordinal、
entry/exit action 与 action ordinal。ordinal 必须来自决定时确定性顺序；不得使用数据库顺序、
前端数组下标或 run-specific trade ID。比较是 `fingerprint -> occurrence count` 多重集差，
禁止压成 set，也禁止模糊时间匹配。字段缺失或 V2 不可用时只展示汇总差，并写明“交易无法逐笔
对齐”；`directComparisonAllowed=false` 时禁止给出改善/恶化方向。

### 6. 默认值、门禁与回滚

新前端入口、bottom panel、解释与 compare V3 均默认关闭并保持懒加载。关闭新 flag 后，
`bottomPanel` 渲染 `null`，主图 DOM、初始包体、单/多图行为和 Host lease 回到本 ADR 的
Phase 0 基线。直到 Phase 12 完成，不合并、不推送、不部署、不默认开启。

Phase 4 生产 UI 开始前，首次打开、运行完成、脚本出错和 stale 变体必须通过人工视觉/产品
评审。评审只确认：唯一主操作、零内部术语、一眼识别结果上下文、错误可行动。

## 后果

Phase 1～3 先建立 feature flags、共享 chart capability 和每 cell 状态安全线；Phase 4～8
实现普通体验与可信解释/比较；Phase 9～11 完成高级研究和旧工作台迁移；Phase 12 才做完整
回归、性能、可访问性、回滚与发布资格判断。本 ADR 不授权提前实现后续阶段。
