# Replay right-side account rail design QA

Date: 2026-08-03  
Implementation URL: `http://127.0.0.1:15173/replay.html?session=0668b060d05c489b999d4e17de57ea54`  
Target viewport: 1280 × 720 CSS px, device scale factor 1, light theme

## Source and rendered truth

- Source visual truth: `I:\sys\下载\Screenshot_2026-08-03-18-41-17-721_com.okinc.oke.jpg`
- Source pixels: 1440 × 3200. The Android CSS viewport and device density are not encoded in the supplied file, so they are treated as unavailable.
- Browser-rendered open-position implementation: `C:\Users\MECHREVO\.codex\visualizations\2026\08\03\019fc737-c4a8-7a73-b680-3382472ae072\replay-ui-vertical-rail\02-open-position-rail.png`
- Browser-rendered final clean state: `C:\Users\MECHREVO\.codex\visualizations\2026\08\03\019fc737-c4a8-7a73-b680-3382472ae072\replay-ui-vertical-rail\03-final-clean-rail.png`
- Implementation pixels / CSS size: 1280 × 720 / 1280 × 720, device scale factor 1.
- Full-view same-input comparison: `H:\program\CandleScope\output\replay-ui-audit-2026-08-03\vertical-comparison\vertical-design-comparison.png` (1264 × 1198).
- Focused same-input comparison: `H:\program\CandleScope\output\replay-ui-audit-2026-08-03\vertical-comparison\vertical-focused-comparison.png` (1264 × 961).

The source is a mobile OKX position page while the implementation is a dense desktop charting workspace. Literal viewport matching would create false precision. The full-view sheet therefore fits both complete captures for composition review; the focused sheet displays the source position area at 436 px width and enlarges CandleScope's 400 px account rail to 520 px (1.3×) for readable typography, spacing, state-color, and control checks.

## Target translation

- Remove the horizontal account workbench from below the chart so the main chart retains its full vertical height.
- Put positions, current orders, order history, fills, assets, and risk into one compact right-side vertical rail.
- Preserve the OKX-inspired scan order: instrument and side, key position metrics, then close controls and account records.
- Keep replay-only truth boundaries and authoritative broker actions unchanged.

## Findings and comparison history

### Iteration 1

- [P1] Horizontal account workbench consumed chart height and split one trading task across two axes.
  - Evidence: the prior implementation kept positions and account records in a full-width bottom workbench while order entry lived in the right dock; the user's follow-up explicitly rejected that layout.
  - Fix: removed the replay `bottomPanel` composition path and mounted the account workbench under a dedicated `仓位` tab in the right market dock.
- [P1] Table-first records were too wide for the requested right-side column.
  - Evidence: positions, orders, fills, assets, and risk used horizontal table layouts that required desktop-width scanning.
  - Fix: replaced them with vertical cards, compact metric grids, short tabs (`持仓 / 当前 / 历史 / 成交 / 资产 / 风险`), and in-card actions.
- [P2] The new `仓位` outer dock tab initially lacked a sufficiently clear selected state.
  - Fix: added the same blue selected treatment and underline used by the account record tab, without changing buy/sell semantic colors.

### Iteration 2

- Post-fix full-view evidence shows the chart using the complete space above the replay control bar; no account panel remains under it.
- Focused evidence shows a coherent vertical hierarchy in the 400 px rail: account summary, record tabs, position card, metrics, size presets, partial close, and full close.
- No actionable P0, P1, or P2 difference remains for the desktop translation.

## Required fidelity surfaces

- Fonts and typography: CandleScope keeps Inter / Microsoft YaHei fallbacks and compact desktop sizing. Symbol, quantity, PnL, and action labels retain distinct optical weights; no clipping or unintended wrapping appeared at 1280 × 720.
- Spacing and layout rhythm: the account rail uses tight 8–12 px card rhythm, two-column metrics, and vertically adjacent close controls. The main chart is no longer shortened by a second horizontal work area.
- Colors and tokens: neutral account surfaces match the existing CandleScope light theme; blue communicates selection, green/red remain reserved for long/buy and short/sell semantics, and disabled/empty states remain subdued but readable.
- Image quality and asset fidelity: no OKX logos, illustrations, or product imagery were required for this structural translation. The implementation uses native text and existing application controls rather than placeholder raster or CSS-drawn substitutes.
- Copy and content: short Chinese labels fit the narrow rail. `当前`, `历史`, `成交`, `资产`, and `风险` expose the missing account functions without ambiguous abbreviations.
- Icons and affordances: existing chart-toolbar icons are unchanged; the new account interactions use semantic tabs and labeled buttons, avoiding icon-only destructive actions.
- Responsiveness and accessibility: at the verified 1280 × 720 viewport, the persistent replay controls remain visible, the account body scrolls independently, tabs expose selected semantics, form fields retain accessible names, and no horizontal overflow hides account actions.

## Functional browser evidence

- Opened a market position, selected 50%, submitted a partial close, and verified the remaining quantity changed from 0.002 BTC to 0.001 BTC.
- Submitted `市价全平` and verified `持仓 0`.
- Submitted a non-marketable 0.001 BTC limit buy at 10,000 USDT; `当前` changed to 1 and rendered a compact order card.
- Canceled the order; `当前` returned to 0 and `历史` showed the order as `已撤销`.
- Opened `资产` and `风险` and verified account-equity, margin, fidelity, and liquidation-domain content in the vertical rail.
- Final replay state: 0 positions and 0 current orders.
- Browser console during the exercised flow: 0 warnings and 0 errors.

## Automated verification

- `npm run typecheck`: passed.
- Focused ESLint for the changed replay/layout files: passed.
- Full `npm run test:replay`: 302/302 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm run check:architecture`: four pre-existing `lightweight-charts` boundary violations remain in HEAD; this implementation added none.

## Follow-up polish

- [P3] At widths below the verified desktop target, a collapsible icon-only mode for the six account tabs could preserve more horizontal room; it is not needed at 1280 × 720.

Final result: passed
