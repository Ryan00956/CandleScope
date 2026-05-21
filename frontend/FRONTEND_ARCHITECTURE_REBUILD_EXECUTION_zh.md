# CandleScope 前端理想架构执行文档

本文定义 CandleScope 前端从“已经拆分的水平分层”继续演进到“按业务能力拥有边界”的执行路线。

当前前端已经完成了大量拆分：`App.jsx` 不再包含所有实现细节，`src/runtime`、`src/components`、`src/services` 也已经成型。但当前主要问题仍然存在：架构边界还不是由业务能力决定，而是由技术类型决定。结果是多个模块看起来已经分开，实际所有权仍然交叉。

本文的目标不是一次性重写前端，而是定义一组中等规模、可验证、可提交的阶段。每个阶段只修一个架构问题。所有阶段完成后，前端应达到一个稳定、清晰、可扩展的目标形态：

```text
src/
  app/                  # 应用组合根、Provider、Shell 装配
  features/             # 按业务能力组织的垂直模块
    chart-session/
    market-data/
    indicators/
    drawings/
    watchlist/
    symbol-search/
    settings/
    alerts/
    export/
  chart-adapter/        # Lightweight Charts 专用适配层
  shared/               # 无业务所有权的通用 UI、storage、service、工具
```

## 架构原则

### 1. 业务能力优先于技术分层

当前目录大体按 `components`、`runtime`、`services`、`hooks` 分层。这个方式能降低单文件体积，但不能自然回答“谁拥有这个行为”。下一阶段应按业务能力组织代码：

| 能力 | 所有权 |
|---|---|
| `chart-session` | 当前 exchange、market type、symbol、interval、dataset key、可见范围导航 |
| `market-data` | K 线首屏加载、缓存、左侧分页、backfill completion、gap recovery、K 线 WebSocket |
| `indicators` | active indicators、内置指标、Pyne/custom 指标、指标 WS、pane projection、指标输出类型 |
| `drawings` | 绘图工具状态、选择、交互、持久化、primitive 生命周期 |
| `watchlist` | 自选列表、订阅层级、侧栏状态、本地持久化 |
| `symbol-search` | symbol catalog、收藏、搜索弹窗状态 |
| `settings` | 图表偏好、代理设置、交易所刷新、缓存限制、维护动作 |
| `export` | 导出面板、导出选项、预览、导出前状态提交 |

### 2. App 只组合，不协调细节

目标中的 `App.jsx` 应只负责装配 feature runtime 和 shell：

```jsx
function App() {
  const session = useChartSession();
  const marketData = useMarketDataRuntime(session);
  const indicators = useIndicatorRuntime(session, marketData);
  const drawings = useDrawingRuntime(session);
  const settings = useSettingsRuntime();
  const watchlist = useWatchlistRuntime();

  return (
    <AppShell
      session={session.view}
      marketData={marketData.view}
      indicators={indicators.view}
      drawings={drawings.view}
      settings={settings.view}
      watchlist={watchlist.view}
    />
  );
}
```

如果 `App.jsx` 需要知道“删除指标时要清理哪个 drawing storage key”，说明边界还没有完成。

### 3. 依赖方向必须固定

最终依赖方向：

```text
app -> features -> chart-adapter/shared
feature ui -> feature runtime -> feature service/storage
chart-adapter -> lightweight-charts
shared -> no app, no feature
```

禁止方向：

```text
shared -> features
services/storage -> React
components -> fetch/localStorage/WebSocket
runtime -> JSX
features/* -> App.jsx internals
```

### 4. 一阶段只修一个问题

每个阶段必须满足：

- 只改变一个架构所有权问题。
- 不混入视觉重设计。
- 不混入后端接口语义变化。
- 不引入大型全局状态库来掩盖 props 问题。
- 保留当前 lazy loading 和首屏 K 线优先策略。
- 阶段结束时能独立运行 lint/build，条件允许时跑 smoke。

## 当前问题清单

