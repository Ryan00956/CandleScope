import {
  buildAdvancedMarketIdentityKey,
  DEFAULT_OPEN_INTEREST_PERIOD,
  type AdvancedMarketChannel,
  type AdvancedMarketConnectionStatus,
  type AdvancedMarketIdentity,
  type AdvancedMarketMetricsSnapshot,
  type AdvancedMarketSummarySnapshot,
  type MarketStateRecord,
} from "./advancedMarketDataTypes.js";

const MAX_METRIC_RECORDS = 20_000;
const MAX_IDENTITY_STATES = 16;

export const EMPTY_ADVANCED_MARKET_SUMMARY: AdvancedMarketSummarySnapshot = Object.freeze({
  markPrice: null,
  indexPrice: null,
  basis: null,
  basisRate: null,
  basisBps: null,
  receivedAtMs: null,
  connectionStatus: "disabled",
});

export const EMPTY_ADVANCED_MARKET_METRICS: AdvancedMarketMetricsSnapshot = Object.freeze({
  fundingHistory: Object.freeze([]) as readonly MarketStateRecord[],
  fundingPreview: null,
  openInterestHistory: Object.freeze([]) as readonly MarketStateRecord[],
  openInterestPeriod: DEFAULT_OPEN_INTEREST_PERIOD,
  connectionStatus: "disabled",
  revision: 0,
});

interface IdentityStoreState {
  latestByChannel: Map<AdvancedMarketChannel, MarketStateRecord>;
  fundingHistory: MarketStateRecord[];
  fundingPreview: MarketStateRecord | null;
  openInterestHistoryByPeriod: Map<string, MarketStateRecord[]>;
  openInterestLive: MarketStateRecord | null;
  activeOpenInterestPeriod: string;
  summarySnapshot: AdvancedMarketSummarySnapshot;
  metricsSnapshot: AdvancedMarketMetricsSnapshot;
  summaryListeners: Set<() => void>;
  metricsListeners: Set<() => void>;
  connectionStatus: AdvancedMarketConnectionStatus;
  metricsRevision: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePeriod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function asOpenInterestLiveProvisional(record: MarketStateRecord): MarketStateRecord {
  if (record.data.is_final !== undefined || record.data.sample_kind !== undefined) {
    return record;
  }
  return {
    ...record,
    data: {
      ...record.data,
      is_final: false,
      sample_kind: "provisional",
    },
  };
}

function compareSameSamplePrecedence(
  left: MarketStateRecord,
  right: MarketStateRecord,
): number {
  const leftFinal = left.data.is_final === true ? 1 : 0;
  const rightFinal = right.data.is_final === true ? 1 : 0;
  return leftFinal - rightFinal
    || left.revision - right.revision
    || left.received_at_ms - right.received_at_ms;
}

function compareChannelProgress(left: MarketStateRecord, right: MarketStateRecord): number {
  return left.event_time_ms - right.event_time_ms
    || compareSameSamplePrecedence(left, right);
}

function metricSampleTime(record: MarketStateRecord): number {
  if (record.channel === "funding_rate") {
    return finiteNumber(record.data.funding_time_ms) ?? record.event_time_ms;
  }
  return record.event_time_ms;
}

function mergeRecords(
  current: readonly MarketStateRecord[],
  incoming: readonly MarketStateRecord[],
): MarketStateRecord[] {
  if (incoming.length === 0) return current as MarketStateRecord[];
  const byTime = new Map<number, MarketStateRecord>();
  for (const record of current) byTime.set(metricSampleTime(record), record);
  for (const record of incoming) {
    const sampleTime = metricSampleTime(record);
    const previous = byTime.get(sampleTime);
    if (!previous || compareSameSamplePrecedence(record, previous) >= 0) {
      byTime.set(sampleTime, record);
    }
  }
  const merged = Array.from(byTime.values()).sort((a, b) => (
    metricSampleTime(a) - metricSampleTime(b) || compareSameSamplePrecedence(a, b)
  ));
  return merged.length <= MAX_METRIC_RECORDS
    ? merged
    : merged.slice(merged.length - MAX_METRIC_RECORDS);
}

function sameSummary(
  left: AdvancedMarketSummarySnapshot,
  right: AdvancedMarketSummarySnapshot,
): boolean {
  return left.markPrice === right.markPrice
    && left.indexPrice === right.indexPrice
    && left.basis === right.basis
    && left.basisRate === right.basisRate
    && left.basisBps === right.basisBps
    && left.receivedAtMs === right.receivedAtMs
    && left.connectionStatus === right.connectionStatus;
}

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) listener();
}

