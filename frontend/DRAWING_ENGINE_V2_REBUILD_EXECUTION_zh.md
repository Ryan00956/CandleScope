# CandleScope 绘图引擎 V2 丝滑重构执行文档

状态：Phase 0、Phase 1、Phase 2 已完成（2026-07-14）；Phase 3、Phase 4、Phase 5、Phase 6、Phase 7 已完成（2026-07-15）；Phase 8 尚未开始。

本文是 CandleScope 绘图引擎 V2 的主执行文档。后续实现必须按本文阶段推进，每个阶段独立验证、独立提交、独立回滚，不允许跳过性能基线、shadow 对照或兼容迁移门。

## 1. 工作区与基线

- 独立工作树：<code>H:\program\CandleScope-frontend</code>
- 实施分支：<code>codex/frontend-drawing-engine-v2</code>
- 文档基线：<code>3067e1b54b54dd00a4a9ed77af1f4b617b232a72</code>
- 基线日期：2026-07-14
- 主工作树：<code>H:\program\CandleScope</code>
- 前端目录：<code>H:\program\CandleScope-frontend\frontend</code>

旧工作树分支 <code>codex/frontend-chart-runtime</code> 已完整合并进当前 <code>main</code>，没有独有提交。本重构分支直接从当前本地 <code>main</code> 创建，不从落后的 <code>origin/main</code> 创建。

当前本地 <code>main</code> 比 <code>origin/main</code> 领先 4 个提交。创建远端 PR 前必须先确认这 4 个基线提交已经进入远端主线，否则 PR 会把它们一起显示为重构差异。

每次开始工作前先执行：

~~~powershell
git -C "H:\program\CandleScope" status --short --branch
git -C "H:\program\CandleScope-frontend" status --short --branch
git -C "H:\program\CandleScope-frontend" rev-parse HEAD
git -C "H:\program\CandleScope" worktree list
~~~

预期：

- 主工作树仍在 <code>main</code>；
- 独立工作树仍在 <code>codex/frontend-drawing-engine-v2</code>；
- 除当前阶段明确产生的修改外，没有来源不明的工作区内容；
- 不在独立工作树切换到 <code>main</code>，因为该分支已被主工作树占用；
- 不使用 <code>reset --hard</code> 或删除旧工作树分支。

## 2. 如何执行本文

每个 Phase 固定遵守以下规则：

1. 只实现当前 Phase 的目标，不提前删除下一阶段仍需要的兼容路径。
2. 开始前记录 HEAD、基准数据和 feature mode。
3. 先补测试或 shadow 观测，再切换可见行为。
4. 至少运行当前 Phase 指定的测试，以及全局永久门禁。
5. 把性能结果保存为 JSON，不只写“感觉更流畅”。
6. 达不到退出门槛时停止推进，修复或回滚当前 Phase。
7. 每个 Phase 使用独立 checkpoint commit；大型 Phase 可以拆成 A/B，但不能跨阶段混交。
8. 文档中的勾选框只能在对应证据已产生后勾选。

进度表：

| Phase | 内容 | 当前状态 |
|---|---|---|
| 0 | 固定重负载基准与 instrumentation | 已完成（before baseline 已固化） |
| 1 | 原子坐标快照与批量 anchor resolver | 已完成（batch baseline 已固化） |
| 2 | DrawingDocumentStore、commands 与 codec | 已完成（document authoritative checkpoint） |
| 3 | Scene shadow、culling 与 render plan | 已完成（正式 shadow parity/perf 门通过） |
| 4 | 单一 DrawingScenePrimitive | 已完成（composite scene checkpoint） |
| 5 | Dynamic Overlay 与 Live Ink | 已完成（interaction overlay checkpoint） |
| 6 | LOD、命中索引、worker 与背压 | 已完成（LOD/worker/indexed hit checkpoint） |
| 7 | IndexedDB、兼容迁移与 export barrier | 已完成（async persistence/export barrier checkpoint） |
| 8 | 全工具迁移与生命周期收口 | 未开始 |
| 9 | 灰度、回滚演练与 legacy 删除 | 未开始 |

## 3. 已确认的性能基线

2026-07-14 在当前真实应用代码路径上完成了浏览器 profiling。测试场景包含 1501 根 K 线，结果如下：

| 场景 | 总耗时 | ScriptDuration | rAF p95 | rAF p99 | 最大帧 |
|---|---:|---:|---:|---:|---:|
| 无绘图，60 次交替 wheel | 3.31s | 0.47s | 17.0ms | 17.1ms | - |
| 1 条自由笔，4096 点 | 3.96s | 1.62s | 16.8ms | 33.5ms | - |
| 64 条自由笔，每条 512 点，共 32768 点 | 13.53s | 12.29s | 316.7ms | 433.3ms | 516.6ms |
| 活动画笔，960 次 pointer 输入、最终 604 点 | 3.29s | 2.30s | 33.4ms | 66.7ms | 76ms long task |

上述自动 profiling 的 DPR 为 1；真实 headed 浏览器观测到 DPR 1.5，因此实际栅格和内存压力只会更高。

### 3.1 已确认根因

1. 标准时间轴自由笔会保存连续插值时间。精确 <code>timeToCoordinate</code> 失败后，当前 <code>timeToCoordinateInterpolated</code> 对每个点执行整份数据 <code>data.every(isNumericDisplayRow)</code>。
2. 单点坐标转换因此接近 <code>O(B)</code>；一帧所有点接近 <code>O(P × B)</code>；活动笔迹不断增长时又接近 <code>O(P² × B)</code>。
3. 每个 drawing 都是一个独立 LWC primitive。每次 <code>requestUpdate</code> 会进入 Lightweight Charts full update。
4. primitive 的 view update 会重新生成 screen points、bitmap points 和 Canvas path，没有 viewport culling、像素 LOD 或统一场景缓存。
5. 当前绘图普遍使用 <code>top</code> z-order，十字光标和 cursor-only 帧也会让 top canvas 参与重绘。
6. 应用几何命中与 LWC primitive 的 <code>hitTest</code> 同名；LWC 和应用可能各执行一遍，应用侧还会扫描全部 primitive。
7. 抬笔后仍会在主线程完成简化、完整序列化和同步 <code>localStorage.setItem</code>。

关键位置：

- <code>src/chart-adapter/coordinateBridge.ts</code>
- <code>src/chart-adapter/chartInstanceBridge.ts</code>
- <code>src/features/drawings/drawingInteractionController.ts</code>
- <code>src/features/drawings/drawingSelectionController.ts</code>
- <code>src/features/drawings/primitives/FreehandDrawingPrimitive.ts</code>
- <code>src/features/drawings/useDrawingPersistenceLifecycle.ts</code>
- <code>src/features/drawings/drawingPersistence.ts</code>

旧文档 <code>FREEHAND_DRAWING_PERFORMANCE_FIX_EXECUTION_zh.md</code> 只描述了早期局部止血路径。本次 V2 会吸收其中仍正确的坐标原则，但不再把 composite scene 当作可选优化。

## 4. 不可破坏的现有语义

任何性能优化都不得绕过以下正确性边界：

- 普通时间轴的 canonical anchor 以 source time 为主。
- 同一点同时有 <code>time</code> 和 legacy <code>logical</code> 时，time 语义优先。
- 未来区域使用 absolute future time，不退化为仅依赖当前数据窗口的 logical。
- Renko、Kagi、Point & Figure、Line Break 等派生图继续使用 source-lineage、same-time ordinal、span、projection id 和 projection config。
- unresolved span 必须保留 path gap，不能为了连续绘制错误跨接。
- freehand/highlighter 的 v1、v2、v3 持久化输入继续兼容并 fail closed。
- 损坏项、未知版本、超数量、超点数、超字符预算不能覆盖最后一份有效数据。
- symbol、interval、chart type、projection、series generation 改变时，旧 screen geometry 不得复用。
- hide、clear、reload、export、surface dispose/recreate 的用户行为保持一致。
- 现有 K 线、指标、多 pane、15 类主图和 chart-adapter 边界不为绘图重构让路。

这些语义必须通过现有测试和新增 golden/parity 测试锁定。

## 5. 最终架构决策

最终选择：

> 每个可绘制 pane 一个 DrawingScenePrimitive，加一个 Dynamic Overlay Canvas 和一个 Live Ink Canvas；Lightweight Charts 继续负责 K 线、时间轴、价格轴、pane 布局和 viewport。

不选择：

- 继续维护“一 drawing 一 primitive”；
- 把全部绘图做成完全独立于 LWC 的 overlay；
- 立即重写为 WebGL/WebGPU；
- 为了绘图性能替换整个图表库；
- 让 worker 复制 Lightweight Charts 私有坐标算法。

### 5.1 目标数据流

~~~mermaid
flowchart LR
    A["Pointer/coalesced events"] --> B["Live Ink Canvas"]
    B -->|"commit"| C["DrawingDocumentStore"]
    C --> D["Scene Registry"]
    E["LWC chart/series"] --> F["Atomic DrawingFrameSnapshot"]
    F --> G["Batch Anchor Resolver"]
    D --> H["Bounds + LOD + Visible Query"]
    G --> H
    H --> I["Main-thread LWC-bound final projection"]
    I --> J["Typed ScreenDisplayList"]
    J --> K["Raster Worker / OffscreenCanvas"]
    K --> L["ImageBitmap / prepared draw commands"]
    L --> M["One DrawingScenePrimitive"]
    C --> N["IndexedDB transaction"]
    O["Hover/selection/drag"] --> P["Dynamic Overlay Canvas"]
~~~

### 5.2 线程边界

必须明确：worker 不能调用 LWC 的 <code>timeScale</code>、<code>series.priceToCoordinate</code> 或 pane API，也不能猜测其 log、percentage、indexed、invert 和 auto-scale 内部实现。

主线程负责：

- 从 adapter 一次捕获原子 <code>DrawingFrameSnapshot</code>；
- 调用 LWC-bound 的最终 logical/price 到 screen 转换；
- pointer 输入和 active/dynamic overlay；
- 发布与当前 revision 完全匹配的 render plan；
- exact screen-space hit test；
- attach/detach 唯一 scene primitive。

纯 resolver 或 worker 可以负责：

- source time/source-lineage 到 logical 的批量解析；
- canonical bounds；
- viewport 前置 culling；
- freehand simplification hierarchy 和 LOD 选择；
- typed screen display list 的离屏栅格；
- 序列化、校验和 IndexedDB 写入；
- 过期任务取消和缓存回收。

