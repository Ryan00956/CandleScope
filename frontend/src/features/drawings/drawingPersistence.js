/**
 * drawingStorage.js — Persist chart drawings to localStorage.
 *
 * Drawings are stored in data coordinates (time + price), which are
 * interval-independent, so callers should pass a stable chart-scope key
 * such as `spot:BTCUSDT` or `futures:BTCUSDT`.
 *
 * Storage key: `candlescope-drawings-{SYMBOL}`
 *
 * Each drawing is serialized as a plain JSON object:
 *   - type: "line" | "axis-line" | "angle-measure" | "freehand" | "highlighter" | "text" | "shape"
 *   - id, color, lineWidth, and type-specific fields
 *   - data coordinates (time + price) — NOT screen pixels
 */

import {
  normalizeFreehandStrokeV2,
  normalizeLegacyFreehandDataPoints,
  normalizeSavedFreehandPayload,
} from "./freehandStrokeModel.js";

const STORAGE_PREFIX = "candlescope-drawings";
export const MAX_DRAWING_STORAGE_CHARS = 2_000_000;
export const MAX_SAVED_DRAWINGS = 512;
export const MAX_SAVED_FREEHAND_POINTS = 32_768;
export const MAX_SAVED_FREEHAND_SPANS = 16_384;

const SAVED_DRAWING_TYPES = new Set([
  "line",
  "axis-line",
  "angle-measure",
  "text",
  "fibonacci",
  "position",
  "shape",
  "freehand",
  "highlighter",
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function storageKey(symbol) {
  return `${STORAGE_PREFIX}-${symbol}`;
}

function safeSourceOrdinal(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeSourceProjection(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? value
    : null;
}

function safeProjectionConfig(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function serializeHorizontalFields(source) {
  const out = {};
  const hasTime = source.time != null && isFinite(Number(source.time));
  if (hasTime) out.time = source.time;

  const sourceOrdinal = hasTime ? safeSourceOrdinal(source.sourceOrdinal) : null;
  const sourceProjection = hasTime ? safeSourceProjection(source.sourceProjection) : null;
  const sourceProjectionConfig = hasTime
    ? safeProjectionConfig(source.sourceProjectionConfig)
    : null;
  if (sourceOrdinal !== null) out.sourceOrdinal = sourceOrdinal;
  if (sourceProjection !== null) out.sourceProjection = sourceProjection;
  if (sourceProjectionConfig !== null) out.sourceProjectionConfig = sourceProjectionConfig;

  // Logical positions are projection-local. Keep the legacy time-axis fallback,
  // but never persist it alongside a canonical ordinal source anchor.
  if (sourceOrdinal === null
    && sourceProjection === null
    && sourceProjectionConfig === null
    && typeof source.logical === "number"
    && Number.isFinite(source.logical)) {
    out.logical = source.logical;
  }
  return out;
}

export function serializeDataPoint(dataPoint) {
  const source = dataPoint || {};
  const out = serializeHorizontalFields(source);
  if (source.price != null && isFinite(Number(source.price))) out.price = source.price;
  return out;
}

function serializeDataPoints(points) {
  return (points || []).map(serializeDataPoint);
}

function normalizeSavedFreehandItem(item) {
  const payload = normalizeSavedFreehandPayload(item);
  if (!payload) return null;

  const normalized = { type: item.type, ...payload };
  if (typeof item.id === "string" && item.id.length <= 256) normalized.id = item.id;
  if (typeof item.color === "string" && item.color.length <= 128) normalized.color = item.color;
  if (typeof item.lineWidth === "number"
    && Number.isFinite(item.lineWidth)
    && item.lineWidth > 0
    && item.lineWidth <= 100) {
    normalized.lineWidth = item.lineWidth;
  }
  if (item.type === "highlighter") {
    if (typeof item.opacity === "number"
      && Number.isFinite(item.opacity)
      && item.opacity >= 0
      && item.opacity <= 1) {
      normalized.opacity = item.opacity;
    }
    if (typeof item.compositeOperation === "string"
      && item.compositeOperation.length <= 32) {
      normalized.compositeOperation = item.compositeOperation;
    }
    if (item.brushShape === "round" || item.brushShape === "square") {
      normalized.brushShape = item.brushShape;
    }
  }
  return normalized;
}

function normalizeSavedDrawingItem(item) {
  if (!isRecord(item) || !SAVED_DRAWING_TYPES.has(item.type)) return null;
  if (item.type === "freehand" || item.type === "highlighter") {
    return normalizeSavedFreehandItem(item);
  }
  return hasOwn(item, "stroke") ? null : item;
}

function freehandPayloadCounts(item) {
  if (item.type !== "freehand" && item.type !== "highlighter") {
    return { points: 0, spans: 0 };
  }
  if (hasOwn(item, "stroke")) {
    return {
      points: item.stroke.points.length,
      spans: item.stroke.spans.length,
    };
  }
  return { points: item.dataPoints.length, spans: 0 };
}

function declaredFreehandPayloadCounts(item) {
  if (!isRecord(item)
    || (item.type !== "freehand" && item.type !== "highlighter")) {
    return { points: 0, spans: 0 };
  }
  const legacyPoints = Array.isArray(item.dataPoints) ? item.dataPoints.length : 0;
  const strokePoints = Array.isArray(item.stroke?.points) ? item.stroke.points.length : 0;
  const strokeSpans = Array.isArray(item.stroke?.spans) ? item.stroke.spans.length : 0;
  return {
    points: legacyPoints + strokePoints,
    spans: strokeSpans,
  };
}

function normalizeSavedDrawingArray(value) {
  if (!Array.isArray(value) || value.length > MAX_SAVED_DRAWINGS) return [];

  let totalPoints = 0;
  let totalSpans = 0;
  for (const item of value) {
    const counts = declaredFreehandPayloadCounts(item);
    totalPoints += counts.points;
    totalSpans += counts.spans;
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS
      || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
      return [];
    }
  }

  const drawings = [];
  for (const item of value) {
    const normalized = normalizeSavedDrawingItem(item);
    if (!normalized) continue;
    drawings.push(normalized);
  }
  return drawings;
}

function readSavedDrawingArray(symbol, warnOnError = false) {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    if (raw.length > MAX_DRAWING_STORAGE_CHARS) {
      if (warnOnError) console.warn("Failed to load drawings: stored payload is too large");
      return [];
    }
    return normalizeSavedDrawingArray(JSON.parse(raw));
  } catch (err) {
    if (warnOnError) console.warn("Failed to load drawings:", err);
    return [];
  }
}

function serializeFreehandPayload(prim) {
  if (prim._stroke != null) {
    const stroke = normalizeFreehandStrokeV2(prim._stroke);
    return stroke ? { stroke } : null;
  }
  const dataPoints = normalizeLegacyFreehandDataPoints(prim._dataPoints);
  return dataPoints ? { dataPoints } : null;
}

export function serializeHorizontalAnchor(anchor) {
  if (anchor == null) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return anchor;
  if (typeof anchor !== "object") return null;
  const out = serializeHorizontalFields(anchor);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Serialize a primitive instance to a plain JSON-safe object.
 */
function serializePrimitive(prim) {
  // Detect type by checking unique properties
  if (prim._lineType != null) {
    // LineDrawingPrimitive
    return {
      type: "line",
      id: prim._id,
      lineType: prim._lineType,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if (prim._type === "axis-line") {
    return {
      type: "axis-line",
      id: prim._id,
      axisLineType: prim._axisLineType,
      dataPoint: serializeDataPoint(prim._dataPoint),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if (prim._type === "angle-measure") {
    return {
      type: "angle-measure",
      id: prim._id,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  if (prim._text != null) {
    // TextDrawingPrimitive
    return {
      type: "text",
      id: prim._id,
      dataPoint: serializeDataPoint(prim._dataPoint),
      text: prim._text,
      color: prim._color,
      fontSize: prim._fontSize,
      fontFamily: prim._fontFamily,
      bold: prim._bold,
      italic: prim._italic,
      // ── Extended fields (PPT-style text box) ──
      underline: prim._underline,
      align: prim._align,
      bgColor: prim._bgColor,
      borderColor: prim._borderColor,
      borderWidth: prim._borderWidth,
      widthPx: prim._widthPx,
      padding: prim._padding,
    };
  }

  if (prim._type === "fibonacci") {
    return {
      type: "fibonacci",
      id: prim._id,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
      levels: prim._levels,
      inverted: prim._inverted || false,
    };
  }

  if (prim._type === "position") {
    return {
      type: "position",
      id: prim._id,
      direction: prim._direction,
      entryPrice: prim._entryPrice,
      tpPrice: prim._tpPrice,
      slPrice: prim._slPrice,
      timeRange: {
        start: serializeHorizontalAnchor(prim._timeRange?.start),
        end: serializeHorizontalAnchor(prim._timeRange?.end),
      },
      positionSize: prim._positionSize,
      infoPanelOffset: prim._infoPanelOffset ? { ...prim._infoPanelOffset } : undefined,
    };
  }

  if (prim._type === "shape") {
    return {
      type: "shape",
      id: prim._id,
      shapeType: prim._shapeType,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
      fillColor: prim._fillColor,
      fillOpacity: prim._fillOpacity,
      lineStyle: prim._lineStyle,
    };
  }

  if (prim._type === "highlighter") {
    const payload = serializeFreehandPayload(prim);
    if (!payload) return null;
    return {
      type: "highlighter",
      id: prim._id,
      ...payload,
      color: prim._color,
      lineWidth: prim._lineWidth,
      opacity: prim._opacity,
      compositeOperation: prim._compositeOperation,
      brushShape: prim._brushShape,
    };
  }

  if (prim._type === "freehand") {
    const payload = serializeFreehandPayload(prim);
    if (!payload) return null;
    return {
      type: "freehand",
      id: prim._id,
      ...payload,
      color: prim._color,
      lineWidth: prim._lineWidth,
    };
  }

  return null;
}

/**
 * Save all current drawing primitives for a symbol.
 * @param {string} symbol - e.g. "BTCUSDT"
 * @param {Array} primitives - array of primitive instances
 */
export function saveDrawings(symbol, primitives) {
  if (!symbol) return;
  try {
    // Filter out preview primitives
    const candidates = primitives
      .filter((p) => p._id !== "__preview__" && !p._isPreview);
    if (candidates.length > MAX_SAVED_DRAWINGS) {
      console.warn("Failed to save drawings: drawing count exceeds the storage limit");
      return;
    }

    const data = [];
    let totalPoints = 0;
    let totalSpans = 0;
    for (const prim of candidates) {
      const item = serializePrimitive(prim);
      if (!item) {
        console.warn("Failed to save drawings: a drawing could not be serialized");
        return;
      }
      const counts = freehandPayloadCounts(item);
      totalPoints += counts.points;
      totalSpans += counts.spans;
      if (totalPoints > MAX_SAVED_FREEHAND_POINTS
        || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
        console.warn("Failed to save drawings: freehand data exceeds the storage limit");
        return;
      }
      data.push(item);
    }

    const raw = JSON.stringify(data);
    if (raw.length > MAX_DRAWING_STORAGE_CHARS) {
      console.warn("Failed to save drawings: serialized payload is too large");
      return;
    }
    localStorage.setItem(storageKey(symbol), raw);
  } catch (err) {
    console.warn("Failed to save drawings:", err);
  }
}

/**
 * Load saved drawing data for a symbol.
 * Returns an array of plain objects (not primitive instances).
 * The caller (useDrawing) is responsible for re-creating primitive instances.
 *
 * @param {string} symbol - e.g. "BTCUSDT"
 * @returns {Array} serialized drawing objects
 */
export function loadDrawings(symbol) {
  if (!symbol) return [];
  return readSavedDrawingArray(symbol, true);
}

/**
 * Return true when a symbol/pane key has persisted drawings.
 * This intentionally avoids importing primitive classes so callers can use it
 * before the real drawing engine is loaded.
 *
 * @param {string} symbol
 * @returns {boolean}
 */
export function hasSavedDrawings(symbol) {
  if (!symbol) return false;
  return readSavedDrawingArray(symbol).length > 0;
}

/**
 * Clear all saved drawings for a symbol.
 * @param {string} symbol
 */
export function clearSavedDrawings(symbol) {
  if (!symbol) return;
  try {
    localStorage.removeItem(storageKey(symbol));
  } catch {
    // ignore
  }
}
