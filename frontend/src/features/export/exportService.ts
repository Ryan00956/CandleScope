import { toCanvas } from "html-to-image";
import { t } from "../../i18n/index.js";
import {
  assertExportPixelBudget,
  buildDefaultWatermark,
  buildExportFilename,
  getExportMimeType,
} from "../../utils/exportFilename.js";
import type { ExportFormat } from "../../utils/exportFilename.js";
import type {
  CanvasCropPlan,
  ExportImageResult,
  ExportMetadata,
  ExportOptions,
  ExportRect,
  ExportScope,
  ExportSnapshot,
} from "./exportTypes.js";

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scope: "chart",
  format: "png",
  scale: 2,
  quality: 0.92,
  backgroundColor: "auto",
  hideDrawings: false,
  watermarkEnabled: false,
  watermarkText: "",
  filenamePrefix: "candlescope",
};

export interface ExportCaptureLifecycle {
  /** Runs after source pixels are fixed, before offscreen crop/encoding work. */
  readonly afterCapture?: () => void | Promise<void>;
}

const EXCLUDED_SELECTORS = [
  ".export-exclude",
  ".text-edit-overlay",
  ".text-format-bar",
  ".price-scale-context-menu",
  ".tool-flyout",
  ".fib-levels-panel",
  ".position-settings-panel",
  ".loading-overlay",
  ".chart-pane-cursor-overlay",
  ".drawing-interaction-overlay",
];

function isTransparentColor(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized === "transparent" || normalized === "rgba(0,0,0,0)";
}

function resolveBackgroundColor(
  targetElement: HTMLElement,
  value: string,
  format: ExportFormat,
): string | undefined {
  if (value && value !== "auto") return value === "transparent" ? undefined : value;

  let element: HTMLElement | null = targetElement;
  while (element && element !== document.documentElement) {
    const color = window.getComputedStyle(element).backgroundColor;
    if (!isTransparentColor(color)) return color;
    element = element.parentElement;
  }

  if (format === "jpeg") return "#0f172a";
  return undefined;
}

function shouldIncludeNode(node: HTMLElement): boolean {
  if (!(node instanceof Element)) return true;
  return !EXCLUDED_SELECTORS.some((selector) => node.matches(selector) || node.closest(selector));
}

