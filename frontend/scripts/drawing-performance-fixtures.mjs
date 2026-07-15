const STORAGE_PREFIX = "candlescope-drawings";

import { PHASE6_LINEAGE_REPRESENTATION } from "./drawing-performance-phase6-lineage.mjs";

export const FIXTURE_NAMES = Object.freeze([
  "empty",
  "singleFreehand4096",
  "freehand64x512",
  "freehandLineage64x512",
  "entities200",
  "entities512",
  "phase4Migrated64",
  "phase4Mixed64",
]);

export const PHASE4_SCENE_DRAWING_TYPES = Object.freeze([
  "line",
  "axis-line",
  "shape",
]);

export const FIXTURE_LIMITS = Object.freeze({
  maxStorageChars: 2_000_000,
  maxDrawings: 512,
  maxFreehandPoints: 32_768,
  maxFreehandSpans: 16_384,
  maxFreehandPointsPerDrawing: 4_096,
  maxFreehandSpansPerDrawing: 2_048,
});

export const DEFAULT_FIXTURE_OPTIONS = Object.freeze({
  scopeKey: "binance:spot:BTCUSDT__main",
  startTime: 1_700_000_000,
  intervalSeconds: 60,
  seed: 0x0cada5c0,
});

export const DEFAULT_MOCK_VISIBLE_PRICE_RANGE = Object.freeze({
  min: 62_000,
  max: 64_000,
});

const FIXTURE_NAME_SET = new Set(FIXTURE_NAMES);
const PHASE4_SCENE_DRAWING_TYPE_SET = new Set(PHASE4_SCENE_DRAWING_TYPES);
const COLORS = Object.freeze([
  "#2962ff",
  "#00bfa5",
  "#ff6d00",
  "#d500f9",
  "#00b0ff",
  "#ff1744",
  "#64dd17",
  "#aa00ff",
]);

function fixtureNameHash(name) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createRandom(seed, fixtureName) {
  let state = (seed ^ fixtureNameHash(fixtureName)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function roundedPrice(value) {
  return Number(value.toFixed(4));
}

function normalizeOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Drawing fixture options must be an object");
  }

  const scopeKey = options.scopeKey ?? DEFAULT_FIXTURE_OPTIONS.scopeKey;
  const startTime = options.startTime ?? DEFAULT_FIXTURE_OPTIONS.startTime;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_FIXTURE_OPTIONS.intervalSeconds;
  const seed = options.seed ?? DEFAULT_FIXTURE_OPTIONS.seed;

  if (typeof scopeKey !== "string" || scopeKey.length === 0) {
    throw new TypeError("Drawing fixture scopeKey must be a non-empty string");
  }
  if (!Number.isFinite(startTime)
    || startTime < Number.MIN_SAFE_INTEGER
    || startTime > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Drawing fixture startTime must be a finite safe-range number");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new TypeError("Drawing fixture intervalSeconds must be a positive finite number");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError("Drawing fixture seed must be an unsigned 32-bit integer");
  }

  const defaultEndTime = startTime + intervalSeconds * 511;
  const lineageContract = normalizeLineageContract(options.lineageContract, {
    startTime,
    endTime: defaultEndTime,
  });
  const priceProfile = normalizePriceProfile(options.priceProfile);
  return { scopeKey, startTime, intervalSeconds, seed, lineageContract, priceProfile };
}

function normalizePriceProfile(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Drawing fixture priceProfile must be an object");
  }
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new TypeError("Drawing fixture priceProfile endpoints must be finite");
  }
  return Object.freeze({ start, end });
}

function profiledPrice(priceProfile, ratio, fallback) {
  if (!priceProfile) return fallback;
  const boundedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  return priceProfile.start + (priceProfile.end - priceProfile.start) * boundedRatio;
}

