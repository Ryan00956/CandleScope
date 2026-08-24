import { useMemo } from "react";

import { t } from "../../i18n/index.js";
import {
  boundBacktestProjectionRows,
  projectDrawdownPolyline,
  projectEquityPolyline,
} from "./chart-tester/chartStrategyResultProjection.js";
import type { BacktestChartData } from "./backtestTypes.js";

export default function BacktestEquityCurve({
  data,
  drawdown = [],
  compact = false,
}: {
  data: BacktestChartData["equity_curve"];
  drawdown?: Array<Record<string, string | number>> | undefined;
  compact?: boolean;
}) {
  const boundedData = useMemo(() => boundBacktestProjectionRows(data), [data]);
  const boundedDrawdown = useMemo(() => boundBacktestProjectionRows(drawdown), [drawdown]);
  const points = useMemo(() => projectEquityPolyline(boundedData), [boundedData]);
  const drawdownPoints = useMemo(
    () => projectDrawdownPolyline(boundedDrawdown),
    [boundedDrawdown],
  );
  if (!points) return <p className="backtest-empty">{t("backtest.equityEmpty")}</p>;
  return (
    <svg
      className={compact ? "backtest-equity-svg compact" : "backtest-equity-svg"}
      viewBox="0 0 1000 210"
      preserveAspectRatio="none"
      aria-label={t("backtest.equityAria")}
    >
      <defs>
        <linearGradient id={compact ? "chart-strategy-equity-fill" : "backtest-equity-fill"} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.35" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,210 ${points} 1000,210`}
        fill={`url(#${compact ? "chart-strategy-equity-fill" : "backtest-equity-fill"})`}
        stroke="none"
      />
      <polyline points={points} fill="none" stroke="#22d3ee" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      {drawdownPoints && <polyline points={drawdownPoints} fill="none" stroke="#f97316" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
