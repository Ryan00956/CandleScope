export const FREEHAND_STROKE_VERSION = 2;
export const FREEHAND_STROKE_V3_VERSION = 3;
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

function safeTime(value) {
  const time = finiteNumber(value);
  return time !== null
    && time >= Number.MIN_SAFE_INTEGER
    && time <= Number.MAX_SAFE_INTEGER
    ? time
    : null;
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
 * Use own-property presence as the only v1/stroke discriminator. An item with a
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
  const stroke = normalizeFreehandStroke(item.stroke);
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

function normalizeV3Span(value) {
  const span = normalizeSpan(value);
  if (!span
    || safeTime(span.exact.left.time) === null
    || safeTime(span.exact.right.time) === null
    || safeTime(span.fallback.fromTime) === null
    || safeTime(span.fallback.toTime) === null) {
    return null;
  }
  return span;
}

function normalizeV3Point(value, spanCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const hasSpan = Object.prototype.hasOwnProperty.call(value, "span");
  const hasRatio = Object.prototype.hasOwnProperty.call(value, "ratio");
  const hasTime = Object.prototype.hasOwnProperty.call(value, "time");
  const hasAnchor = Object.prototype.hasOwnProperty.call(value, "anchor");
  const price = finiteNumber(value.price);
  const representationCount = Number(hasTime)
    + Number(hasAnchor)
    + Number(hasSpan || hasRatio);
  if (price === null || representationCount !== 1) return null;

  if (hasTime) {
    const time = safeTime(value.time);
    return time === null ? null : { time, price };
  }
  if (hasAnchor) {
    const anchor = normalizeExactAnchor(value.anchor);
    return !anchor || safeTime(anchor.time) === null ? null : { anchor, price };
  }
  if (!hasSpan || !hasRatio) return null;
  return normalizePoint(value, spanCount);
}

function freezeNormalizedStroke(stroke) {
  for (const span of stroke.spans) {
    Object.freeze(span.exact.left);
    Object.freeze(span.exact.right);
    Object.freeze(span.exact);
    Object.freeze(span.fallback);
    Object.freeze(span);
  }
  for (const point of stroke.points) {
    if (point.anchor) Object.freeze(point.anchor);
    Object.freeze(point);
  }
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
  if (value && typeof value === "object" && normalizedStrokes.has(value)) {
    return value.version === FREEHAND_STROKE_VERSION ? value : null;
  }
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

/**
 * Validate and clone the persistence-safe freehand stroke v3 schema. V3 keeps
 * the v2 span representation while permitting exact materialized anchors and
 * absolute source-time points. Each point is exactly one representation.
 */
export function normalizeFreehandStrokeV3(value) {
  if (value && typeof value === "object" && normalizedStrokes.has(value)) {
    return value.version === FREEHAND_STROKE_V3_VERSION ? value : null;
  }
  if (value?.version !== FREEHAND_STROKE_V3_VERSION
    || !Array.isArray(value.spans)
    || value.spans.length > MAX_FREEHAND_STROKE_SPANS
    || !Array.isArray(value.points)
    || value.points.length < 2
    || value.points.length > MAX_FREEHAND_STROKE_POINTS) {
    return null;
  }

  const sourceProjection = safeProjectionId(value.sourceProjection);
  const sourceProjectionConfig = safeProjectionConfig(value.sourceProjectionConfig);
  if (!sourceProjection || !sourceProjectionConfig) return null;

  const spans = value.spans.map(normalizeV3Span);
  if (spans.some((span) => span === null)) return null;
  const points = value.points.map((point) => normalizeV3Point(point, spans.length));
  if (points.some((point) => point === null)) return null;

  const normalized = freezeNormalizedStroke({
    version: FREEHAND_STROKE_V3_VERSION,
    sourceProjection,
    sourceProjectionConfig,
    spans,
    points,
  });
  normalizedStrokes.add(normalized);
  return normalized;
}

/** Dispatch only known persistent stroke versions. Unknown versions fail closed. */
export function normalizeFreehandStroke(value) {
  if (value?.version === FREEHAND_STROKE_VERSION) return normalizeFreehandStrokeV2(value);
  if (value?.version === FREEHAND_STROKE_V3_VERSION) return normalizeFreehandStrokeV3(value);
  return null;
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
  const price = finiteNumber(value.price);
  if (price === null) return null;

  let screen = null;
  if (value.screen !== null) {
    const x = finiteNumber(value.screen?.x);
    const y = finiteNumber(value.screen?.y);
    if (x === null || y === null) return null;
    screen = { x, y };
  }

  const hasSpan = Object.prototype.hasOwnProperty.call(value, "span");
  const hasRatio = Object.prototype.hasOwnProperty.call(value, "ratio");
  const hasTime = Object.prototype.hasOwnProperty.call(value, "time");
  const hasAnchor = Object.prototype.hasOwnProperty.call(value, "anchor");
  const representationCount = Number(hasTime)
    + Number(hasAnchor)
    + Number(hasSpan || hasRatio);
  if (representationCount !== 1) return null;

  if (hasTime) {
    const time = safeTime(value.time);
    return time === null ? null : { time, price, screen };
  }
  if (hasAnchor) {
    const anchor = normalizeExactAnchor(value.anchor);
    return !anchor || safeTime(anchor.time) === null
      ? null
      : { anchor, price, screen };
  }

  if (!hasSpan || !hasRatio) return null;
  const span = normalizeSpan(value.span);
  const ratio = finiteNumber(value.ratio);
  if (!span || ratio === null || ratio < 0 || ratio > 1) return null;
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
 * Create a helper-managed mutable v2/v3 draft. `captureIdentity` is deliberately
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
    saturated: false,
    cancelled: false,
  });
  return draft;
}

