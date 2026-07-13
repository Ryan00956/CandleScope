import type {
  DrawingAnchor,
  DrawingDataPoint,
  HorizontalDrawingAnchor,
  PositionInfoPanelOffset,
  PositionTimeRange,
} from "./drawingTypes.js";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function safeSourceOrdinal(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function safeSourceProjection(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? value
    : null;
}

export function safeProjectionConfig(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

/**
 * Parse a persistence/runtime anchor without accepting projection-local order.
 * `logical` is retained only when no canonical source-lineage metadata exists.
 */
export function parseDrawingAnchor(value: unknown): DrawingAnchor | null {
  if (!isRecord(value)) return null;
  const time = finiteNumber(value.time);
  const logical = finiteNumber(value.logical);
  if (time === null && logical === null) return null;

  const sourceOrdinal = time === null ? null : safeSourceOrdinal(value.sourceOrdinal);
  const sourceProjection = time === null ? null : safeSourceProjection(value.sourceProjection);
  const sourceProjectionConfig = time === null
    ? null
    : safeProjectionConfig(value.sourceProjectionConfig);

  if (time !== null && (
    sourceOrdinal !== null
    || sourceProjection !== null
    || sourceProjectionConfig !== null
  )) {
    return {
      time,
      ...(sourceOrdinal === null ? {} : { sourceOrdinal }),
      ...(sourceProjection === null ? {} : { sourceProjection }),
      ...(sourceProjectionConfig === null ? {} : { sourceProjectionConfig }),
    };
  }
  if (logical !== null) {
    return {
      ...(time === null ? {} : { time }),
      logical,
    };
  }
  return time === null ? null : { time };
}

export function parseDrawingDataPoint(value: unknown): DrawingDataPoint | null {
  if (!isRecord(value)) return null;
  const anchor = parseDrawingAnchor(value);
  const price = finiteNumber(value.price);
  return anchor && price !== null ? { ...anchor, price } : null;
}

export function parseDrawingDataPoints(value: unknown): DrawingDataPoint[] | null {
  if (!Array.isArray(value)) return null;
  const points: DrawingDataPoint[] = [];
  for (const candidate of value) {
    const point = parseDrawingDataPoint(candidate);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

export function parseHorizontalDrawingAnchor(value: unknown): HorizontalDrawingAnchor | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseDrawingAnchor(value);
}

export function parsePositionTimeRange(value: unknown): PositionTimeRange | null {
  if (!isRecord(value)) return null;
  const start = value.start === null ? null : parseHorizontalDrawingAnchor(value.start);
  const end = value.end === null ? null : parseHorizontalDrawingAnchor(value.end);
  if ((value.start !== null && start === null) || (value.end !== null && end === null)) {
    return null;
  }
  return { start, end };
}

export function parsePositionInfoPanelOffset(value: unknown): PositionInfoPanelOffset | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  return x === null || y === null ? null : { x, y };
}
