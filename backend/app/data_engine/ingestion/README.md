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
| `INGESTION_PROXY_MODE` | `system`, `custom`, or `none` |
| `INGESTION_HTTP_PROXY` | custom proxy URL |
| `INGESTION_WS_OPEN_TIMEOUT` | WebSocket open timeout |
| `INGESTION_WS_PING_INTERVAL` / `INGESTION_WS_PING_TIMEOUT` | WS keepalive |
| `INGESTION_WS_FAIL_THRESHOLD` | consecutive failures before unhealthy |
| `INGESTION_HTTP_POLL_INTERVAL` | HTTP fallback polling interval |
| `INGESTION_DELIVERY_QUEUE_SIZE` | per-subscriber queue size |
| `INGESTION_EXCHANGE` | default exchange id |

Proxy settings are also loaded from persisted app settings in `app.core.config`, so the UI can change proxy mode at runtime.

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
