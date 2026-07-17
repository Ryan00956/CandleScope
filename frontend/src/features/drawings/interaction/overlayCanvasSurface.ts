export interface DrawingOverlayPlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface DrawingOverlayCanvasLayout {
  readonly key: string;
  readonly rect: DrawingOverlayPlotRect;
  readonly context: CanvasRenderingContext2D;
  readonly changed: boolean;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function validDrawingOverlayPlotRect(
  value: DrawingOverlayPlotRect | null | undefined,
): value is DrawingOverlayPlotRect {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && finitePositive(value.width)
    && finitePositive(value.height)
    && finitePositive(value.dpr);
}

export function overlayLayoutKey(rect: DrawingOverlayPlotRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}:${rect.dpr}`;
}

/** Apply one exact adapter-owned plot rect to a DPR-backed canvas. */
export function syncDrawingOverlayCanvas(
  canvas: HTMLCanvasElement,
  rect: DrawingOverlayPlotRect | null | undefined,
  previousKey: string | null,
): DrawingOverlayCanvasLayout | null {
  if (!validDrawingOverlayPlotRect(rect)) return null;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const key = overlayLayoutKey(rect);
  const changed = key !== previousKey;
  if (changed) {
    const bitmapWidth = Math.max(1, Math.round(rect.width * rect.dpr));
    const bitmapHeight = Math.max(1, Math.round(rect.height * rect.dpr));
    canvas.style.left = `${rect.x}px`;
    canvas.style.top = `${rect.y}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  context.setTransform(rect.dpr, 0, 0, rect.dpr, 0, 0);
  return Object.freeze({ key, rect, context, changed });
}

export function clearDrawingOverlayCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D | null,
): void {
  if (!context) return;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}
