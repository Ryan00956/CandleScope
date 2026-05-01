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

## 0. 当前执行状态

截至当前实现，已完成或基本落地的内容：

- 阶段 0/1：新增边界测试；修复 `QueryEngine` 内部 gap fill 漏传 `exchange`；修复 `DataManager.on_bar_event()` 丢失 `exchange`；补齐 `QueryEngine`、`StreamCoordinator`、`BarCache` 的 public wrapper；删除 ingestion 自动 HTTP gap fill 配置；旧 `services/collectors` 源文件已删除。
- 阶段 2：`DataManager` 已拆出 `aggregator_bridge.py`、`warm_start.py`、`retention.py`、`custom_query.py`，`manager.py` 主要保留 facade/wiring。
- 阶段 3：`BarAggregator` 已提供 `ingest_bar_input()`、`seed_active_bar()`、`replay_components()`、`aggregate_batch()`、bucket state/expire 等 public API；`warm_start`、settings custom repair、backfill custom aggregation 已停止依赖业务路径私有 pipeline。
- 阶段 4：已新增 `BackfillCoordinator`，接管 `QueryEngine` trigger、startup scan、`main.py` backfill 调度、settings gap scan 和 custom repair 的基础周期补齐；`main.py` 已删除手写 `_backfill_trigger()`、`_load_backfilled_to_cache()`、内联 `_startup_gap_scan()`。
- 阶段 5：ingestion `GapMarker` 已通过 `BinanceIngestionFactory -> StreamCoordinator -> DataManager.set_backfill_trigger()` 接入统一 backfill trigger；`ContinuityLayer` 已删除内联 HTTP gap fill，只负责 emit gap marker；`NormalizeLayer` 已收窄为 L4 管线门面，Binance/OKX 解析已迁入独立 normalizer；`SessionLike` 已落地，普通 `SessionLayer` 与 OKX shared WS 通过同一 session contract 接入 `FeedControlLayer`；`DeliveryLayer` 已明确 ordered callback 和 bounded queue subscriber 的反压边界。
- 阶段 6：新增 `data_manager/price_cache.py` 和 `data_manager/ingestion_price_source.py`，`DataManager` 已提供 `ensure_price_stream()`、`get_price()`、`get_prices_snapshot()` 和 `PRICE_UPDATED` 事件；`SubscriptionService` 已迁入 DataManager 包并通过 `dm.ensure_price_stream()` 管理 PRICE/FULL；`GET /subscriptions/prices` 与 `WS /stream/prices` 已改为 DataManager price cache/EventBus；启动流程已改用 ingestion ticker source，旧 `PriceTickerService` 文件已删除。
- 阶段 7：新增 `data_engine/interval_policy.py`，`core.market`、`bar_aggregator.models`、`backfill.models` 的历史 interval helper 已改为兼容代理；dataengine 内部已停止 import `app.core.market` 的 interval helper，`custom_query/warm_start/backfill planner/reconciler/gap detector/fetcher/storage` 都直接引用统一策略；weekly/monthly bucket 已统一到 `IntervalPolicy` calendar-aware helper；45m、91m、2M 已覆盖 query、BarAggregator batch、backfill fallback、settings repair 聚合一致性。
- 阶段 8 部分：settings storage repair/gap-scan/delete 维护逻辑已迁入 `data_manager/maintenance.py`，并通过 `DataManager` public facade 暴露；API 层只负责参数归一化、错误码转换和调用 `dm.repair_custom_storage()` / `dm.scan_and_fill_storage_gaps()` / `dm.delete_storage_data()`。
- 阶段 8 部分：`api/v1/klines.py` 已停止 legacy/mock fallback，正式 K 线查询、storage meta/delete、SMA 都走 DataManager；`api/v1/stream.py` K 线 WS 通过 DataManager EventBus 推送，并修复 multi-stream unsubscribe 不释放订阅句柄的问题；`main.py` 已停止创建旧 `SubscriptionManager`，订阅服务挂在 `dm.subscriptions`；DataEngine 启停已收口到 `app/data_engine/runtime.py`，Indicator 桥接已收口到 `app/indicator/data_manager_bridge.py`；旧 `services/*.py` 与 `collectors/*.py` 源文件已删除。

当前后续可继续优化的内容：

- `MaintenanceService` 已通过 DataManager facade 收口；后续可继续把返回模型和更多 storage 操作收敛成更稳定的 public contract。
- `DataManager.manager.py` 仍保留少量 stream/price wiring 和兼容字段，后续可继续拆成更小 facade 组件。
- QueryEngine standalone callback 仍保留兼容能力；正式 DataManager 路径已通过 `QueryResult.missing_ranges` 显式提交 coordinator。
- multi-symbol ticker fan-out 已在 `IngestionPriceSource` 层支持具备 `start_price_many` 的 factory；后续可把 Binance 真实 `!miniTicker@arr` normalizer 也接成同一能力。

