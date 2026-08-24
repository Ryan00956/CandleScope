import { useMemo } from "react";
import { t } from "../../i18n/index.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import type {
  ExternalMarkerSource,
  ExternalSeriesMarker,
} from "../../chart-adapter/externalMarkerSource.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { floorIntervalTime } from "../../utils/intervalTimeline.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { BacktestChartData } from "./backtestTypes.js";
import {
  projectBacktestResultMarkers,
} from "./chart-tester/chartStrategyResultProjection.js";
export { default as EquityCurve } from "./BacktestEquityCurve.js";

function markerSource(
  chart: BacktestChartData,
  store: SeriesWindowStore,
): ExternalMarkerSource {
  const labels = {
    actions: {
      OPEN_LONG: t("backtest.openLong"),
      CLOSE_LONG: t("backtest.closeLong"),
      OPEN_SHORT: t("backtest.openShort"),
      CLOSE_SHORT: t("backtest.closeShort"),
      ADD_LONG: t("backtest.addLong"),
      ADD_SHORT: t("backtest.addShort"),
      REDUCE_LONG: t("backtest.reduceLong"),
      REDUCE_SHORT: t("backtest.reduceShort"),
      REVERSE_TO_LONG: t("backtest.reverseLong"),
      REVERSE_TO_SHORT: t("backtest.reverseShort"),
    },
    rejection: t("backtest.reject"),
  };
  let cachedAxisRevision = -1;
  let revision = 0;
  let cached: readonly ExternalSeriesMarker[] = [];
  return {
    getSnapshot() {
      const axisRevision = Number(store.axisRevision);
      if (axisRevision !== cachedAxisRevision) {
        cachedAxisRevision = axisRevision;
        cached = projectBacktestResultMarkers(chart, {
          hasTime: (time) => store.hasTime(time),
          labels,
        });
        revision += 1;
      }
      return { markers: cached, revision };
    },
    subscribe(listener) {
      return store.subscribe(listener);
    },
  };
}

export default function BacktestResultChart({ chart, focusTimeMs }: { chart: BacktestChartData; focusTimeMs?: number | null }) {
  const store = useMemo(() => {
    const next = new SeriesWindowStore({
      maxBars: 50_000,
      intervalSeconds: parseIntervalSeconds(chart.interval),
      seriesKey: `backtest:${chart.run_id}`,
    });
    // Populate before the chart mounts so its one-shot initial viewport restore
    // can fit short backtest windows instead of inheriting an empty-axis range.
    next.replace(chart.bars as KlineBar[], { source: "backtest_result" });
    return next;
  }, [chart.bars, chart.interval, chart.run_id]);
  const markers = useMemo(() => markerSource(chart, store), [chart, store]);
  const initialRange = useMemo(() => {
    const focused = focusTimeMs == null ? null : floorIntervalTime(chart.interval, focusTimeMs / 1000);
    const rightmostTime = focused ?? chart.bars.at(-1)?.time;
    return {
      barSpacing: Math.max(4, Math.min(40, 1_000 / Math.max(24, chart.bars.length))),
      rightOffset: 2,
      ...(rightmostTime === undefined ? {} : { rightmostTime }),
    };
  }, [chart.bars, chart.interval, focusTimeMs]);

  return (
    <div className="backtest-result-chart">
      <SingleChartPanes
        seriesStore={store}
        symbol={chart.symbol}
        interval={chart.interval}
        datasetKey={`backtest:${chart.run_id}`}
        upColor="#22c55e"
        downColor="#ef4444"
        theme="dark"
        customBg="#0b1220"
        externalMarkerSource={markers}
        savedVisibleRange={initialRange}
        canLoadMoreLeft={false}
        followLatest={false}
      />
      {chart.truncated && <span className="backtest-chart-warning">{t("backtest.chartTruncated")}</span>}
    </div>
  );
}
