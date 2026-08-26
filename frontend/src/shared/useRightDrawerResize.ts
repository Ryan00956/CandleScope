import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface RightDrawerResizeOptions {
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
  viewportMargin?: number;
  keyboardStep?: number;
}

interface RightDrawerWidthBounds {
  min: number;
  max: number;
}

function viewportWidthFor(options: RightDrawerResizeOptions): number {
  if (typeof window === "undefined") {
    return options.maxWidth + (options.viewportMargin ?? 80);
  }
  return window.innerWidth;
}

export function rightDrawerWidthBounds(
  options: RightDrawerResizeOptions,
  viewportWidth: number,
): RightDrawerWidthBounds {
  const viewportMargin = options.viewportMargin ?? 80;
  const viewportMaximum = Math.max(0, Math.floor(viewportWidth - viewportMargin));
  const max = Math.max(0, Math.min(options.maxWidth, viewportMaximum));
  return {
    min: Math.min(options.minWidth, max),
    max,
  };
}

export function clampRightDrawerWidth(
  width: number,
  options: RightDrawerResizeOptions,
  viewportWidth: number,
): number {
  const bounds = rightDrawerWidthBounds(options, viewportWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function useRightDrawerResize(options: RightDrawerResizeOptions) {
  const resizeOptions = useMemo<RightDrawerResizeOptions>(() => ({
    initialWidth: options.initialWidth,
    minWidth: options.minWidth,
    maxWidth: options.maxWidth,
    viewportMargin: options.viewportMargin ?? 80,
    keyboardStep: options.keyboardStep ?? 16,
  }), [
    options.initialWidth,
    options.keyboardStep,
    options.maxWidth,
    options.minWidth,
    options.viewportMargin,
  ]);
  const [width, setWidth] = useState(() => clampRightDrawerWidth(
    resizeOptions.initialWidth,
    resizeOptions,
    viewportWidthFor(resizeOptions),
  ));
  const [isResizing, setIsResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const clampToViewport = useCallback((nextWidth: number) => (
    clampRightDrawerWidth(nextWidth, resizeOptions, viewportWidthFor(resizeOptions))
  ), [resizeOptions]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    setWidth(clampToViewport(window.innerWidth - event.clientX));
  }, [clampToViewport]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    setIsResizing(true);

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
      setIsResizing(false);
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }, [handlePointerMove]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const bounds = rightDrawerWidthBounds(resizeOptions, viewportWidthFor(resizeOptions));
    let nextWidth: number | null = null;

    if (event.key === "ArrowLeft") nextWidth = width + (resizeOptions.keyboardStep ?? 16);
    else if (event.key === "ArrowRight") nextWidth = width - (resizeOptions.keyboardStep ?? 16);
    else if (event.key === "Home") nextWidth = bounds.min;
    else if (event.key === "End") nextWidth = bounds.max;

    if (nextWidth === null) return;
    event.preventDefault();
    setWidth(clampToViewport(nextWidth));
  }, [clampToViewport, resizeOptions, width]);

  useEffect(() => {
    const handleViewportResize = () => {
      setWidth((current) => clampToViewport(current));
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [clampToViewport]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const bounds = rightDrawerWidthBounds(resizeOptions, viewportWidthFor(resizeOptions));
  return {
    width,
    isResizing,
    resizeHandleProps: {
      role: "separator" as const,
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": bounds.min,
      "aria-valuemax": bounds.max,
      "aria-valuenow": width,
      onPointerDown: beginResize,
      onKeyDown: handleResizeKeyDown,
    },
  };
}
