import { FRONTEND_AUTO_GC_DEFAULT_POLICY } from "./autoGcPolicy.js";
import type { AutoGcPolicyPatch } from "./autoGcPolicy.js";

export interface FrontendAutoGcSchedule {
  enabled: boolean;
  cooldownMs: number;
}

export interface FrontendAutoGcSchedulerSnapshot extends Record<string, unknown> {
  generation: number;
  enabled: boolean;
  scheduled: boolean;
  running: boolean;
  stopped: boolean;
  cooldownMs: number;
  totalRuns: number;
  skippedTicks: number;
  consecutiveErrors: number;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
}

interface FrontendAutoGcSchedulerOptions {
  enabled: boolean;
  cooldownMs: number;
  collectDiagnostics: () => Promise<unknown>;
  runGc: (diagnostics: unknown) => unknown | Promise<unknown>;
  onError?: (
    error: unknown,
    snapshot: FrontendAutoGcSchedulerSnapshot,
  ) => void;
  onStateChange?: (snapshot: FrontendAutoGcSchedulerSnapshot) => void;
  nowMs?: () => number;
  setIntervalFn?: (
    callback: () => void,
    cooldownMs: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface FrontendAutoGcScheduler {
  start: () => void;
  stop: () => void;
  tick: () => Promise<void>;
  snapshot: () => FrontendAutoGcSchedulerSnapshot;
}

let nextSchedulerGeneration = 0;
let latestSchedulerSnapshot: FrontendAutoGcSchedulerSnapshot = {
  generation: 0,
  enabled: false,
  scheduled: false,
  running: false,
  stopped: true,
  cooldownMs: FRONTEND_AUTO_GC_DEFAULT_POLICY.cooldownMs,
  totalRuns: 0,
  skippedTicks: 0,
  consecutiveErrors: 0,
  lastStartedAtMs: null,
  lastCompletedAtMs: null,
  lastSuccessAtMs: null,
  lastErrorAtMs: null,
  lastError: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneSnapshot(
  snapshot: FrontendAutoGcSchedulerSnapshot,
): FrontendAutoGcSchedulerSnapshot {
  return { ...snapshot };
}

export function resolveFrontendAutoGcSchedule(
  policy: AutoGcPolicyPatch = {},
): FrontendAutoGcSchedule {
  const parsedCooldown = Number(policy.cooldownMs);
  return {
    enabled: typeof policy.enabled === "boolean"
      ? policy.enabled
      : FRONTEND_AUTO_GC_DEFAULT_POLICY.enabled,
    cooldownMs: Number.isFinite(parsedCooldown) && parsedCooldown > 0
      ? parsedCooldown
      : FRONTEND_AUTO_GC_DEFAULT_POLICY.cooldownMs,
  };
}

export function snapshotFrontendAutoGcScheduler(): FrontendAutoGcSchedulerSnapshot {
  return cloneSnapshot(latestSchedulerSnapshot);
}

export function createFrontendAutoGcScheduler(
  options: FrontendAutoGcSchedulerOptions,
): FrontendAutoGcScheduler {
  const generation = ++nextSchedulerGeneration;
  const nowMs = options.nowMs || Date.now;
  const schedule = resolveFrontendAutoGcSchedule({
    enabled: options.enabled,
    cooldownMs: options.cooldownMs,
  });
  const setIntervalFn = options.setIntervalFn || ((callback, cooldownMs) => (
    setInterval(callback, cooldownMs)
  ));
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopped = false;
  let running = false;
  let state: FrontendAutoGcSchedulerSnapshot = {
    generation,
    enabled: schedule.enabled,
    scheduled: false,
    running: false,
    stopped: false,
    cooldownMs: schedule.cooldownMs,
    totalRuns: 0,
    skippedTicks: 0,
    consecutiveErrors: 0,
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    lastError: null,
  };

  const publish = (
    patch: Partial<FrontendAutoGcSchedulerSnapshot> = {},
    notifyObserver = true,
  ): void => {
    state = { ...state, ...patch };
    if (state.generation >= latestSchedulerSnapshot.generation) {
      latestSchedulerSnapshot = cloneSnapshot(state);
    }
    if (notifyObserver) {
      try {
        options.onStateChange?.(cloneSnapshot(state));
      } catch {
        // Observers must not destabilize the scheduler.
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || !schedule.enabled) return;
    if (running) {
      publish({ skippedTicks: state.skippedTicks + 1 });
      return;
    }
    running = true;
    const startedAtMs = nowMs();
    publish({
      running: true,
      totalRuns: state.totalRuns + 1,
      lastStartedAtMs: startedAtMs,
    });
    try {
      const diagnostics = await options.collectDiagnostics();
      if (stopped) return;
      await options.runGc(diagnostics);
      if (stopped) return;
      publish({
        consecutiveErrors: 0,
        lastSuccessAtMs: nowMs(),
        lastError: null,
      });
    } catch (error) {
      if (!stopped) {
        const failedAtMs = nowMs();
        publish({
          consecutiveErrors: state.consecutiveErrors + 1,
          lastErrorAtMs: failedAtMs,
          lastError: errorMessage(error),
        });
        try {
          options.onError?.(error, cloneSnapshot(state));
        } catch {
          // Error observers are diagnostic-only.
        }
      }
    } finally {
      running = false;
      publish({ running: false, lastCompletedAtMs: nowMs() }, !stopped);
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    if (!schedule.enabled) {
      publish({ scheduled: false });
      return;
    }
    timer = setIntervalFn(() => {
      void tick();
    }, schedule.cooldownMs);
    publish({ scheduled: true });
    void tick();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    publish({ scheduled: false, stopped: true });
  };

  publish();
  return {
    start,
    stop,
    tick,
    snapshot: () => cloneSnapshot(state),
  };
}
