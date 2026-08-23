import { t } from "../../i18n/index.js";
import type {
  AggregateTrade,
  TradeFlowAggregateStats,
  TradeFlowConnectionStatus,
  TradeFlowExternalStore,
  TradeFlowStoreSnapshot,
} from "./tradeFlowTypes.js";

export interface TradeFlowFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const EMPTY_STATS: TradeFlowAggregateStats = Object.freeze({
  buyQuote: 0,
  sellQuote: 0,
  buyBase: 0,
  sellBase: 0,
  buyCount: 0,
  sellCount: 0,
  maxTradeNotional: 0,
});

function defaultScheduler(): TradeFlowFrameScheduler {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => globalThis.setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => globalThis.clearTimeout(handle),
  };
}

function initialSnapshot(
  status: TradeFlowConnectionStatus = "idle",
  message: string | null = null,
): TradeFlowStoreSnapshot {
  return Object.freeze({
    status,
    records: Object.freeze([]),
    stats: EMPTY_STATS,
    continuity: status !== "gap",
    message,
    error: null,
    version: 0,
  });
}

function aggregateStats(records: readonly AggregateTrade[]): TradeFlowAggregateStats {
  let buyQuote = 0;
  let sellQuote = 0;
  let buyBase = 0;
  let sellBase = 0;
  let buyCount = 0;
  let sellCount = 0;
  let maxTradeNotional = 0;
  for (const record of records) {
    if (record.aggressorSide === "buy") {
      buyQuote += record.quoteQuantity;
      buyBase += record.quantity;
      buyCount += 1;
    } else {
      sellQuote += record.quoteQuantity;
      sellBase += record.quantity;
      sellCount += 1;
    }
    maxTradeNotional = Math.max(maxTradeNotional, record.quoteQuantity);
  }
  return Object.freeze({
    buyQuote,
    sellQuote,
    buyBase,
    sellBase,
    buyCount,
    sellCount,
    maxTradeNotional,
  });
}

function isStrictlyContinuous(records: readonly AggregateTrade[]): boolean {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!previous || !current || current.aggTradeId !== previous.aggTradeId + 1) return false;
  }
  return true;
}

export function createTradeFlowStore({
  maxRecords = 2_000,
  scheduler = defaultScheduler(),
}: {
  maxRecords?: number;
  scheduler?: TradeFlowFrameScheduler;
} = {}): TradeFlowExternalStore {
  const capacity = Math.max(1, Math.floor(maxRecords));
  const listeners = new Set<() => void>();
  let current = initialSnapshot();
  let working: AggregateTrade[] = [];
  let frameHandle: number | null = null;
  let destroyed = false;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (next: Omit<TradeFlowStoreSnapshot, "version">) => {
    if (destroyed) return;
    current = Object.freeze({ ...next, version: current.version + 1 });
    notify();
  };
  const cancelFrame = () => {
    if (frameHandle !== null) scheduler.cancel(frameHandle);
    frameHandle = null;
  };
  const flush = () => {
    frameHandle = null;
    if (destroyed) return;
    const records = Object.freeze(working.slice());
    commit({
      status: "live",
      records,
      stats: aggregateStats(records),
      continuity: true,
      message: null,
      error: null,
    });
  };
  const scheduleFlush = () => {
    if (frameHandle === null) frameHandle = scheduler.request(flush);
  };
  const failGap = (message: string) => {
    cancelFrame();
    working = [];
    commit({
      status: "gap",
      records: Object.freeze([]),
      stats: EMPTY_STATS,
      continuity: false,
      message,
      error: message,
    });
  };

  return {
    getSnapshot: () => current,
    getServerSnapshot: () => current,
    subscribe: (listener) => {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replaceRecent: (records) => {
      if (destroyed) return false;
      if (!isStrictlyContinuous(records)) {
        failGap(t("trade.rt.recentGap"));
        return false;
      }
      working = records.slice(-capacity);
      scheduleFlush();
      return true;
    },
    appendBatch: (records) => {
      if (destroyed || records.length === 0) return !destroyed;
      let lastId = working.at(-1)?.aggTradeId ?? null;
      let appended = false;
      for (const record of records) {
        if (lastId !== null && record.aggTradeId <= lastId) {
          if (!appended) continue;
          failGap(t("trade.rt.batchRewind"));
          return false;
        }
        if (lastId !== null && record.aggTradeId !== lastId + 1) {
          failGap(t("trade.rt.idGap", { from: lastId + 1, to: record.aggTradeId - 1 }));
          return false;
        }
        working.push(record);
        lastId = record.aggTradeId;
        appended = true;
      }
      if (working.length > capacity) working.splice(0, working.length - capacity);
      if (appended) scheduleFlush();
      return true;
    },
    publishStatus: (status, options = {}) => {
      cancelFrame();
      if (options.clearRecords ?? status !== "idle") working = [];
      const records = Object.freeze(working.slice());
      commit({
        status,
        records,
        stats: aggregateStats(records),
        continuity: status !== "gap",
        message: options.message ?? null,
        error: options.error ?? null,
      });
    },
    markGap: failGap,
    reset: (status = "idle", message = null) => {
      cancelFrame();
      working = [];
      commit({
        status,
        records: Object.freeze([]),
        stats: EMPTY_STATS,
        continuity: true,
        message,
        error: null,
      });
    },
    destroy: () => {
      cancelFrame();
      destroyed = true;
      working = [];
      listeners.clear();
    },
  };
}
