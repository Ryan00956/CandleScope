# CandleScope API 文档

[English](API.md)

> CandleScope FastAPI 后端集成参考。HTTP API 挂载在 `/api/v1`；系统健康检查挂载在应用根路径。K 线数据走当前正式 DataManager 链路：内存缓存、SQLite storage，以及异步 BackfillCoordinator 修复。

## 根地址

```text
HTTP API:      http://localhost:8000/api/v1
System API:    http://localhost:8000
WebSocket API: ws://localhost:8000/api/v1
```

所有 K 线、价格、交易对和 stream API 都支持交易所上下文。多数行情端点接受：

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `exchange` | string | `binance` | 已注册交易所 id，例如 `binance`、`okx` |
| `market_type` | string | `spot` | 市场类型，例如 `spot`、`futures`、`swap` |
| `symbol` | string | 视接口而定 | 按交易所规范化；Binance 常用 `BTCUSDT`，OKX 常用 `BTC-USDT` / `BTC-USDT-SWAP` |

时间戳约定：

- storage 和请求范围默认使用毫秒，除非明确写明为秒。
- 图表 bar payload 的 `time` 使用 Unix 秒。

## 系统端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/` | 基础应用状态 |
| `GET` | `/health` | 健康检查和 DataManager 摘要 |
| `GET` | `/debug/snapshot` | 完整 DataManager 诊断快照 |

如果 DataManager 未初始化，数据 API 会返回 `503`，WebSocket 会发送明确错误并关闭连接。

## K 线 REST API

### `GET /klines/`

获取某 symbol/interval 的最新 K 线。处理器会先调用 `DataManager.ensure_stream()`，再查询最新 bars。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1m` | 原生或自定义周期，例如 `1m`、`1h`、`45m`、`3h`、`1w`、`1M` |
| `limit` | int | `500` | 1 到 1000 |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

响应：

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "count": 2,
  "source": "cache",
  "fetched": 2,
  "cache": {},
  "data": [
    {
      "time": 1700000000,
      "open": 42000.5,
      "high": 42100.0,
      "low": 41950.0,
      "close": 42050.0,
      "volume": 12.5,
      "is_closed": false,
      "quote_volume": 525000.0,
      "trades": 320,
      "taker_buy_base": 7.5,
      "taker_buy_quote": 315000.0,
      "order_flow": {
        "taker_sell_base": 5.0,
        "volume_delta_base": 2.5,
        "taker_buy_ratio_base": 0.6,
        "cvd_contribution_base": 2.5
      }
    }
  ],
  "base_interval": null
}
```

只有仍在形成中的实时 K 线，其 `is_closed` 才为 `false`。兼容旧服务或历史存储时，
客户端可将缺少该字段的 K 线视为已确认。

增强字段按 exchange/market 的 capability fail closed；不可用或非法原始值为 `null`，无法计算 base 订单流时整个 `order_flow` 为 `null`。`cvd_contribution_base` 是连续区间 CVD 前缀和的单根贡献，形成中 K 线更新应替换当前桶，不能重复累加。完整字段、公式和自定义周期规则见 [`docs/KLINE_ORDER_FLOW_CONTRACT_zh.md`](docs/KLINE_ORDER_FLOW_CONTRACT_zh.md)。

### `GET /klines/latest`

获取非常靠近实时边缘的 bars，通常为 1 到 2 根。

参数与 `/klines/` 相同，但 `limit` 默认是 `2`。

### `GET /klines/history`

获取截止到最新已收盘 bar 的历史窗口。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1h` | 原生或自定义周期 |
| `days` | float | `7` | 0.001 到 3650；支持小数天 |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

额外响应字段：

- `start_ms`, `end_ms`
- `has_tail_gap`
- `backfill_triggered`
- `verified_contiguous`
- `missing_ranges`

### `GET /klines/range`

带连续性校验的精确范围查询。当前端需要渲染某个明确可见范围时，应优先使用这个接口。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1m` | 原生或自定义周期 |
| `start_ms` | int | 必填 | 毫秒，包含起点 |
| `end_ms` | int | 必填 | 毫秒，包含终点 |
| `repair` | string | `async` | `none`、`async` 或 `wait` |
| `wait_ms` | int | `0` | `repair=wait` 时最多等待，0 到 5000 |
| `strict` | bool | `true` | 为 true 时，可见缺口未修完会让 `renderable=false` |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

