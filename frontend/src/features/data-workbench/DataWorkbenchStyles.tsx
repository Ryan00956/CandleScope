export default function DataWorkbenchStyles() {
  return <style>{`
.dw-overlay {
  --dw-ink: var(--text-primary, #e2e8f0);
  --dw-label: #cbd5e1;
  --dw-subtle: #94a3b8;
  --dw-card-bg: var(--bg-tertiary, #1a2332);
  --dw-card-border: color-mix(in srgb, var(--border-color, #334155) 72%, #94a3b8);
  --dw-inset-bg: color-mix(in srgb, var(--bg-primary, #0a0e17) 62%, var(--bg-tertiary, #1a2332));
  --dw-chip-bg: color-mix(in srgb, var(--accent-blue, #3b82f6) 20%, transparent);
  --dw-chip-fg: #bfdbfe;
  --dw-ok: #34d399;
  --dw-ok-bg: rgba(52, 211, 153, 0.16);
  --dw-warn: #fbbf24;
  --dw-warn-bg: rgba(251, 191, 36, 0.14);
  --dw-fail: #f87171;
  --dw-fail-bg: rgba(248, 113, 113, 0.16);
  --dw-info: #93c5fd;
  --dw-info-bg: rgba(59, 130, 246, 0.16);
  --dw-accent: #93c5fd;
  --dw-filter-bg: color-mix(in srgb, var(--accent-blue, #3b82f6) 12%, var(--bg-tertiary, #1a2332));
  --dw-hover: color-mix(in srgb, var(--accent-blue, #3b82f6) 8%, transparent);
  --dw-overlay-bg: rgba(2, 6, 23, 0.72);
  --dw-scroll: color-mix(in srgb, var(--dw-ink) 22%, transparent);
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dw-overlay-bg);
  backdrop-filter: blur(8px);
}

[data-theme='light'] .dw-overlay {
  --dw-ink: #0f172a;
  --dw-label: #334155;
  --dw-subtle: #475569;
  --dw-card-bg: #ffffff;
  --dw-card-border: #d8e0ea;
  --dw-inset-bg: #f8fafc;
  --dw-chip-bg: #eff6ff;
  --dw-chip-fg: #1d4ed8;
  --dw-ok: #047857;
  --dw-ok-bg: #ecfdf5;
  --dw-warn: #b45309;
  --dw-warn-bg: #fffbeb;
  --dw-fail: #b91c1c;
  --dw-fail-bg: #fef2f2;
  --dw-info: #1d4ed8;
  --dw-info-bg: #eff6ff;
  --dw-accent: #1d4ed8;
  --dw-filter-bg: #eff6ff;
  --dw-hover: color-mix(in srgb, var(--accent-blue, #3b82f6) 6%, #ffffff);
  --dw-overlay-bg: rgba(15, 23, 42, 0.45);
  --dw-scroll: color-mix(in srgb, var(--dw-ink) 18%, transparent);
}

.dw-panel {
  display: flex;
  flex-direction: column;
  width: min(1180px, 96vw);
  height: min(800px, 92vh);
  overflow: hidden;
  border: 1px solid var(--dw-card-border);
  border-radius: 16px;
  background: var(--bg-secondary, #1e293b);
  color: var(--dw-ink);
  box-shadow: 0 28px 72px rgba(15, 23, 42, 0.42);
}

.dw-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 26px 18px;
  border-bottom: 1px solid var(--dw-card-border);
}

.dw-kicker {
  color: var(--dw-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.dw-title {
  margin: 4px 0 6px;
  color: var(--dw-ink);
  font-size: 21px;
  line-height: 1.2;
}

.dw-subtitle {
  margin: 0;
  max-width: 720px;
  color: var(--dw-subtle);
  font-size: 13px;
  line-height: 1.55;
}

.dw-close {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dw-subtle);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  padding: 7px 9px;
}

.dw-close:hover {
  background: var(--dw-hover);
  color: var(--dw-ink);
}

.dw-close:focus-visible,
.dw-button:focus-visible,
.dw-fold-head:focus-visible,
.dw-instrument-head:focus-visible,
.dw-filter-grid input:focus-visible,
.dw-filter-grid select:focus-visible {
  outline: 2px solid var(--accent-blue, #3b82f6);
  outline-offset: 2px;
}

.dw-body {
  flex: 1;
  overflow: auto;
  padding: 20px 26px 32px;
}

.dw-body::-webkit-scrollbar { width: 7px; }
.dw-body::-webkit-scrollbar-thumb {
  background: var(--dw-scroll);
  border-radius: 8px;
}

.dw-section,
.dw-filter-card {
  margin-bottom: 14px;
  padding: 16px;
  border: 1px solid var(--dw-card-border);
  border-radius: 12px;
  background: var(--dw-card-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.dw-filter-card {
  padding: 14px 16px;
  border-color: color-mix(in srgb, var(--accent-blue, #3b82f6) 42%, var(--dw-card-border));
  background: var(--dw-filter-bg);
}

.dw-section.collapsed,
.dw-section.expanded {
  padding: 0;
}

.dw-filter-title-row,
.dw-section-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.dw-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 14px;
}

.dw-summary-chip {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dw-card-border);
  border-radius: 10px;
  background: var(--dw-card-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.dw-summary-chip span,
.dw-summary-chip strong {
  display: block;
}

.dw-summary-chip span {
  margin-bottom: 4px;
  color: var(--dw-label);
  font-size: 11px;
  font-weight: 650;
}

.dw-summary-chip strong {
  overflow: hidden;
  color: var(--dw-ink);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dw-summary-chip.warning strong {
  color: var(--dw-warn);
}

.dw-fold-head {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: var(--dw-ink);
  text-align: left;
  cursor: pointer;
}

.dw-fold-head:hover {
  background: var(--dw-hover);
}

.dw-fold-disclosure {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dw-ink) 8%, transparent);
  color: var(--dw-label);
}

.dw-fold-chevron {
  display: block;
  font-size: 13px;
  line-height: 1;
  transform-origin: 50% 55%;
  transition: transform 0.15s ease;
}

.dw-section.expanded > .dw-fold-head .dw-fold-disclosure {
  background: color-mix(in srgb, var(--accent-blue, #3b82f6) 18%, transparent);
  color: var(--accent-blue, #3b82f6);
}

.dw-section.expanded > .dw-fold-head .dw-fold-chevron {
  transform: rotate(90deg);
}

.dw-fold-copy {
  min-width: 0;
}

.dw-fold-copy h3 {
  margin: 0;
  color: var(--dw-ink);
  font-size: 14px;
}

.dw-fold-copy p {
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--dw-subtle);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dw-fold-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dw-fold-hint {
  color: var(--dw-subtle);
  font-size: 11px;
  font-weight: 650;
}

.dw-fold-body {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--dw-card-border);
}

.dw-fold-body > .dw-stat-grid,
.dw-fold-body > .dw-integrity-grid {
  margin-top: 0;
}

.dw-fold-body > * + .dw-notice,
.dw-fold-body > * + .dw-gap-list,
.dw-fold-body > * + .dw-empty {
  margin-top: 12px;
}

.dw-filter-title-row h3,
.dw-section-heading h3 {
  margin: 0;
  color: var(--dw-ink);
  font-size: 14px;
}

.dw-filter-title-row p,
.dw-section-heading p {
  margin: 5px 0 0;
  color: var(--dw-subtle);
  font-size: 12px;
  line-height: 1.5;
}

.dw-live-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.dw-badge {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 11px;
  font-weight: 700;
}

.dw-badge-live,
.dw-badge-ok {
  color: var(--dw-ok);
  background: var(--dw-ok-bg);
  border-color: color-mix(in srgb, var(--dw-ok) 32%, transparent);
}

.dw-badge-readonly {
  color: var(--dw-info);
  background: var(--dw-info-bg);
  border-color: color-mix(in srgb, var(--dw-info) 28%, transparent);
}

.dw-badge-warning {
  color: var(--dw-warn);
  background: var(--dw-warn-bg);
  border-color: color-mix(in srgb, var(--dw-warn) 32%, transparent);
}

.dw-badge-error {
  color: var(--dw-fail);
  background: var(--dw-fail-bg);
  border-color: color-mix(in srgb, var(--dw-fail) 32%, transparent);
}

.dw-filter-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.dw-filter-grid label {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.dw-filter-grid label > span {
  color: var(--dw-label);
  font-size: 11px;
  font-weight: 700;
}

.dw-filter-grid input,
.dw-filter-grid select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--dw-card-border);
  border-radius: 8px;
  background: var(--dw-card-bg);
  color: var(--dw-ink);
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
}

.dw-filter-grid input:focus,
.dw-filter-grid select:focus {
  border-color: var(--accent-blue, #3b82f6);
}

.dw-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.dw-button {
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 700;
  padding: 8px 12px;
}

.dw-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.dw-button-secondary {
  border-color: var(--dw-card-border);
  background: var(--dw-card-bg);
  color: var(--dw-label);
}

.dw-button-secondary:hover:not(:disabled) {
  border-color: var(--accent-blue, #3b82f6);
  color: var(--dw-accent);
}

.dw-button-primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #ffffff;
}

.dw-button-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.dw-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
  margin-top: 13px;
}

.dw-stat-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--dw-card-border);
  border-radius: 10px;
  background: var(--dw-inset-bg);
}

.dw-stat-card span,
.dw-stat-card small {
  color: var(--dw-label);
  font-size: 11px;
  line-height: 1.4;
}

.dw-stat-card strong {
  overflow-wrap: anywhere;
  color: var(--dw-ink);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 16px;
  font-weight: 700;
}

.dw-notice,
.dw-empty {
  margin-top: 12px;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.5;
}

.dw-notice-warning {
  border: 1px solid color-mix(in srgb, var(--dw-warn) 35%, var(--dw-card-border));
  background: var(--dw-warn-bg);
  color: var(--dw-warn);
}

.dw-notice-error {
  border: 1px solid color-mix(in srgb, var(--dw-fail) 35%, var(--dw-card-border));
  background: var(--dw-fail-bg);
  color: var(--dw-fail);
}

.dw-empty {
  border: 1px dashed var(--dw-card-border);
  color: var(--dw-subtle);
  text-align: center;
}

.dw-integrity-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 13px;
}

.dw-integrity-grid > div {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--dw-card-border);
  border-radius: 10px;
  background: var(--dw-inset-bg);
}

.dw-integrity-grid span {
  color: var(--dw-label);
  font-size: 11px;
  font-weight: 650;
}

.dw-integrity-grid strong {
  color: var(--dw-ink);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.dw-gap-list {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--dw-warn) 32%, var(--dw-card-border));
  border-radius: 10px;
  background: var(--dw-card-bg);
}

.dw-gap-row {
  display: grid;
  grid-template-columns: minmax(130px, 1.5fr) 90px 130px minmax(150px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  color: var(--dw-label);
  font-size: 12px;
}

.dw-gap-row + .dw-gap-row {
  border-top: 1px solid var(--dw-card-border);
}

.dw-gap-row > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.dw-gap-row strong {
  color: var(--dw-ink);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.dw-gap-row small,
.dw-gap-row span {
  overflow-wrap: anywhere;
  color: var(--dw-subtle);
}

.dw-gap-more {
  padding: 10px 12px;
  border-top: 1px solid var(--dw-card-border);
  color: var(--dw-warn);
  font-size: 12px;
}

.dw-result-count {
  color: var(--dw-subtle);
  font-size: 12px;
  white-space: nowrap;
}

.dw-instrument-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 13px;
}

.dw-instrument {
  overflow: hidden;
  border: 1px solid var(--dw-card-border);
  border-radius: 10px;
  background: var(--dw-inset-bg);
}

.dw-gap-list .dw-instrument {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.dw-gap-list .dw-instrument + .dw-instrument {
  border-top: 1px solid var(--dw-card-border);
}

.dw-instrument-head {
  display: grid;
  grid-template-columns: 24px minmax(110px, 0.85fr) minmax(0, 1.5fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--dw-ink);
  text-align: left;
  cursor: pointer;
}

.dw-instrument-head.static {
  cursor: default;
}

.dw-instrument-head:not(.static):hover {
  background: var(--dw-hover);
}

.dw-fold-disclosure.spacer {
  background: transparent;
}

.dw-instrument.expanded .dw-fold-disclosure {
  background: color-mix(in srgb, var(--accent-blue, #3b82f6) 18%, transparent);
  color: var(--accent-blue, #3b82f6);
}

.dw-instrument.expanded .dw-fold-chevron {
  transform: rotate(90deg);
}

.dw-interval-chips {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 5px;
}

.dw-chip {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--dw-chip-bg);
  color: var(--dw-chip-fg);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.3;
}

.dw-chip.muted {
  background: color-mix(in srgb, var(--dw-subtle) 16%, transparent);
  color: var(--dw-subtle);
}

.dw-instrument-stats,
.dw-instrument-dates {
  color: var(--dw-subtle);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}

.dw-instrument-detail {
  border-top: 1px solid var(--dw-card-border);
}

.dw-interval-row {
  display: grid;
  grid-template-columns: 24px 72px minmax(90px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--dw-label);
  font-size: 12px;
}

.dw-interval-row + .dw-interval-row {
  border-top: 1px solid var(--dw-card-border);
}

.dw-interval-row .dw-mono {
  grid-column: 2;
}

.dw-series-name {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.dw-series-name strong {
  overflow-wrap: anywhere;
  color: var(--dw-ink);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12.5px;
}

.dw-series-name small {
  color: var(--dw-subtle);
  font-size: 11px;
}

.dw-mono {
  color: var(--dw-chip-fg);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-weight: 650;
}

.dw-manual {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
  margin: 0 0 14px;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--accent-blue, #3b82f6) 38%, var(--dw-card-border));
  border-radius: 12px;
  background: linear-gradient(145deg, var(--dw-filter-bg), var(--dw-card-bg));
}

.dw-manual > h3,
.dw-manual > p,
.dw-manual > fieldset,
.dw-manual > [data-testid='manual-history-plan-summary'],
.dw-manual > [data-testid='manual-history-polling'],
.dw-manual > [data-testid='manual-history-error'],
.dw-manual > [data-testid='manual-history-recent-jobs'],
.dw-manual > [data-testid='manual-history-collections'],
.dw-manual > div:has([data-testid='manual-history-job-state']) {
  grid-column: 1 / -1;
}

.dw-manual > h3 {
  margin: 0;
  color: var(--dw-ink);
  font-size: 16px;
}

.dw-manual > p {
  margin: 0;
  color: var(--dw-subtle);
  font-size: 12px;
  line-height: 1.5;
}

.dw-manual > label {
  display: grid;
  gap: 7px;
  color: var(--dw-label);
  font-size: 12px;
  font-weight: 650;
}

.dw-manual textarea,
.dw-manual input:not([type='checkbox']),
.dw-manual select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dw-card-border);
  border-radius: 8px;
  background: var(--dw-inset-bg);
  color: var(--dw-ink);
  font: inherit;
  padding: 8px 10px;
}

.dw-manual textarea {
  min-height: 68px;
  resize: vertical;
}

.dw-manual fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 12px;
  margin: 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--dw-card-border);
  border-radius: 9px;
  color: var(--dw-label);
}

.dw-manual fieldset label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.dw-manual h4 {
  margin: 0 0 8px;
  color: var(--dw-ink);
  font-size: 13px;
}

.dw-manual ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.dw-manual li {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dw-inset-bg);
  color: var(--dw-label);
  font-size: 12px;
  line-height: 1.45;
}

.dw-manual [data-tone='success'] { color: var(--dw-ok); }
.dw-manual [data-tone='warning'] { color: var(--dw-warn); }
.dw-manual [data-tone='danger'],
.dw-manual [data-testid='manual-history-error'] { color: var(--dw-fail); }

.dw-manual-release {
  width: auto;
  margin-left: 10px;
  padding: 5px 8px;
  font-size: 11px;
}

.dw-manual-disabled {
  display: block;
  color: var(--dw-subtle);
  font-size: 12px;
}

@media (max-width: 780px) {
  .dw-overlay { padding: 10px; }
  .dw-panel { width: 100%; height: 94vh; }
  .dw-header, .dw-body { padding-left: 16px; padding-right: 16px; }
  .dw-filter-grid, .dw-stat-grid, .dw-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dw-fold-hint { display: none; }
  .dw-fold-copy p { white-space: normal; }
  .dw-integrity-grid { grid-template-columns: 1fr; }
  .dw-gap-row { grid-template-columns: 1fr 1fr; }
  .dw-instrument-head {
    grid-template-columns: 24px minmax(0, 1fr);
    grid-template-areas:
      "disc identity"
      "disc chips"
      "disc stats";
  }
  .dw-instrument-head .dw-fold-disclosure { grid-area: disc; }
  .dw-instrument-head .dw-series-name { grid-area: identity; }
  .dw-instrument-head .dw-interval-chips { grid-area: chips; }
  .dw-instrument-head .dw-instrument-stats { grid-area: stats; }
  .dw-instrument-dates { display: none; }
  .dw-interval-row {
    grid-template-columns: 24px 64px minmax(0, 1fr);
  }
  .dw-interval-row span:nth-child(n + 3) { grid-column: 2 / -1; }
  .dw-manual { grid-template-columns: 1fr; }
  .dw-manual > * { grid-column: 1; }
}

@media (max-width: 520px) {
  .dw-header { gap: 10px; padding-top: 17px; padding-bottom: 14px; }
  .dw-title { font-size: 18px; }
  .dw-filter-grid, .dw-stat-grid, .dw-summary { grid-template-columns: 1fr; }
  .dw-actions { flex-direction: column-reverse; }
  .dw-button { width: 100%; }
}
  `}</style>;
}
