# CandleScope 前端架构继续优化执行文档

本文定义 CandleScope 前端在完成 `app -> features -> chart-adapter/shared` 主体迁移之后，继续从“架构清楚”推进到“边界硬、复杂度低、长期可维护”的执行路线。

当前前端已经不再是混乱的大 App。`src/app` 已经成为组合根和页面 Shell，`src/features/*` 已经按业务能力拥有主要 runtime、storage、controller 和 feature UI 入口，`src/chart-adapter` 已经收住 `lightweight-charts` 直接 import，`src/runtime` 只剩 performance instrumentation，`scripts/check-architecture.mjs` 也已经能通过且没有 migration allowlist。

因此，下一步不应该再做“大搬家”。真正剩下的问题是：少数高复杂度模块内部仍然太重，少数 feature 之间仍靠 App 里的 ref bridge 协调，部分 chart/drawing 代码仍通过 imperative API 隐式耦合。

本文每个阶段只修一个问题。每个阶段都应该能独立验证、独立提交、独立回滚。

## 当前基线

当前已完成：

- `src/App.jsx` 只 re-export `src/app/App.jsx`。
- `src/app/App.jsx` 约 145 行，已经主要负责 feature runtime 装配。
- `src/features/chart-session` 拥有 symbol、exchange、market type、interval、custom interval、dataset key 和 visible range。
- `src/features/market-data` 拥有 K 线首屏加载、缓存、左侧分页、WebSocket、backfill completion、gap recovery 和 background prefetch。
- `src/features/indicators` 拥有 active store、compute controller、stream controller、output reducer 和 pane projection。
- `src/features/drawings` 拥有 drawing tool state、persistence、primitive factory、selection、snap 和 interaction controller。
- `src/features/watchlist`、`src/features/symbol-search`、`src/features/settings`、`src/features/export` 已经拥有主要 runtime 和 storage 边界。
- `src/chart-adapter/lightweightChartSurface.js` 是 `lightweight-charts` 的直接 import 入口。
- `scripts/check-architecture.mjs` 当前通过，且 allowlist 为 0。
- `eslint` 和 `vite build` 当前通过。

当前还不完美：

- `src/app/App.jsx` 仍持有 `chartWidgetRef`、`pageExportRef`、`runtimeBridgeRef`、`indicatorRangeRequestRef` 等跨 feature bridge。
- `src/app/appShellViewModel.js` 仍是一个较大的字段级投影表。
- `src/features/drawings/drawingInteractionController.js` 仍是最大复杂点，约 1890 行。
- `src/features/settings/SettingsModal.jsx` 仍然很重，约 1600+ 行。
- `src/components/ChartPane.jsx` 仍拥有大量 chart rendering lifecycle，约 1700+ 行。
- drawing primitives 仍位于 `src/components/primitives`，但它们本质上已经是 drawing/chart-adapter 内部实现。
- 一些 feature runtime 仍暴露旧兼容字段，方便旧调用路径，但会让接口表面积偏大。

## 最终目标

继续优化完成后，前端应达到：

- `App.jsx` 只装配 feature，不再维护跨 feature imperative bridge。
- feature 之间通过显式 event/action contract 协作，而不是通过 App 中的 refs 互相回调。
- `AppShell` 只接收稳定 view model，不承担大量字段级业务翻译。
- drawing engine 拆成多个可读 controller，每个 controller 只负责一种交互职责。
- chart rendering 拆成 pane lifecycle、series lifecycle、overlay rendering、imperative adapter 四块。
- Settings modal 的 shell、tab registry、panel runtime 和 panel UI 分离。
- drawing primitives 迁出 `components`，避免 feature 依赖旧展示层目录。
- 架构检查能覆盖当前最容易回退的边界。

## 通用验证

每个阶段至少运行：

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

如果当前 PowerShell 找不到 `node` 或 `npm`，使用 Codex bundled Node：

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\check-architecture.mjs
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

涉及 chart、drawing、export、lazy surface 的阶段，有运行环境时额外跑：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

如果涉及 indicator overlay 或 hosted/custom indicator，额外跑：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

