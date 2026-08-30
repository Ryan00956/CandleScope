import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { t, tPlural, type LocaleId } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import DataWorkbenchStyles from "./DataWorkbenchStyles.js";
import {
  fetchStorageInventory,
  type StorageInventoryFilters,
  type StorageInventoryResponse,
} from "../../services/storageInventoryApi.js";
import {
  groupGapsByInstrument,
  groupSeriesByInstrument,
  instrumentGroupKey,
} from "./workbenchInventory.js";
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

function FoldSection({
  title,
  description,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <section className={`dw-section${open ? " expanded" : " collapsed"}`}>
      <button
        aria-expanded={open}
        className="dw-fold-head"
        onClick={onToggle}
        type="button"
      >
        <span aria-hidden="true" className="dw-fold-disclosure">
          <span className="dw-fold-chevron">▸</span>
        </span>
        <span className="dw-fold-copy">
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </span>
        <span className="dw-fold-meta">
          {badge}
          <span className="dw-fold-hint">
            {open ? t("workbench.collapseSection") : t("workbench.expandSection")}
          </span>
        </span>
      </button>
      {open ? <div className="dw-fold-body">{children}</div> : null}
    </section>
  );
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
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [integrityTouched, setIntegrityTouched] = useState(false);
  const [integrityOpen, setIntegrityOpen] = useState(false);
  const [openSeriesGroups, setOpenSeriesGroups] = useState<Set<string>>(() => new Set());
  const [openGapGroups, setOpenGapGroups] = useState<Set<string>>(() => new Set());

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

  useEffect(() => {
    if (!isOpen) return;
    setSnapshotOpen(false);
    setIntegrityTouched(false);
    setIntegrityOpen(false);
    setOpenSeriesGroups(new Set());
    setOpenGapGroups(new Set());
  }, [isOpen]);

  const seriesGroups = useMemo(
    () => groupSeriesByInstrument(payload?.series ?? []),
    [payload],
  );
  const gapGroups = useMemo(
    () => groupGapsByInstrument(payload?.integrity?.available ? payload.integrity.gapSamples : []),
    [payload],
  );

  useEffect(() => {
    const symbol = appliedFilters.symbol.trim().toUpperCase();
    if (!symbol || !payload) return;
    const keys = new Set(
      payload.series
        .filter((item) => item.symbol === symbol)
        .filter((item) => !appliedFilters.exchange || item.exchange === appliedFilters.exchange)
        .filter((item) => !appliedFilters.marketType || item.marketType === appliedFilters.marketType)
        .map((item) => instrumentGroupKey(item.exchange, item.marketType, item.symbol)),
    );
    if (keys.size > 0) setOpenSeriesGroups(keys);
  }, [appliedFilters, payload]);

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

  const toggleSeriesGroup = useCallback((key: string) => {
    setOpenSeriesGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGapGroup = useCallback((key: string) => {
    setOpenGapGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!isOpen) return null;

  const integrity = payload?.integrity;
  const hasCurrentSymbol = Boolean(currentSymbol.trim());
  const hasGaps = Boolean(integrity?.available && integrity.openGapCount > 0);
  const integrityExpanded = integrityTouched ? integrityOpen : hasGaps;
  const gapBadge = !integrity
    ? null
    : !integrity.available
      ? <span className="dw-badge dw-badge-error">{t("workbench.statusUnavailable", {}, locale)}</span>
      : hasGaps
        ? <span className="dw-badge dw-badge-warning">{t("workbench.openGaps", { count: integrity.openGapCount.toLocaleString(locale) }, locale)}</span>
        : <span className="dw-badge dw-badge-ok">{t("workbench.summaryNoGaps", {}, locale)}</span>;
  const fileChipValue = payload
    ? (payload.snapshot.fileSetStable ? t("workbench.fileStable", {}, locale) : t("workbench.fileWriting", {}, locale))
    : "--";
  const gapChipValue = !integrity
    ? "--"
    : !integrity.available
      ? t("workbench.statusUnavailable", {}, locale)
      : hasGaps
        ? String(integrity.openGapCount.toLocaleString(locale))
        : t("workbench.summaryNoGaps", {}, locale);

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
              <h3>{t("workbench.filterTitle", {}, locale)}</h3>
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

          <div className="dw-summary">
            <div className="dw-summary-chip">
              <span>{t("workbench.physical", {}, locale)}</span>
              <strong>{payload ? formatBytes(payload.snapshot.physicalSizeBytes) : "--"}</strong>
            </div>
            <div className="dw-summary-chip">
              <span>{t("workbench.summarySeries", {}, locale)}</span>
              <strong>{payload ? payload.inventory.matchingSeries.toLocaleString(locale) : "--"}</strong>
            </div>
            <div className={`dw-summary-chip${hasGaps ? " warning" : ""}`}>
              <span>{t("workbench.summaryGaps", {}, locale)}</span>
              <strong>{gapChipValue}</strong>
            </div>
            <div className={`dw-summary-chip${payload && !payload.snapshot.fileSetStable ? " warning" : ""}`}>
              <span>{t("workbench.fileStatus", {}, locale)}</span>
              <strong>{fileChipValue}</strong>
            </div>
          </div>

          {error ? <div className="dw-notice dw-notice-error">{error}</div> : null}

          <FoldSection
            title={t("workbench.snapshot", {}, locale)}
            description={payload ? t("workbench.capturedAt", { time: formatDateTime(payload.capturedAtMs, locale) }, locale) : t("workbench.readingSnapshot", {}, locale)}
            badge={payload ? (
              <span className={`dw-badge ${payload.snapshot.fileSetStable ? "dw-badge-ok" : "dw-badge-warning"}`}>
                {payload.snapshot.fileSetStable ? t("workbench.fileStable", {}, locale) : t("workbench.fileWriting", {}, locale)}
              </span>
            ) : null}
            open={snapshotOpen}
            onToggle={() => setSnapshotOpen((value) => !value)}
          >
            <div className="dw-stat-grid">
              <div className="dw-stat-card"><span>{t("workbench.physical", {}, locale)}</span><strong>{payload ? formatBytes(payload.snapshot.physicalSizeBytes) : "--"}</strong><small>DB + WAL</small></div>
              <div className="dw-stat-card"><span>{t("workbench.allSeries", {}, locale)}</span><strong>{payload ? payload.inventory.totalSeries.toLocaleString(locale) : "--"}</strong><small>{payload ? t("settings.diag.rows", { count: payload.inventory.totalRows.toLocaleString(locale) }, locale) : t("workbench.realSummary", {}, locale)}</small></div>
              <div className="dw-stat-card"><span>{t("workbench.currentFilter", {}, locale)}</span><strong>{payload ? payload.inventory.matchingSeries.toLocaleString(locale) : "--"}</strong><small>{payload ? t("settings.diag.rows", { count: payload.inventory.matchingRows.toLocaleString(locale) }, locale) : "--"}</small></div>
              <div className="dw-stat-card"><span>{t("workbench.fileStatus", {}, locale)}</span><strong>{payload?.snapshot.exists ? t("workbench.found", {}, locale) : payload ? t("workbench.notCreated", {}, locale) : "--"}</strong><small>{payload ? t("workbench.totalSize", { size: formatBytes(payload.snapshot.totalSizeBytes) }, locale) : "--"}</small></div>
            </div>
            {payload && !payload.snapshot.fileSetStable ? (
              <div className="dw-notice dw-notice-warning">{t("workbench.writeDuringCapture", {}, locale)}</div>
            ) : null}
          </FoldSection>

          <FoldSection
            title={t("workbench.integrity", {}, locale)}
            badge={gapBadge}
            open={integrityExpanded}
            onToggle={() => {
              setIntegrityTouched(true);
              setIntegrityOpen(!integrityExpanded);
            }}
          >
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
                    {gapGroups.map((group) => {
                      const open = openGapGroups.has(group.key);
                      const expandable = group.gaps.length > 1;
                      const gapIntervals = [...new Set(group.gaps.map((gap) => gap.interval))];
                      return (
                        <article className={`dw-instrument dw-gap-group${open ? " expanded" : ""}`} key={group.key}>
                          {expandable ? (
                            <button
                              aria-expanded={open}
                              className="dw-instrument-head"
                              onClick={() => toggleGapGroup(group.key)}
                              type="button"
                            >
                              <span aria-hidden="true" className="dw-fold-disclosure"><span className="dw-fold-chevron">▸</span></span>
                              <span className="dw-series-name">
                                <strong>{group.symbol || t("workbench.unknownSymbol", {}, locale)}</strong>
                                <small>{group.exchange || "--"} · {formatMarketType(group.marketType, locale)}</small>
                              </span>
                              <span className="dw-interval-chips">
                                {gapIntervals.map((interval) => <span className="dw-chip" key={interval}>{interval}</span>)}
                              </span>
                              <span className="dw-instrument-stats">
                                {tPlural("workbench.intervalCount", gapIntervals.length, {}, locale)}
                                {" · "}
                                {t("workbench.gapBars", { count: group.missingBars.toLocaleString(locale) }, locale)}
                              </span>
                            </button>
                          ) : (
                            <div className="dw-instrument-head static">
                              <span className="dw-fold-disclosure spacer" aria-hidden="true" />
                              <span className="dw-series-name">
                                <strong>{group.symbol || t("workbench.unknownSymbol", {}, locale)}</strong>
                                <small>{group.exchange || "--"} · {formatMarketType(group.marketType, locale)} · {group.gaps[0]?.interval}</small>
                              </span>
                              <span className="dw-instrument-stats">{group.gaps[0]?.status}</span>
                              <span className="dw-instrument-stats">{t("workbench.missingBars", { count: group.missingBars.toLocaleString(locale) }, locale)}</span>
                            </div>
                          )}
                          {expandable && open ? (
                            <div className="dw-instrument-detail">
                              {group.gaps.map((gap, index) => (
                                <div className="dw-interval-row" key={`${gap.interval}:${gap.status}:${index}`}>
                                  <span className="dw-mono">{gap.interval}</span>
                                  <span>{gap.status}</span>
                                  <span>{t("workbench.missingBars", { count: gap.missingBars.toLocaleString(locale) }, locale)}</span>
                                  <span>{t("workbench.lastChecked", { time: formatDateTime(gap.lastCheckedAtMs, locale) }, locale)}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                    {integrity.openGapCount > integrity.gapSamples.length ? (
                      <div className="dw-gap-more">{t("workbench.gapSamples", { shown: integrity.gapSamples.length.toLocaleString(locale), limit: integrity.sampleLimit.toLocaleString(locale) }, locale)}</div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </FoldSection>

          <section className="dw-section dw-series-section">
            <div className="dw-section-heading">
              <h3>{t("workbench.storedSeries", {}, locale)}</h3>
              {payload ? (
                <span className="dw-result-count">
                  {t("workbench.showingGroups", {
                    groups: seriesGroups.length.toLocaleString(locale),
                    series: payload.inventory.returnedSeries.toLocaleString(locale),
                  }, locale)}
                </span>
              ) : null}
            </div>
            {payload?.inventory.truncated ? (
              <div className="dw-notice dw-notice-warning">{t("workbench.truncated", { matching: payload.inventory.matchingSeries.toLocaleString(locale), shown: payload.inventory.returnedSeries.toLocaleString(locale) }, locale)}</div>
            ) : null}
            <div className="dw-instrument-list">
              {loading && !payload ? <div className="dw-empty">{t("workbench.readingInventory", {}, locale)}</div> : null}
              {!loading && payload?.series.length === 0 ? <div className="dw-empty">{t("workbench.emptySeries", {}, locale)}</div> : null}
              {seriesGroups.map((group) => {
                const open = openSeriesGroups.has(group.key);
                const expandable = group.series.length > 1;
                const intervals = group.series.map((item) => item.interval);
                const visibleIntervals = intervals.slice(0, 8);
                return (
                  <article className={`dw-instrument${open ? " expanded" : ""}`} key={group.key}>
                    {expandable ? (
                      <button
                        aria-expanded={open}
                        className="dw-instrument-head"
                        onClick={() => toggleSeriesGroup(group.key)}
                        type="button"
                      >
                        <span aria-hidden="true" className="dw-fold-disclosure"><span className="dw-fold-chevron">▸</span></span>
                        <span className="dw-series-name">
                          <strong>{group.symbol}</strong>
                          <small>{group.exchange} · {formatMarketType(group.marketType, locale)}</small>
                        </span>
                        <span className="dw-interval-chips">
                          {visibleIntervals.map((interval) => <span className="dw-chip" key={interval}>{interval}</span>)}
                          {intervals.length > visibleIntervals.length ? <span className="dw-chip muted">+{intervals.length - visibleIntervals.length}</span> : null}
                        </span>
                        <span className="dw-instrument-stats">
                          {tPlural("workbench.intervalCount", group.series.length, {}, locale)}
                          {" · "}
                          {t("settings.diag.rows", { count: group.totalCount.toLocaleString(locale) }, locale)}
                        </span>
                      </button>
                    ) : (
                      <div className="dw-instrument-head static">
                        <span className="dw-fold-disclosure spacer" aria-hidden="true" />
                        <span className="dw-series-name">
                          <strong>{group.symbol}</strong>
                          <small>{group.exchange} · {formatMarketType(group.marketType, locale)}</small>
                        </span>
                        <span className="dw-interval-chips">
                          <span className="dw-chip">{group.series[0]?.interval}</span>
                        </span>
                        <span className="dw-instrument-stats">
                          {t("settings.diag.rows", { count: group.totalCount.toLocaleString(locale) }, locale)}
                          {" · "}
                          {formatDateTime(group.earliestOpenMs, locale)} → {formatDateTime(group.latestOpenMs, locale)}
                        </span>
                      </div>
                    )}
                    {expandable && open ? (
                      <div className="dw-instrument-detail">
                        {group.series.map((item) => (
                          <div className="dw-interval-row" key={item.interval}>
                            <span className="dw-mono">{item.interval}</span>
                            <span>{t("settings.diag.rows", { count: item.totalCount.toLocaleString(locale) }, locale)}</span>
                            <span>{formatDateTime(item.earliestOpenMs, locale)}</span>
                            <span>{formatDateTime(item.latestOpenMs, locale)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </section>
      <DataWorkbenchStyles />
    </div>
  );
}
