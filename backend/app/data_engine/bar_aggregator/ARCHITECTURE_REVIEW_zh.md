# Bar Aggregator 五层架构评审与修改建议

本文只讨论 `backend/app/data_engine/bar_aggregator` 模块，以及它和 `DataManager`、`BackfillEngine`、旧 `services/kline_aggregator.py` 的边界关系。

目标是把三件事说清楚：

1. 理论上五层架构应该是什么样。
2. 现在代码实际是什么样。
3. 当前有哪些职责越界、重复和臃肿点，以及建议如何调整。

---

## 1. 模块定位

`bar_aggregator` 应该是 CandleScope 后端的数据加工层。

它位于：

```text
ingestion / backfill
      |
      v
bar_aggregator
      |
      v
data_manager / cache / storage / websocket / indicator
```

它的理想职责是：

- 接收实时 `MarketEvent`。
- 接收历史 `FetchedBar` 或等价历史 bar 数据。
- 把不同来源统一转换成 `BarInput`。
- 按目标周期计算时间桶。
- 维护正在形成的 K 线状态。
- 根据封口策略判断 K 线何时 CLOSED。
- 发布 K 线生命周期事件。
- 保证实时聚合和历史聚合使用同一套 bucket / merge / finalize 规则。

它不应该负责：

- 连接交易所 WebSocket。
- 主动 HTTP 拉历史数据。
- 写数据库。
- 维护前端订阅。
- 查询 storage/cache。
- 修复数据库缺口。
- 直接管理 DataManager 的 cache。
- 对外提供 HTTP API。

一句话：

```text
bar_aggregator 负责“把输入事件变成生命周期清晰的 K 线事件”。
```

---

## 2. 理论上的五层架构

理论上的五层应该是单向、可替换、职责单一的管道。

```text
MarketEvent / FetchedBar / Manual BarInput
      |
      v
L1 EventRouter
      |
      v
L2 TimeBucketEngine
      |
      v
L3 BarStateEngine
      |
      v
L4 Finalizer
      |
      v
L5 Publisher
      |
      v
Downstream consumers
```

### L1 EventRouter

理论职责：

- 接收上游事件。
- 把 `MarketEvent`、`FetchedBar`、自定义输入转换成 `BarInput`。
- 根据 `(exchange, market_type, symbol, target_interval)` 分发到对应目标周期。
- 处理 source interval 到 target interval 的路由规则。

理论输入：

- ingestion 输出的 `MarketEvent`。
- backfill 输出的历史 bar。
- adapter 输出的自定义 `BarInput`。

理论输出：

- 面向目标周期的 `BarInput`。

理论上不应该做：

- 维护 OHLCV 状态。
- 计算 bucket。
- 判断封口。
- 访问 cache/storage。
- 知道 DataManager 的订阅状态。

### L2 TimeBucketEngine

理论职责：

- 给定时间戳和目标周期，计算 bucket start。
- 给定 bucket start，计算 bucket range。
- 支持 epoch、midnight、custom alignment。
- 支持 calendar month 和 Monday week 等特殊 bucket。

理论输入：

- `open_time_ms`。
- interval / alignment config。

理论输出：

- `bucket_start_ms`。
- `(bucket_start_ms, bucket_end_ms)`。

理论上不应该做：

- 读取输入源字段。
- 维护 K 线状态。
- 判断交易所 close signal。
- 写入下游。

### L3 BarStateEngine

理论职责：

- 维护 active bars。
- 维护最近 closed bars。
- 应用 merge strategy。
- 处理 late backfill amendment。
- 控制内存上限。

理论输入：

- `(exchange, market_type, symbol, bucket_start_ms, BarInput)`。

理论输出：

- `BarState`。
- `BarStateChange`。

理论上不应该做：

- 自己计算 source 应该路由到哪个 target。
- 判断是否应该封口。
- 发布事件。
- 查询 storage/cache。

### L4 Finalizer

理论职责：

- 根据策略链判断 bar 是否应该 CLOSED。
- 支持 source close、composite close、event-driven close、timeout close、batch close。
- 允许注册自定义 finalizer strategy。

理论输入：

- `BarState`。
- `FinalizeTrigger`。

理论输出：

- 是否应该封口。

理论上不应该做：

- 修改 `BarStateEngine` 的 active/closed 容器。
- 发布事件。
- 查询外部状态。