checkpoint 盘点：

- 后端 dataengine/API 文档和测试改动是本轮重构范围；`frontend/src/*` 仍有未处理的既有脏改动，本轮不碰。
- `rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app -g '*.py'` 无输出。
- `rg -n "PriceTickerService|SubscriptionManager|kline_cache_service|kline_aggregator|spot_fetcher" backend/app -g '*.py'` 无输出。
- 私有 pipeline 检查在 `data_manager/backfill/settings` 正式路径无输出；`bar_aggregator` 模块内部仍可使用自身内部实现。

当前可用验证：

```bash
cd backend
python3 -m compileall app tests
python3 -m pytest -q
```

当前本机验证结果：`python3 -m pytest -q` 通过，`80 passed`。

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
2. best-effort 刷新交易所 symbol metadata。
3. 调 `start_data_engine()` 创建并启动 `DataEngineRuntime`。
4. `runtime.attach_to_app_state(app.state)` 暴露 API 需要的稳定句柄。
5. 调 `bridge_indicator_engine(runtime.data_manager)` 桥接 IndicatorEngine。
6. shutdown 时先停止 IndicatorEngine，再调 `runtime.shutdown()`。

当前问题：

- `main.py` 已不再直接创建 BackfillEngine、TransportLayer、IngestionFactory、SubscriptionService 或 price source。
- `main.py` 已不再手写 startup gap scan、backfill cache reload 或 IndicatorEngine 事件回调。
- 后续可进一步把 `app.state` 兼容句柄集中成 typed application state，但当前 API 兼容字段保留。

目标启动链路：

```text
1. init storage
2. refresh metadata
3. start DataEngineRuntime
4. attach DataEngineRuntime to app.state
5. bridge indicator engine
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
- `main.py` 过去是实际 backfill coordinator；当前已迁到 `DataManager.BackfillCoordinator`。
- `DataManager.on_bars_backfilled()` 回灌 cache 后还会继续检测 gap 并触发 follow-up backfill。
- `settings.py` 过去直接调 `backfill_engine.run()` 并手写 cache reload；当前已通过 DataManager maintenance facade 和 `BackfillCoordinator`。
- `ingestion.ContinuityLayer` 过去可做 `_backfill_kline_gap()`；当前已删除内联 HTTP backfill。

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

过去 `settings.py` 直接做：

- 读取 `dm.query_engine._storage`。
- 直接使用 `BackfillEngine.detect_only()` / `run()`。
- 直接创建 fresh `BarAggregator` 做 custom repair。
- 直接调用 `dm._seed_custom_interval()`。
- 直接读 `dm.cache._ephemeral_max_bars` 和 `dm._db_limits`。

目标：

- proxy/connectivity 可继续留在 settings API。
- storage gap scan 改为 `dm.scan_and_fill_storage_gaps(...)`。
- custom storage repair 改为 `dm.repair_custom_storage(...)`。
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
backend/app/data_engine/interval_policy.py
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

- [x] 记录当前测试基线：

```bash
cd backend
PYTHONPATH=. pytest -q
```

- [x] 记录当前旧依赖清单：

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app backend/tests -g '*.py'
```

- [x] 记录当前私有字段依赖清单：

```bash
rg -n "_handle_bar_input|get_pipeline\(|pipeline\.bar_state|query_engine\._|coordinator\._|cache\._" backend/app backend/tests -g '*.py'
```

- [x] 给旧模块加 deprecated 注释，不改行为：旧源码已删除，因此无需再加 deprecated 注释。

```text
backend/app/data_engine/services/__init__.py
backend/app/data_engine/services/price_ticker.py
backend/app/data_engine/services/subscription_manager.py
backend/app/data_engine/services/kline_cache_service.py
backend/app/data_engine/services/kline_aggregator.py
backend/app/data_engine/collectors/binance/spot_fetcher.py
```

- [x] 新增一个轻量检查脚本或测试，先允许现有引用，但禁止新增正式路径引用旧 services/collectors。

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

- [x] 更新 `backend/app/main.py` 文件头注释，不再鼓励 legacy fallback 是正常运行模式。

### 验收标准

- [x] 测试基线已记录。
- [x] 旧服务引用清单已记录。
- [x] 私有字段依赖清单已记录。
- [x] 有自动化检查阻止新增旁路。

---

## 7. 阶段 1：低风险 bug 修复和 public wrapper

目标：先修明确 bug，给后续迁移补最小 public API，不大改行为。

