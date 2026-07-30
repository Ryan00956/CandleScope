import { useEffect, useRef, useState } from "react";
import {
  formatReplayPublicTime,
  replayEffectiveTrainingState,
  replayOwnsController,
  replayProgress,
} from "../replayUiModel.js";
import type { ReplaySpeed } from "../replayTypes.js";
import type {
  ReplayV2AdvanceBasis,
  ReplayV2Json,
} from "../replayV2Types.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayPhase3ControlType, ReplayViewerRuntime } from "../useReplayViewerRuntime.js";
import { replayAdvanceIsCancelable } from "../useReplayViewerRuntime.js";
import { parseIntervalSeconds } from "../../../utils/intervals.js";

const SPEEDS: readonly ReplaySpeed[] = [1, 5, 15, 30, 60, 120, 300, 600, "MAX"];
const PLAYBACK_RATES = [1, 2, 5, 10, 30, 60, 120, 600, 1_000, 10_000] as const;

const BASIS_LABELS: Readonly<Record<ReplayV2AdvanceBasis, string>> = {
  DISPLAY_BAR: "展示 K",
  BASE_BAR: "最小周期 K",
  SOURCE_EVENT: "源事件",
  VIRTUAL_TIME: "历史虚拟时间",
};

function fastForwardPlan(value: ReplayV2Json | undefined): {
  readonly mode: string;
  readonly explanation: string;
  readonly reasons: readonly string[];
  readonly equivalence: string;
  readonly summaryStatus: string | null;
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
  const summaryValue = plan.period_summary;
  const summaryObject = summaryValue !== null
    && typeof summaryValue === "object"
    && !Array.isArray(summaryValue)
    ? summaryValue as Readonly<Record<string, ReplayV2Json>>
    : null;
  const summaryStatus = typeof summaryObject?.status === "string"
    ? summaryObject.status
    : null;
  return { mode, explanation, reasons, equivalence, summaryStatus };
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
  const [requestedAdvanceBasis, setRequestedAdvanceBasis] = useState<ReplayV2AdvanceBasis | null>(null);
  const [advanceAmount, setAdvanceAmount] = useState(1);
  const [requestedPlaybackRate, setRequestedPlaybackRate] = useState<number | null>(null);
  const endDialogRef = useRef<HTMLElement | null>(null);
  const endTriggerRef = useRef<HTMLButtonElement | null>(null);
  const store = runtime.store;
  const config = store.sessionConfig;
  const tradeTape = config?.source_kind === "agg_trade";
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const pending = runtime.pendingCommand?.type ?? null;
  const phase3Pending = viewer?.controlPending?.type ?? null;
  const contractPortfolio = viewer?.marketTracks?.portfolio.schema_version === "replay.training.portfolio.v2"
    ? viewer.marketTracks.portfolio
    : null;
  const effectiveState = replayEffectiveTrainingState(
    viewer?.marketTracks?.global_clock.state,
    store.state,
    store.controllerClientId,
  );
  const globalClock = viewer?.marketTracks?.global_clock ?? null;
  const effectiveSpeed = globalClock?.rate ?? store.speed ?? 1;
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
  const supportedBases = globalClock?.supported_bases ?? [];
  const playbackBases = globalClock?.playback_bases ?? [];
  const advanceBasis = requestedAdvanceBasis !== null
    && supportedBases.includes(requestedAdvanceBasis)
    ? requestedAdvanceBasis
    : globalClock?.basis ?? "BASE_BAR";
  const playbackRate = requestedPlaybackRate ?? globalClock?.rate ?? 1;
  const maxAdvanceCount = globalClock?.max_count ?? 100_000;
  const virtualTimeQuantumMs = globalClock?.virtual_time_quantum_ms ?? baseIntervalMs;
  const basisCanPlay = playbackBases.includes(advanceBasis);
  const canonicalAdvancePending = phase3Pending === "advance";
  const cancelableAdvancePending = replayAdvanceIsCancelable(
    viewer?.controlPending ?? null,
  );
  const fallbackPublicTime = formatReplayPublicTime(store.virtualTimeMs, {
    blindMode: config?.blind_mode ?? true,
    originMs: store.replayStartMs,
  });
  const publicTime = publicTimeLabel ?? fallbackPublicTime;
  const summaryBuild = viewer?.periodSummary?.status.active_set
    ?? viewer?.periodSummary?.status.latest_build
    ?? null;
  const command = (type: Parameters<ReplayRuntime["actions"]["submitCommand"]>[0], payload: Parameters<ReplayRuntime["actions"]["submitCommand"]>[1] = {}) => {
    void runtime.actions.submitCommand(type, payload).catch(() => undefined);
  };
  const phase3Command = (
    type: ReplayPhase3ControlType,
    payload: Readonly<Record<string, ReplayV2Json>> = {},
  ) => {
    if (viewer !== undefined) void viewer.actions.submitControl(type, payload).catch(() => undefined);
  };
  const submitCanonicalAdvance = (
    basis: ReplayV2AdvanceBasis,
    amount: number,
  ) => {
    const bounded = Math.min(maxAdvanceCount, Math.max(1, Math.trunc(amount)));
    phase3Command("advance", basis === "VIRTUAL_TIME"
      ? { basis, duration_ms: bounded * virtualTimeQuantumMs }
      : { basis, count: bounded });
  };
  const canonicalPlaybackPayload = (): Readonly<Record<string, ReplayV2Json>> => ({
    basis: advanceBasis,
    rate: playbackRate,
  });

  useEffect(() => {
    if (!showEnd) return undefined;
    const dialog = endDialogRef.current;
    if (dialog === null) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trigger = endTriggerRef.current;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((item) => !item.hasAttribute("hidden") && item.getAttribute("aria-hidden") !== "true");
    const initial = dialog.querySelector<HTMLElement>('[data-replay-action="cancel-end"]') ?? focusable()[0] ?? dialog;
    initial.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowEnd(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const restore = trigger ?? previous;
      requestAnimationFrame(() => restore?.focus());
    };
  }, [showEnd]);

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
          {store.controllerClientId ? "另一个页面正在控制，本页只读。" : "当前为只读；获取控制权后可操作。"}
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
        <button
          ref={endTriggerRef}
          type="button"
          data-replay-action="end"
          aria-haspopup="dialog"
          aria-expanded={showEnd}
          disabled={disabled || effectiveState === "ENDED"}
          onClick={() => setShowEnd(true)}
        >结束</button>
        <button
          type="button"
          data-replay-action="fork"
          disabled={pending !== null || phase3Pending !== null || viewer?.viewerPending === true || forkPending || multiTrackForkBlocked}
          title={multiTrackForkBlocked ? "多商品存档保持 v2-only；当前不会压缩成单商品 v1 Fork" : undefined}
          onClick={() => void runtime.actions.forkSession().catch(() => undefined)}
        >分支</button>
        {viewer === undefined ? (
          <button type="button" data-replay-action="step" disabled={disabled || store.state !== "PAUSED"} onClick={() => command("step", { count: 1 })}>
            {pending === "step" ? "单步中…" : "单步 →"}
          </button>
        ) : (<>
          {supportedBases.includes("DISPLAY_BAR") && (
            <button type="button" title="推进一根当前展示周期 K 线" data-replay-action="advance-display" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("DISPLAY_BAR", 1)}>
              {canonicalAdvancePending ? "推进中…" : `下一根 ${viewer.viewerState?.display_interval ?? "--"}`}
            </button>
          )}
          {supportedBases.includes("BASE_BAR") && (
            <button type="button" title="推进一根最小周期 K 线" data-replay-action="advance-base" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("BASE_BAR", 1)}>
              {canonicalAdvancePending ? "推进中…" : `下一根 ${config?.base_interval ?? "--"}`}
            </button>
          )}
          {supportedBases.includes("SOURCE_EVENT") && (
            <button type="button" data-replay-action="advance-source-event" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("SOURCE_EVENT", 1)}>
              {canonicalAdvancePending ? "推进中…" : tradeTape ? "下一聚合成交" : "下一源 K"}
            </button>
          )}
        </>)}
        {viewer !== undefined && (
          <label className="replay-speed-control">
            基准
            <select
              data-replay-action="advance-basis"
              value={advanceBasis}
              disabled={disabled || effectiveState === "PLAYING" || effectiveState === "ENDED"}
              onChange={(event) => setRequestedAdvanceBasis(event.target.value as ReplayV2AdvanceBasis)}
            >
              {supportedBases.map((basis) => (
                <option key={basis} value={basis}>
                  {basis === "SOURCE_EVENT"
                    ? (tradeTape ? "聚合成交源事件" : "BAR 源事件")
                    : BASIS_LABELS[basis]}
                  {!playbackBases.includes(basis) ? "（仅手动）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          data-replay-action={effectiveState === "PLAYING" ? "pause" : "play"}
          disabled={
            disabled
            || !["PAUSED", "PLAYING"].includes(effectiveState ?? "")
            || (viewer !== undefined && effectiveState !== "PLAYING" && !basisCanPlay)
          }
          title={viewer !== undefined && !basisCanPlay ? "这个基准只允许手动推进" : undefined}
          onClick={() => {
            const type = effectiveState === "PLAYING" ? "pause" : "play";
            if (viewer === undefined) command(type);
            else phase3Command(type, type === "play" ? canonicalPlaybackPayload() : {});
          }}
        >
          {pending === "pause" || phase3Pending === "pause" ? "正在暂停…" : pending === "play" || phase3Pending === "play" ? "正在播放…" : effectiveState === "PLAYING" ? "暂停 ‖" : "播放 ▶"}
        </button>
        {viewer === undefined ? (
          <button type="button" data-replay-action="advance" disabled={disabled || store.state !== "PAUSED"} onClick={() => command("advance_by", { ms: 300_000 })}>
            {pending === "advance_by" ? "推进中…" : "前进 5m ⇥"}
          </button>
        ) : (
          <>
            <label className="replay-speed-control">
              数量
              <input
                data-replay-action="advance-amount"
                type="number"
                min={1}
                max={maxAdvanceCount}
                step={1}
                value={advanceAmount}
                disabled={disabled || effectiveState !== "PAUSED"}
                onChange={(event) => setAdvanceAmount(Math.min(
                  maxAdvanceCount,
                  Math.max(1, Math.trunc(Number(event.target.value) || 1)),
                ))}
              />
            </label>
            <button
              type="button"
              data-replay-action="advance"
              title={`推进 ${advanceAmount} ${BASIS_LABELS[advanceBasis]}`}
              disabled={disabled || effectiveState !== "PAUSED"}
              onClick={() => submitCanonicalAdvance(advanceBasis, advanceAmount)}
            >
              {canonicalAdvancePending ? "推进中…" : `推进 ${advanceAmount}`}
            </button>
          </>
        )}
        {viewer !== undefined && cancelableAdvancePending && (
          <button
            type="button"
            data-replay-action="cancel-advance"
            disabled={store.connectionState !== "connected" || !ownsController}
            onClick={() => void viewer.actions.cancelAdvance().catch(() => undefined)}
          >取消推进</button>
        )}
        {viewer === undefined ? (
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
                command("set_speed", { speed });
              }}
            >
              {SPEEDS.map((speed) => <option key={String(speed)} value={String(speed)}>{speed === "MAX" ? "MAX" : `${speed}×`}</option>)}
            </select>
          </label>
        ) : (
          <label className="replay-speed-control">
            速度
            <select
              data-replay-action="playback-rate"
              value={String(playbackRate)}
              disabled={disabled || effectiveState === "ENDED" || !basisCanPlay}
              onChange={(event) => {
                const rate = Number(event.target.value);
                setRequestedPlaybackRate(rate);
                phase3Command("set_speed", { basis: advanceBasis, rate });
              }}
            >
              {PLAYBACK_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {advanceBasis === "VIRTUAL_TIME"
                    ? `${rate}× 历史时间`
                    : `${rate} ${advanceBasis === "SOURCE_EVENT" && tradeTape ? "聚合成交" : BASIS_LABELS[advanceBasis]}/秒`}
                </option>
              ))}
            </select>
          </label>
        )}
        <div
          className="replay-progress"
          data-replay-progress={progress === null ? "unknown" : progress.toFixed(4)}
          data-replay-grain={phase3Pending ?? "idle"}
        >
          <span>{publicTime}</span>
          <progress max={1} value={progress ?? 0} aria-label="回放进度" />
          <span>{progress === null ? "进度未知" : `${(progress * 100).toFixed(1)}%`}</span>
        </div>
      </div>

      {(visiblePlan !== null || viewer !== undefined) && (
        <details className="replay-control-diagnostics">
          <summary>高级诊断</summary>
          <div className="replay-control-diagnostics-body">
            <div className="replay-fidelity-chips">
              <span>{tradeTape ? "AGG_TRADE" : `BAR_${config?.base_interval.toUpperCase() ?? "--"}`}</span>
              <span>{contractPortfolio?.execution_model ?? "PAPER_LINEAR_V1"}</span>
              <span>{tradeTape ? "EXACT_AGG_TRADE" : "EXACT_BAR"}</span>
              <span>{contractPortfolio === null
                ? (tradeTape ? "AGG_TRADE_TAPE" : "BAR_CONSERVATIVE")
                : "NO_BOOK_QUEUE"}</span>
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
                {visiblePlan.summaryStatus !== null && (
                  <em>summary: {visiblePlan.summaryStatus}</em>
                )}
              </div>
            )}
            {viewer !== undefined && (
              <div
                className="replay-period-summary-status"
                data-replay-period-summary={
                  viewer.periodSummary?.enabled === false
                    ? "DISABLED"
                    : summaryBuild?.status ?? (viewer.summaryError === null ? "EMPTY" : "ERROR")
                }
              >
                <strong>推进摘要</strong>
                {viewer.periodSummary?.enabled === false ? (
                  <span>优化开关关闭；推进继续使用精确逐事件参考路径。</span>
                ) : summaryBuild === null ? (
                  <span>尚未准备可验证摘要。</span>
                ) : (
                  <span>
                    {summaryBuild.status} · {summaryBuild.candidate_count} 个候选 ·
                    {" "}{summaryBuild.compressed_bytes} bytes ·
                    {" "}{summaryBuild.build_wall_ms} ms 准备成本
                  </span>
                )}
                {viewer.summaryError !== null && (
                  <span role="alert">{viewer.summaryError}</span>
                )}
                <button
                  type="button"
                  data-replay-action="prepare-period-summaries"
                  disabled={
                    viewer.periodSummary?.enabled === false
                    || viewer.summaryPreparing
                    || viewer.controlPending !== null
                    || viewer.viewerPending
                    || effectiveState !== "PAUSED"
                    || store.connectionState !== "connected"
                  }
                  onClick={() => void viewer.actions.preparePeriodSummaries().catch(() => undefined)}
                >
                  {viewer.summaryPreparing
                    ? "正在精确扫描准备…"
                    : summaryBuild?.status === "READY" ? "重建摘要" : "准备摘要"}
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {showEnd && (
        <div className="replay-modal-backdrop" role="presentation">
          <section
            ref={endDialogRef}
            className="replay-end-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="replay-end-title"
            aria-describedby="replay-end-description"
            data-replay-focus-trap="active"
            tabIndex={-1}
          >
            <h2 id="replay-end-title">结束训练回放</h2>
            <p id="replay-end-description">先暂停并固化报告。按最后已揭示 mark 平仓会记录为合成的 SESSION_END_MARK_CLOSE。</p>
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
              <button type="button" data-replay-action="cancel-end" onClick={() => setShowEnd(false)}>取消</button>
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
