# 单 Chart + 原生 Panes 迁移执行文档（方案 A）

> 目标：把当前「**每个副图一个独立 `createChart` 实例** + 手动同步 logical range + 隐形对齐序列」的多实例架构，
> 迁移为 **lightweight-charts v5 的单 chart 实例 + 原生多 pane**，让所有 series 共享同一条时间轴，
> 从结构上根除「K 线 / 指标错位、缺口、刷新后久不对齐、绘图跳右」这一整类 bug。
>
> 适用版本：`lightweight-charts ^5.1.0`（已确认支持原生 panes）。
> 原则：**小步提交、每步可验证、随时可回滚**。保留此前的止血改动（删除 whitespace、坐标修复）。

---

## 0. 为什么这是「彻底」方案

当前所有错位类 bug 的共同根因：

- 主图与每个副图是**独立 chart 实例**，靠 `syncLogicalRangeAcrossPanes` 手动把 logical range 互相 `setVisibleLogicalRange`
  （`components/MultiPaneChart.jsx:142`、`:377`、`:404`）。
- 副图用一条「隐形对齐序列」`createAlignmentSeries` + `timeAlignment` 来让 time→logical 映射和主图一致
  （`chart-adapter/seriesLifecycle.js:14`、`components/ChartPane.jsx:549`）。
- 这要求**每个 pane 的时间点集合完全相同**。但蜡烛与指标数据是异步独立提交的，时间集合会瞬时发散 → 索引错位。

单 chart 多 pane 后：**只有一条 time scale**，不存在「两套时间轴需要对齐」的问题。logical 同步、对齐序列、跨 pane crosshair 透传等代码可整体删除；由多 chart 多时间轴同步导致的错位在结构上被消除。

注意：单 chart 并不自动阻止指标 series 注入主 K 线不存在的 time。迁移后仍必须把所有指标数据按主 `bars` 的时间集合裁剪，作为共享 time scale 的硬约束。

---

## 1. 改造范围（涉及文件清单）

**重写 / 大改**
- `src/components/MultiPaneChart.jsx` —— 从「N 个 ChartPane 实例 + resizer」改为「1 个 chart 容器 + 渲染多 pane」。
- `src/components/ChartPane.jsx` —— 拆解：单实例创建逻辑上移，pane 内 series 渲染逻辑保留并参数化为「按 paneIndex 渲染」。
- `src/chart-adapter/chartPaneLifecycle.js` —— 改为「单 chart 生命周期 + 按需 createPane」。
- `src/chart-adapter/seriesLifecycle.js` —— `addSeries` 增加 `paneIndex`；删除 `createAlignmentSeries`。
- `src/chart-adapter/chartImperativeHandle.js` —— 同步类方法（`syncCrosshair`、`setVisibleLogicalRange`）整体删除或退化为单 chart 版本。

**小改**
- `src/chart-adapter/chartInstanceBridge.js` —— 绘图 adapter 仍只绑定主 pane 的蜡烛 series，无需改动接口，但确认 `getSeriesData/timeToCoordinate` 指向主 series。
- `src/components/PaneResizer.jsx` —— 由 v5 原生分隔条 `layout.panes` 取代，组件删除或停用。
- `src/features/chart-session/paneLayoutStorage.js` —— 高度持久化改存「pane 像素高度 / stretch」而非 flex 百分比。

**基本不动**
- 数据层 `features/market-data/*`（`useMarketDataRuntime`、`useChartDataRuntime` 等）—— 输出 `bars`/指标投影不变。
- 指标投影 `features/indicators/indicatorPaneProjection.js` —— 仍输出 `mainOverlayLines` 与 `subPanes`，但 `subPanes` 现在映射到 paneIndex 而非独立组件。
- 绘图引擎 `features/drawings/*` —— 仍只挂主 pane；现有坐标换算主路径不变。若落地 Phase 6 的「未来锚点」修复，需要小改 `chart-adapter/coordinateBridge.js` / `drawingInteractionController.js` 以支持 `barOffsetFromLast`。

---

## 2. v5 原生 Panes API 速查（迁移依赖的全部接口）

