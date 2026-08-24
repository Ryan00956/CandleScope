# Backtest Chart-first Phase 5 实施计划（2026-08-24）

## 审计结论

Phase 1 已抽出 typed API client、Run 终态轮询和结果投影；Phase 2 已提供默认关闭、只读
`resolve` 与显式确认的 `materialize`；Phase 3 已提供按 cell 隔离的 generation token、AbortController
和 stale 状态；Phase 4 已冻结一次点击“运行”时的 source、参数、chart session 与 draft content
revision。现有 Host Run 的 `validate -> create`、idempotency header、后台队列和 legacy 可见性均可
直接复用。

当前有三个必须在 Phase 5 内补齐的真实缺口：

1. `ChartStrategyTesterCellBridge` 的 Run handler 仍只把本地状态从 `RESOLVING` 改为 `READY`，
   没有调用 API；
2. 普通图表模板使用受限 Pyne 策略语法，但现有持久化 StrategyRevision 只支持内置模板、
   Pine 子集、JSON order DSL、Python 与外部 artifact，不能诚实执行这些模板；
3. `create_strategy_revision` 每次生成随机 revision ID，尚未按 source/language/compiler/runtime
   identity 复用。

## 实施边界

本阶段只实现“冻结草稿 -> 编译/复用 revision -> resolve/materialize -> validate -> create ->
观察终态”的最小闭环。概览、权益曲线、交易列表、主图 marker、ResultContextBar 与 focused trade
属于 Phase 6，不在本阶段提前实现。不会修改 legacy `/backtest.html` 主流程，不会默认开启 flag，
不会联网准备数据，除非用户在 `NEEDS_DATA` 状态明确点击“准备数据并运行”。

## 后端

1. 新增 fail-closed 的 `PYNE_CHART_V1` StrategyRevision 编译/执行 provider：只接受版本化的
   `strategy` 声明、受支持的指标赋值、条件与 `target_position`，不使用 `eval`，不复用指标
   runtime 冒充策略 runtime；三份内置模板及其数值修改可运行，未知语句返回行列诊断。
2. 让 persisted revision 的 smoke、validate 和隔离执行路径识别同一 `chart-pyne-v1` provider。
3. 在 repository 锁内按 `language + source_hash + dependency_hash + runtime_revision` 原子
   get-or-insert；相同编译 identity 返回已有 active revision，source 或 runtime identity 改变才新建。
4. Run 请求增加可选 `quick_preset_id/revision`，并进入 immutable config identity；费用为空或
   fee source 未确认时 fail closed，不使用 Pydantic 的默认 0 掩盖未知费用。
5. 增加 compiler、revision reuse/concurrency、真实 Run 与 quick preset identity 回归测试。

## 前端流水线

1. 新增纯 `chartStrategyRunRequest` 模块：规范化/冻结输入、生成参数 hash、stable SHA-256
   materialize/Run idempotency key、展开 quick preset 与完整 RunCreateRequest。
2. `runChartStrategyBacktest` 严格执行：create/reuse revision -> resolve ->（READY）smoke ->
   validate -> 再 resolve 并比较 immutable identity -> create -> 按 run ID 轮询；新请求或 cell
   context 变化通过 generation token/AbortController 丢弃旧结果。
3. `NEEDS_DATA` 只返回待确认状态；用户点击“准备数据并运行”后才 materialize，随后必须重新
   resolve，不能复用旧 token。
4. 双击 Run 复用同一个 in-flight promise；Run 一旦创建，停止观察只 abort 前端轮询，不调用
   cancel endpoint，也不宣称取消后台 Run；API 中断保留 run ID，并提供恢复观察。
5. 把 API 错误升级为保留 `code/message/details` 的 typed error，并映射为“发生了什么、为什么、
   下一步做什么”的可行动模型；编译诊断回到脚本问题区。

## 普通模式 UI

1. 顶部只保留一个主 Run 操作，根据状态显示运行、准备数据并运行、排队、运行中；运行中提供
   独立“停止等待”，不显示内部 revision/hash/token。
2. Settings 标签显示五项摘要：资金、仓位、费用、日期、精度；不暴露 dataset/snapshot/
   StrategyRevision/RunCreateRequest。
3. Script/Overview 区域显示排队、运行、完成、失败与恢复观察的就地反馈；错误码只在可展开
   诊断详情中出现。
4. attachment 只更新 `strategyRevisionId`；Run 状态和 controller 不写 workspace JSON。

## 验证与证据

- 纯单测：hash 与 request golden、READY/NEEDS_DATA/unsupported/error、双击去重、generation
  失效、validate/create 漂移、停止/恢复观察、错误映射；
- 后端：三模板 compiler/provider、相同 source 并发复用、source 变化新 revision、费用未知拒绝、
  quick preset identity、真实 fixture Run 完成；
- wire：typed error details、signal、materialize/resolve/create 序列保持；
- 全门禁：`npm run test:backtest`、`npm test`、typecheck、lint、architecture、i18n、flag-on/off
  build、相关 pytest、`git diff --check`；
- 仓库内 Playwright/Chrome：模板和最近脚本三步内得到完成 Run、双击只建一个 Run、数据确认/
  失败/重试、停止等待后按 run ID 恢复、错误就地反馈、4-cell 隔离、1366x768 与参考图对照、
  console/network 证据；
- 结果写入 Phase 5 JSON/Markdown 与截图目录，阶段门禁通过后单独提交
  `feat(backtest): run safe quick backtests from the active chart`。

## 回滚

关闭 chart tester flag 后不加载普通模式流水线；已创建的不可变 StrategyRevision 与 Run 保留，
仍由 legacy workbench 查询和导出。代码回滚为 Phase 5 单提交 revert，不删除用户数据。
