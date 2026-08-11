# CandleScope CCXT market-data provider

The pinned CCXT package owns all public exchange network I/O in the production
registry. Binance and OKX are registered as `CcxtPrimaryPlugin`; the old venue
HTTP/WebSocket protocols are not exposed to `TransportLayer` and cannot be
used as a fallback. Every other pinned CCXT exchange ID is registered through
the generic unified provider.

`INGESTION_CCXT_UNIFIED_STREAM_ENABLED=true` is the production kill switch and
defaults to enabled. `INGESTION_CCXT_STREAM_ENABLED` remains only for legacy
dual-feed qualification scripts and is ignored by the primary registry.

```text
CCXT Pro watch_* / raw hook ──→ projector or venue normalizer ──┐
CCXT async REST ────────────────────────────────────────────────┤
                                                               ↓
                         Continuity → Recovery → Delivery
```

## Provider lanes

The generic lane projects pinned CCXT metadata and unified results for:

- K-lines, trades, bounded order-book snapshots, and tickers;
- mark/index prices, premium-index candles, funding rate/history, open
  interest/history, and public liquidations when CCXT advertises those
  methods;
- runtime market-family and symbol validation after `load_markets()`;
- pooled reconnecting CCXT Pro instances and deterministic cleanup.

Generic depth is explicitly a CCXT-managed bounded snapshot. Its local
revision is not an exchange sequence number and it never claims strict
`FULL_DEPTH` quality.

The primary Binance/OKX lane preserves stable `spot` and `futures` product
names and compact native symbol IDs while all physical calls still go through
CCXT. OKX combines independent CCXT mark-price, index-ticker, and funding-rate
subscriptions into the existing CandleScope derivatives-summary contract.

Channels that require raw venue semantics use decoded-payload hooks before
CCXT's unified projection:

- Binance spot/USD-M K-lines;
- Binance spot/USD-M aggregate trades;
- Binance spot/USD-M strict full-depth deltas;
- Binance USD-M mark/index/funding summary and liquidations;
- OKX spot/swap K-lines and tickers.

CandleScope continues to own normalization, continuity, bounded K-line and
aggregate-trade repair, stale-state publication, and strict full-order-book
reconstruction. Binance repair snapshots/history are requested through CCXT
implicit REST methods, so no native HTTP client is available to bypass the
provider boundary.

## Quality boundaries

- The CCXT version is pinned in `backend/requirements.txt`; a version mismatch
  fails before catalog registration.
- Capability metadata is network-free and fail-closed. Product/symbol support
  is revalidated against live `load_markets()` data.
- A raw queue overflow, crossed CCXT order-book cache, unresolved symbol, or
  broken strict depth link is an explicit unhealthy/resync condition.
- CCXT unified trade IDs are deduplicated but never assumed contiguous.
- Public liquidation streams remain lossy and have no contiguous sequence.

## Validation commands

Run the backend contract and provider suites from the repository root:

```powershell
python -m pytest `
  backend/tests/test_ccxt_unified_provider.py `
  backend/tests/test_ccxt_provider_runtime.py `
  backend/tests/test_ccxt_gap_recovery.py `
  backend/tests/test_exchange_plugin_contracts.py `
  backend/tests/test_exchange_capabilities_v2.py -q
```

Run venue shadow matrices from `backend` when qualifying a CCXT upgrade:

```powershell
python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.binance-usdm.example.json `
  --output ../output/ccxt-shadow-matrix-binance-usdm.json

python scripts/ccxt_shadow_matrix.py `
  --config scripts/ccxt_shadow_matrix.okx-swap.example.json `
  --output ../output/ccxt-shadow-matrix.okx-swap.json
```

Run the representative generic-provider soak:

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

The soak must fail on malformed projection, duplicate trade IDs, regressing
local revisions, stalled streams, incomplete reconnect, queue overflow,
residual CCXT tasks, or a non-empty runtime pool after close.
