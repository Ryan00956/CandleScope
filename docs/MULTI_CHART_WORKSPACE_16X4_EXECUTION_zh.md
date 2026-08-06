# CandleScope 单窗口 16 图、四窗口 64 图执行文档

> 状态：`IN_PROGRESS_PHASE_0_COMPLETE`。Phase 0 已完成并通过本节记录的门禁；Phase 1～8 尚未完成。本文状态不代表当前版本已经支持 16/64 图，也不自动授权合并、发布或默认启用。
>
> 起始审查基线：分支 `codex/multi-chart-workspace`，文档起草时 `HEAD=af9233749219f5c0bbc0dd95af2d1f7b3bb9b9f6`（2026-08-06），工作树有 12 个前端布局相关修改。它们已在 Phase 0 前审查、验证并独立冻结为 `035762e8`；Replay 文案基线漂移另行冻结为 `a0129358`。Phase 0 的实际实现基线为 `a012935801c83e583d2e9a53c70ed9112d63582d`。

---

## 1. 执行结论

目标产品合同固定为：

```text
单窗口最多 16 个 Chart Cell
单 Workspace 最多 4 个原生窗口
单应用同时最多 64 个 Chart Cell
```

这个目标可实现，但必须分成两条交付线：

1. **单窗口 16 图**：扩展 Workspace 文档模型、布局编辑、稳定挂载、连接共享、任务调度和单窗口容量门禁。
2. **四窗口 64 图**：新增原生窗口层、跨窗口状态总线、显示器恢复、跨窗口连接/任务治理和最小化降载。

禁止把本项目简化为以下任一种做法：

- 只把 `CHART_CELL_IDS` 从 4 个扩成 16 个；
- 只增加一个 4×4 CSS Grid；
- 用四个互不协调的浏览器窗口冒充正式四屏能力；
- 通过调大线程、缓存或队列上限掩盖重复订阅和冷启动放大；
- 在没有 16/64 图真实浏览器证据前宣称后端“支持 64 图”。

建议工期按一名熟悉仓库的工程师估算：

| 范围 | 预计投入 | 交付含义 |
|---|---:|---|
| Phase 0～5 | 1.5～2.5 周 | 单窗口 16 图达到可发布门槛 |
| Phase 6～8 | 2～4 周 | 原生四窗口、64 图容量与恢复门禁 |
| 合计 | 4～7 周 | 含真实多显示器、冷库、重指标与长稳验证；不含新增交易所协议能力 |

工期是执行量级，不是发布日期承诺。任何上游交易所限制、桌面壳兼容问题或既有基线失败都必须如实进入证据。

---

## 2. 当前真值与已知边界

### 2.1 已具备能力

当前 Workspace 1.0 已具备以下基础：

- 命名 Workspace 的创建、切换、重命名、复制、删除；
- 递归 Split Tree、布局比例、最大化、分割、关闭、拖换；
- Cell 级 session、指标、绘图、价格轴和可见范围隔离；
- Link Group 的市场、周期、十字线、时间锚、日期范围和绘图联动；
- IndexedDB 持久化与 localStorage 降级；
- 同品种 Cell 共享浏览器侧物理 K 线连接；
- 活动 Cell 才开启 Order Book / Trade Flow 重型侧栏能力；
- 活动 Cell 才执行普通后台周期预取。

本文撰写前重新执行以下针对性测试：

```text
WorkspaceLayoutTree
chartWorkspaceEditing
chartWorkspaceLayout
chartWorkspaceStorage
sharedKlineStreamCoordinator
```

结果为 `33/33 passed`。这只证明当前 4 Cell 布局与流共享契约，没有证明 16/64 图容量。

### 2.2 当前硬上限

| 层 | 当前值 | 代码位置 | 影响 |
|---|---:|---|---|
| Workspace Cell | 4 | `frontend/src/features/chart-workspace/chartWorkspaceTypes.ts` | 第五次分割被拒绝 |
| 布局节点 | `2 × cellCount - 1` | `chartWorkspaceLayout.ts` | 当前最多 7 个节点 |
| 布局深度 | 4 | `chartWorkspaceLayout.ts` | 平衡 4×4 可容纳，但任意深链可能被拒绝 |
| 前端单 series bars | 10,000 | `phase1WindowPolicy.ts` | 64 个唯一活动窗口会放大浏览器内存 |
| 后端 K 线缓存 series | 200 | `data_manager/config.py` | 64 图的当前周期和基准周期可能逼近上限 |
| 后端每 series bars | 5,000 | `data_manager/config.py` | 活跃系列内存预算 |
| Backfill 调度并发 | 4 | `backfill_coordinator.py` | 冷启动请求排队 |
| Backfill REST fetch 并发 | 2 | `backfill/config.py` | 空库或缺口场景的上游吞吐边界 |
| 指标线程 | 2 | `backend/app/core/config.py` | 多图重指标冷启动的首要瓶颈候选 |
| 单指标 WS 订阅 | 50 | `backend/app/core/config.py` | 当前前端每 Cell 一条指标 WS，尚未利用单连接多订阅能力 |
| 前端指标缓存 entry | 80 | `indicatorResultCacheStore.ts` | 多图多指标会触发容量压力；活动 lease 可能阻止淘汰 |

### 2.3 “图数”不是后端容量单位

后端管理的是 `SeriesKey`、stream lease、subscriber、backfill 和 indicator job，不存在统一的 `MAX_CHARTS`。

当前每个 Cell 的实时 K 线集合通常为：

```text
trackedIntervals = 当前周期 + 可解析时的 1m 基准周期
```

因此近似容量必须按以下量计算：

```text
logicalCells       = 当前挂载的 Chart Cell 数
uniqueInstruments  = unique(exchange, marketType, symbol)
uniqueSeries       = unique(exchange, marketType, symbol, trackedInterval)
indicatorTargets   = sum(每个 Cell 的可见托管指标数)
physicalUpstreams  = 交易所 adapter 根据 descriptor/multiplex scope 创建的连接数
```

极端情况下，64 个不同品种、当前周期不为 1m，可形成约 128 个实时 series。它低于当前 200 series 静态上限，但没有给 watchlist、预热、自定义周期、其他客户端和恢复任务留下足够余量。

交易所上游还不等价：

