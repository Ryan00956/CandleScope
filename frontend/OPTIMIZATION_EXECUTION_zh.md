# 前端优化执行文档

本文把下一阶段前端优化拆成可执行、可验收的步骤。它基于当前
[前端架构](ARCHITECTURE_zh.md)：runtime hooks 已按领域放入
`src/runtime`，首屏不需要的面板已经懒加载，`vite.config.js` 已拆分
vendor chunks。

## 当前基线

继续优化前，先以这些数值作为当前参考：

| 指标 | 当前基线 |
|---|---:|
| App main chunk | Phase 1 打点后约 237 kB minified |
| React vendor chunk | 约 195 kB minified |
| Lightweight Charts vendor chunk | 约 158 kB minified |
| smoke 覆盖目标 | K 线 bars > 0、实时 WebSocket、drawing toolbar、symbol search、Settings |
| 已知剩余风险 | drawing engine 和 primitives 仍挂在活跃图表 pane 上 |

只要 main app chunk 稳定低于预算，就不要继续只围绕 chunk size 优化。
下一阶段重点应该转向可测量的 ready time、渲染成本和长期模块边界。

## 性能预算

后续改动按这些预算守门：

| 区域 | 预算 |
|---|---:|
| App main chunk | < 250 kB minified |
| 单个 lazy UI chunk | < 100 kB minified |
| 本地首屏图表 ready | 目标 < 2 s |
| 本地实时 WebSocket ready | 目标 < 3 s |
| lazy panel 首次打开 | 点击后目标 < 500 ms |

如果某个改动超过预算，要么回退，要么在文档里说明为什么这个取舍是刻意的。

## Phase 1：前端性能观测

目标：先让“哪里慢”可测量，再改调度和渲染行为。

增加轻量 mark：

- app boot start
- 首次 history 请求发出
- 首次 history 响应返回
- chart data commit
- 首次非零 bars 渲染完成
- WebSocket live ready
- 指标计算开始/结束
- lazy chunk 打开开始/结束：Settings、symbol search、watchlist、drawing
  toolbar、export、alerts、indicators

实现建议：

- 新增小模块，例如 `src/runtime/performance/perfMarks.js`。
- 浏览器支持时使用 `performance.mark()` / `performance.measure()`。
- 保持本地、无依赖。
- 本阶段不要上报 analytics。
- 扩展 `frontend/scripts/smoke.mjs`，把 timings 放进 JSON report。

验收：

- `npm run smoke -- --url http://127.0.0.1:5173/` 输出 timing 字段。
- smoke 仍然因为产品行为坏了而失败，不因为可选 timing 字段缺失而失败。
- 成功跑一次后，把 measured baseline 写回文档。

实现后的实测基线：

| 指标 | 本地 smoke 结果 |
|---|---:|
| smoke 图表 loaded gate | 2,008 ms |
| 浏览器 `chartReadyMs` mark | 546 ms |
| 浏览器 `firstBarsMs` mark | 546 ms |
| 浏览器 `wsLiveReadyMs` mark | 573 ms |
| 浏览器 latest 请求耗时 | 394 ms |
| 浏览器 history 请求耗时 | 521 ms |
| 浏览器 symbol search 打开 mark | 357 ms |
| 浏览器 Settings 打开 mark | 389 ms |
| smoke 加载 bars | 710 |

smoke gate 会比浏览器内 mark 粗一些，因为脚本按 DOM 文本轮询，并等待
“connected + live”的产品状态。本地 dev 下 React StrictMode 也可能让挂载期事件
出现两次；后续对比以 latest mark 为准，排查重复加载时再看 event list。

## Phase 2：K 线优先调度

目标：让首屏 K 线可见成为第一优先级。指标和后台修复可以晚到，但主图不能等它们。

检查路径：

- `useChartInitialLoad`
- `useKlineStreamRuntime`
- `useIndicators`
- `useChartBackgroundPrefetch`
- `useChartGapRecovery`
- visible range 和 left-load retry 行为

规则：

- 首屏 loading 只归主 K 线数据所有。
- 指标 pane 不能让主图 loading 一直不结束。
- 首批 bars 到达后的指标重算，React 支持时用非紧急调度，例如
  `startTransition`。
