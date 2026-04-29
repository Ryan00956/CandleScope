# Data Manager 架构评审与修改建议

本文只讨论 `backend/app/data_engine/data_manager` 模块，以及它和 `ingestion`、`bar_aggregator`、`backfill`、storage、API 层的边界关系。

结论先说：

`data_manager` 的总体方向是合理的。它确实承担了 CandleScope 后端数据层的统一门面：

```text
API / WebSocket / Indicator / Subscription
        |
        v
DataManager
  - query
  - cache
  - event bus
  - stream lifecycle
        |
        v
ingestion / bar_aggregator / backfill / storage
```

但它现在的问题也很明显：

- `manager.py` 已经不只是 facade，而是吸收了大量 warm-start、repair、retention、exchange 特例逻辑。
- `DataManager` 直接访问 `coordinator`、`query_engine`、`bar_aggregator` 的私有状态。
- `QueryEngine` 不只是查询，也承担 custom interval 重建、gap 检测、storage gap fill、backfill 触发。
- backfill 编排仍然分散在 `QueryEngine`、`DataManager.on_bars_backfilled()`、`main.py`、`settings.py`。
- custom interval 的 bucket / aggregate 规则在 `query`、`bar_aggregator`、`backfill`、`core.market` 多处存在。

所以当前更像是：

```text
data_manager 的核心骨架是对的；
cache / event_bus / models / config 较干净；
manager.py 和 query.py 正在变成系统修补中心。
```

这不是必须推倒重来，但需要尽快把几个“临时补丁型职责”拆出去，否则后续 `bar_aggregator` 和 `backfill` 一重构，`DataManager` 会成为最大阻力。

---

## 1. 模块定位

`data_manager` 应该是 CandleScope 后端的数据访问与事件分发门面。

它位于：

```text
API / WS / Indicator / Strategy / Subscription
              |
              v
        data_manager
              |
              v
cache / storage / ingestion / bar_aggregator / backfill
```

它的理想职责是：

- 提供统一查询接口：`query()`、`query_latest()`、`query_before()`。
- 管理内存缓存：读、写、预热、淘汰。
- 提供统一事件总线：bar event、stream event、backfill event。
- 管理实时流生命周期：按需启动、停止、空闲回收。
- 作为上游事件的编排者，把 ingestion 输出接到 bar_aggregator，把 bar_aggregator 输出接到 cache / event bus / storage。
- 接收 backfill 完成后的 repaired bars，回灌 cache，并通知消费者。
- 提供诊断快照。

它不应该负责：

- 理解 `BarAggregator` 的 pipeline 内部结构。
- 直接操作 `pipeline.bar_state` 或调用 `_handle_bar_input()`。
- 自己实现复杂 custom interval 聚合规则。
- 自己承担 backfill 队列、重试、去重、range coalescing。
- 在门面类里维护 exchange-specific 特例。
- 在门面类里承担数据库 retention cleanup 的完整业务逻辑。

一句话：

```text
DataManager 负责“统一访问、统一编排、统一事件”，不负责替下游模块修补内部状态。
```

---

## 2. 理想分层

理想上的 `data_manager` 可以拆成几块清晰能力。

```text
DataManager facade
      |
      +-- QueryEngine
      |     CacheReader -> StorageReader -> BackfillCoordinator
      |
      +-- BarCache
      |     per-series bounded cache
      |
      +-- DataEventBus
      |     callback / async iterator delivery
      |
      +-- StreamCoordinator
      |     ingestion lifecycle
      |
      +-- AggregatorBridge
      |     BarAggregator event -> cache/storage/event_bus
      |
      +-- BackfillCoordinator
      |     trigger dedup / run / load / notify
      |
      +-- WarmStartService
            seed active forming bars through public aggregator API
```

### DataManager facade

理论职责：

- 组合子组件。
- 暴露稳定公共 API。
- 做少量参数归一化。
- 把具体工作委托给子组件。

理论上不应该做：

- 大段业务算法。
- 直接读取其他组件私有字段。
- 管理下游内部状态机。

### QueryEngine

理论职责：

