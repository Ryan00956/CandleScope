import { useCallback, useMemo, useState } from "react";
import { buildExportOptionsKey, DEFAULT_EXPORT_OPTIONS, downloadBlob } from "./exportService";
import { loadExportOptions, saveExportOptions } from "./exportOptionsStore";
import { useExportPreviewRuntime } from "./exportPreviewRuntime";
import type { MutableRefObject } from "react";
import type { ChartSurfaceActions } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { DrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { ExportMetadata, ExportOptions } from "./exportTypes.js";
import type { ExportPreviewRuntime } from "./exportPreviewRuntime.js";

export interface UseExportRuntimeOptions {
  session: ChartSessionRuntime | null | undefined;
  resolvedTheme: string;
  chartSurfaceActions: ChartSurfaceActions | null | undefined;
  pageExportRef: MutableRefObject<HTMLElement | null>;
  drawings: DrawingRuntime | null | undefined;
  loadUserPrefs?: (() => unknown) | null;
  updateUserPref?: ((key: string, value: unknown) => void) | null;
}

export interface ExportRuntime {
  view: {
    isOpen: boolean;
    options: ExportOptions;
    error: string | null;
    notice: string | null;
    preview: ExportPreviewRuntime;
    metadata: ExportMetadata;
  };
  actions: {
    updateOptions(options: ExportOptions): void;
    togglePanel(): void;
    closePanel(): void;
    exportChart(options?: ExportOptions): Promise<void>;
  };
  status: {
    inProgress: boolean;
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useExportRuntime({
  session,
  resolvedTheme,
  chartSurfaceActions,
  pageExportRef,
  drawings,
  loadUserPrefs,
  updateUserPref,
}: UseExportRuntimeOptions): ExportRuntime {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ExportOptions>(() => loadExportOptions(loadUserPrefs));
  const [inProgress, setInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionView = session?.view;
  const metadata = useMemo<ExportMetadata>(() => ({
    exchange: sessionView?.exchange,
    marketType: sessionView?.marketType,
    symbol: sessionView?.symbol,
    interval: sessionView?.interval,
    theme: resolvedTheme,
  }), [
    resolvedTheme,
    sessionView?.exchange,
    sessionView?.interval,
    sessionView?.marketType,
    sessionView?.symbol,
  ]);

  const preview = useExportPreviewRuntime({
    isOpen,
    options,
    metadata,
    chartSurfaceActions,
    pageExportRef,
    drawingsHidden: drawings?.view?.drawingsHidden,
    prepareDrawingExport: drawings?.actions?.prepareExport,
    setDrawingsHiddenForExport: drawings?.actions?.setDrawingsHiddenForExport,
  });

  const updateOptions = useCallback((nextOptions: ExportOptions) => {
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

  const exportChart = useCallback(async (requestedOptions: ExportOptions = options): Promise<void> => {
    if (inProgress) return;

    const finalOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...options,
      ...requestedOptions,
      metadata,
    };
    const finalOptionsKey = buildExportOptionsKey(finalOptions);
    const previewBlob = preview.blob && preview.optionsKey === finalOptionsKey
      ? preview.blob
      : null;

    setInProgress(true);
    setError(null);
    setNotice(null);

    try {
      if (!previewBlob) {
        throw new Error("当前配置的预览还未生成完成，请等待右侧预览更新后再保存。 ");
      }

      downloadBlob(previewBlob, preview.filename);
      setNotice(`已保存 ${preview.filename}`);
    } catch (err: unknown) {
      setError(errorMessage(err, "保存失败，请稍后重试。 "));
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