| 问题 | 当前表现 | 最终归属 |
|---|---|---|
| 组合根过重 | `App.jsx` 仍串联 chart、stream、indicator、drawing、settings、watchlist | `app` 只组合 feature |
| chart session 分散 | symbol/exchange/marketType/interval/custom interval/navigation 分布在 App 和多个 runtime | `features/chart-session` |
| market data 流程分散 | initial load、load more、WS、gap、backfill 分布在多个 runtime，由 App 串接 | `features/market-data` |
| indicator runtime 仍偏总控 | `useIndicators.js` 同时处理 active state、compute、WS、输出 patch | `features/indicators` |
| drawing engine 未分层 | `useDrawing.js` 同时处理 primitive、交互、选择、持久化、编辑 | `features/drawings` + `chart-adapter` |
| 组件仍碰 storage | Watchlist、symbol favorites、pane heights 等 UI 组件直接读写 localStorage | feature storage 或 shared storage |
| chart adapter 不清晰 | Lightweight Charts ref、series、primitive 生命周期穿透多处 | `chart-adapter` |
| Settings 仍像综合面板 | 弹窗 shell、业务 action、维护流程、偏好表单仍耦合 | `features/settings` |
| props 包过大 | `ChartWorkspace`、`LazySurfaces` 接收巨型对象包 | feature view model |
| 测试边界不匹配 | 验证多依赖手工 smoke，缺少 feature helper 的小测试面 | 每个 feature 有最小纯 helper 测试 |

## 目标完成态

所有阶段完成后，应满足：

- `App.jsx` 低于 200 行，只有 feature runtime 装配、Provider 装配和 Shell 渲染。
- `src/hooks` 不再作为长期业务目录；可迁移到 `features/*` 或 `shared/*`。
- UI 组件不直接访问 `fetch`、`WebSocket`、`localStorage`。
- `market-data` 拥有完整 K 线生命周期，App 不再串接 initial load、WS、gap 和 backfill。
- `indicators` 只消费 market data 的 stable contract，不直接知道 App 的 chart refs。
- `drawings` 只通过 chart adapter 操作图表，不让 App 手动协调 drawing storage。
- `settings`、`watchlist`、`symbol-search` 都有自己的 runtime 和 storage 边界。
- Lightweight Charts 特有对象被限制在 `chart-adapter` 和 chart rendering components 内。
- 每个 feature 都暴露 `{ view, actions, status }` 形态的稳定接口。

## Phase 0：建立架构护栏

### 修复的问题

当前没有机械化边界护栏。即使文档写清楚，后续改动仍可能让组件重新直接访问 service、storage 或 runtime 内部。

### 目标

新增最小架构约束文档和检查入口，先让后续阶段有可执行的边界标准。

### 任务

- 新增 `src/features/README.md`，定义 feature 模块的标准结构。
- 新增 `src/shared/README.md`，定义 shared 目录只能放无业务所有权代码。
- 新增 `src/chart-adapter/README.md`，定义 Lightweight Charts 对象隔离规则。
- 在 `src/runtime/README.md` 标注该目录是迁移期目录，长期能力代码应迁入 `features/*`。
- 在 `README.md` 链接本文档。

### 验收

- 文档明确写出允许依赖和禁止依赖。
- 后续阶段能引用这些规则，不需要重新解释边界。
- `git diff --check` 通过。

### 不做

- 不移动现有代码。
- 不引入 lint 插件。
- 不修改运行时行为。

## Phase 1：收束 Chart Session

### 修复的问题

当前 chart session 状态分散在 `App.jsx` 和多个 runtime 中，包括 `symbol`、`exchange`、`marketType`、`interval`、`datasetKey`、custom interval、native interval fallback、用户偏好写入。

### 目标

创建 `features/chart-session`，让“当前图表会话”成为显式模型。

### 建议结构

```text
src/features/chart-session/
  chartSessionModel.js
  useChartSession.js
  intervalPolicy.js
  visibleRangeStorage.js
  README.md
```

### 任务

- 从 `App.jsx` 迁出 session state 初始化和 user prefs 持久化。
- 把 exchange capability 对 interval/market type 的修正逻辑迁入 `useChartSession`。
- 把 custom interval action 接入 session，而不是让 App 自己协调 interval mutation。
- 暴露稳定接口：

  ```js
  {
    view: { symbol, exchange, marketType, interval, datasetKey, nativeIntervals, intervalGroups },
    actions: { selectSymbol, selectInterval, selectMarketType, refreshDataset },
    status: { exchangeCatalogStatus, exchangeLimitations }
  }
  ```

### 验收

- `App.jsx` 不再直接拥有 `symbol`、`exchange`、`marketType`、`interval` 的 `useState`。
- 切换 symbol、exchange、market type、interval 行为不变。
- 自定义周期创建、删除、恢复、pin 行为不变。
- interval unsupported 时仍能回退到 backend capability 提供的 native interval。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不移动 K 线加载逻辑。
- 不移动 indicator 或 drawing。
- 不改变 backend capability contract。

