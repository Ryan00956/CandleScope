export type SettingsModalStylesProps = Record<string, never>;

export default function SettingsModalStyles(props: SettingsModalStylesProps) {
  void props;
  return (
    <style>{`

/* ═══════════════════════════════════════════════════════════
   Settings Panel — Full-page sidebar + content layout
   Inspired by VS Code / Discord settings
   ═══════════════════════════════════════════════════════════ */

.st-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(6px);
  animation: st-fade-in 0.18s ease-out;
}

@keyframes st-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes st-slide-up {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.st-panel {
  display: flex;
  width: min(960px, 92vw);
  height: min(680px, 88vh);
  background: var(--bg-secondary, #1e293b);
  color: var(--text-primary, #f1f5f9);
  border: 1px solid var(--border-color, #334155);
  border-radius: 16px;
  overflow: hidden;
  box-shadow:
    0 24px 48px rgba(0, 0, 0, 0.45),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset;
  animation: st-slide-up 0.22s ease-out;
}

/* ── Sidebar ────────────────────────────────────────────── */
.st-sidebar {
  width: 200px;
  min-width: 200px;
  background: var(--bg-primary, #0f172a);
  border-right: 1px solid var(--border-color, #334155);
  display: flex;
  flex-direction: column;
  padding: 0;
}

.st-sidebar-title {
  padding: 24px 20px 16px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: 0.02em;
}

.st-sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px;
}

.st-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.15s ease;
  text-align: left;
}

.st-nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary, #f1f5f9);
}

.st-nav-item.active {
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-blue, #3b82f6);
}

.st-nav-item:focus-visible {
  outline: 2px solid var(--accent-blue, #3b82f6);
  outline-offset: -2px;
}

.st-nav-icon {
  font-size: 16px;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
}

.st-sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--border-color, #334155);
}

.st-btn-close {
  width: 100%;
  justify-content: center;
}

/* ── Content area ───────────────────────────────────────── */
.st-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.st-content-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 28px 16px;
  border-bottom: 1px solid var(--border-color, #334155);
  flex-shrink: 0;
}

.st-content-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-close-x {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.15s;
}
.st-close-x:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary, #f1f5f9);
}

.st-content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 32px;
}

/* Custom scrollbar */
.st-content-body::-webkit-scrollbar {
  width: 6px;
}
.st-content-body::-webkit-scrollbar-track {
  background: transparent;
}
.st-content-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
.st-content-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.18);
}

/* ── Groups ─────────────────────────────────────────────── */
.st-group {
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.st-group:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.st-group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin-bottom: 4px;
}

.st-group-desc {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary, #94a3b8);
  margin-bottom: 14px;
}

html[lang="ru"] .st-group-title,
html[lang="ru"] .st-group-desc,
html[lang="ru"] .st-theme-label,
html[lang="ru"] .st-select,
html[lang="ru"] .st-preset-btn {
  overflow-wrap: break-word;
}

/* ── Theme cards ────────────────────────────────────────── */
.st-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.st-appearance-theme-grid {
  grid-template-columns: repeat(4, 1fr);
}

.st-theme-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-theme-card:hover {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
  transform: translateY(-1px);
}

.st-theme-card.active {
  border-color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.1);
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
}

.st-theme-icon {
  font-size: 22px;
}

.st-theme-label {
  font-size: 12.5px;
  font-weight: 500;
}

/* ── Preset row ─────────────────────────────────────────── */
.st-preset-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.st-preset-btn {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  font-size: 13px;
  transition: all 0.15s;
}

.st-preset-btn:hover {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
}

/* ── Colors ─────────────────────────────────────────────── */
.st-custom-colors {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.st-color-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
}

.st-color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.st-color-code {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11.5px;
  color: var(--text-muted, #64748b);
  background: rgba(255, 255, 255, 0.04);
  padding: 3px 8px;
  border-radius: 4px;
}

input[type="color"] {
  border: none;
  width: 32px;
  height: 32px;
  cursor: pointer;
  background: none;
  border-radius: 6px;
}

.st-field {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  color: var(--text-secondary, #cbd5e1);
  font-size: 12px;
  font-weight: 600;
}

/* ── Select ─────────────────────────────────────────────── */
.st-select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 8px;
  cursor: pointer;
  outline: none;
  font-size: 13px;
  transition: border-color 0.15s;
}
.st-select:focus {
  border-color: var(--accent-blue, #3b82f6);
}

.st-select-inline {
  width: auto;
  min-width: 140px;
}

/* ── Input ──────────────────────────────────────────────── */
.st-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-radius: 8px;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.st-input:focus {
  border-color: var(--accent-blue, #3b82f6);
}
.st-input::placeholder {
  color: var(--text-muted, #64748b);
  font-family: inherit;
}

/* ── Info box ───────────────────────────────────────────── */
.st-info-box {
  margin-top: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.06);
  border: 1px solid rgba(59, 130, 246, 0.15);
  font-size: 12.5px;
  color: var(--text-secondary, #94a3b8);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  line-height: 1.5;
}

.st-info-warn {
  background: rgba(234, 179, 8, 0.06);
  border-color: rgba(234, 179, 8, 0.2);
  color: #eab308;
}

.st-info-label {
  font-weight: 600;
}

.st-info-value {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── Buttons ────────────────────────────────────────────── */
.st-actions-row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.st-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.18s ease;
  flex: 1;
}

.st-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.st-btn-primary {
  background: var(--accent-blue, #3b82f6);
  color: white;
  border-color: var(--accent-blue, #3b82f6);
}
.st-btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}

.st-btn-secondary {
  background: var(--bg-tertiary, #1a2332);
  color: var(--text-primary, #f1f5f9);
  border-color: var(--border-color, #334155);
}
.st-btn-secondary:hover:not(:disabled) {
  border-color: var(--accent-blue, #3b82f6);
  color: var(--accent-blue, #3b82f6);
}

.st-btn-warn {
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.3);
}
.st-btn-warn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.5);
}

.st-btn-accent {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-blue, #3b82f6);
  border-color: rgba(59, 130, 246, 0.3);
}
.st-btn-accent:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(59, 130, 246, 0.5);
}

/* ── Preset cards (storage strategy) ────────────────────── */
.st-preset-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.st-preset-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 8px 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-preset-card:hover {
  border-color: rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
}

.st-preset-card.active {
  border-color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.08);
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.25);
}

.st-preset-icon {
  font-size: 20px;
}

.st-preset-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-preset-desc {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
  text-align: center;
  line-height: 1.4;
}

/* ── Badges (memory / db indicators) ────────────────────── */
.st-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
  letter-spacing: 0.03em;
  vertical-align: middle;
}

.st-badge-memory {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.25);
}

.st-badge-db {
  background: rgba(59, 130, 246, 0.12);
  color: #93c5fd;
  border: 1px solid rgba(59, 130, 246, 0.25);
}

[data-theme='light'] .st-badge-memory {
  background: #f5f3ff;
  color: #6d28d9;
  border-color: #ddd6fe;
}

[data-theme='light'] .st-badge-db {
  background: #eff6ff;
  color: #1d4ed8;
  border-color: #bfdbfe;
}

[data-theme='light'] .st-btn-accent {
  background: #2563eb;
  color: #ffffff;
  border-color: #2563eb;
}

[data-theme='light'] .st-btn-accent:hover:not(:disabled) {
  background: #1d4ed8;
  border-color: #1d4ed8;
}

/* ── Ephemeral cache option cards ───────────────────────── */
.st-ephemeral-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.st-ephemeral-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 8px 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.st-ephemeral-card:hover {
  border-color: rgba(168, 85, 247, 0.35);
  transform: translateY(-1px);
}

.st-ephemeral-card.active {
  border-color: #a855f7;
  background: rgba(168, 85, 247, 0.08);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.2);
}

.st-ephemeral-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-ephemeral-desc {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
}

/* ── Ephemeral summary stats ────────────────────────────── */
.st-ephemeral-summary {
  display: flex;
  gap: 18px;
  padding: 10px 14px;
  margin-top: 10px;
  background: rgba(168, 85, 247, 0.05);
  border: 1px solid rgba(168, 85, 247, 0.12);
  border-radius: 8px;
  flex-wrap: wrap;
}

.st-ephemeral-stat {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

.st-ephemeral-stat strong {
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

/* ── Cache diagnostics ─────────────────────────────────── */
.st-gc-scope-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0 4px;
}

.st-gc-scope-card {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.025);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.st-gc-scope-title,
.st-gc-scope-detail {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
}

.st-gc-scope-status {
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
}

.st-diagnostics-section {
  margin-top: 16px;
}

.st-diagnostics-heading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.st-diagnostics-heading {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary, #94a3b8);
  margin-bottom: 0;
}

.st-diagnostics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.st-diagnostics-card {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.st-diagnostics-label,
.st-diagnostics-detail {
  font-size: 10.5px;
  color: var(--text-muted, #64748b);
}

.st-diagnostics-value {
  color: var(--text-primary, #f1f5f9);
  font-size: 14px;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  overflow-wrap: anywhere;
}

.st-diagnostics-list {
  margin-top: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  overflow: hidden;
}

.st-diagnostics-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 7px 10px;
  font-size: 11.5px;
  color: var(--text-secondary, #94a3b8);
  background: rgba(255, 255, 255, 0.015);
}

.st-diagnostics-row-wide {
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.st-diagnostics-row-storage {
  grid-template-columns: minmax(0, 1fr) auto auto auto;
}

.st-diagnostics-row + .st-diagnostics-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.st-diagnostics-row-key {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.st-diagnostics-empty {
  margin-top: 8px;
  padding: 9px 10px;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-muted, #64748b);
}

.st-diagnostics-plan {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid rgba(59, 130, 246, 0.14);
  background: rgba(59, 130, 246, 0.04);
  border-radius: 8px;
}
.st-group-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.st-advanced-toggle {
  background: none;
  border: 1px solid var(--border-color, #334155);
  color: var(--text-muted, #64748b);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.st-advanced-toggle:hover {
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text-secondary, #94a3b8);
}

.st-advanced-toggle.active {
  border-color: var(--accent-blue, #3b82f6);
  color: var(--accent-blue, #3b82f6);
  background: rgba(59, 130, 246, 0.06);
}

/* ── Tier table ─────────────────────────────────────────── */
.st-tier-table {
  border: 1px solid var(--border-color, #334155);
  border-radius: 10px;
  overflow: hidden;
}

.st-tier-header {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1.2fr 1.2fr;
  gap: 8px;
  padding: 9px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--border-color, #334155);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.st-tier-row {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1.2fr 1.2fr;
  gap: 8px;
  padding: 10px 14px;
  align-items: center;
  background: var(--bg-tertiary, #1a2332);
  transition: background 0.12s;
}

.st-tier-row + .st-tier-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.st-tier-row:hover {
  background: rgba(255, 255, 255, 0.02);
}

.st-tier-col-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.st-tier-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.st-tier-desc {
  font-size: 11px;
  color: var(--text-muted, #64748b);
}

.st-tier-col-limit {
  display: flex;
  align-items: center;
}

.st-tier-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.st-tier-value.unlimited {
  color: var(--text-muted, #64748b);
  font-size: 18px;
}

.st-tier-input {
  width: 100%;
  max-width: 110px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-primary, #0f172a);
  color: var(--text-primary, #f1f5f9);
  border-radius: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.15s;
}

.st-tier-input:focus {
  border-color: var(--accent-blue, #3b82f6);
}

/* Hide number input arrows */
.st-tier-input::-webkit-outer-spin-button,
.st-tier-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.st-tier-input[type=number] {
  -moz-appearance: textfield;
}

.st-tier-col-time,
.st-tier-col-size {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

.st-advanced-hint {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.05);
  border: 1px solid rgba(59, 130, 246, 0.12);
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
  line-height: 1.5;
}

/* ── Inline setting ─────────────────────────────────────── */
.st-inline-setting {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.st-inline-setting label {
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
  white-space: nowrap;
}

/* ── Exchange capability directory ─────────────────────── */
.st-exchange-directory {
  --ex-ink: var(--text-primary, #e2e8f0);
  --ex-label: #cbd5e1;
  --ex-subtle: #94a3b8;
  --ex-card-bg: var(--bg-tertiary, #1a2332);
  --ex-card-border: color-mix(in srgb, var(--border-color, #334155) 72%, #94a3b8);
  --ex-inset-bg: color-mix(in srgb, var(--bg-primary, #0a0e17) 70%, var(--bg-tertiary, #1a2332));
  --ex-chip-bg: color-mix(in srgb, var(--accent-blue, #3b82f6) 20%, transparent);
  --ex-chip-fg: #bfdbfe;
  --ex-ok: #34d399;
  --ex-ok-bg: rgba(52, 211, 153, 0.16);
  --ex-warn: #fbbf24;
  --ex-warn-bg: rgba(251, 191, 36, 0.14);
  --ex-pending: #fb923c;
  --ex-pending-bg: rgba(251, 146, 60, 0.16);
  --ex-fail: #f87171;
  --ex-fail-bg: rgba(248, 113, 113, 0.16);
  --ex-info: #93c5fd;
  --ex-info-bg: rgba(59, 130, 246, 0.16);
  --ex-filter-active-bg: color-mix(in srgb, var(--accent-blue, #3b82f6) 24%, transparent);
  --ex-filter-active-fg: #dbeafe;
  --ex-refresh-bg: color-mix(in srgb, var(--accent-blue, #3b82f6) 16%, transparent);
  --ex-refresh-fg: #bfdbfe;
}

[data-theme='light'] .st-exchange-directory {
  --ex-ink: #0f172a;
  --ex-label: #334155;
  --ex-subtle: #475569;
  --ex-card-bg: #ffffff;
  --ex-card-border: #d8e0ea;
  --ex-inset-bg: #f8fafc;
  --ex-chip-bg: #eff6ff;
  --ex-chip-fg: #1d4ed8;
  --ex-ok: #047857;
  --ex-ok-bg: #ecfdf5;
  --ex-warn: #b45309;
  --ex-warn-bg: #fffbeb;
  --ex-pending: #c2410c;
  --ex-pending-bg: #fff7ed;
  --ex-fail: #b91c1c;
  --ex-fail-bg: #fef2f2;
  --ex-info: #1d4ed8;
  --ex-info-bg: #eff6ff;
  --ex-filter-active-bg: #2563eb;
  --ex-filter-active-fg: #ffffff;
  --ex-refresh-bg: #2563eb;
  --ex-refresh-fg: #ffffff;
}

.st-exchange-directory .st-group-title-row {
  align-items: flex-start;
  gap: 12px;
}

.st-exchange-directory .st-group-title {
  margin-bottom: 4px;
  color: var(--ex-ink);
}

.st-exchange-directory .st-group-desc {
  margin-bottom: 0;
  max-width: 680px;
  color: var(--ex-subtle);
}

.st-exchange-refresh {
  flex-shrink: 0;
  padding: 7px 12px;
  border: 1px solid color-mix(in srgb, var(--accent-blue, #3b82f6) 45%, var(--ex-card-border));
  border-radius: 8px;
  background: var(--ex-refresh-bg);
  color: var(--ex-refresh-fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s ease, opacity 0.15s ease;
}

.st-exchange-refresh:hover:not(:disabled) {
  filter: brightness(1.08);
}

.st-exchange-refresh:disabled {
  opacity: 0.55;
  cursor: default;
}

.st-exchange-refresh:focus-visible,
.st-exchange-filter:focus-visible,
.st-exchange-card-head:focus-visible,
.st-exchange-test-button:focus-visible,
.st-exchange-search input:focus-visible {
  outline: 2px solid var(--accent-blue, #3b82f6);
  outline-offset: 2px;
}

.st-exchange-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: 10px;
  margin: 16px 0 14px;
}

.st-exchange-stat {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--ex-card-border);
  border-radius: 10px;
  background: var(--ex-card-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.st-exchange-stat span,
.st-exchange-stat strong {
  display: block;
}

.st-exchange-stat span {
  margin-bottom: 6px;
  color: var(--ex-label);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  line-height: 1.35;
}

.st-exchange-stat strong {
  overflow: hidden;
  color: var(--ex-ink);
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-exchange-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 4px 0 14px;
}

.st-exchange-search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--ex-label);
  font-size: 12px;
  font-weight: 600;
}

.st-exchange-search input {
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--ex-card-border);
  border-radius: 9px;
  outline: none;
  background: var(--ex-card-bg);
  color: var(--ex-ink);
  font-size: 13px;
}

.st-exchange-search input::placeholder {
  color: var(--ex-subtle);
}

.st-exchange-search input:focus {
  border-color: var(--accent-blue, #3b82f6);
}

.st-exchange-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.st-exchange-filter {
  padding: 6px 11px;
  border: 1px solid var(--ex-card-border);
  border-radius: 999px;
  background: var(--ex-card-bg);
  color: var(--ex-label);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.st-exchange-filter:hover {
  border-color: color-mix(in srgb, var(--accent-blue, #3b82f6) 55%, var(--ex-card-border));
  color: var(--ex-ink);
}

.st-exchange-filter.active {
  border-color: transparent;
  background: var(--ex-filter-active-bg);
  color: var(--ex-filter-active-fg);
}

.st-exchange-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.st-exchange-card {
  overflow: hidden;
  border: 1px solid var(--ex-card-border);
  border-radius: 12px;
  background: var(--ex-card-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.st-exchange-card.expanded {
  border-color: color-mix(in srgb, var(--accent-blue, #3b82f6) 55%, var(--ex-card-border));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent-blue, #3b82f6) 28%, transparent),
    0 8px 24px rgba(15, 23, 42, 0.12);
}

.st-exchange-card.current {
  box-shadow: inset 3px 0 0 var(--accent-blue, #3b82f6);
}

.st-exchange-card.current.expanded {
  box-shadow:
    inset 3px 0 0 var(--accent-blue, #3b82f6),
    0 0 0 1px color-mix(in srgb, var(--accent-blue, #3b82f6) 28%, transparent),
    0 8px 24px rgba(15, 23, 42, 0.12);
}

.st-exchange-card.unroutable {
  opacity: 0.92;
}

.st-exchange-card-head {
  display: grid;
  width: 100%;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  grid-template-areas:
    "disc identity badges"
    "disc meta meta";
  align-items: start;
  column-gap: 12px;
  row-gap: 8px;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--ex-ink);
  text-align: left;
  cursor: pointer;
}

.st-exchange-card-head:hover {
  background: color-mix(in srgb, var(--accent-blue, #3b82f6) 7%, transparent);
}

.st-exchange-disclosure {
  display: grid;
  grid-area: disc;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-top: 1px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--ex-ink) 8%, transparent);
  color: var(--ex-label);
}

.st-exchange-chevron {
  display: block;
  font-size: 13px;
  line-height: 1;
  transform-origin: 50% 55%;
  transition: transform 0.15s ease;
}

.st-exchange-card.expanded .st-exchange-disclosure {
  background: color-mix(in srgb, var(--accent-blue, #3b82f6) 18%, transparent);
  color: var(--accent-blue, #3b82f6);
}

.st-exchange-card.expanded .st-exchange-chevron {
  transform: rotate(90deg);
}

.st-exchange-identity {
  grid-area: identity;
  min-width: 0;
  padding-top: 1px;
}

.st-exchange-identity strong,
.st-exchange-identity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-exchange-identity strong {
  color: var(--ex-ink);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
}

.st-exchange-identity small {
  margin-top: 2px;
  color: var(--ex-subtle);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.st-exchange-row-badges {
  display: flex;
  grid-area: badges;
  min-width: 0;
  max-width: 340px;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

.st-exchange-directory .st-series-badge {
  padding: 3px 9px;
  border: 1px solid transparent;
  font-size: 11px;
  line-height: 1.3;
}

.st-exchange-directory .st-badge-ok {
  background: var(--ex-ok-bg);
  color: var(--ex-ok);
}

.st-exchange-directory .st-badge-fail {
  background: var(--ex-fail-bg);
  color: var(--ex-fail);
}

.st-exchange-directory .st-badge-info {
  background: var(--ex-info-bg);
  color: var(--ex-info);
}

.st-exchange-row-meta {
  display: flex;
  grid-area: meta;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.st-exchange-row-markets {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.st-exchange-chip {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--ex-chip-bg);
  color: var(--ex-chip-fg);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.3;
}

.st-exchange-chip.muted {
  background: color-mix(in srgb, var(--ex-subtle) 16%, transparent);
  color: var(--ex-subtle);
}

.st-exchange-row-capabilities {
  min-width: 0;
  color: var(--ex-subtle);
  font-size: 12px;
  line-height: 1.45;
}

.st-exchange-card-detail {
  padding: 16px;
  border-top: 1px solid var(--ex-card-border);
  background: var(--ex-inset-bg);
}

.st-exchange-detail-section h4 {
  margin: 0 0 10px;
  color: var(--ex-label);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.st-exchange-surfaces {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 8px;
}

.st-exchange-surface {
  padding: 10px 12px;
  border: 1px solid var(--ex-card-border);
  border-radius: 9px;
  background: var(--ex-card-bg);
}

.st-exchange-surface span,
.st-exchange-surface strong {
  display: block;
}

.st-exchange-surface span {
  color: var(--ex-label);
  font-size: 11px;
  font-weight: 650;
}

.st-exchange-surface strong {
  margin-top: 5px;
  color: var(--ex-pending);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}

.st-exchange-surface.supported {
  border-color: color-mix(in srgb, var(--ex-ok) 35%, var(--ex-card-border));
  background: var(--ex-ok-bg);
}

.st-exchange-surface.supported strong {
  color: var(--ex-ok);
}

.st-exchange-surface.pending {
  border-color: color-mix(in srgb, var(--ex-pending) 28%, var(--ex-card-border));
  background: var(--ex-pending-bg);
}

.st-exchange-qualification {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ex-ok) 32%, var(--ex-card-border));
  border-radius: 9px;
  background: var(--ex-ok-bg);
  color: var(--ex-label);
  font-size: 12px;
  line-height: 1.45;
}

.st-exchange-qualification strong {
  color: var(--ex-ok);
}

.st-exchange-market-detail {
  margin-top: 12px;
  border: 1px solid var(--ex-card-border);
  border-radius: 10px;
  background: var(--ex-card-bg);
  overflow: hidden;
}

.st-exchange-market-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ex-card-border);
}

.st-exchange-market-detail-head strong,
.st-exchange-market-detail-head span {
  display: block;
}

.st-exchange-market-detail-head strong {
  color: var(--ex-ink);
  font-size: 13px;
}

.st-exchange-market-detail-head span {
  margin-top: 2px;
  color: var(--ex-subtle);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.st-exchange-test-button {
  flex-shrink: 0;
  padding: 7px 11px;
  border: 1px solid color-mix(in srgb, var(--accent-blue, #3b82f6) 40%, var(--ex-card-border));
  border-radius: 8px;
  background: var(--ex-refresh-bg);
  color: var(--ex-refresh-fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.st-exchange-test-button:hover:not(:disabled) {
  filter: brightness(1.06);
}

.st-exchange-test-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.st-exchange-check-result {
  padding: 9px 14px;
  border-bottom: 1px solid var(--ex-card-border);
  font-size: 12px;
}

.st-exchange-check-result.success {
  background: var(--ex-ok-bg);
  color: var(--ex-ok);
}

.st-exchange-check-result.error {
  background: var(--ex-fail-bg);
  color: var(--ex-fail);
}

.st-exchange-capability-header,
.st-exchange-capability-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.05fr) minmax(105px, 0.8fr) minmax(100px, 0.75fr) minmax(230px, 2fr);
  gap: 10px;
  align-items: start;
}

.st-exchange-capability-header {
  padding: 9px 14px;
  background: color-mix(in srgb, var(--ex-ink) 5%, transparent);
  color: var(--ex-label);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.st-exchange-capability-row {
  padding: 11px 14px;
  border-top: 1px solid var(--ex-card-border);
  color: var(--ex-label);
  font-size: 12px;
  line-height: 1.5;
}

.st-exchange-capability-row > div > strong {
  color: var(--ex-ink);
  font-size: 12.5px;
}

.st-exchange-inline-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.st-exchange-inline-chips span {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--ex-chip-bg);
  color: var(--ex-chip-fg);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.st-exchange-quality strong,
.st-exchange-quality span {
  display: block;
}

.st-exchange-quality strong {
  margin-bottom: 3px;
  color: var(--ex-ink);
}

.st-exchange-quality span {
  color: var(--ex-subtle);
}

.st-exchange-quality span + span {
  margin-top: 2px;
}

.st-exchange-limitations {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--ex-warn) 35%, var(--ex-card-border));
  border-radius: 9px;
  background: var(--ex-warn-bg);
  color: var(--ex-label);
  font-size: 12px;
  line-height: 1.55;
}

.st-exchange-limitations strong {
  color: var(--ex-warn);
}

.st-exchange-limitations ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.st-exchange-empty {
  padding: 18px 14px;
  color: var(--ex-subtle);
  font-size: 13px;
  text-align: center;
}

/* ── Responsive ─────────────────────────────────────────── */
@media (max-width: 640px) {
  .st-panel {
    flex-direction: column;
    height: 92vh;
    width: 96vw;
  }

  .st-sidebar {
    width: 100%;
    min-width: unset;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid var(--border-color, #334155);
    padding: 0;
    align-items: center;
  }

  .st-sidebar-title {
    padding: 12px 16px;
    font-size: 15px;
  }

  .st-sidebar-nav {
    flex-direction: row;
    gap: 2px;
    padding: 0 4px;
    overflow-x: auto;
  }

  .st-nav-item {
    padding: 8px 12px;
    white-space: nowrap;
    font-size: 12.5px;
  }

  .st-nav-label {
    display: none;
  }

  .st-sidebar-footer {
    display: none;
  }

  .st-content-body {
    padding: 16px;
  }

  .st-theme-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .st-appearance-theme-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .st-preset-cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .st-ephemeral-cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .st-exchange-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .st-exchange-card-head {
    grid-template-columns: 28px minmax(0, 1fr);
    grid-template-areas:
      "disc identity"
      "disc badges"
      "disc meta";
  }

  .st-exchange-row-badges {
    max-width: none;
    justify-content: flex-start;
  }

  .st-exchange-surfaces {
    grid-template-columns: 1fr;
  }

  .st-exchange-capability-header {
    display: none;
  }

  .st-exchange-capability-row {
    grid-template-columns: 1fr;
  }

  .st-group-title-row {
    align-items: flex-start;
    gap: 10px;
  }

  .st-tier-header,
  .st-tier-row {
    grid-template-columns: 1.5fr 1fr 1fr;
  }

  .st-tier-col-size {
    display: none;
  }
}
.st-tool-card {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
}

[data-theme='light'] .st-tool-card {
  background: #ffffff;
  border-color: #d8e0ea;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

[data-theme='light'] .st-tool-desc {
  color: #475569;
}

[data-theme='light'] .st-gc-scope-card,
[data-theme='light'] .st-diagnostics-card,
[data-theme='light'] .st-db-summary-card {
  background: #ffffff;
  border-color: #d8e0ea;
}

[data-theme='light'] .st-gc-scope-title,
[data-theme='light'] .st-gc-scope-detail,
[data-theme='light'] .st-diagnostics-label,
[data-theme='light'] .st-diagnostics-detail,
[data-theme='light'] .st-db-summary-card span {
  color: #475569;
}

.st-tool-header {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.st-tool-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.st-tool-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  margin-bottom: 4px;
}

.st-tool-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary, #94a3b8);
}

/* ── Result box ─────────────────────────────────────────── */
.st-result {
  margin-top: 12px;
  padding: 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.5;
}

.st-result-ok {
  background: rgba(34, 197, 94, 0.06);
  border: 1px solid rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.st-result-warn {
  background: rgba(245, 158, 11, 0.06);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.st-result-fail {
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.st-result-head {
  font-weight: 600;
  margin-bottom: 6px;
}

.st-result-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 11.5px;
}

.st-result-detail {
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.8;
  font-family: var(--font-mono, monospace);
}

/* ── Series list (repair details) ───────────────────────── */
.st-series-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.st-series-item {
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.st-series-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.st-series-name {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--text-primary, #f1f5f9);
}

.st-series-meta {
  color: var(--text-muted, #64748b);
  font-size: 10px;
  font-weight: 400;
}

.st-series-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.st-badge-ok {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}
.st-badge-fail {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.st-badge-info {
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-blue, #3b82f6);
}

.st-series-msg {
  margin-top: 4px;
  color: var(--text-secondary, #94a3b8);
  font-size: 11px;
}

.st-series-more {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted, #64748b);
}

/* ── Database tools ─────────────────────────────────────── */
.st-db-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.st-db-summary-card {
  min-height: 64px;
  padding: 12px 14px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}

.st-db-summary-card span {
  color: var(--text-muted, #64748b);
  font-size: 11px;
  font-weight: 600;
}

.st-db-summary-card strong {
  color: var(--text-primary, #f1f5f9);
  font-size: 15px;
  font-family: var(--font-mono, monospace);
  font-weight: 700;
  line-height: 1.25;
}

.st-db-summary-wide {
  grid-column: span 2;
}

.st-db-filter-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.st-db-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.st-db-field span {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #64748b);
}

.st-db-scope-actions .st-btn {
  min-width: 0;
}

.st-db-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.st-db-empty {
  padding: 24px 16px;
  border: 1px dashed var(--border-color, #334155);
  border-radius: 10px;
  text-align: center;
  color: var(--text-muted, #64748b);
  font-size: 12.5px;
  background: rgba(255, 255, 255, 0.02);
}

.st-db-symbol-card {
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 10px;
  overflow: hidden;
}

.st-db-symbol-head {
  width: 100%;
  min-height: 52px;
  display: grid;
  grid-template-columns: 18px minmax(100px, 1fr) auto auto auto minmax(130px, auto);
  gap: 8px;
  align-items: center;
  padding: 12px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary, #f1f5f9);
  cursor: pointer;
  text-align: left;
}

.st-db-symbol-head:hover {
  background: rgba(255, 255, 255, 0.03);
}

.st-db-expand {
  color: var(--text-muted, #64748b);
  font-size: 13px;
}

.st-db-symbol-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  font-size: 13.5px;
  font-weight: 700;
}

.st-db-chip {
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary, #94a3b8);
  font-size: 10.5px;
  font-weight: 700;
  white-space: nowrap;
}

.st-db-symbol-meta {
  color: var(--text-muted, #64748b);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
}

.st-db-symbol-body {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.st-db-symbol-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 2px 2px 8px;
  color: var(--text-muted, #64748b);
  font-size: 11px;
}

.st-db-symbol-toolbar .st-btn {
  margin-left: auto;
}

.st-db-series-row {
  display: grid;
  grid-template-columns: 90px 82px minmax(180px, 1.6fr) 70px 100px 180px;
  gap: 10px;
  align-items: center;
  padding: 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.42);
}

.st-db-series-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-width: 0;
}

.st-db-interval {
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  font-weight: 700;
}

.st-db-series-stat {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.st-db-series-stat span {
  color: var(--text-muted, #64748b);
  font-size: 10px;
  font-weight: 700;
}

.st-db-series-stat strong {
  color: var(--text-secondary, #94a3b8);
  font-size: 11.5px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.st-db-row-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.st-db-mini-btn {
  flex: none;
  min-height: 32px;
  padding: 6px 8px;
  font-size: 11.5px;
}

.st-db-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1002;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.5);
}

.st-db-dialog {
  width: min(460px, 100%);
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-secondary, #1e293b);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45);
}

.st-db-dialog-title {
  color: var(--text-primary, #f1f5f9);
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 6px;
}

.st-db-dialog-subtitle {
  color: var(--text-secondary, #94a3b8);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  margin-bottom: 14px;
  overflow-wrap: anywhere;
}

.st-db-dialog-grid {
  display: grid;
  gap: 12px;
}

.st-db-dialog-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
}

.st-db-dialog-row span {
  color: var(--text-muted, #64748b);
}

.st-db-dialog-row strong {
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, monospace);
  text-align: right;
}

.st-db-confirm-field {
  margin-top: 12px;
}

@media (max-width: 860px) {
  .st-db-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .st-db-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .st-db-series-row {
    grid-template-columns: 80px 82px minmax(160px, 1fr) 86px;
  }

  .st-db-series-row .st-db-series-stat:nth-of-type(4),
  .st-db-series-row .st-db-series-stat:nth-of-type(5) {
    display: none;
  }

  .st-db-row-actions {
    grid-column: 1 / -1;
  }
}

@media (max-width: 640px) {
  .st-db-summary-grid,
  .st-db-filter-grid {
    grid-template-columns: 1fr;
  }

  .st-db-summary-wide {
    grid-column: auto;
  }

  .st-db-symbol-head {
    grid-template-columns: 18px minmax(90px, 1fr) auto;
    align-items: start;
  }

  .st-db-symbol-head .st-series-badge,
  .st-db-symbol-meta {
    grid-column: 2 / -1;
  }

  .st-db-chip {
    justify-self: start;
  }

  .st-db-symbol-meta {
    text-align: left;
  }

  .st-db-series-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .st-db-series-row .st-db-series-stat:nth-of-type(4),
  .st-db-series-row .st-db-series-stat:nth-of-type(5) {
    display: flex;
  }

  .st-db-series-main,
  .st-db-series-stat {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }

  .st-db-row-actions {
    grid-template-columns: 1fr;
  }

  .st-db-scope-actions {
    flex-direction: column;
  }
}

/* ── About section ──────────────────────────────────────── */
.st-about-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px 0 8px;
}

.st-about-logo {
  margin-bottom: 12px;
  filter: drop-shadow(0 4px 12px rgba(59, 130, 246, 0.3));
}

.st-about-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: 0.01em;
}

.st-about-name-accent {
  color: #12bfae;
}

.st-about-version {
  margin-top: 4px;
  font-size: 13px;
  color: var(--accent-blue, #3b82f6);
  font-weight: 600;
  padding: 2px 12px;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 999px;
}

.st-about-tagline {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
}

.st-about-stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border-color, #334155);
}

.st-stack-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 11px 16px;
  background: var(--bg-tertiary, #1a2332);
  font-size: 13px;
}

.st-stack-item + .st-stack-item {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.st-stack-label {
  color: var(--text-muted, #64748b);
  font-weight: 500;
}

.st-stack-value {
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
}


/* ── Exchange connectivity test results ─────────────────── */
.st-exchange-results {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.st-exchange-result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  transition: background 0.15s;
}

.st-exchange-result-item.ok {
  background: rgba(34, 197, 94, 0.06);
}

.st-exchange-result-item.fail {
  background: rgba(239, 68, 68, 0.06);
}

.st-exchange-result-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.st-exchange-result-label {
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  min-width: 110px;
}

.st-exchange-result-msg {
  color: var(--text-secondary, #94a3b8);
  font-size: 11.5px;
  flex: 1;
  text-align: right;
}
    `}</style>
  );
}