- Binance K 线当前为 `path_per_stream`，最坏情况下物理连接接近 native stream descriptor 数；
- OKX 当前按 symbol 建共享 hub，同品种多周期复用，但不同品种仍会扩张连接数；
- 自定义周期可能复用 native base stream，不能用 Cell 数直接推导物理连接数。

所以 Phase 0 必须采集真实 `logical cells → unique series → browser WS → backend lease → upstream WS` 映射，后续所有容量结论都以这条证据链为准。

---

## 3. 产品合同

### 3.1 术语

| 名称 | 含义 |
|---|---|
| Pane | 同一个 Chart Cell 内的主图或指标分窗 |
| Chart Cell | 一个完整、独立的市场/周期/指标/绘图/视口图表 |
| Window | 一个原生桌面窗口，绑定显示器、DPI、bounds 和可见性状态 |
| Workspace | 可保存的窗口集合、Cell、布局树和 Link Group |
| App Instance | 一个桌面应用实例和一套共享后端 sidecar |

### 3.2 数量合同

```text
MAX_CELLS_PER_WINDOW = 16
MAX_WINDOWS_PER_WORKSPACE = 4
MAX_CELLS_PER_APP = 64
```

硬上限只能由代码版本扩大；运行时配置和用户设置只能收紧，不能静默放宽。

超限必须 fail closed：

- 分割到第 17 个 Cell：按钮禁用并显示“当前窗口最多 16 图”；
- 新建第 5 个窗口：拒绝并显示“当前工作区最多 4 个窗口”；
- 恢复损坏或超限文档：保留原始记录，生成诊断，回退到可渲染的安全投影；
- 指标、连接或 backfill 达到预算：明确显示降级/排队状态，不得假装实时。

### 3.3 布局合同

单窗口至少提供以下 preset：

```text
1       单图
2       左右 / 上下
3       主图 + 双确认
4       2×2
6       3×2 / 2×3
8       4×2 / 2×4
9       3×3
12      4×3 / 3×4
16      4×4
custom  任意递归分割，仍受 16 Cell 和深度限制
```

布局编辑、切换 preset、最大化和窗口恢复不能交换 Cell 身份。Cell 的 session、指标、绘图 scope 和视口必须跟随稳定 `cellId`，而不是跟随屏幕位置。

### 3.4 实时语义合同

64 图并不意味着所有任务都以活动图最高频率运行。产品明确使用以下 tier：

| Tier | 对象 | K 线接收 | Canvas 提交 | 指标 preview | 历史/回填优先级 |
|---|---|---|---|---|---|
| `focused` | 当前键盘焦点 Cell | 全量 | rAF 合并，最高优先级 | 开启 | 最高 |
| `visible-primary` | 焦点窗口中其余可见 Cell | 全量 | 合并提交，最多随源频率 | 可配置；默认开启轻量 preview | 高 |
| `visible-secondary` | 其他显示器上可见窗口 | 全量 | 限频合并，不丢 final bar | 默认 closed-bar；允许有限 pinned preview | 中 |
| `hidden` | 被最大化遮挡、切走的 Workspace | 保留共享 store 或按策略释放 | 不渲染 | 停止 | 低 |
| `minimized` | 最小化窗口 | 仅保活必要 stream/store | 不渲染 | 停止 | 暂停 |

任何降频只能合并 forming update，不能丢失 closed/amended bar、回填完成、订阅失败和数据修订。

### 3.5 多窗口合同

正式四屏能力必须满足：

- 一个 Workspace 可以拥有 1～4 个原生窗口；
- 每个窗口有独立 `windowId`、布局树、活动 Cell、bounds、monitor fingerprint、DPI 和最大化状态；
- 一个 App Instance 只启动一个后端 sidecar；
- 同一 Workspace 的窗口通过受控状态总线同步 Link Group 和文档 revision；
- 关闭一个窗口不能停止其他窗口仍持有的 backend stream lease；
- 显示器拔出、顺序改变、DPI 改变后，窗口必须被夹取到仍可见区域；
- 浏览器版可以继续支持单窗口，但不能把 `window.open()` 当成正式桌面恢复方案。

---

## 4. 不可妥协的架构原则

```text
P1 Cell 身份稳定
   布局只引用 cellId；移动、换位、preset 切换不交换 Cell 状态。

P2 单一行情真值
   相同 SeriesKey 使用同一个 SeriesWindowStore；Chart Cell 是消费者，不复制数据所有权。

P3 连接按数据身份复用
   browser/backend/upstream 的连接数由唯一订阅身份决定，不由 React 组件数决定。

P4 前台优先、后台可证明降载
   focused > visible > hidden > minimized；每次降载都必须保留 final/correction 语义。

P5 指标任务有预算
   指标 preview、range compute、线程、WS 订阅和缓存 points 都必须进入诊断与门禁。

P6 持久化可回滚
   schema 升级使用新存储槽；至少两个发布窗口不删除 v5 数据，不让旧 build 覆盖新文档。

P7 多窗口是产品层，不是 CSS 层
   Window 拥有 monitor/bounds/DPI/lifecycle；Workspace 拥有窗口集合；Cell 不感知桌面壳。

P8 所有“支持”都需要容量证据
   单元测试证明契约；真实浏览器/sidecar/upstream 证据证明容量。两者不能互相替代。
```

---

## 5. 目标架构

```mermaid
flowchart TB
    subgraph Desktop["Desktop App Instance"]
        Shell["Native Shell / Window Manager"]
        Bus["WorkspaceBus\nrevision + link events + visibility"]
        W1["Window 1\n≤16 Cells"]
        W2["Window 2\n≤16 Cells"]
        W3["Window 3\n≤16 Cells"]
        W4["Window 4\n≤16 Cells"]
        Shell --> W1
        Shell --> W2
        Shell --> W3
        Shell --> W4
        Bus <--> W1
        Bus <--> W2
        Bus <--> W3
        Bus <--> W4
    end

    subgraph Frontend["Per-window frontend runtime"]
        Scheduler["ChartWorkScheduler"]
        KBroker["Window K-line Broker"]
        IBroker["Shared Indicator Broker"]
        Registry["SeriesWindowRegistry"]
        Cells["Stable Cell Hosts"]
        Scheduler --> Cells
        KBroker --> Registry --> Cells
        IBroker --> Cells
    end

    subgraph Backend["One FastAPI/DataEngine sidecar"]
        BatchWS["Batch K-line WS / subscriptions"]
        DM["DataManager leases + EventBus"]
        BF["Priority/Fair Backfill"]
        IND["Indicator compute/stream"]
        DIAG["Capacity diagnostics"]
        BatchWS <--> DM
        BF --> DM
        IND --> DM
        DM --> DIAG
    end

    subgraph Upstream["Exchange adapters"]
        HUB["Bounded multiplex hubs"]
        REST["Rate-limited history REST"]
    end

    W1 --> Frontend
    W2 --> Frontend
    W3 --> Frontend
    W4 --> Frontend
    KBroker <--> BatchWS
    IBroker <--> IND
    DM <--> HUB
    BF <--> REST
```

