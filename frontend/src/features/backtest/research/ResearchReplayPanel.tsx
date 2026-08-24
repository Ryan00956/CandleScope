import { t } from "../../../i18n/index.js";
import { researchReplayHref } from "./backtestResearchAdvancedModel.js";
import type { BacktestResearchRuntime } from "./backtestResearchTypes.js";
import ResearchPanelFrame from "./ResearchPanelFrame.js";

export default function ResearchReplayPanel({ runtime }: { runtime: BacktestResearchRuntime }) {
  const { advancedEnabled, activeRun, reviewBridge, capabilities, busy, startTimeMs, endTimeMs } = runtime.view;
  const bridgeEnabled = capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED === true;
  const replayTrainingAvailable = capabilities?.flags.BACKTEST_REPLAY_TRAINING_AVAILABLE === true;
  const replayEnabled = bridgeEnabled && replayTrainingAvailable;
  const href = researchReplayHref(reviewBridge);
  const bridgeState = typeof reviewBridge?.state === "string" ? reviewBridge.state : null;
  return (
    <ResearchPanelFrame eyebrow={t("research.replay.eyebrow")} title={typeof reviewBridge?.bridgeId === "string" ? reviewBridge.bridgeId : t("research.replay.none")} className="research-replay-panel">
      <p className="research-panel-copy">{t("research.replay.copy")}</p>
      <dl className="research-facts">
        <div><dt>{t("research.replay.sourceRun")}</dt><dd>{activeRun?.run_id ?? "—"}</dd></div>
        <div><dt>{t("research.replay.window")}</dt><dd>{startTimeMs} → {endTimeMs}</dd></div>
        <div><dt>{t("research.replay.flag")}</dt><dd>{bridgeEnabled ? "ON" : "OFF"}</dd></div>
        <div><dt>{t("research.replay.runtime")}</dt><dd>{replayTrainingAvailable ? "AVAILABLE" : "UNAVAILABLE"}</dd></div>
        <div><dt>{t("research.replay.state")}</dt><dd>{bridgeState ?? "—"}</dd></div>
      </dl>
      {advancedEnabled && (
        <div className="research-button-row">
          <button type="button" disabled={busy || !replayEnabled || activeRun?.state !== "COMPLETED"} onClick={() => void runtime.actions.createReviewBridge()}>{t("research.replay.create")}</button>
          <button type="button" disabled={busy || bridgeState !== "BLINDED"} onClick={() => void runtime.actions.revealReviewBridge()}>{t("research.replay.reveal")}</button>
        </div>
      )}
      {href && <a className="research-replay-link" href={href} target="_blank" rel="noreferrer">{t("research.replay.open")}</a>}
      {reviewBridge && <pre className="research-json-readout">{JSON.stringify({
        bridgeId: reviewBridge.bridgeId,
        trainingRunId: reviewBridge.trainingRunId ?? (reviewBridge.trainingRun as Record<string, unknown> | undefined)?.run_id,
        state: reviewBridge.state,
        isolation: reviewBridge.isolation,
        strategyProjection: reviewBridge.strategyProjection,
        comparison: reviewBridge.comparison,
      }, null, 2)}</pre>}
    </ResearchPanelFrame>
  );
}
