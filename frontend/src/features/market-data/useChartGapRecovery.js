import { useCallback, useEffect, useRef } from "react";
import { fetchKlinesHistory, fetchLatestKlines } from "../../services/api";
import { parseIntervalSeconds } from "../../utils/intervals";
import { detectGaps } from "./chartDataRuntime";
import { requestIndicatorRangeInChunks } from "./indicatorRangeRuntime";

const GAP_RECOVERY_SCAN_MS = 5_000;
const GAP_RECOVERY_RELEASE_MS = 10_000;
const TAB_RECOVERY_MIN_HIDDEN_MS = 5_000;

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
  replaceChartData,
  requestIndicatorRange,
  updateLastPrice,
}) {
  const gapFillInFlightRef = useRef(new Set());
  const recoverGapsRef = useRef(null);
  const lastVisibleTimeRef = useRef(Date.now());
  const visibilityRecoveryInFlightRef = useRef(false);

  const recoverGaps = useCallback(async (currentData, sym, intv) => {
    if (!currentData || currentData.length < 3) return;

    const intvSecs = parseIntervalSeconds(intv);
    if (!intvSecs || intvSecs <= 0) return;

    const gaps = detectGaps(currentData, intvSecs);
    if (gaps.length === 0) return;

    const reloadKey = `${sym}-${intv}-fullreload`;
    if (gapFillInFlightRef.current.has(reloadKey)) return;
    gapFillInFlightRef.current.add(reloadKey);

    const totalMissing = gaps.reduce((sum, gap) => sum + gap.missingBars, 0);
    console.log(
      `[GapFill] Detected ${gaps.length} gap(s), ~${totalMissing} bars missing. ` +
      `Reloading full history for ${sym}@${intv}...`,
    );

    try {
      const days = getIntervalDays(intv, exchange);
      const result = await fetchKlinesHistory(sym, intv, days, marketType, exchange);

      if (result?.data?.length > 0) {
        replaceChartData(sym, intv, result.data, {
          cache: true,
          source: "gap-fill-history",
        });
        const remaining = detectGaps(result.data, intvSecs);
        if (remaining.length > 0) {
          console.warn(`[GapFill] ${remaining.length} gap(s) remain after history reload`);
        } else {
          console.log(`[GapFill] All gaps filled successfully (${result.data.length} total bars)`);
        }
        for (const gap of gaps) {
          requestIndicatorRangeInChunks(
            requestIndicatorRange,
            gap.from + intvSecs,
            gap.to - intvSecs,
            intvSecs,
          );
        }
      }
    } catch (err) {
      console.warn("[GapFill] Failed to reload history:", err);
    } finally {
      setTimeout(() => {
        gapFillInFlightRef.current.delete(reloadKey);
      }, GAP_RECOVERY_RELEASE_MS);
    }
  }, [exchange, getIntervalDays, marketType, replaceChartData, requestIndicatorRange]);

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
          replaceChartData(symbol, currentIntv, historyResult.data, {
            cache: true,
            source: "tab-recovery-history",
          });
          const remaining = detectGaps(historyResult.data, intvSecs);
          if (remaining.length > 0) {
            console.warn(`[TabRecovery] ${remaining.length} gap(s) remain after history reload`);
          } else {
            console.log(`[TabRecovery] All gaps filled (${historyResult.data.length} total bars)`);
          }
          requestIndicatorRangeInChunks(
            requestIndicatorRange,
            historyResult.data[0]?.time,
            historyResult.data[historyResult.data.length - 1]?.time,
            intvSecs,
          );
          const latest = historyResult.data[historyResult.data.length - 1];
          updateLastPrice(latest, currentIntv);
          console.log(`[TabRecovery] Reloaded ${historyResult.data.length} bars of full history`);
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
    mergeCacheData,
    replaceChartData,
    requestIndicatorRange,
    symbol,
    trackedIntervalsRef,
    updateLastPrice,
  ]);

  const resetGapRecovery = useCallback(() => {
    gapFillInFlightRef.current.clear();
  }, []);

  return { resetGapRecovery };
}
