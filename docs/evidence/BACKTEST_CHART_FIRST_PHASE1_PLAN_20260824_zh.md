# Backtest Chart-first Phase 1 可复用客户端与结果投影计划（2026-08-24）

## 阶段身份

- 状态：`COMPLETE`
- 基线提交：`5258f982`（Phase 0 合同与基线）
- 分支：`codex/backtest-chart-first-ux`
- 范围：仅 Phase 1；不实现 Phase 2 的共享图表平台，不新增 Phase 3 flags，不改变后端 wire contract。

## 现状审计

1. `backtestApi.ts` 已有 33 个 typed method/33 个 fetch 落点，但除单个 Study holdout 用例外，
   没有逐接口锁定 method、URL、query、header、body、ID 编码和 AbortSignal 的 wire tests。
2. signal trace 已有分页响应类型；Run compare 仍返回 `Record<string, unknown>`，导致旧工作台用强制
   cast 读取 `RUN_COMPARE_V2`。
3. `BacktestResultChart.tsx` 内联构造 fill/rejection marker、equity/downside SVG points；未来 chart
   tester 无法在不复制组件 controller 的情况下复用投影。
4. `BacktestApp.tsx` 内联终态集合、报告四项摘要、focused trade 的 decision/accept/fill 时间回退，
   并直接解释 compare wire shape。
5. `backtestWorkspace.ts` 只有一次 `getRun`；没有可取消、可注入等待函数、直到终态的通用 Run
   polling helper。
6. Phase 0 的 26/26 frontend backtest tests、typecheck、build 和真实 legacy 浏览器基线均通过；
   本阶段必须保持现有 DOM、文案、请求顺序、默认 flags 和 `/backtest.html` 行为不变。

## 实施计划

1. 在 `backtestTypes.ts` 冻结 `SignalTraceV1` 与现有 `RUN_COMPARE_V2` wire 类型；让
   `BacktestApiClient` 返回具体类型，不改变 endpoint 或 payload。
2. 新增可复用 Run helper：统一终态判定，并提供支持 AbortSignal、可注入 wait/间隔与 update
   callback 的 polling；旧工作台和现有 workflow 改用相同终态合同。
3. 新增 `chart-tester/chartStrategyResultProjection.ts` 纯逻辑层：
   - fill/rejection 到 marker 的稳定投影；
   - equity/drawdown 有界序列和 SVG point 投影；
   - legacy 报告四项摘要；
   - focused trade 的 reason 与 decision/accept/fill 时间 view model。
4. 让 `BacktestResultChart.tsx` 和 `BacktestApp.tsx` 使用这些 helper；保持 JSX 元素、class、
   test id、文案和值不变。
5. 新增 wire、golden、pagination、compare compatibility、polling/cancel、focused trade contract
   tests；保留现有 M9 长曲线有界合同。

## 验证与退出标准

- 33 个 API method 的 method/URL/query/header/body wire 行为被测试锁定；错误响应与 signal
  传递 fail closed。
- marker golden 覆盖时间、BUY/SELL 方向、文本、输入顺序、同时间 fill+rejection 不丢失及
  不在 axis 上的事件过滤。
- equity/downside 2,000 点上限、报告摘要、focused trade reason/三段时间回退有纯函数测试。
- signal trace 多页 cursor 与 `RUN_COMPARE_V2` compatible/incompatible 响应有 typed contract tests。
- Run polling 覆盖 queued/running/completed、failed/cancelled、AbortSignal 和 interval 清理。
- `npm run test:backtest`、`npm run typecheck`、`npm run check:architecture`、`npm run check:i18n`
  与 `npm run build` 通过。
- 启动隔离前后端，在真实浏览器确认 legacy `/backtest.html` 加载、完成 Run、报告/图表/比较及
  请求序列；主图与 replay smoke 无回归。
- diff 只包含 Phase 1 代码、测试与证据；单提交可 revert，且无 push/merge/deploy。

## 风险与回滚

- marker 顺序或时间取整漂移：保留现有“fills 输入顺序在前、rejections 输入顺序在后”合同并
  用 golden 锁定，不借重构引入可见排序变化。
- polling 竞态：每次等待前后检查 AbortSignal；终态立即退出；legacy interval 请求节奏保持不变。
- wire 误改：测试同时校验 ID 编码、query、header 与 JSON body；本阶段不修改 backend route。
- 回滚：revert 本阶段单提交即可恢复内联逻辑；Phase 0 文档/基线和后端不可变 Run 不受影响。