正确顺序是：

~~~text
canonical entity
  -> anchor/logical resolution
  -> data-space culling
  -> LOD
  -> 少量可见点的 LWC-bound screen projection
  -> typed ScreenDisplayList
  -> worker raster 或主线程有界 fallback
~~~

### 5.3 三层渲染

1. <code>DrawingScenePrimitive</code>
   - 已完成且未处于活动编辑状态的图形；
   - 每 pane 固定一个；
   - 静态 pane view 使用 <code>normal</code>；
   - <code>paneViews()</code> 返回稳定数组；
   - renderer 不查询数据、不做 anchor 解析、不分配点对象。

2. <code>DynamicOverlayCanvas</code>
   - selected、hover、handles、eraser feedback、drag/resize preview、two-point preview；
   - DPR-aware，<code>pointer-events: none</code>；
   - 独立 rAF，不调用 LWC full update。

3. <code>LiveInkCanvas</code>
   - 当前 freehand/highlighter；
   - 每帧只绘制新增 segment；
   - 不清空并重 trace 历史手势；
   - scene 已确认接管后再清空，避免 mouseup 闪烁。

### 5.4 模块所有权

保持现有架构边界：

- <code>src/features/drawings</code> 拥有 document、commands、scene、interaction、LOD、hit index、persistence 和 worker protocol。
- <code>src/chart-adapter</code> 拥有 LWC refs、原子 frame snapshot、最终坐标投影和唯一 primitive attach/detach。
- <code>src/runtime/performance</code> 只保留跨应用 performance store；drawing 高频计数先在 feature 内聚合，再低频汇总。
- <code>src/app</code> 和公共 <code>useDrawingRuntime</code> 不暴露 raw LWC 对象。
- <code>SingleChartPanes</code> 继续是 chart surface 组合点，不吸收 drawing 业务规则。

建议最终目录：

~~~text
src/features/drawings/
  core/
    drawingDocument.ts
    drawingDocumentStore.ts
    drawingCommands.ts
    drawingCodec.ts
  engine/
    drawingSceneRuntime.ts
    drawingRenderScheduler.ts
    drawingSceneRegistry.ts
  geometry/
    drawingBounds.ts
    drawingLod.ts
    drawingHitIndex.ts
  interaction/
    dynamicOverlayController.ts
    liveInkController.ts
  rendering/
    DrawingScenePrimitive.ts
    drawingSceneRenderer.ts
    drawingDisplayList.ts
  persistence/
    drawingDocumentRepository.ts
    legacyDrawingImporter.ts
  performance/
    drawingPerfCounters.ts
  worker/
    drawingWorkerProtocol.ts
    drawing.worker.ts
  legacy/
    legacyPrimitiveRenderer.ts

src/chart-adapter/
  drawingFrameSnapshot.ts
  drawingCoordinateIndex.ts
  drawingScenePrimitiveBridge.ts
~~~

这只是目标布局。禁止在一个提交中先批量移动全部旧文件；目录应随对应所有权真正建立而渐进创建。

## 6. 核心运行时契约

### 6.1 DrawingDocument

~~~ts
interface DrawingDocument {
  schemaVersion: number;
  scopeKey: string;
  documentRevision: number;
  entities: ReadonlyMap<string, DrawingEntity>;
  zOrder: readonly string[];
}

interface DrawingEntity {
  id: string;
  kind: DrawingKind;
  geometryRevision: number;
  styleRevision: number;
  geometry: CanonicalDrawingGeometry;
  style: DrawingStyle;
  bounds: CanonicalBounds;
}
~~~

要求：

- document 是业务真相，renderer 不是；
- command 原子增加 document revision；
- canonical 时间和价格保持 Float64 精度；
- screen path、Path2D、LOD、bitmap、hit grid 不进入 document；
- React 不订阅高频 geometry snapshot，只订阅选中和工具 UI 所需的派生状态。

### 6.2 DrawingFrameSnapshot

~~~ts
interface DrawingFrameSnapshot {
  surfaceGeneration: number;
  coordinateKey: string;
  dataRevision: number;
  projectionRevision: number;
  lineageIndexRevision: number;
  viewportRevision: number;
  themeRevision: number;
  widthCssPx: number;
  heightCssPx: number;
  dpr: number;
  axisKind: "time" | "derived-ordinal";
}
~~~

实际实现可以补充 adapter 需要的引用，但跨 worker 的消息只能包含可序列化纯数据。

### 6.3 Worker generation

每个 request/result 至少携带：

~~~text
surfaceGeneration
documentRevision
dataRevision
projectionRevision
lineageIndexRevision
viewportRevision
themeRevision
width/height/DPR
jobGeneration
~~~

任一字段不匹配，结果必须丢弃。过期 ImageBitmap 必须立即关闭。

### 6.4 缓存键与预算

~~~text
worldKey  = entity + geometryRev + data/projection/lineage revision
lodKey    = worldKey + scale bucket + tolerance class
pathKey   = lodKey + styleRev + DPR
rasterKey = sceneRev + viewportRev + size + DPR + themeRev
hitKey    = sceneRev + viewportRev + lodKey
~~~

缓存使用 byte-weighted LRU，不只限制条目数：

- 最多保留 current/previous 两张全尺寸 bitmap；
- 默认 drawing cache 预算 64 MiB，高内存设备硬上限 96 MiB；
- 淘汰顺序：旧 raster、旧 path/display list、旧 LOD；
- canonical document 不得因 cache GC 丢失；
- symbol switch、surface dispose、DPR/size generation 改变时主动释放不兼容缓存。

## 7. 性能与发布硬门槛

固定基准环境：

- production build；
- 固定 Chromium 版本；
- viewport 1440 × 900；
- DPR 1、1.5、2；
- 1500 和 10000 bars；
- 64 条自由笔、总计 32768 canonical 点；
- 200 和 512 drawing entities；
- 每个场景至少运行 5 次，丢弃 warm-up；
- 保存浏览器版本、机器、commit、mode 和原始样本。

| 场景 | 硬门槛 |
|---|---|
| 4096 pointer samples，同时存在 heavy scene | drawing main-thread p95 ≤ 4ms，p99 ≤ 8ms |
| input 到下一次 paint | p95 ≤ 20ms，p99 ≤ 33ms |
| 连续 zoom/pan | scene project + paint p95 ≤ 10ms，p99 ≤ 16ms |
| 整体 frame interval | p95 ≤ 20ms，p99 ≤ 33.4ms |
| 1000 次 hit query | p95 ≤ 1ms，p99 ≤ 2ms，max ≤ 4ms |
| mouseup 同步部分 | p95 ≤ 8ms，p99 ≤ 16ms |
| worker finalize | p95 ≤ 150ms |
| 异步 persistence | p95 ≤ 500ms |
| 1000 次 crosshair move | static projection/rebuild 次数均为 0 |
| viewport 停止后的 exact render | ≤ 120ms |
| drawing attributable long task | 大于 50ms 的数量为 0 |
| 每 surface primitive | 固定为 1 |
| 每帧 requestUpdate | ≤ 1 |
| worker queue | 1 in-flight + 1 pending-latest，深度 ≤ 2 |
| 1 小时 soak | heap 无持续增长，cache 不超过配置预算 |

不能通过降低当前 512 drawing、32768 freehand points 或 4096 single-stroke points 上限伪造达标结果。100000 点只作为扩展压力场景，不是首个发布阻断门。

固定 60Hz CI 以 20ms frame/input 门作为发布判定；在真实 120Hz 设备上另记录
pointer-to-next-paint，目标 p95 不超过一个 8.3ms 显示帧、hard gate 不超过
16.7ms。两类结果必须注明刷新率，不能混在同一基线中比较。

## 8. Feature mode 与回滚模型

统一使用：

~~~ts
type DrawingEngineMode =
  | "legacy"
  | "shadow"
  | "scene-canary"
  | "scene";
~~~

- <code>legacy</code>：当前 renderer 可见。
- <code>shadow</code>：legacy 可见；scene 后台计算和比较，不 attach 可见 canvas，不接管 pointer，不写第二份持久化。
- <code>scene-canary</code>：scene 可见；legacy codec/importer 和回滚路径保留，但不实例化全部 legacy primitives。
- <code>scene</code>：正式 V2。

mode 解析建议集中在 <code>drawingEngineMode.ts</code>：

1. 测试和开发环境 URL override；
2. 构建部署环境 <code>VITE_DRAWING_ENGINE_MODE</code>；
3. 当前发布默认值。

生产环境不允许用户输入任意 mode；mode 在 Host mount 时锁定，pointer gesture、text edit、save 和 dispose 中禁止热切换。

本次不新增后端 feature-flag 协议。生产紧急回滚通过部署配置重新构建/部署 legacy 默认包；如果未来已有通用 runtime config，再接入同一个 resolver。

失败处理：

- scene 初始化在第一次 mutation 前失败，可以直接回 legacy；
- 运行中失败时保留最后有效 render plan，取消当前 gesture；
- 不在半个手势中创建数百个 legacy primitive；
- 下一个安全 remount 才按回滚 mode 重建；
- document 和最后有效持久化数据不得因 renderer 失败丢失。

## 9. 全局验证命令

在独立工作树执行：

~~~powershell
Set-Location "H:\program\CandleScope-frontend\frontend"
npm run check:architecture
npm run typecheck
npm run lint
npm run test:drawing
npm test
npm run build
~~~

也可以运行永久总门禁：

~~~powershell
npm run check
~~~

有后端和 Vite 环境时：

~~~powershell
npm run smoke -- --url http://127.0.0.1:15173/ --drawing-check
npm run smoke:export -- --url http://127.0.0.1:15173/
npm run smoke:release -- --url http://127.0.0.1:15173/
~~~

Phase 0 完成后还必须运行：

~~~powershell
npm run perf:drawing -- --url http://127.0.0.1:15173/
~~~

若本机 PATH 找不到 Node，先调用工作区依赖运行时查询，不在文档中硬编码可能漂移的 Node 绝对路径。

## 10. Phase 0：固定重负载基准与 instrumentation

### 目标

先建立可以自动复现当前卡顿、比较每个 Phase、阻止性能回退的 production-browser benchmark。本阶段不改变绘图行为。

### 涉及文件

新增：