### 7.1 修明确 bug

- [x] 修 `QueryEngine._fill_interior_gaps()` 漏传 exchange。

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

- [x] 修 `DataManager.on_bar_event()` 丢失 exchange。

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

- [x] 修 `DataManager.shutdown()` 中重复 `await self._cleanup_task`。

### 7.2 给现有私有访问补 wrapper

- [x] `QueryEngine` 增加：

```python
def set_storage(self, storage: StorageBackend) -> None: ...
def set_backfill_trigger(self, trigger: BackfillTrigger | None) -> None: ...
@property
def storage(self) -> StorageBackend | None: ...
@property
def backfill_trigger(self) -> BackfillTrigger | None: ...
```

- [x] `DataManager.set_storage()` 改为调用 `self.query_engine.set_storage(storage)`。

- [x] `DataManager.set_backfill_trigger()` 改为调用 `self.query_engine.set_backfill_trigger(trigger)`。

- [x] `StreamCoordinator` 增加：

```python
def has_stream(key_or_fields...) -> bool: ...
def get_entry(key_or_fields...) -> StreamInfo | None: ...
def mark_bar_received(key_or_fields...) -> None: ...
def prewarm_targets(self) -> list[tuple[str, str, str]]: ...
def prewarm_intervals(self) -> tuple[str, ...]: ...
```

- [x] `DataManager.ensure_stream()` 不再读 `self.coordinator._streams`。

- [x] `DataManager._on_aggregator_event()` 不再读 `self.coordinator._streams`，改由 `AggregatorBridge` 调 `mark_bar_received()`。

- [x] `BarCache` 增加：

```python
def get_ephemeral_limit(self) -> int: ...
```

- [x] `settings.py` 的 `/cache-limits` 响应不再读 `dm.cache._ephemeral_max_bars`。

### 7.3 ingestion gap fill 默认关掉

- [x] 删除 `IngestionConfig.continuity_auto_fill_gaps` / `continuity_max_gap_fill_bars`。
- [x] 删除 `ContinuityLayer._backfill_kline_gap()`。
- [x] `ContinuityLayer` 只 emit `GapMarker`，不再裸调 HTTP backfill。

### 7.4 测试

- [x] 新增 `QueryEngine._fill_interior_gaps` 测试，断言 storage 收到正确 `exchange`。
- [x] 新增 `DataManager.on_bar_event(exchange="okx")` 测试，断言 EventBus key 保留 exchange。
- [x] 新增 wrapper 测试，确保不需要读私有字段也能完成原行为。

### 验收标准

- [x] `rg -n "query_engine\._storage|query_engine\._backfill_trigger|coordinator\._streams|cache\._ephemeral_max_bars" backend/app/data_engine/data_manager backend/app/api/v1/settings.py` 无业务越界结果。
- [x] 现有 K 线查询、WS、backfill 行为不变。
- [x] `pytest -q backend/tests` 通过。

---

## 8. 阶段 2：DataManager 内部服务拆分，不改行为

目标：先把 `manager.py` 从“大门面 + 修补中心”拆回清晰组件，但尽量保持行为一致。

### 8.1 抽 `warm_start.py`

新增：

```text
backend/app/data_engine/data_manager/warm_start.py
```

迁移方法：

- [x] 移动 `_seed_custom_interval()`。
- [x] 移动 `_seed_standard_interval()`。
- [x] 移动 `_custom_bucket_is_synced()`。
- [x] 移动 `_trigger_custom_tail_repair()`。

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

- [x] 移动 `_on_aggregator_event()`。
- [x] 移动 `_persist_bar_event()`。
- [x] bridge 接收 `cache`、`event_bus`、`storage provider`、`stream marker`。
- [x] DataManager 只负责 aggregator event bridge wiring：

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

- [x] 移动 `_run_startup_db_cleanup()`。
- [x] 移动 `_ephemeral_trim_loop()`。
- [x] 移动 `_run_ephemeral_trim()`。
- [x] 移动 `_db_limits` 管理；`DataManager._db_limits` 仅保留兼容引用。

目标 public API：

```python
dm.update_retention_limits(...) -> None
dm.retention_snapshot() -> dict
```

### 8.4 抽 `custom_query.py`

新增：

```text
backend/app/data_engine/data_manager/custom_query.py
```

迁移方法：

- [x] 移动 `_query_custom_from_base()`。
- [x] 移动 `_query_custom_before()`。
- [x] 移动 `_aggregate_custom_bars()`。
- [x] `QueryEngine` 对 custom interval 只委托 `CustomIntervalQueryService`。

第一版可以继续使用当前 `core.market` 聚合函数；阶段 7 再替换到统一 batch API。

### 8.5 测试

