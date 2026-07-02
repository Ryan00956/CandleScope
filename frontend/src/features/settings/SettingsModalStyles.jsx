export default function SettingsModalStyles() {
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

/* ── Supported exchanges ───────────────────────────────── */
.st-exchange-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.st-exchange-card {
  padding: 16px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
  border-radius: 10px;
}

.st-exchange-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}

.st-exchange-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
}

.st-exchange-id {
  margin-top: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-muted, #64748b);
}

.st-exchange-market-line {
  min-height: 18px;
  margin-bottom: 12px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary, #94a3b8);
}

.st-exchange-cap-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 12px;
}

.st-exchange-cap-row span {
  color: var(--text-muted, #64748b);
}

.st-exchange-cap-row strong {
  color: var(--text-primary, #f1f5f9);
  font-weight: 600;
  text-align: right;
}

.st-exchange-section-label {
  margin-top: 12px;
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.st-exchange-intervals {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.st-exchange-chip {
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.1);
  color: #93c5fd;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 600;
}

.st-exchange-chip.muted {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted, #64748b);
}

.st-exchange-empty {
  color: var(--text-muted, #64748b);
  font-size: 12px;
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

  .st-exchange-grid {
    grid-template-columns: 1fr;
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
  border-radius: 10px;
  border: 1px solid var(--border-color, #334155);
  background: var(--bg-tertiary, #1a2332);
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
  font-size: 48px;
  margin-bottom: 12px;
  filter: drop-shadow(0 4px 12px rgba(59, 130, 246, 0.3));
}

.st-about-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: 0.01em;
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
