import {
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  mergeIndicatorItems,
  mergeIndicatorLines,
  replaceIndicatorItemsRange,
  replaceIndicatorLinesRange,
  resolveWsValue,
  stringSignature,
  upsertLinePoint,
} from "./indicatorPayloadRuntime.js";
import {
  dependencyAvailable,
  dependencyState,
  klineDependencyKey,
  registerCacheDependency,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import {
  indicatorRangeRightEdge,
  indicatorRevisionsCompatible,
  invalidateIndicatorRangeSegments,
  mergeIndicatorRangeSegments,
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
  subtractIndicatorRange,
} from "./indicatorRangeCoverage.js";

const MAX_INDICATOR_CACHE_ENTRIES = 80;
const OUTPUT_KEYS = ["markers", "fills", "hlines", "bgcolors", "barcolors", "signals"];
const INDICATOR_POINT_ESTIMATED_BYTES = 80;
const OUTPUT_ITEM_ESTIMATED_BYTES = 120;

const entries = new Map();

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function normalizeSeriesPart(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizeContext(context = {}) {
  return {
    exchange: normalizeSeriesPart(context.exchange, "binance").toLowerCase(),
    marketType: normalizeSeriesPart(context.marketType, "spot").toLowerCase(),
    symbol: normalizeSeriesPart(context.symbol, "UNKNOWN").toUpperCase(),
    interval: normalizeSeriesPart(context.interval, "1m"),
    candleUpColor: normalizeSeriesPart(context.candleUpColor),
    candleDownColor: normalizeSeriesPart(context.candleDownColor),
  };
}

function indicatorDependencyKey(context = {}) {
  const normalized = normalizeContext(context);
  return klineDependencyKey({
    exchange: normalized.exchange,
    marketType: normalized.marketType,
    symbol: normalized.symbol,
    interval: normalized.interval,
  });
}

function indicatorIdentity(indicator = {}, context = {}) {
  const builtin = isBuiltinIndicator(indicator);
  const computeParams = resolveCacheComputeParams(indicator, context);
  return [
    indicator.id || "",
    builtin ? "builtin" : "script",
    getBuiltinIndicatorName(indicator) || indicator.engineName || indicator.name || "",
    stringSignature(indicator.script || ""),
    indicator.securityMode || "",
    stableJson(computeParams || {}),
  ].join("|");
}

function resolveCacheComputeParams(indicator = {}, context = {}) {
  const params = indicator.params || {};
  if (
    (indicator.id !== "vol" && indicator.engineName !== "VOL")
    || (!context.candleUpColor && !context.candleDownColor)
  ) {
    return params;
  }
  return {
    ...params,
    up_color: context.candleUpColor || params.up_color || "#22c55e",
    down_color: context.candleDownColor || params.down_color || "#ef4444",
  };
}

function emptyNormalized() {
  return {
    lines: [],
    markers: [],
    fills: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
  };
}

function normalizeCachedPayload(normalized = {}) {
  return {
    ...emptyNormalized(),
    ...clone(normalized),
  };
}

function retargetItems(items = [], indicatorId) {
  return (clone(items) || []).map((item) => ({ ...item, indicatorId }));
}

function retargetNormalized(normalized, indicatorId) {
  const next = normalizeCachedPayload(normalized);
  for (const key of OUTPUT_KEYS) {
    next[key] = retargetItems(next[key], indicatorId);
  }
  return next;
}

function buildOutputCoverage(normalized = {}) {
  let firstTime = null;
  let lastTime = null;
  let points = 0;
  for (const line of normalized.lines || []) {
    for (const point of line.data || []) {
      const time = Number(point?.time);
      if (!Number.isFinite(time)) continue;
      firstTime = firstTime == null ? time : Math.min(firstTime, time);
      lastTime = lastTime == null ? time : Math.max(lastTime, time);
      points += 1;
    }
  }
  if (!points) return null;
  return {
    firstTime,
    lastTime,
    points,
  };
}

function extendCoverage(coverage, time, deltaPoints) {
  const normalizedTime = Number(time);
  if (!Number.isFinite(normalizedTime)) return coverage || null;
  const currentPoints = Number(coverage?.points || 0);
  const nextPoints = Math.max(0, currentPoints + Number(deltaPoints || 0));
  if (nextPoints <= 0) return null;
  return {
    firstTime: coverage?.firstTime == null ? normalizedTime : Math.min(coverage.firstTime, normalizedTime),
    lastTime: coverage?.lastTime == null ? normalizedTime : Math.max(coverage.lastTime, normalizedTime),
    points: nextPoints,
  };
}

function countLinePoints(normalized = {}) {
  return (normalized.lines || []).reduce(
    (total, line) => total + (Array.isArray(line.data) ? line.data.length : 0),
    0,
  );
}

function countOutputItems(normalized = {}) {
  return OUTPUT_KEYS.reduce(
    (total, key) => total + (Array.isArray(normalized[key]) ? normalized[key].length : 0),
    0,
  );
}

function hasTimedData(items = []) {
  return items.some((item) => Array.isArray(item?.data) && item.data.some((point) => Number.isFinite(Number(point?.time))));
}

function analyzeTrimSafety(normalized = {}) {
  const unsafeOutputs = OUTPUT_KEYS.filter((key) => {
    const items = normalized[key] || [];
    if (!Array.isArray(items) || items.length === 0) return false;
    return key !== "barcolors" || hasTimedData(items);
  });
  const safeLines = (normalized.lines || []).every((line) => (
    Array.isArray(line.data)
    && (!line.colorData || Array.isArray(line.colorData))
  ));
  return {
    safeRangeTrim: safeLines && unsafeOutputs.length === 0,
    reason: safeLines && unsafeOutputs.length === 0 ? "line-only-time-series" : "complex-output",
    unsafeOutputs,
  };
}

function buildRangeSegments(coverage) {
  if (!coverage?.points) return [];
  return [{
    start: coverage.firstTime,
    end: coverage.lastTime,
    points: coverage.points,
  }];
}

function rangeStep(context = {}) {
  return parseIntervalSeconds(context.interval) || 1;
}

function appendComputedRange(segments, rangeInput, revision, context) {
  const range = normalizeIndicatorRange(rangeInput);
  if (!range) return mergeIndicatorRangeSegments(segments, { step: rangeStep(context) });
  const normalizedRevision = normalizeIndicatorRevision(revision);
  return mergeIndicatorRangeSegments([
    ...(segments || []),
    { ...range, ...(normalizedRevision ? { revision: normalizedRevision } : {}) },
  ], { step: rangeStep(context) });
}

function clearStaleRange(segments, rangeInput, context) {
  const range = normalizeIndicatorRange(rangeInput);
  if (!range) return segments || [];
  const step = rangeStep(context);
  return (segments || []).flatMap((segment) => subtractIndicatorRange(segment, [range], { step }));
}

function trimNormalizedBefore(normalized = {}, keepStart) {
  const cutoff = Number(keepStart);
  if (!Number.isFinite(cutoff)) return normalized;
  return {
    ...normalized,
    lines: (normalized.lines || []).map((line) => ({
      ...line,
      data: (line.data || []).filter((point) => Number(point?.time) >= cutoff),
      ...(line.colorData ? {
        colorData: (line.colorData || []).filter((point) => Number(point?.time) >= cutoff),
      } : {}),
    })),
  };
}

function samePlainObject(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function lineIdentity(line = {}) {
  return line.id || line.outputName || line.name || "";
}

function clonePointWithSharing(point, previousPoint) {
  return samePlainObject(point, previousPoint) ? previousPoint : { ...point };
}

function clonePointArrayWithSharing(points = [], previousPoints = []) {
  let changed = points.length !== previousPoints.length;
  const next = points.map((point, index) => {
    const shared = clonePointWithSharing(point, previousPoints[index]);
    if (shared !== previousPoints[index]) changed = true;
    return shared;
  });
  return changed ? next : previousPoints;
}

function normalizeLinesWithSharing(lines = [], previousLines = []) {
  const previousByIdentity = new Map(previousLines.map((line) => [lineIdentity(line), line]));
  return (lines || []).map((line, index) => {
    const previous = previousByIdentity.get(lineIdentity(line)) || previousLines[index] || null;
    const data = clonePointArrayWithSharing(line.data || [], previous?.data || []);
    const colorData = line.colorData
      ? clonePointArrayWithSharing(line.colorData, previous?.colorData || [])
      : undefined;
    const base = {
      ...line,
      data,
      ...(colorData ? { colorData } : {}),
    };
    if (
      previous
      && data === previous.data
      && (!line.colorData || colorData === previous.colorData)
      && samePlainObject({ ...base, data: undefined, colorData: undefined }, { ...previous, data: undefined, colorData: undefined })
    ) {
      return previous;
    }
    return base;
  });
}

function enforceLimit() {
  while (entries.size > MAX_INDICATOR_CACHE_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey == null) return;
    entries.delete(oldestKey);
    unregisterCacheResource("indicator-result-cache", oldestKey);
  }
}

function putEntry(key, patch) {
  const dependencyKey = indicatorDependencyKey(patch.context);
  if (!dependencyAvailable(dependencyKey)) {
    return null;
  }
  const next = {
    ...patch,
    key,
    dependencyKey,
    lastUpdatedMs: Date.now(),
    lastAccessMs: Date.now(),
  };
  entries.delete(key);
  entries.set(key, next);
  registerCacheResource("indicator-result-cache", key, {
    type: "indicator",
    dependencyKey,
    indicatorId: next.indicatorId,
    context: clone(next.context),
  });
  registerCacheDependency("indicator-result-cache", key, dependencyKey);
  enforceLimit();
  return next;
}

export function buildIndicatorCacheContext(context = {}) {
  return normalizeContext(context);
}

export function buildIndicatorResultCacheKey(indicator, context = {}) {
  const normalizedContext = normalizeContext(context);
  return [
    normalizedContext.exchange,
    normalizedContext.marketType,
    normalizedContext.symbol,
    normalizedContext.interval,
    indicatorIdentity(indicator, normalizedContext),
  ].join("::");
}

export function buildIndicatorCacheHydrationSignature(indicators = [], context = {}) {
  return (indicators || [])
    .map((indicator) => buildIndicatorResultCacheKey(indicator, context))
    .join("\n");
}

export function cacheIndicatorSnapshot(indicator, context, normalized, schema = [], metadata = {}) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const normalizedContext = normalizeContext(context);
  const payload = normalizeCachedPayload(normalized);
  const revision = normalizeIndicatorRevision(metadata.revision || metadata.dataRevision || metadata);
  const computedSegments = appendComputedRange(
    current?.computedSegments,
    metadata.range,
    revision,
    normalizedContext,
  );
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: payload,
    schema: clone(schema) || [],
    outputCoverage: buildOutputCoverage(payload),
    coverage: buildOutputCoverage(payload),
    computedSegments,
    staleSegments: clearStaleRange(current?.staleSegments, metadata.range, normalizedContext),
    revision: revision || current?.revision || null,
  });
}