响应包含：

```json
{
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "start_ms": 1700000000000,
  "end_ms": 1700003600000,
  "effective_end_ms": 1700003580000,
  "count": 60,
  "source": "mixed",
  "fetched": 60,
  "has_tail_gap": false,
  "backfill_triggered": false,
  "verified_contiguous": true,
  "renderable": true,
  "missing_ranges": [],
  "expected_bars": 60,
  "actual_bars": 60,
  "cache": {},
  "data": [],
  "base_interval": null
}
```

### `GET /klines/history/before`

按 Unix 秒时间戳向前分页加载历史数据，用于图表左滑加载。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1h` | 原生或自定义周期 |
| `before` | int | 必填 | Unix 秒，右边界 |
| `bars` | int | `500` | 1 到 1000 |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

响应包含 `has_more`、`backfill_triggered` 和 `missing_ranges`。

### `GET /klines/resolve`

解析周期字符串，并说明是否为自定义周期。

| 参数 | 类型 | 必填 | 说明 |
|---|---:|---|---|
| `interval` | string | 是 | 例如 `7m`、`45m`、`3h`、`1M` |

响应：

```json
{
  "interval": "45m",
  "is_custom": true,
  "custom_seconds": 2700,
  "base_interval": "1m",
  "factor": 45,
  "fetch_plan": {}
}
```

### `GET /klines/storage/meta`

查询某个序列的 storage bounds/count 元数据。

参数：`symbol`、`interval`、`exchange`、`market_type`。

### `GET /klines/continuity`

只扫描已存 bars 的连续性，不触发修复。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1m` | 周期 |
| `start_ms` | int | 可选 | 毫秒，包含起点 |
| `end_ms` | int | 可选 | 毫秒，包含终点 |
| `limit` | int | `50000` | 1 到 200000 |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

响应包含 `verified_contiguous`。

### `DELETE /klines/storage`

删除某 symbol/interval 范围内的 storage K 线。`start` 和 `end` 为 Unix 秒。

| 参数 | 类型 | 必填 | 说明 |
|---|---:|---|---|
| `symbol` | string | 是 | 交易对 |
| `interval` | string | 是 | 周期 |
| `start` | int | 否 | Unix 秒 |
| `end` | int | 否 | Unix 秒 |
| `exchange` | string | 否 | 已注册交易所 |
| `market_type` | string | 否 | 市场类型 |

### `GET /klines/indicators/sma`

基于 DataManager 查询结果计算 SMA 的便利接口。完整指标计算应使用 `/indicators/compute` 或 indicator WebSocket。

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | 交易对 |
| `interval` | string | `1h` | 周期 |
| `period` | int | `20` | 2 到 500 |
| `start` | int | 可选 | Unix 秒 |
| `end` | int | 可选 | Unix 秒 |
| `exchange` | string | `binance` | 已注册交易所 |
| `market_type` | string | `spot` | 市场类型 |

## 高级行情 API（P1）

高级行情与 K 线主链独立，当前支持 Binance USD-M Futures 的 `mark_price`、`index_price`、`funding_rate`、`open_interest` 和派生 `basis`。

### `GET /market/snapshot`

读取一个 symbol 的最新状态。不传 `channel` 时返回全部五个 P1 频道；`channel` 可以重复，也可以用逗号分隔。`refresh_missing=true`（默认）会通过 REST 补读 Hub 中缺失的快照，但不会持有长期订阅。

```http
GET /api/v1/market/snapshot?exchange=binance&market_type=futures&symbol=BTCUSDT&channel=mark_price&channel=open_interest
```

响应包含 `data` 和明确的 `missing` key 列表。每条数据带 `event_time_ms`、`received_at_ms`、`source`，以及该 key 在进程内 Hub 驻留期间单调递增的 `revision`。

### `GET /market/history`

读取一个上游历史页面。P1 只开放 `funding_rate` 与 `open_interest`；OI 必须传 `period`（`5m`、`15m`、`30m`、`1h`、`2h`、`4h`、`6h`、`12h`、`1d`）。可选 `start_ms`、`end_ms`，`limit` 为 1 到 1000。