- 前端只选择语义 endpoint，例如 `/history`、`/range`、`/history/before`、
  `/latest`；后端负责 raw priority 和 scheduling。
- backfill、prefetch、repair 的 UI 要表达“正在等待后台完成”，不要伪装成
  HTTP 请求仍在阻塞。

验收：

- 开启指标时，smoke timing 显示 `firstBarsMs` 早于指标完成时间。
- 关闭指标不会改变 K 线 loading 控制流。
- 左拖加载历史仍保留现有 `backfill_completed` retry 行为。

Phase 2 实现后说明：

- hosted indicator 订阅现在等待 `chartDataMeta.status === "ready"`，不再从
  quick-latest 的 provisional bars 立刻启动。
- 本地指标结果写入使用 `startTransition`；provisional 首批 bars 的重算会延迟，
  让短时间内返回的完整 history 优先。
- background prefetch 和周期性 gap recovery 等 active chart ready 后再启动；
  左拖加载和 `backfill_completed` retry 行为保持不变。
- smoke 会在临时浏览器 profile 里种一个 MA 指标，用来验证“开启指标”的路径。

Phase 2 实测基线：

| 指标 | 本地 smoke 结果 |
|---|---:|
| smoke 图表 loaded gate | 1,005 ms |
| 浏览器 `firstBarsMs` mark | 242 ms |
| 浏览器 `chartReadyMs` mark | 242 ms |
| 浏览器 `wsLiveReadyMs` mark | 268 ms |
| 浏览器 hosted indicator open mark | 352 ms |
| 浏览器 hosted indicator snapshot mark | 4,751 ms |
| smoke 加载 bars | 722 |

## Phase 3：App Shell 拆分

目标：让 `App.jsx` 保持组合根，而不是大段 JSX 的所有者。

拆出：

- `TopBar`
- `ChartWorkspace`
- `LazySurfaces`
- `StatusBar`

规则：

- 不为了缩短文件而移动数据所有权。
- props 要显式，并尽量按行为命名。
- runtime hooks 仍放在 `src/runtime`；UI 组件仍放在 `src/components`。
- 除非出现明确 prop-drilling 问题，否则不要创建一个“什么都塞进去”的大 Context。

验收：

- `App.jsx` 主要负责把 runtime hooks 接到 shell components。
- smoke 行为不变。
- 文件拆分让所有权更清楚，而不是只让文件更短。

Phase 3 实现后说明：

- 新增 `components/app-shell/TopBar.jsx`、`ChartWorkspace.jsx`、
  `LazySurfaces.jsx` 和 `StatusBar.jsx`。
- `App.jsx` 仍然拥有 runtime hooks、refs、callbacks 和数据派生；shell 组件只接收
  明确的 UI / 行为 props。
- lazy 面板仍从 shell 层懒加载；图表数据所有权和后端 endpoint 选择仍留在
  `App.jsx` 与 runtime hooks。
- 拆分后 build 基线：app main chunk 约 240 kB minified，仍低于 250 kB 预算。

## Phase 4：Drawing Engine 设计

目标：判断 drawing engine 能否按需加载，同时不破坏图表交互。

不要直接开改。先写一份短设计，回答：

- `ChartPane` 可以依赖的最小 no-op drawing adapter 是什么？
- real drawing engine 什么时候加载？
- 加载 real engine 前，如何判断是否存在已保存 drawings？
- text editing、selection、style sync、hide/show、clear、export 怎么处理？
- sub-pane drawing key 和 main-pane drawing key 如何区分？
- 用户激活 drawing tool 但 engine 还在加载时，界面应该怎么表现？

候选接口：

```txt
ChartPane
  -> DrawingController
      -> noop drawing controller
      -> lazy real drawing controller
```

高风险区域：

- `useDrawing.js`
- `components/primitives/*`
- `ChartPane` imperative handle
- export preparation 和 text-edit commit
- persisted drawing restore

设计验收：

- no-op controller 能覆盖当前 `ChartPane` contract。
- 设计列出当前 `useDrawing` 的所有返回值，并映射到 no-op、loading 或
  real-engine 行为。
- 实现前先扩展 smoke 覆盖。

实现验收，如果批准进入实现：