- 决定一次查询应该从 cache、storage 还是 backfill coordinator 获取数据。
- 返回统一 `QueryResult`。
- 对明显不完整的数据报告 gap / missing range。

理论上不应该做：

- 亲自调度 backfill 重试。
- 亲自实现所有 custom interval 聚合细节。
- 带有前端 UI 语义过强的状态。

### StreamCoordinator

理论职责：

- 管理 stream entry。
- 按需启动 ingestion。
- 处理 passive stream。
- idle reap。
- prewarm。

理论上不应该做：

- 知道太多 bar aggregation 细节。
- 被 facade 直接读取 `_streams`。

### AggregatorBridge

理论职责：

- 把 `BarAggregator` 的 `BarEvent` 转成 `DataEvent`。
- 写 cache。
- 对 closed/amended bar 写 storage。
- 更新 stream metrics。
- emit event bus。

理论上不应该做：

- seed active state。
- 执行 custom tail repair。
- 直接修复历史缺口。

### BackfillCoordinator

理论职责：

- 接收来自 QueryEngine、startup scan、settings API、ingestion gap marker 的 repair request。
- 做 per-series in-flight guard。
- 合并重叠 range。
- 控制 retry / backoff / cancellation。
- 调 `BackfillEngine.run()`。
- 从 storage 读取最终结果或接收 repaired bars。
- 调 DataManager cache load + event emit。

理论上不应该做：

- HTTP fetch 细节。
- bar merge / reconcile 细节。
- WebSocket 推送细节。

### WarmStartService

理论职责：

- 在 stream 初次启动时，从 storage/cache 获取当前 forming bar 或 forming bucket 的基础数据。
- 通过 `BarAggregator` 的正式 public API seed active state。
- 避免重启后第一条实时 tick 覆盖完整 OHLC。

理论上不应该做：

- 直接访问 `pipeline.bar_state`。
- 直接调用 `_handle_bar_input()`。
- 在 DataManager facade 中堆放几百行修补逻辑。

---

## 3. 当前模块内部结构

当前 `data_manager` 目录是：

```text
data_manager/
├── __init__.py       # public exports
├── config.py         # DataManagerConfig / CacheConfig / QueryConfig ...
├── models.py         # BarData / SeriesKey / QueryResult / DataEvent / Protocol
├── cache.py          # BarCache / BarSeries
├── event_bus.py      # DataEventBus
├── coordinator.py    # StreamCoordinator
├── query.py          # QueryEngine
└── manager.py        # DataManager facade + aggregator bridge + warm start + retention
```

比较好的点：

- `SeriesKey` 把 `exchange`、`market_type`、`symbol`、`interval` 收进统一 key，是正确方向。
- `BarData` 作为 lightweight-charts 兼容输出类型，降低了 API / WS / indicator 的重复转换成本。
- `BarCache` 的职责清楚：per-series buffer、LRU series eviction、TTL、ephemeral limit。
- `DataEventBus` 保持轻量，没有引入网络层或 FastAPI 依赖。
- `StreamCoordinator` 大体聚焦 stream lifecycle。
- `DataManager` 对外 API 简单，调用方不用直接碰 cache/storage/ingestion。

但目前的复杂度集中在两个文件：

```text
manager.py:
  facade + lifecycle + stream + aggregator bridge
  + warm-start seeding
  + custom tail repair
  + backfill completion gap follow-up
  + retention cleanup
  + ephemeral trim

query.py:
  cache/storage query
  + custom interval rebuild
  + monthly alignment
  + interior gap detection
  + storage gap fill
  + backfill trigger
  + tail gap metadata
```

这两个文件不是不可维护，但已经超过“优雅门面”的合理体量。

---

## 4. 主要问题

### 4.1 DataManager 直接越过组件边界

当前 `DataManager` 多处访问其他组件私有字段或内部 pipeline：

```text
DataManager
  -> coordinator._streams
  -> query_engine._storage
  -> query_engine._backfill_trigger
  -> bar_aggregator.get_pipeline()
  -> pipeline.bar_state.get_active()
  -> pipeline.bar_state.expire_bar()
  -> bar_aggregator._handle_bar_input()
  -> cache._ephemeral_max_bars
```