- <code>scripts/drawing-performance.mjs</code>
- <code>scripts/drawing-performance-metrics.mjs</code>
- <code>scripts/drawing-performance-metrics.test.mjs</code>
- <code>src/features/drawings/performance/drawingPerfCounters.ts</code>
- <code>src/features/drawings/performance/__tests__/drawingPerfCounters.test.ts</code>
- <code>../docs/perf-baselines/drawing-engine-v2/README.md</code>

修改：

- <code>package.json</code>
- 必要时复用 <code>scripts/perf-baseline.mjs</code> 的 CDP/heap helper。

### 逐步任务

- [x] 为 package scripts 增加 <code>perf:drawing</code>。
- [x] 固定生成 0 drawing、1 × 4096、64 × 512、200 entities、512 entities 五类 fixture。
- [x] fixture 使用当前合法 SavedDrawing/freehand v3 codec，不直接篡改 primitive 私有字段。
- [x] 自动执行 active freehand、hover、continuous wheel、pan、mouseup、reload restore。
- [x] 收集 rAF intervals、Long Task、Event Timing、ScriptDuration、heap、worker queue。
- [x] 记录 rawPoints、renderedPoints、visibleEntities、culledEntities、LOD ratio。
- [x] 记录 anchorResolveCount、finalProjectionCount、sceneRebuildCount、requestUpdateCount。
- [x] drawing feature 内使用 rolling histogram；禁止每帧调用全局 <code>recordPerfEvent</code>。
- [x] 每 5 秒或 gesture end 才向 <code>window.__CANDLESCOPE_PERF__</code> 汇总一次。
- [x] 保存 before JSON 到 <code>docs/perf-baselines/drawing-engine-v2/</code>。
- [x] 报告必须包含 commit、browser、DPR、viewport、bars、entities、points 和 mode。

### 测试

- percentile、warm-up 丢弃、Long Task 归因和空样本行为单测；
- production preview 实际跑通；
- benchmark 失败时返回非零退出码；
- 不依赖外网市场数据，提供确定性 mock/seed 入口。

### 退出门槛

- [x] 自动复现 64 × 512 wheel 卡顿。（<code>freehand-64x512-viewport</code>：frame p95 650ms、p99 750ms。）
- [x] 自动复现 active 4096 stroke。（<code>active-freehand-4096</code>：五次 measured run 均处理 4096 个输入并成功 reload restore。）
- [x] 相同 commit 连跑 5 次，关键 p95 波动可解释且原始样本完整。（另有一次 warm-up；raw dropped=0。旧 O(P × B) 路径对主机调度/GC 高度敏感，重场景 wall time 同步波动，frame p95 又按 50/66.7/83.3ms 等丢帧档位量化；原始 run、ScriptDuration、heap 与 long task 均保留在 JSON。）
- [x] 生成第一份 versioned baseline JSON。（<code>docs/perf-baselines/drawing-engine-v2/baseline-before-3067e1b5-20260714T083202Z-bars1500-dpr1.json</code>。）

### 回滚

删除 benchmark 和 feature-local counters即可；不得因此修改生产绘图路径。

### 建议提交

<code>test(frontend): add drawing engine performance baseline</code>

## 11. Phase 1：原子坐标快照与批量 anchor resolver

### 目标

消灭逐点 <code>data.every(...)</code> 和重复 source anchor 解析，把数据/projection 解析与 viewport 最终投影分层，同时保持所有现有坐标语义。

### 涉及文件

新增：

- <code>src/chart-adapter/drawingCoordinateIndex.ts</code>
- <code>src/chart-adapter/drawingFrameSnapshot.ts</code>
- 对应 adapter tests。

修改：

- <code>src/chart-adapter/coordinateBridge.ts</code>
- <code>src/chart-adapter/chartInstanceBridge.ts</code>
- <code>src/components/SingleChartPanes.tsx</code>
- <code>src/features/drawings/freehandStrokeModel.ts</code>
- drawing coordinate tests。

### 逐步任务

- [x] 定义 <code>DrawingFrameSnapshot</code> revision contract。
- [x] 把现有 <code>drawingCoordinateKey</code> 纳入 snapshot generation。
- [x] 每个 data revision 只验证一次 numeric series data。
- [x] 建立 Float64 time index 和 exact time lookup。
- [x] 普通时间点提供 exact lookup、binary search 和有序 batch merge-walk。
- [x] derived ordinal 复用现有 <code>DrawingLineageIndex</code>，缓存 same-time ordinal lookup。
- [x] source anchor 到 logical 的结果按 entity geometry revision + data/projection/lineage revision 缓存。
- [x] scalar API 暂时保留，内部可以委托 batch resolver，确保旧调用方不同时爆炸式修改。
- [x] 移除 point projector 内的 <code>data.every(...)</code>。
- [x] 区分纯 anchor resolution 与必须调用 LWC API 的 final screen projection。
- [x] 应用几何命中方法改名为 <code>hitTestGeometry</code>，不再冒充 LWC primitive <code>hitTest</code>。
- [x] legacy primitive 如果保留 LWC hitTest，只能返回正确 contract 或完全不实现。
- [x] 增加临时 coordinate projector 开关，便于 scalar/batch parity 对照。

### 正确性测试

- [x] exact time。
- [x] fractional source time。
- [x] time + stale logical 时仍以 time 为准。
- [x] absolute future time。
- [x] same-time ordinal。
- [x] resolved/unresolved lineage span。
- [x] Renko、Kagi、P&F、Line Break。
- [x] data prepend、gap recovery、interval/chart-type switch。
- [x] normal/log/percentage/indexed/inverted price mode 的最终屏幕 parity。

batch 与当前正确 scalar 结果的误差门：

- 点、端点和 handles：≤ 0.25 CSS px；
- 普通自由笔 render plan：≤ 0.5 CSS px；
- canonical anchor 必须完全一致，不接受像素接近但锚点语义不同。

### 性能验收

- 单个 snapshot 内 numeric validation 次数 ≤ 1；
- 单纯 viewport revision 时 source anchor re-resolution 次数为 0；
- point count 增长不再带来 <code>P × B</code> 次 validation；
- 64 × 512 benchmark 的 ScriptDuration 明显下降，且没有坐标回归。

### 回滚

保留 scalar projector 和 parity tests。开关回 scalar 时 document/persistence 数据不发生变化。

### 建议提交

<code>perf(frontend): add revisioned batch drawing coordinates</code>

## 12. Phase 2：DrawingDocumentStore、commands 与 codec

### 目标

把 drawing 业务模型从 primitive class 中抽离。完成后 document 是唯一持久业务真相，legacy primitive 只是一种 renderer。

### 涉及文件

新增：

- <code>src/features/drawings/core/drawingDocument.ts</code>
- <code>src/features/drawings/core/drawingDocumentStore.ts</code>
- <code>src/features/drawings/core/drawingCommands.ts</code>
- <code>src/features/drawings/core/drawingCodec.ts</code>
- <code>src/features/drawings/legacy/legacyPrimitiveRenderer.ts</code>
- 对应 tests。

渐进修改：

- <code>drawingInteractionController.ts</code>
- <code>drawingCreationController.ts</code>
- <code>drawingDragResizeController.ts</code>
- <code>drawingSelectionController.ts</code>
- <code>drawingPrimitiveFactory.ts</code>
- <code>drawingPersistence.ts</code>
- <code>useDrawingPersistenceLifecycle.ts</code>

### 逐步任务

- [x] 定义所有 drawing kind 的纯 entity geometry/style。
- [x] 复用现有 SavedDrawing normalizer，建立 <code>SavedDrawing -> DrawingDocument</code> importer。
- [x] 建立 <code>DrawingDocument -> legacy-compatible SavedDrawing[]</code> codec。
- [x] 添加 create/update-style/move/resize/delete/clear/reorder command。
- [x] command 同步提交 document，目标主线程耗时 < 1ms。
- [x] document revision 与 entity geometry/style revision 分开。
- [x] 先让 legacy renderer 从 document snapshot 创建/更新 primitives。
- [x] controller 逐动作改为发 command，不再直接把 primitive 私有字段作为业务真相。
- [x] selection state 只保存 entity id 和派生 meta，不保存 class identity。
- [x] 本阶段未引入 undo/redo；后续若启用只保存 commands/document revisions，不保存 bitmap。
- [x] Host 公共 API 保持兼容。

### 推荐拆分

Phase 2A：

- document types、store、codec；
- load/save round-trip；
- 无可见行为变化。

Phase 2B：

- line、axis-line、angle、fib、shape commands；
- legacy renderer 消费 document。

Phase 2C：

- text、position、freehand、highlighter；
- selection/drag/style 从 class identity 脱离。

### 必须测试

1. legacy 保存，document 导入一致。
2. document 修改后导出，最后一个 legacy build 可以读取。
3. v1/v2/v3 freehand round-trip。
4. unknown/malformed/over-budget 继续 fail closed。
5. 单纯 load 不产生 dirty write。
6. style-only command 不增加 geometry revision。
7. symbol switch 不串 document。
8. command 失败不产生半提交 revision。

### 退出门槛

- [x] 所有用户 mutation 都可以表示为 document command。
- [x] primitive 不再是 persistence 输入的唯一来源。
- [x] legacy renderer 下现有功能、smoke、export 全部保持。
- [x] public drawing runtime contract 未扩大到 raw chart refs。

### 回滚

保留 legacy renderer adapter；回滚 document-authoritative 开关时继续读取原 SavedDrawing，不删除任何本地数据。

### 建议提交

<code>refactor(frontend): make drawing document authoritative</code>

## 13. Phase 3：Scene shadow、culling 与 render plan

### 目标

新 scene 在后台读取同一个 document，生成不可见的 render plan，并与 legacy 可见结果比较。本阶段不接管 pointer、不 attach 可见 scene primitive、不双写持久化。

### 涉及文件

新增：

- <code>engine/drawingSceneRuntime.ts</code>
- <code>engine/drawingSceneRegistry.ts</code>
- <code>engine/drawingRenderScheduler.ts</code>
- <code>geometry/drawingBounds.ts</code>
- <code>rendering/drawingDisplayList.ts</code>
- <code>drawingEngineMode.ts</code>

### 逐步任务

