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
  acquireCacheLease,
  cacheLeaseCount,
  dependencyAvailable,
  dependencyState,
  hasCacheLease,
  klineDependencyKey,
  registerCacheDependency,
  registerCacheResource,
  unregisterCacheResource,
} from "../cache-gc/cacheRegistry.js";
import { canonicalizeIntervalValue, parseIntervalSeconds } from "../../utils/intervals.js";
import {
  indicatorRangeRightEdge,
  indicatorRevisionsCompatible,
  invalidateIndicatorRangeSegments,
  mergeIndicatorRangeSegments,
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
  subtractIndicatorRange,
} from "./indicatorRangeCoverage.js";
import { isIndicatorRecord } from "./indicatorContracts.js";
import type {
  IndicatorAuxiliaryItem,
  IndicatorCacheContext,
  IndicatorCacheEntry,
  IndicatorCacheMetadata,
  IndicatorCacheResult,
  IndicatorCacheResultMetadata,
  IndicatorColorPoint,
  IndicatorCoverage,
  IndicatorDefinition,
  IndicatorLine,
  IndicatorParameterSchema,
  IndicatorParams,
  IndicatorRange,
  IndicatorRangeSegment,
  IndicatorRevision,
  IndicatorValuePoint,
  NormalizedIndicatorPayload,
} from "./indicatorTypes.js";

const MAX_INDICATOR_CACHE_ENTRIES = 80;
const OUTPUT_KEYS = [
  "markers",
  "fills",
  "hlines",
  "bgcolors",
  "barcolors",
  "signals",
] as const;
const INDICATOR_POINT_ESTIMATED_BYTES = 80;
const OUTPUT_ITEM_ESTIMATED_BYTES = 120;

type IndicatorContextInput = Partial<IndicatorCacheContext>;
type IndicatorCacheEntryPatch = Omit<
  IndicatorCacheEntry,
  "key" | "contentVersion" | "dependencyKey" | "lastUpdatedMs" | "lastAccessMs"
>;

interface InternalIndicatorCacheEntry extends IndicatorCacheEntry {
  metadataView: IndicatorCacheResultMetadata;
  resultView: IndicatorCacheResult;
}

interface IndicatorCacheTrimVictim {
  key?: string;
  action?: string;
  keepStart?: number | null;
  generation?: unknown;
  expectedRevision?: unknown;
  lastAccessMs?: unknown;
  reason?: unknown;
  relief?: {
    indicatorPoints?: unknown;
    indicatorItems?: unknown;
    estimatedBytes?: unknown;
  };
}

interface PointRecord {
  time?: number;
}

const entries = new Map<string, InternalIndicatorCacheEntry>();
const entryGenerations = new Map<string, number>();
let nextEntryGeneration = 0;
let nextContentVersion = 0;

function markEntryMutation(key: string): number {
  nextEntryGeneration += 1;
  entryGenerations.set(key, nextEntryGeneration);
  return nextEntryGeneration;
}

function forgetEntryGeneration(key: string): void {
  entryGenerations.delete(key);
}

function cloneAndFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const source = value as unknown[];
    return Object.freeze(source.map((item: unknown) => cloneAndFreeze(item))) as T;
  }
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = cloneAndFreeze(item);
  }
  return Object.freeze(next) as T;
}