- 保存过的 drawings 不回归。
- 激活 drawing toolbar 会加载 real engine，并保持当前选中工具状态。
- 导出前仍会 commit text editing。
- 主图 pan/zoom 仍顺滑。

Phase 4 设计记录：

- 新增 [DRAWING_ENGINE_LAZY_LOAD_DESIGN_zh.md](DRAWING_ENGINE_LAZY_LOAD_DESIGN_zh.md)。
- 当前 `ChartPane` 直接 import `useDrawing`，会把完整绘图 hook 和 primitive 类
  带入活动图表模块图。
- 方向是先建立 `DrawingController` 边界，提供空实现、加载中、完整引擎三种
  状态。controller 必须保留现有 `useDrawing` 的完整返回形状，避免破坏
  `ChartPane` 和 `MultiPaneChart` 的合同。
- 实现应先增加只读 storage 的 `hasSavedDrawings()` helper，并在切分 primitive
  chunk 前补上工具激活、保存绘图恢复、导出文本提交的 smoke 覆盖。

Phase 4 实现前 smoke 覆盖：

- `DrawingToolbar` 暴露稳定的 `data-drawing-tool` 和 `data-drawing-action`
  选择器，供 smoke 和后续 lazy-load 检查使用。
- `scripts/smoke.mjs --drawing-check` 会激活线段工具、在主图绘制、验证绘图
  持久化、刷新页面，并验证保存的绘图数据仍存在。
- 本地 `--drawing-check` 结果：chart gate 1,002 ms，线段工具已激活，
  persisted drawings 1，restored drawings 1，无网络失败。

Phase 4 预检后的实现 checkpoint：

- 在 `drawingStorage.js` 增加只读 storage 的 `hasSavedDrawings()`。
- 新增 `useDrawingController`，作为 `ChartPane` 的绘图 adapter 边界。
- `ChartPane` 现在先计算单一 pane drawing key，再传入 controller，保留上面
  文档里的主图 / 子窗格 key 区分。

Phase 4 lazy split 后实现说明：

- 新增 `DrawingEngineHost`，由它拥有真实 `useDrawing` hook 和文本 overlay
  渲染。`ChartPane` 只在存在已保存绘图，或 active drawing tool 需要真实引擎时
  挂载它。
- 真实引擎未挂载时，`ChartPane` 保留 hide drawings、clear、选中样式更新、
  export preparation 的 no-op imperative 行为。
- split 后 build 结果：app main chunk 约 146 kB minified；
  `DrawingEngineHost` lazy chunk 约 89 kB minified，均在预算内。
- lazy split 后本地 `--drawing-check`：drawing engine ready true，line tool
  active true，persisted drawings 1，restored drawings 1，failures 0。

## Phase 5：图表渲染更新成本

目标：降低数据到达后的运行时渲染成本。

排查：

- K 线更新是否在可以 `update()` 时仍全量 `setData()`。
- `buildRenderableChartData` 是否因无关状态变化反复运行。
- `mainOverlayLines`、`subPanes`、fills、markers、hlines 引用是否稳定。
- visible-range restore 是否导致不必要的 chart reset。
- indicator line update 是否不必要地重建 series。

规则：

- 优先做可测量的优化，不做猜测式 memoization。
- 不要用 memoization 掩盖真实数据新鲜度 bug。
- Lightweight Charts 所有权仍留在 chart components，不下沉到 runtime hooks。

验收：

- smoke 通过。
- 手动 pan/zoom 和切换 interval 稳定。
- 性能报告显示 chart update 时间下降，或全量 reset 次数减少。

Phase 5 第一轮实现说明：

- 新增 chart render perf events：`chart.candleSeries.setData`、
  `chart.candleSeries.update`、`chart.indicatorSeries.setData` 和
  `chart.indicatorSeries.update`。
- 主 K 线链路原本已经在正常尾部变化时使用 `update()`；现在会记录每次渲染是
  full replace 还是 trailing update。
- 指标线新增保守的 trailing-update 快路径。只有稳定历史点完全不变，且变化只
  发生在最后一点或新增一点时，才调用 `series.update()`。参数重算、历史变化、
  中间数据变化仍继续走 `setData()`。
- 本地 smoke 结果：bars 721，connected true，live true，failures 0，
  chartReadyMs 305，firstBarsMs 305。series event counts：candle `setData` 2，
  candle `update` 3，indicator `setData` 1。
