import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchResultsPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { report, activeRun } = runtime.view;
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.results")} title={report?.report_label ?? t("research.results.empty")} className="research-results-panel">
      {report ? (
        <div className="research-result-metrics">
          <div><span>{t("research.results.netPnl")}</span><strong>{report.metrics.realized_net_pnl}</strong></div>
          <div><span>{t("research.results.trades")}</span><strong>{report.metrics.trade_count}</strong></div>
          <div><span>{t("research.results.winRate")}</span><strong>{report.metrics.win_rate}</strong></div>
          <div><span>{t("research.results.fidelity")}</span><strong>{activeRun?.fidelity_mode ?? report.fidelity_mode}</strong></div>
        </div>
      ) : <p className="research-empty">{t("research.results.empty")}</p>}
    </ResearchPanelFrame>
  );
}