export function patchCachedIndicatorResult(indicator, context, normalized, metadata = {}) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const incoming = normalizeCachedPayload(normalized);
  const base = current?.normalized || emptyNormalized();
  const nextNormalized = {
    ...base,
    lines: mergeIndicatorLines(base.lines, incoming.lines),
  };
  for (const outputKey of OUTPUT_KEYS) {
    nextNormalized[outputKey] = mergeIndicatorItems(base[outputKey], incoming[outputKey]);
  }
  const normalizedContext = normalizeContext(context);
  const revision = normalizeIndicatorRevision(metadata.revision || metadata.dataRevision || metadata);
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: buildOutputCoverage(nextNormalized),
    coverage: buildOutputCoverage(nextNormalized),
    computedSegments: appendComputedRange(current?.computedSegments, metadata.range, revision, normalizedContext),
    staleSegments: clearStaleRange(current?.staleSegments, metadata.range, normalizedContext),
    revision: revision || current?.revision || null,
  });
}

export function replaceCachedIndicatorRange(indicator, context, normalized, range, metadata = {}) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const incoming = normalizeCachedPayload(normalized);
  const base = current?.normalized || emptyNormalized();
  const nextNormalized = {
    ...base,
    lines: replaceIndicatorLinesRange(base.lines, incoming.lines, range),
  };
  for (const outputKey of OUTPUT_KEYS) {
    nextNormalized[outputKey] = replaceIndicatorItemsRange(base[outputKey], incoming[outputKey], range);
  }
  const normalizedContext = normalizeContext(context);
  const revision = normalizeIndicatorRevision(metadata.revision || metadata.dataRevision || metadata);
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: buildOutputCoverage(nextNormalized),
    coverage: buildOutputCoverage(nextNormalized),
    computedSegments: appendComputedRange(current?.computedSegments, range, revision, normalizedContext),
    staleSegments: clearStaleRange(current?.staleSegments, range, normalizedContext),
    revision: revision || current?.revision || null,
  });
}