function freezeOwned<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) freezeOwned(item);
    return Object.freeze(value) as T;
  }
  for (const item of Object.values(value)) freezeOwned(item);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return cloneAndFreeze(value);
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = isIndicatorRecord(value) ? value : {};
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeSeriesPart(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function normalizeContext(
  context: IndicatorContextInput = {},
): IndicatorCacheContext {
  return {
    exchange: normalizeSeriesPart(context.exchange, "binance").toLowerCase(),
    marketType: normalizeSeriesPart(context.marketType, "spot").toLowerCase(),
    symbol: normalizeSeriesPart(context.symbol, "UNKNOWN").toUpperCase(),
    interval: canonicalizeIntervalValue(context.interval) || "1m",
    candleUpColor: normalizeSeriesPart(context.candleUpColor),
    candleDownColor: normalizeSeriesPart(context.candleDownColor),
  };
}

function indicatorDependencyKey(context: IndicatorContextInput = {}): string {
  const normalized = normalizeContext(context);
  return klineDependencyKey({
    exchange: normalized.exchange,
    marketType: normalized.marketType,
    symbol: normalized.symbol,
    interval: normalized.interval,
  });
}

function indicatorIdentity(
  indicator: IndicatorDefinition,
  context: IndicatorContextInput = {},
): string {
  const builtin = isBuiltinIndicator(indicator);
  const computeParams = resolveCacheComputeParams(indicator, context);
  return [
    indicator.id || "",
    indicator.executionTarget || "hosted",
    builtin ? "builtin" : "script",
    getBuiltinIndicatorName(indicator) ||
      indicator.engineName ||
      indicator.name ||
      "",
    stringSignature(indicator.script || ""),
    indicator.language || "",
    indicator.securityMode || "",
    stableJson(computeParams || {}),
  ].join("|");
}

function resolveCacheComputeParams(
  indicator: IndicatorDefinition,
  context: IndicatorContextInput = {},
): IndicatorParams {
  const params = indicator.params || {};
  if (
    (indicator.id !== "vol" && indicator.engineName !== "VOL") ||
    (!context.candleUpColor && !context.candleDownColor)
  ) {
    return params;
  }
  return {
    ...params,
    up_color: context.candleUpColor || params.up_color || "#22c55e",
    down_color: context.candleDownColor || params.down_color || "#ef4444",
  };
}

function emptyNormalized(): NormalizedIndicatorPayload {
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

function retargetItems<T extends IndicatorAuxiliaryItem>(
  items: T[] = [],
  indicatorId: string,
): T[] {
  return freezeOwned((items || []).map((item) => {
    const owned = cloneAndFreeze(item);
    return freezeOwned({ ...owned, indicatorId }) as T;
  }));
}

function normalizeCachedPayload(
  normalized: Partial<NormalizedIndicatorPayload> = {},
  indicatorId: string,
): NormalizedIndicatorPayload {
  return freezeOwned({
    lines: cloneAndFreeze(normalized.lines || []),
    markers: retargetItems(normalized.markers || [], indicatorId),
    fills: retargetItems(normalized.fills || [], indicatorId),
    hlines: retargetItems(normalized.hlines || [], indicatorId),
    bgcolors: retargetItems(normalized.bgcolors || [], indicatorId),
    barcolors: retargetItems(normalized.barcolors || [], indicatorId),
    signals: retargetItems(normalized.signals || [], indicatorId),
  });
}

function buildOutputCoverage(
  normalized: Partial<NormalizedIndicatorPayload> = {},
): IndicatorCoverage | null {
  let firstTime: number | null = null;
  let lastTime: number | null = null;
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
  if (!points || firstTime === null || lastTime === null) return null;
  return {
    firstTime,
    lastTime,
    points,
  };
}

function extendCoverage(
  coverage: IndicatorCoverage | null | undefined,
  time: unknown,
  deltaPoints: number,
): IndicatorCoverage | null {
  const normalizedTime = Number(time);
  if (!Number.isFinite(normalizedTime)) return coverage || null;
  const currentPoints = Number(coverage?.points || 0);
  const nextPoints = Math.max(0, currentPoints + Number(deltaPoints || 0));
  if (nextPoints <= 0) return null;
  return {
    firstTime:
      coverage?.firstTime == null
        ? normalizedTime
        : Math.min(coverage.firstTime, normalizedTime),
    lastTime:
      coverage?.lastTime == null
        ? normalizedTime
        : Math.max(coverage.lastTime, normalizedTime),
    points: nextPoints,
  };
}

function countLinePoints(
  normalized: Partial<NormalizedIndicatorPayload> = {},
): number {
  return (normalized.lines || []).reduce(
    (total, line) => total + (Array.isArray(line.data) ? line.data.length : 0),
    0,
  );
}

function countOutputItems(
  normalized: Partial<NormalizedIndicatorPayload> = {},
): number {
  const lineColorPoints = (normalized.lines || []).reduce(
    (total, line) => total + (Array.isArray(line.colorData) ? line.colorData.length : 0),
    0,
  );
  return lineColorPoints + OUTPUT_KEYS.reduce((total, key) => {
    const items = Array.isArray(normalized[key]) ? normalized[key] : [];
    return total + items.reduce((itemTotal, item) => {
      const record = isIndicatorRecord(item) ? item : {};
      const dataPoints = Array.isArray(record.data) ? record.data.length : 0;
      const regionPoints = Array.isArray(record.regions) ? record.regions.length : 0;
      return itemTotal + 1 + dataPoints + regionPoints;
    }, 0);
  }, 0);
}

function indicatorAccounting(
  normalized: Partial<NormalizedIndicatorPayload> = {},
) {
  const points = countLinePoints(normalized);
  const items = countOutputItems(normalized);
  return {
    points,
    items,
    estimatedBytes:
      points * INDICATOR_POINT_ESTIMATED_BYTES
      + items * OUTPUT_ITEM_ESTIMATED_BYTES,
  };
}

function hasTimedData(items: IndicatorAuxiliaryItem[] = []): boolean {
  return items.some(
    (item) =>
      Array.isArray(item?.data) &&
      item.data.some((point) => Number.isFinite(Number(point?.time))),
  );
}

function analyzeTrimSafety(
  normalized: Partial<NormalizedIndicatorPayload> = {},
) {
  const unsafeOutputs = OUTPUT_KEYS.filter((key) => {
    const items = normalized[key] || [];
    if (!Array.isArray(items) || items.length === 0) return false;
    return key !== "barcolors" || hasTimedData(items);
  });
  const safeLines = (normalized.lines || []).every(
    (line) =>
      Array.isArray(line.data) &&
      (!line.colorData || Array.isArray(line.colorData)),
  );
  return {
    safeRangeTrim: safeLines && unsafeOutputs.length === 0,
    reason:
      safeLines && unsafeOutputs.length === 0
        ? "line-only-time-series"
        : "complex-output",
    unsafeOutputs,
  };
}

function buildExactTrimPlan(
  normalized: NormalizedIndicatorPayload,
  coverage: IndicatorCoverage | null | undefined,
) {
  const trimSafety = analyzeTrimSafety(normalized);
  if (
    !trimSafety.safeRangeTrim
    || coverage?.firstTime == null
    || coverage?.lastTime == null
    || coverage.firstTime >= coverage.lastTime
  ) return null;
  const keepStart = Math.floor((coverage.firstTime + coverage.lastTime) / 2);
  const before = indicatorAccounting(normalized);
  const after = indicatorAccounting(trimNormalizedBefore(normalized, keepStart));
  const removedPoints = Math.max(0, before.points - after.points);
  const removedItems = Math.max(0, before.items - after.items);
  const removedEstimatedBytes = Math.max(0, before.estimatedBytes - after.estimatedBytes);
  if (removedEstimatedBytes <= 0 || removedPoints + removedItems <= 0) return null;
  return {
    keepStart,
    removedPoints,
    removedItems,
    removedEstimatedBytes,
  };
}

function buildRangeSegments(
  coverage: IndicatorCoverage | null | undefined,
): IndicatorRangeSegment[] {
  if (!coverage?.points) return [];
  return [
    {
      start: coverage.firstTime,
      end: coverage.lastTime,
      points: coverage.points,
    },
  ];
}

function rangeStep(context: IndicatorContextInput = {}): number {
  return parseIntervalSeconds(context.interval) || 1;
}

function rangeOptions(context: IndicatorContextInput = {}) {
  return { interval: context.interval, step: rangeStep(context) };
}

function appendComputedRange(
  segments: IndicatorRangeSegment[] | undefined,
  rangeInput: unknown,
  revision: unknown,
  context: IndicatorContextInput,
): IndicatorRangeSegment[] {
  const range = normalizeIndicatorRange(rangeInput);
  if (!range)
    return mergeIndicatorRangeSegments(segments, rangeOptions(context));
  const normalizedRevision = normalizeIndicatorRevision(revision);
  return mergeIndicatorRangeSegments(
    [
      ...(segments || []),
      {
        ...range,
        ...(normalizedRevision ? { revision: normalizedRevision } : {}),
      },
    ],
    rangeOptions(context),
  );
}

function clearStaleRange(
  segments: IndicatorRangeSegment[] | undefined,
  rangeInput: unknown,
  context: IndicatorContextInput,
): IndicatorRangeSegment[] {
  const range = normalizeIndicatorRange(rangeInput);
  if (!range) return segments || [];
  return (segments || []).flatMap((segment) =>
    subtractIndicatorRange(segment, [range], rangeOptions(context)),
  );
}

function trimNormalizedBefore(
  normalized: NormalizedIndicatorPayload,
  keepStart: unknown,
): NormalizedIndicatorPayload {
  const cutoff = Number(keepStart);
  if (!Number.isFinite(cutoff)) return normalized;
  return {
    ...normalized,
    lines: (normalized.lines || []).map((line) => ({
      ...line,
      data: (line.data || []).filter((point) => Number(point?.time) >= cutoff),
      ...(line.colorData
        ? {
            colorData: (line.colorData || []).filter(
              (point) => Number(point?.time) >= cutoff,
            ),
          }
        : {}),
    })),
  };
}

function samePlainObject(
  left: object | null | undefined,
  right: object | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (Reflect.get(left, key) !== Reflect.get(right, key)) return false;
  }
  return true;
}

function lineIdentity(line: Partial<IndicatorLine> = {}): string {
  return line.id || line.outputName || line.name || "";
}

function clonePointWithSharing<T extends PointRecord>(
  point: T,
  previousPoint: T | undefined,
): T {
  return previousPoint !== undefined && samePlainObject(point, previousPoint)
    ? previousPoint
    : { ...point };
}

function clonePointArrayWithSharing<T extends PointRecord>(
  points: T[] = [],
  previousPoints: T[] = [],
): T[] {
  let changed = points.length !== previousPoints.length;
  const next = points.map((point, index) => {
    const shared = clonePointWithSharing(point, previousPoints[index]);
    if (shared !== previousPoints[index]) changed = true;
    return shared;
  });
  return changed ? next : previousPoints;
}

function normalizeLinesWithSharing(
  lines: IndicatorLine[] = [],
  previousLines: IndicatorLine[] = [],
): IndicatorLine[] {
  const previousByIdentity = new Map(
    previousLines.map((line) => [lineIdentity(line), line]),
  );
  return (lines || []).map((line, index) => {
    const previous =
      previousByIdentity.get(lineIdentity(line)) ||
      previousLines[index] ||
      null;
    const data = clonePointArrayWithSharing(
      line.data || [],
      previous?.data || [],
    );
    const colorData = line.colorData
      ? clonePointArrayWithSharing(line.colorData, previous?.colorData || [])
      : undefined;
    const base = {
      ...line,
      data,
      ...(colorData ? { colorData } : {}),
    };
    if (
      previous &&
      data === previous.data &&
      (!line.colorData || colorData === previous.colorData) &&
      samePlainObject(
        { ...base, data: undefined, colorData: undefined },
        { ...previous, data: undefined, colorData: undefined },
      )
    ) {
      return previous;
    }
    return base;
  });
}

function enforceLimit(): void {
  while (entries.size > MAX_INDICATOR_CACHE_ENTRIES) {
    const oldestKey = Array.from(entries.keys()).find(
      (key) => !hasCacheLease("indicator-result-cache", key),
    );
    if (oldestKey == null) return;
    entries.delete(oldestKey);
    forgetEntryGeneration(oldestKey);
    unregisterCacheResource("indicator-result-cache", oldestKey);
  }
}

function snapshotCacheEntry(
  entry: InternalIndicatorCacheEntry,
): IndicatorCacheEntry {
  return Object.freeze({
    key: entry.key,
    contentVersion: entry.contentVersion,
    dependencyKey: entry.dependencyKey,
    indicatorId: entry.indicatorId,
    context: entry.context,
    normalized: entry.normalized,
    schema: entry.schema,
    outputCoverage: entry.outputCoverage,
    coverage: entry.coverage,
    computedSegments: entry.computedSegments,
    staleSegments: entry.staleSegments,
    revision: entry.revision,
    lastUpdatedMs: entry.lastUpdatedMs,
    lastAccessMs: entry.lastAccessMs,
  });
}

function putEntry(
  key: string,
  patch: IndicatorCacheEntryPatch,
): IndicatorCacheEntry | null {
  const dependencyKey = indicatorDependencyKey(patch.context);
  if (!dependencyAvailable(dependencyKey)) {
    return null;
  }
  nextContentVersion += 1;
  const context = freezeOwned(patch.context);
  const normalized = freezeOwned(patch.normalized);
  const schema = freezeOwned(patch.schema);
  const outputCoverage = freezeOwned(patch.outputCoverage || patch.coverage);
  const computedSegments = freezeOwned(patch.computedSegments);
  const staleSegments = freezeOwned(patch.staleSegments);
  const revision = freezeOwned(patch.revision);
  const lastUpdatedMs = Date.now();
  const base: IndicatorCacheEntry = {
    key,
    contentVersion: nextContentVersion,
    dependencyKey,
    indicatorId: patch.indicatorId,
    context,
    normalized,
    schema,
    outputCoverage,
    coverage: outputCoverage,
    computedSegments,
    staleSegments,
    revision,
    lastUpdatedMs,
    lastAccessMs: Date.now(),
  };
  const resultView = freezeOwned<IndicatorCacheResult>({
    indicatorId: base.indicatorId,
    contentVersion: base.contentVersion,
    normalized,
    schema,
    outputCoverage,
    coverage: outputCoverage,
    computedSegments,
    staleSegments,
    revision,
    lastUpdatedMs,
  });
  const metadataView = freezeOwned<IndicatorCacheResultMetadata>({
    key,
    indicatorId: base.indicatorId,
    contentVersion: base.contentVersion,
    outputCoverage,
    coverage: outputCoverage,
    computedSegments,
    staleSegments,
    revision,
    lastUpdatedMs,
  });
  const next: InternalIndicatorCacheEntry = {
    ...base,
    metadataView,
    resultView,
  };
  entries.delete(key);
  entries.set(key, next);
  markEntryMutation(key);
  registerCacheResource("indicator-result-cache", key, {
    type: "indicator",
    dependencyKey,
    indicatorId: next.indicatorId,
    context: clone(next.context),
  });
  registerCacheDependency("indicator-result-cache", key, dependencyKey);
  enforceLimit();
  return snapshotCacheEntry(next);
}

export function buildIndicatorCacheContext(
  context: IndicatorContextInput = {},
): IndicatorCacheContext {
  return normalizeContext(context);
}

export function buildIndicatorResultCacheKey(
  indicator: IndicatorDefinition,
  context: IndicatorContextInput = {},
): string {
  const normalizedContext = normalizeContext(context);
  return [
    normalizedContext.exchange,
    normalizedContext.marketType,
    normalizedContext.symbol,
    normalizedContext.interval,
    indicatorIdentity(indicator, normalizedContext),
  ].join("::");
}

export function buildIndicatorCacheHydrationSignature(
  indicators: IndicatorDefinition[] = [],
  context: IndicatorContextInput = {},
): string {
  return (indicators || [])
    .map((indicator) => buildIndicatorResultCacheKey(indicator, context))
    .join("\n");
}

export function acquireActiveIndicatorCacheLeases(
  indicators: IndicatorDefinition[] = [],
  context: IndicatorContextInput = {},
  runtimeLeaseId = "indicator-runtime",
): () => void {
  const normalizedContext = normalizeContext(context);
  const releases: Array<() => void> = [];
  const acquiredKeys = new Set<string>();
  for (const indicator of indicators) {
    if (!indicator?.id) continue;
    const key = buildIndicatorResultCacheKey(indicator, normalizedContext);
    if (acquiredKeys.has(key)) continue;
    acquiredKeys.add(key);
    const release = acquireCacheLease(
      "indicator-result-cache",
      key,
      runtimeLeaseId,
      {
        lifecycle: "active-indicator-runtime",
        indicatorId: indicator.id,
        context: clone(normalizedContext),
      },
    );
    if (release) releases.push(release);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
  };
}

export function cacheIndicatorSnapshot(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  normalized: NormalizedIndicatorPayload,
  schema: IndicatorParameterSchema[] = [],
  metadata: IndicatorCacheMetadata = {},
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const normalizedContext = normalizeContext(context);
  const payload = normalizeCachedPayload(normalized, indicator.id);
  const revision = normalizeIndicatorRevision(
    metadata.revision || metadata.dataRevision || metadata,
  );
  const computedSegments = appendComputedRange(
    current?.computedSegments,
    metadata.range,
    revision,
    normalizedContext,
  );
  const coverage = freezeOwned(buildOutputCoverage(payload));
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: payload,
    schema: cloneAndFreeze(schema) || [],
    outputCoverage: coverage,
    coverage,
    computedSegments,
    staleSegments: clearStaleRange(
      current?.staleSegments,
      metadata.range,
      normalizedContext,
    ),
    revision: revision || current?.revision || null,
  });
}

