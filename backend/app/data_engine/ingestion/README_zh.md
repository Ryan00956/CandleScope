# 实时数据摄取 — 市场数据接入管道

[![English](https://img.shields.io/badge/Language-English-blue)](README.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)


> **交易所实时数据 → 统一格式 → 稳定事件流**

本模块是 CandleScope 的**最底层数据接入层**。它连接交易所的 WebSocket/REST API，将原始数据转换为统一的 `MarketEvent` 格式，并输出稳定的事件流供下游服务订阅。

**本模块不负责生成K线、计算指标或存储数据。** 这些职责属于下游层（kline_aggregator、storage 等）。

---

## 架构

六层管道，每层职责清晰单一：

```
交易所 WS/REST
      │
      ▼
┌─────────────────┐
│  L1: Transport   │  原始 I/O — WS连接、HTTP请求、端点轮换
├─────────────────┤
│  L2: Session     │  WS生命周期 — 重连、退避、超时检测
├─────────────────┤
│  L3: FeedControl │  WS↔HTTP 故障转移 — 自动降级与恢复
├─────────────────┤
│  L4: Normalize   │  原始JSON → MarketEvent — 统一格式转换
├─────────────────┤
│  L5: Continuity  │  去重、间隙检测、自动回填
├─────────────────┤
│  L6: Delivery    │  分发 — 回调 + 异步迭代器，面向消费者
└─────────────────┘
      │
      ▼
  MarketEvent 事件流  (供 kline_aggregator、storage、UI 等消费)
```

## 支持的数据流类型

| StreamType    | WS 流名称             | REST 端点              | 说明               |
|---------------|----------------------|------------------------|--------------------|
| `KLINE`       | `@kline_<interval>`  | `/api/v3/klines`       | 交易所聚合K线       |
| `AGG_TRADE`   | `@aggTrade`          | `/api/v3/aggTrades`    | 聚合交易            |
| `TRADE`       | `@trade`             | `/api/v3/trades`       | 原始逐笔交易        |
| `TICKER`      | `@ticker`            | `/api/v3/ticker/24hr`  | 24小时滚动行情      |
| `MINI_TICKER` | `@miniTicker`        | `/api/v3/ticker/24hr`  | 轻量行情            |
| `DEPTH`       | `@depth<levels>`     | `/api/v3/depth`        | 订单簿深度          |

## 快速开始

```python
from backend.app.data_engine.ingestion import (
    MarketDataIngress, StreamDescriptor, StreamType
)

async def main():
    ingress = MarketDataIngress()
    await ingress.start()

    # 订阅 BTC 1分钟K线流
    desc = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    pipeline = await ingress.add_stream(desc)

    # 方式一：异步迭代器消费
    async for event in pipeline.delivery.subscribe():
        print(event.to_dict())

    # 方式二：回调消费
    async def on_event(market_event):
        print(market_event.data)

    pipeline.delivery.on_market_event(on_event)

    # 可以同时订阅多种流
    trade_desc = StreamDescriptor("BTCUSDT", StreamType.AGG_TRADE)
    trade_pipeline = await ingress.add_stream(trade_desc)

    await ingress.stop()
```

## 核心输出：`MarketEvent`

所有流类型都输出统一的 `MarketEvent`，其 `data` 字典按类型有不同的标准化结构：

```python
@dataclass
class MarketEvent:
    event_type: StreamType      # kline / aggTrade / trade / ticker / ...
    symbol: str                 # "BTCUSDT"
    exchange: str               # "binance"
    event_time_ms: int          # 交易所事件时间戳 (ms)
    received_at_ms: int         # 本地接收时间戳 (ms)
    source: DataSource          # websocket / http / http_backfill
    data: dict[str, Any]        # 标准化载荷（schema 因 event_type 而异）
    stream_key: str             # "BTCUSDT@kline_1m"
    sequence: int | None        # 用于去重/排序
```

### 各 StreamType 的 data 结构

**KLINE（K线）:**
```json
{
  "interval": "1m", "open_time": 1672531200000, "close_time": 1672531259999,
  "open": 16500.0, "high": 16510.0, "low": 16490.0, "close": 16505.0,
  "volume": 100.5, "quote_volume": 1658250.0, "trades": 350,
  "taker_buy_base": 60.3, "taker_buy_quote": 995000.0, "is_closed": true
}
```

**AGG_TRADE（聚合交易）:**
```json
{
  "agg_trade_id": 123456, "price": 16500.0, "quantity": 0.5,
  "first_trade_id": 100, "last_trade_id": 105,
  "trade_time_ms": 1672531200123, "is_buyer_maker": false
}
```

**TRADE（逐笔交易）:**
```json
{
  "trade_id": 12345, "price": 16500.0, "quantity": 0.5,
  "trade_time_ms": 1672531200123, "is_buyer_maker": false,
  "buyer_order_id": 111, "seller_order_id": 222
}
```

**TICKER（行情）:**
```json
{
  "price_change": 100.0, "price_change_pct": 0.61, "last_price": 16500.0,
  "bid_price": 16499.0, "ask_price": 16501.0, "volume": 50000.0, ...
}
```

**DEPTH（深度）:**
```json
{
  "last_update_id": 123456789,
  "bids": [[16499.0, 5.0], ...],
  "asks": [[16501.0, 2.0], ...]
}
```

## Delivery 层（L6）— 消费者接口

Delivery 层提供**类似 WebSocket 的稳定事件流**：

### 回调方式
```python
# 仅市场事件
pipeline.delivery.on_market_event(my_handler)

# 间隙标记
pipeline.delivery.on_gap(my_gap_handler)

# 所有事件（market_event + gap + status）
pipeline.delivery.on_event(my_universal_handler)
```

### 异步迭代器方式
```python
async for event in pipeline.delivery.subscribe():
    if event.event_type == "market_event":
        process(event.market_event)
    elif event.event_type == "gap":
        handle_gap(event.gap)
```

## 可靠性特性

- **自动重连** — 指数退避策略（L2）
- **超时检测** — N秒无消息则强制重连（L2）
- **WS → HTTP 降级** — WS连续失败时自动切换（L3）
- **WS 探测** — HTTP模式下定期探测WS，恢复后自动切回（L3）
- **去重** — 按事件类型使用不同的去重键（L5）
- **间隙检测** — 自动回填K线间隙（L5）
- **端点轮换** — 多个交易所端点间自动切换（L1）

## 配置

所有参数可通过 `IngestionConfig` 或环境变量配置：

```python
config = IngestionConfig(
    ws_reconnect_delay_max=60.0,      # WS最大重连延迟
    http_poll_interval=2.0,            # HTTP轮询间隔
    continuity_auto_fill_gaps=True,    # 自动填补间隙
    delivery_queue_size=500,           # 每订阅者队列大小
)
ingress = MarketDataIngress(config=config)
```

## 文件结构

| 文件              | 层级  | 说明                                  |
|------------------|-------|---------------------------------------|
| `models.py`      | 全局  | 数据类型：MarketEvent, StreamDescriptor |
| `config.py`      | 全局  | IngestionConfig，支持环境变量          |
| `metrics.py`     | 全局  | 各层指标（计数器、度量）               |
| `transport.py`   | L1    | 原始 WS/HTTP I/O，端点轮换            |
| `session.py`     | L2    | WS 会话生命周期，重连                  |
| `feed_control.py`| L3    | WS↔HTTP 故障转移编排器                |
| `normalize.py`   | L4    | 原始数据 → MarketEvent 转换           |
| `continuity.py`  | L5    | 去重、间隙检测、回填                   |
| `delivery.py`    | L6    | 分发给订阅者                          |
| `__init__.py`    | —     | 组装、StreamPipeline、MarketDataIngress |
