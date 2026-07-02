import { useCallback, useRef, useState } from "react";

export const INDICATOR_RANGE_REQUEST_REASONS = Object.freeze({
  LOAD_MORE_LEFT: "load-more-left",
  BACKFILL_COMPLETED: "backfill-completed",
  GAP_RECOVERY: "gap-recovery",
  WINDOW_DELTA: "window-delta",
});

function normalizeRangeBoundary(value) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) ? normalized : null;
}

export function useMarketDataEvents({ interval, sessionKey }) {
  const [indicatorRangeRequests, setIndicatorRangeRequests] = useState([]);
  const indicatorRangeRequestIdRef = useRef(0);

  const publishIndicatorRangeRequest = useCallback((start, end, reason) => {
    const startSec = normalizeRangeBoundary(start);
    const endSec = normalizeRangeBoundary(end);
    if (!startSec || !endSec || startSec > endSec) return false;

    indicatorRangeRequestIdRef.current += 1;
    const request = {
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

  const consumeIndicatorRangeRequest = useCallback((requestId) => {
    setIndicatorRangeRequests((current) => current.filter((request) => request.id !== requestId));
  }, []);

  const createIndicatorRangeRequester = useCallback((reason) => (
    (start, end) => publishIndicatorRangeRequest(start, end, reason)
  ), [publishIndicatorRangeRequest]);

  return {
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    createIndicatorRangeRequester,
  };
}