export function patchCachedIndicatorResult(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  normalized: NormalizedIndicatorPayload,
  metadata: IndicatorCacheMetadata = {},
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const incoming = normalizeCachedPayload(normalized, indicator.id);
  const base = current?.normalized || emptyNormalized();
  const nextNormalized: NormalizedIndicatorPayload = freezeOwned({
    ...base,
    lines: mergeIndicatorLines(base.lines, incoming.lines),
    markers: mergeIndicatorItems(base.markers, incoming.markers),
    fills: mergeIndicatorItems(base.fills, incoming.fills),
    hlines: mergeIndicatorItems(base.hlines, incoming.hlines),
    bgcolors: mergeIndicatorItems(base.bgcolors, incoming.bgcolors),
    barcolors: mergeIndicatorItems(base.barcolors, incoming.barcolors),
    signals: mergeIndicatorItems(base.signals, incoming.signals),
  });
  const normalizedContext = normalizeContext(context);
  const revision = normalizeIndicatorRevision(
    metadata.revision || metadata.dataRevision || metadata,
  );
  const coverage = freezeOwned(buildOutputCoverage(nextNormalized));
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: coverage,
    coverage,
    computedSegments: appendComputedRange(
      current?.computedSegments,
      metadata.range,
      revision,
      normalizedContext,
    ),
    staleSegments: clearStaleRange(
      current?.staleSegments,
      metadata.range,
      normalizedContext,
    ),
    revision: revision || current?.revision || null,
  });
}

