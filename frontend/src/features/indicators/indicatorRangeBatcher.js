function abortError() {
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function batchGroupKey(request) {
  return [
    request?.exchange || "binance",
    request?.marketType || request?.market_type || "spot",
    String(request?.symbol || "").toUpperCase(),
    request?.interval || "",
  ].join("|");
}

function requestWithoutSignal(request) {
  const { signal: _signal, ...serializable } = request || {};
  return serializable;
}

/** Microtask-coalesce same-series indicator range calls into one HTTP batch. */
export function createIndicatorRangeBatcher({ sendBatch, maxBatchSize = 32 } = {}) {
  if (typeof sendBatch !== "function") throw new TypeError("sendBatch is required");
  const queued = [];
  const activeBatches = new Set();
  let flushQueued = false;
  let disposed = false;

  function settleAborted(entry) {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(abortError());
  }

  async function sendEntries(entries) {
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
      const response = await sendBatch({
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
        entry.resolve(results[index]?.payload ?? results[index]);
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

  function flush() {
    flushQueued = false;
    if (disposed) {
      for (const entry of queued.splice(0)) settleAborted(entry);
      return;
    }
    const pending = queued.splice(0);
    const groups = new Map();
    for (const entry of pending) {
      const key = batchGroupKey(entry.request);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const size = Math.max(1, Math.floor(Number(maxBatchSize) || 32));
    for (const entries of groups.values()) {
      for (let index = 0; index < entries.length; index += size) {
        void sendEntries(entries.slice(index, index + size));
      }
    }
  }

  function schedule(request) {
    if (disposed) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = { reject, request, resolve, settled: false, signal: request?.signal };
      if (entry.signal?.aborted) {
        settleAborted(entry);
        return;
      }
      queued.push(entry);
      if (!flushQueued) {
        flushQueued = true;
        queueMicrotask(flush);
      }
    });
  }

  function dispose() {
    disposed = true;
    for (const entry of queued.splice(0)) settleAborted(entry);
    for (const batch of activeBatches) batch.controller.abort();
    activeBatches.clear();
  }

  function reset() {
    disposed = false;
  }

  return { dispose, reset, schedule };
}
