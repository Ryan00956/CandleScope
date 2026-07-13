import { memo, useMemo } from "react";
import ExportPreviewPanel from "./ExportPreviewPanel";
import { buildExportFilename } from "../../utils/exportFilename.js";

const SCOPE_OPTIONS = [
  { value: "chart", label: "整张图表", desc: "包含主图和所有指标窗格" },
  { value: "main-pane", label: "主窗格", desc: "仅导出当前 K 线主图" },
  { value: "page", label: "页面可见区", desc: "包含顶部栏、侧边栏等当前 UI" },
];

const FORMAT_OPTIONS = [
  { value: "png", label: "PNG", desc: "无损，推荐" },
  { value: "jpeg", label: "JPEG", desc: "体积小" },
  { value: "webp", label: "WebP", desc: "清晰且体积低" },
];

const SCALE_OPTIONS = [1, 2, 3];

function patchOptions(options, onChange, patch) {
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
}) {
  const filenamePreview = useMemo(() => buildExportFilename({
    prefix: options.filenamePrefix || "candlescope",
    exchange: metadata?.exchange,
    marketType: metadata?.marketType,
    symbol: metadata?.symbol,
    interval: metadata?.interval,
    scope: options.scope,
    format: options.format,
  }), [metadata?.exchange, metadata?.interval, metadata?.marketType, metadata?.symbol, options.filenamePrefix, options.format, options.scope]);
  const previewIsCurrent = Boolean(preview?.url && preview?.optionsKey && preview?.optionsKey === preview?.currentOptionsKey);
  const canSavePreview = Boolean(preview?.blob && previewIsCurrent && !preview?.loading && !preview?.error);
  const saveDisabled = inProgress || preview?.loading || !canSavePreview;

  if (!isOpen) return null;

  return (
    <div className="export-panel export-workspace export-exclude" role="dialog" aria-label="截图导出设置">
      <div className="export-panel-header">
        <div>
          <div className="export-panel-title">截图导出</div>
          <div className="export-panel-subtitle">调整配置后右侧会自动生成最终图片预览，保存即当前预览。</div>
        </div>
        <button type="button" className="export-panel-close" onClick={onClose} aria-label="关闭导出面板">×</button>
      </div>

      <div className="export-workspace-body">
        <div className="export-settings-panel">
          {(loading || indicatorComputing) && (
            <div className="export-panel-warning">
              {loading ? "图表仍在加载数据。" : "指标仍在计算。"} 可以继续预览当前画面，也可以等待完成。
            </div>
          )}

          <section className="export-panel-section">
            <div className="export-section-label">导出范围</div>
            <div className="export-option-grid scope-grid">
              {SCOPE_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-export-scope={item.value}
                  className={`export-option-card ${options.scope === item.value ? "active" : ""}`}
                  onClick={() => patchOptions(options, onOptionsChange, { scope: item.value })}
                >
                  <span>{item.label}</span>
                  <small>{item.desc}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="export-panel-section">
            <div className="export-section-label">格式</div>
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
                  <small>{item.desc}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="export-panel-section export-inline-row">
            <div>
              <div className="export-section-label">缩放倍率</div>
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
              <div className="export-section-label">背景</div>
              <select
                className="export-select"
                data-export-option="background"
                value={options.backgroundColor || "auto"}
                onChange={(event) => patchOptions(options, onOptionsChange, { backgroundColor: event.target.value })}
              >
                <option value="auto">跟随图表</option>
                <option value="transparent" disabled={options.format === "jpeg"}>透明（PNG / WebP）</option>
                <option value="#0f172a">深色</option>
                <option value="#ffffff">白色</option>
              </select>
            </div>
          </section>

          {options.format !== "png" && (
            <section className="export-panel-section">
              <div className="export-section-label">图片质量：{Math.round((options.quality || 0.92) * 100)}%</div>
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
                <strong>导出时隐藏绘图</strong>
                <small>预览和保存都会临时隐藏，生成后恢复。</small>
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
                <strong>添加水印</strong>
                <small>默认使用 CandleScope、交易所、交易对和周期。</small>
              </span>
            </label>
          </section>

          {options.watermarkEnabled && (
            <section className="export-panel-section">
              <div className="export-section-label">水印文本</div>
              <textarea
                className="export-textarea"
                data-export-option="watermark-text"
                rows={2}
                placeholder="留空则自动生成"
                value={options.watermarkText || ""}
                onChange={(event) => patchOptions(options, onOptionsChange, { watermarkText: event.target.value })}
              />
            </section>
          )}

          <section className="export-panel-section">
            <div className="export-section-label">文件名前缀</div>
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
            <button type="button" className="export-secondary-btn" onClick={onClose} disabled={inProgress}>关闭</button>
            <button
              type="button"
              data-export-action="save"
              className="export-primary-btn"
              onClick={() => onExport(options)}
              disabled={saveDisabled}
              title={preview?.loading ? "预览仍在生成" : canSavePreview ? "保存右侧当前预览" : "请先生成当前配置预览"}
            >
              {inProgress ? "保存中..." : preview?.loading ? "生成预览中..." : "保存当前预览"}
            </button>
          </div>
        </div>

        <ExportPreviewPanel
          previewUrl={preview?.url}
          filename={preview?.filename || filenamePreview}
          width={preview?.width}
          height={preview?.height}
          mimeType={preview?.mimeType}
          generatedAt={preview?.generatedAt}
          loading={!!preview?.loading}
          error={preview?.error}
          isCurrent={previewIsCurrent}
          onRefresh={preview?.refreshPreview}
        />
      </div>
    </div>
  );
});

export default ExportPanel;
