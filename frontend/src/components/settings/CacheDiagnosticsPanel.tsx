import type { ReactNode } from "react";
import { getLocale, t, type MessageKey } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { GcVictim } from "../../features/cache-gc/cacheGcTypes.js";
import type {
  BackendDiagnosticsResult,
  BackendGcVictim,
  CacheDiagnosticsRuntime,
} from "../../features/settings/cacheDiagnosticsSettingsRuntime.js";

const REASON_KEYS: Record<string, MessageKey> = {
  "cold-cache-over-budget": "settings.diag.reason.coldOverBudget",
  "estimated-bytes-over-budget": "settings.diag.reason.bytesOverBudget",
  "cold-non-ephemeral-storage-backed": "settings.diag.reason.coldStorageBacked",
  "ephemeral-over-limit": "settings.diag.reason.ephemeralOverLimit",
  "indicator-points-over-budget": "settings.diag.reason.indicatorOverBudget",
  "kline-bars-over-budget": "settings.diag.reason.klineOverBudget",
  "missing-kline-dependency": "settings.diag.reason.missingKline",
  "minutes-tier-retention": "settings.diag.reason.minutesRetention",
  "hours-tier-retention": "settings.diag.reason.hoursRetention",
  "daily-tier-retention": "settings.diag.reason.dailyRetention",
  "sqlite-budget-pressure": "settings.diag.reason.sqlitePressure",
  "warm-cache-over-budget": "settings.diag.reason.warmOverBudget",
};

const RISK_KEYS: Record<string, MessageKey> = {
  "active-or-subscribed": "settings.diag.risk.active",
  "custom-interval": "settings.diag.risk.customInterval",
  "latest-data-close-to-now": "settings.diag.risk.nearRealtime",
  "storage-intent": "settings.diag.risk.storageIntent",
};

const WATERMARK_KEYS: Record<string, MessageKey> = {
  unconfigured: "settings.diag.watermark.unconfigured",
  normal: "settings.diag.watermark.normal",
  high: "settings.diag.watermark.high",
  critical: "settings.diag.watermark.critical",
  over_budget: "settings.diag.watermark.overBudget",
};

