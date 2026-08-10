export const REPLAY_ORDER_ADVISORY_DEBOUNCE_MS = 500;

export interface ReplayOrderAdvisoryTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReplayOrderAdvisoryScheduler {
  schedule(key: string, callback: () => void): boolean;
  cancel(): void;
  forget(key: string): void;
  pending(): boolean;
}

const browserTimers: ReplayOrderAdvisoryTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(
    handle as ReturnType<typeof globalThis.setTimeout>,
  ),
};

/**
 * Collapse cursor churn into one advisory request after the authoritative
 * replay cursor is quiet. Order submission still performs its own exact,
 * same-cursor capacity and preview checks.
 */
export function createReplayOrderAdvisoryScheduler({
  delayMs = REPLAY_ORDER_ADVISORY_DEBOUNCE_MS,
  timers = browserTimers,
}: {
  readonly delayMs?: number;
  readonly timers?: ReplayOrderAdvisoryTimers;
} = {}): ReplayOrderAdvisoryScheduler {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1) {
    throw new TypeError("replay order advisory delay must be a positive integer");
  }
  let handle: unknown | null = null;
  let pendingKey: string | null = null;
  let lastStartedKey: string | null = null;
  return {
    schedule(key, callback) {
      if (!key) throw new TypeError("replay order advisory key must be non-empty");
      if (lastStartedKey === key || (handle !== null && pendingKey === key)) {
        return false;
      }
      if (handle !== null) timers.clearTimeout(handle);
      pendingKey = key;
      handle = timers.setTimeout(() => {
        handle = null;
        pendingKey = null;
        lastStartedKey = key;
        callback();
      }, delayMs);
      return true;
    },
    cancel() {
      if (handle === null) return;
      timers.clearTimeout(handle);
      handle = null;
      pendingKey = null;
    },
    forget(key) {
      if (lastStartedKey === key) lastStartedKey = null;
    },
    pending() {
      return handle !== null;
    },
  };
}
