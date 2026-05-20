import { useCallback, useMemo, useState } from "react";
import { useExportPreview } from "../../hooks/useExportPreview";
import { buildExportOptionsKey, DEFAULT_EXPORT_OPTIONS, downloadBlob } from "../../services/exportService";

export function useChartExportRuntime({
  exchange,
  marketType,
  symbol,
  interval,
  resolvedTheme,
  chartWidgetRef,
  pageExportRef,
  drawingsHidden,
  setDrawingsHidden,
  loadUserPrefs,
  updateUserPref,
}) {
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exportOptions, setExportOptions] = useState(() => {
    const prefs = loadUserPrefs();
    return { ...DEFAULT_EXPORT_OPTIONS, ...(prefs.chartExportOptions || {}) };
  });
  const [exportInProgress, setExportInProgress] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);

  const exportMetadata = useMemo(() => ({
    exchange,
    marketType,
    symbol,
    interval,
    theme: resolvedTheme,
  }), [exchange, interval, marketType, resolvedTheme, symbol]);

  const exportPreview = useExportPreview({
    isOpen: showExportPanel,
    options: exportOptions,
    metadata: exportMetadata,
    chartWidgetRef,
    pageExportRef,
    drawingsHidden,
    setDrawingsHidden,
  });

  const handleExportOptionsChange = useCallback((nextOptions) => {
    setExportOptions(nextOptions);
    setExportError(null);
    setExportNotice(null);
    updateUserPref("chartExportOptions", nextOptions);
  }, [updateUserPref]);

  const handleToggleExportPanel = useCallback(() => {
    setExportError(null);
    setExportNotice(null);
    setShowExportPanel((prev) => !prev);
  }, []);

  const handleCloseExportPanel = useCallback(() => {
    if (exportInProgress) return;
    setShowExportPanel(false);
  }, [exportInProgress]);

  const handleExportChart = useCallback(async (requestedOptions = exportOptions) => {
    if (exportInProgress) return;

    const finalOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...exportOptions,
      ...requestedOptions,
      metadata: exportMetadata,
    };
    const finalOptionsKey = buildExportOptionsKey(finalOptions);
    const previewReady = exportPreview.blob && exportPreview.optionsKey === finalOptionsKey;

    setExportInProgress(true);
    setExportError(null);
    setExportNotice(null);

    try {
      if (!previewReady) {
        throw new Error("当前配置的预览还未生成完成，请等待右侧预览更新后再保存。 ");
      }

      downloadBlob(exportPreview.blob, exportPreview.filename);
      setExportNotice(`已保存 ${exportPreview.filename}`);
    } catch (err) {
      setExportError(err?.message || "保存失败，请稍后重试。 ");
    } finally {
      setExportInProgress(false);
    }
  }, [
    exportInProgress,
    exportMetadata,
    exportOptions,
    exportPreview.blob,
    exportPreview.filename,
    exportPreview.optionsKey,
  ]);

  return {
    showExportPanel,
    exportOptions,
    exportInProgress,
    exportError,
    exportNotice,
    exportPreview,
    exportMetadata,
    handleExportOptionsChange,
    handleToggleExportPanel,
    handleCloseExportPanel,
    handleExportChart,
  };
}
