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

const STORAGE_PREFIX = "candlescope-drawings";

function storageKey(symbol) {
  return `${STORAGE_PREFIX}-${symbol}`;
}

function serializeDataPoint(dataPoint) {
  const source = dataPoint || {};
  const out = {};
  if (source.time != null && isFinite(Number(source.time))) out.time = source.time;
  if (typeof source.logical === "number" && Number.isFinite(source.logical)) out.logical = source.logical;
  if (source.price != null && isFinite(Number(source.price))) out.price = source.price;
  return out;
}

function serializeDataPoints(points) {
  return (points || []).map(serializeDataPoint);
}

function serializeHorizontalAnchor(anchor) {
  if (anchor == null) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return anchor;
  if (typeof anchor !== "object") return null;
  const out = {};
  if (anchor.time != null && isFinite(Number(anchor.time))) out.time = anchor.time;
  if (typeof anchor.logical === "number" && Number.isFinite(anchor.logical)) out.logical = anchor.logical;
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
    return {
      type: "highlighter",
      id: prim._id,
      dataPoints: serializeDataPoints(prim._dataPoints),
      color: prim._color,
      lineWidth: prim._lineWidth,
      opacity: prim._opacity,
      compositeOperation: prim._compositeOperation,
      brushShape: prim._brushShape,
    };
  }

  // FreehandDrawingPrimitive (default)
  return {
    type: "freehand",
    id: prim._id,
    dataPoints: serializeDataPoints(prim._dataPoints),
    color: prim._color,
    lineWidth: prim._lineWidth,
  };
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
    const data = primitives
      .filter((p) => p._id !== "__preview__" && !p._isPreview)
      .map(serializePrimitive);
    localStorage.setItem(storageKey(symbol), JSON.stringify(data));
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
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Failed to load drawings:", err);
    return [];
  }
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
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
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
