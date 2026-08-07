# CandleScope CCXT connection provider

This package is an opt-in compatibility layer around the exact CCXT version
pinned in `backend/requirements.txt`. The production registry exposes it behind
`INGESTION_CCXT_STREAM_ENABLED`; the flag is off by default.

The ownership boundary is:

```text
CCXT Pro watch_* + reconnect-capable sockets
                ↓ complete decoded exchange payload
CandleScope Normalize → Continuity → Recovery → Delivery
                                      ↓
                     native REST + shared quota manager
```

The extension owns only the seams that CCXT's unified API does not expose:

- a reusable `handle_message` MRO hook for future CCXT exchange profiles;
- pooled CCXT instances instead of one exchange client per subscription;
- declarative channel/symbol routing profiles;
- raw Binance USD-M kline, aggregate-trade, and depth payload hooks;
- websocket lifecycle observations;
- admission and response accounting through CandleScope's shared IP budget;
- deterministic REST cleanup and the Windows threaded-DNS workaround.

CandleScope continues to own normalization, continuity, bounded Kline/aggTrade
gap repair, stale-state publication, and strict full-order-book reconstruction.
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

The first enabled profile is deliberately narrow:

- exchange/market: Binance USD-M futures;
- streams: Kline, aggregate trade, full depth;
- Kline routing includes the raw interval so parallel intervals cannot mix;
- conflicting full-depth update speeds for one symbol fail closed because the
  raw Binance payload does not identify the requested speed;
- spot and all other exchanges remain on their existing transports.

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
