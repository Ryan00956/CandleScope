import { useMemo, useState } from "react";
import { t } from "../../../i18n/index.js";
import { parseResearchRunConfig, researchRunIsActive } from "./backtestResearchAdvancedModel.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchRunPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { advancedEnabled, activeRun, runs, busy } = runtime.view;
  const [compareRunId, setCompareRunId] = useState("");
  const [cloneParameter, setCloneParameter] = useState("");
  const [cloneValue, setCloneValue] = useState("25");
  const compareOptions = useMemo(
    () => runs.filter((run) => run.run_id !== activeRun?.run_id && run.state === "COMPLETED"),
    [activeRun?.run_id, runs],
  );
  const cloneParameters = useMemo(
    () => {
      const parameters = parseResearchRunConfig(activeRun).parameters;
      return parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? Object.keys(parameters).sort()
        : [];
    },
    [activeRun],
  );
  const selectedCloneParameter = cloneParameters.includes(cloneParameter)
    ? cloneParameter
    : cloneParameters[0] ?? "";
  const parseCloneValue = () => Number.isFinite(Number(cloneValue)) ? Number(cloneValue) : cloneValue;
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.run")} title={activeRun?.run_id ?? t("research.run.none")}>
      {activeRun && (
        <div className="research-active-run">
          <span data-state={activeRun.state}>{activeRun.state}</span>
          <small>{activeRun.fidelity_mode}</small>
        </div>
      )}
      {advancedEnabled && (
        <>
          <div className="research-button-row">
            <button type="button" disabled={busy || !activeRun || !researchRunIsActive(activeRun)} onClick={() => void runtime.actions.cancelRun()}>{t("research.run.cancel")}</button>
            <button type="button" disabled={busy || !activeRun} onClick={() => void runtime.actions.resumeRun()}>{t("research.run.resume")}</button>
            <button type="button" disabled={busy || !activeRun} onClick={() => void runtime.actions.exportRun()}>{t("research.run.export")}</button>
          </div>
          <details className="research-advanced-details">
            <summary>{t("research.run.cloneSummary")}</summary>
            {cloneParameters.length > 0 ? <label className="research-field"><span>{t("research.run.parameter")}</span><select value={selectedCloneParameter} onChange={(event) => setCloneParameter(event.target.value)}>{cloneParameters.map((parameter) => <option value={parameter} key={parameter}>{parameter}</option>)}</select></label> : <p className="research-empty">{t("research.run.noCloneParameters")}</p>}
            <label className="research-field"><span>{t("research.run.value")}</span><input value={cloneValue} onChange={(event) => setCloneValue(event.target.value)} /></label>
            <button type="button" disabled={busy || !activeRun || !selectedCloneParameter} onClick={() => void runtime.actions.cloneRun(selectedCloneParameter, parseCloneValue())}>{t("research.run.clone")}</button>
          </details>
          <details className="research-advanced-details">
            <summary>{t("research.run.compareSummary")}</summary>
            <label className="research-field"><span>{t("research.run.baseline")}</span><select aria-label={t("research.run.baseline")} value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}><option value="">{t("research.run.select")}</option>{compareOptions.map((run) => <option value={run.run_id} key={run.run_id}>{run.run_id}</option>)}</select></label>
            <button type="button" disabled={busy || !activeRun || !compareRunId} onClick={() => void runtime.actions.compareRun(compareRunId)}>{t("research.run.compare")}</button>
          </details>
        </>
      )}
      <div className="research-run-list">
        {runs.slice(0, 20).map((run) => (
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
