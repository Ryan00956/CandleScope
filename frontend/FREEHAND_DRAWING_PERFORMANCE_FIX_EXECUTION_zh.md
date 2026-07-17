# 画笔工具缩放卡顿修复执行文档

状态：历史参考，已被
[绘图引擎 V2 丝滑重构执行文档](DRAWING_ENGINE_V2_REBUILD_EXECUTION_zh.md)
取代。本文保留早期坐标热点的根因记录，不再作为当前实施顺序；其中旧 JavaScript
路径、5173 端口、把 composite primitive 视为可选 Phase 6 等内容已经过时。

目标：修复画笔/荧光笔绘制后缩放、平移明显卡顿的问题，重点消除每帧每个画笔点调用 `series.data()` 导致的整份 K 线数据复制。

## 背景

当前画笔工具通过 `FreehandDrawingPrimitive` 作为独立 `ISeriesPrimitive` 挂到主 K 线 series 上。缩放或平移时，`lightweight-charts` 会刷新 primitive：

```text
SeriesPrimitiveWrapper._internal_updateAllViews()
  -> FreehandDrawingPrimitive.updateAllViews()
  -> FreehandPaneView.update()
  -> 每个 dataPoint 调 dataPointToCoordinate(...)
```

当前画笔点主要保存为 `{ time, price }`。为了支持亚 K 线精度，交互层会把鼠标位置转换成连续时间：

```text
snappedTime + ratio * (neighborTime - snappedTime)
```

这个 `time` 往往不是已有 K 线的精确时间。

## 已确认根因

核心瓶颈在 `frontend/src/chart-adapter/coordinateBridge.js`：

1. `dataPointToCoordinate(...)` 优先调用 `timeScale.timeToCoordinate(dataPoint.time)`。
2. `lightweight-charts@5.1.0` 的 `timeToCoordinate(time)` 内部使用 `timeToIndex(time, false)`。
3. 非精确 bar time 会返回 `null`。
4. 当前代码随后进入 `timeToCoordinateInterpolated(...)`。
5. `timeToCoordinateInterpolated(...)` 每次都会调用 `series.data()`。
6. 库源码中 `series.data()` 是 `rows.map((row) => seriesCreator(row))`，每次都会新建整份数据数组和每根 K 线对象。

因此缩放/平移时的成本不是单纯画线点数，而是：

```text
每帧成本 ~= 所有画笔点数 * K线数量 * 对象分配
```

例如 5 条画笔、每条 50 点、1500 根 K 线，会接近每帧 `5 * 50 * 1500 = 375000` 个 row 映射对象级别的分配压力。

已有 RDP 抽稀只发生在 `handleMouseUp`，只能减少部分点数，不能移除 `series.data()` 的每点全量复制，因此不是根修复。

## 修复原则

- 坐标转换热路径不能每点调用 `series.data()`。
- 画笔点可以保存 fractional `logical`，但当同一个点同时有 `time` 和 `logical` 时，渲染必须优先使用 `time`。
- `logical` 只能作为缺少 `time` 或 time 转换失败后的兜底，因为 logical 是当前数据集的位置索引，会随切周期、左侧加载历史、gap 回补而改变含义。
- 插值 `time` 兜底必须缓存 `series.data()`，不能每点调用。
- 修复应优先覆盖 `freehand` 和 `highlighter`，不要顺手大改所有 drawing primitive。
- 不改变画笔视觉效果、存储 key、工具栏行为和导出行为。

## Phase 0：建立性能观测基线

目标：先证明当前慢路径存在，并给修复后验收提供数字。

建议任务：

- 在测试或临时调试脚本中 mock `chart/series`，确认：
  - 精确 `time` 点不调用 `series.data()`。
  - 插值 `time` 点会调用 `series.data()`。
  - `logical` 点不调用 `series.data()`。
- 在浏览器运行态加临时计数，统计缩放/平移期间：
  - `series.data()` 调用次数。
  - `FreehandPaneView.update()` 次数。
  - 画笔总点数。
- 计数只用于验证，不应长期污染生产控制台。

验收：

