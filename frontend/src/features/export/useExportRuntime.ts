import { useCallback, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import {
  buildExportPresentationKey,
  DEFAULT_EXPORT_OPTIONS,
  downloadBlob,
} from "./exportService";
import { loadExportOptions, saveExportOptions } from "./exportOptionsStore";
import { useExportPreviewRuntime } from "./exportPreviewRuntime";
import type { MutableRefObject } from "react";
import type { ChartSurfaceActions } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { DrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { ExportMetadata, ExportOptions } from "./exportTypes.js";
import type {
  DrawingExportTarget,
  ExportPreviewRuntime,
} from "./exportPreviewRuntime.js";

export interface UseExportRuntimeOptions {
  session: ChartSessionRuntime | null | undefined;
  metadata?: ExportMetadata;
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

export function sameDrawingExportTarget(
  left: DrawingExportTarget | null,
  right: DrawingExportTarget | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.scopeKey === right.scopeKey
      && left.documentRevision === right.documentRevision;
}

export function useExportRuntime({
  session,
  metadata: metadataOverride,
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
    ...(sessionView?.exchange === undefined ? {} : { exchange: sessionView.exchange }),
    ...(sessionView?.marketType === undefined ? {} : { marketType: sessionView.marketType }),
    ...(sessionView?.symbol === undefined ? {} : { symbol: sessionView.symbol }),
    ...(sessionView?.interval === undefined ? {} : { interval: sessionView.interval }),
    theme: resolvedTheme,
    ...metadataOverride,
  }), [
    metadataOverride,
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
    drawingsHidden: drawings?.view?.drawingsHidden === true,
    ...(drawings?.actions?.prepareExport === undefined
      ? {}
      : { prepareDrawingExport: drawings.actions.prepareExport }),
    ...(drawings?.actions?.exportInstrumentation === undefined
      ? {}
      : { drawingExportInstrumentation: drawings.actions.exportInstrumentation }),
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
    const finalOptionsKey = buildExportPresentationKey(
      finalOptions,
      drawings?.view?.drawingsHidden === true,
    );
    const previewBlob = preview.blob && preview.optionsKey === finalOptionsKey
      ? preview.blob
      : null;

    setInProgress(true);
    setError(null);
    setNotice(null);

    try {
      if (!previewBlob) {
        throw new Error(t("export.previewNotReady"));
      }
      let blob = previewBlob;
      let filename = preview.filename;
      const drawingLease = await drawings?.actions?.prepareExport?.({
        hideDrawings: finalOptions.hideDrawings,
        timeoutMs: 5_000,
      }) ?? null;
      const currentDrawingTarget = drawingLease
        ? Object.freeze({
            scopeKey: drawingLease.receipt.scopeKey,
            documentRevision: drawingLease.receipt.documentRevision,
          })
        : null;
      if (drawingLease) await drawingLease.restore();
      if (!sameDrawingExportTarget(currentDrawingTarget, preview.drawingTarget)) {
        const refreshed = await preview.refreshPreview();
        if (!refreshed) {
          throw new Error(t("export.drawPreviewStale"));
        }
        blob = refreshed.blob;
        filename = refreshed.filename;
      }

      downloadBlob(blob, filename);
      setNotice(t("export.saved", { filename }));
    } catch (err: unknown) {
      setError(errorMessage(err, t("export.saveFailed")));
    } finally {
      setInProgress(false);
    }
  }, [
    inProgress,
    metadata,
    options,
    drawings?.actions,
    drawings?.view?.drawingsHidden,
    preview,
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
