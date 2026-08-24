import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchExecutionPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { selectedTask, activeRun, launchContext } = runtime.view;
  const copy = selectedTask === "PRECISE_EXECUTION"
    ? t("research.execution.precise")
    : selectedTask === "PYTHON_MODEL"
      ? t("research.execution.python")
      : t("research.execution.general");
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.execution")} title={activeRun?.fidelity_mode ?? "BAR_APPROX"}>
      <p className="research-panel-copy">{copy}</p>
      <dl className="research-facts">
        <div><dt>Preset</dt><dd>{launchContext?.quick_preset_id ?? "—"}</dd></div>
        <div><dt>State</dt><dd>{activeRun?.state ?? "DRAFT"}</dd></div>
        <div><dt>Config hash</dt><dd title={activeRun?.config_hash}>{activeRun?.config_hash?.slice(0, 16) ?? "—"}</dd></div>
      </dl>
    </ResearchPanelFrame>
  );
}
