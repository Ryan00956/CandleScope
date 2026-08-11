import { canonicalizeIntervalValue } from "../../../utils/intervals.js";
import type { IntervalString } from "../../../utils/intervals.js";
import type {
  KlineApi,
  KlineBeforeRequestOptions,
  KlineFetchResult,
  KlineHistoryBatchRequest,
  KlineHistoryRequestOptions,
  KlineRangeRequestOptions,
  KlineRequestOptions,
} from "../klineContracts.js";

type RequestKind = "before" | "history" | "latest" | "range";

interface RequestConsumer {
  reject(error: unknown): void;
  resolve(result: KlineFetchResult): void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface SharedRequestEntry {
  consumers: Map<symbol, RequestConsumer>;
  group?: SharedPhysicalGroup;
  historyBatchRequest?: KlineHistoryBatchRequest;
  key: string;
  kind: RequestKind;
  startedAt: number;
}

interface SharedPhysicalGroup {
  controller: AbortController;
  entries: SharedRequestEntry[];
  token: symbol;
}

export interface SharedKlineRequestCoordinatorDiagnostics {
  completedPhysical: number;
  joinedLogical: number;
  logicalInflight: number;
  physicalInflight: number;
  requests: Array<{
    ageMs: number;
    consumers: number;
    key: string;
    kind: RequestKind;
  }>;
  totalLogical: number;
  totalPhysical: number;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function intervalIdentity(interval: IntervalString): string {
  return canonicalizeIntervalValue(interval) || String(interval || "").trim();
}

function seriesIdentity(
  symbol: string,
  interval: IntervalString,
  marketType: string,
  exchange: string,
): readonly string[] {
  return [
    String(exchange || "").trim().toLowerCase(),
    String(marketType || "").trim().toLowerCase(),
    String(symbol || "").trim().toUpperCase(),
    intervalIdentity(interval),
  ];
}

function requestKey(kind: RequestKind, identity: readonly unknown[]): string {
  return JSON.stringify([kind, ...identity]);
}

function physicalOptions<TOptions extends KlineRequestOptions>(
  options: TOptions,
  signal: AbortSignal,
): TOptions {
  return { ...options, signal };
}

/**
 * Window-scoped exact-request single flight for K-line HTTP work.
 *
 * Each logical caller keeps independent cancellation. The physical fetch is
 * aborted only after every joined caller leaves, so one Cell changing series
 * cannot cancel another Cell that is waiting for the same immutable result.
 */
export class SharedKlineRequestCoordinator implements KlineApi {
  private readonly api: KlineApi;
  private readonly entries = new Map<string, SharedRequestEntry>();
  private readonly pendingHistory = new Set<SharedRequestEntry>();
  private readonly physicalGroups = new Map<symbol, SharedPhysicalGroup>();
  private historyFlushScheduled = false;
  private totalLogical = 0;
  private totalPhysical = 0;
  private joinedLogical = 0;
  private completedPhysical = 0;

  constructor(api: KlineApi) {
    this.api = api;
  }

  fetchKlinesHistory(
    symbol: string,
    interval: IntervalString,
    days: number | null | undefined,
    marketType: string,
    exchange: string,
    options: KlineHistoryRequestOptions,
  ): Promise<KlineFetchResult> {
    const identity = [
      ...seriesIdentity(symbol, interval, marketType, exchange),
      days ?? null,
      options.countBack ?? null,
      options.maxWaitMs ?? null,
      options.intent ?? null,
    ];
    return this.join(
      "history",
      requestKey("history", identity),
      options.signal,
      (signal) => this.api.fetchKlinesHistory(
        symbol,
        interval,
        days,
        marketType,
        exchange,
        physicalOptions(options, signal),
      ),
      this.api.fetchKlinesHistoryBatch
        ? {
            symbol,
            interval,
            days,
            marketType,
            exchange,
            options: {
              ...(options.countBack === undefined ? {} : { countBack: options.countBack }),
              ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
              ...(options.intent === undefined ? {} : { intent: options.intent }),
              ...(options.demandScope === undefined ? {} : { demandScope: options.demandScope }),
              ...(options.demandGeneration === undefined
                ? {}
                : { demandGeneration: options.demandGeneration }),
            },
          }
        : undefined,
    );
  }