function appendNormalizedDraftCapture(state, normalized) {
  if (normalized.span) {
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
  } else if (Object.prototype.hasOwnProperty.call(normalized, "time")) {
    state.samples.push({
      point: { time: normalized.time, price: normalized.price },
      screen: normalized.screen,
    });
  } else {
    state.samples.push({
      point: { anchor: normalized.anchor, price: normalized.price },
      screen: normalized.screen,
    });
  }
  if (state.samples.length >= MAX_FREEHAND_STROKE_POINTS) state.saturated = true;
  return true;
}

/** Append one capture. The draft is unchanged when validation fails. */
export function appendFreehandStrokeCapture(draft, capture, captureIdentity) {
  const state = draftStates.get(draft);
  const normalized = normalizeDraftCapture(capture);
  if (!state
    || state.cancelled
    || state.saturated
    || captureIdentity !== state.captureIdentity
    || !normalized
    || state.samples.length >= MAX_FREEHAND_STROKE_POINTS) {
    return false;
  }
  return appendNormalizedDraftCapture(state, normalized);
}

/** Append a capture batch atomically. */
export function appendFreehandStrokeCaptureBatch(draft, batch) {
  const state = draftStates.get(draft);
  if (!state
    || state.cancelled
    || state.saturated
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
    if (!capture.span) continue;
    const key = spanKey(capture.span);
    if (!state.spanIndexes.has(key)) newKeys.add(key);
  }
  if (state.spans.length + newKeys.size > MAX_FREEHAND_STROKE_SPANS) return false;

  for (const capture of normalizedCaptures) {
    if (!appendNormalizedDraftCapture(state, capture)) return false;
  }
  return true;
}

function previewPointFromCapture(capture) {
  return capture.screen ? { ...capture.screen } : null;
}

/**
 * Append as much of one live pointer batch as the bounded draft can retain.
 * Invalid identity/data returns `null` without mutation. Capacity exhaustion is
 * a successful terminal state: callers keep the draft and commit it on mouseup.
 */
export function appendFreehandStrokeCaptureBatchIncremental(draft, batch) {
  const state = draftStates.get(draft);
  if (!state
    || state.cancelled
    || batch?.captureIdentity !== state.captureIdentity
    || batch?.sourceProjection !== state.sourceProjection
    || batch?.sourceProjectionConfig !== state.sourceProjectionConfig
    || !Array.isArray(batch?.captures)
    || batch.captures.length === 0) {
    return null;
  }
  if (state.saturated) {
    return { appendedCount: 0, previewPoints: [], saturated: true };
  }

  const normalizedCaptures = batch.captures.map(normalizeDraftCapture);
  if (normalizedCaptures.some((capture) => capture === null)) return null;

  const availablePoints = MAX_FREEHAND_STROKE_POINTS - state.samples.length;
  const availableSpans = MAX_FREEHAND_STROKE_SPANS - state.spans.length;
  const pendingSpanKeys = new Set();
  let appendCount = 0;
  for (const capture of normalizedCaptures) {
    if (appendCount >= availablePoints) break;
    if (capture.span) {
      const key = spanKey(capture.span);
      if (!state.spanIndexes.has(key) && !pendingSpanKeys.has(key)) {
        if (pendingSpanKeys.size >= availableSpans) break;
        pendingSpanKeys.add(key);
      }
    }
    appendCount += 1;
  }

  const accepted = normalizedCaptures.slice(0, appendCount);
  for (const capture of accepted) {
    if (!appendNormalizedDraftCapture(state, capture)) return null;
  }
  if (appendCount < normalizedCaptures.length) state.saturated = true;

  return {
    appendedCount: appendCount,
    previewPoints: accepted.map(previewPointFromCapture),
    saturated: state.saturated,
  };
}