export function updateCachedIndicatorLines(indicator, context, lines) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const baseNormalized = current?.normalized || emptyNormalized();
  const nextNormalized = {
    ...baseNormalized,
    lines: normalizeLinesWithSharing(lines, baseNormalized.lines || []),
  };
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizeContext(context),
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: buildOutputCoverage(nextNormalized),
    coverage: buildOutputCoverage(nextNormalized),
    computedSegments: current?.computedSegments || [],
    staleSegments: current?.staleSegments || [],
    revision: current?.revision || null,
  });
}

export function upsertCachedIndicatorLinePoint(indicator, context, values, barTime, histogramColor) {
  if (!indicator?.id || !values || !barTime) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  if (!current) return null;

  const baseNormalized = current.normalized || emptyNormalized();
  const baseLines = Array.isArray(baseNormalized.lines) ? baseNormalized.lines : [];
  const isSingleLine = baseLines.length === 1 && Object.keys(values).length === 1;
  let pointDelta = 0;
  let removedPoint = false;
  let changed = false;
  const nextLines = baseLines.map((line) => {
    const value = resolveWsValue(line, values, isSingleLine);
    if (value === undefined) return line;
    const point = { time: barTime, value };
    if (line.type === "histogram" && histogramColor) {
      point.color = histogramColor;
    }
    const previousData = Array.isArray(line.data) ? line.data : [];
    const nextData = upsertLinePoint(previousData, point);
    if (nextData !== previousData) {
      changed = true;
      pointDelta += nextData.length - previousData.length;
      if (nextData.length < previousData.length) removedPoint = true;
    }
    return { ...line, data: nextData };
  });
  if (!changed) return current;

  const nextNormalized = {
    ...baseNormalized,
    lines: nextLines,
  };
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizeContext(context),
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: removedPoint
      ? buildOutputCoverage(nextNormalized)
      : extendCoverage(current.outputCoverage || current.coverage, barTime, pointDelta),
    coverage: removedPoint
      ? buildOutputCoverage(nextNormalized)
      : extendCoverage(current.outputCoverage || current.coverage, barTime, pointDelta),
    computedSegments: appendComputedRange(
      current.computedSegments,
      { start: barTime, end: barTime },
      current.revision,
      current.context,
    ),
    staleSegments: clearStaleRange(
      current.staleSegments,
      { start: barTime, end: barTime },
      current.context,
    ),
    revision: current.revision || null,
  });
}

