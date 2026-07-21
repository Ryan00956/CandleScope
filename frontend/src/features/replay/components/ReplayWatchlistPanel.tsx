import React, { useMemo } from "react";
import { parseSymbolKey, symbolKey } from "../../../utils/symbolKey.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";


export type ReplaySubscriptionTier = "NONE" | "WARM" | "FULL";

export interface ReplayWatchlistPanelProps {
  readonly runtime: ReplayRuntime;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (value: boolean) => void;
}

function loadReplayWatchlistSymbols(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem("candlescope-watchlists");
    const decoded: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    return decoded.flatMap((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return [];
      const symbols = (group as { symbols?: unknown }).symbols;
      return Array.isArray(symbols)
        ? symbols.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
    });
  } catch {
    return [];
  }
}

function ReplayWatchlistPanel({ runtime, collapsed, onCollapsedChange }: ReplayWatchlistPanelProps) {
  const config = runtime.store.sessionConfig;
  const primaryKey = config === null
    ? ""
    : symbolKey(config.symbol, config.market_type, config.exchange);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const values: string[] = [];
    if (primaryKey) {
      seen.add(primaryKey);
      values.push(primaryKey);
    }
    for (const raw of loadReplayWatchlistSymbols()) {
      const parsed = parseSymbolKey(raw);
      const value = symbolKey(parsed.symbol, parsed.marketType, parsed.exchange);
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
    return values.slice(0, 100);
  }, [primaryKey]);
  return (
    <div className={`watchlist-pane replay-watchlist-pane ${collapsed ? "collapsed" : ""}`} data-replay-local-tiers="true">
      <div className="wl-header">
        <button
          className="wl-collapse-btn"
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "展开回放自选" : "收起回放自选"}
        >{collapsed ? "‹" : "›"}</button>
        {!collapsed && <><span className="wl-header-title">回放自选</span><small>NONE / WARM / FULL</small></>}
      </div>
      {collapsed ? (
        <div className="wl-collapsed-icons" title="主轨 FULL">R</div>
      ) : (
        <div className="replay-watchlist-rows">
          {rows.map((value) => {
            const identity = parseSymbolKey(value);
            const primary = value === primaryKey;
            const tier: ReplaySubscriptionTier = primary ? "FULL" : "NONE";
            const last = primary ? runtime.store.lastPrice : null;
            return (
              <button
                type="button"
                key={value}
                className={`replay-watchlist-row ${primary ? "active" : ""}`}
                disabled={!primary}
                title={primary ? "主训练轨：完整冻结数据" : "Phase 2 尚未创建该市场轨；不会回退到 live 行情"}
                data-replay-tier={tier}
              >
                <span><strong>{identity.symbol}</strong><small>{identity.exchange} · {identity.marketType}</small></span>
                <span>{last?.close ?? "--"}</span>
                <code>{tier}</code>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default React.memo(ReplayWatchlistPanel);
