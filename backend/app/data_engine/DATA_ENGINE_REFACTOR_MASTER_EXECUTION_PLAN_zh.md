# Data Engine 后端架构规范化总执行文档

本文是 `backend/app/data_engine` 重构的总执行文档，用来统筹 `ingestion`、`bar_aggregator`、`data_manager`、`backfill` 四个核心模块，以及旧 `services/collectors`、API 层、启动流程、settings 维护接口之间的迁移协作。

本文已对照阅读并吸收以下五份文档：

- `backend/app/data_engine/data_manager/ARCHITECTURE_REVIEW_zh.md`
- `backend/app/data_engine/ingestion/ARCHITECTURE_REVIEW_zh.md`
- `backend/app/data_engine/bar_aggregator/ARCHITECTURE_REVIEW_zh.md`
- `backend/app/data_engine/backfill/ARCHITECTURE_REVIEW_zh.md`
- `backend/app/data_engine/FOUR_MODULE_CONSOLIDATION_PLAN_zh.md`

本文不是重新设计一个新系统，而是把当前已经存在的后端数据链路收口成唯一权威路径，并把迁移拆成可以逐条执行、逐阶段验收的任务。

---

## 1. 总目标

最终后端数据路径必须固定为：

```text
所有行情输入       -> ingestion
所有 K 线生成      -> bar_aggregator
所有查询/缓存/订阅/事件输出 -> data_manager
所有历史修复       -> backfill
storage           -> 基础设施，不作为业务数据模块暴露
```

最终对外原则：

```text
API / WebSocket / Indicator / Subscription / Settings
        |
        v
DataManager 公开 API
        |
        +-- ingestion
        +-- bar_aggregator
        +-- backfill via BackfillCoordinator
        +-- storage
```

最终禁止：

- 正式路径直接 import `app.data_engine.services`。
- 正式路径直接 import `app.data_engine.collectors`。
- API 在 DataManager 失败时静默返回 legacy 数据或 mock 行情。
- `ingestion` 自己做历史 HTTP gap fill。
- `DataManager` 调 `bar_aggregator._handle_bar_input()` 或直接操作 `pipeline.bar_state`。
- `settings.py`、`main.py`、`QueryEngine` 各自手写一套 backfill run/cache reload/event emit。
- custom interval 在实时、查询、backfill、manual repair 中使用多套 bucket/merge 规则。

非目标：

- 不重写 FastAPI 应用。
- 不替换 SQLite storage。
- 不一次性推倒四个模块内部结构。
- 不把所有历史数据逻辑塞进 `DataManager.manager.py`。

---

## 2. 当前真实运行链路

### 2.1 启动链路

当前 `backend/app/main.py` 做了这些事：

1. `init_klines_storage()` 初始化 SQLite。
2. 创建 `DataManager()`。
3. 注入 `KlinesRepoAdapter` 到 DataManager。
4. 创建 `BinanceIngestionFactory()` 并注入 DataManager。
5. 创建独立 `TransportLayer + BackfillEngine`。
6. 调 `backfill_engine.reconciler.set_bar_aggregator(dm.bar_aggregator)`。
7. 在 `main.py` 内定义 `_backfill_trigger()` 和 `_load_backfilled_to_cache()`。
8. `dm.set_backfill_trigger(_backfill_trigger)`。
9. `await dm.start()`。
10. 启动旧 `SubscriptionManager + PriceTickerService`。
11. `main.py` 内启动 `_startup_gap_scan()`。
12. 桥接 `IndicatorEngine` 到 DataManager EventBus。

当前问题：

- `main.py` 同时承担组合根、backfill coordinator、startup scan、旧 price service 启停。
- backfill 完成后的 cache 回灌和事件通知写在 `main.py`。
- `PriceTickerService` 是独立行情旁路。
- `SubscriptionManager` 同时知道 DataManager 和 PriceTickerService。

目标启动链路：

```text
1. init storage
2. create DataManager
3. inject storage
4. inject ingestion factory
5. create BackfillEngine
6. dm.backfill.set_engine(backfill_engine)
7. await dm.start()
8. restore subscriptions through DataManager
9. bridge indicator engine
```

### 2.2 实时 K 线链路

当前主链路：

```text
API/WS ensure_stream()
  -> DataManager.ensure_stream()
  -> BarAggregator.add_target()
  -> StreamCoordinator.ensure_stream()
  -> BinanceIngestionFactory.start()
  -> MarketDataIngress.add_stream()
  -> StreamPipeline:
       FeedControl -> Normalize -> Continuity -> Delivery
  -> factory callback converts MarketEvent to bar_dict
  -> StreamCoordinator wraps _BarDictMarketEvent
  -> BarAggregator.on_market_event()
  -> Publisher
  -> DataManager._on_aggregator_event()
  -> cache + storage + event_bus
  -> WebSocket / indicators
```

当前问题：

- `BinanceIngestionFactory` 名字已经不准确，实际支持 `exchange` 参数。
- Factory 把 `MarketEvent` 转成 `bar_dict`，Coordinator 再转成 `_BarDictMarketEvent`，桥接格式偏临时。
- DataManager 在启动 stream 时直接访问 `coordinator._streams`。
- DataManager 直接访问 `bar_aggregator.get_pipeline()`、`pipeline.bar_state`、`_handle_bar_input()` 做 warm-start。
- OKX 高周期需要 1m base stream 的策略硬编码在 DataManager。

目标链路：

```text
DataManager.ensure_stream()
  -> StreamCoordinator.ensure_stream()
  -> KlineIngestionBridge / MarketIngestionBridge
  -> ingestion outputs MarketEvent
  -> BarAggregator public ingest API
  -> AggregatorBridge
  -> cache/storage/event_bus
```

### 2.3 历史查询和 backfill 链路

当前链路：

```text
api/v1/klines.py
  -> dm.query/query_latest/query_before
  -> QueryEngine
       cache -> storage -> detect gap -> _backfill_trigger
  -> main.py _backfill_trigger
  -> BackfillEngine.run()
       GapDetector -> Planner -> Fetcher -> Reconciler -> Publisher
  -> main.py _load_backfilled_to_cache
  -> dm.on_bars_backfilled()
  -> DataManager emits BACKFILL_COMPLETED
```

当前问题：

- `QueryEngine` 直接触发 backfill callback，不返回结构化 missing ranges。
- `main.py` 是实际 backfill coordinator。
- `DataManager.on_bars_backfilled()` 回灌 cache 后还会继续检测 gap 并触发 follow-up backfill。
- `settings.py` 也直接调 `backfill_engine.run()` 并手写 cache reload。
- `ingestion.ContinuityLayer` 仍可做 `_backfill_kline_gap()`。

目标链路：

```text
QueryEngine / StartupScan / Settings API / Ingestion GapMarker
        |
        v
DataManager.BackfillCoordinator.request(...)
        |
        v
BackfillEngine.run()
        |
        v
BackfillCoordinator reloads storage
        |
        v
DataManager.on_bars_backfilled()
        |
        v
EventBus BACKFILL_COMPLETED / BACKFILL_FAILED
```

