# First-open /strategy.html acceptance (2026-08-25)

- `/strategy.html` first paint includes three templates (`SMA_CROSS`, `RSI_REVERSAL`, `DONCHIAN_BREAKOUT`), an import action when the library flag is enabled, and a visible script slot.
- `/strategy.html?source=current` never fabricates an exchange, symbol, interval, bar count, or snapshot. Because the full-screen workspace does not own the market chart session, it presents an unbound explanation and an action back to the live market page.
- On `/`, the chart-first tester binds the actual `ChartSession`. The observed browser run used `BTCUSDT · 1h` with 1501 loaded bars; these values came from the active chart and are not strategy-workspace defaults.
- Imported data can be viewed without a Run. Running freezes the immutable source through the backend and displays the completed report.
- Ordinary first-open copy does not expose internal dataset IDs or snapshot hashes.

Automated coverage: `test:research-data` 93 passed, including the current-source non-fabrication and StrictMode lifecycle contracts.

Browser evidence:

- `strategy-research-unification-phase-12/strategy-imported-completed.png`
- `strategy-research-unification-phase-12/live-current-chart-tester.png`