- 可以复现插值 `time` 每点触发一次 `series.data()`。
- 记录一个修复前场景，例如 5 条画笔、每条约 50 点、1500 bars。

## Phase 1：新画笔点同时保存 `logical`

目标：让新创建的画笔点具备快路径坐标。

涉及文件：

- `frontend/src/features/drawings/drawingInteractionController.js`
- `frontend/src/features/drawings/drawingPersistence.js`
- `frontend/src/features/drawings/drawingPrimitiveFactory.js`

建议改动：

- `screenToData(x, y)` 已经能算出 `fracLogical`。
- 当前成功得到插值 `time` 时返回 `{ time, price }`，应改为至少返回：

```js
{ time, logical: fracLogical, price }
```

- 未来空白区或无法取 time 时继续返回：

```js
{ time: null, logical: fracLogical, price }
```

- `serializeDataPoint(...)` 当前已经支持保存 `logical`，确认不会被后续 factory 丢弃。
- 新建 `freehand/highlighter` 的第一点和后续 `addPoint(...)` 都应得到 `logical`。

验收：

- 新画笔 localStorage 中的每个点包含 `logical`。
- 画笔在 K 线之间仍保持亚 K 线位置精度。
- 未来空白区行为不回退。

## Phase 2：坐标转换保持 `time` 优先，`logical` 仅兜底

目标：修复性能瓶颈时不破坏画笔跨周期、左侧加载历史后的横向位置正确性。

关键约束：

- `time` 是画笔锚点的稳定横向语义。
- `logical` 是当前数据集中的位置索引，不是绝对坐标。
- 切换周期时，同一个 logical index 对应的时间会变化。
- 左侧加载历史或 gap 回补 prepend 数据时，已有 bar 的 logical index 会整体右移。
- 因此不能让 stale `logical` 压过同一点上的 `time`。

涉及文件：

- `frontend/src/chart-adapter/coordinateBridge.js`

建议改动：

- 在 `dataPointToCoordinate(...)` 中保持优先级：
  1. `barOffsetFromLast`
  2. exact/interpolated `time`
  3. finite `logical`

目标逻辑：

```js
if (isFiniteNumber(dataPoint.barOffsetFromLast)) {
  ...
}

if (dataPoint.time != null) {
  ...
}

if (isFiniteNumber(dataPoint.logical)) {
  const x = logicalToCoordinateInterpolated(timeScale, dataPoint.logical);
  if (isFiniteNumber(x)) return x;
}
```

注意：

- 这里不要直接调用 `timeScale.logicalToCoordinate(dataPoint.logical)`，因为小数 logical 需要 `logicalToCoordinateInterpolated(...)`。
- 新画笔即使保存了 `logical`，正常渲染也应由 `time` 决定位置；`logical` 是兜底字段。

验收：

- mock 测试中 `{ time: 1090, logical: staleLogical, price }` 必须使用 `time` 插值得到的坐标，而不是 stale logical 坐标。
- `{ time: 1090, price }` 仍能被渲染，并且同一轮 update 中多点共享 `series.data()` 缓存。

## Phase 3：为旧数据添加每帧缓存兜底

目标：旧 localStorage 中只保存 `{ time, price }` 的画笔也不要灾难性卡顿。

涉及文件：

- `frontend/src/chart-adapter/coordinateBridge.js`
- `frontend/src/features/drawings/primitives/FreehandDrawingPrimitive.js`

建议改动方向：

- 新增可选上下文参数，允许同一轮 update 复用 series data：

```js
dataPointToCoordinate(chart, series, dataPoint, context)
timeToCoordinateInterpolated(chart, series, timestamp, context)
```

- `context.seriesData` 第一次需要时才调用 `series.data()`，后续点复用。
- `FreehandPaneView.update()` 每次 update 创建一个局部 context，传给所有点：

```js
const coordinateContext = {};
for (const dp of source._dataPoints) {
  const x = dataPointToCoordinate(chart, series, dp, coordinateContext);
  ...
}
```

- 不要把缓存做成跨帧全局缓存，除非同时订阅 data changed 并处理失效。最小安全方案是每次 `update()` 一个局部缓存。

验收：

