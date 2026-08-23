import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

const ExportIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <rect x="5" y="5" width="14" height="9" rx="2" opacity="0.25" />
  </svg>
);

const EyeIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-3.17 4.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const ClearIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

export default function DrawingActionButtons({
  drawingsHidden,
  exportInProgress,
  exportPanelOpen,
  onClearAll,
  onToggleDrawingsHidden,
  onToggleExportPanel,
}: DrawingActionButtonsProps) {
  useLocale();
  return (
    <>
      <div style={{ flex: 1 }} />
      <button
        className={`drawing-tool-btn drawing-export-btn ${exportPanelOpen ? "active" : ""}`}
        data-drawing-action="export"
        onClick={onToggleExportPanel}
        disabled={exportInProgress}
        title={exportInProgress ? t("drawing.exporting") : t("drawing.export")}
      >
        {ExportIcon}
      </button>
      <button
        className={`drawing-tool-btn drawing-hide-btn ${drawingsHidden ? "active" : ""}`}
        data-drawing-action="toggle-hidden"
        onClick={onToggleDrawingsHidden}
        title={drawingsHidden ? t("drawing.showAll") : t("drawing.hideAll")}
      >
        {drawingsHidden ? EyeOffIcon : EyeIcon}
      </button>
      <button
        className="drawing-tool-btn drawing-clear-btn"
        data-drawing-action="clear"
        onClick={onClearAll}
        title={t("drawing.clearAll")}
      >
        {ClearIcon}
      </button>
    </>
  );
}
export interface DrawingActionButtonsProps {
  drawingsHidden: boolean;
  exportInProgress: boolean;
  exportPanelOpen: boolean;
  onClearAll(): void;
  onToggleDrawingsHidden(): void;
  onToggleExportPanel(): void;
}