export function getCachedIndicatorResult(indicator, context) {
  if (!indicator?.id) return null;
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (!entry) return null;
  if (!dependencyAvailable(entry.dependencyKey || indicatorDependencyKey(entry.context))) {
    entries.delete(entry.key);
    unregisterCacheResource("indicator-result-cache", entry.key);
    return null;
  }
  entry.lastAccessMs = Date.now();
  entries.delete(entry.key);
  entries.set(entry.key, entry);
  return {
    indicatorId: indicator.id,
    normalized: retargetNormalized(entry.normalized, indicator.id),
    schema: clone(entry.schema) || [],
    outputCoverage: clone(entry.outputCoverage || entry.coverage),
    coverage: clone(entry.outputCoverage || entry.coverage),
    computedSegments: clone(entry.computedSegments || []),
    staleSegments: clone(entry.staleSegments || []),
    revision: clone(entry.revision),
    lastUpdatedMs: entry.lastUpdatedMs,
  };
}

export function getCachedIndicatorComputedSegments(indicator, context, revision = null) {
  if (!indicator?.id) return [];
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (!entry || !dependencyAvailable(entry.dependencyKey || indicatorDependencyKey(entry.context))) return [];
  const step = rangeStep(entry.context);
  return mergeIndicatorRangeSegments(entry.computedSegments || [], { step, revision }).map(clone);
}

