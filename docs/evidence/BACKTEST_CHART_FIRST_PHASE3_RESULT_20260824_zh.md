# Backtest Chart-first Phase 3 每 Cell 状态与持久化结果（2026-08-24）

## 结论

Phase 3 状态为 `COMPLETE`。普通行情 workspace payload 已从 schema 7 升级到 schema 8，并为每个
cell 增加只保存轻量配置的 strategy attachment。策略源码、语言、光标和保存状态进入独立、版本化
的 `StrategyDraftStore`；Run、报告、交易、曲线、marker 和运行中状态没有进入 workspace 持久层。

纯 TypeScript reducer 覆盖 chart session、draft、revision、参数、范围、精度和 preset 的 stale
原因，旧结果在同一状态转换中停止投影，但完成 Run 身份仍被保留以供后续 UI 查看。generation token
同时绑定 workspace/cell scope，过期响应和跨 cell 响应不能写入当前状态。runtime factory 只在显式
附着或打开编辑器时创建实例，并在 detach、close、workspace 删除、关 flag 或页面 dispose 时释放
timer、AbortController、cleanup、marker 和结果引用。

本阶段没有用户可见 UI，因此没有把 DOM 或截图检查描述成视觉证据；Phase 4 尚未开始。未 push、
merge、deploy，主工作树中的用户改动保持原样。

## 持久化与迁移

- `ChartWorkspaceDocument.schemaVersion` 升为 8，`ChartCellState.strategyAttachment` 为 nullable。
- attachment 只包含 draft/revision ID、显示名、语言、参数、范围、精度、quick preset 和 auto-run
  偏好；规范化层会剥离源码和未知字段，对畸形 attachment fail closed。
- schema 7 在既有 normalization 边界原位迁移为 8，保留 layout、window、session、drawing、
  indicator、link group 与 revision；旧 cell 的 attachment 固定为 `null`。
- 单 workspace local-storage 先读 v8 key、再读 v7 key，并只写 v8；读取旧 key 不产生隐式写入。
- IndexedDB 仓储容器和 CAS record schema 没有无谓升级；既有 v7 payload 可读取，下次正常保存写回
  schema 8，避免新建空数据库造成工作区丢失。
- copy/split 深复制 attachment 配置但不复制 runtime；blank 明确清空 attachment；link group 只传播
  chart session，不传播策略配置。close 保留隐藏 cell 的持久配置，由 runtime 可见性协调负责释放实例。

## 草稿、状态机与生命周期

- `StrategyDraftStore` 使用独立 `candlescope-strategy-drafts-v1` key 和可注入 adapter；记录包含 source、
  language、cursor、单调 revision、created/updated time，视图显式暴露 IDLE/SAVING/SAVED/ERROR。
- 同一 draft 的并发 save 串行化，旧写入不会覆盖新 revision；损坏存储内容和 adapter 错误均 fail closed。
- stale 原因覆盖 exchange、market type、symbol、interval、draft ID/content、language、strategy
  revision、parameters、range、fidelity 和 quick preset；参数比较使用稳定键序规范化。
- request token 为 `cellScope + generation`。20 次连续切换只接受最终 generation；cell A 的 token 或
  result identity 均不能写入 cell B。
- factory key 为 `workspaceId + cellId`，避免不同 workspace 复用相同 cell ID 时串状态。64 个未附着
  cell 创建 0 个实例；激活 N=16 只创建 16 个实例且重复激活复用；全部释放后资源计数回到基线。
- `.env.example` 明确 `VITE_CHART_STRATEGY_TESTER_ENABLED=0`。Phase 3 没有把 runtime、draft store
  或 editor 接进 App/LiveChartCell import graph，因此默认构建没有 tester/editor 产品 chunk、DOM、
  storage write、timer、polling 或 AbortController 副作用。

## 自动化证据

| 验证 | 结果 |
| --- | --- |
| Phase 3 定向测试 | PASS，45 tests，0 fail |
| chart-workspace 全量 | PASS，81 tests，0 fail，675 ms |
| `npm run test:backtest` | PASS，55 tests / 3 suites，0 fail，476 ms |
| `npm test` | PASS，3,329 tests / 3 suites，0 fail，123.74 s |
| `npm run typecheck` | PASS |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,562 keys / 596 source files |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run build` | PASS，630 modules，6.41 s；保留既有 >500 kB chunk warning |
| `git diff --check` | PASS |

生产 build 的 backtest entry 仍为 `93.01 kB raw / 22.47 kB gzip`。live entry 为
`533.71 / 154.87 kB`，Phase 2 为 `531.72 / 154.30 kB`；增量来自 workspace schema 8
规范化代码。manifest/chunk 输出没有新增 chart tester、draft store 或 editor 产品 chunk。

## 验收矩阵

| 合同 | 证据 | 结果 |
| --- | --- | --- |
| schema 7 -> 8 无损迁移 | 真实 v7 payload 的 storage/repository tests | PASS |
| attachment round-trip 且源码不入 workspace | v8 保存、恢复、未知 source 剥离测试 | PASS |
| malformed attachment fail closed | normalization diagnostic test | PASS |
| copy/blank/link 行为 | editing 与 link-model tests | PASS |
| 草稿与 workspace 分离 | 独立 key、恢复、revision/save-state tests | PASS |
| 所有 stale 维度 | 12 个 typed stale reasons 的表驱动测试 | PASS |
| 旧响应与跨 cell 响应拒绝 | 20-generation、detach、A/B scope tests | PASS |
| 16/64 容量与完整释放 | runtime factory diagnostics tests | PASS |
| flag 默认关闭且无产品 import | strict flag、`.env.example` 与 import-graph audit | PASS |
| legacy backtest 与全前端回归 | backtest suite、全量 suite、build | PASS |

## 已处理的非通过尝试

首轮 TypeScript 检查在 reducer 的 `SYNC_INPUTS` 分支报告一次 null narrowing 错误；该分支在前置
null guard 后改为显式非空输入，随后定向测试、全量测试、typecheck、lint 和 build 全部通过。没有
放宽类型、测试或产品合同。

## 退出标准与回滚

- 状态机在无 React、无网络环境完整测试：PASS。
- 草稿恢复、不可变 revision 边界和多图表身份隔离：PASS。
- runtime 按需创建与完整 dispose 容量测试：PASS。
- 旧 workspace 可恢复：PASS。
- 关闭 `VITE_CHART_STRATEGY_TESTER_ENABLED` 可维持零入口、零 runtime；代码回滚时应保留 schema 8
  reader 至少一版，避免新版已写数据无法被旧 reader 读取。

Phase 4 尚未开始。
