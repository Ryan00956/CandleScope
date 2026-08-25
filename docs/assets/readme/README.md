# CandleScope README Visual Assets

This directory is reserved for final, repository-owned README screenshots.
Both root README files reference the same images so the English and Chinese
product pages stay visually consistent.

## Required Images

| File | Purpose | Recommended capture |
|---|---|---|
| `hero-live-workspace.png` | README hero | 1600 × 1000, dark theme, populated four-chart workspace |
| `live-order-flow.png` | Live analysis | One strong chart with order book, trades, distribution, CVD, and volume delta |
| `multi-chart-workspace.png` | Workspace feature | Four populated charts with different intervals and visible linking |
| `replay-training.png` | Replay feature | Active training run with virtual clock, chart, paper orders, positions, and controls |
| `pyne-indicator.png` | Extensibility feature | Pyne editor beside the indicator rendered on the chart |
| `backtest-research.png` | Quant research beta | Completed run with equity, drawdown, metrics, trades, provenance, and Study/OOS context |

## Capture Checklist

- Use one consistent 16:10 viewport, preferably 1600 × 1000.
- Use the dark theme for the hero and keep theme treatment consistent across
  the remaining tour unless a deliberate light/dark comparison is needed.
- Wait for historical data and realtime surfaces to be fully populated.
- Remove loading states, errors, debug labels, test fixtures, and unrelated
  notification badges.
- Use realistic but non-sensitive market data and local paper-training state.
- When capturing the backtest surface, keep its visible “local beta” status and
  provenance/fidelity disclosure in frame; do not imply that it is default-on.
- Do not include browser chrome, desktop wallpaper, terminal windows, or
  personal paths.
- Preserve readable product text at GitHub's normal README width.
- Optimize PNG files after capture without resizing or introducing blur.

## Publishing

Each screenshot location in `README.md` and `README_zh.md` is stored as an
HTML comment. After adding and reviewing an image:

1. Confirm its filename matches the table above.
2. Open the file locally and check the full-resolution crop.
3. Remove only the surrounding comment markers for that image block in both
   root README files.
4. Render the README on GitHub or an equivalent Markdown preview and verify
   that every image loads with useful alt text.

The README uses the canonical responsive lockups from `frontend/public/brand/`:

- `candlescope-lockup.svg` on light backgrounds
- `candlescope-lockup-on-dark.svg` when the viewer prefers a dark color scheme

Do not duplicate those brand assets into this screenshot directory.