```js
// 创建带分隔条的图（单实例）
const chart = createChart(container, {
  layout: { panes: { separatorColor, separatorHoverColor, enableResize: true } },
});

// 主 pane 蜡烛（默认 paneIndex=0）
const candle = chart.addSeries(CandlestickSeries, candleOpts);

// 副图指标：第三个参数 = paneIndex，pane 不存在则自动创建
const rsi = chart.addSeries(LineSeries, lineOpts, 1);

// 迁移 series 到别的 pane（pane 不存在则创建）
rsi.moveToPane(2);

// 取 pane 控制句柄
const panes = chart.panes();           // IPaneApi[]
panes[1].setHeight(300);               // 像素高度，最小 30px
panes[1].getHeight();
panes[1].paneIndex();
panes[1].moveTo(0);                    // 调整 pane 顺序

// 某个 pane 的价格刻度
chart.priceScale('right', 1).applyOptions({ scaleMargins: { top: 0.2, bottom: 0.2 } });

// 删除 pane（连同其中所有 series）
chart.removePane(1);
```

要点：
- **空 pane 会被自动回收**：当一个 pane 内最后一个 series 被移除，pane 自动删除。
- **原生分隔条可拖拽**：`layout.panes.enableResize: true` 即可，**不再需要 `PaneResizer`**。
- 时间轴只在最底部 pane 显示——v5 单 chart 天然如此，无需 per-pane `showTimeScale`。

---

## 3. 分阶段执行计划（每个 Phase 独立可提交、可回滚）

### Phase 0 — 基线与开关（0.5 天）

1. 确认基线可跑：`cd frontend && npm install && npm run dev`，记录当前 4 个 bug 的复现路径。
2. 跑测试与 lint 建立基线：
   ```bash
   cd frontend
   npm run lint
   node --test src/features/drawings/__tests__/coordinateBridge.test.js
   ```
3. 加一个特性开关，便于灰度与回滚（当前仓库还没有统一 feature flag 文件，可新增 `src/shared/featureFlags.js` 并导出 `SINGLE_CHART_PANES`）。
   - 在 `ChartWorkspace.jsx` 里按开关在「旧 MultiPaneChart」与「新 MultiPaneChart」之间切换。
   - 整个迁移期间老代码保持可用，直到 Phase 9 验收通过再删。

**验收**：开关 off 时行为与现在完全一致。

---

### Phase 1 — 适配层：单 chart + 按需 createPane（1 天）

目标：让 `chart-adapter` 具备「一个 chart 管理多个 pane」的能力，先不接 UI。

1. `lightweightChartSurface.js`：`createChartInstance` 的 options 增加 `layout.panes`（分隔条颜色 / `enableResize`）。
2. `seriesLifecycle.js`：
   - `createMainSeries(chart, opts)` 不变（pane 0）。
   - `createIndicatorSeries(chart, line, { paneIndex })`：把 `paneIndex` 透传给 `chart.addSeries(type, options, paneIndex)`。
   - **删除** `createAlignmentSeries`（单 chart 不再需要对齐序列）。
3. 新增 `chart-adapter/paneManager.js`（纯函数 + 句柄管理）：
   ```text
   ensurePane(chart, paneIndex)         // 优先用 chart.addPane(true) / chart.panes() 管理；不要长期保留隐藏占位 series
   setPaneHeights(chart, heightsPx[])   // chart.panes()[i].setHeight()
   removePaneSeries(chart, entries)     // 移除某 pane 的所有指标 series（pane 自动回收）
   ```

**验收**：写一个最小 demo 页（或临时 story）用单 chart 加 1 主 + 1 副 pane，能渲染、能拖动分隔条、滚动时两 pane 天然同步。

---

### Phase 2 — 抽出「单 chart 表面」组件 ChartSurface（1.5 天）

把 `ChartPane.jsx` 里「创建 chart 实例 + 主蜡烛 + 交互（autoscale 拖动、右键菜单、resize observer、crosshair→OHLC）」的部分，提升为**只创建一次**的 `ChartSurface`。

1. 新建 `src/components/ChartSurface.jsx`：
   - 持有**唯一** `chartRef`、`mainSeriesRef`。
   - 复用 `chartPaneLifecycle.js` 的事件绑定（autoscale 拖动、dblclick、contextmenu、ResizeObserver、crosshair）。
   - 不再有 `paneType`，不再有 `alignmentSeriesRef`/`drawingAnchorSeriesRef`。
   - 接入现有 `chartSurfaceContract.js` / `useChartSurfaceRuntime.js` 通道，继续提供 `getVisibleRange`、`getExportSnapshot`、`prepareExport`、`setDrawingsHidden`、`updateSelectedDrawingStyle` 等 imperative action，避免新组件绕开导出和绘图动作入口。
2. 主蜡烛数据渲染：直接搬 `ChartPane.jsx:462-545` 的 `setData/update` 逻辑（已是原始 `bars`，无 whitespace）。
3. crosshair → OHLC header：搬 `chartPaneLifecycle.js:193-210`（用 `param.seriesData.get(mainSeries)`）。

