export const FREEHAND_STROKE_VERSION = 2;
export const MAX_FREEHAND_STROKE_SPANS = 2_048;
export const MAX_FREEHAND_STROKE_POINTS = 4_096;
export const MAX_LEGACY_FREEHAND_POINTS = MAX_FREEHAND_STROKE_POINTS;

const MAX_PROJECTION_ID_LENGTH = 64;
const MAX_PROJECTION_CONFIG_LENGTH = 512;
const normalizedStrokes = new WeakSet();

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeSourceOrdinal(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeProjectionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROJECTION_ID_LENGTH
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? value
    : null;
}

function safeProjectionConfig(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PROJECTION_CONFIG_LENGTH) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function normalizeLegacyFreehandPoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const price = finiteNumber(value.price);
  const time = finiteNumber(value.time);
  const logical = finiteNumber(value.logical);
  if (price === null || (time === null && logical === null)) return null;

  const point = {};
  if (time !== null) {
    point.time = time;
    const sourceOrdinal = safeSourceOrdinal(value.sourceOrdinal);
    const sourceProjection = safeProjectionId(value.sourceProjection);
    const sourceProjectionConfig = safeProjectionConfig(value.sourceProjectionConfig);
    if (sourceOrdinal !== null) point.sourceOrdinal = sourceOrdinal;
    if (sourceProjection !== null) point.sourceProjection = sourceProjection;
    if (sourceProjectionConfig !== null) point.sourceProjectionConfig = sourceProjectionConfig;
    if (sourceOrdinal === null
      && sourceProjection === null
      && sourceProjectionConfig === null
      && logical !== null) {
      point.logical = logical;
    }
  } else {
    point.logical = logical;
  }
  point.price = price;
  return point;
}

/**
 * Validate and clone the legacy freehand/highlighter point array without
 * changing its v1 representation. Projection-local `order` is discarded, but
 * the historical time-axis `logical` fallback remains supported.
 */
export function normalizeLegacyFreehandDataPoints(value) {
  if (!Array.isArray(value)
    || value.length < 2
    || value.length > MAX_LEGACY_FREEHAND_POINTS) {
    return null;
  }

  const points = value.map(normalizeLegacyFreehandPoint);
  return points.some((point) => point === null) ? null : points;
}

/**
 * Use own-property presence as the only v1/v2 discriminator. An item with a
 * `stroke` field is never allowed to fall back to legacy `dataPoints`.
 */
export function normalizeSavedFreehandPayload(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const hasStroke = Object.prototype.hasOwnProperty.call(item, "stroke");
  if (!hasStroke) {
    const dataPoints = normalizeLegacyFreehandDataPoints(item.dataPoints);
    return dataPoints ? { dataPoints } : null;
  }
  if (Object.prototype.hasOwnProperty.call(item, "dataPoints")) return null;
  const stroke = normalizeFreehandStrokeV2(item.stroke);
  return stroke ? { stroke } : null;
}

function normalizeExactAnchor(value) {
  const time = finiteNumber(value?.time);
  const sourceOrdinal = safeSourceOrdinal(value?.sourceOrdinal);
  return time === null || sourceOrdinal === null
    ? null
    : { time, sourceOrdinal };
}

function compareExactAnchors(left, right) {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.sourceOrdinal === right.sourceOrdinal) return 0;
  return left.sourceOrdinal < right.sourceOrdinal ? -1 : 1;
}

function normalizeSpan(value) {
  const left = normalizeExactAnchor(value?.exact?.left);
  const right = normalizeExactAnchor(value?.exact?.right);
  const fromTime = finiteNumber(value?.fallback?.fromTime);
  const toTime = finiteNumber(value?.fallback?.toTime);
  const leftRatio = finiteNumber(value?.fallback?.leftRatio);
  const rightRatio = finiteNumber(value?.fallback?.rightRatio);

  if (!left
    || !right
    || compareExactAnchors(left, right) >= 0
    || fromTime === null
    || toTime === null
    || fromTime > toTime
    || left.time < fromTime
    || left.time > toTime
    || right.time < fromTime
    || right.time > toTime
    || leftRatio === null
    || rightRatio === null
    || leftRatio < 0
    || rightRatio > 1
    || leftRatio >= rightRatio) {
    return null;
  }

  return {
    exact: { left, right },
    fallback: {
      fromTime,
      toTime,
      leftRatio,
      rightRatio,
    },
  };
}

