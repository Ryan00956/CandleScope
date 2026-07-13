const EXPORT_EXTENSION_BY_FORMAT = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
} as const;

const EXPORT_MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

export type ExportFormat = keyof typeof EXPORT_EXTENSION_BY_FORMAT;

export interface BuildExportFilenameOptions {
  prefix?: string;
  exchange?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
  scope?: string;
  format?: string;
  timestamp?: Date;
}

export interface DefaultWatermarkOptions {
  exchange?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
}

const DEFAULT_MAX_EXPORT_PIXELS = 36_000_000;

function isExportFormat(value: string): value is ExportFormat {
  return value === "png" || value === "jpeg" || value === "webp";
}

function pad2(value: unknown): string {
  return String(value).padStart(2, "0");
}

function sanitizeFileSegment(value: unknown, fallback = "chart"): string {
  const text = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return text || fallback;
}

export function getExportExtension(format = "png"): string {
  return isExportFormat(format)
    ? EXPORT_EXTENSION_BY_FORMAT[format]
    : EXPORT_EXTENSION_BY_FORMAT.png;
}

export function getExportMimeType(format = "png"): string {
  return isExportFormat(format)
    ? EXPORT_MIME_BY_FORMAT[format]
    : EXPORT_MIME_BY_FORMAT.png;
}

export function formatExportTimestamp(date: Date = new Date()): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "-",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

export function buildExportFilename({
  prefix = "candlescope",
  exchange,
  marketType,
  symbol,
  interval,
  scope,
  format = "png",
  timestamp = new Date(),
}: BuildExportFilenameOptions = {}): string {
  const parts = [
    prefix,
    exchange,
    marketType,
    symbol,
    interval,
    scope,
    formatExportTimestamp(timestamp),
  ].filter(Boolean).map((part) => sanitizeFileSegment(part));

  return `${parts.join("-")}.${getExportExtension(format)}`;
}

export function buildDefaultWatermark({
  exchange,
  marketType,
  symbol,
  interval,
}: DefaultWatermarkOptions = {}): string {
  const market = marketType === "futures" ? "Futures" : "Spot";
  const venue = [exchange, market].filter(Boolean).join(" ");
  const pair = [symbol, interval].filter(Boolean).join(" · ");
  return ["CandleScope", venue, pair].filter(Boolean).join(" · ");
}

export function estimateExportPixels(
  width: unknown,
  height: unknown,
  scale: unknown = 1,
): number {
  const w = Number(width);
  const h = Number(height);
  const s = Number(scale) || 1;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.ceil(w * h * s * s);
}

export function assertExportPixelBudget(
  width: unknown,
  height: unknown,
  scale: unknown = 1,
  maxPixels = DEFAULT_MAX_EXPORT_PIXELS,
): number {
  const pixels = estimateExportPixels(width, height, scale);
  if (pixels > maxPixels) {
    const megapixels = (pixels / 1_000_000).toFixed(1);
    const limit = (maxPixels / 1_000_000).toFixed(0);
    throw new Error(`导出尺寸过大（约 ${megapixels}MP，限制 ${limit}MP）。请降低缩放倍率或缩小窗口后重试。`);
  }
  return pixels;
}