**验收**：`ChartSurface` 单独渲染主图蜡烛与现在主 pane 行为一致（缩放、autoscale、右键、crosshair 头部数值）。

---

### Phase 3 — 指标渲染按 paneIndex 注入（2 天）

把指标 series 的创建 / 更新逻辑从「每个副图组件各自渲染」改为「在同一个 chart 上按 paneIndex 渲染」。

1. 设计 pane 索引映射：
   - `paneIndex 0` = 主 pane（蜡烛 + `mainOverlayLines` 叠加线）。
   - `subPanes`（来自 `indicatorPaneProjection.js`）按顺序映射到 `paneIndex 1..N`。
   - 维护 `Map<paneKey, paneIndex>`，并在 subPanes 增删时通过 `moveToPane` / `removePane` 调整。
2. 复用 `ChartPane.jsx` 现有的指标渲染算法（`alignedIndicatorLines`、结构 key 快路径 `:671-760`、`applyLineSeriesData`、markers/fills/hlines/bgcolor 渲染器），
   但 series 创建处统一加 `paneIndex` 参数。
3. **保留** `buildTimeSetForPane`/`alignIndicatorLinesToTimes`（你已加的指标投影）——作为**第二层保险**：即使指标多算了几根，也不会往共享时间轴注入蜡烛没有的时间点。
   - 注意：单 chart 下时间轴由主蜡烛主导，但指标 series 仍可能引入新 time。务必用主 `bars` 的时间集合裁剪指标（`paneTimeSet` 改为「永远来自主 bars」，不再用 `timeAlignment`）。
4. 叠加线（main overlay）和副图线统一走同一条渲染管线，仅 `paneIndex` 不同。

**验收**：加 1 个叠加指标（如 MA）+ 1 个副图指标（如 RSI），三者时间轴完全对齐；快速切换 symbol/interval 不再出现「指标比 K 线长 / 缺口」。

---

### Phase 4 — 删除手动同步与对齐序列（0.5 天）

单 chart 后这些都成为死代码，逐个删除并验证：

- `MultiPaneChart.jsx`：`syncLogicalRangeAcrossPanes`、`handleVisibleLogicalRangeChange` 里的「sync 其他 pane」、`handleCrosshairSync`、`subPaneRefs`、那些 `setTimeout(50)` / `requestAnimationFrame` 补同步（`:257-288`）。
- `chartImperativeHandle.js`：`syncCrosshair`、`setVisibleLogicalRange`（跨 pane 用途）整体删除。
- `seriesLifecycle.js`：`createAlignmentSeries` 删除；`chartPaneLifecycle.js` 中 `alignmentSeriesRef`/`drawingAnchorSeriesRef` 相关删除。
- `ChartPane.jsx`：`timeAlignment` prop、alignment effect（`:549-563`）删除。

**验收**：crosshair 与滚动在所有 pane 间仍然同步（现在由 v5 原生保证），且代码中再无「跨 pane 同步用途」的 `setVisibleLogicalRange`、对齐序列引用。单 chart 自身用于恢复可见范围的 `setVisibleLogicalRange` 可以保留。

---

### Phase 5 — 高度与分隔条改用原生 panes（1 天）

1. 移除自定义 `PaneResizer` 与 `paneHeightPercents`/`handleResize`/`handleResizeEnd`（`MultiPaneChart.jsx:127-235,:488-511`）。
2. 改用 `layout.panes.enableResize: true` 提供拖拽分隔条。
3. 高度持久化：`paneLayoutStorage.js` 改为存每个 pane 的像素高度（或相对 stretch）。
   - 加载时：`chart.panes()[i].setHeight(px)`。
   - 用户拖动后：v5 没有现成的「resize end」事件，可在分隔条 `mouseup` 或定时 `chart.panes()` 读取高度并 debounce 保存。
4. 默认分配：主 pane 较高，副 pane 平分剩余（迁移现有「主 65% / 副均分 35%」逻辑为像素近似）。

**验收**：拖动分隔条流畅；刷新后 pane 高度恢复；增删副图指标时高度合理重排。

---

### Phase 6 — 绘图层适配（1 天）

绘图仍只作用于主 pane（蜡烛 series），核心不变，但要确认引用对象正确。