### 2.4 价格订阅链路

当前链路：

```text
subscriptions API / price WS
  -> SubscriptionManager
  -> PriceTickerService
       own WS connections
       own price cache
       own callbacks
```

当前问题：

- 价格流绕过 `ingestion -> DataManager`。
- PriceTickerService 自己开 WS、REST daily open、缓存、callback。
- `GET /subscriptions/prices` 和 `WS /stream/prices` 不走 DataManager EventBus。

目标链路：

```text
Subscription tier
  FULL  -> DataManager.ensure_stream(...)
  PRICE -> DataManager.ensure_price_stream(...)
  NONE  -> persist only

ingestion MINI_TICKER/TICKER
  -> DataManager PriceSnapshotCache
  -> DataEventType.PRICE_UPDATED
  -> REST snapshot / price WS / watchlist
```

### 2.5 settings 维护链路

当前 `settings.py` 直接做：

- 读取 `dm.query_engine._storage`。
- 直接使用 `BackfillEngine.detect_only()` / `run()`。
- 直接创建 fresh `BarAggregator` 做 custom repair。
- 直接调用 `dm._seed_custom_interval()`。
- 直接读 `dm.cache._ephemeral_max_bars` 和 `dm._db_limits`。

目标：

- proxy/connectivity 可继续留在 settings API。
- storage gap scan 改为 `dm.backfill.scan_and_repair_storage(...)`。
- custom storage repair 改为 `dm.maintenance.repair_custom_series(...)`。
- cache limits 改为 DataManager public method 返回结果，不读私有字段。

---

## 3. 最终模块边界

### 3.1 ingestion

职责：

- 打开交易所 WS。
- 必要时做当前实时源的 HTTP polling/fallback。
- 把交易所原始 payload 标准化成 `MarketEvent`。
- 对实时事件做去重、乱序识别、gap marker。
- 输出 `MarketEvent` / `GapMarker` 到下游。
- 支持 `KLINE`、`TICKER`、`MINI_TICKER`、`TRADE`、`DEPTH` 等统一 stream type。

不做：

- 不生成最终 K 线。
- 不写 storage。
- 不回灌 DataManager cache。
- 不调 `BackfillEngine` 做历史修复。
- 不管理前端订阅状态。

关键 public contract：

```python
MarketDataIngress.add_stream(descriptor) -> StreamPipeline
StreamPipeline.delivery.on_market_event(callback)
StreamPipeline.delivery.on_gap(callback)
```

目标新增/调整：

```python
class SessionLike(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def on_message(self, callback): ...
    def on_health_change(self, callback): ...
    def snapshot(self) -> dict: ...
```

### 3.2 bar_aggregator

职责：

- 接收 `MarketEvent` / `BarInput` / historical bars。
- 统一计算 bucket。
- 合并 OHLCV。
- 判断 bar 生命周期。
- 发布 `BarEvent`。
- 保证实时、历史、manual repair 的 bucket/merge/finalize 规则一致。

不做：

- 不连交易所。
- 不主动 HTTP 拉历史。
- 不读写 storage。
- 不管理前端订阅。
- 不调 DataManager cache。

目标 public API：

```python
async def ingest_bar_input(
    target_interval: str,
    bar_input: BarInput,
    *,
    emit_events: bool = True,
) -> None: ...

async def seed_active_bar(
    symbol: str,
    interval: str,
    row: dict,
    *,
    exchange: str,
    market_type: str,
    emit_events: bool = False,
) -> BarState | None: ...

async def replay_components(
    symbol: str,
    source_interval: str,
    target_interval: str,
    rows: list[dict],
    *,
    exchange: str,
    market_type: str,
    emit_events: bool = False,
) -> BarState | None: ...

async def aggregate_batch(
    symbol: str,
    source_interval: str,
    target_interval: str,
    rows: list[dict],
    *,
    exchange: str,
    market_type: str,
    emit_events: bool = False,
) -> list[BarState]: ...

def get_bucket_state(...) -> BarState | None: ...
def expire_bucket(...) -> BarState | None: ...
```

### 3.3 data_manager

职责：

- 对 API/WS/Indicator/Subscription/Settings 提供唯一数据门面。
- 统一 query/query_latest/query_before。
- 管理 cache。
- 管理 EventBus。
- 管理 stream lifecycle。
- 桥接 BarAggregator events 到 cache/storage/event_bus。
- 管理 price snapshot cache。
- 通过 BackfillCoordinator 调度历史修复。
- 暴露 diagnostics/maintenance public methods。

不做：

- 不理解 BarAggregator pipeline 私有结构。
- 不直接运行 BackfillEngine.run/retry/reload 的散落逻辑。
- 不在 facade 里堆 warm-start、retention、custom repair 细节。
- 不硬编码 exchange-specific stream policy。

目标内部结构：

```text
data_manager/
├── manager.py                # thin facade
├── query.py                  # standard query orchestration
├── custom_query.py           # custom interval query/rebuild
├── coordinator.py            # stream lifecycle
├── aggregator_bridge.py      # BarEvent -> cache/storage/event_bus
├── warm_start.py             # seed active aggregator state
├── backfill_coordinator.py   # repair request orchestration
├── price_cache.py            # PriceSnapshot cache + events
├── subscriptions.py          # tier persistence/restore, DataManager-only
├── maintenance.py            # storage repair / gap scan / custom repair
├── retention.py              # DB/cache retention
├── cache.py
├── event_bus.py
└── models.py
```

### 3.4 backfill

职责：

- detect gaps。
- plan tasks。
- fetch historical data。
- reconcile/dedup/write storage。
- 输出 repair report / written ranges。

不做：

- 不管理 FastAPI/WebSocket。
- 不直接通知前端。
- 不直接回灌 DataManager cache。
- 不使用 realtime BarAggregator 主状态做 batch custom aggregation。

目标 public contract：

```python
await BackfillEngine.run(...) -> RepairReport
await BackfillEngine.detect_only(...) -> list[GapInfo]
```

目标新增：

```python
class HistoricalMarketDataClient(Protocol):
    async def fetch_klines(...) -> list[FetchedBar]: ...
```

`RepairReport` 需要能告诉 coordinator 哪些 range 被写入：

```python
written_ranges: list[WrittenRange]
```

---

## 4. 跨模块共享契约

### 4.1 SeriesKey

所有缓存、事件、stream、storage 访问统一使用：

```text
(exchange, market_type, symbol, interval)
```

执行要求：

- 新增代码不得只用 `(symbol, interval)` 做业务 key。
- 所有 storage query/upsert/delete 必须显式传 `exchange` 和 `market_type`。
- 所有 EventBus 事件必须带完整 `SeriesKey`。

### 4.2 IntervalPolicy

新增共享模块：

```text
backend/app/core/interval_policy.py
```

统一提供：

