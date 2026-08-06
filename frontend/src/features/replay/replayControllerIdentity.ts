const REPLAY_CONTROLLER_STORAGE_PREFIX = "candlescope:replay-controller-client:v1:";
const CLIENT_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ReplayControllerIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let fallbackIdentityCounter = 0;
const documentFallbackIdentities = new Map<string, string>();

function nextControllerIdentity(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `browser-${uuid}`;
  fallbackIdentityCounter += 1;
  return `browser-${Date.now()}-${fallbackIdentityCounter}`;
}

function browserSessionStorage(): ReplayControllerIdentityStorage | null {
  try {
    return typeof globalThis.sessionStorage === "undefined" ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function replayControllerIdentityStorageKey(runId: string): string {
  return `${REPLAY_CONTROLLER_STORAGE_PREFIX}${runId}`;
}

/**
 * Keeps controller ownership stable across adapter-session reloads in one tab.
 * sessionStorage is deliberately used instead of localStorage: another tab must
 * remain a distinct controller client and contend through the server lease.
 */
export function getReplayControllerClientInstanceId(
  runId: string,
  storage: ReplayControllerIdentityStorage | null = browserSessionStorage(),
  createIdentity: () => string = nextControllerIdentity,
): string {
  const key = replayControllerIdentityStorageKey(runId);
  if (storage !== null) {
    try {
      const stored = storage.getItem(key);
      if (stored !== null && CLIENT_INSTANCE_ID.test(stored)) return stored;
      const created = createIdentity();
      if (!CLIENT_INSTANCE_ID.test(created)) {
        throw new Error("generated replay controller client identity is invalid");
      }
      storage.setItem(key, created);
      return created;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("identity is invalid")) throw cause;
    }
  }

  const existing = documentFallbackIdentities.get(runId);
  if (existing !== undefined) return existing;
  const created = createIdentity();
  if (!CLIENT_INSTANCE_ID.test(created)) {
    throw new Error("generated replay controller client identity is invalid");
  }
  documentFallbackIdentities.set(runId, created);
  return created;
}
