import { useCallback, useEffect, useMemo, useState } from "react";
import { t, type LocaleId } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import DataWorkbenchStyles from "./DataWorkbenchStyles.js";
import {
  fetchStorageInventory,
  type StorageInventoryFilters,
  type StorageInventoryResponse,
} from "../../services/storageInventoryApi.js";
import { ManualHistoryDownloadPanel } from "./ManualHistoryDownloadPanel.js";

interface WorkbenchFilters {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
}

export interface DataWorkbenchModalProps {
  isOpen: boolean;
  onClose(): void;
  currentExchange?: string;
  currentMarketType?: string;
  currentSymbol?: string;
}

function emptyFilters(): WorkbenchFilters {
  return { exchange: "", marketType: "", symbol: "", interval: "" };
}

function toRequestFilters(filters: WorkbenchFilters): StorageInventoryFilters {
  return {
    ...(filters.exchange ? { exchange: filters.exchange } : {}),
    ...(filters.marketType ? { marketType: filters.marketType } : {}),
    ...(filters.symbol ? { symbol: filters.symbol.trim().toUpperCase() } : {}),
    ...(filters.interval ? { interval: filters.interval } : {}),
    limit: 500,
  };
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDateTime(value: number | null, locale: LocaleId): string {
  if (value === null) return "--";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMarketType(value: string, locale: LocaleId): string {
  if (value === "futures") return t("market.futures", {}, locale);
  if (value === "swap") return t("market.swap", {}, locale);
  return t("market.spot", {}, locale);
}

function formatCountMap(values: Record<string, number>, locale: LocaleId): string {
  const entries = Object.entries(values);
  return entries.length
    ? entries.map(([key, value]) => `${key}: ${value.toLocaleString(locale)}`).join(" · ")
    : "--";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export default function DataWorkbenchModal({
  isOpen,
  onClose,
  currentExchange = "binance",
  currentMarketType = "spot",
  currentSymbol = "",
}: DataWorkbenchModalProps) {
  const locale = useLocale();
  const [draftFilters, setDraftFilters] = useState<WorkbenchFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<WorkbenchFilters>(emptyFilters);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [payload, setPayload] = useState<StorageInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (filters: WorkbenchFilters, signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchStorageInventory(toRequestFilters(filters), { signal });
      if (!signal.aborted) setPayload(next);
    } catch (loadError: unknown) {
      if (!signal.aborted && !isAbortError(loadError)) {
        setError(t("workbench.loadFailed", { error: errorMessage(loadError) }));
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const controller = new AbortController();
    void load(appliedFilters, controller.signal);
    return () => controller.abort();
  }, [appliedFilters, isOpen, load, refreshGeneration]);

  const exchangeOptions = useMemo(() => {
    const values = new Set(payload?.series.map((series) => series.exchange) || []);
    if (draftFilters.exchange) values.add(draftFilters.exchange);
    return [...values].sort();
  }, [draftFilters.exchange, payload?.series]);
  const marketTypeOptions = useMemo(() => {
    const values = new Set(payload?.series.map((series) => series.marketType) || []);
    if (draftFilters.marketType) values.add(draftFilters.marketType);
    return [...values].sort();
  }, [draftFilters.marketType, payload?.series]);
  const intervalOptions = useMemo(() => {
    const values = new Set(payload?.series.map((series) => series.interval) || []);
    if (draftFilters.interval) values.add(draftFilters.interval);
    return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }, [draftFilters.interval, payload?.series]);

  const applyFilters = useCallback(() => {
    setAppliedFilters({ ...draftFilters });
    setRefreshGeneration((value) => value + 1);
  }, [draftFilters]);

  const resetFilters = useCallback(() => {
    const next = emptyFilters();
    setDraftFilters(next);
    setAppliedFilters(next);
    setRefreshGeneration((value) => value + 1);
  }, []);

  const focusCurrentSeries = useCallback(() => {
    const next = {
      exchange: currentExchange,
      marketType: currentMarketType,
      symbol: currentSymbol.trim().toUpperCase(),
      interval: "",
    };
    setDraftFilters(next);
    setAppliedFilters(next);
    setRefreshGeneration((value) => value + 1);
  }, [currentExchange, currentMarketType, currentSymbol]);

  if (!isOpen) return null;

  const integrity = payload?.integrity;
  const hasCurrentSymbol = Boolean(currentSymbol.trim());

  return (
    <div className="dw-overlay" onClick={onClose}>
      <section
        aria-label={t("settings.workbench.name", {}, locale)}
        aria-modal="true"
        className="dw-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="dw-header">
          <div>
            <div className="dw-kicker">{t("workbench.kicker", {}, locale)}</div>
            <h2 className="dw-title">{t("settings.workbench.name", {}, locale)}</h2>
            <p className="dw-subtitle">{t("workbench.subtitle", {}, locale)}</p>
          </div>
          <button aria-label={t("workbench.close", {}, locale)} className="dw-close" onClick={onClose} type="button">✕</button>
        </header>

        <div className="dw-body">
          <section className="dw-filter-card">
            <div className="dw-filter-title-row">
              <div>
                <h3>{t("workbench.filterTitle", {}, locale)}</h3>
                <p>{t("workbench.filterDesc", {}, locale)}</p>
              </div>
              <div className="dw-live-badges">
                <span className="dw-badge dw-badge-live">LIVE</span>
                <span className="dw-badge dw-badge-readonly">{t("workbench.readonly", {}, locale)}</span>
              </div>
            </div>
            <div className="dw-filter-grid">
              <label>
                <span>{t("workbench.exchange", {}, locale)}</span>
                <select value={draftFilters.exchange} onChange={(event) => setDraftFilters((current) => ({ ...current, exchange: event.target.value }))}>
                  <option value="">{t("workbench.allExchanges", {}, locale)}</option>
                  {exchangeOptions.map((exchange) => <option key={exchange} value={exchange}>{exchange}</option>)}
                </select>
              </label>
              <label>
                <span>{t("workbench.market", {}, locale)}</span>
                <select value={draftFilters.marketType} onChange={(event) => setDraftFilters((current) => ({ ...current, marketType: event.target.value }))}>
                  <option value="">{t("workbench.allMarkets", {}, locale)}</option>
                  {marketTypeOptions.map((marketType) => <option key={marketType} value={marketType}>{formatMarketType(marketType, locale)}</option>)}
                </select>
              </label>
              <label>
                <span>{t("workbench.instrument", {}, locale)}</span>
                <input value={draftFilters.symbol} onChange={(event) => setDraftFilters((current) => ({ ...current, symbol: event.target.value }))} placeholder="BTCUSDT" />
              </label>
              <label>
                <span>{t("interval.label", {}, locale)}</span>
                <select value={draftFilters.interval} onChange={(event) => setDraftFilters((current) => ({ ...current, interval: event.target.value }))}>
                  <option value="">{t("workbench.allIntervals", {}, locale)}</option>
                  {intervalOptions.map((interval) => <option key={interval} value={interval}>{interval}</option>)}
                </select>
              </label>
            </div>
            <div className="dw-actions">
              <button className="dw-button dw-button-secondary" onClick={resetFilters} type="button">{t("workbench.reset", {}, locale)}</button>
              <button className="dw-button dw-button-secondary" disabled={!hasCurrentSymbol} onClick={focusCurrentSeries} type="button">{t("workbench.currentChart", {}, locale)}</button>
              <button className="dw-button dw-button-primary" disabled={loading} onClick={applyFilters} type="button">{loading ? t("workbench.reading", {}, locale) : t("workbench.apply", {}, locale)}</button>
            </div>
          </section>

          <ManualHistoryDownloadPanel
            exchange={currentExchange}
            marketType={currentMarketType}
            symbols={currentSymbol.trim() ? [currentSymbol.trim().toUpperCase()] : []}
          />

          {error ? <div className="dw-notice dw-notice-error">{error}</div> : null}

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>{t("workbench.snapshot", {}, locale)}</h3>
                <p>{payload ? t("workbench.capturedAt", { time: formatDateTime(payload.capturedAtMs, locale) }, locale) : t("workbench.readingSnapshot", {}, locale)}</p>
              </div>
              {payload ? (
                <span className={`dw-badge ${payload.snapshot.fileSetStable ? "dw-badge-ok" : "dw-badge-warning"}`}>
                  {payload.snapshot.fileSetStable ? t("workbench.fileStable", {}, locale) : t("workbench.fileWriting", {}, locale)}
                </span>
              ) : null}
            </div>
            <div className="dw-stat-grid">
              <div className="dw-stat-card"><span>{t("workbench.physical", {}, locale)}</span><strong>{payload ? formatBytes(payload.snapshot.physicalSizeBytes) : "--"}</strong><small>DB + WAL</small></div>
              <div className="dw-stat-card"><span>{t("workbench.allSeries", {}, locale)}</span><strong>{payload ? payload.inventory.totalSeries.toLocaleString(locale) : "--"}</strong><small>{payload ? t("settings.diag.rows", { count: payload.inventory.totalRows.toLocaleString(locale) }, locale) : t("workbench.realSummary", {}, locale)}</small></div>
              <div className="dw-stat-card"><span>{t("workbench.currentFilter", {}, locale)}</span><strong>{payload ? payload.inventory.matchingSeries.toLocaleString(locale) : "--"}</strong><small>{payload ? t("settings.diag.rows", { count: payload.inventory.matchingRows.toLocaleString(locale) }, locale) : "--"}</small></div>
              <div className="dw-stat-card"><span>{t("workbench.fileStatus", {}, locale)}</span><strong>{payload?.snapshot.exists ? t("workbench.found", {}, locale) : payload ? t("workbench.notCreated", {}, locale) : "--"}</strong><small>{payload ? t("workbench.totalSize", { size: formatBytes(payload.snapshot.totalSizeBytes) }, locale) : "--"}</small></div>
            </div>
            {payload?.inventory.truncated ? (
              <div className="dw-notice dw-notice-warning">{t("workbench.truncated", { matching: payload.inventory.matchingSeries.toLocaleString(locale), shown: payload.inventory.returnedSeries.toLocaleString(locale) }, locale)}</div>
            ) : null}
            {payload && !payload.snapshot.fileSetStable ? (
              <div className="dw-notice dw-notice-warning">{t("workbench.writeDuringCapture", {}, locale)}</div>
            ) : null}
          </section>

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>{t("workbench.integrity", {}, locale)}</h3>
                <p>{t("workbench.integrityDesc", {}, locale)}</p>
              </div>
              {integrity ? (
                <span className={`dw-badge ${integrity.available ? (integrity.openGapCount ? "dw-badge-warning" : "dw-badge-ok") : "dw-badge-error"}`}>
                  {integrity.available ? t("workbench.openGaps", { count: integrity.openGapCount.toLocaleString(locale) }, locale) : t("workbench.statusUnavailable", {}, locale)}
                </span>
              ) : null}
            </div>
            {!integrity && loading ? <div className="dw-empty">{t("workbench.readingIntegrity", {}, locale)}</div> : null}
            {integrity && !integrity.available ? (
              <div className="dw-notice dw-notice-error">{integrity.reason}</div>
            ) : null}
            {integrity?.available ? (
              <>
                <div className="dw-integrity-grid">
                  <div><span>{t("workbench.statusDist", {}, locale)}</span><strong>{formatCountMap(integrity.openGapByStatus, locale)}</strong></div>
                  <div><span>{t("workbench.gapAge", {}, locale)}</span><strong>{formatCountMap(integrity.openGapAgeBuckets, locale)}</strong></div>
                  <div><span>{t("workbench.oldest", {}, locale)}</span><strong>{formatDateTime(integrity.oldestOpenGapAtMs, locale)}</strong></div>
                </div>
                {!integrity.openGapCount ? (
                  <div className="dw-empty">{t("workbench.noGaps", {}, locale)}</div>
                ) : (
                  <div className="dw-gap-list">
                    {integrity.gapSamples.map((gap, index) => (
                      <div className="dw-gap-row" key={`${gap.exchange}:${gap.marketType}:${gap.symbol}:${gap.interval}:${index}`}>
                        <div><strong>{gap.symbol || t("workbench.unknownSymbol", {}, locale)}</strong><span>{gap.exchange || "--"} · {gap.marketType || "--"} · {gap.interval || "--"}</span></div>
                        <span>{gap.status}</span>
                        <span>{t("workbench.missingBars", { count: gap.missingBars.toLocaleString(locale) }, locale)}</span>
                        <span>{t("workbench.lastChecked", { time: formatDateTime(gap.lastCheckedAtMs, locale) }, locale)}</span>
                      </div>
                    ))}
                    {integrity.openGapCount > integrity.gapSamples.length ? (
                      <div className="dw-gap-more">{t("workbench.gapSamples", { shown: integrity.gapSamples.length.toLocaleString(locale), limit: integrity.sampleLimit.toLocaleString(locale) }, locale)}</div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </section>

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>{t("workbench.storedSeries", {}, locale)}</h3>
                <p>{t("workbench.storedDesc", {}, locale)}</p>
              </div>
              {payload ? <span className="dw-result-count">{t("workbench.showing", { count: payload.inventory.returnedSeries.toLocaleString(locale) }, locale)}</span> : null}
            </div>
            <div className="dw-table" role="table">
              <div className="dw-table-head" role="row">
                <span>{t("workbench.colSeries", {}, locale)}</span><span>{t("interval.label", {}, locale)}</span><span>{t("workbench.colRows", {}, locale)}</span><span>{t("workbench.colStart", {}, locale)}</span><span>{t("workbench.colLatest", {}, locale)}</span>
              </div>
              {loading && !payload ? <div className="dw-empty">{t("workbench.readingInventory", {}, locale)}</div> : null}
              {!loading && payload?.series.length === 0 ? <div className="dw-empty">{t("workbench.emptySeries", {}, locale)}</div> : null}
              {payload?.series.map((series) => (
                <div className="dw-table-row" key={`${series.exchange}:${series.marketType}:${series.symbol}:${series.interval}`} role="row">
                  <span className="dw-series-name"><strong>{series.symbol}</strong><small>{series.exchange} · {formatMarketType(series.marketType, locale)}</small></span>
                  <span className="dw-mono">{series.interval}</span>
                  <span>{series.totalCount.toLocaleString(locale)}</span>
                  <span>{formatDateTime(series.earliestOpenMs, locale)}</span>
                  <span>{formatDateTime(series.latestOpenMs, locale)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
      <DataWorkbenchStyles />
    </div>
  );
}