```python
parse_interval(interval)
is_exchange_native_interval(exchange, market_type, interval)
is_custom_interval(interval)
is_ephemeral_interval(interval)
base_interval_for(interval, exchange, market_type)
bucket_start_ms(ts_ms, interval)
bucket_end_ms(bucket_start_ms, interval)
next_bucket_start_ms(bucket_start_ms, interval)
decompose_for_historical_fetch(interval)
```

迁移后必须调用同一套规则的路径：

- `bar_aggregator.time_bucket`
- `data_manager.query/custom_query`
- `data_manager.warm_start`
- `backfill.planner`
- `backfill.reconciler`
- `settings maintenance repair`

### 4.3 RepairRequest

所有历史修复入口统一提交：

```python
@dataclass(frozen=True)
class RepairRequest:
    exchange: str
    market_type: str
    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    reason: str
    priority: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
```

`reason` 建议枚举值：

```text
query_empty
query_tail_gap
query_left_gap
query_interior_gap
load_more_shortfall
startup_scan
settings_gap_scan
settings_custom_repair
ingestion_gap_marker
custom_tail_repair
manual
```

### 4.4 PriceSnapshot

价格流统一进入 DataManager：

```python
@dataclass(slots=True)
class PriceSnapshot:
    exchange: str
    market_type: str
    symbol: str
    price: float
    open_24h: float = 0.0
    high_24h: float = 0.0
    low_24h: float = 0.0
    change_pct_24h: float = 0.0
    volume_24h: float = 0.0
    quote_volume_24h: float = 0.0
    daily_open: float = 0.0
    updated_at_ms: int = 0
```

事件类型新增：

```python
DataEventType.PRICE_UPDATED
```

---

## 5. 推荐执行顺序

执行顺序按依赖排列：

```text
阶段 0：基线和防旁路
阶段 1：低风险 bug 修复和 public wrapper
阶段 2：DataManager 内部服务拆分，不改行为
阶段 3：BarAggregator public seed/replay/batch API
阶段 4：BackfillCoordinator 收口
阶段 5：Ingestion gap marker 和内部边界收紧
阶段 6：价格流并入 ingestion + DataManager
阶段 7：custom interval/IntervalPolicy 统一
阶段 8：API/main/settings 迁移并删除旧 services/collectors
阶段 9：测试、文档、最终验收
```

可以并行的工作：

- 阶段 2 的 `retention.py` 拆分可与 `warm_start.py` 拆分并行。
- 阶段 5 的 normalizer 拆分可与阶段 6 price stream 工作并行。
- 阶段 7 的 IntervalPolicy 单测可提前写，但正式替换要等 BarAggregator batch API 稳定。

不建议提前做的工作：

- 不要在 BackfillCoordinator 完成前删除旧 backfill trigger。
- 不要在 DataManager price cache 完成前删除 PriceTickerService。
- 不要在 API 全部停止 import 旧 services 前删除 `services/`。
- 不要在 custom realtime/history/backfill/manual repair 共用规则前删除旧 custom 聚合 fallback。

---

## 6. 阶段 0：基线和防旁路

目标：先知道当前功能是否可跑，并防止新代码继续依赖旧旁路。

### 执行动作

- [ ] 记录当前测试基线：

```bash
cd backend
PYTHONPATH=. pytest -q
```

