import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchExecutionPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { advancedEnabled, selectedTask, activeRun, launchContext, runDraftText, busy } = runtime.view;
  const copy = selectedTask === "PRECISE_EXECUTION"
    ? t("research.execution.precise")
    : selectedTask === "PYTHON_MODEL"
      ? t("research.execution.python")
      : t("research.execution.general");
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.execution")} title={activeRun?.fidelity_mode ?? "BAR_APPROX"}>
      <p className="research-panel-copy">{copy}</p>
      <dl className="research-facts">
        <div><dt>{t("research.execution.preset")}</dt><dd>{launchContext?.quick_preset_id ?? "—"}</dd></div>
        <div><dt>{t("research.execution.state")}</dt><dd>{activeRun?.state ?? "DRAFT"}</dd></div>
        <div><dt>{t("research.execution.configHash")}</dt><dd title={activeRun?.config_hash}>{activeRun?.config_hash?.slice(0, 16) ?? "—"}</dd></div>
      </dl>
      {advancedEnabled && (
        <details open className="research-advanced-details research-execution-draft">
          <summary>{t("research.execution.draft")}</summary>
          <p className="research-panel-copy">{t("research.execution.authority")}</p>
          <textarea
            aria-label={t("research.execution.configAria")}
            rows={18}
            spellCheck={false}
            value={runDraftText}
            onChange={(event) => runtime.actions.setRunDraftText(event.target.value)}
          />
          <div className="research-button-row">
            <button type="button" disabled={busy} onClick={runtime.actions.resetRunDraft}>{t("research.execution.reset")}</button>
            <button type="button" disabled={busy || !runtime.view.snapshot || !runtime.view.selectedRevisionId} onClick={() => void runtime.actions.createRun()}>{t("research.execution.create")}</button>
          </div>
        </details>
      )}
    </ResearchPanelFrame>
  );
}
