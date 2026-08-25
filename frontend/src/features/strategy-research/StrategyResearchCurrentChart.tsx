import { t } from "../../i18n/index.js";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";

export function currentChartSource(): Extract<ResearchSourceRefV1, { kind: "CURRENT_CHART" }> {
  return {
    schemaVersion: "candlescope.research-source/1",
    kind: "CURRENT_CHART",
    workspaceId: "current",
    cellId: "current",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  };
}

export function StrategyResearchCurrentChart({ session }: { session: ChartSession }) {
  return (
    <section
      className="strategy-research-current-chart"
      data-testid="strategy-research-current-chart"
      data-symbol={session.symbol}
      data-interval={session.interval}
      data-exchange={session.exchange}
    >
      <header>
        <strong>{session.symbol}</strong>
        <span>{session.exchange} · {session.marketType} · {session.interval}</span>
      </header>
      <p>{t("strategy.chartSlot")}</p>
    </section>
  );
}
