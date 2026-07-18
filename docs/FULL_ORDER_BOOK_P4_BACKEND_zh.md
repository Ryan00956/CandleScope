# P4 完整订单簿纯后端实现

## 1. 本阶段结论

P4 新增了一条与 P3A Partial Top-N 完全隔离的 Full Depth 主链：

```text
Binance diff-depth WebSocket
        │ ordered U/u/pu deltas
        ▼
per-stream bounded actor ──────► connection health observer
        │                         reconnect => stale immediately
        ├─ buffer deltas first
        ├─ fetch REST depth snapshot(limit=1000)
        ├─ align and replay atomically
        └─ gap/cross/overflow => discard epoch + resync
        ▼
bounded local L2 book
        ▼
atomic replaceable snapshots/status
        ├─ HTTP /api/v1/full-order-book/snapshot
        └─ WS   /api/v1/stream/full-order-book
```

它不复用 P3A 的 latest-wins ingestion mailbox。上游任一 delta 丢失都可能破坏整个 book，因此 P4 的原则是：

- 严格按接收顺序处理；
- 不静默丢 delta；
- 发现不连续后立即停止对外提供 live book；
- 只有完成新 REST snapshot 与 WS delta 对齐后才重新变为 live；
- 不保存 raw depth，不提供历史查询。

## 2. “完整”的准确含义

Binance USDⓈ-M REST `/fapi/v1/depth` 单侧最多返回 1000 个价位，而且 RPI 订单不包含在普通 depth 响应中。因此这里的 Full Order Book 指：

> 从交易所允许的最大 1000 档 REST seed 出发，持续无缺口应用之后收到的全部普通 L2 diff-depth 更新，并维护本地序列一致的动态订单簿。

它不是交易所撮合引擎中所有未暴露价位的穷尽副本。响应中会显式返回：

```json
{
  "local_sequence_continuity": true,
  "exchange_full_depth_exhaustive": false
}
```

本地引擎默认允许每侧最多 5000 个动态价位；HTTP/WS 单次输出最多投影前 1000 行。`output_limit` 只影响聚合后的输出，不改变后端重建覆盖范围，也不会新建额外的交易所连接。价格聚合发生在完整本地投影上，因此粗粒度不会退化为“把已经裁剪的 100 行再合并”。

## 3. Binance 同步协议

当前实现依据 Binance 2026-07-14 的官方规则：

1. 先连接 `{symbol}@depth`、`@100ms` 或 `@500ms` diff-depth stream；默认无后缀为 250ms。
2. 先缓冲收到的每个增量事件。
3. 请求 `/fapi/v1/depth?symbol=...&limit=1000`。
4. 丢弃 `u < lastUpdateId` 的旧事件。
5. 首个应用事件必须桥接 REST seed：`U <= lastUpdateId <= u`。
6. live 后每个事件的 `pu` 必须等于上一事件的 `u`。
7. `b` / `a` 中的 quantity 是该价位的新绝对数量，不是增量。
8. quantity 为 `0` 时删除价位；删除本地不存在的价位是允许的。
9. 任一 gap、冲突重复、crossed/locked book、空单边或容量越界都废弃当前 epoch 并重新同步。

官方参考：