export function replaceCachedIndicatorRange(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  normalized: NormalizedIndicatorPayload,
  range: IndicatorRange,
  metadata: IndicatorCacheMetadata = {},
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const incoming = normalizeCachedPayload(normalized, indicator.id);
  const base = current?.normalized || emptyNormalized();
  const nextNormalized: NormalizedIndicatorPayload = freezeOwned({
    ...base,
    lines: replaceIndicatorLinesRange(base.lines, incoming.lines, range),
    markers: replaceIndicatorItemsRange(base.markers, incoming.markers, range),
    fills: replaceIndicatorItemsRange(base.fills, incoming.fills, range),
    hlines: replaceIndicatorItemsRange(base.hlines, incoming.hlines, range),
    bgcolors: replaceIndicatorItemsRange(base.bgcolors, incoming.bgcolors, range),
    barcolors: replaceIndicatorItemsRange(base.barcolors, incoming.barcolors, range),
    signals: replaceIndicatorItemsRange(base.signals, incoming.signals, range),
  });
  const normalizedContext = normalizeContext(context);
  const revision = normalizeIndicatorRevision(
    metadata.revision || metadata.dataRevision || metadata,
  );
  const coverage = freezeOwned(buildOutputCoverage(nextNormalized));
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizedContext,
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: coverage,
    coverage,
    computedSegments: appendComputedRange(
      current?.computedSegments,
      range,
      revision,
      normalizedContext,
    ),
    staleSegments: clearStaleRange(
      current?.staleSegments,
      range,
      normalizedContext,
    ),
    revision: revision || current?.revision || null,
  });
}