### L5 Publisher

理论职责：

- 发布 `BarEvent`。
- 支持 callback 和 async iterator。
- 支持 event filter。
- 对 UPDATE 事件做节流。
- 对 subscriber queue 做容量控制。

理论输入：

- `BarEvent` 或 `BarState`。

理论输出：

- 下游消费者可订阅的事件流。

理论上不应该做：

- 聚合 K 线。
- 决定封口。
- 写数据库。
- 更新 cache。

---

## 3. 当前代码的实际架构

当前模块主链路基本符合五层模型。

核心入口是 `BarAggregator`：

```text
BarAggregator
  owns EventRouter
  owns BarAggregatorPublisher
  owns interval -> IntervalPipeline

IntervalPipeline
  owns TimeBucketEngine
  owns BarStateEngine
  owns Finalizer
```

实际处理链路是：

```text
on_market_event() / on_backfill_bars()
      |
      v
EventRouter
  convert raw event -> BarInput
  route to target intervals
      |
      v
BarAggregator._handle_bar_input()
  TimeBucketEngine.compute_bucket()
  BarStateEngine.apply()
  Publisher.emit_created/updated/amended()
  Finalizer.check()
  BarStateEngine.close_bar()
  Publisher.emit_closed()
```

对应代码：

- 顶层编排：`aggregator.py`
- L1 router：`router.py`
- L2 bucket：`time_bucket.py`
- L3 state：`bar_state.py`
- L4 finalizer：`finalizer.py`
- L5 publisher：`publisher.py`
- 公共模型：`models.py`
- 配置：`config.py`

从模块内部看，五层拆分是清楚的。

更准确地说，当前不是“bar_aggregator 内部混乱”，而是：

```text
bar_aggregator 内部主线清楚；
bar_aggregator 和外部模块的边界开始变薄；
旧聚合路径还没有完全退场。
```

---

## 4. 当前不合理行为清单

### 4.1 DataManager 直接调用 BarAggregator 内部方法

`BarAggregator` 文档说它是唯一外部入口，但实际 `DataManager` 已经绕过公开 API。

典型行为：

- 通过 `get_pipeline(interval)` 拿到内部 pipeline。
- 读取 `pipeline.time_bucket`。
- 读取 `pipeline.bar_state`。
- 直接调用 `bar_aggregator._handle_bar_input(...)`。

这些行为主要出现在两类场景：

1. 标准周期启动时 seed 当前 forming bar。
2. 自定义周期启动时用 base bars rebuild 当前 bucket。

这说明问题不是 DataManager 随便越界，而是 `BarAggregator` 目前缺少正式 API 来表达这些必要操作。

当前缺失的公共能力包括：

- 直接 ingest 一个已经构造好的 `BarInput`。
- 静默 replay 一组 component bars 到某个 target interval。
- seed active bar，但不把它误判为正常 backfill closed bar。
- rebuild 当前 custom bucket，并能控制是否 emit events。
- 查询 bucket state，但不暴露整个 `BarStateEngine`。

风险：

- 外部模块依赖 `_handle_bar_input` 这种内部函数，后续重构会很痛。
- DataManager 被迫理解 bucket、state、source、finalizer 的内部细节。
- `get_pipeline()` 作为高级扩展入口，实际上变成业务集成入口。

建议：

- 短期：新增正式 API，先包住现有内部调用。
- 中期：DataManager 不再调用 `_handle_bar_input`，也不直接读 `pipeline.bar_state`。
- 长期：`get_pipeline()` 只保留给调试和高级定制，不作为业务主链路依赖。

建议 API 形态：

```python
async def ingest_bar_input(
    self,
    target_interval: str,
    bar_input: BarInput,
    *,
    emit_events: bool = True,
) -> None:
    ...

async def replay_components(
    self,
    symbol: str,
    target_interval: str,
    component_interval: str,
    rows: list[dict],
    *,
    exchange: str,
    market_type: str,
    emit_events: bool = False,
) -> BarState | None:
    ...

def get_bucket_state(
    self,
    symbol: str,
    interval: str,
    bucket_start_ms: int,
    *,
    exchange: str,
    market_type: str,
) -> BarState | None:
    ...
```

---

### 4.2 新旧聚合逻辑并存

当前项目里有两套聚合逻辑：

