import { toCanvas } from "html-to-image";
import {
  assertExportPixelBudget,
  buildDefaultWatermark,
  buildExportFilename,
  getExportMimeType,
} from "../utils/exportFilename";

export const DEFAULT_EXPORT_OPTIONS = {
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

const EXCLUDED_SELECTORS = [
  ".export-exclude",
  ".text-edit-overlay",
  ".text-format-bar",
  ".price-scale-context-menu",
  ".tool-flyout",
  ".fib-levels-panel",
  ".position-settings-panel",
  ".loading-overlay",
];

function isTransparentColor(value) {
  if (!value) return true;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized === "transparent" || normalized === "rgba(0,0,0,0)";
}

function resolveBackgroundColor(targetElement, value, format) {
  if (value && value !== "auto") return value === "transparent" ? undefined : value;

  let element = targetElement;
  while (element && element !== document.documentElement) {
    const color = window.getComputedStyle(element).backgroundColor;
    if (!isTransparentColor(color)) return color;
    element = element.parentElement;
  }

  if (format === "jpeg") return "#0f172a";
  return undefined;
}

function shouldIncludeNode(node) {
  if (!(node instanceof Element)) return true;
  return !EXCLUDED_SELECTORS.some((selector) => node.matches(selector) || node.closest(selector));
}

export function canvasToBlob(canvas, format, quality) {
  const mimeType = getExportMimeType(format);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("浏览器未能生成图片 Blob。"));
        return;
      }
      resolve(blob);
    }, mimeType, format === "png" ? undefined : quality);
  });
}

function waitForFrames(count = 2) {
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

function drawRoundedRect(ctx, x, y, width, height, radius) {
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

function drawWatermark(ctx, canvas, text) {
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

function finalizeCanvas(sourceCanvas, options, targetElement) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建图片画布。浏览器可能不支持 Canvas。 ");

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

function captureCanvasFallback(targetElement, options) {
  const rect = targetElement.getBoundingClientRect();
  const scale = Number(options.scale) || 1;
  assertExportPixelBudget(rect.width, rect.height, scale);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建备用图片画布。 ");

  const background = resolveBackgroundColor(targetElement, options.backgroundColor, options.format) || "#0f172a";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const canvases = Array.from(targetElement.querySelectorAll("canvas"))
    .filter((item) => item.width > 0 && item.height > 0 && item.offsetParent !== null);

  if (canvases.length === 0) {
    throw new Error("未找到可导出的图表 Canvas。 ");
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

async function captureElementToCanvas(targetElement, options) {
  const rect = targetElement.getBoundingClientRect();
  const scale = Number(options.scale) || 1;
  assertExportPixelBudget(rect.width, rect.height, scale);

  const backgroundColor = resolveBackgroundColor(targetElement, options.backgroundColor, options.format);

  try {
    return await toCanvas(targetElement, {
      backgroundColor,
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

function selectTargetElement(snapshot, options) {
  if (options.scope === "page") {
    return options.pageElement || document.querySelector(".app-layout") || document.body;
  }
  if (options.scope === "main-pane") {
    return snapshot?.mainPane?.rootElement || snapshot?.rootElement;
  }
  return snapshot?.rootElement;
}

function normalizeExportOptions(rawOptions = {}) {
  return { ...DEFAULT_EXPORT_OPTIONS, ...rawOptions };
}

export function buildExportOptionsKey(rawOptions = {}) {
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
  });
}

export async function renderExportImage(snapshot, rawOptions = {}) {
  const options = normalizeExportOptions(rawOptions);
  const targetElement = selectTargetElement(snapshot, options);
  if (!targetElement) {
    throw new Error("图表尚未就绪，无法导出。 ");
  }

  await waitForFrames();
  const capturedCanvas = await captureElementToCanvas(targetElement, options);
  const finalCanvas = finalizeCanvas(capturedCanvas, options, targetElement);
  const blob = await canvasToBlob(finalCanvas, options.format, options.quality);
  const filename = options.filename || buildExportFilename({
    prefix: options.filenamePrefix,
    exchange: options.metadata?.exchange,
    marketType: options.metadata?.marketType,
    symbol: options.metadata?.symbol,
    interval: options.metadata?.interval,
    scope: options.scope,
    format: options.format,
  });

  return {
    blob,
    filename,
    width: finalCanvas.width,
    height: finalCanvas.height,
    mimeType: getExportMimeType(options.format),
    optionsKey: buildExportOptionsKey(options),
  };
}

export async function exportChartSnapshot(snapshot, rawOptions = {}) {
  return renderExportImage(snapshot, rawOptions);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
