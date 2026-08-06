import { canonicalizeIntervalValue } from "../../../utils/intervals.js";
import type { IntervalString } from "../../../utils/intervals.js";
import type {
  KlineApi,
  KlineBeforeRequestOptions,
  KlineFetchResult,
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
  controller: AbortController;
  consumers: Map<symbol, RequestConsumer>;
  key: string;
  kind: RequestKind;
  startedAt: number;
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
      physicalInflight: this.entries.size,
      requests,
      totalLogical: this.totalLogical,
      totalPhysical: this.totalPhysical,
    };
  }

  closeAll(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.controller.abort();
      this.settle(entry, "reject", abortError());
    }
  }

  private join(
    kind: RequestKind,
    key: string,
    signal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<KlineFetchResult>,
  ): Promise<KlineFetchResult> {
    this.totalLogical += 1;
    if (signal?.aborted) return Promise.reject(abortError());

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        controller: new AbortController(),
        consumers: new Map(),
        key,
        kind,
        startedAt: Date.now(),
      };
      this.entries.set(key, entry);
      this.totalPhysical += 1;
      const ownedEntry = entry;
      void Promise.resolve()
        .then(() => request(ownedEntry.controller.signal))
        .then(
          (result) => this.finish(ownedEntry, "resolve", result),
          (error) => this.finish(ownedEntry, "reject", error),
        );
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
            ownedEntry.controller.abort();
          }
        };
        consumer.signal = signal;
        consumer.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      ownedEntry.consumers.set(token, consumer);
    });
  }

  private finish(
    entry: SharedRequestEntry,
    outcome: "reject" | "resolve",
    value: unknown,
  ): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.completedPhysical += 1;
    this.settle(entry, outcome, value);
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
