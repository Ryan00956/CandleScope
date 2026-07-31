import type {
  IndicatorStorageLike,
} from "../indicators/activeIndicatorStore.js";

type ReplayIndicatorStorage = IndicatorStorageLike & {
  removeItem?(key: string): void;
};

const REPLAY_INDICATOR_STORAGE_PREFIX = "candlescope-replay-indicators-v2:";
const REPLAY_ORDER_FLOW_STORAGE_PREFIX = "candlescope-replay-order-flow-v2:";

function browserStorage(): ReplayIndicatorStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function replayIndicatorStorageKey(runScope: string): string {
  return `${REPLAY_INDICATOR_STORAGE_PREFIX}${runScope}`;
}

export function replayOrderFlowStorageKey(runScope: string): string {
  return `${REPLAY_ORDER_FLOW_STORAGE_PREFIX}${runScope}`;
}

export function clearReplaySharedIndicatorPreferences(
  runScopes: readonly string[],
  storage: ReplayIndicatorStorage | null = browserStorage(),
): void {
  if (storage?.removeItem === undefined) return;
  for (const runScope of new Set(runScopes.map((value) => value.trim()))) {
    if (!runScope) continue;
    for (const key of [
      replayIndicatorStorageKey(runScope),
      replayOrderFlowStorageKey(runScope),
    ]) {
      try {
        storage.removeItem(key);
      } catch {
        // Archive deletion remains authoritative when browser storage is blocked.
      }
    }
  }
}
