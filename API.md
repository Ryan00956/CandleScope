# CandleScope API Reference

[简体中文](API_zh.md)

> Integration reference for the CandleScope FastAPI backend. HTTP APIs are mounted under `/api/v1`; system health endpoints are mounted at the application root. K-line data is served through the current DataManager path: cache, SQLite storage, and asynchronous BackfillCoordinator repair.

## Base URLs

```text
HTTP API:      http://localhost:8000/api/v1
System API:    http://localhost:8000
WebSocket API: ws://localhost:8000/api/v1
```

All K-line, price, symbol, and stream APIs are exchange-aware. Most market-data endpoints accept:

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `exchange` | string | `binance` | Registered exchange id, e.g. `binance`, `okx` |
| `market_type` | string | `spot` | Market type, e.g. `spot`, `futures`, `swap` |
| `symbol` | string | varies | Normalized per exchange; Binance usually `BTCUSDT`, OKX usually `BTC-USDT` / `BTC-USDT-SWAP` |

Timestamps:

- Storage and request ranges use milliseconds unless explicitly documented as seconds.
- Chart bar payloads use `time` in Unix seconds.

## System Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Basic app status |
| `GET` | `/health` | Health and DataManager summary |
| `GET` | `/debug/snapshot` | Full DataManager diagnostic snapshot |

If DataManager is not initialized, data APIs return `503` or close WebSocket connections with an explicit error.

## K-line REST API

### `GET /klines/`

Latest K-line bars for a symbol and interval. The handler calls `DataManager.ensure_stream()` before querying latest bars.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1m` | Native or custom interval, e.g. `1m`, `1h`, `45m`, `3h`, `1w`, `1M` |
| `limit` | int | `500` | 1 to 1000 |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

Response:

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
      "is_closed": false
    }
  ],
  "base_interval": null
}
```

`is_closed` is `false` only for a still-forming live bar. Clients may treat the
missing field from older servers or stored historical rows as confirmed.

### `GET /klines/latest`

Very recent bars, usually 1-2 rows for the live chart edge.

Parameters are the same as `/klines/`, except `limit` defaults to `2`.

### `GET /klines/history`

Historical bars for a lookback window ending at the latest closed bar.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1h` | Native or custom interval |
| `days` | float | `7` | 0.001 to 3650; fractional days are supported |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

Additional response fields:

- `start_ms`, `end_ms`
- `has_tail_gap`
- `backfill_triggered`
- `verified_contiguous`
- `missing_ranges`

### `GET /klines/range`

Exact range query with continuity verification. This is the safest API when the frontend needs to render a specific visible range.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1m` | Native or custom interval |
| `start_ms` | int | required | Inclusive range start in milliseconds |
| `end_ms` | int | required | Inclusive range end in milliseconds |
| `repair` | string | `async` | `none`, `async`, or `wait` |
| `wait_ms` | int | `0` | Max wait when `repair=wait`, 0 to 5000 |
| `strict` | bool | `true` | If true, `renderable` is false when visible gaps remain |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

Response includes:

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

Paginated history before a Unix timestamp in seconds. Used for left-scroll loading.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1h` | Native or custom interval |
| `before` | int | required | Right boundary in Unix seconds |
| `bars` | int | `500` | 1 to 1000 |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

Response includes `has_more`, `backfill_triggered`, and `missing_ranges`.

### `GET /klines/resolve`

Resolve an interval string and explain whether it is custom.

| Parameter | Type | Required | Notes |
|---|---:|---|---|
| `interval` | string | yes | e.g. `7m`, `45m`, `3h`, `1M` |

Response:

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

Storage bounds/count metadata for one series.

Parameters: `symbol`, `interval`, `exchange`, `market_type`.

### `GET /klines/continuity`

Scan stored bars for continuity gaps without triggering repair.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1m` | Interval |
| `start_ms` | int | optional | Inclusive scan start |
| `end_ms` | int | optional | Inclusive scan end |
| `limit` | int | `50000` | 1 to 200000 |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

Response includes `verified_contiguous`.

### `DELETE /klines/storage`

