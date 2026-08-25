# First-open /strategy.html capture (2026-08-25)

Shipped tests render the unified app:

- `/strategy.html` first paint includes three templates (`SMA_CROSS`, `RSI_REVERSAL`, `DONCHIAN_BREAKOUT`), import CTA when the library flag is on, and a source bar. The script slot is no longer `max-height: 0`.
- `/strategy.html?source=current` fills `strategy-research-current-chart` with `BTCUSDT` / `1m` even when the library flag is off. Import CTA is absent.

Scratch captures: `strategy-first-open.html`, `strategy-source-current.html`, `strategy-driven-change.txt` (`driven_change=true`).

`test:research-data` 89 passed after the change.
