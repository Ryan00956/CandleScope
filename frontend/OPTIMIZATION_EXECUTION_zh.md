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