### 5.1 Workspace schema v6 方向

建议把固定 tuple/Record 模型改为动态 ID，并把 Window 作为一等实体：

```ts
type ChartCellId = string;
type ChartWindowId = string;

interface ChartWindowState {
  id: ChartWindowId;
  layoutTree: ChartWorkspaceLayoutNode;
  activeCellId: ChartCellId;
  maximizedCellId: ChartCellId | null;
  boundsDip: { x: number; y: number; width: number; height: number } | null;
  monitorFingerprint: string | null;
  dpiScale: number | null;
  windowState: "normal" | "maximized" | "minimized";
}

interface ChartWorkspaceDocumentV6 {
  schemaVersion: 6;
  revision: number;
  activeWindowId: ChartWindowId;
  windows: Record<ChartWindowId, ChartWindowState>;
  cells: Record<ChartCellId, ChartCellState>;
  linkGroups: Record<ChartLinkGroupId, ChartLinkGroupSettings>;
}
```

要求：

- 保留现有 `cell-1`～`cell-4` ID，不重写用户已有 scope；
- 新 Cell 使用持久、不可复用的 opaque ID；关闭后 undo 可恢复同一 ID；
- `layoutTree` parser 接受动态 ID，但必须验证 ID 在 `cells` 中、无重复、节点数和深度受限；
- `revision` 用于跨窗口 CAS/冲突检测；
- v5 首次读取复制到独立 v6 store，v5 原始记录保持只读；
- v6 写入失败不能覆盖最近一份可解析 revision。

### 5.2 稳定 Cell Host

当前递归树直接递归渲染 Cell。扩到 16 图后，布局编辑造成的 React reparent/remount 可能重复创建 Lightweight Charts、指标连接和绘图 runtime。

目标结构：

```text
WorkspaceLayoutGeometry
  -> 根据 Split Tree 计算 leaf rect + split handle rect

WorkspaceCellLayer
  -> 所有 LiveChartCell 作为同一稳定父节点的 keyed siblings
  -> 通过 CSS variables/absolute grid area 投影到 leaf rect

WorkspaceSplitHandleLayer
  -> 只负责编辑交互，不拥有 Cell runtime
```

必须用 profiler/counter 证明 preset 切换、换位、调整比例不会无故 remount 未变化 Cell；不能仅凭 React render 次数推断 DOM/Canvas 是否重建。

### 5.3 连接与任务治理

目标连接层分三层：

```text
Cell logical subscription
  -> per-window broker/shard
  -> backend batch subscription + lease/refcount
  -> exchange adapter bounded multiplex
```

建议新增或演进：

```text
frontend/src/features/market-data/feed/windowKlineStreamCoordinator.ts
frontend/src/features/indicators/sharedIndicatorStreamCoordinator.ts
frontend/src/features/chart-workspace/chartWorkScheduler.ts
backend/app/api/v1/stream_klines_batch.py
backend/app/data_engine/data_manager/capacity.py
```

`/stream/klines_batch` 必须是 additive v2 endpoint，旧 `/stream/klines_multi` 在两个发布窗口内保留。建议控制消息：

```json
{
  "action": "subscribe",
  "request_id": "req-1",
  "subscriptions": [
    {
      "client_id": "cell-id",
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "intervals": ["1m", "15m"]
    }
  ]
}
```

ACK 必须逐订阅返回 accepted/failed/active，不允许一个失败项让整批订阅状态模糊。

指标连接按 window 池化，并按后端 `maxSubscriptions` 分片；每片预留安全余量，不能正好塞满 50。Cell 销毁只取消自己的 `clientId`，不能关闭其他 Cell 共用的 socket。

---

## 6. 容量预算与发布门槛

### 6.1 固定测试环境

Phase 0 必须记录一台固定基准机：

- CPU 型号、核心数；
- RAM；
- GPU 与驱动；
- Windows 版本；
- Chrome for Testing/WebView2/桌面壳版本；
- 屏幕分辨率、DPI、刷新率和显示器数量；
- Node/Python 版本；
- 后端 DB 路径、是否空库、数据范围和 SHA-256；
- 交易所、market type、symbols、intervals；
- 指标集合和参数。

基准机变化后不能直接把新旧数字做严格回归比较。

### 6.2 场景矩阵

| ID | 窗口/Cell | 市场组合 | 指标 | 数据状态 | 目的 |
|---|---|---|---|---|---|
| S1 | 1×16 | 同品种同周期 | 无 | 热库 | 验证共享 store/连接和纯渲染 |
| S2 | 1×16 | 同品种 8～16 周期 | 无 | 热库 | 验证 interval union 与 adapter multiplex |
| S3 | 1×16 | 16 个不同品种 | 无 | 热库 | 单窗口最坏 K 线 fan-out |
| S4 | 1×16 | 16 个不同品种 | 每图 2 个 builtin | 热库 | 常规指标容量 |
| S5 | 1×16 | 16 个不同品种 | 每图 1 个重 hosted/Pyne | 热库/冷库 | 指标线程和 range compute |
| C1 | 1×16 | 16 个不同品种 | 每图 2 个 | 空库 | backfill、公平性、上游限流 |
| W1 | 4×16 | 64 图、重复品种为主 | 无 | 热库 | 跨窗口共享与渲染 |
| W2 | 4×16 | 64 个不同品种 | 无 | 热库 | K 线最坏容量 |
| W3 | 4×16 | 64 个不同品种 | 每图 2 个 builtin | 热库 | 正式 64 图门禁 |
| F1 | 4×16 | W3 | 同 W3 | 运行中断网/恢复 | 重连风暴与状态一致性 |
| F2 | 4×16 | W3 | 同 W3 | sidecar 重启 | lease/ACK/窗口恢复 |
| F3 | 4×16 | W3 | 同 W3 | 拔出显示器 | bounds/DPI/窗口回收 |

