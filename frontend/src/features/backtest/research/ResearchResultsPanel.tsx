import { useState } from "react";
import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

type ResultTab = "SUMMARY" | "TRADES" | "TRACE" | "COMPARE" | "QUALITY";

export default function ResearchResultsPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { advancedEnabled, report, activeRun, chart, runComparison, signalTrace, busy } = runtime.view;
  const [tab, setTab] = useState<ResultTab>("SUMMARY");
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.results")} title={report?.report_label ?? t("research.results.empty")} className="research-results-panel">
      {report ? (
        <>
          <div className="research-result-metrics">
            <div><span>{t("research.results.netPnl")}</span><strong>{report.metrics.realized_net_pnl}</strong></div>
            <div><span>{t("research.results.trades")}</span><strong>{report.metrics.trade_count}</strong></div>
            <div><span>{t("research.results.winRate")}</span><strong>{report.metrics.win_rate}</strong></div>
            <div><span>{t("research.results.fidelity")}</span><strong>{activeRun?.fidelity_mode ?? report.fidelity_mode}</strong></div>
          </div>
          {advancedEnabled && (
            <>
              <nav className="research-result-tabs" aria-label={t("research.aria.resultDetails")}>
                {(["SUMMARY", "TRADES", "TRACE", "COMPARE", "QUALITY"] as const).map((item) => <button type="button" key={item} data-active={tab === item} onClick={() => setTab(item)}>{item}</button>)}
              </nav>
              <div className="research-result-detail" data-result-tab={tab}>
                {tab === "SUMMARY" && <pre>{JSON.stringify({
                  credibility: report.credibility,
                  identity: report.identity,
                  account: report.account,
                  risk_policy: report.risk_policy,
                  execution_assumptions: report.execution_assumptions,
                  hashes: report.hashes,
                  equity_points: chart?.equity_curve.length ?? report.equity_curve?.length ?? 0,
                }, null, 2)}</pre>}
                {tab === "TRADES" && (
                  <div className="research-trade-table-wrap"><table><thead><tr><th>{t("research.results.trade")}</th><th>{t("research.results.side")}</th><th>{t("research.results.entry")}</th><th>{t("research.results.exit")}</th><th>{t("research.results.netPnl")}</th></tr></thead><tbody>{report.trades.slice(0, 500).map((trade, index) => <tr key={String(trade.trade_id ?? index)}><td>{String(trade.trade_id ?? index + 1)}</td><td>{String(trade.side ?? "—")}</td><td>{String(trade.entry_time_ms ?? "—")}</td><td>{String(trade.exit_time_ms ?? "—")}</td><td>{String(trade.net_pnl ?? "—")}</td></tr>)}</tbody></table></div>
                )}
                {tab === "TRACE" && <>
                  <button type="button" disabled={busy} onClick={() => void runtime.actions.loadSignalTrace()}>{t("research.results.trace")}</button>
                  <pre>{JSON.stringify(signalTrace.slice(0, 1_000), null, 2)}</pre>
                </>}
                {tab === "COMPARE" && <pre>{JSON.stringify(runComparison ?? { message: t("research.results.compareEmpty") }, null, 2)}</pre>}
                {tab === "QUALITY" && <pre>{JSON.stringify({
                  data_quality: report.data_quality,
                  quality: report.performance?.quality,
                  reconciliation: report.performance?.reconciliation,
                  fill_model: report.fill_model,
                  fill_trace: report.fill_trace,
                  unmodeled: report.unmodeled,
                  suitable_for: report.suitable_for,
                  not_suitable_for: report.not_suitable_for,
                }, null, 2)}</pre>}
              </div>
            </>
          )}
        </>
      ) : <p className="research-empty">{t("research.results.empty")}</p>}
    </ResearchPanelFrame>
  );
}
