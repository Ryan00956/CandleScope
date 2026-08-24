import { lazy, Suspense, useMemo, useState } from "react";
import { t } from "../../../i18n/index.js";
import { defaultBacktestApi } from "../backtestApi.js";
import { isPythonStrategyEntryEnabled } from "../backtestFlags.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

const PythonStudioPanel = lazy(() => import("../PythonStudioPanel.js"));

function schemaParameters(runtime: BacktestResearchRuntime): Record<string, string | number | boolean> {
  const revision = runtime.view.revisions.find((item) => item.revision_id === runtime.view.selectedRevisionId);
  const values: Record<string, string | number | boolean> = {};
  for (const field of revision?.parameter_schema ?? []) {
    const name = typeof field.name === "string" ? field.name : "";
    const value = field.default;
    if (name && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      values[name] = value;
    }
  }
  return { ...values, ...(runtime.view.launchContext?.parameters ?? {}) } as Record<string, string | number | boolean>;
}

export default function ResearchStrategyPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const {
    advancedEnabled,
    draft,
    revisions,
    selectedRevisionId,
    selectedTask,
    snapshot,
    selectedDatasetId,
    startTimeMs,
    endTimeMs,
    busy,
  } = runtime.view;
  const [revisionName, setRevisionName] = useState("Research revision");
  const [revisionLanguage, setRevisionLanguage] = useState("BUILTIN_TEMPLATE");
  const [revisionSource, setRevisionSource] = useState("");
  const parameters = useMemo(() => schemaParameters(runtime), [runtime]);
  const pythonEnabled = isPythonStrategyEntryEnabled();
  return (
    <ResearchPanelFrame
      eyebrow={t("research.panel.strategy")}
      title={draft?.displayName ?? selectedRevisionId ?? t("research.strategy.noDraft")}
      className="research-strategy-panel"
    >
      {draft && (
        <dl className="research-facts">
          <div><dt>{t("research.strategy.draft")}</dt><dd>{draft.id}</dd></div>
          <div><dt>{t("research.strategy.language")}</dt><dd>{draft.language}</dd></div>
          <div><dt>{t("research.strategy.parameters")}</dt><dd>{Object.keys(runtime.view.launchContext?.parameters ?? {}).length}</dd></div>
        </dl>
      )}
      {advancedEnabled ? (
        <>
          <label className="research-field">
            <span>{t("research.strategy.revision")}</span>
            <select value={selectedRevisionId} onChange={(event) => runtime.actions.selectRevision(event.target.value)}>
              {revisions.map((revision) => <option key={revision.revision_id} value={revision.revision_id}>{revision.label}</option>)}
            </select>
          </label>
          <div className="research-button-row">
            <button type="button" disabled={busy || !snapshot} onClick={() => void runtime.actions.smokeStrategyRevision()}>{t("research.strategy.smoke")}</button>
            <button type="button" disabled={busy || !selectedRevisionId} onClick={() => void runtime.actions.copyStrategyRevision()}>{t("research.strategy.copy")}</button>
            <button type="button" disabled={busy || !selectedRevisionId} onClick={() => void runtime.actions.archiveStrategyRevision()}>{t("research.strategy.archive")}</button>
          </div>
          <details className="research-advanced-details">
            <summary>{t("research.strategy.create")}</summary>
            <label className="research-field"><span>{t("research.strategy.name")}</span><input value={revisionName} onChange={(event) => setRevisionName(event.target.value)} /></label>
            <label className="research-field"><span>{t("research.strategy.language")}</span><select value={revisionLanguage} onChange={(event) => setRevisionLanguage(event.target.value)}><option value="BUILTIN_TEMPLATE">{t("research.strategy.template")}</option><option value="PYNE">{t("research.strategy.pyne")}</option><option value="PINE">{t("research.strategy.pine")}</option></select></label>
            <label className="research-field"><span>{t("research.strategy.source")}</span><textarea rows={6} value={revisionSource} onChange={(event) => setRevisionSource(event.target.value)} /></label>
            <button type="button" disabled={busy || !revisionName.trim()} onClick={() => void runtime.actions.createStrategyRevision({
              name: revisionName,
              language: revisionLanguage,
              base_revision_id: revisionLanguage === "BUILTIN_TEMPLATE" ? "builtin-rsi-wilder-long-short-v1" : null,
              source_text: revisionSource,
              parameter_schema: revisionLanguage === "BUILTIN_TEMPLATE" ? [
                { name: "length", type: "integer", default: 24, minimum: 2 },
                { name: "oversold", type: "number", default: 30 },
                { name: "overbought", type: "number", default: 70 },
              ] : [],
            })}>{t("research.strategy.compile")}</button>
          </details>
          {selectedTask === "PYTHON_MODEL" && (
            <details open className="research-python-studio">
              <summary>{t("research.strategy.pythonTitle")}</summary>
              {pythonEnabled ? (
                <Suspense fallback={<p className="research-empty">{t("research.strategy.pythonLoading")}</p>}>
                  <PythonStudioPanel
                    api={defaultBacktestApi}
                    loading={busy}
                    snapshot={snapshot}
                    datasetId={selectedDatasetId}
                    startTimeMs={startTimeMs}
                    endTimeMs={endTimeMs}
                    schemaParameters={parameters}
                    selectedRevisionId={selectedRevisionId}
                    onLoading={runtime.actions.setBusy}
                    onNotice={runtime.actions.setNotice}
                    onError={runtime.actions.setOperationError}
                    onRevisionReady={(revision) => runtime.actions.acceptStrategyRevision(revision)}
                    onGateChange={runtime.actions.setPythonGate}
                  />
                </Suspense>
              ) : <p className="research-empty">{t("research.strategy.pythonDisabled")}</p>}
            </details>
          )}
        </>
      ) : (
        <details>
          <summary>{t("research.strategy.revisions")} · {revisions.length}</summary>
          <div className="research-compact-list">
            {revisions.slice(0, 10).map((revision) => (
              <span key={revision.revision_id} data-active={revision.revision_id === selectedRevisionId}>
                <strong>{revision.label}</strong><small>{revision.revision_id}</small>
              </span>
            ))}
          </div>
        </details>
      )}
    </ResearchPanelFrame>
  );
}
