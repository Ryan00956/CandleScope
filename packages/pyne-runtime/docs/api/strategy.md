# Strategy API

`strategy` is the Pine-like namespace for deterministic strategy events.

The current implementation is an event and position semantics layer. It is not
a broker simulator and does not model order books or tick-level matching.

The public strategy API is stable through both `pyne_runtime.strategy` and the
package top level. Existing imports such as `from pyne_runtime.strategy import
StrategyModule` and `from pyne_runtime import StrategyModule` continue to work.

```python
strategy(
    "Trend Strategy",
    overlay=True,
    pyramiding=1,
    slippage=2,
    mintick=0.01,
    commission_type=strategy.commission.percent,
    commission_value=0.1,
    backtest_fill_limits_assumption=1,
    process_orders_on_close=True,
    same_bar_fill_priority=strategy.same_bar.stop_first,
    intrabar_path=strategy.intrabar.same_bar_priority,
    margin_long=0,
    margin_short=0,
)

fast = ta.ema(close, 12)
slow = ta.ema(close, 26)

strategy.entry_when(ta.cross(fast, slow), "Long", strategy.long, qty=1)
strategy.close_when(ta.cross(slow, fast), "Long")
strategy.exit("Long Exit", from_entry="Long", stop=close * 0.95, limit=close * 1.05)
strategy.cancel("Long", when=barstate.islast)
strategy.close_all(when=barstate.islast, comment="End")

plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
```

## Direction Constants

- `strategy.long`
- `strategy.short`
- `strategy.direction.all`
- `strategy.direction.long`
- `strategy.direction.short`
- `strategy.direction.none`

## OCA Constants

- `strategy.oca.none`
- `strategy.oca.cancel`
- `strategy.oca.reduce`

The current replay model implements `strategy.oca.cancel` and
`strategy.oca.reduce` for pending `strategy.entry*` and `strategy.order*`
orders. In a reduce group, a filled order reduces sibling pending quantities by
the filled quantity; siblings reduced to zero are canceled.

OCA state changes do not charge commission by themselves. A canceled sibling
keeps a lifecycle record with no `commission` field. A reduced sibling charges
commission only if it later fills, and cash-per-contract commission uses the
reduced filled quantity rather than the original requested quantity.

## Configuration

Prefer the Pine-like declaration form:

```python
strategy(
    "My Strategy",
    overlay=True,
    pyramiding=1,
    slippage=2,
    mintick=0.01,
    commission_type=strategy.commission.percent,
    commission_value=0.1,
    backtest_fill_limits_assumption=1,
    process_orders_on_close=True,
    same_bar_fill_priority=strategy.same_bar.stop_first,
    intrabar_path=strategy.intrabar.same_bar_priority,
    margin_long=0,
    margin_short=0,
)
```

`strategy.configure(...)` is also available as a Python-friendly alias when a
script has already declared metadata through `indicator(...)` or does not need
declaration metadata.

`pyramiding` controls additional same-direction entries:

- `pyramiding=0` is the default and allows one open same-direction entry.
- `pyramiding=1` allows one additional same-direction entry.
- same-direction entries update `strategy.position_size` and weighted
  `strategy.position_avg_price`
- an opposite-direction entry reverses or replaces the current position

`slippage` follows Pine's tick-based model:

- `slippage` is a number of ticks, not a direct price or percent value.
- `mintick` / `min_tick` supplies the symbol's minimum price movement.
- When `mintick` / `min_tick` is omitted, Pyne uses `syminfo.mintick`.
- buy fills use `price + slippage * mintick`.
- sell fills use `price - slippage * mintick`.

Commission uses Pine-like constants:

- `strategy.commission.percent`: `commission_value` is a percent of traded notional.
- `strategy.commission.cash_per_order`: `commission_value` is charged once per filled order.
- `strategy.commission.cash_per_contract`: `commission_value` is charged per filled unit.