## Phase H1：移除 App 中的 market-data bridge

### 修复的问题

`src/app/App.jsx` 现在通过 `chartSessionRuntimeBridgeRef` 把 market-data 的 `clearCache`、`clearChartData`、`setLastPrice`、`setLoading` 等 setter 暴露给 chart-session。这样 App 虽然不直接写业务逻辑，但仍在维护 chart-session 和 market-data 的隐式通道。

### 目标

让 chart-session 不再直接控制 market-data 内部 setter。session 切换只发出明确的 session transition，market-data 自己响应。

### 建议设计

新增一个纯 transition model：

```text
src/features/chart-session/
  chartSessionTransition.js
```

chart-session 暴露：

```js
{
  view,
  actions,
  events: {
    transitionToken,
    lastTransition
  }
}
```

market-data 监听 `session.events.lastTransition`，自行清 cache、清 chart data、重置 loading、重置 error、重置 hasMoreLeft。

关键约束：

- transition 的 reset 必须先于新 session 的首轮 `loadData` 生效，或者由 `loadData` 在读取 transition 后同步完成 reset，避免旧 symbol/interval 的 K 线在新 session 中短暂残留。
- `selectSymbol`、`selectInterval`、exchange capability correction 触发的 transition 必须带上 `sessionKey` 或等价字段，market-data 只处理与当前 session 匹配的 transition。
- interval 切换前保存 visible range 时，不能再从 bridge 读取 `chartDataMeta`；必须通过显式参数或 chart surface action 拿到当时的 range/meta。

### 任务

- 在 chart-session 中定义 transition 类型，例如 `symbol-change`、`interval-change`、`market-type-change`、`capability-correction`。
- `selectSymbol`、`selectInterval` 不再调用 `runtimeBridgeRef.current.*`。
- market-data 新增 effect，响应 transition 并执行原本由 bridge 调用的清理动作。
- 明确 reset 与 `loadData` 的顺序：同一个 transition 不能出现“先加载新数据、后清旧数据”的竞态。
- visible range 保存需要的 `chartDataMeta` 不再从 `runtimeBridgeRef` 读取；改为 market-data 把 `meta` 作为显式参数传给 `session.actions.onVisibleRangeChange(range, meta)`，或提供 `session.actions.saveVisibleRange(range, meta)`。
- 从 `src/app/App.jsx` 删除 `chartSessionRuntimeBridgeRef`。

### 验收

- `src/app/App.jsx` 不再出现 `runtimeBridgeRef`。
- 切换 symbol、exchange、market type、interval 后，旧数据不会残留。
- interval 切换仍会保存当前 visible range。
- unsupported interval correction 行为不变。
- market-data 的 loading/error/hasMoreLeft 重置语义不变。
- 快速连续切换 symbol/interval 时，过期 transition 不会清掉当前 session 的数据。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不改变 session UI。
- 不改变 K 线 API。
- 不把 market-data setter 暴露给 App。

## Phase H2：移除 App 中的 indicator range bridge

### 修复的问题

market-data 需要在 load-more-left、backfill completion、gap recovery 后请求 indicator 补范围。现在 `src/app/App.jsx` 用 `indicatorRangeRequestRef` 把 indicator action 反向塞给 market-data。这是一个跨 feature 回调桥。

### 目标

让 market-data 只发布 range request 事件，indicator runtime 自己订阅并执行补范围。

### 建议设计

在 `features/market-data` 内建立轻量事件队列：

```text
src/features/market-data/
  marketDataEvents.js
```

market-data 暴露：

```js
events: {
  indicatorRangeRequests,
  consumeIndicatorRangeRequest
}
```

或暴露不可变 token：

```js
events: {
  latestIndicatorRangeRequest
}
```

indicator runtime 接收 `marketData.events`，在 effect 中调用自己的 `requestIndicatorRange(start, end)`。

事件约束：

