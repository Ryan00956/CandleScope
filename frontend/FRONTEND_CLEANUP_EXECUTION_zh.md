# 前端清理执行计划

本文定义临时前端优化 worktree 的下一阶段清理步骤。这个 worktree 不是独立前端仓库，改动最终会合并回主项目 `H:\program\CandleScope`。

本阶段不要清理 `backend/`、`packages/` 或顶层全栈文档。它们是主项目上下文的一部分，除非某个合并相关任务明确需要改动，否则不要碰。

## 目标

- 继续让 `App.jsx` 只做组合根，不把所有权重新塞回去。
- 按职责降低最大前端模块的复杂度，而不是单纯追求行数减少。
- 减少 UI 组件对后端 service、storage、性能埋点系统的直接依赖。
- 后端已经提供 capability 的交易所行为，优先由后端元数据驱动。
- 保留上一轮性能优化成果。
- 每个切片都要容易合并回主 CandleScope 仓库。

## 当前基线

当前架构已经可以继续演进：

- `src/runtime` 按 chart、streams、exchange、preferences、workflows、performance 管理编排逻辑。
- `src/components/app-shell` 管理顶层布局和 lazy UI 挂载。
- `src/services` 管理 API 和 storage primitive。
- API 默认使用同源 `/api/v1`，本地开发由 Vite proxy 把 `/api` 转给后端。
- 在这台 Windows 机器上，用 Codex bundled Node 跑 `eslint .` 和 `vite build` 已通过。

后续重点是清理和边界加固，不是重新设计一套前端架构。

## 非目标

- 不把这个 worktree 改造成独立前端仓库。
- 不移除 worktree 里的 backend 或 package 目录。
- 不为了减少 props 传递而引入大型全局状态库。
- 没有实测证据前，不把 Lightweight Charts 对象所有权移出 chart components。
- 不在前端为新交易所增加本应属于后端 plugin capability 的硬编码策略。

## Phase 1：拆分 SettingsModal

目标：让 `SettingsModal.jsx` 变成设置弹窗外壳，具体设置项拆到小面板。

建议拆分：

| 新单元 | 所有权 |
|---|---|
| `SettingsModal.jsx` | 弹窗框架、tab 状态、关闭行为 |
| `settings/ProxySettingsPanel.jsx` | 代理模式、自定义代理、代理测试 |
| `settings/ExchangeDataPanel.jsx` | 交易所元数据刷新和状态 |
| `settings/StorageMaintenancePanel.jsx` | repair 和 gap-scan 操作 |
| `settings/CacheLimitsPanel.jsx` | 缓存限制控制 |
| `settings/ChartAppearancePanel.jsx` | 主题、颜色、时区、图表显示 |
| `runtime/preferences/useSettingsActions.js` | 后端支持的 settings action |

规则：

- 保持当前视觉布局和交互不变。
- 能迁出的后端调用尽量不要留在展示面板里。
- mock 或本地-only 的维护流程要命名清楚；没验证真实 endpoint 前，不要包装成后端能力。
- 优先传小而明确的 props，不传一个巨大的 `settingsContext`。

验收：

- Settings 仍然通过 lazy surface 打开。
- 代理测试、交易所刷新、存储修复/gap scan、缓存限制同步保持现有行为。
- `SettingsModal.jsx` 不再独自拥有所有设置表单和后端 action。
- `eslint .` 和 `vite build` 通过。

第一轮实现 checkpoint：

- 新增 `settings/ChartAppearancePanel.jsx`、`settings/ProxySettingsPanel.jsx`
  和 `settings/ExchangeSettingsPanel.jsx`。
- 新增 `runtime/preferences/useProxySettingsRuntime.js` 和
  `runtime/exchange/useExchangeSettingsRuntime.js`。
- `SettingsModal.jsx` 现在保留分类外壳，以及尚未拆分的 data、database、about
  区域；proxy 和 exchange 的后端 action 已迁到 runtime hook。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

data 区域拆分 checkpoint：

- 新增 `settings/CacheLimitsPanel.jsx`、`settings/StorageMaintenancePanel.jsx`
  和 `settings/AboutSettingsPanel.jsx`。
- 新增 `runtime/preferences/useSettingsMaintenanceRuntime.js`，管理 storage
  repair、gap scan 和交易对刷新 action。
- `SettingsModal.jsx` 不再直接 import settings 后端 action service 或 symbol
  parsing helper；现在主要负责挂载聚焦面板、分类状态和弹窗外壳。
