import { memo, useMemo } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import ExportPreviewPanel from "./ExportPreviewPanel";
import { buildExportFilename } from "../../utils/exportFilename.js";
import type { ExportPreviewRuntime } from "./exportPreviewRuntime.js";
import type { ExportMetadata, ExportOptions } from "./exportTypes.js";

const SCOPE_OPTIONS: ReadonlyArray<{
  value: ExportOptions["scope"];
  labelKey: "export.scope.chart" | "export.scope.main" | "export.scope.page";
  descKey: "export.scope.chartDesc" | "export.scope.mainDesc" | "export.scope.pageDesc";
}> = [
  { value: "chart", labelKey: "export.scope.chart", descKey: "export.scope.chartDesc" },
  { value: "main-pane", labelKey: "export.scope.main", descKey: "export.scope.mainDesc" },
  { value: "page", labelKey: "export.scope.page", descKey: "export.scope.pageDesc" },
];

const FORMAT_OPTIONS: ReadonlyArray<{
  value: ExportOptions["format"];
  label: string;
  descKey: "export.format.pngDesc" | "export.format.jpegDesc" | "export.format.webpDesc";
}> = [
  { value: "png", label: "PNG", descKey: "export.format.pngDesc" },
  { value: "jpeg", label: "JPEG", descKey: "export.format.jpegDesc" },
  { value: "webp", label: "WebP", descKey: "export.format.webpDesc" },
];

const SCALE_OPTIONS = [1, 2, 3];

export interface ExportPanelProps {
  isOpen: boolean;
  options: ExportOptions;
  onOptionsChange(options: ExportOptions): void;
  onExport(options: ExportOptions): void | Promise<void>;
  onClose(): void;
  inProgress?: boolean;
  error?: string | null;
  notice?: string | null;
  metadata: ExportMetadata;
  loading?: boolean;
  indicatorComputing?: boolean;
  preview?: ExportPreviewRuntime | null;
}

function patchOptions(
  options: ExportOptions,
  onChange: (options: ExportOptions) => void,
  patch: Partial<ExportOptions>,
): void {
  const nextOptions = { ...options, ...patch };
  if (nextOptions.format === "jpeg" && nextOptions.backgroundColor === "transparent") {
    nextOptions.backgroundColor = "auto";
  }
  onChange(nextOptions);
}

