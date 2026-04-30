# Data Engine 四大模块收口与旧模块删除计划

本文只讨论如何把 `backend/app/data_engine` 中四大核心模块之外的行情数据逻辑删除或整合。目标不是重写系统，而是把数据后端收口成一条权威路径：

```text
所有行情输入 -> ingestion
所有 K 线生成 -> bar_aggregator
所有查询/缓存/订阅/事件输出 -> data_manager
所有历史修复 -> backfill
```

`storage` 作为基础设施保留，但不再被视为一个业务数据模块。API、指标、订阅、设置页只能通过 `DataManager` 或其公开子能力访问数据，不再直接调用旧服务。

---

## 1. 最终目标结构

目标结构：

```text
backend/app/data_engine/
├── ingestion/         # 实时 WS/REST 接入、标准化、连续性标记
├── bar_aggregator/    # K 线 bucket、merge、finalize、生命周期事件
├── data_manager/      # 统一查询、缓存、事件总线、流生命周期、订阅门面
├── backfill/          # 历史缺口检测、规划、拉取、调和、报告
├── storage/           # SQLite/数据库适配层，基础设施保留
└── mock_data.py       # 仅开发兜底，正式主链路不依赖
```

需要删除或迁移的旧目录/模块：

```text
backend/app/data_engine/services/kline_cache_service.py
backend/app/data_engine/services/kline_aggregator.py
backend/app/data_engine/services/price_ticker.py
backend/app/data_engine/services/subscription_manager.py
backend/app/data_engine/collectors/binance/spot_fetcher.py
backend/app/data_engine/collectors/
```

`services/` 目录最终应删除，或只在迁移期间保留空壳兼容层。正式数据链路中不允许再 import `app.data_engine.services`。

---

## 2. 模块边界

### ingestion

保留职责：

- 打开交易所 WS 连接。
- 必要时做 HTTP polling/fallback。
- 把交易所原始 payload 标准化为 `MarketEvent`。
- 对实时事件做去重、乱序识别、gap marker。
- 输出稳定事件流。

新增/强化职责：

- 支持 `StreamType.TICKER` / `StreamType.MINI_TICKER` 作为轻量价格流。
- 对价格流也输出统一 `MarketEvent`，不再由 `PriceTickerService` 自己开旁路 WS。

要删除的职责：

- `ContinuityLayer` 不再自己 HTTP 补 K 线 gap。
- gap 只产生 `GapMarker`，由 `DataManager` 或 `BackfillCoordinator` 决定是否触发 `backfill`。

### bar_aggregator

保留职责：

- 接收 `MarketEvent` / 历史 bars / manual `BarInput`。
- 计算 bucket。
- 合并 OHLCV。
- 判断封口。
- 发布 `BarEvent`。

新增/强化职责：

- 提供隔离的 batch aggregation API，例如：

```python
await aggregator.aggregate_batch(
    symbol=symbol,
    source_interval="1m",
    target_interval="91m",
    bars=bars,
    emit_events=False,
)
```

这个 API 给 `backfill` 和 storage repair 使用，不能污染实时主聚合器状态。

要删除的职责：

- 不查 storage。
- 不管理前端订阅。
- 不参与 backfill 调度。

### data_manager

保留职责：

- 统一查询：`query`、`query_latest`、`query_before`。
- 管理缓存：K 线 cache、价格 snapshot cache。
- 管理事件：bar event、price event、stream event、backfill event。
- 管理实时流生命周期。
- API / WebSocket / indicator / subscription 的唯一数据入口。

新增/强化职责：

- 支持轻量价格订阅：

```python
await dm.ensure_price_stream(symbol, exchange="binance", market_type="spot")
dm.get_price(symbol, exchange="binance", market_type="spot")
dm.subscribe(..., event_types={DataEventType.PRICE_UPDATED})
```

- 增加 `BackfillCoordinator`，统一所有历史修复触发和完成通知。
- 增加或迁入订阅等级管理能力，替代 `services/subscription_manager.py`。

要删除的职责：

- `manager.py` 不直接访问 `bar_aggregator` 私有状态。
- `query.py` 不直接负责 backfill 重试/队列/去重。
- settings API 不再绕过 DataManager 手写修复流程。

### backfill

保留职责：

- 缺口检测。
- 任务规划。
- 历史 REST 拉取。
- 去重与写库。
- 输出修复报告。

新增/强化职责：

- 接收 `BackfillCoordinator` 的统一 repair request。
- 对 custom interval 生成使用 `bar_aggregator` 的 isolated batch API。

要删除的职责：