- `SettingsModal.jsx` 从 Phase 1 开始时的 2,676 行降到当前 1,713 行。剩余行数主要是弹窗样式定义和现有数据库工具面板挂载。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

## Phase 2：拆分 Indicator Runtime

目标：按职责拆开 `useIndicators.js`，同时保持现有指标体验不变。

建议拆分：

| 新单元 | 所有权 |
|---|---|
| `runtime/indicators/useActiveIndicators.js` | 本地持久化和列表变更 |
| `runtime/indicators/useIndicatorCompute.js` | 计算请求和 recompute 调度 |
| `runtime/indicators/useIndicatorSnapshots.js` | hosted snapshot 和 stream 处理 |
| `runtime/indicators/useIndicatorChartBindings.js` | chart refs、pane target、输出映射 |
| `runtime/indicators/indicatorComputeRuntime.js` | 纯 compute 输入和结果整理 |
| `runtime/indicators/indicatorPayloadRuntime.js` | payload、annotation、merge 和 signature helper |
| `runtime/indicators/indicatorPaneRuntime.js` | 纯 pane output 派生 |
| `runtime/indicators/indicatorWsRuntime.js` | hosted subscription、signature 和 range message helper |
| `runtime/chart/indicatorRangeRuntime.js` | 继续保留 range request 分块逻辑 |

规则：

- K 线 ready 不能重新被指标 ready 阻塞。
- helper 命名要区分 built-in 指标和 Pyne/custom 指标路径。
- 不把 chart series 所有权混进 service client。
- 保留 active indicators 的 localStorage 迁移行为。

验收：

- 指标新增、删除、显隐、参数更新、重新计算都正常。
- hosted indicator snapshot 仍然等 `chartDataMeta.status === "ready"` 后再进入。
- MA/VOL smoke 覆盖仍通过。
- overlay-heavy smoke 仍可用于渲染生命周期检查。

active indicator 拆分 checkpoint：

- 新增 `runtime/indicators/useActiveIndicators.js`。
- active indicator 的 localStorage 加载/保存、首次 VOL 插入，以及
  add/remove/toggle/params/script mutation 已从 `useIndicators.js` 迁出。
- `useIndicators.js` 仍然负责 compute、hosted snapshot、chart-output mapping
  和运行时结果 patch；这些路径仍保留 `setActiveIndicators`。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

payload runtime 拆分 checkpoint：

- 新增 `runtime/indicators/indicatorPayloadRuntime.js`。
- indicator error 格式化、builtin/WS-hosted 判断、payload normalize、
  annotation split、line/item merge、WS value resolve 和 point upsert helper
  已从 `useIndicators.js` 迁出。
- `useIndicators.js` 仍然负责 React state、effects、WebSocket 生命周期、
  compute scheduling 和 pane output state 更新。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

pane/signature runtime 拆分 checkpoint：

- 新增 `runtime/indicators/indicatorPaneRuntime.js`，负责纯
  `mainOverlayLines` 和 `subPanes` 派生。
- chart data signature、provisional status 判断和 script string signature
  已迁入 `indicatorPayloadRuntime.js`。
- `useIndicators.js` 现在把 pane 派生和 data signature 委托给 runtime helper，
  自身继续保留 React effect 调度。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

compute-runtime helper 拆分 checkpoint：

- 新增 `runtime/indicators/indicatorComputeRuntime.js`。
- OHLCV request shaping、VOL 颜色参数注入、本地 compute 结果汇总已迁入纯
  runtime helper。
- hosted subscription 和本地 compute 现在复用同一个 VOL 颜色参数 helper，避免两条路径漂移。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

hosted-WS helper 拆分 checkpoint：

- 新增 `runtime/indicators/indicatorWsRuntime.js`。
- visible hosted indicator 过滤、WS signature 构造、subscription message 构造、
  subscription signature 构造、range request message shaping 已从 `useIndicators.js`
  迁出。
- socket 生命周期、重连、sequence-gap resubscribe 和运行时 state patch 仍保留在
  `useIndicators.js`。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

hosted-WS message dispatch 拆分 checkpoint：

- 在 `runtime/indicators/indicatorWsRuntime.js` 新增 parse、sequence-gap state
  resolution 和 typed message dispatch helper。
- `useIndicators.js` 现在继续保留 WebSocket effect 生命周期和 timer，同时把消息
  parse、heartbeat/client 检查、snapshot/patch/update/error routing、
  sequence-gap detection 委托给 runtime helper。
