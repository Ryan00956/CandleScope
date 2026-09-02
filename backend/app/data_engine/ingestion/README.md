# Ingestion

[中文](README_zh.md)

> Realtime market-data ingress. This module converts exchange-specific HTTP/WS payloads into normalized `MarketEvent` and `GapMarker` objects for downstream aggregation and repair.

## Position In Data Engine

```text
Exchange WS / REST
        ▼
ingestion
        │ MarketEvent / GapMarker
        ▼
bar_aggregator / data_manager backfill trigger
```

`ingestion` is intentionally generic. It does not create final K-lines, write storage, or run historical repair. Those responsibilities belong to `bar_aggregator`, `storage`, and `backfill`.

## Six-Layer Pipeline

| Layer | Component | Responsibility |
|---|---|---|
| L1 | `TransportLayer` | HTTP and WebSocket I/O, endpoint selection, proxy usage, REST pagination helpers |
| L2 | `SessionLayer` / `SharedWsSessionAdapter` | WebSocket lifecycle, reconnect, stale detection, health state |
| L3 | `FeedControlLayer` | Switch between WS and HTTP polling when a stream becomes unhealthy |
| L4 | `NormalizeLayer` | Convert raw exchange payloads into `MarketEvent` |
| L5 | `ContinuityLayer` | Deduplicate, preserve ordering, detect gaps, emit `GapMarker` |
| L6 | `DeliveryLayer` | Fan out events to callbacks and async-iterator subscribers |

`MarketDataIngress.add_stream()` creates a `StreamPipeline` that wires L3 -> L4 -> L5 -> L6 for one `StreamDescriptor`. The L1 transport and shared WS hub registry are owned by `MarketDataIngress`.

## Public Entry Points

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

The production runtime normally uses `ExchangeIngestionFactory` instead of direct `MarketDataIngress` construction. For kline streams, that factory forwards L6 `MarketEvent` objects directly into `BarAggregator.on_market_event()` through `StreamCoordinator`.

## Key Models

| Type | File | Notes |
|---|---|---|
| `StreamDescriptor` | [models.py](models.py) | Uniquely identifies a stream by exchange, market type, symbol, stream type, and optional interval/depth |
| `StreamType` | [models.py](models.py) | `KLINE`, `AGG_TRADE`, `TRADE`, `TICKER`, `MINI_TICKER`, `DEPTH` |
| `MarketEvent` | [models.py](models.py) | Exchange-agnostic normalized event envelope; all event timestamps are milliseconds |
| `GapMarker` | [models.py](models.py) | Gap detected by continuity checks; forwarded to repair coordination |
| `RawMessage` | [models.py](models.py) | Internal L1 -> L4 payload wrapper |
| `TransportRequest` | [models.py](models.py) | REST request descriptor used by transport/fetching paths |
| `FeedMode` | [models.py](models.py) | `websocket`, `http_poll`, `idle` |
| `SessionHealth` | [models.py](models.py) | `connected`, `connecting`, `reconnecting`, `unhealthy`, `disconnected` |

## Exchange Normalization

Normalizers live under [normalizers](normalizers/):

- `binance.py` handles Binance spot/futures kline, trade, ticker, and depth payload shapes.
- `okx.py` handles OKX public/business WS payloads and OKX volume field differences.
- `base.py` defines the normalizer contract.

`NormalizeLayer` dispatches by `StreamDescriptor.exchange`, keeping exchange quirks out of downstream modules.

## Shared WebSocket Sessions

[shared_ws.py](shared_ws.py) provides a multiplex hub for exchanges/stream types that benefit from shared connections. Current tests assert that OKX kline streams use the shared hub path, while direct sessions still switch to HTTP fallback when unhealthy.

The shared adapter lets L3 use HTTP fallback without stopping the underlying shared session for other subscribers.

## Configuration

`IngestionConfig` reads constructor values first, then `INGESTION_*` environment variables, and supports runtime `update()`.

Common knobs:

| Field / Env | Default Purpose |
|---|---|
| `INGESTION_HTTP_BASE_URLS` | Binance spot HTTP endpoints |
| `INGESTION_WS_BASE_URLS` | Binance spot WS endpoints |
| `INGESTION_HTTP_BASE_URLS_FUTURES` | Binance futures HTTP endpoints |
| `INGESTION_WS_BASE_URLS_FUTURES` | Binance futures WS endpoints |
| `INGESTION_HTTP_TIMEOUT` | HTTP request timeout |
| `INGESTION_TWELVE_DATA_API_KEY` | Server-side Twelve Data API key; the provider fails closed when absent |
| `INGESTION_TWELVE_DATA_HTTP_BASE_URLS` | Twelve Data HTTP endpoints; defaults to `https://api.twelvedata.com` |
| `INGESTION_TWELVE_DATA_WS_ENABLED` | enable the shared Twelve Data Basic realtime price stream; defaults to `true` |
| `INGESTION_TWELVE_DATA_WS_MAX_SYMBOLS` | logical subscription ceiling; defaults to and is hard-capped at `8` |
| `INGESTION_TWELVE_DATA_WS_HEARTBEAT_INTERVAL` | application heartbeat seconds; defaults to `10` |
| `INGESTION_TWELVE_DATA_CONCURRENCY` | Twelve Data history/search concurrency; defaults to `1` |
| `INGESTION_TWELVE_DATA_CREDITS_PER_MINUTE` | Shared Twelve Data credit budget; defaults to `8` before the global safety factor |
| `INGESTION_PROXY_MODE` | `system`, `custom`, or `none` |
| `INGESTION_HTTP_PROXY` | custom proxy URL |
| `INGESTION_WS_OPEN_TIMEOUT` | WebSocket open timeout |
| `INGESTION_WS_CONTROL_TIMEOUT` | shared WS subscribe/unsubscribe send timeout |
| `INGESTION_WS_PING_INTERVAL` / `INGESTION_WS_PING_TIMEOUT` | WS keepalive |
| `INGESTION_WS_FAIL_THRESHOLD` | consecutive failures before unhealthy |
| `INGESTION_HTTP_POLL_INTERVAL` | HTTP fallback polling interval |
| `INGESTION_DELIVERY_QUEUE_SIZE` | per-subscriber queue size |
| `INGESTION_EXCHANGE` | default exchange id |

Proxy settings are also loaded from persisted app settings in `app.core.config`, so the UI can change proxy mode at runtime.

### Twelve Data M2

M2 adds regular-session intraday history for US-venue stocks/ETFs and a provider-sidecar realtime ticker stream shared by up to eight unique symbols. Twelve Data's WebSocket does not publish OHLC, so realtime K-lines remain disabled; every connection generation obtains a shared-budget `/quote` snapshot to seed intraday fields.

Every Twelve Data bar carries the complete series identity. Stock/ETF volume means `shares`, and a row without volume is rejected. FX, index, and commodity volume is explicitly unavailable; the numeric storage placeholder is `0` and must not be interpreted as zero trading activity. See [Traditional Market Data M2](../../../../docs/TRADITIONAL_MARKET_DATA_M2_zh.md).

## Delivery Semantics

- Callback subscribers are awaited before queue delivery, preserving backpressure for ordered consumers.
- Queue overflow drops queued delivery items instead of blocking callbacks.
- Gap events are delivered to callbacks and async queues.
- Closing a subscriber unblocks full queues.

## Tests

```bash
cd backend
python -m pytest -q \
  tests/test_ingestion_delivery.py \
  tests/test_ingestion_normalizers.py \
  tests/test_ingestion_session_types.py \
  tests/test_transport_ws_urls.py
```
