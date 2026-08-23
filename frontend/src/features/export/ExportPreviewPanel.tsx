import { memo, useMemo, useState } from "react";
import { getLocale, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { CSSProperties } from "react";

type PreviewZoomMode = "fit" | "50" | "100";

const ZOOM_OPTIONS: ReadonlyArray<{ value: PreviewZoomMode; labelKey?: "export.fit"; label?: string }> = [
  { value: "fit", labelKey: "export.fit" },
  { value: "50", label: "50%" },
  { value: "100", label: "100%" },
];

export interface ExportPreviewPanelProps {
  previewUrl?: string | null;
  filename?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  generatedAt?: number | null;
  loading?: boolean;
  error?: string | null;
  isCurrent?: boolean;
  onRefresh?: () => unknown;
}

function formatGeneratedAt(value: number | null | undefined): string {
  if (!value) return t("export.notGenerated");
  try {
    return new Date(value).toLocaleTimeString(getLocale() === "zh-CN" ? "zh-CN" : "en-GB", { hour12: false });
  } catch {
    return t("export.justNow");
  }
}

function formatMime(mimeType: string, filename: string | undefined): string {
  if (mimeType) return mimeType.replace("image/", "").toUpperCase();
  const ext = String(filename || "").split(".").pop();
  return ext ? ext.toUpperCase() : "--";
}

const ExportPreviewPanel = memo(function ExportPreviewPanel({
  previewUrl,
  filename,
  width = 0,
  height = 0,
  mimeType = "",
  generatedAt = null,
  loading = false,
  error = null,
  isCurrent = false,
  onRefresh,
}: ExportPreviewPanelProps) {
  useLocale();
  const [zoomMode, setZoomMode] = useState<PreviewZoomMode>("fit");
  const hasPreview = Boolean(previewUrl);
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (zoomMode === "fit") return undefined;
    return {
      width: `${zoomMode}%`,
      maxWidth: "none",
      maxHeight: "none",
    };
  }, [zoomMode]);
  const formatLabel = formatMime(mimeType, filename);
  const statusText = loading
    ? hasPreview ? t("export.updating") : t("export.creating")
    : hasPreview && isCurrent ? t("export.saveIsThis") : hasPreview ? t("export.configChanged") : t("export.waitPreview");

  return (
    <aside className="export-preview-panel export-exclude" aria-label={t("export.previewAria")}>
      <div className="export-preview-header">
        <div>
          <div className="export-preview-title">{t("export.previewTitle")}</div>
          <div className="export-preview-subtitle">{t("export.previewSubtitle")}</div>
        </div>
        <button
          type="button"
          className="export-preview-refresh"
          onClick={onRefresh}
          disabled={loading}
          title={t("export.refreshPreview")}
        >
          {t("export.refresh")}
        </button>
      </div>

      <div className="export-preview-meta-grid">
        <div>
          <span>{t("export.status")}</span>
          <strong>{statusText}</strong>
        </div>
        <div>
          <span>{t("export.format")}</span>
          <strong>{formatLabel}</strong>
        </div>
        <div>
          <span>{t("export.size")}</span>
          <strong>{width && height ? `${width} × ${height}` : "--"}</strong>
        </div>
        <div>
          <span>{t("export.generated")}</span>
          <strong>{formatGeneratedAt(generatedAt)}</strong>
        </div>
      </div>

      <div className="export-preview-toolbar">
        <div className="export-preview-zoom">
          {ZOOM_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={zoomMode === item.value ? "active" : ""}
              onClick={() => setZoomMode(item.value)}
            >
              {item.labelKey ? t(item.labelKey) : item.label}
            </button>
          ))}
        </div>
        {filename && <div className="export-preview-filename" title={filename}>{filename}</div>}
      </div>

      <div className={`export-preview-frame ${loading ? "loading" : ""} ${!isCurrent && hasPreview ? "stale" : ""}`}>
        {hasPreview && (
          <img
            src={previewUrl || undefined}
            alt={t("export.previewAlt")}
            className="export-preview-image"
            style={imageStyle}
          />
        )}

        {!hasPreview && loading && (
          <div className="export-preview-skeleton">
            <div className="export-preview-skeleton-icon">📸</div>
            <div>{t("export.firstPreview")}</div>
          </div>
        )}

        {!hasPreview && !loading && !error && (
          <div className="export-preview-empty">
            <div>{t("export.clickRefresh")}</div>
          </div>
        )}

        {loading && hasPreview && (
          <div className="export-preview-overlay">{t("export.updating")}</div>
        )}

        {error && !loading && (
          <div className="export-preview-error">
            <strong>{t("export.previewFailed")}</strong>
            <span>{error}</span>
            <button type="button" onClick={onRefresh}>{t("export.regenerate")}</button>
          </div>
        )}
      </div>
    </aside>
  );
});

export default ExportPreviewPanel;
