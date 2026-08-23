# Chart-first 回测 Phase 3 实施计划（2026-08-24）

## 范围

本阶段只实现执行文档 Phase 3：每 cell 的持久 attachment、独立 strategy draft store、无 React
stale/generation 状态机，以及按 cell scope 懒创建和完整释放的 runtime factory。不增加可见入口、
编辑器、底部结果面板、自动运行或后端 Run 编排。

## 已审计边界

- 当前 workspace payload schema 为 7；IndexedDB、fallback library 与 bootstrap 都通过
  `normalizeChartWorkspace` 读取。7 -> 8 迁移应放在该规范化边界，继续复用现有仓储容器和 CAS
  revision，避免建立空的新数据库后丢失用户工作区。
- `ChartCellState` 是唯一的每 cell 持久对象；源码、报告、曲线、交易和运行中状态不得写进它。
- split/copy 已深复制整个 cell；加入 attachment 后 copy 自然复制配置，但 blank 必须显式清空。
  close 保留隐藏 cell state，因此 runtime 释放必须由可见 cell 生命周期处理，不能删除持久配置。
- cell ID 可跨 workspace 重复，runtime key 必须是稳定的 `workspaceId + cellId` scope，而不是全局
  单独 cell ID。
- Phase 3 不改 `LiveChartCell` DOM。flag off 时 App 不 import runtime、draft store 或未来 editor，
  因而未附着 16/64 cells 的实例、timer、polling、AbortController 和 editor chunk 都为 0。

## 实施顺序

1. 定义 `ChartStrategyAttachmentRecord`，将 workspace payload schema 升为 8。
2. 在 normalization 层实现严格 7 -> 8 migration；v7 每个 cell attachment 为 `null`，v8 对
   attachment ID、语言、范围、精度、preset、parameters 和 autoRun fail closed。
3. 增加 v8 local storage key，并从 v8 优先、v7 fallback 读取；IndexedDB v7 容器原位读取并在
   下次保存写回 schema 8。
4. 调整 default/copy/blank/template 路径：default/blank 为 null，copy 深复制 attachment，link group
   更新不传播 attachment。
5. 新增版本化 `StrategyDraftStore`，用独立 adapter 保存 source、language、cursor、revision 和
   save state；提供可注入内存 adapter 与浏览器 local-storage adapter，错误 fail closed。
6. 新增纯 `chartStrategyTesterState` reducer：完整 stale reason、同步隐藏 projection、单调
   generation token 和旧响应拒绝。
7. 新增 `ChartStrategyTesterRuntime` 与 factory：显式 activation 才创建；相同 scope 复用；
   detach/close/workspace delete/flag off/page dispose 释放订阅、timer、AbortController、结果和 marker
   引用，但不删除后端 Run。
8. 新增默认关闭的 `VITE_CHART_STRATEGY_TESTER_ENABLED` 严格解析；Phase 3 不把模块接进 App DOM。
9. 覆盖 schema round-trip、迁移、copy/blank/link、所有 stale 维度、20 次竞态、16/64 零实例、
   N attachments 上限、detach/close dispose 与 flag/storage 零副作用。

## 非目标

- 不加载 Monaco、模板选择器或 chart tester React chunk。
- 不调用 Phase 2 resolve/materialize，也不 validate/create/poll Run。
- 不新增 marker source、bottom panel 或 TopBar 入口。
- 不更改 legacy backtest workbench。
- 不开启 flag，不 push、merge 或 deploy。

## 退出标准

- schema 7 工作区无损迁移到 8，旧 session/drawing/indicator/layout 完全保留。
- 状态机在无 React、无网络环境覆盖全部 stale 与 generation 竞态。
- 16/64 未激活 cell 的 runtime 数为 0；激活 N 个最多 N 个，释放后回到基线。
- flag off 不产生 storage write、DOM、timer、polling、AbortController 或 editor import 副作用。
