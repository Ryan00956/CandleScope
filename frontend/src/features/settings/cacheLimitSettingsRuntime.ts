import { useEffect, useRef } from "react";
import { updateCacheLimits } from "../../services/api";
import type { CacheLimitsInput } from "../../services/api";
import type { CacheRowLimits } from "./chartAppearanceSettings.js";

const CACHE_LIMIT_SYNC_HEARTBEAT_MS = 5 * 60_000;
const CACHE_LIMIT_SYNC_RETRY_BASE_MS = 1_000;
const CACHE_LIMIT_SYNC_MAX_FAST_RETRIES = 4;

type TimerHandle = unknown;

export interface CacheLimitSyncCoordinatorOptions {
  send?: (payload: CacheLimitsInput) => Promise<unknown>;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  heartbeatMs?: number;
  retryBaseMs?: number;
  maxFastRetries?: number;
}

export interface CacheLimitSyncCoordinator {
  update(payload: CacheLimitsInput): void;
  clear(): void;
  dispose(): void;
}

interface SyncJob {
  generation: number;
  payload: CacheLimitsInput;
}

function clonePayload(payload: CacheLimitsInput): CacheLimitsInput {
  return {
    ...payload,
    ...(payload.dbLimits && typeof payload.dbLimits === "object" && !Array.isArray(payload.dbLimits)
      ? { dbLimits: { ...payload.dbLimits as Record<string, unknown> } }
      : {}),
  };
}

/**
 * Serialize cache-limit writes across React effect generations.
 *
 * A request that already reached the backend is allowed to finish. If settings
 * changed while it was in flight, only the newest pending payload is sent
 * next. That ordering makes the last backend write latest-wins without relying
 * on best-effort fetch cancellation.
 */
export function createCacheLimitSyncCoordinator(
  options: CacheLimitSyncCoordinatorOptions = {},
): CacheLimitSyncCoordinator {
  const send = options.send || updateCacheLimits;
  const schedule = options.schedule || ((callback: () => void, delayMs: number) => (
    setTimeout(callback, delayMs)
  ));
  const cancel = options.cancel || ((handle: TimerHandle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const heartbeatMs = Math.max(1, options.heartbeatMs ?? CACHE_LIMIT_SYNC_HEARTBEAT_MS);
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? CACHE_LIMIT_SYNC_RETRY_BASE_MS);
  const maxFastRetries = Math.max(
    0,
    Math.floor(options.maxFastRetries ?? CACHE_LIMIT_SYNC_MAX_FAST_RETRIES),
  );

  let disposed = false;
  let nextGeneration = 0;
  let desired: SyncJob | null = null;
  let inFlight: SyncJob | null = null;
  let retryAttempt = 0;
  let timer: TimerHandle | null = null;

  const clearTimer = (): void => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };

  const schedulePump = (delayMs: number): void => {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      pump();
    }, delayMs);
  };

  const settle = (job: SyncJob, succeeded: boolean): void => {
    if (inFlight?.generation === job.generation) inFlight = null;
    if (disposed) return;

    if (!desired || desired.generation !== job.generation) {
      retryAttempt = 0;
      pump();
      return;
    }

    if (succeeded) {
      retryAttempt = 0;
      schedulePump(heartbeatMs);
      return;
    }

    if (retryAttempt >= maxFastRetries) {
      retryAttempt = 0;
      schedulePump(heartbeatMs);
      return;
    }
    const delayMs = Math.min(30_000, retryBaseMs * (2 ** retryAttempt));
    retryAttempt += 1;
    schedulePump(delayMs);
  };

  const run = async (job: SyncJob): Promise<void> => {
    try {
      await send(job.payload);
      settle(job, true);
    } catch {
      settle(job, false);
    }
  };

  function pump(): void {
    if (disposed || inFlight || !desired) return;
    inFlight = desired;
    void run(inFlight);
  }

  return {
    update(payload: CacheLimitsInput): void {
      if (disposed) return;
      nextGeneration += 1;
      desired = {
        generation: nextGeneration,
        payload: clonePayload(payload),
      };
      retryAttempt = 0;
      clearTimer();
      pump();
    },

    clear(): void {
      if (disposed) return;
      nextGeneration += 1;
      desired = null;
      retryAttempt = 0;
      clearTimer();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      desired = null;
      clearTimer();
    },
  };
}

export function useCacheLimitsSync({
  cacheLimits,
  ephemeralCacheBars,
  sqliteStorageBudgetBytes,
  storageRowLimitsEnabled,
}: {
  cacheLimits: CacheRowLimits | null | undefined;
  ephemeralCacheBars: number | null | undefined;
  sqliteStorageBudgetBytes: number | null | undefined;
  storageRowLimitsEnabled: boolean;
}): void {
  const coordinatorRef = useRef<CacheLimitSyncCoordinator | null>(null);

  useEffect(() => {
    const coordinator = createCacheLimitSyncCoordinator();
    coordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    if (!cacheLimits) {
      coordinator.clear();
      return;
    }
    const payload = {
      dbLimits: { ...cacheLimits },
      ephemeralBars: ephemeralCacheBars ?? 86400,
      ...(sqliteStorageBudgetBytes === undefined ? {} : {
        sqliteBudgetBytes: sqliteStorageBudgetBytes,
      }),
      storageRowLimitsEnabled,
    };
    coordinator.update(payload);
  }, [cacheLimits, ephemeralCacheBars, sqliteStorageBudgetBytes, storageRowLimitsEnabled]);
}
