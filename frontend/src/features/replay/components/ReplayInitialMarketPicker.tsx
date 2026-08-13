import { useEffect, useMemo, useState } from "react";
import type { ReplayCatalog, ReplayCatalogEntry } from "../replayTypes.js";
import type { TrainingRunCard } from "../replayV2Types.js";
import { defaultReplayV2Api, ReplayV2ApiError } from "../replayV2Api.js";
import {
  prepareReplayInitialMarketSelection,
  selectReplayInitialMarketWithEpochRetry,
} from "../replayInitialMarket.js";
import {
  formatReplayMarketCoverage,
  formatReplayUtcDateTime,
  isReplayInitialMarketAvailable,
  trainingExchangeLabel,
  trainingMarketKey,
  trainingMarketTypeLabel,
  trainingSourceKindLabel,
  trainingVenueLabel,
} from "../trainingHubLabels.js";

export interface ReplayInitialMarketPickerProps {
  readonly run: TrainingRunCard;
  readonly onInitialized: (run: TrainingRunCard) => void;
}

interface MarketTypeFilter {
  readonly exchange: string;
  readonly marketType: string;
}

function marketTypeKey(filter: MarketTypeFilter): string {
  return `${filter.exchange}:${filter.marketType}`;
}

function sameMarketType(
  left: MarketTypeFilter,
  right: MarketTypeFilter,
): boolean {
  return left.exchange === right.exchange && left.marketType === right.marketType;
}

function ReplayMarketPickerRow({
  entry,
  available,
  recommended,
  selecting,
  sourceKind,
  coverage,
  onSelect,
}: {
  readonly entry: ReplayCatalogEntry;
  readonly available: boolean;
  readonly recommended: boolean;
  readonly selecting: boolean;
  readonly sourceKind: TrainingRunCard["source_kind"];
  readonly coverage: string;
  readonly onSelect: () => void;
}) {
  const reason = entry.start_compatibility?.message
    ?? "服务端尚未返回本局时间兼容性。";
  return (
    <article
      className="replay-market-picker-row"
      data-available={available ? "true" : "false"}
      data-recommended={recommended ? "true" : "false"}
    >
      <div className="replay-market-picker-row-main">
        <div className="replay-market-picker-identity">
          <strong>{entry.identity.symbol}</strong>
          <span>{trainingVenueLabel(entry)}</span>
        </div>
        <dl>
          <div>
            <dt>周期</dt>
            <dd>{entry.selected_base_interval ?? "—"}</dd>
          </div>
          <div>
            <dt>覆盖</dt>
            <dd>{coverage}</dd>
          </div>
        </dl>
      </div>
      {available ? (
        <button
          className="training-hub-primary-button"
          type="button"
          disabled={selecting}
          onClick={onSelect}
        >
          {selecting
            ? sourceKind === "AGG_TRADE"
              ? "正在下载并校验…"
              : "正在初始化…"
            : "选择"}
        </button>
      ) : (
        <p className="replay-market-picker-reason">{reason}</p>
      )}
    </article>
  );
}

