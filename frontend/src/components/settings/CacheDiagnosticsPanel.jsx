function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "--";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function reasonLabel(reason) {
  const labels = {
    "cold-cache-over-budget": "冷缓存超预算",
    "estimated-bytes-over-budget": "估算内存超预算",
    "cold-non-ephemeral-storage-backed": "冷缓存，可由 SQLite 回读",
    "ephemeral-over-limit": "临时缓存超保留量",
    "indicator-points-over-budget": "指标点数超预算",
    "kline-bars-over-budget": "K 线根数超预算",
    "missing-kline-dependency": "K 线依赖已不存在",
    "minutes-tier-retention": "分钟级保留策略",
    "hours-tier-retention": "小时级保留策略",
    "daily-tier-retention": "日线级保留策略",
    "sqlite-budget-pressure": "SQLite 预算压力",
    "warm-cache-over-budget": "预热缓存超预算",
  };
  return labels[reason] || reason || "--";
}

function riskLabel(flags = []) {
  if (!flags.length) return "常规";
  const labels = {
    "active-or-subscribed": "活跃/订阅中",
    "custom-interval": "自定义周期",
    "latest-data-close-to-now": "接近实时尾部",
    "storage-intent": "保留意图",
  };
  return flags.map((flag) => labels[flag] || flag).join(" / ");
}

function watermarkLabel(level) {
  const labels = {
    unconfigured: "未设置",
    normal: "正常",
    high: "偏高",
    critical: "临界",
    over_budget: "超预算",
  };
  return labels[level] || level || "--";
}

function StatCard({ label, value, detail }) {
  return (
    <div className="st-diagnostics-card">
      <span className="st-diagnostics-label">{label}</span>
      <strong className="st-diagnostics-value">{value}</strong>
      {detail ? <span className="st-diagnostics-detail">{detail}</span> : null}
    </div>
  );
}

function countVictims(plan) {
  return Number(plan?.victims?.length ?? plan?.series?.length ?? 0);
}

