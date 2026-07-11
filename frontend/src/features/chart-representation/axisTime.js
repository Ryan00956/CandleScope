import { PROJECTION_METADATA_KEY } from "./projectors/projectorData.js";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareNumbers(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Returns true for the public ordinal horizontal-scale item accepted by the
 * custom Lightweight Charts behavior.
 */
export function isOrdinalAxisTime(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.order)
    && finiteNumber(value.sourceTime) !== null
    && Number.isSafeInteger(value.sourceOrdinal)
    && value.sourceOrdinal >= 0;
}

/**
 * Stable primitive key for chart-axis values. Invalid axis values have no key.
 */
export function axisTimeKey(value) {
  if (isOrdinalAxisTime(value)) return `order:${value.order}`;
  const sourceTime = finiteNumber(value);
  return sourceTime === null ? null : `time:${sourceTime}`;
}

/**
 * Compare values in their native axis order. Ordinal items are ordered by
 * `order`, even when their source timestamps are repeated or non-monotonic.
 */
export function compareAxisTime(left, right) {
  const leftOrdinal = isOrdinalAxisTime(left);
  const rightOrdinal = isOrdinalAxisTime(right);
  if (leftOrdinal && rightOrdinal) return compareNumbers(left.order, right.order);

  const leftSourceTime = sourceTimeFromAxisTime(left);
  const rightSourceTime = sourceTimeFromAxisTime(right);
  if (leftSourceTime !== null && rightSourceTime !== null) {
    const sourceComparison = compareNumbers(leftSourceTime, rightSourceTime);
    if (sourceComparison !== 0) return sourceComparison;
    if (leftOrdinal !== rightOrdinal) return leftOrdinal ? 1 : -1;
    return 0;
  }
  if (leftSourceTime !== null) return -1;
  if (rightSourceTime !== null) return 1;
  return 0;
}

/**
 * Resolve a domain/source timestamp from a public axis value.
 */
export function sourceTimeFromAxisTime(value) {
  if (isOrdinalAxisTime(value)) return value.sourceTime;
  return finiteNumber(value);
}

/**
 * Resolve the inclusive source-time lineage represented by a display row.
 */
export function sourceTimeRangeFromDisplayRow(row) {
  if (!row || typeof row !== "object") return null;
  const lineage = row.customValues?.[PROJECTION_METADATA_KEY];
  const rowSourceTime = finiteNumber(row.sourceTime);
  const axisSourceTime = sourceTimeFromAxisTime(row.time);
  const fallback = rowSourceTime ?? axisSourceTime;
  const from = finiteNumber(lineage?.sourceFromTime) ?? fallback;
  const to = finiteNumber(lineage?.sourceToTime) ?? fallback;
  if (from === null || to === null) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Resolve the most recent source timestamp represented by a display row.
 */
export function sourceTimeFromDisplayRow(row) {
  return sourceTimeRangeFromDisplayRow(row)?.to ?? null;
}

/**
 * Find the last projected element emitted by exactly one source timestamp.
 * This deliberately chooses the last brick when one source bar emits many.
 */
export function findLastDisplayIndexForSourceTime(displayRows, sourceTime) {
  const target = finiteNumber(sourceTime);
  if (target === null || !Array.isArray(displayRows)) return -1;
  let match = -1;
  for (let index = 0; index < displayRows.length; index += 1) {
    if (sourceTimeFromDisplayRow(displayRows[index]) === target) match = index;
  }
  return match;
}

function findAnchorDisplayIndex(displayRows, sourceTime) {
  const exact = findLastDisplayIndexForSourceTime(displayRows, sourceTime);
  if (exact >= 0) return exact;

  let atOrBefore = -1;
  let firstAfter = -1;
  for (let index = 0; index < displayRows.length; index += 1) {
    const rowTime = sourceTimeFromDisplayRow(displayRows[index]);
    if (rowTime === null) continue;
    if (rowTime <= sourceTime) atOrBefore = index;
    else if (firstAfter < 0) firstAfter = index;
  }
  return atOrBefore >= 0 ? atOrBefore : firstAfter;
}

/**
 * Map a source-time interval to the inclusive display logical indexes whose
 * lineage overlaps that interval. Repeated timestamps include every brick.
 */
export function mapSourceTimeRangeToDisplayLogicalRange(displayRows, sourceRange) {
  const from = finiteNumber(sourceRange?.from);
  const to = finiteNumber(sourceRange?.to);
  if (from === null || to === null || from > to || !Array.isArray(displayRows)) {
    return null;
  }

  let first = -1;
  let last = -1;
  for (let index = 0; index < displayRows.length; index += 1) {
    const lineage = sourceTimeRangeFromDisplayRow(displayRows[index]);
    if (!lineage || lineage.to < from || lineage.from > to) continue;
    if (first < 0) first = index;
    last = index;
  }
  return first < 0 ? null : { from: first, to: last };
}

/**
 * Rebuild a visible logical range around a source-time anchor.
 *
 * `screenOffset` is the old anchor logical index minus the old range's `to`.
 * Retaining it keeps the source anchor at the same horizontal screen position.
 */
export function mapSourceViewportAnchorToDisplayLogicalRange(displayRows, {
  sourceTime,
  logicalSpan,
  screenOffset = 0,
} = {}) {
  const target = finiteNumber(sourceTime);
  const span = finiteNumber(logicalSpan);
  const offset = finiteNumber(screenOffset);
  if (target === null || span === null || span < 0 || offset === null) return null;
  if (!Array.isArray(displayRows) || displayRows.length === 0) return null;

  const anchorIndex = findAnchorDisplayIndex(displayRows, target);
  if (anchorIndex < 0) return null;
  const to = anchorIndex - offset;
  return { from: to - span, to };
}