### 6.3 初始门槛

Phase 0 先采基线；若真实基线证明以下阈值不合理，只能在 Phase 0 文档评审中修改，后续 Phase 不得为通过测试临时放宽。

| 指标 | 单窗口 16 图门槛 | 四窗口 64 图门槛 |
|---|---:|---:|
| React/runtime error | 0 | 0 |
| 订阅静默失败 | 0 | 0 |
| closed/amended bar 丢失 | 0 | 0 |
| 同一订阅身份重复 backend lease | 0 | 0 |
| 同一 adapter scope 重复 upstream descriptor | 0 | 0 |
| 热库全部 Cell 可用 p95 | ≤ 3 s | ≤ 8 s |
| 前台输入响应 p95 | ≤ 100 ms | ≤ 150 ms |
| >50 ms 浏览器 long task | ≤ 5/min | ≤ 15/min，全局；焦点窗口 ≤ 5/min |
| 后端 event-loop lag p99 | ≤ 50 ms | ≤ 100 ms |
| 30 分钟 JS heap 增长 | ≤ 15%，且无单调增长 | ≤ 20%，且无单调增长 |
| 1 小时后端 private bytes 增长 | ≤ 15%，且到达平台期 | ≤ 20%，且到达平台期 |
| 单 series bars | ≤ `MAX_SERIES_BARS` | ≤ `MAX_SERIES_BARS` |
| forming update outbox overflow | 0；允许同 key replace | 0；允许同 key replace |
| 最小化窗口 Canvas/indicator preview | 0 | 0 |

空库场景必须分别报告：

```text
browser first usable
HTTP 请求排队
SQLite query/write
backfill coordinator wait
exchange REST admission/wait
真实 upstream download
indicator range compute
```

不能把外网下载时间混成一个“页面加载总耗时”后归咎于浏览器。

### 6.4 连接门槛

最终证据必须同时记录：

```text
logical chart subscriptions
frontend logical K-line subscriptions
browser physical K-line WebSockets
browser indicator WebSockets
backend DataManager leases
backend active SeriesKey
exchange physical WebSockets
exchange REST in-flight / waiting
```

目标不是盲目追求一条连接，而是：

- 同一身份绝不重复；
- 连接数与 unique descriptor/multiplex shard 成正比，不与 Cell 数直接成正比；
- 每个 shard 有显式上限、重连退避和逐项 ACK；
- 达到上限时拒绝新增项并保留已运行项。

---

## 7. 分阶段执行

```text
Phase 0  冻结合同、当前基线和容量证据工具
Phase 1  Workspace schema v6、动态 Cell/Window ID、双槽迁移
Phase 2  单窗口 16 Cell 布局、稳定挂载和密度适配
Phase 3  每窗口 K 线/指标 broker 与 ChartWorkScheduler
Phase 4  后端批量订阅、容量诊断、backfill 公平性与上游去重
Phase 5  单窗口 16 图真实验收与默认关闭发布候选
Phase 6  原生多窗口壳、单 sidecar、显示器/DPI 恢复
Phase 7  跨窗口 WorkspaceBus、64 Cell 调度与故障恢复
Phase 8  64 图终验、长稳、回滚演练和发布切换

严格依赖：0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
```

每个 Phase 必须独立提交，包含：代码、测试、machine-readable evidence、本文勾选状态和回滚说明。禁止把 Phase 1～8 压成一个不可审查的大提交。

---

## Phase 0：合同、基线与证据工具

### 目标

不改变运行行为，冻结当前 1/2/4 Cell 真值，建立之后判断 16/64 图是否真的可用的同一把尺子。

### 任务

- [x] 0.1 分类当前工作树 12 个布局修改，明确哪些属于 Workspace 编辑能力，哪些尚未验证。
- [x] 0.2 记录当前完整 Git base、Node/Python/浏览器版本和固定硬件 profile。
- [x] 0.3 新增 `frontend/scripts/multi-chart-capacity.mjs`，支持 1/2/4/8/16 Cell 参数化运行。
- [x] 0.4 新增后端只读 capacity snapshot，聚合 DataManager、EventBus、backfill、executor、indicator 和 exchange hub 诊断。
- [x] 0.5 建立 `candlescope.multi-chart.capacity/1` evidence schema。
- [x] 0.6 采集当前 1/2/4 Cell 的 S1～S5 可运行子集，保存浏览器 trace、截图和 JSON。
- [x] 0.7 记录全量测试当前通过数和所有既有失败，不把基线失败归因于本项目。

建议 evidence 位置：

```text
docs/perf-baselines/multi-chart-workspace/
  phase0-1cell-YYYYMMDD.json
  phase0-2cell-YYYYMMDD.json
  phase0-4cell-YYYYMMDD.json
  hardware-profile-YYYYMMDD.json
```

### 验收

- [x] 现有运行行为不变；
- [x] 1/2/4 Cell 能生成同 schema 可比较证据；
- [x] evidence 能区分 browser WS、backend lease 和 exchange upstream；
- [x] targeted Workspace/stream 测试不低于本文记录的 `33/33`；
- [x] 全量基线和既有失败被准确记录。

### Phase 0 实施记录（2026-08-06）