这些访问说明两个问题：

1. `DataManager` 当前确实需要这些能力。
2. 这些能力还没有被下游模块以稳定 public API 形式表达出来。

风险：

- `bar_aggregator` 内部重构会直接破坏 DataManager。
- `QueryEngine` 的存储和 backfill trigger 被外部随意改，封装失效。
- `StreamCoordinator` 的 stream 状态无法独立演进。
- 单测难写，因为 facade 与多个内部实现强耦合。

建议：

- `QueryEngine.set_storage()` / `set_backfill_trigger()`，替代直接写 `_storage`、`_backfill_trigger`。
- `StreamCoordinator.has_stream()` / `touch_stream()` / `mark_bar_received()`，替代读写 `_streams`。
- `BarAggregator.seed_active_bar()` / `seed_from_base_bars()`，替代 `_handle_bar_input()` 和 `pipeline.bar_state`。
- `BarCache.get_ephemeral_limit()`，替代外部读 `_ephemeral_max_bars`。

短期可以先补 public wrapper，不必大规模重构。

---

### 4.2 manager.py 过胖，facade 和修补服务混在一起

`DataManager` 当前承担了几类职责：

- 公开 API facade。
- 子组件 wiring。
- lifecycle。
- stream ensure/stop。
- aggregator event bridge。
- standard interval seed。
- custom interval seed。
- custom tail repair。
- post-backfill gap follow-up。
- startup DB cleanup。
- ephemeral trim loop。

其中 facade / lifecycle / bridge 是合理的；后面几类更像独立服务。

尤其是 seed 逻辑：

```text
ensure_stream()
  -> _seed_custom_interval()
       read storage/cache
       compute current bucket
       detect missing base components
       trigger backfill
       inspect pipeline state
       expire active bar
       build BarInput
       call bar_aggregator._handle_bar_input()
       write cache

  -> _seed_standard_interval()
       read storage
       compute bucket
       inspect active state
       build BarInput
       call bar_aggregator._handle_bar_input()
```

这段逻辑解决的是现实问题：重启后 aggregator active state 为空，第一条实时 tick 可能覆盖完整 OHLC。这个问题必须解决，但不应该长期放在 `DataManager` facade 里。

建议：

新增：

```text
data_manager/warm_start.py

class AggregatorWarmStartService:
    seed_standard(...)
    seed_custom(...)
    trigger_custom_tail_repair(...)
```

`DataManager.ensure_stream()` 只保留：

```python
await self.stream_service.ensure(...)
await self.warm_start.seed_if_needed(...)
```

这样 `DataManager` 重新变薄，warm-start 的复杂规则也更容易单独测试。

---

### 4.3 QueryEngine 做了太多“查询以外”的工作

`QueryEngine.query()` 当前逻辑是：

```text
custom interval?
  -> rebuild from base interval

standard interval:
  -> cache
  -> storage
  -> merge
  -> detect interior gaps
  -> fill gaps from storage
  -> trigger backfill
  -> compute tail_gap metadata
```

这让 `QueryEngine` 变成了“查询 + repair trigger + custom aggregator + UI hint”的混合体。

其中有些是合理的：

- cache first / storage fallback 是 QueryEngine 的核心职责。
- 发现不完整数据并报告 gap 是合理的。

但这些不够理想：

- custom interval rebuild 使用自己的聚合函数，容易和 `bar_aggregator` / `backfill` 规则漂移。
- interior gap fill 会直接查 storage 并触发 backfill。
- `has_tail_gap` 更像前端 loading 语义，不应过度污染查询核心。

建议拆分：

```text
QueryEngine:
  - query standard interval
  - return data + MissingRange list

CustomIntervalQueryService:
  - query base interval
  - call shared interval aggregation API
  - return derived bars

BackfillCoordinator:
  - consume MissingRange
  - schedule repair

QueryResult:
  - 保留 has_tail_gap 可以，但由上层根据 MissingRange 计算更清楚
```

短期最小改法：

