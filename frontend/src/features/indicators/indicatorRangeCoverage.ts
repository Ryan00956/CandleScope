import { isIndicatorRecord } from "./indicatorContracts.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";
import type {
  IndicatorRange,
  IndicatorRangeOptions,
  IndicatorRangeSegment,
  IndicatorRevision,
} from "./indicatorTypes.js";

function finiteBoundary(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function finiteStep(value: unknown): number {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 1;
}

function rangeNavigation(options: IndicatorRangeOptions): {
  next: (value: number) => number;
  previous: (value: number) => number;
} {
  const step = finiteStep(options.step);
  const timeline = createIntervalTimeline(options.interval);
  return {
    next: (value) => timeline?.next(value) ?? (value + step),
    previous: (value) => timeline?.previous(value) ?? (value - step),
  };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function normalizeIndicatorRange(range: unknown): IndicatorRange | null {
  if (!isIndicatorRecord(range)) return null;
  const start = finiteBoundary(range.start ?? range.from);
  const end = finiteBoundary(range.end ?? range.to);
  if (!start || !end || start > end) return null;
  return { start, end };
}

export function normalizeIndicatorRevision(source: unknown): IndicatorRevision | null {
  if (!isIndicatorRecord(source)) return null;
  const nested = source.dataRevision || source.data_revision || source.revision;
  const candidate = isIndicatorRecord(nested) ? nested : source;
  const serverEpoch = firstDefined(
    candidate.serverEpoch,
    candidate.server_epoch,
    source.serverEpoch,
    source.server_epoch,
  );
  const correctionRevision = firstDefined(
    candidate.correctionRevision,
    candidate.correction_revision,
    source.correctionRevision,
    source.correction_revision,
  );
  const closedThrough = finiteBoundary(firstDefined(
    candidate.closedThrough,
    candidate.closed_through,
    source.closedThrough,
    source.closed_through,
  ));
  const opaque = firstDefined(
    candidate.token,
    candidate.value,
    typeof nested === "string" || typeof nested === "number" ? nested : undefined,
  );
  const dirtyRange = normalizeIndicatorRange(
    candidate.dirtyRange
      || candidate.dirty_range
      || source.dirtyRange
      || source.dirty_range,
  );
  const historyInvalid = Boolean(firstDefined(
    candidate.historyInvalid,
    candidate.history_invalid,
    source.historyInvalid,
    source.history_invalid,
  ));
  if (
    serverEpoch === undefined
    && correctionRevision === undefined
    && closedThrough == null
    && opaque === undefined
    && !dirtyRange
    && !historyInvalid
  ) {
    return null;
  }
  return {
    ...(serverEpoch !== undefined ? { serverEpoch: String(serverEpoch) } : {}),
    ...(correctionRevision !== undefined ? { correctionRevision: String(correctionRevision) } : {}),
    ...(closedThrough != null ? { closedThrough } : {}),
    ...(opaque !== undefined ? { token: String(opaque) } : {}),
    ...(dirtyRange ? { dirtyRange } : {}),
    ...(historyInvalid ? { historyInvalid: true } : {}),
  };
}

export function indicatorRevisionsCompatible(cachedInput: unknown, desiredInput: unknown): boolean {
  const cached = normalizeIndicatorRevision(cachedInput);
  const desired = normalizeIndicatorRevision(desiredInput);
  if (!desired) return true;
  if (desired.historyInvalid) return false;
  if (!cached) return false;
  for (const key of ["serverEpoch", "correctionRevision", "token"] as const) {
    if (desired[key] === undefined) continue;
    if (cached[key] === undefined || cached[key] !== desired[key]) return false;
  }
  return true;
}

function sameRevision(left: unknown, right: unknown): boolean {
  const a = normalizeIndicatorRevision(left);
  const b = normalizeIndicatorRevision(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (["serverEpoch", "correctionRevision", "token"] as const).every((key) => (
    (a[key] ?? null) === (b[key] ?? null)
  ));
}

export function mergeIndicatorRangeSegments(
  segments: readonly unknown[] = [],
  options: IndicatorRangeOptions = {},
): IndicatorRangeSegment[] {
  const navigation = rangeNavigation(options);
  const desiredRevision = normalizeIndicatorRevision(options.revision);
  const normalized: IndicatorRangeSegment[] = [];
  for (const segment of segments) {
    const range = normalizeIndicatorRange(segment);
    if (!range) continue;
    const revision = normalizeIndicatorRevision(isIndicatorRecord(segment) ? segment.revision : null);
    if (desiredRevision && !indicatorRevisionsCompatible(revision, desiredRevision)) continue;
    normalized.push({ ...range, ...(revision ? { revision } : {}) });
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: IndicatorRangeSegment[] = [];
  for (const segment of normalized) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && segment.start <= navigation.next(previous.end)
      && sameRevision(previous.revision, segment.revision)
    ) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export function subtractIndicatorRange(
  desiredInput: unknown,
  coveredSegments: readonly unknown[] = [],
  options: IndicatorRangeOptions = {},
): IndicatorRange[] {
  const desired = normalizeIndicatorRange(desiredInput);
  if (!desired) return [];
  const navigation = rangeNavigation(options);
  const covered = mergeIndicatorRangeSegments(coveredSegments, {
    interval: options.interval,
    step: options.step,
    revision: options.revision,
  });
  const missing: IndicatorRange[] = [];
  let cursor = desired.start;
  for (const segment of covered) {
    if (segment.end < cursor) continue;
    if (segment.start > desired.end) break;
    if (segment.start > cursor) {
      const missingEnd = Math.min(desired.end, navigation.previous(segment.start));
      if (cursor <= missingEnd) missing.push({ start: cursor, end: missingEnd });
    }
    cursor = Math.max(cursor, navigation.next(segment.end));
    if (cursor > desired.end) break;
  }
  if (cursor <= desired.end) missing.push({ start: cursor, end: desired.end });
  return missing;
}

export function indicatorRangeCovered(
  desired: unknown,
  coveredSegments: readonly unknown[] = [],
  options: IndicatorRangeOptions = {},
): boolean {
  return subtractIndicatorRange(desired, coveredSegments, options).length === 0;
}

export function invalidateIndicatorRangeSegments(
  segments: readonly unknown[] = [],
  dirtyInput: unknown,
  options: IndicatorRangeOptions = {},
): IndicatorRangeSegment[] {
  const dirty = normalizeIndicatorRange(dirtyInput);
  if (!dirty) return mergeIndicatorRangeSegments(segments, options);
  const navigation = rangeNavigation(options);
  const adjacencyOptions: IndicatorRangeOptions = {
    interval: options.interval,
    step: options.step,
  };
  const cascadeRight = options.cascadeRight !== false;
  const nextRevision = normalizeIndicatorRevision(options.revision);
  const kept: IndicatorRangeSegment[] = [];
  for (const segment of mergeIndicatorRangeSegments(segments, adjacencyOptions)) {
    if (segment.end < dirty.start) {
      kept.push({ ...segment, ...(nextRevision ? { revision: nextRevision } : {}) });
      continue;
    }
    if (!cascadeRight && segment.start > dirty.end) {
      kept.push({ ...segment, ...(nextRevision ? { revision: nextRevision } : {}) });
      continue;
    }
    const leftEnd = navigation.previous(dirty.start);
    if (segment.start <= leftEnd) {
      kept.push({
        start: segment.start,
        end: Math.min(segment.end, leftEnd),
        ...(nextRevision ? { revision: nextRevision } : segment.revision ? { revision: segment.revision } : {}),
      });
    }
    if (!cascadeRight) {
      const rightStart = navigation.next(dirty.end);
      if (segment.end >= rightStart) {
        kept.push({
          start: Math.max(segment.start, rightStart),
          end: segment.end,
          ...(nextRevision ? { revision: nextRevision } : segment.revision ? { revision: segment.revision } : {}),
        });
      }
    }
  }
  return mergeIndicatorRangeSegments(kept, adjacencyOptions);
}

export function indicatorRangeRightEdge(
  segments: readonly unknown[] = [],
  revision: unknown = null,
): number | null {
  const compatible = mergeIndicatorRangeSegments(segments, { revision });
  return compatible.reduce((latest, segment) => Math.max(latest, segment.end), 0) || null;
}

export function clampIndicatorRangeToClosedThrough(
  rangeInput: unknown,
  revisionInput: unknown,
): { formingOnly: boolean; range: IndicatorRange | null } {
  const range = normalizeIndicatorRange(rangeInput);
  if (!range) return { formingOnly: false, range: null };
  const revision = normalizeIndicatorRevision(revisionInput);
  const closedThrough = finiteBoundary(revision?.closedThrough);
  if (!closedThrough) return { formingOnly: false, range };
  if (range.start > closedThrough) return { formingOnly: true, range: null };
  return {
    formingOnly: false,
    range: { start: range.start, end: Math.min(range.end, closedThrough) },
  };
}

export function planIndicatorDirtyRefresh(dirtyInput: unknown, desiredInput: unknown): IndicatorRange | null {
  const dirty = normalizeIndicatorRange(dirtyInput);
  const desired = normalizeIndicatorRange(desiredInput);
  if (!dirty || !desired || desired.end < dirty.start) return null;
  return {
    start: Math.max(desired.start, dirty.start),
    end: desired.end,
  };
}
