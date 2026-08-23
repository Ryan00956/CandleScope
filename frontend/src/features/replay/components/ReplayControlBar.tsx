import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import {
  formatReplayPublicTime,
  replayEffectiveTrainingState,
  replayOwnsController,
} from "../replayUiModel.js";
import type {
  ReplayV2AdvanceBasis,
  ReplayV2Json,
} from "../replayV2Types.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayPhase3ControlType, ReplayViewerRuntime } from "../useReplayViewerRuntime.js";
import { replayAdvanceIsCancelable } from "../useReplayViewerRuntime.js";
import {
  boundedReplayAdvanceAmount,
  SOURCE_EVENT_MAX_MANUAL_COUNT,
} from "../replayAdvanceLimits.js";
import { parseIntervalSeconds } from "../../../utils/intervals.js";

const PLAYBACK_RATES = [1, 2, 5, 10, 30, 60, 120, 600, 1_000, 10_000] as const;

function basisLabel(basis: ReplayV2AdvanceBasis): string {
  switch (basis) {
    case "DISPLAY_BAR":
      return t("replay.control.displayBar");
    case "BASE_BAR":
      return t("replay.control.baseBar");
    case "SOURCE_EVENT":
      return t("replay.control.sourceEvent");
    case "VIRTUAL_TIME":
      return t("replay.control.virtualTime");
  }
}

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
  readonly viewer: ReplayViewerRuntime;
  readonly publicTimeLabel?: string | undefined;
}