- `ChartPane` 改动后本地 `--drawing-check` 也通过：drawing engine ready true，
  persisted drawings 1，restored drawings 1，failures 0。

Phase 5 barcolor 轮次实现说明：

- barcolor overlay 现在会保存上一份 colored candle data；当已着色历史稳定时，
  使用保守的尾部 `update()`。首次应用、清空、历史变化、或中间 K 线颜色/数值
  变化仍继续使用 `setData()`。
- 本地 smoke 结果：bars 722，connected true，live true，failures 0，
  chartReadyMs 793，firstBarsMs 793。series event counts：candle `setData` 2，
  candle `update` 2，indicator `setData` 5，indicator `update` 7。
- 本地 `--drawing-check` 仍通过：drawing engine ready true，persisted drawings 1，
  restored drawings 1，failures 0。

## Phase 6：交互预加载

目标：只有用户真的感到首次点击延迟时，才处理 lazy UI 的 first-click cost。

候选：

- hover/focus `#symbol-selector` 时 preload symbol search。
- hover/focus settings button 时 preload Settings。
- 如果当前网络/cache profile 下明显可感知，可在 first bars 后 idle preload
  drawing toolbar。

规则：

- 不要启动时 preload 所有 lazy chunks。
- 优先使用意图信号：hover、focus、keyboard shortcut，或 first bars 后 idle。
- smoke 仍要能证明 lazy surface 可以打开。

验收：

- lazy panel first-open time 下降。
- first chart ready time 不回退。

Phase 6 实现后说明：

- 新增共享 lazy surface loaders，让 Settings、Indicator Panel 和 Alerts 的
  `React.lazy()` 与交互预加载复用同一组 dynamic import 函数。
- `#symbol-selector` 与 settings button 现在会在 pointer hover、mouse hover
  和 focus 时预加载对应 lazy chunk。预加载仍由用户意图触发，不会把这些面板重新放回
  首屏启动路径。
- smoke 现在会先触发同样的意图事件，再测量 symbol search 和 Settings 的 click-to-open
  路径。这样测试覆盖的是实际交互路径，而不是每次都测冷启动 lazy import。
- 本轮预加载后的本地验证：app main chunk 约 148 kB minified，
  `DrawingEngineHost` lazy chunk 约 89 kB，Settings lazy chunk 约 82 kB，
  SymbolSearch lazy chunk 约 11 kB。smoke 通过：bars 722，connected true，
  live true，failures 0，chartReadyMs 2,580，firstBarsMs 2,580，
  symbolSearchOpenMs 506，settingsOpenMs 521。

## Phase 7：测量质量和 Overlay 渲染

目标：先让下一轮优化能测到 500 ms 粗轮询以下的差异，再继续用证据推进图表渲染优化。

第一 checkpoint：

- 把 lazy-surface smoke timing 从依赖 500 ms DOM 轮询，改成等待应用自己的
  performance marks。
- DOM 可见性检查仍作为产品断言保留，但 timing 使用浏览器 performance report 里的
  `settingsOpenMs`、`symbolSearchOpenMs` 和 `drawingToolbarReadyMs`。
- hosted-indicator wait 继续使用原来的慢轮询；那条路径等的是 backend/runtime 工作，
  不是 500 ms 以下的 UI 交互。

测量 checkpoint 验收：

- smoke script 级别 lint 通过。
- build 仍在现有 chunk budgets 内。
- 当 backend 和 Vite 可用时，smoke 输出的 lazy-surface timings 可以低于 500 ms。

Phase 7 测量 checkpoint 实现后说明：

- `scripts/smoke.mjs` 现在支持给 `waitForPerfTiming()` 配置轮询间隔，并新增
  `waitForExpression()` 处理 DOM 断言。
- Settings、symbol search 和 drawing toolbar readiness 优先使用 perf-report timing，
  同时保留 DOM 检查来捕获产品行为损坏。
- 本地验证：smoke script eslint 通过；Vite build 通过，app main chunk 约
  148 kB minified。因为 `127.0.0.1:5173` 上的 Vite 和 `127.0.0.1:8000`
  上的后端都未运行，本轮没有跑端到端 smoke。

第二 checkpoint：

