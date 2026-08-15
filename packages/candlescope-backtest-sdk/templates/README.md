# Official Python First templates

Each directory is an immutable author bundle: `strategy.json`, `strategy.py`,
`requirements.lock`. Strategies return decisions only. CandleScope Host owns
matching, fees, funding, risk, account, ledger, report, Study, and audit.

Signal clock is `BAR_CLOSE`. Supported fidelity labels are `BAR_APPROX` and
`AGG_TRADE_EXECUTION`. Neither is raw trade or queue exact.

| Template | Output | Role |
|---|---|---|
| `sma_cross` | TARGET_POSITION | SMA cross long/short |
| `rsi_wilder_24` | SIGNAL | Wilder RSI24 long/short |
| `donchian_breakout` | TARGET_POSITION | Donchian / range breakout |
| `mean_reversion` | TARGET_POSITION | Close vs SMA band |
| `buy_and_hold` | TARGET_POSITION | Always long benchmark |
| `always_flat` | TARGET_POSITION | Always flat benchmark |
| `order_intents` | ORDER_INTENT | Market / Limit / Stop / Stop-Limit |
| `snapshot_restore` | TARGET_POSITION | Snapshot and restore example |

`study_parameter_space.json` is the Study V2 grid for `rsi_wilder_24`.
