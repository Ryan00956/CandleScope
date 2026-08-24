import { t } from "../../../i18n/index.js";
import { researchStudyIsActive } from "./backtestResearchAdvancedModel.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchStudyPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { advancedEnabled, activeStudy, studies, studyDraftText, studyComparison, busy, revisions, selectedRevisionId } = runtime.view;
  const holdoutCanReveal = activeStudy?.state === "AWAITING_HOLDOUT" && activeStudy.holdout?.state === "SEALED";
  const selectedRevision = revisions.find((revision) => revision.revision_id === selectedRevisionId);
  const studyCompatible = selectedRevision?.output_modes.includes("SIGNAL") === true;
  const contractReady = (runtime.view.snapshot?.quality.contract_data as Record<string, unknown> | undefined)?.status === "complete";
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.study")} title={activeStudy?.name ?? t("research.study.none")} className="research-study-panel">
      <p className="research-panel-copy">{t("research.study.draftHint")}</p>
      {advancedEnabled && (
        <>
          <details open className="research-advanced-details">
            <summary>{t("research.study.draftSummary")}</summary>
            {!studyCompatible && <p className="research-operation-message error">{t("research.study.incompatible")}</p>}
            {studyCompatible && !contractReady && <p className="research-operation-message error">{t("research.study.dataIncompatible")}</p>}
            <textarea aria-label={t("research.study.draftAria")} rows={16} spellCheck={false} value={studyDraftText} onChange={(event) => runtime.actions.setStudyDraftText(event.target.value)} />
            <div className="research-button-row">
              <button type="button" disabled={busy} onClick={runtime.actions.resetStudyDraft}>{t("research.study.reset")}</button>
              <button type="button" disabled={busy || !runtime.view.snapshot || !runtime.view.selectedRevisionId || !studyCompatible || !contractReady} onClick={() => void runtime.actions.createStudy()}>{t("research.study.create")}</button>
            </div>
          </details>
          <div className="research-button-row">
            <button type="button" disabled={busy || activeStudy?.state !== "CREATED" || !contractReady} onClick={() => void runtime.actions.startStudy()}>{t("research.study.start")}</button>
            <button type="button" disabled={busy || !activeStudy || !researchStudyIsActive(activeStudy.state)} onClick={() => void runtime.actions.cancelStudy()}>{t("research.study.cancel")}</button>
            <button type="button" disabled={busy || !holdoutCanReveal} onClick={() => void runtime.actions.revealStudyHoldout()}>{t("research.study.reveal")}</button>
            <button type="button" disabled={busy || !activeStudy} onClick={() => void runtime.actions.compareStudy()}>{t("research.study.compare")}</button>
          </div>
        </>
      )}
      <div className="research-run-list">
        {studies.slice(0, 20).map((study) => (
          <button
            type="button"
            key={study.study_id}
            data-active={study.study_id === activeStudy?.study_id}
            onClick={() => void runtime.actions.openStudy(study.study_id)}
          >
            <span><strong>{study.name}</strong><small>{study.study_id}</small></span>
            <span>{study.state}</span>
          </button>
        ))}
      </div>
      {activeStudy && (
        <details className="research-advanced-details">
          <summary>{t("research.study.authority")}</summary>
          <pre className="research-json-readout">{JSON.stringify({
            protocol: activeStudy.study_protocol_revision,
            identity: activeStudy.identity,
            holdout: activeStudy.holdout,
            folds: activeStudy.folds,
            oos_report: activeStudy.oos_report,
            dataset_basket: activeStudy.dataset_basket,
          }, null, 2)}</pre>
        </details>
      )}
      {studyComparison && (
        <details open className="research-advanced-details">
          <summary>{t("research.study.oos", { count: studyComparison.completed_trial_count })}</summary>
          <pre className="research-json-readout">{JSON.stringify({
            ready: studyComparison.ready,
            selection_warning: studyComparison.selection_warning,
            ranking: studyComparison.ranking,
            independent_symbol_robustness: studyComparison.independent_symbol_robustness,
            portfolio_sum_forbidden: studyComparison.portfolio_sum_forbidden,
          }, null, 2)}</pre>
        </details>
      )}
    </ResearchPanelFrame>
  );
}
