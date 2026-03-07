# Real-time Ingestion — Market Data Ingress Pipeline

> **Exchange real-time data → Unified format → Stable event stream**

This module is the **lowest-level data intake layer** of CandleScope. It connects to exchange WebSocket/REST APIs, normalizes raw payloads into a unified `MarketEvent` format, and outputs a stable event stream that downstream services can subscribe to.

**This module does NOT generate K-line bars, compute indicators, or store data.** Those responsibilities belong to downstream layers (kline_aggregator, storage, etc.).

---

## Architecture

Six-layer pipeline, each with a single clear responsibility:

```
Exchange WS/REST
      │
      ▼
┌─────────────────┐
│  L1: Transport   │  Raw I/O — WS connect, HTTP fetch, endpoint rotation
├─────────────────┤
│  L2: Session     │  WS lifecycle — reconnect, backoff, staleness detection
├─────────────────┤
│  L3: FeedControl │  WS↔HTTP failover — automatic fallback & recovery
├─────────────────┤
│  L4: Normalize   │  Raw JSON → MarketEvent — unified format conversion
├─────────────────┤
│  L5: Continuity  │  Dedup, gap detection, auto-backfill
├─────────────────┤
│  L6: Delivery    │  Fan-out — callbacks + async iterators for consumers
└─────────────────┘
      │
      ▼
  MarketEvent stream  (consumed by kline_aggregator, storage, UI, etc.)
```

## Supported Stream Types

| StreamType    | WS Stream               | REST Endpoint         | Description            |
|---------------|------------------------|-----------------------|------------------------|
| `KLINE`       | `@kline_<interval>`    | `/api/v3/klines`      | Exchange-aggregated candles |
| `AGG_TRADE`   | `@aggTrade`            | `/api/v3/aggTrades`   | Aggregated trades      |
| `TRADE`       | `@trade`               | `/api/v3/trades`      | Raw individual trades  |
| `TICKER`      | `@ticker`              | `/api/v3/ticker/24hr` | 24h rolling ticker     |
| `MINI_TICKER` | `@miniTicker`          | `/api/v3/ticker/24hr` | Lightweight ticker     |
| `DEPTH`       | `@depth<levels>`       | `/api/v3/depth`       | Order-book depth       |

## Quick Start

```python
from backend.app.data_engine.ingestion import (
    MarketDataIngress, StreamDescriptor, StreamType
)

async def main():
    ingress = MarketDataIngress()
    await ingress.start()

    # Subscribe to BTC 1m kline stream
    desc = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    pipeline = await ingress.add_stream(desc)

    # Consume via async iterator
    async for event in pipeline.delivery.subscribe():
        print(event.to_dict())

    # Or via callback
    async def on_event(market_event):
        print(market_event.data)

    pipeline.delivery.on_market_event(on_event)

    # Subscribe to multiple streams simultaneously
    trade_desc = StreamDescriptor("BTCUSDT", StreamType.AGG_TRADE)
    trade_pipeline = await ingress.add_stream(trade_desc)

    await ingress.stop()
```

## Core Output: `MarketEvent`

Every stream type produces a `MarketEvent` with a standardized `data` dict:

```python
@dataclass
class MarketEvent:
    event_type: StreamType      # kline / aggTrade / trade / ticker / ...
    symbol: str                 # "BTCUSDT"
    exchange: str               # "binance"
    event_time_ms: int          # exchange event timestamp (ms)
    received_at_ms: int         # local receive timestamp (ms)
    source: DataSource          # websocket / http / http_backfill
    data: dict[str, Any]        # standardized payload (schema varies by event_type)
    stream_key: str             # "BTCUSDT@kline_1m"
    sequence: int | None        # for dedup/ordering
```

### Data Schemas per StreamType

**KLINE:**
```json
{
  "interval": "1m", "open_time": 1672531200000, "close_time": 1672531259999,
  "open": 16500.0, "high": 16510.0, "low": 16490.0, "close": 16505.0,
  "volume": 100.5, "quote_volume": 1658250.0, "trades": 350,
  "taker_buy_base": 60.3, "taker_buy_quote": 995000.0, "is_closed": true
}
```

**AGG_TRADE:**
```json
{
  "agg_trade_id": 123456, "price": 16500.0, "quantity": 0.5,
  "first_trade_id": 100, "last_trade_id": 105,
  "trade_time_ms": 1672531200123, "is_buyer_maker": false
}
```

**TRADE:**
```json
{
  "trade_id": 12345, "price": 16500.0, "quantity": 0.5,
  "trade_time_ms": 1672531200123, "is_buyer_maker": false,
  "buyer_order_id": 111, "seller_order_id": 222
}
```

**TICKER:**
```json
{
  "price_change": 100.0, "price_change_pct": 0.61, "last_price": 16500.0,
  "bid_price": 16499.0, "ask_price": 16501.0, "volume": 50000.0, ...
}
```

**DEPTH:**
```json
{
  "last_update_id": 123456789,
  "bids": [[16499.0, 5.0], ...],
  "asks": [[16501.0, 2.0], ...]
}
```

## Delivery Layer (L6) — Consumer Interface

The Delivery layer provides a **stable event stream** similar to a WebSocket feed:

### Callback Style
```python
# Market events only
pipeline.delivery.on_market_event(my_handler)

# Gap markers
pipeline.delivery.on_gap(my_gap_handler)

# All events (market_event + gap + status)
pipeline.delivery.on_event(my_universal_handler)
```

### Async Iterator Style
```python
async for event in pipeline.delivery.subscribe():
    if event.event_type == "market_event":
        process(event.market_event)
    elif event.event_type == "gap":
        handle_gap(event.gap)
```

## Reliability Features

- **Auto-reconnect** with exponential backoff (L2)
- **Staleness detection** — force reconnect if no data for N seconds (L2)
- **WS → HTTP fallback** when WebSocket fails repeatedly (L3)
- **WS probing** while in HTTP mode — auto-recovers to WS (L3)
- **Deduplication** by event-specific keys (L5)
- **Gap detection** with auto-backfill for kline streams (L5)
- **Endpoint rotation** across multiple exchange endpoints (L1)

## Configuration

All parameters are configurable via `IngestionConfig` or environment variables:

```python
config = IngestionConfig(
    ws_reconnect_delay_max=60.0,
    http_poll_interval=2.0,
    continuity_auto_fill_gaps=True,
    delivery_queue_size=500,
)
ingress = MarketDataIngress(config=config)
```

## File Structure

| File             | Layer | Description                               |
|------------------|-------|-------------------------------------------|
| `models.py`      | All   | Data types: MarketEvent, StreamDescriptor |
| `config.py`      | All   | IngestionConfig with env var support      |
| `metrics.py`     | All   | Per-layer metrics (counters, gauges)      |
| `transport.py`   | L1    | Raw WS/HTTP I/O, endpoint rotation       |
| `session.py`     | L2    | WS session lifecycle, reconnect          |
| `feed_control.py`| L3    | WS↔HTTP failover orchestrator            |
| `normalize.py`   | L4    | Raw → MarketEvent conversion             |
| `continuity.py`  | L5    | Dedup, gap detection, backfill           |
| `delivery.py`    | L6    | Fan-out to subscribers                   |
| `__init__.py`    | —     | Wiring, StreamPipeline, MarketDataIngress |
