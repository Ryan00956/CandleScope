# Pyne Workbench for CandleScope

An independent Plugin Platform v2 development plugin. It does not replace the
frozen `candlescope.script-runtime/1` Pyne bridge.

The batch command follows one explicit path:

1. read the Host-owned current chart context;
2. read bounded primary bars;
3. execute native Pyne output schema v2;
4. broker any exact `request.*` ranges back through `market.bars.read`;
5. project supported output into `candlescope.render/2` and publish it against
   the exact chart revision.

The incremental commands expose open/seed, preview or commit one bar, snapshot,
and close. Sessions are process-local, capped at 16, expire after 15 idle
minutes, and use Pyne's own rolling retention and snapshot-capable engine.

## Honest rendering boundary

Lines, drawing lines/polylines, boxes, labels, markers, and horizontal levels
map to chart-layer/2. Native Pyne candles, histograms, fills, bar/background
colors, linefills, and tables remain counted in the command result but are not
silently approximated as another chart primitive.

## Development

From this directory, with the sibling packages and local `pyne-runtime` on
`PYTHONPATH`:

```powershell
python -m ruff check src tests
pytest -q
python -m build
python -m twine check dist/*
```

The manifest currently grants a deliberately small development universe:
Binance/OKX, spot/perpetual, BTCUSDT/ETHUSDT/SOLUSDT, and six common intervals.
Expand those scopes intentionally; they are authorization ceilings, not market
discovery.

This source package intentionally depends on the `0.3` development lines of
the Pyne bridge and runtime. The already published `0.2.0` bridge and
`0.2.0rc1` runtime do not contain the native-v2 methods used here. Local
cross-repository and installed-wheel acceptance use the unpublished
`0.3.0.dev0` bridge plus `0.3.0rc2` runtime candidate lock; publishing remains
a separate decision.