function normalizePoint(value, spanCount) {
  const span = value?.span;
  const ratio = finiteNumber(value?.ratio);
  const price = finiteNumber(value?.price);
  if (!Number.isSafeInteger(span)
    || span < 0
    || span >= spanCount
    || ratio === null
    || ratio < 0
    || ratio > 1
    || price === null) {
    return null;
  }
  return { span, ratio, price };
}

function freezeNormalizedStroke(stroke) {
  for (const span of stroke.spans) {
    Object.freeze(span.exact.left);
    Object.freeze(span.exact.right);
    Object.freeze(span.exact);
    Object.freeze(span.fallback);
    Object.freeze(span);
  }
  for (const point of stroke.points) Object.freeze(point);
  Object.freeze(stroke.spans);
  Object.freeze(stroke.points);
  return Object.freeze(stroke);
}

/**
 * Validate and clone the persistence-safe freehand stroke v2 schema.
 *
 * Projection-local `order` and `logical` coordinates are intentionally not
 * represented. The exact layer retains 1:N source ordinals for an unchanged
 * projection, while the fallback envelope remains portable across projectors.
 */
export function normalizeFreehandStrokeV2(value) {
  if (value && typeof value === "object" && normalizedStrokes.has(value)) return value;
  if (value?.version !== FREEHAND_STROKE_VERSION
    || !Array.isArray(value.spans)
    || value.spans.length === 0
    || value.spans.length > MAX_FREEHAND_STROKE_SPANS
    || !Array.isArray(value.points)
    || value.points.length < 2
    || value.points.length > MAX_FREEHAND_STROKE_POINTS) {
    return null;
  }

  const sourceProjection = safeProjectionId(value.sourceProjection);
  const sourceProjectionConfig = safeProjectionConfig(value.sourceProjectionConfig);
  if (!sourceProjection || !sourceProjectionConfig) return null;

  const spans = value.spans.map(normalizeSpan);
  if (spans.some((span) => span === null)) return null;
  const points = value.points.map((point) => normalizePoint(point, spans.length));
  if (points.some((point) => point === null)) return null;

  const normalized = freezeNormalizedStroke({
    version: FREEHAND_STROKE_VERSION,
    sourceProjection,
    sourceProjectionConfig,
    spans,
    points,
  });
  normalizedStrokes.add(normalized);
  return normalized;
}

function normalizeResolvedSpan(value) {
  const left = finiteNumber(value?.left);
  const right = finiteNumber(value?.right);
  return left !== null && right !== null && left < right
    ? { left, right }
    : null;
}

/**
 * Resolve a stroke with at most one bridge call per referenced span.
 * Unresolved spans become `null` path gaps; callers must not reconnect across
 * those markers.
 */
export function resolveFreehandStrokeV2Points(value, resolveSpan) {
  const stroke = normalizeFreehandStrokeV2(value);
  if (!stroke || typeof resolveSpan !== "function") return [];

  const resolvedSpans = new Map();
  return stroke.points.map((point) => {
    if (!resolvedSpans.has(point.span)) {
      let resolved = null;
      try {
        resolved = normalizeResolvedSpan(resolveSpan(
          stroke.spans[point.span],
          point.span,
          stroke,
        ));
      } catch {
        resolved = null;
      }
      resolvedSpans.set(point.span, resolved);
    }

    const span = resolvedSpans.get(point.span);
    if (!span) return null;
    return {
      x: span.left + (span.right - span.left) * point.ratio,
      price: point.price,
    };
  });
}
