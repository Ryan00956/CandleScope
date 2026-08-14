import { useMemo } from "react";
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

function markerSource(
  chart: BacktestChartData,
  store: SeriesWindowStore,
): ExternalMarkerSource {
  let cachedAxisRevision = -1;
  let revision = 0;
  let cached: readonly ExternalSeriesMarker[] = [];
  return {
    getSnapshot() {
      const axisRevision = Number(store.axisRevision);
      if (axisRevision !== cachedAxisRevision) {
        cachedAxisRevision = axisRevision;
        const fillMarkers = chart.fills.flatMap((fill, index) => {
          const eventTimeMs = Number(fill.event_time_ms);
          const displayTime = floorIntervalTime(chart.interval, eventTimeMs / 1000);
          if (displayTime === null || !store.hasTime(displayTime)) return [];
          const side = String(fill.side || "").toUpperCase();
          const action = String(fill.action || side);
          const actionLabel: Record<string, string> = {
            OPEN_LONG: "开多",
            CLOSE_LONG: "平多",
            OPEN_SHORT: "开空",
            CLOSE_SHORT: "平空",
            ADD_LONG: "加多",
            ADD_SHORT: "加空",
            REDUCE_LONG: "减多",
            REDUCE_SHORT: "减空",
            REVERSE_TO_LONG: "反手多",
            REVERSE_TO_SHORT: "反手空",
          };
          return [{
            id: `backtest:${String(fill.order_id || index)}:${index}`,
            time: displayTime,
            position: side === "BUY" ? "belowBar" : "aboveBar",
            color: side === "BUY" ? "#22c55e" : "#ef4444",
            shape: side === "BUY" ? "arrowUp" : "arrowDown",
            text: `${actionLabel[action] ?? action} ${String(fill.price || "")}`,
            size: 1.2,
          } satisfies ExternalSeriesMarker];
        });
        const rejectionMarkers = (chart.rejected_orders ?? []).flatMap((rejection, index) => {
          const eventTimeMs = Number(rejection.event_time_ms);
          const displayTime = floorIntervalTime(chart.interval, eventTimeMs / 1000);
          if (displayTime === null || !store.hasTime(displayTime)) return [];
          return [{
            id: `backtest:rejected:${String(rejection.sequence ?? index)}:${index}`,
            time: displayTime,
            position: "aboveBar",
            color: "#f59e0b",
            shape: "square",
            // Keep dense rejection periods legible on the K-line. The adjacent
            // rejection table owns the full reason code and input snapshot.
            text: "拒",
            size: 1,
          } satisfies ExternalSeriesMarker];
        });
        cached = [...fillMarkers, ...rejectionMarkers];
        revision += 1;
      }
      return { markers: cached, revision };
    },
    subscribe(listener) {
      return store.subscribe(listener);
    },
  };
}

export function EquityCurve({
  data,
  drawdown = [],
}: {
  data: BacktestChartData["equity_curve"];
  drawdown?: Array<Record<string, string | number>> | undefined;
}) {
  const points = useMemo(() => {
    const values = data
      .map((item) => Number(item.equity))
      .filter((value) => Number.isFinite(value));
    if (values.length < 2) return "";
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = Math.max(high - low, Math.abs(high) * 0.0001, 1);
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * 1000;
      const y = 190 - ((value - low) / span) * 170;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }, [data]);
  const drawdownPoints = useMemo(() => {
    const values = drawdown.map((item) => Number(item.drawdown));
    if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return "";
    const low = Math.min(...values, -0.000001);
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * 1000;
      const y = 105 + (Math.abs(value) / Math.abs(low)) * 85;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }, [drawdown]);
  if (!points) return <p className="backtest-empty">权益曲线数据不足。</p>;
  return (
    <svg className="backtest-equity-svg" viewBox="0 0 1000 210" preserveAspectRatio="none" aria-label="账户资金曲线">
      <defs>
        <linearGradient id="backtest-equity-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.35" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,210 ${points} 1000,210`} fill="url(#backtest-equity-fill)" stroke="none" />
      <polyline points={points} fill="none" stroke="#22d3ee" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      {drawdownPoints && <polyline points={drawdownPoints} fill="none" stroke="#f97316" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
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
      {chart.truncated && <span className="backtest-chart-warning">图表只显示最后 50,000 根 K 线。</span>}
    </div>
  );
}