Filled entry lots retain their entry commission. When a lot is partially or
fully closed, `closedtrades[*].commission` and
`strategy.closedtrades.commission(trade_num)` include the proportional entry
commission plus the proportional commission from the closing order. This keeps
closed-trade net profit aligned with Pine's "commission paid by the closed
trade" mental model while `summary["commission"]` continues to report total
accumulated commission.

`backtest_fill_limits_assumption` follows Pine's limit-order verification
mental model:

- the value is a number of ticks
- the tick size is `mintick` / `min_tick`, or `syminfo.mintick` when omitted
- a long/buy limit fills only when bar `low <= limit - value * mintick`
- a short/sell limit fills only when bar `high >= limit + value * mintick`
- the filled price remains the requested limit price plus normal slippage rules

The default is `0`, which preserves the simpler touch-to-fill behavior.

`process_orders_on_close=True` follows Pine's close-processing visibility:
orders submitted on a bar can fill at that bar's close or intrabar price, while
strategy series such as `strategy.position_size`, `strategy.netprofit`, and
`strategy.closedtrades` expose same-bar fills on the following bar. The default
is `False`, preserving Pyne's original same-bar fill visibility.

`same_bar_fill_priority` controls deterministic replay when both stop and limit
prices are touched by the same bar:

- `strategy.same_bar.stop_first`: stop wins. This is the default and preserves
  Pyne's earlier conservative behavior.
- `strategy.same_bar.limit_first`: limit wins.

The rule applies to pending `strategy.entry*` / `strategy.order*` stop-limit
submissions and to `strategy.exit(...)` brackets. Pyne still does not infer the
true intrabar path; this setting only makes the ambiguous same-bar outcome
explicit and repeatable.

`intrabar_path` can make that ambiguity follow a deterministic high/low path:

- `strategy.intrabar.same_bar_priority`: use `same_bar_fill_priority`. This is
  the default.
- `strategy.intrabar.open_high_low_close`: assume the bar visits `high` before
  `low`.
- `strategy.intrabar.open_low_high_close`: assume the bar visits `low` before
  `high`.

The path policy is only used when both stop and limit are hit by the same bar.
It does not model tick-level movement, order queueing, partial intrabar fills,
or exchange-specific matching.

Margin settings are accepted in the Pine-like declaration:

- `margin_long` is the percent margin required for long exposure.
- `margin_short` is the percent margin required for short exposure.
- both default to `0`, meaning no margin admission check
- lower values allow larger notional exposure for the same equity
- `syminfo.pointvalue` participates in the notional calculation

Pyne uses explicit margin settings as deterministic entry/order admission rules. If the
resulting position would require more margin than the current replayed equity,
the new `strategy.entry*` or `strategy.order*` fill is skipped. Reducing,
closing, exiting, and canceling exposure remains allowed. Pyne does not model
broker margin calls, forced liquidation, interest, or cash settlement.

## Pine-Equivalent Goldens

The strategy golden suite includes `pine_equivalent` scaffolds for a basic
market round trip, pending limit/stop entries, bracket exits,
commission/slippage cost accounting, percent commission, cash-per-contract
commission, partial close allocation, reversal, pyramiding, and OCA/risk-lock
interactions, plus global drawdown lock, max position size, and limit
verification scenarios, partial exits, same-bar stop/limit priority, and
intrabar path policy, including mirrored short-side exit, size, OCA, and cost
paths, margin admission, lower-level `strategy.order` net-position behavior,
and cancel/cancel_all cleanup. These Pine scripts use
`process_orders_on_close=true`, while Pyne scripts pin explicit entry or close
fills with `price=close` where needed, so expected prices are deterministic and
can be replaced with exported TradingView values when an external capture is
available.

Fixtures can include an optional `external_capture` block:

```json
{
  "provider": "tradingview",
  "status": "captured",
  "tolerance": 1e-9,
  "values": {
    "Position": [2.0, 2.0, 0.0],
    "Net Profit": [0.0, 0.0, 6.0]
  }
}
```

