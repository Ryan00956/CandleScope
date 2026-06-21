# Compatibility

Pyne Runtime is currently pre-1.0.

Compatibility goals:

- Patch versions should not break public root imports.
- Minor versions may add new public APIs.
- Breaking changes should be documented in `CHANGELOG.md`.
- `pn.__version__` follows the installed package version.

Stable root imports are documented in [Public API](../api/public_api.md).
The detailed Pine-like feature matrix lives in
[Pine-Like API Matrix](pine_like_api_matrix.md).

The output schema has its own version: `PYNE_OUTPUT_SCHEMA_VERSION`.
Script parameter schemas have their own version:
`PYNE_PARAM_SCHEMA_VERSION`.
The host request-provider contract has its own version:
`PYNE_REQUEST_PROVIDER_SCHEMA_VERSION`.
Schema migration policy and breaking-change requirements are documented in
[Schema Migrations](schema_migrations.md).
Release versioning and release-candidate checks are documented in
[Release Process](release_process.md).

## Pine-Like Surface

Supported:

- `close[1]` and other non-negative bars-back history references.
- `na`, `nz()`, `when()`, and `switch()` helpers for Python-friendly series logic.
- `bar_index`, `last_bar_index`, and `barstate.*` in batch execution.
- `var()` / `pyne.var()` state cells.
- `line` and `label` drawing object handles.
- `box` and `table` drawing object handles.
- `request.security()` for host-backed OHLCV field requests and callable expression thunks.
- `request.security_lower_tf()` for host-backed lower-timeframe grouping.
- `strategy.entry_when()` and `strategy.close_when()` event output.
- `strategy.exit()` stop/limit event output.

Known differences:

- Pyne scripts are Python, not TradingView Pine source code.
- Python `if` cannot branch directly on a series; use `when()` or `switch()`.
- `request.security()` cannot capture already evaluated Python expressions such
  as `ta.ema(close, 20)`; use `lambda ctx: ctx.ta.ema(ctx.close, 20)`.
- Higher-timeframe `request.security()` confirmation alignment is covered by a
  TradingView-backed HTF capture parity fixture.
- `request.security_lower_tf()` returns grouped Python/Pyne objects rather than
  Pine native arrays. Higher-timeframe gaps/lookahead alignment and
  lower-timeframe grouping behavior are covered by golden-style fixtures in
  `tests/golden/`.
- Request provider diagnostics distinguish legal empty provider results from
  ignored invalid symbols: legal `[]` results are successful cached contexts,
  while `PyneInvalidSymbolError` converted by `ignore_invalid_symbol=True`
  returns empty output without populating the provider cache.
- Strategy support emits deterministic events and a lightweight position
  timeline; it is not a full broker simulator and does not model a complete
  intrabar path or broker liquidation.