- [x] 给 `warm_start.py` 添加标准周期 seed 测试。
- [x] 给 `warm_start.py` 添加 custom seed 当前 bucket 测试。
- [x] 给 `aggregator_bridge.py` 添加 CLOSED/AMENDED 持久化测试。
- [x] 给 `retention.py` 添加 cache/db limit 测试。
- [x] 给 `custom_query.py` 添加 45m、91m、2M 查询测试；1w 已通过 IntervalPolicy/BarAggregator weekly bucket 边界覆盖。

### 验收标准

- [x] `DataManager.manager.py` 不再包含大量 warm-start/backfill/retention 算法。
- [x] 行为保持一致。
- [x] `DataManager.ensure_stream()` 只做参数归一化、stream policy plan、target 注册、coordinator 调用、warm-start 委托。

---

## 9. 阶段 3：BarAggregator public seed/replay/batch API

目标：停止 DataManager 和 Backfill 依赖 BarAggregator 内部 pipeline。

### 9.1 新增 public API

- [x] 新增 `BarAggregator.ingest_bar_input(...)`，内部包住 `_handle_bar_input()`。
- [x] 新增 `BarAggregator.seed_active_bar(...)`，用于标准周期 warm-start。
- [x] 新增 `BarAggregator.replay_components(...)`，用于 custom forming bucket seed。
- [x] 新增 `BarAggregator.aggregate_batch(...)`，用于 backfill/settings custom repair。
- [x] 新增 `BarAggregator.get_bucket_state(...)`。
- [x] 新增 `BarAggregator.expire_bucket(...)`。

要求：

- `emit_events=False` 时不得向普通 publisher 发事件。
- batch API 不污染 realtime 主状态。
- 第一版可以创建临时 isolated `BarAggregator` 实例实现 batch，避免重构主 pipeline。

### 9.2 替换 DataManager warm-start 调用

- [x] `warm_start.seed_standard()` 改用 `seed_active_bar()`。
- [x] `warm_start.seed_custom()` 改用 `replay_components()`。
- [x] `warm_start` 不再调用 `_handle_bar_input()`。
- [x] `warm_start` 不再直接操作 `pipeline.bar_state`。
- [x] `get_pipeline()` 在业务路径不再使用，只留 advanced/debug。

### 9.3 替换 settings custom repair 聚合

- [x] `settings.py` 或后续 `maintenance.py` 的 `_aggregate_custom_rows()` 改用 `aggregate_batch()`。
- [x] 删除 fresh `BarAggregator + publisher capture` 的临时实现；当前只通过 public `aggregate_batch()` 入口。

### 9.4 替换 backfill custom aggregation

- [x] `Reconciler._generate_custom_bars()` 改用 `aggregate_batch()`。
- [x] 不再调用主 `dm.bar_aggregator.add_target()`。
- [x] 不再调用主 `dm.bar_aggregator.on_backfill_bars()`。
- [x] 不再调用 `get_recent_bars(limit=10000)` 收集 batch 结果。

### 9.5 引入 RoutingPolicy / MergeMode

先新增模型，不必一次替换全部逻辑：

```python
class MergeMode(str, Enum):
    SNAPSHOT = "snapshot"
    INCREMENTAL = "incremental"
    COMPONENT = "component"
    PRICE_ONLY = "price_only"
```

- [x] `BarInput` 增加可选 `merge_mode`。
- [x] `EventRouter` 对 OKX 1m fanout 标记 `PRICE_ONLY`。
- [x] `BarStateEngine`/merge strategy 按 `merge_mode` 执行，而不是用 `source_interval != state.interval` 推断。

### 测试

- [x] `seed_active_bar()` 不 emit event。
- [x] `replay_components()` 能重建当前 custom bucket。
- [x] `aggregate_batch()` 多次调用不会改变主 aggregator `targets/active/recent`。
- [x] `aggregate_batch()` 对 45m、91m、2M 结果稳定；1w bucket 已由 weekly Monday UTC 测试覆盖。
- [x] OKX `1m -> 1h` PRICE_ONLY 不污染 volume/trades。

### 验收标准

- [x] `rg -n "_handle_bar_input|pipeline\.bar_state|get_pipeline\(" backend/app/data_engine/data_manager backend/app/api/v1/settings.py backend/app/data_engine/backfill` 无业务调用。
- [x] backfill custom aggregation 与 realtime custom aggregation 使用同一套 BarAggregator 规则；异常 fallback 也使用统一 bucket helper。

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

