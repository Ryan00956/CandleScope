import { useCallback, useEffect, useRef, useState } from "react";

const PENDING_LOAD_MORE_LEFT_SAFETY_MAX_ATTEMPTS = 1;
const PENDING_LOAD_MORE_LEFT_SAFETY_MS = 3_000;
const LOAD_MORE_PAGE_SIZE = 500;

export function useChartLoadMoreLeft({
  symbol,
  exchange,
  marketType,
  interval,
  chartData,
  loading,
  dataSource,
  seriesDataFeed,
  commitMergedChartData,
}) {
  const [loadingMoreLeft, setLoadingMoreLeft] = useState(false);
  const [hasMoreLeft, setHasMoreLeft] = useState(true);
  const handleNeedMoreLeftRef = useRef(null);
  const oldestChartTime = chartData[0]?.time ?? null;

  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime) => {
      if (loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") return;
      if (oldestChartTime == null) return;

      const before = oldestLoadedTime || oldestChartTime;
      const series = { exchange, marketType, symbol, interval };
      if (seriesDataFeed.isBeforePageCoolingDown(series)) return;

      setLoadingMoreLeft(true);
      try {
        const result = await seriesDataFeed.requestBeforePage(series, {
          before,
          bars: LOAD_MORE_PAGE_SIZE,
          source: "history-before-page",
        });
        if (result.skipped) return;
        if (result.stale || result.active === false) return;
        const older = result.data || [];

        if (older.length > 0) {
          if (!result.committed) {
            commitMergedChartData(symbol, interval, older, { source: "history-before-page" });
          }
        } else if (result.has_more) {
          console.log(`[LoadMoreLeft] 0 bars returned for ${interval}, backfill likely in progress - will retry soon`);

          setTimeout(() => {
            if (!seriesDataFeed.markBeforePageSafetyRetry(
              series,
              before,
              PENDING_LOAD_MORE_LEFT_SAFETY_MAX_ATTEMPTS,
            )) {
              return;
            }
            handleNeedMoreLeftRef.current?.(before);
          }, PENDING_LOAD_MORE_LEFT_SAFETY_MS);
        }

        if (typeof result.has_more === "boolean") {
          setHasMoreLeft(result.has_more);
        } else if (older.length === 0) {
          setHasMoreLeft(false);
      }
    } catch (err) {
        console.error("Load older data failed:", err);
      } finally {
        setLoadingMoreLeft(false);
      }
    },
    [
      commitMergedChartData,
      dataSource,
      exchange,
      hasMoreLeft,
      interval,
      loading,
      loadingMoreLeft,
      marketType,
      oldestChartTime,
      seriesDataFeed,
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
    handleNeedMoreLeft,
  };
}
