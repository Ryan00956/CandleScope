# CandleScope 前端架构边界硬化执行文档

本文定义 CandleScope 前端在完成 `FRONTEND_ARCHITECTURE_REBUILD_EXECUTION_zh.md` 的 12 个阶段之后，继续收紧代码实现边界的执行路线。

当前前端主体架构已经合理：`src/app` 成为组合根和页面 Shell，`src/features/*` 已经按业务能力拥有主要 runtime、storage、controller 和 feature UI 入口，`src/runtime` 只保留跨应用 performance instrumentation，且 `scripts/check-architecture.mjs` 已经提供基础边界检查。

但代码实现还没有达到完全干净的终态。当前剩余问题主要集中在三类：

- 架构检查 allowlist 中的历史例外仍然存在。
- 部分 feature UI 仍通过 compatibility wrapper 间接留在 `src/components`。
- `AppShell`、chart rendering 和 drawing/chart adapter 之间仍有迁移期投影和 imperative bridge。

本文目标不是开启另一轮大型重构，而是把这些已知边界债拆成小步、可验证、可独立提交的硬化阶段。

## 当前代码级判断

基于当前实现，前端处于以下状态：

- `src/app/App.jsx` 已经主要负责装配 feature runtime、Provider 和 Shell。
- `features/chart-session` 拥有 symbol、exchange、market type、interval、custom interval、dataset key 和 visible range。
- `features/market-data` 拥有 K 线首屏加载、缓存、左侧分页、WebSocket、backfill completion、gap recovery 和 background prefetch。
- `features/indicators` 已拆出 active store、compute controller、stream controller、output reducer 和 pane projection。
- `features/drawings` 已拆出 tool state、persistence、primitive factory、selection、snap 和 interaction controller。
- `features/watchlist`、`features/symbol-search`、`features/settings`、`features/export` 已经拥有主要 runtime 和 storage 边界。
- `src/runtime` 只剩 `performance/` instrumentation。

同时仍有以下明确迁移债：

- `src/components/IndicatorPanel.jsx` 仍直接 import `src/services/indicatorApi`。
- `src/components/MultiPaneChart.jsx` 仍直接访问 `localStorage` 保存 pane heights。
- `src/components/ChartPane.jsx` 仍直接 import `lightweight-charts`。
- `src/features/settings/SettingsModal.jsx`、`src/features/indicators/IndicatorPanel.jsx`、`src/features/indicators/IndicatorEditor.jsx` 仍是 re-export wrapper。
- `src/app/AppShell.jsx` 仍做大量 feature 字段级 props 投影。

## 执行原则

### 1. 先清已被工具识别的边界例外

优先处理 `scripts/check-architecture.mjs` allowlist 中的条目。每清一条 allowlist，都要同步删除对应 allowlist entry，并运行架构检查。

### 2. 保留当前用户行为

这些阶段只调整 ownership 和 import 方向，不做 UI 重设计，不改后端 API contract，不改默认功能语义。

### 3. 小步提交，阶段可回滚

每个阶段只解决一个边界问题。阶段完成后必须能独立通过：

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

涉及 chart、drawing、export、lazy surface 的阶段，在有运行环境时额外跑：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 4. 不为目录漂亮而搬不稳定代码

如果某个 UI 文件还在频繁变化，可以先通过 runtime action 和 storage helper 收紧依赖，再择机移动文件。移动文件不应混入行为重写。

## Phase H1：收束 IndicatorPanel service 直连

### 修复的问题

`src/components/IndicatorPanel.jsx` 仍直接 import `deleteCustomIndicator` 和 `saveCustomIndicator`，违反组件层不直接访问 service 的边界规则。

### 目标

让自定义指标保存、删除、catalog 更新都由 `features/indicators` runtime 拥有，IndicatorPanel 只调用 feature action。

### 任务

- 在 `features/indicators/useIndicatorCatalogRuntime.js` 中暴露保存和删除自定义指标的 action。
- 或新增 `features/indicators/customIndicatorStore.js`，把 backend service 调用和本地 catalog mutation 收束进去。
- 从 `components/IndicatorPanel.jsx` 移除对 `services/indicatorApi` 的直接 import。
- 删除 `scripts/check-architecture.mjs` 中 `component-no-service-import` 对 `src/components/IndicatorPanel.jsx` 的 allowlist entry。
- 更新 `features/indicators/README.md`，标注 custom indicator catalog action 的所有权。

### 验收

- `IndicatorPanel.jsx` 不再 import `src/services/*`。
- 自定义指标保存、删除、编辑后列表刷新行为不变。
- `check:architecture` allowlist 数量减少 1。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

### 不做

- 不改变 Pyne/custom indicator API。
- 不移动 IndicatorPanel 文件。
- 不重写 IndicatorEditor。