- 每个 range request 必须带稳定 `id`、`sessionKey`、`start`、`end`、`interval` 和 `reason`，例如 `load-more-left`、`backfill-completed`、`gap-recovery`。
- indicator runtime 必须按 `id` 幂等消费，React effect 重跑不能导致同一个 range 重复请求。
- market-data 仍负责决定“哪里需要补范围”，但不要直接调用 indicator action；indicator 仍负责实际请求、hosted/custom indicator 细节和现有分块策略。
- 不能丢掉 `requestIndicatorRangeInChunks` 当前的大范围分块语义；事件消费层应复用该语义或在 indicator 内保持等价行为。

### 任务

- 从 `useMarketDataRuntime` 参数中移除 `requestIndicatorRange`。
- market-data 内部在需要补指标范围时记录 range request event。
- `useIndicatorRuntime({ marketData })` 监听 range request event。
- 从 `src/app/App.jsx` 删除 `indicatorRangeRequestRef` 和 `requestIndicatorRangeForMarketData`。
- 保证同一个 range request 不会重复消费。
- 保证 load-more-left、backfill completion、gap recovery 的 range request reason 可追踪，方便后续排查指标和 K 线不同步。

### 验收

- `src/app/App.jsx` 不再出现 `indicatorRangeRequestRef`。
- 左侧加载更多历史后，指标仍能补齐新增范围。
- backfill completion 合并后，hosted indicator range request 行为不变。
- gap recovery 后，indicator overlay/sub-pane 不丢数据。
- 大范围补指标仍按当前 chunk 规则拆分，不会因为事件化退化为单个超大请求。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有后端时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

### 不做

- 不改变 indicator WS message format。
- 不改变 indicator compute result format。
- 不引入全局事件总线。

## Phase H3：建立 chart surface runtime，收口 chartWidgetRef

### 修复的问题

`chartWidgetRef` 现在被 App、chart-session、drawing、export、AppShell 共同传递。虽然它是 chart imperative API 的自然入口，但现在传播路径太宽，导致多个 feature 都知道 chart widget ref。

### 目标

建立 `chart-adapter` 层的 chart surface runtime，让 feature 依赖稳定 chart surface contract，而不是直接依赖 `chartWidgetRef`。

### 建议结构

```text
src/chart-adapter/
  useChartSurfaceRuntime.js
  chartSurfaceContract.js
```

对外 contract：

```js
{
  ref,
  view: {},
  actions: {
    getVisibleRange,
    clearAllDrawings,
    setDrawingsHidden,
    prepareExport,
    updateSelectedDrawingStyle
  }
}
```

### 任务

- 在 `useChartSurfaceRuntime` 内部创建并持有 `chartWidgetRef`。
- `AppShell` 只接收 `chartSurface.ref` 用于挂载。
- chart-session、drawing、export 改为接收 `chartSurface.actions`，不再接收 raw ref。
- 保留当前 ChartPane/MultiPaneChart imperative handle，不在本阶段重写 chart rendering。

### 验收

- `src/app/App.jsx` 不再直接创建 `chartWidgetRef`。
- drawing runtime 不再直接调用 `chartWidgetRef.current?.*`。
- export runtime 不再直接依赖 raw chart ref。
- clear drawings、hide drawings、selected drawing style update、prepare export 行为不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改变 ChartPane imperative handle 名称，除非只加 wrapper。
- 不把 chart lifecycle 移到 App。
- 不重写 drawing interaction。

## Phase H4：拆分 AppShell view model

### 修复的问题

`src/app/appShellViewModel.js` 当前把 top bar、interval selector、workspace、lazy surfaces、status bar 的字段级 projection 放在一个函数里。它比把逻辑塞在 JSX 里好，但已经变成一个大型映射表。

### 目标

把 AppShell projection 拆成按页面区域命名的纯 builder，使每个 builder 只理解一个 UI 区域。

### 建议结构

```text
src/app/view-models/
  topBarViewModel.js
  intervalSelectorViewModel.js
  chartWorkspaceViewModel.js
  lazySurfaceViewModel.js
  statusBarViewModel.js
```

### 任务