`status="not_captured"` records that a Pine scaffold exists but no external
export has been added yet. `status="captured"` turns the exported plot values
into active assertions against Pyne output. The values should come from the
matching `pine_equivalent` script's exported plot data, not from Pyne itself.

## Batch And Incremental Shared Core

Batch strategy replay and incremental strategy callbacks share the same
constant classes and pure helper semantics for:

- direction, commission, OCA, same-bar priority, intrabar path, and risk mode
  constants
- pending entry/order and bracket-exit trigger resolution
- same-bar stop/limit priority and deterministic intrabar path normalization
- commission, margin, exposure-reduction, max-position-size, drawdown, and
  intraday filled-order gates
- open-trade profit and numeric trade field coercion helpers

The shared helpers live under `pyne_runtime.strategy.*` and are covered by unit
tests in `tests/test_strategy_shared_helpers.py`. Incremental strategy still
owns scalar current-bar mutation, preview isolation, pending-order storage,
open/closed trade list mutation, and callback lifecycle reporting. Batch
strategy still owns vector replay and per-bar series output. This keeps the
high-risk state transitions separate while making the deterministic admission,
cost, risk, and trigger rules common to both runtimes.

Capital reporting:

- `initial_capital` defaults to `100000`.
- `currency` defaults to `syminfo.currency` when available.
- `strategy.equity` is `initial_capital + strategy.netprofit + strategy.openprofit`.
- `strategy.netprofit` is realized gross profit/loss minus accumulated commission.
- `strategy.openprofit` marks the current net position to the current bar's `close`.
- `strategy.grossprofit` and `strategy.grossloss` track realized gross PnL before
  commission. `strategy.grossloss` is reported as a negative number.

## Risk Configuration

```python
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.risk.max_drawdown(20, strategy.percent_of_equity)
strategy.risk.max_intraday_loss(5, strategy.cash)
strategy.risk.max_position_size(10)
strategy.risk.max_intraday_filled_orders(3)
```

`strategy.risk.allow_entry_in(...)` limits subsequent replay of
`strategy.entry*` events:

- `strategy.direction.all` / `strategy.risk.all`: allow long and short entries.
- `strategy.direction.long` / `strategy.risk.long`: allow long entries only.
- `strategy.direction.short` / `strategy.risk.short`: allow short entries only.
- `strategy.direction.none` / `strategy.risk.none`: block all entries.

This is a replay configuration for `strategy.entry*`. Lower-level
`strategy.order*` calls are not blocked by this setting because they represent
net-position order events rather than Pine-style entries.

`strategy.risk.max_drawdown(value, type=strategy.percent_of_equity)` locks the
strategy after equity falls far enough from the replayed equity peak:

- `strategy.percent_of_equity`: `value` is a percentage drawdown from peak equity.
- `strategy.cash`: `value` is an absolute cash drawdown from peak equity.

Once locked, future `strategy.entry*` and `strategy.order*` submissions and
pending fills are blocked. Close, exit, and cancel events remain available so a
script can flatten or clean up existing exposure. This is deterministic replay
logic, not a broker-side liquidation model. Blocked pending entry/order fills
remain pending and do not charge commission; if an intraday rule resets at a
later `session.isfirstbar`, those pending submissions can be evaluated again.

`strategy.risk.max_intraday_loss(value, type=strategy.percent_of_equity)` uses
the same value types, but resets at the next `session.isfirstbar` boundary. Host
applications can mark daily or trading-session starts with per-bar
`session_isfirstbar` metadata. Without explicit metadata, Pyne's default batch
session marks only the first input bar as a session start.

`strategy.risk.max_position_size(contracts)` caps `strategy.entry*` fills so
the resulting long or short position does not exceed the configured absolute
size. If an entry would exceed the cap, Pyne reduces its fill quantity; if no
quantity remains after the cap is applied, the entry is skipped. Opposite
entries can replace the current position with a new capped position in the
opposite direction.

Like `allow_entry_in(...)`, this is an entry-level risk rule.
`strategy.order*` remains a lower-level net-position API and is not quantity
capped by `max_position_size(...)`.