export function isFreehandStrokeDraftSaturated(draft) {
  const state = draftStates.get(draft);
  return !!state && !state.cancelled && state.saturated;
}

export function getFreehandStrokeDraftRemainingCapacity(draft) {
  const state = draftStates.get(draft);
  return state && !state.cancelled
    ? Math.max(0, MAX_FREEHAND_STROKE_POINTS - state.samples.length)
    : null;
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

  const usesV3Point = keptSamples.some(({ point }) => (
    Object.prototype.hasOwnProperty.call(point, "time")
      || Object.prototype.hasOwnProperty.call(point, "anchor")
  ));
  const usedSpans = new Set(keptSamples
    .map(({ point }) => point.span)
    .filter((span) => span !== undefined));
  const remap = new Map();
  const spans = [];
  for (let index = 0; index < state.spans.length; index += 1) {
    if (!usedSpans.has(index)) continue;
    remap.set(index, spans.length);
    spans.push(state.spans[index]);
  }
  const points = keptSamples.map(({ point }) => {
    if (Object.prototype.hasOwnProperty.call(point, "time")) {
      return { time: point.time, price: point.price };
    }
    if (Object.prototype.hasOwnProperty.call(point, "anchor")) {
      return { anchor: point.anchor, price: point.price };
    }
    return {
        span: remap.get(point.span),
        ratio: point.ratio,
        price: point.price,
    };
  });
  return normalizeFreehandStroke({
    version: usesV3Point ? FREEHAND_STROKE_V3_VERSION : FREEHAND_STROKE_VERSION,
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

function resolveNormalizedFreehandStrokePoints(stroke, {
  resolveAnchor,
  resolveSpan,
  resolveTime,
}) {
  const resolvedSpans = new Map();
  return stroke.points.map((point, pointIndex) => {
    if (Object.prototype.hasOwnProperty.call(point, "time")) {
      if (typeof resolveTime !== "function") return null;
      let x = null;
      try {
        x = finiteNumber(resolveTime(point.time, pointIndex, point, stroke));
      } catch {
        x = null;
      }
      return x === null ? null : { x, price: point.price };
    }
    if (Object.prototype.hasOwnProperty.call(point, "anchor")) {
      if (typeof resolveAnchor !== "function") return null;
      let x = null;
      try {
        x = finiteNumber(resolveAnchor(point.anchor, pointIndex, point, stroke));
      } catch {
        x = null;
      }
      return x === null ? null : { x, price: point.price };
    }

    if (!resolvedSpans.has(point.span)) {
      let resolved = null;
      if (typeof resolveSpan === "function") {
        try {
          resolved = normalizeResolvedSpan(resolveSpan(
            stroke.spans[point.span],
            point.span,
            stroke,
          ));
        } catch {
          resolved = null;
        }
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

/**
 * Resolve a v2 stroke with at most one bridge call per referenced span.
 * Unresolved spans become `null` path gaps; callers must not reconnect across
 * those markers.
 */
export function resolveFreehandStrokeV2Points(value, resolveSpan) {
  const stroke = normalizeFreehandStrokeV2(value);
  return stroke && typeof resolveSpan === "function"
    ? resolveNormalizedFreehandStrokePoints(stroke, {
        resolveAnchor: null,
        resolveSpan,
        resolveTime: null,
      })
    : [];
}

/** Resolve a strict v3 stroke through lineage-span and absolute-time bridges. */
export function resolveFreehandStrokeV3Points(value, {
  resolveAnchor = null,
  resolveSpan = null,
  resolveTime = null,
} = {}) {
  const stroke = normalizeFreehandStrokeV3(value);
  return stroke
    ? resolveNormalizedFreehandStrokePoints(stroke, { resolveAnchor, resolveSpan, resolveTime })
    : [];
}

/** Resolve any known persistent stroke version; unknown versions fail closed. */
export function resolveFreehandStrokePoints(value, {
  resolveAnchor = null,
  resolveSpan = null,
  resolveTime = null,
} = {}) {
  if (value?.version === FREEHAND_STROKE_VERSION) {
    return resolveFreehandStrokeV2Points(value, resolveSpan);
  }
  if (value?.version === FREEHAND_STROKE_V3_VERSION) {
    return resolveFreehandStrokeV3Points(value, { resolveAnchor, resolveSpan, resolveTime });
  }
  return [];
}