- [x] 按 `(exchange, market_type, symbol, interval)` 做 in-flight guard。
- [x] 合并重叠或相邻 range。
- [x] 同一 series 同时只跑一个 BackfillEngine run。
- [x] 支持 retry/backoff。
- [x] 支持 cancellation on shutdown。
- [x] 支持 reason/metadata 记录。
- [x] 所有结果进入 coordinator snapshot。

### 10.3 回灌规则

BackfillEngine 完成后：

- [x] 从 report 或 plan 中计算 written ranges。
- [x] 对每个 written range 从 storage 读最终 bars。
- [x] 调 `DataManager.on_bars_backfilled(...)`。
- [x] emit `BACKFILL_COMPLETED`。
- [x] 失败 emit `BACKFILL_FAILED`。
- [x] 不在 `DataManager.on_bars_backfilled()` 内继续触发 follow-up backfill；follow-up 应由 coordinator 决定。

### 10.4 迁移调用方

- [x] `main.py` 删除 `_backfill_trigger()`。
- [x] `main.py` 删除 `_load_backfilled_to_cache()`。
- [x] `dm.set_backfill_trigger(...)` 改为设置 coordinator 或 QueryEngine 提交 request。
- [x] `main.py` 的 `_startup_gap_scan()` 移入 `BackfillCoordinator.startup_scan()`。
- [x] `QueryEngine` 保持短期 callback 也可以，但 callback 目标必须是 coordinator。
- [x] 中期 `QueryEngine` 返回结构化 `MissingRange`。
- [x] DataManager 基于 `QueryResult.missing_ranges` 显式提交 coordinator；QueryEngine standalone callback 只保留兼容能力。
- [x] `settings.py` gap scan 改调 DataManager maintenance facade，再由 maintenance 调 coordinator。
- [x] `settings.py` custom repair 改调 DataManager maintenance facade，再由 maintenance 调 coordinator/batch API。
- [x] ingestion gap marker 接入 coordinator。

### 10.5 BackfillEngine/Reconciler 配套修正

- [x] `ReconcileResult` 增加 `write_errors` / `failed_batches`。
- [x] `_dedup_and_write()` 写入失败必须进入 `ReconcileResult.errors`。
- [x] custom bar 写入失败必须进入 `ReconcileResult.errors`。
- [x] `BackfillEngine.run()` 对写入错误返回 `PARTIAL`。
- [x] `DeduplicationStrategy` 新增 `BACKFILL_WINS`，`NEWER_WINS` 保留为兼容别名但不再宣称比较 existing row metadata。
- [x] `RepairReport` 增加 `written_ranges`，供 coordinator 回灌。

### 10.6 测试

- [x] 同一 request 重复提交只跑一个 backfill。
- [x] 重叠 range 合并。
- [x] BackfillEngine `COMPLETED/PARTIAL/FAILED` 映射到正确 DataEvent。
- [x] settings gap scan 不直接调用 BackfillEngine。
- [x] startup scan 由 coordinator 执行并可取消。
- [x] 写库失败时状态是 `PARTIAL` 或 `FAILED`，不会伪装成 completed。

### 验收标准

- [x] `rg -n "backfill_engine\.run|detect_only|on_bars_backfilled" backend/app/main.py backend/app/api/v1/settings.py` 不再出现手写修复流程。
- [x] `main.py` 不再保存 `backfill_futures`。
- [x] `DataManager.on_bars_backfilled()` 只负责 cache merge + event emit，不负责调度下一次 backfill。

---

## 11. 阶段 5：Ingestion gap marker 和内部边界收紧

目标：ingestion 只输出稳定实时事件和 gap marker，不做历史修复，同时降低交易所解析和 WS 生命周期重复。

### 11.1 移除 L5 自动 backfill

- [x] `continuity_auto_fill_gaps` / `continuity_max_gap_fill_bars` 配置已删除。
- [x] 删除 `ContinuityLayer._backfill_kline_gap()` 正式调用路径和实现。
- [x] `ContinuityLayer` 发现 gap 后只 emit `GapMarker`。
- [x] `DeliveryLayer` 能稳定 deliver gap event。
- [x] `DataManager` / `StreamCoordinator` 接收 ingestion gap marker 并提交统一 backfill trigger；`BackfillCoordinator` 负责实际 repair。

### 11.2 拆 NormalizeLayer

新增：

```text
backend/app/data_engine/ingestion/normalizers/
├── __init__.py
├── base.py
├── binance.py
└── okx.py
```

- [x] Binance WS/HTTP kline/trade/ticker/depth 解析迁入 `binance.py`。
- [x] OKX WS/HTTP kline/ticker 解析迁入 `okx.py`。
- [x] `NormalizeLayer` 只负责按 descriptor.exchange 分发。
- [x] 每个交易所 normalizer 单独测试。

### 11.3 统一 Session 抽象

新增：

