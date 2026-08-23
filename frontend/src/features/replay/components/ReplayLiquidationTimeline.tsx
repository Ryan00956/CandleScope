import { t, type LocaleId } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { ReplayLiquidationCase } from "../replayV2Types.js";

export interface ReplayLiquidationTimelineProps {
  readonly cases: readonly ReplayLiquidationCase[];
  readonly formatVirtualTime?: ((value: number) => string) | undefined;
  readonly emptyLabel?: string | undefined;
}

function amount(value: string | null, locale: LocaleId, digits = 8): string {
  if (value === null) return "--";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(locale, { maximumFractionDigits: digits });
}

export default function ReplayLiquidationTimeline({
  cases,
  formatVirtualTime,
  emptyLabel,
}: ReplayLiquidationTimelineProps) {
  const locale = useLocale();
  if (cases.length === 0) {
    return <div className="replay-account-empty compact calm">{emptyLabel ?? t("replay.liq.empty")}</div>;
  }
  return (
    <div className="replay-liquidation-timeline" data-replay-timeline="liquidation">
      {cases.map((item) => (
        <details className="replay-liquidation-case" key={item.case_id} open={cases.length === 1}>
          <summary>
            <span><strong>{t("replay.liq.case", { sequence: item.case_sequence })}</strong><small>{item.reason}</small></span>
            <span className="replay-chip" data-liquidation-state={item.state}>{item.state}</span>
          </summary>
          <div className="replay-liquidation-case-body">
            <p className="replay-liquidation-disclosure">
              {t("replay.liq.disclosure", { fidelity: item.fidelity, sequence: item.trigger_source_sequence })}
              {formatVirtualTime === undefined
                ? ""
                : ` · ${formatVirtualTime(item.trigger_virtual_time_ms)}`}
            </p>
            <div className="replay-liquidation-legs">
              {item.legs.map((leg) => (
                <article key={leg.liquidation_leg_id} data-position-side={leg.position_side.toLowerCase()}>
                  <header><strong>{leg.position_side} · {leg.track_id}</strong><span>{leg.state}</span></header>
                  <dl className="replay-metric-flat">
                    <div><dt>{t("replay.liq.triggerQty")}</dt><dd>{amount(leg.trigger_quantity, locale)}</dd></div>
                    <div><dt>{t("replay.liq.completed")}</dt><dd>{amount(leg.completed_quantity, locale)}</dd></div>
                    <div><dt>{t("replay.liq.mm")}</dt><dd>{amount(leg.maintenance_margin, locale)}</dd></div>
                    <div><dt>{t("replay.liq.liqPrice")}</dt><dd>{amount(leg.liquidation_price, locale)}</dd></div>
                    <div><dt>{t("replay.liq.bankruptcy")}</dt><dd>{amount(leg.bankruptcy_price, locale)}</dd></div>
                    <div><dt>{t("replay.liq.takeover")}</dt><dd>{amount(leg.takeover_price, locale)}</dd></div>
                    <div className="wide"><dt>{t("replay.liq.fee")}</dt><dd>{amount(leg.liquidation_fee, locale)}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
            <div className="replay-liquidation-steps">
              {item.steps.map((step) => (
                <details key={`${item.case_id}:${step.step_sequence}`} open={step.state === "FAILED_CLOSED"}>
                  <summary>
                    <span>{t("replay.liq.step", { sequence: step.step_sequence, type: step.step_type })}</span>
                    <span data-liquidation-step-state={step.state}>{step.state}</span>
                  </summary>
                  <p>{step.reason}</p>
                  {step.book_execution !== null && (
                    <p className="replay-liquidation-disclosure">
                      {t("replay.liq.l2", {
                        fidelity: step.book_execution.execution_fidelity,
                        levels: step.book_execution.levels.length,
                        qty: amount(step.book_execution.visible_quantity, locale),
                      })}
                    </p>
                  )}
                  {step.orders.map((order) => (
                    <article className="replay-liquidation-order" key={order.order_id}>
                      <header>
                        <strong>{order.side} {order.order_type}</strong>
                        <span>{order.state} · {amount(order.filled_quantity, locale)}/{amount(order.requested_quantity, locale)}</span>
                      </header>
                      {order.fills.map((fill) => (
                        <dl className="replay-liquidation-fill" key={fill.fill_id}>
                          <div><dt>{t("replay.liq.fill")}</dt><dd>{amount(fill.quantity, locale)} @ {amount(fill.price, locale)}</dd></div>
                          <div><dt>{t("replay.liq.level")}</dt><dd>{fill.book_level ?? "--"}</dd></div>
                          <div><dt>{t("replay.liq.tradingFee")}</dt><dd>{amount(fill.trading_fee, locale)}</dd></div>
                          <div><dt>{t("replay.liq.fee")}</dt><dd>{amount(fill.liquidation_fee, locale)}</dd></div>
                        </dl>
                      ))}
                    </article>
                  ))}
                  {step.insurance_postings.map((posting) => (
                    <article className="replay-liquidation-posting" key={posting.posting_id}>
                      <strong>{t("replay.liq.insurance", { asset: posting.asset })}</strong>
                      <span>{amount(posting.cash_delta, locale)} → {amount(posting.balance_after, locale)}</span>
                      <small>{posting.reason}</small>
                    </article>
                  ))}
                  {step.adl_events.map((event) => (
                    <article className="replay-liquidation-adl" key={event.adl_event_id}>
                      <header><strong>{t("replay.liq.adl", { state: event.state })}</strong><span>{amount(event.completed_notional, locale)}/{amount(event.required_notional, locale)}</span></header>
                      {event.selections.map((selection) => (
                        <div key={selection.candidate_id}>
                          <span>#{selection.selection_sequence} {selection.candidate_id}</span>
                          <span>{amount(selection.quantity, locale)} @ {amount(selection.price, locale)}</span>
                        </div>
                      ))}
                      <small>{t("replay.liq.adlHint", { count: event.counterparty_ledger.length })}</small>
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
