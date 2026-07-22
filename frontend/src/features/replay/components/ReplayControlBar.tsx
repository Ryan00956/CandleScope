import { useState } from "react";
import { formatReplayPublicTime, replayOwnsController, replayProgress } from "../replayUiModel.js";
import type { ReplaySpeed } from "../replayTypes.js";
import type { ReplayV2Json } from "../replayV2Types.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayPhase3ControlType, ReplayViewerRuntime } from "../useReplayViewerRuntime.js";
import { parseIntervalSeconds } from "../../../utils/intervals.js";

const SPEEDS: readonly ReplaySpeed[] = [1, 5, 15, 30, 60, 120, 300, 600, "MAX"];

function fastForwardPlan(value: ReplayV2Json | undefined): {
  readonly mode: string;
  readonly explanation: string;
  readonly reasons: readonly string[];
  readonly equivalence: string;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Readonly<Record<string, ReplayV2Json>>;
  const mode = typeof plan.plan === "string"
    ? plan.plan
    : typeof plan.mode === "string" ? plan.mode : null;
  if (mode === null) return null;
  const explanation = typeof plan.explanation === "string" ? plan.explanation : "";
  const reasons = Array.isArray(plan.reason_codes)
    ? plan.reason_codes.filter((reason): reason is string => typeof reason === "string")
    : [];
  const equivalenceValue = plan.equivalence;
  const equivalenceObject = equivalenceValue !== null
    && typeof equivalenceValue === "object"
    && !Array.isArray(equivalenceValue)
    ? equivalenceValue as Readonly<Record<string, ReplayV2Json>>
    : null;
  const equivalence = typeof equivalenceObject?.status === "string"
    ? equivalenceObject.status
    : "UNKNOWN";
  return { mode, explanation, reasons, equivalence };
}

export interface ReplayControlBarProps {
  readonly runtime: ReplayRuntime;
  readonly viewer?: ReplayViewerRuntime;
  readonly publicTimeLabel?: string | undefined;
}