- [ ] 记录当前旧依赖清单：

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app backend/tests -g '*.py'
```

- [ ] 记录当前私有字段依赖清单：

```bash
rg -n "_handle_bar_input|get_pipeline\(|pipeline\.bar_state|query_engine\._|coordinator\._|cache\._" backend/app backend/tests -g '*.py'
```

- [ ] 给旧模块加 deprecated 注释，不改行为：

```text
backend/app/data_engine/services/__init__.py
backend/app/data_engine/services/price_ticker.py
backend/app/data_engine/services/subscription_manager.py
backend/app/data_engine/services/kline_cache_service.py
backend/app/data_engine/services/kline_aggregator.py
backend/app/data_engine/collectors/binance/spot_fetcher.py
```

- [ ] 新增一个轻量检查脚本或测试，先允许现有引用，但禁止新增正式路径引用旧 services/collectors。

建议路径：

```text
backend/tests/test_data_engine_architecture_boundaries.py
```

第一版可以只做白名单：

```text
允许：
  api/v1/klines.py
  api/v1/subscriptions.py
  main.py
  tests/test_symbol_normalization.py
  data_engine/services/*

禁止：
  新增任何其它 backend/app 路径 import app.data_engine.services
```

- [ ] 更新 `backend/app/main.py` 文件头注释，不再鼓励 legacy fallback 是正常运行模式。

### 验收标准

- [ ] 测试基线已记录。
- [ ] 旧服务引用清单已记录。
- [ ] 私有字段依赖清单已记录。
- [ ] 有自动化检查阻止新增旁路。

---

## 7. 阶段 1：低风险 bug 修复和 public wrapper

目标：先修明确 bug，给后续迁移补最小 public API，不大改行为。

### 7.1 修明确 bug

- [ ] 修 `QueryEngine._fill_interior_gaps()` 漏传 exchange。

当前代码只传了 `market_type`，应改为：

```python
rows = self._storage.query_bars(
    symbol=key.symbol,
    interval=key.interval,
    start_ms=gap_start_ms,
    end_ms=gap_end_ms,
    limit=5000,
    order="ASC",
    exchange=key.exchange,
    market_type=key.market_type,
)
```

- [ ] 修 `DataManager.on_bar_event()` 丢失 exchange。

目标签名：

```python
async def on_bar_event(
    self,
    symbol: str,
    interval: str,
    bar: BarData,
    event_type: DataEventType = DataEventType.BAR_UPDATED,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
```

并转发：

```python
await self.coordinator.on_bar_event(
    symbol,
    interval,
    bar,
    event_type,
    exchange=exchange,
    market_type=market_type,
)
```

- [ ] 修 `DataManager.shutdown()` 中重复 `await self._cleanup_task`。

### 7.2 给现有私有访问补 wrapper

- [ ] `QueryEngine` 增加：

```python
def set_storage(self, storage: StorageBackend) -> None: ...
def set_backfill_trigger(self, trigger: BackfillTrigger | None) -> None: ...
@property
def storage(self) -> StorageBackend | None: ...
@property
def backfill_trigger(self) -> BackfillTrigger | None: ...
```

- [ ] `DataManager.set_storage()` 改为调用 `self.query_engine.set_storage(storage)`。

- [ ] `DataManager.set_backfill_trigger()` 改为调用 `self.query_engine.set_backfill_trigger(trigger)`。

- [ ] `StreamCoordinator` 增加：

```python
def has_stream(key_or_fields...) -> bool: ...
def get_entry(key_or_fields...) -> StreamInfo | None: ...
def mark_bar_received(key_or_fields...) -> None: ...
def prewarm_targets(self) -> list[tuple[str, str, str]]: ...
def prewarm_intervals(self) -> tuple[str, ...]: ...
```

- [ ] `DataManager.ensure_stream()` 不再读 `self.coordinator._streams`。

- [ ] `DataManager._on_aggregator_event()` 不再读 `self.coordinator._streams`，改调 `mark_bar_received()`。

- [ ] `BarCache` 增加：

```python
def get_ephemeral_limit(self) -> int: ...
```

- [ ] `settings.py` 的 `/cache-limits` 响应不再读 `dm.cache._ephemeral_max_bars`。

### 7.3 ingestion gap fill 默认关掉

- [ ] 把 `IngestionConfig.continuity_auto_fill_gaps` 默认值改为 `false`。

环境变量仍可覆盖：

```text
INGESTION_CONTINUITY_AUTO_FILL=true
```

- [ ] 在 `ContinuityLayer._backfill_kline_gap()` docstring 标记 legacy。

### 7.4 测试

- [ ] 新增 `QueryEngine._fill_interior_gaps` 测试，断言 storage 收到正确 `exchange`。
- [ ] 新增 `DataManager.on_bar_event(exchange="okx")` 测试，断言 EventBus key 保留 exchange。
- [ ] 新增 wrapper 测试，确保不需要读私有字段也能完成原行为。

### 验收标准

- [ ] `rg -n "query_engine\._storage|query_engine\._backfill_trigger|coordinator\._streams|cache\._ephemeral_max_bars" backend/app/data_engine/data_manager backend/app/api/v1/settings.py` 数量下降，只剩待拆迁移点。
- [ ] 现有 K 线查询、WS、backfill 行为不变。
- [ ] `pytest -q backend/tests` 通过。

---

## 8. 阶段 2：DataManager 内部服务拆分，不改行为

目标：先把 `manager.py` 从“大门面 + 修补中心”拆回清晰组件，但尽量保持行为一致。

### 8.1 抽 `warm_start.py`

新增：

```text
backend/app/data_engine/data_manager/warm_start.py
```

迁移方法：

- [ ] 移动 `_seed_custom_interval()`。
- [ ] 移动 `_seed_standard_interval()`。
- [ ] 移动 `_custom_bucket_is_synced()`。
- [ ] 移动 `_trigger_custom_tail_repair()`。

目标类：

```python
class AggregatorWarmStartService:
    async def seed_if_needed(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        had_stream: bool,
    ) -> None: ...
```

第一版允许内部继续调用现有私有 aggregator API，因为阶段 3 会替换。

DataManager 保留：

```python
await self.warm_start.seed_if_needed(...)
```

### 8.2 抽 `aggregator_bridge.py`

新增：

```text
backend/app/data_engine/data_manager/aggregator_bridge.py
```

迁移方法：

- [ ] 移动 `_on_aggregator_event()`。
- [ ] 移动 `_persist_bar_event()`。
- [ ] bridge 接收 `cache`、`event_bus`、`storage provider`、`stream marker`。
- [ ] DataManager 只负责 wiring：

```python
self.aggregator_bridge = AggregatorBridge(...)
self.bar_aggregator.publisher.on_bar_event(self.aggregator_bridge.on_bar_event)
```

### 8.3 抽 `retention.py`

新增：

```text
backend/app/data_engine/data_manager/retention.py
```

迁移方法：

- [ ] 移动 `_run_startup_db_cleanup()`。
- [ ] 移动 `_ephemeral_trim_loop()`。
- [ ] 移动 `_run_ephemeral_trim()`。
- [ ] 移动 `_db_limits` 管理。

目标 public API：

```python
dm.update_retention_limits(...) -> dict
dm.retention.snapshot() -> dict
```

### 8.4 抽 `custom_query.py`

新增：

```text
backend/app/data_engine/data_manager/custom_query.py
```

迁移方法：

- [ ] 移动 `_query_custom_from_base()`。
- [ ] 移动 `_query_custom_before()`。
- [ ] 移动 `_aggregate_custom_bars()`。
- [ ] `QueryEngine` 对 custom interval 只委托 `CustomIntervalQueryService`。

第一版可以继续使用当前 `core.market` 聚合函数；阶段 7 再替换到统一 batch API。

### 8.5 测试

- [ ] 给 `warm_start.py` 添加标准周期 seed 测试。
- [ ] 给 `warm_start.py` 添加 custom seed 当前 bucket 测试。
- [ ] 给 `aggregator_bridge.py` 添加 CLOSED/AMENDED 持久化测试。
- [ ] 给 `retention.py` 添加 cache/db limit 测试。
- [ ] 给 `custom_query.py` 添加 45m、91m、1w、2M 查询测试。

### 验收标准

- [ ] `DataManager.manager.py` 不再包含大量 warm-start/backfill/retention 算法。
- [ ] 行为保持一致。
- [ ] `DataManager.ensure_stream()` 只做参数归一化、target 注册、coordinator 调用、warm-start 委托。

---

## 9. 阶段 3：BarAggregator public seed/replay/batch API

目标：停止 DataManager 和 Backfill 依赖 BarAggregator 内部 pipeline。

### 9.1 新增 public API

- [ ] 新增 `BarAggregator.ingest_bar_input(...)`，内部包住 `_handle_bar_input()`。
- [ ] 新增 `BarAggregator.seed_active_bar(...)`，用于标准周期 warm-start。
- [ ] 新增 `BarAggregator.replay_components(...)`，用于 custom forming bucket seed。
- [ ] 新增 `BarAggregator.aggregate_batch(...)`，用于 backfill/settings custom repair。
- [ ] 新增 `BarAggregator.get_bucket_state(...)`。
- [ ] 新增 `BarAggregator.expire_bucket(...)`。

要求：

- `emit_events=False` 时不得向普通 publisher 发事件。
- batch API 不污染 realtime 主状态。
- 第一版可以创建临时 isolated `BarAggregator` 实例实现 batch，避免重构主 pipeline。

### 9.2 替换 DataManager warm-start 调用

- [ ] `warm_start.seed_standard()` 改用 `seed_active_bar()`。
- [ ] `warm_start.seed_custom()` 改用 `replay_components()`。
- [ ] `warm_start` 不再调用 `_handle_bar_input()`。
- [ ] `warm_start` 不再直接操作 `pipeline.bar_state`。
- [ ] `get_pipeline()` 在业务路径不再使用，只留 advanced/debug。

### 9.3 替换 settings custom repair 聚合

- [ ] `settings.py` 或后续 `maintenance.py` 的 `_aggregate_custom_rows()` 改用 `aggregate_batch()`。
- [ ] 删除 fresh `BarAggregator + publisher capture` 的临时实现。

### 9.4 替换 backfill custom aggregation

- [ ] `Reconciler._generate_custom_bars()` 改用 `aggregate_batch()`。
- [ ] 不再调用主 `dm.bar_aggregator.add_target()`。
- [ ] 不再调用主 `dm.bar_aggregator.on_backfill_bars()`。
- [ ] 不再调用 `get_recent_bars(limit=10000)` 收集 batch 结果。

### 9.5 引入 RoutingPolicy / MergeMode

先新增模型，不必一次替换全部逻辑：

```python
class MergeMode(str, Enum):
    SNAPSHOT = "snapshot"
    INCREMENTAL = "incremental"
    COMPONENT = "component"
    PRICE_ONLY = "price_only"
```

- [ ] `BarInput` 增加可选 `merge_mode`。
- [ ] `EventRouter` 对 OKX 1m fanout 标记 `PRICE_ONLY`。
- [ ] `BarStateEngine`/merge strategy 按 `merge_mode` 执行，而不是用 `source_interval != state.interval` 推断。

### 测试

- [ ] `seed_active_bar()` 不 emit event，后续 realtime tick 能正确 merge OHLCV。
- [ ] `replay_components()` 能重建当前 custom bucket。
- [ ] `aggregate_batch()` 多次调用不会改变主 aggregator `targets/active/recent`。
- [ ] `aggregate_batch()` 对 45m、91m、1w、2M 结果稳定。
- [ ] OKX `1m -> 1h` PRICE_ONLY 不污染 volume/trades。

### 验收标准

- [ ] `rg -n "_handle_bar_input|pipeline\.bar_state|get_pipeline\(" backend/app/data_engine/data_manager backend/app/api/v1/settings.py backend/app/data_engine/backfill` 无业务调用。
- [ ] backfill custom aggregation 与 realtime custom aggregation 使用同一套 BarAggregator 规则。

---

## 10. 阶段 4：BackfillCoordinator 收口

目标：所有历史修复入口统一调度、去重、重试、回灌 cache、发事件。

### 10.1 新增文件

```text
backend/app/data_engine/data_manager/backfill_coordinator.py
```

核心类：

```python
class BackfillCoordinator:
    def set_engine(self, engine: BackfillEngine) -> None: ...

    def request(self, request: RepairRequest) -> str: ...

    async def request_and_wait(self, request: RepairRequest) -> RepairOutcome: ...

    async def startup_scan(self, targets: list[...]) -> ScanReport: ...

    async def scan_and_repair_storage(...) -> ScanReport: ...

    async def repair_custom_series(...) -> RepairReport: ...

    async def shutdown(self) -> None: ...
```

### 10.2 调度规则

- [ ] 按 `(exchange, market_type, symbol, interval)` 做 in-flight guard。
- [ ] 合并重叠或相邻 range。
- [ ] 同一 series 同时只跑一个 BackfillEngine run。
- [ ] 支持 retry/backoff。
- [ ] 支持 cancellation on shutdown。
- [ ] 支持 reason/metadata 记录。
- [ ] 所有结果进入 coordinator snapshot。

### 10.3 回灌规则

BackfillEngine 完成后：

- [ ] 从 report 或 plan 中计算 written ranges。
- [ ] 对每个 written range 从 storage 读最终 bars。
- [ ] 调 `DataManager.on_bars_backfilled(...)`。
- [ ] emit `BACKFILL_COMPLETED`。
- [ ] 失败 emit `BACKFILL_FAILED`。
- [ ] 不在 `DataManager.on_bars_backfilled()` 内继续触发 follow-up backfill；follow-up 应由 coordinator 决定。

### 10.4 迁移调用方

- [ ] `main.py` 删除 `_backfill_trigger()`。
- [ ] `main.py` 删除 `_load_backfilled_to_cache()`。
- [ ] `dm.set_backfill_trigger(...)` 改为设置 coordinator 或 QueryEngine 提交 request。
- [ ] `main.py` 的 `_startup_gap_scan()` 移入 `BackfillCoordinator.startup_scan()`。
- [ ] `QueryEngine` 保持短期 callback 也可以，但 callback 目标必须是 coordinator。
- [ ] 中期 `QueryEngine` 返回 `MissingRange`，由 DataManager 调 coordinator。
- [ ] `settings.py` gap scan 改调 coordinator。
- [ ] `settings.py` custom repair 改调 `dm.maintenance`，再由 maintenance 调 coordinator/batch API。
- [ ] ingestion gap marker 接入 coordinator。

### 10.5 BackfillEngine/Reconciler 配套修正

- [ ] `ReconcileResult` 增加 `write_errors` / `failed_batches`。
- [ ] `_dedup_and_write()` 写入失败必须进入 `ReconcileResult.errors`。
- [ ] custom bar 写入失败必须进入 `ReconcileResult.errors`。
- [ ] `BackfillEngine.run()` 对写入错误返回 `PARTIAL`。
- [ ] `DeduplicationStrategy.NEWER_WINS` 改名为 `BACKFILL_WINS`，或实现真正 existing row metadata 比较。
- [ ] `RepairReport` 增加 `written_ranges`，供 coordinator 回灌。

### 10.6 测试

- [ ] 同一 request 重复提交只跑一个 backfill。
- [ ] 重叠 range 合并。
- [ ] BackfillEngine `COMPLETED/PARTIAL/FAILED` 映射到正确 DataEvent。
- [ ] settings gap scan 不直接调用 BackfillEngine。
- [ ] startup scan 由 coordinator 执行并可取消。
- [ ] 写库失败时状态是 `PARTIAL` 或 `FAILED`，不会伪装成 completed。

### 验收标准

- [ ] `rg -n "backfill_engine\.run|detect_only|on_bars_backfilled" backend/app/main.py backend/app/api/v1/settings.py` 不再出现手写修复流程。
- [ ] `main.py` 不再保存 `backfill_futures`。
- [ ] `DataManager.on_bars_backfilled()` 只负责 cache merge + event emit，不负责调度下一次 backfill。

---

## 11. 阶段 5：Ingestion gap marker 和内部边界收紧

目标：ingestion 只输出稳定实时事件和 gap marker，不做历史修复，同时降低交易所解析和 WS 生命周期重复。

### 11.1 移除 L5 自动 backfill

- [ ] `continuity_auto_fill_gaps` 默认 false 已在阶段 1 完成。
- [ ] 删除或废弃 `ContinuityLayer._backfill_kline_gap()` 正式调用路径。
- [ ] `ContinuityLayer` 发现 gap 后只 emit `GapMarker`。
- [ ] `DeliveryLayer` 能稳定 deliver gap event。
- [ ] `DataManager` 或 `BackfillCoordinator` 订阅 ingestion gap marker 并提交 `RepairRequest(reason="ingestion_gap_marker")`。

### 11.2 拆 NormalizeLayer

新增：

```text
backend/app/data_engine/ingestion/normalizers/
├── __init__.py
├── base.py
├── binance.py
└── okx.py
```

- [ ] Binance WS/HTTP kline/trade/ticker/depth 解析迁入 `binance.py`。
- [ ] OKX WS/HTTP kline/ticker 解析迁入 `okx.py`。
- [ ] `NormalizeLayer` 只负责按 descriptor.exchange 分发。
- [ ] 每个交易所 normalizer 单独测试。

### 11.3 统一 Session 抽象

新增：

```text
backend/app/data_engine/ingestion/session_types.py
```

或放入 `session.py`：

```python
class SessionLike(Protocol): ...
```

- [ ] `SessionLayer` 实现 `SessionLike`。
- [ ] 当前 OKX `SharedWsHub` 包成 `SharedSessionAdapter` 或 `MultiplexedMessageSession`。
- [ ] `FeedControlLayer` 只依赖 `SessionLike`，不直接知道 OKX shared WS 分支。
- [ ] `SharedWsHubRegistry` 保留，但职责收窄到 session factory/cache。

### 11.4 Delivery 反压模型

- [ ] 保留 ordered callback 给 BarAggregator/DataManager 核心链路。
- [ ] 给非核心消费者提供 async queue subscriber。
- [ ] 文档明确 ordered callback 会反压 ingestion 主链路。

### 测试

- [ ] GapMarker 不触发 ingestion HTTP backfill。
- [ ] GapMarker 能到达 BackfillCoordinator。
- [ ] Binance/OKX normalizer 单测互不影响。
- [ ] OKX shared WS 和普通 session 的 health/reconnect snapshot 结构一致。

### 验收标准

- [ ] `rg -n "_backfill_kline_gap|HTTP_BACKFILL" backend/app/data_engine/ingestion` 只剩兼容/测试/模型定义，不在主链路触发。
- [ ] `ingestion` 不 import `backfill`。

---

## 12. 阶段 6：价格流并入 ingestion + DataManager

目标：删除 `PriceTickerService` 旁路，让 watchlist price tier 也走统一事件总线。

### 12.1 DataManager price cache

新增：

```text
backend/app/data_engine/data_manager/price_cache.py
```

- [ ] 定义 `PriceSnapshot`。
- [ ] 定义 `PriceSnapshotCache`。
- [ ] `DataEventType` 增加 `PRICE_UPDATED`。
- [ ] DataManager 增加：

```python
async def ensure_price_stream(symbol, *, exchange, market_type) -> StreamInfo: ...
def get_price(symbol, *, exchange, market_type) -> PriceSnapshot | None: ...
def get_prices_snapshot(...) -> list[dict]: ...
```

### 12.2 ingestion ticker bridge

- [ ] `MarketIngestionFactory` 支持 `StreamType.MINI_TICKER` / `TICKER`。
- [ ] 对支持 multi-symbol ticker 的交易所，允许一个 stream fan-out 多 symbol。
- [ ] 对 OKX 这类 per-symbol ticker，用统一 session/factory 表达，不再写 PriceTickerService 特例。
- [ ] ticker `MarketEvent` 进入 DataManager price cache。

### 12.3 daily open

当前 PriceTickerService 会额外取 1D open。迁移选项：

- [ ] 短期：DataManager price cache 使用 ticker 24h open，字段名保持兼容。
- [ ] 中期：新增 `DailyOpenService`，通过 DataManager/Backfill/storage 查询当前 1d open。
- [ ] 不要让 price cache 直接裸写一套 REST requests 旁路。

建议中期目标：

```text
daily_open = dm.query_latest(symbol, "1d", limit=1).bars[-1].open
```

如果无 1d 数据，由 coordinator 请求 backfill 1d。

### 12.4 subscription 管理迁移

新增或迁移：

```text
backend/app/data_engine/data_manager/subscriptions.py
```

- [ ] `SubscriptionTier` 从旧 services 迁入 DataManager 或 API 层。
- [ ] `FULL` 调 `dm.ensure_stream(symbol, "1m", ...)`。
- [ ] `PRICE` 调 `dm.ensure_price_stream(symbol, ...)`。
- [ ] `NONE` 只保存 tier，不启动行情。
- [ ] subscription persistence 保留 SQLite 表，可复用原 schema。
- [ ] 删除 `SubscriptionManager.set_price_ticker()`。

### 12.5 API/WS 迁移

- [ ] `GET /subscriptions/prices` 改为 `dm.get_prices_snapshot()`。
- [ ] `WS /stream/prices` 改为订阅 `DataEventType.PRICE_UPDATED`。
- [ ] `POST /subscriptions/sync` 不 import 旧 `SubscriptionTier`。
- [ ] `PUT /subscriptions/{symbol}` 不 import 旧 `SubscriptionTier`。
- [ ] `main.py` 不再创建 `PriceTickerService`。
- [ ] shutdown 不再 stop `PriceTickerService`。

### 测试

- [ ] PRICE tier 会启动 price stream，不启动 kline stream。
- [ ] FULL tier 会启动 kline stream，也能有 price snapshot。
- [ ] `GET /subscriptions/prices` 不依赖 `app.state.price_ticker`。
- [ ] `WS /stream/prices` 从 DataManager EventBus 收到 `PRICE_UPDATED`。

### 验收标准

- [ ] `rg -n "PriceTickerService|price_ticker" backend/app -g '*.py'` 无正式路径引用。
- [ ] `backend/app/data_engine/services/price_ticker.py` 可删除。

---

## 13. 阶段 7：custom interval 和 IntervalPolicy 统一

目标：实时、查询、backfill、manual repair 对 custom interval 给出同一套答案。

### 13.1 新增 IntervalPolicy

- [ ] 新增 `backend/app/core/interval_policy.py`。
- [ ] 从 `core.market` 迁入或代理：
  - parse custom/native interval。
  - weekly Monday UTC bucket。
  - monthly calendar bucket。
  - base interval selection。
  - exchange-native interval 判断。
  - ephemeral interval 判断。

### 13.2 替换调用方

- [ ] `bar_aggregator.models/time_bucket.py` 使用 IntervalPolicy。
- [ ] `data_manager.custom_query.py` 使用 `BarAggregator.aggregate_batch()` 或 IntervalPolicy bucket。
- [ ] `data_manager.warm_start.py` 使用 IntervalPolicy。
- [ ] `backfill.models/planner/reconciler.py` 使用 IntervalPolicy。
- [ ] `settings maintenance repair` 使用 `BarAggregator.aggregate_batch()`。
- [ ] 旧 `services/kline_aggregator.py` 若还未删除，内部改为调用同一 batch API 或标记不可用。

### 13.3 custom query 最终形态

查询 custom interval：

```text
QueryEngine
  -> CustomIntervalQueryService
  -> query base interval through QueryEngine
  -> BarAggregator.aggregate_batch(emit_events=False)
  -> cache custom result
```

backfill custom interval：

```text
BackfillPlanner decomposes interval
  -> HistoricalFetcher fetches base components
  -> Reconciler writes base bars
  -> Reconciler calls BarAggregator.aggregate_batch(emit_events=False)
  -> writes custom bars
```

settings repair custom interval：

```text
MaintenanceService
  -> ensure base complete via BackfillCoordinator
  -> query base rows
  -> BarAggregator.aggregate_batch(emit_events=False)
  -> compare/write custom rows
  -> warm DataManager cache through public API
```

### 测试

- [ ] `compute_bucket_start` weekly 以 Monday UTC 对齐。
- [ ] `1M/2M/3M` 以 calendar month 对齐，不用固定 30 天 bucket。
- [ ] 45m 查询、realtime seed、backfill、settings repair 结果一致。
- [ ] 91m 查询、realtime seed、backfill、settings repair 结果一致。
- [ ] 2M 查询、backfill、settings repair 结果一致。

### 验收标准

- [ ] `rg -n "compute_bucket_start_ms|parse_interval_ms|STANDARD_INTERVAL_MS|INTERVAL_SECONDS" backend/app/data_engine backend/app/api/v1/settings.py` 结果可解释，非权威实现逐步消失。
- [ ] custom interval 只剩一套 bucket/merge/finalize 权威实现。

---

## 14. 阶段 8：API/main/settings 迁移并删除旧 services/collectors

目标：正式路径只通过 DataManager，旧模块退出。

### 14.1 `api/v1/klines.py`

- [ ] 删除文件顶部旧 imports：

```python
from app.data_engine.mock_data import generate_mock_klines
from app.data_engine.services import aggregate_klines, aggregate_multi_resolution
```

- [ ] DataManager 为 None 时所有正式 K 线 endpoint 返回 503。
- [ ] DataManager 查询失败时返回 500 或明确错误，不 fallback legacy。
- [ ] 删除 `_legacy_get_klines()`。
- [ ] 删除 `_legacy_get_latest()`。
- [ ] 删除 `_legacy_get_history()`。
- [ ] 删除 `_legacy_get_before()`。
- [ ] `/storage/meta` 只调 `dm.get_bounds()`，无 dm 返回 503。
- [ ] `/storage` delete 改为 DataManager maintenance/storage facade。
- [ ] `/indicators/sma` 改为 indicator engine 或删除/迁移到 indicators API。

### 14.2 `api/v1/subscriptions.py`

- [ ] 全部改用 DataManager subscription service。
- [ ] 删除 `app.state.subscription_manager` 依赖，或将其变成 DataManager 内部服务引用。
- [ ] 删除 `app.state.price_ticker` 依赖。
- [ ] price WS 订阅 DataManager EventBus。

### 14.3 `api/v1/settings.py`

- [ ] proxy 设置保留。
- [ ] `_get_transports()` 不读 factory private `_ingress._transport`；改由 DataManager/ingestion factory public method 暴露 transports 或 config update。
- [ ] `/storage/repair` 调 `dm.maintenance.repair_custom_series(...)`。
- [ ] `/storage/gap-scan` 调 `dm.backfill.scan_and_repair_storage(...)`。
- [ ] `/cache-limits` 调 DataManager public method 并返回 public snapshot。
- [ ] 不再创建 fresh `BarAggregator`。
- [ ] 不再调用 `dm._seed_custom_interval()`。
- [ ] 不再读 `dm.query_engine._storage`。

### 14.4 `main.py`

- [ ] 删除旧 fallback 注释。
- [ ] 删除 `PriceTickerService` 创建/start/stop。
- [ ] 删除旧 `SubscriptionManager` 创建/start。
- [ ] 删除 `_backfill_trigger()`。
- [ ] 删除 `_load_backfilled_to_cache()`。
- [ ] 删除 `_startup_gap_scan()` 内联实现。
- [ ] 只负责组合根 wiring。

### 14.5 删除旧文件

删除前必须确认无正式引用：

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app backend/tests -g '*.py'
```

可删除清单：

```text
backend/app/data_engine/services/price_ticker.py
backend/app/data_engine/services/subscription_manager.py
backend/app/data_engine/services/kline_cache_service.py
backend/app/data_engine/services/kline_aggregator.py
backend/app/data_engine/services/__init__.py
backend/app/data_engine/collectors/binance/spot_fetcher.py
backend/app/data_engine/collectors/binance/__init__.py
backend/app/data_engine/collectors/__init__.py
backend/app/data_engine/collectors/
```

`mock_data.py` 保留为显式 dev/test fixture，不允许正式 API 自动 fallback。

### 验收标准

- [ ] K 线 HTTP API 只调用 DataManager。
- [ ] K 线 WebSocket 只通过 DataManager EventBus 推送。
- [ ] price REST/WS 只通过 DataManager。
- [ ] settings repair/gap-scan 只通过 DataManager maintenance/backfill coordinator。
- [ ] `backend/app/data_engine/services/` 删除或为空壳兼容层，正式路径无 import。
- [ ] `backend/app/data_engine/collectors/` 删除。

---

## 15. 阶段 9：测试、文档、最终验收

### 15.1 单元测试矩阵

- [ ] `SeriesKey` exchange/market_type/symbol/interval topic 和匹配。
- [ ] `IntervalPolicy` native/custom/weekly/monthly/ephemeral。
- [ ] `BarAggregator.seed_active_bar()`。
- [ ] `BarAggregator.replay_components()`。
- [ ] `BarAggregator.aggregate_batch()` isolated state。
- [ ] `RoutingPolicy` OKX 1m fanout。
- [ ] `MergeMode.PRICE_ONLY` 不污染 volume/trades。
- [ ] `QueryEngine` cache/storage/backfill request。
- [ ] `CustomIntervalQueryService` 45m/91m/2M。
- [ ] `BackfillCoordinator` dedup/coalesce/retry/cancel。
- [ ] `Reconciler` write failure -> partial。
- [ ] `PriceSnapshotCache` update/snapshot/event。
- [ ] `SubscriptionService` FULL/PRICE/NONE。
- [ ] `MaintenanceService` custom repair。

### 15.2 集成测试矩阵

- [ ] `/api/v1/klines` DataManager 可用时返回数据。
- [ ] `/api/v1/klines` DataManager 不可用时返回 503。
- [ ] `/api/v1/klines/history` 缺数据时提交 BackfillCoordinator request。
- [ ] `/api/v1/stream/klines` 收到 BAR_UPDATED/BAR_CLOSED。
- [ ] `/api/v1/stream/klines_multi` 收到 BACKFILL_COMPLETED。
- [ ] `/api/v1/subscriptions/prices` 从 DataManager price cache 返回。
- [ ] `/api/v1/stream/prices` 收到 PRICE_UPDATED。
- [ ] `/api/v1/settings/storage/gap-scan` 只走 coordinator。
- [ ] `/api/v1/settings/storage/repair` custom repair 使用 batch API。

### 15.3 架构边界测试

新增或完善：

```text
backend/tests/test_data_engine_architecture_boundaries.py
```

必须断言：

- [ ] `backend/app` 无 `app.data_engine.services` import。
- [ ] `backend/app` 无 `app.data_engine.collectors` import。
- [ ] `api/v1` 不 import `bar_aggregator`，除非是 settings maintenance 已迁出。
- [ ] `ingestion` 不 import `backfill`。
- [ ] `bar_aggregator` 不 import `storage`。
- [ ] `backfill` 不 import `data_manager`。
- [ ] `data_manager` 不调用 `bar_aggregator._handle_bar_input`。

### 15.4 文档更新

- [ ] 更新 `README_zh.md` 数据引擎说明。
- [ ] 更新 `API_zh.md`：
  - DataManager 不可用返回 503。
  - backfill async completion event。
  - price stream 数据源为 DataManager。
- [ ] 更新四个模块 README：
  - ingestion：gap marker only。
  - bar_aggregator：public seed/replay/batch API。
  - data_manager：BackfillCoordinator/PriceSnapshotCache/SubscriptionService。
  - backfill：BackfillEngine 只做 pipeline。

### 15.5 最终验收命令

```bash
cd backend
PYTHONPATH=. pytest -q
```

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app -g '*.py'
```

期望：无输出。

```bash
rg -n "_handle_bar_input|pipeline\.bar_state|query_engine\._|coordinator\._|cache\._" backend/app -g '*.py'
```

期望：正式路径无输出；如有输出，必须是模块内部实现或明确 debug/advanced 代码。

```bash
rg -n "PriceTickerService|SubscriptionManager|kline_cache_service|kline_aggregator|spot_fetcher" backend/app -g '*.py'
```

期望：无输出。

---

## 16. 跨模块协作规则

### 16.1 谁可以调用谁

允许：

```text
DataManager -> ingestion public API
DataManager -> bar_aggregator public API
DataManager -> BackfillCoordinator
BackfillCoordinator -> BackfillEngine
BackfillEngine -> HistoricalMarketDataClient
BackfillEngine -> BarAggregator batch API
API/WS/Indicator/Subscription/Settings -> DataManager public API
```

禁止：

```text
API -> storage direct
API -> backfill_engine.run direct
API -> bar_aggregator direct
API -> data_engine.services
ingestion -> backfill
bar_aggregator -> storage
bar_aggregator -> DataManager
backfill -> DataManager
DataManager facade -> downstream private fields
```

### 16.2 事件顺序

实时 K 线核心路径保持强顺序：

```text
ingestion ordered callback
  -> bar_aggregator
  -> AggregatorBridge
  -> cache/storage/event_bus
```

非核心消费者必须走异步队列：

```text
metrics/logging/debug UI
  -> async side subscriber
```

### 16.3 backfill 并发

BackfillCoordinator 必须保证：

- 同一 `(exchange, market_type, symbol, interval)` 同时最多一个 active repair。
- 重叠 range 合并。
- 不同 exchange/market_type 互不污染。
- shutdown 取消 pending tasks。
- `FAILED` 和 `PARTIAL` 都发事件，调用方不能只等 `COMPLETED`。

### 16.4 custom interval correctness

任何 custom interval 结果必须说明来源：

```text
realtime forming    -> BarAggregator target pipeline
HTTP query rebuild  -> BarAggregator batch API
backfill repair     -> BarAggregator batch API
settings repair     -> BarAggregator batch API
```

不允许新增 ad hoc 聚合函数。

---

## 17. 风险和回滚策略

### 17.1 最大风险点

- BarAggregator batch API 如果不隔离状态，会污染 realtime active/recent bars。
- BackfillCoordinator 如果去重范围处理错误，会漏补或重复补。
- PriceTickerService 删除前，如果 price stream 未覆盖 OKX/Binance futures，会影响 watchlist。
- IntervalPolicy 替换如果月线/周线规则改变，会导致历史 custom 数据重建结果变化。
- API 取消 legacy fallback 后，DataManager 初始化失败会更显性暴露。

### 17.2 回滚原则

- 每个阶段单独提交，避免跨阶段混杂。
- 删除旧 services 前保留一个版本周期的兼容分支或 tag。
- BackfillCoordinator 首版可以只接管 query/main/settings 中一个入口，确认后再迁其它入口。
- Price stream 迁移可先双写：
  - PriceTickerService 仍运行。
  - DataManager price cache 同时运行。
  - API 先从 DataManager 读，必要时临时 fallback 到 PriceTickerService。
  - 验收稳定后删除 fallback。

### 17.3 不允许的回滚方式

- 不允许重新让 API 直接调用旧 `kline_cache_service`。
- 不允许在 `ingestion` 恢复自动 HTTP backfill 作为长期方案。
- 不允许新增另一个独立 price service 替代 PriceTickerService。

---

## 18. 建议 PR 切分

### PR 1：边界测试 + 低风险 bug

包含阶段 0 和阶段 1。

验收重点：

- exchange 漏传修复。
- on_bar_event exchange 修复。
- wrapper 减少私有字段依赖。
- continuity auto fill 默认 false。

### PR 2：DataManager 变薄

包含阶段 2。

验收重点：

- `warm_start.py`、`aggregator_bridge.py`、`retention.py`、`custom_query.py` 出现。
- 行为不变。

### PR 3：BarAggregator public API

包含阶段 3。

验收重点：

- DataManager 不再调 aggregator 私有 API。
- batch API isolated。

### PR 4：BackfillCoordinator

包含阶段 4。

验收重点：

- main/settings/query backfill 入口收口。
- cache reload/event emit 统一。
- Reconciler 错误语义修正。

### PR 5：Ingestion 边界

包含阶段 5。

验收重点：

- ingestion gap marker only。
- normalizer 拆分。
- SessionLike 初步落地。

### PR 6：价格和订阅迁移

包含阶段 6。

验收重点：

- PRICE tier 走 DataManager。
- price REST/WS 走 EventBus。
- PriceTickerService 可删除。

### PR 7：custom interval 统一

包含阶段 7。

验收重点：

- IntervalPolicy 成为唯一规则入口。
- custom realtime/query/backfill/settings repair 一致。

### PR 8：删除旧路径和文档收尾

包含阶段 8 和阶段 9。

验收重点：

- 无 services/collectors import。
- legacy fallback 删除。
- README/API 文档更新。

---

## 19. 最终完成定义

当以下条件全部满足，dataengine 架构规范化才算完成：

1. K 线 HTTP API 只通过 `DataManager` 查询。
2. K 线 WebSocket 只通过 `DataManager.EventBus` 推送。
3. watchlist price stream 只通过 `ingestion -> DataManager` 更新。
4. `settings.py` 不直接运行 BackfillEngine 或 BarAggregator。
5. `main.py` 只做组合根，不承担 backfill coordinator 职责。
6. `ingestion` 只 emit gap marker，不做历史修复。
7. 所有历史修复入口都通过 `BackfillCoordinator`。
8. custom interval 的实时、查询、backfill、manual repair 使用同一套 bucket/merge/finalize 规则。
9. `DataManager` 不调用 `bar_aggregator` 私有方法。
10. `BackfillEngine` 不依赖 DataManager，不直接通知前端。
11. `bar_aggregator` 不读写 storage。
12. 正式代码无 `app.data_engine.services` import。
13. 正式代码无 `app.data_engine.collectors` import。
14. DataManager 初始化失败时 API 返回明确 503，不返回 mock 或 legacy 数据。

最终判断新功能放哪里，只按这四句话：

```text
从交易所拿数据：放 ingestion。
把输入变成 K 线：放 bar_aggregator。
给应用读、订阅、缓存、推送：放 data_manager。
补历史缺口：放 backfill，通过 BackfillCoordinator 调度。
```
