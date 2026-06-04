# Data Manager

[English](README.md)

> CandleScope 行情数据的公共业务门面。API/WS/Indicator 代码应通过 `DataManager` 进行 K 线查询、cache 访问、事件订阅、stream 生命周期、backfill coordination、价格快照和维护任务。

## 在 Data Engine 中的位置

```text
ingestion -> bar_aggregator -> DataManager -> API / WS / Indicator
                         ▲
                         └── backfill -> storage readback
```

`data_manager` 是底层数据管线和应用功能之间的边界。外部模块应使用 [__init__.py](__init__.py) 暴露的 package root API，不要直接依赖 `QueryEngine`、`StreamCoordinator`、`AggregatorBridge` 等内部服务。

## 职责

| 领域 | 组件 | 职责 |
|---|---|---|
| 门面 | `DataManager` | 查询、stream、subscription、maintenance、diagnostics 的公共方法 |
| Cache | `KlineCache` | 带 size/TTL 限制的内存序列缓存 |
| Query | `QueryEngine` | Cache -> Storage -> Backfill 解析，并返回 missing-range metadata |
| Streams | `StreamCoordinator` / `StreamEnsurePlanner` | 启停 ingestion 和 bar aggregator targets；跨 consumer lease 共享 upstream stream |
| Events | `DataEventBus` | callback 和 async-iterator 事件分发 |
| Aggregation Bridge | `AggregatorBridge` | 持久化 bar events、合并 cache、发出 `DataEvent` |
| Backfill | `BackfillCoordinator` | request 去重、合并、retry、cancel、storage 回读、事件映射 |
| Custom Query | `CustomQueryEngine` | 自定义周期一致查询 |
| Warm Start | `AggregatorWarmStartService` | 启动时从 storage seed aggregator state |
| Price | `IngestionPriceSource` / `PriceSnapshotCache` | 轻量实时价格流和快照 |
| Subscription | `SubscriptionService` | watchlist tier：`full`、`price`、`none`；持久化 full 周期和 consumer lease |
| Maintenance | `maintenance.py`、`retention.py` | storage repair、gap scan、retention limits |

## 公共 API

`DataManager` 常用方法：

| 方法 | 用途 |
|---|---|
| `start()` / `shutdown()` | 生命周期 |
| `query()` | 查询范围，可按配置触发 backfill |
| `query_latest()` | 最新 N 根 bars |
| `query_before()` | 按 timestamp 向前分页 |
| `get_bounds()` | 某个序列的 storage metadata |
| `scan_storage_gaps()` | 只扫描连续性，不触发修复 |
| `ensure_stream()` | 确保实时 ingestion + aggregation 正在运行，可注册到 consumer lease |
| `release_stream()` | 释放 consumer lease，不强制停止其他 consumer 仍在使用的流 |
| `subscribe()` / `unsubscribe()` | callback 事件订阅 |
| `subscribe_iter()` | async iterator 事件订阅 |
| `on_bar_event()` | 消费 `BarAggregator` events |
| `on_bars_backfilled()` | storage 回读后合并修复 bars |
| `get_prices_snapshot()` | 当前 watched symbols 价格快照 |
| `get_subscription_service()` | 获取 subscription tier manager |
| `repair_custom_storage()` | 重建自定义周期 rows |
| `scan_and_fill_storage_gaps()` | 手动 gap scan + repair |
| `update_retention_limits()` | 更新 DB/ephemeral retention 设置 |
| `snapshot()` | 完整诊断快照 |

示例：

```python
from app.data_engine.data_manager import DataManager

dm = DataManager()
await dm.start()

await dm.ensure_stream("BTCUSDT", "1m", exchange="binance", market_type="spot")
result = dm.query_latest("BTCUSDT", "1m", 500, "binance", market_type="spot")

handle = dm.subscribe(callback=on_event, symbol="BTCUSDT", interval="1m")
dm.unsubscribe(handle)

await dm.shutdown()
```

## 公共类型

package root 暴露稳定门面和契约：

- Config：`DataManagerConfig`、`CacheConfig`、`QueryConfig`、`EventBusConfig`、`CoordinatorConfig`、`PrewarmTarget`
- Data：`BarData`、`SeriesKey`、`QueryResult`、`MissingRange`、`QuerySource`
- Events：`DataEvent`、`DataEventType`、`SubscriptionHandle`
- Streams：`StreamInfo`、`StreamStatus`
- Storage protocol：`StorageBackend`
- Maintenance/subscription：`MaintenanceBusyError`、`MaintenanceUnavailableError`、`SubscriptionTier`

