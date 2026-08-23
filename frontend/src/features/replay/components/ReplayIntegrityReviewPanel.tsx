import { useMemo, useState } from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";

import { buildEquityPolyline } from "../replayIntegrityModel.js";
import { downloadReplayTrainingReport } from "../replayReportExport.js";
import { replayOwnsController } from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayIntegrityRuntime } from "../useReplayIntegrityRuntime.js";
import ReplayLiquidationTimeline from "./ReplayLiquidationTimeline.js";

export interface ReplayIntegrityReviewPanelProps {
  readonly runtime: ReplayRuntime;
  readonly integrityRuntime: ReplayIntegrityRuntime;
  readonly trainingState?: string | null;
  readonly onClose?: (() => void) | undefined;
}

function AuditValue({ value }: { readonly value: Readonly<Record<string, unknown>> }) {
  return <code>{JSON.stringify(value)}</code>;
}

export default function ReplayIntegrityReviewPanel({
  runtime,
  integrityRuntime,
  trainingState = null,
  onClose,
}: ReplayIntegrityReviewPanelProps) {
  useLocale();
  const [amount, setAmount] = useState("100");
  const [reason, setReason] = useState("training adjustment");
  const [makerFeeBps, setMakerFeeBps] = useState("");
  const [takerFeeBps, setTakerFeeBps] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");
  const [fundingMode, setFundingMode] = useState<"OFF" | "SANDBOX_FIXED">("OFF");
  const [fixedFundingRate, setFixedFundingRate] = useState("0.0001");
  const [fundingIntervalMs, setFundingIntervalMs] = useState("28800000");
  const [markerText, setMarkerText] = useState("");
  const [playbackRate, setPlaybackRate] = useState<"0.25" | "0.5" | "1" | "2" | "4" | "8">("1");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const integrity = integrityRuntime.integrity;
  const rules = integrityRuntime.rules;
  const review = integrityRuntime.review;
  const report = integrityRuntime.report;
  const ownsController = replayOwnsController(runtime.store, runtime.clientInstanceId);
  const busy = integrityRuntime.operation !== null;
  const equityPoints = useMemo(() => buildEquityPolyline(
    integrityRuntime.equity?.samples ?? [],
    420,
    112,
  ), [integrityRuntime.equity?.samples]);

  if (integrity === null && integrityRuntime.error === null) {
    return (
      <section className="replay-integrity-panel" data-replay-panel="integrity" aria-label={t("replay.integrity.aria")}>
        <header className="replay-integrity-heading">
          <div>
            <span className="training-hub-kicker">{t("replay.integrity.kicker")}</span>
            <h2>{t("replay.integrity.title")}</h2>
          </div>
          {onClose !== undefined && (
            <button type="button" data-replay-action="close-integrity" onClick={onClose}>
              {t("replay.hub.close")}
            </button>
          )}
        </header>
        <p role="status">{t("replay.integrity.loading")}</p>
      </section>
    );
  }

  const allowed = new Set(integrity?.allowed_mutations ?? []);
  const effectiveSelectedEventId = review === null
    ? null
    : review.events.some((event) => event.event_id === selectedEventId)
      ? selectedEventId
      : review.selected_event_id;
  const canCapital = ownsController && !busy && runtime.store.state !== "ENDED"
    && review === null;
  const canMutateRules = ownsController && !busy && runtime.store.state !== "ENDED"
    && review === null;
  const fundingInterval = Number(fundingIntervalMs);
  const fundingPolicyValid = fundingMode === "OFF" || (
    integrity?.integrity_mode === "SANDBOX"
    && Number.isSafeInteger(fundingInterval)
    && fundingInterval >= 60_000
    && fundingInterval <= 30 * 86_400_000
    && fixedFundingRate.length > 0
  );
  const canReveal = ownsController && !busy && review === null
    && integrity !== null && !integrity.revealed
    && (runtime.store.state === "ENDED" || allowed.has("reveal_time"));
  const reviewOriginalState = trainingState ?? runtime.store.state;
  const reviewStartReady = reviewOriginalState === "PAUSED"
    || reviewOriginalState === "ENDED";
  const submitCapital = (kind: "deposit" | "withdraw") => {
    const action = kind === "deposit"
      ? integrityRuntime.actions.deposit
      : integrityRuntime.actions.withdraw;
    void action(amount, reason).catch(() => undefined);
  };
  const budget = review?.budget ?? integrityRuntime.budget;
  const budgetPressure = budget === null ? 0 : Math.max(
    budget.critical_events / budget.critical_event_limit,
    budget.viewport_samples / budget.viewport_sample_limit,
    budget.anchor_used_bytes / budget.anchor_limit_bytes,
    budget.artifact_used_bytes / budget.artifact_limit_bytes,
  );

  return (
    <section
      className="replay-integrity-panel"
      data-replay-panel="integrity"
      data-integrity-mode={integrity?.integrity_mode ?? "unavailable"}
      data-time-disclosure-policy={integrity?.effective_time_disclosure_policy ?? "unavailable"}
      data-result-label={integrity?.result_label ?? "unavailable"}
      aria-labelledby="replay-integrity-title"
    >
      <header className="replay-integrity-heading">
        <div>
          <span className="training-hub-kicker">{t("replay.integrity.kicker")}</span>
          <h2 id="replay-integrity-title">{t("replay.integrity.title")}</h2>
        </div>
        <div className="replay-integrity-heading-actions">
          <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.refresh()}>
            {t("replay.hub.refresh")}
          </button>
          {onClose !== undefined && (
            <button type="button" data-replay-action="close-integrity" onClick={onClose}>
              {t("replay.hub.close")}
            </button>
          )}
        </div>
      </header>

      {integrityRuntime.error !== null && (
        <div className="replay-command-error" role="alert">{integrityRuntime.error}</div>
      )}

      {integrity !== null && (
        <>
          <div className="replay-integrity-summary">
            <div><span>{t("replay.integrity.mode")}</span><strong>{integrity.integrity_mode}</strong></div>
            <div><span>{t("replay.integrity.result")}</span><strong>{integrity.result_label}</strong></div>
            <div><span>{t("replay.integrity.publicTime")}</span><strong data-public-time-label>{integrity.public_time.label}</strong></div>
            <div><span>{t("replay.integrity.disclosure")}</span><strong>{integrity.effective_time_disclosure_policy}</strong></div>
            <div><span>{t("replay.integrity.strict")}</span><strong>{integrity.strict_eligible ? "ELIGIBLE" : "NOT STRICT"}</strong></div>
            <div><span>{t("replay.integrity.startKnown")}</span><strong>{integrity.start_time_known ? "YES" : "NO"}</strong></div>
          </div>

          <div className="replay-integrity-grid">
            <section aria-labelledby="replay-equity-title">
              <div className="replay-integrity-section-heading">
                <h3 id="replay-equity-title">{t("replay.integrity.equity")}</h3>
                <span>{t("replay.integrity.sampleCount", {
                  resolution: integrityRuntime.equity?.resolution ?? "--",
                  count: integrityRuntime.equity?.samples.length ?? 0,
                })}</span>
              </div>
              <svg
                className="replay-equity-chart"
                viewBox="0 0 420 112"
                role="img"
                aria-label={t("replay.integrity.equityAria")}
                preserveAspectRatio="none"
              >
                <polyline points={equityPoints} fill="none" vectorEffect="non-scaling-stroke" />
              </svg>
              <p>{t("replay.integrity.equityHint")}</p>
            </section>

            <section aria-labelledby="replay-policy-title">
              <div className="replay-integrity-section-heading">
                <h3 id="replay-policy-title">{t("replay.integrity.policy")}</h3>
                <span>{integrity.allowed_mutations.length === 0 ? "LOCKED" : integrity.allowed_mutations.join(" · ")}</span>
              </div>
              {(allowed.has("deposit") || allowed.has("withdraw")) && (
                <div className="replay-capital-controls">
                  <label>{t("replay.integrity.amount")}<input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} /></label>
                  <label>{t("replay.integrity.reason")}<input value={reason} maxLength={512} onChange={(event) => setReason(event.target.value)} /></label>
                  <div>
                    {allowed.has("deposit") && <button type="button" disabled={!canCapital} onClick={() => submitCapital("deposit")}>{t("replay.integrity.deposit")}</button>}
                    {allowed.has("withdraw") && <button type="button" disabled={!canCapital} onClick={() => submitCapital("withdraw")}>{t("replay.integrity.withdraw")}</button>}
                  </div>
                </div>
              )}
              {!integrity.revealed && (
                <button
                  className="replay-reveal-time"
                  type="button"
                  data-replay-action="reveal-time"
                  disabled={!canReveal}
                  title={ownsController ? t("replay.integrity.revealTitle") : t("replay.integrity.needLease")}
                  onClick={() => {
                    if (window.confirm(t("replay.integrity.revealConfirm"))) {
                      void integrityRuntime.actions.revealTime(reason).catch(() => undefined);
                    }
                  }}
                >{t("replay.integrity.reveal")}</button>
              )}
              {integrity.revealed && <p className="replay-revealed">{t("replay.integrity.revealed")}</p>}
              <p>{t("replay.integrity.atomic")}</p>
            </section>
          </div>

          <section className="replay-run-rules" aria-labelledby="replay-run-rules-title">
            <div className="replay-integrity-section-heading">
              <div>
                <h3 id="replay-run-rules-title">{t("replay.integrity.rules")}</h3>
                <p>{t("replay.integrity.rulesHint")}</p>
              </div>
              <span>{rules === null ? t("replay.integrity.loading") : t("replay.integrity.revisions", { count: rules.history.length })}</span>
            </div>
            {rules !== null && (
              <>
                <div className="replay-rule-current">
                  <div><span>{t("replay.integrity.makerTaker")}</span><strong>{rules.fee_policy.maker_fee_bps} / {rules.fee_policy.taker_fee_bps} bps</strong></div>
                  <div><span>{t("replay.integrity.userLeverage")}</span><strong>{rules.leverage_policy.max_leverage}×</strong></div>
                  <div><span>{t("replay.integrity.funding")}</span><strong>{rules.funding_policy.funding_mode}</strong></div>
                  <div><span>{t("replay.integrity.exchangeRules")}</span><strong>{t("replay.integrity.immutableRules", { count: rules.instrument_rules.length })}</strong></div>
                </div>
                <div className="replay-rule-forms">
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void integrityRuntime.actions.changeFeePolicy(
                      makerFeeBps || rules.fee_policy.maker_fee_bps,
                      takerFeeBps || rules.fee_policy.taker_fee_bps,
                      reason,
                    ).catch(() => undefined);
                  }}>
                    <strong>{t("replay.integrity.feeRev")}</strong>
                    <label>{t("replay.integrity.makerBps")}<input inputMode="decimal" value={makerFeeBps} placeholder={rules.fee_policy.maker_fee_bps} onChange={(event) => setMakerFeeBps(event.target.value)} /></label>
                    <label>{t("replay.integrity.takerBps")}<input inputMode="decimal" value={takerFeeBps} placeholder={rules.fee_policy.taker_fee_bps} onChange={(event) => setTakerFeeBps(event.target.value)} /></label>
                    <button type="submit" disabled={!canMutateRules || !allowed.has("change_fee_policy")}>{t("replay.integrity.submit")}</button>
                  </form>
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void integrityRuntime.actions.changeLeverageCap(
                      maxLeverage || rules.leverage_policy.max_leverage,
                      reason,
                    ).catch(() => undefined);
                  }}>
                    <strong>{t("replay.integrity.leverageOverlay")}</strong>
                    <label>{t("replay.integrity.maxMult")}<input inputMode="decimal" value={maxLeverage} placeholder={rules.leverage_policy.max_leverage} onChange={(event) => setMaxLeverage(event.target.value)} /></label>
                    <span>{Object.entries(rules.effective_leverage_by_track).map(([track, value]) => `${track}=${value}×`).join(" · ")}</span>
                    <button type="submit" disabled={!canMutateRules || !allowed.has("change_leverage_cap")}>{t("replay.integrity.submit")}</button>
                  </form>
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    if (!fundingPolicyValid) return;
                    void integrityRuntime.actions.changeFundingPolicy(
                      fundingMode,
                      fundingMode === "OFF" ? null : fixedFundingRate,
                      fundingMode === "OFF" ? null : fundingInterval,
                      reason,
                    ).catch(() => undefined);
                  }}>
                    <strong>{t("replay.integrity.sandboxFunding")}</strong>
                    <label>{t("replay.integrity.fundingMode")}<select value={fundingMode} onChange={(event) => setFundingMode(event.target.value as "OFF" | "SANDBOX_FIXED")}><option value="OFF">{t("replay.hub.modeOff")}</option><option value="SANDBOX_FIXED">{t("replay.integrity.sandboxFixed")}</option></select></label>
                    <label>{t("replay.integrity.rate")}<input inputMode="decimal" disabled={fundingMode === "OFF"} value={fixedFundingRate} onChange={(event) => setFixedFundingRate(event.target.value)} /></label>
                    <label>{t("replay.integrity.intervalMs")}<input inputMode="numeric" disabled={fundingMode === "OFF"} value={fundingIntervalMs} onChange={(event) => setFundingIntervalMs(event.target.value)} /></label>
                    <button
                      type="submit"
                      title={fundingPolicyValid ? t("replay.integrity.submitRev") : t("replay.integrity.fundingSandboxOnly")}
                      disabled={!canMutateRules || !allowed.has("change_funding_policy") || !fundingPolicyValid}
                    >{t("replay.integrity.submit")}</button>
                  </form>
                </div>
                <label className="replay-rule-reason">{t("replay.integrity.changeReason")}<input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
                <div className="replay-rule-history" aria-label={t("replay.integrity.ruleHistory")}>
                  {rules.history.map((revision) => (
                    <article key={`${revision.kind}-${revision.revision}-${revision.policy_hash}`}>
                      <strong>{revision.kind} r{revision.revision}</strong>
                      <span>{revision.public_time.label}</span>
                      <span>{revision.reason}</span>
                      <code>{revision.command_id ?? "creation"}</code>
                      <code>{revision.policy_hash}</code>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="replay-review-budget" aria-labelledby="replay-review-budget-title" data-budget-warning={budgetPressure >= 0.85 ? "true" : "false"}>
            <div className="replay-integrity-section-heading">
              <h3 id="replay-review-budget-title">{t("replay.integrity.budget")}</h3>
              <strong>{budget === null ? "--" : `${Math.round(budgetPressure * 100)}% peak`}</strong>
            </div>
            {budget !== null && (
              <div className="replay-budget-grid">
                <span>{t("replay.integrity.criticalEvents", { count: budget.critical_events, limit: budget.critical_event_limit })}</span>
                <span>{t("replay.integrity.viewportBudget", { used: budget.viewport_samples, limit: budget.viewport_sample_limit })}</span>
                <span>{t("replay.integrity.anchorBudget", { used: Math.round(budget.anchor_used_bytes / 1_048_576), limit: Math.round(budget.anchor_limit_bytes / 1_048_576) })}</span>
                <span>{t("replay.integrity.artifactBudget", { used: Math.round(budget.artifact_used_bytes / 1_048_576), limit: Math.round(budget.artifact_limit_bytes / 1_048_576) })}</span>
              </div>
            )}
            {budgetPressure >= 0.85 && <p role="alert">{t("replay.integrity.budgetWarn")}</p>}
          </section>

          <section className="replay-integrity-audit" aria-labelledby="replay-audit-title">
            <div className="replay-integrity-section-heading">
              <h3 id="replay-audit-title">{t("replay.integrity.audit")}</h3>
              <span>{integrity.mutations.length}</span>
            </div>
            {integrity.mutations.length === 0 ? <p>{t("replay.integrity.noMutations")}</p> : (
              <div className="replay-integrity-audit-list">
                {integrity.mutations.slice(-20).map((mutation) => (
                  <article key={mutation.event_id} data-audit-event={mutation.event_type}>
                    <strong>{mutation.event_type}</strong>
                    <span>{t("replay.integrity.ruleRevision", { time: mutation.public_time.label, revision: mutation.rule_revision })}</span>
                    <span>{mutation.reason}</span>
                    <AuditValue value={mutation.old_value} />
                    <span>→</span>
                    <AuditValue value={mutation.new_value} />
                  </article>
                ))}
              </div>
            )}
          </section>

          {report !== null && (
            <section className="replay-integrity-report" data-replay-panel="report" aria-labelledby="replay-phase4-report-title">
              <div className="replay-integrity-section-heading">
                <h3 id="replay-phase4-report-title">{t("replay.integrity.report")}</h3>
                <code>{report.report.report_hash}</code>
                <div className="replay-report-actions">
                  <button type="button" onClick={() => downloadReplayTrainingReport(report, "json")}>{t("replay.integrity.exportJson")}</button>
                  <button type="button" onClick={() => downloadReplayTrainingReport(report, "csv")}>{t("replay.integrity.exportCsv")}</button>
                </div>
              </div>
              <div className="replay-integrity-summary">
                <div><span>{t("replay.integrity.finalEquity")}</span><strong>{report.report.final_equity}</strong></div>
                <div><span>{t("replay.integrity.realizedPnl")}</span><strong>{report.report.realized_pnl}</strong></div>
                <div><span>{t("replay.integrity.fees")}</span><strong>{report.report.fees_paid}</strong></div>
                <div><span>{t("replay.integrity.trades")}</span><strong>{report.report.trade_count}</strong></div>
                {report.modelled_account.schema_version === "replay.training.portfolio.v2" && (
                  <>
                    <div>
                      <span>{t("replay.integrity.accountInputs")}</span>
                      <strong>{report.modelled_account.account_history.mode}</strong>
                    </div>
                    <div>
                      <span>{t("replay.integrity.accountAudit")}</span>
                      <strong data-account-auditor-status={report.modelled_account.account_history.auditor.status}>
                        {report.modelled_account.account_history.auditor.status}
                      </strong>
                    </div>
                    <div>
                      <span>{t("replay.integrity.simLiq")}</span>
                      <strong>{report.modelled_account.liquidations.length + report.modelled_account.liquidation_recoveries.length}</strong>
                    </div>
                    <div>
                      <span>{t("replay.integrity.mktLiq")}</span>
                      <strong>{report.modelled_account.liquidation_channels.historical_market.fidelity}</strong>
                    </div>
                  </>
                )}
              </div>
              {report.modelled_account.schema_version === "replay.training.portfolio.v2" && (
                <section className="replay-report-liquidations" aria-label={t("replay.integrity.liqAria")}>
                  <h4>{t("replay.integrity.liqHeading")}</h4>
                  <ReplayLiquidationTimeline
                    cases={[
                      ...report.modelled_account.liquidation_recoveries,
                      ...report.modelled_account.liquidations,
                    ]}
                  />
                </section>
              )}
              {report.account_audit !== null && (
                <p>
                  {t("replay.integrity.accountAudit")}<strong>{report.account_audit.status}</strong>
                  {" · "}<code>{report.account_audit.proof_hash}</code>
                </p>
              )}
            </section>
          )}

          <section className="replay-review" aria-labelledby="replay-review-title" data-review-read-only={String(review?.read_only ?? false)}>
            <div className="replay-integrity-section-heading">
              <div><h3 id="replay-review-title">{t("replay.integrity.review")}</h3><p>{t("replay.integrity.reviewHint")}</p></div>
              <button
                type="button"
                disabled={busy || (review === null && !reviewStartReady)}
                title={review === null && !reviewStartReady
                  ? t("replay.integrity.pauseFirst")
                  : t("replay.integrity.cursorOnly")}
                onClick={() => {
                if (review === null) void integrityRuntime.actions.startReview();
                else integrityRuntime.actions.closeReview();
              }}
              >
                {review === null ? t("replay.integrity.startReview") : t("replay.integrity.exitReview")}
              </button>
            </div>
            {review === null && (
              <form className="replay-marker-form" onSubmit={(event) => {
                event.preventDefault();
                void integrityRuntime.actions.addMarker(markerText).then(() => {
                  setMarkerText("");
                }).catch(() => undefined);
              }}>
                <label>{t("replay.integrity.marker")}<input value={markerText} maxLength={500} placeholder={t("replay.integrity.markerPh")} onChange={(event) => setMarkerText(event.target.value)} /></label>
                <button type="submit" disabled={busy || markerText.trim().length === 0}>{t("replay.integrity.record")}</button>
              </form>
            )}
            {review !== null && (
              <>
                <div className="replay-review-controls" role="group" aria-label={t("replay.integrity.reviewControls")}>
                  <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.controlReview("PREVIOUS")}>{t("replay.integrity.prev")}</button>
                  <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.controlReview("NEXT")}>{t("replay.integrity.next")}</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void integrityRuntime.actions.controlReview(
                      review.playback_state === "PLAYING" ? "PAUSE" : "PLAY",
                      { playbackRate },
                    )}
                  >{review.playback_state === "PLAYING" ? t("replay.integrity.pause") : t("replay.integrity.play")}</button>
                  <label>{t("replay.integrity.speed")}
                    <select value={playbackRate} onChange={(event) => setPlaybackRate(event.target.value as typeof playbackRate)}>
                      {(["0.25", "0.5", "1", "2", "4", "8"] as const).map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
                    </select>
                  </label>
                  <label>
                    {t("replay.integrity.event")}
                    <select value={effectiveSelectedEventId ?? review.selected_event_id} onChange={(event) => setSelectedEventId(event.target.value)}>
                      {review.events.map((event) => (
                        <option key={event.event_id} value={event.event_id}>
                          #{event.timeline_sequence} · {event.public_time.label} · {event.category}/{event.event_type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy || effectiveSelectedEventId === null}
                    onClick={() => effectiveSelectedEventId !== null && void integrityRuntime.actions.controlReview("JUMP", { eventId: effectiveSelectedEventId })}
                  >{t("replay.integrity.jump")}</button>
                  <button
                    type="button"
                    disabled={busy || effectiveSelectedEventId === null}
                    onClick={() => effectiveSelectedEventId !== null && void integrityRuntime.actions.forkReview(effectiveSelectedEventId)}
                  >{t("replay.integrity.fork")}</button>
                </div>
                <div className="replay-review-proof" data-review-verified={String(review.immutability_proof.verified)}>
                  <strong>{t("replay.integrity.unchanged")}</strong>
                  <code>{t("replay.integrity.proofOriginal", { hash: review.original_state_hash })}</code>
                  <code>{t("replay.integrity.proofSelected", { hash: review.selected_state_hash })}</code>
                  <code>{t("replay.integrity.proofAccount", { hash: review.immutability_proof.original_account_hash })}</code>
                  <code>{t("replay.integrity.proofLedger", { hash: review.immutability_proof.original_ledger_tail_hash })}</code>
                </div>
                <div className="replay-review-projection" aria-label={t("replay.integrity.projection")}>
                  <div><span>{t("replay.integrity.timeline")}</span><strong>{t("replay.integrity.timelineRevision", { sequence: review.selected_timeline_sequence, revision: review.cursor_revision })}</strong></div>
                  <div><span>{t("replay.integrity.viewer")}</span><strong>{String(review.projection.viewer_state.selected_track_id)} · {String(review.projection.viewer_state.display_interval)}</strong></div>
                  <div><span>{t("replay.integrity.ordersFills")}</span><strong>{review.projection.orders.length} / {review.projection.fills.length}</strong></div>
                  <div><span>{t("replay.integrity.ledgerLiquidations")}</span><strong>{review.projection.ledger.length} / {review.projection.liquidations.length}</strong></div>
                  <div><span>{t("replay.integrity.rules")}</span><strong>{t("replay.integrity.ruleRevisions", { fee: review.projection.rules.fee_policy.revision, leverage: review.projection.rules.leverage_policy.revision, funding: review.projection.rules.funding_policy.revision })}</strong></div>
                  <div><span>{t("replay.integrity.drawing")}</span><strong>{t("replay.integrity.drawingRevision", { revision: review.projection.drawing_revision, hash: review.projection.drawing_document_hash ?? t("replay.integrity.empty") })}</strong></div>
                </div>
                <section className="replay-review-liquidations" aria-label={t("replay.integrity.reviewLiq")}>
                  <h4>{t("replay.integrity.liqHeading")}</h4>
                  <ReplayLiquidationTimeline cases={review.projection.liquidations} />
                </section>
                <div className="replay-review-timeline" aria-label={t("replay.integrity.timeline")}>
                  {review.events.map((event) => (
                    <button
                      type="button"
                      key={event.event_id}
                      className={event.event_id === review.selected_event_id ? "active" : ""}
                      data-review-event-category={event.category}
                      onClick={() => void integrityRuntime.actions.controlReview("JUMP", { eventId: event.event_id })}
                      disabled={busy}
                    >
                      <strong>#{event.timeline_sequence} {event.event_type}</strong>
                      <span>{event.public_time.label} · {event.category}</span>
                      {event.detail?.text !== undefined && <span>{String(event.detail.text)}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
            {integrityRuntime.forked !== null && (
              <div className="replay-review-fork-result" role="status">
                <strong>{t("replay.integrity.forked")}</strong>
                <code>{integrityRuntime.forked.run.state_hash}</code>
                <span>{t("replay.integrity.forkSummary", { tracks: integrityRuntime.forked.tracks.length, sequence: integrityRuntime.forked.parent_timeline_sequence })}</span>
                {integrityRuntime.forked.account_audit !== null && <span>{t("replay.integrity.exactAuditor", { status: String(integrityRuntime.forked.account_audit.status ?? "--") })}</span>}
                <a href={`/replay.html?run=${encodeURIComponent(integrityRuntime.forked.run.run_id)}`}>
                  {t("replay.integrity.openChild")}
                </a>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