- 从 `appShellViewModel.js` 迁出 `buildTopBarViewModel`。
- 迁出 `buildIntervalSelectorViewModel`。
- 迁出 `buildChartWorkspaceViewModel`。
- 迁出 `buildLazySurfaceViewModel`。
- 迁出 `buildStatusBarViewModel`。
- 保留 `buildAppShellViewModel` 作为组合函数，只负责调用这些 builder。

### 验收

- 每个 view model builder 无 side effect。
- 每个 builder 文件低于 150 行，`chartWorkspaceViewModel` 如超过 150 行，可在后续阶段拆 toolbar/chart/watchlist。
- AppShell JSX 不变或更薄。
- 子组件 props shape 不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不改 UI 布局。
- 不改 feature runtime。
- 不新增 context/global store。

## Phase H5：拆分 drawing interaction controller 第一刀

### 修复的问题

`src/features/drawings/drawingInteractionController.js` 仍然约 1890 行，是当前最大复杂点。它同时处理 persistence、primitive lifecycle、pointer interaction、selection、text edit、keyboard、snap、export preparation 等多个职责。

### 目标

第一刀只移出 persistence lifecycle，让 interaction controller 不再负责“何时保存、何时加载、何时清 storage”。

### 建议结构

```text
src/features/drawings/
  useDrawingPersistenceLifecycle.js
```

### 任务

- 把当前 controller 内与 `saveDrawings`、`loadDrawings`、`clearSavedDrawings` 相关的 effects 和 helper 迁出。
- 新 hook 接收 `symbol`、`primitivesRef`、`attachPrimitive`、`detachPrimitive`、`setSelectedDrawing` 等最小必要参数。
- controller 只调用 persistence lifecycle，不直接描述 localStorage 语义。
- 保持 `drawingPersistence.js` 作为纯 storage/serialization helper。

### 验收

- `drawingInteractionController.js` 行数明显下降。
- 刷新后 drawing 恢复行为不变。
- 切换 symbol/interval/pane 后 drawing key 不串。
- clear all 后 storage 清理行为不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改 primitive 类。
- 不改 pointer interaction。
- 不改 toolbar。

## Phase H6：拆分 drawing pointer interaction

### 修复的问题

drawing controller 仍会集中处理 pointer down/move/up、drag、resize、erase、hover、snap preview。即使 persistence 移出，它仍然偏大。

### 目标

把 pointer event state machine 拆成独立 controller，让主 drawing controller 只装配各子 controller。

### 建议结构

```text
src/features/drawings/
  drawingPointerController.js
  drawingDragController.js
  drawingEraseController.js
```

### 任务

- 先抽出 pointer coordinate normalization 和 active pointer state。
- 再抽出 drag/resize 逻辑。
- 再抽出 eraser hover/delete 逻辑。
- 每次只抽一个子 controller，并保持 smoke 通过。

### 验收

- 主 controller 不再直接包含所有 pointer case 分支。
- 画线、画矩形、画 fibonacci、position、freehand、text 放置行为不变。
- 选择后拖拽、端点 resize、erase 行为不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时必须跑：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不新增绘图工具。
- 不改变 snap 规则。
- 不改变 primitive rendering。

## Phase H7：把 drawing primitives 迁入 drawings 或 chart-adapter

### 修复的问题

drawing feature 现在仍 import `src/components/primitives/*`。这些 primitive 不是普通展示组件，而是 drawing/chart rendering implementation。继续留在 components 会让目录语义不准。

### 目标

把 drawing primitive 实现从 `components/primitives` 移到更准确的所有权目录。

### 推荐归属

优先迁入：

```text
src/features/drawings/primitives/
```

如果某个 primitive 强依赖 chart adapter contract，可后续再下沉到：

```text
src/chart-adapter/primitives/
```

### 任务

- 移动 primitive 文件到 `features/drawings/primitives`。
- 更新 drawing controller、primitive factory、ChartPane 相关 import。
- 保留或删除旧路径 wrapper，取决于是否有旧引用；如果保留 wrapper，必须在 README 写删除条件。
- 更新架构检查，禁止 features 从 `src/components/primitives` import。

### 验收

