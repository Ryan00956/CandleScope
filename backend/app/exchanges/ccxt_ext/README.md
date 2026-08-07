# CandleScope CCXT connection provider

This package provides two compatibility lanes around the exact CCXT version
pinned in `backend/requirements.txt`:

- every pinned CCXT exchange ID is registered from a network-free capability
  catalog and, when CCXT Pro advertises the method, uses unified `watch_*`
  results by default (`INGESTION_CCXT_UNIFIED_STREAM_ENABLED=true`);
- dedicated raw profiles remain available for channels whose correctness
  requires exchange sequence/checksum fields. They are controlled separately
  by `INGESTION_CCXT_STREAM_ENABLED`, which remains off by default.

The ownership boundary is:

```text
CCXT Pro unified watch_* result ─→ generic projection ─┐
raw-profile decoded exchange payload ─────────────────┤
                                                      ↓
                   CandleScope Normalize → Continuity → Delivery
                                                      ↑
                         CCXT REST history + shared quota admission
```

The generic lane owns the integration seams CandleScope must validate:

- pinned-version exchange and capability enumeration;
- exact market-family and unified-symbol routing;
- K-line closure transitions and Trade cache deduplication;
- bounded CCXT-managed order-book snapshots with explicit local revisions;
- pooled reconnecting Pro sessions, full CCXT websocket-cache rebuild on connection
  generation changes, and deterministic resource cleanup;
- lazy, on-demand symbol discovery so startup never contacts every exchange.

The strict lane additionally owns the seams that CCXT's unified API does not
expose:

- a reusable `handle_message` MRO hook for future CCXT exchange profiles;
- pooled CCXT instances instead of one exchange client per subscription;
- declarative channel/symbol routing profiles;
- raw Binance USD-M kline, aggregate-trade, and depth payload hooks;
- websocket lifecycle observations;
- admission and response accounting through CandleScope's shared IP budget;
- deterministic REST cleanup and the Windows threaded-DNS workaround.

CandleScope continues to own normalization contracts, continuity, bounded
Kline/aggTrade gap repair, stale-state publication, and strict
full-order-book reconstruction.
Gap repair deliberately uses the existing native REST transport and shared
quota manager; it does not call CCXT REST and therefore cannot double-reserve
the IP budget. Consumers feed raw `U/u/pu` depth events to the existing full
order-book service, which publishes stale state and rebuilds from a native
snapshot on every sequence or connection break. CCXT's projected order book is
never authoritative.

The reconstructed book is explicitly non-exhaustive because Binance REST
snapshots are finite. The engine keeps a bounded best-known local window,
reports trimmed far-side levels, and ignores only updates strictly beyond the
recorded retention boundary. It still fails closed if the retained book falls
below the trusted REST seed depth; no trimmed book is advertised as an
exhaustive exchange view.

The first strict raw profile is deliberately narrow:

- exchange/market: Binance USD-M futures;
- streams: Kline, aggregate trade, full depth;
- Kline routing includes the raw interval so parallel intervals cannot mix;
- conflicting full-depth update speeds for one symbol fail closed because the
  raw Binance payload does not identify the requested speed;
- other pinned exchange IDs use the generic capability-scoped lane and never
  claim strict `FULL_DEPTH` support.

Local opt-in example:

```powershell
$env:INGESTION_CCXT_STREAM_ENABLED = "true"
```

Optional safety bounds include `INGESTION_CCXT_RAW_QUEUE_SIZE` (default 4096),
`INGESTION_CCXT_RECOVERY_TIMEOUT_SECONDS` (10 seconds per REST attempt),
`INGESTION_CCXT_RECOVERY_RETRY_DEADLINE_SECONDS` (900 seconds total),
`INGESTION_CCXT_RECOVERY_RETRY_INITIAL_SECONDS` / `_MAX_SECONDS` (1 / 30),
`INGESTION_CCXT_RECOVERY_BUFFER_MAX_EVENTS` (50000), and
`INGESTION_CCXT_RECOVERY_MAX_EVENTS` (10000 missing events per repair). A raw
queue or recovery buffer overflow is an explicit unhealthy failure, never a
silent drop.

A transient REST failure keeps the gap pending, leaves downstream delivery in
the observable `recovering` state, and retries with exponential backoff while
live events remain in the bounded recovery buffer. Recovered REST rows are
validated as a complete contiguous range, then emitted before buffered live
events. That publication is serialized with new live delivery, and a final
monotonic high-water guard drops older reconnect replays (while preserving
same-open-time live K-line revisions). An unfilled marker is emitted only when
the total retry deadline is exhausted, the recovery buffer overflows, or the
stream shuts down.