- 给 candles 和 indicator lines 之外仍然不透明的 chart surfaces 增加 render events。
- 本轮只做 instrumentation，不改变 fill、marker、hline 或 background overlay 的更新策略。
  等 events 显示哪条路径真的热，再做优化。

Phase 7 overlay instrumentation 实现后说明：

- `ChartPane` 现在会记录 indicator series create/remove、marker set/clear、
  hline create/remove、fill-series create/remove，以及 bgcolor canvas overlay
  create/remove/render 生命周期事件。
- event details 包含 pane id、定义数量、创建/删除的 series 数、marker 数、fill 点数，
  以及可见 bgcolor region 数。
- `scripts/smoke.mjs` 现在会输出 `performanceEventSummary`，包含全部 event counts
  和 chart-only event counts，同时保留原始 performance report 方便深入检查。
- 本地验证：`eslint src/components/ChartPane.jsx` 通过；Vite build 通过，app main chunk
  约 149 kB minified。因为本地 backend/Vite 服务未运行，本轮没有跑端到端 smoke。

event summary 后的实测跟进：

- 新 event summary 的基线 smoke 显示，在无 marker 的 MA/VOL 场景里
  `chart.markerSeries.clear: 37`。重复调用来自 marker effects 在 indicator data
  和布局状态变化时反复清理已经为空的 target。
- `ChartPane` 现在会按 target series 缓存 empty marker 状态；如果同一个 target
  已经是 empty，就跳过重复的 `setMarkers([])`。
- 跟进 smoke 通过：`chart.markerSeries.clear: 6`，
  `chart.indicatorSeries.create: 3`，`chart.indicatorSeries.setData: 3`，
  `chart.indicatorSeries.update: 1`。app main chunk 仍在预算内，约 149 kB minified。
- 在 `127.0.0.1:4173` 跑 production preview smoke 后确认，dev smoke 里剩余的
  `volume-vol` 重复 rebuild 没有出现在 Vite dev StrictMode 之外。preview 结果：
  `chart.markerSeries.clear: 2`，`chart.indicatorSeries.create: 2`，
  `chart.indicatorSeries.setData: 2`，`chart.indicatorSeries.update: 1`，
  对应一条 MA line 和一条 VOL line。

Overlay-heavy smoke 场景：

- `scripts/smoke.mjs --overlay-heavy` 不改变默认 smoke 路径，只在需要更密集的
  chart-rendering fixture 时 seed MA、VOL、BOLL 和 RSI。
- 这个场景会稳定覆盖 main-pane indicator lines、volume subpane histogram、BOLL
  fill area output、RSI hlines，以及 separate-pane indicator lifecycle。
- marker fixture 暂缓，直到支持的脚本语法足够稳定；这里不为了测试而发明产品里没有的
  marker seed 行为。
- 这次 production preview 结果：bars 722，failures 0，`overlayHeavyCoverage: true`，
  snapshot ids 为 `ma`、`vol`、`boll`、`rsi`。Chart event counts 包含
  `chart.fillSeries.create: 13`、`chart.fillSeries.remove: 12`、
  `chart.hline.create: 17`、`chart.hline.remove: 16`，所以下一个有实测依据的
  渲染目标是 fill/hline lifecycle churn。

## 验证命令

常规命令：

```bash
cd frontend
npm run lint
npm run build
npm run smoke -- --url http://127.0.0.1:5173/
```

在这台 Windows Codex 环境里，如果 `npm` 或 `node` 不在 `PATH`，用 bundled
Node：

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\smoke.mjs --url http://127.0.0.1:5173/
```

跑 smoke 前需要启动后端；Windows 下如果后端日志遇到控制台编码问题：

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## 提交策略

使用小 checkpoint：

1. 只做 instrumentation
2. 只做 K-line-first scheduling
3. 只做 App shell extraction
4. 只写 drawing design document
5. drawing engine implementation，如果批准
6. rendering-cost optimizations

每个提交的总结都要写清验证结果。

## 停止条件

出现以下情况要停下来重新评估：

- chart pan/zoom 回归。
- 已保存 drawings 不能恢复。
- smoke timing 变得不稳定。
- 前端开始给后端传 raw scheduling priority。
- 某个改动只是减少源码行数，没有改善所有权、性能或验证能力。
