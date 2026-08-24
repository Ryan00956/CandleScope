# Market chart platform

This package is the source-neutral chart boundary shared by the live market page and research
applications. It owns no product UI and opens no REST or WebSocket connection by itself.

- `LIVE_REFERENCE` adapts a Host-owned `MarketDataRuntimeContract`; it has no immutable execution
  identity and must be rejected as a Run input.
- `FROZEN_SNAPSHOT` owns a copied, offline `SeriesWindowStore` identified by dataset, epoch, and
  snapshot hash.
- `RUN_RESULT` owns a copied, offline result series identified by Run and report/chart hashes.

Consumers render through `MarketChartSurface`, pass markers, layers, and supplemental panes as
explicit inputs, and dispose the source when its owner closes. `MarketChartSourceSlot` disposes the
previous source before a source switch. Imports from backtest UI, replay UI, app composition, and
workspace stores are prohibited by the architecture check.