- [USDⓈ-M Public WebSocket Streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public)
- [USDⓈ-M REST Order Book](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#order-book)
- [How to manage a local order book correctly](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)

## 4. 独立身份与能力边界

新增逻辑类型：

- ingestion：`StreamType.FULL_DEPTH = "fullDepth"`
- market channel：`MarketChannel.FULL_DEPTH = "full_depth"`
- delivery class：`ORDERED_DELTA`

一条物理流的稳定 identity 为：

```text
exchange + market_type + symbol + mode=full
+ snapshot_limit=1000 + update_interval_ms
```

P3A 仍使用：

```text
StreamType.DEPTH / MarketChannel.DEPTH / mode=partial
```

两者拥有不同 descriptor key、normalizer、service、engine、HTTP/WS API 与诊断项。Full Depth delta 中的零数量删除不会进入拒绝零数量的 Partial snapshot 模型。

## 5. Fail-closed 状态机

每条物理流由一个 actor 独占修改，主要状态为：

```text
starting -> stale -> resyncing -> live
                         ▲         │
                         └─ gap ───┘
```

以下情况会立即进入 stale：

- `pu` 不等于上一包 `u`；
- 首包无法桥接 REST `lastUpdateId`；
- WebSocket 进入 `RECONNECTING`、`UNHEALTHY` 或 `DISCONNECTED`；
- 上游有界 queue 满；
- crossed/locked book 或一侧被清空；
- 同一 update ID 出现冲突 payload；
- book、delta 或 bootstrap buffer 超过硬上限；
- snapshot 超时、失败或属于旧 generation/epoch。

stale 状态会：

- 清空对外 `bids` / `asks`；
- 令 `live=false`、`sequence_continuity=false`；
- 保留 `last_live_update_id` 与 `stale_reason` 供诊断；
- 拒绝 HTTP `current`/`wait_for_live` 把旧 book 当作可用状态；
- 启动带指数退避的新 snapshot 对齐。

旧 REST 请求即使忽略 cancellation 并延迟返回，也受 `generation + resync_version + engine_epoch` 三层隔离，不能覆盖新 book。

## 6. HTTP API

```http
GET /api/v1/full-order-book/snapshot
    ?exchange=binance
    &market_type=futures
    &symbol=BTCUSDT
    &update_interval_ms=250
    &limit=100
    &price_grouping=auto
    &wait_ms=5000
```

约束：

- 当前仅支持 `binance + futures`；
- `update_interval_ms`：`100 | 250 | 500`；
- `limit`：`1..1000`，表示聚合后的最大输出行数；
- `price_grouping`：`raw | auto | 10 | 100 | 1000`，数字是 `price_tick_size` 的倍数；
- endpoint 使用短租约，成功、超时或错误后都会释放；
- 同步未在 `wait_ms` 内完成返回 `504`；stale 不返回旧 book。

响应契约：

```json
{
  "type": "full_order_book.snapshot",
  "protocol": "orderbook.full.v1",
  "delivery": "atomic_snapshot",
  "source_delivery": "ordered_delta",
  "backend_sequence_continuity": true,
  "fail_closed_on_gap": true,
  "upstream_snapshot_limit": 1000,
  "output_limit": 100,
  "price_grouping": "auto",
  "backfillable": false,
  "persisted": false,
  "data": {
    "data": {
      "price_tick_size": 0.1,
      "price_step": 1.0,
      "price_grouping": "auto",
      "aggregation_applied": true
    }
  }
}
```

## 7. WebSocket API

连接：

```text
WS /api/v1/stream/full-order-book
```

订阅：

```json
{
  "action": "subscribe",
  "request_id": "book-1",
  "streams": [
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "channel": "full_depth",
      "params": {
        "mode": "full",
        "snapshot_limit": 1000,
        "update_interval_ms": 100,
        "output_limit": 200,
        "price_grouping": "auto"
      }
    }
  ]
}
```

聚合规则是展示契约，不改变底层物理 stream identity：

- 买盘使用 `floor(price / step) * step`，不会把可买价格抬高；
- 卖盘使用 `ceil(price / step) * step`，不会把可卖价格压低；
- 同桶数量相加后才应用 `output_limit`；
- 每侧可见价格窗口不超过 `price_step × (output_limit - 1)`，不会因为 1000 档种子里的稀疏远端挂单而把近端盘口拉到异常价格；
- 如果非穷尽交易所源在最外侧聚合桶中间截止，该不完整边界桶会被省略；`price_window_*_truncated` 与 `incomplete_outer_*_bucket_omitted` 明确报告两类裁剪；
- `best_bid_price`、`best_ask_price`、`mid_price`、`spread` 和 `spread_bps` 仍来自未聚合盘口；
- `auto` 以约 `0.1 bps`（价格的十万分之一）的尺度选择 `tick × 10^n`，并限制在支持范围内；tick 元数据不可用时安全退回原始价位。

live book 使用：

```json
{
  "type": "full_order_book.snapshot",
  "state": "live",
  "backend_sequence_continuity": true,
  "data": {}
}
```

断链或 gap 使用独立 status 帧，不伪装成 snapshot：

```json
{
  "type": "full_order_book.status",
  "state": "stale",
  "backend_sequence_continuity": false,
  "data": {
    "data": {
      "live": false,
      "bids": [],
      "asks": [],
      "stale_reason": "ingestion_reconnecting"
    }
  }
}
```

浏览器消费者应在 status=stale 时立即清空旧 book，等待后续新的 live atomic snapshot。当前下游允许按 stream key 合并尚未发送的 replaceable snapshot；这不会影响后端 actor 对每个上游 delta 的严格处理。

## 8. 配置

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `FULL_ORDER_BOOK_MAX_STREAMS` | `16` | 同时活跃的 Full Depth 物理流上限 |
| `FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE` | `4096` | 每条物理流严格 delta queue 上限 |
| `FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE` | `5000` | 本地每侧价位硬上限，必须至少 1000 |
| `FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA` | `10000` | 单个 delta 的价位更新硬上限 |
| `FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES` | `200000` | bootstrap 缓冲价位更新总上限 |
| `FULL_ORDER_BOOK_DEFAULT_MAX_PENDING` | `16` | 下游消费者等待的不同 stream key 上限 |
| `FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS` | `5.0` | 单次 REST seed/bridge 有界等待 |
| `FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS` | `0.1` | 首次重同步退避 |
| `FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS` | `5.0` | 指数退避上限 |
| `FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS` | `5.0` | 物理 feed 停止等待上限；需覆盖底层 WebSocket close budget |

无效或互相矛盾的配置会在启动时 fail fast，不会降级为无界或静默丢包模式。

## 9. 存储和未来演进

本阶段明确不做：

- raw depth delta 落库；
- Full Order Book 历史 API；
- 用 K 线/成交历史伪造历史订单簿；
- 前端 Worker、增量镜像或 DOM 渲染。

因此这条链不会污染现有 SQLite、Parquet 原始成交归档或未来 DuckDB 存储接口。若以后需要订单簿研究数据，应新增“采样快照/聚合微结构指标”存储，而不是直接把无界 raw depth 塞进当前业务库。

前端下一阶段可以直接消费本阶段的 atomic snapshot/status 契约；如果改为浏览器 Worker 重放 delta，应另开带 `book_epoch + sequence` 的下游严格协议，不能把当前 replaceable snapshot socket 偷换成有损 delta socket。
