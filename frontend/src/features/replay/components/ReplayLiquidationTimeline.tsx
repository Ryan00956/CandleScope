import type { ReplayLiquidationCase } from "../replayV2Types.js";

export interface ReplayLiquidationTimelineProps {
  readonly cases: readonly ReplayLiquidationCase[];
  readonly formatVirtualTime?: ((value: number) => string) | undefined;
  readonly emptyLabel?: string | undefined;
}

function amount(value: string | null, digits = 8): string {
  if (value === null) return "--";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export default function ReplayLiquidationTimeline({
  cases,
  formatVirtualTime,
  emptyLabel = "暂无模拟账户强平",
}: ReplayLiquidationTimelineProps) {
  if (cases.length === 0) {
    return <div className="replay-account-empty compact calm">{emptyLabel}</div>;
  }
  return (
    <div className="replay-liquidation-timeline" data-replay-timeline="liquidation">
      {cases.map((item) => (
        <details className="replay-liquidation-case" key={item.case_id} open={cases.length === 1}>
          <summary>
            <span><strong>Case #{item.case_sequence}</strong><small>{item.reason}</small></span>
            <span className="replay-chip" data-liquidation-state={item.state}>{item.state}</span>
          </summary>
          <div className="replay-liquidation-case-body">
            <p className="replay-liquidation-disclosure">
              交易所规则级确定性模拟 · {item.fidelity} · source #{item.trigger_source_sequence}
              {formatVirtualTime === undefined
                ? ""
                : ` · ${formatVirtualTime(item.trigger_virtual_time_ms)}`}
            </p>
            <div className="replay-liquidation-legs">
              {item.legs.map((leg) => (
                <article key={leg.liquidation_leg_id} data-position-side={leg.position_side.toLowerCase()}>
                  <header><strong>{leg.position_side} · {leg.track_id}</strong><span>{leg.state}</span></header>
                  <dl className="replay-metric-flat">
                    <div><dt>触发数量</dt><dd>{amount(leg.trigger_quantity)}</dd></div>
                    <div><dt>已处理</dt><dd>{amount(leg.completed_quantity)}</dd></div>
                    <div><dt>维持保证金</dt><dd>{amount(leg.maintenance_margin)}</dd></div>
                    <div><dt>强平价</dt><dd>{amount(leg.liquidation_price)}</dd></div>
                    <div><dt>破产价</dt><dd>{amount(leg.bankruptcy_price)}</dd></div>
                    <div><dt>接管价</dt><dd>{amount(leg.takeover_price)}</dd></div>
                    <div className="wide"><dt>强平费</dt><dd>{amount(leg.liquidation_fee)}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
            <div className="replay-liquidation-steps">
              {item.steps.map((step) => (
                <details key={`${item.case_id}:${step.step_sequence}`} open={step.state === "FAILED_CLOSED"}>
                  <summary>
                    <span>Step {step.step_sequence} · {step.step_type}</span>
                    <span data-liquidation-step-state={step.state}>{step.state}</span>
                  </summary>
                  <p>{step.reason}</p>
                  {step.book_execution !== null && (
                    <p className="replay-liquidation-disclosure">
                      L2 {step.book_execution.execution_fidelity} · {step.book_execution.levels.length} 档
                      · 可见 {amount(step.book_execution.visible_quantity)} · queue exact: false
                    </p>
                  )}
                  {step.orders.map((order) => (
                    <article className="replay-liquidation-order" key={order.order_id}>
                      <header>
                        <strong>{order.side} {order.order_type}</strong>
                        <span>{order.state} · {amount(order.filled_quantity)}/{amount(order.requested_quantity)}</span>
                      </header>
                      {order.fills.map((fill) => (
                        <dl className="replay-liquidation-fill" key={fill.fill_id}>
                          <div><dt>成交</dt><dd>{amount(fill.quantity)} @ {amount(fill.price)}</dd></div>
                          <div><dt>档位</dt><dd>{fill.book_level ?? "--"}</dd></div>
                          <div><dt>交易费</dt><dd>{amount(fill.trading_fee)}</dd></div>
                          <div><dt>强平费</dt><dd>{amount(fill.liquidation_fee)}</dd></div>
                        </dl>
                      ))}
                    </article>
                  ))}
                  {step.insurance_postings.map((posting) => (
                    <article className="replay-liquidation-posting" key={posting.posting_id}>
                      <strong>Insurance · {posting.asset}</strong>
                      <span>{amount(posting.cash_delta)} → {amount(posting.balance_after)}</span>
                      <small>{posting.reason}</small>
                    </article>
                  ))}
                  {step.adl_events.map((event) => (
                    <article className="replay-liquidation-adl" key={event.adl_event_id}>
                      <header><strong>ADL · {event.state}</strong><span>{amount(event.completed_notional)}/{amount(event.required_notional)}</span></header>
                      {event.selections.map((selection) => (
                        <div key={selection.candidate_id}>
                          <span>#{selection.selection_sequence} {selection.candidate_id}</span>
                          <span>{amount(selection.quantity)} @ {amount(selection.price)}</span>
                        </div>
                      ))}
                      <small>对手方账本 {event.counterparty_ledger.length} 条 · 确定性模拟，不代表历史交易所私有队列</small>
                    </article>
                  ))}
                </details>
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