- runtime state patch handler 仍留在 `useIndicators.js`，所以这一步不改变
  snapshot、patch、preview/update 或 error side effect。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

compute-scheduling helper 拆分 checkpoint：

- candle color key 构造、indicator mutation signature、VOL 是否存在判断、
  compute debounce/provisional delay 选择、series-ready compute delay 选择已迁入
  `runtime/indicators/indicatorComputeRuntime.js`。
- `useIndicators.js` 仍然负责 compute effects 和实际 `computeAll` 调用，但不再内联这些
  纯调度判断。
- 保留了原有 provisional-data performance event 语义。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

## Phase 3：清理 Drawing 所有权

目标：降低 drawing 代码体积和耦合，同时不回退保存绘图和导出准备逻辑。

建议拆分：

| 新单元 | 所有权 |
|---|---|
| `hooks/drawing/useDrawingPersistence.js` | 保存绘图的加载、保存、恢复协调 |
| `hooks/drawing/useDrawingInteraction.js` | 指针交互和 active shape 生命周期 |
| `hooks/drawing/useDrawingSelection.js` | 选择、样式同步、隐藏/显示、清空 |
| `components/drawing/DrawingToolGroup.jsx` | toolbar 工具分组 |
| `components/drawing/DrawingStyleControls.jsx` | 工具和选中对象样式控制 |

规则：

- 保持现有 `useDrawingController` 边界。
- `DrawingEngineHost` 继续 lazy，并且只在需要时挂载。
- 保留 main pane 和 sub-pane 的 drawing key 区分。
- 导出前提交正在编辑文本的行为不能变。

验收：

- 后端和 Vite 运行时，`scripts/smoke.mjs --drawing-check` 通过。
- 刷新后保存绘图仍能恢复。
- 激活绘图工具仍会加载真实 drawing engine。
- 导出准备仍会提交 active text edit。

toolbar flyout 拆分 checkpoint：

- 新增 `components/drawing/ToolFlyout.jsx`。
- shared variant flyout 渲染和 outside-click close 行为已从 `DrawingToolbar.jsx`
  迁出。
- drawing state、selected variant state、export controls、chart/runtime 集成仍保留
  在现有 toolbar 和 drawing runtime 中。
- 拆分过程中修复了编码损坏的 JSX，并把 drawing toolbar variant label 和 tooltip
  统一为 ASCII 文案。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar settings-panel 拆分 checkpoint：

- 新增 `components/drawing/FibLevelsPanel.jsx` 和
  `components/drawing/PositionSettingsPanel.jsx`。
- Fibonacci level 编辑、自定义 level 新增、默认 level 判断、position size preset
  已从 `DrawingToolbar.jsx` 迁出。
- toolbar-owned flyout state 和 drawing tool selection 仍保留在
  `DrawingToolbar.jsx`；新 panel 只负责本地表单状态和 outside-click close 行为。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar style-controls 拆分 checkpoint：

- 新增 `components/drawing/DrawingStyleControls.jsx`。
- pen/highlighter 颜色和大小控制、line/shape/fibonacci 样式控制、text
  color/font/bold/italic 控制、position-size trigger 已从 `DrawingToolbar.jsx` 迁出。
- style mutation handler 仍保留在 `DrawingToolbar.jsx`，因此 selected-drawing
  样式同步和默认 drawing 样式更新仍走现有 callback 路径。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar action-buttons 拆分 checkpoint：

- 新增 `components/drawing/DrawingActionButtons.jsx`。
- export、hide/show、clear 按钮渲染及其图标已从 `DrawingToolbar.jsx` 迁出。
- export click wrapper 仍保留在 `DrawingToolbar.jsx`，因此打开 export panel 前仍会先关闭
  当前 flyout，再委托给现有 export panel callback。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar variant-button 拆分 checkpoint：

- 新增 `components/drawing/DrawingVariantToolButton.jsx`。
- chart type、cursor、freehand、line、shape、position variant 的重复
  wrapper/button/flyout 结构已从 `DrawingToolbar.jsx` 迁出。
- click、double-click、context-menu、variant selection、flyout-open state handler
  仍保留在 `DrawingToolbar.jsx`，保持现有工具选择时序。
- Fibonacci settings 仍走 toolbar-owned 路径，因为它打开的是自定义 settings panel，
  不是普通 variant flyout。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar simple-button 拆分 checkpoint：

