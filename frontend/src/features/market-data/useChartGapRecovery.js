import { useCallback, useEffect, useRef } from "react";
import { fetchKlinesHistory, fetchKlinesRange, fetchLatestKlines } from "../../services/api";
import { parseIntervalSeconds } from "../../utils/intervals";
import { detectGaps } from "./chartDataRuntime";
import { requestIndicatorRangeInChunks } from "./indicatorRangeRuntime";

const GAP_RECOVERY_SCAN_MS = 5_000;
const GAP_RECOVERY_RELEASE_MS = 10_000;
const GAP_REPAIR_WAIT_MS = 1_500;
const GAP_RETRY_BASE_MS = 10_000;
const GAP_RETRY_MAX_MS = 10 * 60 * 1_000;
const TAB_RECOVERY_MIN_HIDDEN_MS = 5_000;

function gapKeyFor({ exchange, marketType, symbol, interval, gap }) {
  return `${exchange}-${marketType}-${symbol}-${interval}-${gap.from}-${gap.to}`;
}

function gapRepairRange(gap, intervalSeconds) {
  const start = gap.from + intervalSeconds;
  const end = gap.to - intervalSeconds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function rowRange(rows) {
  if (!rows?.length) return null;
  return {
    start: rows[0]?.time,
    end: rows[rows.length - 1]?.time,
  };
}

export function useChartGapRecovery({
  loading,
  dataReady = true,
  dataSource,
  symbol,
  exchange,
  marketType,
  intervalRef,
  trackedIntervalsRef,
  getIntervalDays,
  getCache,
  mergeCacheData,
  commitMergedChartData,
  requestIndicatorRange,
  updateLastPrice,
}) {
  const gapFillInFlightRef = useRef(new Set());
  const unresolvedGapsRef = useRef(new Map());
  const recoverGapsRef = useRef(null);
  const lastVisibleTimeRef = useRef(Date.now());
  const visibilityRecoveryInFlightRef = useRef(false);

  const isGapBackedOff = useCallback((key) => {
    const entry = unresolvedGapsRef.current.get(key);
    return entry?.nextRetryAt && Date.now() < entry.nextRetryAt;
  }, []);

  const markGapUnresolved = useCallback((key, reason) => {
    const previous = unresolvedGapsRef.current.get(key);
    const attempts = (previous?.attempts || 0) + 1;
    const delayMs = Math.min(GAP_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)), GAP_RETRY_MAX_MS);
    unresolvedGapsRef.current.set(key, {
      attempts,
      nextRetryAt: Date.now() + delayMs,
      reason,
    });
  }, []);

  const clearGapBackoff = useCallback((key) => {
    unresolvedGapsRef.current.delete(key);
  }, []);

  const requestIndicatorRows = useCallback((rows, intervalSeconds) => {
    if (!intervalSeconds || intervalSeconds <= 0) return;
    const range = rowRange(rows);
    if (!range || range.start == null || range.end == null) return;
    requestIndicatorRangeInChunks(
      requestIndicatorRange,
      range.start,
      range.end,
      intervalSeconds,
    );
  }, [requestIndicatorRange]);

  const mergeActiveRows = useCallback((sym, intv, rows, source, intervalSeconds) => {
    if (!rows?.length) return false;
    mergeCacheData(sym, intv, rows, { marketType, exchange });
    commitMergedChartData(sym, intv, rows, { source });
    requestIndicatorRows(rows, intervalSeconds);
    return true;
  }, [commitMergedChartData, exchange, marketType, mergeCacheData, requestIndicatorRows]);

  const recoverGaps = useCallback(async (currentData, sym, intv) => {
    if (!currentData || currentData.length < 3) return;

    const intvSecs = parseIntervalSeconds(intv);
    if (!intvSecs || intvSecs <= 0) return;

    const gaps = detectGaps(currentData, intvSecs);
    if (gaps.length === 0) return;

    const dueGaps = gaps.filter((gap) => {
      const key = gapKeyFor({ exchange, marketType, symbol: sym, interval: intv, gap });
      return !isGapBackedOff(key);
    });
    if (dueGaps.length === 0) return;

    const reloadKey = `${sym}-${intv}-gap-range`;
    if (gapFillInFlightRef.current.has(reloadKey)) return;
    gapFillInFlightRef.current.add(reloadKey);

    const totalMissing = dueGaps.reduce((sum, gap) => sum + gap.missingBars, 0);
    console.log(
      `[GapFill] Detected ${dueGaps.length} due gap(s), ~${totalMissing} bars missing. ` +
      `Repairing ranges for ${sym}@${intv}...`,
    );

    try {
      let mergedAny = false;
      for (const gap of dueGaps) {
        const key = gapKeyFor({ exchange, marketType, symbol: sym, interval: intv, gap });
        const range = gapRepairRange(gap, intvSecs);
        if (!range) {
          markGapUnresolved(key, "invalid-range");
          continue;
        }

        try {
          const result = await fetchKlinesRange(
            sym,
            intv,
            range.start,
            range.end,
            marketType,
            exchange,
            { repair: "wait", waitMs: GAP_REPAIR_WAIT_MS, strict: false },
          );
          const rows = result?.data || [];
          if (rows.length > 0) {
            mergedAny = mergeActiveRows(sym, intv, rows, "gap-fill-range", intvSecs) || mergedAny;
            clearGapBackoff(key);
          } else {
            markGapUnresolved(key, "empty-range-result");
          }
        } catch (rangeErr) {
          markGapUnresolved(key, "range-fetch-failed");
          console.warn(`[GapFill] Range repair failed for ${sym}@${intv} ${range.start}-${range.end}:`, rangeErr);
        }
      }

      if (mergedAny) {
        const latestCache = getCache(sym, intv, { marketType, exchange }) || [];
        const remaining = detectGaps(latestCache, intvSecs);
        if (remaining.length > 0) {
          console.warn(`[GapFill] ${remaining.length} gap(s) remain after range repair`);
        } else {
          console.log(`[GapFill] All gaps filled successfully (${latestCache.length} total bars)`);
        }
      }
    } catch (err) {
      console.warn("[GapFill] Failed to repair gaps:", err);
    } finally {
      setTimeout(() => {
        gapFillInFlightRef.current.delete(reloadKey);
      }, GAP_RECOVERY_RELEASE_MS);
    }
  }, [
    clearGapBackoff,
    exchange,
    getCache,
    isGapBackedOff,
    markGapUnresolved,
    marketType,
    mergeActiveRows,
  ]);

  useEffect(() => {
    recoverGapsRef.current = recoverGaps;
  }, [recoverGaps]);

  useEffect(() => {
    if (loading || !dataReady || dataSource === "mock") return undefined;

    const periodicTimer = setInterval(() => {
      if (!recoverGapsRef.current) return;

      const currentIntv = intervalRef.current;
      const currentCache = getCache(symbol, currentIntv, { marketType, exchange });

      if (currentCache && currentCache.length >= 3) {
        recoverGapsRef.current(currentCache, symbol, currentIntv);
      }
    }, GAP_RECOVERY_SCAN_MS);

    return () => clearInterval(periodicTimer);
  }, [dataReady, dataSource, exchange, getCache, intervalRef, loading, marketType, symbol]);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "hidden") {
        lastVisibleTimeRef.current = Date.now();
        return;
      }

      const hiddenDurationMs = Date.now() - lastVisibleTimeRef.current;
      const currentIntv = intervalRef.current;
      const intvSecs = parseIntervalSeconds(currentIntv);

      if (hiddenDurationMs < TAB_RECOVERY_MIN_HIDDEN_MS) return;
      if (visibilityRecoveryInFlightRef.current) return;
      visibilityRecoveryInFlightRef.current = true;

      console.log(
        `[TabRecovery] Tab was hidden for ${(hiddenDurationMs / 1000).toFixed(1)}s, ` +
        `recovering data for ${symbol}@${currentIntv}...`,
      );

      try {
        const days = getIntervalDays(currentIntv, exchange);
        const historyResult = await fetchKlinesHistory(symbol, currentIntv, days, marketType, exchange);

        if (historyResult?.data?.length > 0) {
          mergeActiveRows(symbol, currentIntv, historyResult.data, "tab-recovery-history", intvSecs);
          const mergedCache = getCache(symbol, currentIntv, { marketType, exchange }) || historyResult.data;
          const remaining = detectGaps(mergedCache, intvSecs);
          if (remaining.length > 0) {
            console.warn(`[TabRecovery] ${remaining.length} gap(s) remain after history merge`);
          } else {
            console.log(`[TabRecovery] All gaps filled (${mergedCache.length} total bars)`);
          }
          const latest = historyResult.data[historyResult.data.length - 1];
          updateLastPrice(latest, currentIntv);
          console.log(`[TabRecovery] Merged ${historyResult.data.length} bars of full history`);
        }

        for (const bgIntv of trackedIntervalsRef.current) {
          if (bgIntv === currentIntv) continue;
          const bgCache = getCache(symbol, bgIntv, { marketType, exchange });
          if (!bgCache || bgCache.length === 0) continue;

          try {
            const bgResult = await fetchLatestKlines(symbol, bgIntv, 10, marketType, exchange);
            if (bgResult?.data?.length > 0) {
              mergeCacheData(symbol, bgIntv, bgResult.data, { marketType, exchange });
            }
          } catch {
            // Non-critical background cache refresh.
          }
        }
      } catch (err) {
        console.warn("[TabRecovery] Recovery failed:", err);
      } finally {
        visibilityRecoveryInFlightRef.current = false;
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [
    exchange,
    getCache,
    getIntervalDays,
    intervalRef,
    marketType,
    mergeActiveRows,
    mergeCacheData,
    symbol,
    trackedIntervalsRef,
    updateLastPrice,
  ]);

  const resetGapRecovery = useCallback(() => {
    gapFillInFlightRef.current.clear();
    unresolvedGapsRef.current.clear();
  }, []);

  return { resetGapRecovery };
}