## 时间戳和身份规则

- storage 和内部 engine 时间戳使用毫秒。
- `BarData.time` 使用 Unix 秒，面向 `lightweight-charts`。
- `SeriesKey` 会把 symbol 规范成大写，exchange/market type 规范成小写。
- Binance spot topic 保持简短：`BTCUSDT@1m`。
- 非默认 exchange 或 market type 会带前缀：`okx:swap:BTC-USDT@1m`、`futures:BTCUSDT@1m`。

## 查询语义

`QueryEngine` 按以下顺序解析数据：

1. cache 命中时先用 cache。
2. 再查注入的 storage backend。
3. 检测到 missing ranges 且 `auto_backfill` 开启时触发 backfill。

`QueryResult` 包含：

- `bars`：按时间升序排列的 `BarData`
- `source`：`cache`、`storage`、`backfill`、`mixed` 或 `empty`
- `cache_hit`
- `has_more`
- `backfill_triggered`
- `has_tail_gap`
- `missing_ranges`
- `metadata`

API range endpoints 会在这些 metadata 之上额外做可见范围连续性校验。

## Stream 生命周期

`ensure_stream()` 是启动实时数据的公共入口：

```text
ensure_stream(symbol, interval)
        ▼
StreamEnsurePlanner
        ▼
StreamCoordinator
        ├── BarAggregator.add_target()
        └── IngestionFactory.start(on_market_event)
```

planner 会选择需要的 source streams。对于自定义周期，可能会启动合适的 base interval，并在 aggregator 中注册用户请求的 target interval。

## Backfill 协调

`BackfillCoordinator` 和 `BackfillEngine` 分离：

- 去重 in-flight requests。
- 合并兼容 ranges。
- 在 `GapLedger` 持久化 gap lifecycle。
- 处理 retry/cancel/shutdown。
- 运行 `BackfillEngine`。
- 按 `RepairReport.written_ranges` 从 storage 回读。
- 调用 `DataManager.on_bars_backfilled()`。
- 发出 `BACKFILL_COMPLETED` 或 `BACKFILL_FAILED`。

API 和 settings 代码应通过 DataManager/coordinator 触发修复，不要直接调用 `BackfillEngine.run()`。

## Events

`DataEventType` 包括：

- Bar 生命周期：`BAR_CREATED`、`BAR_UPDATED`、`BAR_CLOSED`、`BAR_AMENDED`、`BAR_EXPIRED`
- Stream 生命周期：`STREAM_STARTED`、`STREAM_STOPPED`、`STREAM_ERROR`
- Backfill 生命周期：`BACKFILL_STARTED`、`BACKFILL_COMPLETED`、`BACKFILL_FAILED`
- Cache/price：`CACHE_PREWARM`、`CACHE_EVICTION`、`PRICE_UPDATED`

消费者可使用 callback 或 async iterator：

```python
async for event in dm.subscribe_iter(symbol="BTCUSDT", interval="1m"):
    print(event.to_dict())
```

## 配置

`DataManagerConfig` 分组：

| 分组 | 重要字段 |
|---|---|
| `cache` | `max_bars_per_series`、`max_series`、`prewarm_bars`、`ttl_seconds` |
| `query` | `default_limit`、`max_limit`、`sync_backfill_timeout_seconds`、`auto_backfill` |
| `event_bus` | `subscriber_queue_size`、`emit_bar_updated`、`emit_bar_created` |
| `coordinator` | `auto_start_ingestion`、`idle_stream_timeout_seconds`、`base_interval`、`prewarm_intervals`、`prewarm_symbols`、`prewarm_targets` |

## 维护

`DataManager` 通过门面方法提供 settings API 所需的维护能力：

- `repair_custom_storage()`
- `scan_and_fill_storage_gaps()`
- `scan_storage_gaps()`
- `update_retention_limits()`
- `retention_snapshot()`

维护方法在发生并发冲突时抛出 `MaintenanceBusyError`，缺少必要 runtime dependency 时抛出 `MaintenanceUnavailableError`。

## 测试

```bash
cd backend
python -m pytest -q \
  tests/test_query_engine_paths.py \
  tests/test_backfill_coordinator.py \
  tests/test_data_manager_warm_start_bridge.py \
  tests/test_maintenance_facade.py \
  tests/test_price_subscription_services.py
```