const ExportPanel = memo(function ExportPanel({
  isOpen,
  options,
  onOptionsChange,
  onExport,
  onClose,
  inProgress = false,
  error = null,
  notice = null,
  metadata,
  loading = false,
  indicatorComputing = false,
  preview = null,
}: ExportPanelProps) {
  useLocale();
  const filenamePreview = useMemo(() => buildExportFilename({
    prefix: options.filenamePrefix || "candlescope",
    ...(metadata.exchange === undefined ? {} : { exchange: metadata.exchange }),
    ...(metadata.marketType === undefined ? {} : { marketType: metadata.marketType }),
    ...(metadata.symbol === undefined ? {} : { symbol: metadata.symbol }),
    ...(metadata.interval === undefined ? {} : { interval: metadata.interval }),
    scope: options.scope,
    format: options.format,
  }), [metadata.exchange, metadata.interval, metadata.marketType, metadata.symbol, options.filenamePrefix, options.format, options.scope]);
  const previewIsCurrent = Boolean(preview?.url && preview?.optionsKey && preview?.optionsKey === preview?.currentOptionsKey);
  const canSavePreview = Boolean(preview?.blob && previewIsCurrent && !preview?.loading && !preview?.error);
  const saveDisabled = inProgress || preview?.loading || !canSavePreview;

  if (!isOpen) return null;

  return (
    <div className="export-panel export-workspace export-exclude" role="dialog" aria-label={t("export.aria")}>
      <div className="export-panel-header">
        <div>
          <div className="export-panel-title">{t("export.title")}</div>
          <div className="export-panel-subtitle">{t("export.subtitle")}</div>
        </div>
        <button type="button" className="export-panel-close" onClick={onClose} aria-label={t("export.close")}>×</button>
      </div>

      <div className="export-workspace-body">
        <div className="export-settings-panel">
          {(loading || indicatorComputing) && (
            <div className="export-panel-warning">
              {loading ? t("export.chartLoading") : t("export.indicatorComputing")} {t("export.canContinue")}
            </div>
          )}

          <section className="export-panel-section">
            <div className="export-section-label">{t("export.scope")}</div>
            <div className="export-option-grid scope-grid">
              {SCOPE_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-export-scope={item.value}
                  className={`export-option-card ${options.scope === item.value ? "active" : ""}`}
                  onClick={() => patchOptions(options, onOptionsChange, { scope: item.value })}
                >
                  <span>{t(item.labelKey)}</span>
                  <small>{t(item.descKey)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="export-panel-section">
            <div className="export-section-label">{t("export.format")}</div>
            <div className="export-option-grid format-grid">
              {FORMAT_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-export-format={item.value}
                  className={`export-option-card ${options.format === item.value ? "active" : ""}`}
                  onClick={() => patchOptions(options, onOptionsChange, { format: item.value })}
                >
                  <span>{item.label}</span>
                  <small>{t(item.descKey)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="export-panel-section export-inline-row">
            <div>
              <div className="export-section-label">{t("export.scale")}</div>
              <div className="export-segmented">
                {SCALE_OPTIONS.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    className={Number(options.scale) === scale ? "active" : ""}
                    onClick={() => patchOptions(options, onOptionsChange, { scale })}
                  >
                    {scale}x
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="export-section-label">{t("export.background")}</div>
              <select
                className="export-select"
                data-export-option="background"
                value={options.backgroundColor || "auto"}
                onChange={(event) => patchOptions(options, onOptionsChange, { backgroundColor: event.target.value })}
              >
                <option value="auto">{t("export.bg.auto")}</option>
                <option value="transparent" disabled={options.format === "jpeg"}>{t("export.bg.transparent")}</option>
                <option value="#0f172a">{t("export.bg.dark")}</option>
                <option value="#ffffff">{t("export.bg.white")}</option>
              </select>
            </div>
          </section>

          {options.format !== "png" && (
            <section className="export-panel-section">
              <div className="export-section-label">{t("export.quality", { percent: Math.round((options.quality || 0.92) * 100) })}</div>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.01"
                value={options.quality || 0.92}
                className="export-range"
                onChange={(event) => patchOptions(options, onOptionsChange, { quality: Number(event.target.value) })}
              />
            </section>
          )}

          <section className="export-panel-section export-check-list">
            <label className="export-checkbox-row">
              <input
                type="checkbox"
                data-export-option="hide-drawings"
                checked={!!options.hideDrawings}
                onChange={(event) => patchOptions(options, onOptionsChange, { hideDrawings: event.target.checked })}
              />
              <span>
                <strong>{t("export.hideDrawings")}</strong>
                <small>{t("export.hideDrawingsDesc")}</small>
              </span>
            </label>
            <label className="export-checkbox-row">
              <input
                type="checkbox"
                data-export-option="watermark-enabled"
                checked={!!options.watermarkEnabled}
                onChange={(event) => patchOptions(options, onOptionsChange, { watermarkEnabled: event.target.checked })}
              />
              <span>
                <strong>{t("export.watermark")}</strong>
                <small>{t("export.watermarkDesc")}</small>
              </span>
            </label>
          </section>

          {options.watermarkEnabled && (
            <section className="export-panel-section">
              <div className="export-section-label">{t("export.watermarkText")}</div>
              <textarea
                className="export-textarea"
                data-export-option="watermark-text"
                rows={2}
                placeholder={t("export.watermarkPlaceholder")}
                value={options.watermarkText || ""}
                onChange={(event) => patchOptions(options, onOptionsChange, { watermarkText: event.target.value })}
              />
            </section>
          )}

          <section className="export-panel-section">
            <div className="export-section-label">{t("export.filename")}</div>
            <input
              className="export-input"
              value={options.filenamePrefix || "candlescope"}
              onChange={(event) => patchOptions(options, onOptionsChange, { filenamePrefix: event.target.value })}
            />
            <div className="export-filename-preview">{preview?.filename || filenamePreview}</div>
          </section>

          {error && <div className="export-panel-message error">{error}</div>}
          {notice && !error && <div className="export-panel-message success">{notice}</div>}

          <div className="export-panel-actions">
            <button type="button" className="export-secondary-btn" onClick={onClose} disabled={inProgress}>{t("export.closeBtn")}</button>
            <button
              type="button"
              data-export-action="save"
              className="export-primary-btn"
              onClick={() => onExport(options)}
              disabled={saveDisabled}
              title={preview?.loading ? t("export.previewLoadingTitle") : canSavePreview ? t("export.savePreview") : t("export.needPreview")}
            >
              {inProgress ? t("export.saving") : preview?.loading ? t("export.generating") : t("export.saveCurrent")}
            </button>
          </div>
        </div>

        <ExportPreviewPanel
          filename={preview?.filename || filenamePreview}
          isCurrent={previewIsCurrent}
          {...(preview === null ? {} : {
            previewUrl: preview.url,
            width: preview.width,
            height: preview.height,
            mimeType: preview.mimeType,
            generatedAt: preview.generatedAt,
            loading: preview.loading,
            error: preview.error,
            onRefresh: preview.refreshPreview,
          })}
        />
      </div>
    </div>
  );
});

export default ExportPanel;