export function canvasToBlob(
  canvas: Pick<HTMLCanvasElement, "toBlob">,
  format: ExportFormat,
  quality: number,
): Promise<Blob> {
  const mimeType = getExportMimeType(format);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(t("export.blobFailed")));
        return;
      }
      if (blob.type !== mimeType) {
        const actualType = blob.type || t("export.unknownFormat");
        reject(new Error(t("export.mimeUnsupported", { expected: mimeType, actual: actualType })));
        return;
      }
      resolve(blob);
    }, mimeType, format === "png" ? undefined : quality);
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string,
): void {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const scale = Math.max(1, Math.min(canvas.width, canvas.height) / 900);
  const fontSize = Math.max(12, Math.round(12 * scale));
  const lineHeight = Math.round(fontSize * 1.45);
  const padX = Math.round(12 * scale);
  const padY = Math.round(8 * scale);
  const margin = Math.round(18 * scale);

  ctx.save();
  ctx.font = `600 ${fontSize}px Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  const maxTextWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const boxWidth = maxTextWidth + padX * 2;
  const boxHeight = lineHeight * lines.length + padY * 2;
  const x = canvas.width - boxWidth - margin;
  const y = canvas.height - boxHeight - margin;

  ctx.fillStyle = "rgba(15, 23, 42, 0.48)";
  drawRoundedRect(ctx, x, y, boxWidth, boxHeight, Math.round(8 * scale));
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  ctx.textBaseline = "top";
  lines.forEach((line, index) => {
    ctx.fillText(line, x + padX, y + padY + index * lineHeight);
  });
  ctx.restore();
}

function finalizeCanvas(
  sourceCanvas: HTMLCanvasElement,
  options: ExportOptions,
  targetElement: HTMLElement,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("export.canvasFailed"));

  const background = resolveBackgroundColor(targetElement, options.backgroundColor, options.format);
  if (background || options.format === "jpeg") {
    ctx.fillStyle = background || "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(sourceCanvas, 0, 0);

  if (options.watermarkEnabled) {
    const watermark = options.watermarkText?.trim() || buildDefaultWatermark(options.metadata);
    drawWatermark(ctx, canvas, watermark);
  }

  return canvas;
}

export function buildCanvasCropPlan({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  cropRect,
}: {
  sourceWidth?: unknown;
  sourceHeight?: unknown;
  targetWidth?: unknown;
  targetHeight?: unknown;
  cropRect?: Partial<ExportRect> | null;
} = {}): CanvasCropPlan | null {
  const sourceW = Number(sourceWidth);
  const sourceH = Number(sourceHeight);
  const targetW = Number(targetWidth);
  const targetH = Number(targetHeight);
  if (
    !cropRect
    || !Number.isFinite(sourceW)
    || !Number.isFinite(sourceH)
    || !Number.isFinite(targetW)
    || !Number.isFinite(targetH)
    || sourceW <= 0
    || sourceH <= 0
    || targetW <= 0
    || targetH <= 0
  ) return null;

  const scaleX = sourceW / targetW;
  const scaleY = sourceH / targetH;
  const left = Math.max(0, Number(cropRect.x) || 0);
  const top = Math.max(0, Number(cropRect.y) || 0);
  const width = Number(cropRect.width);
  const height = Number(cropRect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const sx = Math.min(sourceW - 1, Math.round(left * scaleX));
  const sy = Math.min(sourceH - 1, Math.round(top * scaleY));
  const sw = Math.min(sourceW - sx, Math.max(1, Math.round(width * scaleX)));
  const sh = Math.min(sourceH - sy, Math.max(1, Math.round(height * scaleY)));
  return { sx, sy, sw, sh };
}

function cropCapturedCanvas(
  sourceCanvas: HTMLCanvasElement,
  cropRect: ExportRect | null | undefined,
  targetElement: HTMLElement,
): HTMLCanvasElement {
  if (!cropRect) return sourceCanvas;
  const targetRect = targetElement.getBoundingClientRect();
  const plan = buildCanvasCropPlan({
    sourceWidth: sourceCanvas.width,
    sourceHeight: sourceCanvas.height,
    targetWidth: targetRect.width,
    targetHeight: targetRect.height,
    cropRect,
  });
  if (!plan) return sourceCanvas;

  const canvas = document.createElement("canvas");
  canvas.width = plan.sw;
  canvas.height = plan.sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("export.mainCanvasFailed"));
  ctx.drawImage(
    sourceCanvas,
    plan.sx,
    plan.sy,
    plan.sw,
    plan.sh,
    0,
    0,
    plan.sw,
    plan.sh,
  );
  return canvas;
}

function captureCanvasFallback(
  targetElement: HTMLElement,
  options: ExportOptions,
): HTMLCanvasElement {
  const rect = targetElement.getBoundingClientRect();
  const scale = Number(options.scale) || 1;
  assertExportPixelBudget(rect.width, rect.height, scale);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("export.fallbackCanvasFailed"));

  const background = resolveBackgroundColor(targetElement, options.backgroundColor, options.format);
  if (background || options.format === "jpeg") {
    ctx.fillStyle = background || "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const canvases = Array.from(targetElement.querySelectorAll("canvas"))
    .filter((item) => shouldIncludeNode(item)
      && item.width > 0
      && item.height > 0
      && item.offsetParent !== null);

  if (canvases.length === 0) {
    throw new Error(t("export.noCanvas"));
  }

  for (const source of canvases) {
    const sourceRect = source.getBoundingClientRect();
    const dx = (sourceRect.left - rect.left) * scale;
    const dy = (sourceRect.top - rect.top) * scale;
    const dw = sourceRect.width * scale;
    const dh = sourceRect.height * scale;
    ctx.drawImage(source, 0, 0, source.width, source.height, dx, dy, dw, dh);
  }

  return canvas;
}

async function captureElementToCanvas(
  targetElement: HTMLElement,
  options: ExportOptions,
): Promise<HTMLCanvasElement> {
  const rect = targetElement.getBoundingClientRect();
  const scale = Number(options.scale) || 1;
  assertExportPixelBudget(rect.width, rect.height, scale);

  const backgroundColor = resolveBackgroundColor(targetElement, options.backgroundColor, options.format);

  if (options.scope !== "page") {
    try {
      // The chart surface is already fully rasterized by Lightweight Charts
      // and the drawing scene. Compositing those canvases synchronously keeps
      // the exact-scene lease atomic; cloning the DOM can take seconds while
      // live market updates replace the validated scene underneath it.
      return captureCanvasFallback(targetElement, options);
    } catch {
      // Retain the richer DOM capture as a compatibility fallback for unusual
      // chart hosts that do not expose drawable canvases.
    }
  }

  try {
    return await toCanvas(targetElement, {
      ...(backgroundColor === undefined ? {} : { backgroundColor }),
      cacheBust: true,
      filter: shouldIncludeNode,
      height: Math.ceil(rect.height),
      pixelRatio: scale,
      skipFonts: true,
      style: {
        margin: "0",
        transform: "none",
        transformOrigin: "top left",
      },
      width: Math.ceil(rect.width),
    });
  } catch (error) {
    if (options.scope === "page") throw error;
    return captureCanvasFallback(targetElement, options);
  }
}

function selectTargetElement(
  snapshot: ExportSnapshot | null | undefined,
  options: ExportOptions,
): HTMLElement | null {
  if (options.scope === "page") {
    return options.pageElement
      || document.querySelector<HTMLElement>(".app-layout")
      || document.body;
  }
  if (options.scope === "main-pane") {
    return snapshot?.mainPane?.rootElement || snapshot?.rootElement || null;
  }
  return snapshot?.rootElement || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exportFormat(value: unknown): ExportFormat {
  return value === "jpeg" || value === "webp" || value === "png" ? value : "png";
}

function exportScope(value: unknown): ExportScope {
  return value === "main-pane" || value === "page" || value === "chart" ? value : "chart";
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function metadataFrom(value: unknown): ExportMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const metadata: ExportMetadata = {};
  for (const key of ["exchange", "marketType", "symbol", "interval", "theme"] as const) {
    if (typeof value[key] === "string") metadata[key] = value[key];
  }
  return metadata;
}

export function normalizeExportOptions(rawOptions: unknown = {}): ExportOptions {
  const raw = isRecord(rawOptions) ? rawOptions : {};
  const metadata = metadataFrom(raw.metadata);
  const pageElement = typeof HTMLElement !== "undefined" && raw.pageElement instanceof HTMLElement
    ? raw.pageElement
    : null;
  const options: ExportOptions = {
    scope: exportScope(raw.scope),
    format: exportFormat(raw.format),
    scale: finiteInRange(raw.scale, DEFAULT_EXPORT_OPTIONS.scale, 1, 3),
    quality: finiteInRange(raw.quality, DEFAULT_EXPORT_OPTIONS.quality, 0.1, 1),
    backgroundColor: typeof raw.backgroundColor === "string"
      ? raw.backgroundColor
      : DEFAULT_EXPORT_OPTIONS.backgroundColor,
    hideDrawings: typeof raw.hideDrawings === "boolean"
      ? raw.hideDrawings
      : DEFAULT_EXPORT_OPTIONS.hideDrawings,
    watermarkEnabled: typeof raw.watermarkEnabled === "boolean"
      ? raw.watermarkEnabled
      : DEFAULT_EXPORT_OPTIONS.watermarkEnabled,
    watermarkText: typeof raw.watermarkText === "string"
      ? raw.watermarkText
      : DEFAULT_EXPORT_OPTIONS.watermarkText,
    filenamePrefix: typeof raw.filenamePrefix === "string" && raw.filenamePrefix
      ? raw.filenamePrefix
      : DEFAULT_EXPORT_OPTIONS.filenamePrefix,
    ...(typeof raw.filename === "string" && raw.filename ? { filename: raw.filename } : {}),
    ...(metadata ? { metadata } : {}),
    ...(pageElement ? { pageElement } : {}),
  };
  if (options.format === "jpeg" && options.backgroundColor === "transparent") {
    options.backgroundColor = "auto";
  }
  return options;
}

export function buildExportOptionsKey(rawOptions: unknown = {}): string {
  const options = normalizeExportOptions(rawOptions);
  const metadata = options.metadata || {};
  return JSON.stringify({
    scope: options.scope,
    format: options.format,
    scale: Number(options.scale) || 1,
    quality: Number(options.quality) || DEFAULT_EXPORT_OPTIONS.quality,
    backgroundColor: options.backgroundColor || "auto",
    hideDrawings: !!options.hideDrawings,
    watermarkEnabled: !!options.watermarkEnabled,
    watermarkText: options.watermarkText || "",
    filenamePrefix: options.filenamePrefix || "candlescope",
    filename: options.filename || "",
    exchange: metadata.exchange || "",
    marketType: metadata.marketType || "",
    symbol: metadata.symbol || "",
    interval: metadata.interval || "",
    theme: metadata.theme || "",
  });
}

/**
 * Preview freshness also depends on the live drawing presentation. Global
 * hide/show does not mutate the drawing document revision, so it must be part
 * of the preview key whenever the export option itself does not force hidden.
 */
export function buildExportPresentationKey(
  rawOptions: unknown = {},
  drawingsHidden = false,
): string {
  const options = normalizeExportOptions(rawOptions);
  const effectiveDrawingsHidden = options.hideDrawings || drawingsHidden;
  return `${buildExportOptionsKey(options)}|drawings:${effectiveDrawingsHidden ? "hidden" : "visible"}`;
}

export async function renderExportImage(
  snapshot: ExportSnapshot | null | undefined,
  rawOptions: unknown = {},
  lifecycle: ExportCaptureLifecycle = {},
): Promise<ExportImageResult> {
  const options = normalizeExportOptions(rawOptions);
  const targetElement = selectTargetElement(snapshot, options);
  if (!targetElement) {
    throw new Error(t("export.chartNotReady"));
  }

  const capturedCanvas = await captureElementToCanvas(targetElement, options);
  await lifecycle.afterCapture?.();
  const scopedCanvas = options.scope === "main-pane"
    ? cropCapturedCanvas(capturedCanvas, snapshot?.mainPane?.captureRect, targetElement)
    : capturedCanvas;
  const finalCanvas = finalizeCanvas(scopedCanvas, options, targetElement);
  const blob = await canvasToBlob(finalCanvas, options.format, options.quality);
  const metadata = options.metadata;
  const filename = options.filename || buildExportFilename({
    prefix: options.filenamePrefix,
    ...(metadata?.exchange === undefined ? {} : { exchange: metadata.exchange }),
    ...(metadata?.marketType === undefined ? {} : { marketType: metadata.marketType }),
    ...(metadata?.symbol === undefined ? {} : { symbol: metadata.symbol }),
    ...(metadata?.interval === undefined ? {} : { interval: metadata.interval }),
    scope: options.scope,
    format: options.format,
  });

  return {
    blob,
    filename,
    width: finalCanvas.width,
    height: finalCanvas.height,
    mimeType: blob.type,
    optionsKey: buildExportOptionsKey(options),
  };
}

export async function exportChartSnapshot(
  snapshot: ExportSnapshot | null | undefined,
  rawOptions: unknown = {},
): Promise<ExportImageResult> {
  return renderExportImage(snapshot, rawOptions);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