export function updateCachedIndicatorLines(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  lines: IndicatorLine[],
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const baseNormalized = current?.normalized || emptyNormalized();
  const nextNormalized = freezeOwned({
    ...baseNormalized,
    lines: normalizeLinesWithSharing(lines, baseNormalized.lines || []),
  });
  const coverage = freezeOwned(buildOutputCoverage(nextNormalized));
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizeContext(context),
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: coverage,
    coverage,
    computedSegments: current?.computedSegments || [],
    staleSegments: current?.staleSegments || [],
    revision: current?.revision || null,
  });
}

export function upsertCachedIndicatorLinePoint(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  values: Record<string, unknown>,
  barTime: number,
  histogramColor?: string | ((line: IndicatorLine, value: unknown) => string | undefined),
): IndicatorCacheEntry | null {
  if (!indicator?.id || !values || !barTime) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  if (!current) return null;

  const baseNormalized = current.normalized || emptyNormalized();
  const baseLines = Array.isArray(baseNormalized.lines)
    ? baseNormalized.lines
    : [];
  const isSingleLine =
    baseLines.length === 1 && Object.keys(values).length === 1;
  let pointDelta = 0;
  let removedPoint = false;
  let changed = false;
  const nextLines = baseLines.map((line) => {
    const value = resolveWsValue(line, values, isSingleLine);
    if (value === undefined) return line;
    const point: { time: number; value: unknown; color?: string } = {
      time: barTime,
      value,
    };
    const resolvedHistogramColor = typeof histogramColor === "function"
      ? histogramColor(line, value)
      : histogramColor;
    if (line.type === "histogram" && resolvedHistogramColor) {
      point.color = resolvedHistogramColor;
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
  if (!changed) return snapshotCacheEntry(current);

  const nextNormalized = freezeOwned({
    ...baseNormalized,
    lines: nextLines,
  });
  const coverage = freezeOwned(removedPoint
    ? buildOutputCoverage(nextNormalized)
    : extendCoverage(
        current.outputCoverage || current.coverage,
        barTime,
        pointDelta,
      ));
  return putEntry(key, {
    indicatorId: indicator.id,
    context: normalizeContext(context),
    normalized: nextNormalized,
    schema: current?.schema || [],
    outputCoverage: coverage,
    coverage,
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

function resolveCachedEntry(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): InternalIndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (!entry) return null;
  if (
    !dependencyAvailable(
      entry.dependencyKey || indicatorDependencyKey(entry.context),
    )
  ) {
    entries.delete(entry.key);
    forgetEntryGeneration(entry.key);
    unregisterCacheResource("indicator-result-cache", entry.key);
    return null;
  }
  entry.lastAccessMs = Date.now();
  entries.delete(entry.key);
  entries.set(entry.key, entry);
  markEntryMutation(entry.key);
  return entry;
}

export function getCachedIndicatorResult(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): IndicatorCacheResult | null {
  return resolveCachedEntry(indicator, context)?.resultView || null;
}

export function getCachedIndicatorMetadata(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): IndicatorCacheResultMetadata | null {
  return resolveCachedEntry(indicator, context)?.metadataView || null;
}

export function getCachedIndicatorRevision(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): IndicatorRevision | null {
  return resolveCachedEntry(indicator, context)?.revision || null;
}

export function removeCachedIndicatorResult(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): boolean {
  if (!indicator?.id) return false;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const removed = entries.delete(key);
  if (!removed) return false;
  forgetEntryGeneration(key);
  unregisterCacheResource("indicator-result-cache", key);
  return true;
}

export function getCachedIndicatorComputedSegments(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  revision: IndicatorRevision | null = null,
): IndicatorRangeSegment[] {
  if (!indicator?.id) return [];
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (
    !entry ||
    !dependencyAvailable(
      entry.dependencyKey || indicatorDependencyKey(entry.context),
    )
  )
    return [];
  return mergeIndicatorRangeSegments(entry.computedSegments || [], {
    ...rangeOptions(entry.context),
    revision,
  }).map(clone);
}

export function getCachedIndicatorResumeState(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
): {
  resumeFrom: number;
  serverEpoch?: string;
  correctionRevision?: string;
} | null {
  if (!indicator?.id) return null;
  const entry = entries.get(buildIndicatorResultCacheKey(indicator, context));
  if (
    !entry ||
    !dependencyAvailable(
      entry.dependencyKey || indicatorDependencyKey(entry.context),
    )
  )
    return null;
  const revision = normalizeIndicatorRevision(entry.revision);
  const resumeFrom = indicatorRangeRightEdge(
    entry.computedSegments || [],
    revision,
  );
  if (!resumeFrom) return null;
  return {
    resumeFrom,
    ...(revision?.serverEpoch ? { serverEpoch: revision.serverEpoch } : {}),
    ...(revision?.correctionRevision
      ? { correctionRevision: revision.correctionRevision }
      : {}),
  };
}

export function invalidateCachedIndicatorRange(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  range: IndicatorRange,
  options: IndicatorCacheMetadata = {},
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  if (!current) return null;
  const revision = normalizeIndicatorRevision(
    options.revision || options.dataRevision || options,
  );
  const normalizedRange = normalizeIndicatorRange(range);
  if (!normalizedRange) return snapshotCacheEntry(current);
  const coverageOptions = rangeOptions(current.context);
  const cascadeRight = options.cascadeRight !== false;
  const invalidatedEnd = cascadeRight
    ? (current.computedSegments || []).reduce(
        (latest, segment) =>
          Math.max(latest, Number(segment.end) || normalizedRange.end),
        normalizedRange.end,
      )
    : normalizedRange.end;
  const staleRange = { start: normalizedRange.start, end: invalidatedEnd };
  return putEntry(key, {
    ...current,
    computedSegments: invalidateIndicatorRangeSegments(
      current.computedSegments,
      normalizedRange,
      {
        cascadeRight,
        revision,
        ...coverageOptions,
      },
    ),
    staleSegments: mergeIndicatorRangeSegments(
      [...(current.staleSegments || []), staleRange],
      coverageOptions,
    ),
    revision: revision || current.revision || null,
  });
}

export function rebaseCachedIndicatorRevision(
  indicator: IndicatorDefinition | null | undefined,
  context: IndicatorContextInput,
  revisionInput: unknown,
): IndicatorCacheEntry | null {
  if (!indicator?.id) return null;
  const key = buildIndicatorResultCacheKey(indicator, context);
  const current = entries.get(key);
  const revision = normalizeIndicatorRevision(revisionInput);
  if (!current || !revision) return current ? snapshotCacheEntry(current) : null;
  if (
    current.revision &&
    !indicatorRevisionsCompatible(current.revision, revision)
  )
    return snapshotCacheEntry(current);
  return putEntry(key, {
    ...current,
    computedSegments: (current.computedSegments || []).map((segment) => ({
      ...segment,
      revision,
    })),
    revision,
  });
}

export function resolveCachedIndicatorResults(
  indicators: IndicatorDefinition[] = [],
  context: IndicatorContextInput = {},
): IndicatorCacheResult[] {
  return indicators
    .map((indicator) => getCachedIndicatorResult(indicator, context))
    .filter((entry): entry is IndicatorCacheResult => entry !== null);
}

export function resetIndicatorResultCache(): void {
  for (const key of entries.keys()) {
    unregisterCacheResource("indicator-result-cache", key);
  }
  entries.clear();
  entryGenerations.clear();
}

export function snapshotIndicatorResultCacheEntries(): IndicatorCacheEntry[] {
  return Array.from(entries.values(), snapshotCacheEntry);
}

export function snapshotIndicatorResultCacheDiagnostics() {
  const snapshot = Array.from(entries.values()).map((entry) => {
    const normalized = entry.normalized || emptyNormalized();
    const accounting = indicatorAccounting(normalized);
    const points = accounting.points;
    const items = accounting.items;
    const deps = dependencyState("indicator-result-cache", entry.key);
    const coverage = entry.outputCoverage || entry.coverage;
    const trimSafety = analyzeTrimSafety(normalized);
    const trimPlan = buildExactTrimPlan(normalized, coverage);
    const activeLeaseCount = cacheLeaseCount("indicator-result-cache", entry.key);
    return {
      owner: "indicator-result-cache",
      key: entry.key,
      indicatorId: entry.indicatorId,
      dependencyKey:
        entry.dependencyKey || indicatorDependencyKey(entry.context),
      dependencyState: deps,
      tier: activeLeaseCount > 0 ? "active" : deps.orphan ? "cold" : "warm",
      activeLeaseCount,
      contentVersion: entry.contentVersion,
      generation: entryGenerations.get(entry.key) || 0,
      context: clone(entry.context),
      points,
      items,
      lineCount: normalized.lines?.length || 0,
      outputCounts: OUTPUT_KEYS.reduce(
        (counts, key) => ({
          ...counts,
          [key]: Array.isArray(normalized[key]) ? normalized[key].length : 0,
        }),
        {},
      ),
      estimatedBytes:
        accounting.estimatedBytes,
      accounting: clone(accounting),
      coverage: clone(coverage),
      outputCoverage: clone(coverage),
      computedSegments: clone(entry.computedSegments || []),
      staleSegments: clone(entry.staleSegments || []),
      revision: clone(entry.revision),
      rangeSegments: clone(
        entry.computedSegments?.length
          ? entry.computedSegments
          : buildRangeSegments(entry.outputCoverage || entry.coverage),
      ),
      trimSafety,
      ...(trimPlan ? { trimPlan: clone(trimPlan) } : {}),
      lastAccessMs: entry.lastAccessMs || null,
      lastUpdatedMs: entry.lastUpdatedMs || null,
    };
  });
  const totalPoints = snapshot.reduce(
    (total, entry) => total + entry.points,
    0,
  );
  const totalItems = snapshot.reduce((total, entry) => total + entry.items, 0);
  return {
    owner: "indicator-result-cache",
    entryCount: snapshot.length,
    maxEntries: MAX_INDICATOR_CACHE_ENTRIES,
    totalPoints,
    totalItems,
    estimatedBytes:
      totalPoints * INDICATOR_POINT_ESTIMATED_BYTES +
      totalItems * OUTPUT_ITEM_ESTIMATED_BYTES,
    entries: snapshot,
  };
}

export function trimIndicatorResultCacheEntries(
  victims: IndicatorCacheTrimVictim[] = [],
) {
  const byKey = new Map<string, IndicatorCacheTrimVictim>();
  for (const victim of victims) {
    if (typeof victim.key === "string" && victim.key) byKey.set(victim.key, victim);
  }
  const removed = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const [key, victim] of byKey.entries()) {
    const entry = entries.get(key);
    if (!entry) continue;
    if (hasCacheLease("indicator-result-cache", key)) {
      skipped.push({ key, reason: "active-lease" });
      continue;
    }
    const normalized = entry.normalized || emptyNormalized();
    const accounting = indicatorAccounting(normalized);
    const expectedGeneration = Number(victim.generation);
    if (
      Number.isFinite(expectedGeneration)
      && expectedGeneration > 0
      && entryGenerations.get(key) !== expectedGeneration
    ) {
      skipped.push({ key, reason: "generation-changed" });
      continue;
    }
    const plannedLastAccessMs = Number(victim.lastAccessMs);
    if (
      Number.isFinite(plannedLastAccessMs)
      && plannedLastAccessMs > 0
      && entry.lastAccessMs > plannedLastAccessMs
    ) {
      skipped.push({ key, reason: "accessed-after-plan" });
      continue;
    }
    if (
      victim.expectedRevision !== undefined
      && stableJson(normalizeIndicatorRevision(entry.revision))
        !== stableJson(normalizeIndicatorRevision(victim.expectedRevision))
    ) {
      skipped.push({ key, reason: "revision-changed" });
      continue;
    }
    if (
      victim.reason === "missing-kline-dependency"
      && dependencyAvailable(entry.dependencyKey || indicatorDependencyKey(entry.context))
    ) {
      skipped.push({ key, reason: "dependency-restored" });
      continue;
    }
    if (victim?.action === "trim-range") {
      if (victim.keepStart == null || !Number.isFinite(Number(victim.keepStart))) {
        skipped.push({ key, reason: "invalid-trim-boundary" });
        continue;
      }
      const trimSafety = analyzeTrimSafety(normalized);
      if (trimSafety.safeRangeTrim) {
        const nextNormalized = freezeOwned(trimNormalizedBefore(
          normalized,
          victim.keepStart,
        ));
        const nextAccounting = indicatorAccounting(nextNormalized);
        const removedPoints = Math.max(0, accounting.points - nextAccounting.points);
        const removedItems = Math.max(0, accounting.items - nextAccounting.items);
        const removedEstimatedBytes = Math.max(
          0,
          accounting.estimatedBytes - nextAccounting.estimatedBytes,
        );
        const plannedRelief = victim.relief;
        if (
          plannedRelief
          && (
            removedPoints !== Number(plannedRelief.indicatorPoints || 0)
            || removedItems !== Number(plannedRelief.indicatorItems || 0)
            || removedEstimatedBytes !== Number(plannedRelief.estimatedBytes || 0)
          )
        ) {
          skipped.push({ key, reason: "trim-accounting-changed" });
          continue;
        }
        if (removedEstimatedBytes <= 0) {
          skipped.push({ key, reason: "trim-no-relief" });
          continue;
        }
        const coverage = freezeOwned(buildOutputCoverage(nextNormalized));
        const updated = putEntry(key, {
          indicatorId: entry.indicatorId,
          context: entry.context,
          normalized: nextNormalized,
          schema: entry.schema,
          outputCoverage: coverage,
          coverage,
          computedSegments: (entry.computedSegments || []).flatMap((segment) =>
            subtractIndicatorRange(
              segment,
              [{ start: 1, end: Number(victim.keepStart) - 1 }],
              {
                ...rangeOptions(entry.context),
              },
            ),
          ),
          staleSegments: entry.staleSegments,
          revision: entry.revision,
        });
        if (!updated) {
          skipped.push({ key, reason: "dependency-unavailable" });
          continue;
        }
        removed.push({
          owner: "indicator-result-cache",
          key,
          action: "trim-range",
          points: removedPoints,
          items: removedItems,
          estimatedBytes: removedEstimatedBytes,
        });
        continue;
      }
      skipped.push({ key, reason: "trim-no-longer-safe" });
      continue;
    }
    const plannedRelief = victim.relief;
    if (
      plannedRelief
      && (
        accounting.points !== Number(plannedRelief.indicatorPoints || 0)
        || accounting.items !== Number(plannedRelief.indicatorItems || 0)
        || accounting.estimatedBytes !== Number(plannedRelief.estimatedBytes || 0)
      )
    ) {
      skipped.push({ key, reason: "delete-accounting-changed" });
      continue;
    }
    entries.delete(key);
    forgetEntryGeneration(key);
    unregisterCacheResource("indicator-result-cache", key);
    removed.push({
      owner: "indicator-result-cache",
      key,
      action: "delete-entry",
      points: accounting.points,
      items: accounting.items,
      estimatedBytes: accounting.estimatedBytes,
    });
  }
  return {
    owner: "indicator-result-cache",
    removedCount: removed.length,
    removedIndicatorPoints: removed.reduce(
      (total, entry) => total + entry.points,
      0,
    ),
    removedIndicatorItems: removed.reduce(
      (total, entry) => total + entry.items,
      0,
    ),
    removedEstimatedBytes: removed.reduce(
      (total, entry) => total + entry.estimatedBytes,
      0,
    ),
    removed,
    skipped,
  };
}