## Phase H2：移出 MultiPaneChart pane height storage

### 修复的问题

`src/components/MultiPaneChart.jsx` 直接读写 `localStorage` 保存 pane heights，违反组件层不直接访问 storage 的边界规则。

### 目标

把 pane height persistence 固定到明确 storage/helper 模块中，让 chart container 只调用 helper。

### 建议结构

```text
src/features/chart-session/
  paneLayoutStorage.js
```

或在后续引入 chart layout owner 时迁入：

```text
src/features/chart-layout/
  paneLayoutStorage.js
```

当前不建议为了一个 helper 新增完整 feature，因此优先放入 `features/chart-session` 或 `shared/storage` 的泛型 wrapper 加 feature-owned key。

### 任务

- 抽出 `loadPaneHeights`、`savePaneHeights`、`paneConfigKey` 相关 storage 逻辑。
- `MultiPaneChart.jsx` 不再直接访问 `localStorage`。
- 删除 `scripts/check-architecture.mjs` 中 `component-no-local-storage` 对 `src/components/MultiPaneChart.jsx` 的 allowlist entry。
- 更新相关 README，说明 pane layout persistence 的临时归属和后续迁移条件。

### 验收

- `MultiPaneChart.jsx` 不再出现 `localStorage`。
- 拖拽 pane resize 后刷新页面仍能恢复高度。
- 删除指标 pane 后，pane layout 不串 key。
- `check:architecture` allowlist 数量减少 1。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

有运行环境时：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不重写 pane resize。
- 不改变默认 pane 高度比例。
- 不调整 indicator pane projection。

## Phase H3：真正迁移 SettingsModal 到 settings feature

### 修复的问题

`src/features/settings/SettingsModal.jsx` 当前只是 re-export `src/components/SettingsModal.jsx`，而实际 SettingsModal 实现仍在 components 中反向 import settings feature runtime 和 panels。

### 目标

让 SettingsModal 实现文件位于 `features/settings`，使目录结构反映真实所有权。

### 任务

- 把 `components/SettingsModal.jsx` 内容移动到 `features/settings/SettingsModal.jsx`。
- 更新相对 import，使 panels 和 `useSettingsRuntime` 使用 feature 内部路径。
- 检查是否还有代码 import `components/SettingsModal.jsx`。
- 如果无引用，删除旧文件；如果仍需兼容，则保留短 wrapper `components/SettingsModal.jsx -> features/settings/SettingsModal.jsx`，并在 README 标注删除条件。
- 不混入视觉或文案修改；如需格式化，只做机械格式化。

### 验收

- SettingsModal 的真实实现位于 `features/settings`。
- `components/SettingsModal.jsx` 不再反向 import `features/settings/*`，或被删除。
- 设置面板 tab、代理测试、交易所刷新、storage maintenance、cache limit、database tools 行为不变。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

有运行环境时：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不改设置项布局。
- 不把 mock、本地 only、真实 backend endpoint 的语义混在一起。
- 不重写 settings runtime。

## Phase H4：真正迁移 IndicatorPanel 和 IndicatorEditor

### 修复的问题

`features/indicators/IndicatorPanel.jsx` 和 `features/indicators/IndicatorEditor.jsx` 当前仍是 wrapper，真实实现还在 components 中。

### 目标

让 indicator UI 实现归入 `features/indicators`，减少 components 与 indicators feature 的双向纠缠。

### 前置条件

建议先完成 Phase H1，确保 IndicatorPanel 已不直接 import service。

### 任务

- 把 `components/IndicatorPanel.jsx` 移到 `features/indicators/IndicatorPanel.jsx`。
- 把 `components/IndicatorEditor.jsx` 移到 `features/indicators/IndicatorEditor.jsx`。
- 更新 imports：IndicatorPanel 内部引用 IndicatorEditor 应改为 feature 内部路径。
- 检查 lazy loader、wrapper、旧组件引用。
- 如果无旧路径引用，删除 components 下旧文件；否则保留短期 wrapper 并标注删除条件。

### 验收

- indicator panel/editor 的真实实现位于 `features/indicators`。
- components 不再反向 import indicators runtime。
- 添加、删除、隐藏、参数更新、脚本编辑、手动 recompute 行为不变。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

有后端时：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

### 不做

- 不改变 indicator output format。
- 不重写 editor。
- 不改变 custom indicator backend API。

## Phase H5：收窄 AppShell 字段级投影

### 修复的问题

`src/app/AppShell.jsx` 虽然不是业务 runtime，但仍拆解大量 feature 字段，再组装成 `TopBar`、`ChartWorkspace`、`LazyFeatureSurfaces`、`StatusBar` props。它承担了较多页面级投影细节。

### 目标