- `src/components/primitives` 被删除，或只剩明确短期 wrapper。
- `features/drawings` 不再依赖 components 目录里的 primitive。
- 所有 drawing 类型渲染行为不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不重写 primitive 类。
- 不修改 coordinate math。
- 不改变 serialized drawing schema。

## Phase H8：拆分 SettingsModal shell 和 panel registry

### 修复的问题

`src/features/settings/SettingsModal.jsx` 仍然很大。它已经归到 settings feature，但内部仍同时负责 modal shell、tab registry、panel props、多个 settings section 的装配。

### 目标

把 SettingsModal 拆成 shell、tab registry、panel host 三层。

### 建议结构

```text
src/features/settings/
  SettingsModal.jsx
  settingsTabRegistry.js
  SettingsPanelHost.jsx
  settingsPanelViewModel.js
```

### 任务

- 抽出 tab 定义到 `settingsTabRegistry.js`。
- 抽出当前 tab -> panel 的 switch 逻辑到 `SettingsPanelHost.jsx`。
- 抽出 panel props 派生到 `settingsPanelViewModel.js`。
- `SettingsModal.jsx` 只保留 modal shell、open/close、active tab。

### 验收

- `SettingsModal.jsx` 行数显著下降。
- 每个 panel 的 props 来源更容易追踪。
- 代理测试、交易所刷新、storage maintenance、database tools、cache limits、chart appearance 行为不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不改设置项 UI。
- 不合并 mock、本地 only、真实 backend action。
- 不改 backend endpoint。

## Phase H9：拆分 ChartPane chart lifecycle

### 修复的问题

`src/components/ChartPane.jsx` 仍是 chart rendering 最大模块。它拥有 chart 创建、series lifecycle、indicator overlay、fills、hlines、bgcolors、markers、visible range restore、imperative handle。

### 目标

先把 chart lifecycle 和 series lifecycle 拆成 chart-adapter 下的 helper，保持 ChartPane 作为 React owner，但减少内部细节。

### 建议结构

```text
src/chart-adapter/
  chartPaneLifecycle.js
  seriesLifecycle.js
  overlaySeriesRenderer.js
  chartImperativeHandle.js
```

### 任务

- 抽出 chart 创建和基础 option application。
- 抽出 main series / overlay series 创建、更新、清理。
- 抽出 fills / hlines / bgcolors / markers 中最独立的一类作为第一步，不一次性全拆。
- 抽出 imperative handle builder，但仍由 ChartPane 调用 `useImperativeHandle`。

### 验收

- ChartPane 行数逐阶段下降。
- visible range restore 行为不变。
- overlay indicator、fills、hlines、bgcolors、barcolors 行为不变。
- chart adapter 不拥有业务规则，只拥有 chart 操作。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

### 不做

- 不替换 Lightweight Charts。
- 不把 chart lifecycle 上移到 App。
- 不改变 indicator output contract。

## Phase H10：收窄 feature runtime 兼容字段

### 修复的问题

部分 feature runtime 同时返回新接口 `{ view, actions, status }` 和旧兼容字段。例如 drawing 和 indicators 仍暴露大量顶层字段。这样方便迁移，但会让后续调用方继续绕开稳定 contract。

### 目标

在调用方全部迁到 `{ view, actions, status }` 后，删除旧兼容字段。

### 任务

- 搜索 feature runtime 顶层兼容字段的引用。
- 先改调用方使用 `view/actions/status`。
- 每次删除一个 runtime 的兼容字段：先 indicators，再 drawings，再 market-data。
- 更新对应 feature README，写明公共 contract。

### 验收

- AppShell 和 LazyFeatureSurfaces 只依赖稳定 contract。
- feature runtime 返回对象表面积变小。
- 无旧字段引用。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不改变 feature 行为。
- 不新增 re-export barrel 掩盖路径。

## Phase H11：强化架构检查

### 修复的问题

当前 `check-architecture` 已经能防组件直接 import service、组件直接 localStorage、shared import feature、service import React、feature runtime JSX、Lightweight Charts 越界 import。但当前剩余风险还包括：feature 依赖 legacy components/primitives、App 重新引入 bridge refs、feature runtime 继续返回兼容字段。

