import { useCallback, useRef } from "react";
import { fetchKlinesHistory, fetchLatestKlines } from "../../services/api";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks";
import { numericRange } from "./rangeRuntime";

const INITIAL_BACKFILL_RETRY_MS = 3_000;
const INITIAL_BACKFILL_TIMEOUT_MS = 10_000;
const INITIAL_BACKFILL_MAX_WAIT_MS = 60_000;

export function useChartInitialLoad({
  exchange,
  marketType,
  getIntervalDays,
  getFromCache,
  replaceChartData,
  clearChartData,
  commitMergedChartData,
  commitPatchedChartData,
  pendingInitialHistoryRef,
  updateLastPrice,
  setConnectionStatus,
  setDatasetKey,
  setLoading,
  setError,
  setLoadingMoreLeft,
  setHasMoreLeft,
  setCrosshairData,
  setDataSource,
}) {
  const abortRef = useRef(null);

  return useCallback(async (sym, intv, mt = marketType, ex = exchange) => {
    markPerf("chart.initialLoad.start", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const cached = getFromCache(sym, intv);
    const hasCacheHit = cached && cached.length > 0;
    let shownInitialData = false;

    if (hasCacheHit) {
      replaceChartData(sym, intv, cached, { source: "memory-cache-hit" });
      updateLastPrice(cached[cached.length - 1], intv);
      setConnectionStatus("connected");
      setDatasetKey((version) => version + 1);
      setLoading(false);
      setError(null);
      shownInitialData = true;
    } else {
      clearChartData("load-start-clear", sym, intv);
      setLoading(true);
      setError(null);
      setConnectionStatus("loading");
    }

    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setCrosshairData(null);
    pendingInitialHistoryRef.current = null;

    const days = getIntervalDays(intv, ex);

    function commitQuickResult(quickResult) {
      if (controller.signal.aborted || !quickResult?.data?.length) return;
      markPerf("chart.initialLoad.latest.commit", {
        source: quickResult.source || "unknown",
        bars: quickResult.data.length,
      });
      commitPatchedChartData(sym, intv, quickResult.data, {
        seedIfEmpty: true,
        source: "initial-latest",
      });
      const latestTick = quickResult.data[quickResult.data.length - 1];
      updateLastPrice(latestTick, intv);
      setDataSource(quickResult.source || "unknown");

      if (!shownInitialData) {
        setDatasetKey((version) => version + 1);
        setLoading(false);
        shownInitialData = true;
      }
    }

    function commitHistoryResult(historyResult) {
      if (controller.signal.aborted) return;

      recordPerfEvent("chart.initialLoad.history.result", {
        source: historyResult?.source || "unknown",
        bars: historyResult?.data?.length || 0,
        hasTailGap: Boolean(historyResult?.has_tail_gap),
      });

      if (historyResult?.start_ms != null && historyResult?.end_ms != null) {
        pendingInitialHistoryRef.current = {
          exchange: ex,
          marketType: mt,
          symbol: sym,
          interval: intv,
          range: numericRange(historyResult.start_ms, historyResult.end_ms),
        };
      }

      if (!historyResult?.data?.length) {
        recordPerfEvent("chart.initialLoad.history.empty", {
          exchange: ex,
          marketType: mt,
          symbol: sym,
          interval: intv,
        });
        startInitialHistoryRetry();
        return;
      }

      markPerf("chart.initialLoad.history.commit", {
        source: historyResult.source || "unknown",
        bars: historyResult.data.length,
      });
      commitMergedChartData(sym, intv, historyResult.data, { source: "initial-history" });
      const latest = historyResult.data[historyResult.data.length - 1];
      updateLastPrice(latest, intv);
      setDataSource(historyResult.source || "unknown");
      setConnectionStatus(historyResult.source === "mock" ? "loading" : "connected");

      if (!shownInitialData) {
        setDatasetKey((version) => version + 1);
        shownInitialData = true;
      }
      pendingInitialHistoryRef.current = null;

      if (historyResult.has_tail_gap) {
        setConnectionStatus("loading");
      }
      setLoading(false);
    }

    function startInitialHistoryRetry() {
      markPerf("chart.initialLoad.retry.start", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
      setConnectionStatus("loading");

      let retryTimer = null;
      let safetyTimer = null;
      let stoppedRetrying = false;
      const retryStartedAt = Date.now();

      const retryInitialHistory = async () => {
        if (controller.signal.aborted || stoppedRetrying) return false;
        try {
          const retryResult = await fetchKlinesHistory(sym, intv, days, mt, ex, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || stoppedRetrying) return false;
          if (retryResult?.data?.length) {
            markPerf("chart.initialLoad.retry.success", {
              source: retryResult.source || "unknown",
              bars: retryResult.data.length,
            });
            commitHistoryResult(retryResult);
            return true;
          }
        } catch (retryErr) {
          console.warn("Initial history retry failed:", retryErr);
        }
        return false;
      };

      const scheduleRetry = () => {
        if (controller.signal.aborted || stoppedRetrying) return;
        retryTimer = setTimeout(async () => {
          retryTimer = null;
          const loaded = await retryInitialHistory();
          if (loaded) {
            stoppedRetrying = true;
            if (safetyTimer) clearTimeout(safetyTimer);
            return;
          }
          if (Date.now() - retryStartedAt < INITIAL_BACKFILL_MAX_WAIT_MS) {
            scheduleRetry();
          }
        }, INITIAL_BACKFILL_RETRY_MS);
      };

      scheduleRetry();

      safetyTimer = setTimeout(async () => {
        if (controller.signal.aborted) return;
        if (await retryInitialHistory()) return;
        if (!shownInitialData) {
          markPerf("chart.initialLoad.retry.timeout", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
          setLoading(false);
          setDatasetKey((version) => version + 1);
        }
      }, INITIAL_BACKFILL_TIMEOUT_MS);

      controller.signal.addEventListener("abort", () => {
        stoppedRetrying = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
      });
    }

    markPerf("chart.initialLoad.latest.request", { exchange: ex, marketType: mt, symbol: sym, interval: intv, limit: 5 });
    markPerf("chart.initialLoad.history.request", { exchange: ex, marketType: mt, symbol: sym, interval: intv, days });

    await Promise.all([
      fetchLatestKlines(sym, intv, 5, mt, ex, "", { signal: controller.signal })
        .then((result) => {
          markPerf("chart.initialLoad.latest.response", {
            source: result?.source || "unknown",
            bars: result?.data?.length || 0,
          });
          commitQuickResult(result);
        })
        .catch(() => null),
      fetchKlinesHistory(sym, intv, days, mt, ex, { signal: controller.signal })
        .then((result) => {
          markPerf("chart.initialLoad.history.response", {
            source: result?.source || "unknown",
            bars: result?.data?.length || 0,
          });
          commitHistoryResult(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) startInitialHistoryRetry();
        }),
    ]);

    if (shownInitialData) {
      setLoading(false);
    }
  }, [
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
    exchange,
    getFromCache,
    getIntervalDays,
    marketType,
    pendingInitialHistoryRef,
    replaceChartData,
    setConnectionStatus,
    setCrosshairData,
    setDataSource,
    setDatasetKey,
    setError,
    setHasMoreLeft,
    setLoading,
    setLoadingMoreLeft,
    updateLastPrice,
  ]);
}