  fetchKlinesBefore(
    symbol: string,
    interval: IntervalString,
    before: Parameters<KlineApi["fetchKlinesBefore"]>[2],
    bars: number,
    marketType: string,
    exchange: string,
    options: KlineBeforeRequestOptions,
  ): Promise<KlineFetchResult> {
    const identity = [
      ...seriesIdentity(symbol, interval, marketType, exchange),
      before ?? null,
      bars,
      options.maxWaitMs ?? null,
    ];
    return this.join(
      "before",
      requestKey("before", identity),
      options.signal,
      (signal) => this.api.fetchKlinesBefore(
        symbol,
        interval,
        before,
        bars,
        marketType,
        exchange,
        physicalOptions(options, signal),
      ),
    );
  }

  fetchKlinesRange(
    symbol: string,
    interval: IntervalString,
    start: Parameters<KlineApi["fetchKlinesRange"]>[2],
    end: Parameters<KlineApi["fetchKlinesRange"]>[3],
    marketType: string,
    exchange: string,
    options: KlineRangeRequestOptions,
  ): Promise<KlineFetchResult> {
    const identity = [
      ...seriesIdentity(symbol, interval, marketType, exchange),
      start,
      end,
      options.repair ?? null,
      options.waitMs ?? null,
      options.strict ?? null,
    ];
    return this.join(
      "range",
      requestKey("range", identity),
      options.signal,
      (signal) => this.api.fetchKlinesRange(
        symbol,
        interval,
        start,
        end,
        marketType,
        exchange,
        physicalOptions(options, signal),
      ),
    );
  }

  fetchLatestKlines(
    symbol: string,
    interval: IntervalString,
    limit: number,
    marketType: string,
    exchange: string,
    source: string,
    options: KlineRequestOptions,
  ): Promise<KlineFetchResult> {
    const identity = [
      ...seriesIdentity(symbol, interval, marketType, exchange),
      limit,
      String(source || ""),
    ];
    return this.join(
      "latest",
      requestKey("latest", identity),
      options.signal,
      (signal) => this.api.fetchLatestKlines(
        symbol,
        interval,
        limit,
        marketType,
        exchange,
        source,
        physicalOptions(options, signal),
      ),
    );
  }

  getMultiStreamUrl(symbol: string, marketType: string, exchange: string): string {
    return this.api.getMultiStreamUrl(symbol, marketType, exchange);
  }

  diagnostics(now = Date.now()): SharedKlineRequestCoordinatorDiagnostics {
    let logicalInflight = 0;
    const requests = [...this.entries.values()].slice(0, 64).map((entry) => {
      logicalInflight += entry.consumers.size;
      return {
        ageMs: Math.max(0, now - entry.startedAt),
        consumers: entry.consumers.size,
        key: entry.key,
        kind: entry.kind,
      };
    });
    if (this.entries.size > requests.length) {
      for (const entry of [...this.entries.values()].slice(requests.length)) {
        logicalInflight += entry.consumers.size;
      }
    }
    return {
      completedPhysical: this.completedPhysical,
      joinedLogical: this.joinedLogical,
      logicalInflight,
      physicalInflight: this.physicalGroups.size,
      requests,
      totalLogical: this.totalLogical,
      totalPhysical: this.totalPhysical,
    };
  }

  closeAll(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.pendingHistory.clear();
    for (const group of this.physicalGroups.values()) group.controller.abort();
    this.physicalGroups.clear();
    for (const entry of entries) {
      this.settle(entry, "reject", abortError());
    }
  }

  private join(
    kind: RequestKind,
    key: string,
    signal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<KlineFetchResult>,
    historyBatchRequest?: KlineHistoryBatchRequest,
  ): Promise<KlineFetchResult> {
    this.totalLogical += 1;
    if (signal?.aborted) return Promise.reject(abortError());

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        consumers: new Map(),
        ...(historyBatchRequest === undefined ? {} : { historyBatchRequest }),
        key,
        kind,
        startedAt: Date.now(),
      };
      this.entries.set(key, entry);
      if (historyBatchRequest && this.api.fetchKlinesHistoryBatch) {
        this.pendingHistory.add(entry);
        this.scheduleHistoryFlush();
      } else {
        this.startSingle(entry, request);
      }
    } else {
      this.joinedLogical += 1;
    }

    const ownedEntry = entry;
    return new Promise<KlineFetchResult>((resolve, reject) => {
      const token = Symbol(key);
      const consumer: RequestConsumer = { reject, resolve };
      if (signal) {
        const abortListener = () => {
          if (!ownedEntry.consumers.delete(token)) return;
          signal.removeEventListener("abort", abortListener);
          reject(abortError());
          if (ownedEntry.consumers.size === 0 && this.entries.get(key) === ownedEntry) {
            this.entries.delete(key);
            this.pendingHistory.delete(ownedEntry);
            this.abortGroupIfUnowned(ownedEntry.group);
          }
        };
        consumer.signal = signal;
        consumer.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      ownedEntry.consumers.set(token, consumer);
    });
  }

