# Chart-first Strategy Tester — Phase 4 Design QA

- date: 2026-08-24
- source first-open visual: `H:\program\CandleScope-backtest-chart-first\docs\assets\backtest-chart-first-phase0\visual-first-1440x900.png`
- source error visual: `H:\program\CandleScope-backtest-chart-first\docs\assets\backtest-chart-first-phase0\visual-error-1440x900.png`
- implementation route: live market page with `VITE_CHART_STRATEGY_TESTER_ENABLED=1`
- implementation first-open capture: `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\phase4-first-open-1440x900.png`
- implementation error capture: `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\phase4-script-error-1440x900.png`
- compact viewport capture: `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\phase4-first-open-1366x768.png`
- viewport: 1440 x 900 CSS px for both approved-source comparisons
- source pixels: 1440 x 900
- implementation pixels: 1440 x 900
- density normalization: 1:1 CSS-pixel and image-pixel comparison
- states: ordinary-mode first open and script error

## Full-view comparison evidence

The approved source and browser implementation were placed in the same comparison images:

- `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\qa-first-source-vs-implementation.png`
- `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\qa-error-source-vs-implementation.png`

Both implementation captures use the same 1440 x 900 viewport and the same BTCUSDT 1m chart context as their approved source. Live market bars and prices differ because the browser used the current backend stream; this does not change the Phase 4 component geometry or state.

## Focused region comparison evidence

The chart/panel boundary, panel header, tabs, primary action, first-start cards, Monaco editor, and problem panel were also compared together at original scale:

- `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\qa-first-panel-crop.png`
- `H:\program\CandleScope-backtest-chart-first\docs\evidence\backtest-chart-first-phase4\qa-error-panel-crop.png`

The implementation matches the approved information hierarchy, dimensions, spacing rhythm, border treatment, typography scale, color tokens, copy, and control placement. Monaco supplies real syntax coloring and diagnostics instead of the source mock's simplified editor rendering; the diagnostic remains visibly bound to line 8, column 19 and the problem explanation.

## Primary interactions and runtime checks

Browser-verified in headed Chrome through the repository-local Playwright CLI:

- exactly three first-start actions; no empty Monaco and no editor resources before a real script is selected;
- template, recent-script, and paste transitions;
- delayed Monaco loading, edit, autosave, cursor restore after reload, and error-location focus;
- honest save failure, retained in-memory draft, visible retry, and successful persistence after retry;
- Run button and `Ctrl/Cmd+Enter` equivalence without inserting a newline;
- four tabs and their honest Phase 4 placeholders;
- pointer and keyboard panel resize;
- Close and Escape both restore focus to the active chart's strategy entry;
- four-cell active ownership, cell-local attachments, and maximized-cell ownership;
- 1366 x 768 has no horizontal or vertical document overflow and retains visible chart and close action;
- flag-off production build has no entry or panel DOM and loads no ChartStrategy, StrategyScript, vendor-editor, or Monaco resources;
- final browser console: 0 errors and 0 warnings.

## Findings

No actionable P0, P1, or P2 visual findings remain.

Accepted live-only differences:

- current bars, prices, and order-book connection text differ from the frozen source captures;
- Monaco's production syntax highlighting and overview-ruler marker are richer than the static approved mock;
- the Phase 0 review badge is evidence annotation and is not part of the production UI.

## Required fidelity surfaces

- Fonts and typography: passed.
- Spacing and layout rhythm: passed.
- Colors and visual tokens: passed.
- Image and asset fidelity: passed; Phase 4 introduces no replacement raster asset and reuses the product chart/icon surfaces.
- Copy and content: passed in the visible Chinese state and catalog parity checks.
- Responsive behavior: passed at 1440 x 900 and 1366 x 768.

## Comparison history

1. Initial in-app Browser attempt: blocked by its local-URL policy; no visual claim made.
2. First repository-local Chrome pass: found premature `vendor-editor` preload and a Monaco `Ctrl/Cmd+Enter` conflict; both were fixed and rebuilt.
3. Interaction pass: found Close/Escape focus returning to `body` after the top bar remounted; focus restoration was changed to target the current cell entry after React commit and reverified.
4. Final same-viewport pass: approved source and implementation were compared together for first-open and script-error states; no P0/P1/P2 visual finding remained.

final result: passed
