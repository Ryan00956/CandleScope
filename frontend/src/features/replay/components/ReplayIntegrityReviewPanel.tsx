import { useMemo, useState } from "react";

import { buildEquityPolyline } from "../replayIntegrityModel.js";
import { downloadReplayTrainingReport } from "../replayReportExport.js";
import { replayOwnsController } from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayIntegrityRuntime } from "../useReplayIntegrityRuntime.js";

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
      <section className="replay-integrity-panel" data-replay-panel="integrity" aria-label="训练完整性">
        <header className="replay-integrity-heading">
          <div>
            <span className="training-hub-kicker">服务端校验 · 只读证据</span>
            <h2>完整性与复盘</h2>
          </div>
          {onClose !== undefined && (
            <button type="button" data-replay-action="close-integrity" onClick={onClose}>
              关闭
            </button>
          )}
        </header>
        <p role="status">正在加载服务端完整性与权益证据…</p>
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
          <span className="training-hub-kicker">服务端校验 · 只读证据</span>
          <h2 id="replay-integrity-title">完整性与复盘</h2>
        </div>
        <div className="replay-integrity-heading-actions">
          <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.refresh()}>
            刷新
          </button>
          {onClose !== undefined && (
            <button type="button" data-replay-action="close-integrity" onClick={onClose}>
              关闭
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
            <div><span>模式</span><strong>{integrity.integrity_mode}</strong></div>
            <div><span>结果标签</span><strong>{integrity.result_label}</strong></div>
            <div><span>公开时间</span><strong data-public-time-label>{integrity.public_time.label}</strong></div>
            <div><span>披露策略</span><strong>{integrity.effective_time_disclosure_policy}</strong></div>
            <div><span>严格资格</span><strong>{integrity.strict_eligible ? "ELIGIBLE" : "NOT STRICT"}</strong></div>
            <div><span>起点已知</span><strong>{integrity.start_time_known ? "YES" : "NO"}</strong></div>
          </div>

          <div className="replay-integrity-grid">
            <section aria-labelledby="replay-equity-title">
              <div className="replay-integrity-section-heading">
                <h3 id="replay-equity-title">有界权益曲线</h3>
                <span>{integrityRuntime.equity?.resolution ?? "--"} · {integrityRuntime.equity?.samples.length ?? 0} samples</span>
              </div>
              <svg
                className="replay-equity-chart"
                viewBox="0 0 420 112"
                role="img"
                aria-label="服务端账本权益曲线"
                preserveAspectRatio="none"
              >
                <polyline points={equityPoints} fill="none" vectorEffect="non-scaling-stroke" />
              </svg>
              <p>EVENT / 1M / 15M / 1H 由服务端限额保留；数值保持 Decimal 字符串。</p>
            </section>

            <section aria-labelledby="replay-policy-title">
              <div className="replay-integrity-section-heading">
                <h3 id="replay-policy-title">可审计规则动作</h3>
                <span>{integrity.allowed_mutations.length === 0 ? "LOCKED" : integrity.allowed_mutations.join(" · ")}</span>
              </div>
              {(allowed.has("deposit") || allowed.has("withdraw")) && (
                <div className="replay-capital-controls">
                  <label>金额<input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} /></label>
                  <label>原因<input value={reason} maxLength={512} onChange={(event) => setReason(event.target.value)} /></label>
                  <div>
                    {allowed.has("deposit") && <button type="button" disabled={!canCapital} onClick={() => submitCapital("deposit")}>审计入金</button>}
                    {allowed.has("withdraw") && <button type="button" disabled={!canCapital} onClick={() => submitCapital("withdraw")}>审计出金</button>}
                  </div>
                </div>
              )}
              {!integrity.revealed && (
                <button
                  className="replay-reveal-time"
                  type="button"
                  data-replay-action="reveal-time"
                  disabled={!canReveal}
                  title={ownsController ? "不可逆揭示；服务端将降级结果标签并写审计事件" : "先获取 controller lease"}
                  onClick={() => {
                    if (window.confirm("时间揭示不可逆，并会永久写入审计与结果标签。继续吗？")) {
                      void integrityRuntime.actions.revealTime(reason).catch(() => undefined);
                    }
                  }}
                >不可逆揭示时间</button>
              )}
              {integrity.revealed && <p className="replay-revealed">时间已揭示；该状态不可回退。</p>}
              <p>所有动作由服务端按当前组合 VirtualTime 原子生效；ReviewMode 内完全锁定原 Run。</p>
            </section>
          </div>

          <section className="replay-run-rules" aria-labelledby="replay-run-rules-title">
            <div className="replay-integrity-section-heading">
              <div>
                <h3 id="replay-run-rules-title">训练规则</h3>
                <p>交易所规则不可变；用户杠杆上限是独立 overlay，实际值取二者较小值。</p>
              </div>
              <span>{rules === null ? "LOADING" : `${rules.history.length} revisions`}</span>
            </div>
            {rules !== null && (
              <>
                <div className="replay-rule-current">
                  <div><span>Maker / Taker</span><strong>{rules.fee_policy.maker_fee_bps} / {rules.fee_policy.taker_fee_bps} bps</strong></div>
                  <div><span>用户杠杆上限</span><strong>{rules.leverage_policy.max_leverage}×</strong></div>
                  <div><span>资金费</span><strong>{rules.funding_policy.funding_mode}</strong></div>
                  <div><span>交易所规则</span><strong>{rules.instrument_rules.length} immutable</strong></div>
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
                    <strong>手续费 revision</strong>
                    <label>Maker bps<input inputMode="decimal" value={makerFeeBps} placeholder={rules.fee_policy.maker_fee_bps} onChange={(event) => setMakerFeeBps(event.target.value)} /></label>
                    <label>Taker bps<input inputMode="decimal" value={takerFeeBps} placeholder={rules.fee_policy.taker_fee_bps} onChange={(event) => setTakerFeeBps(event.target.value)} /></label>
                    <button type="submit" disabled={!canMutateRules || !allowed.has("change_fee_policy")}>提交</button>
                  </form>
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void integrityRuntime.actions.changeLeverageCap(
                      maxLeverage || rules.leverage_policy.max_leverage,
                      reason,
                    ).catch(() => undefined);
                  }}>
                    <strong>杠杆 overlay</strong>
                    <label>最高倍数<input inputMode="decimal" value={maxLeverage} placeholder={rules.leverage_policy.max_leverage} onChange={(event) => setMaxLeverage(event.target.value)} /></label>
                    <span>{Object.entries(rules.effective_leverage_by_track).map(([track, value]) => `${track}=${value}×`).join(" · ")}</span>
                    <button type="submit" disabled={!canMutateRules || !allowed.has("change_leverage_cap")}>提交</button>
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
                    <strong>Sandbox 资金费</strong>
                    <label>模式<select value={fundingMode} onChange={(event) => setFundingMode(event.target.value as "OFF" | "SANDBOX_FIXED")}><option value="OFF">OFF</option><option value="SANDBOX_FIXED">SANDBOX_FIXED</option></select></label>
                    <label>费率<input inputMode="decimal" disabled={fundingMode === "OFF"} value={fixedFundingRate} onChange={(event) => setFixedFundingRate(event.target.value)} /></label>
                    <label>周期 ms<input inputMode="numeric" disabled={fundingMode === "OFF"} value={fundingIntervalMs} onChange={(event) => setFundingIntervalMs(event.target.value)} /></label>
                    <button
                      type="submit"
                      title={fundingPolicyValid ? "提交服务端规则 revision" : "固定资金费仅支持 Sandbox，周期须为 60,000 ms 到 30 天"}
                      disabled={!canMutateRules || !allowed.has("change_funding_policy") || !fundingPolicyValid}
                    >提交</button>
                  </form>
                </div>
                <label className="replay-rule-reason">规则变更原因<input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
                <div className="replay-rule-history" aria-label="规则历史">
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
              <h3 id="replay-review-budget-title">完整复盘预算</h3>
              <strong>{budget === null ? "--" : `${Math.round(budgetPressure * 100)}% peak`}</strong>
            </div>
            {budget !== null && (
              <div className="replay-budget-grid">
                <span>关键事件 {budget.critical_events} / {budget.critical_event_limit}</span>
                <span>Viewport {budget.viewport_samples} / {budget.viewport_sample_limit}</span>
                <span>Anchor {Math.round(budget.anchor_used_bytes / 1_048_576)} / {Math.round(budget.anchor_limit_bytes / 1_048_576)} MiB</span>
                <span>Artifact {Math.round(budget.artifact_used_bytes / 1_048_576)} / {Math.round(budget.artifact_limit_bytes / 1_048_576)} MiB</span>
              </div>
            )}
            {budgetPressure >= 0.85 && <p role="alert">复盘证据预算接近上限；达到硬上限后服务端会拒绝关键动作，不会静默丢事件。</p>}
          </section>

          <section className="replay-integrity-audit" aria-labelledby="replay-audit-title">
            <div className="replay-integrity-section-heading">
              <h3 id="replay-audit-title">不可变审计事件</h3>
              <span>{integrity.mutations.length}</span>
            </div>
            {integrity.mutations.length === 0 ? <p>尚无策略变更。</p> : (
              <div className="replay-integrity-audit-list">
                {integrity.mutations.slice(-20).map((mutation) => (
                  <article key={mutation.event_id} data-audit-event={mutation.event_type}>
                    <strong>{mutation.event_type}</strong>
                    <span>{mutation.public_time.label} · rule r{mutation.rule_revision}</span>
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
                <h3 id="replay-phase4-report-title">固化报告</h3>
                <code>{report.report.report_hash}</code>
                <div className="replay-report-actions">
                  <button type="button" onClick={() => downloadReplayTrainingReport(report, "json")}>导出 JSON</button>
                  <button type="button" onClick={() => downloadReplayTrainingReport(report, "csv")}>导出 CSV</button>
                </div>
              </div>
              <div className="replay-integrity-summary">
                <div><span>Final equity</span><strong>{report.report.final_equity}</strong></div>
                <div><span>Realized PnL</span><strong>{report.report.realized_pnl}</strong></div>
                <div><span>Fees</span><strong>{report.report.fees_paid}</strong></div>
                <div><span>Trades</span><strong>{report.report.trade_count}</strong></div>
                {report.modelled_account.schema_version === "replay.training.portfolio.v2" && (
                  <>
                    <div>
                      <span>Account inputs</span>
                      <strong>{report.modelled_account.account_history.mode}</strong>
                    </div>
                    <div>
                      <span>Account audit</span>
                      <strong data-account-auditor-status={report.modelled_account.account_history.auditor.status}>
                        {report.modelled_account.account_history.auditor.status}
                      </strong>
                    </div>
                    <div>
                      <span>模拟账户强平</span>
                      <strong>{report.modelled_account.liquidations.length}</strong>
                    </div>
                    <div>
                      <span>历史市场爆仓</span>
                      <strong>{report.modelled_account.liquidation_channels.historical_market.fidelity}</strong>
                    </div>
                  </>
                )}
              </div>
              {report.account_audit !== null && (
                <p>
                  独立账户审计：<strong>{report.account_audit.status}</strong>
                  {" · "}<code>{report.account_audit.proof_hash}</code>
                </p>
              )}
            </section>
          )}

          <section className="replay-review" aria-labelledby="replay-review-title" data-review-read-only={String(review?.read_only ?? false)}>
            <div className="replay-integrity-section-heading">
              <div><h3 id="replay-review-title">只读复盘</h3><p>独立持久游标、只读组合和回放专属绘图；原训练不会被移动。</p></div>
              <button
                type="button"
                disabled={busy || (review === null && !reviewStartReady)}
                title={review === null && !reviewStartReady
                  ? "先暂停训练，确保 ReviewMode 的原 Run 不再推进"
                  : "ReviewMode 只移动独立持久游标"}
                onClick={() => {
                if (review === null) void integrityRuntime.actions.startReview();
                else integrityRuntime.actions.closeReview();
              }}
              >
                {review === null ? "开始只读复盘" : "退出只读复盘"}
              </button>
            </div>
            {review === null && (
              <form className="replay-marker-form" onSubmit={(event) => {
                event.preventDefault();
                void integrityRuntime.actions.addMarker(markerText).then(() => {
                  setMarkerText("");
                }).catch(() => undefined);
              }}>
                <label>手工复盘标记<input value={markerText} maxLength={500} placeholder="例如：突破确认后开仓" onChange={(event) => setMarkerText(event.target.value)} /></label>
                <button type="submit" disabled={busy || markerText.trim().length === 0}>记录到不可变时间线</button>
              </form>
            )}
            {review !== null && (
              <>
                <div className="replay-review-controls" role="group" aria-label="ReviewMode 播放控制">
                  <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.controlReview("PREVIOUS")}>上一事件</button>
                  <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.controlReview("NEXT")}>下一事件</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void integrityRuntime.actions.controlReview(
                      review.playback_state === "PLAYING" ? "PAUSE" : "PLAY",
                      { playbackRate },
                    )}
                  >{review.playback_state === "PLAYING" ? "暂停" : "播放"}</button>
                  <label>速度
                    <select value={playbackRate} onChange={(event) => setPlaybackRate(event.target.value as typeof playbackRate)}>
                      {(["0.25", "0.5", "1", "2", "4", "8"] as const).map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
                    </select>
                  </label>
                  <label>
                    持久事件
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
                  >跳转</button>
                  <button
                    type="button"
                    disabled={busy || effectiveSelectedEventId === null}
                    onClick={() => effectiveSelectedEventId !== null && void integrityRuntime.actions.forkReview(effectiveSelectedEventId)}
                  >从该事件创建新训练</button>
                </div>
                <div className="replay-review-proof" data-review-verified={String(review.immutability_proof.verified)}>
                  <strong>原 Run 未变化 · VERIFIED</strong>
                  <code>original {review.original_state_hash}</code>
                  <code>selected {review.selected_state_hash}</code>
                  <code>account {review.immutability_proof.original_account_hash}</code>
                  <code>ledger {review.immutability_proof.original_ledger_tail_hash}</code>
                </div>
                <div className="replay-review-projection" aria-label="选中事件只读投影">
                  <div><span>Timeline</span><strong>#{review.selected_timeline_sequence} · cursor r{review.cursor_revision}</strong></div>
                  <div><span>Viewer</span><strong>{String(review.projection.viewer_state.selected_track_id)} · {String(review.projection.viewer_state.display_interval)}</strong></div>
                  <div><span>Orders / Fills</span><strong>{review.projection.orders.length} / {review.projection.fills.length}</strong></div>
                  <div><span>Ledger / Liquidations</span><strong>{review.projection.ledger.length} / {review.projection.liquidations.length}</strong></div>
                  <div><span>Rules</span><strong>fee r{review.projection.rules.fee_policy.revision} · leverage r{review.projection.rules.leverage_policy.revision} · funding r{review.projection.rules.funding_policy.revision}</strong></div>
                  <div><span>Drawing</span><strong>r{review.projection.drawing_revision} · {review.projection.drawing_document_hash ?? "empty"}</strong></div>
                </div>
                <div className="replay-review-timeline" aria-label="不可变复盘时间线">
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
                <strong>新训练已从不可变事件创建</strong>
                <code>{integrityRuntime.forked.run.state_hash}</code>
                <span>{integrityRuntime.forked.tracks.length} tracks · event #{integrityRuntime.forked.parent_timeline_sequence}</span>
                {integrityRuntime.forked.account_audit !== null && <span>Exact account auditor: {String(integrityRuntime.forked.account_audit.status ?? "--")}</span>}
                <a href={`/replay.html?run=${encodeURIComponent(integrityRuntime.forked.run.run_id)}`}>
                  打开子训练
                </a>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
