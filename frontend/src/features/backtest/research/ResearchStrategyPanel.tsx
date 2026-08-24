import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchStrategyPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { draft, launchContext, revisions } = runtime.view;
  const activeRevision = launchContext?.strategy_revision_id ?? null;
  return (
    <ResearchPanelFrame
      eyebrow={t("research.panel.strategy")}
      title={draft?.displayName ?? activeRevision ?? t("research.strategy.noDraft")}
      className="research-strategy-panel"
    >
      {draft ? (
        <dl className="research-facts">
          <div><dt>Draft</dt><dd>{draft.id}</dd></div>
          <div><dt>Language</dt><dd>{draft.language}</dd></div>
          <div><dt>Revision</dt><dd>{activeRevision ?? "—"}</dd></div>
          <div><dt>{t("research.strategy.parameters")}</dt><dd>{Object.keys(launchContext?.parameters ?? {}).length}</dd></div>
        </dl>
      ) : <p className="research-empty">{t("research.strategy.noDraft")}</p>}
      <details>
        <summary>{t("research.strategy.revisions")} · {revisions.length}</summary>
        <div className="research-compact-list">
          {revisions.slice(0, 10).map((revision) => (
            <span key={revision.revision_id} data-active={revision.revision_id === activeRevision}>
              <strong>{revision.label}</strong><small>{revision.revision_id}</small>
            </span>
          ))}
        </div>
      </details>
    </ResearchPanelFrame>
  );
}