- 新增 `components/drawing/DrawingToolButton.jsx`。
- eraser、text、Fibonacci、snap control 的剩余简单 wrapper/button 结构已从
  `DrawingToolbar.jsx` 迁出。
- shared corner-triangle indicator 已迁入 drawing button 组件。
- Fibonacci context-menu 和 double-click handler 仍保留在 `DrawingToolbar.jsx`，
  因此自定义 settings-panel 打开行为不变。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

toolbar definitions 拆分 checkpoint：

- 新增 `components/drawing/drawingToolbarDefinitions.jsx`。
- 静态 SVG 图标、chart-type variants、drawing variant 列表和 tool-id set 已从
  `DrawingToolbar.jsx` 迁出。
- `DrawingToolbar.jsx` 现在只导入这些定义，并继续保留工具状态、点击计时、
  flyout state 和样式 mutation callback。
- 清理了本轮触碰区域里的旧乱码注释，并把 fallback label 统一成 ASCII 文案。
- 已用 bundled Node 验证：`eslint .`、`vite build` 和 `git diff --check`
  通过。

toolbar controller 拆分 checkpoint：

- 新增 `components/drawing/useDrawingToolbarController.js`。
- toolbar 自有的 variant state、flyout state、button refs、click timers、
  active-tool booleans、当前 icon/label 派生，以及 click/context-menu handler
  已从 `DrawingToolbar.jsx` 迁出。
- selected-drawing 样式 mutation 和渲染组合仍保留在 `DrawingToolbar.jsx`，
  因此默认绘图样式更新和已选绘图样式更新仍走现有 callback。
- 已用 bundled Node 验证：`eslint .`、`vite build` 和 `git diff --check`
  通过。

## Phase 4：加固组件边界

目标：在周围 runtime 已经有自然所有者的地方，让组件更接近展示层。

候选项：

- 把 symbol search 数据加载从 `SymbolSearchModal.jsx` 迁到 runtime hook。
- 把 indicator catalog/security policy 加载从 panel/editor 组件迁到 indicator runtime hook。
- 对能降低耦合的性能埋点，改成回调或小 runtime hook。
- chart components 仍然是 chart 所有者；不要为了“纯组件”盲目移除 chart 专用 helper。

验收：

- 组件继续接收明确 props，而不是一个大 app context。
- runtime module 不渲染 JSX。
- service module 仍然只是 HTTP/WebSocket/storage primitive。
- 本阶段不引入产品行为变化。

symbol catalog runtime 拆分 checkpoint：

- 新增 `runtime/exchange/useSymbolCatalogRuntime.js`。
- symbol catalog 初始加载、refresh flow、loading state、refreshing state，以及
  exchange/market/key enrichment 已从 `SymbolSearchModal.jsx` 迁出。
- `SymbolSearchModal.jsx` 仍负责本地搜索过滤、收藏、键盘/列表交互、
  context menu state 和 watchlist 渲染。
- 将 modal reset/clamp effects 改为异步调度 state change，使当前 React lint
  gate 保持干净。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

indicator catalog/security runtime 拆分 checkpoint：

- 新增 `runtime/indicators/useIndicatorCatalogRuntime.js`。
- built-in preset 加载、custom indicator 加载、catalog normalization、
  图表插入前的 full-preset resolution，以及 custom catalog upsert/remove helper
  已从 `IndicatorPanel.jsx` 迁出。
- 新增 `runtime/indicators/usePyneSecurityPolicy.js`，并把 editor security-policy
  fetch 从 `IndicatorEditor.jsx` 迁出。
- `IndicatorPanel.jsx` 仍负责 active indicator action、save/delete service
  mutation、editor navigation 和可见 UI 分组。
- catalog hook 使用 loaded ref 收住首次加载语义，避免后端返回空 preset 时重复加载。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

## Phase 5：加固 API Client

目标：让 API 层更容易取消、测试和扩展。

执行路径：

1. 扩展内部 `request()`，支持 `{ method, headers, body, signal }`。
2. 增加小型 `ApiError`，携带 `status`、`detail`、`url`。
3. 剩余手写 query string 改成 `URLSearchParams`。
4. initial history/latest 已经有 stale request 模型的地方，把 `AbortController.signal` 传进 fetch。
5. WebSocket URL builder 继续留在 service 层。

规则：

- 不改 endpoint path，不改后端调度语义。
- 不让前端分配后端 raw priority。
- 保持同源 `/api/v1` 默认值。

验收：