1. 起始的 12 个修改全部属于既有四 Cell Workspace 的编辑能力：布局锁、递归 split handle 禁用、bounded undo/redo、快捷键/菜单/样式、存储默认值和对应测试；它们不解除 `ChartCellId` 四值边界，也不把 schema v5 提升到 16 Cell。验证结果为 Workspace 定向 `60/60`，提交为 `035762e8`。
2. 起始全量前端门禁暴露一个与多图无关、且在干净基线可复现的 Replay launcher 文案断言漂移；只同步测试合同后以 `a0129358` 独立提交，Phase 0 从该提交开始。
3. 固定 profile 为 i9-13900HX（32 logical cores）、约 31.7 GiB RAM、RTX 4080 Laptop GPU、Windows `10.0.26200`、Chrome `151.0.7922.71`、Node `v22.14.0`、Python `3.12.7`。当前逻辑显示器为 1 个，浏览器 viewport `1707×1067`、DPR `1.5`；活动显示链路报告 `2560×1600@240Hz`。完整数据见 `hardware-profile-20260806.json`。
4. S1 热库真实浏览器采集的 1/2/4 Cell 均为 `pass`：console/runtime/network error 均为 0，canvas remount 为 0；同品种同周期均映射为 1 条浏览器 K 线 WS、1 个 backend active series、1 个 backend direct lease。exchange physical WS 独立报告为 2（K 线与市场深度），没有把上游物理连接误当成 Cell 数。
5. 8/16 参数在 Phase 0 明确生成 `unsupported` 并以退出码 2 fail-closed，因为当前 schema v5 产品上限仍是 4；这验证了 harness 参数合同，不虚报产品已支持 8/16。Phase 1～2 完成前不得把此结果改成 pass。
6. 前端完整 `npm run check` 通过：architecture、plugin boundary、TypeScript、ESLint、`2990/2990` 测试和 production build 全部成功。受影响后端定向测试为 `21/21`。
7. 后端全量基线为 `3094 passed, 31 failed, 8 errors, 5 warnings`。全部 39 个非通过节点已在干净 `a0129358` worktree 中逐项复跑并得到完全相同的 `31 failed, 8 errors`：其中 38 个是既有 plugin-platform/marketplace 冻结合同或 release evidence 漂移，1 个是既有 Replay 错误码断言漂移。因此它们被记录为 pre-existing baseline，不归因于 Phase 0，也不在本阶段跨域修改。

机器可读证据：

- `docs/perf-baselines/multi-chart-workspace/capacity-evidence.schema.json`
- `docs/perf-baselines/multi-chart-workspace/hardware-profile-20260806.json`
- `docs/perf-baselines/multi-chart-workspace/phase0-{1,2,4}cell-20260806.json`
- `docs/perf-baselines/multi-chart-workspace/phase0-test-baseline-20260806.json`

原始 Chrome trace、截图和独立 backend snapshot 保存在忽略版本控制的 `output/playwright/multi-chart-capacity/`；可提交 JSON 中保留其绝对路径和证据摘要。

### 回滚

删除 Phase 0 新增诊断、脚本和证据即可；不触碰 Workspace 存储和用户数据。

---

## Phase 1：Workspace schema v6 与动态身份

### 目标

解除固定四 Cell 类型边界，为 16 Cell 和四窗口建立可迁移、可回滚的数据模型，但 UI 仍保持最多 4 Cell。

### 任务

- [ ] 1.1 把 `ChartCellId` 从四值 union 改为受验证的 opaque string。
- [ ] 1.2 `cells`、layout parser、editing、undo/redo、link coordinator 和 drawing scope 全部改为动态 ID。
- [ ] 1.3 新增 `ChartWindowId`、`windows`、`activeWindowId` 和 document `revision`。
- [ ] 1.4 将当前单窗口文档迁入固定 `main-window`，保留已有 Cell ID 和绘图/可见范围 scope。
- [ ] 1.5 新 Cell ID 不复用已关闭 ID；undo/redo 恢复原 ID 和完整 Cell snapshot。
- [ ] 1.6 新建 v6 IndexedDB store；首次读取复制 v5，后续不覆盖 v5。
- [ ] 1.7 parser 对重复 ID、悬空 ID、超节点、超深度、超窗口/Cell fail closed，并保留诊断。
- [ ] 1.8 增加硬上限常量，但用默认关闭 flag 把可见上限仍收紧为 4。

建议 flags：

```text
MULTI_CHART_16_ENABLED=0
MULTI_WINDOW_ENABLED=0
MULTI_CHART_64_ENABLED=0
```

环境变量只能从硬上限向下收紧；不能把 16/4/64 放宽。

### 测试

- v1～v5 → v6 迁移；
- v5 store 保留且不被 v6 写入覆盖；
- 动态 Cell split/close/swap/reset/undo/redo；
- 16 个唯一 ID，关闭再新增不复用；
- 重复/悬空/超限文档 fail closed；
- drawing/visible-range/indicator scope 迁移不变；
- revision CAS 和冲突拒绝。

### 验收

- [ ] flag 关闭时 UI 和当前 4 Cell 行为不变；
- [ ] v5 用户数据原样保留；
- [ ] v6 可表达 4 window × 16 Cell，但尚不创建额外窗口；
- [ ] typecheck、lint、architecture、plugins、targeted、全量和 build 完成。

### 回滚

关闭新 flags 并回退代码。旧 build 继续读取未修改的 v5 store；v6 store 保留只读，不删除。

---

## Phase 2：单窗口 16 Cell 与稳定挂载

### 目标

实现真实 4×4 和任意最多 16 Cell 的单窗口布局，同时避免布局编辑造成无关 Chart runtime 重建。

### 任务

- [ ] 2.1 新增 6/8/9/12/16 preset，并由一个可测试的矩阵/递归树生成器生成。
- [ ] 2.2 `firstAvailableChartCellId` 改为 ID factory + capacity check。
- [ ] 2.3 引入 `WorkspaceLayoutGeometry`，输出 leaf/split rect。
- [ ] 2.4 引入稳定 `WorkspaceCellLayer`；Cell 作为稳定 keyed sibling，不由递归 DOM 位置拥有 runtime。
- [ ] 2.5 split handle 使用独立 overlay，锁定、拖动、键盘和触摸行为保持可访问。
- [ ] 2.6 用 ResizeObserver 定义密度档：完整 header、紧凑 header、极简状态；功能不因窄 Cell 静默消失。
- [ ] 2.7 最大化时暂停被遮挡 Cell 的 Canvas/indicator preview，保留共享 store 和可恢复状态。
- [ ] 2.8 切换 preset、换位和调整 ratio 不重建未变化 Cell 的 market/indicator/drawing runtime。
- [ ] 2.9 添加 4K、1440p、1080p 的 16 Cell 可用性检查；低分辨率明确提示空间不足，不强行挤压到不可操作。

### 测试