function recordMatchesIdentity(
  identity: AdvancedMarketIdentity,
  record: MarketStateRecord,
): boolean {
  return record.key.exchange.toLowerCase() === identity.exchange.toLowerCase()
    && record.key.market_type.toLowerCase() === identity.marketType.toLowerCase()
    && record.key.symbol.toUpperCase() === identity.symbol.toUpperCase();
}

function createState(): IdentityStoreState {
  return {
    latestByChannel: new Map(),
    fundingHistory: [],
    fundingPreview: null,
    openInterestHistoryByPeriod: new Map(),
    openInterestLive: null,
    activeOpenInterestPeriod: DEFAULT_OPEN_INTEREST_PERIOD,
    summarySnapshot: EMPTY_ADVANCED_MARKET_SUMMARY,
    metricsSnapshot: EMPTY_ADVANCED_MARKET_METRICS,
    summaryListeners: new Set(),
    metricsListeners: new Set(),
    connectionStatus: "disabled",
    metricsRevision: 0,
  };
}

export class AdvancedMarketDataStore {
  private readonly states = new Map<string, IdentityStoreState>();

  private state(identityOrKey: AdvancedMarketIdentity | string): IdentityStoreState {
    const key = typeof identityOrKey === "string"
      ? identityOrKey
      : buildAdvancedMarketIdentityKey(identityOrKey);
    let state = this.states.get(key);
    if (!state) {
      state = createState();
      this.states.set(key, state);
      this.evictInactiveStates();
    } else {
      this.states.delete(key);
      this.states.set(key, state);
    }
    return state;
  }