1. `chartInstanceBridge.js` 的 adapter：`seriesRef` 固定指向**主蜡烛 series**（不再有 sub pane 的 `drawingAnchorSeriesRef`）。
2. `getSeriesData()` / `timeToCoordinate()` 走主 series + 主 pane time scale —— 与单一时间轴一致，绘图坐标天然稳定。
3. 并行落实「未来锚点」根治（bug 1 的彻底解法）。这是绘图锚点语义修复，不是原生 panes 自动解决的问题：
   - 往最后一根右侧画图时，锚点存 **`{ barOffsetFromLast: 整数, price }`** 而非外推时间。
   - 渲染：`x = logicalToCoordinate(lastBarLogical + barOffsetFromLast)`。
   - 该偏移不随尾部实时数据变化 → 不再「瞬间跑到右边」。
   - 影响文件：`features/drawings/drawingInteractionController.js`（`screenToData`/`dataToScreen`）、`chart-adapter/coordinateBridge.js`（已有 `logicalToCoordinateInterpolated` 可直接用）。
4. 绘图持久化结构需兼容旧数据：旧锚点存的是 time，新增 `barOffsetFromLast` 字段；读取时若无该字段则回落 time 逻辑。

**验收**：在无 K 线的未来区域画线段/矩形/文本，实时新 bar 到来后位置**不漂移**；历史绘图（存 time）仍正确。

---

### Phase 7 — 可见范围 / 导出 / crosshair 头部（0.5 天）

1. 可见范围持久化 `visibleRangeStorage.js` + `planVisibleRangeRestore`：改为只对**唯一** time scale 操作（删除「restore 后再 sync 各 pane」）。
2. 导出快照 `getExportSnapshot`：现在是单 chart 单容器，截图范围简化为整个 wrapper；删除「主 pane + 各 sub pane 分别截」的拼接逻辑（`MultiPaneChart.jsx:342-357`）。
3. crosshair → OHLC 头部、`onNeedMoreLeft`（左侧加载）逻辑迁到唯一 time scale 的 `subscribeVisibleLogicalRangeChange`（保留 `LEFT_EDGE_TRIGGER_BARS` 触发）。

**验收**：刷新后可见范围恢复正确；导出图片包含全部 pane；拖到左边界仍触发历史加载。

---

### Phase 8 — 清理死代码（0.5 天）

- 删除：`PaneResizer.jsx`、`createAlignmentSeries`、`syncCrosshair`、跨 pane 同步、`timeAlignment` 全链路、`subPaneRefs`、per-pane `showTimeScale` 分发。
- `ChartPane.jsx` 若已被 `ChartSurface` + 指标渲染管线取代，整体删除。
- 移除特性开关里的旧分支（确认新路径稳定后）。
- 跑 `npm run lint` 清理未使用 import/变量。

---

### Phase 9 — 测试与验收（1 天）

**自动化**
```bash
cd frontend
npm run lint
node --test src/features/drawings/__tests__/coordinateBridge.test.js
npm run test:drawing
# 如新增 paneManager / 指标投影裁剪的单测，一并跑
npm run build   # 确认生产构建通过
npm run smoke -- --overlay-heavy
```

**逐 bug 手动验收用例**

| Bug | 复现操作 | 期望（修复后） |
|---|---|---|
| 1 拖到未来画图跳右 | 选线段，从最后一根右侧空白处画，等几根实时 bar | 图形锚点稳定不漂移 |
| 2 刷新后副图久不对齐 | 带副图指标的图，强刷新多次 | 主图与副图**首帧即对齐**，无「先错位后自愈」 |
| 3 K 线没出来指标先出来 | 弱网 / 限速下加载 | 指标不会先于 K 线铺满；范围一致 |
| 4 K 线巨大缺口指标连续 | 切到有缺口/休市品种 | 蜡烛与指标缺口位置一致，不再「一个断一个连」 |

**性能 / 回归**
- 大数据量（数万根）滚动、缩放流畅度对比旧版。
- 多副图（≥3）增删、切 symbol/interval、切主题、时区切换。

---

## 4. 关键风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| 重构面大 | `ChartPane`/`MultiPaneChart` 是核心组件 | 特性开关灰度，老路径保留到 Phase 9 |
| 原生 resize 事件缺失 | v5 无「resize end」回调 | 用分隔条 mouseup + debounce 读 `panes()` 高度 |
| 指标仍可能引入新 time | 单 chart 下 series time 仍并入时间轴 | 保留「指标按主 `bars` 时间集合裁剪」作为硬约束 |
| 绘图旧数据兼容 | 已存绘图用 time 锚点 | 新增 `barOffsetFromLast`，读取时回落 time |
| per-pane priceScale 选项 | autoscale / 反转 / 对数仅主 pane | 用 `chart.priceScale('right', paneIndex)` 分别配置 |