```text
新主线：
backend/app/data_engine/bar_aggregator/

旧路径：
backend/app/data_engine/services/kline_aggregator.py
```

旧路径仍提供：

- `aggregate_klines()`
- `aggregate_realtime_into_last()`
- `aggregate_multi_resolution()`

API legacy fallback 仍会调用旧聚合逻辑来处理 custom interval。

风险：

- custom interval 的 bucket 对齐规则可能不一致。
- 月线、周线等 calendar bucket 的边界可能不一致。
- 实时聚合和 HTTP 查询聚合可能不一致。
- volume / quote_volume / trades 等字段处理不一致。
- 修复一个聚合 bug 时，需要检查两套实现。

当前 backfill reconciler 已经倾向于优先走 `BarAggregator`，这方向是对的。

建议：

- 短期：明确 `services/kline_aggregator.py` 是 legacy fallback，只用于 DataManager 未初始化的旧 API 路径。
- 中期：让旧函数内部复用 `TimeBucketEngine` 和 `ComponentSnapshotOHLCVMerge` 的规则，至少统一 bucket/merge 语义。
- 长期：HTTP custom interval 聚合也走 `BarAggregator` 的纯 batch/replay API。

目标形态：

```text
所有 custom interval 生成都使用同一套：
TimeBucketEngine + BarStateEngine + Finalizer
```

---

### 4.3 Router 混入了交易所 source capability 策略

`EventRouter` 理论上负责“事件转换和分发”。

当前它确实做了这些事，但同时也硬编码了 source capability 规则：

- realtime custom interval 只接受 `1m` source。
- backfill custom interval 接受小于等于 target 的标准 source interval。
- OKX realtime `1m` 可以 fan out 到更大标准周期。

这些规则不是纯 router 逻辑，而是：

```text
source stream capability + exchange behavior + product decision
```

例如 OKX 1m fanout 的原因是：

- OKX 大周期 WS 推送不够频繁。
- 为了让图表上的大周期 forming bar 实时更新，需要 1m 驱动更大周期。

这是合理需求，但硬编码在 `router.py` 里会让 router 随交易所增长而膨胀。

风险：

- 新增交易所时，`router.py` 会继续堆 if/elif。
- 同一个 target interval 到底接受哪些 source interval 不够可配置。
- source selection 分散在 DataManager、Coordinator、Router、BarState merge 之间。

建议：

- 短期：保留现状，但在文档中承认 Router 包含 routing policy。
- 中期：抽出 `RoutingPolicy`。
- 长期：由 exchange adapter 或 source planner 提供 source capability，Router 只执行策略结果。

建议目标：

```python
class RoutingPolicy(Protocol):
    def should_route(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        source_interval: str,
        target_interval: str,
        source: BarInputSource,
    ) -> bool:
        ...
```

这样 Router 只做：

```python
if self._routing_policy.should_route(...):
    await self._on_bar_input(...)
```

---

### 4.4 BarState merge 里混入了跨周期路由语义

`BarStateEngine` 理论上只负责状态维护和 merge。

当前 `StandardOHLCVMerge` 里存在一段特殊逻辑：

```text
source_interval != state.interval:
  只更新 OHLC，不更新 volume/trades
```

这段逻辑是为 OKX `1m -> 5m/1h/...` cross-interval realtime fanout 服务的。

业务上它是有道理的：

- 1m source 只覆盖大周期中的一个组件。
- 如果把 1m volume 直接替换或累加到 1h state，会污染 1h volume。
- native 大周期 push 到来时，才能给出完整累计 volume。

但从架构上看，这使 `StandardOHLCVMerge` 开始理解“这个输入是 cross-interval price-only update”。

风险：

- merge strategy 不再是纯 OHLCV 规则。
- 未来还有其他 source merge mode 时，会继续往 `StandardOHLCVMerge` 加条件。
- Router 和 BarState 必须隐式配合，理解成本上升。

建议：

- 短期：保留逻辑，但命名上明确这是 `PRICE_ONLY_CROSS_INTERVAL`。
- 中期：在 `BarInput` 或 dispatch context 上携带 `merge_mode`。
- 长期：merge strategy 按 `merge_mode` 执行，不自己推断 source 语义。

建议模型：

```python
class MergeMode(str, Enum):
    SNAPSHOT = "snapshot"          # kline snapshot: replace cumulative fields
    INCREMENTAL = "incremental"    # trade/tick: add cumulative fields
    COMPONENT = "component"        # custom component: snapshot collection then rebuild
    PRICE_ONLY = "price_only"      # cross interval realtime UI update
```