- [x] 实现 <code>legacy/shadow/scene-canary/scene</code> mode resolver。
- [x] scene registry 按 entity id/z-order 维护 retained nodes。
- [x] 每 entity 生成 canonical bounds。
- [x] ray/infinite line 使用明确 unbounded 标志，不伪造巨大 bbox。
- [x] 当前 ≤ 512 entities 先采用 packed bbox arrays 顺序扫描。
- [x] 长自由笔按 chunk 建 bounds，避免一个跨全图 stroke 每次处理全部点。
- [x] shadow 使用同一 atomic frame snapshot。
- [x] 生成 typed screen display list，不创建每点对象。
- [x] 比较 legacy 与 scene 的 visible entity、bbox、handles、hit entity 和 serialized output。
- [x] 对比结果低频汇总到 perf store。
- [x] shadow 禁止 attach 可见 canvas、注册第二套 pointer listener或写第二份 persistence。

### Shadow parity 门

- canonical entity id/z-order：完全一致；
- visible entity set：完全一致；
- bounded geometry screen bbox：每边误差 ≤ 0.5px；
- handles：≤ 0.25px；
- hit result：entity id/zone/handle 一致；
- serialized SavedDrawing：normalize 后深度一致；
- unresolved span gap：数量和位置一致。

### 性能门

shadow 额外成本不能让现有场景出现新的 >50ms Long Task。若 shadow 本身超预算，不能进入可见 Phase；必须先修正 scene 数据结构。

### 回滚

mode 改回 legacy。shadow 不改变数据和可见行为，因此无需迁移回滚。

### 建议提交

<code>feat(frontend): add shadow drawing scene runtime</code>

## 14. Phase 4：单一 DrawingScenePrimitive

### 目标

让已完成绘图由每 pane 一个 composite scene primitive 渲染，消除 per-drawing attach/updateAllViews/full-update 放大。

### 涉及文件

新增：

- <code>rendering/DrawingScenePrimitive.ts</code>
- <code>rendering/drawingSceneRenderer.ts</code>
- <code>src/chart-adapter/drawingScenePrimitiveBridge.ts</code>

修改：

- <code>DrawingEngineHost.tsx</code>
- <code>chartInstanceBridge.ts</code>
- <code>useDrawingPersistenceLifecycle.ts</code>
- scene scheduler。

### 逐步任务

- [x] 每个 drawing surface 创建一个 scene primitive。
- [x] <code>paneViews()</code> 返回永久复用的 readonly array。
- [x] 静态 pane view 使用 <code>normal</code> z-order。
- [x] renderer 只读取 immutable prepared render plan。
- [x] draw 内禁止 anchor resolve、data scan、JSON、React state 和大对象分配。
- [x] 同一帧最多一次 scene invalidation/requestUpdate。
- [x] 聚合必要的 price/time axis views；不要重新变成每 entity 一个 primitive。
- [x] scene primitive 不实现重型 LWC hitTest。
- [x] cursor-only 帧不得触发 static scene projection/rebuild。
- [x] series recreate 只 detach/attach 一个 scene primitive。
- [x] document 在 surface recreate 时继续存在。
- [x] 第一批只迁移 basic line、axis-line 和 shape。
- [x] 未迁移 kind 暂时继续由 legacy primitive 渲染；同一个 entity 不得双绘或双命中。
- [x] scene-canary 初始化失败仅在第一次 mutation 前允许安全回 legacy。

### 功能验收

- 第一批 line、axis-line、shape 的静态显示 parity；
- 已迁移 kind 的 z-order、line dash、fill 和 opacity 一致；
- crosshair 在静态绘图之上；
- hide/show、clear、theme、resize、DPR、series generation 正确；
- export 先暂时沿用现有 committed scene，active overlay 在 Phase 7 收口。

### 性能验收

- 只包含已迁移 kind 的 fixture 中，每 surface attached drawing primitive 数 = 1；
- 混合 fixture 中 primitive 数 = 1 个 scene primitive + 尚未迁移的 legacy entity 数；
- 1000 次 crosshair move 的 static scene rebuild = 0；
- 每 viewport frame requestUpdate ≤ 1；
- 64 条自由笔不再产生 64 份 view update。

### 回滚

mode 回 shadow/legacy；document 和 codec 保持不变。

### 建议提交

<code>feat(frontend): render committed drawings through one scene primitive</code>

## 15. Phase 5：Dynamic Overlay 与 Live Ink

### 目标

让正在画、拖拽、选中和 hover 的高频反馈完全离开 LWC full-update 路径。

### 涉及文件

新增：

- <code>interaction/dynamicOverlayController.ts</code>
- <code>interaction/liveInkController.ts</code>
- 可选 <code>rendering/DrawingInteractionOverlay.tsx</code>

修改：

- <code>DrawingEngineHost.tsx</code>
- <code>drawingInteractionController.ts</code>
- <code>drawingPointerController.ts</code>
- <code>drawingHoverController.ts</code>
- <code>drawingEraseController.ts</code>
- text edit overlay 协作。

### 逐步任务

- [x] 在 pane DOM 上挂载 DPR-aware dynamic canvas。
- [x] 挂载独立 live-ink canvas，二者均 <code>pointer-events: none</code>。
- [x] overlay 使用 adapter 提供的真实 main-pane plot rect 裁剪，不覆盖 price axis、time axis 或 subpane。
- [x] 复用现有 coalesced events 和 rAF 合帧。
- [x] 每个 pointer frame 只处理本帧新增 samples。
- [x] live ink 只追加 line segment，不重 trace 已画历史。
- [x] canonical draft 使用 chunked typed buffers，避免每点扩容复制。
- [x] selected/hover/handles/drag preview 只画 dynamic overlay。
- [x] 当前活动 entity 可以从 static scene 临时排除或仅画非重复底图。
- [x] highlighter 使用独立 buffer 和整体 opacity/composite，避免分段接缝反复叠黑。
- [x] mouseup 先原子提交 document，overlay 保持最后一帧。
- [x] scene revision 确认可见后再清空 live ink。
- [x] pointer cancel、Escape、surface dispose 都能清理 overlay 和 draft。
- [x] pointer move 不触发 React render 或 LWC requestUpdate。

### 性能门

- active overlay drawing CPU p95 ≤ 2ms/frame；
- 全部 drawing main-thread p95 ≤ 4ms；
- 4096 pointer samples 无 drawing 导致的 >50ms Long Task；
- mouseup 主线程 p95 ≤ 8ms；
- overlay 与 committed scene 交接无空白帧。

### 功能矩阵

- pen/highlighter；
- drag/resize；
- selection handles；
- eraser hover/delete；
- two-point preview；
- text edit/commit/cancel；
- pointer cancel/window blur；
- DPR/resize；
- LWC pan/zoom 与 drawing pointer ownership。

### 回滚

scene static renderer 可继续存在；关闭 overlay flag 后恢复旧交互 renderer。document 不回滚。

### 建议提交

<code>perf(frontend): move live drawing feedback off chart updates</code>

## 16. Phase 6：LOD、命中索引、worker 与 latest-wins 背压

### 目标

让缩放、平移、命中和抬笔后的大计算受可见像素预算限制，并把允许离线的重工作移出主线程。

### 涉及文件

新增：

- <code>geometry/drawingLod.ts</code>
- <code>geometry/drawingHitIndex.ts</code>
- <code>worker/drawingWorkerProtocol.ts</code>
- <code>worker/drawing.worker.ts</code>
- worker tests。

### 逐步任务

- [x] 每个连续 freehand path 生成嵌套 simplification hierarchy。
- [x] canonical raw points 永久保留；LOD 只是可再生 cache，不回写覆盖原始几何。
- [x] endpoints 和 path gaps 永久保留。
- [x] LOD 由屏幕误差选择，不使用固定每 N 点抽样。
- [x] selected/edit tolerance 约 0.35px。
- [x] normal static tolerance 约 0.75px。
- [x] continuous wheel/pan tolerance 约 1.25px。
- [x] 普通路径限制为每可见 CSS px 约 2–3 个有效顶点。
- [x] 先 entity/chunk culling，再做 LOD 和 LWC-bound final projection。
- [x] 当前可见 render plan 同步生成 screen bbox。
- [x] 建立 32/64px uniform grid，bucket 保存 segment references。
- [x] exact hit 使用 squared point-to-segment distance，不做无意义 sqrt。
- [x] z-order 只在候选集内决胜。
- [x] worker 持有 canonical/LOD 镜像和可选 OffscreenCanvas。
- [x] 主线程发送 entity patch，不每帧传全场 typed arrays。
- [x] final screen projection 后发送 typed ScreenDisplayList。
- [x] worker 返回 ImageBitmap 或有界 draw result。
- [x] 每类 queue 固定 1 in-flight + 1 pending-latest。
- [x] 新 viewport 覆盖 pending old viewport。
- [x] worker 在 entity/path 边界检查 cancel generation。
- [x] revision 不匹配结果不发布并立即释放资源。
- [x] 不支持 OffscreenCanvas 时走主线程分时、低 LOD fallback。

### 快速模式与 exact 收敛

viewport 连续变化时：

1. 优先复用上一个 exact raster；
2. 只有实际采样验证 affine residual ≤ 0.25px 时才 warp；
3. data/projection/lineage/DPR/size 改变时禁止 warp；
4. affine 不可靠时立即使用更低 LOD 的精确可见点；
5. 每帧 drawing budget 到 4ms 后停止低优先工作；
6. viewport 80–120ms 稳定后发布 ≤0.5px exact render。

normal、log、percentage、indexed、invert price mode 至少使用三个价格样本验证 transform。不能假设所有模式都可直接仿射复用。

### 性能门

- 64 × 512、10000 bars 连续 zoom 的 scene project+paint p95 ≤ 10ms；
- frame interval p95 ≤ 20ms、p99 ≤ 33.4ms；
- hit-test p95 ≤ 1ms；
- worker queue depth ≤ 2；
- stale result publish = 0；
- viewport-only 更新的 source anchor resolve = 0；
- exact settle ≤ 120ms。

### 回滚

关闭 worker/raster backend，保留同一 scene/document，使用主线程低 LOD renderer。不要回到 per-drawing primitive。

### 建议提交

<code>perf(frontend): add drawing LOD worker and indexed hit testing</code>

## 17. Phase 7：IndexedDB、兼容迁移与 export barrier

### 目标

把同步大 JSON/localStorage 写入移出交互热路径，同时保证旧数据可读、回滚可行、导出内容完整。

### 目标存储

~~~text
Database: candlescope-drawings-v2
Store: documents
Key: drawing scope key
Record:
  documentSchemaVersion
  scopeKey
  documentRevision
  updatedAt
  entities
~~~

