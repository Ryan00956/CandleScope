import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { buildTradeFlowProfile } from "./tradeFlowProfile.js";
import {
  TRADE_FLOW_BUBBLE_OPTIONS,
  TRADE_FLOW_NOTIONAL_OPTIONS,
} from "./tradeFlowPreferencesStore.js";
import type {
  AggregateTrade,
  TradeFlowConnectionStatus,
  TradeFlowExternalStore,
  TradeFlowRuntime,
} from "./tradeFlowTypes.js";

const STATUS_LABELS: Record<TradeFlowConnectionStatus, string> = {
  idle: "未启用",
  unsupported: "不可用",
  connecting: "连接中",
  reconnecting: "重连中",
  live: "实时连续",
  gap: "存在缺口",
  error: "错误",
};

export interface TradeFlowDockProps {
  runtime: TradeFlowRuntime;
  height: number;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  onOpenOrderBook(): void;
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function formatPrice(value: number): string {
  const decimals = value >= 1_000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return trimZeros(value.toFixed(decimals));
}

function formatQuantity(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (absolute >= 1_000) return `${trimZeros((value / 1_000).toFixed(2))}K`;
  if (absolute >= 1) return trimZeros(value.toFixed(3));
  return trimZeros(value.toFixed(6));
}

function formatNotional(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${sign}$${trimZeros((absolute / 1_000_000).toFixed(2))}M`;
  if (absolute >= 1_000) return `${sign}$${trimZeros((absolute / 1_000).toFixed(1))}K`;
  return `${sign}$${trimZeros(absolute.toFixed(0))}`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  const base = date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function TradeFlowStatus({ store }: { store: TradeFlowExternalStore }) {
  const status = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().status,
    () => store.getServerSnapshot().status,
  );
  return (
    <span className={`tf-status tf-status-${status}`} title={STATUS_LABELS[status]}>
      <span className="tf-status-dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

const TapeRow = React.memo(function TapeRow({
  trade,
  largeThreshold,
}: {
  trade: AggregateTrade;
  largeThreshold: number;
}) {
  const large = largeThreshold > 0 && trade.quoteQuantity >= largeThreshold;
  return (
    <div className={`tf-tape-row tf-${trade.aggressorSide} ${large ? "tf-large" : ""}`}>
      <span className="tf-tape-side" aria-label={trade.aggressorSide === "buy" ? "主动买" : "主动卖"}>
        {trade.aggressorSide === "buy" ? "B" : "S"}
      </span>
      <span>{formatPrice(trade.price)}</span>
      <span>{formatQuantity(trade.quantity)}</span>
      <span>{formatNotional(trade.quoteQuantity)}</span>
      <time dateTime={new Date(trade.tradeTimeMs).toISOString()}>{formatTime(trade.tradeTimeMs)}</time>
    </div>
  );
}, (previous, next) => (
  previous.trade === next.trade && previous.largeThreshold === next.largeThreshold
));

function TradeFlowSummary({ snapshot }: {
  snapshot: ReturnType<TradeFlowExternalStore["getSnapshot"]>;
}) {
  const total = snapshot.stats.buyQuote + snapshot.stats.sellQuote;
  const buyIntensity = total > 0 ? snapshot.stats.buyQuote / total * 100 : 0;
  return (
    <div className="tf-summary">
      <span className="tf-summary-buy">买 {formatNotional(snapshot.stats.buyQuote)} · {snapshot.stats.buyCount} 笔</span>
      <span className="tf-summary-sell">卖 {formatNotional(snapshot.stats.sellQuote)} · {snapshot.stats.sellCount} 笔</span>
      <span>强度 {buyIntensity.toFixed(1)}%</span>
      <span>最大 {formatNotional(snapshot.stats.maxTradeNotional)}</span>
    </div>
  );
}

function TradeFlowEmpty({
  runtime,
  status,
  message,
}: {
  runtime: TradeFlowRuntime;
  status: TradeFlowConnectionStatus;
  message: string | null;
}) {
  const retryable = status === "gap" || status === "error" || status === "reconnecting";
  return (
    <div className={`tf-empty tf-empty-${status}`}>
      <strong>{STATUS_LABELS[status]}</strong>
      <span>{runtime.view.supportMessage || message || "等待第一笔聚合成交"}</span>
      {retryable && <button type="button" onClick={runtime.actions.retry}>重新同步</button>}
    </div>
  );
}

function TradeFlowTape({ runtime }: { runtime: TradeFlowRuntime }) {
  const snapshot = useSyncExternalStore(
    runtime.view.store.subscribe,
    runtime.view.store.getSnapshot,
    runtime.view.store.getServerSnapshot,
  );
  const { sideFilter, minNotional, largeTradeNotional } = runtime.view.preferences;
  const rows = useMemo(() => {
    const result: AggregateTrade[] = [];
    for (let index = snapshot.records.length - 1; index >= 0 && result.length < 72; index -= 1) {
      const trade = snapshot.records[index];
      if (!trade || trade.quoteQuantity < minNotional) continue;
      if (sideFilter !== "all" && trade.aggressorSide !== sideFilter) continue;
      result.push(trade);
    }
    return result;
  }, [minNotional, sideFilter, snapshot.records]);

  return (
    <div className="tf-body">
      <TradeFlowSummary snapshot={snapshot} />
      <div className="tf-tape-header" aria-hidden="true">
        <span>方向</span><span>价格</span><span>数量</span><span>成交额</span><span>时间</span>
      </div>
      {rows.length > 0 ? (
        <div className="tf-tape-list" role="log" aria-live="off">
          {rows.map((trade) => (
            <TapeRow key={trade.aggTradeId} trade={trade} largeThreshold={largeTradeNotional} />
          ))}
        </div>
      ) : (
        <TradeFlowEmpty
          runtime={runtime}
          status={snapshot.status}
          message={snapshot.records.length > 0 ? "当前筛选条件下无成交" : snapshot.message}
        />
      )}
    </div>
  );
}

const ProfileRow = React.memo(function ProfileRow({
  row,
  maximum,
}: {
  row: ReturnType<typeof buildTradeFlowProfile>["rows"][number];
  maximum: number;
}) {
  const buyWidth = maximum > 0 ? row.buyQuote / maximum * 100 : 0;
  const sellWidth = maximum > 0 ? row.sellQuote / maximum * 100 : 0;
  return (
    <div className="tf-profile-row">
      <span className="tf-profile-bars" aria-hidden="true">
        <i className="tf-profile-buy-bar" style={{ width: `${buyWidth}%` }} />
        <i className="tf-profile-sell-bar" style={{ width: `${sellWidth}%` }} />
      </span>
      <span>{formatPrice(row.price)}</span>
      <span className="tf-profile-buy">{formatNotional(row.buyQuote)}</span>
      <span className="tf-profile-sell">{formatNotional(row.sellQuote)}</span>
      <span className={row.deltaQuote >= 0 ? "tf-profile-buy" : "tf-profile-sell"}>
        {row.deltaQuote >= 0 ? "+" : ""}{formatNotional(row.deltaQuote)}
      </span>
      <span>{row.buyCount}×{row.sellCount}</span>
    </div>
  );
});

function TradeFlowProfileBody({ runtime }: { runtime: TradeFlowRuntime }) {
  const subscribe = useCallback((listener: () => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = runtime.view.store.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        listener();
      }, 200);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [runtime.view.store]);
  const snapshot = useSyncExternalStore(
    subscribe,
    runtime.view.store.getSnapshot,
    runtime.view.store.getServerSnapshot,
  );
  const records = useMemo(() => snapshot.records.filter((trade) => (
    trade.quoteQuantity >= runtime.view.preferences.minNotional
    && (runtime.view.preferences.sideFilter === "all"
      || trade.aggressorSide === runtime.view.preferences.sideFilter)
  )), [
    runtime.view.preferences.minNotional,
    runtime.view.preferences.sideFilter,
    snapshot.records,
  ]);
  const profile = useMemo(() => buildTradeFlowProfile(records), [records]);
  return (
    <div className="tf-body tf-profile-body">
      <TradeFlowSummary snapshot={snapshot} />
      <div className="tf-profile-caption">
        <span>实时 Footprint / Volume Profile</span>
        <span>{profile.trades} 笔 · 步长 {profile.priceStep ? formatPrice(profile.priceStep) : "—"}</span>
      </div>
      <div className="tf-profile-header" aria-hidden="true">
        <span>价格</span><span>主动买</span><span>主动卖</span><span>Delta</span><span>买×卖</span>
      </div>
      {profile.rows.length > 0 ? (
        <div className="tf-profile-list">
          {profile.rows.map((row) => <ProfileRow key={row.key} row={row} maximum={profile.maxQuote} />)}
        </div>
      ) : (
        <TradeFlowEmpty
          runtime={runtime}
          status={snapshot.status}
          message={snapshot.records.length > 0 ? "当前筛选条件下无成交" : snapshot.message}
        />
      )}
    </div>
  );
}

function TradeFlowDock({
  runtime,
  height,
  collapsed,
  onCollapsedChange,
  onOpenOrderBook,
}: TradeFlowDockProps) {
  const preferences = runtime.view.preferences;
  return (
    <section
      className={`order-book-dock trade-flow-dock ${collapsed ? "collapsed" : ""}`}
      style={{ height }}
      aria-label="成交订单流"
    >
      <header className="ob-header tf-header">
        <button
          type="button"
          className="ob-collapse-button"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "展开市场微观结构" : "折叠市场微观结构"}
          aria-expanded={!collapsed}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            {collapsed ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        </button>
        <div className="market-dock-tabs" role="tablist" aria-label="市场微观结构视图">
          <button type="button" role="tab" aria-selected={false} onClick={onOpenOrderBook}>盘口</button>
          <button
            type="button"
            role="tab"
            aria-selected={preferences.dockView === "tape"}
            className={preferences.dockView === "tape" ? "active" : ""}
            onClick={() => runtime.actions.setDockView("tape")}
          >成交</button>
          <button
            type="button"
            role="tab"
            aria-selected={preferences.dockView === "profile"}
            className={preferences.dockView === "profile" ? "active" : ""}
            onClick={() => runtime.actions.setDockView("profile")}
          >分布</button>
        </div>
        {!collapsed && <TradeFlowStatus store={runtime.view.store} />}
      </header>

      {!collapsed && (
        <>
          <div className="tf-controls">
            <div className="tf-side-switch" role="group" aria-label="成交方向过滤">
              {(["all", "buy", "sell"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  className={preferences.sideFilter === side ? "active" : ""}
                  onClick={() => runtime.actions.setSideFilter(side)}
                >{side === "all" ? "全部" : side === "buy" ? "主动买" : "主动卖"}</button>
              ))}
            </div>
            <label title="成交带与分布的最小成交额">
              <span>过滤</span>
              <select value={preferences.minNotional} onChange={(event) => runtime.actions.setMinNotional(Number(event.target.value))}>
                {TRADE_FLOW_NOTIONAL_OPTIONS.map((value) => <option key={value} value={value}>{value ? `≥ ${formatNotional(value)}` : "全部"}</option>)}
              </select>
            </label>
            <label title="主图大额成交气泡阈值">
              <span>气泡</span>
              <select value={preferences.largeTradeNotional} onChange={(event) => runtime.actions.setLargeTradeNotional(Number(event.target.value))}>
                {TRADE_FLOW_BUBBLE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value ? `≥ ${formatNotional(value)}` : "关闭"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {preferences.dockView === "profile"
            ? <TradeFlowProfileBody runtime={runtime} />
            : <TradeFlowTape runtime={runtime} />}
        </>
      )}
    </section>
  );
}

export default React.memo(TradeFlowDock);