  subscribeSummary(identityKey: string, listener: () => void): () => void {
    const listeners = this.state(identityKey).summaryListeners;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  subscribeMetrics(identityKey: string, listener: () => void): () => void {
    const listeners = this.state(identityKey).metricsListeners;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  getSummarySnapshot(identityKey: string): AdvancedMarketSummarySnapshot {
    return this.states.get(identityKey)?.summarySnapshot ?? EMPTY_ADVANCED_MARKET_SUMMARY;
  }

  getMetricsSnapshot(identityKey: string): AdvancedMarketMetricsSnapshot {
    return this.states.get(identityKey)?.metricsSnapshot ?? EMPTY_ADVANCED_MARKET_METRICS;
  }

  setConnectionStatus(
    identity: AdvancedMarketIdentity,
    connectionStatus: AdvancedMarketConnectionStatus,
  ): void {
    const state = this.state(identity);
    if (state.connectionStatus === connectionStatus) return;
    state.connectionStatus = connectionStatus;
    this.publishSummary(state);
    this.publishMetrics(state);
  }

  setOpenInterestPeriod(identity: AdvancedMarketIdentity, period: string): void {
    const normalized = normalizePeriod(period);
    if (!normalized) return;
    const state = this.state(identity);
    if (state.activeOpenInterestPeriod === normalized) return;
    state.activeOpenInterestPeriod = normalized;
    this.publishMetrics(state);
  }

  applyRecords(
    identity: AdvancedMarketIdentity,
    records: readonly MarketStateRecord[],
  ): void {
    const state = this.state(identity);
    let summaryChanged = false;
    let metricsChanged = false;
    for (const record of records) {
      if (!recordMatchesIdentity(identity, record)) continue;
      const previous = state.latestByChannel.get(record.channel);
      if (previous && compareChannelProgress(record, previous) < 0) continue;
      state.latestByChannel.set(record.channel, record);

      if (record.channel === "mark_price"
        || record.channel === "index_price"
        || record.channel === "basis") {
        summaryChanged = true;
      } else if (record.channel === "funding_rate") {
        const isPreview = record.data.is_final === false
          || record.data.sample_kind === "preview"
          || finiteNumber(record.data.funding_time_ms) === null;
        if (!isPreview) {
          state.fundingHistory = mergeRecords(state.fundingHistory, [record]);
        } else {
          state.fundingPreview = record;
        }
        metricsChanged = true;
      } else if (record.channel === "open_interest") {
        // Snapshot/WebSocket OI has no period identity. Keep it as a separate
        // live lane so it can paint the current tail without contaminating any
        // REST-history period partition.
        state.openInterestLive = asOpenInterestLiveProvisional(record);
        metricsChanged = true;
      }
    }
    if (summaryChanged) this.publishSummary(state);
    if (metricsChanged) this.publishMetrics(state);
  }

  mergeMetricHistory(
    identity: AdvancedMarketIdentity,
    channel: Extract<AdvancedMarketChannel, "funding_rate" | "open_interest">,
    records: readonly MarketStateRecord[],
    period: string | null = null,
  ): void {
    const filtered = records.filter((record) => (
      record.channel === channel && recordMatchesIdentity(identity, record)
    ));
    if (filtered.length === 0) return;
    const state = this.state(identity);
    if (channel === "funding_rate") {
      const settlements = filtered.filter((record) => (
        record.data.is_final !== false
        && record.data.sample_kind !== "preview"
        && finiteNumber(record.data.funding_time_ms) !== null
      ));
      const previews = filtered.filter((record) => !settlements.includes(record));
      state.fundingHistory = mergeRecords(state.fundingHistory, settlements);
      for (const preview of previews) {
        if (!state.fundingPreview
          || compareChannelProgress(preview, state.fundingPreview) >= 0) {
          state.fundingPreview = preview;
        }
      }
    } else {
      const explicitPeriod = normalizePeriod(period);
      const grouped = new Map<string, MarketStateRecord[]>();
      for (const record of filtered) {
        const recordPeriod = normalizePeriod(record.key.params.period);
        const resolvedPeriod = explicitPeriod ?? recordPeriod;
        if (!resolvedPeriod) continue;
        const group = grouped.get(resolvedPeriod) ?? [];
        group.push(record);
        grouped.set(resolvedPeriod, group);
      }
      if (grouped.size === 0) return;
      for (const [resolvedPeriod, incoming] of grouped) {
        const current = state.openInterestHistoryByPeriod.get(resolvedPeriod) ?? [];
        state.openInterestHistoryByPeriod.set(
          resolvedPeriod,
          mergeRecords(current, incoming),
        );
      }
    }
    this.publishMetrics(state);
  }

  clear(): void {
    this.states.clear();
  }

  resetIdentity(identity: AdvancedMarketIdentity): void {
    const key = buildAdvancedMarketIdentityKey(identity);
    const state = this.states.get(key);
    if (!state) return;
    if (state.summaryListeners.size === 0 && state.metricsListeners.size === 0) {
      this.states.delete(key);
      return;
    }
    const replacement = createState();
    replacement.summaryListeners = state.summaryListeners;
    replacement.metricsListeners = state.metricsListeners;
    this.states.set(key, replacement);
    notify(replacement.summaryListeners);
    notify(replacement.metricsListeners);
  }

  private publishSummary(state: IdentityStoreState): void {
    const basisRecord = state.latestByChannel.get("basis");
    const markRecord = state.latestByChannel.get("mark_price");
    const indexRecord = state.latestByChannel.get("index_price");
    const markPrice = finiteNumber(basisRecord?.data.mark_price)
      ?? finiteNumber(markRecord?.data.mark_price);
    const indexPrice = finiteNumber(basisRecord?.data.index_price)
      ?? finiteNumber(indexRecord?.data.index_price);
    const basis = finiteNumber(basisRecord?.data.basis)
      ?? (markPrice !== null && indexPrice !== null ? markPrice - indexPrice : null);
    const basisRate = finiteNumber(basisRecord?.data.basis_rate)
      ?? (basis !== null && indexPrice !== null && indexPrice !== 0 ? basis / indexPrice : null);
    const basisBps = finiteNumber(basisRecord?.data.basis_bps)
      ?? (basisRate === null ? null : basisRate * 10_000);
    const receivedAtMs = Math.max(
      basisRecord?.received_at_ms ?? 0,
      markRecord?.received_at_ms ?? 0,
      indexRecord?.received_at_ms ?? 0,
    ) || null;
    const next: AdvancedMarketSummarySnapshot = {
      markPrice,
      indexPrice,
      basis,
      basisRate,
      basisBps,
      receivedAtMs,
      connectionStatus: state.connectionStatus,
    };
    if (sameSummary(next, state.summarySnapshot)) return;
    state.summarySnapshot = next;
    notify(state.summaryListeners);
  }

  private publishMetrics(state: IdentityStoreState): void {
    state.metricsRevision += 1;
    const periodHistory = state.openInterestHistoryByPeriod.get(
      state.activeOpenInterestPeriod,
    ) ?? [];
    state.metricsSnapshot = {
      fundingHistory: state.fundingHistory,
      fundingPreview: state.fundingPreview,
      openInterestHistory: state.openInterestLive
        ? mergeRecords(periodHistory, [state.openInterestLive])
        : periodHistory,
      openInterestPeriod: state.activeOpenInterestPeriod,
      connectionStatus: state.connectionStatus,
      revision: state.metricsRevision,
    };
    notify(state.metricsListeners);
  }

  private evictInactiveStates(): void {
    if (this.states.size <= MAX_IDENTITY_STATES) return;
    for (const [key, state] of this.states) {
      if (this.states.size <= MAX_IDENTITY_STATES) break;
      if (state.summaryListeners.size > 0 || state.metricsListeners.size > 0) continue;
      this.states.delete(key);
    }
  }
}

export const advancedMarketDataStore = new AdvancedMarketDataStore();