让 AppShell 保持页面装配角色，但把复杂 props projection 移到纯 builder/helper 中，使 JSX 更接近稳定 Shell contract。

### 建议结构

```text
src/app/
  appShellViewModel.js
```

### 任务

- 新增纯函数 `buildTopBarModel`、`buildWorkspaceModel`、`buildLazySurfaceModel`、`buildStatusBarModel`。
- AppShell 只调用 builder 并传给子组件。
- builder 不做 side effect，不访问 `localStorage`、fetch、WebSocket 或 chart refs。
- 保持 `ChartWorkspace`、`TopBar`、`LazyFeatureSurfaces` 的外部行为不变。

### 验收

- AppShell JSX 明显减少字段级拆解。
- feature view/action/status contract 不被打散到更多文件。
- lazy loading 行为不变。
- 首屏 bundle 不明显变大。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

有运行环境时：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
```

### 不做

- 不新增全局状态库。
- 不改 UI 布局。
- 不一次性重写 ChartWorkspace。

## Phase H6：推进 chart-adapter 边界

### 修复的问题

`src/components/ChartPane.jsx` 仍直接 import `lightweight-charts`。这是当前风险最高、影响面最大的剩余边界债。

### 目标

逐步让 Lightweight Charts 原始对象只暴露在 chart rendering/adapter 边界内，让 drawing 和业务 feature 依赖稳定 adapter contract。

### 前置条件

- Phase H1-H5 已完成或至少 allowlist 已减少到只剩 chart adapter 相关项。
- drawing smoke 能稳定运行。

### 任务

- 已删除无运行时引用的 legacy single-pane `ChartWidget.jsx`；后续聚焦当前 multi-pane renderer。
- 扩展 `chart-adapter/chartInstanceBridge.js`，把 drawing/export/visible range 所需 imperative API 明确命名并文档化。
- 减少 drawing runtime 对松散 `chartWidgetRef.current?.method` 的依赖，改为 adapter contract。
- 保留 `ChartPane` / `MultiPaneChart` 对实际 chart lifecycle 的所有权，避免把 chart 创建逻辑上移到 App。
- 最后删除 `chart-adapter-lightweight-import` allowlist entry。

### 验收

- 新业务 feature 不再接触 raw Lightweight Charts refs、series、primitive 生命周期。
- drawing、crosshair、visible range restore、pane resize、export 行为不变。
- `check:architecture` allowlist 最终清零，或只保留有明确删除条件的新迁移项。

### 验证

```powershell
npm --prefix frontend run check:architecture
npm --prefix frontend run lint
npm --prefix frontend run build
```

有运行环境时必须跑：

```powershell
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/
npm --prefix frontend run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不更换图表库。
- 不把 Lightweight Charts 生命周期迁入 App。
- 不重写整个 chart rendering。

## 推荐提交顺序

1. `refactor(frontend): move indicator custom actions behind runtime`
2. `refactor(frontend): move pane layout storage out of chart component`
3. `refactor(frontend): move settings modal into settings feature`
4. `refactor(frontend): move indicator panel into indicators feature`
5. `refactor(frontend): simplify app shell view projections`
6. `refactor(frontend): tighten chart adapter boundary`

## 每阶段完成前检查

- 是否减少了一个真实 allowlist 或 compatibility wrapper。
- 是否没有新增组件层 service/storage/WebSocket 访问。
- 是否没有把 feature 业务规则迁入 `app`、`shared` 或 `chart-adapter`。
- 是否没有扩大 AppShell 的字段级业务理解。
- 是否保留 lazy loading 和首屏 K 线优先策略。
- 是否运行了 `check:architecture`、`lint`、`build`。

## 停止条件

出现以下情况时，停止继续推进并重新评估：

- 清 allowlist 需要大规模重写 chart rendering。
- AppShell helper 开始拥有业务 side effect。
- IndicatorPanel 迁移后 custom indicator save/delete 行为变化。
- Pane height storage 移出后刷新不能恢复布局。
- Chart adapter 收口导致 drawing、crosshair、visible range 或 export 任一核心流程退化。
- 为了消除 wrapper 引入大量 re-export barrel，导致依赖路径更难判断。

## 完成定义

本硬化计划完成后，应满足：

- `scripts/check-architecture.mjs` allowlist 清零，或只剩极少数带明确删除条件的 chart rendering 迁移项。
- `src/components` 不再保存 feature-owned modal/panel 的主要实现。
- `AppShell` 只做页面装配和纯 view model 投影，不承担业务协调。
- 组件层不直接访问 service、WebSocket 或 feature-owned localStorage。
- chart/drawing/export 之间通过明确 adapter/runtime action 协作，而不是依赖 App 或松散 refs 知道内部细节。

这一步完成后，前端架构才从“主体合理”进入“边界硬化完成”的状态。