## Phase 2：建立 Market Data Runtime

### 修复的问题

当前 K 线生命周期被 App 串起来：initial load、left pagination、backfill completion、K 线 WS、background prefetch、gap recovery 各自是 runtime，但所有协作关系仍在 App。

### 目标

创建 `features/market-data`，由它完整拥有 K 线数据生命周期。

### 建议结构

```text
src/features/market-data/
  useMarketDataRuntime.js
  marketDataModel.js
  marketDataCache.js
  marketDataEffects.js
  marketDataView.js
  README.md
```

### 任务

- 把 `useChartDataRuntime`、`useChartInitialLoad`、`useChartLoadMoreLeft`、`useKlineStreamRuntime`、`useBackfillCompletionRuntime`、`useChartGapRecovery` 的组合关系迁入 `useMarketDataRuntime`。
- 由 `useMarketDataRuntime(session)` 暴露：

  ```js
  {
    view: { bars, renderBars, meta, loading, error, lastPrice, dataSource, wsStatus },
    actions: { retry, loadMoreLeft, onVisibleRangeChange },
    events: { onBackfillCompleted },
    status: { hasMoreLeft, loadingMoreLeft, activeChartReady }
  }
  ```

- App 不再知道 pending refs、cache refs、loading refs、tracked interval refs。
- 保留当前 “K 线 ready 优先于 indicator/background work” 的语义。

### 验收

- `App.jsx` 不再直接调用 initial load、WS、gap recovery、backfill completion hooks。
- 首屏加载仍先显示 K 线，不等待指标。
- 左拖加载历史、backfill completion 合并、gap recovery 行为不变。
- WebSocket 更新仍能更新当前价格和最后一根 K 线。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有后端时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不修改 API path。
- 不调整 backend priority。
- 不改变 indicator compute。

## Phase 3：隔离 Chart Adapter

### 修复的问题

Lightweight Charts 的 `chartRef`、`seriesRef`、primitive、visible range restore 目前穿透 App、chart components、drawing 和 indicator。业务代码容易被图表库对象污染。

### 目标

建立 `chart-adapter`，让图表库对象成为适配层内部细节。

### 建议结构

```text
src/chart-adapter/
  LightweightChartSurface.jsx
  chartInstanceBridge.js
  primitiveBridge.js
  visibleRangeBridge.js
  coordinateBridge.js
  README.md
```

### 任务

- 定义 chart adapter 对外 contract：

  ```js
  {
    getMainSeries(),
    attachPrimitive(primitive),
    detachPrimitive(primitive),
    priceToCoordinate(price),
    timeToCoordinate(time),
    coordinateToPrice(y),
    coordinateToTime(x),
    restoreVisibleRange(range),
    subscribeCrosshair(handler)
  }
  ```

- 让 drawing 和 indicator 只依赖 adapter contract。
- 保留 `ChartPane` / `MultiPaneChart` 对 Lightweight Charts 生命周期的实际所有权。
- 从 App 移除 indicator ref-to-ref 协调细节。

### 验收

- App 不再持有 `indicatorChartRefRef` / `indicatorSeriesRefRef` 这类图表库桥接细节。
- indicator 和 drawing 不直接读取 Lightweight Charts 内部对象。
- 图表平移、缩放、crosshair、pane resize 行为不变。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不重写 chart rendering。
- 不更换图表库。
- 不把 Lightweight Charts 所有权迁入 App 或 service。

## Phase 4：重构 Indicator Runtime 边界

### 修复的问题

`useIndicators.js` 已经抽出了 helper，但仍同时拥有 active state、compute scheduling、hosted WebSocket、snapshot/patch、pane projection、output side effects。

### 目标

把 indicator 拆成明确子模块，并让它只消费 market data contract。

### 建议结构

```text
src/features/indicators/
  useIndicatorRuntime.js
  activeIndicatorStore.js
  indicatorComputeController.js
  indicatorStreamController.js
  indicatorOutputReducer.js
  indicatorPaneProjection.js
  IndicatorPanel.jsx
  IndicatorEditor.jsx
  README.md
```

### 任务

- 把 active indicator 持久化与 mutation 固定在 `activeIndicatorStore.js`。
- 把本地 compute 与 hosted stream 分成两个 controller。
- 把 marker/fill/hline/bgcolor/barcolor/signal 更新收束为 reducer。
- 让 pane projection 变成纯函数。
- `useIndicatorRuntime(session, marketData)` 只接收稳定输入，不接收 App refs。

