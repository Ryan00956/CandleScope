export const REPLAY_ORDER_ADVISORY_DEBOUNCE_MS = 180;

export interface ReplayOrderAdvisoryTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReplayOrderAdvisoryScheduler {
  schedule(callback: () => void): void;
  cancel(): void;
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
  return {
    schedule(callback) {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        callback();
      }, delayMs);
    },
    cancel() {
      if (handle === null) return;
      timers.clearTimeout(handle);
      handle = null;
    },
    pending() {
      return handle !== null;
    },
  };
}
