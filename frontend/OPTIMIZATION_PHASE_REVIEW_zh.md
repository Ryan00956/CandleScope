# 前端优化阶段审查

本文记录 `codex/frontend-chart-runtime` 上 Phase 1-6 优化完成后的状态。
详细执行日志仍以 [前端优化执行文档](OPTIMIZATION_EXECUTION_zh.md) 为准。

## 状态

原优化计划已经实现到 Phase 6。

| 阶段 | 结果 |
|---|---|
| 性能 instrumentation | 已完成。smoke 会输出前端 timing marks 和 chart-series render events。 |
| K 线优先调度 | 已完成。首屏 K 线 ready 不再被 hosted indicators 或后台修复阻塞。 |
| App shell 拆分 | 已完成。`App.jsx` 是组合根，shell components 拥有顶层 UI 布局。 |
| Drawing engine 边界 | 已完成。只有存在 saved drawings 或 active tools 时，才通过 `DrawingEngineHost` 加载真实绘图引擎。 |
| Chart rendering update cost | 部分完成。Candles、barcolor overlays 和 indicator lines 已在安全场景使用保守尾部增量更新。 |
| 交互预加载 | 已完成最有价值的 lazy surfaces：symbol search 和 Settings。 |

## 当前形态

- `src/runtime` 按领域拥有 app orchestration：chart、streams、exchange、
  preferences、workflows 和 performance。
- `src/components/app-shell` 拥有顶层 layout surfaces 和 lazy UI wiring。
- `ChartPane` 仍拥有 Lightweight Charts objects 和 series lifecycle。这是有意保留的边界；
  rendering ownership 没有下沉到 runtime hooks。
- Drawing 不再把完整 drawing hook 和 primitives 强制带进首屏 chart module path。
  只有 saved drawing 或选中工具需要时，chart 才挂载 `DrawingEngineHost`。
- Lazy UI 在启动时仍保持 lazy。Symbol search 和 Settings 用 hover/focus 的意图预加载，
  让正常首屏保持较小。

## 预算快照

执行文档中记录的最近一次本地验证：

| 区域 | 最近结果 |
|---|---:|
| App main chunk | 约 148 kB minified |
| `DrawingEngineHost` lazy chunk | 约 89 kB minified |
| Settings lazy chunk | 约 82 kB minified |
| SymbolSearch lazy chunk | 约 11 kB minified |
| Smoke bars | 722 |
| Smoke failures | 0 |

主包和 lazy chunks 都在文档预算内。First chart ready 仍然受环境影响：本地后端状态、
cache 深度和 smoke polling 都会影响数值。后续应优先比较同一台机器上的趋势，
不要把单次本地结果当成通用 benchmark。

## 剩余风险

- `ChartPane` 仍然很密。现在更安全了，但后续拆内部结构仍应先有实测理由。
- 当前 lazy panel 的 smoke measurement 有 500 ms 轮询下限，所以 `~500 ms` 的打开数字更准确地说是
  “第一次轮询时已经可见”，不是精确交互延迟。
- Fills、markers、hlines 和 overlay lifecycle 还需要像 candles、indicator lines 一样做实测处理。
- pan/zoom、切换 interval、drawing selection、text editing、export preparation
  仍然需要人工或浏览器级交互覆盖。
- 性能预算已经写进文档，但还没有在 CI 中强制执行。

## 推荐下一阶段

Phase 7 先做测量质量，再继续渲染成本优化：

1. 把 lazy-surface smoke 的粗轮询改成更细的 DOM-ready 或 perf-mark wait，
   让 click-to-open timing 在 500 ms 以下也有意义。
2. 为 fills、markers、hlines 和 overlay series lifecycle 增加 render events。
3. 用这些 events 找到不必要的 full reset，再改 chart 结构。
4. 只有测量结果指向 `ChartPane` 结构本身时，再拆成 chart-owned helpers，
   例如 series managers 或 overlay controllers。
5. 当 timing collection 足够精确后，再考虑在 CI 中产出 smoke timing snapshot。

## Phase 7 进展

第一轮测量质量 checkpoint 已实现：

- Lazy-surface smoke waits 现在读取应用自己的 performance timings，不再用
  500 ms DOM 轮询推导打开延迟。
- DOM 可见性检查仍保留为产品断言。
- 本地 script 级 lint 和 production build 已通过。

下一步 Phase 7 是给 fills、markers、hlines 和 overlay series lifecycle 增加
render events，再用这些 events 判断是否需要继续拆 `ChartPane` 内部结构。

Overlay instrumentation checkpoint 现在也已实现：

- `ChartPane` 会记录 indicator series、markers、hlines、fill area series 和
  bgcolor canvas overlays 的生命周期事件。
- Smoke report 现在包含 `performanceEventSummary`，可以直接比较事件频率，不用手动扫
  原始 performance event list。
- 本轮刻意只做观测，不改变渲染策略。下一步可以根据事件频率和点数决定优化方向，
  而不是只凭源码结构判断。

第一轮基于实测的 cleanup 已减少重复 empty marker clears：

- 基线 smoke 在无 marker 数据时报告 `chart.markerSeries.clear: 37`。
- `ChartPane` 现在会记住某个 target series 已经处于 marker-empty 状态。
- 跟进 smoke 报告 `chart.markerSeries.clear: 6`，且无产品失败。
- Production preview 报告 `chart.indicatorSeries.create: 2` 和
  `chart.indicatorSeries.setData: 2`，所以 Vite dev 里额外的 `volume-vol`
  rebuild 先视为 StrictMode/dev 噪声，不作为生产热路径继续硬改。
