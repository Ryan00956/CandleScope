# Backtest Chart-first Phase 1 可复用客户端与结果投影结果（2026-08-24）

## 结论

Phase 1 状态为 `COMPLETE`。现有 33 个 backtest client method 已有稳定 wire tests；signal trace
分页和 `RUN_COMPARE_V2` 具备具体 TypeScript 类型；Run 终态/轮询、marker、equity/drawdown、
报告四项摘要和 focused trade 已成为可复用纯逻辑。Legacy `BacktestApp`、
`BacktestResultChart` 与 workflow 已改用这些 helper，真实浏览器的 DOM、文案和请求路径未发生
产品行为变化。

本阶段未修改 backend route/schema，未新增或开启产品 flag，未进入 Phase 2～3，也未 push、
merge、deploy。主工作树的用户修改保持原样。

## 实现

### Typed client 与 Run 生命周期

- `backtestTypes.ts` 增加 `SignalTraceItem/Page`、`RunCompareV2`、compare side/delta wire 类型。
- `backtestApi.ts` 保持 33 个 endpoint/method/payload 不变；`compareRuns` 不再返回无结构的
  `Record<string, unknown>`。
- `backtestRunClient.ts` 冻结 `COMPLETED/FAILED/CANCELLED` 终态，提供可取消、可注入 wait、
  可观察每次 update 的 `pollBacktestRunToTerminal`；非 `Error` abort reason 统一为 `AbortError`。
- `backtestWorkspace.ts` 使用通用 polling helper；已完成 Run 的现有调用序列仍为一次
  `getRun`，活动 Run 才继续有界间隔轮询。

### 纯结果投影与 legacy adapter

- `chart-tester/chartStrategyResultProjection.ts` 提供：
  - fill/rejection marker 投影；保持 legacy 的 fills 输入顺序在前、rejections 输入顺序在后；
  - 同一时间的 fill 与 rejection 保留为两个 marker；axis 外事件不投影；
  - equity/drawdown 有界抽样与 SVG points；上限仍为 2,000；
  - 报告标签、成交、完整交易、最终权益四项摘要；
  - focused trade 的入/出场原因与 decision/accepted/fill 时间回退。
- `BacktestResultChart.tsx` 只保留 React/SeriesWindowStore adapter；`BacktestApp.tsx` 使用 typed
  compare、共享终态、报告摘要和 focused trade view model，现有 JSX element/class/test id 不变。
- M9 长曲线回归测试改为跟随纯投影落点，不降低 1,000 表格行和 2,000 曲线点上限。

## 自动化证据

| 验证 | 结果 |
| --- | --- |
| `npm run test:backtest` | PASS，38 tests / 3 suites，0 fail，最终 449 ms |
| API wire | PASS，33/33 method；method、URL、query、ID 编码、header、JSON body、AbortSignal |
| projection golden | PASS，marker 时间/方向/文本/顺序、同时间拒单，equity/drawdown、摘要、focused trade |
| Run polling | PASS，QUEUED→RUNNING→COMPLETED、FAILED、CANCELLED、abort 与 wait cleanup |
| `npm run typecheck` | PASS |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,562 keys / 592 source files |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run build` | PASS，630 modules，最终 6.06 s；既有 >500 kB chunk warning 保留 |
| 后端 backtest/provider 回归 | PASS，241 passed / 4 existing FastAPI `on_event` warnings / 18.33 s |

生产 build 中 backtest entry 为 `92.66 kB raw / 22.43 kB gzip`，相比 Phase 0 基线增加
`0.61 / 0.27 kB`；live `531.72 / 154.30 kB`、replay `293.27 / 78.78 kB`、shared index
`783.01 / 233.71 kB` 均与基线相同。

## 公开 API 与真实浏览器

隔离 `LOCAL_OFFLINE` runtime 使用端口 18085 和新建 output 目录，只导入仓库
`local_mode_sample.csv`（12 rows），没有联网准备数据：

- smoke Run 1：`bt_1f27874c47c041b8b7f1a9e71cde6581`，report hash
  `sha256:66f3058448280731684132055da90551ef55f9b46b1bae7525c5f3dfef6f0063`；390 ms；
- smoke Run 2：`bt_4828d9a3d9784acfb1e0320b851e8d82`，相同输入得到相同 report hash；279 ms；
- legacy 浏览器启动后读取 dataset/runs/report/signal-trace/chart，显示
  `APPROXIMATE / 2 fills / 1 trade / 9961.527`，1 个图表 surface 和 1 条权益曲线，无错误 DOM；
- 选择第二个 Run 后请求现有 `/runs/compare/pair`，显示“关键身份兼容：允许直接叠加”，
  `tradeCount delta=0`、`netPnl delta=0.000`；
- 点击 `trade-1` 后 focused trade 恢复 decision/accepted/fill 时间并定位图表；
- 从 UI 点击“验证并启动后台 Run”后，Run 数从 2 增至 3，最终三条均为 `COMPLETED`，后端实际
  请求序列为 validate → create → runs polling → report/signal-trace/chart；
- 同一分支前端连接现有只读 LIVE backend 后，普通主图为 1 cell / 1 chart surface /
  `data-market-data-ready=true`，回放页标题和训练大厅加载且无 `REPLAY_V2_PROTOCOL_ERROR`。

浏览器 DOM 验证未作为视觉像素证据：隔离 worktree 的 `node_modules` junction 指向主工作树，
Vite 开发服务器按既有 `server.fs.allow` 正确拒绝 worktree 外字体文件；类型、生产 build 与上述
DOM/API 合同不受影响。所有阶段临时 tab、15225/15226/15227 与 18085 进程均已关闭；用户的
18080 backend 结束时仍为 `status=ok`。

## 已处理的非通过尝试

1. 首轮 projection test 把 10 项数组与数字 10 比较，37 项通过、1 项测试断言失败；改为数组
   内容比较后 38/38 通过，产品代码未为测试降级。
2. 首轮 typecheck 拒绝缺少必填 wire 字段的摘要测试 fixture；补齐真实最小
   `BacktestReport`，未使用双重断言绕过类型。
3. 首轮 ESLint 拒绝可能为非 `Error` 的 AbortSignal reason；实现统一 `AbortError` 规范化后，
   定向和全仓 lint 均通过。
4. `LOCAL_OFFLINE` runtime 不提供 live/replay API；该环境只用于 backtest UI，主图/replay
   最终回归改用现有 LIVE backend 的只读连接，没有把预期 403 描述成产品回归或通过。

## 退出标准与回滚

- 新 chart tester 可直接复用 typed API、Run polling 和所有结果投影：PASS。
- `BacktestApp.tsx` 不再是唯一能构造结果摘要/交易定位的地方：PASS。
- legacy 用户可见行为、DOM 和 wire 路径零产品变化：PASS。
- 回滚：revert 本阶段单提交即可恢复内联逻辑；Phase 0 基线、后端 Run/Study 和用户 workspace
  无需删除或迁移。

Phase 2 尚未开始。
