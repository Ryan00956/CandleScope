import { useCallback, useEffect, useMemo, useState } from "react";
import { SeriesDataFeed } from "../market-data/feed/seriesDataFeed.js";
import type { FeedResult, AppliedKlineResult } from "../market-data/klineContracts.js";
import type { EpochSeconds, MarketSeries } from "../market-data/marketDataTypes.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import { floorIntervalTime } from "../../utils/intervalTimeline.js";
import { LocalKlineApi } from "./localDataApi.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";


export interface LocalChartRuntime {
  seriesStore: SeriesWindowStore;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMoreLeft: boolean;
  loadMoreLeft(oldestLoadedTime?: EpochSeconds | null): Promise<void>;
  focusTime(time: number): Promise<boolean>;
  retry(): void;
}

function resultHasMore(result: FeedResult | AppliedKlineResult): boolean {
  return result.has_more === true;
}

export function buildLocalChartDataMeta(
  seriesStore: SeriesWindowStore,
  status: "loading" | "ready",
  observedVersion = Number(seriesStore.version),
): ChartDataCommitMeta {
  const description = seriesStore.describe();
  return {
    version: observedVersion,
    status,
    source: "local_dataset",
    seriesKey: seriesStore.seriesKey,
    bars: description.bars,
    firstTime: description.firstTime,
    lastTime: description.lastTime,
    coverage: {
      from: description.coverage.firstTime,
      to: description.coverage.lastTime,
      bars: description.coverage.bars,
    },
    committedAt: null,
    optimistic: false,
    historyComplete: true,
    dataRevision: seriesStore.seriesKey,
  };
}

export function useLocalChartRuntime(
  manifest: LocalDatasetManifest,
  interval: string = manifest.interval,
): LocalChartRuntime {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreLeft, setHasMoreLeft] = useState(true);
  const series = useMemo<MarketSeries>(() => ({
    exchange: "local",
    marketType: manifest.dataset_id,
    symbol: manifest.symbol,
    interval,
  }), [interval, manifest.dataset_id, manifest.symbol]);
  const seriesStore = useMemo(() => new SeriesWindowStore({
    intervalSeconds: parseIntervalSeconds(interval),
    seriesKey: `local:${manifest.dataset_id}:${manifest.data_epoch}:${interval}`,
  }), [interval, manifest.data_epoch, manifest.dataset_id]);
  const feed = useMemo(() => new SeriesDataFeed({
    api: new LocalKlineApi(manifest.dataset_id),
    getActiveSeries: () => series,
    isActiveSeries: (candidate) => (
      candidate.exchange === series.exchange
      && candidate.marketType === series.marketType
      && candidate.symbol === series.symbol
      && candidate.interval === series.interval
    ),
    commitMergedChartData: (_symbol, _interval, rows) => {
      seriesStore.applyRange(rows, { source: "local_dataset" });
    },
    commitPatchedChartData: (_symbol, _interval, rows) => {
      seriesStore.applyRange(rows, { source: "local_dataset" });
    },
  }), [manifest.dataset_id, series, seriesStore]);

  useEffect(() => {
    const controller = new AbortController();
    feed.beginEpoch(series);
    seriesStore.clear({ source: "local_dataset_switch" });
    setLoading(true);
    setError(null);
    void feed.getHistory(series, {
      countBack: 2_000,
      commit: "active",
      signal: controller.signal,
      source: "local-initial",
    }).then((result) => {
      if (controller.signal.aborted) return;
      setHasMoreLeft(resultHasMore(result));
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "本地数据读取失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      controller.abort();
      feed.cancelSeriesRequests(series);
    };
  }, [attempt, feed, series, seriesStore]);

  const loadMoreLeft = useCallback(async (oldestLoadedTime?: EpochSeconds | null) => {
    if (loadingMore || !hasMoreLeft) return;
    const before = oldestLoadedTime ?? seriesStore.first()?.time ?? undefined;
    if (before === undefined) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await feed.getBefore(series, {
        before,
        bars: 1_000,
        commit: "active",
        source: "local-before",
      });
      setHasMoreLeft(resultHasMore(result));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早的本地数据读取失败");
    } finally {
      setLoadingMore(false);
    }
  }, [feed, hasMoreLeft, loadingMore, series, seriesStore]);

  const focusTime = useCallback(async (time: number): Promise<boolean> => {
    if (!Number.isFinite(time) || time <= 0) return false;
    const target = (floorIntervalTime(interval, time) ?? time) as EpochSeconds;
    if (seriesStore.hasTime(target)) return true;
    const intervalSeconds = parseIntervalSeconds(interval) ?? 60;
    const radius = Math.max(intervalSeconds * 120, 3_600);
    setLoadingMore(true);
    setError(null);
    try {
      await feed.getRange(series, {
        startSec: Math.max(1, time - radius) as EpochSeconds,
        endSec: (time + radius) as EpochSeconds,
        repair: "none",
        strict: false,
        commit: "active",
        source: "local-analysis-focus",
        maxPages: 2,
      });
      if (!seriesStore.hasTime(target)) {
        setError("标记对应的 K 线不在当前数据集内");
        return false;
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法定位分析标记");
      return false;
    } finally {
      setLoadingMore(false);
    }
  }, [feed, interval, series, seriesStore]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    seriesStore,
    loading,
    loadingMore,
    error,
    hasMoreLeft,
    loadMoreLeft,
    focusTime,
    retry,
  };
}
