import { getLocale, t } from "../../../i18n/index.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

function hash(value: string | null | undefined): string {
  return value ? `${value.slice(0, 18)}…` : "—";
}

export default function ResearchDataPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const {
    advancedEnabled,
    datasets,
    selectedDatasetId,
    snapshot,
    startTimeMs,
    endTimeMs,
  } = runtime.view;
  const dataset = datasets.find((item) => item.dataset_id === selectedDatasetId) ?? null;
  return (
    <ResearchPanelFrame
      eyebrow={t("research.panel.data")}
      title={dataset?.name ?? t("research.data.noContext")}
      className="research-data-panel"
    >
      {advancedEnabled ? (
        <>
          <label className="research-field">
            <span>{t("research.data.dataset")}</span>
            <select value={selectedDatasetId} onChange={(event) => runtime.actions.selectDataset(event.target.value)}>
              {datasets.map((item) => (
                <option key={`${item.dataset_id}:${item.data_epoch}`} value={item.dataset_id}>
                  {item.name} · {item.symbol} · {item.interval}
                </option>
              ))}
            </select>
          </label>
          <div className="research-range-grid">
            <label className="research-field"><span>{t("research.data.start")}</span><input type="number" value={startTimeMs} onChange={(event) => runtime.actions.setRange(Number(event.target.value), endTimeMs)} /></label>
            <label className="research-field"><span>{t("research.data.end")}</span><input type="number" value={endTimeMs} onChange={(event) => runtime.actions.setRange(startTimeMs, Number(event.target.value))} /></label>
          </div>
        </>
      ) : <p className="research-empty">{t("research.data.readOnly")}</p>}
      {dataset && (
        <dl className="research-facts">
          <div><dt>{t("research.data.rows")}</dt><dd>{dataset.rows}</dd></div>
          <div><dt>{t("research.data.epoch")}</dt><dd title={dataset.data_epoch}>{hash(dataset.data_epoch)}</dd></div>
          <div><dt>{t("research.data.coverage")}</dt><dd>{new Date(dataset.first_open_ms ?? 0).toLocaleDateString(getLocale())} → {new Date(dataset.last_close_ms ?? 0).toLocaleDateString(getLocale())}</dd></div>
        </dl>
      )}
      {snapshot ? (
        <details open className="research-advanced-details">
          <summary>{t("research.data.snapshot", { count: snapshot.row_count })}</summary>
          <dl className="research-facts">
            <div><dt>{t("research.data.hash")}</dt><dd title={snapshot.snapshot_hash}>{hash(snapshot.snapshot_hash)}</dd></div>
            <div><dt>{t("research.data.marketRows")}</dt><dd>{snapshot.market_row_count ?? snapshot.row_count}</dd></div>
            <div><dt>{t("research.data.fidelity")}</dt><dd>{snapshot.fidelity_capabilities.join(", ") || "—"}</dd></div>
          </dl>
          <pre className="research-json-readout">{JSON.stringify({
            quality: snapshot.quality,
            role_hashes: snapshot.role_hashes ?? {},
            coverage: dataset?.coverage ?? {},
            gap: dataset?.gap ?? {},
            contract_history: dataset?.contract_history ?? {},
          }, null, 2)}</pre>
        </details>
      ) : advancedEnabled ? <p className="research-empty">{t("research.data.waiting")}</p> : null}
    </ResearchPanelFrame>
  );
}
