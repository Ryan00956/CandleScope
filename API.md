# CandleScope API Reference

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](API_zh.md)

This document provides a comprehensive integration guide for the CandleScope HTTP REST and WebSocket APIs. All data retrieval endpoints are powered by the unified `DataManager` utilizing the three-tier caching system (Memory -> SQLite -> External Backfill).

---

## Base URL

```text
http://localhost:8000/api/v1
```

---

## 1. REST API Endpoints

### 1.1 Get K-lines (Default)
Fetch K-line bars for a specific symbol and interval. This is the standard entry point, returning the latest N bars.

- **URL:** `/klines`
- **Method:** `GET`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| No       | `BTCUSDT` | Trading pair symbol |
| `interval`| string| No       | `1m`      | Standard (e.g., `1m`, `1h`) or Custom (e.g., `45m`, `3h`) |
| `limit`   | int  | No       | `500`     | Number of data points to return (Max 1000) |

**Success Response:**
```json
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "limit": 500,
  "count": 500,
  "source": "cache",
  "has_more": true,
  "fetched": 0,
  "cache": { "elapsed_ms": 1.2 },
  "data": [
    {
      "time": 1700000000,
      "open": 42000.5,
      "high": 42100.0,
      "low": 41950.0,
      "close": 42050.0,
      "volume": 12.5
    }
  ],
  "base_interval": null
}
```
*Note: The `source` field determines where the data came from (`cache`, `storage`, `mixed`, `empty`).*

---

### 1.2 Get Latest K-lines
Fetch very recent K-line bars, typically used during initial load to instantly paint the leading edge of a chart.

- **URL:** `/klines/latest`
- **Method:** `GET`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| No       | `BTCUSDT` | Trading pair symbol |
| `interval`| string| No       | `1m`      | Time interval |
| `limit`   | int  | No       | `2`       | Number of recent rows to return |

---

### 1.3 Get Historical K-lines
Fetch historical K-line bars spanning a certain number of days ending at the current time. The system will automatically calculate the optimal limit and trigger a background backfill if data is missing.

- **URL:** `/klines/history`
- **Method:** `GET`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| No       | `BTCUSDT` | Trading pair |
| `interval`| string| No       | `1h`      | Time interval |
| `days`    | int  | No       | `7`       | Lookback period in days (1-3650) |

---

### 1.4 Get Paginated K-lines Before Timestamp
Crucial for seamless scrolling backwards in time (lazy load). Fetches data strictly prior to the given timestamp.

- **URL:** `/klines/history/before`
- **Method:** `GET`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| No       | `BTCUSDT` | Trading pair |
| `interval`| string| No       | `1h`      | Time interval |
| `before`  | int  | **Yes**  | None    | Unix timestamp (seconds) specifying the right bound |
| `bars`    | int  | No       | `500`   | Number of bars to return |

**Success Response:**
Contains `"has_more": true/false`, indicating whether the frontend should allow further left-scrolling. If the backfill engine is triggered, `has_more` intentionally stays true to prevent infinite scrolling from breaking.

---

### 1.5 Query Storage Metadata
Diagnostics endpoint to inspect what is currently persisted inside the local SQLite database for a specific pair/interval.

- **URL:** `/klines/storage/meta`
- **Method:** `GET`

**Success Response:**
```json
{
  "symbol": "BTCUSDT",
  "interval": "1h",
  "cache_count": 500,
  "storage_count": 120500,
  "storage_earliest": 1650000000,
  "storage_latest": 1700000000,
  "is_custom": false
}
```

---

## 2. WebSocket Real-Time Stream API

There are two primary ways to subscribe to live data streams via WebSockets. Both endpoints push normalized K-line data directly from the DataManager's internal `DataEventBus`.

### 2.1 Single-Interval Stream

Connects and subscribes to only one interval right away.

- **URL:** `ws://localhost:8000/api/v1/stream`
- **Query Params:** `?symbol=BTCUSDT&interval=1m`

---

### 2.2 Multi-Interval Multiplexed Stream (Recommended)

Allows the client to connect via a single WebSocket and dynamically subscribe/unsubscribe to multiple intervals simultaneously.

- **URL:** `ws://localhost:8000/api/v1/stream/multi`
- **Query Params:** `?symbol=BTCUSDT`

**Client to Server Commands (JSON):**

*Subscribe to intervals:*
```json
{
  "action": "subscribe",
  "intervals": ["1m", "5m", "1h"]
}
```

*Unsubscribe from intervals:*
```json
{
  "action": "unsubscribe",
  "intervals": ["5m"]
}
```

*Ping (Keep-Alive):*
```json
"ping"
// Server will respond with: "pong"
```

---

### 2.3 WebSocket Message Formats (Server -> Client)

All payloads received from the server are JSON objects carrying a specific `type`.

**1. K-line Update (`type: "kline"`)**
Fired frequently (e.g. 250ms throttled) as a bar updates, and once when it natively closes.
```json
{
  "type": "kline",
  "interval": "1m",
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

**2. Backfill Notification (`type: "backfill_completed"`)**
Broadcasted to connected WebSocket clients whenever the background Backfill Engine finishes filling a historical data gap. Tell your frontend to trigger a `history/before` or `history` HTTP fetch to paint the gap.
```json
{
  "type": "backfill_completed",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "status": "success"
}
```

**3. Stream Status (`type: "stream_status"`)**
Indicates the health of the connection to the exchange (e.g., Binance). Used to show connecting/live indicators.
```json
{
  "type": "stream_status",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "status": "live"
}
```
*(Possible statuses: `starting`, `live`, `reconnecting`, `failed`, `stopped`)*
