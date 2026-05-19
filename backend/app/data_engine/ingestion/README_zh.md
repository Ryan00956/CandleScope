# Ingestion

[English](README.md)

> 实时行情接入层。该模块把交易所 HTTP/WS payload 转成统一的 `MarketEvent` 和 `GapMarker`，交给下游 K 线聚合和历史修复链路。

## 在 Data Engine 中的位置

```text
交易所 WS / REST
        ▼
ingestion
        │ MarketEvent / GapMarker
        ▼
bar_aggregator / data_manager backfill trigger
```

`ingestion` 保持通用接入层定位：不生成最终业务 K 线、不写 storage、不执行历史修复。这些职责分别属于 `bar_aggregator`、`storage` 和 `backfill`。

## 六层 Pipeline

| 层 | 组件 | 职责 |
|---|---|---|
| L1 | `TransportLayer` | HTTP 和 WebSocket I/O、endpoint 选择、proxy 使用、REST 分页辅助 |
| L2 | `SessionLayer` / `SharedWsSessionAdapter` | WebSocket 生命周期、重连、stale 检测、健康状态 |
| L3 | `FeedControlLayer` | stream 不健康时在 WS 和 HTTP polling 间切换 |
| L4 | `NormalizeLayer` | 原始交易所 payload 转成 `MarketEvent` |
| L5 | `ContinuityLayer` | 去重、保序、检测缺口、发出 `GapMarker` |
| L6 | `DeliveryLayer` | 将事件 fan out 给 callback 和 async iterator subscriber |

`MarketDataIngress.add_stream()` 会为一个 `StreamDescriptor` 创建 `StreamPipeline`，并把 L3 -> L4 -> L5 -> L6 串起来。L1 transport 和 shared WS hub registry 由 `MarketDataIngress` 持有。

## 公共入口

```python
from app.data_engine.ingestion import (
    IngestionConfig,
    MarketDataIngress,
    StreamDescriptor,
    StreamType,
)

ingress = MarketDataIngress(IngestionConfig())
await ingress.start()

desc = StreamDescriptor(
    symbol="BTCUSDT",
    stream_type=StreamType.KLINE,
    interval="1m",
    exchange="binance",
    market_type="spot",
)
pipeline = await ingress.add_stream(desc)

async for event in pipeline.delivery.subscribe():
    print(event.to_dict())
```

生产 runtime 通常通过 `ExchangeIngestionFactory` 使用 ingestion，而不是直接创建 `MarketDataIngress`。对于 K 线流，factory 会通过 `StreamCoordinator` 将 L6 `MarketEvent` 直接转发给 `BarAggregator.on_market_event()`。

## 核心模型

| 类型 | 文件 | 说明 |
|---|---|---|
| `StreamDescriptor` | [models.py](models.py) | 用 exchange、market type、symbol、stream type、interval/depth 唯一标识数据流 |
| `StreamType` | [models.py](models.py) | `KLINE`、`AGG_TRADE`、`TRADE`、`TICKER`、`MINI_TICKER`、`DEPTH` |
| `MarketEvent` | [models.py](models.py) | 交易所无关的标准事件 envelope；事件时间戳统一为毫秒 |
| `GapMarker` | [models.py](models.py) | continuity 检测出的缺口，交给修复协调层处理 |
| `RawMessage` | [models.py](models.py) | L1 -> L4 内部 payload wrapper |
| `TransportRequest` | [models.py](models.py) | transport/fetching 路径使用的 REST 请求描述 |
| `FeedMode` | [models.py](models.py) | `websocket`、`http_poll`、`idle` |
| `SessionHealth` | [models.py](models.py) | `connected`、`connecting`、`reconnecting`、`unhealthy`、`disconnected` |

## 交易所标准化

normalizer 位于 [normalizers](normalizers/)：

- `binance.py` 处理 Binance spot/futures kline、trade、ticker、depth payload。
- `okx.py` 处理 OKX public/business WS payload 和 OKX volume 字段差异。
- `base.py` 定义 normalizer contract。

`NormalizeLayer` 按 `StreamDescriptor.exchange` 分发，把交易所差异隔离在 ingestion 内部。

## Shared WebSocket

[shared_ws.py](shared_ws.py) 为适合共享连接的交易所/stream type 提供 multiplex hub。当前测试断言 OKX kline stream 会走 shared hub，而普通 direct session 在不健康时会切到 HTTP fallback。

shared adapter 允许 L3 使用 HTTP fallback，同时不停止其他订阅者共用的底层 shared session。

## 配置

`IngestionConfig` 支持构造参数、`INGESTION_*` 环境变量和运行时 `update()`。

常用参数：

| 字段 / 环境变量 | 默认用途 |
|---|---|
| `INGESTION_HTTP_BASE_URLS` | Binance spot HTTP endpoints |
| `INGESTION_WS_BASE_URLS` | Binance spot WS endpoints |
| `INGESTION_HTTP_BASE_URLS_FUTURES` | Binance futures HTTP endpoints |
| `INGESTION_WS_BASE_URLS_FUTURES` | Binance futures WS endpoints |
| `INGESTION_HTTP_TIMEOUT` | HTTP 请求超时 |
| `INGESTION_PROXY_MODE` | `system`、`custom` 或 `none` |
| `INGESTION_HTTP_PROXY` | custom proxy URL |
| `INGESTION_WS_OPEN_TIMEOUT` | WebSocket 建连超时 |
| `INGESTION_WS_PING_INTERVAL` / `INGESTION_WS_PING_TIMEOUT` | WS keepalive |
| `INGESTION_WS_FAIL_THRESHOLD` | 连续失败多少次后标记 unhealthy |
| `INGESTION_HTTP_POLL_INTERVAL` | HTTP fallback 轮询间隔 |
| `INGESTION_DELIVERY_QUEUE_SIZE` | 每个 subscriber 的队列大小 |
| `INGESTION_EXCHANGE` | 默认 exchange id |

proxy 还会读取 `app.core.config` 中持久化的应用设置，因此前端可以运行时切换 proxy 模式。

## Delivery 语义

- callback subscriber 会在 queue delivery 之前被 await，给有序消费者提供背压。
- queue 满时丢弃 queue delivery item，不阻塞 callback。
- gap event 会同时发送给 callback 和 async queue。
- 关闭 subscriber 会解除满队列阻塞。

## 测试

```bash
cd backend
python -m pytest -q \
  tests/test_ingestion_delivery.py \
  tests/test_ingestion_normalizers.py \
  tests/test_ingestion_session_types.py \
  tests/test_transport_ws_urls.py
```
