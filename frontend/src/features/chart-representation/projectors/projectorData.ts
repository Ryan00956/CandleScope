import type {
  DisplayRow,
  OhlcValues,
  ProjectionCustomValues,
  SourceBar,
} from "../chartRepresentationTypes.js";

export const PROJECTION_METADATA_KEY = "chartProjection";

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function sourceOhlc(row: SourceBar | DisplayRow | null | undefined): OhlcValues | null {
  if (row?.__whitespace) return null;
  const open = finiteNumber(row?.open);
  const high = finiteNumber(row?.high);
  const low = finiteNumber(row?.low);
  const close = finiteNumber(row?.close);
  return open == null || high == null || low == null || close == null
    ? null
    : { open, high, low, close };
}

export function projectedOhlc(row: DisplayRow | null | undefined): OhlcValues | null {
  return sourceOhlc(row);
}

export function projectionMetadata(
  row: SourceBar,
  projectorId: string,
  { synthetic = false }: { synthetic?: boolean } = {},
): ProjectionCustomValues {
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

export function whitespaceDisplayRow(
  row: SourceBar,
  projectorId: string,
  options: { synthetic?: boolean } = {},
): DisplayRow {
  const point: DisplayRow = {
    time: row?.time,
    customValues: projectionMetadata(row, projectorId, options),
  };
  if (Object.prototype.hasOwnProperty.call(row || {}, "volume")) point.volume = row.volume;
  return point;
}

export function withProjectionMetadata(
  row: SourceBar,
  projectorId: string,
  options: { synthetic?: boolean } = {},
): DisplayRow {
  return {
    ...row,
    customValues: projectionMetadata(row, projectorId, options),
  };
}