Any CCXT version change must update `SUPPORTED_CCXT_VERSION` and pass the
extension, provider, recovery, and full-order-book contract tests plus live
shadow/parity probes before the default flag can change.

Run a non-production dual-feed comparison from `backend`:

```powershell
python scripts/ccxt_binance_shadow.py `
  --symbol BTCUSDT `
  --duration 65 `
  --output ../output/ccxt-shadow-btcusdt.json
```

The strict comparison trims the non-overlapping connection edges. K-lines are
authoritative only after both sources observe the same closed candle;
aggregate trades compare aggregate IDs and payloads; futures depth compares
final update IDs, raw payloads, and each source's independent `pu == previous
u` continuity.

Timing summaries are reported as local receive time minus Binance event time.
They include host/exchange clock offset and therefore are diagnostic rather
than a pure one-way network-latency measurement.

Run the first multi-product admission gate through one shared CCXT profile:

```powershell
python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.binance-usdm.example.json `
  --output ../output/ccxt-shadow-matrix-binance-usdm.json
```

The default matrix concurrently compares BTCUSDT, ETHUSDT, SOLUSDT, and
DOGEUSDT across K-line, aggregate-trade, and full-depth streams. Each product
has its own strict comparator and verdict. The matrix fails if any product is
not ready, any channel fails, a profile route is unmatched or ambiguous, a
watch call errors, or either transport is interrupted during the measurement
window. It also reports route-scan work and websocket/session counts so the
current linear subscriber demultiplexer remains visible as the matrix grows.

The JSON file is the durable run contract. CLI `--symbols`, `--interval`,
`--depth-update-ms`, `--duration`, and `--startup-timeout` values can override
it for a controlled probe. A shared network interruption is still an overall
failure (`runtime.observation_window=INTERRUPTED`); it is never converted into
a product PASS.

Binance Spot has a separate shadow-only profile and comparator contract:

```powershell
python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.binance-spot.example.json `
  --output ../output/ccxt-shadow-matrix-binance-spot.json
```

Spot depth is not judged with the USD-M `pu` rule. It requires valid `U/u`
ranges and fails when the next range begins after `previous_u + 1`; overlapping
ranges remain valid for snapshot/reconnect alignment. The Spot profile is not
wired into `BinancePlugin.create_stream_session`: passing its shadow gate does
not silently promote it to a production provider.

The first OKX swap gate stays within the built-in plugin's honest capability
surface (K-line and ticker only):

```powershell
python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.okx-swap.example.json `
  --output ../output/ccxt-shadow-matrix-okx-swap.json
```

Closed candles compare their full nine-field row by open time. Tickers compare
the complete row by OKX exchange timestamp. The matrix intentionally does not
claim OKX trade or order-book parity: those native channels are not exposed by
the current OKX plugin and require their own recovery/continuity contracts
before admission.

OKX Spot uses the same currently supported K-line/ticker surface but a separate
market identity and run contract:

```powershell
python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.okx-spot.example.json `
  --output ../output/ccxt-shadow-matrix-okx-spot.json
```

Run the end-to-end CandleScope kernel soak from `backend`:

```powershell
python scripts/ccxt_integrated_soak.py `
  --symbol BTCUSDT `
  --duration 14400 `
  --heartbeat 30 `
  --inject-disconnect-at 900 `
  --output ../output/ccxt-integrated-btcusdt-4h.json
```

`--inject-disconnect-at` is repeatable. It recycles the pooled CCXT websocket
clients without closing the runtime so the normal reconnect, gap recovery,
full-book fail-closed resync, and final shutdown paths are exercised. The
final report is a failure unless each injected disconnect is observed, every
output sequence is complete, the full book has no capacity failure, and all
pooled resources close cleanly.

Run the generic unified-provider acceptance or representative soak separately:

```powershell
python scripts/ccxt_unified_soak.py `
  --exchange bybit `
  --market-type swap.linear `
  --symbol BTC/USDT:USDT `
  --symbol ETH/USDT:USDT `
  --duration 14400 `
  --inject-disconnect-at 900 `
  --output ../output/ccxt-unified-bybit-linear-4h.json
```

This gate shares one CCXT runtime across both products and all four generic
channels. It fails on malformed projection, duplicate Trade IDs, regressing
K-line/depth revisions, a stream that stops updating, incomplete reconnect,
queue overflow, residual CCXT tasks, or a non-empty runtime pool after close.
Exchange timestamps that repeat or briefly move backward are recorded as a
diagnostic because some unified ticker feeds legitimately exhibit that
behavior; they are not treated as CandleScope continuity keys.
