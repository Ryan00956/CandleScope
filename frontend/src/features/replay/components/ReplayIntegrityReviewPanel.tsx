import { useMemo, useState } from "react";

import { buildEquityPolyline } from "../replayIntegrityModel.js";
import { downloadReplayTrainingReport } from "../replayReportExport.js";
import { replayOwnsController } from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayIntegrityRuntime } from "../useReplayIntegrityRuntime.js";

export interface ReplayIntegrityReviewPanelProps {
  readonly runtime: ReplayRuntime;
  readonly integrityRuntime: ReplayIntegrityRuntime;
}

function AuditValue({ value }: { readonly value: Readonly<Record<string, unknown>> }) {
  return <code>{JSON.stringify(value)}</code>;
}

export default function ReplayIntegrityReviewPanel({
  runtime,
  integrityRuntime,
}: ReplayIntegrityReviewPanelProps) {
  const [amount, setAmount] = useState("100");
  const [reason, setReason] = useState("training adjustment");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const integrity = integrityRuntime.integrity;
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
  const canCapital = ownsController && !busy && runtime.store.state !== "ENDED";
  const canReveal = ownsController && !busy && integrity !== null && !integrity.revealed
    && (runtime.store.state === "ENDED" || allowed.has("reveal_time"));
  const submitCapital = (kind: "deposit" | "withdraw") => {
    const action = kind === "deposit"
      ? integrityRuntime.actions.deposit
      : integrityRuntime.actions.withdraw;
    void action(amount, reason).catch(() => undefined);
  };

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
          <span className="training-hub-kicker">SERVER-AUTHORITATIVE · PHASE 6</span>
          <h2 id="replay-integrity-title">完整性与复盘</h2>
        </div>
        <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.refresh()}>
          刷新证据
        </button>
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
              <p>费率、杠杆上限与 Sandbox 固定资金费经版本化 Run command 变更并写入本审计流；本面板当前直接提供资金与时间披露操作。</p>
            </section>
          </div>

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
              </div>
            </section>
          )}

          <section className="replay-review" aria-labelledby="replay-review-title" data-review-read-only={String(review?.read_only ?? false)}>
            <div className="replay-integrity-section-heading">
              <div><h3 id="replay-review-title">ReviewMode</h3><p>只读事件跳转；原 run 的游标与状态哈希不变。</p></div>
              <button type="button" disabled={busy} onClick={() => void integrityRuntime.actions.startReview()}>
                {review === null ? "开始只读复盘" : "刷新复盘"}
              </button>
            </div>
            {review !== null && (
              <div className="replay-review-controls">
                <label>
                  持久事件
                  <select value={effectiveSelectedEventId ?? review.selected_event_id} onChange={(event) => setSelectedEventId(event.target.value)}>
                    {review.events.map((event) => (
                      <option key={event.event_id} value={event.event_id}>
                        {event.public_time.label} · {event.event_type} · seq {event.source_sequence}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || effectiveSelectedEventId === null}
                  onClick={() => effectiveSelectedEventId !== null && void integrityRuntime.actions.startReview(effectiveSelectedEventId)}
                >只读跳转</button>
                <button
                  type="button"
                  disabled={busy || effectiveSelectedEventId === null}
                  onClick={() => effectiveSelectedEventId !== null && void integrityRuntime.actions.forkReview(effectiveSelectedEventId)}
                >从该 checkpoint Fork</button>
                <code>original {review.original_state_hash}</code>
                <code>selected {review.selected_state_hash}</code>
              </div>
            )}
            {integrityRuntime.forked !== null && (
              <div className="replay-review-fork-result" role="status">
                <strong>精确 Fork 已创建</strong>
                <code>{integrityRuntime.forked.run.state_hash}</code>
                <a href={`/replay.html?session=${encodeURIComponent(integrityRuntime.forked.run.adapter_session_id)}`}>
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