### 目标

把已经清理完成的边界变成自动检查，避免回退。

执行原则：

- 不必等所有阶段结束后一次性补检查。每完成一个可检查的边界，就在同一 Phase 或紧随其后的提交中加入对应规则。
- H1 完成后立即禁止 `src/app/App.jsx` 重新出现 `runtimeBridgeRef`。
- H2 完成后立即禁止 `src/app/App.jsx` 重新出现 `indicatorRangeRequestRef`。
- H3 完成后立即禁止 `src/app/App.jsx` 直接创建 raw `chartWidgetRef`。
- H7 完成后立即禁止 `src/features/*` import `src/components/primitives/*`。

### 任务

- 新增规则：`src/features/*` 不允许 import `src/components/primitives/*`。
- 新增规则：`src/app/App.jsx` 不允许出现 `runtimeBridgeRef`、`indicatorRangeRequestRef`。
- 新增规则：`src/app/App.jsx` 不允许直接创建 chart widget ref；应通过 chart surface runtime。
- 可选新增规则：feature runtime 文件不允许返回指定 legacy compat field。
- 每条规则都要有清晰错误信息。
- 每条规则只在对应迁移完成后启用，避免为了通过检查而引入长期 allowlist。

### 验收

- `node ./scripts/check-architecture.mjs` 通过。
- 故意制造越界 import 时，错误信息能指出文件和规则。
- 没有无期限 allowlist。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不引入复杂 monorepo 工具。
- 不把规则写到无法解释的正则迷宫里。

## 推荐提交顺序

1. `refactor(frontend): replace session runtime bridge with transitions`
2. `refactor(frontend): replace indicator range bridge with market events`
3. `refactor(frontend): add chart surface runtime`
4. `refactor(frontend): split app shell view models`
5. `refactor(frontend): extract drawing persistence lifecycle`
6. `refactor(frontend): split drawing pointer controller`
7. `refactor(frontend): move drawing primitives into drawings feature`
8. `refactor(frontend): split settings modal shell`
9. `refactor(frontend): split chart pane lifecycle helpers`
10. `refactor(frontend): remove feature runtime compat fields`
11. `test(frontend): harden architecture boundary checks`

## 每阶段完成前检查

- 是否只修了一个问题。
- 是否减少了 App、AppShell、ChartPane、SettingsModal 或 drawing controller 中的一个明确职责。
- 是否没有新增组件层 service/storage/WebSocket 访问。
- 是否没有把业务规则迁入 `app`、`shared` 或 `chart-adapter`。
- 是否保留 lazy loading 和首屏 K 线优先策略。
- 是否保留 exchange capability 由后端驱动的原则。
- 如果本阶段清掉了一个边界，是否同步补了 architecture check 防回退。
- 是否运行了 architecture check、lint、build。

## 停止条件

出现以下情况时停止继续推进：

- 为了移除一个 ref bridge，需要重写 K 线加载或 indicator 协议。
- chart surface runtime 开始拥有业务规则。
- drawing controller 拆分后 drawing 保存恢复或 text edit 退化。
- ChartPane 拆分导致 visible range、crosshair、pane sync 或 overlay 渲染退化。
- SettingsModal 拆分后无法判断某个 action 是 mock、本地 only 还是真 backend endpoint。
- 架构检查开始依赖大量永久 allowlist。

## 完成定义

本计划完成后，前端应达到：

- `src/app/App.jsx` 不持有跨 feature bridge refs。
- feature 之间通过显式 event/action contract 协作。
- `AppShell` 只组合区域 view model，不做大块字段投影。
- drawing controller 不再是单一巨型控制器。
- drawing primitives 的目录归属与业务所有权一致。
- SettingsModal 和 ChartPane 不再是不可读的大型模块。
- feature runtime 只暴露 `{ view, actions, status, events }` 等稳定 contract。
- architecture check 覆盖已清理边界，防止后续回退。

这一步完成后，前端架构才可以从“已经很好”进入“接近完美且能长期保持”的状态。