Delete stored K-lines for a symbol/interval range. `start` and `end` are Unix seconds.

| Parameter | Type | Required | Notes |
|---|---:|---|---|
| `symbol` | string | yes | Trading symbol |
| `interval` | string | yes | Interval |
| `start` | int | no | Unix seconds |
| `end` | int | no | Unix seconds |
| `exchange` | string | no | Registered exchange |
| `market_type` | string | no | Market type |

### `GET /klines/indicators/sma`

Convenience SMA endpoint built from DataManager query results. Full indicator work should use `/indicators/compute` or the indicator WebSocket.

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `symbol` | string | `BTCUSDT` | Trading symbol |
| `interval` | string | `1h` | Interval |
| `period` | int | `20` | 2 to 500 |
| `start` | int | optional | Unix seconds |
| `end` | int | optional | Unix seconds |
| `exchange` | string | `binance` | Registered exchange |
| `market_type` | string | `spot` | Market type |

## WebSocket API

### `WS /stream/klines`

Single-interval K-line stream.

URL:

```text
ws://localhost:8000/api/v1/stream/klines?symbol=BTCUSDT&interval=1m&exchange=binance&market_type=spot
```

Server sends a subscription acknowledgement:

```json
{
  "type": "subscribed",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "market_type": "spot"
}
```

K-line update:

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

Client can send text `ping`; server responds `pong`.

### `WS /stream/klines_multi`

Multiplexed K-line stream for one symbol and many intervals.

URL:

```text
ws://localhost:8000/api/v1/stream/klines_multi?symbol=BTCUSDT&exchange=binance&market_type=spot
```

Initial message:

```json
{
  "type": "connected",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "market_type": "spot"
}
```

Client commands:

```json
{ "action": "subscribe", "intervals": ["1m", "5m", "1h"] }
```

```json
{ "action": "unsubscribe", "intervals": ["5m"] }
```

```json
"ping"
```

Server messages:

- `subscribed`
- `unsubscribed`
- `warning` for invalid intervals skipped
- `error` for invalid JSON/action
- `kline`
- `backfill_completed`

Backfill completion message:

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

Realtime price stream from DataManager price cache.

Connection flow:

```json
{ "type": "connected" }
```

Then a snapshot:

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

Subsequent `PRICE_UPDATED` events send the same `prices` shape with only changed rows. Client text `ping` receives `pong`.

### `WS /stream/indicators`

Realtime indicator stream. It supports built-in indicators and saved/ad-hoc Pyne scripts over one WebSocket.

Subscribe to a built-in indicator:

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

Subscribe to a Pyne script:

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

Unsubscribe:

```json
{ "action": "unsubscribe", "clientId": "ma20" }
```

Server messages include sequence numbers and types such as:

- `indicator.snapshot`
- `indicator.preview`
- `indicator.update`
- `indicator.error`
- `heartbeat`

## Indicator REST API

### Registry And Presets

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/indicators/registry` | List registered built-in specs |
| `GET` | `/indicators/registry/{name}` | Get one built-in spec |
| `GET` | `/indicators/presets` | Frontend-compatible preset list |
| `GET` | `/indicators/presets/{preset_id}` | Preset details and reference script |

Built-ins currently include `MA`, `EMA`, `MACD`, `RSI`, `BOLL`, `ATR`, and `VOL`.

### Custom Indicators

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/indicators/custom` | List saved custom indicators |
| `POST` | `/indicators/custom` | Create or update a custom indicator |
| `DELETE` | `/indicators/custom/{indicator_id}` | Delete a custom indicator |

Custom indicator payload:

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

Returns current Pyne security policy: mode, allowed imports, timeout, bar/output limits, executor mode, and cache limit.

### `GET /indicators/diagnostics`

Returns registry, running engine, custom store, Pyne security/executor/cache, and indicator WebSocket tuning diagnostics.

### `POST /indicators/compute`

One-shot indicator computation.

Request body:

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

Modes:

- Built-in mode: `mode="builtin"` with `name`, or a preset script marker such as `# __ENGINE__:MA`.
- Script mode: `mode="script"` with `script`; runs through Pyne.