然后 source policy 决定：

```text
OKX 1m -> 1h realtime = PRICE_ONLY
1m -> 91m custom = COMPONENT
1h native -> 1h = SNAPSHOT
trade -> any = INCREMENTAL
```

---

### 4.5 Backfill 路径复用 BarAggregator 是对的，但缺少 batch 隔离

`backfill/reconciler.py` 已经优先把 component bars 喂给 `BarAggregator.on_backfill_bars()`，这是正确方向。

它的好处是：

- backfill 生成 custom bars 和 realtime 生成 custom bars 共享同一套 bucket/merge/finalize。
- 减少旧聚合逻辑重复。
- 月线、周线、自定义周期的规则更容易一致。

但当前复用方式仍有几个隐患：

- 使用的是主 `BarAggregator` 实例时，会污染 recent closed state。
- backfill 期间 publisher 可能向 DataManager 发出正常 bar events。
- 收集结果依赖 `get_recent_bars(limit=10000)`。
- 同一个 aggregator 同时处理 realtime 和 backfill 时，状态边界不够清晰。

风险：

- 大批量 backfill 会挤占 closed bars memory。
- backfill amendment 和 realtime update 可能在同一个状态容器里交错。
- `limit=10000` 是经验值，不是严格 batch 结果边界。

建议：

- 短期：继续允许 reconciler 复用 BarAggregator，但对 batch 生成结果做更明确的范围过滤。
- 中期：提供 `aggregate_batch()` API，内部创建临时 isolated pipeline 或临时 BarAggregator。
- 长期：backfill custom bar 生成不依赖主 realtime aggregator 的 recent memory。

建议 API：

```python
async def aggregate_batch(
    self,
    symbol: str,
    target_interval: str,
    component_bars: list[BarInput],
    *,
    exchange: str,
    market_type: str,
    emit_events: bool = False,
) -> list[BarState]:
    ...
```

---

### 4.6 active/closed state 和 eviction event 耦合略重

`BarStateEngine` 负责内存上限。

当超过 active/closed limit 时，它会：

- force close active bar。
- expire closed bar。
- 把结果放进 `evicted_closed` / `evicted_expired` buffer。

然后 `BarAggregator` 再调用 `_drain_eviction_buffers()` 发布事件。

这比 `BarStateEngine` 直接发布事件更好，因为 L3 没有依赖 L5。

但问题是 buffer 是可变共享状态：

```text
BarStateEngine mutates buffer
BarAggregator must remember to drain buffer
```

风险：

- 新增调用路径时忘记 drain，事件丢失。
- 并发调用时 buffer 语义不够清楚。
- L3 返回值不能完整表达一次 apply/close 的副作用。

建议：

- 短期：保持现状。
- 中期：让 `apply()` / `close_bar()` 返回结构化 result，包含 primary change 和 side effects。

建议模型：

```python
@dataclass
class BarStateResult:
    state: BarState | None
    change: BarStateChange
    side_effects: list[BarStateEffect]
```

这样调用方不需要记得 drain 全局 buffer。

---

### 4.7 Publisher callback 是强顺序反压模型

`Publisher.emit()` 当前会：

1. 检查是否应该 emit。
2. 对 UPDATED 事件节流。
3. await callbacks。
4. enqueue 给 async subscribers。

这意味着 callback 慢时，bar aggregation 主链路会被拖慢。

优点：

- 顺序简单。
- DataManager 能在同一事件流里稳定更新 cache/storage/event bus。
- 下游错误会被记录。

风险：

- 一个慢 callback 会阻塞所有后续 bar input。
- 如果未来增加多个消费者，主链路延迟会更不稳定。
- callback 内如果做慢 I/O，实时聚合延迟会放大。

建议：

- 短期：保留强顺序 callback，文档明确它是反压模型。
- 中期：区分 ordered callback 和 async side subscriber。
- 长期：DataManager 这类核心消费者使用 ordered path，监控/UI辅助消费者使用异步队列。

---

### 4.8 custom interval 的 source_snapshots 需要明确生命周期

`ComponentSnapshotOHLCVMerge` 为了支持乱序、late backfill、重复 component 修正，会保存每个 source component 的最新 snapshot。