function formatBytes(bytes: unknown): string {
  const value = Number(bytes || 0);
  if (!value) return "--";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatNumber(value: unknown): string {
  return Number(value || 0).toLocaleString(getLocale());
}

function reasonLabel(reason: unknown): string {
  const key = typeof reason === "string" ? reason : "";
  const messageKey = REASON_KEYS[key];
  return messageKey ? t(messageKey) : (key || "--");
}

function riskLabel(flags: string[] = []): string {
  if (!flags.length) return t("settings.diag.routine");
  return flags.map((flag) => {
    const messageKey = RISK_KEYS[flag];
    return messageKey ? t(messageKey) : flag;
  }).join(" / ");
}

function watermarkLabel(level: unknown): string {
  const key = typeof level === "string" ? level : "";
  const messageKey = WATERMARK_KEYS[key];
  return messageKey ? t(messageKey) : (key || "--");
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

function StatCard({ label, value, detail }: StatCardProps) {
  return (
    <div className="st-diagnostics-card">
      <span className="st-diagnostics-label">{label}</span>
      <strong className="st-diagnostics-value">{value}</strong>
      {detail ? <span className="st-diagnostics-detail">{detail}</span> : null}
    </div>
  );
}

interface GcPlanSummary {
  victims?: readonly unknown[];
  series?: readonly unknown[];
}

function countVictims(plan: GcPlanSummary | null | undefined): number {
  return Number(plan?.victims?.length ?? plan?.series?.length ?? 0);
}

interface ScopeSummaryCardProps {
  title: string;
  mode: string;
  plan: GcPlanSummary | null;
  result: unknown;
  metricLabel?: string;
  metricValue: string;
}

function ScopeSummaryCard({ title, mode, plan, result, metricLabel, metricValue }: ScopeSummaryCardProps) {
  const plannedCount = countVictims(plan);
  const hasResult = Boolean(result);
  let status = t("settings.diag.pending");
  let detail = mode;
  if (plannedCount) {
    status = t("settings.diag.planned");
    detail = t("settings.diag.candidates", { count: formatNumber(plannedCount) });
  }
  if (hasResult) {
    status = t("settings.diag.executed");
    detail = metricValue;
  }
  return (
    <div className="st-gc-scope-card">
      <span className="st-gc-scope-title">{title}</span>
      <strong className="st-gc-scope-status">{status}</strong>
      <span className="st-gc-scope-detail">{metricLabel ? `${metricLabel} ${detail}` : detail}</span>
    </div>
  );
}

interface SectionTitleProps {
  title: string;
  badge?: string;
  tone?: string;
}

function SectionTitle({ title, badge, tone = "memory" }: SectionTitleProps) {
  return (
    <div className="st-diagnostics-heading-row">
      <div className="st-diagnostics-heading">{title}</div>
      {badge ? <span className={`st-badge st-badge-${tone}`}>{badge}</span> : null}
    </div>
  );
}

interface GcPlanRowsProps {
  victims?: Array<GcVictim | BackendGcVictim>;
}

function GcPlanRows({ victims = [] }: GcPlanRowsProps) {
  if (!victims.length) {
    return <div className="st-diagnostics-empty">{t("settings.diag.empty")}</div>;
  }
  return (
    <div className="st-diagnostics-list">
      {victims.slice(0, 8).map((entry) => (
        <div key={`${entry.owner}:${entry.key}`} className="st-diagnostics-row st-diagnostics-row-wide">
          <span className="st-diagnostics-row-key">{entry.key}</span>
          <span>{reasonLabel(entry.reason)}</span>
          <span>{formatBytes(entry.estimatedBytes ?? entry.estimated_bytes ?? entry.would_free_estimated_bytes)}</span>
        </div>
      ))}
    </div>
  );
}

type CacheListEntry = { key?: string } & Record<string, unknown>;

interface TopEntriesProps {
  entries?: CacheListEntry[];
  metric?: string;
}

function TopEntries({ entries = [], metric = "bars" }: TopEntriesProps) {
  const sorted = [...entries]
    .sort((left, right) => Number(right[metric] || 0) - Number(left[metric] || 0))
    .slice(0, 5);
  if (!sorted.length) {
    return <div className="st-diagnostics-empty">{t("settings.diag.noEntries")}</div>;
  }
  return (
    <div className="st-diagnostics-list">
      {sorted.map((entry) => (
        <div key={entry.key} className="st-diagnostics-row">
          <span className="st-diagnostics-row-key">{entry.key}</span>
          <span>{formatNumber(entry[metric])}</span>
        </div>
      ))}
    </div>
  );
}

export type CacheDiagnosticsPanelProps = Pick<
  CacheDiagnosticsRuntime,
  | "backendDiagnostics"
  | "backendMemoryGcPlan"
  | "backendMemoryGcResult"
  | "error"
  | "frontendDiagnostics"
  | "frontendGcPlan"
  | "frontendGcResult"
  | "loading"
  | "onPlanBackendMemoryGc"
  | "onPlanFrontendGc"
  | "onPlanStorageGc"
  | "onRunBackendMemoryGc"
  | "onRunFrontendGc"
  | "onRunStorageGc"
  | "onRefresh"
  | "onVacuumStorage"
  | "storageGcPlan"
  | "storageGcResult"
  | "storageVacuumResult"
>;

export default function CacheDiagnosticsPanel({
  backendDiagnostics,
  backendMemoryGcPlan,
  backendMemoryGcResult,
  error,
  frontendDiagnostics,
  frontendGcPlan,
  frontendGcResult,
  loading,
  onPlanBackendMemoryGc,
  onPlanFrontendGc,
  onPlanStorageGc,
  onRunBackendMemoryGc,
  onRunFrontendGc,
  onRunStorageGc,
  onRefresh,
  onVacuumStorage,
  storageGcPlan,
  storageGcResult,
  storageVacuumResult,
}: CacheDiagnosticsPanelProps) {
  useLocale();
  const frontend = frontendDiagnostics || {};
  const owners = frontend.owners || {};
  const chart = owners.chart || {};
  const watchlist = owners.watchlist || {};
  const indicators = owners.indicators || {};
  const backendCache = backendDiagnostics?.data_manager?.cache || {};
  const storageFiles = backendDiagnostics?.storage?.files || {};
  const storageSeries = backendDiagnostics?.storage?.series || {};
  const storageWatermarks = storageGcPlan?.watermarks || backendDiagnostics?.storage?.watermarks || {};
  const pyneCache = backendDiagnostics?.indicator?.pyne_cache || {};
  const canRunFrontendGc = Boolean(frontendGcPlan?.victims?.length) && !frontendGcResult;
  const canRunBackendMemoryGc = Boolean(backendMemoryGcPlan?.victims?.length) && !backendMemoryGcResult;
  const canRunStorageGc = Boolean(storageGcPlan?.series?.length) && !storageGcResult;
  const canVacuumStorage = Boolean(
    storageGcResult?.vacuum_recommended || storageGcPlan?.vacuum_recommended
  ) && !storageVacuumResult;

  return (
    <div className="st-group">
      <div className="st-group-title-row">
        <div className="st-group-title" style={{ marginBottom: 0 }}>
          {t("settings.diag.title")}
          <span className="st-badge st-badge-memory">{t("settings.diag.layered")}</span>
        </div>
        <button className="st-advanced-toggle" onClick={() => onRefresh?.()} disabled={loading}>
          {loading ? t("settings.diag.refreshing") : t("settings.diag.refresh")}
        </button>
      </div>
      <div className="st-group-desc">
        {t("settings.diag.desc")}
      </div>

      {error ? <div className="st-info-box st-info-warn">{error}</div> : null}

      <div className="st-gc-scope-grid">
        <ScopeSummaryCard
          title={t("settings.diag.frontendMem")}
          mode={t("settings.diag.browserCache")}
          plan={frontendGcPlan}
          result={frontendGcResult}
          metricLabel={t("settings.diag.freed")}
          metricValue={formatBytes(frontendGcResult?.removedEstimatedBytes)}
        />
        <ScopeSummaryCard
          title={t("settings.diag.backendMem")}
          mode="DataManager"
          plan={backendMemoryGcPlan}
          result={backendMemoryGcResult}
          metricLabel={t("settings.diag.freed")}
          metricValue={`${formatNumber(backendMemoryGcResult?.removed_bars)} bars`}
        />
        <ScopeSummaryCard
          title={t("settings.diag.sqlite")}
          mode={t("settings.diag.persistent")}
          plan={storageGcPlan}
          result={storageGcResult}
          metricLabel={t("settings.diag.deleted")}
          metricValue={t("settings.diag.rows", { count: formatNumber(storageGcResult?.deleted_rows) })}
        />
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title={t("settings.diag.frontendCache")} badge={t("settings.diag.local")} />
        <div className="st-diagnostics-grid">
          <StatCard label={t("settings.diag.chartBars")} value={t("settings.diag.barsUnit", { count: formatNumber(chart.totalBars) })} detail={t("settings.diag.seriesCount", { count: formatNumber(chart.seriesCount) })} />
          <StatCard label={t("settings.diag.watchlistFull")} value={t("settings.diag.barsUnit", { count: formatNumber(watchlist.totalBars) })} detail={t("settings.diag.seriesCount", { count: formatNumber(watchlist.seriesCount) })} />
          <StatCard label={t("settings.diag.indicatorResults")} value={t("settings.diag.pointsUnit", { count: formatNumber(indicators.totalPoints) })} detail={t("settings.diag.entriesUnit", { count: formatNumber(indicators.entryCount) })} />
          <StatCard label={t("settings.diag.estimatedMem")} value={formatBytes(frontend.estimatedBytes)} detail={t("settings.diag.browserEstimate")} />
        </div>
        <TopEntries entries={[...(chart.entries || []), ...(watchlist.entries || [])]} metric="bars" />
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanFrontendGc?.()}>
            {t("settings.diag.planFrontend")}
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onRunFrontendGc?.()}
            disabled={!canRunFrontendGc}
          >
            {t("settings.diag.runFrontend")}
          </button>
        </div>
        {frontendGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label={t("settings.diag.wouldFree")} value={formatBytes(frontendGcPlan.wouldFreeEstimatedBytes)} detail={t("settings.diag.entriesCount", { count: formatNumber(frontendGcPlan.victims?.length) })} />
              <StatCard label={t("settings.diag.barCount")} value={formatNumber(frontendGcPlan.wouldFreeBars)} detail={t("settings.diag.pressureBars", { count: formatNumber(frontendGcPlan.pressure?.klineBars) })} />
              <StatCard label={t("settings.diag.indicatorPoints")} value={formatNumber(frontendGcPlan.wouldFreeIndicatorPoints)} detail={t("settings.diag.pressurePoints", { count: formatNumber(frontendGcPlan.pressure?.indicatorPoints) })} />
              <StatCard label={t("settings.diag.protectedEntries")} value={formatNumber(frontendGcPlan.protectedCount)} detail="active/subscribed" />
            </div>
            <GcPlanRows victims={frontendGcPlan.victims || []} />
          </div>
        ) : null}
        {frontendGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">{t("settings.diag.gcResult")}</span>
            <span>{t("settings.diag.removedEntries", { count: formatNumber(frontendGcResult.removedCount) })}</span>
            <span>{t("settings.diag.freedEst", { bytes: formatBytes(frontendGcResult.removedEstimatedBytes) })}</span>
            <span>{t("settings.diag.barsRemoved", { count: formatNumber(frontendGcResult.removedBars) })}</span>
            <span>{t("settings.diag.pointsRemoved", { count: formatNumber(frontendGcResult.removedIndicatorPoints) })}</span>
          </div>
        ) : null}
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title={t("settings.diag.backendCache")} badge={t("settings.diag.inProcess")} />
        <div className="st-diagnostics-grid">
          <StatCard label="DataManager series" value={formatNumber(backendCache.total_series)} detail={t("settings.diag.cap", { count: formatNumber(backendCache.max_series) })} />
          <StatCard label="DataManager bars" value={formatNumber(backendCache.total_bars)} detail={t("settings.diag.perSeries", { count: formatNumber(backendCache.max_bars_per_series) })} />
          <StatCard label={t("settings.diag.cacheHits")} value={formatNumber(backendCache.hits)} detail={t("settings.diag.misses", { count: formatNumber(backendCache.misses) })} />
          <StatCard label="Pyne cache" value={formatNumber(pyneCache.size ?? pyneCache.items ?? 0)} detail={t("settings.diag.cap", { count: formatNumber(pyneCache.max_items ?? pyneCache.maxItems ?? 0) })} />
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanBackendMemoryGc?.()} disabled={loading}>
            {t("settings.diag.planBackend")}
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onRunBackendMemoryGc?.()}
            disabled={loading || !canRunBackendMemoryGc}
          >
            {t("settings.diag.runBackend")}
          </button>
        </div>
        {backendMemoryGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label={t("settings.diag.wouldFree")} value={formatBytes(backendMemoryGcPlan.would_free_estimated_bytes)} detail={t("settings.diag.entriesCount", { count: formatNumber(backendMemoryGcPlan.victims?.length) })} />
              <StatCard label={t("settings.diag.wouldFreeBars")} value={formatNumber(backendMemoryGcPlan.would_free_bars)} detail={t("settings.diag.seriesUnit", { count: formatNumber(backendMemoryGcPlan.would_remove_series) })} />
              <StatCard label={t("settings.diag.protected")} value={formatNumber(backendMemoryGcPlan.protected_count)} detail="active/subscribed" />
              <StatCard label={t("settings.diag.pressure")} value={formatNumber(backendMemoryGcPlan.pressure?.total_bars)} detail={t("settings.diag.cap", { count: formatNumber(backendMemoryGcPlan.pressure?.max_total_bars) })} />
            </div>
            <GcPlanRows victims={backendMemoryGcPlan.victims || []} />
          </div>
        ) : null}
        {backendMemoryGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">{t("settings.diag.backendResult")}</span>
            <span>{t("settings.diag.removedSeries", { count: formatNumber(backendMemoryGcResult.removed_series) })}</span>
            <span>{t("settings.diag.trimmedSeries", { count: formatNumber(backendMemoryGcResult.trimmed_series) })}</span>
            <span>{t("settings.diag.freedBars", { count: formatNumber(backendMemoryGcResult.removed_bars) })}</span>
            <span>{t("settings.diag.estimated", { bytes: formatBytes(backendMemoryGcResult.removed_estimated_bytes) })}</span>
          </div>
        ) : null}
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title={t("settings.diag.sqliteStorage")} badge={t("settings.diag.persistentBadge")} tone="db" />
        <div className="st-diagnostics-grid">
          <StatCard label={t("settings.diag.dbFile")} value={formatBytes(storageFiles.db_size_bytes)} detail={storageFiles.exists ? t("settings.diag.created") : t("settings.diag.notCreated")} />
          <StatCard label={t("settings.diag.walFile")} value={formatBytes(storageFiles.wal_size_bytes)} detail={t("settings.diag.readonly")} />
          <StatCard label="Series" value={formatNumber(storageSeries.series_count)} detail={t("settings.diag.totalRows", { count: formatNumber(storageSeries.total_rows) })} />
          <StatCard label={t("settings.diag.totalSize")} value={formatBytes(storageFiles.total_size_bytes)} detail="DB + WAL + SHM" />
          <StatCard
            label={t("settings.diag.sqliteBudget")}
            value={storageWatermarks.budget_bytes ? formatBytes(storageWatermarks.budget_bytes) : t("settings.diag.unset")}
            detail={t("settings.diag.watermark", { level: watermarkLabel(storageWatermarks.level) })}
          />
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanStorageGc?.()} disabled={loading}>
            {t("settings.diag.planStorage")}
          </button>
          <button
            className="st-btn st-btn-warn"
            onClick={() => onRunStorageGc?.()}
            disabled={loading || !canRunStorageGc}
          >
            {t("settings.diag.runStorage")}
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onVacuumStorage?.()}
            disabled={loading || !canVacuumStorage}
          >
            {t("settings.diag.vacuum")}
          </button>
        </div>
        {storageGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label={t("settings.diag.wouldDeleteRows")} value={formatNumber(storageGcPlan.would_delete_rows)} detail={t("settings.diag.seriesUnit", { count: formatNumber(storageGcPlan.victim_count) })} />
              <StatCard label={t("settings.diag.freeEst")} value={formatBytes(storageGcPlan.would_free_estimated_bytes)} detail={t("settings.diag.roughEst")} />
              <StatCard label={t("settings.diag.budgetLevel")} value={watermarkLabel(storageGcPlan.watermarks?.level)} detail={`${((storageGcPlan.watermarks?.budget_usage_ratio || 0) * 100).toFixed(1)}%`} />
              <StatCard label={t("settings.diag.vacuumLabel")} value={storageGcPlan.vacuum_recommended ? t("settings.diag.recommended") : t("settings.diag.optional")} detail={t("settings.diag.notAuto")} />
            </div>
            {storageGcPlan.unable_to_reach_budget ? (
              <div className="st-info-box st-info-warn">
                <span className="st-info-label">{t("settings.diag.budgetWarn")}</span>
                <span>{t("settings.diag.budgetGap", { bytes: formatBytes(storageGcPlan.budget_gap_bytes) })}</span>
              </div>
            ) : null}
            {storageGcPlan.series?.length ? (
              <div className="st-diagnostics-list">
                {storageGcPlan.series.slice(0, 8).map((entry) => (
                  <div key={`${entry.owner}:${entry.key}`} className="st-diagnostics-row st-diagnostics-row-storage">
                    <span className="st-diagnostics-row-key">{entry.key}</span>
                    <span>{reasonLabel(entry.reason)}</span>
                    <span>{t("settings.diag.rows", { count: formatNumber(entry.would_delete_rows) })}</span>
                    <span>{riskLabel(entry.risk_flags)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="st-diagnostics-empty">{t("settings.diag.noStorageVictims")}</div>
            )}
          </div>
        ) : null}
        {storageGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">{t("settings.diag.storageResult")}</span>
            <span>{t("settings.diag.deletedRows", { count: formatNumber(storageGcResult.deleted_rows) })}</span>
            <span>{t("settings.diag.affectedSeries", { count: formatNumber(storageGcResult.affected_series) })}</span>
            <span>{t("settings.diag.elapsed", { count: formatNumber(storageGcResult.elapsed_ms) })}</span>
            <span>{storageGcResult.checkpoint_result ? t("settings.diag.checkpointDone") : t("settings.diag.checkpointSkip")}</span>
          </div>
        ) : null}
        {storageVacuumResult ? (
          <div className="st-info-box">
            <span className="st-info-label">{t("settings.diag.vacuumResult")}</span>
            <span>{storageVacuumResult.status || "ok"}</span>
            <span>{t("settings.diag.elapsed", { count: formatNumber(storageVacuumResult.elapsed_ms) })}</span>
            <span>{t("settings.diag.currentTotal", { bytes: formatBytes(storageVacuumResult.storage_files_after?.total_size_bytes) })}</span>
          </div>
        ) : null}
        <TopEntries entries={(storageSeries.largest_series || []).map((item) => ({
          key: `${item.exchange}:${item.market_type}:${item.symbol}:${item.interval}`,
          rows: item.total_count,
        }))} metric="rows" />
      </div>
    </div>
  );
}
