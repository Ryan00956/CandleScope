# CandleScope 爆仓后端 P2B

## 结论

本阶段新增一条独立于 K 线和 TradeFlow 的公开爆仓主链：

```text
Binance Futures {symbol}@forceOrder
  -> Binance normalizer / MarketEvent
  -> LiquidationService
  -> LiquidationEngine
       |-> 有界原始事件 ring -> liquidation.v1 WebSocket / recent HTTP
       `-> 每分钟、每方向 rollup -> 有界 writer -> SQLite -> history HTTP
```

它保存的是 CandleScope 实际观察到的公开强平快照，不是交易所的全量爆仓账本。所有 HTTP、WebSocket 和诊断消息都显式携带：

```json
{
  "source_quality": "sampled_best_effort",
  "lossy_snapshot": true,
  "backfillable": false,
  "exchange_update_interval_ms": 1000
}
```

前端和后续分析必须保留这组语义，不能把本地聚合显示成“市场真实总爆仓量”。

## 为什么是 sampled_best_effort

Binance Futures 的公开 liquidation stream 是 `{symbol}@forceOrder`。交易所对每个品种每 1000ms 最多推送该窗口内最新的一条强平订单快照；窗口内如果发生多条，其余事件不会形成可恢复的连续序列。公开 payload 也没有可用于 gap repair 的单调事件 ID。

官方说明：[Binance USDⓈ-M Liquidation Order Streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market#liquidation-order-streams)

因此当前链路有这些硬边界：

- 没有公共历史源可回填 CandleScope 启动前的数据。
- 没有 sequence，不能像 aggTrade 一样检测并按 ID 修补缺口。
- 断网或进程停止期间的数据无法重建。
- 本地 fingerprint 只在当前进程保留的原始 ring 内去重；重启后不承诺原始事件级幂等。
- SQLite 保存的是一分钟方向聚合，原始事件不落 SQLite，也不写 Parquet。

`delivery_continuity=true` 只表示 CandleScope 后端到当前浏览器 subscriber 的有界队列没有丢批，不表示交易所源完整。

## 方向定义和金额口径

Binance payload 的 `order_side` 是强制平仓订单方向，而不是被平仓仓位方向：

| `order_side` | 被强平仓位 | CandleScope `position_side` |
|---|---|---|
| `SELL` | 多头被强制卖出 | `long` |
| `BUY` | 空头被强制买回 | `short` |

爆仓成交名义金额只使用已成交口径：

```text
executed_notional = average_price * filled_quantity
```

其中 `filled_quantity` 是交易所 payload 的累计成交量。不会在成交均价或累计成交量为零时退回使用 `order_price * original_quantity`，以免把未成交委托金额混进实际成交聚合。

实时原始事件还保留：

- `order_type`
- `time_in_force`
- `original_quantity`
- `order_price`
- `average_price`
- `order_status`
- `last_filled_quantity`
- `filled_quantity`
- `trade_time_ms`
- `event_time_ms`
- `received_at_ms`
- `pair_symbol` / `symbol_type`
- `fingerprint`

## 一分钟落库 schema

SQLite 表名为 `liquidation_rollup_1m`。自然主键是：

```text
(exchange, market_type, symbol, bucket_open_ms, position_side)
```

同一分钟的多头爆仓和空头爆仓各占一行；某方向没有观测事件时，不强行写零值行。

| 字段 | 含义 |
|---|---|
| `exchange` | 交易所，规范化为小写 |
| `market_type` | 当前只支持 `futures` |
| `symbol` | 大写交易对 |
| `bucket_open_ms` | UTC 毫秒时间，一分钟对齐 |
| `bucket_close_ms` | `bucket_open_ms + 60000` |
| `position_side` | `long` 或 `short` |
| `filled_quantity` | 该方向观测事件的累计成交量之和 |
| `filled_notional` | 该方向观测 `executed_notional` 之和 |
| `event_count` | 该方向收到的公开快照数，不是实际强平订单总数 |
| `max_event_notional` | 单条观测事件最大已成交名义金额 |
| `first_event_time_ms` | 桶内最早交易所成交时间 |
| `last_event_time_ms` | 桶内最晚交易所成交时间 |
| `is_final` | 分钟桶是否已结束 |
| `revision` | 桶内版本 |
| `source` | 当前通常为 `websocket` / `live` |
| `received_at_ms` | 最新本地接收时间 |

writer 对 provisional 行按自然键合并，并设置有界容量；final 行走 durable acknowledgement。SQLite upsert 保证 final 不会被 provisional 覆盖，之后再按较新的 `received_at_ms`、相同接收时间下较大的 `revision` 选择版本。

存储接口通过 `LiquidationRollupStore` 抽象，当前实现是 SQLite，未来可增加 DuckDB 而不改变 service、DataManager 或 API 契约。

## HTTP API

### 短期原始观测

```http
GET /api/v1/liquidations/recent
    ?exchange=binance
    &market_type=futures
    &symbol=BTCUSDT
    &limit=500
```

- 默认 `limit=500`，最大 5000。
- 数据来自当前进程的有界 ring。
- 重启后 ring 清空。
- 返回 `coverage.earliest_ms/latest_ms` 和质量元数据。

### 本地一分钟历史

```http
GET /api/v1/liquidations/history
    ?exchange=binance
    &market_type=futures
    &symbol=BTCUSDT
    &period=1m
    &position_side=long
    &start_ms=...
    &end_ms=...
    &limit=500