这对 custom interval 是正确设计。

例如：

- 当前 forming custom bar 先从 storage/cache seed。
- 之后缺失的早期 component 被 backfill 补上。
- 同一个 source bar 后续收到更完整 OHLCV。

保存 component snapshots 后，可以每次按 open time 重新 rebuild custom bar。

但它也带来内存问题：

- 91m 基于 1m source，大约 91 个 snapshot，问题不大。
- 1d 基于 1m source，1440 个 snapshot。
- 1M / 2M / 3M 如果基于 1m source，可能是几万到十几万个 snapshot。

风险：

- closed bar 保留在 memory 时也保留 snapshots。
- 大周期 custom interval 的 recent closed cache 会变重。
- backfill 大批量生成时，内存峰值不容易估算。

建议：

- 短期：在 README / review 中明确 `source_snapshots` 是 custom interval correctness tradeoff。
- 中期：对 large interval 增加 snapshot retention 策略。
- 长期：closed bar 默认丢弃 snapshots，只保留 OHLCV；只有允许 late amendment 的窗口内保留 snapshots。

可选策略：

```text
FORMING custom bar:
  保留 snapshots

CLOSED custom bar:
  默认丢弃 snapshots
  或只保留最近 N 个 bucket
  或只在 amendment window 内保留

Batch aggregation:
  使用 isolated state，结束后只返回最终 OHLCV
```

---

## 5. 建议的目标架构

目标不是推翻五层，而是收紧边界。

建议目标形态：

```text
                         +----------------------+
                         | Source/RoutingPolicy |
                         | exchange capability  |
                         +----------+-----------+
                                    |
                                    v
MarketEvent / FetchedBar / BarInput
      |
      v
L1 EventRouter
  normalize input
  ask RoutingPolicy
  dispatch BarInput + MergeMode
      |
      v
L2 TimeBucketEngine
  compute bucket only
      |
      v
L3 BarStateEngine
  apply merge mode
  return structured state result
      |
      v
L4 Finalizer
  decide close only
      |
      v
L5 Publisher
  ordered core event path
  async side subscriber path
      |
      v
DataManager / Backfill / Indicators / WS
```

外部模块应该只依赖 `BarAggregator` 的公开 API：

```text
DataManager:
  ensure target
  seed/replay through public API
  subscribe publisher events

BackfillEngine:
  aggregate batch through public API
  or use isolated temporary BarAggregator

API:
  query DataManager/cache/storage
  do not call old custom aggregation unless legacy fallback
```

核心原则：

- `bar_aggregator` 不查 storage。
- `DataManager` 不直接碰 pipeline internals。
- custom interval 只保留一套权威聚合规则。
- exchange 特殊 source 能力通过 policy 表达，不散落在 Router 和 Merge 中。
- realtime aggregator 和 batch aggregator 可以共用代码，但状态要隔离。

---

## 6. 分阶段修改建议

### 阶段 1：先收敛文档和命名，不大改代码

目标：让当前架构语义和实际代码对齐。

建议改动：

1. 新增本文档。
2. 在 README 中说明旧 `services/kline_aggregator.py` 是 legacy fallback。
3. 在 README 中说明 `get_pipeline()` 是高级扩展/调试入口，不建议业务代码依赖。
4. 给 `_handle_bar_input()` 上方注释明确“内部入口，外部应该使用 public ingest/replay API”。
5. 在 Router 文档中承认当前包含 routing policy。

收益：

- 风险低。
- 不影响实时链路。
- 后续重构方向清楚。

### 阶段 2：补公共 seed/replay/ingest API

目标：消除 DataManager 对 `_handle_bar_input()` 和 pipeline internals 的依赖。

建议改动：

```python
async def ingest_bar_input(...)
async def replay_components(...)
def get_bucket_state(...)
def expire_bucket(...)
```

然后逐步替换 DataManager 中这些行为：

- `self.bar_aggregator._handle_bar_input(...)`
- `pipeline.bar_state.get_active(...)`
- `pipeline.bar_state.expire_bar(...)`

收益：

- 外部边界立刻清楚。
- 后续重构 `IntervalPipeline` 不会牵动 DataManager。

### 阶段 3：抽 RoutingPolicy 和 MergeMode

目标：把交易所 source 特殊规则从 Router/BarState 中抽出来。

建议改动：

