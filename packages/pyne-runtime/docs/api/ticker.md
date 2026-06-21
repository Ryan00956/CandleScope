# Ticker API

Pyne exposes a Pine-like `ticker.*` namespace for constructing stable ticker id
strings. Pyne does not resolve exchange aliases itself; host data providers
decide how to interpret the returned id.

Base ticker ids use `PREFIX:SYMBOL`. Optional modifiers are encoded as query
parameters:

```python
base = ticker.new("NASDAQ", "AAPL")
extended = ticker.new("NASDAQ", "AAPL", ticker.session_extended, ticker.adjustment_dividends)

# "NASDAQ:AAPL"
# "NASDAQ:AAPL?session=extended&adjustment=dividends"
```

## Helpers

- `ticker.new(prefix=None, ticker=None, session=None, adjustment=None)`
- `ticker.inherit(ticker=None, session=None, adjustment=None)`
- `ticker.modify(tickerid, session=None, adjustment=None)`
- `ticker.standard(tickerid=None)`
- `ticker.heikinashi(tickerid=None)`
- `ticker.renko(tickerid=None, style=None, param=None)`
- `ticker.linebreak(tickerid=None, lines=None)`
- `ticker.kagi(tickerid=None, reversal=None)`
- `ticker.pointfigure(tickerid=None, style=None, param=None, reversal=None)`

`ticker.inherit()` uses the current `syminfo.prefix` when available.
`ticker.standard()` strips Pyne ticker modifiers and returns the base ticker id.
When `tickerid` is omitted, helpers default to the current `syminfo.tickerid`.

## Constants

- `ticker.session_regular`
- `ticker.session_extended`
- `ticker.adjustment_none`
- `ticker.adjustment_splits`
- `ticker.adjustment_dividends`

Chart-type helpers add a `chart` modifier:

```python
ticker.heikinashi("NASDAQ:AAPL")
# "NASDAQ:AAPL?chart=heikinashi"

ticker.renko("NASDAQ:AAPL", "ATR", 14)
# "NASDAQ:AAPL?chart=renko&style=ATR&param=14"
```
