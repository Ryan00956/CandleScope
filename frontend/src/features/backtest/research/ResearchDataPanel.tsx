import { t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchDataPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { datasets, launchContext } = runtime.view;
  const identity = launchContext?.dataset_identity ?? null;
  return (
    <ResearchPanelFrame eyebrow={t("research.panel.data")} title={identity?.dataset_id ?? t("research.data.noContext")}>
      {identity ? (
        <dl className="research-facts">
          <div><dt>Data epoch</dt><dd title={identity.data_epoch}>{identity.data_epoch.slice(0, 18)}…</dd></div>
          <div><dt>Snapshot</dt><dd title={identity.snapshot_hash}>{identity.snapshot_hash.slice(0, 18)}…</dd></div>
        </dl>
      ) : <p className="research-empty">{t("research.data.noContext")}</p>}
      <details>
        <summary>{t("research.data.available")} · {datasets.length}</summary>
        <div className="research-compact-list">
          {datasets.slice(0, 10).map((dataset) => (
            <span key={`${dataset.dataset_id}:${dataset.data_epoch}`}>
              <strong>{dataset.name}</strong><small>{dataset.symbol} · {dataset.interval} · {dataset.rows}</small>
            </span>
          ))}
        </div>
      </details>
    </ResearchPanelFrame>
  );
}
