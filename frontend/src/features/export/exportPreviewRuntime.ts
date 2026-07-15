import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildExportPresentationKey,
  DEFAULT_EXPORT_OPTIONS,
  renderExportImage,
} from "./exportService";
import type { MutableRefObject } from "react";
import type { ChartSurfaceActions } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type {
  DrawingExportLease,
  DrawingExportPrepareOptions,
} from "../drawings/drawingInteractionController.js";
import type { DrawingExportTarget } from "../drawings/export/drawingExportBarrier.js";
import type { ExportImageResult, ExportMetadata, ExportOptions } from "./exportTypes.js";

function revokeObjectUrl(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

export interface ExportPreviewState {
  url: string | null;
  blob: Blob | null;
  filename: string;
  width: number;
  height: number;
  mimeType: string;
  optionsKey: string;
  generatedAt: number | null;
  drawingTarget: DrawingExportTarget | null;
}

const EMPTY_PREVIEW: ExportPreviewState = {
  url: null,
  blob: null,
  filename: "",
  width: 0,
  height: 0,
  mimeType: "",
  optionsKey: "",
  generatedAt: null,
  drawingTarget: null,
};

export interface ExportPreviewRuntime extends ExportPreviewState {
  loading: boolean;
  error: string | null;
  currentOptionsKey: string;
  refreshPreview(): Promise<ExportImageResult | null> | null;
  clearPreview(): void;
}

export interface UseExportPreviewRuntimeOptions {
  isOpen: boolean;
  options: ExportOptions;
  metadata: ExportMetadata;
  chartSurfaceActions: ChartSurfaceActions | null | undefined;
  pageExportRef: MutableRefObject<HTMLElement | null>;
  drawingsHidden?: boolean | null;
  prepareDrawingExport?: ((
    options?: DrawingExportPrepareOptions,
  ) => Promise<DrawingExportLease | null>) | null;
  debounceMs?: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useExportPreviewRuntime({
  isOpen,
  options,
  metadata,
  chartSurfaceActions,
  pageExportRef,
  drawingsHidden = false,
  prepareDrawingExport,
  debounceMs = 450,
}: UseExportPreviewRuntimeOptions): ExportPreviewRuntime {
  const [preview, setPreview] = useState<ExportPreviewState>(EMPTY_PREVIEW);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const openRef = useRef(isOpen);
  const latestOptionsRef = useRef<ExportOptions | null>(null);
  const latestDrawingsHiddenRef = useRef(drawingsHidden === true);
  const latestOptionsKeyRef = useRef("");
  const runGenerationRef = useRef<(() => Promise<ExportImageResult | null>) | null>(null);
  const runAbortControllerRef = useRef<AbortController | null>(null);

  const desiredOptions = useMemo(() => ({
    ...DEFAULT_EXPORT_OPTIONS,
    ...options,
    metadata,
  }), [metadata, options]);

  const desiredOptionsKey = useMemo(
    () => buildExportPresentationKey(desiredOptions, drawingsHidden === true),
    [desiredOptions, drawingsHidden],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPreview = useCallback(() => {
    clearTimer();
    runAbortControllerRef.current?.abort();
    runAbortControllerRef.current = null;
    pendingRef.current = false;
    if (urlRef.current) {
      revokeObjectUrl(urlRef.current);
      urlRef.current = null;
    }
    setPreview(EMPTY_PREVIEW);
    setError(null);
    setLoading(false);
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      runAbortControllerRef.current?.abort();
      runAbortControllerRef.current = null;
      pendingRef.current = false;
      if (urlRef.current) {
        revokeObjectUrl(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [clearTimer]);

  useEffect(() => {
    openRef.current = isOpen;
    if (!isOpen) {
      clearPreview();
    }
  }, [clearPreview, isOpen]);

  useEffect(() => {
    latestOptionsRef.current = desiredOptions;
    latestDrawingsHiddenRef.current = drawingsHidden === true;
    latestOptionsKeyRef.current = desiredOptionsKey;
  }, [desiredOptions, desiredOptionsKey, drawingsHidden]);

  const runGeneration = useCallback(async (): Promise<ExportImageResult | null> => {
    if (!openRef.current || !mountedRef.current) return null;

    if (runningRef.current) {
      pendingRef.current = true;
      return null;
    }

    runningRef.current = true;
    pendingRef.current = false;
    const runAbortController = new AbortController();
    runAbortControllerRef.current = runAbortController;

    const exportOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...(latestOptionsRef.current || {}),
      pageElement: pageExportRef.current,
    };
    const requestKey = buildExportPresentationKey(
      exportOptions,
      latestDrawingsHiddenRef.current,
    );
    let drawingLease: DrawingExportLease | null = null;
    let drawingTarget: DrawingExportTarget | null = null;

    if (mountedRef.current && openRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      if (typeof chartSurfaceActions?.getExportSnapshot !== "function") {
        throw new Error("图表尚未就绪，无法生成预览。 ");
      }

      if (prepareDrawingExport) {
        drawingLease = await withTimeout(
          prepareDrawingExport({
            hideDrawings: exportOptions.hideDrawings,
            timeoutMs: 5_000,
            signal: runAbortController.signal,
          }),
          5_250,
          "绘图导出准备超时，未截取可能处于半更新状态的画面。 ",
        );
        drawingTarget = drawingLease
          ? Object.freeze({
              scopeKey: drawingLease.receipt.scopeKey,
              documentRevision: drawingLease.receipt.documentRevision,
            })
          : null;
      }

      const snapshot = chartSurfaceActions.getExportSnapshot();
      const result = await withTimeout<ExportImageResult>(
        renderExportImage(snapshot, exportOptions, {
          afterCapture: async () => {
            if (!drawingLease) return;
            if (!(await drawingLease.revalidate())) {
              throw new Error("绘图在截图期间发生变化，已丢弃过期预览，请重试。 ");
            }
            const completedLease = drawingLease;
            await completedLease.restore();
            drawingLease = null;
          },
        }),
        30_000,
        "预览生成超时，请尝试降低缩放倍率、切换到图表范围，或稍后重试。 ",
      );
      const isLatest = requestKey === latestOptionsKeyRef.current;

      if (mountedRef.current && openRef.current && isLatest) {
        const nextUrl = URL.createObjectURL(result.blob);
        const oldUrl = urlRef.current;
        urlRef.current = nextUrl;
        setPreview({
          url: nextUrl,
          blob: result.blob,
          filename: result.filename,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
          optionsKey: requestKey,
          generatedAt: Date.now(),
          drawingTarget,
        });
        revokeObjectUrl(oldUrl);
        setError(null);
        return result;
      }

      return null;
    } catch (err: unknown) {
      const isLatest = requestKey === latestOptionsKeyRef.current;
      if (mountedRef.current && openRef.current && isLatest) {
        setError(errorMessage(err, "预览生成失败，请重试。 "));
      }
      return null;
    } finally {
      if (drawingLease) {
        try {
          await drawingLease.restore();
        } catch (restoreError) {
          console.warn("Failed to restore drawing presentation after export", restoreError);
        }
      }

      runningRef.current = false;
      if (runAbortControllerRef.current === runAbortController) {
        runAbortControllerRef.current = null;
      }
      const shouldRunAgain = openRef.current && mountedRef.current && (
        pendingRef.current || requestKey !== latestOptionsKeyRef.current
      );

      if (shouldRunAgain) {
        pendingRef.current = false;
        window.setTimeout(() => { void runGenerationRef.current?.(); }, 0);
      } else if (mountedRef.current && openRef.current) {
        setLoading(false);
      }
    }
  }, [chartSurfaceActions, pageExportRef, prepareDrawingExport]);

  useEffect(() => {
    runGenerationRef.current = runGeneration;
  }, [runGeneration]);

  useEffect(() => {
    if (!isOpen) return undefined;
    clearTimer();
    setLoading(true);
    setError(null);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runGenerationRef.current?.();
    }, debounceMs);

    return () => clearTimer();
  }, [clearTimer, debounceMs, desiredOptionsKey, isOpen]);

  const refreshPreview = useCallback(() => {
    if (!openRef.current) return null;
    clearTimer();
    setLoading(true);
    setError(null);
    return runGenerationRef.current?.() || null;
  }, [clearTimer]);

  return {
    ...preview,
    loading,
    error,
    currentOptionsKey: desiredOptionsKey,
    refreshPreview,
    clearPreview,
  };
}

export default useExportPreviewRuntime;