export function getCachedIndicatorResumeState(indicator, context) {
  if (!indicator?.id) return null;
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (!entry || !dependencyAvailable(entry.dependencyKey || indicatorDependencyKey(entry.context))) return null;
  const revision = normalizeIndicatorRevision(entry.revision);
  const resumeFrom = indicatorRangeRightEdge(entry.computedSegments || [], revision);
  if (!resumeFrom) return null;
  return {
    resumeFrom,
    ...(revision?.serverEpoch ? { serverEpoch: revision.serverEpoch } : {}),
    ...(revision?.correctionRevision ? { correctionRevision: revision.correctionRevision } : {}),
  };
}

export function invalidateCachedIndicatorRange(indicator, context, range, options = {}) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  if (!current) return null;
  const revision = normalizeIndicatorRevision(options.revision || options.dataRevision || options);
  const normalizedRange = normalizeIndicatorRange(range);
  if (!normalizedRange) return current;
  const step = rangeStep(current.context);
  const cascadeRight = options.cascadeRight !== false;
  const invalidatedEnd = cascadeRight
    ? (current.computedSegments || []).reduce(
      (latest, segment) => Math.max(latest, Number(segment.end) || normalizedRange.end),
      normalizedRange.end,
    )
    : normalizedRange.end;
  const staleRange = { start: normalizedRange.start, end: invalidatedEnd };
  return putEntry(key, {
    ...current,
    computedSegments: invalidateIndicatorRangeSegments(current.computedSegments, normalizedRange, {
      cascadeRight,
      revision,
      step,
    }),
    staleSegments: mergeIndicatorRangeSegments([
      ...(current.staleSegments || []),
      staleRange,
    ], { step }),
    revision: revision || current.revision || null,
  });
}

export function rebaseCachedIndicatorRevision(indicator, context, revisionInput) {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const revision = normalizeIndicatorRevision(revisionInput);
  if (!current || !revision) return current || null;
  if (current.revision && !indicatorRevisionsCompatible(current.revision, revision)) return current;
  return putEntry(key, {
    ...current,
    computedSegments: (current.computedSegments || []).map((segment) => ({ ...segment, revision })),
    revision,
  });
}

export function resolveCachedIndicatorResults(indicators = [], context = {}) {
  return indicators
    .map((indicator) => getCachedIndicatorResult(indicator, context))
    .filter(Boolean);
}

export function resetIndicatorResultCache() {
  for (const key of entries.keys()) {
    unregisterCacheResource("indicator-result-cache", key);
  }
  entries.clear();
}

export function snapshotIndicatorResultCacheEntries() {
  return Array.from(entries.values()).map(clone);
}

