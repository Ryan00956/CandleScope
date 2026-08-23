import React, { useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
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
  const locale = useLocale();
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
      setCatalogError(reason instanceof Error ? reason.message : t("replay.watchlist.catalogFailed"));
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
      setCatalogError(reason instanceof Error ? reason.message : t("replay.watchlist.addFailed"));
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
        name: t("replay.watchlist.primary", {}, locale),
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
        name: t("replay.watchlist.addedGroup", {}, locale),
        color: "#22c55e",
        rows: additional,
      });
    }
    return values;
  }, [locale, primaryKey, viewer.marketTracks]);
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
              ? t("replay.watchlist.sameScope")
              : selected
                ? t("replay.watchlist.currentFull")
                : t("replay.watchlist.switchHint")
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
            aria-label={t("replay.watchlist.tierAria", { symbol: identity.symbol })}
            value={tier}
            disabled={pending || forced.length > 0}
            onChange={(event) => {
              void viewer.actions.setSubscriptionTier(
                track.track_id,
                event.target.value as ReplaySubscriptionTier,
              ).catch(() => undefined);
            }}
          >
            <option value="NONE">{t("replay.watchlist.tier.none")}</option>
            <option value="WARM">{t("replay.watchlist.tier.warm")}</option>
            <option value="FULL">{t("replay.watchlist.tier.full")}</option>
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
          title={collapsed ? t("replay.watchlist.expand") : t("replay.watchlist.collapse")}
        >{collapsed ? "‹" : "›"}</button>
        {!collapsed && <><span className="wl-header-title">{t("replay.watchlist.title")}</span><small>{t("replay.watchlist.subtitle")}</small></>}
      </div>
      {collapsed ? (
        <div className="wl-collapsed-icons" title={t("replay.watchlist.primaryFull")}>R</div>
      ) : (
        <div className="replay-watchlist-rows">
          <section className="replay-watchlist-group replay-market-search">
            <header>
              <i style={{ background: "#38bdf8" }} />
              <span>{t("replay.watchlist.add")}</span>
              <button
                type="button"
                disabled={runId === null || addingMarket !== null}
                onClick={() => setCatalogAttempt((value) => value + 1)}
              >{t("replay.watchlist.refresh")}</button>
            </header>
            <label>
              <span>{t("replay.watchlist.search")}</span>
              <input
                aria-label={t("replay.watchlist.search")}
                value={marketQuery}
                onChange={(event) => setMarketQuery(event.target.value)}
                placeholder={t("replay.watchlist.searchPlaceholder")}
              />
            </label>
            <small>{t("replay.watchlist.hint")}</small>
            {catalogError !== null && <p role="alert">{catalogError}</p>}
            {catalog === null && catalogError === null && <p>{t("replay.watchlist.loading")}</p>}
            {catalog !== null && catalogEntries.length === 0 && <p>{t("replay.watchlist.noMatch")}</p>}
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
                  ?? t("replay.watchlist.noCover");
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={tracked || !available || addingMarket !== null || viewer.viewerPending}
                    title={tracked ? t("replay.watchlist.inRun") : available ? t("replay.watchlist.addTitle") : unavailableReason}
                    onClick={() => void addCatalogMarket(entry)}
                  >
                    <strong>{entry.identity.symbol}</strong>
                    <small>{tracked ? t("replay.watchlist.added") : addingMarket === key ? t("replay.watchlist.adding") : available ? t("replay.watchlist.addBtn") : t("replay.watchlist.unavailable")}</small>
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
                ? <p>{t("replay.watchlist.emptyGroup")}</p>
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