function normalizeLineageContract(value, { startTime, endTime }) {
  const fallback = {
    sourceProjection: PHASE6_LINEAGE_REPRESENTATION.projectorId,
    sourceProjectionConfig: PHASE6_LINEAGE_REPRESENTATION.projectionConfig,
    exact: {
      left: { time: startTime, sourceOrdinal: 1 },
      right: { time: endTime, sourceOrdinal: 1 },
    },
    fallback: { fromTime: startTime, toTime: endTime, leftRatio: 0, rightRatio: 1 },
    derivedRowCount: null,
  };
  const candidate = value ?? fallback;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Drawing fixture lineageContract must be an object");
  }
  const sourceProjection = candidate.sourceProjection;
  const sourceProjectionConfig = candidate.sourceProjectionConfig;
  const exact = candidate.exact;
  const envelope = candidate.fallback;
  const leftTime = Number(exact?.left?.time);
  const rightTime = Number(exact?.right?.time);
  const leftOrdinal = Number(exact?.left?.sourceOrdinal);
  const rightOrdinal = Number(exact?.right?.sourceOrdinal);
  const fromTime = Number(envelope?.fromTime);
  const toTime = Number(envelope?.toTime);
  const leftRatio = Number(envelope?.leftRatio);
  const rightRatio = Number(envelope?.rightRatio);
  if (typeof sourceProjection !== "string" || sourceProjection.length === 0
    || typeof sourceProjectionConfig !== "string" || sourceProjectionConfig.length === 0
    || !Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime > rightTime
    || !Number.isSafeInteger(leftOrdinal) || leftOrdinal < 0
    || !Number.isSafeInteger(rightOrdinal) || rightOrdinal < 0
    || !Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime
    || !Number.isFinite(leftRatio) || !Number.isFinite(rightRatio)
    || leftRatio < 0 || rightRatio > 1 || leftRatio >= rightRatio) {
    throw new TypeError("Drawing fixture lineageContract is invalid");
  }
  const derivedRowCount = candidate.derivedRowCount == null
    ? null
    : Number(candidate.derivedRowCount);
  if (derivedRowCount !== null
    && (!Number.isSafeInteger(derivedRowCount) || derivedRowCount <= 0)) {
    throw new TypeError("Drawing fixture lineageContract derivedRowCount must be positive");
  }
  return Object.freeze({
    sourceProjection,
    sourceProjectionConfig,
    exact: Object.freeze({
      left: Object.freeze({ time: leftTime, sourceOrdinal: leftOrdinal }),
      right: Object.freeze({ time: rightTime, sourceOrdinal: rightOrdinal }),
    }),
    fallback: Object.freeze({ fromTime, toTime, leftRatio, rightRatio }),
    derivedRowCount,
  });
}

function absoluteTime(startTime, intervalSeconds, offset) {
  const time = startTime + intervalSeconds * offset;
  if (!Number.isFinite(time)
    || time < Number.MIN_SAFE_INTEGER
    || time > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Drawing fixture time range exceeds the persistence-safe range");
  }
  return time;
}

function buildFreehandDrawing({
  fixtureName,
  strokeIndex,
  pointCount,
  startTime,
  intervalSeconds,
  random,
  priceProfile,
}) {
  const phase = random() * Math.PI * 2;
  const center = 62_800 + (strokeIndex - 31.5) * 4;
  const amplitude = 25 + random() * 35;
  const frequency = 0.018 + random() * 0.022;
  const points = new Array(pointCount);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const ratio = pointIndex / Math.max(1, pointCount - 1);
    const wave = Math.sin(pointIndex * frequency + phase) * amplitude;
    const secondaryWave = Math.cos(pointIndex * 0.006 + strokeIndex * 0.17) * 12;
    const jitter = (random() - 0.5) * (priceProfile ? 0.25 : 3.5);
    points[pointIndex] = {
      time: absoluteTime(startTime, intervalSeconds, pointIndex),
      price: roundedPrice(
        profiledPrice(priceProfile, ratio, center) + wave + secondaryWave + jitter,
      ),
    };
  }

  return {
    type: "freehand",
    id: `perf-${fixtureName}-freehand-${String(strokeIndex).padStart(3, "0")}`,
    stroke: {
      version: 3,
      sourceProjection: "time-axis",
      sourceProjectionConfig: "drawing-performance-fixture:v1",
      spans: [],
      points,
    },
    color: COLORS[strokeIndex % COLORS.length],
    lineWidth: 1 + (strokeIndex % 3),
  };
}

