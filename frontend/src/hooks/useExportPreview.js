import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildExportOptionsKey, DEFAULT_EXPORT_OPTIONS, renderExportImage } from "../services/exportService";

function waitForAnimationFrames(count = 2) {
  return new Promise((resolve) => {
    const tick = (remaining) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(remaining - 1));
    };
    tick(count);
  });
}

function revokeObjectUrl(url) {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) window.clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

const EMPTY_PREVIEW = {
  url: null,
  blob: null,
  filename: "",
  width: 0,
  height: 0,
  mimeType: "",
  optionsKey: "",
  generatedAt: null,
};

export function useExportPreview({
  isOpen,
  options,
  metadata,
  chartWidgetRef,
  pageExportRef,
  drawingsHidden,
  setDrawingsHidden,
  debounceMs = 450,
}) {
  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const urlRef = useRef(null);
  const timerRef = useRef(null);
  const runningRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const openRef = useRef(isOpen);
  const latestOptionsRef = useRef(null);
  const latestOptionsKeyRef = useRef("");
  const runGenerationRef = useRef(null);
  const drawingsHiddenRef = useRef(drawingsHidden);

  const desiredOptions = useMemo(() => ({
    ...DEFAULT_EXPORT_OPTIONS,
    ...options,
    metadata,
  }), [metadata, options]);

  const desiredOptionsKey = useMemo(
    () => buildExportOptionsKey(desiredOptions),
    [desiredOptions],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPreview = useCallback(() => {
    clearTimer();
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
    drawingsHiddenRef.current = drawingsHidden;
  }, [drawingsHidden]);

  useEffect(() => {
    latestOptionsRef.current = desiredOptions;
    latestOptionsKeyRef.current = desiredOptionsKey;
  }, [desiredOptions, desiredOptionsKey]);

  const runGeneration = useCallback(async () => {
    if (!openRef.current || !mountedRef.current) return null;

    if (runningRef.current) {
      pendingRef.current = true;
      return null;
    }

    runningRef.current = true;
    pendingRef.current = false;

    const chartApi = chartWidgetRef.current;
    const exportOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...(latestOptionsRef.current || {}),
      pageElement: pageExportRef.current,
    };
    const requestKey = buildExportOptionsKey(exportOptions);
    const previousDrawingsHidden = drawingsHiddenRef.current;
    let changedDrawingVisibility = false;

    if (mountedRef.current && openRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      if (!chartApi?.getExportSnapshot) {
        throw new Error("图表尚未就绪，无法生成预览。 ");
      }

      chartApi.prepareExport?.();

      if (exportOptions.hideDrawings && !previousDrawingsHidden) {
        changedDrawingVisibility = true;
        setDrawingsHidden(true);
        chartApi.setDrawingsHidden?.(true);
      }

      await waitForAnimationFrames(2);
      const snapshot = chartApi.getExportSnapshot();
      const result = await withTimeout(
        renderExportImage(snapshot, exportOptions),
        12000,
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
          optionsKey: result.optionsKey,
          generatedAt: Date.now(),
        });
        revokeObjectUrl(oldUrl);
        setError(null);
        return result;
      }

      return null;
    } catch (err) {
      const isLatest = requestKey === latestOptionsKeyRef.current;
      if (mountedRef.current && openRef.current && isLatest) {
        setError(err?.message || "预览生成失败，请重试。 ");
      }
      return null;
    } finally {
      if (changedDrawingVisibility) {
        chartApi?.setDrawingsHidden?.(false);
        setDrawingsHidden(false);
      }

      runningRef.current = false;
      const shouldRunAgain = openRef.current && mountedRef.current && (
        pendingRef.current || requestKey !== latestOptionsKeyRef.current
      );

      if (shouldRunAgain) {
        pendingRef.current = false;
        window.setTimeout(() => runGenerationRef.current?.(), 0);
      } else if (mountedRef.current && openRef.current) {
        setLoading(false);
      }
    }
  }, [chartWidgetRef, pageExportRef, setDrawingsHidden]);

  useEffect(() => {
    runGenerationRef.current = runGeneration;
  }, [runGeneration]);

  useEffect(() => {
    if (!isOpen) return undefined;
    clearTimer();
    setLoading(true);
    setError(null);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      runGenerationRef.current?.();
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

export default useExportPreview;
