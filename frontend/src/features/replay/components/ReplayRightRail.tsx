import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  formatReplayPublicTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayOwnsController,
} from "../replayUiModel.js";
import type {
  ReplayTrainingContractPortfolio,
  ReplayV2Json,
} from "../replayV2Types.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import { useReplayTradeFlow } from "../useReplayTradeFlow.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const RAIL_TABS = [
  ["trade", "下单"],
  ["positions", "持仓"],
  ["orders", "订单"],
  ["fills", "成交"],
  ["book", "盘口"],
  ["flow", "订单流"],
  ["risk", "账户与风险"],
  ["notes", "记录"],
] as const;

type RailTab = typeof RAIL_TABS[number][0];
type JsonRecord = Readonly<Record<string, ReplayV2Json>>;

function orderClientId(): string {
  return `ticket-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.trunc(Math.random() * 1_000_000)}`}`;
}

function recordText(record: JsonRecord, key: string, fallback = "--"): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function recordNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function contractPortfolio(value: unknown): ReplayTrainingContractPortfolio | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly schema_version?: unknown };
  return candidate.schema_version === "replay.training.portfolio.v2"
    ? value as ReplayTrainingContractPortfolio
    : null;
}

export interface ReplayRightRailProps {
  readonly runtime: ReplayRuntime;
  readonly viewer?: ReplayViewerRuntime;
  readonly indicatorStatus: {
    readonly mode: string;
    readonly sourceBarCount: number;
    readonly disabledCapabilities: readonly string[];
  };
  readonly formatTime?: (valueMs: number) => string;
}

export function ReplayPaperTradingDock({
  runtime,
  viewer,
  indicatorStatus,
  formatTime,
}: ReplayRightRailProps) {
  const [activeTab, setActiveTab] = useState<RailTab>("trade");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET">("MARKET");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [isolatedAmount, setIsolatedAmount] = useState("0");
  const [journalText, setJournalText] = useState("");
  const store = runtime.store;
  const config = store.sessionConfig;
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const commandReady = ownsController
    && store.connectionState === "connected"
    && runtime.pendingCommand === null
    && !runtime.forkPending
    && viewer?.viewerPending !== true
    && store.state !== "ENDED";
  const portfolio = viewer?.marketTracks?.portfolio ?? null;
  const contract = contractPortfolio(portfolio);
  const accountHistory = contract?.account_history ?? null;
  const selectedTrackId = viewer?.viewerState?.selected_track_id ?? "track-1";
  const selectedTrack = viewer?.marketTracks?.tracks.find((item) => item.track_id === selectedTrackId);
  const historicalBook = selectedTrack?.historical_book ?? null;
  const tradeFlow = useReplayTradeFlow({
    runId: viewer?.viewerState?.run_id ?? null,
    trackId: selectedTrackId,
    sourceKind: config?.source_kind ?? null,
    revealedSequence: store.sourceSequence,
  });
  const settlementAsset = selectedTrack?.settlement_asset ?? store.account?.quote_asset ?? "";
  const portfolioPositions = portfolio?.positions ?? [];
  const structuredOrders: readonly JsonRecord[] = contract?.orders
    ?? store.orders.map((order) => order as unknown as JsonRecord);
  const structuredFills: readonly JsonRecord[] = contract?.fills
    ?? store.fills.map((fill) => fill as unknown as JsonRecord);
  const openOrders = structuredOrders.filter(
    (order) => !TERMINAL_ORDER_STATES.has(recordText(order, "status", "OPEN")),
  );
  const recentStructuredFills = structuredFills
    .slice(-REPLAY_ACTIVITY_VIEW_LIMIT)
    .reverse();
  const closedTrades = runtime.report?.report.closed_trades ?? store.closedTrades;
  const recentClosedTrades = useMemo(() => recentReplayActivity(closedTrades), [closedTrades]);
  const recentJournal = useMemo(() => recentReplayActivity(store.journal), [store.journal]);
  const warningCount = store.warnings.length;
  const trade = (
    type: "place_order" | "cancel_order" | "close_position",
    payload: Readonly<Record<string, string | boolean | null>>,
  ) => {
    const result = viewer === undefined
      ? runtime.actions.submitCommand(type, payload)
      : viewer.actions.submitTrade(type, payload);
    void result.catch(() => undefined);
  };
  const time = (value: number) => formatTime?.(value)
    ?? formatReplayPublicTime(value, {
      blindMode: config?.blind_mode ?? true,
      originMs: store.replayStartMs,
    });
  const handleRailTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    value: RailTab,
  ) => {
    const currentIndex = RAIL_TABS.findIndex(([tab]) => tab === value);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % RAIL_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + RAIL_TABS.length) % RAIL_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = RAIL_TABS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = RAIL_TABS[nextIndex];
    if (next === undefined) return;
    const nextTab = next[0];
    setActiveTab(nextTab);
    event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelector<HTMLButtonElement>(`[data-replay-rail-tab="${nextTab}"]`)
      ?.focus();
  };

  return (
    <div className="replay-paper-trading" data-replay-paper-surface="account">
      <header
        className="replay-rail-account-strip"
        data-replay-account-model={contract?.account_model ?? "PAPER_LINEAR_V1"}
        data-replay-account-history-mode={accountHistory?.mode ?? "LEGACY"}
      >
        <div>
          <small>账户模型 · {contract === null ? "Legacy paper account" : "TOUCH_OR_TAPE_V2"}</small>
          <strong>{portfolio?.equity ?? store.account?.equity ?? "--"} {settlementAsset}</strong>
        </div>
        <span data-account-status={contract?.status ?? "ACTIVE"}>{contract?.status ?? "ACTIVE"}</span>
        {contract !== null && (
          <em>
            {accountHistory?.mode === "HISTORICAL_EXACT" ? "EXACT ACCOUNT INPUTS · " : "APPROX ACCOUNT · "}
            {historicalBook?.mode === "BOOK_ASSISTED_REQUIRED" ? "BOOK_ASSISTED · " : ""}
            不含盘口排队
          </em>
        )}
      </header>

      <nav className="replay-rail-tabs" aria-label="训练账户视图" role="tablist">
        {RAIL_TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`replay-rail-tab-${value}`}
            className={activeTab === value ? "active" : ""}
            aria-selected={activeTab === value}
            aria-controls="replay-rail-active-panel"
            tabIndex={activeTab === value ? 0 : -1}
            data-replay-rail-tab={value}
            onClick={() => setActiveTab(value)}
            onKeyDown={(event) => handleRailTabKeyDown(event, value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {warningCount > 0 && (
        <section className="replay-ambiguity-warning" role="alert" data-replay-warning-count={warningCount}>
          <strong>保守执行警告 · {warningCount}</strong>
          <p>BAR 内路径不唯一；系统采用最不利可行顺序，结果不代表真实逐笔成交。</p>
          {store.warnings.slice(-3).map((warning) => <div key={warning.warning_id}>{warning.code}: {warning.message}</div>)}
        </section>
      )}

      <div
        id="replay-rail-active-panel"
        className="replay-rail-tabpanel"
        role="tabpanel"
        aria-labelledby={`replay-rail-tab-${activeTab}`}
      >
      {activeTab === "trade" && (
        <>
          <section className="replay-rail-section" data-replay-panel="account-summary">
            <h2>账户摘要</h2>
            <dl className="replay-metrics-grid">
              <div><dt>Available</dt><dd>{portfolio?.available_equity ?? store.account?.available_equity ?? "--"}</dd></div>
              <div><dt>Margin used</dt><dd>{portfolio?.margin_used ?? store.account?.margin_used ?? "--"}</dd></div>
              <div><dt>Realized PnL</dt><dd>{portfolio?.realized_pnl ?? store.account?.realized_pnl ?? "--"}</dd></div>
              <div><dt>Unrealized PnL</dt><dd>{portfolio?.unrealized_pnl ?? store.account?.unrealized_pnl ?? "--"}</dd></div>
            </dl>
            {contract !== null && <small className="replay-account-fidelity">{contract.margin_mode} · {contract.funding_mode} · {contract.execution_fidelity}</small>}
          </section>

          <section className="replay-rail-section replay-order-ticket" data-replay-panel="order-ticket">
            <h2>纸面下单</h2>
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
              onClick={() => trade("place_order", {
                client_order_id: orderClientId(),
                side,
                order_type: orderType,
                quantity,
                reduce_only: reduceOnly,
                limit_price: orderType === "LIMIT" ? price : null,
                stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET" ? price : null,
              })}
            >{contract === null ? "提交纸面委托" : "按当前已揭示参考价提交"}</button>
            <small className="replay-order-hint">市价/穿价单立即 taker；挂单只从接受命令后的首次触价开始，不追溯成交。</small>
          </section>
        </>
      )}

      {activeTab === "positions" && (
        <section className="replay-rail-section" data-replay-panel="positions">
          <h2>持仓 · {portfolioPositions.length}</h2>
          <button
            type="button"
            data-replay-action="close-position"
            disabled={!commandReady || store.position?.quantity === "0"}
            onClick={() => trade("close_position", { quantity: null })}
          >按当前已揭示参考价平选中轨道</button>
          {portfolioPositions.length === 0 ? <p className="replay-empty">当前组合为空仓</p> : portfolioPositions.map((item) => (
            <article className="replay-list-card" key={item.track_id}>
              <strong>{item.symbol} · {String(item.position.quantity ?? "0")}</strong>
              <span>Entry {String(item.position.entry_price ?? "--")} · Mark {String(item.position.mark_price ?? "--")}</span>
              {contract !== null && <span>Maintenance {item.maintenance_margin} · Risk {item.risk_ratio ?? "--"}</span>}
              {item.mark_fidelity !== undefined && <small>{item.mark_fidelity}</small>}
            </article>
          ))}
          <h2>Closed trades · {closedTrades.length}</h2>
          {closedTrades.length === 0 ? <p className="replay-empty">暂无已平仓交易</p> : recentClosedTrades.map((item) => (
            <article className="replay-list-card" key={item.trade_id}><strong>{item.side} · PnL {item.realized_pnl}</strong><span>{item.entry_price} → {item.exit_price}</span></article>
          ))}
        </section>
      )}

      {activeTab === "orders" && (
        <section className="replay-rail-section" data-replay-panel="open-orders">
          <h2>Open orders · {openOrders.length}</h2>
          {openOrders.length === 0 ? <p className="replay-empty">暂无未成交委托</p> : openOrders.map((order, index) => {
            const orderId = recordText(order, "order_id", `order-${index}`);
            const trackId = recordText(order, "track_id", selectedTrackId);
            return (
              <article className="replay-list-card" key={`${trackId}:${orderId}`}>
                <strong>{recordText(order, "side")} {recordText(order, "order_type")}</strong>
                <span>{recordText(order, "quantity")} @ {recordText(order, "limit_price", recordText(order, "stop_price", "current reference"))}</span>
                <span>{recordText(order, "status")} · {trackId} · filled {recordText(order, "filled_quantity", "0")}</span>
                {trackId === selectedTrackId && <button type="button" disabled={!commandReady} onClick={() => trade("cancel_order", { order_id: orderId })}>取消</button>}
              </article>
            );
          })}
        </section>
      )}

      {activeTab === "fills" && (
        <section className="replay-rail-section" data-replay-panel="fills">
          <h2>Fills · {structuredFills.length}</h2>
          {structuredFills.length > REPLAY_ACTIVITY_VIEW_LIMIT && <small data-replay-recent-window="fills">仅显示最近 {REPLAY_ACTIVITY_VIEW_LIMIT} 条；完整记录见报告导出。</small>}
          {structuredFills.length === 0 ? <p className="replay-empty">暂无成交</p> : recentStructuredFills.map((fill, index) => {
            const eventTime = recordNumber(fill, "event_time_ms");
            return (
              <article className="replay-list-card" key={recordText(fill, "fill_id", `fill-${index}`)}>
                <strong>{recordText(fill, "side")} {recordText(fill, "quantity")} @ {recordText(fill, "price")}</strong>
                <span>{recordText(fill, "liquidity")} · {recordText(fill, "reason")} · fee {recordText(fill, "configured_fee", recordText(fill, "fee"))}</span>
                <span>{recordText(fill, "track_id", selectedTrackId)}{eventTime === null ? "" : ` · ${time(eventTime)}`}</span>
              </article>
            );
          })}
        </section>
      )}

      {activeTab === "book" && (
        <section
          className="replay-rail-section replay-historical-book"
          data-replay-panel="historical-book"
          data-replay-book-status={historicalBook?.status ?? "OFF"}
        >
          <h2>历史 L2 · {selectedTrack?.symbol ?? "--"}</h2>
          {historicalBook === null || historicalBook.status === "OFF" ? (
            <div className="replay-capability-boundary" role="status">
              <strong>OFF · TOUCH_OR_TAPE_V2</strong>
              <p>本 Run 未开启历史盘口；执行明确不含盘口排队。</p>
            </div>
          ) : historicalBook.status !== "READY" ? (
            <div className="replay-capability-boundary" role="alert">
              <strong>{historicalBook.status} · 已清空旧盘口</strong>
              <p>{historicalBook.message}</p>
              <p>整个 BOOK_ASSISTED Run 保持暂停，不会静默退回 Touch/Tape 继续成交。</p>
              {viewer !== undefined && (
                <button
                  type="button"
                  data-replay-action="resync-historical-book"
                  disabled={viewer.viewerPending || viewer.marketTracks?.global_clock.state !== "PAUSED"}
                  onClick={() => void viewer.actions.resyncHistoricalBook().catch(() => undefined)}
                >重新校验并 resync</button>
              )}
            </div>
          ) : (
            <>
              <dl className="replay-metrics-grid">
                <div><dt>Update ID</dt><dd>{historicalBook.last_update_id}</dd></div>
                <div><dt>As of</dt><dd>{historicalBook.as_of_virtual_time_ms === null ? "--" : time(historicalBook.as_of_virtual_time_ms)}</dd></div>
              </dl>
              <small>AVAILABLE_EXACT · {historicalBook.execution_fidelity}</small>
              <small>Queue exact：否；该盘口只在连续性通过时显示。</small>
              <div className="replay-book-columns">
                <div>
                  <h3>Bids</h3>
                  {historicalBook.bids.map(([levelPrice, levelQuantity]) => (
                    <span key={`bid:${levelPrice}`} data-book-side="bid">
                      <strong>{levelPrice}</strong><small>{levelQuantity}</small>
                    </span>
                  ))}
                </div>
                <div>
                  <h3>Asks</h3>
                  {historicalBook.asks.map(([levelPrice, levelQuantity]) => (
                    <span key={`ask:${levelPrice}`} data-book-side="ask">
                      <strong>{levelPrice}</strong><small>{levelQuantity}</small>
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === "flow" && (
        <section
          className="replay-rail-section replay-trade-flow"
          data-replay-panel="trade-flow"
          data-replay-trade-flow-state={tradeFlow.state}
        >
          <h2>聚合成交 Tape 与 CVD</h2>
          {tradeFlow.state === "UNSUPPORTED_SOURCE_MODE" && (
            <div className="replay-capability-boundary" role="status">
              <strong>UNSUPPORTED_SOURCE_MODE</strong>
              <p>BAR 归档没有聚合成交序列，不能生成 Tape 或订单流；这里不会把缺失历史显示成 0。</p>
            </div>
          )}
          {tradeFlow.state === "LOADING" && <p className="replay-empty">正在读取已揭示的有界聚合成交页…</p>}
          {tradeFlow.state === "DEGRADED" && (
            <div className="replay-capability-boundary" role="alert">
              <strong>DEGRADED · 已清空</strong>
              <p>{tradeFlow.error ?? "订单流连续性校验失败"}</p>
            </div>
          )}
          {tradeFlow.state === "CONTIGUOUS" && (<>
            <dl className="replay-metrics-grid">
              <div><dt>Window CVD</dt><dd>{tradeFlow.cvd}</dd></div>
              <div><dt>Page delta</dt><dd>{tradeFlow.pageDelta}</dd></div>
            </dl>
            <small>AVAILABLE_EXACT tape · AVAILABLE_APPROX aggressor · {tradeFlow.fidelity}</small>
            <small>Window CVD 从当前连续有界窗口的起点累加，不冒充全历史 CVD。</small>
            {tradeFlow.tape.length === 0 ? (
              <p className="replay-empty">当前已揭示范围内暂无聚合成交。</p>
            ) : (
              <div className="replay-trade-flow-list">
                {[...tradeFlow.tape].reverse().map((item) => (
                  <article key={item.source_sequence} data-aggressor-side={item.aggressor_side}>
                    <strong>{item.aggressor_side} {item.quantity} @ {item.price}</strong>
                    <span>Δ {item.cvd_delta} · agg #{item.agg_trade_id}</span>
                    <small>{time(item.trade_time_ms)} · {item.raw_trade_count} raw trades aggregated</small>
                  </article>
                ))}
              </div>
            )}
          </>)}
        </section>
      )}

      {activeTab === "risk" && (
        <>
          <section className="replay-rail-section" data-replay-panel="account-risk">
            <h2>账户与风险</h2>
            <dl className="replay-metrics-grid">
              <div><dt>Equity</dt><dd>{portfolio?.equity ?? "--"}</dd></div>
              <div><dt>Cash</dt><dd>{portfolio?.cash_balance ?? "--"}</dd></div>
              <div><dt>Reserved</dt><dd>{portfolio?.reserved_margin ?? "--"}</dd></div>
              <div><dt>Fees</dt><dd>{portfolio?.fees_paid ?? "--"}</dd></div>
              <div><dt>Maintenance</dt><dd>{contract?.maintenance_margin ?? "legacy n/a"}</dd></div>
              <div><dt>Risk ratio</dt><dd>{contract?.risk_ratio ?? "--"}</dd></div>
              <div><dt>Funding cashflow</dt><dd>{contract?.funding_cashflow ?? "OFF"}</dd></div>
              <div><dt>Liquidation fees</dt><dd>{contract?.liquidation_fees_paid ?? "--"}</dd></div>
            </dl>
            {contract?.margin_mode === "ISOLATED" && viewer !== undefined && (
              <div className="replay-isolated-allocation">
                <label>选中轨道逐仓分配
                  <input value={isolatedAmount} inputMode="decimal" onChange={(event) => setIsolatedAmount(event.target.value)} />
                </label>
                <button
                  type="button"
                  disabled={!commandReady || !isolatedAmount.trim()}
                  onClick={() => void viewer.actions.submitTrade("allocate_isolated_margin", {
                    track_id: selectedTrackId,
                    amount: isolatedAmount,
                  }).catch(() => undefined)}
                >设置分配</button>
                <small>当前：{String(contract.isolated_allocations[selectedTrackId] ?? "0")} {settlementAsset}</small>
              </div>
            )}
          </section>

          <section className="replay-rail-section replay-fidelity-panel" data-replay-panel="fidelity">
            <h2>执行与账本 fidelity</h2>
            <p><strong>{contract?.execution_model ?? "PAPER_LINEAR_V1"}</strong> · {contract?.execution_fidelity ?? "legacy adapter"}</p>
            <p>Mark：{contract === null ? "legacy" : recordText(contract.fidelity, "mark")}</p>
            <p>Funding：{contract === null ? "legacy" : recordText(contract.fidelity, "funding")}</p>
            <p>强平：{contract === null ? "unsupported" : recordText(contract.fidelity, "liquidation")}</p>
            <p>账本重算差异：{contract === null ? "n/a" : recordText(contract.ledger, "reconciliation_delta")}</p>
            <small>
              {accountHistory?.mode === "HISTORICAL_EXACT"
                ? "Mark/index、版本化交易规则与可选 funding 来自已固定并校验的归档；账户强平仍是本训练账户模型的计算事件。"
                : "当前代理 mark 只用于近似模拟账户风险；不是交易所历史权威 mark。"}
            </small>
          </section>

          {accountHistory !== null && (
            <section
              className="replay-rail-section replay-fidelity-panel"
              data-replay-panel="account-history"
              data-account-history-status={accountHistory.status}
            >
              <h2>账户历史与独立审计</h2>
              <p><strong>{accountHistory.mode}</strong> · {accountHistory.status}</p>
              <p>{accountHistory.fidelity}</p>
              <p>Archive set proof：<code>{accountHistory.archive_proof_hash ?? "none"}</code></p>
              <p>
                Auditor：
                <strong data-account-auditor-status={accountHistory.auditor.status}>
                  {accountHistory.auditor.status}
                </strong>
                {accountHistory.auditor.proof_hash === null
                  ? ""
                  : ` · ${accountHistory.auditor.proof_hash}`}
              </p>
              {viewer !== undefined && (
                <button
                  type="button"
                  data-replay-action="audit-account"
                  disabled={viewer.viewerPending}
                  onClick={() => void viewer.actions.auditAccount().catch(() => undefined)}
                >
                  重新运行独立账户审计
                </button>
              )}
              {accountHistory.auditor.differences.length > 0 && (
                <div className="replay-command-error" role="alert">
                  审计发现 {accountHistory.auditor.differences.length} 项差异；Run 不应被视为可验证 exact 结果。
                </div>
              )}
              {accountHistory.bindings.map((binding) => (
                <article className="replay-list-card" key={`${binding.track_id}:${binding.archive_id}`}>
                  <strong>{binding.track_id} · {binding.status}</strong>
                  <span>Mark {binding.mark_price ?? "--"} · Index {binding.index_price ?? "--"}</span>
                  <span>event #{binding.last_event_sequence} · generation {binding.archive_generation}</span>
                  <code>{binding.archive_id}</code>
                  <small>{binding.proof_hash}</small>
                </article>
              ))}
              {accountHistory.mode === "APPROX_PROXY" && (
                <small>未绑定历史账户归档；该结果明确保持 APPROX。</small>
              )}
            </section>
          )}

          <section
            className="replay-rail-section replay-capability-boundary"
            data-replay-panel="historical-market-liquidations"
            data-replay-domain="historical-market-liquidation"
          >
            <h2>历史市场爆仓</h2>
            <strong>{contract?.liquidation_channels.historical_market.fidelity ?? "UNSUPPORTED_NO_HISTORY"}</strong>
            <p>这是独立市场数据域，不会用训练账户的模拟强平事件代替或冒充。</p>
          </section>

          <section className="replay-rail-section" data-replay-panel="simulated-liquidations" data-replay-domain="simulated-account-liquidation">
            <h2>模拟账户强平 · {contract?.liquidations.length ?? 0}</h2>
            <small>{contract?.liquidation_channels.simulated_account.fidelity ?? "AVAILABLE_APPROX_SIMULATED_ACCOUNT"} · 与“历史市场爆仓”严格分域。</small>
            {contract === null || contract.liquidations.length === 0 ? (
              <p className="replay-empty">暂无模拟账户强平</p>
            ) : contract.liquidations.map((event, index) => (
              <article className="replay-list-card" key={recordText(event, "liquidation_id", `liquidation-${index}`)}>
                <strong>{recordText(event, "state")} · {recordText(event, "track_id")}</strong>
                <span>Mark {recordText(event, "mark_price")} · maintenance {recordText(event, "maintenance_margin")}</span>
                <span>Fee {recordText(event, "liquidation_fee")} · equity {recordText(event, "account_equity_before")} → {recordText(event, "account_equity_after")}</span>
                <small>{recordText(event, "fidelity")}</small>
              </article>
            ))}
          </section>
        </>
      )}

      {activeTab === "notes" && (
        <>
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
            {recentJournal.map((entry) => <article className="replay-list-card" key={entry.entry_id}><span>{time(entry.virtual_time_ms)}</span><p>{entry.text}</p></article>)}
          </section>
          <section className="replay-rail-section replay-indicator-boundary" data-replay-panel="indicators">
            <h2>本地指标</h2>
            <p>SMA 20 · 仅 {indicatorStatus.sourceBarCount} 根已揭示 bars。</p>
            <p>Hosted / range / security 指标已禁用：回放页不会请求后端或未来窗口。</p>
          </section>
        </>
      )}
      </div>
    </div>
  );
}

export default function ReplayRightRail(props: ReplayRightRailProps) {
  return (
    <aside className="replay-right-rail" aria-label="回放训练账户与纸面交易">
      <ReplayPaperTradingDock {...props} />
    </aside>
  );
}