export default function ReplayControlBar({ runtime, viewer, publicTimeLabel }: ReplayControlBarProps) {
  const [showEnd, setShowEnd] = useState(false);
  const [openOrderDisposition, setOpenOrderDisposition] = useState<"expire" | "cancel" | "preserve">("expire");
  const [positionDisposition, setPositionDisposition] = useState<"keep" | "mark_close">("keep");
  const store = runtime.store;
  const config = store.sessionConfig;
  const tradeTape = config?.source_kind === "agg_trade";
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const pending = runtime.pendingCommand?.type ?? null;
  const phase3Pending = viewer?.controlPending?.type ?? null;
  const contractPortfolio = viewer?.marketTracks?.portfolio.schema_version === "replay.training.portfolio.v2"
    ? viewer.marketTracks.portfolio
    : null;
  const effectiveState = viewer?.marketTracks?.global_clock.state ?? store.state;
  const effectiveSpeed = viewer?.marketTracks?.global_clock.speed ?? store.speed ?? 1;
  const forkPending = runtime.forkPending;
  const multiTrackForkBlocked = (viewer?.marketTracks?.tracks.length ?? 1) > 1;
  const disabled = pending !== null || phase3Pending !== null || forkPending
    || store.connectionState !== "connected" || !ownsController
    || (viewer !== undefined && (viewer.viewerState === null || viewer.viewerPending));
  const domainProgress = replayProgress(store);
  const phase3Ratio = viewer?.progress?.ratio_ppm;
  const visiblePlan = fastForwardPlan(viewer?.progress?.plan);
  const progress = typeof phase3Ratio === "number" && Number.isSafeInteger(phase3Ratio)
    ? Math.min(1, Math.max(0, phase3Ratio / 1_000_000))
    : domainProgress;
  const baseIntervalMs = Math.max(1, (parseIntervalSeconds(config?.base_interval ?? "1m") ?? 60) * 1_000);
  const fallbackPublicTime = formatReplayPublicTime(store.virtualTimeMs, {
    blindMode: config?.blind_mode ?? true,
    originMs: store.replayStartMs,
  });
  const publicTime = publicTimeLabel ?? fallbackPublicTime;
  const command = (type: Parameters<ReplayRuntime["actions"]["submitCommand"]>[0], payload: Parameters<ReplayRuntime["actions"]["submitCommand"]>[1] = {}) => {
    void runtime.actions.submitCommand(type, payload).catch(() => undefined);
  };
  const phase3Command = (
    type: ReplayPhase3ControlType,
    payload: Readonly<Record<string, ReplayV2Json>> = {},
  ) => {
    if (viewer !== undefined) void viewer.actions.submitControl(type, payload).catch(() => undefined);
  };

  return (
    <section className="replay-control-stack" aria-label="K 线回放控制">
      {store.connectionState !== "connected" && (
        <div className="replay-recovery-banner" role="status">
          回放连接 {store.connectionState}；恢复原子 snapshot 前所有命令已禁用。
          <button type="button" onClick={() => runtime.actions.requestResync("manual recovery")}>重新同步</button>
        </div>
      )}
      {!ownsController && (
        <div className="replay-controller-banner" role="status">
          {store.controllerClientId ? "另一个页面持有控制权；当前为只读 viewer。" : "当前没有 controller lease。"}
          <button
            type="button"
            data-replay-action="takeover-controller"
            disabled={pending !== null || forkPending || store.connectionState !== "connected"}
            onClick={() => {
              if (viewer === undefined) {
                void runtime.actions.acquireController(store.controllerClientId !== null).catch(() => undefined);
                return;
              }
              if (store.controllerClientId === null) {
                phase3Command("acquire_controller", { takeover: false });
              } else {
                phase3Command("takeover_controller");
              }
            }}
          >
            {store.controllerClientId ? "接管控制权" : "获取控制权"}
          </button>
        </div>
      )}
      {(runtime.commandError || store.error) && (
        <div className="replay-command-error" role="alert" data-replay-command-error={runtime.commandError?.code ?? store.error?.code}>
          <strong>{runtime.commandError?.code ?? store.error?.code}</strong>
          <span>{runtime.commandError?.message ?? store.error?.message}</span>
          {(runtime.commandError?.details?.needs_resync === true) && <span>命令结果未知；已请求服务端原子 resync，状态收敛前不会接受下一条命令。</span>}
          {(runtime.commandError?.code === "REVISION_CONFLICT") && <span>已请求服务端原子 resync，请等待状态收敛。</span>}
          {runtime.commandRecoveryPending && (
            <button
              type="button"
              data-replay-action="reconcile-command"
              disabled={!runtime.commandRecoveryReady || runtime.commandRecoveryInFlight}
              onClick={() => void runtime.actions.retryPendingCommandRecovery().catch(() => undefined)}
            >{runtime.commandRecoveryInFlight ? "正在用同一 command_id 对账…" : "用同一 command_id 重试对账"}</button>
          )}
        </div>
      )}
      <div className="replay-control-bar">
        <button type="button" data-replay-action="end" disabled={disabled || effectiveState === "ENDED"} onClick={() => setShowEnd(true)}>结束</button>
        <button
          type="button"
          data-replay-action="fork"
          disabled={pending !== null || phase3Pending !== null || viewer?.viewerPending === true || forkPending || multiTrackForkBlocked}
          title={multiTrackForkBlocked ? "多商品存档保持 v2-only；当前不会压缩成单商品 v1 Fork" : undefined}
          onClick={() => void runtime.actions.forkSession().catch(() => undefined)}
        >Fork</button>
        {viewer === undefined ? (
          <button type="button" data-replay-action="step" disabled={disabled || store.state !== "PAUSED"} onClick={() => command("step", { count: 1 })}>
            {pending === "step" ? "单步中…" : "单步 →"}
          </button>
        ) : (<>
          <button type="button" data-replay-action="step-display" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => phase3Command("step_display", { count: 1 })}>
            {phase3Pending === "step_display" ? "展示步进中…" : `下一展示 K (${viewer.viewerState?.display_interval ?? "--"}) →`}
          </button>
          <button type="button" data-replay-action="step-base" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => phase3Command("step_base", { count: 1 })}>
            {phase3Pending === "step_base" ? "基础步进中…" : `基础 K (${config?.base_interval ?? "--"})`}
          </button>
        </>)}
        {viewer !== undefined && tradeTape && (
          <button type="button" data-replay-action="step-event" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => phase3Command("step_event", { count: 1 })}>
            {phase3Pending === "step_event" ? "成交步进中…" : "下一成交"}
          </button>
        )}
        <button
          type="button"
          data-replay-action={effectiveState === "PLAYING" ? "pause" : "play"}
          disabled={disabled || !["PAUSED", "PLAYING"].includes(effectiveState ?? "")}
          onClick={() => {
            const type = effectiveState === "PLAYING" ? "pause" : "play";
            if (viewer === undefined) command(type);
            else phase3Command(type);
          }}
        >
          {pending === "pause" || phase3Pending === "pause" ? "正在暂停…" : pending === "play" || phase3Pending === "play" ? "正在播放…" : effectiveState === "PLAYING" ? "暂停 ‖" : "播放 ▶"}
        </button>
        {viewer === undefined ? (
          <button type="button" data-replay-action="advance" disabled={disabled || store.state !== "PAUSED"} onClick={() => command("advance_by", { ms: 300_000 })}>
            {pending === "advance_by" ? "推进中…" : "前进 5m ⇥"}
          </button>
        ) : (
          <button type="button" data-replay-action="advance-by" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => phase3Command("advance_by", { ms: baseIntervalMs * 5 })}>
            {phase3Pending === "advance_by" ? "推进中…" : "前进 5 个基础 K ⇥"}
          </button>
        )}
        {viewer !== undefined && (phase3Pending === "advance_by" || phase3Pending === "advance_to") && (
          <button
            type="button"
            data-replay-action="cancel-advance"
            disabled={store.connectionState !== "connected" || !ownsController}
            onClick={() => void viewer.actions.cancelAdvance().catch(() => undefined)}
          >取消推进</button>
        )}
        <label className="replay-speed-control">
          速度
          <select
            data-replay-action="speed"
            value={String(effectiveSpeed)}
            disabled={disabled || effectiveState === "ENDED"}
            onChange={(event) => {
              const speed = event.target.value === "MAX"
                ? "MAX"
                : Number(event.target.value) as ReplaySpeed;
              if (viewer === undefined) command("set_speed", { speed });
              else phase3Command("set_speed", { speed });
            }}
          >
            {SPEEDS.map((speed) => <option key={String(speed)} value={String(speed)}>{speed === "MAX" ? "MAX" : `${speed}×`}</option>)}
          </select>
        </label>
        <div
          className="replay-progress"
          data-replay-progress={progress === null ? "unknown" : progress.toFixed(4)}
          data-replay-grain={phase3Pending ?? "idle"}
        >
          <span>{publicTime}</span>
          <progress max={1} value={progress ?? 0} aria-label="回放进度" />
          <span>{progress === null ? "进度未知" : `${(progress * 100).toFixed(1)}%`}</span>
        </div>
        <div className="replay-fidelity-chips">
          <span>{tradeTape ? "AGG_TRADE" : `BAR_${config?.base_interval.toUpperCase() ?? "--"}`}</span>
          <span>{contractPortfolio?.execution_model ?? "PAPER_LINEAR_V1"}</span>
          <span>{tradeTape ? "EXACT_AGG_TRADE" : "EXACT_BAR"}</span>
          <span>{contractPortfolio === null
            ? (tradeTape ? "AGG_TRADE_TAPE" : "BAR_CONSERVATIVE")
            : "NO_BOOK_QUEUE"}</span>
        </div>
      </div>

      {visiblePlan !== null && (
        <div
          className="replay-fast-forward-plan"
          data-replay-fast-forward-plan={visiblePlan.mode}
          data-replay-equivalence={visiblePlan.equivalence}
        >
          <strong>{visiblePlan.mode}</strong>
          <span>{visiblePlan.explanation}</span>
          {visiblePlan.reasons.length > 0 && <code>{visiblePlan.reasons.join(" · ")}</code>}
          <em>equivalence: {visiblePlan.equivalence}</em>
        </div>
      )}

      {showEnd && (
        <div className="replay-modal-backdrop" role="presentation">
          <section className="replay-end-dialog" role="dialog" aria-modal="true" aria-labelledby="replay-end-title">
            <h2 id="replay-end-title">结束训练回放</h2>
            <p>先暂停并固化报告。按最后已揭示 mark 平仓会记录为合成的 SESSION_END_MARK_CLOSE。</p>
            <label>未成交订单
              <select value={openOrderDisposition} onChange={(event) => setOpenOrderDisposition(event.target.value as typeof openOrderDisposition)}>
                <option value="expire">到期</option><option value="cancel">取消</option><option value="preserve">保留到报告</option>
              </select>
            </label>
            <label>持仓
              <select value={positionDisposition} onChange={(event) => setPositionDisposition(event.target.value as typeof positionDisposition)}>
                <option value="keep">保留未实现状态</option><option value="mark_close">按已揭示 mark 合成平仓</option>
              </select>
            </label>
            <div className="replay-dialog-actions">
              <button type="button" onClick={() => setShowEnd(false)}>取消</button>
              <button
                type="button"
                data-replay-action="confirm-end"
                onClick={() => {
                  setShowEnd(false);
                  void (async () => {
                    const payload = {
                      open_order_disposition: openOrderDisposition,
                      position_disposition: positionDisposition,
                    };
                    if (viewer === undefined) {
                      if (runtime.store.state === "PLAYING") await runtime.actions.submitCommand("pause", {});
                      await runtime.actions.submitCommand("end_session", payload);
                    } else {
                      if (effectiveState === "PLAYING") await viewer.actions.submitControl("pause", {});
                      await viewer.actions.submitControl("end", payload);
                    }
                    await runtime.actions.loadReport();
                  })().catch(() => undefined);
                }}
              >确认结束</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
