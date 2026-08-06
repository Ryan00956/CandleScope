interface SharedReadEntry<T = unknown> {
  expiresAt: number;
  promise: Promise<T>;
}

const MAX_SHARED_CONTROL_READS = 32;
const entries = new Map<string, SharedReadEntry>();

function aborted(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Coalesces global control-plane reads across simultaneously mounted charts.
 * Caller cancellation never aborts a physical read still serving another
 * Cell. Entries are TTL-bounded and the map is hard-capped to avoid turning
 * this bootstrap optimization into an unbounded application cache.
 */
export function sharedControlRead<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const now = Date.now();
  const current = entries.get(key) as SharedReadEntry<T> | undefined;
  if (current && current.expiresAt > now) {
    entries.delete(key);
    entries.set(key, current);
    return withCallerAbort(current.promise, signal);
  }
  if (current) entries.delete(key);

  while (entries.size >= MAX_SHARED_CONTROL_READS) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  const entry: SharedReadEntry<T> = {
    expiresAt: now + Math.max(0, ttlMs),
    promise: Promise.resolve().then(loader),
  };
  entries.set(key, entry);
  entry.promise.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return withCallerAbort(entry.promise, signal);
}

export function resetSharedControlReadsForTests(): void {
  entries.clear();
}

export function sharedControlReadCountForTests(): number {
  return entries.size;
}
