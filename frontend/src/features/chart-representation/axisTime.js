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

function sourceOrdinalFromDisplayRow(row) {
  if (isOrdinalAxisTime(row?.time)) return row.time.sourceOrdinal;
  const ordinal = row?.customValues?.[PROJECTION_METADATA_KEY]?.sourceOrdinal;
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
}

/**
 * Resolve a captured axis anchor against a newly projected display.
 *
 * Synthetic `order` values are projection-local and may be reassigned by a
 * structural rebuild, so they are deliberately never used here. Source
 * lineage is stable across those rebuilds. Within a 1:N source emission the
 * original source ordinal is preferred; if that exact output disappeared, the
 * closest predecessor ordinal is retained before falling forward.
 */
export function findDisplayIndexForAxisAnchor(displayRows, axisTime) {
  const targetSourceTime = sourceTimeFromAxisTime(axisTime);
  if (targetSourceTime === null
    || !Array.isArray(displayRows)
    || displayRows.length === 0) {
    return -1;
  }

  const targetSourceOrdinal = isOrdinalAxisTime(axisTime)
    ? axisTime.sourceOrdinal
    : null;
  let lastExactSourceIndex = -1;
  let exactOrdinalIndex = -1;
  let predecessorOrdinalIndex = -1;
  let predecessorOrdinal = -1;
  let successorOrdinalIndex = -1;
  let successorOrdinal = Number.POSITIVE_INFINITY;
  let hasExactSourceOrdinal = false;

  for (let index = 0; index < displayRows.length; index += 1) {
    const row = displayRows[index];
    const rowSourceTime = sourceTimeFromAxisTime(row?.time)
      ?? sourceTimeFromDisplayRow(row);
    if (rowSourceTime !== targetSourceTime) continue;

    lastExactSourceIndex = index;
    if (targetSourceOrdinal === null) continue;
    const rowSourceOrdinal = sourceOrdinalFromDisplayRow(row);
    if (rowSourceOrdinal === null) continue;
    hasExactSourceOrdinal = true;
    if (rowSourceOrdinal === targetSourceOrdinal) {
      exactOrdinalIndex = index;
    } else if (rowSourceOrdinal < targetSourceOrdinal
      && rowSourceOrdinal >= predecessorOrdinal) {
      predecessorOrdinal = rowSourceOrdinal;
      predecessorOrdinalIndex = index;
    } else if (rowSourceOrdinal > targetSourceOrdinal
      && rowSourceOrdinal < successorOrdinal) {
      successorOrdinal = rowSourceOrdinal;
      successorOrdinalIndex = index;
    }
  }

  if (exactOrdinalIndex >= 0) return exactOrdinalIndex;
  if (predecessorOrdinalIndex >= 0) return predecessorOrdinalIndex;
  if (successorOrdinalIndex >= 0) return successorOrdinalIndex;
  if (lastExactSourceIndex >= 0 && !hasExactSourceOrdinal) {
    return lastExactSourceIndex;
  }

  let containingIndex = -1;
  let containingTo = Number.POSITIVE_INFINITY;
  let containingFrom = Number.NEGATIVE_INFINITY;
  let predecessorIndex = -1;
  let predecessorTime = Number.NEGATIVE_INFINITY;
  let firstAfterIndex = -1;
  let firstAfterTime = Number.POSITIVE_INFINITY;
  for (let index = 0; index < displayRows.length; index += 1) {
    const lineage = sourceTimeRangeFromDisplayRow(displayRows[index]);
    if (!lineage) continue;
    if (lineage.from <= targetSourceTime && targetSourceTime <= lineage.to) {
      if (lineage.to < containingTo
        || (lineage.to === containingTo && lineage.from > containingFrom)
        || (lineage.to === containingTo
          && lineage.from === containingFrom
          && index > containingIndex)) {
        containingTo = lineage.to;
        containingFrom = lineage.from;
        containingIndex = index;
      }
      continue;
    }
    if (lineage.to < targetSourceTime && lineage.to >= predecessorTime) {
      predecessorTime = lineage.to;
      predecessorIndex = index;
    } else if (lineage.from > targetSourceTime && lineage.from < firstAfterTime) {
      firstAfterTime = lineage.from;
      firstAfterIndex = index;
    }
  }

  if (containingIndex >= 0) return containingIndex;
  return predecessorIndex >= 0 ? predecessorIndex : firstAfterIndex;
}

function findAnchorDisplayIndex(displayRows, sourceTime) {
  return findDisplayIndexForAxisAnchor(displayRows, sourceTime);
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