```text
bar_aggregator/
  routing_policy.py
  merge_mode.py
```

`RoutingPolicy` 决定是否 route，以及用什么 merge mode。

`BarStateEngine` 只执行 merge mode。

收益：

- OKX fanout 逻辑有正式位置。
- 新增交易所时不用继续改大段 Router。
- merge 逻辑更纯。

### 阶段 4：统一 custom interval batch aggregation

目标：让 API/backfill/realtime 都用同一套聚合规则。

建议改动：

1. 新增 `aggregate_batch()` 或 `BatchBarAggregator`。
2. backfill reconciler 使用 batch API，不依赖主 aggregator 的 recent memory。
3. settings repair 使用 batch API。
4. legacy `services/kline_aggregator.py` 只作为最后 fallback，或者内部调用 batch API。

收益：

- custom interval 一套规则。
- 历史修复不污染 realtime state。
- 不再依赖 `get_recent_bars(limit=10000)` 收集 batch 结果。

### 阶段 5：优化 Publisher 反压模型

目标：保持核心顺序，同时避免旁路消费者拖慢主链路。

建议改动：

```text
on_bar_event_ordered(callback)
subscribe(event_filter)
on_bar_event_async(callback)
```

或者保留现有 callback 语义，把 async subscriber 推荐为非核心消费者路径。

收益：

- DataManager 继续保持强顺序。
- 监控/日志/UI辅助订阅不阻塞聚合。

### 阶段 6：控制 custom source_snapshots 生命周期

目标：降低大周期 custom interval 的内存风险。

建议改动：

1. closed custom bar 默认可选择 drop snapshots。
2. 增加 amendment retention window。
3. batch mode 聚合完成后只返回最终 OHLCV。
4. snapshot 中暴露 `source_snapshots_count`，便于观测。

收益：

- 大周期/月线更安全。
- 内存使用更可控。

---

## 7. 建议优先级

如果只做最关键的三件事：

1. **先补 `BarAggregator` 的 public ingest/replay/seed API。**
2. **把 `services/kline_aggregator.py` 的地位明确为 legacy，并逐步统一到 BarAggregator 规则。**
3. **抽出 RoutingPolicy / MergeMode，收敛 OKX 和 cross-interval 特例。**

原因：

- DataManager 越界是当前最明显的边界问题。
- 两套 custom aggregation 是长期一致性风险。
- 交易所特殊路由会随着交易所数量增长而变成 Router/BarState 的膨胀源。

---

## 8. 需要讨论的问题

后续具体改代码前，建议先确认这些问题：

1. `BarAggregator` 是否允许提供 `emit_events=False` 的静默 replay？
   - 建议：允许。seed/rebuild/batch aggregation 都需要。

2. backfill custom aggregation 是否应该使用主 realtime aggregator？
   - 建议：短期可以，长期使用 isolated batch aggregator。

3. closed custom bar 是否需要长期保留 source snapshots？
   - 建议：默认不长期保留，只在 amendment window 内保留。

4. OKX 1m fanout 到大周期是 exchange policy 还是 UI policy？
   - 建议：定义为 source/routing policy，由交易所能力和产品需求共同决定。

5. `get_pipeline()` 是否继续公开？
   - 建议：保留，但标为 advanced/debug；业务集成不要依赖。

6. legacy API fallback 是否还必须保留？
   - 如果必须保留，至少让旧聚合复用新 bucket/merge 规则。

---

## 9. 简短结论

`bar_aggregator` 的五层主架构是清楚的，不属于内部混乱型模块。

当前更准确的问题是：

- 内部五层清楚。
- 外部边界开始变薄。
- DataManager 已经需要绕过 public API。
- custom aggregation 新旧两套逻辑并存。
- exchange/source 特殊策略散落在 Router 和 Merge 中。
- batch backfill 和 realtime aggregation 共用主状态时，隔离不够明确。

建议不要推倒重来，而是按这个方向收紧：

```text
bar_aggregator 只负责 K 线生命周期；
DataManager 只负责编排、cache、storage、event bus；
Backfill 只负责历史修复；
RoutingPolicy 负责 source 能力和交易所特殊规则；
所有 custom interval 统一使用 BarAggregator 的 bucket/merge/finalize 规则。
```

只要先补 public ingest/replay/seed API，再逐步废弃旧聚合路径，这个模块的架构会比较稳，不需要大拆。
