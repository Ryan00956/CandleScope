import { useCallback, useEffect, useMemo, useState } from "react";
import DataWorkbenchStyles from "./DataWorkbenchStyles.js";
import {
  fetchStorageInventory,
  type StorageInventoryFilters,
  type StorageInventoryResponse,
} from "../../services/storageInventoryApi.js";

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

function formatDateTime(value: number | null): string {
  if (value === null) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMarketType(value: string): string {
  if (value === "futures") return "合约";
  if (value === "swap") return "永续";
  return "现货";
}

function formatCountMap(values: Record<string, number>): string {
  const entries = Object.entries(values);
  return entries.length
    ? entries.map(([key, value]) => `${key}: ${value.toLocaleString()}`).join(" · ")
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
        setError(`数据工作台无法读取真实库存：${errorMessage(loadError)}`);
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
        aria-label="数据工作台"
        aria-modal="true"
        className="dw-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="dw-header">
          <div>
            <div className="dw-kicker">真实运行数据 · 只读快照</div>
            <h2 className="dw-title">数据工作台</h2>
            <p className="dw-subtitle">库存和缺口只来自当前后端；此处不执行删除、补全或数据库压缩。</p>
          </div>
          <button aria-label="关闭数据工作台" className="dw-close" onClick={onClose} type="button">✕</button>
        </header>

        <div className="dw-body">
          <section className="dw-filter-card">
            <div className="dw-filter-title-row">
              <div>
                <h3>库存筛选</h3>
                <p>筛选在后端执行，当前结果最多返回 500 个序列。</p>
              </div>
              <div className="dw-live-badges">
                <span className="dw-badge dw-badge-live">LIVE</span>
                <span className="dw-badge dw-badge-readonly">只读</span>
              </div>
            </div>
            <div className="dw-filter-grid">
              <label>
                <span>交易所</span>
                <select value={draftFilters.exchange} onChange={(event) => setDraftFilters((current) => ({ ...current, exchange: event.target.value }))}>
                  <option value="">全部交易所</option>
                  {exchangeOptions.map((exchange) => <option key={exchange} value={exchange}>{exchange}</option>)}
                </select>
              </label>
              <label>
                <span>市场</span>
                <select value={draftFilters.marketType} onChange={(event) => setDraftFilters((current) => ({ ...current, marketType: event.target.value }))}>
                  <option value="">全部市场</option>
                  {marketTypeOptions.map((marketType) => <option key={marketType} value={marketType}>{formatMarketType(marketType)}</option>)}
                </select>
              </label>
              <label>
                <span>商品</span>
                <input value={draftFilters.symbol} onChange={(event) => setDraftFilters((current) => ({ ...current, symbol: event.target.value }))} placeholder="BTCUSDT" />
              </label>
              <label>
                <span>周期</span>
                <select value={draftFilters.interval} onChange={(event) => setDraftFilters((current) => ({ ...current, interval: event.target.value }))}>
                  <option value="">全部周期</option>
                  {intervalOptions.map((interval) => <option key={interval} value={interval}>{interval}</option>)}
                </select>
              </label>
            </div>
            <div className="dw-actions">
              <button className="dw-button dw-button-secondary" onClick={resetFilters} type="button">重置</button>
              <button className="dw-button dw-button-secondary" disabled={!hasCurrentSymbol} onClick={focusCurrentSeries} type="button">只看当前图表</button>
              <button className="dw-button dw-button-primary" disabled={loading} onClick={applyFilters} type="button">{loading ? "读取中…" : "应用并刷新"}</button>
            </div>
          </section>

          {error ? <div className="dw-notice dw-notice-error">{error}</div> : null}

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>SQLite 快照</h3>
                <p>{payload ? `采集于 ${formatDateTime(payload.capturedAtMs)}` : "正在向后端读取快照"}</p>
              </div>
              {payload ? (
                <span className={`dw-badge ${payload.snapshot.fileSetStable ? "dw-badge-ok" : "dw-badge-warning"}`}>
                  {payload.snapshot.fileSetStable ? "文件集稳定" : "采集期间有写入"}
                </span>
              ) : null}
            </div>
            <div className="dw-stat-grid">
              <div className="dw-stat-card"><span>物理占用</span><strong>{payload ? formatBytes(payload.snapshot.physicalSizeBytes) : "--"}</strong><small>DB + WAL</small></div>
              <div className="dw-stat-card"><span>全部序列</span><strong>{payload ? payload.inventory.totalSeries.toLocaleString() : "--"}</strong><small>{payload ? `${payload.inventory.totalRows.toLocaleString()} 行` : "真实汇总"}</small></div>
              <div className="dw-stat-card"><span>当前筛选</span><strong>{payload ? payload.inventory.matchingSeries.toLocaleString() : "--"}</strong><small>{payload ? `${payload.inventory.matchingRows.toLocaleString()} 行` : "--"}</small></div>
              <div className="dw-stat-card"><span>文件状态</span><strong>{payload?.snapshot.exists ? "已找到" : payload ? "尚未创建" : "--"}</strong><small>{payload ? `总计 ${formatBytes(payload.snapshot.totalSizeBytes)}` : "--"}</small></div>
            </div>
            {payload?.inventory.truncated ? (
              <div className="dw-notice dw-notice-warning">当前筛选匹配 {payload.inventory.matchingSeries.toLocaleString()} 个序列，只展示前 {payload.inventory.returnedSeries.toLocaleString()} 个；请继续缩小筛选范围。</div>
            ) : null}
            {payload && !payload.snapshot.fileSetStable ? (
              <div className="dw-notice dw-notice-warning">SQLite 在采集期间发生写入；请刷新后再依据文件大小或行数做操作判断。</div>
            ) : null}
          </section>

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>数据完整性</h3>
                <p>读取 gap ledger 的已登记缺口，不会发起扫描或修复。</p>
              </div>
              {integrity ? (
                <span className={`dw-badge ${integrity.available ? (integrity.openGapCount ? "dw-badge-warning" : "dw-badge-ok") : "dw-badge-error"}`}>
                  {integrity.available ? `${integrity.openGapCount.toLocaleString()} 个已登记缺口` : "状态不可用"}
                </span>
              ) : null}
            </div>
            {!integrity && loading ? <div className="dw-empty">正在读取完整性状态…</div> : null}
            {integrity && !integrity.available ? (
              <div className="dw-notice dw-notice-error">{integrity.reason}</div>
            ) : null}
            {integrity?.available ? (
              <>
                <div className="dw-integrity-grid">
                  <div><span>状态分布</span><strong>{formatCountMap(integrity.openGapByStatus)}</strong></div>
                  <div><span>缺口年龄</span><strong>{formatCountMap(integrity.openGapAgeBuckets)}</strong></div>
                  <div><span>最早登记</span><strong>{formatDateTime(integrity.oldestOpenGapAtMs)}</strong></div>
                </div>
                {!integrity.openGapCount ? (
                  <div className="dw-empty">Gap ledger 当前没有已登记缺口；这不等同于已经完成一次全库扫描。</div>
                ) : (
                  <div className="dw-gap-list">
                    {integrity.gapSamples.map((gap, index) => (
                      <div className="dw-gap-row" key={`${gap.exchange}:${gap.marketType}:${gap.symbol}:${gap.interval}:${index}`}>
                        <div><strong>{gap.symbol || "未知商品"}</strong><span>{gap.exchange || "--"} · {gap.marketType || "--"} · {gap.interval || "--"}</span></div>
                        <span>{gap.status}</span>
                        <span>缺失 {gap.missingBars.toLocaleString()} 根</span>
                        <span>最近检查 {formatDateTime(gap.lastCheckedAtMs)}</span>
                      </div>
                    ))}
                    {integrity.openGapCount > integrity.gapSamples.length ? (
                      <div className="dw-gap-more">仅展示当前快照中的 {integrity.gapSamples.length.toLocaleString()} 条样本（上限 {integrity.sampleLimit.toLocaleString()}）。</div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </section>

          <section className="dw-section">
            <div className="dw-section-heading">
              <div>
                <h3>实际落库序列</h3>
                <p>以交易所、市场、商品、周期四元组识别；不从前端估算容量或伪造健康状态。</p>
              </div>
              {payload ? <span className="dw-result-count">显示 {payload.inventory.returnedSeries.toLocaleString()} 个</span> : null}
            </div>
            <div className="dw-table" role="table">
              <div className="dw-table-head" role="row">
                <span>序列</span><span>周期</span><span>行数</span><span>起始</span><span>最新</span>
              </div>
              {loading && !payload ? <div className="dw-empty">正在读取真实库存…</div> : null}
              {!loading && payload?.series.length === 0 ? <div className="dw-empty">当前筛选没有实际落库序列。</div> : null}
              {payload?.series.map((series) => (
                <div className="dw-table-row" key={`${series.exchange}:${series.marketType}:${series.symbol}:${series.interval}`} role="row">
                  <span className="dw-series-name"><strong>{series.symbol}</strong><small>{series.exchange} · {formatMarketType(series.marketType)}</small></span>
                  <span className="dw-mono">{series.interval}</span>
                  <span>{series.totalCount.toLocaleString()}</span>
                  <span>{formatDateTime(series.earliestOpenMs)}</span>
                  <span>{formatDateTime(series.latestOpenMs)}</span>
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
