import { useCallback, useRef } from "react";
import { fetchKlinesBefore, fetchKlinesHistory, fetchKlinesRange } from "../services/api";
import { parseIntervalSeconds } from "../utils/intervals";
import { requestIndicatorRangeInChunks } from "./indicatorRangeRuntime";
import {
  eventRangeFromDetail,
  isSameSeries,
  rangeCovers,
  rangesOverlap,
  rowRangeMs,
} from "./rangeRuntime";

const BACKFILL_RELOAD_COOLDOWN_MS = 10_000;
const PENDING_LOAD_MORE_LEFT_COMPLETION_MAX_ATTEMPTS = 3;

export function useBackfillCompletionRuntime({
  symbol,
  exchange,
  marketType,
  intervalRef,
  loadingRef,
  pendingInitialHistoryRef,
  pendingLoadMoreLeftRef,
  cacheKey,
  getIntervalDays,
  mergeCacheData,
  commitMergedChartData,
  requestIndicatorRange,
  setLastPrice,
  setError,
  setConnectionStatus,
  setLoading,
  setDatasetKey,
}) {
  const backfillReloadInFlightRef = useRef(new Set());

  return useCallback((msg) => {
    if (msg?.type !== "backfill_completed") return false;

    const bfInterval = msg.interval;
    const bfSymbol = msg.symbol || symbol;
    const bfExchange = msg.exchange || exchange;
    const bfMarketType = msg.market_type || marketType;
    const detail = msg.detail || {};
    const eventSeries = {
      exchange: bfExchange,
      marketType: bfMarketType,
      symbol: bfSymbol,
      interval: bfInterval,
    };
    const activeSeries = {
      exchange,
      marketType,
      symbol,
      interval: intervalRef.current,
    };
    const eventRange = eventRangeFromDetail(detail);
    const userVisibleReason = new Set([
      "initial_history",
      "visible_range_gap",
      "visible_load_more",
      "visible_seed_gap",
    ]).has(detail.reason);

    const bfDedupeKey = `${bfExchange}-${bfMarketType}-${bfSymbol}-${bfInterval}`;
    if (backfillReloadInFlightRef.current.has(bfDedupeKey)) {
      console.log(`[Backfill] Skipping duplicate reload for ${bfDedupeKey} (already in-flight/cooldown)`);
      return true;
    }
    backfillReloadInFlightRef.current.add(bfDedupeKey);

    console.log(`Backfill completed for ${bfSymbol}@${bfInterval}, reloading data...`);
    const days = getIntervalDays(bfInterval, bfExchange);

    const canReleaseInitialLoading = (rows) => {
      if (!isSameSeries(eventSeries, activeSeries)) return false;
      if (!loadingRef.current) return true;

      const pendingInitial = pendingInitialHistoryRef.current;
      const rowsRange = rowRangeMs(rows);
      if (pendingInitial && isSameSeries(eventSeries, pendingInitial)) {
        if (!pendingInitial.range) return true;
        if (rowsRange && rangesOverlap(rowsRange, pendingInitial.range)) return true;
        if (eventRange && rangesOverlap(eventRange, pendingInitial.range)) return true;
        if (detail.verified_contiguous === true && rangeCovers(eventRange, pendingInitial.range)) return true;
        return false;
      }

      return userVisibleReason;
    };

    const isActiveSeries = () => (
      bfInterval === intervalRef.current &&
      bfSymbol === symbol &&
      bfExchange === exchange &&
      bfMarketType === marketType
    );

    const mergeBackfillRows = (rows) => {
      if (!rows?.length) return false;
      mergeCacheData(bfSymbol, bfInterval, rows, {
        marketType: bfMarketType,
        exchange: bfExchange,
      });

      if (isActiveSeries()) {
        commitMergedChartData(bfSymbol, bfInterval, rows, { source: "backfill-completed" });
        setLastPrice((prev) => {
          if (prev) return prev;
          const latest = rows[rows.length - 1];
          return latest || prev;
        });
        requestIndicatorRangeInChunks(
          requestIndicatorRange,
          rows[0]?.time,
          rows[rows.length - 1]?.time,
          parseIntervalSeconds(bfInterval),
        );
        setError(null);
        if (canReleaseInitialLoading(rows)) {
          pendingInitialHistoryRef.current = null;
          setConnectionStatus("connected");
          setLoading(false);
        }
        setDatasetKey((version) => version + 1);
      }
      return true;
    };

    const readBackfilledData = async () => {
      const startMs = Number(detail.range_start_ms ?? detail.request_start_ms);
      const endMs = Number(detail.range_end_ms ?? detail.request_end_ms);
      let loadedAny = false;
      let lastError = null;

      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        try {
          const rangeResult = await fetchKlinesRange(
            bfSymbol,
            bfInterval,
            startMs / 1000,
            endMs / 1000,
            bfMarketType,
            bfExchange,
            { repair: "none", strict: false },
          );
          loadedAny = mergeBackfillRows(rangeResult?.data || []) || loadedAny;
        } catch (rangeErr) {
          lastError = rangeErr;
          console.warn(`[Backfill] Exact range reload failed for ${bfDedupeKey}:`, rangeErr);
        }
      }

      try {
        const result = await fetchKlinesHistory(bfSymbol, bfInterval, days, bfMarketType, bfExchange);
        loadedAny = mergeBackfillRows(result?.data || []) || loadedAny;
      } catch (historyErr) {
        lastError = historyErr;
        console.warn(`[Backfill] History reload failed for ${bfDedupeKey}:`, historyErr);
      }

      if (!loadedAny && lastError) {
        throw lastError;
      }
    };

    readBackfilledData()
      .then(() => {
        const pendingKey = cacheKey(bfSymbol, bfInterval, bfMarketType, bfExchange);
        const pending = pendingLoadMoreLeftRef.current.get(pendingKey);
        if (!pending) return undefined;
        const completionAttempts = pending.completionAttempts ?? 0;
        if (completionAttempts >= PENDING_LOAD_MORE_LEFT_COMPLETION_MAX_ATTEMPTS) {
          pendingLoadMoreLeftRef.current.delete(pendingKey);
          return undefined;
        }
        pending.completionAttempts = completionAttempts + 1;
        return fetchKlinesBefore(bfSymbol, bfInterval, pending.before, 500, bfMarketType, bfExchange)
          .then((beforeResult) => {
            const older = beforeResult?.data || [];
            if (older.length > 0) {
              const patchStart = older[0]?.time;
              const patchEnd = older[older.length - 1]?.time;
              mergeCacheData(bfSymbol, bfInterval, older, {
                marketType: bfMarketType,
                exchange: bfExchange,
              });
              if (isActiveSeries()) {
                commitMergedChartData(bfSymbol, bfInterval, older, { source: "backfill-before-page" });
                if (patchStart && patchEnd) {
                  requestIndicatorRangeInChunks(
                    requestIndicatorRange,
                    patchStart,
                    patchEnd,
                    parseIntervalSeconds(bfInterval),
                  );
                }
                setDatasetKey((version) => version + 1);
              }
              pendingLoadMoreLeftRef.current.delete(pendingKey);
            } else if (beforeResult && beforeResult.has_more === false) {
              pendingLoadMoreLeftRef.current.delete(pendingKey);
            }
          })
          .catch((err) => {
            console.warn(`[Backfill] Pending fetchKlinesBefore failed for ${pendingKey}:`, err);
          });
      })
      .catch((err) => {
        console.warn(`Failed to reload after backfill for ${bfInterval}:`, err);
      })
      .finally(() => {
        setTimeout(() => {
          backfillReloadInFlightRef.current.delete(bfDedupeKey);
        }, BACKFILL_RELOAD_COOLDOWN_MS);
      });

    return true;
  }, [
    cacheKey,
    commitMergedChartData,
    exchange,
    getIntervalDays,
    intervalRef,
    loadingRef,
    marketType,
    mergeCacheData,
    pendingInitialHistoryRef,
    pendingLoadMoreLeftRef,
    requestIndicatorRange,
    setConnectionStatus,
    setDatasetKey,
    setError,
    setLastPrice,
    setLoading,
    symbol,
  ]);
}