export default function ReplayInitialMarketPicker({
  run,
  onInitialized,
}: ReplayInitialMarketPickerProps) {
  const [catalog, setCatalog] = useState<ReplayCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [availableOnly, setAvailableOnly] = useState(true);
  const [marketType, setMarketType] = useState<MarketTypeFilter | null>(null);
  const [unavailableOpen, setUnavailableOpen] = useState(false);
  const [downgrade, setDowngrade] = useState<{
    readonly entry: ReplayCatalogEntry;
    readonly message: string;
  } | null>(null);

  const loadCatalog = () => {
    setError(null);
    setDowngrade(null);
    setCatalog(null);
    void defaultReplayV2Api.marketCatalog(run.run_id).then(setCatalog).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "商品目录读取失败");
    });
  };

  useEffect(() => {
    const abort = new AbortController();
    void defaultReplayV2Api.marketCatalog(run.run_id, abort.signal)
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "商品目录读取失败");
      });
    return () => abort.abort();
  }, [run.run_id]);

  const marketTypes = useMemo(() => {
    const seen = new Map<string, MarketTypeFilter>();
    for (const entry of catalog?.entries ?? []) {
      const filter = {
        exchange: entry.identity.exchange,
        marketType: entry.identity.market_type,
      };
      seen.set(marketTypeKey(filter), filter);
    }
    return [...seen.values()];
  }, [catalog]);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      const matchesQuery = needle.length === 0
        || entry.identity.symbol.toLowerCase().includes(needle)
        || entry.identity.exchange.toLowerCase().includes(needle)
        || entry.identity.market_type.toLowerCase().includes(needle)
        || trainingVenueLabel(entry).toLowerCase().includes(needle);
      const matchesType = marketType === null
        || sameMarketType(marketType, {
          exchange: entry.identity.exchange,
          marketType: entry.identity.market_type,
        });
      return matchesQuery && matchesType;
    });
  }, [catalog, marketType, query]);

  const availableEntries = entries.filter(isReplayInitialMarketAvailable);
  const blockedEntries = entries.filter((entry) => !isReplayInitialMarketAvailable(entry));
  const visibleBlocked = !availableOnly || unavailableOpen ? blockedEntries : [];
  const timeCommitment = catalog?.time_commitment;
  const committedTimeLabel = timeCommitment?.committed_start_ms === null
    ? "已冻结（按披露策略隐藏）"
    : timeCommitment?.committed_start_ms === undefined
      ? "正在读取"
      : formatReplayUtcDateTime(timeCommitment.committed_start_ms);
  const hedgeLocked = (catalog?.entries ?? []).some((entry) => {
    const text = `${entry.start_compatibility?.code ?? ""} ${entry.start_compatibility?.message ?? ""}`;
    return /HEDGE|双向/.test(text);
  });

  const selectMarket = async (entry: ReplayCatalogEntry, confirmed = false) => {
    if (catalog === null || entry.selected_base_interval === null || selecting !== null) return;
    setSelecting(trainingMarketKey(entry));
    setError(null);
    if (!confirmed) setDowngrade(null);
    try {
      if (!confirmed) {
        const prepared = await prepareReplayInitialMarketSelection({
          api: defaultReplayV2Api,
          runId: run.run_id,
          catalog,
          entry,
        });
        if (prepared.downgradeConfirmation !== null) {
          setDowngrade({ entry, message: prepared.downgradeConfirmation });
          setSelecting(null);
          return;
        }
      }
      const result = await selectReplayInitialMarketWithEpochRetry({
        api: defaultReplayV2Api,
        runId: run.run_id,
        catalog,
        entry,
      });
      setCatalog(result.catalog);
      setDowngrade(null);
      onInitialized(result.response.run);
    } catch (reason) {
      const message = reason instanceof ReplayV2ApiError
        ? `${reason.code}: ${reason.message}`
        : reason instanceof Error ? reason.message : "商品初始化失败";
      setError(message);
      setSelecting(null);
      if (reason instanceof ReplayV2ApiError && reason.code === "CATALOG_EPOCH_MISMATCH") {
        loadCatalog();
      }
    }
  };

  return (
    <main
      className="training-hub-page replay-market-picker"
      data-replay-run-state="AWAITING_MARKET"
    >
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div className="training-hub-brand">
            <div className="training-hub-brand-mark" aria-hidden="true">T0</div>
            <div>
              <span className="training-hub-kicker">开局时间已冻结 · 尚未加载商品</span>
              <h1>{run.name}</h1>
              <p>选择商品只会检查它是否支持这局已冻结的时间，不会改时间、顺延或重新随机。</p>
            </div>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={loadCatalog} disabled={selecting !== null}>刷新目录</button>
            <a href="/replay.html">返回大厅</a>
          </div>
        </header>

        <section className="replay-market-picker-commit" aria-label="本局约束">
          <div><span>开局时间</span><strong>{committedTimeLabel}</strong></div>
          <div><span>结算资产</span><strong>{run.settlement_asset}</strong></div>
          <div><span>历史源</span><strong>{trainingSourceKindLabel(run.source_kind)}</strong></div>
          {hedgeLocked && <div><span>持仓</span><strong>双向</strong></div>}
        </section>

        {run.source_kind === "AGG_TRADE" && (
          <div className="replay-info-note" data-replay-agg-trade-download-note>
            首次选择需下载并校验整日成交档；官方目录不提供可信行数或大小，下载量未知。
          </div>
        )}
        {hedgeLocked && (
          <div className="replay-info-note" data-replay-hedge-lock-note>
            本局已锁定双向持仓；只有支持该账户模式的商品可以开局。
          </div>
        )}

        <div className="replay-market-picker-toolbar">
          <label className="replay-market-picker-search">
            <span>搜索商品</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="BTC、ETH、交易所或市场类型"
              autoFocus
            />
          </label>
          {marketTypes.length > 1 && (
            <div className="training-hub-filter-chips" role="group" aria-label="市场类型">
              <button
                type="button"
                aria-pressed={marketType === null}
                onClick={() => setMarketType(null)}
              >
                全部市场
              </button>
              {marketTypes.map((filter) => (
                <button
                  key={marketTypeKey(filter)}
                  type="button"
                  aria-pressed={marketType !== null && sameMarketType(marketType, filter)}
                  onClick={() => setMarketType(filter)}
                >
                  {trainingExchangeLabel(filter.exchange)} {trainingMarketTypeLabel(filter.marketType)}
                </button>
              ))}
            </div>
          )}
          <label className="replay-market-picker-toggle">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={(event) => {
                setAvailableOnly(event.target.checked);
                if (event.target.checked) setUnavailableOpen(false);
              }}
            />
            只看可用
          </label>
        </div>

        {error !== null && <div className="replay-error-summary" role="alert">{error}</div>}
        {downgrade !== null && (
          <section className="replay-error-summary" role="alert" data-replay-market-downgrade="HEDGE_HYBRID">
            <strong>确认降级后再选择 {downgrade.entry.identity.symbol}</strong>
            <span>{downgrade.message}</span>
            <div>
              <button
                type="button"
                disabled={selecting !== null}
                onClick={() => void selectMarket(downgrade.entry, true)}
              >
                确认使用 HEDGE_HYBRID 并选择
              </button>
              <button type="button" disabled={selecting !== null} onClick={() => setDowngrade(null)}>
                取消
              </button>
            </div>
          </section>
        )}

        {catalog === null ? (
          <div className="training-hub-empty"><div className="replay-loading-spinner" />正在读取可用商品…</div>
        ) : entries.length === 0 ? (
          <div className="training-hub-empty">
            <strong>没有匹配商品</strong>
            <span>清空搜索词，或改成查看全部市场。</span>
          </div>
        ) : availableEntries.length === 0 && visibleBlocked.length === 0 ? (
          <div className="training-hub-empty">
            <strong>没有本局可用商品</strong>
            <span>当前过滤下没有兼容商品。可以显示不可用原因，或另开一局。</span>
            <div className="replay-market-picker-empty-actions">
              {blockedEntries.length > 0 && (
                <button type="button" onClick={() => {
                  setAvailableOnly(false);
                  setUnavailableOpen(true);
                }}
                >
                  查看 {blockedEntries.length} 个不可用商品
                </button>
              )}
              <a href="/replay.html">另开一局</a>
            </div>
          </div>
        ) : (
          <div className="replay-market-picker-list">
            {availableEntries.length > 0 && (
              <section aria-label="可用商品">
                <header>
                  <h2>可用</h2>
                  <span>{availableEntries.length}</span>
                </header>
                {availableEntries.map((entry, index) => (
                  <ReplayMarketPickerRow
                    key={trainingMarketKey(entry)}
                    entry={entry}
                    available
                    recommended={index === 0}
                    selecting={selecting === trainingMarketKey(entry)}
                    sourceKind={run.source_kind}
                    coverage={formatReplayMarketCoverage(entry, catalog.blind_mode)}
                    onSelect={() => void selectMarket(entry)}
                  />
                ))}
              </section>
            )}
            {visibleBlocked.length > 0 && (
              <section aria-label="本局不可用商品">
                <header>
                  <h2>本局不可用</h2>
                  <span>{visibleBlocked.length}</span>
                </header>
                {visibleBlocked.map((entry) => (
                  <ReplayMarketPickerRow
                    key={trainingMarketKey(entry)}
                    entry={entry}
                    available={false}
                    recommended={false}
                    selecting={false}
                    sourceKind={run.source_kind}
                    coverage={formatReplayMarketCoverage(entry, catalog.blind_mode)}
                    onSelect={() => undefined}
                  />
                ))}
              </section>
            )}
            {blockedEntries.length > 0 && (
              <div className="replay-market-picker-more">
                {availableOnly && !unavailableOpen && (
                  <button type="button" onClick={() => setUnavailableOpen(true)}>
                    显示 {blockedEntries.length} 个不可用商品
                  </button>
                )}
                <a href="/replay.html">另开一局</a>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
