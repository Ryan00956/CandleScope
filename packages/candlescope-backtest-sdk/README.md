# candlescope-backtest-sdk

Author types for `candlescope.python-strategy/1`. Strategies return `SIGNAL`,
`TARGET_POSITION`, or `ORDER_INTENT`. CandleScope Host owns data, watermark,
matching, fees, funding, risk, account, ledger, report, Study, and audit.

This package has no backend, database, network, or Plugin Platform client.

## Strategy cannot

- Import Host modules or open CandleScope SQLite
- Read future observations or forming bars
- Treat a returned intent as an accepted order or fill
- Change Host fee, funding, or risk models

## Host owns

Observation clock, planner/rules/risk, fills, ledger, report hashes, and
checkpoint identity.
