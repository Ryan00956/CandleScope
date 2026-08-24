import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchStudyPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { activeStudy, studies } = runtime.view;
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.study")} title={activeStudy?.name ?? t("research.study.none")}>
      <p className="research-panel-copy">{t("research.study.draftHint")}</p>
      <div className="research-run-list">
        {studies.slice(0, 12).map((study) => (
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
    </ResearchPanelFrame>
  );
}
