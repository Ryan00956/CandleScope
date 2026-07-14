# 高级行情主链 P1（后端）

## 目标与边界

P1 在现有 K 线主链旁新增独立的高级行情主链，首批覆盖 Binance USD-M Futures：

- `mark_price`
- `index_price`
- `funding_rate`
- `open_interest`
- `basis`（由 Mark 与 Index 派生）

原有 `Ingestion -> BarAggregator -> DataManager EventBus -> Kline API/WS` 不变。高级行情不会扩充 K 线 `BarData` 或 `DataEvent`，也不会进入 BarAggregator。

```text
K 线：Exchange -> Ingestion -> BarAggregator -> Kline cache/SQLite -> Kline API/WS

高级行情：Exchange -> Ingestion -> MarketDataService -> MarketEventHub -> Market API/WS
```

P1 的历史数据直接读取 Binance REST：Funding 支持历史，OI 支持按 period 的历史；Mark/Index 点值历史暂不开放，因为 Binance 对应历史接口返回 OHLC K 线而不是同一份点值契约。高级行情本地 SQLite 持久化留到后续阶段。

## 上游传输

| 逻辑频道 | 实时 | 当前快照 | 历史 | 物理来源 |
|---|---|---|---|---|
| Mark Price | WS | REST | 否 | `<symbol>@markPrice@1s` |
| Index Price | WS | REST | 否 | 与 Mark 共用 |
| Funding Rate | WS | REST | REST | 与 Mark 共用 |
| Basis | 派生 | 派生 | 否 | 与 Mark 共用 |
| Open Interest | REST poll（5 秒） | REST | REST | 独立 OI 请求 |

Mark、Index、Funding、Basis 在同一 symbol 下只持有一个物理 Mark Price feed。Binance 高级行情 Hub 还会把不同 symbol 的 Mark Price stream 合并到同一条上游 multiplex 连接。OI 没有被声明成 WebSocket 能力，避免错误地走 WS fallback。

`MarketDataService` 分开维护逻辑租约和物理 feed：

- 同一 consumer 重复订阅同一 key 是幂等操作；
- 多 consumer 或多个逻辑投影共享物理 feed；
- 最后一个依赖释放后才停止物理 feed；
- 启动失败会回滚本次租约；
- Runtime 关闭时先停止高级行情 service，再关闭共享 ingestion factory。

## latest-wins 与背压

`MarketEventHub` 为每个 `MarketStreamKey` 只保存最新状态。每个订阅者也只保留每个 key 的最新 pending record：

- publish 不等待浏览器或数据库；
- 慢消费者会合并同一 key 的中间状态，不会无限积压；
- 单浏览器连接最多 64 个逻辑 stream；
- 每 100ms 最多发送 64 条更新；
- Hub 默认最多保存 4096 个不同 key；
- 容量满时只淘汰最久未更新且没有订阅者的 inactive state，活跃状态不会被驱逐；
- 旧 sequence 或旧 `(event_time_ms, received_at_ms)` 会被拒绝；
- 每个 key 在状态驻留期间带进程内单调 `revision`。

服务同时限制最多 512 条衍生品摘要物理流和 64 条 OI 轮询物理流。64 条 OI 按 5 秒周期约为每分钟 768 次当前快照请求，低于默认保守的 Futures request-weight 桶。HTTP 快照/历史共用 endpoint token bucket，并按插件规则执行并发闸门（Binance 默认每桶 1 个并发）；Funding 与 OI 历史分别使用官方的 5 分钟桶。

诊断信息位于 `GET /debug/snapshot` 返回的 `market_data` 字段，包括 logical/physical stream 数、Hub state 数、合并与丢弃计数。

## HTTP API

### 最新快照

```http
GET /api/v1/market/snapshot?exchange=binance&market_type=futures&symbol=BTCUSDT&channel=mark_price&channel=open_interest
```

不传 `channel` 时返回 P1 的五个逻辑频道。默认 `refresh_missing=true`：Hub 中没有状态，或摘要超过 10 秒、OI 超过 15 秒时，会读取 REST 快照，但不会因此持有长期上游订阅。不同物理分组独立完成，单个上游请求失败时，其余成功数据仍会返回，失败频道进入 `missing`。

```json
{
  "type": "market.snapshot",
  "as_of_ms": 1700000000100,
  "data": [
    {
      "key": {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "channel": "mark_price",
        "params": {}
      },
      "topic": "binance:futures:BTCUSDT@mark_price",
      "channel": "mark_price",
      "event_time_ms": 1700000000000,
      "received_at_ms": 1700000000010,
      "source": "http",
      "sequence": null,
      "revision": 1,
      "data": {"mark_price": 62000.1}
    }
  ],
  "missing": []
}
```

### 历史

Funding：

```http
GET /api/v1/market/history?exchange=binance&market_type=futures&symbol=BTCUSDT&channel=funding_rate&limit=500
```

OI 必须指定 Binance 支持的 period：

```http
GET /api/v1/market/history?exchange=binance&market_type=futures&symbol=BTCUSDT&channel=open_interest&period=5m&limit=500
```

可选参数为 `start_ms`、`end_ms` 和 `limit`。P1 返回的是一个上游页面，`coverage.complete` 固定为 `false`，调用方不能把它解释为本地完整历史。

## 浏览器 WebSocket

连接：

```text
ws://localhost:8000/api/v1/stream/market
```

一个浏览器连接可以订阅多个 symbol/channel：

```json
{
  "action": "subscribe",
  "request_id": "req-1",
  "streams": [
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "channel": "mark_price"
    },
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "ETHUSDT",
      "channel": "open_interest"
    }
  ]
}
```

服务端依次发送 `subscribed` 与 `snapshot`，后续状态按批次放在：

```json
{
  "type": "update",
  "protocol": "market.v1",
  "data": []
}
```

取消订阅使用相同 `streams` 结构并把 `action` 改为 `unsubscribe`。断开连接时，服务端会释放该连接持有的全部逻辑租约。稳定上游连接上的 symbol 增删使用增量 `SUBSCRIBE/UNSUBSCRIBE`，不会因为正常订阅 churn 重建所有 symbol 共用的连接。

P1 的 stream 对象不接受自定义 `params`。单条命令最多 64 个 stream，JSON 文本最多 64 KiB；这些限制在构造逻辑 key 和启动上游资源之前执行。

## P1 明确未包含

- 不修改现有 K 线协议或存储表；
- 不把 Mark/Index/Funding/OI 塞入每根 K 线；
- 不提供 Mark/Index 点值历史；
- 不在本地持久化高级行情历史；
- 不提供 Trade、Depth、Liquidation 等 append/delta 类频道；
- 不包含前端接入。