IndexedDB 可以 structured-clone typed arrays。LOD、Path2D、screen bbox、bitmap 和 viewport caches 不持久化。

### 涉及文件

新增：

- <code>persistence/drawingDocumentRepository.ts</code>
- <code>persistence/legacyDrawingImporter.ts</code>
- repository/migration tests。

修改：

- <code>drawingPersistence.ts</code>
- <code>useDrawingPersistenceLifecycle.ts</code>
- <code>drawingEngineLoader.ts</code>
- <code>DrawingEngineHost.tsx</code>
- <code>src/features/export/useExportRuntime.ts</code>
- <code>src/features/export/exportPreviewRuntime.ts</code>
- <code>src/chart-adapter/useChartSurfaceRuntime.ts</code>
- <code>src/components/SingleChartPanes.tsx</code>
- worker protocol。

### 逐步任务

- [x] 第一次读取优先查 v2 document。
- [x] v2 不存在时读取当前 <code>candlescope-drawings-*</code> SavedDrawing[]。
- [x] 处理当前 drawing engine lazy loader 依赖同步 <code>hasSavedDrawings()</code> 的接缝。
- [x] 使用 feature-owned 小型 manifest 或受控的异步 IDB probe 决定是否懒加载 engine；manifest 只保存 key/count/revision 提示，不作为 drawing 真值。
- [x] manifest 损坏或缺失时可以通过 IDB probe 修复，组件层不得直接拥有 IDB/localStorage 规则。
- [x] legacy 输入只在内存导入，单纯 load 不重写。
- [x] 第一次 mutation 后异步创建 v2 record。
- [x] document persistence 使用 300–500ms debounce、per-symbol latest-wins。
- [x] IndexedDB 事务原子更新；失败时旧 record 保持。
- [x] worker 可以完成序列化/校验，但最终 decoder/budget 必须再次验证。
- [x] canary 期间 idle 生成 legacy-compatible snapshot，供旧 build 回滚读取。
- [x] legacy <code>localStorage.setItem</code> 不在 pointer/mouseup 热路径。
- [x] quota/validation 失败不覆盖旧 localStorage value。
- [x] symbol switch、visibilitychange、pagehide、export 前显式 flush。
- [x] 保存失败保留 dirty document 并记录状态，不丢内存内容。
- [x] v1/v2/v3 decoder 至少保留到 legacy renderer 删除后的一个正式版本。

### Export barrier

把当前同步 <code>prepareExport()</code> 扩展为可等待的 barrier：

1. commit/cancel text editing；
2. 处理 active gesture；
3. flush document command；
4. 等待目标 scene revision exact render；
5. 清除 selection/hover/live overlay；
6. 等待一帧；
7. 执行现有 DOM/chart capture；
8. 恢复交互 overlay。

需要修改公共 contract 时，优先把 <code>prepareExport(): void</code> 演进为返回 Promise 的兼容形式，调用方必须 await，不能靠固定两帧猜测 worker 完成。

### 兼容测试

1. legacy 保存，scene 加载一致。
2. scene 修改保存，legacy decoder 加载一致。
3. scene 保存失败，原始 bytes 不变。
4. v1/v2/v3、损坏项、未知版本、超预算混合输入 fail closed。
5. reload、symbol/interval switch。
6. hide drawings export。
7. active text/freehand export。
8. DPR 1/2 和 1×/2×/3× export scale。

### 性能门

- mouseup 不同步 stringify 全 document；
- persistence p95 ≤ 500ms，且不阻塞 input；
- 512 entities restore 的任何单个主线程阻塞块 ≤ 16ms；
- export 超时给出明确错误，不截取半更新 scene。

### 回滚

- v2 record 不删除 legacy snapshot；
- legacy build 继续读取最后兼容 snapshot；
- 回滚不需要把 cache 写回存储；
- 删除 v2 DB 只能在用户明确清理数据时执行。

### 建议提交

<code>refactor(frontend): persist drawing documents asynchronously</code>

## 18. Phase 8：全工具迁移与生命周期收口

### 目标

所有 drawing kinds 完全使用 document/scene/overlay，不再依赖 per-drawing primitive 作为业务或交互对象。

### 推荐迁移顺序

Phase 4 已迁移 basic line、axis-line 和 shape，Phase 6 已迁移
freehand/highlighter。本阶段按以下顺序收口剩余 kind：

1. angle measurement；
2. fibonacci；
3. text；
4. position；
5. 回归审计 basic line、axis-line、shape；
6. 回归审计 freehand/highlighter。

自由笔最影响性能，但不在最早阶段同时承担全部模型迁移风险：Phase 1 先移除
坐标热点；Phase 5 接管高频 dynamic overlay 与 active live ink；Phase 6 将
committed freehand/highlighter 迁入 static DrawingScenePrimitive，并完成 LOD、
命中索引、worker 与 latest-wins 背压。angle measurement、fibonacci、text、
position 的完整 document/scene/overlay 迁移仍由 Phase 8 收口。

Text 的字体加载、<code>measureText</code> 和 worker font parity 必须单独验证；若
worker 字体结果不稳定，允许该帧使用同一 scene 的主线程 Canvas2D backend，
不能为了文字把 entity 拆回独立 primitive 或打乱 z-order。

### 每类工具固定步骤

- [ ] entity geometry/style 定义完成。
- [ ] legacy import/export round-trip。
- [ ] scene static renderer。
- [ ] dynamic preview。
- [ ] handles/drag/resize。
- [ ] hit zones 和 cursor。
- [ ] style patch。
- [ ] hide/clear/delete。
- [ ] reload。
- [ ] future/source-lineage semantics。
- [ ] export。
- [ ] pixel/anchor golden。
- [ ] shadow parity 达标。
- [ ] scene-canary 可见。
- [ ] 对应 legacy primitive 不再实例化。

### 生命周期

- [ ] chart remove 前同步取消 pointer capture、rAF 和 overlay。
- [ ] worker pending 标记 stale，不允许写回新 surface。
- [ ] 关闭 current/previous ImageBitmap。
- [ ] detach 唯一 scene primitive。
- [ ] series recreate 后重新 attach 一个 scene primitive。
- [ ] document 不因 surface recreate 销毁。
- [ ] drawingCoordinateKey 改变立即清空旧 screen geometry/hit grid。
- [ ] hidden scene 不进行无用 raster，但 persistence 保持。
- [ ] clearAll 同时清 document、scene cache、overlay、selection 和持久化任务。

### 全局功能矩阵

- chart type：candlestick、line/area/baseline 代表、Renko、Kagi、P&F、Line Break；
- price mode：normal、log、percentage、indexed、inverted；
- anchor：source-time、derived ordinal、future absolute time；
- DPR：1、1.5、2；
- lifecycle：symbol、interval、projection、theme、resize、reload、dispose/recreate；
- interaction：create、select、hover、drag、resize、style、erase、hide、clear；
- export：chart、main pane、page，PNG/JPEG/WebP。

### 退出门槛

- 所有工具在 scene-canary 下通过；
- legacy primitive 实例数在 scene-canary 为 0；
- public drawing runtime 和 toolbar 行为保持；
- smoke:release 和 perf:drawing 同时达标。

### 建议提交

可以按工具组拆分多个提交，例如：

- <code>refactor(frontend): move line tools to drawing scene</code>
- <code>refactor(frontend): move shape and annotation tools to drawing scene</code>
- <code>refactor(frontend): complete freehand scene migration</code>

## 19. Phase 9：灰度、回滚演练与 legacy 删除

### 灰度顺序

1. 开发和自动测试：shadow。
2. 内部/QA：scene-canary。
3. production cohort：1%。
4. 通过完整观察窗：10%。
5. 通过完整观察窗：50%。
6. 通过完整观察窗：100%。
7. 100% 默认至少两个发布或 14 天。
8. 删除 legacy renderer。

没有现成远程 feature-flag 服务时，通过不同部署构建的 mode/rollout 配置执行；不要为了本重构临时发明未经治理的后端配置协议。

### 每档观察项

- scene init/runtime fallback；
- persist invalid/quota；
- stale worker drop 与错误 publish；
- input/frame p95/p99；
- Long Task；
- cache bytes/heap；
- export timeout；
- coordinate parity；
- legacy import count；
- crash/unhandled rejection。

### 强制回滚演练

- [ ] scene worker 初始化失败。
- [ ] OffscreenCanvas 不支持。
- [ ] IndexedDB quota/blocked。
- [ ] worker 返回 stale generation。
- [ ] chart type/interval 在 active gesture 中切换。
- [ ] series 在 export 前重建。
- [ ] DPR/resize 连续变化。
- [ ] canary 构建切回 legacy 后仍能读取最新兼容 snapshot。

### 删除条件

以下全部满足后才删除：

- scene 默认 100% 至少两个发布或 14 天；
- init/runtime fallback 为 0 或只有已解释且有 fallback 的环境；
- persistence invalid 为 0；
- DPR 1/1.5/2、普通与 derived ordinal 全过 SLO；
- 最后一个 legacy build 能读取 scene 保存 fixtures；
- 一小时 soak 无持续 heap 增长；
- export matrix 全过；
- 用户数据迁移没有未解决丢失报告。

### 删除内容

- <code>src/features/drawings/primitives/</code> 中已无引用的 per-drawing classes；
- <code>drawingPrimitiveFactory.ts</code>；
- <code>DrawingPrimitive</code> class union；
- <code>primitivesRef</code>；
- 逐项 attach/detach lifecycle；
- legacy/shadow renderer mode；
- 临时 scalar/batch parity 开关；
- canary-only dual instrumentation。

保留：

- legacy SavedDrawing decoder/importer至少一个正式版本；
- golden fixtures；
- perf:drawing；
- scene architecture tests；
- emergency document export能力。

### 架构门禁

扩展 <code>scripts/check-architecture.mjs</code>，禁止重新出现：

- drawing feature 内逐 entity <code>attachPrimitive</code>；
- <code>primitivesRef</code>；
- 每 entity <code>paneViews()</code>；
- pointer move 调用 LWC <code>requestUpdate</code>；
- interaction hot path 直接 <code>localStorage.setItem</code>；
- worker import chart-adapter/LWC refs；
- drawing public runtime 暴露 raw chart/series。

### 建议提交

<code>refactor(frontend): remove legacy drawing primitives</code>

## 20. 推荐 checkpoint 顺序

