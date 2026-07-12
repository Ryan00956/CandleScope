export const FREEHAND_STROKE_VERSION = 2;
export const MAX_FREEHAND_STROKE_SPANS = 2_048;
export const MAX_FREEHAND_STROKE_POINTS = 4_096;
export const MAX_LEGACY_FREEHAND_POINTS = MAX_FREEHAND_STROKE_POINTS;

const MAX_PROJECTION_ID_LENGTH = 64;
const MAX_PROJECTION_CONFIG_LENGTH = 512;
const normalizedStrokes = new WeakSet();
const draftStates = new WeakMap();

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

function spanKey(span) {
  const { left, right } = span.exact;
  const fallback = span.fallback;
  return JSON.stringify([
    left.time,
    left.sourceOrdinal,
    right.time,
    right.sourceOrdinal,
    fallback.fromTime,
    fallback.toTime,
    fallback.leftRatio,
    fallback.rightRatio,
  ]);
}

function normalizeDraftCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const span = normalizeSpan(value.span);
  const ratio = finiteNumber(value.ratio);
  const price = finiteNumber(value.price);
  if (!span || ratio === null || ratio < 0 || ratio > 1 || price === null) return null;

  let screen = null;
  if (value.screen !== null) {
    const x = finiteNumber(value.screen?.x);
    const y = finiteNumber(value.screen?.y);
    if (x === null || y === null) return null;
    screen = { x, y };
  }
  return { span, ratio, price, screen };
}

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(
    point.x - (start.x + amount * dx),
    point.y - (start.y + amount * dy),
  );
}

function retainPathIndexes(samples, start, end, epsilon, retained) {
  retained.add(start);
  retained.add(end);
  const stack = [[start, end]];
  while (stack.length > 0) {
    const [left, right] = stack.pop();
    if (right - left <= 1) continue;
    let farthestIndex = -1;
    let farthestDistance = 0;
    for (let index = left + 1; index < right; index += 1) {
      const distance = perpendicularDistance(
        samples[index].screen,
        samples[left].screen,
        samples[right].screen,
      );
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex >= 0 && farthestDistance > epsilon) {
      retained.add(farthestIndex);
      stack.push([left, farthestIndex], [farthestIndex, right]);
    }
  }
}

function retainedDraftIndexes(samples, epsilon) {
  const retained = new Set();
  let pathStart = -1;
  let hasRenderablePath = false;
  for (let index = 0; index <= samples.length; index += 1) {
    const isPathPoint = index < samples.length && samples[index].screen !== null;
    if (isPathPoint && pathStart < 0) pathStart = index;
    if (isPathPoint) continue;

    if (pathStart >= 0) {
      const pathEnd = index - 1;
      if (pathEnd > pathStart) hasRenderablePath = true;
      retainPathIndexes(samples, pathStart, pathEnd, epsilon, retained);
      pathStart = -1;
    }
    // A valid capture whose screen coordinate could not be resolved is a path
    // separator and must survive decimation so later rendering cannot bridge it.
    if (index < samples.length) retained.add(index);
  }
  return hasRenderablePath ? retained : null;
}

/**
 * Create a helper-managed mutable v2 draft. `captureIdentity` is deliberately
 * opaque and compared by reference; it is never copied into the saved stroke.
 */
export function createFreehandStrokeDraft({
  sourceProjection,
  sourceProjectionConfig,
  captureIdentity,
} = {}) {
  const projection = safeProjectionId(sourceProjection);
  const config = safeProjectionConfig(sourceProjectionConfig);
  if (!projection || !config || captureIdentity === null || captureIdentity === undefined) {
    return null;
  }
  const draft = {};
  draftStates.set(draft, {
    sourceProjection: projection,
    sourceProjectionConfig: config,
    captureIdentity,
    spans: [],
    spanIndexes: new Map(),
    samples: [],
    cancelled: false,
  });
  return draft;
}

