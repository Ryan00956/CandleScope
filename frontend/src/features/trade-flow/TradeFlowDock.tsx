import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { getLocale, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
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

const TRADE_STATUS_KEYS = {
  idle: "trade.status.idle",
  unsupported: "trade.status.unsupported",
  connecting: "trade.status.connecting",
  reconnecting: "trade.status.reconnecting",
  live: "trade.status.live",
  gap: "trade.status.gap",
  error: "trade.status.error",
} as const satisfies Record<TradeFlowConnectionStatus, string>;

function tradeStatusLabel(status: TradeFlowConnectionStatus): string {
  return t(TRADE_STATUS_KEYS[status]);
}

export interface TradeFlowDockProps {
  runtime: TradeFlowRuntime;
  height: number;
  /** Which trade-flow body to show when mounted as a dedicated rail view. */
  mode: "tape" | "profile";
  /** Closes this rail view (activity-bar style). */
  onRequestClose?(): void;
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
  const base = date.toLocaleTimeString(getLocale() === "zh-CN" ? "zh-CN" : "en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function TradeFlowStatus({ store }: { store: TradeFlowExternalStore }) {
  useLocale();
  const status = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().status,
    () => store.getServerSnapshot().status,
  );
  return (
    <span className={`tf-status tf-status-${status}`} title={tradeStatusLabel(status)}>
      <span className="tf-status-dot" aria-hidden="true" />
      {tradeStatusLabel(status)}
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
  useLocale();
  const large = largeThreshold > 0 && trade.quoteQuantity >= largeThreshold;
  return (
    <div className={`tf-tape-row tf-${trade.aggressorSide} ${large ? "tf-large" : ""}`}>
      <span className="tf-tape-side" aria-label={trade.aggressorSide === "buy" ? t("trade.buy") : t("trade.sell")}>
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
      <span className="tf-summary-buy">{t("trade.buySummary", { notional: formatNotional(snapshot.stats.buyQuote), count: snapshot.stats.buyCount })}</span>
      <span className="tf-summary-sell">{t("trade.sellSummary", { notional: formatNotional(snapshot.stats.sellQuote), count: snapshot.stats.sellCount })}</span>
      <span>{t("trade.intensity", { value: buyIntensity.toFixed(1) })}</span>
      <span>{t("trade.max", { value: formatNotional(snapshot.stats.maxTradeNotional) })}</span>
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
      <strong>{tradeStatusLabel(status)}</strong>
      <span>{runtime.view.supportMessage || message || t("trade.waitFirst")}</span>
      {retryable && <button type="button" onClick={runtime.actions.retry}>{t("trade.resync")}</button>}
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
        <span>{t("trade.side")}</span><span>{t("trade.price")}</span><span>{t("trade.qty")}</span><span>{t("trade.notional")}</span><span>{t("trade.time")}</span>
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
          message={snapshot.records.length > 0 ? t("trade.noMatch") : snapshot.message}
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
        <span>{t("trade.footprint")}</span>
        <span>{t("trade.profileMeta", { trades: profile.trades, step: profile.priceStep ? formatPrice(profile.priceStep) : "—" })}</span>
      </div>
      <div className="tf-profile-header" aria-hidden="true">
        <span>{t("trade.price")}</span><span>{t("trade.buyVol")}</span><span>{t("trade.sellVol")}</span><span>{t("trade.delta")}</span><span>{t("trade.buySell")}</span>
      </div>
      {profile.rows.length > 0 ? (
        <div className="tf-profile-list">
          {profile.rows.map((row) => <ProfileRow key={row.key} row={row} maximum={profile.maxQuote} />)}
        </div>
      ) : (
        <TradeFlowEmpty
          runtime={runtime}
          status={snapshot.status}
          message={snapshot.records.length > 0 ? t("trade.noMatch") : snapshot.message}
        />
      )}
    </div>
  );
}

function TradeFlowDock({
  runtime,
  height,
  mode,
  onRequestClose,
}: TradeFlowDockProps) {
  useLocale();
  const preferences = runtime.view.preferences;
  return (
    <section
      className="order-book-dock trade-flow-dock"
      style={{ height }}
      aria-label={mode === "profile" ? t("trade.profileAria") : t("trade.tapeAria")}
    >
      <header className="ob-header tf-header">
        {onRequestClose && (
          <button
            type="button"
            className="ob-collapse-button"
            onClick={onRequestClose}
            title={mode === "profile" ? t("trade.collapseProfile") : t("trade.collapseTape")}
            aria-label={mode === "profile" ? t("trade.collapseProfile") : t("trade.collapseTape")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        <span className="ob-title">{mode === "profile" ? t("trade.profile") : t("trade.tape")}</span>
        <span
          className="ob-symbol"
          title={runtime.view.deliveryMode === "polling_observational"
            ? t("trade.mode.pollingDetail")
            : runtime.view.continuityMode === "observational"
              ? t("trade.mode.observationalDetail")
            : t("trade.mode.strictDetail")}
        >
          {runtime.view.deliveryMode === "polling_observational"
            ? t("trade.mode.polling")
            : runtime.view.continuityMode === "observational"
              ? t("trade.mode.observational")
            : t("trade.mode.strict")}
        </span>
        <TradeFlowStatus store={runtime.view.store} />
      </header>

      <>
        <div className="tf-controls">
          <div className="tf-side-switch" role="group" aria-label={t("trade.sideFilter")}>
            {(["all", "buy", "sell"] as const).map((side) => (
              <button
                key={side}
                type="button"
                className={preferences.sideFilter === side ? "active" : ""}
                onClick={() => runtime.actions.setSideFilter(side)}
              >{side === "all" ? t("trade.all") : side === "buy" ? t("trade.buy") : t("trade.sell")}</button>
            ))}
          </div>
          <label title={t("trade.filterTitle")}>
            <span>{t("trade.filter")}</span>
            <select value={preferences.minNotional} onChange={(event) => runtime.actions.setMinNotional(Number(event.target.value))}>
              {TRADE_FLOW_NOTIONAL_OPTIONS.map((value) => <option key={value} value={value}>{value ? `≥ ${formatNotional(value)}` : t("trade.all")}</option>)}
            </select>
          </label>
          <label title={t("trade.bubbleTitle")}>
            <span>{t("trade.bubbles")}</span>
            <select value={preferences.largeTradeNotional} onChange={(event) => runtime.actions.setLargeTradeNotional(Number(event.target.value))}>
              {TRADE_FLOW_BUBBLE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value ? `≥ ${formatNotional(value)}` : t("trade.off")}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mode === "profile"
          ? <TradeFlowProfileBody runtime={runtime} />
          : <TradeFlowTape runtime={runtime} />}
      </>
    </section>
  );
}

export default React.memo(TradeFlowDock);