- 把 `_aggregate_custom_bars()`、`_query_custom_from_base()`、`_query_custom_before()` 移到 `custom_query.py`。
- `QueryEngine` 只委托，不直接持有全部 custom 规则。

---

### 4.4 backfill 编排散落在太多地方

当前涉及 backfill 的路径至少有：

- `QueryEngine.query()` 数据不完整时触发。
- `QueryEngine.query_before()` 左滚不足时触发。
- `QueryEngine._fill_interior_gaps()` storage 也缺时触发。
- `DataManager.on_bars_backfilled()` 回灌后发现 gap 再触发。
- `DataManager._seed_custom_interval()` seed 时发现 base components 缺失后触发。
- `DataManager._trigger_custom_tail_repair()` 触发。
- `main.py` 中 `_backfill_trigger()` 承担 run / retry / load cache。
- `settings.py` 中 repair / gap scan 端点另有手写流程。

这和 `backfill` 模块评审里的结论一致：问题不是单个函数写坏了，而是缺少应用级 backfill coordinator。

风险：

- 同一个缺口重复触发。
- retry 策略分散。
- backfill 完成后的 cache 回灌路径不统一。
- settings API、startup scan、query 触发之间行为不一致。
- 后续做可观测性、取消、限流时没有唯一入口。

建议：

新增：

```text
data_engine/backfill_coordinator.py
或
data_manager/backfill_coordinator.py
```

职责：

```text
request_repair(symbol, interval, start_ms, end_ms, exchange, market_type, reason)
  -> normalize range
  -> dedup / coalesce
  -> per-series in-flight guard
  -> run BackfillEngine
  -> load repaired range into DataManager cache
  -> emit BACKFILL_COMPLETED / BACKFILL_FAILED
```

然后：

- `QueryEngine` 不直接拿 callback，而是返回 gap 或调用 coordinator。
- `main.py` 不再定义 `_load_backfilled_to_cache()`。
- `settings.py` 不再手写 cache reload。
- `DataManager.on_bars_backfilled()` 只做“接收 repaired bars -> cache -> event”，不再继续负责 backfill 编排。

---

### 4.5 custom interval 规则重复且分散

custom interval 当前至少出现在：

- `core.market`
- `bar_aggregator.time_bucket`
- `bar_aggregator.router`
- `data_manager.query`
- `data_manager.manager` seed custom
- `backfill.planner`
- `backfill.reconciler`

风险：

- 月线、多月线、非标准分钟周期、周线对齐规则可能在不同路径中出现细微差异。
- 实时聚合、查询重建、历史修复结果不一致。
- 修一个 interval bug 需要改多个模块。

建议：

把 interval 规则收敛到一个共享 API：

```text
IntervalRules:
  parse(interval)
  is_standard(interval)
  is_custom(interval)
  is_ephemeral(interval)
  base_interval_for(interval)
  bucket_start(timestamp, interval)
  bucket_end(bucket_start, interval)
  aggregate_rows(rows, interval)
```

短期可以先让 `QueryEngine` 的 custom rebuild 调用 `bar_aggregator` 暴露的 batch aggregation API，避免自己再维护一套 OHLCV 聚合。

---

### 4.6 exchange 特例进入 DataManager facade

`ensure_stream()` 中有 OKX 高周期额外启动 base interval 的逻辑：

```text
OKX standard interval > base interval:
  start base 1m stream
  use router fanout to update higher timeframe
```

这个行为本身可能合理，因为 OKX 高周期 WS 推送频率低，前端会像卡住一样。但它不应该长期硬编码在 DataManager facade。

建议：

放到 exchange capability / stream policy：

```text
ExchangeStreamPolicy:
  should_run_base_stream(exchange, market_type, interval) -> bool
  base_interval_for(exchange, market_type, interval) -> str
```

然后 `DataManager` 只问 policy，不理解 OKX 细节。

---

### 4.7 retention cleanup 不宜放在 DataManager facade

`DataManager.start()` 会跑 startup DB cleanup，`DataManager` 还维护 `_db_limits` 和 ephemeral trim loop。

这部分不是错误，但从职责看更像：

