# ADR-BACKTEST-010: Report and performance metrics V2

- Status: Accepted for M7 implementation
- Date: 2026-08-15
- Identity: `candlescope.backtest-report/2` + `BACKTEST_METRICS_V2`
- Dependencies: `LINEAR_PERP_ONE_WAY_V2` and `EXECUTION_REALISM_V2`

## Decision

Report V2 is opt-in and immutable. A Run freezes `metrics_version`, report schema,
`UTC_DAILY_CLOSE_V1`, 365-day annualization, annual risk-free rate, benchmark
model and sample role. Report `/1` remains byte/hash compatible and read-only.
The Host owns every formula; the browser renders report fields and never
recomputes a performance metric.

## Frozen sampling and null rules

The account series is the last observed mark-to-market equity point in each UTC
calendar day. The Run initial equity is eligible as the first sample. Daily
return is `equity[t] / equity[t-1] - 1`. A non-positive equity denominator,
negative/final non-positive equity, zero denominator or insufficient sample
returns `null` with a reason; no infinity or fabricated zero is emitted.

- annualized return requires at least 365 elapsed days;
- volatility, downside volatility, Sharpe and Sortino require at least 30 daily
  returns;
- annualization uses 365 and the Run's frozen annual risk-free rate;
- account metrics include open-position mark-to-market PnL; trade metrics use
  only FIFO-completed round trips;
- zero trades yield `null + NO_CLOSED_TRADES` for rates and expectations;
- monthly return uses first and last daily equity in a UTC month and requires at
  least two samples in that month.

## Frozen formulas

| Metric | Formula / convention |
| --- | --- |
| total return | `final equity / initial equity - 1` |
| annualized return | `exp(ln(1 + total return) * 365 / elapsed days) - 1` |
| net PnL | `final equity - initial equity` |
| realized/unrealized PnL | authoritative account cumulative realized / final mark-to-market unrealized |
| benchmark return | full-notional buy-and-hold on the same snapshot/window, applying the same taker fee and symmetric slippage at entry and exit |
| excess return | total return minus benchmark return |
| max drawdown | maximum absolute decline from prior daily equity peak |
| drawdown duration | maximum UTC milliseconds from peak to an unrecovered daily point |
| volatility | sample standard deviation of daily returns times `sqrt(365)` |
| downside volatility | root mean square of negative daily excess returns times `sqrt(365)` |
| Sharpe | mean daily excess return / sample standard deviation, times `sqrt(365)` |
| Sortino | annualized mean daily excess return / annualized downside volatility |
| Calmar | annualized return / max drawdown |
| win rate | profitable completed FIFO trades / completed FIFO trades |
| profit factor | gross profit / absolute gross loss |
| expectancy | mean completed-trade net PnL |
| payoff ratio | mean winning net PnL / absolute mean losing net PnL |
| holding duration | FIFO entry-to-exit milliseconds; mean and median |
| turnover | sum absolute fill notional / mean sampled equity |
| exposure time | time-weighted fraction of sampled intervals whose starting position is non-zero |
| MAE/MFE | worst/best signed price return over authoritative source events while the FIFO lot is open; BAR uses entry/open, intervening high/low, and only the exit bar open before a market exit, so post-exit bar extremes cannot leak into the trade |
| fees/funding | authoritative account cumulative amounts |
| slippage | signed fill-price cost against the authoritative source-event price |

Long and short metrics are separate. Maximum single loss and maximum consecutive
losses use completed-trade net PnL. Partial, rejected and unfilled orders are
execution quality counts and never become trades.

## Reconciliation and failure policy

Report sealing fails closed unless all equations hold exactly as Decimal:

1. completed-trade gross PnL equals account cumulative realized PnL;
2. fill fees equal account cumulative fees;
3. funding ledger event amounts equal account cumulative funding;
4. final equity equals final wallet plus final unrealized PnL.

The report hash is computed only after metrics and reconciliation are present.
JSON and CSV export manifests bind to that same report hash. Benchmark evidence
includes the reduced market-context hash, snapshot window, source prices and
cost assumptions. It is not a second strategy and does not alter the primary
Run config hash after creation.

## Consequences and rollback

The new report is larger but bounded to daily account points, monthly cells and
per-trade evidence; it never embeds the full market tape. Revert the independent
M7 commit to remove creation of `/2`; stored `/1` reports remain readable. All
production flags and the V2 UI toggle remain default off.
