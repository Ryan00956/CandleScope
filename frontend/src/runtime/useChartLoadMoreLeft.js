import { useCallback, useEffect, useRef, useState } from "react";
import { fetchKlinesBefore } from "../services/api";
import { parseIntervalSeconds } from "../utils/intervals";
import { requestIndicatorRangeInChunks } from "./indicatorRangeRuntime";

const NEED_MORE_LEFT_COOLDOWN_MS = 3_000;
const PENDING_LOAD_MORE_LEFT_SAFETY_MAX_ATTEMPTS = 1;
const PENDING_LOAD_MORE_LEFT_SAFETY_MS = 6_000;
const LOAD_MORE_PAGE_SIZE = 500;

export function useChartLoadMoreLeft({
  symbol,
  exchange,
  marketType,
  interval,
  chartData,
  loading,
  dataSource,
  cacheKey,
  commitMergedChartData,
  requestIndicatorRange,
}) {
  const [loadingMoreLeft, setLoadingMoreLeft] = useState(false);
  const [hasMoreLeft, setHasMoreLeft] = useState(true);
  const needMoreLeftCooldownRef = useRef(new Map());
  const pendingLoadMoreLeftRef = useRef(new Map());
  const handleNeedMoreLeftRef = useRef(null);
  const oldestChartTime = chartData[0]?.time ?? null;

  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime) => {
      if (loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") return;
      if (oldestChartTime == null) return;

      const cooldownKey = interval;
      const lastCall = needMoreLeftCooldownRef.current.get(cooldownKey) || 0;
      if (Date.now() - lastCall < NEED_MORE_LEFT_COOLDOWN_MS) return;

      const before = oldestLoadedTime || oldestChartTime;
      const pendingKey = cacheKey(symbol, interval);
      setLoadingMoreLeft(true);
      try {
        const result = await fetchKlinesBefore(
          symbol,
          interval,
          before,
          LOAD_MORE_PAGE_SIZE,
          marketType,
          exchange,
        );
        const older = result.data || [];

        if (older.length > 0) {
          const patchStart = older[0]?.time;
          const patchEnd = older[older.length - 1]?.time;
          commitMergedChartData(symbol, interval, older, { source: "history-before-page" });
          if (patchStart && patchEnd) {
            requestIndicatorRangeInChunks(
              requestIndicatorRange,
              patchStart,
              patchEnd,
              parseIntervalSeconds(interval),
            );
          }
          pendingLoadMoreLeftRef.current.delete(pendingKey);
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now());
        } else if (result.has_more) {
          console.log(`[LoadMoreLeft] 0 bars returned for ${interval}, backfill likely in progress - will retry in 5s`);
          const existing = pendingLoadMoreLeftRef.current.get(pendingKey);
          if (!existing || existing.before !== before) {
            pendingLoadMoreLeftRef.current.set(pendingKey, {
              before,
              safetyAttempts: 0,
              completionAttempts: 0,
            });
          }
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now() + 2_000);

          setTimeout(() => {
            const stillPending = pendingLoadMoreLeftRef.current.get(pendingKey);
            if (!stillPending || stillPending.before !== before) return;
            const safetyAttempts = stillPending.safetyAttempts ?? 0;
            if (safetyAttempts >= PENDING_LOAD_MORE_LEFT_SAFETY_MAX_ATTEMPTS) return;
            needMoreLeftCooldownRef.current.set(cooldownKey, 0);
            stillPending.safetyAttempts = safetyAttempts + 1;
            handleNeedMoreLeftRef.current?.(before);
          }, PENDING_LOAD_MORE_LEFT_SAFETY_MS);
        } else {
          pendingLoadMoreLeftRef.current.delete(pendingKey);
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now());
        }

        if (typeof result.has_more === "boolean") {
          setHasMoreLeft(result.has_more);
        } else if (older.length === 0) {
          setHasMoreLeft(false);
        }
      } catch (err) {
        console.error("Load older data failed:", err);
        needMoreLeftCooldownRef.current.set(cooldownKey, Date.now() + 2_000);
      } finally {
        setLoadingMoreLeft(false);
      }
    },
    [
      cacheKey,
      commitMergedChartData,
      dataSource,
      exchange,
      hasMoreLeft,
      interval,
      loading,
      loadingMoreLeft,
      marketType,
      oldestChartTime,
      requestIndicatorRange,
      symbol,
    ],
  );

  useEffect(() => {
    handleNeedMoreLeftRef.current = handleNeedMoreLeft;
  }, [handleNeedMoreLeft]);

  return {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    pendingLoadMoreLeftRef,
    handleNeedMoreLeft,
  };
}