- 旧画笔只有插值 `time` 时，每条画笔每帧最多调用一次 `series.data()`，不是每点一次。
- 新画笔同时保存 `time + logical` 时，也应优先走 `time`；如果 `time` 需要插值，每条画笔每帧最多调用一次 `series.data()`。

## Phase 4：补测试

目标：锁住这次性能修复的关键行为，避免后续改回慢路径。

涉及文件：

- `frontend/src/features/drawings/__tests__/coordinateBridge.test.js`
- 可选新增 `FreehandDrawingPrimitive` 相关测试

建议测试：

- `dataPointToCoordinate` 对 `{ logical: 1.5 }` 不调用 `series.data()`。
- `dataPointToCoordinate` 对 `{ time: fractional, logical: staleLogical }` 优先 time，避免切周期或 prepend 后错位。
- `dataPointToCoordinate` 对 `{ time: fractional }` 使用 context 缓存，多点转换只调用一次 `series.data()`。
- `logicalToCoordinateInterpolated` 继续保留小数 logical 精度。
- `screenToData` 或上层创建逻辑能生成包含 `logical` 的 freehand data point。

验收：

- 相关单测通过。
- 测试能在没有真实浏览器时覆盖慢路径调用次数。

## Phase 5：运行态验证

目标：确认真实图表缩放/平移不卡，并且画笔位置不漂移。

静态验证：

```powershell
cd H:\program\CandleScope\frontend
node .\node_modules\eslint\bin\eslint.js .
node .\node_modules\vite\bin\vite.js build
```

如果 `node` 被 Windows 拦截，使用 bundled Node：

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

浏览器验证：

- 启动后端和 Vite dev server。
- 打开真实 chart 页面。
- 在主 K 线图上画 5 条以上 freehand，每条尽量画曲线。
- 缩放和平移图表。
- 切换周期后检查画笔位置是否仍跟随预期。
- 刷新页面后检查 localStorage 恢复的画笔是否不卡。

建议 smoke：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

性能验收：

- 新画笔缩放/平移期间 `series.data()` 调用次数不随画笔点数增长。
- 旧画笔缩放/平移期间 `series.data()` 调用次数不随点数增长。
- 画笔多时缩放没有明显长时间停顿。

## Phase 6：可选合并 primitive

目标：如果修完坐标热路径后仍有可感知卡顿，再考虑减少 primitive 数量。

建议：

- 先不要做。
- 等 Phase 1 到 Phase 5 验收后再测。
- 如果仍卡，考虑把多条 freehand/highlighter stroke 汇总到一个 drawing-layer primitive 中渲染。

收益：

- 减少 `updateAllViews()` 和 pane view wrapper 数量。
- 可能减少 renderer 对象和数组分配。

风险：

- 选择、hover、eraser hitTest、单条 stroke 样式都会更复杂。
- 会扩大改动范围，不适合作为第一轮修复。

## 不做事项

- 不删除 RDP 抽稀。它不是根修复，但保留可以继续降低绘制点数。
- 不把 drawing 类型迁到 logical 优先。logical 只能作为缺少 time 时的兜底。
- 不改后端。
- 不改 chart 数据加载、gap recovery、indicator 渲染链路。
- 不把 localStorage schema 做破坏性迁移。

## 回滚策略

- Phase 1 可独立回滚：回滚后新画笔不再额外保存 logical。
- Phase 3 是旧数据性能兜底，若出现坐标异常，可只回滚 context 参数和缓存逻辑。
- localStorage 中新增 `logical` 是向后兼容字段，旧代码会忽略或继续使用 `time`。

## 最终验收清单

- [ ] 新画笔点保存 `logical`。
- [ ] `dataPointToCoordinate` 对 `time + logical` 点优先使用 `time`。
- [ ] 新画笔缩放/平移期间不再 per-point 调 `series.data()`。
- [ ] 旧画笔只含插值 `time` 时，`series.data()` 每帧每 primitive 最多调用一次。
- [ ] 画笔在缩放、平移、刷新、切周期后位置正确。
- [ ] freehand 和 highlighter 都验证通过。
- [ ] `coordinateBridge` 单测覆盖调用次数。
- [ ] `eslint` 和 `vite build` 通过。
