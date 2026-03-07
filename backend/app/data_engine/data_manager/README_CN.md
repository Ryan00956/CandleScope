# Data Manager（数据管理器）

> **CandleScope 的统一缓存、查询和事件分发层。**

Data Manager 是所有 K 线数据操作的**唯一入口**。图表、指标、策略、API 端点和 WebSocket 推送全部通过 `DataManager` 交互，不需要直接操作缓存、存储或数据采集模块。

## 架构

```
┌──────────────────────────────────────────────────────┐
│                  DataManager（门面）                  │
│                                                      │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ BarCache │  │ QueryEngine │  │  DataEventBus  │  │
│  │ 内存缓存  │  │  查询引擎    │  │   事件总线      │  │
│  └────┬─────┘  └──────┬──────┘  └───────┬────────┘  │
│       │               │                │             │
│  ┌────┴───────────────┴────────────────┴──────────┐  │
│  │           StreamCoordinator（流协调器）          │  │
│  │     数据采集 + 聚合 生命周期管理                   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
         ▲              ▲              ▲
         │              │              │
    bar_aggregator   storage      ingestion
     （K线聚合）    （SQLite）   （WebSocket）
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `config.py` | 所有配置数据类（`DataManagerConfig`、`CacheConfig`、`QueryConfig`、`EventBusConfig`、`CoordinatorConfig`） |
| `models.py` | 核心类型：`BarData`（K线数据）、`SeriesKey`（系列标识）、`QueryResult`（查询结果）、`DataEvent`（事件）、`StorageBackend`（存储协议）等 |
| `cache.py` | `BarCache` — 线程安全、LRU 淘汰、有界的内存 K 线缓存，每个系列独立环形缓冲区 |
| `event_bus.py` | `DataEventBus` — 基于主题的发布/订阅，支持回调和异步迭代器两种订阅方式，支持中间件 |
| `query.py` | `QueryEngine` — 三级查询引擎：缓存 → 存储 → 回填 |
| `coordinator.py` | `StreamCoordinator` — 数据采集管道的生命周期管理、预热、空闲回收 |
| `manager.py` | `DataManager` — 组合所有组件的公共门面 |

## 快速开始

```python
from app.data_engine.data_manager import DataManager, DataManagerConfig

# 使用默认或自定义配置创建
dm = DataManager()

# 注入可选后端
dm.set_storage(my_storage_backend)          # SQLite、PostgreSQL 等
dm.set_ingestion_factory(my_ws_factory)     # Binance、OKX 等
dm.set_backfill_trigger(backfill_fn)        # 缺口填补回调

# 启动（预热缓存、启动空闲回收器）
await dm.start()
```

## 查询数据

所有消费者使用相同的接口：

```python
# 获取最新 500 根 K 线
result = dm.query("BTCUSDT", "1m", limit=500)

# 时间范围查询
result = dm.query("BTCUSDT", "1h", start_ms=1700000000000, end_ms=1700100000000)

# 分页（加载更多）
result = dm.query_before("BTCUSDT", "1m", before_ms=oldest_bar_ms, limit=500)

# 访问结果
for bar in result.bars:
    print(bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume)

# 元数据
print(result.source)              # "cache"、"storage"、"mixed"、"empty"
print(result.cache_hit)           # True/False
print(result.backfill_triggered)  # 是否触发了回填
```

查询引擎分三级解析数据：
1. **缓存** — 亚毫秒级，内存中
2. **存储** — SQLite / 数据库回退，结果会自动缓存供下次使用
3. **回填** — 如果检测到缺口，触发异步历史数据获取

## 订阅事件

### 回调方式

```python
from app.data_engine.data_manager import DataEventType

async def on_bar_closed(event):
    bar = event.bar
    print(f"K线收盘: {event.key} @ {bar.close}")

handle = dm.subscribe(
    callback=on_bar_closed,
    symbol="BTCUSDT",
    interval="1m",
    event_types={DataEventType.BAR_CLOSED},
)

# 取消订阅
dm.unsubscribe(handle)
```

### 异步迭代器方式

```python
async for event in dm.subscribe_iter("BTCUSDT", "1m"):
    await websocket.send(event.to_dict())
