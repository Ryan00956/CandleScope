import React, { useEffect, useMemo, useState } from "react";
import { parseSymbolKey, symbolKey } from "../../../utils/symbolKey.js";
import type { ReplayCatalog, ReplayCatalogEntry } from "../replayTypes.js";
import { defaultReplayV2Api } from "../replayV2Api.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";
import type { ReplayTrainingMarketTrack } from "../replayV2Types.js";

export type ReplaySubscriptionTier = "NONE" | "WARM" | "FULL";

export interface ReplayWatchlistPanelProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (value: boolean) => void;
}

function ReplayWatchlistPanel({ runtime, viewer, collapsed, onCollapsedChange }: ReplayWatchlistPanelProps) {
  const config = runtime.store.sessionConfig;
  const runId = viewer.viewerState?.run_id ?? null;
  const [catalog, setCatalog] = useState<ReplayCatalog | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [marketQuery, setMarketQuery] = useState("");
  const [addingMarket, setAddingMarket] = useState<string | null>(null);
  const primaryKey = config === null
    ? ""
    : symbolKey(config.symbol, config.market_type, config.exchange);
  const trackedKeys = useMemo(() => new Set(
    (viewer.marketTracks?.tracks ?? []).map((track) => (
      symbolKey(track.symbol, track.market_type, track.exchange)
    )),
  ), [viewer.marketTracks]);
  useEffect(() => {
    if (runId === null) return;
    const controller = new AbortController();
    setCatalogError(null);
    void defaultReplayV2Api.marketCatalog(runId, controller.signal).then(setCatalog).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setCatalogError(reason instanceof Error ? reason.message : "商品目录读取失败");
    });
    return () => controller.abort();
  }, [catalogAttempt, runId]);

  const catalogEntries = useMemo(() => {
    if (config === null) return [];
    const needle = marketQuery.trim().toLowerCase();
    return (catalog?.entries ?? []).filter((entry) => (
      entry.identity.exchange === config.exchange
      && entry.identity.market_type === config.market_type
      && (
        needle.length === 0
        || entry.identity.symbol.toLowerCase().includes(needle)
      )
    )).slice(0, 20);
  }, [catalog, config, marketQuery]);

  const addCatalogMarket = async (entry: ReplayCatalogEntry) => {
    if (config === null || addingMarket !== null || viewer.viewerPending) return;
    const key = symbolKey(
      entry.identity.symbol,
      entry.identity.market_type,
      entry.identity.exchange,
    );
    if (trackedKeys.has(key)) return;
    setAddingMarket(key);
    setCatalogError(null);
    try {
      await viewer.actions.addAndSelectTrack({
        exchange: entry.identity.exchange,
        marketType: entry.identity.market_type,
        symbol: entry.identity.symbol,
      });
      setMarketQuery("");
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : "商品添加失败");
    } finally {
      setAddingMarket(null);
    }
  };
  const groups = useMemo(() => {
    const tracksByKey = new Map<string, ReplayTrainingMarketTrack>();
    for (const track of viewer.marketTracks?.tracks ?? []) {
      tracksByKey.set(
        symbolKey(track.symbol, track.market_type, track.exchange),
        track,
      );
    }
    const seen = new Set<string>();
    const values: Array<{
      readonly id: string;
      readonly name: string;
      readonly color: string;
      readonly rows: Array<{
        readonly key: string;
        readonly track: ReplayTrainingMarketTrack | null;
      }>;
    }> = [];
    for (const group of viewer.marketTracks?.launch_context?.watchlist_snapshot.groups ?? []) {
      const rows = group.items.map((item) => {
        const key = symbolKey(item.symbol, item.market_type, item.exchange);
        seen.add(key);
        return { key, track: tracksByKey.get(key) ?? null };
      });
      values.push({
        id: group.id,
        name: group.name,
        color: group.color,
        rows,
      });
    }
    if (primaryKey && !seen.has(primaryKey)) {
      seen.add(primaryKey);
      values.unshift({
        id: "replay_primary",
        name: "训练主轨",
        color: "#8b5cf6",
        rows: [{ key: primaryKey, track: tracksByKey.get(primaryKey) ?? null }],
      });
    }
    const additional: Array<{
      readonly key: string;
      readonly track: ReplayTrainingMarketTrack | null;
    }> = [];
    for (const track of tracksByKey.values()) {
      const key = symbolKey(track.symbol, track.market_type, track.exchange);
      if (seen.has(key)) continue;
      seen.add(key);
      additional.push({ key, track });
    }
    if (additional.length > 0) {
      values.push({
        id: "replay_tracks",
        name: "训练中新增",
        color: "#22c55e",
        rows: additional,
      });
    }
    return values;
  }, [primaryKey, viewer.marketTracks]);
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? null;
  const renderRow = (
    key: string,
    track: ReplayTrainingMarketTrack | null,
    reactKey: string,
  ) => {
    const identity = parseSymbolKey(key);
    const selected = track?.track_id === selectedTrackId;
    const sameScope = config !== null
      && identity.exchange === config.exchange
      && identity.marketType === config.market_type;
    const tier: ReplaySubscriptionTier = track?.subscription_tier ?? "NONE";
    const last = selected ? runtime.store.lastPrice?.close ?? null : track?.public_price ?? null;
    const forced = track?.forced_full_reasons ?? [];
    const pending = viewer.viewerPending || viewer.controlPending !== null;
    const activate = () => {
      if (pending || selected || !sameScope) return;
      const action = track === null
        ? viewer.actions.addAndSelectTrack({
            exchange: identity.exchange,
            marketType: identity.marketType,
            symbol: identity.symbol,
          })
        : viewer.actions.selectTrack(track.track_id);
      void action.catch(() => undefined);
    };
    return (
      <div
        key={reactKey}
        className={`replay-watchlist-row ${selected ? "active" : ""}`}
        data-replay-tier={tier}
        data-replay-track-id={track?.track_id ?? "unregistered"}
      >
        <button
          type="button"
          className="replay-watchlist-market"
          disabled={pending || selected || !sameScope}
          title={
            !sameScope
              ? "首个多商品闭环仅允许同交易所、同市场类型、同结算资产"
              : selected
                ? "当前主图：强制 FULL"
                : "暂停全局时钟、对齐冻结历史后原子切换"
          }
          onClick={activate}
        >
          <span><strong>{identity.symbol}</strong><small>{identity.exchange} · {identity.marketType}</small></span>
          <span>{last ?? "--"}</span>
        </button>
        <code>{tier}</code>
        {forced.length > 0 && <small className="replay-track-force" title={forced.join(", ")}>🔒 {forced.join(" · ")}</small>}
        {track !== null && !selected && (
          <select
            aria-label={`${identity.symbol} replay subscription tier`}
            value={tier}
            disabled={pending || forced.length > 0}
            onChange={(event) => {
              void viewer.actions.setSubscriptionTier(
                track.track_id,
                event.target.value as ReplaySubscriptionTier,
              ).catch(() => undefined);
            }}
          >
            <option value="NONE">NONE</option>
            <option value="WARM">WARM</option>
            <option value="FULL">FULL</option>
          </select>
        )}
        {track?.degraded_reason && <small role="alert">{track.degraded_reason}</small>}
      </div>
    );
  };
  return (
    <div
      className={`watchlist-pane replay-watchlist-pane ${collapsed ? "collapsed" : ""}`}
      data-replay-local-tiers="false"
      data-replay-watchlist-source="run-archive"
    >
      <div className="wl-header">
        <button
          className="wl-collapse-btn"
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "展开回放自选" : "收起回放自选"}
        >{collapsed ? "‹" : "›"}</button>
        {!collapsed && <><span className="wl-header-title">回放自选</span><small>归档快照 · NONE / WARM / FULL</small></>}
      </div>
      {collapsed ? (
        <div className="wl-collapsed-icons" title="主轨 FULL">R</div>
      ) : (
        <div className="replay-watchlist-rows">
          <section className="replay-watchlist-group replay-market-search">
            <header>
              <i style={{ background: "#38bdf8" }} />
              <span>添加商品</span>
              <button
                type="button"
                disabled={runId === null || addingMarket !== null}
                onClick={() => setCatalogAttempt((value) => value + 1)}
              >刷新</button>
            </header>
            <label>
              <span>搜索当前 Run 可用商品</span>
              <input
                aria-label="搜索当前 Run 可用商品"
                value={marketQuery}
                onChange={(event) => setMarketQuery(event.target.value)}
                placeholder="BTC、ETH、SOL…"
              />
            </label>
            <small>Run 不绑定单一商品；新商品会按当前全局时钟对齐后成为 MarketTrack。</small>
            {catalogError !== null && <p role="alert">{catalogError}</p>}
            {catalog === null && catalogError === null && <p>正在读取商品目录…</p>}
            {catalog !== null && catalogEntries.length === 0 && <p>没有匹配的可用商品</p>}
            <div className="replay-market-search-results">
              {catalogEntries.map((entry) => {
                const key = symbolKey(
                  entry.identity.symbol,
                  entry.identity.market_type,
                  entry.identity.exchange,
                );
                const tracked = trackedKeys.has(key);
                const available = entry.selected_base_interval !== null
                  && entry.eligible_window_count > 0
                  && entry.start_compatibility?.state === "READY";
                const unavailableReason = entry.start_compatibility?.message
                  ?? "当前训练参数下无精确历史覆盖";
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={tracked || !available || addingMarket !== null || viewer.viewerPending}
                    title={tracked ? "已在当前 Run 中" : available ? "校验账户范围后添加并切换" : unavailableReason}
                    onClick={() => void addCatalogMarket(entry)}
                  >
                    <strong>{entry.identity.symbol}</strong>
                    <small>{tracked ? "已添加" : addingMarket === key ? "校验并对齐中…" : available ? "添加" : "不可用"}</small>
                  </button>
                );
              })}
            </div>
          </section>
          {groups.map((group) => (
            <section className="replay-watchlist-group" key={group.id}>
              <header>
                <i style={{ background: group.color }} />
                <span>{group.name}</span>
                <small>{group.rows.length}</small>
              </header>
              {group.rows.length === 0
                ? <p>此分组在创建训练时为空</p>
                : group.rows.map(({ key, track }) => (
                    renderRow(key, track, `${group.id}:${key}`)
                  ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default React.memo(ReplayWatchlistPanel);