`strategy.risk.max_intraday_filled_orders(count)` caps filled `strategy.entry*`
and `strategy.order*` events in the current session segment. Once the limit is
reached, future entry/order submissions and pending fills are blocked until the
next `session.isfirstbar` boundary. Close, exit, and cancel events remain
available so scripts can flatten or clean up existing exposure.

## Entry

```python
strategy.entry_when(condition, id, direction=strategy.long, qty=1, price=None, limit=None, stop=None, oca_name="", oca_type=None, comment="")
strategy.entry(id, direction=strategy.long, qty=1, when=True, price=None, limit=None, stop=None, oca_name="", oca_type=None, comment="")
```

`condition` / `when` may be a scalar bool or a `PyneSeries` bool expression.
When `price` is omitted, Pyne uses `close` for the event price.

Entries use lightweight target/replay semantics:

- a long entry adds positive quantity
- a short entry adds negative quantity
- same-direction duplicate entries are limited by `strategy.configure(pyramiding=...)`
- a later opposite-direction entry can reverse or replace the target position
- `limit` and `stop` create lightweight pending orders that fill when later bar
  high/low values touch the trigger price
- pending orders with the same `oca_name` and `oca_type=strategy.oca.cancel`
  cancel their siblings when the first order fills

## Order

```python
strategy.order_when(condition, id, direction=strategy.long, qty=1, price=None, limit=None, stop=None, oca_name="", oca_type=None, comment="")
strategy.order(id, direction=strategy.long, qty=1, when=True, price=None, limit=None, stop=None, oca_name="", oca_type=None, comment="")
```

`strategy.order*` is a lower-level net-position order. Unlike
`strategy.entry*`, it is not limited by `pyramiding`:

- same-direction orders add to the current position
- opposite-direction orders reduce the current position
- if an opposite-direction order is larger than the current position, it reverses the position
- slippage and commission settings apply to filled order prices
- `limit` and `stop` create pending orders using the same high/low trigger scan
  as `strategy.entry*`

## Cancel

```python
strategy.cancel(id, when=True, comment="")
strategy.cancel_all(when=True, comment="")
```

`cancel()` cancels pending entry/order events with the matching id.
`cancel_all()` cancels every pending entry/order event. Cancel events are emitted
only when at least one pending order is actually canceled.

Cancel events are cleanup events, so they remain available while risk rules are
locked and do not charge commission. Canceled pending orders stay canceled across
later bars and later intraday risk resets.

## Close

```python
strategy.close_when(condition, id="", qty=None, qty_percent=None, price=None, comment="")
strategy.close(id="", when=True, qty=None, qty_percent=None, price=None, comment="")
strategy.close_all(when=True, price=None, comment="")
```

`close_when()` emits close events only when there is an open position at that
bar in the replayed event timeline. When `id` is provided, replay closes the
matching entry-id lot quantity instead of blindly closing the whole net
position.

`qty` and `qty_percent` allow partial closes:

- `qty` closes up to that absolute quantity.
- `qty_percent` closes that percentage of the targeted quantity.
- if both are provided, `qty` takes precedence.
- if `id` is provided, `qty_percent` is calculated against the matching entry
  lot quantity; otherwise it is calculated against the whole current position.
- if neither is provided, the close targets the full matching quantity.

`close_all()` emits a close-all event that closes any open long or short
position at matching bars.

## Exit

```python
strategy.exit(id, from_entry="", qty=None, qty_percent=None, stop=None, limit=None, when=True, comment="")
```

`strategy.exit()` emits stop/limit bracket exit events while a position is open.
The current implementation scans each bar's `high` and `low` values:

- Long stop triggers when `low <= stop`.
- Long limit triggers when `high >= limit`.
- Short stop triggers when `high >= stop`.
- Short limit triggers when `low <= limit`.

When stop and limit are both touched on the same bar, stop wins. This is a
deterministic event model, not an intrabar broker simulator.

