# Unified free-scroll accordion right rail design QA

Date: 2026-08-13

Implementation URL: `http://127.0.0.1:15173/`

Target viewport: 1280 × 720 CSS px, light theme

## Source and rendered truth

- Source visual truth: `C:\Users\MECHREVO\.codex\generated_images\019ffae0-4304-7272-8286-283c4e6a027e\exec-b4b7660d-59f6-43d3-8b20-350c7cdf82ee.png`.
- Source pixels: 1672 × 941. It is a desktop design target rather than a browser capture, so CSS size and source density are unavailable.
- Browser-rendered implementation: `C:\Users\MECHREVO\.codex\visualizations\2026\08\13\019ffae0-4304-7272-8286-283c4e6a027e\candlescope-free-scroll-accordion\final-live-1280x720.png`.
- Implementation CSS viewport: 1280 × 720; browser devicePixelRatio: 1.5; captured pixels: 1280 × 720 because the in-app browser capture is normalized to CSS pixel dimensions.
- Full-view same-input comparison: `C:\Users\MECHREVO\.codex\visualizations\2026\08\13\019ffae0-4304-7272-8286-283c4e6a027e\candlescope-free-scroll-accordion\comparison-source-vs-live.png`.
- Focused right-rail comparison: `C:\Users\MECHREVO\.codex\visualizations\2026\08\13\019ffae0-4304-7272-8286-283c4e6a027e\candlescope-free-scroll-accordion\comparison-right-rail-focus.png`.
- Density normalization: the source was scaled to 1280 × 720 with Lanczos filtering; the normalized 1280 × 720 implementation capture was kept unchanged before comparison.

## Verified state

- Live rail at 1280 × 720 with watchlist collapsed and order book, tape, and profile expanded simultaneously.
- One shared `MarketRightRailFrame` owns the live and replay accordion; there is no live/replay layout branch.
- Each expanded view owns one height separator. Changing a view height grows or shrinks only that view and changes the outer rail scroll length.
- All collapsed views remain available as 36 px summary headers.

## Findings and comparison history

### Iteration 1

- [P1] The previous stacked height allocator redistributed one fixed viewport among open views, so opening more cards compressed every sibling.
  - Evidence: the pre-change implementation capture showed several right-rail surfaces competing for the same fixed height, while the source target showed independent modules inside a scrolling rail.
  - Fix: removed `allocateRailViewHeights` and `orderedOpenViews`; replaced the shared frame with one free multi-open accordion whose sections have independent persisted heights and whose parent owns vertical scrolling.
- [P1] Live and replay preferences treated an empty open set as a special rail-collapse layout.
  - Fix: separated whole-rail visibility from per-section expansion. An empty open set now leaves useful collapsed headers visible, and `panelCollapsed` remains independently restorable in both runtimes.
- [P2] Nested order-book and trade-flow scrollers could retain wheel input and make the outer rail feel stuck.
  - Fix: allowed wheel chaining from internal scrollers to the outer rail at their scroll boundaries while keeping outer overscroll contained.

### Iteration 2

- [P2] Initial 360 px defaults made the unified behavior correct but kept too little of the third expanded card visible at 1280 × 720.
  - Evidence: the first post-change capture showed the three 360 px market panels creating a 1372 px rail and hiding most downstream context.
  - Fix: calibrated live defaults to 220 px for order book, 220 px for tape, and 300 px for profile. Users can still expand each panel up to its existing maximum.
- Post-fix evidence: the final full-view and focused comparisons show a 36 px collapsed watchlist header, three independently expanded market modules, a visible outer scrollbar, readable activity-bar labels, and the same chart-to-rail density as the source direction.
- No actionable P0, P1, or P2 issue remains.

## Required fidelity surfaces

- Fonts and typography: existing Inter, JetBrains Mono, and Chinese fallbacks remain unchanged. The new 11 px accordion titles, 9 px summaries, and 8.5 px activity labels preserve the product's dense hierarchy without clipping or unintended wrapping.
- Spacing and layout rhythm: collapsed headers are consistently 36 px; expanded cards have independent heights and 7 px keyboard-accessible resize handles. Dividers and 6–8 px internal spacing match the existing CandleScope rail rhythm.
- Colors and visual tokens: the implementation reuses existing background, border, hover, muted-text, accent-blue, candle-up, and candle-down tokens. No new competing palette or theme branch was introduced.
- Image quality and asset fidelity: the design uses existing application icons and chart assets. No new raster asset, placeholder, emoji, handcrafted SVG substitute, or CSS-drawn product imagery was introduced.
- Copy and content: live labels are `自选 / 盘口 / 成交 / 分布`; replay labels are `自选 / 下单 / 仓位 / 市场 / 能力`. Collapsed summaries describe the hidden content without truncating at the verified width.
- Affordances and accessibility: activity buttons report independent pressed/expanded state; collapsed headers are full-width buttons; resize handles expose horizontal separator semantics, min/max/current values, ArrowUp/ArrowDown, Home/End, and double-click reset.

## Functional browser evidence

- All four live modules were expanded at once; toggling `成交` closed and reopened only that module while the other three remained expanded.
- Keyboard resize changed only `成交` from 360 px to 380 px; page reload preserved the new height and all expanded states.
- With a compact 220/220/300 configuration, the outer rail measured 801 px of content in a 612 px viewport, proving that cards grow total scroll length rather than stealing height from siblings.
- Repeated wheel input over the tape list moved the inner list from 0 to its maximum 1504 and then the outer rail from 0 to its maximum 189, confirming boundary scroll chaining.
- Live and replay browser console error count: 0.
- `replay.html` loaded the training hub, but the currently running backend reported `REPLAY_TRAINING_UNAVAILABLE`, so an active replay run could not be captured. Replay ownership was verified through the shared-frame DOM test and 27 replay workspace/preference tests, including empty-state collapse and independent height persistence.

## Automated verification

- `npm run typecheck`: passed.
- `npm run check:architecture`: passed with 0 active migration allowlist entries.
- `npm run lint`: passed.
- Focused rail and replay tests: 44 passed.
- Full `npm test`: passed on the final isolated run. An earlier concurrent run had one unrelated watchlist-cache worker failure; that file passed 24/24 in isolation before the final full pass.
- `npm run build`: passed.
- `git diff --check`: passed.

## Follow-up polish

- [P3] If future plugins add enough activity buttons to overflow the icon strip, a subtle activity-bar scrollbar fade could make that secondary scroll surface more discoverable.

final result: passed