function buildLineageFreehandDrawing({
  fixtureName,
  strokeIndex,
  pointCount,
  random,
  lineageContract,
  priceProfile,
}) {
  const phase = random() * Math.PI * 2;
  const center = 62_800 + (strokeIndex - 31.5) * 4;
  const amplitude = 25 + random() * 35;
  const frequency = 0.018 + random() * 0.022;
  const points = new Array(pointCount);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const ratio = pointIndex / Math.max(1, pointCount - 1);
    const wave = Math.sin(pointIndex * frequency + phase) * amplitude;
    const secondaryWave = Math.cos(pointIndex * 0.006 + strokeIndex * 0.17) * 12;
    const jitter = (random() - 0.5) * (priceProfile ? 0.25 : 3.5);
    points[pointIndex] = {
      span: 0,
      ratio: Number(ratio.toFixed(8)),
      price: roundedPrice(
        profiledPrice(priceProfile, ratio, center) + wave + secondaryWave + jitter,
      ),
    };
  }

  return {
    type: "freehand",
    id: `perf-${fixtureName}-freehand-${String(strokeIndex).padStart(3, "0")}`,
    stroke: {
      version: 3,
      sourceProjection: lineageContract.sourceProjection,
      sourceProjectionConfig: lineageContract.sourceProjectionConfig,
      spans: [{
        exact: lineageContract.exact,
        fallback: lineageContract.fallback,
      }],
      points,
    },
    color: COLORS[strokeIndex % COLORS.length],
    lineWidth: 1 + (strokeIndex % 3),
  };
}

function buildEntityDrawing({ index, count, startTime, intervalSeconds, random, priceProfile }) {
  const slot = index * 2;
  const firstTime = absoluteTime(startTime, intervalSeconds, slot);
  const secondTime = absoluteTime(startTime, intervalSeconds, slot + 1);
  const profiledCenter = profiledPrice(
    priceProfile,
    (slot + 0.5) / Math.max(1, count * 2 - 1),
    62_500,
  );
  const center = priceProfile
    ? profiledCenter + ((index % 48) - 23.5) * 6 + (random() - 0.5) * 5
    : 62_500 + (index % 48) * 11 + (random() - 0.5) * 5;
  const delta = 18 + random() * 35;
  const color = COLORS[index % COLORS.length];
  const dataPoints = [
    { time: firstTime, price: roundedPrice(center - delta) },
    { time: secondTime, price: roundedPrice(center + delta) },
  ];

  if (index % 4 !== 3) {
    return {
      type: "line",
      id: `perf-entity-line-${String(index).padStart(3, "0")}`,
      lineType: "line-segment",
      dataPoints,
      color,
      lineWidth: 1 + (index % 2),
    };
  }

  return {
    type: "shape",
    id: `perf-entity-shape-${String(index).padStart(3, "0")}`,
    shapeType: index % 8 === 3 ? "rectangle" : "ellipse",
    dataPoints,
    color,
    lineWidth: 1,
    fillColor: color,
    fillOpacity: 0.12 + (index % 3) * 0.04,
    lineStyle: index % 8 === 3 ? "solid" : "dashed",
  };
}

function buildPhase4MigratedDrawing({ index, startTime, intervalSeconds, random }) {
  const slot = index * 2;
  const firstTime = absoluteTime(startTime, intervalSeconds, slot);
  const secondTime = absoluteTime(startTime, intervalSeconds, slot + 1);
  const center = 62_550 + (index % 40) * 13 + (random() - 0.5) * 4;
  const delta = 16 + random() * 28;
  const color = COLORS[index % COLORS.length];
  const dataPoints = [
    { time: firstTime, price: roundedPrice(center - delta) },
    { time: secondTime, price: roundedPrice(center + delta) },
  ];

  if (index % 3 === 0) {
    return {
      type: "line",
      id: `perf-phase4-line-${String(index).padStart(3, "0")}`,
      lineType: index % 6 === 0 ? "line-ray" : "line-segment",
      dataPoints,
      color,
      lineWidth: 1 + (index % 2),
    };
  }
  if (index % 3 === 1) {
    const axisLineTypes = ["horizontal", "vertical", "cross"];
    return {
      type: "axis-line",
      id: `perf-phase4-axis-${String(index).padStart(3, "0")}`,
      axisLineType: axisLineTypes[index % axisLineTypes.length],
      dataPoint: dataPoints[0],
      color,
      lineWidth: 1 + (index % 2),
    };
  }
  return {
    type: "shape",
    id: `perf-phase4-shape-${String(index).padStart(3, "0")}`,
    shapeType: index % 2 === 0 ? "rectangle" : "ellipse",
    dataPoints,
    color,
    lineWidth: 1,
    fillColor: color,
    fillOpacity: 0.14,
    lineStyle: index % 2 === 0 ? "solid" : "dashed",
  };
}