Pyne execution uses process mode by default and is governed by `PYNE_*` configuration. Safe mode blocks imports; research mode allows only configured imports; unsafe mode is for trusted local scripts.

Response includes backward-compatible `lines` plus normalized output fields such as `series`, `annotations`, `fills`, `paneLayout`, and structured `errorDetail` on failure.

## Subscriptions And Prices

### REST

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/subscriptions/` | List all subscriptions |
| `GET` | `/subscriptions/prices` | Current price snapshot |
| `POST` | `/subscriptions/sync` | Sync watchlist symbols; new symbols become `price` tier |
| `GET` | `/subscriptions/{symbol}` | Get subscription tier |
| `PUT` | `/subscriptions/{symbol}` | Set tier |
| `DELETE` | `/subscriptions/{symbol}` | Remove subscription |

Tier values:

- `full`: price stream plus the requested K-line intervals
- `price`: price stream only
- `none`: no watchlist-owned price or K-line realtime work

Set tier body:

```json
{ "tier": "price" }
```

For `full`, clients should send the complete interval set they want kept warm.
The frontend builds this from the exchange plugin's native intervals plus the
user's saved custom intervals. `consumer_id` identifies the frontend owner of
the lease so repeated frontend or chart subscriptions can share the same
backend upstream stream.

```json
{
  "tier": "full",
  "intervals": ["1m", "5m", "1h", "45m"],
  "consumer_id": "watchlist:client-instance:binance:spot:ETHUSDT"
}
```

`GET /subscriptions/` and `GET /subscriptions/{symbol}` include `intervals` for
persisted full subscriptions. Older full subscriptions without interval data
fall back to `1m` when restored.

Sync body:

```json
{ "symbols": ["BTCUSDT", "ETHUSDT"] }
```

## Settings And Maintenance

### Proxy

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/settings/proxy` | Current proxy config and effective proxy |
| `PUT` | `/settings/proxy` | Persist and apply proxy settings |
| `POST` | `/settings/proxy/test` | Test connectivity to Binance spot, Binance futures, and OKX |

Proxy modes:

- `system`: env/OS proxy
- `custom`: use `custom_proxy`
- `none`: direct connection

Body:

```json
{
  "mode": "custom",
  "custom_proxy": "http://127.0.0.1:7890"
}
```

`PUT /settings/proxy` persists settings and restarts runtime-owned transports when available.

### Storage And Cache Maintenance

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/settings/storage/repair` | Rebuild custom interval storage from authoritative base data |
| `POST` | `/settings/storage/gap-scan` | Scan stored standard intervals and submit repair |
| `GET` | `/settings/storage/health` | Gap ledger and BackfillCoordinator health |
| `POST` | `/settings/cache-limits` | Update retention limits |

Optional maintenance body:

```json
{ "symbols": ["BTCUSDT", "ETHUSDT"] }
```

`storage/repair` and `storage/gap-scan` also accept query parameters `exchange` and `market_type`.

Cache limits body:

```json
{
  "db_limits": { "minutes": 10000, "hours": 10000, "daily": 5000 },
  "ephemeral_bars": 5000
}
```

## Exchanges And Symbols

### Exchanges

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/exchanges/` | List registered exchange capabilities |
| `GET` | `/exchanges/{exchange}/capabilities` | Capabilities for one exchange |

### Symbols

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/symbols/exchange-info` | Cached symbol metadata with filters |
| `POST` | `/symbols/exchange-info/refresh` | Refresh metadata through exchange registry |

`GET /symbols/exchange-info` query parameters:

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `search` | string | empty | Filter by symbol/base/quote |
| `quote_asset` | string | empty | e.g. `USDT` |
| `market_type` | string | empty | Empty means all |
| `exchange` | string | empty | Empty means all registered exchanges |

## Error Notes

- Unknown exchange normally returns `400` for market-data routes or `404` on `/exchanges/{exchange}/capabilities`.
- Invalid intervals return `400`.
- Missing DataManager returns `503`.
- WebSocket streams send an error payload and close when the backend is not ready or the interval is invalid.