- `Reconciler` 不直接使用实时 `BarAggregator` 主状态生成 custom bars。
- `Reconciler` 不负责把数据回灌到 DataManager cache，也不直接通知前端。

---

## 3. 非四大模块迁移方案

### 3.1 `services/price_ticker.py`

当前问题：

- 自己管理 Binance miniTicker WS。
- 自己维护价格缓存。
- 订阅 API 和 WS 直接依赖它。
- 形成 `ingestion -> data_manager` 之外的行情旁路。

迁移目标：

```text
Ingestion MINI_TICKER/TICKER
        |
        v
DataManager PriceSnapshotCache
        |
        v
subscriptions REST / price WebSocket / watchlist
```

具体动作：

1. 在 `ingestion.models.StreamType` 中确认 `MINI_TICKER` / `TICKER` 的标准 payload。
2. 在 `BinanceIngestionFactory` 或新的通用 factory 中支持启动 ticker stream。
3. 在 `DataManager` 增加价格事件处理入口，例如 `on_market_event()` 或专用 bridge。
4. 新增 `PriceSnapshot` / `PriceSnapshotCache` 数据结构。
5. 新增 `DataEventType.PRICE_UPDATED`。
6. 改 `/api/v1/subscriptions/prices` 从 DataManager 读价格快照。
7. 改 `/api/v1/stream/prices` 订阅 DataManager event bus。
8. 删除 `PriceTickerService` 和 `main.py` 中对它的启动/关闭逻辑。

验收标准：

- watchlist 价格更新不再 import `PriceTickerService`。
- 全项目无 `app.data_engine.services.price_ticker` import。
- 价格 WS 和 K 线 WS 都由 DataManager EventBus 输出。

### 3.2 `services/subscription_manager.py`

当前问题：

- 同时协调 DataManager 和 PriceTickerService。
- 放在 `data_engine/services` 下，像一个独立数据服务。

迁移目标：

订阅等级保留，但只调用 DataManager：

```text
FULL  -> dm.ensure_stream(symbol, interval="1m" 或活跃图表周期)
PRICE -> dm.ensure_price_stream(symbol)
NONE  -> 只保存 watchlist 状态，不启动行情流
```

具体动作：

1. 把订阅等级模型迁到 `data_manager/subscriptions.py` 或 API 层。
2. 订阅管理只持久化 watchlist tier，不直接管理任何独立行情服务。
3. `FULL` 和 `PRICE` 都通过 DataManager 的公开方法启动/停止。
4. 删除 `SubscriptionManager.set_price_ticker()`。
5. 删除 `main.py` 中 `PriceTickerService` 注入，只保留 DataManager 注入。

验收标准：

- 订阅模块不再知道 `PriceTickerService`。
- `price` tier 不再是旁路 WS，而是 DataManager 管理的 ingestion stream。

### 3.3 `services/kline_cache_service.py`

当前问题：

- 旧的 K 线查询、缓存、后台 refresh/backfill 逻辑仍在。
- `api/v1/klines.py` 在 DataManager 失败时 fallback 到它。
- 它直接调用旧 collector 和 storage，绕过四大模块。

迁移目标：

全部由 DataManager 替代：

```text
get_cached_latest  -> dm.query_latest()
get_cached_history -> dm.query()
get_more_left      -> dm.query_before()
delete_cached_*    -> storage maintenance through DataManager/settings facade
calculate_sma      -> indicator engine 或 API 本地计算
```

具体动作：

1. 删除 `api/v1/klines.py` 的 legacy fallback。
2. DataManager 未初始化时返回 `503`，不再生成旧链路数据。
3. 将仍有价值的小工具迁到明确归属：
   - 查询能力归 DataManager。
   - 指标计算归 indicator。
   - 存储维护归 settings facade 或 DataManager maintenance。
4. 删除 `kline_cache_service.py`。

验收标准：

- 全项目无 `get_cached_latest`、`get_cached_history`、`get_more_left` import。
- K 线 HTTP API 只调用 DataManager。

### 3.4 `services/kline_aggregator.py`

当前问题：

- 旧 custom interval 聚合逻辑和 `bar_aggregator`、`core.market`、`backfill.reconciler` 重复。
- 月线、周线、任意周期的 bucket 规则容易出现多套答案。

迁移目标：

- custom interval 的权威 bucket/merge/finalize 规则归 `bar_aggregator`。
- 纯工具函数如 interval parse、bucket start 可以放在 `core.market`，但业务聚合不再放 `services`。

具体动作：