```text
backend/app/data_engine/ingestion/session_types.py
```

已新增：

```python
class SessionLike(Protocol): ...
```

- [x] `SessionLayer` 实现 `SessionLike`。
- [x] 当前 OKX `SharedWsHub` 包成 `SharedWsSessionAdapter`。
- [x] `FeedControlLayer` 只依赖 `SessionLike`，不直接知道 OKX shared WS 分支。
- [x] `SharedWsHubRegistry` 保留，但职责收窄到 hub/session adapter cache 入口。

### 11.4 Delivery 反压模型

- [x] 保留 ordered callback 给 BarAggregator/DataManager 核心链路。
- [x] 给非核心消费者提供 bounded async queue subscriber。
- [x] 文档明确 ordered callback 会反压 ingestion 主链路。

### 测试

- [x] GapMarker 不触发 ingestion HTTP backfill。
- [x] GapMarker 能到达统一 backfill trigger/BackfillCoordinator 链路。
- [x] Binance/OKX normalizer 单测互不影响。
- [x] OKX shared WS adapter 和普通 session 的 health/reconnect snapshot 顶层结构一致。
- [x] Delivery ordered callback 会在 queue subscriber 前反压核心链路。
- [x] Delivery queue 满时丢弃非核心事件，不阻塞 ordered callback。
- [x] Delivery gap event 同时投递 ordered callback 和 queue subscriber。

### 验收标准

- [x] `rg -n "_backfill_kline_gap|continuity_auto_fill_gaps|continuity_max_gap_fill_bars" backend/app backend/tests -g '*.py'` 无结果。
- [x] `ingestion` 不 import `backfill`。

---

## 12. 阶段 6：价格流并入 ingestion + DataManager

目标：删除 `PriceTickerService` 旁路，让 watchlist price tier 也走统一事件总线。

### 12.1 DataManager price cache

新增：

```text
backend/app/data_engine/data_manager/price_cache.py
```

- [x] 定义 `PriceSnapshot`。
- [x] 定义 `PriceSnapshotCache`。
- [x] `DataEventType` 增加 `PRICE_UPDATED`。
- [x] DataManager 增加：

```python
async def ensure_price_stream(symbol, *, exchange, market_type) -> StreamInfo: ...
def get_price(symbol, *, exchange, market_type) -> PriceSnapshot | None: ...
def get_prices_snapshot(...) -> list[dict]: ...
```

当前实现状态：以上三个 DataManager public API 已落地；`ensure_price_stream()` 通过 `IngestionPriceSource` 启动 native ingestion ticker pipeline。

### 12.2 ingestion ticker bridge

- [x] `MarketIngestionFactory` 支持 `StreamType.MINI_TICKER` / `TICKER`。
- [x] 对支持 multi-symbol ticker 的交易所，允许一个 stream fan-out 多 symbol。
- [x] 对 OKX 这类 per-symbol ticker，用统一 session/factory 表达，不再写 PriceTickerService 特例。
- [x] ticker `MarketEvent` 进入 DataManager price cache。

### 12.3 daily open

当前 PriceTickerService 会额外取 1D open。迁移选项：

- [x] 短期：DataManager price cache 使用 ticker 24h open，字段名保持兼容。
- [x] 中期：新增 `DailyOpenService`，通过 DataManager/Backfill/storage 查询当前 1d open。
- [x] 不要让 price cache 直接裸写一套 REST requests 旁路。

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

- [x] `SubscriptionTier` 从旧 services 迁入 DataManager 或 API 层。
- [x] `FULL` 调 `dm.ensure_stream(symbol, "1m", ...)`。
- [x] `PRICE` 调 `dm.ensure_price_stream(symbol, ...)`。
- [x] `NONE` 只保存 tier，不启动行情。
- [x] subscription persistence 保留 SQLite 表，可复用原 schema。
- [x] 删除 `SubscriptionManager.set_price_ticker()`。

### 12.5 API/WS 迁移

- [x] `GET /subscriptions/prices` 改为 `dm.get_prices_snapshot()`。
- [x] `WS /stream/prices` 改为订阅 `DataEventType.PRICE_UPDATED`。
- [x] `POST /subscriptions/sync` 不 import 旧 `SubscriptionTier`。
- [x] `PUT /subscriptions/{symbol}` 不 import 旧 `SubscriptionTier`。
- [x] `main.py` 不再创建 `PriceTickerService`。
- [x] shutdown 不再 stop 旧 `app.state.price_ticker`；当前 stop 的是 `app.state.price_stream_source`。

### 测试