  private startSingle(
    entry: SharedRequestEntry,
    request: (signal: AbortSignal) => Promise<KlineFetchResult>,
  ): void {
    const group = this.createPhysicalGroup([entry]);
    void Promise.resolve()
      .then(() => request(group.controller.signal))
      .then(
        (result) => this.finishGroup(group, [{ outcome: "resolve", value: result }]),
        (error) => this.finishGroup(group, [{ outcome: "reject", value: error }]),
      );
  }

  private scheduleHistoryFlush(): void {
    if (this.historyFlushScheduled) return;
    this.historyFlushScheduled = true;
    queueMicrotask(() => {
      this.historyFlushScheduled = false;
      this.flushHistory();
    });
  }

  private flushHistory(): void {
    const available = [...this.pendingHistory].filter((entry) => (
      this.entries.get(entry.key) === entry && entry.consumers.size > 0
    ));
    for (const entry of available) this.pendingHistory.delete(entry);
    for (let offset = 0; offset < available.length; offset += 16) {
      const entries = available.slice(offset, offset + 16);
      if (entries.length === 1 || !this.api.fetchKlinesHistoryBatch) {
        const entry = entries[0];
        if (!entry) continue;
        const item = entry.historyBatchRequest;
        if (!item) continue;
        this.startSingle(entry, (signal) => this.api.fetchKlinesHistory(
          item.symbol,
          item.interval,
          item.days,
          item.marketType,
          item.exchange,
          physicalOptions(item.options, signal),
        ));
        continue;
      }
      const group = this.createPhysicalGroup(entries);
      const items = entries.map((entry) => entry.historyBatchRequest as KlineHistoryBatchRequest);
      void this.api.fetchKlinesHistoryBatch(items, { signal: group.controller.signal }).then(
        (outcomes) => {
          if (outcomes.length !== entries.length) {
            throw new Error("History batch response length did not match the request length");
          }
          this.finishGroup(group, outcomes.map((outcome) => outcome.ok
            ? { outcome: "resolve" as const, value: outcome.result }
            : { outcome: "reject" as const, value: outcome.error }));
        },
        (error: unknown) => this.finishGroup(
          group,
          entries.map(() => ({ outcome: "reject" as const, value: error })),
        ),
      ).catch((error: unknown) => this.finishGroup(
        group,
        entries.map(() => ({ outcome: "reject" as const, value: error })),
      ));
    }
  }

  private createPhysicalGroup(entries: SharedRequestEntry[]): SharedPhysicalGroup {
    const group: SharedPhysicalGroup = {
      controller: new AbortController(),
      entries,
      token: Symbol("physical-kline-request"),
    };
    for (const entry of entries) entry.group = group;
    this.physicalGroups.set(group.token, group);
    this.totalPhysical += 1;
    return group;
  }

  private abortGroupIfUnowned(group: SharedPhysicalGroup | undefined): void {
    if (!group) return;
    const hasOwner = group.entries.some((entry) => (
      this.entries.get(entry.key) === entry && entry.consumers.size > 0
    ));
    if (!hasOwner) group.controller.abort();
  }

  private finishGroup(
    group: SharedPhysicalGroup,
    outcomes: Array<{ outcome: "reject" | "resolve"; value: unknown }>,
  ): void {
    if (!this.physicalGroups.delete(group.token)) return;
    this.completedPhysical += 1;
    group.entries.forEach((entry, index) => {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      delete entry.group;
      const result = outcomes[index] ?? {
        outcome: "reject" as const,
        value: new Error("Missing physical request outcome"),
      };
      this.settle(entry, result.outcome, result.value);
    });
  }

  private settle(
    entry: SharedRequestEntry,
    outcome: "reject" | "resolve",
    value: unknown,
  ): void {
    const consumers = [...entry.consumers.values()];
    entry.consumers.clear();
    for (const consumer of consumers) {
      if (consumer.signal && consumer.abortListener) {
        consumer.signal.removeEventListener("abort", consumer.abortListener);
      }
      if (outcome === "resolve") consumer.resolve(value as KlineFetchResult);
      else consumer.reject(value);
    }
  }
}