When `from_entry` is provided, the exit targets matching entry-id lots. When
`qty` is provided, the exit reduces that matched quantity by up to `qty` and
leaves the remaining position open with the previous average entry price. When
`qty_percent` is provided, the exit reduces that percentage of the targeted
quantity. If both `qty` and `qty_percent` are provided, `qty` takes precedence.
When neither is provided, the exit closes the full matched entry lot quantity.

## Position Series

```python
plot(strategy.position_size, "Position")
plot(strategy.position_avg_price, "Average Price")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
plot(strategy.openprofit, "Open Profit")
plot(strategy.closedtrades, "Closed Trade Count")
plot(strategy.opentrades, "Open Trade Count")
```

Position values are replayed from the emitted event ledger in chronological
order. This gives batch output a Pine-like bar-by-bar mental model while staying
Python-friendly.

## Trade Namespace Access

`strategy.closedtrades` and `strategy.opentrades` behave as count series when
plotted. They also expose field accessors for the latest replayed entry-lot
ledger:

```python
plot(strategy.closedtrades, "Closed Trades")
plot(strategy.opentrades, "Open Trades")
plot(strategy.closedtrades.profit(0), "First Closed Profit")
plot(strategy.opentrades.entry_price(-1), "Latest Open Entry")
```

Supported accessors:

- `size(trade_num)` / `qty(trade_num)`
- `profit(trade_num)`
- `profit_percent(trade_num)`
- `net_profit(trade_num)`
- `commission(trade_num)`
- `entry_price(trade_num)`
- `exit_price(trade_num)`
- `entry_time(trade_num)`
- `exit_time(trade_num)`
- `entry_bar_index(trade_num)`
- `exit_bar_index(trade_num)`
- `entry_id(trade_num)`
- `exit_id(trade_num)`
- `entry_comment(trade_num)`
- `exit_comment(trade_num)`
- `side(trade_num)`

Negative indexes count from the end of the current ledger. When a ledger is
empty, the default first/latest trade accessors (`0` and `-1`) return `0` for
numeric fields so exported plots stay aligned with TradingView's empty-ledger
zeros. Out-of-range indexes on a non-empty ledger still return `na` for numeric
fields and an empty string for string fields. The count objects
(`strategy.closedtrades` and `strategy.opentrades`) are bar-by-bar series, while
field accessors read from the latest replayed ledger snapshot.

Non-empty entry and exit order comments are preserved as `entry_comment` and
`exit_comment` fields in the public trade report. Empty comments are omitted
from the report and return `""` from the script-facing accessors.

`profit_percent(trade_num)` reports `profit / abs(entry_price * size) * 100`
using the same trade profit value exposed by `profit(trade_num)`. Empty default
trades return `0`, while out-of-range or incomplete trades return `na`.

For closed trades, `commission(trade_num)` includes both the matched entry-lot
commission share and the exit/close order commission share. For open trades, it
reports the commission still attached to that open entry lot when commission is
non-zero.

## Lifecycle Report

`output["strategy"]["lifecycle"]` reports the replayed order lifecycle without
changing the compact `orders` fill ledger. It is intended for host renderers,
debug panels, and tests that need to distinguish submission, pending,
fill, cancel, and rejection phases.

Lifecycle records include:

- `status`: `pending`, `filled`, `canceled`, `rejected`, or `submitted`.
- `phase`: `market_fill`, `pending`, `pending_fill`, `pending_canceled`,
  `pending_rejected`, `exit_fill`, `close_fill`, `close_all_fill`, `cancel`,
  or `rejected`.
- `submitted_time`, `filled_time`, `canceled_time`, and `rejected_time` when
  known.
- order identity and replay fields such as `id`, `type`, `side`, `qty`,
  `price`, `limit`, `stop`, `position_after`, `reason`, `comment`,
  `oca_name`, and `oca_type` when those fields apply.
- quantity details such as `target_qty`, `requested_qty`, `filled_qty`, and
  `qty_percent` when replay needs to distinguish requested size from actual
  filled size.

