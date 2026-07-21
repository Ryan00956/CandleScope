import { useMemo, useState } from "react";
import {
  formatReplayPublicTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayOwnsController,
} from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

function orderClientId(): string {
  return `ticket-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.trunc(Math.random() * 1_000_000)}`}`;
}

export interface ReplayRightRailProps {
  readonly runtime: ReplayRuntime;
  readonly indicatorStatus: {
    readonly mode: string;
    readonly sourceBarCount: number;
    readonly disabledCapabilities: readonly string[];
  };
}

export function ReplayPaperTradingDock({ runtime, indicatorStatus }: ReplayRightRailProps) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET">("MARKET");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [journalText, setJournalText] = useState("");
  const store = runtime.store;
  const config = store.sessionConfig;
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const commandReady = ownsController
    && store.connectionState === "connected"
    && runtime.pendingCommand === null
    && !runtime.forkPending
    && store.state !== "ENDED";
  const openOrders = useMemo(() => store.orders.filter((order) => !TERMINAL_ORDER_STATES.has(order.status)), [store.orders]);
  // Reports fill the active-session closed-trade gap between atomic snapshots.
  // The lifecycle invalidates them on every reset generation and only accepts
  // responses bound to the current generation.
  const closedTrades = runtime.report?.report.closed_trades ?? store.closedTrades;
  const recentFills = useMemo(() => recentReplayActivity(store.fills), [store.fills]);
  const recentClosedTrades = useMemo(() => recentReplayActivity(closedTrades), [closedTrades]);
  const recentJournal = useMemo(() => recentReplayActivity(store.journal), [store.journal]);
  const warningCount = store.warnings.length;
  const time = (value: number) => formatReplayPublicTime(value, {
    blindMode: config?.blind_mode ?? true,
    originMs: store.replayStartMs,
  });

  return (
    <>
      {warningCount > 0 && (
        <section className="replay-ambiguity-warning" role="alert" data-replay-warning-count={warningCount}>
          <strong>保守执行警告 · {warningCount}</strong>
          <p>BAR 内路径不唯一；系统采用最不利路径，结果不代表可获得的真实逐笔成交。</p>
          {store.warnings.slice(-3).map((warning) => <div key={warning.warning_id}>{warning.code}: {warning.message}</div>)}
        </section>
      )}

      <section className="replay-rail-section" data-replay-panel="account">
        <h2>训练账户</h2>
        <dl className="replay-metrics-grid">
          <div><dt>Equity</dt><dd>{store.account?.equity ?? "--"} {store.account?.quote_asset ?? ""}</dd></div>
          <div><dt>Available</dt><dd>{store.account?.available_equity ?? "--"}</dd></div>
          <div><dt>Reserved</dt><dd>{store.account?.reserved_margin ?? "--"}</dd></div>
          <div><dt>Realized PnL</dt><dd>{store.account?.realized_pnl ?? "--"}</dd></div>
          <div><dt>Unrealized PnL</dt><dd>{store.account?.unrealized_pnl ?? "--"}</dd></div>
          <div><dt>Fees</dt><dd>{store.account?.fees_paid ?? "--"}</dd></div>
        </dl>
      </section>

      <section className="replay-rail-section" data-replay-panel="position">
        <h2>当前持仓</h2>
        <dl className="replay-metrics-grid">
          <div><dt>Quantity</dt><dd>{store.position?.quantity ?? "0"}</dd></div>
          <div><dt>Entry</dt><dd>{store.position?.entry_price ?? "--"}</dd></div>
          <div><dt>Mark</dt><dd>{store.position?.mark_price ?? "--"}</dd></div>
          <div><dt>Liquidation</dt><dd>BAR v1 不支持</dd></div>
        </dl>
        <button
          type="button"
          data-replay-action="close-position"
          disabled={!commandReady || store.position?.quantity === "0"}
          onClick={() => void runtime.actions.submitCommand("close_position", { quantity: null }).catch(() => undefined)}
        >按下一已揭示执行机会平仓</button>
      </section>

      <section className="replay-rail-section replay-order-ticket" data-replay-panel="order-ticket">
        <h2>Paper order ticket</h2>
        <div className="replay-segmented">
          <button type="button" className={side === "BUY" ? "active" : ""} onClick={() => setSide("BUY")}>BUY</button>
          <button type="button" className={side === "SELL" ? "active" : ""} onClick={() => setSide("SELL")}>SELL</button>
        </div>
        <label>类型
          <select value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}>
            <option>MARKET</option><option>LIMIT</option><option>STOP_MARKET</option><option>TAKE_PROFIT_MARKET</option>
          </select>
        </label>
        <label>数量<input data-replay-field="order-quantity" value={quantity} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} /></label>
        {orderType !== "MARKET" && <label>{orderType === "LIMIT" ? "限价" : "触发价"}<input data-replay-field="order-price" value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} /></label>}
        <label className="replay-checkbox-field"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} />Reduce only</label>
        <button
          type="button"
          data-replay-action="place-order"
          disabled={!commandReady || !quantity.trim() || (orderType !== "MARKET" && !price.trim())}
          onClick={() => void runtime.actions.submitCommand("place_order", {
            client_order_id: orderClientId(),
            side,
            order_type: orderType,
            quantity,
            reduce_only: reduceOnly,
            limit_price: orderType === "LIMIT" ? price : null,
            stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET" ? price : null,
          }).catch(() => undefined)}
        >提交纸面委托</button>
        <small>前端不预生成成交；风险、价格步长与成交由服务端权威校验。</small>
      </section>

      <section className="replay-rail-section" data-replay-panel="open-orders">
        <h2>Open orders · {openOrders.length}</h2>
        {openOrders.length === 0 ? <p className="replay-empty">暂无未成交委托</p> : openOrders.map((order) => (
          <article className="replay-list-card" key={order.order_id}>
            <strong>{order.side} {order.order_type}</strong><span>{order.quantity} @ {order.limit_price ?? order.stop_price ?? "next open"}</span>
            <span>{order.status} · filled {order.filled_quantity}</span>
            <button type="button" disabled={!commandReady} onClick={() => void runtime.actions.submitCommand("cancel_order", { order_id: order.order_id }).catch(() => undefined)}>取消</button>
          </article>
        ))}
      </section>

      <section className="replay-rail-section" data-replay-panel="fills">
        <h2>Fills · {store.fills.length}</h2>
        {store.fills.length > REPLAY_ACTIVITY_VIEW_LIMIT && <small data-replay-recent-window="fills">仅显示最近 {REPLAY_ACTIVITY_VIEW_LIMIT} 条；完整记录见报告导出。</small>}
        {store.fills.length === 0 ? <p className="replay-empty">等待下一已揭示执行机会</p> : recentFills.map((fill) => (
          <article className="replay-list-card" key={fill.fill_id} data-replay-fill={fill.fill_id}>
            <strong>{fill.side} {fill.quantity} @ {fill.price}</strong>
            <span>{fill.reason} · fee {fill.fee}</span><span>{time(fill.event_time_ms)}</span>
          </article>
        ))}
      </section>

      <section className="replay-rail-section" data-replay-panel="closed-trades">
        <h2>Closed trades · {closedTrades.length}</h2>
        {closedTrades.length > REPLAY_ACTIVITY_VIEW_LIMIT && <small data-replay-recent-window="closed-trades">仅显示最近 {REPLAY_ACTIVITY_VIEW_LIMIT} 条；完整记录见报告导出。</small>}
        {closedTrades.length === 0 ? <p className="replay-empty">暂无已平仓交易</p> : recentClosedTrades.map((trade) => (
          <article className="replay-list-card" key={trade.trade_id}><strong>{trade.side} · PnL {trade.realized_pnl}</strong><span>{trade.entry_price} → {trade.exit_price}</span></article>
        ))}
      </section>

      <section className="replay-rail-section" data-replay-panel="journal">
        <h2>训练日志</h2>
        <textarea value={journalText} maxLength={4000} placeholder="记录当前判断；内容绑定虚拟时间。" onChange={(event) => setJournalText(event.target.value)} />
        <button
          type="button"
          disabled={!ownsController || !journalText.trim() || runtime.pendingCommand !== null || runtime.forkPending}
          onClick={() => {
            const text = journalText.trim();
            setJournalText("");
            void runtime.actions.submitCommand("add_journal_note", { text }).catch(() => setJournalText(text));
          }}
        >添加日志</button>
        {store.journal.length > REPLAY_ACTIVITY_VIEW_LIMIT && <small data-replay-recent-window="journal">仅显示最近 {REPLAY_ACTIVITY_VIEW_LIMIT} 条；完整记录见报告导出。</small>}
        {recentJournal.map((entry) => <article className="replay-list-card" key={entry.entry_id}><span>{time(entry.virtual_time_ms)}</span><p>{entry.text}</p></article>)}
      </section>

      <section className="replay-rail-section replay-indicator-boundary" data-replay-panel="indicators">
        <h2>本地指标</h2>
        <p>SMA 20 · 仅 {indicatorStatus.sourceBarCount} 根已揭示 bars。</p>
        <p>Hosted / range / security 指标已禁用：回放页不会请求后端或未来窗口。</p>
      </section>
    </>
  );
}

export default function ReplayRightRail(props: ReplayRightRailProps) {
  return (
    <aside className="replay-right-rail" aria-label="回放训练账户与纸面交易">
      <ReplayPaperTradingDock {...props} />
    </aside>
  );
}
