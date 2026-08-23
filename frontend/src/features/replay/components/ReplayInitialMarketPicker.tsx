import { useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
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
    ?? t("replay.picker.compatUnknown");
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
            <dt>{t("replay.picker.interval")}</dt>
            <dd>{entry.selected_base_interval ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("replay.picker.coverage")}</dt>
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
              ? t("replay.picker.downloading")
              : t("replay.picker.init")
            : t("replay.picker.select")}
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
  useLocale();
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
      setError(reason instanceof Error ? reason.message : t("replay.picker.catalogFailed"));
    });
  };

  useEffect(() => {
    const abort = new AbortController();
    void defaultReplayV2Api.marketCatalog(run.run_id, abort.signal)
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : t("replay.picker.catalogFailed"));
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
    ? t("replay.picker.frozenHidden")
    : timeCommitment?.committed_start_ms === undefined
      ? t("replay.picker.reading")
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
        : reason instanceof Error ? reason.message : t("replay.picker.initFailed");
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
              <span className="training-hub-kicker">{t("replay.picker.kicker")}</span>
              <h1>{run.name}</h1>
              <p>{t("replay.picker.intro")}</p>
            </div>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={loadCatalog} disabled={selecting !== null}>{t("replay.picker.refresh")}</button>
            <a href="/replay.html">{t("replay.picker.backToHub")}</a>
          </div>
        </header>

        <section className="replay-market-picker-commit" aria-label={t("replay.picker.constraints")}>
          <div><span>{t("replay.picker.startTime")}</span><strong>{committedTimeLabel}</strong></div>
          <div><span>{t("replay.picker.settlement")}</span><strong>{run.settlement_asset}</strong></div>
          <div><span>{t("replay.picker.source")}</span><strong>{trainingSourceKindLabel(run.source_kind)}</strong></div>
          {hedgeLocked && <div><span>{t("replay.picker.position")}</span><strong>{t("replay.picker.hedge")}</strong></div>}
        </section>

        {run.source_kind === "AGG_TRADE" && (
          <div className="replay-info-note" data-replay-agg-trade-download-note>
            {t("replay.picker.firstDownload")}
          </div>
        )}
        {hedgeLocked && (
          <div className="replay-info-note" data-replay-hedge-lock-note>
            {t("replay.picker.hedgeLocked")}
          </div>
        )}

        <div className="replay-market-picker-toolbar">
          <label className="replay-market-picker-search">
            <span>{t("replay.picker.search")}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("replay.picker.searchPh")}
              autoFocus
            />
          </label>
          {marketTypes.length > 1 && (
            <div className="training-hub-filter-chips" role="group" aria-label={t("replay.picker.marketType")}>
              <button
                type="button"
                aria-pressed={marketType === null}
                onClick={() => setMarketType(null)}
              >
                {t("replay.picker.allMarkets")}
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
            {t("replay.picker.availableOnly")}
          </label>
        </div>

        {error !== null && <div className="replay-error-summary" role="alert">{error}</div>}
        {downgrade !== null && (
          <section className="replay-error-summary" role="alert" data-replay-market-downgrade="HEDGE_HYBRID">
            <strong>{t("replay.picker.confirmDowngrade", { symbol: downgrade.entry.identity.symbol })}</strong>
            <span>{downgrade.message}</span>
            <div>
              <button
                type="button"
                disabled={selecting !== null}
                onClick={() => void selectMarket(downgrade.entry, true)}
              >
                {t("replay.picker.confirmHybrid")}
              </button>
              <button type="button" disabled={selecting !== null} onClick={() => setDowngrade(null)}>
                {t("replay.hub.cancel")}
              </button>
            </div>
          </section>
        )}

        {catalog === null ? (
          <div className="training-hub-empty"><div className="replay-loading-spinner" />{t("replay.picker.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="training-hub-empty">
            <strong>{t("replay.picker.noMatch")}</strong>
            <span>{t("replay.picker.noMatchHint")}</span>
          </div>
        ) : availableEntries.length === 0 && visibleBlocked.length === 0 ? (
          <div className="training-hub-empty">
            <strong>{t("replay.picker.noneReady")}</strong>
            <span>{t("replay.picker.noneReadyHint")}</span>
            <div className="replay-market-picker-empty-actions">
              {blockedEntries.length > 0 && (
                <button type="button" onClick={() => {
                  setAvailableOnly(false);
                  setUnavailableOpen(true);
                }}
                >
                  {t("replay.picker.viewBlocked", { count: blockedEntries.length })}
                </button>
              )}
              <a href="/replay.html">{t("replay.picker.newRun")}</a>
            </div>
          </div>
        ) : (
          <div className="replay-market-picker-list">
            {availableEntries.length > 0 && (
              <section aria-label={t("replay.picker.available")}>
                <header>
                  <h2>{t("replay.picker.availableH")}</h2>
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
              <section aria-label={t("replay.picker.blocked")}>
                <header>
                  <h2>{t("replay.picker.blockedH")}</h2>
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
                    {t("replay.picker.showBlocked", { count: blockedEntries.length })}
                  </button>
                )}
                <a href="/replay.html">{t("replay.picker.newRun")}</a>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