```http
GET /api/v1/market/history?exchange=binance&market_type=futures&symbol=BTCUSDT&channel=open_interest&period=5m&limit=500
```

`coverage.complete` 在 P1 固定为 `false`，表示结果是 Binance REST 页面，不是本地完整历史。

### `WS /stream/market`

一个浏览器 WebSocket 可以 multiplex 多个 symbol/channel。连接后发送：

```json
{
  "action": "subscribe",
  "request_id": "req-1",
  "streams": [
    {"exchange":"binance","market_type":"futures","symbol":"BTCUSDT","channel":"mark_price"},
    {"exchange":"binance","market_type":"futures","symbol":"ETHUSDT","channel":"open_interest"}
  ]
}
```

服务端依次返回 `subscribed`、`snapshot`，之后发送 `protocol=market.v1` 的批量 `update`。每个连接最多 64 个逻辑 stream。取消订阅复用相同 `streams` 并将 action 改成 `unsubscribe`；断连会自动释放全部租约。

完整架构、物理流复用和背压语义见 [`docs/ADVANCED_MARKET_DATA_P1_BACKEND_zh.md`](docs/ADVANCED_MARKET_DATA_P1_BACKEND_zh.md)。

## 完整订单簿 API（P4）

P4 为 Binance USD-M Futures 提供独立的本地 L2 重建链。它先订阅 diff-depth WebSocket，再以 REST `limit=1000` seed 对齐，并严格检查 `U/u/pu`。gap、重连、队列溢出或 crossed book 会立即令状态 stale，旧盘口不会继续作为 live 返回。原始 depth 不落库，也没有历史查询。

### `GET /full-order-book/snapshot`

```http
GET /api/v1/full-order-book/snapshot?symbol=BTCUSDT&update_interval_ms=250&limit=100&wait_ms=5000
```

`update_interval_ms` 支持 `100`、`250`、`500`；`limit` 为 `1..1000`，只裁剪输出，不改变后台 1000 档 seed。接口仅在 book 为 live 时返回；有界等待超时返回 `504`。

### `WS /stream/full-order-book`

```json
{
  "action": "subscribe",
  "streams": [{
    "exchange": "binance",
    "market_type": "futures",
    "symbol": "BTCUSDT",
    "channel": "full_depth",
    "params": {
      "mode": "full",
      "snapshot_limit": 1000,
      "update_interval_ms": 100,
      "output_limit": 200
    }
  }]
}
```

live 数据帧类型为 `full_order_book.snapshot`；断链/重同步帧类型为 `full_order_book.status`，并带 `state=stale`、`backend_sequence_continuity=false` 和空 `bids/asks`。完整状态机、能力边界和配置见 [`docs/FULL_ORDER_BOOK_P4_BACKEND_zh.md`](docs/FULL_ORDER_BOOK_P4_BACKEND_zh.md)。

## WebSocket API

### `WS /stream/klines`

单周期 K 线流。

URL：

```text
ws://localhost:8000/api/v1/stream/klines?symbol=BTCUSDT&interval=1m&exchange=binance&market_type=spot
```

服务端先发送订阅确认：

```json
{
  "type": "subscribed",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "market_type": "spot"
}
```

K 线更新：

```json
{
  "type": "kline",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "market_type": "spot",
  "data": {
    "time": 1700000000,
    "open": 42000.5,
    "high": 42100.0,
    "low": 41950.0,
    "close": 42050.0,
    "volume": 12.5,
    "is_closed": false
  }
}
```

客户端可发送文本 `ping`；服务端返回 `pong`。

### `WS /stream/klines_multi`

同一个 symbol、多周期复用 K 线流。

URL：

```text
ws://localhost:8000/api/v1/stream/klines_multi?symbol=BTCUSDT&exchange=binance&market_type=spot
```

初始消息：

```json
{
  "type": "connected",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "market_type": "spot"
}
```

客户端命令：

```json
{ "action": "subscribe", "intervals": ["1m", "5m", "1h"] }
```

```json
{ "action": "unsubscribe", "intervals": ["5m"] }
```

```json
"ping"
```

