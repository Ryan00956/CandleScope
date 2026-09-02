import type { ChartSession, DatasetKey } from "./chartSessionTypes.js";
import { canonicalizeIntervalValue } from "../../utils/intervals.js";
import {
  isLegacyKlineSeriesIdentity,
  klineSeriesIdentityKey,
} from "../market-data/klineSeriesIdentity.js";

export interface ChartDatasetSourceIdentity {
  sourceKind?: string;
  replaySessionId?: string;
  dataEpoch?: string;
  publicTimelineEpoch?: string | number;
}

function keyPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function buildChartDatasetKey<T extends ChartSession & ChartDatasetSourceIdentity>(
  session: T,
): DatasetKey {
  const {
    exchange,
    marketType,
    symbol,
    interval,
    sourceKind,
    replaySessionId,
    dataEpoch,
    publicTimelineEpoch,
  } = session;
  const canonicalInterval = canonicalizeIntervalValue(interval) || interval;
  const routedKey = [exchange, marketType, symbol, canonicalInterval].join("-");
  const legacyKey = isLegacyKlineSeriesIdentity(exchange, session)
    ? routedKey
    : `${klineSeriesIdentityKey(exchange, session)}::${routedKey}`;
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