```

- 只支持 `period=1m`。
- `position_side` 可省略，或使用 `long` / `short`。
- `start_ms`、`end_ms` 都可省略；两者都省略时返回最新尾部，再按时间升序排列。
- 单次最大 5000 行，响应使用额外一行判断 `has_more`。
- 只返回 CandleScope 本地已经观察并落库的范围。
- `coverage.all_rows_final` 只表示返回桶已经结束，不表示交易所源全量完整。

## WebSocket 协议

连接地址：

```text
ws://localhost:8000/api/v1/stream/liquidations
```

协议版本：`liquidation.v1`。

订阅示例：

```json
{
  "action": "subscribe",
  "request_id": "liq-1",
  "streams": [
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "channel": "liquidation"
    }
  ],
  "recent_limit": 500
}
```

首次成功订阅后 stream 集合不可修改。服务端依次发送：

1. `connected`
2. `subscribed`
3. `recent`
4. 后续 `liquidation.batch`

批次示例：

```json
{
  "type": "liquidation.batch",
  "protocol": "liquidation.v1",
  "sequence": 12,
  "delivery_continuity": true,
  "resync_required": false,
  "dropped_before": 0,
  "source_quality": "sampled_best_effort",
  "lossy_snapshot": true,
  "backfillable": false,
  "exchange_update_interval_ms": 1000,
  "data": []
}
```

如果浏览器消费过慢导致本地 subscriber 队列丢批，服务端发送：

```json
{
  "type": "resync_required",
  "protocol": "liquidation.v1",
  "code": "LIQUIDATION_DELIVERY_DISCONTINUITY",
  "delivery_continuity": false,
  "resync_required": true,
  "dropped_before": 1
}
```

然后以 WebSocket code `1013` 关闭连接。客户端应重连，并重新获取 recent/history；不能尝试按不存在的交易所 sequence 修补。

当前每个 socket 最多 32 个订阅，每流 recent 最大 2000 条，初始 recent 总量最大 5000 条，subscriber pending record 上限为 4096。

## 常驻采集与本地历史

普通浏览器订阅会持有一个 consumer lease；最后一个 consumer 释放后，对应物理上游流可以停止。如果希望关闭浏览器后仍继续积累本地一分钟历史，应配置：

```dotenv
LIQUIDATION_CAPTURE_STREAMS=binance:futures:BTCUSDT,binance:futures:ETHUSDT
```

runtime 使用固定 consumer：

```text
runtime:liquidation-capture
```

相同 identity 会规范化并去重。任一配置项格式错误或常驻 lease 启动失败都会让应用启动失败，避免用户误以为历史仍在持续采集。

默认值为空，表示不创建常驻上游订阅；服务本身仍会初始化，按浏览器/API consumer 的实际 lease 工作。

## 环境变量

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `LIQUIDATION_ROLLUP_BACKEND` | `sqlite` | rollup 存储实现；当前仅支持 SQLite |
| `LIQUIDATION_DB_PATH` | `KLINES_DB_PATH` | 爆仓 rollup SQLite 文件，可与 K 线共库但使用独立表 |
| `LIQUIDATION_RAW_RING_SIZE` | `5000` | 每个 stream 的进程内原始事件上限 |
| `LIQUIDATION_MAX_STREAMS` | `64` | 同时活跃的爆仓物理 stream 上限 |
| `LIQUIDATION_EVENT_QUEUE_SIZE` | `8192` | service ingestion command queue 上限 |
| `LIQUIDATION_BATCH_INTERVAL_SECONDS` | `0.1` | 浏览器 append batch flush 周期 |
| `LIQUIDATION_MAX_BATCH_SIZE` | `500` | 单个浏览器 batch 最大事件数 |
| `LIQUIDATION_FINALIZE_INTERVAL_SECONDS` | `1.0` | wall-clock 桶终结检查周期 |
| `LIQUIDATION_CAPTURE_STREAMS` | 空 | 逗号分隔的常驻采集 identity |

数值配置必须为有限正数；backend、路径、stream identity 或数值无效时启动 fail-closed。

## 诊断

```http
GET /debug/snapshot
```

查看响应中的 `liquidations`：

- `state`
- `source_quality`
- `lossy_snapshot`
- `backfillable`
- `idempotency_scope`
- `physical_streams` / `logical_leases`
- `physical[].last_event_time_ms`
- `command_queue.pending/limit`
- `engine.raw_records/rollup_rows/duplicates_rejected`
- `hub.pending_records/subscriber_*_dropped`
- `rollup_writer.state/degraded/write_failures`
- `shutdown.degraded/last_physical_stop_error`

压测时至少观察 queue、ring、rollup row 和内存是否趋于平台；不能只检查 UI 是否出现爆仓点。

## 未来前端接入

第一版前端建议：

1. 图表初始化时用 `/liquidations/history?period=1m` 加载可见范围附近的方向桶。
2. 用 `/stream/liquidations` 接收短期事件和实时批次。
3. 将 `long` 与 `short` 作为两条副图序列，或在同一 pane 中使用正负方向；文案统一写“观测爆仓”。
4. marker 先按分钟/K 线/方向/名义金额聚合，不要为每条快照创建一个图元。
5. `source_quality=sampled_best_effort`、`lossy_snapshot=true` 必须进入 store 状态和说明文案。
6. 收到 `resync_required` 后重连并重新加载 recent/history，不按 sequence 猜测缺失金额。

Mark Price、Index Price、Basis 仍属于 latest-wins 摘要链；Funding/OI 属于低频历史指标链；爆仓是 append-only 观测链。前端不要把三类数据塞进同一个更新策略。

## 本阶段明确不包含

- 交易所公开爆仓历史回填。
- 爆仓 gap repair 或“完整率”推断。
- 原始爆仓 SQLite/Parquet 永久归档。
- 跨交易所爆仓统一口径。
- 前端副图、marker 或告警实现。

这些边界保证当前 API 对采样事实保持诚实，同时保留未来 DuckDB、跨交易所和前端聚合可视化的演进空间。
