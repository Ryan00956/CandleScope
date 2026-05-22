import { useCallback, useMemo, useState } from "react";
import { buildExportOptionsKey, DEFAULT_EXPORT_OPTIONS, downloadBlob } from "./exportService";
import { loadExportOptions, saveExportOptions } from "./exportOptionsStore";
import { useExportPreviewRuntime } from "./exportPreviewRuntime";

export function useExportRuntime({
  session,
  resolvedTheme,
  chartWidgetRef,
  pageExportRef,
  drawings,
  loadUserPrefs,
  updateUserPref,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState(() => loadExportOptions(loadUserPrefs));
  const [inProgress, setInProgress] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const sessionView = session?.view || {};
  const metadata = useMemo(() => ({
    exchange: sessionView.exchange,
    marketType: sessionView.marketType,
    symbol: sessionView.symbol,
    interval: sessionView.interval,
    theme: resolvedTheme,
  }), [
    resolvedTheme,
    sessionView.exchange,
    sessionView.interval,
    sessionView.marketType,
    sessionView.symbol,
  ]);

  const preview = useExportPreviewRuntime({
    isOpen,
    options,
    metadata,
    chartWidgetRef,
    pageExportRef,
    drawingsHidden: drawings?.view?.drawingsHidden,
    prepareDrawingExport: drawings?.actions?.prepareExport,
    setDrawingsHiddenForExport: drawings?.actions?.setDrawingsHiddenForExport,
  });

  const updateOptions = useCallback((nextOptions) => {
    setOptions(nextOptions);
    setError(null);
    setNotice(null);
    saveExportOptions(updateUserPref, nextOptions);
  }, [updateUserPref]);

  const togglePanel = useCallback(() => {
    setError(null);
    setNotice(null);
    setIsOpen((prev) => !prev);
  }, []);

  const closePanel = useCallback(() => {
    if (inProgress) return;
    setIsOpen(false);
  }, [inProgress]);

  const exportChart = useCallback(async (requestedOptions = options) => {
    if (inProgress) return;

    const finalOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...options,
      ...requestedOptions,
      metadata,
    };
    const finalOptionsKey = buildExportOptionsKey(finalOptions);
    const previewReady = preview.blob && preview.optionsKey === finalOptionsKey;

    setInProgress(true);
    setError(null);
    setNotice(null);

    try {
      if (!previewReady) {
        throw new Error("当前配置的预览还未生成完成，请等待右侧预览更新后再保存。 ");
      }

      downloadBlob(preview.blob, preview.filename);
      setNotice(`已保存 ${preview.filename}`);
    } catch (err) {
      setError(err?.message || "保存失败，请稍后重试。 ");
    } finally {
      setInProgress(false);
    }
  }, [
    inProgress,
    metadata,
    options,
    preview.blob,
    preview.filename,
    preview.optionsKey,
  ]);

  return {
    view: {
      isOpen,
      options,
      error,
      notice,
      preview,
      metadata,
    },
    actions: {
      updateOptions,
      togglePanel,
      closePanel,
      exportChart,
    },
    status: {
      inProgress,
    },
  };
}