- 每个 preset 的 leaf 数、唯一 ID 和矩形无重叠；
- 16 Cell split/close/undo/redo；
- stable mount counter；
- 最大化/还原不丢 session、指标、绘图和视口；
- 1600px、2560px、3840px 响应式结构；
- 键盘 focus 和 ARIA 顺序与视觉顺序一致；
- 第 17 个 Cell 明确拒绝。

### 验收

- [ ] `MULTI_CHART_16_ENABLED=1` 时可创建、保存、刷新恢复 4×4；
- [ ] 16 Cell 不要求每次布局编辑重连 K 线或指标；
- [ ] 第 17 个 Cell fail closed；
- [ ] 无 React key、hook、Canvas attach/detach 错误。

### 回滚

关闭 `MULTI_CHART_16_ENABLED` 后只投影前四个可见 Cell；v6 文档和其余 Cell 状态保留，不删除。

---

## Phase 3：每窗口 Broker 与 ChartWorkScheduler

### 目标

让 16 个 Cell 共享连接、store、指标 socket 和任务预算，避免“16 个完整 App runtime”并排运行。

### 任务

- [ ] 3.1 将现有 `SharedKlineStreamCoordinator` 升级为 window broker，公开 logical/physical/interval-union diagnostics。
- [ ] 3.2 确认相同 SeriesKey 的 `SeriesWindowStore`、HTTP in-flight 和 gap repair 被共享，不只共享 WebSocket。
- [ ] 3.3 新增 `SharedIndicatorStreamCoordinator`，按后端 `maxSubscriptions` 安全分片。
- [ ] 3.4 指标 `clientId` 加入 `workspaceId/windowId/cellId/indicatorId`，防止跨窗口冲突。
- [ ] 3.5 新增 `ChartWorkScheduler`，统一管理 focused/visible-secondary/hidden/minimized tier。
- [ ] 3.6 forming K 线和指标 preview 使用 rAF/时间片合并；final/amended 不可丢。
- [ ] 3.7 当前 `ForegroundPreloadGate` 扩展为窗口级公平队列，不能让第一个 Cell 长期饿死其余 Cell。
- [ ] 3.8 指标 range、初始 history、load-more 和普通 prefetch 使用不同 lane。
- [ ] 3.9 diagnostics 输出每 Cell/tier 的 pending、dropped/replaced、last commit 和 queue wait。

### 测试

- 16 个同品种同周期只有一个 window K 线 physical entry；
- 同品种多周期正确 union，单 Cell 退订不影响其他 Cell；
- 指标 broker 分片、ACK、重连、局部取消；
- forming replace 与 final 不丢；
- tier 切换、最大化、窗口 visibility；
- 公平队列无 starvation；
- cleanup 后无 timer/socket/subscriber 残留。

### 验收

- [ ] S1 的 browser K 线 physical WS 不随 16 Cell 增长；
- [ ] 每个有指标的 Cell 不再默认拥有独立指标 WS；
- [ ] hidden/minimized 的 Canvas 和 preview 工作为 0；
- [ ] 任何降载都不改变 closed/amended 数据语义。

### 回滚

保留当前 per-Cell runtime 实现作为一个发布窗口内的默认关闭 fallback。回滚只切 broker/scheduler flag，不迁移用户数据。

---

## Phase 4：后端批量订阅、容量治理与上游去重

### 目标

让后端对 16/64 图负载有显式合同、逐项 ACK、租约去重、公平 backfill 和可观测上游连接，而不是依赖“目前没有 max”碰运气。

### 任务

- [ ] 4.1 新增 additive `/api/v1/stream/klines_batch`；支持一条 client socket 管理多个 instrument/interval。
- [ ] 4.2 每个 subscription 使用稳定 client ID，subscribe/unsubscribe/update 都逐项 ACK。
- [ ] 4.3 限制单 client series、单 series intervals、总 logical subscription 和 outbox；上限写入 capabilities。
- [ ] 4.4 DataManager lease 保持 `SeriesKey + consumer_id` 幂等；重复 subscribe 不增加重复 consumer。
- [ ] 4.5 客户端断开时释放自己的 lease，不误停其他窗口、watchlist、指标或插件 consumer。
- [ ] 4.6 capacity diagnostics 增加 logical clients、leases、active series、EventBus subscribers、queue/outbox 和 physical upstream。
- [ ] 4.7 BackfillCoordinator 加入 app/window/cell/reason priority 与公平性；不先调大并发。
- [ ] 4.8 对 Binance/OKX K 线做真实 multiplex scope 审计；只有协议与官方限制证明安全时才合并跨 symbol hub。
- [ ] 4.9 adapter hub 分片、订阅上限、重连退避和失败隔离进入测试；不能无限塞入单连接。
- [ ] 4.10 指标 executor、range cache 和 WS subscription diagnostics 纳入同一 capacity snapshot。

建议 hard ceilings（最终值由 Phase 0 证据冻结）：

```text
KLINE_BATCH_MAX_SERIES_PER_CLIENT
KLINE_BATCH_MAX_INTERVALS_PER_SERIES
KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS
KLINE_BATCH_OUTBOX_SIZE
KLINE_APP_MAX_ACTIVE_SERIES
INDICATOR_APP_MAX_ACTIVE_TARGETS
```

### 测试

- 批量 subscribe/update/unsubscribe 与逐项部分失败；
- 相同 consumer 重放幂等；
- 多窗口共用 SeriesKey 的 lease/refcount；
- client 崩溃清理；
- outbox forming replace/final ordering；
- 64/128 logical series 的容量拒绝边界；
- backfill priority/fairness/rate-limit wait；
- exchange hub shard/reconnect/partial failure；
- diagnostics 为常量大小摘要，详细列表有分页/上限。

### 验收

- [ ] S1/S2/S3 的每层连接计数都能解释；
- [ ] 同一订阅身份没有重复 upstream；
- [ ] 达到硬上限时新增订阅失败，已运行订阅继续；
- [ ] 冷启动不会因盲目加并发突破交易所额度；
- [ ] 旧 `/stream/klines_multi` 回归保持通过。

### 回滚

关闭 batch endpoint flag，前端退回旧 endpoint。新 diagnostics 可保留；lease 数据是进程内状态，不做持久化迁移。

---

