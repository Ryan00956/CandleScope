# P3A Partial Top-N 盘口后端

## 结论

这一阶段只实现可替换的 Partial Top-N 盘口快照，不实现完整本地订单簿：

- 首个支持范围是 Binance USDⓈ-M Futures；
- 支持 5、10、20 档和 100、250、500ms 更新频率；
- 每个不可变 stream key 只保留最新快照，慢消费者允许覆盖旧快照；
- 原始盘口不落库，没有历史查询，也不能用于完整订单簿回放；
- `last_update_id` 仅用于拒绝进程内重复或倒退快照，不代表 gap-free 连续性。

[Binance 当前 USDⓈ-M 公共市场流协议](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public)入口位于 `/public/ws`。250ms 是省略速度后缀的默认流，例如 `btcusdt@depth20`；100ms 和 500ms 分别使用 `@100ms`、`@500ms`。内部 identity 仍显式保留 250ms，避免不同频率错误复用。本实现保留上游存在时的 `U/u/pu/E/T`，但 P3A 不用它们增量重建全量订单簿。

## 数据链路

```text
Binance Partial Depth WS
  -> Binance protocol / normalizer
  -> MarketEvent(StreamType.DEPTH)
  -> OrderBookService per-key latest mailbox
  -> OrderBookEngine validation + metrics
  -> MarketEventHub latest state
     |-> HTTP bounded transient snapshot
     `-> WebSocket latest-wins fanout
```

`OrderBookService` 与 K 线、TradeFlow、Liquidation 独立。浏览器慢、网络抖动或同一 stream 高频突发时，等待处理的旧快照会被新快照覆盖，不会让消息总量转化为无界队列。

## Stream identity

逻辑 key 必须精确包含：

```json
{
  "exchange": "binance",
  "market_type": "futures",
  "symbol": "BTCUSDT",
  "channel": "depth",
  "params": {
    "mode": "partial",
    "depth_levels": "20",
    "update_interval_ms": "250"
  }
}
```

档位或频率不同就是不同的物理 stream，不能错误复用同一 ingestion pipeline。

## 快照字段和指标

每条发布记录的 `data` 包含：

| 字段 | 含义 |
|---|---|
| `last_update_id` | 当前快照上游 update ID |
| `depth_levels` | 请求的最大档位数 |
| `update_interval_ms` | 交易所推送频率 |
| `bids` / `asks` | 规范化后的 `[price, quantity]`；买盘降序、卖盘升序 |
| `top_bid` / `top_ask` | 最优买价和最优卖价 |
| `mid_price` | `(top_bid + top_ask) / 2` 的安全等价计算 |
| `spread` | `top_ask - top_bid` |
| `spread_bps` | `spread / mid_price * 10000` |
| `bid_base_quantity` / `ask_base_quantity` | 两侧观测基础资产数量和 |
| `bid_notional` / `ask_notional` | 两侧 `price * quantity` 之和 |
| `notional_imbalance` | `(bid_notional - ask_notional) / (bid_notional + ask_notional)` |

引擎拒绝空盘口、超档、重复价格、零或负价格/数量、非有限数、锁盘和交叉盘。`bids`、`asks` 允许少于请求档位，因为薄盘口并不一定填满全部档位。

## HTTP

```http
GET /api/v1/order-book/snapshot
    ?exchange=binance
    &market_type=futures
    &symbol=BTCUSDT
    &depth_levels=20
    &update_interval_ms=250
    &wait_ms=2000
```

接口使用唯一的短期逻辑 lease：没有浏览器订阅时会启动物理流，等待首个新鲜快照，然后在 `finally` 中释放 lease。等待有界，超时返回 `504`；内部上游错误会脱敏。响应会在交易对元数据可用时附带 `price_tick_size`，供前端做不超过 `tick × 10` 的有限展示聚合；前端会省略被 Top-N 边界截断的最外侧聚合桶，不会把不完整数量或 20 档快照伪装成更深盘口。

响应明确包含：

```json
{
  "type": "order_book.snapshot",
  "protocol": "orderbook.v1",
  "delivery": "latest_snapshot",
  "full_depth": false,
  "backfillable": false,
  "persisted": false
}
```

## WebSocket

连接：

```text
ws://localhost:8000/api/v1/stream/order-book
```

首条命令：

```json
{
  "action": "subscribe",
  "request_id": "book-1",
  "streams": [
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "channel": "depth",
      "params": {
        "mode": "partial",
        "depth_levels": 20,
        "update_interval_ms": 250
      }
    }
  ]
}
```

服务端依次发送：

1. `connected`
2. `subscribed`
3. `snapshot`：订阅建立时的当前快照集合
4. `order_book.snapshot`：后续最新替换快照

订阅建立后不可变；改变交易对、档位或频率需要重连。客户端看到 revision 跳号不表示订单簿损坏，因为这里只传 replaceable snapshot。接口同时声明 `sequence_continuity=false`，防止前端误当成 Full Depth delta。

## 配置

| 环境变量 | 默认值 | 用途 |
|---|---:|---|
| `ORDER_BOOK_MAX_STREAMS` | `64` | 同时活跃的物理 Partial Depth stream 上限 |
| `ORDER_BOOK_EVENT_QUEUE_SIZE` | `256` | per-key latest mailbox key 队列上限；必须不小于 stream 上限 |
| `ORDER_BOOK_DEFAULT_MAX_PENDING` | `32` | 每个消费者最多等待的不同 stream key 数 |
| `ORDER_BOOK_MAX_SNAPSHOT_AGE_MS` | `5000` | HTTP/current 可接受的快照最大年龄 |
| `ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS` | `2.0` | 单个物理 feed 有界停止等待 |

配置不合法时 runtime fail closed，不会静默退化为无界队列或错误复用 stream。

## 诊断与验收

`GET /debug/snapshot` 的 `order_book` 节点包含：

- 物理 stream、逻辑 lease 和 snapshot age；
- `events_coalesced`、队列拒绝和队列高水位；
- invalid、duplicate、stale、identity mismatch；
- Hub subscriber coalesced/dropped；
- stop timeout、late reconciliation 和 degraded 状态；
- Engine stream 容量、淘汰和校验计数。

重点验收边界：慢客户端不会推动内存随消息总量增长；同一 key 只保留一个待处理快照；旧 generation 的迟到 callback 不能污染重连后的新 stream。

## 与回放、存储和 Full Depth 的边界

成交驱动 K 线回放继续依赖 `RawAggTradeArchive.scan_range()`，不依赖盘口。本阶段不写 SQLite、Parquet 或 DuckDB，避免高频快照制造无意义写放大。

如果以后需要历史盘口指标，可以新增低频 Spread/Imbalance rollup store；不要落每个原始快照。进入 Full Depth 前必须另建 ordered-delta 状态机，完整保留并校验 `U/u/pu`，执行 REST snapshot 对齐、断序 stale、重新同步和严格队列策略，不能复用本阶段的 latest-wins 语义。