1. 给 `bar_aggregator` 增加 batch aggregation API。
2. `QueryEngine` custom interval 查询优先复用统一 bucket 规则。
3. `backfill.reconciler` custom bars 生成改用 batch API。
4. `settings.py` custom storage repair 改用 batch API。
5. 删除 `kline_aggregator.py`。

验收标准：

- 全项目无 `aggregate_klines`、`aggregate_multi_resolution` import。
- 实时 custom、历史查询 custom、backfill custom、manual repair custom 使用同一套 bucket 规则。

### 3.5 `collectors/binance/spot_fetcher.py`

当前问题：

- 旧 requests/pandas REST fetcher，只服务旧 cache service。
- 和 `ingestion.TransportLayer`、`backfill.HistoricalFetcher` 重复。

迁移目标：

- 实时/轻量 REST fallback 走 `ingestion.TransportLayer`。
- 历史补洞走 `backfill.HistoricalFetcher`。
- 不再保留专用 collector。

具体动作：

1. 确认旧 cache service 删除后没有调用者。
2. 将必要的 endpoint fallback / proxy 行为确认已覆盖到 `TransportLayer`。
3. 删除 `collectors/` 目录。

验收标准：

- 全项目无 `collectors.binance.spot_fetcher` import。
- REST 历史拉取只存在于 `backfill.fetcher`。

### 3.6 `mock_data.py`

当前问题：

- 作为开发兜底可以保留，但不能掩盖 DataManager 初始化失败。

迁移目标：

- 正式 API 不在 DataManager 失败时返回 mock K 线。
- mock 只用于本地开发或测试开关。

具体动作：

1. 删除 `klines.py` 中自动 fallback mock 的逻辑。
2. 如确实需要 mock，放到显式 debug endpoint 或测试 fixture。

验收标准：

- 生产路径不会静默返回 mock market data。

---

## 4. BackfillCoordinator 收口设计

新增建议位置：

```text
backend/app/data_engine/data_manager/backfill_coordinator.py
```

职责：

- 接收所有 repair request。
- 按 `(exchange, market_type, symbol, interval)` 做 in-flight guard。
- 合并重叠时间范围。
- 统一 retry/backoff/cancellation。
- 调用 `BackfillEngine.run()`。
- 回填完成后从 storage 读取最终 bars。
- 调 `DataManager.on_bars_backfilled()`。
- 统一发送 `BACKFILL_COMPLETED` / `BACKFILL_FAILED` 事件。

输入来源统一变成：

```text
QueryEngine missing range
Startup gap scan
Settings manual scan/repair
Ingestion GapMarker
Frontend load-more shortfall
```

这些入口不再自己跑 `BackfillEngine.run()`，而是：

```python
await dm.backfill.request(
    symbol=symbol,
    interval=interval,
    start_ms=start_ms,
    end_ms=end_ms,
    reason="query_tail_gap",
    exchange=exchange,
    market_type=market_type,
)
```

迁移后，`main.py` 不再内联 `_backfill_trigger()` 和 `_load_backfilled_to_cache()`。它只负责创建 BackfillEngine 并注入 DataManager：

```python
dm.set_backfill_engine(backfill_engine)
```

---

## 5. API 层迁移

### `api/v1/klines.py`

改造目标：

- 删除全部 legacy fallback。
- DataManager 不可用时返回 `503`。
- custom interval 查询只走 DataManager。

保留职责：

- 参数校验。
- symbol/exchange/market_type 归一化。
- 调 DataManager。
- 返回 HTTP schema。

### `api/v1/stream.py`

改造目标：

- 已经基本走 DataManager EventBus，保留。
- 确认所有 K 线 stream 都不使用旧服务。

### `api/v1/subscriptions.py`

改造目标：

- price snapshot 和 price WS 从 DataManager 读。
- subscription tier 变更调用 DataManager。
- 不再引用 `PriceTickerService`。

### `api/v1/settings.py`

改造目标：

- proxy 设置保留。
- connectivity test 保留。
- storage repair/gap scan 不再手写 backfill 编排。
- 改为调用 DataManager maintenance/backfill coordinator 方法。

示例：

```python
await dm.backfill.scan_and_repair_storage(...)
await dm.maintenance.repair_custom_series(...)
```

---

## 6. 主启动流程迁移

当前 `main.py` 同时做：

- 初始化 storage。
- 初始化 DataManager。
- 初始化 ingestion factory。
- 初始化 BackfillEngine。
- 内联 backfill trigger。
- 初始化 PriceTickerService。
- 初始化 SubscriptionManager。
- startup gap scan。
- indicator bridge。

目标启动流程：