function buildDrawings(name, options, random) {
  switch (name) {
    case "empty":
      return [];
    case "singleFreehand4096":
      return [buildFreehandDrawing({
        fixtureName: name,
        strokeIndex: 0,
        pointCount: 4_096,
        startTime: options.startTime,
        intervalSeconds: options.intervalSeconds,
        random,
        priceProfile: options.priceProfile,
      })];
    case "freehand64x512":
      return Array.from({ length: 64 }, (_, strokeIndex) => buildFreehandDrawing({
        fixtureName: name,
        strokeIndex,
        pointCount: 512,
        startTime: options.startTime,
        intervalSeconds: options.intervalSeconds,
        random,
        priceProfile: options.priceProfile,
      }));
    case "freehandLineage64x512":
      return Array.from({ length: 64 }, (_, strokeIndex) => buildLineageFreehandDrawing({
        fixtureName: name,
        strokeIndex,
        pointCount: 512,
        random,
        lineageContract: options.lineageContract,
        priceProfile: options.priceProfile,
      }));
    case "entities200":
    case "entities512": {
      const count = name === "entities200" ? 200 : 512;
      return Array.from({ length: count }, (_, index) => buildEntityDrawing({
        index,
        count,
        startTime: options.startTime,
        intervalSeconds: options.intervalSeconds,
        random,
        priceProfile: options.priceProfile,
      }));
    }
    case "phase4Migrated64":
      return Array.from({ length: 64 }, (_, index) => buildPhase4MigratedDrawing({
        index,
        startTime: options.startTime,
        intervalSeconds: options.intervalSeconds,
        random,
      }));
    case "phase4Mixed64":
      return [
        ...Array.from({ length: 32 }, (_, index) => buildPhase4MigratedDrawing({
          index,
          startTime: options.startTime,
          intervalSeconds: options.intervalSeconds,
          random,
        })),
        ...Array.from({ length: 32 }, (_, strokeIndex) => buildFreehandDrawing({
          fixtureName: name,
          strokeIndex,
          pointCount: 16,
          startTime: options.startTime,
          intervalSeconds: options.intervalSeconds,
          random,
        })),
      ];
    default:
      throw new RangeError(`Unknown drawing performance fixture: ${name}`);
  }
}

function summarizeDrawings(drawings) {
  let freehandDrawingCount = 0;
  let pointCount = 0;
  let freehandPointCount = 0;
  let freehandSpanCount = 0;
  let maxFreehandPointsPerDrawing = 0;
  let maxFreehandSpansPerDrawing = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  const drawingTypes = {};
  let phase4SceneDrawingCount = 0;

  const recordTime = (time) => {
    if (!Number.isFinite(time)) return;
    minTime = Math.min(minTime, time);
    maxTime = Math.max(maxTime, time);
  };
  const recordPrice = (price) => {
    if (!Number.isFinite(price)) return;
    minPrice = Math.min(minPrice, price);
    maxPrice = Math.max(maxPrice, price);
  };

  for (const drawing of drawings) {
    drawingTypes[drawing.type] = (drawingTypes[drawing.type] ?? 0) + 1;
    if (PHASE4_SCENE_DRAWING_TYPE_SET.has(drawing.type)) phase4SceneDrawingCount += 1;
    if (drawing.type === "freehand" || drawing.type === "highlighter") {
      const drawingPointCount = drawing.stroke?.points?.length ?? drawing.dataPoints?.length ?? 0;
      const spanCount = drawing.stroke?.spans?.length ?? 0;
      freehandDrawingCount += 1;
      pointCount += drawingPointCount;
      freehandPointCount += drawingPointCount;
      freehandSpanCount += spanCount;
      maxFreehandPointsPerDrawing = Math.max(maxFreehandPointsPerDrawing, drawingPointCount);
      maxFreehandSpansPerDrawing = Math.max(maxFreehandSpansPerDrawing, spanCount);
      for (const span of drawing.stroke?.spans ?? []) {
        recordTime(span.exact?.left?.time);
        recordTime(span.exact?.right?.time);
        recordTime(span.fallback?.fromTime);
        recordTime(span.fallback?.toTime);
      }
      for (const point of drawing.stroke?.points ?? drawing.dataPoints ?? []) {
        recordTime(point.time ?? point.anchor?.time);
        recordPrice(point.price);
      }
      continue;
    }
    const dataPoints = drawing.dataPoints ?? [];
    pointCount += dataPoints.length;
    for (const point of dataPoints) {
      recordTime(point.time);
      recordPrice(point.price);
    }
    if (drawing.dataPoint != null) pointCount += 1;
    recordTime(drawing.dataPoint?.time);
    recordPrice(drawing.dataPoint?.price);
  }

  return {
    drawingCount: drawings.length,
    drawingTypes,
    pointCount,
    freehandDrawingCount,
    freehandPointCount,
    freehandSpanCount,
    maxFreehandPointsPerDrawing,
    maxFreehandSpansPerDrawing,
    phase4SceneDrawingCount,
    phase4LegacyDrawingCount: drawings.length - phase4SceneDrawingCount,
    phase4ExpectedAttachedPrimitiveCount: 1 + drawings.length - phase4SceneDrawingCount,
    timeRange: {
      start: minTime === Infinity ? null : minTime,
      end: maxTime === -Infinity ? null : maxTime,
    },
    priceRange: {
      min: minPrice === Infinity ? null : minPrice,
      max: maxPrice === -Infinity ? null : maxPrice,
    },
  };
}