### 验收

- `useIndicators.js` 被替换或降级为 compatibility wrapper。
- 删除、隐藏、参数更新、脚本更新、手动 recompute 行为不变。
- hosted indicator snapshot 仍等待 chart data ready。
- MA/VOL 默认行为不变。
- indicator 输出仍正确进入 main overlay 和 sub pane。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有后端时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

### 不做

- 不改变 Pyne/custom indicator API。
- 不改变指标输出数据格式。
- 不把指标计算塞进 chart components。

## Phase 5：拆解 Drawing Engine

### 修复的问题

`useDrawing.js` 是当前最大单点复杂度。它同时拥有工具状态、primitive 创建、pointer 交互、选择、拖拽、snap、文本编辑、持久化、清理。

### 目标

把 drawing 拆成 controller、interaction、selection、persistence、primitive factory，并只通过 chart adapter 触碰图表。

### 建议结构

```text
src/features/drawings/
  useDrawingRuntime.js
  drawingModel.js
  drawingToolState.js
  drawingInteractionController.js
  drawingSelectionController.js
  drawingPersistence.js
  drawingPrimitiveFactory.js
  drawingSnapController.js
  DrawingToolbar.jsx
  README.md
```

### 任务

- 先抽出纯 model：drawing id、tool id、style、pane key、storage key。
- 再抽出 persistence：load/save/clear/restore，只接受 model，不知道 UI。
- 再抽出 interaction：pointer down/move/up、drag、resize、erase。
- 再抽出 selection：selected drawing、style sync、delete/escape。
- 最后让 `useDrawingRuntime(session, chartAdapter)` 成为唯一入口。

### 验收

- `useDrawing.js` 不再超过 600 行，或被多个 controller 替代。
- 刷新后保存绘图仍能恢复。
- 切换 symbol/interval/pane 时 drawing key 不串。
- 文本编辑导出前仍能提交。
- clear all、hide/show、snap、fibonacci、position 工具行为不变。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改变绘图工具视觉表现。
- 不重写 primitives。
- 不改变导出格式。

## Phase 6：收束 Watchlist

### 修复的问题

Watchlist 相关状态分散在 storage service、runtime、sidebar component 中，组件仍直接管理 localStorage、宽度、折叠状态和列表结构。

### 目标

创建 `features/watchlist`，让 watchlist UI 只渲染 view model。

### 建议结构

```text
src/features/watchlist/
  useWatchlistRuntime.js
  watchlistStore.js
  watchlistSubscriptionRuntime.js
  WatchlistSidebar.jsx
  README.md
```

### 任务

- 把 list storage、collapsed list storage、sidebar width storage 迁入 `watchlistStore.js`。
- 把 subscription tier 和 symbol price runtime 固定在 watchlist feature 内。
- Sidebar 只接收 `items`、`layout`、`actions`。

### 验收

- `WatchlistSidebar.jsx` 不再直接访问 `localStorage`。
- 自选列表增删、折叠、调整宽度、订阅层级行为不变。
- symbol 选择仍通过 chart session action。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不改 watchlist UI。
- 不改订阅协议。
- 不把 watchlist price stream 合并进 market-data。

## Phase 7：收束 Symbol Search

### 修复的问题

Symbol search modal 同时负责 catalog runtime、favorites localStorage、搜索过滤、键盘/菜单交互和渲染。

### 目标

创建 `features/symbol-search`，让 catalog、favorites、modal interaction 分层。

### 建议结构

```text
src/features/symbol-search/
  useSymbolSearchRuntime.js
  symbolCatalogRuntime.js
  symbolFavoritesStore.js
  symbolSearchFilter.js
  SymbolSearch.jsx
  SymbolSearchModal.jsx
  README.md
```

### 任务

- 把 favorites storage 迁出 modal。
- 把 search/filter/sort 变成纯函数。
- 把 catalog loading status 和 refresh action 固定在 runtime。
- Symbol select 只调用 chart session 的 `selectSymbol`。

### 验收

- SymbolSearchModal 不直接访问 `localStorage`。
- 搜索、收藏、键盘选择、context menu 行为不变。
- 后端 exchange catalog 失败时 fallback 行为不变。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不新增交易所硬编码策略。
- 不改变 symbol key 格式。

## Phase 8：收束 Settings

### 修复的问题

Settings 已经拆出 panel，但 `SettingsModal` 仍像综合协调器，包含多个后端 action、维护流程和偏好表单挂载逻辑。