- stale initial load abort 后不会提交旧数据。
- settings、subscriptions、symbols、klines、indicator 调用保持现有行为。
- UI 中的错误信息仍然可读。

API request helper 加固 checkpoint：

- 在 `services/api.js` 新增 `ApiError`，携带 `status`、`detail` 和 `url`。
- 扩展内部 `request()` helper，支持 `method`、`headers`、`body` 和 `signal`，
  并对普通 request body 自动 JSON encode。
- `services/api.js` 中重复的写操作 `fetch` 块已改为复用 shared helper。
- kline、exchange-info、storage maintenance 以及 kline WebSocket URL 的 query
  construction 已收敛到 shared `URLSearchParams` helper。
- `useChartInitialLoad.js` 的 initial latest/history load 和 initial history retry
  已传入 `AbortController.signal`。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

## Phase 6：收窄 Exchange Fallback

目标：让前端 fallback 表只承担启动兜底，而不是主要交易所事实来源。

执行路径：

1. 文档明确哪些字段必须来自 `GET /api/v1/exchanges/`。
2. 后端存在 `native_intervals`、`markets`、`protocol_features`、`ws_connection_model`、`known_limitations` 时，前端优先使用它们。
3. 如果后端后续暴露默认 history window 或 pagination hint，再把 `intervalDays` 决策迁到 capability。
4. 本地 Binance/OKX interval 表只作为 capability 请求失败和首次渲染兜底。

验收：

- 新增交易所仍从后端 plugin 开始。
- 前端周期 UI 跟随后端 metadata。
- 后端 capability 请求失败时 fallback 仍稳定。

exchange fallback 收窄 checkpoint：

- `exchangeCatalogRuntime.js` 现在会记录 interval history-window days 来自后端
  capability 还是本地 fallback。
- `getIntervalDays(interval, exchange, catalog)` 现在接收后端 exchange catalog，
  并在后端提供 history-window map 时优先使用 capability 数据。
- 当前 Binance/OKX `intervalDays` 仍只作为 capability 加载失败，或后端暂未暴露
  history window 时的兜底行为。
- `App.jsx` 现在把绑定了 `exchangeCatalog` 的 `getIntervalDays` 传给 initial load、
  backfill completion、WS reconnect recovery 和 gap recovery。
- 已用 bundled Node 验证：`eslint .` 和 `vite build` 通过。

## Phase 7：合并回主项目准备

目标：让这个 worktree 可以安全合并回 `H:\program\CandleScope`。

检查清单：

- 最终验证前，从主 CandleScope 分支 rebase 或 merge 最新代码。
- 先看 `frontend/` 下 diff；除非明确需要，否则 backend/package 不应有 diff。
- 前端文档要从 `frontend/README.md` 能找到。
- 稳定架构规则变化时，中英文文档一起更新。
- 跑前端本地验证门。
- 条件允许时，在后端和 Vite 都启动后跑浏览器 smoke。

最终验证命令：

```powershell
cd H:\program\CandleScope-frontend\frontend
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

后端和 Vite 运行时：

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/ --drawing-check
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/ --overlay-heavy
```

合并前验证 checkpoint：

- 已确认本 worktree 的 diff 范围只在 `frontend/` 内。
- 已确认前端清理执行文档可从 `frontend/README.md` 找到。
- 已用 bundled Node 重新运行前端门：`eslint .`、`vite build` 和
  `git diff --check`。
- 已使用原项目 `H:\program\CandleScope` 后端和本 frontend worktree 的 Vite
  dev server 跑浏览器 smoke：基础 smoke、`--drawing-check` 和
  `--overlay-heavy` 均通过。
- `git diff --check` 只报告 Windows LF/CRLF normalization warning，没有
  whitespace error。

## Commit 策略

使用小 checkpoint：

1. Settings panel 拆分。
2. Indicator runtime 拆分。
3. Drawing 内部清理。
4. Component boundary 加固。
5. API client 加固。
6. Exchange fallback 收窄。
7. 文档和合并前验证。

每个 commit 摘要都应包含：

- 改动文件或职责区域
- 已运行的验证命令
- smoke 状态，如果可用
- 有意延后的风险

## 停止条件

出现以下情况时停下来重新评估：

- 首屏 K 线 ready 又开始等待指标或后台 repair。
- 保存绘图无法恢复。
- 图表平移/缩放或切换周期回退。
- Settings action 拆完比拆之前更难追踪。
- 前端开始复制后端 exchange plugin policy。
- 改动只是搬代码，没有改善所有权、可测试性或合并安全性。