Pending entry/order submissions that never fill still appear with
`status="pending"`. Pending submissions canceled by `strategy.cancel()`,
`strategy.cancel_all()`, or OCA behavior appear with `status="canceled"` and
`phase="pending_canceled"`. Filled stop/limit submissions appear with
`phase="pending_fill"`, while immediate market-style entry/order fills use
`phase="market_fill"`.

Pending submissions that survive a risk lock keep their original
`submitted_time`. If they later fill after an intraday reset, later OCA or
cancel cleanup records preserve the same lifecycle identity and report the final
`filled_time` or `canceled_time`.

Rejected submissions appear with `status="rejected"` and `rejected_reason`.
Current rejection reasons include `risk_locked`, `direction_not_allowed`,
`pyramiding_exceeded`, `max_position_size`, and `margin`.

For capped or partial fills, `orders[*].qty` remains the compact filled ledger
quantity, while lifecycle fields preserve the wider replay context:

- `target_qty`: position or entry-lot quantity available to close/exit.
- `requested_qty`: quantity requested by the script after applying
  `qty_percent`, if any.
- `filled_qty`: quantity actually filled by the deterministic replay.
- `qty_percent`: original percentage request for close/exit calls when used.
- `transaction_qty`: actual broker-style transaction quantity when it differs
  from the compact entry quantity, such as an opposite-direction
  `strategy.entry*` reversal where closing the old position and opening the new
  target position happen in one replayed fill.

## Output

Strategy output is serialized under `output["strategy"]`:

Hosts can inspect the versioned strategy report contract through
`pn.schema()["strategyReport"]`. That schema describes the public `orders`,
`position`, `summary`, `risk`, `closedtrades`, `opentrades`, and `lifecycle`
sections. Script-facing accessor implementation details, such as private trade
fields beginning with `_`, are intentionally excluded from the public report.

```json
{
  "strategy": {
    "orders": [
      {
        "time": 1710000000,
        "id": "Long",
        "type": "entry",
        "side": "long",
        "qty": 1.0,
        "requested_qty": 1.0,
        "filled_qty": 1.0,
        "price": 123.45,
        "position_after": 1.0,
        "commission": 0.12,
        "comment": ""
      },
      {
        "time": 1710000600,
        "id": "Long Exit",
        "from_entry": "Long",
        "type": "exit",
        "side": "flat",
        "qty": 1.0,
        "price": 130.0,
        "position_after": 0.0,
        "reason": "limit",
        "comment": ""
      }
    ],
    "position": {
      "size": 1.0,
      "side": "long",
      "avg_price": 123.45
    },
    "lifecycle": [
      {
        "id": "Long",
        "type": "entry",
        "status": "filled",
        "phase": "market_fill",
        "submitted_time": 1710000000,
        "filled_time": 1710000000,
        "canceled_time": null,
        "rejected_time": null,
        "side": "long",
        "qty": 1.0,
        "price": 123.45,
        "position_after": 1.0,
        "comment": ""
      }
    ],
    "summary": {
      "initial_capital": 100000.0,
      "currency": "USD",
      "equity": 100250.0,
      "netprofit": 125.0,
      "openprofit": 125.0,
      "grossprofit": 250.0,
      "grossloss": 0.0,
      "commission": 0.0,
      "backtest_fill_limits_assumption": 0,
      "margin_long": 0.0,
      "margin_short": 0.0
    },
    "closedtrades": [],
    "opentrades": [
      {
        "entry_time": 1710000000,
        "entry_id": "Long",
        "side": "long",
        "qty": 1.0,
        "entry_price": 123.45,
        "profit": 125.0
      }
    ]
  }
}
```

`closedtrades` and `opentrades` are entry-lot ledgers. Same-direction entries
create separate lots, `strategy.exit(..., from_entry="...")` closes matching
lots first, and broad closes such as `strategy.close_all()` close lots FIFO.
The position series remains a deterministic net-position replay.

Known limits:

- no intrabar path model
- Python `if` cannot branch directly on series conditions; use
  `entry_when()` and `close_when()`
