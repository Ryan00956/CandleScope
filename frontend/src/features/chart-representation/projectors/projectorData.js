export const PROJECTION_METADATA_KEY = "chartProjection";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function sourceOhlc(row) {
  if (row?.__whitespace) return null;
  const open = finiteNumber(row?.open);
  const high = finiteNumber(row?.high);
  const low = finiteNumber(row?.low);
  const close = finiteNumber(row?.close);
  return open == null || high == null || low == null || close == null
    ? null
    : { open, high, low, close };
}

export function projectedOhlc(row) {
  return sourceOhlc(row);
}

export function projectionMetadata(row, projectorId, { synthetic = false } = {}) {
  return {
    ...(row?.customValues || {}),
    [PROJECTION_METADATA_KEY]: Object.freeze({
      projectorId,
      sourceFromTime: row?.time ?? null,
      sourceToTime: row?.time ?? null,
      sourceOrdinal: 0,
      synthetic,
    }),
  };
}

export function whitespaceDisplayRow(row, projectorId, options = {}) {
  const point = {
    time: row?.time,
    customValues: projectionMetadata(row, projectorId, options),
  };
  if (Object.prototype.hasOwnProperty.call(row || {}, "volume")) point.volume = row.volume;
  return point;
}

export function withProjectionMetadata(row, projectorId, options = {}) {
  return {
    ...row,
    customValues: projectionMetadata(row, projectorId, options),
  };
}
