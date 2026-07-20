import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { CommitChartData } from "./klineContracts.js";
import type { EpochSeconds, KlineBar } from "./marketDataTypes.js";
import type { SeriesDataFeed } from "./feed/seriesDataFeed.js";

const LOAD_MORE_PAGE_SIZE = 500;

export type LoadMoreLeft = (oldestLoadedTime?: EpochSeconds | null) => Promise<void>;

export interface UseChartLoadMoreLeftOptions {
  enabled: boolean;
  symbol: SymbolCode;
  exchange: ExchangeId;
  marketType: MarketType;
  interval: IntervalString;
  chartData: KlineBar[];
  loading: boolean;
  dataSource: string | null;
  seriesDataFeed: SeriesDataFeed;
  commitMergedChartData: CommitChartData;
}

export interface ChartLoadMoreLeftRuntime {
  loadingMoreLeft: boolean;
  setLoadingMoreLeft: Dispatch<SetStateAction<boolean>>;
  hasMoreLeft: boolean;
  setHasMoreLeft: Dispatch<SetStateAction<boolean>>;
  handleNeedMoreLeft: LoadMoreLeft;
}

export function useChartLoadMoreLeft({
  enabled,
  symbol,
  exchange,
  marketType,
  interval,
  chartData,
  loading,
  dataSource,
  seriesDataFeed,
  commitMergedChartData,
}: UseChartLoadMoreLeftOptions): ChartLoadMoreLeftRuntime {
  const [loadingMoreLeft, setLoadingMoreLeft] = useState(false);
  const [hasMoreLeft, setHasMoreLeft] = useState(true);
  const oldestChartTime = chartData[0]?.time ?? null;

  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime?: EpochSeconds | null) => {
      if (!enabled || loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") return;
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
        if (result.skipped) {
          if (result.reason === "history-exhausted") setHasMoreLeft(false);
          return;
        }
        if (result.stale || result.active === false) return;
        const older = result.data || [];

        if (older.length > 0) {
          if (!result.committed) {
            commitMergedChartData(symbol, interval, older, { source: "history-before-page" });
          }
          void seriesDataFeed.repairVisibleGaps(series, older, null, {
            source: "before-page-gap-planner",
            maxScanBars: LOAD_MORE_PAGE_SIZE + 2,
          });
        }

        if (result.pending) {
          console.log(`[LoadMoreLeft] Partial page returned for ${interval}; repair remains pending`);
        }

        if (result.pending) {
          setHasMoreLeft(true);
        } else if (typeof result.has_more === "boolean") {
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
      enabled,
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

  return {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    handleNeedMoreLeft,
  };
}