### 目标

创建 `features/settings`，让 settings modal 只负责弹窗 shell，业务 action 进入 runtime。

### 建议结构

```text
src/features/settings/
  useSettingsRuntime.js
  chartAppearanceSettings.js
  proxySettingsRuntime.js
  exchangeSettingsRuntime.js
  maintenanceSettingsRuntime.js
  cacheLimitSettingsRuntime.js
  SettingsModal.jsx
  panels/
  README.md
```

### 任务

- 把 chart appearance、proxy、exchange refresh、storage maintenance、cache limit runtime 收束进 settings feature。
- `SettingsModal` 只拥有 tab/open/close 和 panel mount。
- 维护动作必须明确标注 mock、本地 only、真实 backend endpoint 三种类型。

### 验收

- `SettingsModal.jsx` 不再直接 import settings action service。
- 代理测试、交易所刷新、storage repair、gap scan、cache sync 行为不变。
- settings 更新仍能驱动 chart colors/theme/timezone。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不改设置项文案和布局。
- 不把 mock action 包装成真实后端能力。
- 不改变 backend endpoint。

## Phase 9：收束 Export

### 修复的问题

Export workflow 涉及 chart widget ref、page export ref、drawing hidden state、preview、metadata、导出前文本提交。当前它依赖 App 串接多方状态。

### 目标

创建 `features/export`，让导出只依赖 chart adapter、drawing runtime 和 session view。

### 建议结构

```text
src/features/export/
  useExportRuntime.js
  exportOptionsStore.js
  exportPreviewRuntime.js
  exportService.js
  ExportPanel.jsx
  README.md
```

### 任务

- 把 export options persistence 固定在 export feature。
- 把 export preview 和 export action 收束到 `useExportRuntime`。
- 导出前需要 drawing 提交文本编辑时，通过 drawing runtime action 完成，不由 App 操作 drawing state。

### 验收

- App 不再协调 `drawingsHidden` 和 export panel 的内部关系。
- 导出图片、预览、metadata、错误提示行为不变。
- 导出前 active text edit 仍会提交。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改变导出格式。
- 不改变默认导出选项。

## Phase 10：重塑 App Shell 和 Lazy Surfaces

### 修复的问题

`ChartWorkspace`、`LazySurfaces`、`TopBar` 当前通过大 props 包接收大量 feature 细节。虽然减少了 App JSX 体积，但 shell 还没有形成稳定页面 contract。

### 目标

建立 `src/app`，让 App Shell 接收 feature view models，而不是松散 props。

### 建议结构

```text
src/app/
  App.jsx
  AppShell.jsx
  AppProviders.jsx
  LazyFeatureSurfaces.jsx
  TopBar.jsx
  StatusBar.jsx
```

### 任务

- 把 `components/app-shell` 迁入 `app`。
- 定义 Shell props：

  ```js
  {
    session,
    marketData,
    indicators,
    drawings,
    watchlist,
    settings,
    exportFlow,
    alerts
  }
  ```

- `LazyFeatureSurfaces` 只负责 lazy import 和 mount，不理解 feature 内部状态细节。
- TopBar 只接收 header view，不直接格式化 feature 内部数据。

### 验收

- `App.jsx` 只装配 feature runtime。
- Shell 不再接收几十个扁平 props。
- Lazy loading chunk 行为不变。
- 首屏 bundle 不变大，非首屏 panel 仍 lazy。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不做 UI 重设计。
- 不移除 lazy loading。
- 不改变 panel 开关行为。

## Phase 11：清理迁移期目录

### 修复的问题

迁移完成后，如果 `src/hooks` 和 `src/runtime` 继续保留大量历史模块，架构会同时存在新旧两套入口。

### 目标

删除或降级迁移期 wrapper，让目录结构真实反映所有权。

### 任务

- 检查 `src/hooks`，把仍有业务所有权的 hook 迁入对应 feature。
- 检查 `src/runtime`，把仍有业务所有权的模块迁入对应 feature。
- 只保留真正 shared 的纯 helper，迁入 `src/shared`。
- 删除已无引用的 compatibility wrapper。
- 更新 `ARCHITECTURE.md` 和 `ARCHITECTURE_zh.md`。

### 验收

- `src/hooks` 不再是业务模块入口。
- `src/runtime` 不再持有 feature 所有权，或被明确标注为 legacy compatibility。
- README 中的架构说明与实际目录一致。

### 验证

```powershell
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
git diff --check
```

### 不做