**回滚**：任一 Phase 出问题，关闭 `SINGLE_CHART_PANES` 开关即回到旧多实例路径；每个 Phase 是独立 commit，可单独 revert。

---

## 5. 建议提交粒度（每条一个 PR/commit）

1. `feat(chart): 适配层支持单 chart 多 pane（paneManager + addSeries paneIndex）`
2. `feat(chart): 抽出 ChartSurface 单实例主图`
3. `feat(chart): 指标按 paneIndex 注入并以主 bars 裁剪时间`
4. `refactor(chart): 删除手动 logical 同步与对齐序列`
5. `feat(chart): 原生 panes 分隔条与高度持久化`
6. `fix(drawing): 未来锚点改用 bar 偏移，根治跳右`
7. `chore(chart): 可见范围/导出/crosshair 迁移到单 time scale`
8. `chore(chart): 清理 PaneResizer 等死代码`

---

## 6. 完成定义（DoD）

- [x] 4 个 bug 的前端隔离验收已通过，且**不再依赖 gap-recovery 的「自愈」**。
- [x] 业务代码中不存在 `syncLogicalRangeAcrossPanes` / `createAlignmentSeries` / `timeAlignment`。
- [x] 不存在跨 pane 同步用途的 `setVisibleLogicalRange` / `syncCrosshair`；单 chart 自身的可见范围恢复 API 保留合理。
- [x] `eslint`、`vite build`、chart-adapter/drawing/market-data 单测、`smoke --overlay-heavy` 通过。
- [x] 多副图、切 symbol/interval、主题/时区切换、绘图持久化/恢复、未来绘图锚点、价格刻度右键菜单、可见范围恢复完成前端隔离验证；真实后端恢复后复跑 smoke。
- [x] 特性开关旧分支与死代码已移除。

---

## 7. 执行状态（2026-06-02）

本轮已按迁移计划完成前端侧切换：入口已固定使用 `SingleChartPanes`，不再保留多 chart 手动对齐分支；所有主图、overlay、副图指标都注入同一个 lightweight-charts v5 chart，并通过原生 `paneIndex` 分配 pane。

已完成：

- `ChartWorkspace` 已移除 `SINGLE_CHART_PANES` 特性开关判断，直接渲染 `SingleChartPanes`。
- 指标数据在写入 series 前按主 `bars` 的 time 集合裁剪，避免副图或 overlay 指标向时间轴注入未来点。
- `paneManager` 负责原生 pane 创建、高度读取/持久化和 series 清理。
- `seriesLifecycle`、`overlaySeriesRenderer` 已支持 `paneIndex`，`createAlignmentSeries` 已删除。
- 旧多实例路径已移除：`ChartPane.jsx`、`MultiPaneChart.jsx`、`PaneResizer.jsx`、`chartImperativeHandle.js`。
- 绘图未来锚点已改为 `barOffsetFromLast`，读取旧 `time` 锚点时仍保留兼容回落。
- `detectGaps` 默认只检测历史序列内部缺口，不再用 `Date.now()` 推断尾部缺口；尾部检查改为显式 opt-in。
- `SingleChartPanes` 已恢复价格刻度右键菜单：自动缩放、反转、常规/对数/百分比/基准 100。
- smoke 脚本已适配单 pane 容器，并补充绘图持久化/恢复和未来锚点存储检查。
- 新增本地 mock API/WS，用于隔离真实后端 500 时对前端迁移进行稳定验证。

验证结果：

- `eslint .`：通过。
- `vite build`：通过。
- `node --test src/chart-adapter/__tests__/*.test.js src/features/drawings/__tests__/*.test.js src/features/market-data/__tests__/*.test.js`：通过，23/23。
- `smoke --overlay-heavy`：通过，240 bars、Connected、Live，MA/VOL/BOLL/RSI snapshot 正常，fill/hline 覆盖正常。
- `smoke --overlay-heavy --drawing-check`：通过，绘图新增后持久化，未来锚点保存为 `barOffsetFromLast`，刷新后恢复 2 条。
- Browser DOM 校验：仅存在 1 个 `.chart-pane`，`data-pane-id="single-chart"`，`data-pane-type="native-panes"`。
- Browser 菜单校验：右键价格轴显示 6 个菜单项，切换“对数”后 active 标记回写到“对数”。

剩余注意：

- 本轮验证使用 mock API 隔离前端迁移风险；真实后端在此前联调中仍有 500 响应，后端恢复后应复跑同一组 smoke。
- 单 chart 自身的可见范围恢复仍会使用 time scale API；这不属于旧多 chart 跨 pane 手动同步。