服务端消息类型：

- `subscribed`
- `unsubscribed`
- `warning`：跳过非法 interval
- `error`：非法 JSON/action
- `kline`
- `backfill_completed`

backfill 完成消息：

```json
{
  "type": "backfill_completed",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "market_type": "spot",
  "detail": {
    "range_start_ms": 1700000000000,
    "range_end_ms": 1700003600000
  }
}
```

### `WS /stream/prices`

来自 DataManager price cache 的实时价格流。

连接后：

```json
{ "type": "connected" }
```

随后发送当前快照：

```json
{
  "type": "prices",
  "data": [
    {
      "exchange": "binance",
      "market_type": "spot",
      "symbol": "BTCUSDT",
      "price": 42050.0,
      "daily_open": 41800.0,
      "timestamp_ms": 1700000000000
    }
  ]
}
```

后续 `PRICE_UPDATED` 事件会发送相同 `prices` 结构，但 `data` 只包含变化项。客户端文本 `ping` 返回 `pong`。

### `WS /stream/indicators`

实时指标流。一个 WebSocket 连接内支持内置指标和保存/临时 Pyne 脚本。

订阅内置指标：

```json
{
  "action": "subscribe",
  "clientId": "ma20",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "exchange": "binance",
  "market_type": "spot",
  "name": "MA",
  "params": { "period": 20 },
  "historyLimit": 500
}
```

订阅 Pyne 脚本：

```json
{
  "action": "subscribe",
  "clientId": "custom1",
  "kind": "script",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "script": "plot(close, title='Close')",
  "securityMode": "safe",
  "historyLimit": 500
}
```

取消订阅：

```json
{ "action": "unsubscribe", "clientId": "ma20" }
```

服务端消息带 sequence number，常见类型：

- `indicator.snapshot`
- `indicator.preview`
- `indicator.update`
- `indicator.error`
- `heartbeat`

## 指标 REST API

### Registry 和 Presets

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/indicators/registry` | 列出已注册内置指标 specs |
| `GET` | `/indicators/registry/{name}` | 获取单个内置指标 spec |
| `GET` | `/indicators/presets` | 前端兼容 preset 列表 |
| `GET` | `/indicators/presets/{preset_id}` | preset 详情和参考脚本 |

当前内置指标包括 `MA`、`EMA`、`MACD`、`RSI`、`BOLL`、`ATR` 和 `VOL`。

### 自定义指标

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/indicators/custom` | 列出保存的自定义指标 |
| `POST` | `/indicators/custom` | 创建或更新自定义指标 |
| `DELETE` | `/indicators/custom/{indicator_id}` | 删除自定义指标 |

自定义指标 payload：

```json
{
  "schemaVersion": 1,
  "id": "my-script",
  "kind": "script",
  "name": "My Script",
  "description": "",
  "script": "plot(close)",
  "params": {},
  "paramSchema": [],
  "renderHints": {},
  "securityMode": "safe"
}
```

### `GET /indicators/pyne/security`

返回当前 Pyne security policy：mode、allowed imports、timeout、bar/output limits、executor mode、cache limit。

### `GET /indicators/diagnostics`

返回 registry、运行中 engine、custom store、Pyne security/executor/cache 和 indicator WebSocket 配置诊断。

### `POST /indicators/compute`

一次性指标计算。

请求体：

```json
{
  "mode": "script",
  "name": "MA",
  "params": { "period": 20 },
  "exchange": "binance",
  "market_type": "spot",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "ohlcv": [
    { "time": 1700000000, "open": 42000, "high": 42100, "low": 41900, "close": 42050, "volume": 12.5 }
  ],
  "script": "plot(close, title='Close')",
  "securityMode": "safe"
}
```

模式：

- 内置模式：`mode="builtin"` 并提供 `name`，或使用 `# __ENGINE__:MA` 这类 preset marker。
- 脚本模式：`mode="script"` 并提供 `script`；通过 Pyne 运行。

Pyne 默认使用 process executor，并受 `PYNE_*` 配置控制。safe mode 禁止 imports；research mode 只允许配置的 imports；unsafe mode 仅适合本地可信脚本。