export function fixtureTimeOffsetDenominator(fixtureName) {
  if (fixtureName === "singleFreehand4096") return 4_095;
  if (fixtureName === "freehand64x512" || fixtureName === "freehandLineage64x512") return 511;
  if (fixtureName === "entities200") return 399;
  if (fixtureName === "entities512") return 1_023;
  if (fixtureName === "phase4Migrated64") return 127;
  if (fixtureName === "phase4Mixed64") return 63;
  return 1;
}

function assertWithinBudgets(summary, storageChars) {
  if (summary.drawingCount > FIXTURE_LIMITS.maxDrawings
    || summary.freehandPointCount > FIXTURE_LIMITS.maxFreehandPoints
    || summary.freehandSpanCount > FIXTURE_LIMITS.maxFreehandSpans
    || summary.maxFreehandPointsPerDrawing > FIXTURE_LIMITS.maxFreehandPointsPerDrawing
    || summary.maxFreehandSpansPerDrawing > FIXTURE_LIMITS.maxFreehandSpansPerDrawing
    || storageChars > FIXTURE_LIMITS.maxStorageChars) {
    throw new RangeError("Generated drawing performance fixture exceeds a persistence budget");
  }
}

/**
 * Build a persistence-ready deterministic drawing fixture.
 *
 * `raw` is the exact value to pass to localStorage.setItem(storageKey, raw).
 * Freehand fixtures use the current v3 codec with absolute source-time or
 * source-lineage span points; no primitive instance/private field is involved.
 */
export function buildDrawingFixture(name, options = {}) {
  if (!FIXTURE_NAME_SET.has(name)) {
    throw new RangeError(`Unknown drawing performance fixture: ${name}`);
  }
  const normalizedOptions = normalizeOptions(options);
  const random = createRandom(normalizedOptions.seed, name);
  const drawings = buildDrawings(name, normalizedOptions, random);
  const raw = JSON.stringify(drawings);
  const summary = summarizeDrawings(drawings);
  assertWithinBudgets(summary, raw.length);

  return {
    storageKey: `${STORAGE_PREFIX}-${normalizedOptions.scopeKey}`,
    raw,
    metadata: {
      name,
      scopeKey: normalizedOptions.scopeKey,
      seed: normalizedOptions.seed,
      startTime: normalizedOptions.startTime,
      intervalSeconds: normalizedOptions.intervalSeconds,
      storageChars: raw.length,
      ...summary,
      ...(name === "freehandLineage64x512" ? {
        sourceProjection: normalizedOptions.lineageContract.sourceProjection,
        sourceProjectionConfig: normalizedOptions.lineageContract.sourceProjectionConfig,
        lineageExact: normalizedOptions.lineageContract.exact,
        lineageFallback: normalizedOptions.lineageContract.fallback,
        lineageDerivedRowCount: normalizedOptions.lineageContract.derivedRowCount,
      } : {}),
      ...(normalizedOptions.priceProfile
        ? { priceProfile: normalizedOptions.priceProfile }
        : {}),
      withinBudgets: true,
    },
  };
}