- [x] PRICE tier 会启动 price stream，不启动 kline stream。
- [x] FULL tier 会启动 kline stream，也能有 price snapshot。
- [x] `GET /subscriptions/prices` 不依赖 `app.state.price_ticker`。
- [x] `WS /stream/prices` 从 DataManager EventBus 收到 `PRICE_UPDATED`。

### 验收标准

- [x] `rg -n "PriceTickerService|price_ticker" backend/app -g '*.py'` 无正式路径引用。
- [x] `backend/app/data_engine/services/price_ticker.py` 可删除，已删除。

---

## 13. 阶段 7：custom interval 和 IntervalPolicy 统一

目标：实时、查询、backfill、manual repair 对 custom interval 给出同一套答案。

### 13.1 新增 IntervalPolicy

- [x] 新增 `backend/app/data_engine/interval_policy.py`。
- [x] 从 `core.market` 迁入或代理：
  - parse custom/native interval。
  - weekly Monday UTC bucket。
  - monthly calendar bucket。
  - base interval selection。
  - exchange-native interval 判断。
  - ephemeral interval 判断。

### 13.2 替换调用方

- [x] `bar_aggregator.models` 的 interval helper 使用 IntervalPolicy 兼容代理。
- [x] `ingestion.continuity` 固定间隔 gap detection 使用 IntervalPolicy 标准表。
- [x] `data_manager.custom_query.py` 使用 IntervalPolicy bucket/monthly helper，完整 bucket 优先使用 `BarAggregator.aggregate_batch()`。
- [x] `data_manager.warm_start.py` 使用 IntervalPolicy。
- [x] `backfill.models` 的 interval helper 使用 IntervalPolicy 兼容代理。
- [x] `backfill.planner/reconciler/gap_detector/fetcher.py` 使用 IntervalPolicy。
- [x] `data_manager.maintenance/query/retention/cache/coordinator/manager` 使用 IntervalPolicy，不再依赖 `app.core.market`。
- [x] `settings maintenance repair` 使用 `BarAggregator.aggregate_batch()`。
- [x] 旧 `services/kline_aggregator.py` 已删除。

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

- [x] `IntervalPolicy` 历史入口代理等价性边界测试已覆盖 native/custom/weekly/monthly 基础解析。
- [x] custom query 完整 bucket 会调用 `BarAggregator.aggregate_batch()`。
- [x] `compute_bucket_start` weekly 以 Monday UTC 对齐。
- [x] `1M/2M/3M` 以 calendar month 对齐，不用固定 30 天 bucket。
- [x] 45m 查询、BarAggregator batch、backfill、settings repair 结果一致。
- [x] 91m 查询、BarAggregator batch、backfill、settings repair 结果一致。
- [x] 2M 查询、backfill、settings repair 结果一致。

### 验收标准

- [x] `rg -n "from app\\.core\\.market import" backend/app/data_engine -g '*.py'` 无结果。
- [x] `rg -n "compute_bucket_start_ms|parse_interval_ms|STANDARD_INTERVAL_MS|INTERVAL_SECONDS" backend/app/data_engine backend/app/api/v1/settings.py` 结果可解释；当前 `interval_policy.py` 是权威实现，`bar_aggregator.models` / `backfill.models` 为兼容代理。
- [x] custom interval 完整 bucket 使用同一套 bucket/merge/finalize 权威实现；未封口查询尾部仍保留只读聚合以维持查询体验。

---

## 14. 阶段 8：API/main/settings 迁移并删除旧 services/collectors

目标：正式路径只通过 DataManager，旧模块退出。

### 14.1 `api/v1/klines.py`

- [x] 删除文件顶部旧 imports：

```python
from app.data_engine.mock_data import generate_mock_klines
from app.data_engine.services import aggregate_klines, aggregate_multi_resolution
```

- [x] DataManager 为 None 时所有正式 K 线 endpoint 返回 503。
- [x] DataManager 查询失败时返回 500 或明确错误，不 fallback legacy。
- [x] 删除 `_legacy_get_klines()`。
- [x] 删除 `_legacy_get_latest()`。
- [x] 删除 `_legacy_get_history()`。
- [x] 删除 `_legacy_get_before()`。
- [x] `/storage/meta` 只调 `dm.get_bounds()`，无 dm 返回 503。
- [x] `/storage` delete 改为 DataManager maintenance/storage facade。
- [x] `/indicators/sma` 已改为 DataManager 查询后本地计算；后续可再迁到 indicator engine。

### 14.2 `api/v1/subscriptions.py`

- [x] 全部改用 DataManager subscription service。
- [x] 删除 `app.state.subscription_manager` 依赖，订阅服务挂在 `dm.subscriptions`。
- [x] 删除 `app.state.price_ticker` 依赖。
- [x] price WS 订阅 DataManager EventBus。