```text
1. init storage
2. create DataManager
3. inject storage
4. inject ingestion factory
5. inject BackfillEngine through BackfillCoordinator
6. start DataManager
7. start subscription restore through DataManager
8. bridge indicator engine
```

需要删除：

- `PriceTickerService` start/stop。
- 旧 `_backfill_trigger()`。
- 旧 `_load_backfilled_to_cache()`。
- `main.py` 内联 startup gap scan，迁到 `BackfillCoordinator.startup_scan()`。

---

## 7. 推荐迁移顺序

### 阶段 1：禁止新旁路

目标：先让后续代码不再继续依赖旧服务。

动作：

1. 在文档和代码注释中标记 `services/kline_*`、`collectors` 为 deprecated。
2. 新增 lint/搜索检查：禁止新增 `app.data_engine.services` import。
3. `api/v1/klines.py` 改成 DataManager 不可用返回 503。

### 阶段 2：价格流并入 ingestion + DataManager

目标：删除最大旁路 `PriceTickerService`。

动作：

1. 完成 ticker/miniTicker ingestion。
2. DataManager 增加 price cache 和 `PRICE_UPDATED` event。
3. 改 subscriptions API/WS。
4. 删除 `PriceTickerService`。

### 阶段 3：BackfillCoordinator 收口

目标：所有历史修复入口统一。

动作：

1. 新增 `data_manager/backfill_coordinator.py`。
2. QueryEngine 改为提交 repair request。
3. main startup scan 改为 coordinator 方法。
4. settings gap scan/repair 改为 coordinator/maintenance 方法。
5. ingestion gap marker 接入 coordinator。

### 阶段 4：custom interval 统一

目标：删除旧 `kline_aggregator.py`。

动作：

1. BarAggregator 增加 isolated batch API。
2. QueryEngine/backfill/settings repair 复用 batch API 或统一 bucket API。
3. 删除 `services/kline_aggregator.py`。

### 阶段 5：删除旧 K 线 cache/collector

目标：彻底删除旧 K 线链路。

动作：

1. 删除 `services/kline_cache_service.py`。
2. 删除 `collectors/`。
3. 清理 `services/__init__.py`。
4. 若 `services/` 目录为空，删除目录。

### 阶段 6：清理测试和文档

目标：让主链路唯一且可验证。

动作：

1. 更新 README / API 文档。
2. 测试覆盖：
   - K 线查询只走 DataManager。
   - price tier 走 ingestion + DataManager。
   - custom interval 实时/历史/backfill 一致。
   - backfill completed 一定进入 DataManager EventBus。
3. 删除旧服务测试或迁移成四大模块测试。

---

## 8. 删除清单

可以直接删除的前提是全项目搜索无引用。

```text
backend/app/data_engine/services/price_ticker.py
backend/app/data_engine/services/kline_cache_service.py
backend/app/data_engine/services/kline_aggregator.py
backend/app/data_engine/services/__init__.py
backend/app/data_engine/collectors/binance/spot_fetcher.py
backend/app/data_engine/collectors/binance/__init__.py
backend/app/data_engine/collectors/__init__.py
backend/app/data_engine/collectors/
```

迁移后需要清理的引用点：

```text
backend/app/main.py
backend/app/api/v1/klines.py
backend/app/api/v1/subscriptions.py
backend/app/api/v1/settings.py
backend/app/data_engine/data_manager/query.py
backend/app/data_engine/ingestion/continuity.py
```

---

## 9. 验收标准

最终架构验收必须满足：

1. K 线 HTTP API 只通过 `DataManager` 查询。
2. K 线 WebSocket 只通过 `DataManager.EventBus` 推送。
3. watchlist 轻量价格只通过 `ingestion -> DataManager` 更新。
4. 没有任何正式路径直接 import `app.data_engine.services`。
5. 没有任何正式路径直接 import `app.data_engine.collectors`。
6. `ingestion` 只发 gap marker，不自己修历史。
7. 所有历史修复都通过 `BackfillCoordinator`。
8. custom interval 的实时、历史、backfill、manual repair 使用同一套 bucket/merge 规则。
9. DataManager 初始化失败时 API 返回明确错误，不静默走旧链路或 mock 数据。

---

## 10. 核心原则

以后判断一个新功能放哪里，只按下面四句话：

```text
从交易所拿数据：放 ingestion。
把输入变成 K 线：放 bar_aggregator。
给应用读、订阅、缓存、推送：放 data_manager。
补历史缺口：放 backfill。
```

任何绕过这四句话的服务，都应该先被视为临时兼容层，而不是新架构的一部分。
