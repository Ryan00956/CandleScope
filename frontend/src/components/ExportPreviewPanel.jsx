import { memo, useMemo, useState } from "react";

const ZOOM_OPTIONS = [
  { value: "fit", label: "适应" },
  { value: "50", label: "50%" },
  { value: "100", label: "100%" },
];

function formatGeneratedAt(value) {
  if (!value) return "尚未生成";
  try {
    return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "刚刚";
  }
}

function formatMime(mimeType, filename) {
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
}) {
  const [zoomMode, setZoomMode] = useState("fit");
  const hasPreview = Boolean(previewUrl);
  const imageStyle = useMemo(() => {
    if (zoomMode === "fit") return undefined;
    return {
      width: `${zoomMode}%`,
      maxWidth: "none",
      maxHeight: "none",
    };
  }, [zoomMode]);
  const formatLabel = formatMime(mimeType, filename);
  const statusText = loading
    ? hasPreview ? "正在更新预览..." : "正在生成预览..."
    : hasPreview && isCurrent ? "保存即此图" : hasPreview ? "配置已变化，等待刷新" : "等待预览";

  return (
    <aside className="export-preview-panel export-exclude" aria-label="导出图片预览">
      <div className="export-preview-header">
        <div>
          <div className="export-preview-title">导出预览</div>
          <div className="export-preview-subtitle">预览图就是最终保存的图片。</div>
        </div>
        <button
          type="button"
          className="export-preview-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="重新生成当前预览"
        >
          ↻ 刷新
        </button>
      </div>

      <div className="export-preview-meta-grid">
        <div>
          <span>状态</span>
          <strong>{statusText}</strong>
        </div>
        <div>
          <span>格式</span>
          <strong>{formatLabel}</strong>
        </div>
        <div>
          <span>尺寸</span>
          <strong>{width && height ? `${width} × ${height}` : "--"}</strong>
        </div>
        <div>
          <span>生成</span>
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
              {item.label}
            </button>
          ))}
        </div>
        {filename && <div className="export-preview-filename" title={filename}>{filename}</div>}
      </div>

      <div className={`export-preview-frame ${loading ? "loading" : ""} ${!isCurrent && hasPreview ? "stale" : ""}`}>
        {hasPreview && (
          <img
            src={previewUrl}
            alt="导出图片预览"
            className="export-preview-image"
            style={imageStyle}
          />
        )}

        {!hasPreview && loading && (
          <div className="export-preview-skeleton">
            <div className="export-preview-skeleton-icon">📸</div>
            <div>正在生成第一张预览...</div>
          </div>
        )}

        {!hasPreview && !loading && !error && (
          <div className="export-preview-empty">
            <div>点击刷新生成当前画面预览</div>
          </div>
        )}

        {loading && hasPreview && (
          <div className="export-preview-overlay">正在更新预览...</div>
        )}

        {error && !loading && (
          <div className="export-preview-error">
            <strong>预览生成失败</strong>
            <span>{error}</span>
            <button type="button" onClick={onRefresh}>重新生成</button>
          </div>
        )}
      </div>
    </aside>
  );
});

export default ExportPreviewPanel;