export function snapshotIndicatorResultCacheDiagnostics() {
  const snapshot = Array.from(entries.values()).map((entry) => {
    const normalized = entry.normalized || emptyNormalized();
    const points = countLinePoints(normalized);
    const items = countOutputItems(normalized);
    const deps = dependencyState("indicator-result-cache", entry.key);
    return {
      owner: "indicator-result-cache",
      key: entry.key,
      indicatorId: entry.indicatorId,
      dependencyKey: entry.dependencyKey || indicatorDependencyKey(entry.context),
      dependencyState: deps,
      tier: deps.orphan ? "cold" : "warm",
      context: clone(entry.context),
      points,
      items,
      lineCount: normalized.lines?.length || 0,
      outputCounts: OUTPUT_KEYS.reduce((counts, key) => ({
        ...counts,
        [key]: Array.isArray(normalized[key]) ? normalized[key].length : 0,
      }), {}),
      estimatedBytes: points * INDICATOR_POINT_ESTIMATED_BYTES + items * OUTPUT_ITEM_ESTIMATED_BYTES,
      coverage: clone(entry.outputCoverage || entry.coverage),
      outputCoverage: clone(entry.outputCoverage || entry.coverage),
      computedSegments: clone(entry.computedSegments || []),
      staleSegments: clone(entry.staleSegments || []),
      revision: clone(entry.revision),
      rangeSegments: clone(entry.computedSegments?.length
        ? entry.computedSegments
        : buildRangeSegments(entry.outputCoverage || entry.coverage)),
      trimSafety: analyzeTrimSafety(normalized),
      lastAccessMs: entry.lastAccessMs || null,
      lastUpdatedMs: entry.lastUpdatedMs || null,
    };
  });
  const totalPoints = snapshot.reduce((total, entry) => total + entry.points, 0);
  const totalItems = snapshot.reduce((total, entry) => total + entry.items, 0);
  return {
    owner: "indicator-result-cache",
    entryCount: snapshot.length,
    maxEntries: MAX_INDICATOR_CACHE_ENTRIES,
    totalPoints,
    totalItems,
    estimatedBytes: (
      totalPoints * INDICATOR_POINT_ESTIMATED_BYTES
      + totalItems * OUTPUT_ITEM_ESTIMATED_BYTES
    ),
    entries: snapshot,
  };
}

export function trimIndicatorResultCacheEntries(victims = []) {
  const byKey = new Map(victims.filter((victim) => victim?.key).map((victim) => [victim.key, victim]));
  const removed = [];
  for (const [key, victim] of byKey.entries()) {
    const entry = entries.get(key);
    if (!entry) continue;
    const normalized = entry.normalized || emptyNormalized();
    const points = countLinePoints(normalized);
    const items = countOutputItems(normalized);
    if (entry && victim?.action === "trim-range" && victim.keepStart != null) {
      const trimSafety = analyzeTrimSafety(normalized);
      if (trimSafety.safeRangeTrim) {
        const nextNormalized = trimNormalizedBefore(normalized, victim.keepStart);
        const nextPoints = countLinePoints(nextNormalized);
        const removedPoints = Math.max(0, points - nextPoints);
        const nextEntry = {
          ...entry,
          normalized: nextNormalized,
          outputCoverage: buildOutputCoverage(nextNormalized),
          coverage: buildOutputCoverage(nextNormalized),
          computedSegments: (entry.computedSegments || []).flatMap((segment) => (
            subtractIndicatorRange(segment, [{ start: 1, end: Number(victim.keepStart) - 1 }], {
              step: rangeStep(entry.context),
            })
          )),
          lastUpdatedMs: Date.now(),
        };
        entries.set(key, nextEntry);
        removed.push({
          owner: "indicator-result-cache",
          key,
          action: "trim-range",
          points: removedPoints,
          items: 0,
          estimatedBytes: removedPoints * INDICATOR_POINT_ESTIMATED_BYTES,
        });
        continue;
      }
    }
    entries.delete(key);
    unregisterCacheResource("indicator-result-cache", key);
    removed.push({
      owner: "indicator-result-cache",
      key,
      points,
      items,
      estimatedBytes: points * INDICATOR_POINT_ESTIMATED_BYTES + items * OUTPUT_ITEM_ESTIMATED_BYTES,
    });
  }
  return {
    owner: "indicator-result-cache",
    removedCount: removed.length,
    removedIndicatorPoints: removed.reduce((total, entry) => total + entry.points, 0),
    removedIndicatorItems: removed.reduce((total, entry) => total + entry.items, 0),
    removedEstimatedBytes: removed.reduce((total, entry) => total + entry.estimatedBytes, 0),
    removed,
  };
}
