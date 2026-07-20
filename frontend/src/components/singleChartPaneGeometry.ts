export interface CursorOverlayGeometrySource {
  getBoundingClientRect(): Pick<DOMRectReadOnly, "left" | "top">;
}

export interface CursorOverlayGeometry {
  readonly left: number;
  readonly top: number;
}

export interface CursorOverlayGeometryCache {
  capture(source: CursorOverlayGeometrySource): CursorOverlayGeometry | null;
  invalidate(): void;
  peek(): CursorOverlayGeometry | null;
}

export interface CursorOverlayPoint {
  x: number;
  y: number;
}

export interface CursorOverlayPlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneCaptureSizeSource {
  readonly clientHeight: number;
  readonly clientWidth: number;
}

export interface PaneCaptureSize {
  readonly heightCssPx: number;
  readonly widthCssPx: number;
}

interface CursorOverlayViewportEventTarget {
  addEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface CursorOverlayResizeObserver {
  disconnect(): void;
  observe(target: Element): void;
}

interface ContainmentTarget extends EventTarget {
  contains(node: Node): boolean;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createCursorOverlayGeometryCache(): CursorOverlayGeometryCache {
  let geometry: CursorOverlayGeometry | null = null;
  return {
    capture(source) {
      const rect = source.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
        geometry = null;
        return null;
      }
      geometry = Object.freeze({ left: rect.left, top: rect.top });
      return geometry;
    },
    invalidate() {
      geometry = null;
    },
    peek() {
      return geometry;
    },
  };
}

export function resolveCursorOverlayPoint(
  cache: CursorOverlayGeometryCache,
  clientX: number,
  clientY: number,
  plotRect: CursorOverlayPlotRect | null | undefined,
  output: CursorOverlayPoint,
): boolean {
  const geometry = cache.peek();
  if (!geometry
    || !plotRect
    || !Number.isFinite(clientX)
    || !Number.isFinite(clientY)
    || !Number.isFinite(plotRect.x)
    || !Number.isFinite(plotRect.y)
    || !isPositiveFinite(plotRect.width)
    || !isPositiveFinite(plotRect.height)) return false;

  const x = clientX - geometry.left;
  const y = clientY - geometry.top;
  if (x < plotRect.x
    || y < plotRect.y
    || x > plotRect.x + plotRect.width
    || y > plotRect.y + plotRect.height) return false;
  output.x = x;
  output.y = y;
  return true;
}

/**
 * Prefer chart-owned pane geometry. Fallback dimensions are read lazily so a
 * valid paneSize keeps the per-frame capture path free of DOM size reads.
 */
export function resolvePaneCaptureSize(
  paneSize: Readonly<{ height?: number; width?: number }> | null | undefined,
  fallback: PaneCaptureSizeSource,
): PaneCaptureSize | null {
  const heightCssPx = isPositiveFinite(paneSize?.height)
    ? paneSize.height
    : fallback.clientHeight;
  const widthCssPx = isPositiveFinite(paneSize?.width)
    ? paneSize.width
    : fallback.clientWidth;
  if (!isPositiveFinite(heightCssPx) || !isPositiveFinite(widthCssPx)) return null;
  return Object.freeze({ heightCssPx, widthCssPx });
}

function isContainmentTarget(target: EventTarget): target is ContainmentTarget {
  return "contains" in target && typeof target.contains === "function";
}

export function shouldRefreshCursorOverlayGeometryForScroll(
  container: HTMLElement,
  scrollTarget: EventTarget | null,
  viewportTarget: unknown,
): boolean {
  if (!scrollTarget) return false;
  const ownerDocument = container.ownerDocument;
  if (scrollTarget === viewportTarget
    || scrollTarget === ownerDocument
    || scrollTarget === ownerDocument?.defaultView) return true;
  // A captured descendant or container-local scroll cannot move the container
  // in viewport space. Only a strict scrolling ancestor can do so.
  return scrollTarget !== container
    && isContainmentTarget(scrollTarget)
    && scrollTarget.contains(container);
}

/**
 * Refresh viewport-relative geometry at layout boundaries. Pointermove then
 * consumes only cache state and never calls getBoundingClientRect itself.
 */
export function subscribeCursorOverlayGeometryRefresh({
  cache,
  container,
  eventTarget = typeof window === "undefined"
    ? null
    : window as unknown as CursorOverlayViewportEventTarget,
  createResizeObserver = typeof ResizeObserver === "undefined"
    ? null
    : (listener: ResizeObserverCallback) => new ResizeObserver(listener),
}: {
  cache: CursorOverlayGeometryCache;
  container: HTMLElement;
  eventTarget?: CursorOverlayViewportEventTarget | null;
  createResizeObserver?: ((listener: ResizeObserverCallback) => CursorOverlayResizeObserver) | null;
}): () => void {
  let disposed = false;
  const refresh = () => {
    cache.invalidate();
    if (!disposed) cache.capture(container);
  };
  const handleResize: EventListener = () => refresh();
  const handleScroll: EventListener = (event) => {
    if (shouldRefreshCursorOverlayGeometryForScroll(
      container,
      event.target,
      eventTarget,
    )) refresh();
  };
  const resizeObserver = createResizeObserver?.(() => refresh()) ?? null;

  refresh();
  resizeObserver?.observe(container);
  eventTarget?.addEventListener("resize", handleResize);
  // Capture observes scrolls from any ancestor that shifts viewport-relative
  // container coordinates even though scroll does not bubble.
  eventTarget?.addEventListener("scroll", handleScroll, true);

  return () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    eventTarget?.removeEventListener("resize", handleResize);
    eventTarget?.removeEventListener("scroll", handleScroll, true);
    cache.invalidate();
  };
}