```text
RetentionService:
  - db retention cleanup
  - ephemeral cache trim
  - settings update
```

风险：

- DataManager 启动流程变重。
- settings API 直接影响 facade 内部字段。
- 后续如果要给 retention 加 dry-run、progress、manual trigger，会继续撑大 `manager.py`。

建议：

短期保留现状可以接受；中期拆成 `retention.py`，由 DataManager 持有服务实例。

---

## 5. 具体代码风险

### 5.1 `_fill_interior_gaps()` 漏传 exchange

`QueryEngine._fill_interior_gaps()` 查 storage 时传了 `market_type`，但没有传 `exchange`。

当前类似：

```python
rows = self._storage.query_bars(
    symbol=key.symbol,
    interval=key.interval,
    start_ms=gap_start_ms,
    end_ms=gap_end_ms,
    limit=5000,
    order="ASC",
    market_type=key.market_type,
)
```

如果当前 key 是 `okx:BTCUSDT@1m` 或其他 exchange，这里可能回落到 storage 默认 `exchange="binance"`。

建议立即修：

```python
exchange=key.exchange,
market_type=key.market_type,
```

这是小改动，风险低，收益明确。

### 5.2 `DataManager.on_bar_event()` 丢失 exchange 参数

`DataManager.on_bar_event()` 当前参数只有 `market_type`，没有 `exchange`，调用 coordinator 时也没有传 exchange。虽然正常 aggregator path 走 `_on_aggregator_event()`，但这个 public method 作为手动注入入口，会默认写入 `binance` key。

建议：

- 给 `DataManager.on_bar_event()` 补 `exchange: str = "binance"`。
- 转发给 `coordinator.on_bar_event(..., exchange=exchange, market_type=...)`。

### 5.3 文档和实现不完全一致

README 中“与 bar_aggregator 集成”仍展示 `data_manager.on_bar_event()`，但真实主路径已经是：

```text
bar_aggregator.publisher.on_bar_event(DataManager._on_aggregator_event)
```

建议更新 README，避免后续维护者误以为 aggregator 应该直接调用 public `on_bar_event()`。

---

## 6. 建议的目标结构

建议把 `data_manager` 演进成：

```text
data_manager/
├── __init__.py
├── config.py
├── models.py
├── cache.py
├── event_bus.py
├── coordinator.py
├── query.py
├── custom_query.py          # custom interval query/rebuild
├── aggregator_bridge.py     # BarEvent -> cache/storage/event bus
├── warm_start.py            # seed active aggregator state
├── retention.py             # DB/cache retention
├── backfill_client.py       # thin adapter to BackfillCoordinator
└── manager.py               # thin public facade
```

目标不是文件越多越好，而是让每个复杂点有独立边界和测试入口。

`manager.py` 最终应该接近：

```python
class DataManager:
    def __init__(...):
        self.cache = BarCache(...)
        self.event_bus = DataEventBus(...)
        self.query_engine = QueryEngine(...)
        self.coordinator = StreamCoordinator(...)
        self.aggregator = BarAggregator(...)
        self.bridge = AggregatorBridge(...)
        self.warm_start = AggregatorWarmStartService(...)
        self.retention = RetentionService(...)

    def query(...):
        return self.query_engine.query(...)

    async def ensure_stream(...):
        info = await self.coordinator.ensure_stream(...)
        await self.warm_start.seed_if_needed(...)
        return info

    async def on_bars_backfilled(...):
        await self.backfill_client.load_and_emit(...)
```

---

## 7. 分阶段整改建议

### 阶段 0：小修，立即做

目标：修掉明确 bug 和低成本封装。

- `QueryEngine._fill_interior_gaps()` 补 `exchange=key.exchange`。
- `DataManager.on_bar_event()` 补 `exchange` 参数。
- 给 `QueryEngine` 增加 `set_storage()`、`set_backfill_trigger()`。
- 给 `BarCache` 增加 `get_ephemeral_limit()`。
- 给 `StreamCoordinator` 增加 `has_stream()`、`mark_bar_received()`。
- 更新 README 中 bar_aggregator 集成说明。

