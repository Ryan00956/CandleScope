# Backtest performance and release evidence

This directory holds machine-readable backtest evidence. Phase 0 only freezes
the layout and the release-manifest schema. It does not record a production
benchmark, because no Host kernel exists yet.

## Layout

- `release-manifest.schema.json` — `candlescope.backtest-release/1`
- later Phase files: `phaseN-<kind>-<date>.json`

## Test matrix

Every later Phase must add focused commands. The contract suite that already
exists:

```powershell
Set-Location H:\program\CandleScope-backtest-foundation\backend
..\..\. wait
H:\program\CandleScope\backend\.venv\Scripts\python.exe -m pytest tests/backtest_contract -q
```

Required later families, from the execution document:

- `no_lookahead`
- `determinism`
- `accounting`
- `execution`
- `provider_conformance`
- `data_quality`
- `study_validity`
- `security`
- `browser_acceptance`
- `performance`
- `rollback`

Empty-path benchmarks must not replace workloads that contain open orders,
SQLite writes, or Decimal ledger rows.

## Product-path smoke / soak commands

```powershell
Set-Location H:\program\CandleScope-backtest-foundation\frontend
$env:BACKTEST_BASE_URL='http://127.0.0.1:8000/api/v1/backtests'
npm run smoke:backtest
npm run soak:backtest
```

`smoke:backtest` and `soak:backtest` use the public API and durable worker, then
verify the stored report/export hashes. A target runtime with at least one
immutable local dataset is required.

Historical files on this branch:

- `docs/evidence/backtest-soak-million-trade-20260814.json`
- `docs/evidence/backtest-soak-1h-20260814.json`

Those files came from `backend/scripts/soak_backtest.py`, which bypasses the
public service/worker/report path. They are lower-level kernel/SQLite
microbenchmarks and are not release evidence.