export default function ReplayControlBar({ runtime, viewer, publicTimeLabel }: ReplayControlBarProps) {
  useLocale();
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
  const phase3Pending = viewer.controlPending?.type ?? null;
  const controllerActionPending = pending === "acquire_controller"
    || phase3Pending === "acquire_controller"
    || phase3Pending === "takeover_controller";
  const contractPortfolio = viewer.marketTracks?.portfolio.schema_version === "replay.training.portfolio.v2"
    ? viewer.marketTracks.portfolio
    : null;
  const effectiveState = replayEffectiveTrainingState(
    viewer.marketTracks?.global_clock?.state,
    store.state,
    store.controllerClientId,
  );
  const globalClock = viewer.marketTracks?.global_clock ?? null;
  const disabled = pending !== null || phase3Pending !== null
    || store.connectionState !== "connected" || !ownsController
    || viewer.viewerState === null || viewer.viewerPending;
  const cancelableAdvancePending = replayAdvanceIsCancelable(
    viewer.controlPending,
  );
  const phase3Ratio = viewer.progress?.ratio_ppm;
  const visiblePlan = fastForwardPlan(viewer.progress?.plan);
  const advanceProgress = typeof phase3Ratio === "number" && Number.isSafeInteger(phase3Ratio)
    ? Math.min(1, Math.max(0, phase3Ratio / 1_000_000))
    : null;
  const baseIntervalMs = Math.max(1, (parseIntervalSeconds(config?.base_interval ?? "1m") ?? 60) * 1_000);
  const supportedBases = globalClock?.supported_bases ?? [];
  const playbackBases = globalClock?.playback_bases ?? [];
  const advanceBasis = requestedAdvanceBasis !== null
    && supportedBases.includes(requestedAdvanceBasis)
    ? requestedAdvanceBasis
    : globalClock?.basis ?? "BASE_BAR";
  const playbackRate = requestedPlaybackRate ?? globalClock?.rate ?? 1;
  const globalMaxAdvanceCount = globalClock?.max_count ?? 100_000;
  const maxAdvanceCount = advanceBasis === "SOURCE_EVENT"
    ? Math.min(globalMaxAdvanceCount, SOURCE_EVENT_MAX_MANUAL_COUNT)
    : globalMaxAdvanceCount;
  const boundedAdvanceAmount = boundedReplayAdvanceAmount(
    advanceAmount,
    advanceBasis,
    globalMaxAdvanceCount,
  );
  const virtualTimeQuantumMs = globalClock?.virtual_time_quantum_ms ?? baseIntervalMs;
  const basisCanPlay = playbackBases.includes(advanceBasis);
  const canonicalAdvancePending = phase3Pending === "advance";
  const fallbackPublicTime = formatReplayPublicTime(store.virtualTimeMs, {
    blindMode: config?.blind_mode ?? true,
    originMs: store.replayStartMs,
  });
  const publicTime = publicTimeLabel ?? fallbackPublicTime;
  const summaryBuild = viewer.periodSummary?.status.active_set
    ?? viewer.periodSummary?.status.latest_build
    ?? null;
  const phase3Command = (
    type: ReplayPhase3ControlType,
    payload: Readonly<Record<string, ReplayV2Json>> = {},
  ) => {
    void viewer.actions.submitControl(type, payload).catch(() => undefined);
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
    <section className="replay-control-stack" aria-label={t("replay.control.aria")}>
      {store.connectionState !== "connected" && (
        <div className="replay-recovery-banner" role="status">
          {t("replay.control.connection", { state: store.connectionState })}
          <button type="button" onClick={() => runtime.actions.requestResync("manual recovery")}>{t("replay.control.resync")}</button>
        </div>
      )}
      {!ownsController && (
        <div className="replay-controller-banner" role="status">
          {store.controllerClientId
            ? t("replay.control.otherPage")
            : effectiveState === "ENDED"
              ? t("replay.control.ended")
              : controllerActionPending
                ? t("replay.control.recovering")
                : t("replay.control.readonly")}
          <button
            type="button"
            data-replay-action="takeover-controller"
            disabled={pending !== null || phase3Pending !== null || store.connectionState !== "connected"}
            onClick={() => {
              if (store.controllerClientId === null) {
                phase3Command("acquire_controller", { takeover: false });
              } else {
                phase3Command("takeover_controller");
              }
            }}
          >
            {controllerActionPending
              ? store.controllerClientId ? t("replay.control.taking") : t("replay.control.restoring")
              : store.controllerClientId
              ? t("replay.control.take")
              : effectiveState === "ENDED" ? t("replay.control.takeReview") : t("replay.control.takeControl")}
          </button>
        </div>
      )}
      {(runtime.commandError || store.error) && (
        <div className="replay-command-error" role="alert" data-replay-command-error={runtime.commandError?.code ?? store.error?.code}>
          <strong>{runtime.commandError?.code ?? store.error?.code}</strong>
          <span>{runtime.commandError?.message ?? store.error?.message}</span>
          {(runtime.commandError?.details?.needs_resync === true) && <span>{t("replay.control.unknownResult")}</span>}
          {(runtime.commandError?.code === "REVISION_CONFLICT") && <span>{t("replay.control.resyncWait")}</span>}
          {runtime.commandRecoveryPending && (
            <button
              type="button"
              data-replay-action="reconcile-command"
              disabled={!runtime.commandRecoveryReady || runtime.commandRecoveryInFlight}
              onClick={() => void runtime.actions.retryPendingCommandRecovery().catch(() => undefined)}
            >{runtime.commandRecoveryInFlight ? t("replay.control.reconciling") : t("replay.control.reconcile")}</button>
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
        >{t("replay.control.end")}</button>
        <>
          {supportedBases.includes("DISPLAY_BAR") && (
            <button type="button" title={t("replay.control.advanceDisplayTitle")} data-replay-action="advance-display" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("DISPLAY_BAR", 1)}>
              {canonicalAdvancePending ? t("replay.control.advancing") : t("replay.control.nextDisplay", { interval: viewer.viewerState?.display_interval ?? "--" })}
            </button>
          )}
          {supportedBases.includes("BASE_BAR") && (
            <button type="button" title={t("replay.control.advanceBaseTitle")} data-replay-action="advance-base" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("BASE_BAR", 1)}>
              {canonicalAdvancePending ? t("replay.control.advancing") : t("replay.control.nextBase", { interval: config?.base_interval ?? "--" })}
            </button>
          )}
          {supportedBases.includes("SOURCE_EVENT") && (
            <button type="button" data-replay-action="advance-source-event" disabled={disabled || effectiveState !== "PAUSED"} onClick={() => submitCanonicalAdvance("SOURCE_EVENT", 1)}>
              {canonicalAdvancePending ? t("replay.control.advancing") : tradeTape ? t("replay.control.nextAgg") : t("replay.control.nextSource")}
            </button>
          )}
        </>
        <label className="replay-speed-control">
          {t("replay.control.basis")}
          <select
            data-replay-action="advance-basis"
            value={advanceBasis}
            disabled={disabled || effectiveState === "PLAYING" || effectiveState === "ENDED"}
            onChange={(event) => setRequestedAdvanceBasis(event.target.value as ReplayV2AdvanceBasis)}
          >
            {supportedBases.map((basis) => (
              <option key={basis} value={basis}>
                {basis === "SOURCE_EVENT"
                  ? (tradeTape ? t("replay.control.aggSource") : t("replay.control.barSource"))
                  : basisLabel(basis)}
                {!playbackBases.includes(basis) ? t("replay.control.manualOnly") : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-replay-action={effectiveState === "PLAYING" ? "pause" : "play"}
          disabled={
            disabled
            || !["PAUSED", "PLAYING"].includes(effectiveState ?? "")
            || (effectiveState !== "PLAYING" && !basisCanPlay)
          }
          title={!basisCanPlay ? t("replay.control.manualBasis") : undefined}
          onClick={() => {
            const type = effectiveState === "PLAYING" ? "pause" : "play";
            phase3Command(type, type === "play" ? canonicalPlaybackPayload() : {});
          }}
        >
          {pending === "pause" || phase3Pending === "pause" ? t("replay.control.pausing") : pending === "play" || phase3Pending === "play" ? t("replay.control.playing") : effectiveState === "PLAYING" ? t("replay.control.pause") : t("replay.control.play")}
        </button>
        <label className="replay-speed-control">
          {t("replay.control.amount")}
          <input
            data-replay-action="advance-amount"
            type="number"
            min={1}
            max={maxAdvanceCount}
            step={1}
            value={boundedAdvanceAmount}
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
          title={t("replay.control.advance", { count: `${boundedAdvanceAmount} ${basisLabel(advanceBasis)}` })}
          disabled={disabled || effectiveState !== "PAUSED"}
          onClick={() => submitCanonicalAdvance(advanceBasis, boundedAdvanceAmount)}
        >
          {canonicalAdvancePending ? t("replay.control.advancing") : t("replay.control.advance", { count: boundedAdvanceAmount })}
        </button>
        {cancelableAdvancePending && (
          <button
            type="button"
            data-replay-action="cancel-advance"
            disabled={store.connectionState !== "connected" || !ownsController}
            onClick={() => void viewer.actions.cancelAdvance().catch(() => undefined)}
          >{t("replay.control.cancelAdvance")}</button>
        )}
        <label className="replay-speed-control">
          {t("replay.control.speed")}
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
                  ? t("replay.control.rateTime", { rate })
                  : t("replay.control.rateUnit", {
                    rate,
                    unit: advanceBasis === "SOURCE_EVENT" && tradeTape ? t("replay.source.agg") : basisLabel(advanceBasis),
                  })}
              </option>
            ))}
          </select>
        </label>
        <div
          className="replay-progress"
          data-replay-progress={cancelableAdvancePending
            ? advanceProgress === null ? "unknown" : advanceProgress.toFixed(4)
            : "hidden"}
          data-replay-grain={phase3Pending ?? "idle"}
        >
          <span className="replay-public-time">{publicTime}</span>
          {cancelableAdvancePending && (
            <span className="replay-advance-progress" data-replay-command-progress="active">
              <span>{t("replay.control.thisAdvance")}</span>
              <progress
                max={1}
                {...(advanceProgress === null ? {} : { value: advanceProgress })}
                aria-label={t("replay.control.advanceProgress")}
              />
              <span>{advanceProgress === null ? t("replay.control.preparing") : `${(advanceProgress * 100).toFixed(1)}%`}</span>
            </span>
          )}
        </div>
      </div>

      <details className="replay-control-diagnostics">
          <summary>{t("replay.control.diagnostics")}</summary>
          <div className="replay-control-diagnostics-body">
            <div className="replay-fidelity-chips">
              <span>{tradeTape ? "AGG_TRADE" : `BAR_${config?.base_interval.toUpperCase() ?? "--"}`}</span>
              <span>{contractPortfolio?.execution_model ?? "--"}</span>
              <span>{tradeTape ? "VERIFIED_TAPE · APPROX_BARS" : "EXACT_BAR"}</span>
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
                <em>{t("replay.control.equivalence", { value: visiblePlan.equivalence })}</em>
                {visiblePlan.summaryStatus !== null && (
                  <em>{t("replay.control.summaryStatus", { value: visiblePlan.summaryStatus })}</em>
                )}
              </div>
            )}
            <div
              className="replay-period-summary-status"
              data-replay-period-summary={
                viewer.periodSummary?.enabled === false
                  ? "DISABLED"
                  : summaryBuild?.status ?? (viewer.summaryError === null ? "EMPTY" : "ERROR")
              }
            >
              <strong>{t("replay.control.summary")}</strong>
              {viewer.periodSummary?.enabled === false ? (
                <span>{t("replay.control.summaryDisabled")}</span>
              ) : summaryBuild === null ? (
                <span>{t("replay.control.summaryEmpty")}</span>
              ) : (
                <span>
                  {t("replay.control.summaryStats", {
                    status: summaryBuild.status,
                    count: summaryBuild.candidate_count,
                    bytes: summaryBuild.compressed_bytes,
                    ms: summaryBuild.build_wall_ms,
                  })}
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
                  ? t("replay.control.scanning")
                  : summaryBuild?.status === "READY" ? t("replay.control.rebuildSummary") : t("replay.control.prepareSummary")}
              </button>
            </div>
          </div>
        </details>

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
            <h2 id="replay-end-title">{t("replay.control.endTitle")}</h2>
            <p id="replay-end-description">{t("replay.control.endHint")}</p>
            <label>{t("replay.control.openOrders")}
              <select value={openOrderDisposition} onChange={(event) => setOpenOrderDisposition(event.target.value as typeof openOrderDisposition)}>
                <option value="expire">{t("replay.control.expire")}</option><option value="cancel">{t("replay.control.cancel")}</option><option value="preserve">{t("replay.control.preserve")}</option>
              </select>
            </label>
            <label>{t("replay.control.positions")}
              <select value={positionDisposition} onChange={(event) => setPositionDisposition(event.target.value as typeof positionDisposition)}>
                <option value="keep">{t("replay.control.keepUnrealized")}</option><option value="mark_close">{t("replay.control.markClose")}</option>
              </select>
            </label>
            <div className="replay-dialog-actions">
              <button type="button" data-replay-action="cancel-end" onClick={() => setShowEnd(false)}>{t("replay.control.cancel")}</button>
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
                    if (effectiveState === "PLAYING") await viewer.actions.submitControl("pause", {});
                    await viewer.actions.submitControl("end", payload);
                  })().catch(() => undefined);
                }}
              >{t("replay.control.confirmEnd")}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