| 顺序 | 建议提交 | 可见行为 |
|---:|---|---|
| 1 | test: drawing performance baseline | 无变化 |
| 2 | perf: revisioned batch coordinates | 应明显改善坐标热点 |
| 3 | refactor: drawing document core | legacy 可见行为不变 |
| 4 | feat: shadow scene runtime | legacy 可见，后台对照 |
| 5 | feat: one scene primitive | scene-canary 静态接管 |
| 6 | perf: live ink overlays | 活动画笔接管 |
| 7 | perf: LOD worker and hit index | 缩放/命中接管 |
| 8 | refactor: async persistence/export | 存储和导出接管 |
| 9 | refactor: migrate all tools | scene-canary 全工具 |
| 10 | refactor: remove legacy engine | scene 正式 |

每个 checkpoint 都必须附：

- 修改范围；
- 运行命令；
- 单测数量/结果；
- smoke 结果；
- before/after perf JSON；
- 当前 mode；
- 已知限制；
- 回滚方法。

## 21. 停止条件

遇到以下任一情况，停止扩大改动或灰度：

- canonical anchor 或未来时间语义发生变化；
- batch 与 scalar parity 超过阈值；
- derived ordinal 出现错误跨 gap 连线；
- scene 数据与持久化数据出现双真相；
- worker 尝试复制 LWC 私有价格/时间坐标逻辑；
- shadow 注册第二套 pointer listener；
- scene-canary 仍实例化大量 legacy primitives；
- input 热路径出现同步 JSON/localStorage/IndexedDB 等待；
- worker queue 超过 2 或 stale result 被发布；
- cache 没有 byte budget 或 ImageBitmap 未 close；
- export 捕获半更新 scene；
- 通过减少支持点数或 drawing 数掩盖性能问题；
- 只为了目录整齐进行大规模移动；
- K 线、指标或 chart-adapter 边界被 drawing 反向污染；
- 无法明确回滚当前 Phase。

## 22. 最终完成定义

全部满足才算重构完成：

- [ ] 每个 drawing pane 固定一个 scene primitive。
- [ ] active/dynamic interaction 不触发 LWC full update。
- [ ] viewport-only 更新不重新解析 source anchors。
- [ ] 渲染工作与可见图形/像素预算相关，不与总保存点数线性绑定。
- [ ] hit-test 只检查空间候选。
- [ ] worker latest-wins，过期结果永不发布。
- [ ] persistence 不阻塞 pointer/mouseup。
- [ ] legacy 数据可导入，最后 legacy build 可读取 canary 兼容数据。
- [ ] 全工具、全 chart anchor、DPR、price mode、lifecycle 和 export matrix 通过。
- [ ] perf:drawing 所有硬门槛通过。
- [ ] 一小时 soak 通过。
- [ ] legacy per-drawing primitives 删除。
- [ ] 架构检查禁止旧模式回归。
- [ ] README、架构文档和 drawings ownership 文档与实现一致。

“一劳永逸”不表示未来永远不需要调参，而表示以后更换 Canvas2D/WebGL backend、调整 LOD 或缓存预算时，不再需要重写 document、坐标语义、交互、持久化和 chart integration。

## 23. 执行记录模板

每完成一个 Phase，在对应 PR/提交说明和本节追加：

~~~text
Phase:
Date:
Commit:
Mode:
Files:
Tests:
Smoke:
Perf baseline:
Perf result:
Correctness parity:
Known limitations:
Rollback verified:
Decision:
~~~

不要只记录最终最好的一次数字；保留原始 JSON 和失败样本，确保后续能解释真实性能变化。

### Phase 0 执行记录

~~~text
Phase: 0 — 固定重负载基准与 instrumentation
Date: 2026-07-14
Commit: 5cfc84d3c3131e527fc10a9389edde9de99bdd3d（before 报告在 checkpoint 前生成，因此 source commit 为 3067e1b5 且如实记录 dirty=true）
Mode: legacy
Files: scripts/drawing-performance*.mjs、scripts/mock-api.mjs、src/features/drawings/performance/、legacy freehand/line/shape/interaction/selection/persistence instrumentation、package/vite 配置、docs/perf-baselines/drawing-engine-v2/
Tests: npm.cmd run check 通过：architecture、typecheck、ESLint、805/805 tests、production build；Phase 0 定向测试 36/36 通过
Smoke: production mock + Vite preview 跑通；六场景 smoke 与 active 128/4096 smoke 通过；正式 36/36 run 的真实 reload restore 全部通过
Perf baseline: docs/perf-baselines/drawing-engine-v2/baseline-before-3067e1b5-20260714T083202Z-bars1500-dpr1.json
Perf result: phase0Acceptance=true；Chrome/150.0.7871.101，1440×900，DPR 1，1500 bars，59.88Hz；6 场景各 1 warm-up + 5 measured；raw dropped=0、Event Timing 122 samples、diagnostic runs=0。64×512/32768 点场景 drawing-main p95/p99=573.3/656.1ms、frame p95/p99=650/750ms；active 4096 + 200 background entities 场景 drawing-main p95/p99=78.4/103.5ms、frame p95/p99=83.4/116.7ms。legacy target assessment 按预期未通过。
Correctness parity: 本阶段未改变 SavedDrawing/freehand codec 或可见绘图语义；五次 active measured run 均处理 4096 输入，rawPoints 峰值 4497、visibleEntities 201、requestUpdateCount 4099，mouseup 后保存并 reload 为 201 entities / 1217 canonical points；36 个 run 的实体、类型、点数摘要均一致。
Known limitations: 本阶段只冻结 legacy before 基线，不修复已测得的性能热点。主基线为 1500 bars / DPR 1；runner 已支持 --bars/--dpr，10000 bars 与 DPR 1.5/2 仍属于第 7 节的全局发布矩阵。legacy 重场景 p95 相对范围约 40%–60%，与单 run wall time/丢帧档位同步，非丢样或诊断错误。
Rollback verified: 回滚边界已核对为 benchmark、feature-local counters、instrumentation 调用点与 package/vite/mock 配置；未在当前未提交工作区执行破坏性回滚演练，绘图数据无需迁移。
Decision: Phase 0 PASS；正式 before baseline 已冻结；checkpoint 已提交。
~~~

### Phase 1 执行记录

~~~text
Phase: 1 — 原子坐标快照与批量 anchor resolver
Date: 2026-07-14
Commits: aa36dc227028c3614845b9c9ced075645a48c0ce（核心实现）；9a4b4c550376a6462b5611c03eb3cc94a5732b45（验收 runner 对齐）
Mode: legacy renderer + batch coordinate projector；保留 scalar/parity 回滚开关
Files: src/chart-adapter/drawingCoordinateIndex.ts、drawingFrameSnapshot.ts、coordinateBridge.ts、chartInstanceBridge.ts、SingleChartPanes.tsx、DrawingLineageIndex、freehand model、8 类 legacy primitives、对应 tests、scripts/drawing-performance.mjs、.env.example
Tests: npm.cmd run check 通过：architecture migration allowlist=0、双 TypeScript、ESLint、840/840 tests、production build；坐标/lineage/primitive/price parity 定向回归通过
Smoke: production build 下 parity projector 的 64×512 重场景 smoke 通过；execution、instrumentation、restore、geometry projection coverage 全部通过
Perf baseline: docs/perf-baselines/drawing-engine-v2/baseline-after-9a4b4c55-20260714T095757Z-bars1500-dpr1.json；对照 baseline-before-3067e1b5-20260714T083202Z-bars1500-dpr1.json
Perf result: phase1Acceptance=true、phase1Comparison=true、对照上下文全部可比；Chrome/150.0.7871.101，1440×900，DPR 1，1500 bars，59.88Hz；6 场景各 1 warm-up + 5 measured；raw dropped=0、Event Timing 112 samples、diagnostic runs=0、restore failures=0。64×512/32768 点场景 ScriptDuration p95 50.396→8.726ms（下降 82.69%），drawing-main p95 573.3→98.3ms（下降 82.85%）、p99=106.4ms，frame p95/p99=100.1/116.7ms；该 viewport-only 场景 anchorResolveCount p95/max=0/0。
Correctness parity: exact/fractional/source time、time 优先于 stale logical、absolute future time、same-time ordinal、resolved/unresolved lineage span、Renko/Kagi/P&F/Line Break、prepend/gap/interval/chart-type 切换均有回归；normal/log/percentage/indexed/inverted 五种 price mode 中点、端点、handle ≤0.25 CSS px，自由笔 render plan ≤0.5 CSS px，canonical anchor 完全一致。旧 scalar API 仍可用，正常路径为 batch，parity 模式会双算并报告偏差。
Known limitations: Phase 1 只消除坐标解析和验证热点，尚未引入 Phase 2 document store、Phase 3 composite scene/culling、LOD 或 worker；因此最终 V2 target assessment 按预期仍未全过，64×512 场景仍高于最终帧预算。这不是 Phase 1 验收失败。after 报告如实记录 dirty=true，dirty 项仅为三份预先存在且未纳入本任务提交的用户文档。
Rollback verified: VITE_DRAWING_COORDINATE_PROJECTOR=scalar 可恢复旧 scalar 路径，parity 可在线对照；切换 projector 不改 document/persistence 数据。旧快照只读、LWC projection 发布失败时保留上一份 owner，避免半更新坐标状态。
Decision: Phase 1 PASS；正式 after baseline 已冻结；Phase 2 未开始。
~~~

### Phase 2 执行记录

