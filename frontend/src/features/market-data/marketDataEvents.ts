import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { IndicatorRangeEvent } from "./klineContracts.js";
import type { EpochSeconds } from "./marketDataTypes.js";
import { toEpochSeconds } from "./marketDataTypes.js";
import { intervalsSemanticallyEquivalent } from "../../utils/intervals.js";

export const INDICATOR_RANGE_REQUEST_REASONS = {
  LOAD_MORE_LEFT: "load-more-left",
  BACKFILL_COMPLETED: "backfill-completed",
  GAP_RECOVERY: "gap-recovery",
  WINDOW_DELTA: "window-delta",
  WINDOW_PREPEND: "window-prepend",
  WINDOW_MID_MERGE: "window-mid-merge",
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

export function isIndicatorRangeSessionCurrent(
  activeSession: { interval: string; sessionKey: string },
  requestSession: { interval: string; sessionKey: string },
): boolean {
  return activeSession.sessionKey === requestSession.sessionKey
    && intervalsSemanticallyEquivalent(activeSession.interval, requestSession.interval);
}

export function retainCurrentIndicatorRangeRequests(
  requests: IndicatorRangeEvent[],
  activeSession: { interval: string; sessionKey: string },
): IndicatorRangeEvent[] {
  const retained = requests.filter((request) => isIndicatorRangeSessionCurrent(
    activeSession,
    { interval: request.interval, sessionKey: request.sessionKey },
  ));
  return retained.length === requests.length ? requests : retained;
}

export function useMarketDataEvents({
  interval,
  sessionKey,
}: UseMarketDataEventsOptions): {
  indicatorRangeRequests: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest: (requestId: number) => void;
  publishIndicatorRangeRequest: (
    start: unknown,
    end: unknown,
    reason: IndicatorRangeRequestReason,
    metadata?: Pick<IndicatorRangeEvent, "initialSettlementRelease">,
  ) => boolean;
  createIndicatorRangeRequester: (
    reason: IndicatorRangeRequestReason,
  ) => (start: unknown, end: unknown) => boolean;
} {
  const [indicatorRangeRequests, setIndicatorRangeRequests] = useState<IndicatorRangeEvent[]>([]);
  const indicatorRangeRequestIdRef = useRef(0);
  const activeSessionRef = useRef({ interval, sessionKey });

  useLayoutEffect(() => {
    activeSessionRef.current = { interval, sessionKey };
  }, [interval, sessionKey]);

  const publishIndicatorRangeRequest = useCallback((
    start: unknown,
    end: unknown,
    reason: IndicatorRangeRequestReason,
    metadata: Pick<IndicatorRangeEvent, "initialSettlementRelease"> = {},
  ): boolean => {
    if (!isIndicatorRangeSessionCurrent(
      activeSessionRef.current,
      { interval, sessionKey },
    )) return false;
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
      ...(metadata.initialSettlementRelease === true
        ? { initialSettlementRelease: true }
        : {}),
    };
    setIndicatorRangeRequests((current) => [
      ...retainCurrentIndicatorRangeRequests(current, { interval, sessionKey }),
      request,
    ]);
    return true;
  }, [interval, sessionKey]);

  const consumeIndicatorRangeRequest = useCallback((requestId: number): void => {
    setIndicatorRangeRequests((current) => retainCurrentIndicatorRangeRequests(
      current.filter((request) => request.id !== requestId),
      activeSessionRef.current,
    ));
  }, []);

  const createIndicatorRangeRequester = useCallback((reason: IndicatorRangeRequestReason) => (
    (start: unknown, end: unknown) => publishIndicatorRangeRequest(start, end, reason)
  ), [publishIndicatorRangeRequest]);

  const currentIndicatorRangeRequests = useMemo(
    () => retainCurrentIndicatorRangeRequests(
      indicatorRangeRequests,
      { interval, sessionKey },
    ),
    [indicatorRangeRequests, interval, sessionKey],
  );

  return {
    indicatorRangeRequests: currentIndicatorRangeRequests,
    consumeIndicatorRangeRequest,
    publishIndicatorRangeRequest,
    createIndicatorRangeRequester,
  };
}
