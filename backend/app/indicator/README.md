# Indicator Engine

[中文](README_zh.md)

> Incremental, event-driven indicator computation for CandleScope. The module supports built-in Python indicator classes and backend-hosted Pyne scripts, and is bridged to DataManager bar events at application startup.

## Architecture

```text
DataManager DataEventBus
        │ BAR_UPDATED / BAR_CLOSED / BACKFILL_COMPLETED
        ▼
data_manager_bridge.py
        ▼
IndicatorEngine
        ├── built-in Indicator instances
        ├── instance cache / refcount
        ├── event listeners
        └── IndicatorResult / IndicatorEvent

HTTP / WS APIs
        ├── registry and presets
        ├── one-shot compute
        ├── custom indicator CRUD
        └── realtime indicator stream

Script requests → IndicatorRuntimeService → legacy / shadow / sidecar
```

## Main Files

| File | Responsibility |
|---|---|
| [base.py](base.py) | Abstract `Indicator` lifecycle contract and output helpers |
| [engine.py](engine.py) | `IndicatorEngine`: instance cache, subscriptions, partial/closed updates, event dispatch |
| [types.py](types.py) | `IndicatorKey`, metadata, output, result, and registry spec types |
| [registry.py](registry.py) | Global `IndicatorRegistry` for built-ins |
| [events.py](events.py) | `IndicatorEvent` and event types |
| [data_manager_bridge.py](data_manager_bridge.py) | Connects DataManager bar events to IndicatorEngine |
| [custom_store.py](custom_store.py) | Local JSON store for user scripts |
| [serialization.py](serialization.py) | Normalized frontend payloads for built-in and Pyne results |
| [runtime_routes.py](runtime_routes.py) | Strict per-language `legacy/shadow/sidecar` route table |
| [runtime_service.py](runtime_service.py) | Shared script execution, shadow comparison, and sidecar dispatch |
| [RUNTIME_ROUTING.md](RUNTIME_ROUTING.md) | Operator and community-plugin rollout contract |
| [errors.py](errors.py) | Structured error payload helpers |
| [indicators](indicators/) | Built-in indicator implementations |
| [pyne](pyne/) | Current legacy Pyne facade, retained until the plugin cutover gate |

## Built-In Indicators

Built-ins are auto-registered in [__init__.py](__init__.py).

| Name | File | Outputs | Pane | Notes |
|---|---|---|---|---|
| `MA` | [ma.py](indicators/ma.py) | `ma` | main overlay | rolling-sum simple moving average |
| `EMA` | [ema.py](indicators/ema.py) | `ema` | main overlay | SMA seed then recursive EMA |
| `MACD` | [macd.py](indicators/macd.py) | `dif`, `dea`, `hist` | separate | histogram output for `hist` |
| `RSI` | [rsi.py](indicators/rsi.py) | `rsi` | separate | Wilder smoothing, precision 2 |
| `BOLL` | [boll.py](indicators/boll.py) | `middle`, `upper`, `lower` | main overlay | rolling mean/std |
| `ATR` | [atr.py](indicators/atr.py) | `atr` | separate | true range plus Wilder smoothing |
| `VOL` | [vol.py](indicators/vol.py) | `volume` | volume | histogram with up/down bar colors |

Each class exposes `get_spec()` for frontend registry metadata and parameter schema generation.

## Indicator Lifecycle

Every indicator subclasses `Indicator` and implements:

```python
class MyIndicator(Indicator):
    def init(self, bars: list[BarData]) -> None:
        ...

    def update_partial(self, bar: BarData) -> None:
        ...

    def update_closed(self, bar: BarData) -> None:
        ...
```

Semantics:

- `init(bars)` initializes state from sorted historical bars.
- `update_partial(bar)` computes preview values for a forming bar and must not advance committed rolling state.
- `update_closed(bar)` commits a closed bar and advances rolling state once.
- `recompute(bars)` defaults to `reset() + init(bars)`.
- `build_result(key)` returns a standardized `IndicatorResult`.

## Identity And Caching

`IndicatorKey` uniquely identifies one indicator instance:

```python
IndicatorKey(
    symbol="BTCUSDT",
    interval="1m",
    indicator_name="MA",
    params={"period": 20, "source": "close"},
    exchange="binance",
    market_type="spot",
)
```

Rules:

- Symbol is normalized to uppercase.
- Indicator name is normalized to uppercase.
- Exchange and market type are normalized to lowercase.
- Params are frozen and hashed.
- `uid` includes exchange and market type, for example `binance:spot:BTCUSDT:1m:MA:<hash>`.
- `series_topic` matches DataManager topic semantics, such as `BTCUSDT@1m` or `okx:swap:BTC-USDT@1m`.

`IndicatorEngine` caches instances by key and reference-counts subscriptions. Multiple chart panes requesting the same key share one instance.

## Engine API

```python
from app.indicator import create_engine

engine = create_engine()

result = engine.compute(
    symbol="BTCUSDT",
    interval="1m",
    market_type="spot",
    indicator_name="MA",
    params={"period": 20},
    bars=bars,
    exchange="binance",
)

key, initial = engine.subscribe(
    symbol="BTCUSDT",
    interval="1m",
    market_type="spot",
    indicator_name="RSI",
    params={"period": 14},
    bars=bars,
)

engine.on_bar_updated("BTCUSDT", "1m", forming_bar)
engine.on_bar_closed("BTCUSDT", "1m", closed_bar)
engine.unsubscribe(key)
```