## Phase 5：单窗口 16 图发布门

### 目标

用真实浏览器和真实 sidecar 证明 16 图，不再以静态代码推断容量。

### 任务

- [ ] 5.1 跑 S1～S5、C1 全矩阵，冷库使用真正空数据库。
- [ ] 5.2 对每个场景采集 trace、截图、Network、heap、backend diagnostics、SQLite/backfill 和 upstream 计数。
- [ ] 5.3 运行 1 小时 16 图 soak；包含切周期、换品种、拖布局、最大化、指标增删和重连。
- [ ] 5.4 检查浏览器 profiler：React render、DOM commit、Canvas remount 分开记录。
- [ ] 5.5 检查 16 图下 drawing、crosshair、date range、link role 和导出边界。
- [ ] 5.6 固化 release evidence 和已知限制。

### 验收

- [ ] §6 的单窗口门槛全部 PASS；
- [ ] 16 图热库和空库结果分开报告；
- [ ] 无 connection/backfill/indicator 风暴；
- [ ] 关闭 flag 可恢复 4 图，v6 数据不丢；
- [ ] `MULTI_CHART_16_ENABLED` 在通过 release review 前仍默认 `0`。

### 回滚

运行时关闭 16 图 flag；旧四图路径和 v5 数据仍可用。回滚演练必须真实执行一次并保存证据。

---

## Phase 6：原生多窗口与显示器恢复

### 目标

建立真正的 Window 层：一个 App Instance、一个 sidecar、最多四个原生窗口，可跨显示器保存和恢复。

### 前置决策门

先做最小桌面 spike，对 Tauri 2、Electron 或现有宿主候选进行同一套验证。不得仅按安装包大小选型。

Spike 必须证明：

- 现有 Lightweight Charts、绘图、指标、右侧 rail 和导出可用；
- 4 个窗口可共用一个 Python sidecar；
- 第二/第三/第四显示器可创建、移动、关闭和恢复；
- 100%/125%/150%/200% DPI 坐标正确；
- 最小化/隐藏事件可靠；
- 崩溃后不会遗留 sidecar 或子进程；
- 打包、升级和日志位置可诊断。

### 任务

- [ ] 6.1 建立 `DesktopWindowManager` 抽象，Web 单窗口实现和 Native 多窗口实现共用前端合同。
- [ ] 6.2 单实例锁和单 sidecar 生命周期由 shell 主进程拥有。
- [ ] 6.3 每个原生窗口通过 `windowId` 打开同一 Workspace 的局部投影。
- [ ] 6.4 bounds 使用 DIP 保存；恢复时根据 monitor fingerprint、work area 和当前 DPI 转换。
- [ ] 6.5 显示器缺失时按主屏可见区域夹取，不能恢复到屏幕外。
- [ ] 6.6 窗口创建/关闭使用 document revision CAS；失败不留下孤儿窗口记录。
- [ ] 6.7 close/minimize/focus/visibility 事件进入 `ChartWorkScheduler`。
- [ ] 6.8 浏览器版保持单窗口且明确标注多窗口能力不可用。

### 测试

- 1～4 window 创建/关闭/恢复；
- 多 DPI 和负坐标显示器；
- 拔出显示器、改变主屏、改变缩放；
- sidecar 启动失败、窗口崩溃、主进程退出；
- 单实例重复启动；
- offscreen bounds 修复；
- v6 revision 并发写入。

### 验收

- [ ] 四个原生窗口可分别放到四个显示器；
- [ ] 重启后全部恢复到可见区域；
- [ ] 始终只有一个 sidecar；
- [ ] 关闭一个窗口不影响其他窗口的数据 lease；
- [ ] desktop shell 选型有真实 spike evidence。

### 回滚

关闭 `MULTI_WINDOW_ENABLED` 后只打开 `main-window`。其他窗口状态保留在 v6 文档中，不删除；sidecar 继续走原单窗口生命周期。

---

## Phase 7：WorkspaceBus 与 64 Cell 调度

### 目标

让四个窗口成为同一个 Workspace，而不是四份互相覆盖的本地状态；同时把 64 Cell 的渲染、指标和历史任务控制在预算内。

### 任务

- [ ] 7.1 定义 `WorkspaceBus`：document patch、revision、link event、window visibility、focus 和 health。
- [ ] 7.2 Native 使用受控 IPC；Web fallback 可使用 BroadcastChannel，但不是桌面唯一实现。
- [ ] 7.3 所有持久化写入经过单 writer 或 revision CAS，冲突返回可诊断结果，不采用 last-write-wins 静默覆盖。
- [ ] 7.4 Link Group 跨窗口同步 market/interval/crosshair/timeAnchor/dateRange/drawings，并保留 role 方向。
- [ ] 7.5 高频 crosshair 事件限频且不持久化；session/layout 变更持久化。
- [ ] 7.6 全应用最多允许 4 个 focused/pinned preview lane；超出时 UI 明确要求取消 pin。
- [ ] 7.7 其他可见窗口 K 线 forming update 合并提交，final/amended 立即提交。
- [ ] 7.8 hidden/minimized 窗口暂停 Canvas、preview indicator、普通 prefetch；恢复先从共享 store 首帧，再补缺口。
- [ ] 7.9 连接/指标/backfill 预算按 app → window → cell 分配，窗口不能互相饿死。
- [ ] 7.10 窗口崩溃后清理 consumer，并允许原 `windowId` 恢复。

### 测试

- 跨窗口 link role 和环路抑制；
- revision 冲突、重放和断线恢复；
- crosshair 事件风暴不会写存储；
- 4 window 公平调度；
- minimize/restore 任务为 0/恢复；
- pinned preview 上限；
- 窗口崩溃 lease 清理；
- 64 Cell 不重复创建同一 store/indicator target。

### 验收

- [ ] 四窗口编辑同一 Workspace 无丢更新；
- [ ] W1/W2 连接计数符合 unique identity；
- [ ] 最小化窗口无 Canvas/preview 活动；
- [ ] 恢复窗口不先显示空图再全量重拉；
- [ ] 64 Cell 超限新增被明确拒绝。

### 回滚

关闭 `MULTI_CHART_64_ENABLED`，每窗口最多 16 但应用只启用主窗口；v6 多窗口记录保留。

---