这些改动不改变架构，只是减少直接访问私有字段。

### 阶段 1：抽离 warm-start

目标：让 `manager.py` 从 1400+ 行降下来，并减少它对 aggregator internals 的理解。

- 新增 `warm_start.py`。
- 移动 `_seed_custom_interval()`、`_seed_standard_interval()`、`_custom_bucket_is_synced()`、`_trigger_custom_tail_repair()`。
- 先保持内部逻辑不变，只移动位置。
- 给 warm-start 单独补测试。

这是最值得优先做的结构性整理，因为它不需要先解决 backfill 大重构。

### 阶段 2：给 BarAggregator 补正式 seed / batch API

目标：停止 `DataManager` 调用 `_handle_bar_input()` 和 `pipeline.bar_state`。

建议 public API：

```python
await bar_aggregator.seed_active_bar(
    symbol=...,
    interval=...,
    row=...,
    exchange=...,
    market_type=...,
)

await bar_aggregator.seed_from_base_bars(
    symbol=...,
    target_interval=...,
    base_interval=...,
    rows=...,
    exchange=...,
    market_type=...,
)

bar_aggregator.get_active_bar(...)
bar_aggregator.expire_active_bar(...)
```

更好的长期 API：

```python
bar_aggregator.aggregate_batch(
    rows,
    source_interval,
    target_interval,
    emit_events=False,
)
```

这样 DataManager 不再理解 pipeline 层级。

### 阶段 3：抽离 BackfillCoordinator

目标：统一历史修复入口。

- 把 `main.py` 的 `_backfill_trigger()` 和 `_load_backfilled_to_cache()` 移入 coordinator。
- `QueryEngine` 只提交 repair request。
- `DataManager.on_bars_backfilled()` 只负责 cache merge + event emit。
- `settings.py` 的 repair / gap-scan 端点调用 coordinator，不直接写一套流程。

这是系统层面收益最大的改动，但需要动的调用方较多，适合作为单独 PR。

### 阶段 4：抽离 custom query 和 retention

目标：进一步降低 `query.py` 和 `manager.py` 复杂度。

- `custom_query.py` 承担 custom interval rebuild。
- `retention.py` 承担 startup DB cleanup 和 ephemeral trim。
- `QueryEngine` 只做标准查询编排。
- custom interval 聚合尽量复用统一 interval/batch aggregation API。

---

## 8. 推荐的最终边界

最终建议四个数据模块边界固定为：

```text
ingestion:
  实时接入、解析、连续性标记。
  输出 MarketEvent / GapMarker。

bar_aggregator:
  输入 MarketEvent / BarInput / batch rows。
  输出 BarEvent。
  不查 storage，不调 backfill，不碰 DataManager cache。

backfill:
  输入 RepairRequest。
  拉历史、去重、写库、输出 RepairReport / repaired range。
  不知道 WebSocket / FastAPI。

data_manager:
  对外统一 query / subscribe / ensure_stream。
  负责 cache、event bus、stream lifecycle、bridge、diagnostics。
  通过 BackfillCoordinator 调度历史修复。
```

一句话：

```text
DataManager 可以是系统中枢，但不应该是所有补丁的落点。
```

---

## 9. 总结

`data_manager` 当前不是“屎山”，但已经有明显膨胀趋势。

判断：

- `cache.py`、`event_bus.py`、`models.py`、`config.py`：比较健康。
- `coordinator.py`：基本合理，但需要减少外部读 `_streams`。
- `query.py`：功能正确性导向强，但职责偏多。
- `manager.py`：最大问题点，facade 已经混入 warm-start、repair、retention、exchange policy。

最务实的路线：

1. 先补 `_fill_interior_gaps()` 的 exchange 漏传。
2. 给现有私有字段访问补 public wrapper。
3. 抽 `warm_start.py`，不改行为，只搬复杂逻辑。
4. 再做 `BackfillCoordinator`，统一 repair 编排。
5. 最后收敛 custom interval 规则到统一 API。

这样可以在不破坏当前功能的前提下，把 DataManager 从“越来越胖的门面”拉回“清晰的应用级编排层”。
