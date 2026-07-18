import type { ChartSession, DatasetKey } from "./chartSessionTypes.js";

export interface ChartDatasetSourceIdentity {
  sourceKind?: string;
  replaySessionId?: string;
  dataEpoch?: string;
  publicTimelineEpoch?: string | number;
}

function keyPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function buildChartDatasetKey<T extends ChartSession & ChartDatasetSourceIdentity>({
  exchange,
  marketType,
  symbol,
  interval,
  sourceKind,
  replaySessionId,
  dataEpoch,
  publicTimelineEpoch,
}: T): DatasetKey {
  const legacyKey = [exchange, marketType, symbol, interval].join("-");
  const hasSourceScope = sourceKind !== undefined
    || replaySessionId !== undefined
    || dataEpoch !== undefined
    || publicTimelineEpoch !== undefined;
  if (!hasSourceScope) return legacyKey;

  if (sourceKind === "replay" && (
    !replaySessionId
    || !dataEpoch
    || publicTimelineEpoch === undefined
  )) {
    throw new Error("replay dataset identity requires session, data epoch, and public timeline epoch");
  }

  return [
    legacyKey,
    `source=${keyPart(sourceKind ?? "unknown")}`,
    `session=${keyPart(replaySessionId ?? "-")}`,
    `data=${keyPart(dataEpoch ?? "-")}`,
    `timeline=${keyPart(publicTimelineEpoch ?? "-")}`,
  ].join("::");
}
