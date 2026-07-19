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
import {
  fundingRateProvenance,
  fundingRateSampleTimeMs,
  fundingRateTargetTimeMs,
  isFundingRateHistory,
  isFundingRateRealtime,
} from "./fundingRateSemantics.js";
import { normalizeIntervalValue } from "../../utils/intervals.js";

const MAX_METRIC_RECORDS = 20_000;
const MAX_FUNDING_REALTIME_RECORDS = 36_000;
const MAX_IDENTITY_STATES = 16;

export interface AdvancedMarketFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

function defaultFrameScheduler(): AdvancedMarketFrameScheduler {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    };
  }
  // Keep non-browser consumers deterministic; browser delivery is still
  // frame-coalesced and unit tests can inject a manual frame scheduler.
  return {
    request(callback) {
      callback();
      return 0;
    },
    cancel() {},
  };
}

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
  fundingRealtimeHistory: Object.freeze([]) as readonly MarketStateRecord[],
  fundingPreview: null,
  openInterestHistory: Object.freeze([]) as readonly MarketStateRecord[],
  openInterestPeriod: DEFAULT_OPEN_INTEREST_PERIOD,
  connectionStatus: "disabled",
  revision: 0,
});

interface IdentityStoreState {
  latestByChannel: Map<AdvancedMarketChannel, MarketStateRecord>;
  fundingLegacySettlementHistory: MarketStateRecord[];
  fundingHybridSettlementHistoryByPeriod: Map<string, MarketStateRecord[]>;
  fundingDerivedHistoryByPeriod: Map<string, MarketStateRecord[]>;
  activeFundingPeriod: string | null;
  fundingDisplayHistory: MarketStateRecord[];
  fundingRealtimeHistory: MarketStateRecord[];
  fundingPreview: MarketStateRecord | null;
  openInterestHistoryByPeriod: Map<string, MarketStateRecord[]>;
  openInterestLive: MarketStateRecord | null;
  openInterestDisplayHistory: MarketStateRecord[];
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

function normalizeFundingPeriod(value: unknown): string | null {
  return normalizeIntervalValue(value) || null;
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
  const fundingPrecedence = (record: MarketStateRecord): number => {
    if (record.channel !== "funding_rate") return record.data.is_final === true ? 1 : 0;
    const provenance = fundingRateProvenance(record);
    if (provenance === "exchange_settlement") return 2;
    if (provenance === "derived_history") return 1;
    return 0;
  };
  const leftFinal = fundingPrecedence(left);
  const rightFinal = fundingPrecedence(right);
  return leftFinal - rightFinal
    || left.revision - right.revision
    || left.received_at_ms - right.received_at_ms;
}

function compareChannelProgress(left: MarketStateRecord, right: MarketStateRecord): number {
  return left.event_time_ms - right.event_time_ms
    || compareSameSamplePrecedence(left, right);
}

function sameShallowRecord(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

function sameMarketRecord(left: MarketStateRecord | null, right: MarketStateRecord | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.topic === right.topic
    && left.channel === right.channel
    && left.event_time_ms === right.event_time_ms
    && left.received_at_ms === right.received_at_ms
    && left.source === right.source
    && left.sequence === right.sequence
    && left.revision === right.revision
    && left.key.exchange === right.key.exchange
    && left.key.market_type === right.key.market_type
    && left.key.symbol === right.key.symbol
    && left.key.channel === right.key.channel
    && sameShallowRecord(left.key.params, right.key.params)
    && sameShallowRecord(left.data, right.data);
}

function sameRecordSequence(
  left: readonly MarketStateRecord[],
  right: readonly MarketStateRecord[],
): boolean {
  return left === right || (
    left.length === right.length
    && left.every((record, index) => sameMarketRecord(record, right[index] ?? null))
  );
}

function metricSampleTime(record: MarketStateRecord): number {
  if (record.channel === "funding_rate") {
    return fundingRateSampleTimeMs(record);
  }
  return record.event_time_ms;
}

function mergeRecords(
  current: readonly MarketStateRecord[],
  incoming: readonly MarketStateRecord[],
  maxRecords: number = MAX_METRIC_RECORDS,
): MarketStateRecord[] {
  if (incoming.length === 0) return current as MarketStateRecord[];
  const byTime = new Map<number, MarketStateRecord>();
  for (const record of current) byTime.set(metricSampleTime(record), record);
  let changed = false;
  for (const record of incoming) {
    const sampleTime = metricSampleTime(record);
    const previous = byTime.get(sampleTime);
    if (!previous || compareSameSamplePrecedence(record, previous) >= 0) {
      if (previous && sameMarketRecord(previous, record)) continue;
      byTime.set(sampleTime, record);
      changed = true;
    }
  }
  if (!changed) return current as MarketStateRecord[];
  const merged = Array.from(byTime.values()).sort((a, b) => (
    metricSampleTime(a) - metricSampleTime(b) || compareSameSamplePrecedence(a, b)
  ));
  const bounded = merged.length <= maxRecords
    ? merged
    : merged.slice(merged.length - maxRecords);
  return sameRecordSequence(current, bounded)
    ? current as MarketStateRecord[]
    : bounded;
}

function appendFundingRealtimeRecord(
  state: IdentityStoreState,
  record: MarketStateRecord,
): boolean {
  const timeline = state.fundingRealtimeHistory;
  const observationMs = fundingRateSampleTimeMs(record);
  const tail = timeline.at(-1);
  if (tail && fundingRateSampleTimeMs(tail) === observationMs) {
    if (compareChannelProgress(record, tail) < 0 || sameMarketRecord(tail, record)) return false;
    state.fundingRealtimeHistory = [...timeline.slice(0, -1), record];
    return true;
  }
  const next = [...timeline, record];
  state.fundingRealtimeHistory = next.length > MAX_FUNDING_REALTIME_RECORDS
    ? next.slice(next.length - MAX_FUNDING_REALTIME_RECORDS)
    : next;
  return true;
}

function fundingSettlementCycleKey(record: MarketStateRecord): string {
  const cycleTime = finiteNumber(record.data.funding_cycle_ms)
    ?? finiteNumber(record.data.raw_funding_time_ms)
    ?? finiteNumber(record.data.funding_time_ms);
  return cycleTime === null
    ? `sample:${fundingRateSampleTimeMs(record)}`
    : `cycle:${cycleTime}`;
}

function mergeFundingSettlements(
  legacy: readonly MarketStateRecord[],
  hybrid: readonly MarketStateRecord[],
): MarketStateRecord[] {
  const byCycle = new Map<string, MarketStateRecord>();
  for (const record of legacy) {
    const key = fundingSettlementCycleKey(record);
    const previous = byCycle.get(key);
    if (!previous || compareSameSamplePrecedence(record, previous) >= 0) {
      byCycle.set(key, record);
    }
  }
  // The active hybrid bucket is authoritative for chart placement even when
  // a cached sparse record represents the same exchange settlement cycle.
  for (const record of hybrid) byCycle.set(fundingSettlementCycleKey(record), record);
  return [...byCycle.values()]
    .sort((left, right) => metricSampleTime(left) - metricSampleTime(right))
    .slice(-MAX_METRIC_RECORDS);
}

function refreshFundingDisplayHistory(state: IdentityStoreState): boolean {
  const hybridSettlements = state.activeFundingPeriod
    ? state.fundingHybridSettlementHistoryByPeriod.get(state.activeFundingPeriod) ?? []
    : [];
  const derived = state.activeFundingPeriod
    ? state.fundingDerivedHistoryByPeriod.get(state.activeFundingPeriod) ?? []
    : [];
  const next = mergeRecords(
    mergeFundingSettlements(state.fundingLegacySettlementHistory, hybridSettlements),
    derived,
  );
  if (sameRecordSequence(state.fundingDisplayHistory, next)) return false;
  state.fundingDisplayHistory = next;
  return true;
}

function refreshOpenInterestDisplayHistory(state: IdentityStoreState): boolean {
  const periodHistory = state.openInterestHistoryByPeriod.get(
    state.activeOpenInterestPeriod,
  ) ?? [];
  const next = state.openInterestLive
    ? mergeRecords(periodHistory, [state.openInterestLive])
    : periodHistory;
  if (sameRecordSequence(state.openInterestDisplayHistory, next)) return false;
  state.openInterestDisplayHistory = next;
  return true;
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
    fundingLegacySettlementHistory: [],
    fundingHybridSettlementHistoryByPeriod: new Map(),
    fundingDerivedHistoryByPeriod: new Map(),
    activeFundingPeriod: null,
    fundingDisplayHistory: [],
    fundingRealtimeHistory: [],
    fundingPreview: null,
    openInterestHistoryByPeriod: new Map(),
    openInterestLive: null,
    openInterestDisplayHistory: [],
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

  private readonly scheduler: AdvancedMarketFrameScheduler;

  private readonly pendingSummaryNotifications = new Set<IdentityStoreState>();

  private readonly pendingMetricsNotifications = new Set<IdentityStoreState>();

  private notificationFrame: number | null = null;

  constructor(scheduler: AdvancedMarketFrameScheduler = defaultFrameScheduler()) {
    this.scheduler = scheduler;
  }

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
    refreshOpenInterestDisplayHistory(state);
    this.publishMetrics(state);
  }

  setFundingPeriod(identity: AdvancedMarketIdentity, period: string): void {
    const normalized = normalizeFundingPeriod(period);
    if (!normalized) return;
    const state = this.state(identity);
    if (state.activeFundingPeriod === normalized) return;
    state.activeFundingPeriod = normalized;
    // A period switch hands closed bars back to hybrid history. Keep only the
    // latest exchange observation for the newly forming K.
    state.fundingRealtimeHistory = state.fundingPreview ? [state.fundingPreview] : [];
    refreshFundingDisplayHistory(state);
    this.publishMetrics(state);
  }

  applyRecords(
    identity: AdvancedMarketIdentity,
    records: readonly MarketStateRecord[],
  ): void {
    const state = this.state(identity);
    let summaryChanged = false;
    let metricsChanged = false;
    let fundingDisplayDirty = false;
    let openInterestDisplayDirty = false;
    for (const record of records) {
      if (!recordMatchesIdentity(identity, record)) continue;
      const previous = state.latestByChannel.get(record.channel);
      if (previous && compareChannelProgress(record, previous) < 0) continue;
      if (previous && sameMarketRecord(previous, record)) continue;
      state.latestByChannel.set(record.channel, record);

      if (record.channel === "mark_price"
        || record.channel === "index_price"
        || record.channel === "basis") {
        summaryChanged = true;
      } else if (record.channel === "funding_rate") {
        if (isFundingRateHistory(record)) {
          if (fundingRateProvenance(record) === "exchange_settlement") {
            const hybridPeriod = record.key.params.view === "hybrid"
              ? normalizeFundingPeriod(record.key.params.period)
              : null;
            if (hybridPeriod) {
              const current = state.fundingHybridSettlementHistoryByPeriod.get(hybridPeriod) ?? [];
              const next = mergeRecords(current, [record]);
              if (next !== current) {
                state.fundingHybridSettlementHistoryByPeriod.set(hybridPeriod, next);
                if (hybridPeriod === state.activeFundingPeriod) fundingDisplayDirty = true;
              }
            } else {
              const next = mergeRecords(
                state.fundingLegacySettlementHistory,
                [record],
              );
              if (next !== state.fundingLegacySettlementHistory) {
                state.fundingLegacySettlementHistory = next;
                fundingDisplayDirty = true;
              }
            }
          } else {
            const period = normalizeFundingPeriod(record.key.params.period);
            if (period) {
              const current = state.fundingDerivedHistoryByPeriod.get(period) ?? [];
              const next = mergeRecords(current, [record]);
              if (next !== current) {
                state.fundingDerivedHistoryByPeriod.set(period, next);
                if (period === state.activeFundingPeriod) fundingDisplayDirty = true;
              }
            }
          }
        } else {
          const previousTarget = state.fundingPreview
            ? fundingRateTargetTimeMs(state.fundingPreview)
            : null;
          const nextTarget = fundingRateTargetTimeMs(record);
          if (previousTarget !== null && nextTarget !== null && previousTarget !== nextTarget) {
            state.fundingRealtimeHistory = [];
            metricsChanged = true;
          }
          if (appendFundingRealtimeRecord(state, record)) metricsChanged = true;
          if (!sameMarketRecord(state.fundingPreview, record)) {
            state.fundingPreview = record;
            metricsChanged = true;
          }
        }
      } else if (record.channel === "open_interest") {
        // Snapshot/WebSocket OI has no period identity. Keep it as a separate
        // live lane so it can paint the current tail without contaminating any
        // REST-history period partition.
        const next = asOpenInterestLiveProvisional(record);
        if (!sameMarketRecord(state.openInterestLive, next)) {
          state.openInterestLive = next;
          openInterestDisplayDirty = true;
        }
      }
    }
    if (fundingDisplayDirty && refreshFundingDisplayHistory(state)) metricsChanged = true;
    if (openInterestDisplayDirty && refreshOpenInterestDisplayHistory(state)) metricsChanged = true;
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
    let metricsChanged = false;
    if (channel === "funding_rate") {
      const history = filtered.filter(isFundingRateHistory);
      const previews = filtered.filter(isFundingRateRealtime);
      const settlements = history.filter((record) => (
        fundingRateProvenance(record) === "exchange_settlement"
      ));
      const derived = history.filter((record) => (
        fundingRateProvenance(record) === "derived_history"
      ));
      const fundingPeriod = normalizeFundingPeriod(period);
      const hybridSettlements = settlements.filter((record) => (
        record.key.params.view === "hybrid" && fundingPeriod !== null
      ));
      const hybridSettlementSet = new Set(hybridSettlements);
      const legacySettlements = settlements.filter((record) => !hybridSettlementSet.has(record));
      let fundingDisplayDirty = false;
      const legacyHistory = mergeRecords(
        state.fundingLegacySettlementHistory,
        legacySettlements,
      );
      if (legacyHistory !== state.fundingLegacySettlementHistory) {
        state.fundingLegacySettlementHistory = legacyHistory;
        fundingDisplayDirty = true;
      }
      if (fundingPeriod && hybridSettlements.length > 0) {
        const current = state.fundingHybridSettlementHistoryByPeriod.get(fundingPeriod) ?? [];
        const next = mergeRecords(current, hybridSettlements);
        if (next !== current) {
          state.fundingHybridSettlementHistoryByPeriod.set(fundingPeriod, next);
          if (fundingPeriod === state.activeFundingPeriod) fundingDisplayDirty = true;
        }
      }
      if (fundingPeriod && derived.length > 0) {
        const current = state.fundingDerivedHistoryByPeriod.get(fundingPeriod) ?? [];
        const next = mergeRecords(current, derived);
        if (next !== current) {
          state.fundingDerivedHistoryByPeriod.set(fundingPeriod, next);
          if (fundingPeriod === state.activeFundingPeriod) fundingDisplayDirty = true;
        }
      }
      if (fundingDisplayDirty && refreshFundingDisplayHistory(state)) metricsChanged = true;
      for (const preview of previews.sort(compareChannelProgress)) {
        if (state.fundingPreview
          && compareChannelProgress(preview, state.fundingPreview) < 0) continue;
        if (sameMarketRecord(state.fundingPreview, preview)) continue;
        const previousTarget = state.fundingPreview
          ? fundingRateTargetTimeMs(state.fundingPreview)
          : null;
        const nextTarget = fundingRateTargetTimeMs(preview);
        if (previousTarget !== null && nextTarget !== null && previousTarget !== nextTarget) {
          state.fundingRealtimeHistory = [];
          metricsChanged = true;
        }
        if (appendFundingRealtimeRecord(state, preview)) metricsChanged = true;
        state.fundingPreview = preview;
        metricsChanged = true;
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
      let activeHistoryChanged = false;
      for (const [resolvedPeriod, incoming] of grouped) {
        const current = state.openInterestHistoryByPeriod.get(resolvedPeriod) ?? [];
        const next = mergeRecords(current, incoming);
        if (next === current) continue;
        state.openInterestHistoryByPeriod.set(resolvedPeriod, next);
        if (resolvedPeriod === state.activeOpenInterestPeriod) activeHistoryChanged = true;
      }
      if (activeHistoryChanged && refreshOpenInterestDisplayHistory(state)) metricsChanged = true;
    }
    if (metricsChanged) this.publishMetrics(state);
  }

  clear(): void {
    if (this.notificationFrame !== null) this.scheduler.cancel(this.notificationFrame);
    this.notificationFrame = null;
    this.pendingSummaryNotifications.clear();
    this.pendingMetricsNotifications.clear();
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
    this.pendingSummaryNotifications.delete(state);
    this.pendingMetricsNotifications.delete(state);
    this.states.set(key, replacement);
    this.queueSummaryNotification(replacement);
    this.queueMetricsNotification(replacement);
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
    this.queueSummaryNotification(state);
  }

  private publishMetrics(state: IdentityStoreState): void {
    const previous = state.metricsSnapshot;
    if (previous.fundingHistory === state.fundingDisplayHistory
      && previous.fundingRealtimeHistory === state.fundingRealtimeHistory
      && previous.fundingPreview === state.fundingPreview
      && previous.openInterestHistory === state.openInterestDisplayHistory
      && previous.openInterestPeriod === state.activeOpenInterestPeriod
      && previous.connectionStatus === state.connectionStatus) {
      return;
    }
    state.metricsRevision += 1;
    state.metricsSnapshot = {
      fundingHistory: state.fundingDisplayHistory,
      fundingRealtimeHistory: state.fundingRealtimeHistory,
      fundingPreview: state.fundingPreview,
      openInterestHistory: state.openInterestDisplayHistory,
      openInterestPeriod: state.activeOpenInterestPeriod,
      connectionStatus: state.connectionStatus,
      revision: state.metricsRevision,
    };
    this.queueMetricsNotification(state);
  }

  private queueSummaryNotification(state: IdentityStoreState): void {
    this.pendingSummaryNotifications.add(state);
    this.scheduleNotificationFrame();
  }

  private queueMetricsNotification(state: IdentityStoreState): void {
    this.pendingMetricsNotifications.add(state);
    this.scheduleNotificationFrame();
  }

  private scheduleNotificationFrame(): void {
    if (this.notificationFrame !== null) return;
    let flushedSynchronously = false;
    const handle = this.scheduler.request(() => {
      flushedSynchronously = true;
      this.notificationFrame = null;
      const summaryStates = [...this.pendingSummaryNotifications];
      const metricsStates = [...this.pendingMetricsNotifications];
      this.pendingSummaryNotifications.clear();
      this.pendingMetricsNotifications.clear();
      for (const state of summaryStates) notify(state.summaryListeners);
      for (const state of metricsStates) notify(state.metricsListeners);
    });
    if (!flushedSynchronously) this.notificationFrame = handle;
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