function ScopeSummaryCard({ title, mode, plan, result, metricLabel, metricValue }) {
  const plannedCount = countVictims(plan);
  const hasResult = Boolean(result);
  let status = "待预估";
  let detail = mode;
  if (plannedCount) {
    status = "已预估";
    detail = `${formatNumber(plannedCount)} 个候选`;
  }
  if (hasResult) {
    status = "已执行";
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

function SectionTitle({ title, badge, tone = "memory" }) {
  return (
    <div className="st-diagnostics-heading-row">
      <div className="st-diagnostics-heading">{title}</div>
      {badge ? <span className={`st-badge st-badge-${tone}`}>{badge}</span> : null}
    </div>
  );
}

function GcPlanRows({ victims = [] }) {
  if (!victims.length) {
    return <div className="st-diagnostics-empty">当前预算下没有可建议回收的缓存</div>;
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

function TopEntries({ entries = [], metric = "bars" }) {
  const sorted = [...entries]
    .sort((left, right) => Number(right[metric] || 0) - Number(left[metric] || 0))
    .slice(0, 5);
  if (!sorted.length) {
    return <div className="st-diagnostics-empty">暂无缓存条目</div>;
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
}) {
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
          缓存与存储 GC
          <span className="st-badge st-badge-memory">分层</span>
        </div>
        <button className="st-advanced-toggle" onClick={() => onRefresh?.()} disabled={loading}>
          {loading ? "刷新中..." : "刷新"}
        </button>
      </div>
      <div className="st-group-desc">
        前端、后端内存和 SQLite 均支持 dry-run 后手动清理；数据库 VACUUM 是单独动作，不会跟普通清理混在一起。
      </div>

      {error ? <div className="st-info-box st-info-warn">{error}</div> : null}

      <div className="st-gc-scope-grid">
        <ScopeSummaryCard
          title="前端内存"
          mode="浏览器缓存"
          plan={frontendGcPlan}
          result={frontendGcResult}
          metricLabel="释放"
          metricValue={formatBytes(frontendGcResult?.removedEstimatedBytes)}
        />
        <ScopeSummaryCard
          title="后端内存"
          mode="DataManager"
          plan={backendMemoryGcPlan}
          result={backendMemoryGcResult}
          metricLabel="释放"
          metricValue={`${formatNumber(backendMemoryGcResult?.removed_bars)} bars`}
        />
        <ScopeSummaryCard
          title="SQLite"
          mode="持久化存储"
          plan={storageGcPlan}
          result={storageGcResult}
          metricLabel="删除"
          metricValue={`${formatNumber(storageGcResult?.deleted_rows)} 行`}
        />
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title="前端内存缓存" badge="本地" />
        <div className="st-diagnostics-grid">
          <StatCard label="主图 K 线" value={`${formatNumber(chart.totalBars)} 根`} detail={`${formatNumber(chart.seriesCount)} 个 series`} />
          <StatCard label="自选 Full" value={`${formatNumber(watchlist.totalBars)} 根`} detail={`${formatNumber(watchlist.seriesCount)} 个 series`} />
          <StatCard label="指标结果" value={`${formatNumber(indicators.totalPoints)} 点`} detail={`${formatNumber(indicators.entryCount)} 个 entry`} />
          <StatCard label="估算内存" value={formatBytes(frontend.estimatedBytes)} detail="浏览器侧粗估" />
        </div>
        <TopEntries entries={[...(chart.entries || []), ...(watchlist.entries || [])]} metric="bars" />
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanFrontendGc?.()}>
            预估前端缓存清理
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onRunFrontendGc?.()}
            disabled={!canRunFrontendGc}
          >
            清理前端 warm/cold 缓存
          </button>
        </div>
        {frontendGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label="可释放估算" value={formatBytes(frontendGcPlan.wouldFreeEstimatedBytes)} detail={`${formatNumber(frontendGcPlan.victims?.length)} 个条目`} />
              <StatCard label="K 线根数" value={formatNumber(frontendGcPlan.wouldFreeBars)} detail={`压力 ${formatNumber(frontendGcPlan.pressure?.klineBars)} 根`} />
              <StatCard label="指标点数" value={formatNumber(frontendGcPlan.wouldFreeIndicatorPoints)} detail={`压力 ${formatNumber(frontendGcPlan.pressure?.indicatorPoints)} 点`} />
              <StatCard label="保护条目" value={formatNumber(frontendGcPlan.protectedCount)} detail="active/subscribed" />
            </div>
            <GcPlanRows victims={frontendGcPlan.victims || []} />
          </div>
        ) : null}
        {frontendGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">清理结果</span>
            <span>移除 {formatNumber(frontendGcResult.removedCount)} 个条目</span>
            <span>释放估算 {formatBytes(frontendGcResult.removedEstimatedBytes)}</span>
            <span>K 线 {formatNumber(frontendGcResult.removedBars)} 根</span>
            <span>指标 {formatNumber(frontendGcResult.removedIndicatorPoints)} 点</span>
          </div>
        ) : null}
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title="后端内存缓存" badge="进程内" />
        <div className="st-diagnostics-grid">
          <StatCard label="DataManager series" value={formatNumber(backendCache.total_series)} detail={`上限 ${formatNumber(backendCache.max_series)}`} />
          <StatCard label="DataManager bars" value={formatNumber(backendCache.total_bars)} detail={`每 series ${formatNumber(backendCache.max_bars_per_series)}`} />
          <StatCard label="Cache 命中" value={formatNumber(backendCache.hits)} detail={`${formatNumber(backendCache.misses)} 次 miss`} />
          <StatCard label="Pyne cache" value={formatNumber(pyneCache.size ?? pyneCache.items ?? 0)} detail={`上限 ${formatNumber(pyneCache.max_items ?? pyneCache.maxItems ?? 0)}`} />
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanBackendMemoryGc?.()} disabled={loading}>
            预估后端内存清理
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onRunBackendMemoryGc?.()}
            disabled={loading || !canRunBackendMemoryGc}
          >
            清理后端内存缓存
          </button>
        </div>
        {backendMemoryGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label="可释放估算" value={formatBytes(backendMemoryGcPlan.would_free_estimated_bytes)} detail={`${formatNumber(backendMemoryGcPlan.victims?.length)} 个条目`} />
              <StatCard label="可释放 bars" value={formatNumber(backendMemoryGcPlan.would_free_bars)} detail={`${formatNumber(backendMemoryGcPlan.would_remove_series)} 个 series`} />
              <StatCard label="受保护" value={formatNumber(backendMemoryGcPlan.protected_count)} detail="active/subscribed" />
              <StatCard label="压力" value={formatNumber(backendMemoryGcPlan.pressure?.total_bars)} detail={`上限 ${formatNumber(backendMemoryGcPlan.pressure?.max_total_bars)}`} />
            </div>
            <GcPlanRows victims={backendMemoryGcPlan.victims || []} />
          </div>
        ) : null}
        {backendMemoryGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">后端清理结果</span>
            <span>删除 {formatNumber(backendMemoryGcResult.removed_series)} 个 series</span>
            <span>裁剪 {formatNumber(backendMemoryGcResult.trimmed_series)} 个 series</span>
            <span>释放 {formatNumber(backendMemoryGcResult.removed_bars)} 根 bars</span>
            <span>估算 {formatBytes(backendMemoryGcResult.removed_estimated_bytes)}</span>
          </div>
        ) : null}
      </div>

      <div className="st-diagnostics-section">
        <SectionTitle title="SQLite 存储" badge="持久化" tone="db" />
        <div className="st-diagnostics-grid">
          <StatCard label="DB 文件" value={formatBytes(storageFiles.db_size_bytes)} detail={storageFiles.exists ? "已创建" : "未创建"} />
          <StatCard label="WAL 文件" value={formatBytes(storageFiles.wal_size_bytes)} detail="只读检测" />
          <StatCard label="Series" value={formatNumber(storageSeries.series_count)} detail={`${formatNumber(storageSeries.total_rows)} 行`} />
          <StatCard label="总占用" value={formatBytes(storageFiles.total_size_bytes)} detail="DB + WAL + SHM" />
          <StatCard
            label="SQLite 预算"
            value={storageWatermarks.budget_bytes ? formatBytes(storageWatermarks.budget_bytes) : "未设置"}
            detail={`水位 ${watermarkLabel(storageWatermarks.level)}`}
          />
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-secondary" onClick={() => onPlanStorageGc?.()} disabled={loading}>
            预估数据库清理
          </button>
          <button
            className="st-btn st-btn-warn"
            onClick={() => onRunStorageGc?.()}
            disabled={loading || !canRunStorageGc}
          >
            执行数据库清理
          </button>
          <button
            className="st-btn st-btn-accent"
            onClick={() => onVacuumStorage?.()}
            disabled={loading || !canVacuumStorage}
          >
            压缩数据库文件
          </button>
        </div>
        {storageGcPlan ? (
          <div className="st-diagnostics-plan">
            <div className="st-diagnostics-grid">
              <StatCard label="将删除行数" value={formatNumber(storageGcPlan.would_delete_rows)} detail={`${formatNumber(storageGcPlan.victim_count)} 个 series`} />
              <StatCard label="释放估算" value={formatBytes(storageGcPlan.would_free_estimated_bytes)} detail="粗略按总大小/总行数估算" />
              <StatCard label="预算水位" value={watermarkLabel(storageGcPlan.watermarks?.level)} detail={`${((storageGcPlan.watermarks?.budget_usage_ratio || 0) * 100).toFixed(1)}%`} />
              <StatCard label="VACUUM" value={storageGcPlan.vacuum_recommended ? "建议" : "手动可选"} detail="不会自动执行" />
            </div>
            {storageGcPlan.unable_to_reach_budget ? (
              <div className="st-info-box st-info-warn">
                <span className="st-info-label">预算提醒</span>
                <span>受保护数据过多，自动 GC 预计仍差 {formatBytes(storageGcPlan.budget_gap_bytes)} 才能回到目标水位</span>
              </div>
            ) : null}
            {storageGcPlan.series?.length ? (
              <div className="st-diagnostics-list">
                {storageGcPlan.series.slice(0, 8).map((entry) => (
                  <div key={`${entry.owner}:${entry.key}`} className="st-diagnostics-row st-diagnostics-row-storage">
                    <span className="st-diagnostics-row-key">{entry.key}</span>
                    <span>{reasonLabel(entry.reason)}</span>
                    <span>{formatNumber(entry.would_delete_rows)} 行</span>
                    <span>{riskLabel(entry.risk_flags)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="st-diagnostics-empty">当前预算与高级行数策略下没有会被删除的数据库行</div>
            )}
          </div>
        ) : null}
        {storageGcResult ? (
          <div className="st-info-box">
            <span className="st-info-label">数据库清理结果</span>
            <span>删除 {formatNumber(storageGcResult.deleted_rows)} 行</span>
            <span>影响 {formatNumber(storageGcResult.affected_series)} 个 series</span>
            <span>耗时 {formatNumber(storageGcResult.elapsed_ms)} ms</span>
            <span>Checkpoint {storageGcResult.checkpoint_result ? "已执行" : "未执行"}</span>
          </div>
        ) : null}
        {storageVacuumResult ? (
          <div className="st-info-box">
            <span className="st-info-label">VACUUM 结果</span>
            <span>{storageVacuumResult.status || "ok"}</span>
            <span>耗时 {formatNumber(storageVacuumResult.elapsed_ms)} ms</span>
            <span>当前总占用 {formatBytes(storageVacuumResult.storage_files_after?.total_size_bytes)}</span>
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