~~~text
Phase: 2 — DrawingDocumentStore、commands 与 codec
Date: 2026-07-14
Commit: 本执行记录所在 checkpoint（refactor(frontend): make drawing document authoritative）
Mode: document authority + legacy primitive renderer；VITE_DRAWING_DOCUMENT_AUTHORITY=legacy 可精确回滚
Files: src/features/drawings/core/、legacy/legacyPrimitiveRenderer.ts、drawingDocumentAuthority.ts、drawingScopePersistence.ts、drawing persistence/lifecycle/controllers、DrawingEngineHost.tsx、chartInstanceBridge.ts、对应 tests、.env.example 与 drawings ownership 文档
Tests: architecture migration allowlist=0、双 TypeScript、ESLint、923/923 tests 通过；drawing 定向测试 276/276 通过；production build 307 modules 通过
Smoke: production document-authority drawing smoke 通过 execution/restore；最新 production build 的 chart-type matrix 与标准 smoke:export 均通过，PNG/JPEG/WebP 3/3、magic/dimensions/pixel signature、drawing reload restore 全部通过，warnings/errors/exceptions 为空
Perf baseline: Phase 1 的 baseline-after-9a4b4c55-20260714T095757Z-bars1500-dpr1.json 继续作为可见 renderer 基线；Phase 2 不以提前完成 Phase 3 scene target 为验收条件
Perf result: 512 entities 下 style/move/reorder command 同步提交 median 0.082ms、p95 0.090ms，低于 1ms Phase 2 command budget；production smoke 的 single-freehand-4096-viewport execution/instrumentation/restore 全部通过
Correctness parity: 9 类 drawing geometry/style、legacy import/export、freehand v1/v2/v3、unknown/malformed/over-budget fail closed、load no-dirty、style/geometry revision 隔离、失败 atomic rollback 均有回归；strict optional fields、raw attached candidate、显式 unconfirmed text credential、第 513 个 text create 拒绝恢复、create/delete attach/detach 补偿、surface dispose/rebuild、main-series replacement credential invalidation/rebind、symbol scope readiness/retry、commit 到 passive-effect stale callback 封窗、mousemove/mouseup 冻结、跨 symbol subpane cleanup 隔离、dirty empty tombstone 也已覆盖。controller 的完成态动作必须携带完整 canonical command payload；legacy primitive 只保留为 renderer 和活动手势草稿，磁盘只接收 document codec 输出。
Known limitations: Phase 3 scene shadow/culling/render plan 尚未开始；legacy per-entity primitives 仍承担可见渲染和活动手势草稿，因此最终 V2 frame/scene 目标按计划尚未达成，不属于 Phase 2 失败。
Rollback verified: 设置 VITE_DRAWING_DOCUMENT_AUTHORITY=legacy 即回到原 legacy adapter；继续读写相同 SavedDrawing[] key/数据，不迁移、不删除本地数据。document 模式的 dirty session 在 host reacquisition 时保留，失败提交恢复 canonical snapshot。
Decision: Phase 2 PASS；独立最终复审无 P0/P1/exit blocker；Phase 3 未开始。
~~~

### Phase 3 执行记录

~~~text
Phase: 3 — Scene shadow、culling 与 render plan
Date: 2026-07-15
Commit: 本执行记录所在 checkpoint（feat(frontend): add shadow drawing scene runtime）
Mode: legacy 可见 renderer + shadow scene；scene-canary/scene 在 Phase 4 可见 primitive 就绪前继续 fail closed 到 legacy
Files: drawingEngineMode.ts、engine/drawingSceneRuntime.ts/drawingSceneRegistry.ts/drawingRenderScheduler.ts/drawingSceneProjector.ts/drawingShadowParity.ts、geometry/drawingBounds.ts、rendering/drawingDisplayList.ts、legacy parity probe、atomic frame/adapter/lifecycle/selection/interaction/perf counters、scripts/drawing-performance.mjs、.env.example 与对应 tests
Tests: npm.cmd run check 通过：architecture migration allowlist=0、双 TypeScript、ESLint、1023/1023 tests、production build 317 modules、git diff --check；scene runtime/scheduler/projector/display-list/parity 定向回归 56/56 通过
Smoke: production build 下 64×512 scene-build margin 三轮 smoke 为 35.0/29.8/39.2ms，优化后正式前复测为 63/70/80 Long Tasks；200 mixed 三轮均为 0；两组 smoke 的 execution、parity、hit coverage、restore 与 diagnostics 均通过
Perf baseline: docs/perf-baselines/drawing-engine-v2/phase3-legacy-2026-07-15.json；docs/perf-baselines/drawing-engine-v2/phase3-shadow-2026-07-15.json；共同 buildInputFingerprint=4aeb3eca5c643b236e9a7897e1b95fbb0065acd4b825c8d03264285df9446c42
Perf result: phase3Acceptance=true、phase3Comparison=true、beforeEligible=true、afterEligible=true、contextComparable=true；Chrome/150.0.7871.101，6 场景各 1 warm-up + 5 measured，共 36/36 runs。legacy→shadow attributable Long Tasks：empty 0→0、single freehand 0→0、64×512/32768 点 373→317、200 mixed 0→0、512 mixed 5→2、active 1→0；所有场景 noNewLongTasks=true。shadowSceneBuildMs 单轮最大值：empty 0、single 6.0、64×512 30.5、200 mixed 3.1、512 mixed 6.1、active 5.0ms，全部 ≤50ms。
Correctness parity: canonical id/z-order、visible set、bbox、handles、hit entity/zone/handle、normalized SavedDrawing 与 unresolved gap 全部通过；非空场景每轮均有实体和 hit 比较，64×512 为 64 entities/32 hits；全部 measured run 的 shadowParityMismatchCount=0、shadowErrorCount=0、shadowMismatchItems=0，restore/diagnostics 全部干净。shadow scene 只读取 authoritative document 与 atomic frame，不 attach canvas、不注册 pointer listener、不写 persistence。
Known limitations: Phase 3 只建立不可见 scene shadow；可见 surface 仍由 legacy per-entity primitives 渲染。单一 DrawingScenePrimitive、首批 line/axis-line/shape 可见迁移、scene hit/selection/drag bridge 与真实 attached-primitive instrumentation 属于 Phase 4，不在本阶段提前切换。
Rollback verified: VITE_DRAWING_ENGINE_MODE=legacy 可停用 shadow；shadow 不改变 SavedDrawing/document 数据、可见 canvas、pointer owner 或 persistence owner。scene build/parity 失败均保留 legacy 可见路径并 fail closed，不需要数据回滚。
Decision: Phase 3 PASS；正式 legacy/shadow 对照、正确性 parity、≤50ms scene build 与 no-new-Long-Task 门全部通过；Phase 4 尚未开始。
~~~

### Phase 4 执行记录

~~~text
Phase: 4 — 单一 DrawingScenePrimitive
Date: 2026-07-15
Commit: 本执行记录所在 checkpoint（feat(frontend): render committed drawings through one scene primitive）
Mode: document authority + scene-canary 可见 composite scene；line/axis-line/shape 归 scene，未迁移 kind 继续归 legacy primitive
Files: rendering/DrawingScenePrimitive.ts/drawingSceneRenderer.ts/drawingSceneMigration.ts/drawingDisplayList.ts、chart-adapter/drawingScenePrimitiveBridge.ts/drawingPrimitiveTypes.ts、engine/drawingSceneProjector.ts/drawingSceneRuntime.ts、legacyPrimitiveRenderer.ts、drawing lifecycle/interaction/selection/erase/keyboard controllers、FreehandDrawingPrimitive.ts、performance counters、scripts/drawing-performance-phase4.mjs/fixtures/runner 与对应 tests
Tests: npm test 1056/1056、npm run test:drawing 391/391、Phase 4 performance gate tests 16/16、核心定向回归 59/59；architecture migration allowlist=0、双 TypeScript、ESLint、production build 321 modules、git diff --check 全部通过
Smoke: headed Chromium + 实际后端在 scene-canary 下创建 line/rectangle/horizontal axis-line，attachedPrimitiveCount 始终为 1；resize、reload、hide/show、clear 与 clear 后 reload 通过，console 0 errors，未出现 scene runtime fault 或 legacy fallback
Perf baseline: output/phase4-acceptance.json（本地原始报告；production build，1440×900，DPR 1，1500 bars，Chrome/150.0.7871.101）
Perf result: phase4Acceptance=true、failureReasons=[]；4 个固定场景各 1 warm-up + 5 measured，共 24/24 runs。纯迁移 64 entities 在 initial/action/reload 均 attached=1；mixed 32 scene + 32 legacy 均 attached=33；1000 crosshair moves 的 scene rebuild=0；viewport requestUpdatePerFrame max=1；64 legacy freehand 的 view-update fan-out gate 通过，attached=65（1 empty scene owner + 64 legacy）。
Correctness parity: immutable render spec 覆盖 line/axis-line/shape 的 stroke、dash、fill、opacity、selection handles 与 DPR；paint extent/viewport culling、axis nearest-hit、canonical z-order interaction、shape resize raw screen box、crosshair above scene 均有回归。scene primitive 不提供 LWC heavy hitTest，交互通过 display-list hit 映射 canonical proxy；同一 entity 只归一个可见 owner。首帧发布、StrictMode effect replay、projection/publish fault、同 binding 恢复与 series generation 采用 fail-closed/transactional 测试覆盖。
Known limitations: hover、实时 drag/live ink、动态 selection overlay 留给 Phase 5；freehand/highlighter 仍是 legacy，通用最终 targetAssessment 的 freehand 重场景仍有 5 个 measured run 未过最终帧/Long Task 目标，属于 Phase 6 的迁移范围，不影响本阶段明确要求的 fan-out gate。混合期跨 scene/legacy owner 的任意物理视觉交错仍受两个 renderer 边界限制，但交互命中已按 canonical z-order 合并。
Rollback verified: VITE_DRAWING_ENGINE_MODE=shadow/legacy 可关闭可见 scene；SavedDrawing/document/codec 不变。scene-canary 只允许在第一次已接受 mutation 前回 legacy；边界后故障保留最后有效 render plan 并原位恢复，禁止双 owner 和静默数据回退。
Decision: Phase 4 PASS；单 surface composite primitive、首批三类可见迁移、所有权/生命周期边界、浏览器功能验收与 Phase 4 正式性能门全部通过；Phase 5 尚未开始。
~~~

### Phase 5 执行记录

