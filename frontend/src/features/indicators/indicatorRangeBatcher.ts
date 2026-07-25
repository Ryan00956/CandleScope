interface BatchableIndicatorRangeRequest {
  clientId: string;
  exchange?: string;
  marketType?: string;
  market_type?: string;
  symbol?: string;
  interval?: string;
  requestScope?: string;
  requestGeneration?: number;
  signal?: AbortSignal;
}

interface IndicatorBatchResult<TPayload> {
  payload?: TPayload;
}

interface IndicatorBatchResponse<TPayload> {
  results?: Array<IndicatorBatchResult<TPayload> | TPayload>;
}

interface IndicatorRangeBatcherOptions<TRequest, TPayload> {
  sendBatch?: (input: {
    requests: Array<Omit<TRequest, "signal">>;
    signal: AbortSignal;
  }) => Promise<IndicatorBatchResponse<TPayload>>;
  /** Briefly hold requests so effects committed in adjacent frames share one HTTP batch. */
  coalesceWindowMs?: number;
  maxBatchSize?: number;
}

interface QueuedEntry<TRequest, TPayload> {
  reject: (reason?: unknown) => void;
  request: TRequest;
  resolve: (value: TPayload) => void;
  settled: boolean;
  signal?: AbortSignal;
}

interface ActiveBatch<TRequest, TPayload> {
  controller: AbortController;
  entries: Array<QueuedEntry<TRequest, TPayload>>;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function batchGroupKey(request: BatchableIndicatorRangeRequest): string {
  return [
    request?.exchange || "binance",
    request?.marketType || request?.market_type || "spot",
    String(request?.symbol || "").toUpperCase(),
    request?.interval || "",
    request?.requestScope || "",
    request?.requestGeneration ?? "",
  ].join("|");
}

function requestWithoutSignal<TRequest extends BatchableIndicatorRangeRequest>(
  request: TRequest,
): Omit<TRequest, "signal"> {
  const { signal: _signal, ...serializable } = request;
  void _signal;
  return serializable;
}

/** Microtask-coalesce same-series indicator range calls into one HTTP batch. */
export function createIndicatorRangeBatcher<
  TRequest extends BatchableIndicatorRangeRequest,
  TPayload = unknown,
>({
  sendBatch,
  coalesceWindowMs = 0,
  maxBatchSize = 32,
}: IndicatorRangeBatcherOptions<TRequest, TPayload> = {}) {
  if (typeof sendBatch !== "function") throw new TypeError("sendBatch is required");
  const sendBatchRequest = sendBatch;
  const queued: Array<QueuedEntry<TRequest, TPayload>> = [];
  const activeBatches = new Set<ActiveBatch<TRequest, TPayload>>();
  const activeGroupKeys = new Set<string>();
  let flushQueued = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function settleAborted(entry: QueuedEntry<TRequest, TPayload>): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(abortError());
  }

  async function sendEntries(entries: Array<QueuedEntry<TRequest, TPayload>>): Promise<void> {
    if (disposed) {
      for (const entry of entries) settleAborted(entry);
      return;
    }
    const live = entries.filter((entry) => !entry.signal?.aborted && !entry.settled);
    for (const entry of entries) {
      if (entry.signal?.aborted) settleAborted(entry);
    }
    if (live.length === 0) return;

    const controller = new AbortController();
    const batch = { controller, entries: live };
    activeBatches.add(batch);
    const onAbort = () => {
      if (live.every((entry) => entry.signal?.aborted || entry.settled)) controller.abort();
    };
    for (const entry of live) entry.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await sendBatchRequest({
        requests: live.map((entry) => requestWithoutSignal(entry.request)),
        signal: controller.signal,
      });
      const results = Array.isArray(response?.results) ? response.results : [];
      if (results.length !== live.length) {
        throw new Error(`Indicator range batch returned ${results.length} results for ${live.length} requests`);
      }
      live.forEach((entry, index) => {
        if (entry.settled) return;
        if (entry.signal?.aborted) {
          settleAborted(entry);
          return;
        }
        entry.settled = true;
        const result = results[index];
        const payload = typeof result === "object" && result !== null && "payload" in result
          ? result.payload
          : result;
        entry.resolve(payload as TPayload);
      });
    } catch (error) {
      for (const entry of live) {
        if (entry.settled) continue;
        entry.settled = true;
        entry.reject(entry.signal?.aborted ? abortError() : error);
      }
    } finally {
      activeBatches.delete(batch);
      for (const entry of live) entry.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function sendGroup(
    groupKey: string,
    entries: Array<QueuedEntry<TRequest, TPayload>>,
  ): Promise<void> {
    activeGroupKeys.add(groupKey);
    const size = Math.max(1, Math.floor(Number(maxBatchSize) || 32));
    try {
      // One physical request per K-line series at a time. A newer revision can
      // abort the active request; work accumulated meanwhile is then sent as
      // one replacement batch instead of racing it through storage.
      for (let index = 0; index < entries.length; index += size) {
        await sendEntries(entries.slice(index, index + size));
      }
    } finally {
      activeGroupKeys.delete(groupKey);
      if (!disposed && queued.length > 0) scheduleFlush();
    }
  }

  function flush(): void {
    flushQueued = false;
    if (disposed) {
      for (const entry of queued.splice(0)) settleAborted(entry);
      return;
    }
    const pending = queued.splice(0);
    const groups = new Map<string, Array<QueuedEntry<TRequest, TPayload>>>();
    for (const entry of pending) {
      const key = batchGroupKey(entry.request);
      const group = groups.get(key) || [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [groupKey, entries] of groups) {
      if (activeGroupKeys.has(groupKey)) {
        queued.push(...entries);
        continue;
      }
      void sendGroup(groupKey, entries);
    }
  }

  function scheduleFlush(): void {
    if (flushQueued || disposed) return;
    flushQueued = true;
    const delay = Math.max(0, Math.floor(Number(coalesceWindowMs) || 0));
    if (delay > 0) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, delay);
      return;
    }
    queueMicrotask(flush);
  }

  function schedule(request: TRequest): Promise<TPayload> {
    if (disposed) return Promise.reject(abortError());
    return new Promise<TPayload>((resolve, reject) => {
      const entry: QueuedEntry<TRequest, TPayload> = {
        reject,
        request,
        resolve,
        settled: false,
      };
      if (request.signal !== undefined) entry.signal = request.signal;
      if (entry.signal?.aborted) {
        settleAborted(entry);
        return;
      }
      queued.push(entry);
      scheduleFlush();
    });
  }

  function dispose(): void {
    disposed = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    flushQueued = false;
    for (const entry of queued.splice(0)) settleAborted(entry);
    for (const batch of activeBatches) batch.controller.abort();
    activeBatches.clear();
    activeGroupKeys.clear();
  }

  function reset(): void {
    disposed = false;
  }

  return { dispose, reset, schedule };
}