响应保留兼容旧前端的 `lines`，同时包含标准化输出字段，例如 `series`、`annotations`、`fills`、`paneLayout`；失败时返回结构化 `errorDetail`。

## 订阅和价格

### REST

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/subscriptions/` | 列出所有订阅 |
| `GET` | `/subscriptions/prices` | 当前价格快照 |
| `POST` | `/subscriptions/sync` | 同步 watchlist；新增 symbol 自动成为 `price` tier |
| `GET` | `/subscriptions/{symbol}` | 获取订阅等级 |
| `PUT` | `/subscriptions/{symbol}` | 设置订阅等级 |
| `DELETE` | `/subscriptions/{symbol}` | 移除订阅 |

tier 值：

- `full`：价格流 + 请求的 K 线周期流
- `price`：仅价格流
- `none`：不保活 watchlist 拥有的价格或 K 线实时任务

设置等级请求体：

```json
{ "tier": "price" }
```

`full` 请求应带上前端希望后台保活的完整周期集合。前端从交易所插件的
native intervals 加上用户保存的 custom intervals 生成这个集合。
`consumer_id` 用于标识前端 lease owner，让重复的自选或主图订阅能够共享
同一个后端 upstream stream。

```json
{
  "tier": "full",
  "intervals": ["1m", "5m", "1h", "45m"],
  "consumer_id": "watchlist:client-instance:binance:spot:ETHUSDT"
}
```

`GET /subscriptions/` 和 `GET /subscriptions/{symbol}` 会返回已持久化 full
订阅的 `intervals`。旧版本缺少周期数据的 full 订阅在恢复时降级使用 `1m`。

同步请求体：

```json
{ "symbols": ["BTCUSDT", "ETHUSDT"] }
```

## Settings 和维护

### Proxy

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/settings/proxy` | 当前 proxy 配置和 effective proxy |
| `PUT` | `/settings/proxy` | 持久化并应用 proxy 设置 |
| `POST` | `/settings/proxy/test` | 测试 Binance spot、Binance futures 和 OKX 连通性 |

proxy modes：

- `system`：环境变量或 OS proxy
- `custom`：使用 `custom_proxy`
- `none`：直连

请求体：

```json
{
  "mode": "custom",
  "custom_proxy": "http://127.0.0.1:7890"
}
```

`PUT /settings/proxy` 会持久化设置，并在 runtime 可用时重启 runtime-owned transports。

### Storage 和 Cache 维护

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/settings/storage/repair` | 从权威 base data 重建自定义周期 storage |
| `POST` | `/settings/storage/gap-scan` | 扫描已存标准周期并提交修复 |
| `GET` | `/settings/storage/health` | Gap ledger 和 BackfillCoordinator 健康信息 |
| `POST` | `/settings/cache-limits` | 更新 retention limits |

维护接口可选 body：

```json
{ "symbols": ["BTCUSDT", "ETHUSDT"] }
```

`storage/repair` 和 `storage/gap-scan` 也接受 query 参数 `exchange` 和 `market_type`。

cache limits 请求体：

```json
{
  "db_limits": { "minutes": 10000, "hours": 10000, "daily": 5000 },
  "ephemeral_bars": 5000
}
```

## Exchanges 和 Symbols

### Exchanges

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/exchanges/` | 列出已注册交易所能力 |
| `GET` | `/exchanges/{exchange}/capabilities` | 单个交易所能力 |

### Symbols

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/symbols/exchange-info` | 带过滤的缓存交易对元数据 |
| `POST` | `/symbols/exchange-info/refresh` | 通过 exchange registry 刷新元数据 |

`GET /symbols/exchange-info` query 参数：

| 参数 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `search` | string | 空 | 按 symbol/base/quote 过滤 |
| `quote_asset` | string | 空 | 例如 `USDT` |
| `market_type` | string | 空 | 空表示全部 |
| `exchange` | string | 空 | 空表示全部已注册交易所 |

## 错误说明

- 未知 exchange 在行情路由通常返回 `400`，在 `/exchanges/{exchange}/capabilities` 返回 `404`。
- 非法 interval 返回 `400`。
- DataManager 缺失返回 `503`。
- WebSocket 在后端未就绪或 interval 非法时会发送错误 payload 并关闭连接。