### 14.3 `api/v1/settings.py`

- [x] proxy 设置保留。
- [x] `_get_transports()` 不读 factory private `_ingress._transport`；已通过 ingestion factory public method 暴露 transports，并通过 transport/factory public `config` 更新配置。
- [x] `/storage/repair` 调 `dm.repair_custom_storage(...)`。
- [x] `/storage/gap-scan` 调 `dm.scan_and_fill_storage_gaps(...)`。
- [x] `/cache-limits` 调 `dm.update_retention_limits(...)` 并返回 `dm.retention_snapshot()`。
- [x] 不再创建 fresh `BarAggregator`。
- [x] 不再调用 `dm._seed_custom_interval()`。
- [x] 不再读 `dm.query_engine._storage`。

### 14.4 `main.py`

- [x] 删除旧 fallback 注释。
- [x] 删除 `PriceTickerService` 创建/start/stop。
- [x] 删除旧 `SubscriptionManager` 创建/start。
- [x] 删除 `_backfill_trigger()`。
- [x] 删除 `_load_backfilled_to_cache()`。
- [x] 删除 `_startup_gap_scan()` 内联实现。
- [x] 只负责组合根 wiring。

### 14.5 删除旧文件

删除前必须确认无正式引用：

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" backend/app backend/tests -g '*.py'
```

已删除清单：

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

- [x] K 线 HTTP API 只调用 DataManager。
- [x] K 线 WebSocket 只通过 DataManager EventBus 推送。
- [x] price REST/WS 只通过 DataManager。
- [x] settings repair/gap-scan 只通过 DataManager maintenance/backfill coordinator。
- [x] `backend/app/data_engine/services/` 删除或为空壳兼容层，正式路径无 import。
- [x] `backend/app/data_engine/collectors/` 删除。

---

## 15. 阶段 9：测试、文档、最终验收

### 15.1 单元测试矩阵

- [x] `SeriesKey` exchange/market_type/symbol/interval topic 和匹配。
- [x] `IntervalPolicy` native/custom/weekly/monthly/ephemeral 历史入口基础边界。
- [x] `BarAggregator.seed_active_bar()`。
- [x] `BarAggregator.replay_components()`。
- [x] `BarAggregator.aggregate_batch()` isolated state。
- [x] `RoutingPolicy` OKX 1m fanout。
- [x] `MergeMode.PRICE_ONLY` 不污染 volume/trades。
- [x] `QueryEngine` cache/storage/backfill request。
- [x] `CustomIntervalQueryService` 45m/91m/2M。
- [x] `BackfillCoordinator` dedup/coalesce/retry/cancel。
- [x] `Reconciler` write failure -> partial。
- [x] `PriceSnapshotCache` update/snapshot/event。
- [x] `SubscriptionService` FULL/PRICE/NONE。
- [x] `MaintenanceService` custom repair aggregation path.

### 15.2 集成测试矩阵

- [x] `/api/v1/klines` DataManager 可用时返回数据。
- [x] `/api/v1/klines` DataManager 不可用时返回 503。
- [x] `/api/v1/klines/history` 缺数据时提交 BackfillCoordinator request。
- [x] `/api/v1/stream/klines` 收到 BAR_UPDATED/BAR_CLOSED。
- [x] `/api/v1/stream/klines_multi` 收到 BACKFILL_COMPLETED。
- [x] `/api/v1/subscriptions/prices` 从 DataManager price cache 返回。
- [x] `/api/v1/stream/prices` 收到 PRICE_UPDATED。
- [x] `/api/v1/settings/storage/gap-scan` 只走 coordinator。
- [x] `/api/v1/settings/storage/repair` custom repair 使用 batch API。

### 15.3 架构边界测试

新增或完善：

```text
backend/tests/test_data_engine_architecture_boundaries.py
```

必须断言：

- [x] `backend/app` 无 `app.data_engine.services` import。
- [x] `backend/app` 无 `app.data_engine.collectors` import。
- [x] `api/v1` 不 import `bar_aggregator`，除非是 settings maintenance 已迁出。
- [x] `ingestion` 不 import `backfill`。
- [x] `bar_aggregator` 不 import `storage`。
- [x] `backfill` 不 import `data_manager`。
- [x] `data_manager` 不调用 `bar_aggregator._handle_bar_input`。
- [x] `main.py` 不直接构造 DataEngine 内部组件，只委托 `DataEngineRuntime`。

### 15.4 文档更新

- [x] 更新 `README_zh.md` 数据引擎说明。
- [x] 更新 `API_zh.md`：
  - DataManager 不可用返回 503。
  - backfill async completion event。
  - price stream 数据源为 DataManager。
- [x] 更新四个模块 README：
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
