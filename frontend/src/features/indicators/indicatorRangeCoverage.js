function finiteBoundary(value) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function finiteStep(value) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 1;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function normalizeIndicatorRange(range) {
  const start = finiteBoundary(range?.start ?? range?.from);
  const end = finiteBoundary(range?.end ?? range?.to);
  if (!start || !end || start > end) return null;
  return { start, end };
}

export function normalizeIndicatorRevision(source) {
  if (!source || typeof source !== "object") return null;
  const nested = source.dataRevision || source.data_revision || source.revision;
  const candidate = nested && typeof nested === "object" ? nested : source;
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

export function indicatorRevisionsCompatible(cachedInput, desiredInput) {
  const cached = normalizeIndicatorRevision(cachedInput);
  const desired = normalizeIndicatorRevision(desiredInput);
  if (!desired) return true;
  if (desired.historyInvalid) return false;
  if (!cached) return false;
  for (const key of ["serverEpoch", "correctionRevision", "token"]) {
    if (desired[key] === undefined) continue;
    if (cached[key] === undefined || cached[key] !== desired[key]) return false;
  }
  return true;
}

function sameRevision(left, right) {
  const a = normalizeIndicatorRevision(left);
  const b = normalizeIndicatorRevision(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return ["serverEpoch", "correctionRevision", "token"].every((key) => (
    (a[key] ?? null) === (b[key] ?? null)
  ));
}

export function mergeIndicatorRangeSegments(segments = [], options = {}) {
  const step = finiteStep(options.step);
  const desiredRevision = normalizeIndicatorRevision(options.revision);
  const normalized = [];
  for (const segment of segments || []) {
    const range = normalizeIndicatorRange(segment);
    if (!range) continue;
    const revision = normalizeIndicatorRevision(segment?.revision);
    if (desiredRevision && !indicatorRevisionsCompatible(revision, desiredRevision)) continue;
    normalized.push({ ...range, ...(revision ? { revision } : {}) });
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const segment of normalized) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && segment.start <= previous.end + step
      && sameRevision(previous.revision, segment.revision)
    ) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export function subtractIndicatorRange(desiredInput, coveredSegments = [], options = {}) {
  const desired = normalizeIndicatorRange(desiredInput);
  if (!desired) return [];
  const step = finiteStep(options.step);
  const covered = mergeIndicatorRangeSegments(coveredSegments, {
    step,
    revision: options.revision,
  });
  const missing = [];
  let cursor = desired.start;
  for (const segment of covered) {
    if (segment.end < cursor) continue;
    if (segment.start > desired.end) break;
    if (segment.start > cursor) {
      const missingEnd = Math.min(desired.end, segment.start - step);
      if (cursor <= missingEnd) missing.push({ start: cursor, end: missingEnd });
    }
    cursor = Math.max(cursor, segment.end + step);
    if (cursor > desired.end) break;
  }
  if (cursor <= desired.end) missing.push({ start: cursor, end: desired.end });
  return missing;
}

export function indicatorRangeCovered(desired, coveredSegments = [], options = {}) {
  return subtractIndicatorRange(desired, coveredSegments, options).length === 0;
}

export function invalidateIndicatorRangeSegments(segments = [], dirtyInput, options = {}) {
  const dirty = normalizeIndicatorRange(dirtyInput);
  if (!dirty) return mergeIndicatorRangeSegments(segments, options);
  const step = finiteStep(options.step);
  const cascadeRight = options.cascadeRight !== false;
  const nextRevision = normalizeIndicatorRevision(options.revision);
  const kept = [];
  for (const segment of mergeIndicatorRangeSegments(segments, { step })) {
    if (segment.end < dirty.start) {
      kept.push({ ...segment, ...(nextRevision ? { revision: nextRevision } : {}) });
      continue;
    }
    if (!cascadeRight && segment.start > dirty.end) {
      kept.push({ ...segment, ...(nextRevision ? { revision: nextRevision } : {}) });
      continue;
    }
    const leftEnd = dirty.start - step;
    if (segment.start <= leftEnd) {
      kept.push({
        start: segment.start,
        end: Math.min(segment.end, leftEnd),
        ...(nextRevision ? { revision: nextRevision } : segment.revision ? { revision: segment.revision } : {}),
      });
    }
    if (!cascadeRight) {
      const rightStart = dirty.end + step;
      if (segment.end >= rightStart) {
        kept.push({
          start: Math.max(segment.start, rightStart),
          end: segment.end,
          ...(nextRevision ? { revision: nextRevision } : segment.revision ? { revision: segment.revision } : {}),
        });
      }
    }
  }
  return mergeIndicatorRangeSegments(kept, { step });
}

export function indicatorRangeRightEdge(segments = [], revision = null) {
  const compatible = mergeIndicatorRangeSegments(segments, { revision });
  return compatible.reduce((latest, segment) => Math.max(latest, segment.end), 0) || null;
}

export function clampIndicatorRangeToClosedThrough(rangeInput, revisionInput) {
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

export function planIndicatorDirtyRefresh(dirtyInput, desiredInput) {
  const dirty = normalizeIndicatorRange(dirtyInput);
  const desired = normalizeIndicatorRange(desiredInput);
  if (!dirty || !desired || desired.end < dirty.start) return null;
  return {
    start: Math.max(desired.start, dirty.start),
    end: desired.end,
  };
}
