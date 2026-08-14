import { useCallback, useMemo } from "react";

import {
  createActiveIndicatorPersistence,
} from "../indicators/activeIndicatorStore.js";
import type {
  IndicatorComputeBatchExecutor,
} from "../indicators/indicatorComputeController.js";
import type { IndicatorRuntime } from "../indicators/indicatorRuntimeContract.js";
import {
  useProvidedBarsIndicatorRuntime,
} from "../indicators/useProvidedBarsIndicatorRuntime.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { computeLocalIndicatorBatch } from "./localDataApi.js";
import type { LocalIndicatorComputeJob } from "./localDataApi.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


export interface UseLocalIndicatorRuntimeOptions {
  manifest: LocalDatasetManifest;
  bars: KlineBar[];
  chartDataMeta: ChartDataCommitMeta;
  seriesVersion: number;
  candleUpColor: string;
  candleDownColor: string;
}

/**
 * Adapts immutable dataset compute to the shared explicit-bars indicator
 * product runtime. The browser-owned bars drive lifecycle/rendering only;
 * the backend reopens the named dataEpoch and never accepts those bars.
 */
export function useLocalIndicatorRuntime({
  manifest,
  bars,
  chartDataMeta,
  seriesVersion,
  candleUpColor,
  candleDownColor,
}: UseLocalIndicatorRuntimeOptions): IndicatorRuntime {
  const persistence = useMemo(() => createActiveIndicatorPersistence(
    `candlescope:local-indicators:v1:${manifest.dataset_id}:${manifest.data_epoch}`,
  ), [manifest.data_epoch, manifest.dataset_id]);
  const computeBatch = useCallback<IndicatorComputeBatchExecutor>(async ({
    jobs,
    signal,
  }) => {
    const requests: LocalIndicatorComputeJob[] = jobs.map((job) => {
      const name = job.request.name;
      if (job.request.mode !== "builtin" || typeof name !== "string" || !name.trim()) {
        throw new Error("离线 profile 只允许共享目录中的内置指标");
      }
      return {
        clientId: job.clientId,
        jobKey: job.jobKey,
        name,
        params: job.request.params ?? {},
      };
    });
    return computeLocalIndicatorBatch(manifest, requests, signal);
  }, [manifest]);
  const latestTime = bars.at(-1)?.time ?? null;

  return useProvidedBarsIndicatorRuntime({
    bars,
    candleDownColor,
    candleUpColor,
    computeBatch,
    chartDataMeta,
    datasetKey: `local:${manifest.dataset_id}:${manifest.data_epoch}`,
    exchange: "local",
    interval: manifest.interval,
    marketType: manifest.dataset_id,
    persistence,
    seriesReady: seriesVersion,
    sourceOrdinal: seriesVersion,
    sourceScopeKey: `${manifest.dataset_id}:${manifest.data_epoch}`,
    symbol: manifest.symbol,
    visibleThroughSeconds: latestTime,
  });
}