## Phase 8：64 图终验、长稳与发布

### 目标

在四个真实显示器、一个真实 sidecar 和真实浏览器/桌面壳下完成最终容量、恢复和回滚门禁。

### 任务

- [ ] 8.1 跑 W1～W3、F1～F3 完整矩阵。
- [ ] 8.2 运行 4 小时 4×16 soak，记录 heap/private bytes、CPU、GPU、event-loop lag、queue、WS 和 reconnect。
- [ ] 8.3 执行交易所断线、代理失败、HTTP 429、sidecar 重启和单窗口崩溃演练。
- [ ] 8.4 执行显示器拔插、DPI 改变、窗口越界和应用重启恢复演练。
- [ ] 8.5 执行三层 flag 回滚：64 → 16 → 4，并证明 Workspace 数据未删除。
- [ ] 8.6 生成 machine-readable release evidence、支持矩阵、已知限制和回滚 runbook。
- [ ] 8.7 全量前后端、架构、插件、构建、桌面安装包和 fresh-process 验证全部完成。

### 最终发布条件

- [ ] §6 的 64 图门槛全部 PASS；
- [ ] 4 小时没有单调内存增长、连接增长或 subscriber 残留；
- [ ] 0 个 closed/amended bar 丢失；
- [ ] 0 个静默订阅/指标失败；
- [ ] 真实回滚恢复 16/4 图且不删除 v6/v5 数据；
- [ ] 默认 flag 的切换经过独立 release review；
- [ ] 文档只宣称实际通过的交易所、指标类型、硬件 profile 和显示器组合。

### 回滚顺序

```text
1. MULTI_CHART_64_ENABLED=0     -> 禁止 4×16，保留单窗口 16
2. MULTI_WINDOW_ENABLED=0       -> 只打开 main-window
3. MULTI_CHART_16_ENABLED=0     -> UI 回到最多 4 Cell
4. K-line batch/broker flag=0   -> 回到旧 klines_multi/per-Cell 兼容路径
5. revert 对应 Phase 提交       -> v5/v6 store 均保留，不做数据删除
```

---

## 8. 测试与证据要求

### 8.1 每阶段全局命令

```powershell
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run check:architecture
npm --prefix frontend run check:plugins
npm --prefix frontend test
npm --prefix frontend run build
python -m pytest backend/tests -q
```

若全量测试存在既有失败，必须同时提供：

- 当前分支准确失败；
- 选定基线分支/父提交对照；
- 失败是否与本 Phase 相关的证据；
- 不得把“主分支也失败”改写成“全量通过”。

### 8.2 Machine-readable evidence 最小字段

```json
{
  "schemaVersion": "candlescope.multi-chart.capacity/1",
  "git": { "commit": "...", "dirty": true },
  "hardware": { "profileSha256": "sha256:..." },
  "scenario": { "id": "W3", "windows": 4, "cells": 64 },
  "data": { "databaseState": "warm", "datasetSha256": "sha256:..." },
  "frontend": {
    "heap": {},
    "longTasks": {},
    "reactCommits": {},
    "canvasRemounts": 0,
    "klineWebSockets": 0,
    "indicatorWebSockets": 0
  },
  "backend": {
    "activeSeries": 0,
    "streamLeases": 0,
    "eventLoopLag": {},
    "privateBytes": {},
    "backfill": {},
    "indicatorExecutor": {}
  },
  "upstream": { "physicalWebSockets": 0, "httpRequests": 0 },
  "result": "pass"
}
```

禁止手工填写 `pass`。Gate 脚本必须根据冻结阈值计算结果，并保留原始指标。

### 8.3 截图不替代运行证据

每个关键 Phase 至少保留：

- 一张完整窗口截图；
- 一份 browser trace；
- 一份 capacity JSON；
- 一份后端 diagnostics snapshot；
- 一份测试输出摘要；
- 一份 Git/status/flags/ports 记录。

截图证明“看得见”，不能证明连接去重、无数据丢失或长稳通过。

---

## 9. 建议提交与合并顺序

| PR/提交 | 内容 | 默认行为变化 | 可独立回滚 |
|---|---|---|---|
| PR-00 | 文档、Phase 0 harness、evidence schema | 否 | 是 |
| PR-01 | schema v6、动态 Cell/Window ID、双槽迁移 | flag off | 是 |
| PR-02 | 16 Cell preset、稳定 host、密度适配 | flag off | 是 |
| PR-03 | window K-line/indicator broker、scheduler | flag off | 是 |
| PR-04 | backend batch WS、capacity、fair backfill | endpoint off | 是 |
| PR-05 | 16 图 gate、回滚证据、候选开关 | 审核后启用 | 是 |
| PR-06 | desktop shell/window manager spike 与实现 | flag off | 是 |
| PR-07 | WorkspaceBus、跨窗口 link、64 调度 | flag off | 是 |
| PR-08 | 64 图 release gates、runbook、默认切换 | 审核后启用 | 是 |

在当前混合工作树中，提交必须使用显式 pathspec。不得 `git add -A` 把无关修改带入某一 Phase。

---

## 10. 完成定义

### 单窗口 16 图完成

- [ ] Workspace schema v6 可回滚迁移；
- [ ] 单窗口可创建、保存、恢复、编辑 16 Cell；
- [ ] 第 17 Cell fail closed；
- [ ] 连接/store/指标任务不按 Cell 盲目复制；
- [ ] S1～S5、C1 与 1 小时 soak 通过；
- [ ] 16 → 4 回滚真实通过；
- [ ] 支持声明与 evidence 一致。

### 四窗口 64 图完成

- [ ] 四个原生窗口、一个 sidecar；
- [ ] bounds/monitor/DPI 恢复通过；
- [ ] WorkspaceBus 无静默覆盖；
- [ ] 64 Cell 任务和连接遵守 budget；
- [ ] W1～W3、F1～F3 与 4 小时 soak 通过；
- [ ] 64 → 16 → 4 回滚真实通过；
- [ ] v5/v6 用户数据均未删除；
- [ ] 发布清单、支持矩阵、已知限制和 runbook 完整。

在以上项目全部完成前，只能分别表述为：

```text
“已有单屏 4 图基础能力”
“16 图处于实现/验证阶段”
“四屏 64 图尚未发布支持”
```
