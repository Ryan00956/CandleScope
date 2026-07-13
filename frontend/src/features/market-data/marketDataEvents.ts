import { useCallback, useRef, useState } from "react";

import type { IndicatorRangeEvent } from "./klineContracts.js";
import type { EpochSeconds } from "./marketDataTypes.js";
import { toEpochSeconds } from "./marketDataTypes.js";

export const INDICATOR_RANGE_REQUEST_REASONS = {
  LOAD_MORE_LEFT: "load-more-left",
  BACKFILL_COMPLETED: "backfill-completed",
  GAP_RECOVERY: "gap-recovery",
  WINDOW_DELTA: "window-delta",
} as const;

export type IndicatorRangeRequestReason =
  (typeof INDICATOR_RANGE_REQUEST_REASONS)[keyof typeof INDICATOR_RANGE_REQUEST_REASONS];

interface UseMarketDataEventsOptions {
  interval: string;
  sessionKey: string;
}
function normalizeRangeBoundary(value: unknown): EpochSeconds | null {
  return toEpochSeconds(Math.floor(Number(value)));
}

export function useMarketDataEvents({
  interval,
  sessionKey,
}: UseMarketDataEventsOptions): {
  indicatorRangeRequests: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest: (requestId: number) => void;
  createIndicatorRangeRequester: (
    reason: IndicatorRangeRequestReason,
  ) => (start: unknown, end: unknown) => boolean;
} {
  const [indicatorRangeRequests, setIndicatorRangeRequests] = useState<IndicatorRangeEvent[]>([]);
  const indicatorRangeRequestIdRef = useRef(0);

  const publishIndicatorRangeRequest = useCallback((
    start: unknown,
    end: unknown,
    reason: IndicatorRangeRequestReason,
  ): boolean => {
    const startSec = normalizeRangeBoundary(start);
    const endSec = normalizeRangeBoundary(end);
    if (!startSec || !endSec || startSec > endSec) return false;

    indicatorRangeRequestIdRef.current += 1;
    const request: IndicatorRangeEvent = {
      id: indicatorRangeRequestIdRef.current,
      sessionKey,
      start: startSec,
      end: endSec,
      interval,
      reason,
      createdAt: Date.now(),
    };
    setIndicatorRangeRequests((current) => [...current, request]);
    return true;
  }, [interval, sessionKey]);

  const consumeIndicatorRangeRequest = useCallback((requestId: number): void => {
    setIndicatorRangeRequests((current) => current.filter((request) => request.id !== requestId));
  }, []);

  const createIndicatorRangeRequester = useCallback((reason: IndicatorRangeRequestReason) => (
    (start: unknown, end: unknown) => publishIndicatorRangeRequest(start, end, reason)
  ), [publishIndicatorRangeRequest]);

  return {
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    createIndicatorRangeRequester,
  };
}
