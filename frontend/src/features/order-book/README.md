# Order book feature

This feature owns the Binance Spot and USD-M Futures order-book subscription
lifecycle and UI.

- `useOrderBookRuntime` is the composition boundary. It opens one immutable P3 or P4 WebSocket subscription and closes it when identity, mode, frequency, depth, visibility, or component lifetime changes.
- `orderBookStreamController` validates handshakes and acknowledgements. P3 uses a client stale watchdog; P4 clears the visible book immediately on a backend stale/resync status.
- `orderBookStore` is a latest-only external store. Book updates are published at most once per animation frame so they do not enter the chart or application state tree.
- `OrderBookDock` renders only validated, live snapshots. It does not own WebSocket or local-storage effects.
- Price grouping is stored per mode. P3 groups only its bounded Top-N snapshot in the dock, caps auto grouping at `tick × 10`, and omits the incomplete furthest bucket cut by the Top-N boundary. P4 sends `price_grouping` to the backend, where the full reconstructed projection is grouped before the near-price window and `output_limit` are applied. Raw best quotes and spread metrics remain unchanged.
- Rows use stable physical slot identities and the two depth scrollers disable browser scroll anchoring. When best prices advance, existing row slots update their values instead of the browser moving the viewport to preserve old price nodes.

The current backend scope is intentionally explicit: Binance Spot and USD-M
Futures live order books, with no historical replay. Spot supports the exchange
cadences of 100 ms and 1000 ms; USD-M Futures supports 100 ms, 250 ms, and
500 ms. P4 reconstructs each market with its native sequence contract and
fails closed while a gap is being resynchronized.
