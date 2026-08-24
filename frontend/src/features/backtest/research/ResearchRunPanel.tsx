import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchRunPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { activeRun, runs } = runtime.view;
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.run")} title={activeRun?.run_id ?? t("research.run.none")}>
      {activeRun && (
        <div className="research-active-run">
          <span data-state={activeRun.state}>{activeRun.state}</span>
          <small>{activeRun.fidelity_mode}</small>
        </div>
      )}
      <div className="research-run-list">
        {runs.slice(0, 12).map((run) => (
          <button
            type="button"
            key={run.run_id}
            data-active={run.run_id === activeRun?.run_id}
            onClick={() => void runtime.actions.openRun(run.run_id)}
          >
            <span><strong>{run.run_id}</strong><small>{run.fidelity_mode}</small></span>
            <span>{run.state}</span>
          </button>
        ))}
      </div>
    </ResearchPanelFrame>
  );
}
