export default function DataWorkbenchStyles() {
  return <style>{`
.dw-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 6, 23, 0.78);
  backdrop-filter: blur(8px);
}

.dw-panel {
  width: min(1180px, 96vw);
  height: min(800px, 92vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color, #334155);
  border-radius: 16px;
  background: var(--bg-secondary, #1e293b);
  box-shadow: 0 28px 72px rgba(0, 0, 0, 0.52);
}

.dw-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 26px 18px;
  border-bottom: 1px solid var(--border-color, #334155);
}

.dw-kicker { color: #60a5fa; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.dw-title { margin: 4px 0 5px; color: var(--text-primary, #f1f5f9); font-size: 21px; line-height: 1.2; }
.dw-subtitle { margin: 0; color: var(--text-secondary, #94a3b8); font-size: 12.5px; line-height: 1.5; }
.dw-close { border: 0; border-radius: 8px; background: transparent; color: var(--text-muted, #64748b); cursor: pointer; font-size: 20px; line-height: 1; padding: 7px 9px; }
.dw-close:hover { background: rgba(255, 255, 255, .06); color: var(--text-primary, #f1f5f9); }

.dw-body { flex: 1; overflow: auto; padding: 20px 26px 32px; }
.dw-body::-webkit-scrollbar { width: 7px; }
.dw-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .12); border-radius: 8px; }
.dw-section, .dw-filter-card { margin-bottom: 18px; padding: 16px; border: 1px solid rgba(255, 255, 255, .08); border-radius: 12px; background: rgba(15, 23, 42, .28); }
.dw-filter-card { border-color: rgba(59, 130, 246, .22); background: rgba(30, 64, 175, .08); }
.dw-filter-title-row, .dw-section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.dw-filter-title-row h3, .dw-section-heading h3 { margin: 0; color: var(--text-primary, #f1f5f9); font-size: 14px; }
.dw-filter-title-row p, .dw-section-heading p { margin: 5px 0 0; color: var(--text-muted, #64748b); font-size: 11.5px; line-height: 1.45; }
.dw-live-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.dw-badge { display: inline-flex; align-items: center; white-space: nowrap; border: 1px solid transparent; border-radius: 999px; padding: 3px 8px; font-size: 10px; font-weight: 700; }
.dw-badge-live { color: #86efac; background: rgba(34, 197, 94, .1); border-color: rgba(34, 197, 94, .25); }
.dw-badge-readonly { color: #93c5fd; background: rgba(59, 130, 246, .1); border-color: rgba(59, 130, 246, .25); }
.dw-badge-ok { color: #86efac; background: rgba(34, 197, 94, .1); border-color: rgba(34, 197, 94, .25); }
.dw-badge-warning { color: #fcd34d; background: rgba(245, 158, 11, .1); border-color: rgba(245, 158, 11, .25); }
.dw-badge-error { color: #fca5a5; background: rgba(239, 68, 68, .1); border-color: rgba(239, 68, 68, .25); }

.dw-filter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 15px; }
.dw-filter-grid label { display: grid; gap: 6px; min-width: 0; }
.dw-filter-grid label > span { color: var(--text-muted, #64748b); font-size: 10.5px; font-weight: 700; }
.dw-filter-grid input, .dw-filter-grid select { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--border-color, #334155); border-radius: 7px; background: var(--bg-tertiary, #1a2332); color: var(--text-primary, #f1f5f9); font: inherit; font-size: 12.5px; padding: 8px 10px; outline: none; }
.dw-filter-grid input:focus, .dw-filter-grid select:focus { border-color: #3b82f6; }
.dw-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.dw-button { border: 1px solid transparent; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 700; padding: 8px 12px; }
.dw-button:disabled { cursor: not-allowed; opacity: .5; }
.dw-button-secondary { border-color: var(--border-color, #334155); background: var(--bg-tertiary, #1a2332); color: var(--text-secondary, #cbd5e1); }
.dw-button-secondary:hover:not(:disabled) { border-color: #60a5fa; color: #bfdbfe; }
.dw-button-primary { border-color: #2563eb; background: #2563eb; color: white; }
.dw-button-primary:hover:not(:disabled) { background: #1d4ed8; }

.dw-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; margin-top: 13px; }
.dw-stat-card { display: flex; min-width: 0; flex-direction: column; gap: 4px; padding: 11px; border: 1px solid rgba(255, 255, 255, .07); border-radius: 8px; background: rgba(255, 255, 255, .025); }
.dw-stat-card span, .dw-stat-card small { color: var(--text-muted, #64748b); font-size: 10.5px; }
.dw-stat-card strong { overflow-wrap: anywhere; color: var(--text-primary, #f1f5f9); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 15px; }
.dw-notice, .dw-empty { margin-top: 12px; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; }
.dw-notice-warning { border: 1px solid rgba(245, 158, 11, .23); background: rgba(245, 158, 11, .07); color: #fcd34d; }
.dw-notice-error { border: 1px solid rgba(239, 68, 68, .23); background: rgba(239, 68, 68, .07); color: #fca5a5; }
.dw-empty { border: 1px dashed rgba(255, 255, 255, .12); color: var(--text-muted, #64748b); text-align: center; }

.dw-integrity-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin-top: 13px; }
.dw-integrity-grid > div { display: grid; gap: 5px; min-width: 0; padding: 10px; border-radius: 8px; background: rgba(255, 255, 255, .025); }
.dw-integrity-grid span { color: var(--text-muted, #64748b); font-size: 10.5px; }
.dw-integrity-grid strong { color: var(--text-secondary, #cbd5e1); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.dw-gap-list { margin-top: 12px; overflow: hidden; border: 1px solid rgba(245, 158, 11, .16); border-radius: 8px; }
.dw-gap-row { display: grid; grid-template-columns: minmax(130px, 1.5fr) 90px 130px minmax(150px, 1fr); align-items: center; gap: 10px; padding: 9px 11px; color: var(--text-secondary, #cbd5e1); font-size: 11.5px; }
.dw-gap-row + .dw-gap-row { border-top: 1px solid rgba(255, 255, 255, .06); }
.dw-gap-row > div { display: grid; gap: 2px; min-width: 0; }
.dw-gap-row strong { color: var(--text-primary, #f1f5f9); font-family: var(--font-mono, 'JetBrains Mono', monospace); }
.dw-gap-row small, .dw-gap-row span { overflow-wrap: anywhere; color: var(--text-muted, #64748b); }
.dw-gap-more { padding: 9px 11px; border-top: 1px solid rgba(255, 255, 255, .06); color: #fcd34d; font-size: 11px; }

.dw-result-count { color: var(--text-muted, #64748b); font-size: 11px; white-space: nowrap; }
.dw-table { margin-top: 13px; overflow: hidden; border: 1px solid rgba(255, 255, 255, .08); border-radius: 8px; }
.dw-table-head, .dw-table-row { display: grid; grid-template-columns: minmax(190px, 1.4fr) 70px 90px minmax(130px, 1fr) minmax(130px, 1fr); align-items: center; gap: 10px; padding: 9px 11px; }
.dw-table-head { background: rgba(255, 255, 255, .03); color: var(--text-muted, #64748b); font-size: 10.5px; font-weight: 700; }
.dw-table-row { color: var(--text-secondary, #cbd5e1); font-size: 11.5px; }
.dw-table-row + .dw-table-row { border-top: 1px solid rgba(255, 255, 255, .06); }
.dw-table-row:hover { background: rgba(255, 255, 255, .025); }
.dw-series-name { display: grid; min-width: 0; gap: 3px; }
.dw-series-name strong { overflow-wrap: anywhere; color: var(--text-primary, #f1f5f9); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; }
.dw-series-name small { color: var(--text-muted, #64748b); font-size: 10px; }
.dw-mono { color: #bfdbfe; font-family: var(--font-mono, 'JetBrains Mono', monospace); }

@media (max-width: 780px) {
  .dw-overlay { padding: 10px; }
  .dw-panel { width: 100%; height: 94vh; }
  .dw-header, .dw-body { padding-left: 16px; padding-right: 16px; }
  .dw-filter-grid, .dw-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dw-integrity-grid { grid-template-columns: 1fr; }
  .dw-gap-row { grid-template-columns: 1fr 1fr; }
  .dw-table { overflow-x: auto; }
  .dw-table-head, .dw-table-row { min-width: 690px; }
}

@media (max-width: 520px) {
  .dw-header { gap: 10px; padding-top: 17px; padding-bottom: 14px; }
  .dw-title { font-size: 18px; }
  .dw-filter-grid, .dw-stat-grid { grid-template-columns: 1fr; }
  .dw-actions { flex-direction: column-reverse; }
  .dw-button { width: 100%; }
}
  `}</style>;
}