- 不为了“目录漂亮”移动仍不稳定的代码。
- 不保留无意义 re-export barrel。

## Phase 12：建立架构回归检查

### 修复的问题

如果没有自动检查，组件直接访问 storage、feature 越界 import、runtime 混 JSX 等问题会反复出现。

### 目标

增加轻量架构检查脚本，保护目标结构。

### 建议结构

```text
scripts/check-architecture.mjs
```

### 检查规则

- `src/components` 或 `src/app` 不允许直接 import `src/services/*`，除非在 allowlist。
- `src/components` 或 `src/app` 不允许直接调用 `localStorage`。
- `src/shared` 不允许 import `src/features`。
- `src/services` 不允许 import React。
- `src/features/*/runtime` 不允许包含 JSX。
- `src/chart-adapter` 是唯一允许集中 import `lightweight-charts` 的适配入口；现有 chart rendering 迁移期间可用 allowlist。

### 验收

- `npm run lint` 或新增 `npm run check:architecture` 能运行检查。
- 检查失败时输出清晰文件路径和规则名称。
- 初期 allowlist 有注释，且每条都有计划删除阶段。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

### 不做

- 不引入复杂 monorepo 工具。
- 不让检查阻塞当前无法一次迁完的历史文件；用明确 allowlist 过渡。

## 推荐提交节奏

每个 phase 独立提交。提交说明应包含：

- 本阶段修复的唯一架构问题。
- 迁移的主要 ownership。
- 已运行的验证命令。
- 如果有 allowlist 或 compatibility wrapper，说明删除条件。

推荐顺序：

1. `docs: add frontend architecture rebuild plan`
2. `refactor(frontend): add architecture guard docs`
3. `refactor(frontend): extract chart session feature`
4. `refactor(frontend): consolidate market data runtime`
5. `refactor(frontend): isolate chart adapter boundary`
6. `refactor(frontend): reshape indicator runtime`
7. `refactor(frontend): split drawing engine controllers`
8. `refactor(frontend): move watchlist ownership into feature`
9. `refactor(frontend): move symbol search ownership into feature`
10. `refactor(frontend): move settings ownership into feature`
11. `refactor(frontend): move export ownership into feature`
12. `refactor(frontend): simplify app shell contracts`
13. `refactor(frontend): remove legacy runtime wrappers`
14. `test(frontend): add architecture boundary checks`

## 每阶段通用验收清单

每个阶段完成前都检查：

- `App.jsx` 是否减少了协调职责，而不是只是把代码搬到另一个大 hook。
- UI 组件是否少知道了一个 service/storage/runtime 细节。
- 新模块名称是否回答“谁拥有这个行为”。
- 是否保留首屏 K 线优先和 lazy loading。
- 是否没有新增 exchange-specific 前端硬编码策略。
- 是否没有新增全局状态库来绕开边界设计。
- 是否没有把 Lightweight Charts 对象扩散到更多业务模块。
- 是否运行了 lint/build。

## 停止条件

出现以下情况时，停止继续推进并重新评估：

- 首屏 K 线又开始等待 indicator、settings、watchlist 或 drawing。
- 删除指标、删除 pane、切换 symbol 后 drawing storage 串 key。
- WebSocket tick 能更新图表但不能更新 header price，或反过来。
- indicator hosted snapshot 在 chart data ready 前进入渲染。
- settings action 拆分后更难判断是真后端能力还是本地/mock 行为。
- 为了减少 props 引入大型全局 store，但业务所有权仍然不清楚。
- `chart-adapter` 变成新的万能层，开始拥有业务规则。

## 最终完成定义

当前文档全部完成后，前端应达到：

- `App.jsx` 是组合根，不是业务调度中心。
- `features/*` 是业务能力的主要入口。
- `chart-adapter` 是图表库隔离层。
- `shared` 不含 CandleScope 业务语义。
- 每个 feature 都能独立解释、独立验证、独立替换内部实现。
- 新增 Pine/Pyne 指标能力时，主要进入 `features/indicators`，不会迫使 App、chart session、market data、drawing 同时变化。
- 新增交易所 capability 时，主要由后端 plugin 提供 metadata，前端通过 `chart-session` 和 `market-data` 消费，不新增散落硬编码。
- 新增绘图工具时，主要进入 `features/drawings` 和 `chart-adapter`，不会影响 indicator 或 market data。

这就是本文所谓的“完美架构”：不是没有复杂度，而是复杂度有主人、有边界、有验证入口。