~~~text
Phase: 5 — Dynamic Overlay 与 Live Ink
Date: 2026-07-15
Commit: 本执行记录所在 checkpoint（perf(frontend): move live drawing feedback off chart updates）
Mode: document authority + scene-canary + mount-locked interaction overlay；scene/runtime 不可用时 fail closed 到 legacy
Files: chart-adapter main-pane geometry/invalidation；DrawingEngineHost/interaction controller；interaction canvas controllers；document/codec/commands/persistence bridge；scene/legacy renderer；perf counters/runner/probe/tests；CSS/env
Tests: npm run check PASS（architecture 0 allowlist；typecheck；ESLint；1111/1111 tests；production build 326 modules）；npm run test:drawing 427/427；Phase 5 acceptance unit 14/14。
Smoke: headed Chromium 真实 pen + line，reload 后持久化；DPR=1.5 时双 canvas CSS/bitmap 与 public main-pane plot rect 精确一致；console 0 error；formal 5+1 exact handoff 20/20、blank frame 0。
Perf baseline: output/phase4-acceptance.json
Perf result: output/phase5-formal-final.json；5 scenarios ×（1 warmup + 5 measured）PASS；active overlay p95 <= 0.30ms，drawing main p95/p99 <= 0.30/0.90ms，frame p95/p99 <= 16.80/16.80ms，input-to-paint p95/p99 <= 14.40/14.60ms，mouseup p95/p99 <= 4.70/4.70ms，attributable >50ms Long Task = 0；25/25 pointer windows React/LWC update/scene rebuild delta 全 0。
Correctness parity: 64×512/32768-point heavy scene active ink + legal 4096-sample commit；pen/highlighter、drag/resize、selection/hover、eraser、two-point commit/cancel、pointercancel/blur/Escape、DPR/resize、document-first exact ticket handoff 与 reload persistence 均通过。
Known limitations: committed freehand/highlighter 仍由 legacy static renderer 承担，留给 Phase 6；angle/fibonacci/text/position 完整迁移留给 Phase 8。
Rollback verified: VITE_DRAWING_INTERACTION_OVERLAY=legacy 可恢复旧交互 renderer；document/codec 与 static scene 不回滚。
Decision: Phase 5 PASS；Dynamic Overlay、Live Ink、document-first exact handoff 与正式性能门通过；Phase 6 尚未开始。
~~~

### Phase 6 执行记录

~~~text
Phase: 6 — LOD、命中索引、worker 与 latest-wins 背压
Date: 2026-07-15
Commit: 本执行记录所在 checkpoint（perf(frontend): add drawing LOD worker and indexed hit testing）
Mode: document authority + scene-canary + worker raster；worker/OffscreenCanvas 不可用时在同一 scene/document 内回退主线程低 LOD，不恢复 per-drawing primitive
Files: geometry/drawingLod.ts/drawingHitIndex.ts；worker protocol/runtime/worker entry；drawingRasterBackend.ts；scene projector/runtime/renderer/display-list/migration；scene primitive/atomic frame/lifecycle/interaction/live ink；performance counters/fixtures/runner/browser probe/acceptance；mock API、env 与对应 tests
Tests: npm run check PASS（architecture 0 allowlist；双 TypeScript；ESLint；1216/1216 tests；production build 331 modules）；npm run test:drawing 494/494；git diff --check PASS。
Smoke: headed Chrome 创建真实 freehand 并 reload 持久化通过，console 0 error；DPR 1 与 2 的六场景 headless smoke 均 smokeAcceptance=true、execution/fixture/oracle/restore 通过、invalidScenarios=[]。两组单次 smoke 只作功能与 DPR 覆盖，不作为正式 latency 结论。
Perf baseline: Phase 5 的 output/phase5-formal-final.json；Phase 6 正式报告 output/phase6-formal-dpr15-final.json
Perf result: production managed preview，headed Chrome/150.0.7871.124，1440×900，DPR 1.5，59.88Hz，10000 bars，6 scenarios ×（1 warm-up + 5 measured）全部 PASS。freehand 64×512 zoom/pan 的 scene project+paint p95/p99=4.5/10.1ms、frame=17.0/17.1ms、exact max=105.4ms；Renko lineage 为 6.3/14.0ms、17.0/17.1ms、79.3ms；indexed hit 共 5000 queries，p95/p99/max=0/0.1/0.1ms、brute-force mismatch=0；active 4096 finalize 的 drawing main=0.2/0.4ms、scene=4.0/4.2ms、input-to-paint=15.1/15.2ms、mouseup=4.2/4.2ms、worker finalize p95=1.1ms、exact max=48.5ms；main-thread fallback 的 scene=4.7/9.7ms、frame=17.0/17.1ms、exact max=53.8ms；全部场景 drawing-attributable Long Task=0。
Backpressure: 96ms worker fault injection 的五次 measured 均 queue max/current=2/0、in-flight max/current=1/0、jobs/results=98/1、pending drops=57、stale result drops=34–36、stale publish=0，最终 requested/painted stamp 一致。注入下 worker finalize p95=212.2ms、exact=301.1–350.9ms；该故障场景按契约验证 latest-wins 最终收敛，不套正常场景的 120ms exact SLO。
Correctness parity: canonical raw geometry 不被 LOD 覆盖；RDP hierarchy 保留 endpoints/path gaps，并按 0.35/0.75/1.25px 与可见像素预算选择；entity/chunk culling 在 LOD 与 LWC-bound final projection 之前；screen bbox 与 64px uniform-grid segment index 同 render plan 发布。worker patch 先按 immutable entity identity 排除未变化实体，再为真正 upsert 构造 canonical typed buffer；短 segment 使用 tolerance-expanded AABB 保守登记，长 segment 保留 DDA，边界命中与 brute force parity 有回归。Renko lineage exact resolve=6912–7296/run、fallback/unresolved=0；五个 viewport-only 场景 anchorResolveDelta=0；active-finalize 的 769 次解析来自 document mutation/new stroke，不属于 viewport-only。LOD 证据要求 initial/final raw-rendered-ratio 三元组都存在且各自自洽，布尔 invariant 要求两次 observation 都明确为 true；hit oracle 5000/5000 与 brute force 一致；全部 measured run 的 stale publish 与 shadow parity mismatch 均为 0。
Known limitations: 本记录证明 Phase 6 checkpoint，不声称第 7 节全局发布矩阵全部完成；DPR 1/2 目前为 smoke，正式 5+1 仍留给最终全局发布矩阵。IndexedDB/export barrier 属于 Phase 7；angle/fibonacci/text/position 完整迁移属于 Phase 8。
Rollback verified: VITE_DRAWING_RASTER_BACKEND=main-thread 使用相同 scene/document、screen display list 与低 LOD renderer；正式 fallback 场景 exact max=53.8ms，queue/in-flight/stale publish 均为 0。worker backend 的旧 generation、旧 plan 与旧 frame 结果禁止发布并释放资源。
Decision: Phase 6 PASS；LOD、indexed hit、worker latest-wins/backpressure、source-lineage、主线程 fallback、浏览器功能验收与 DPR 1.5 正式性能门全部通过；Phase 7 尚未开始。
~~~

### Phase 7 执行记录

~~~text
Phase: 7 — IndexedDB、兼容迁移与 export barrier
Date: 2026-07-15
Commit: 本执行记录所在 checkpoint（refactor(frontend): persist drawing documents asynchronously）
Mode: v2 IndexedDB document authoritative；feature-owned manifest 只作 lazy-load hint；v2 缺失时一次性内存导入 legacy；scene-canary + interaction overlay + worker raster
Files: persistence/drawingDocumentRepository.ts/legacyDrawingImporter.ts/drawingPersistenceCoordinator.ts/drawingPersistenceCodec.ts；drawings/export/drawingExportBarrier.ts/drawingExportReadiness.ts；drawing loader/scope persistence/lifecycle/interaction/runtime/store/perf counters；export preview/service/runtime；chart surface/SingleChartPanes/DrawingEngineHost；Phase 7 performance scripts 与对应 tests
Tests: npm run check PASS（architecture、typecheck、ESLint、1276/1276 tests、production build 336 modules）；Phase 7 repository/import/coordinator/export barrier/readiness/loader/export target 定向测试 32/32；controller + export barrier 并发回归 34/34；Phase 7 performance script tests 8/8；git diff --check PASS。
Persistence: native IndexedDB 数据库 candlescope-drawings-v2、documents store、scope-keyed atomic put；400ms debounce，per-scope 单一 in-flight + latest pending；ack 精确匹配 revision，失败保留 dirty document 和旧 bytes。symbol switch、visibilitychange、pagehide 与 export 前显式 flush；idle fair-yield 生成 legacy-compatible snapshot，失败不覆盖旧值。
Compatibility: 首读严格 v2-first，只有 v2 missing 才读取 legacy；legacy load 只在内存导入，第一次 mutation 后创建 v2。manifest 缺失/损坏由受控 IDB probe 修复；组件层不拥有存储规则。v1/v2/v3 decoder、损坏/未知版本/超预算 fail-closed 与 v2 命中绕过 legacy 均有回归。
Export barrier: text/freehand/drag 先终态化并 flush exact revision，再等待 exact render plan；清理 selection/hover/live overlay 后等待一帧。chart/main-pane 使用现有 canvas 原子合成锁定像素，page scope 保留 DOM capture；capture 边界立即重验 lease 并恢复 presentation，超时或 scope/revision/plan 漂移明确 fail closed，不输出半更新 scene。lease 期间用户 hide/show 采用 latest-wins 排队，按 capture state、interaction overlay、解锁、pending intent 的顺序恢复；preview freshness key 同时覆盖 document target 与实际绘图可见性。
Smoke: 可见 headed Chrome 的 overlay 模式完成 line、reload、hide-drawings export 后恢复、active freehand export；1x/2x/3x 分别生成 672×498、1344×998、2016×1496 预览，状态均为“保存即此图”；最终 overlay 线段导出再验通过，全局 hide/show 后 preview blob 自动换代且恢复可保存，fresh reload 后 console 0 errors。
Perf result: DPR 1 与 DPR 2 各 5 个正式 measured run 全部 PASS；每轮 native IDB restore 512 entities、manifest repair=true、legacy bypass=true、scene entity count=512。DPR 1 restore 10 chunks、max=0.5ms，persistence p95=1.10ms；DPR 2 restore max=0.60ms，persistence p95=2.00ms；两个 DPR 的 attributable Long Task 均为 0，任一 restore 主线程块远低于 16ms，persistence 远低于 500ms。
Rollback verified: v2 写入不删除 legacy snapshot；旧 build 可继续读取最后成功的兼容 snapshot。删除 v2 DB 不属于自动回滚；legacy interaction/main-thread raster 开关仍可独立回退，document 真值不降级。
Known limitations: legacy-only 用户首次兼容读取仍是一次性 fallback；正式 512-entity 性能门针对目标 v2 IndexedDB restore。page scope 因包含完整 DOM 继续走兼容 capture，并保持同一 barrier/超时/fail-closed 契约。angle/fibonacci/text/position 完整 document/scene/overlay 迁移留给 Phase 8。
Decision: Phase 7 PASS；异步 v2 persistence、受控 legacy migration、manifest repair、生命周期 flush、exact export barrier、浏览器兼容验收与 DPR 1/2 正式性能门全部通过；Phase 8 尚未开始。
~~~