/** Append one capture. The draft is unchanged when validation fails. */
export function appendFreehandStrokeCapture(draft, capture, captureIdentity) {
  const state = draftStates.get(draft);
  const normalized = normalizeDraftCapture(capture);
  if (!state
    || state.cancelled
    || captureIdentity !== state.captureIdentity
    || !normalized
    || state.samples.length >= MAX_FREEHAND_STROKE_POINTS) {
    return false;
  }
  const key = spanKey(normalized.span);
  let span = state.spanIndexes.get(key);
  if (span === undefined) {
    if (state.spans.length >= MAX_FREEHAND_STROKE_SPANS) return false;
    span = state.spans.length;
    state.spanIndexes.set(key, span);
    state.spans.push(normalized.span);
  }
  state.samples.push({
    point: { span, ratio: normalized.ratio, price: normalized.price },
    screen: normalized.screen,
  });
  return true;
}

/** Append a capture batch atomically. */
export function appendFreehandStrokeCaptureBatch(draft, batch) {
  const state = draftStates.get(draft);
  if (!state
    || state.cancelled
    || batch?.captureIdentity !== state.captureIdentity
    || batch?.sourceProjection !== state.sourceProjection
    || batch?.sourceProjectionConfig !== state.sourceProjectionConfig
    || !Array.isArray(batch?.captures)
    || batch.captures.length === 0
    || state.samples.length + batch.captures.length > MAX_FREEHAND_STROKE_POINTS) {
    return false;
  }

  const normalizedCaptures = batch.captures.map(normalizeDraftCapture);
  if (normalizedCaptures.some((capture) => capture === null)) return false;
  const newKeys = new Set();
  for (const capture of normalizedCaptures) {
    const key = spanKey(capture.span);
    if (!state.spanIndexes.has(key)) newKeys.add(key);
  }
  if (state.spans.length + newKeys.size > MAX_FREEHAND_STROKE_SPANS) return false;

  for (const capture of normalizedCaptures) {
    appendFreehandStrokeCapture(draft, capture, batch.captureIdentity);
  }
  return true;
}

/** Return a defensive screen-space preview, preserving null path gaps. */
export function getFreehandStrokeDraftPreviewPoints(draft) {
  const state = draftStates.get(draft);
  if (!state || state.cancelled) return [];
  return state.samples.map(({ screen }) => (screen ? { ...screen } : null));
}

/** Cancel and empty a draft. It cannot subsequently be appended or finalized. */
export function cancelFreehandStrokeDraft(draft) {
  const state = draftStates.get(draft);
  if (!state || state.cancelled) return false;
  state.cancelled = true;
  state.spans.length = 0;
  state.samples.length = 0;
  state.spanIndexes.clear();
  return true;
}

/**
 * Finalize with iterative, path-local screen-space RDP. Kept sample indexes
 * select the persistent points, after which unused spans are removed/remapped.
 */
export function finalizeFreehandStrokeDraft(draft, {
  captureIdentity,
  epsilon = 1.5,
} = {}) {
  const state = draftStates.get(draft);
  const tolerance = finiteNumber(epsilon);
  if (!state
    || state.cancelled
    || captureIdentity !== state.captureIdentity
    || tolerance === null
    || tolerance < 0
    || state.samples.length < 2) {
    return null;
  }
  const retained = retainedDraftIndexes(state.samples, tolerance);
  if (!retained) return null;
  const keptSamples = state.samples.filter((_sample, index) => retained.has(index));
  if (keptSamples.length < 2) return null;

  const usedSpans = new Set(keptSamples.map(({ point }) => point.span));
  const remap = new Map();
  const spans = [];
  for (let index = 0; index < state.spans.length; index += 1) {
    if (!usedSpans.has(index)) continue;
    remap.set(index, spans.length);
    spans.push(state.spans[index]);
  }
  const points = keptSamples.map(({ point }) => ({
    span: remap.get(point.span),
    ratio: point.ratio,
    price: point.price,
  }));
  return normalizeFreehandStrokeV2({
    version: FREEHAND_STROKE_VERSION,
    sourceProjection: state.sourceProjection,
    sourceProjectionConfig: state.sourceProjectionConfig,
    spans,
    points,
  });
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