```

### 事件类型

| 事件 | 说明 |
|------|------|
| `BAR_CREATED` | 新的 K 线桶开始 |
| `BAR_UPDATED` | K 线 OHLCV 更新（实时tick） |
| `BAR_CLOSED` | K 线最终确认 — 策略最关心的事件 |
| `BAR_AMENDED` | 历史 K 线修正（回填） |
| `STREAM_STARTED` | 数据采集管道启动 |
| `STREAM_STOPPED` | 数据采集管道停止 |
| `STREAM_ERROR` | 数据流遇到错误 |
| `BACKFILL_*` | 回填生命周期（开始/完成/失败） |
| `CACHE_PREWARM` | 缓存预热完成 |
| `CACHE_EVICTION` | 系列被从缓存淘汰 |

## 数据流管理

```python
# 按需自动启动数据流
info = await dm.ensure_stream("BTCUSDT", "1m")

# 停止数据流
await dm.stop_stream("BTCUSDT", "1m")

# 查看所有活跃流
streams = dm.get_all_streams()
for s in streams:
    print(s.to_dict())
```

## 中间件

中间件钩子在每个事件到达订阅者之前运行：

```python
async def logging_middleware(event):
    logger.info(f"事件: {event.event_type} {event.key}")
    return event  # 返回 None 则抑制该事件

dm.add_middleware(logging_middleware)
```

## 与 bar_aggregator 集成

`bar_aggregator.publisher` 将事件推送到 Data Manager：

```python
bar = BarData.from_bar_state(bar_state)
await data_manager.on_bar_event(
    symbol="BTCUSDT",
    interval="5m",
    bar=bar,
    event_type=DataEventType.BAR_CLOSED,
)
```

## 与 backfill 集成

```python
# 回填获取和校验完成后
bars = [BarData.from_storage_row(r) for r in rows]
await data_manager.on_bars_backfilled("BTCUSDT", "1m", bars)
```

## 自定义存储后端

实现 `StorageBackend` 协议：

```python
class MyPostgresStorage:
    def query_bars(self, symbol, interval, start_ms=None, end_ms=None, limit=None, order="ASC"):
        ...
    def upsert_bars(self, symbol, interval, rows, source="data_manager"):
        ...
    def get_bounds(self, symbol, interval):
        ...
    def delete_bars(self, symbol, interval, start_ms=None, end_ms=None):
        ...
    def fetch_before(self, symbol, interval, before_ms, limit=500):
        ...

dm.set_storage(MyPostgresStorage())
```

## 诊断

```python
snapshot = dm.snapshot()
# 返回完整的 JSON 可序列化字典，包含：
# - 缓存统计（命中/未命中/系列数）
# - 查询指标（总查询数/缓存命中率）
# - 事件总线状态（订阅者数量/已发送/已丢弃事件数）
# - 流信息（活跃流/健康状态）
# - 完整配置
```

## 配置

所有配置通过 `DataManagerConfig`：

```python
from app.data_engine.data_manager import (
    DataManagerConfig, CacheConfig, QueryConfig, EventBusConfig, CoordinatorConfig
)

config = DataManagerConfig(
    cache=CacheConfig(
        max_bars_per_series=5000,   # 每个(交易对, 周期)的最大K线数
        max_series=200,             # 最大追踪系列数
        prewarm_bars=1000,          # 首次访问时加载的K线数
        ttl_seconds=0,              # 0 = 永不过期
    ),
    query=QueryConfig(
        default_limit=500,          # 默认返回条数
        max_limit=10000,            # 单次查询上限
        auto_backfill=True,         # 检测到缺口时自动回填
    ),
    event_bus=EventBusConfig(
        subscriber_queue_size=1000, # 每个订阅者的队列深度
        emit_bar_updated=True,      # 是否转发更新事件
        emit_bar_created=True,      # 是否转发创建事件
    ),
    coordinator=CoordinatorConfig(
        auto_start_ingestion=True,        # 按需自动启动采集
        idle_stream_timeout_seconds=300,  # 空闲流超时（秒）
        base_interval="1m",              # 基础采集周期
        prewarm_symbols=["BTCUSDT"],     # 启动时预热的交易对
        prewarm_intervals={"1m": 1, "5m": 3, "1h": 30},  # 预热周期和天数
    ),
)

dm = DataManager(config)
```

## 设计原则

- **单一入口** — 全部数据操作走 DataManager，降低耦合
- **依赖注入** — 存储、采集、回填全部通过协议/接口注入，方便替换
- **开发者友好** — 丰富的文档字符串、类型标注和诊断快照
- **可扩展** — 中间件、自定义存储后端、自定义采集工厂
- **确定性内存** — 有界缓存，LRU 淘汰，可选 TTL 过期