## Event Types

`IndicatorEventType` includes:

- `INSTANCE_CREATED`
- `INSTANCE_INITIALIZED`
- `INSTANCE_DESTROYED`
- `INDICATOR_UPDATED`
- `INDICATOR_PREVIEW`
- `INDICATOR_RECOMPUTED`
- `INDICATOR_ERROR`

`IndicatorEvent.to_dict()` includes identity fields, latest values or full result when present, and structured details for errors.

## DataManager Bridge

`bridge_indicator_engine(data_manager)`:

1. Creates and starts an `IndicatorEngine`.
2. Subscribes to DataManager `BAR_CLOSED` and `BAR_UPDATED` events.
3. Routes closed bars into `engine.on_bar_closed()`.
4. Routes forming updates into `engine.on_bar_updated()`.
5. On `BACKFILL_COMPLETED`, queries latest bars and calls `engine.on_bars_backfilled()` to recompute affected instances.

`app/main.py` attaches the bridged engine to `app.state.indicator_engine`.

## HTTP And WebSocket API

Router: `backend/app/api/v1/indicators.py`, mounted under `/api/v1/indicators`.

Important endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /registry` | List registered indicator specs |
| `GET /registry/{name}` | Get one built-in spec |
| `GET /runtimes` | List routed script languages and public runtime descriptors |
| `GET /presets` / `GET /presets/{id}` | Frontend preset compatibility |
| `GET /custom` | List saved custom indicators |
| `POST /custom` | Create/update a saved custom indicator |
| `DELETE /custom/{indicator_id}` | Delete a saved custom indicator |
| `GET /pyne/security` | Current Pyne security policy |
| `GET /diagnostics` | Indicator diagnostics |
| `POST /compute` | Built-in or routed script one-shot compute |

Realtime endpoint:

| Endpoint | Purpose |
|---|---|
| `WS /api/v1/stream/indicators` | Subscribe/unsubscribe multiple built-in or routed script indicators over one connection |

## Built-In Vs Script Compute

`POST /compute` supports two paths:

- Built-in engine mode: provide `name` and `params`, or a preset marker such as `# __ENGINE__:MA`.
- Script mode: provide `script`, an optional descriptor-declared `language`, and
  Pyne-only `securityMode`; execution goes through the configured runtime route.

Tests assert that script mode executes the script even if a built-in name is present, while built-in mode ignores the script body and uses the optimized engine path.

## Custom Indicator Store

`CustomIndicatorStore` stores local JSON under `DATA_DIR / "custom_indicators.json"` by default.

Payload fields:

- `schemaVersion`
- `id`
- `kind`: `script` or `custom`
- `language`: routed language ID; omitted legacy records default to `pyne`
- `name`
- `description`
- `script`
- `params`
- `paramSchema`
- `renderHints`
- `securityMode`: Pyne-only `safe`, `research`, `unsafe`, or omitted

Writes are atomic through a temporary file. Invalid IDs, missing names/scripts, invalid kinds, and invalid security modes are rejected.

## Serialization Contract

[serialization.py](serialization.py) keeps backward-compatible `lines` while also returning normalized output:

- `series`
- `annotations`
- `fills`
- `paneLayout`
- structured errors through `errorDetail`

Schema constants:

- `INDICATOR_PAYLOAD_SCHEMA_VERSION = 1`
- `INDICATOR_OUTPUT_SCHEMA_VERSION = 2`

Pyne extended outputs include markers, fills, hlines, background colors, bar colors, and signals.

## Adding A Built-In Indicator

1. Create `backend/app/indicator/indicators/my_indicator.py`.
2. Subclass `Indicator`.
3. Implement `init`, `update_partial`, `update_closed`, `get_meta`, output config, and `get_spec`.
4. Add the class to `_BUILTINS` in [__init__.py](__init__.py).
5. Add focused tests for warmup, partial update state safety, closed update, output schema, and registry spec.

Skeleton:

```python
from app.indicator.base import Indicator
from app.indicator.types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType

class MyIndicator(Indicator):
    def init(self, bars):
        for bar in bars:
            self.update_closed(bar)

    def update_partial(self, bar):
        value = self._calculate_preview(bar)
        self._set_output("value", bar.time, value)

    def update_closed(self, bar):
        value = self._calculate_and_commit(bar)
        self._set_output("value", bar.time, value)

    def get_meta(self):
        return IndicatorMeta(name="MY", pane=PaneType.MAIN, overlay=True)

    @classmethod
    def get_spec(cls):
        return IndicatorSpec(
            name="MY",
            display_name="My Indicator",
            param_schema=[IndicatorParam(key="period", type="int", default=20, min=1)],
            default_params={"period": 20},
        )
```

## Tests

```bash
cd backend
python -m pytest -q tests/test_indicator_api.py
```

Relevant broader checks:

```bash
cd backend
python -m pytest -q \
  tests/test_indicator_api.py \
  tests/test_stream_api.py \
  tests/test_data_engine_phase1_boundaries.py
```
