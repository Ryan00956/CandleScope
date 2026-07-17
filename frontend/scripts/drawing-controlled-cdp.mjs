import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONTROLLED_WEBSOCKET_CONSTRUCTOR = (() => {
  const constructor = globalThis.WebSocket;
  if (typeof constructor === "function") {
    Object.freeze(constructor.prototype);
    Object.freeze(constructor);
  }
  return constructor;
})();
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const CONTROLLED_LAUNCHERS = new Map([
  [
    path.join(SCRIPT_DIRECTORY, "drawing-controlled-cdp-smoke.mjs"),
    path.join(SCRIPT_DIRECTORY, "drawing-controlled-cdp-smoke.ps1"),
  ],
  [
    path.join(SCRIPT_DIRECTORY, "drawing-rollback-drills-browser.mjs"),
    path.join(SCRIPT_DIRECTORY, "drawing-rollback-drills-browser.ps1"),
  ],
]);
const CONTROLLED_ENTRYPOINTS = new Set(CONTROLLED_LAUNCHERS.keys());
const OWNED_PROFILE_PREFIX = "candlescope-controlled-cdp-";
const DIAGNOSTIC_BINDING = "__CANDLESCOPE_CONTROLLED_CDP_REPORT__";
const CONTROLLED_ROLLBACK_SESSION_KEY = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL_TOKEN__";
const CONTROLLED_ROLLBACK_HANDLE = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__";
export const CONTROLLED_WORKER_ROLLBACK_DRILL_IDS = Object.freeze([
  "worker-init-failure",
  "offscreen-canvas-unsupported",
  "worker-stale-generation",
]);
export const CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS = Object.freeze([
  "quota",
  "blocked",
]);
export const CONTROLLED_ROLLBACK_DRILL_IDS = Object.freeze([
  ...CONTROLLED_WORKER_ROLLBACK_DRILL_IDS,
  "indexeddb-quota-blocked",
]);
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DEFAULT_MOCK = Object.freeze({
  bars: 1_500,
  intervalSeconds: 3_600,
  endTime: 1_783_987_200,
});
export const CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES = Object.freeze({
  worker: Object.freeze({ runtime: true, network: true, fetch: false }),
  shared_worker: Object.freeze({ runtime: true, network: true, fetch: true }),
  service_worker: Object.freeze({ runtime: true, network: true, fetch: true }),
});
export const CONTROLLED_DIAGNOSTIC_WORKER_TYPES = Object.freeze(
  Object.keys(CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES),
);
const CONTROLLED_DRAWING_WORKER_FETCH_RESOURCE_TYPE = "Other";
const CONTROLLED_OPTION_KEYS = new Set([
  "chromePath",
  "dpr",
  "engineMode",
  "interactionSurfaceMode",
  "mockBars",
  "mockEndTime",
  "mockIntervalSeconds",
  "rasterBackend",
  "timeoutMs",
  "viewport",
]);
const FORBIDDEN_OPTION_KEYS = new Set([
  "apiPort",
  "browserArgs",
  "cdpUrl",
  "debugPort",
  "environment",
  "frontendRoot",
  "headless",
  "previewPort",
  "processFactory",
  "profileDirectory",
  "spawn",
  "transport",
  "url",
  "webSocketUrl",
]);
const BUILD_INPUT_ROOTS = Object.freeze(["public", "src", "scripts"]);
const BUILD_INPUT_FILES = Object.freeze([
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]);
const PROCESS_ENVIRONMENT_ALLOWLIST = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function isoNow() {
  return new Date().toISOString();
}

const INDEXEDDB_BUCKET_SPACE_CACHE_TIME_LIMIT_MS = 30_000;
const INDEXEDDB_BUCKET_SPACE_CACHE_GUARD_MS = 5_000;
const CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES = 1;
const CONTROLLED_QUOTA_STORE_NAME = "quota-probe";
const CONTROLLED_QUOTA_BASELINE_KEY = "baseline";

export async function waitForControlledQuotaCacheExpiry({
  origin,
  readUsageAndQuota,
  waitFor = wait,
  monotonicNow = () => globalThis.performance.now(),
  observedAt = isoNow,
  cacheTimeLimitMs = INDEXEDDB_BUCKET_SPACE_CACHE_TIME_LIMIT_MS,
  guardMs = INDEXEDDB_BUCKET_SPACE_CACHE_GUARD_MS,
}) {
  const requestedWaitMs = cacheTimeLimitMs + guardMs;
  const startedAt = observedAt();
  const startedMilliseconds = monotonicNow();
  await waitFor(requestedWaitMs);
  const elapsedMs = monotonicNow() - startedMilliseconds;
  const completedAt = observedAt();
  if (!Number.isFinite(elapsedMs) || elapsedMs < requestedWaitMs) {
    throw new Error(
      `Controlled IndexedDB quota cache-expiry guard elapsed only ${elapsedMs}ms; required ${requestedWaitMs}ms`,
    );
  }
  const verification = await readUsageAndQuota(origin);
  return Object.freeze({
    kind: "indexeddb-bucket-space-cache-expiry",
    cacheTimeLimitMs,
    guardMs,
    requestedWaitMs,
    elapsedMs,
    startedAt,
    completedAt,
    verification,
  });
}

export async function prepareControlledQuotaOverride({
  binding,
  receiptId,
  origin,
  overrideQuota,
  readUsageAndQuota,
  evaluatePreparation,
  evaluateProbe,
  evaluateCleanup,
  publish,
  observedAt = isoNow,
  waitForCacheExpiry = waitForControlledQuotaCacheExpiry,
}) {
  let state = {
    ...binding,
    receiptId,
    origin,
    sacrificialDatabaseName: `candlescope-rollback-quota-${binding.runId}-${binding.faultId}`,
    sacrificialStoreName: CONTROLLED_QUOTA_STORE_NAME,
    baselineKey: CONTROLLED_QUOTA_BASELINE_KEY,
    preparationSnapshot: null,
    probeSnapshot: null,
    releaseSnapshot: null,
    prepared: false,
    before: null,
    overrideCommand: null,
    overridden: null,
    cacheExpiryGuard: null,
    quotaPlan: null,
    overrideActive: false,
    overrideCleared: true,
    overrideResetRequired: false,
    pageCleanupRequired: true,
    pageCleanupCompleted: false,
    releaseAccepted: false,
    clearCommand: null,
    restored: null,
    forcedCleanup: false,
    overrideCleanupError: null,
    pageCleanupError: null,
    restorationError: null,
  };
  publish(state);
  try {
    const preparationSnapshot = await evaluatePreparation(binding.faultId);
    const quotaPreparation = preparationSnapshot?.storage?.quotaPreparation;
    if (preparationSnapshot?.runId !== binding.runId
      || preparationSnapshot?.faultId !== binding.faultId
      || preparationSnapshot?.variant !== "quota"
      || quotaPreparation?.prepared !== true
      || quotaPreparation?.databaseName !== state.sacrificialDatabaseName
      || quotaPreparation?.storeName !== state.sacrificialStoreName
      || quotaPreparation?.baselineKey !== state.baselineKey
      || quotaPreparation?.baselineCommitted !== true
      || quotaPreparation?.connectionKeptOpen !== true) {
      throw new Error(
        `Controlled IndexedDB quota preparation is invalid: ${JSON.stringify(preparationSnapshot)}`,
      );
    }
    state = { ...state, preparationSnapshot };
    publish(state);

    const before = await readUsageAndQuota(origin);
    state = { ...state, before };
    publish(state);
    if (!Number.isFinite(before?.usageBytes)
      || before.usageBytes <= CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES
      || !Number.isFinite(before?.quotaBytes)
      || before.quotaBytes <= CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES
      || before?.overrideActive !== false) {
      throw new Error(`Controlled IndexedDB baseline quota is invalid: ${JSON.stringify(state)}`);
    }
    const quotaPlan = Object.freeze({
      kind: "nonzero-below-existing-usage",
      quotaSizeBytes: CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES,
      baselineUsageBytes: before.usageBytes,
      baselineUsageExceedsQuota: before.usageBytes > CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES,
    });
    state = { ...state, quotaPlan };
    publish(state);

    state = {
      ...state,
      overrideCleared: false,
      overrideResetRequired: true,
    };
    publish(state);
    await overrideQuota({ origin, quotaSize: CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES });
    const overrideCommand = Object.freeze({
      method: "Storage.overrideQuotaForOrigin",
      origin,
      quotaSize: CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES,
      accepted: true,
      observedAt: observedAt(),
    });
    state = { ...state, overrideCommand, overrideActive: true };
    publish(state);

    const overridden = await readUsageAndQuota(origin);
    state = { ...state, overridden };
    publish(state);
    if (overridden?.quotaBytes !== CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES
      || overridden?.overrideActive !== true) {
      throw new Error(`Controlled IndexedDB quota override did not become authoritative: ${JSON.stringify(state)}`);
    }

    const cacheExpiryGuard = await waitForCacheExpiry({ origin, readUsageAndQuota });
    state = { ...state, cacheExpiryGuard };
    publish(state);
    if (cacheExpiryGuard?.kind !== "indexeddb-bucket-space-cache-expiry"
      || cacheExpiryGuard?.cacheTimeLimitMs !== 30_000
      || cacheExpiryGuard?.guardMs !== 5_000
      || cacheExpiryGuard?.elapsedMs < cacheExpiryGuard?.requestedWaitMs
      || cacheExpiryGuard?.requestedWaitMs !== 35_000
      || cacheExpiryGuard?.verification?.quotaBytes !== CONTROLLED_QUOTA_OVERRIDE_SIZE_BYTES
      || cacheExpiryGuard?.verification?.overrideActive !== true) {
      throw new Error(`Controlled IndexedDB quota cache-expiry verification failed: ${JSON.stringify(state)}`);
    }

    const probeSnapshot = await evaluateProbe(binding.faultId);
    const quotaProbe = probeSnapshot?.storage?.quotaProbe;
    if (probeSnapshot?.runId !== binding.runId
      || probeSnapshot?.faultId !== binding.faultId
      || probeSnapshot?.variant !== "quota"
      || quotaProbe?.attempted !== true
      || quotaProbe?.databaseName !== state.sacrificialDatabaseName
      || quotaProbe?.storeName !== state.sacrificialStoreName
      || quotaProbe?.transactionMode !== "readwrite"
      || quotaProbe?.settled !== "abort"
      || quotaProbe?.abortEvent?.type !== "abort"
      || quotaProbe?.abortEvent?.isTrusted !== true
      || quotaProbe?.transactionError?.name !== "QuotaExceededError"
      || quotaProbe?.nativeQuotaExceeded !== true) {
      throw new Error(`Controlled IndexedDB native quota probe is invalid: ${JSON.stringify(probeSnapshot)}`);
    }
    state = {
      ...state,
      probeSnapshot,
      prepared: true,
    };
    publish(state);
    return Object.freeze({ ...state });
  } catch (error) {
    state = await forceCleanupControlledQuotaOverride(state, {
      overrideQuota,
      evaluateCleanup,
      readUsageAndQuota,
      publish,
      reason: "quota-preparation-failed",
      observedAt,
    });
    throw error;
  }
}

export async function forceCleanupControlledQuotaOverride(
  state,
  {
    overrideQuota,
    evaluateCleanup,
    readUsageAndQuota,
    publish = () => {},
    reason,
    observedAt = isoNow,
  },
) {
  if (!state) return state;
  let nextState = {
    ...state,
    forcedCleanup: true,
    forcedCleanupReason: reason,
    forcedCleanupAt: observedAt(),
  };
  publish(nextState);

  if (nextState.overrideCleared !== true || nextState.overrideResetRequired === true) {
    try {
      await overrideQuota({ origin: nextState.origin });
      nextState = {
        ...nextState,
        overrideActive: false,
        overrideCleared: true,
        overrideResetRequired: false,
        overrideCleanupError: null,
      };
    } catch (error) {
      nextState = {
        ...nextState,
        overrideCleanupError: error instanceof Error ? error.message : String(error),
      };
    }
    publish(nextState);
  }

  if (nextState.pageCleanupCompleted !== true) {
    try {
      const releaseSnapshot = await evaluateCleanup(nextState.faultId, true);
      const quotaRelease = releaseSnapshot?.storage?.quotaRelease;
      const completed = releaseSnapshot?.runId === nextState.runId
        && releaseSnapshot?.faultId === nextState.faultId
        && releaseSnapshot?.variant === "quota"
        && quotaRelease?.databaseName === nextState.sacrificialDatabaseName
        && quotaRelease?.storeName === nextState.sacrificialStoreName
        && quotaRelease?.connectionClosed === true
        && quotaRelease?.deletion?.status === "success"
        && quotaRelease?.databaseStillPresent === false
        && quotaRelease?.forcedCleanup === true
        && quotaRelease?.completed === true;
      nextState = {
        ...nextState,
        releaseSnapshot,
        pageCleanupCompleted: completed,
        pageCleanupRequired: !completed,
        pageCleanupError: completed ? null : "controlled quota page cleanup is incomplete",
      };
    } catch (error) {
      nextState = {
        ...nextState,
        pageCleanupError: error instanceof Error ? error.message : String(error),
      };
    }
    publish(nextState);
  }

  if (nextState.overrideCleared === true
    && nextState.pageCleanupCompleted === true
    && (!nextState.restored || nextState.restorationError !== null)
    && typeof readUsageAndQuota === "function") {
    try {
      const restored = await readUsageAndQuota(nextState.origin);
      const restorationValid = restored?.overrideActive === false
        && (nextState.before === null || restored?.quotaBytes === nextState.before?.quotaBytes);
      nextState = {
        ...nextState,
        restored,
        restorationError: restorationValid ? null : "controlled quota restoration drifted",
      };
    } catch (error) {
      nextState = {
        ...nextState,
        restorationError: error instanceof Error ? error.message : String(error),
      };
    }
    publish(nextState);
  }
  return Object.freeze({ ...nextState });
}

export async function releaseControlledQuotaOverride(
  state,
  {
    overrideQuota,
    evaluateCleanup,
    readUsageAndQuota,
    publish = () => {},
    observedAt = isoNow,
  },
) {
  let nextState = { ...state, overrideResetRequired: true };
  publish(nextState);
  await overrideQuota({ origin: nextState.origin });
  const clearCommand = Object.freeze({
    method: "Storage.overrideQuotaForOrigin",
    origin: nextState.origin,
    quotaSizeOmitted: true,
    accepted: true,
    observedAt: observedAt(),
  });
  nextState = {
    ...nextState,
    overrideActive: false,
    overrideCleared: true,
    overrideResetRequired: false,
    clearCommand,
  };
  publish(nextState);

  const releaseSnapshot = await evaluateCleanup(nextState.faultId, false);
  const quotaRelease = releaseSnapshot?.storage?.quotaRelease;
  if (releaseSnapshot?.runId !== nextState.runId
    || releaseSnapshot?.faultId !== nextState.faultId
    || releaseSnapshot?.variant !== "quota"
    || quotaRelease?.databaseName !== nextState.sacrificialDatabaseName
    || quotaRelease?.storeName !== nextState.sacrificialStoreName
    || quotaRelease?.connectionClosed !== true
    || quotaRelease?.deletion?.status !== "success"
    || quotaRelease?.completed !== true
    || quotaRelease?.databaseStillPresent !== false
    || quotaRelease?.forcedCleanup === true) {
    throw new Error(`Controlled IndexedDB quota release is invalid: ${JSON.stringify(releaseSnapshot)}`);
  }
  nextState = {
    ...nextState,
    releaseSnapshot,
    pageCleanupCompleted: true,
    pageCleanupRequired: false,
  };
  publish(nextState);

  const restored = await readUsageAndQuota(nextState.origin);
  const restorationValid = restored?.overrideActive === false
    && restored?.quotaBytes === nextState.before?.quotaBytes;
  nextState = {
    ...nextState,
    restored,
    restorationError: restorationValid ? null : "controlled quota restoration drifted",
  };
  publish(nextState);
  if (!restorationValid) {
    throw new Error(`Controlled IndexedDB quota restoration drifted: ${JSON.stringify(nextState)}`);
  }
  nextState = { ...nextState, releaseAccepted: true };
  publish(nextState);
  return Object.freeze({ ...nextState });
}

export async function prepareControlledBlockedFault({
  binding,
  receiptId,
  evaluatePreparation,
  publish,
}) {
  let state = {
    ...binding,
    receiptId,
    prepared: false,
    released: false,
    forcedCleanup: false,
    snapshot: null,
  };
  publish(state);
  const snapshot = await evaluatePreparation(binding.faultId);
  if (snapshot?.runId !== binding.runId
    || snapshot?.faultId !== binding.faultId
    || snapshot?.variant !== "blocked"
    || snapshot?.storage?.blockedInterceptorInstalled !== true
    || snapshot?.storage?.blockedPreparation?.prepared !== true) {
    throw new Error(`Controlled IndexedDB blocked preparation is invalid: ${JSON.stringify(snapshot)}`);
  }
  state = {
    ...state,
    prepared: true,
    snapshot,
  };
  publish(state);
  return Object.freeze({ ...state });
}

export async function forceCleanupControlledBlockedFault(
  state,
  { evaluateCleanup, reason },
) {
  if (!state || state.released !== false) {
    return Object.freeze({
      state,
      receipt: state ? Object.freeze({
        complete: state.released === true,
        forced: state.forcedCleanup === true,
        faultId: state.faultId,
      }) : null,
    });
  }
  const snapshot = await evaluateCleanup(state.faultId);
  const complete = snapshot?.storage?.blockedRelease?.completed === true;
  const nextState = Object.freeze({
    ...state,
    released: complete,
    forcedCleanup: true,
    forcedCleanupReason: reason,
    snapshot,
  });
  return Object.freeze({
    state: nextState,
    receipt: Object.freeze({ complete, forced: true, faultId: state.faultId }),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitWithCancelableTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function controlledCdpTerminalCauseErrorMessage(cause) {
  if (cause?.kind === "cdp-close") return `Owned Chrome CDP closed (code=${cause.code})`;
  if (cause?.kind === "cdp-error") {
    return `Owned Chrome CDP websocket error: ${cause.message || "unknown"}`;
  }
  return null;
}

function controlledHostProcessEnvironment(hostEnvironment = process.env) {
  return Object.fromEntries(Object.entries(hostEnvironment || {}).filter(([name]) => (
    PROCESS_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
  )));
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableObject(item)]));
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function positiveNumber(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeViewport(value = DEFAULT_VIEWPORT) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("viewport must be an object");
  }
  const unknown = Object.keys(value).filter((key) => key !== "width" && key !== "height");
  if (unknown.length > 0) throw new Error(`Unknown viewport option: ${unknown.join(", ")}`);
  return Object.freeze({
    width: positiveInteger(value.width, "viewport.width", 320, 7_680),
    height: positiveInteger(value.height, "viewport.height", 240, 4_320),
  });
}

export function normalizeControlledCdpOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("controlled CDP options must be an object");
  }
  const keys = Object.keys(options);
  const forbidden = keys.filter((key) => FORBIDDEN_OPTION_KEYS.has(key));
  if (forbidden.length > 0) {
    throw new Error(`Controlled CDP does not accept externally controlled state: ${forbidden.join(", ")}`);
  }
  const unknown = keys.filter((key) => !CONTROLLED_OPTION_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Unknown controlled CDP option: ${unknown.join(", ")}`);

  const engineMode = options.engineMode ?? "scene-canary";
  if (!["legacy", "shadow", "scene-canary", "scene"].includes(engineMode)) {
    throw new Error("engineMode must be legacy, shadow, scene-canary, or scene");
  }
  const interactionSurfaceMode = options.interactionSurfaceMode ?? "overlay";
  if (!["overlay", "legacy"].includes(interactionSurfaceMode)) {
    throw new Error("interactionSurfaceMode must be overlay or legacy");
  }
  const rasterBackend = options.rasterBackend ?? "worker";
  if (!["worker", "main-thread"].includes(rasterBackend)) {
    throw new Error("rasterBackend must be worker or main-thread");
  }
  const chromePath = String(options.chromePath || "");
  return Object.freeze({
    chromePath,
    dpr: positiveNumber(options.dpr ?? 1, "dpr", 0.5, 4),
    engineMode,
    interactionSurfaceMode,
    mockBars: positiveInteger(options.mockBars ?? DEFAULT_MOCK.bars, "mockBars", 2, 20_000),
    mockEndTime: positiveInteger(
      options.mockEndTime ?? DEFAULT_MOCK.endTime,
      "mockEndTime",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    mockIntervalSeconds: positiveInteger(
      options.mockIntervalSeconds ?? DEFAULT_MOCK.intervalSeconds,
      "mockIntervalSeconds",
      1,
      31_536_000,
    ),
    rasterBackend,
    timeoutMs: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1_000, 600_000),
    viewport: normalizeViewport(options.viewport),
  });
}

export function controlledBuildEnvironment(options, hostEnvironment = process.env) {
  const normalized = normalizeControlledCdpOptions(options);
  const inherited = controlledHostProcessEnvironment(hostEnvironment);
  const explicit = Object.freeze({
    NODE_ENV: "production",
    VITE_API_BASE: "/api/v1",
    VITE_DRAWING_COORDINATE_PROJECTOR: "batch",
    VITE_DRAWING_DOCUMENT_AUTHORITY: "document",
    VITE_DRAWING_ENGINE_MODE: normalized.engineMode,
    VITE_DRAWING_INTERACTION_OVERLAY: normalized.interactionSurfaceMode,
    VITE_DRAWING_RASTER_BACKEND: normalized.rasterBackend,
  });
  return Object.freeze({
    explicit,
    processEnvironment: Object.freeze({ ...inherited, ...explicit }),
  });
}

function normalizeFingerprintPath(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized
    || normalized.startsWith("/")
    || /^[a-z]:\//i.test(normalized)
    || normalized.split("/").includes("..")) {
    throw new Error(`Fingerprint path must be relative and contained: ${relativePath}`);
  }
  return normalized;
}

export function fingerprintFileEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("fingerprintFileEntries requires at least one file");
  }
  const seen = new Set();
  const files = entries.map((entry) => {
    const relativePath = normalizeFingerprintPath(entry?.relativePath);
    if (seen.has(relativePath)) throw new Error(`Duplicate fingerprint path: ${relativePath}`);
    seen.add(relativePath);
    const content = Buffer.isBuffer(entry?.content)
      ? entry.content
      : Buffer.from(String(entry?.content ?? ""), "utf8");
    return { relativePath, content };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const aggregate = createHash("sha256");
  const manifest = files.map((file) => {
    aggregate.update(file.relativePath);
    aggregate.update("\0");
    aggregate.update(String(file.content.byteLength));
    aggregate.update("\0");
    aggregate.update(file.content);
    aggregate.update("\0");
    return Object.freeze({
      path: file.relativePath,
      bytes: file.content.byteLength,
      sha256: sha256(file.content),
    });
  });
  return Object.freeze({
    algorithm: "sha256",
    fileCount: manifest.length,
    totalBytes: manifest.reduce((total, file) => total + file.bytes, 0),
    sha256: aggregate.digest("hex"),
    files: Object.freeze(manifest),
  });
}

function collectDirectoryEntries(rootDirectory, include = () => true) {
  const entries = [];
  const visit = (absolutePath, relativePath) => {
    if (!fs.existsSync(absolutePath)) return;
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), path.join(relativePath, name));
      }
      return;
    }
    const normalized = relativePath.replaceAll("\\", "/");
    if (stat.isFile() && include(normalized)) {
      entries.push({ relativePath: normalized, content: fs.readFileSync(absolutePath) });
    }
  };
  visit(rootDirectory, "");
  return entries;
}

function fingerprintBuildInputs() {
  const entries = [];
  for (const root of BUILD_INPUT_ROOTS) {
    entries.push(...collectDirectoryEntries(path.join(FRONTEND_ROOT, root))
      .map((entry) => ({ ...entry, relativePath: `${root}/${entry.relativePath}` })));
  }
  for (const file of BUILD_INPUT_FILES) {
    const absolutePath = path.join(FRONTEND_ROOT, file);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      entries.push({ relativePath: file, content: fs.readFileSync(absolutePath) });
    }
  }
  return fingerprintFileEntries(entries);
}

function fingerprintDistribution() {
  const directory = path.join(FRONTEND_ROOT, "dist");
  if (!fs.existsSync(path.join(directory, "index.html"))) {
    throw new Error("Controlled production build did not create dist/index.html");
  }
  return fingerprintFileEntries(collectDirectoryEntries(directory));
}

export function controlledBuildFingerprint(explicitEnvironment, assetFingerprint) {
  if (!explicitEnvironment || typeof explicitEnvironment !== "object" || Array.isArray(explicitEnvironment)) {
    throw new TypeError("explicitEnvironment must be an object");
  }
  if (!/^[0-9a-f]{64}$/.test(String(assetFingerprint?.sha256 || ""))) {
    throw new Error("assetFingerprint.sha256 must be a SHA-256 digest");
  }
  const environmentSha256 = sha256(stableJson(explicitEnvironment));
  return Object.freeze({
    algorithm: "sha256",
    environmentSha256,
    assetSha256: assetFingerprint.sha256,
    sha256: sha256(`${environmentSha256}\0${assetFingerprint.sha256}`),
  });
}

function hashFile(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(Object.freeze({
      path: path.resolve(absolutePath),
      bytes: fs.statSync(absolutePath).size,
      sha256: hash.digest("hex"),
    })));
  });
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function resolveControlledExecutable(name) {
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  if (process.platform === "win32" && process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, "System32", name));
  }
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of pathEntries) {
    if (path.extname(name)) candidates.push(path.join(directory, name));
    else for (const extension of extensions) candidates.push(path.join(directory, `${name}${extension}`));
  }
  const found = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) throw new Error(`Controlled runner could not resolve executable ${name}`);
  return path.resolve(found);
}

function controlledSystemPowerShellPath() {
  if (process.platform !== "win32") return null;
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || "").trim();
  if (!systemRoot) return null;
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function resolveControlledSystemPowerShell() {
  const executable = controlledSystemPowerShellPath();
  if (!executable) {
    throw new Error("Controlled runner could not resolve the system Windows PowerShell executable");
  }
  return executable;
}

function parseWindowsCommandLine(commandLine) {
  const source = String(commandLine || "");
  const argumentsList = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || "")) index += 1;
    if (index >= source.length) break;
    let argument = "";
    let inQuotes = false;
    while (index < source.length && (inQuotes || !/\s/.test(source[index]))) {
      if (source[index] === "\\") {
        let slashCount = 0;
        while (source[index] === "\\") {
          slashCount += 1;
          index += 1;
        }
        if (source[index] === '"') {
          argument += "\\".repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 0) inQuotes = !inQuotes;
          else argument += '"';
          index += 1;
        } else argument += "\\".repeat(slashCount);
        continue;
      }
      if (source[index] === '"') {
        inQuotes = !inQuotes;
        index += 1;
        continue;
      }
      argument += source[index];
      index += 1;
    }
    if (inQuotes) throw new Error("native process command line contains an unterminated quote");
    argumentsList.push(argument);
  }
  return argumentsList;
}

function readNativeProcessInvocation() {
  try {
    if (process.platform === "win32") {
      const powershellPath = resolveControlledSystemPowerShell();
      const script = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `$record = Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}"`,
        "if ($null -eq $record) { throw 'native process record not found' }",
        "$parent = Get-CimInstance Win32_Process -Filter (\"ProcessId = {0}\" -f $record.ParentProcessId)",
        "if ($null -eq $parent) { throw 'native parent process record not found' }",
        "[pscustomobject]@{ ProcessId = $record.ProcessId; ExecutablePath = $record.ExecutablePath; CommandLine = $record.CommandLine; ParentProcessId = $parent.ProcessId; ParentExecutablePath = $parent.ExecutablePath; ParentCommandLine = $parent.CommandLine } | ConvertTo-Json -Compress",
      ].join("\n");
      const raw = execFileSync(powershellPath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ], {
        encoding: "utf8",
        env: controlledHostProcessEnvironment(process.env),
        timeout: 15_000,
        windowsHide: true,
      }).trim();
      const record = JSON.parse(raw);
      return Object.freeze({
        kind: "native-process-invocation",
        schemaVersion: "candlescope-native-process-invocation/v1",
        supported: true,
        observedAt: isoNow(),
        pid: Number(record.ProcessId),
        executablePath: record.ExecutablePath ? path.resolve(record.ExecutablePath) : null,
        commandLine: record.CommandLine ?? null,
        arguments: Object.freeze(parseWindowsCommandLine(record.CommandLine)),
        parent: Object.freeze({
          pid: Number(record.ParentProcessId),
          executablePath: record.ParentExecutablePath ? path.resolve(record.ParentExecutablePath) : null,
          commandLine: record.ParentCommandLine ?? null,
          arguments: Object.freeze(parseWindowsCommandLine(record.ParentCommandLine)),
        }),
        error: null,
      });
    }
    if (process.platform === "linux") {
      const commandLine = fs.readFileSync(`/proc/${process.pid}/cmdline`);
      const argumentsList = commandLine.toString("utf8").split("\0").filter(Boolean);
      return Object.freeze({
        kind: "native-process-invocation",
        schemaVersion: "candlescope-native-process-invocation/v1",
        supported: true,
        observedAt: isoNow(),
        pid: process.pid,
        executablePath: fs.realpathSync(`/proc/${process.pid}/exe`),
        commandLine: null,
        arguments: Object.freeze(argumentsList),
        parent: null,
        error: null,
      });
    }
    throw new Error(`native process invocation is unsupported on ${process.platform}`);
  } catch (error) {
    return Object.freeze({
      kind: "native-process-invocation",
      schemaVersion: "candlescope-native-process-invocation/v1",
      supported: false,
      observedAt: isoNow(),
      pid: process.pid,
      executablePath: null,
      commandLine: null,
      arguments: Object.freeze([]),
      parent: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const CONTROLLED_NATIVE_PROCESS_INVOCATION = readNativeProcessInvocation();

function pathsEqual(left, right) {
  if (typeof left !== "string" || !left || typeof right !== "string" || !right) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  };
  const normalizedLeft = canonical(left);
  const normalizedRight = canonical(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function executableArgumentMatches(argv0, executablePath) {
  if (pathsEqual(argv0, executablePath)) return true;
  if (typeof argv0 !== "string" || !argv0 || typeof executablePath !== "string" || !executablePath) {
    return false;
  }
  return path.basename(argv0).toLowerCase() === path.basename(executablePath).toLowerCase();
}

function controlledPowerShellFileInvocationValid(parent, expectedLauncher) {
  const parentArguments = parent?.arguments;
  const trustedPowerShell = controlledSystemPowerShellPath();
  if (!Number.isSafeInteger(parent?.pid)
    || parent.pid <= 0
    || !Array.isArray(parentArguments)
    || parentArguments.length < 3
    || !trustedPowerShell
    || !pathsEqual(parent?.executablePath, trustedPowerShell)
    || !executableArgumentMatches(parentArguments[0], parent.executablePath)
    || expectedLauncher === null) {
    return false;
  }

  const fileArgumentIndices = parentArguments.flatMap((argument, index) => (
    /^-file$/i.test(String(argument)) ? [index] : []
  ));
  if (fileArgumentIndices.length !== 1) return false;
  const fileArgumentIndex = fileArgumentIndices[0];
  if (!Number.isSafeInteger(fileArgumentIndex)
    || fileArgumentIndex < 2
    || !pathsEqual(parentArguments[fileArgumentIndex + 1], expectedLauncher)) {
    return false;
  }

  const seenSwitches = new Set();
  for (let index = 1; index < fileArgumentIndex; index += 1) {
    const argument = String(parentArguments[index]).toLowerCase();
    if (["-nologo", "-noprofile", "-noninteractive"].includes(argument)) {
      if (seenSwitches.has(argument)) return false;
      seenSwitches.add(argument);
      continue;
    }
    if (argument === "-executionpolicy") {
      if (seenSwitches.has(argument)
        || String(parentArguments[index + 1] || "").toLowerCase() !== "bypass") {
        return false;
      }
      seenSwitches.add(argument);
      index += 1;
      continue;
    }
    return false;
  }
  return seenSwitches.has("-noprofile");
}

function controlledEntrypoint(entryPath) {
  return [...CONTROLLED_ENTRYPOINTS].find((candidate) => pathsEqual(candidate, entryPath)) ?? null;
}

function controlledLauncherForEntrypoint(entryPath) {
  const matchedEntrypoint = controlledEntrypoint(entryPath);
  return matchedEntrypoint ? CONTROLLED_LAUNCHERS.get(matchedEntrypoint) ?? null : null;
}

export function assessControlledRunnerRuntimeEvidence(evidence) {
  const violations = [];
  const nativeInvocation = evidence?.nativeInvocation;
  const nativeArguments = nativeInvocation?.arguments;
  if (nativeInvocation?.kind !== "native-process-invocation"
    || nativeInvocation?.schemaVersion !== "candlescope-native-process-invocation/v1"
    || nativeInvocation?.supported !== true
    || nativeInvocation?.pid !== evidence?.pid
    || !Array.isArray(nativeArguments)
    || nativeArguments.length < 2) {
    violations.push("native-invocation-invalid");
  }
  if (!pathsEqual(nativeInvocation?.executablePath, evidence?.execPath)
    || !pathsEqual(nativeArguments?.[0], evidence?.execPath)) {
    violations.push("native-executable-mismatch");
  }
  const nativeEntrypoint = typeof nativeArguments?.[1] === "string"
    ? path.resolve(nativeArguments[1])
    : null;
  const matchedEntrypoint = controlledEntrypoint(nativeEntrypoint);
  if (matchedEntrypoint === null) {
    violations.push("native-entrypoint-invalid");
  }
  const expectedLauncher = controlledLauncherForEntrypoint(matchedEntrypoint);
  const parent = nativeInvocation?.parent;
  if (!controlledPowerShellFileInvocationValid(parent, expectedLauncher)) {
    violations.push("native-launcher-parent-invalid");
  }
  if (!Array.isArray(evidence?.execArgv) || evidence.execArgv.length !== 0) {
    violations.push("node-exec-argv-not-empty");
  }
  if (String(evidence?.nodeOptions || "").trim()) violations.push("node-options-present");
  if (String(evidence?.nodePath || "").trim()) violations.push("node-path-present");
  if (!Array.isArray(evidence?.argv)
    || !pathsEqual(evidence.argv[0], evidence?.execPath)
    || !pathsEqual(evidence.argv[1], nativeEntrypoint)) {
    violations.push("javascript-argv-mismatch");
  }
  if (evidence?.webSocketValid !== true) violations.push("captured-websocket-invalid");
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
    nativeEntrypoint: matchedEntrypoint,
    nativeLauncher: expectedLauncher,
  });
}

export function assertControlledRunnerRuntime() {
  const prototype = CONTROLLED_WEBSOCKET_CONSTRUCTOR?.prototype;
  const evidence = Object.freeze({
    nativeInvocation: CONTROLLED_NATIVE_PROCESS_INVOCATION,
    pid: process.pid,
    execPath: process.execPath,
    execArgv: Object.freeze([...process.execArgv]),
    argv: Object.freeze([...process.argv]),
    nodeOptions: process.env.NODE_OPTIONS || null,
    nodePath: process.env.NODE_PATH || null,
    webSocketValid: typeof CONTROLLED_WEBSOCKET_CONSTRUCTOR === "function"
      && CONTROLLED_WEBSOCKET_CONSTRUCTOR.name === "WebSocket"
      && typeof prototype?.send === "function"
      && typeof prototype?.close === "function",
  });
  const assessment = assessControlledRunnerRuntimeEvidence(evidence);
  if (!assessment.valid) {
    throw new Error(`Controlled runner forbids Node code injection or mutable launch provenance: ${JSON.stringify({
      violations: assessment.violations,
      nativeInvocation: CONTROLLED_NATIVE_PROCESS_INVOCATION,
      execArgv: evidence.execArgv,
      argv: evidence.argv,
      NODE_OPTIONS: evidence.nodeOptions,
      NODE_PATH: evidence.nodePath,
    })}`);
  }
  return evidence;
}

export function assertControlledRunnerEntrypoint() {
  const nativeEntrypoint = CONTROLLED_NATIVE_PROCESS_INVOCATION.arguments?.[1];
  const resolved = typeof nativeEntrypoint === "string" && nativeEntrypoint
    ? path.resolve(nativeEntrypoint)
    : null;
  const matchedEntrypoint = controlledEntrypoint(resolved);
  const expectedLauncher = controlledLauncherForEntrypoint(matchedEntrypoint);
  if (matchedEntrypoint === null
    || !pathsEqual(process.argv[1], resolved)) {
    throw new Error(`Controlled runner requires a fixed trusted native entrypoint: ${resolved || "missing"}`);
  }
  if (!controlledPowerShellFileInvocationValid(CONTROLLED_NATIVE_PROCESS_INVOCATION.parent, expectedLauncher)) {
    throw new Error(`Controlled runner requires its fixed native launcher: ${expectedLauncher || "missing"}`);
  }
  return matchedEntrypoint;
}

export function fingerprintBuildToolImplementation() {
  const roots = [
    ["vite/dist", path.join(FRONTEND_ROOT, "node_modules", "vite", "dist")],
    ["rollup/dist", path.join(FRONTEND_ROOT, "node_modules", "rollup", "dist")],
    ["@rollup", path.join(FRONTEND_ROOT, "node_modules", "@rollup")],
    ["esbuild/bin", path.join(FRONTEND_ROOT, "node_modules", "esbuild", "bin")],
    ["@esbuild", path.join(FRONTEND_ROOT, "node_modules", "@esbuild")],
  ];
  const entries = roots.flatMap(([prefix, absolute]) => (
    collectDirectoryEntries(absolute).map((entry) => ({
      ...entry,
      relativePath: `${prefix}/${entry.relativePath}`,
    }))
  ));
  return fingerprintFileEntries(entries);
}

async function readToolchainFingerprint(chromePath) {
  const runtimeEvidence = assertControlledRunnerRuntime();
  const vitePath = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  const npmCli = findNpmCli();
  if (!npmCli) throw new Error("Controlled runner could not locate npm-cli.js for toolchain provenance");
  const gitPath = resolveControlledExecutable(process.platform === "win32" ? "git.exe" : "git");
  const taskkillPath = process.platform === "win32" ? resolveControlledExecutable("taskkill.exe") : null;
  const powershellPath = process.platform === "win32"
    ? resolveControlledSystemPowerShell()
    : null;
  const webSocketSource = Function.prototype.toString.call(CONTROLLED_WEBSOCKET_CONSTRUCTOR);
  return Object.freeze({
    node: await hashFile(process.execPath),
    npm: await hashFile(npmCli),
    vite: await hashFile(vitePath),
    buildImplementation: fingerprintBuildToolImplementation(),
    git: await hashFile(gitPath),
    taskkill: taskkillPath ? await hashFile(taskkillPath) : null,
    powershell: powershellPath ? await hashFile(powershellPath) : null,
    browser: await hashFile(chromePath),
    runtime: Object.freeze({
      nodeVersion: process.version,
      execArgv: Object.freeze([...process.execArgv]),
      nodeOptionsPresent: Boolean(String(process.env.NODE_OPTIONS || "").trim()),
      nodePathPresent: Boolean(String(process.env.NODE_PATH || "").trim()),
      webSocketConstructorName: CONTROLLED_WEBSOCKET_CONSTRUCTOR.name,
      webSocketConstructorSha256: sha256(webSocketSource),
      nativeInvocation: runtimeEvidence.nativeInvocation,
    }),
  });
}

function readWindowsDescendantCensus(rootPid, powershellPath) {
  if (process.platform !== "win32") {
    return Object.freeze({
      kind: "windows-process-descendant-census",
      schemaVersion: "candlescope-windows-process-descendant-census/v1",
      supported: false,
      checkedAt: isoNow(),
      rootPid,
      empty: true,
      descendants: Object.freeze([]),
    });
  }
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$rootPid = ${Number(rootPid)}`,
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)",
    "$frontier = @($rootPid)",
    "$found = @()",
    "while ($frontier.Count -gt 0) {",
    "  $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId })",
    "  if ($next.Count -eq 0) { break }",
    "  $found += $next",
    "  $frontier = @($next | ForEach-Object { $_.ProcessId })",
    "}",
    "@($found) | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
  const raw = execFileSync(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: controlledHostProcessEnvironment(process.env),
    timeout: 15_000,
    windowsHide: true,
  }).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  const descendants = (Array.isArray(parsed) ? parsed : [parsed]).map((record) => Object.freeze({
    pid: Number(record.ProcessId),
    parentPid: Number(record.ParentProcessId),
    name: record.Name ?? null,
    executablePath: record.ExecutablePath ?? null,
  }));
  return Object.freeze({
    kind: "windows-process-descendant-census",
    schemaVersion: "candlescope-windows-process-descendant-census/v1",
    supported: true,
    checkedAt: isoNow(),
    rootPid,
    empty: descendants.length === 0,
    descendants: Object.freeze(descendants),
  });
}

async function closeBuildDescendants(rootPid, toolchain) {
  const before = readWindowsDescendantCensus(rootPid, toolchain.powershell?.path ?? null);
  const terminationReceipts = [];
  for (const descendant of before.descendants) {
    terminationReceipts.push(await stopWindowsProcessTree(descendant.pid));
  }
  const after = readWindowsDescendantCensus(rootPid, toolchain.powershell?.path ?? null);
  return Object.freeze({
    kind: "windows-descendant-cleanup-census",
    schemaVersion: "candlescope-windows-descendant-cleanup-census/v1",
    rootPid,
    before,
    terminationReceipts: Object.freeze(terminationReceipts),
    after,
    empty: after.empty,
  });
}

async function closeDescendantsWithFailureReceipt(rootPid, toolchain) {
  try {
    if (!Number.isSafeInteger(rootPid)) throw new Error("owned process PID was not allocated");
    return await closeBuildDescendants(rootPid, toolchain);
  } catch (error) {
    return Object.freeze({
      kind: "windows-descendant-cleanup-census",
      schemaVersion: "candlescope-windows-descendant-cleanup-census/v1",
      before: null,
      terminationReceipts: Object.freeze([]),
      after: null,
      empty: false,
      error: error instanceof Error ? error.message : String(error),
      rootPid: Number.isSafeInteger(rootPid) ? rootPid : null,
    });
  }
}

async function waitForWindowsDescendantsQuiet(rootPid, toolchain, timeoutMs = 1_500) {
  if (process.platform !== "win32") {
    return Object.freeze({
      kind: "windows-descendant-exit-grace",
      schemaVersion: "candlescope-windows-descendant-exit-grace/v1",
      supported: false,
      passed: true,
      rootPid,
      requiredConsecutiveEmpty: 0,
      observations: Object.freeze([]),
    });
  }
  const observations = [];
  const deadline = Date.now() + timeoutMs;
  let consecutiveEmpty = 0;
  let error = null;
  while (Date.now() <= deadline) {
    try {
      const census = readWindowsDescendantCensus(rootPid, toolchain.powershell?.path ?? null);
      observations.push(census);
      consecutiveEmpty = census.empty ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= 2) break;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
    await wait(100);
  }
  return Object.freeze({
    kind: "windows-descendant-exit-grace",
    schemaVersion: "candlescope-windows-descendant-exit-grace/v1",
    supported: true,
    passed: consecutiveEmpty >= 2 && error === null,
    rootPid,
    requiredConsecutiveEmpty: 2,
    consecutiveEmpty,
    observations: Object.freeze(observations),
    error,
  });
}

function readGitBuildContext(gitExecutable) {
  const run = (args) => execFileSync(gitExecutable, args, {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: controlledHostProcessEnvironment(process.env),
  }).trim();
  const pathspecs = [...BUILD_INPUT_ROOTS, ...BUILD_INPUT_FILES];
  const commit = run(["rev-parse", "HEAD"]);
  const status = run([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...pathspecs,
  ]);
  return Object.freeze({
    commit,
    clean: status.length === 0,
    status: Object.freeze(status ? status.split(/\r?\n/) : []),
  });
}

export async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port)) reject(new Error("Loopback port allocation failed"));
        else resolve(port);
      });
    });
  });
}

async function findDistinctLoopbackPorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      server.unref();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      if (typeof address !== "object" || !address || !Number.isSafeInteger(address.port)) {
        throw new Error("Loopback port allocation failed");
      }
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  }
}

function probeLoopbackPort(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, result });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(null, "probe-timeout"));
    socket.once("error", (error) => {
      const result = error?.code || error?.message || "connection-error";
      finish(result === "ECONNREFUSED" ? false : null, result);
    });
  });
}

async function waitForOwnedPortsClosed(descriptors, timeoutMs = 5_000) {
  const records = descriptors.map((descriptor) => ({
    kind: descriptor.kind,
    host: "127.0.0.1",
    port: descriptor.port,
    attempts: 0,
    closed: false,
    closedAt: null,
    lastProbe: null,
  }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline && records.some((record) => !record.closed)) {
    await Promise.all(records.filter((record) => !record.closed).map(async (record) => {
      record.attempts += 1;
      const probe = await probeLoopbackPort(record.port);
      record.lastProbe = probe.result;
      if (probe.open === false) {
        record.closed = true;
        record.closedAt = isoNow();
      }
    }));
    if (records.some((record) => !record.closed)) await wait(100);
  }
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

export function findControlledChrome(explicitPath = "") {
  const explicit = String(explicitPath || "").trim();
  if (explicit) return fs.existsSync(explicit) && fs.statSync(explicit).isFile() ? path.resolve(explicit) : null;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? path.resolve(found) : null;
}

function createOutputTail(child, limit = 120) {
  const lines = [];
  const append = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    lines.push(...text.split(/\r?\n/).filter(Boolean));
    if (lines.length > limit) lines.splice(0, lines.length - limit);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => [...lines];
}

function createProcessLifecycle(kind, child, details = {}) {
  const lifecycle = {
    kind,
    instanceId: randomUUID(),
    pid: Number.isSafeInteger(child.pid) ? child.pid : null,
    startedAt: isoNow(),
    readyAt: null,
    stopRequestedAt: null,
    forceStopRequestedAt: null,
    stoppedAt: null,
    exitCode: null,
    signal: null,
    spawnError: null,
    treeStopReceipt: null,
    details,
  };
  let resolveExit;
  lifecycle.exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const complete = (code, signal) => {
    if (lifecycle.stoppedAt !== null) return;
    lifecycle.stoppedAt = isoNow();
    lifecycle.exitCode = Number.isInteger(code) ? code : null;
    lifecycle.signal = typeof signal === "string" ? signal : null;
    resolveExit();
  };
  child.once("error", (error) => {
    lifecycle.spawnError = error instanceof Error ? error.message : String(error);
    complete(null, null);
  });
  child.once("exit", complete);
  if (child.exitCode !== null || child.signalCode !== null) complete(child.exitCode, child.signalCode);
  return lifecycle;
}

function processLifecycleSnapshot(lifecycle, outputTail = []) {
  return Object.freeze({
    kind: lifecycle.kind,
    instanceId: lifecycle.instanceId,
    pid: lifecycle.pid,
    startedAt: lifecycle.startedAt,
    readyAt: lifecycle.readyAt,
    stopRequestedAt: lifecycle.stopRequestedAt,
    forceStopRequestedAt: lifecycle.forceStopRequestedAt,
    stoppedAt: lifecycle.stoppedAt,
    exitCode: lifecycle.exitCode,
    signal: lifecycle.signal,
    spawnError: lifecycle.spawnError,
    treeStopReceipt: lifecycle.treeStopReceipt,
    exited: lifecycle.stoppedAt !== null,
    details: stableObject(lifecycle.details),
    outputTail: Object.freeze([...outputTail]),
  });
}

async function waitForLifecycleExit(lifecycle, timeoutMs) {
  if (lifecycle.stoppedAt !== null) return true;
  const outcome = await waitWithCancelableTimeout(lifecycle.exitPromise, timeoutMs);
  return !outcome.timedOut;
}

async function stopWindowsProcessTree(pid, timeoutMs = 5_000) {
  const taskkillPath = resolveControlledExecutable("taskkill.exe");
  const child = spawn(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
    env: controlledHostProcessEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = createOutputTail(child, 40);
  const lifecycle = createProcessLifecycle("windows-taskkill", child, {
    executable: taskkillPath,
    targetPid: pid,
  });
  const exited = await waitForLifecycleExit(lifecycle, timeoutMs);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {
      // The timeout and lifecycle receipt remain the cleanup proof.
    }
    await waitForLifecycleExit(lifecycle, 1_000);
  }
  return processLifecycleSnapshot(lifecycle, output());
}

async function stopOwnedProcess(child, lifecycle, timeoutMs = 5_000, toolchain = null) {
  if (!child || !lifecycle) return;
  lifecycle.stopRequestedAt ??= isoNow();
  if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
    const rootAlreadyExited = lifecycle.stoppedAt !== null;
    let rootTermination = null;
    if (!rootAlreadyExited) {
      lifecycle.forceStopRequestedAt = isoNow();
      rootTermination = await stopWindowsProcessTree(child.pid, timeoutMs);
      await waitForLifecycleExit(lifecycle, timeoutMs);
    }
    const cleanupToolchain = toolchain ?? Object.freeze({
      powershell: Object.freeze({ path: resolveControlledSystemPowerShell() }),
    });
    const descendantCensus = await closeDescendantsWithFailureReceipt(child.pid, cleanupToolchain);
    const rootExited = lifecycle.stoppedAt !== null;
    const passed = rootExited && descendantCensus.empty === true;
    lifecycle.treeStopReceipt = Object.freeze({
      kind: "windows-owned-process-tree-cleanup",
      schemaVersion: "candlescope-windows-owned-process-tree-cleanup/v1",
      exited: passed,
      exitCode: passed ? 0 : 1,
      rootPid: child.pid,
      rootAlreadyExited,
      rootExited,
      rootTermination,
      descendantCensus,
    });
    return;
  }
  if (lifecycle.stoppedAt !== null) return;
  try { child.kill(); } catch (error) {
    lifecycle.spawnError ??= error instanceof Error ? error.message : String(error);
  }
  if (await waitForLifecycleExit(lifecycle, timeoutMs)) return;
  lifecycle.forceStopRequestedAt = isoNow();
  try { child.kill("SIGKILL"); } catch (error) {
    lifecycle.spawnError ??= error instanceof Error ? error.message : String(error);
  }
  await waitForLifecycleExit(lifecycle, timeoutMs);
}

async function runProductionBuild(configuration, runNonce, toolchain) {
  const buildEnvironment = controlledBuildEnvironment(configuration);
  const gitBefore = readGitBuildContext(toolchain.git.path);
  const beforeInputs = fingerprintBuildInputs();
  const viteBin = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) throw new Error("Vite executable is missing; run npm install first");
  const child = spawn(process.execPath, [viteBin, "build"], {
    cwd: FRONTEND_ROOT,
    env: buildEnvironment.processEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = createOutputTail(child);
  const lifecycle = createProcessLifecycle("vite-build", child, {
    command: [process.execPath, viteBin, "build"],
    cwd: FRONTEND_ROOT,
  });
  const exited = await waitForLifecycleExit(lifecycle, configuration.timeoutMs * 4);
  if (!exited) await stopOwnedProcess(child, lifecycle, 5_000, toolchain);
  const processReceipt = processLifecycleSnapshot(lifecycle, output());
  const descendantCensus = await closeDescendantsWithFailureReceipt(processReceipt.pid, toolchain);
  if (!exited || processReceipt.exitCode !== 0 || processReceipt.spawnError !== null) {
    throw new Error(`Controlled production build failed: ${JSON.stringify({
      process: processReceipt,
      descendantCensus,
    })}`);
  }
  if (!descendantCensus.empty) {
    throw new Error(`Controlled production build left descendant processes: ${JSON.stringify(descendantCensus)}`);
  }
  const afterInputs = fingerprintBuildInputs();
  if (beforeInputs.sha256 !== afterInputs.sha256) {
    throw new Error("Controlled production build inputs changed while Vite was building");
  }
  const gitAfter = readGitBuildContext(toolchain.git.path);
  if (gitAfter.commit !== gitBefore.commit
    || stableJson(gitAfter.status) !== stableJson(gitBefore.status)) {
    throw new Error(`Controlled production build Git context changed: ${JSON.stringify({
      before: gitBefore,
      after: gitAfter,
    })}`);
  }
  const ownershipRelativePath = "__controlled__/ownership.json";
  const ownership = Object.freeze({
    schemaVersion: "candlescope-controlled-production/v1",
    runNonce,
    gitCommit: gitBefore.commit,
    buildInputSha256: beforeInputs.sha256,
  });
  const ownershipPath = path.join(FRONTEND_ROOT, "dist", ...ownershipRelativePath.split("/"));
  fs.mkdirSync(path.dirname(ownershipPath), { recursive: true });
  fs.writeFileSync(ownershipPath, `${stableJson(ownership)}\n`, "utf8");
  const assets = fingerprintDistribution();
  const fingerprint = controlledBuildFingerprint(buildEnvironment.explicit, assets);
  const indexHtml = fs.readFileSync(path.join(FRONTEND_ROOT, "dist", "index.html"), "utf8");
  const entryAssetPaths = extractHtmlAssetPaths(indexHtml);
  return Object.freeze({
    kind: "controlled-production-build",
    buildId: randomUUID(),
    runNonce,
    completedAt: isoNow(),
    explicitEnvironment: buildEnvironment.explicit,
    git: gitBefore,
    toolchain,
    inputFingerprint: beforeInputs,
    assetFingerprint: assets,
    buildFingerprint: fingerprint,
    entryAssetPaths,
    ownership: Object.freeze({ relativePath: ownershipRelativePath, value: ownership }),
    process: processReceipt,
    descendantCensus,
  });
}

function httpJson(url, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once("timeout", () => request.destroy(new Error(`HTTP timeout for ${url}`)));
    request.once("error", reject);
  });
}

async function waitForHttpJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try { return await httpJson(url, Math.min(5_000, timeoutMs)); } catch (error) { lastError = error; }
    await wait(200);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function startManagedServers(configuration, buildReceipt, apiPort, previewPort) {
  const baseEnvironment = controlledHostProcessEnvironment(process.env);
  const apiEnvironment = {
    ...baseEnvironment,
    NODE_ENV: "production",
    PORT: String(apiPort),
    CANDLESCOPE_CONTROLLED_RUN_NONCE: buildReceipt.runNonce,
    CANDLESCOPE_MOCK_BAR_COUNT: String(configuration.mockBars),
    CANDLESCOPE_MOCK_INTERVAL_SECONDS: String(configuration.mockIntervalSeconds),
    CANDLESCOPE_MOCK_END_TIME: String(configuration.mockEndTime),
  };
  const api = spawn(process.execPath, [path.join(FRONTEND_ROOT, "scripts", "mock-api.mjs")], {
    cwd: FRONTEND_ROOT,
    env: apiEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const apiOutput = createOutputTail(api);
  const apiLifecycle = createProcessLifecycle("mock-api", api, {
    host: "127.0.0.1",
    port: apiPort,
    runNonce: buildReceipt.runNonce,
    environment: Object.freeze({
      NODE_ENV: apiEnvironment.NODE_ENV,
      PORT: apiEnvironment.PORT,
      CANDLESCOPE_CONTROLLED_RUN_NONCE: apiEnvironment.CANDLESCOPE_CONTROLLED_RUN_NONCE,
      CANDLESCOPE_MOCK_BAR_COUNT: apiEnvironment.CANDLESCOPE_MOCK_BAR_COUNT,
      CANDLESCOPE_MOCK_INTERVAL_SECONDS: apiEnvironment.CANDLESCOPE_MOCK_INTERVAL_SECONDS,
      CANDLESCOPE_MOCK_END_TIME: apiEnvironment.CANDLESCOPE_MOCK_END_TIME,
    }),
  });
  const viteBin = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  const preview = spawn(process.execPath, [
    viteBin,
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(previewPort),
    "--strictPort",
  ], {
    cwd: FRONTEND_ROOT,
    env: {
      ...baseEnvironment,
      NODE_ENV: "production",
      CANDLESCOPE_CONTROLLED_RUN_NONCE: buildReceipt.runNonce,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      VITE_DEV_PORT: String(previewPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const previewOutput = createOutputTail(preview);
  const previewLifecycle = createProcessLifecycle("vite-preview", preview, {
    host: "127.0.0.1",
    port: previewPort,
    apiProxyTarget: `http://127.0.0.1:${apiPort}`,
    runNonce: buildReceipt.runNonce,
  });

  const snapshot = () => Object.freeze({
    api: processLifecycleSnapshot(apiLifecycle, apiOutput()),
    preview: processLifecycleSnapshot(previewLifecycle, previewOutput()),
  });
  const close = async () => {
    await stopOwnedProcess(preview, previewLifecycle, 5_000, buildReceipt.toolchain);
    await stopOwnedProcess(api, apiLifecycle, 5_000, buildReceipt.toolchain);
    return snapshot();
  };
  try {
    const mockMeta = await waitForHttpJson(`http://127.0.0.1:${apiPort}/__mock__/meta`, configuration.timeoutMs);
    await waitForHttpJson(`http://127.0.0.1:${previewPort}/api/v1/exchanges/`, configuration.timeoutMs);
    const ownership = await waitForHttpJson(
      `http://127.0.0.1:${previewPort}/${buildReceipt.ownership.relativePath}`,
      configuration.timeoutMs,
    );
    if (mockMeta?.bar_count !== configuration.mockBars
      || mockMeta?.interval_seconds !== configuration.mockIntervalSeconds
      || mockMeta?.end_time !== configuration.mockEndTime) {
      throw new Error(`Managed mock API metadata does not match this run: ${JSON.stringify(mockMeta)}`);
    }
    if (stableJson(ownership) !== stableJson(buildReceipt.ownership.value)) {
      throw new Error(`Managed preview nonce does not match this build: ${JSON.stringify(ownership)}`);
    }
    await wait(100);
    if (apiLifecycle.stoppedAt !== null || previewLifecycle.stoppedAt !== null) {
      throw new Error("Managed server exited after another listener answered readiness probes");
    }
    apiLifecycle.readyAt = isoNow();
    previewLifecycle.readyAt = isoNow();
    return {
      origin: `http://127.0.0.1:${previewPort}`,
      url: `http://127.0.0.1:${previewPort}/`,
      mockMeta,
      ownership,
      snapshot,
      close,
    };
  } catch (error) {
    const receipts = await close();
    const wrapped = new Error(
      `${error?.message || error}\nManaged server receipts:\n${JSON.stringify(receipts)}`,
    );
    wrapped.serverReceipts = receipts;
    throw wrapped;
  }
}

async function waitForDebugTarget(debugPort, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${debugPort}/json`, Math.min(timeoutMs, 5_000));
      if (Array.isArray(targets)) {
        const page = targets.find((target) => target?.type === "page");
        if (page?.id && page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) { lastError = error; }
    await wait(200);
  }
  throw lastError || new Error("Timed out waiting for owned Chrome debug target");
}

async function waitForOwnedDevToolsPort(profileDirectory, timeoutMs) {
  const activePortPath = path.join(profileDirectory, "DevToolsActivePort");
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const lines = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
      const port = Number(lines[0]);
      const browserWebSocketPath = lines[1] || null;
      latest = { port, browserWebSocketPath };
      if (Number.isSafeInteger(port)
        && port > 0
        && browserWebSocketPath?.startsWith("/devtools/browser/")) {
        return Object.freeze({
          path: activePortPath,
          port,
          browserWebSocketPath,
          observedAt: isoNow(),
        });
      }
    } catch {
      // Chrome creates the owned profile receipt asynchronously during startup.
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for owned DevToolsActivePort: ${JSON.stringify(latest)}`);
}

function assertOwnedWebSocketUrl(webSocketUrl, debugPort) {
  const parsed = new URL(webSocketUrl);
  const hostAllowed = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "ws:"
    || !hostAllowed
    || Number(parsed.port) !== debugPort
    || !parsed.pathname.startsWith("/devtools/page/")) {
    throw new Error("Chrome returned a debug target outside the owned loopback endpoint");
  }
}

export function createControlledCdpCommandEnvelope(id, method, params = {}, sessionId = null) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("CDP command id must be positive");
  if (typeof method !== "string" || !method.trim()) throw new TypeError("CDP command method is required");
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("CDP command params must be an object");
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId.trim())) {
    throw new TypeError("CDP command sessionId must be null or a non-empty string");
  }
  return Object.freeze({
    id,
    method,
    params,
    ...(sessionId !== null ? { sessionId } : {}),
  });
}

export function parseControlledCdpMessage(raw) {
  if (typeof raw !== "string") throw new TypeError("CDP message must be textual JSON");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`CDP message is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("CDP message root must be an object");
  }
  const hasOwn = (name) => Object.prototype.hasOwnProperty.call(parsed, name);
  const hasId = hasOwn("id");
  const hasMethod = hasOwn("method");
  if (hasId === hasMethod) {
    throw new TypeError("CDP message must be exactly one response or event");
  }
  const hasSessionId = hasOwn("sessionId");
  const sessionId = hasSessionId ? parsed.sessionId : null;
  if (hasSessionId && (typeof sessionId !== "string" || !sessionId.trim())) {
    throw new TypeError("CDP message sessionId must be a non-empty string when present");
  }
  if (hasId) {
    if (!Number.isSafeInteger(parsed.id) || parsed.id <= 0) {
      throw new TypeError("CDP response id must be a positive safe integer");
    }
    const hasResult = hasOwn("result");
    const hasError = hasOwn("error");
    if (hasResult === hasError) {
      throw new TypeError("CDP response must contain exactly one of result or error");
    }
    const payload = hasResult ? parsed.result : parsed.error;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError(`CDP response ${hasResult ? "result" : "error"} must be an object`);
    }
    return Object.freeze({
      kind: "response",
      id: parsed.id,
      sessionId,
      ...(hasResult ? { result: payload } : { error: payload }),
    });
  }
  if (typeof parsed.method !== "string" || !parsed.method.trim()) {
    throw new TypeError("CDP event method must be a non-empty string");
  }
  const params = hasOwn("params") ? parsed.params : {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("CDP event params must be an object");
  }
  return Object.freeze({
    kind: "event",
    method: parsed.method,
    params,
    sessionId,
  });
}

export function assertControlledCdpResponseSession(message, expectedSessionId = null) {
  if (message?.kind !== "response") throw new TypeError("CDP response session check requires a response");
  if (expectedSessionId !== null
    && (typeof expectedSessionId !== "string" || !expectedSessionId.trim())) {
    throw new TypeError("expected CDP sessionId must be null or a non-empty string");
  }
  if (message.sessionId !== expectedSessionId) {
    throw new Error(`CDP response session mismatch: expected ${
      expectedSessionId ?? "<top>"
    }, received ${message.sessionId ?? "<top>"}`);
  }
  return true;
}

export function isControlledDetachedSessionCommandError(message, expectedSessionId = null) {
  return message?.kind === "response"
    && typeof expectedSessionId === "string"
    && expectedSessionId.trim().length > 0
    && message.sessionId === null
    && message.error?.code === -32001
    && message.error?.message === "Session with given id not found.";
}

export function createControlledCdpHandlerTracker(diagnostics) {
  if (!diagnostics
    || typeof diagnostics.recordEvent !== "function"
    || typeof diagnostics.recordHandlerError !== "function") {
    throw new TypeError("CDP handler tracker requires controlled diagnostics");
  }
  const handlers = new Map();
  const pending = new Set();
  const failures = [];
  const settlements = [];
  let asyncScheduledCount = 0;
  let asyncCompletedCount = 0;
  let handlerSequence = 0;
  const recordFailure = (method, message, sequence, error) => {
    diagnostics.recordHandlerError(method, error);
    failures.push(Object.freeze({
      at: isoNow(),
      event: method,
      handlerSequence: sequence,
      sessionId: message?.sessionId ?? null,
      error: error instanceof Error ? error.message : String(error),
    }));
  };
  const snapshot = () => Object.freeze({
    passed: pending.size === 0 && failures.length === 0,
    pendingCount: pending.size,
    asyncScheduledCount,
    asyncCompletedCount,
    failureCount: failures.length,
    failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    settlements: Object.freeze(settlements.map((receipt) => Object.freeze({ ...receipt }))),
  });
  const settleHandlers = async (timeoutMs = 2_000) => {
    const parsedTimeoutMs = positiveInteger(timeoutMs, "handler settlement timeoutMs", 1, 60_000);
    const startedAt = isoNow();
    const deadline = Date.now() + parsedTimeoutMs;
    const scheduledAtStart = asyncScheduledCount;
    const completedAtStart = asyncCompletedCount;
    let timedOut = false;
    while (pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const outcome = await waitWithCancelableTimeout(
        Promise.allSettled([...pending]),
        Math.min(remaining, 250),
      );
      if (outcome.timedOut && Date.now() >= deadline) timedOut = true;
    }
    const receipt = Object.freeze({
      kind: "controlled-cdp-handler-settlement",
      startedAt,
      completedAt: isoNow(),
      completed: !timedOut && pending.size === 0,
      passed: !timedOut && pending.size === 0 && failures.length === 0,
      timedOut,
      timeoutMs: parsedTimeoutMs,
      pendingCount: pending.size,
      scheduledAtStart,
      scheduledAtEnd: asyncScheduledCount,
      completedAtStart,
      completedAtEnd: asyncCompletedCount,
      failureCount: failures.length,
      failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    });
    settlements.push(receipt);
    return receipt;
  };
  return Object.freeze({
    on(method, handler) {
      if (typeof method !== "string" || !method) throw new TypeError("CDP event method is required");
      if (typeof handler !== "function") throw new TypeError("CDP event handler must be a function");
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    dispatch(method, params = {}, message = {}) {
      diagnostics.recordEvent(method, params, { sessionId: message?.sessionId ?? null });
      for (const handler of handlers.get(method) || []) {
        const sequence = ++handlerSequence;
        let returned;
        try {
          returned = handler(params, message);
        } catch (error) {
          recordFailure(method, message, sequence, error);
          continue;
        }
        if (!returned || typeof returned.then !== "function") continue;
        asyncScheduledCount += 1;
        let task;
        task = Promise.resolve(returned)
          .catch((error) => recordFailure(method, message, sequence, error))
          .finally(() => {
            asyncCompletedCount += 1;
            pending.delete(task);
          });
        pending.add(task);
      }
    },
    settleHandlers,
    snapshot,
  });
}

function connectOwnedCdp(webSocketUrl, debugPort, timeoutMs, diagnostics) {
  assertOwnedWebSocketUrl(webSocketUrl, debugPort);
  if (!CONTROLLED_WEBSOCKET_CONSTRUCTOR) {
    throw new Error("This Node.js runtime does not expose the captured WebSocket implementation");
  }
  return new Promise((resolve, reject) => {
    const socket = new CONTROLLED_WEBSOCKET_CONSTRUCTOR(webSocketUrl);
    const connectionTimer = setTimeout(() => {
      try { socket.close(); } catch {
        // The connection timeout is already the authoritative failure.
      }
      reject(new Error("Timed out connecting to owned Chrome CDP"));
    }, Math.min(timeoutMs, 10_000));
    socket.addEventListener("error", (event) => {
      clearTimeout(connectionTimer);
      reject(new Error(`Owned Chrome CDP websocket error: ${event?.message || "unknown"}`));
    }, { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(connectionTimer);
      let nextId = 1;
      let closedError = null;
      let closeEventReceipt = null;
      let terminalCauseReceipt = null;
      let resolveClosed;
      const closedPromise = new Promise((closedResolve) => { resolveClosed = closedResolve; });
      const pending = new Map();
      const detachedSessionIds = new Set();
      const handlerTracker = createControlledCdpHandlerTracker(diagnostics);
      const terminalTransportError = (cause) => {
        const error = new Error(controlledCdpTerminalCauseErrorMessage(cause));
        Object.defineProperty(error, "controlledCdpTerminalCause", {
          configurable: false,
          enumerable: false,
          value: cause,
          writable: false,
        });
        return error;
      };
      const rejectPending = (error, cause = null) => {
        terminalCauseReceipt ??= cause;
        closedError ??= error;
        for (const deferred of pending.values()) {
          clearTimeout(deferred.timer);
          deferred.reject(error);
        }
        pending.clear();
      };
      socket.addEventListener("message", (event) => {
        let message;
        try { message = parseControlledCdpMessage(event.data); } catch (error) {
          diagnostics.recordProtocolError(error);
          return;
        }
        if (message.kind === "response") {
          if (!pending.has(message.id)) {
            diagnostics.recordProtocolError(new Error(`Unexpected CDP response id ${message.id}`));
            return;
          }
          const deferred = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(deferred.timer);
          const detachedSessionCommandError = detachedSessionIds.has(deferred.sessionId)
            && isControlledDetachedSessionCommandError(message, deferred.sessionId);
          try {
            if (!detachedSessionCommandError) {
              assertControlledCdpResponseSession(message, deferred.sessionId);
            }
          } catch (cause) {
            const error = new Error(
              `CDP response session mismatch for ${deferred.method}: ${cause instanceof Error ? cause.message : cause}`,
            );
            diagnostics.recordProtocolError(error);
            deferred.reject(error);
            return;
          }
          if (message.error) {
            const error = new Error(message.error.message || JSON.stringify(message.error));
            if (detachedSessionCommandError) {
              Object.defineProperty(error, "controlledCdpDetachedSession", {
                configurable: false,
                enumerable: false,
                value: true,
                writable: false,
              });
            }
            if (deferred.recordErrors) diagnostics.recordCommandError(deferred.method, error);
            deferred.reject(error);
          } else deferred.resolve(message);
          return;
        }
        if (message.method === "Target.detachedFromTarget"
          && typeof message.params?.sessionId === "string"
          && message.params.sessionId.trim()) {
          detachedSessionIds.add(message.params.sessionId);
        }
        handlerTracker.dispatch(message.method, message.params, message);
      });
      socket.addEventListener("close", (event) => {
        closeEventReceipt = Object.freeze({
          kind: "cdp-close",
          observedAt: isoNow(),
          code: event.code,
          reason: event.reason || null,
          wasClean: event.wasClean === true,
        });
        rejectPending(terminalTransportError(closeEventReceipt), closeEventReceipt);
        resolveClosed(closeEventReceipt);
      });
      socket.addEventListener("error", (event) => {
        const errorReceipt = Object.freeze({
          kind: "cdp-error",
          observedAt: isoNow(),
          message: event?.message || "unknown",
        });
        rejectPending(terminalTransportError(errorReceipt), errorReceipt);
      });
      const waitForClose = async (waitTimeoutMs = 2_000) => {
        if (closeEventReceipt) {
          return Object.freeze({
            closed: true,
            timedOut: false,
            event: closeEventReceipt,
            terminalCause: terminalCauseReceipt,
          });
        }
        const outcome = await waitWithCancelableTimeout(closedPromise, waitTimeoutMs);
        const event = outcome.timedOut ? null : outcome.value;
        return Object.freeze({
          closed: event !== null,
          timedOut: event === null,
          event,
          terminalCause: terminalCauseReceipt,
        });
      };
      resolve({
        send(method, params = {}, sessionId = null, recordErrors = true, onDispatched = null) {
          if (closedError) return Promise.reject(closedError);
          if (socket.readyState !== CONTROLLED_WEBSOCKET_CONSTRUCTOR.OPEN) {
            return Promise.reject(new Error(`Owned Chrome CDP is not open for ${method}`));
          }
          const id = nextId++;
          return new Promise((sendResolve, sendReject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              const error = new Error(`Timed out waiting for CDP command ${method}`);
              if (recordErrors) diagnostics.recordCommandError(method, error);
              sendReject(error);
            }, timeoutMs);
            pending.set(id, {
              resolve: sendResolve,
              reject: sendReject,
              timer,
              method,
              recordErrors,
              sessionId,
            });
            try {
              socket.send(JSON.stringify(createControlledCdpCommandEnvelope(
                id,
                method,
                params,
                sessionId,
              )));
              if (typeof onDispatched === "function") onDispatched(Object.freeze({
                id,
                method,
                sessionId,
                dispatchedAt: isoNow(),
              }));
            } catch (error) {
              pending.delete(id);
              clearTimeout(timer);
              if (recordErrors) diagnostics.recordCommandError(method, error);
              sendReject(error);
            }
          });
        },
        on: handlerTracker.on,
        settleHandlers: handlerTracker.settleHandlers,
        handlerSnapshot: handlerTracker.snapshot,
        waitForClose,
        async close(closeTimeoutMs = 2_000) {
          const requestedAt = isoNow();
          const beforeClose = await handlerTracker.settleHandlers(closeTimeoutMs);
          if (socket.readyState === CONTROLLED_WEBSOCKET_CONSTRUCTOR.OPEN
            || socket.readyState === CONTROLLED_WEBSOCKET_CONSTRUCTOR.CONNECTING) {
            try { socket.close(); } catch (error) {
              diagnostics.recordProtocolError(error);
            }
          }
          const closure = await waitForClose(closeTimeoutMs);
          const afterClose = await handlerTracker.settleHandlers(closeTimeoutMs);
          return Object.freeze({
            requestedAt,
            ...closure,
            handlerSettlementBeforeClose: beforeClose,
            handlerSettlementAfterClose: afterClose,
            handlerSnapshot: handlerTracker.snapshot(),
          });
        },
      });
    }, { once: true });
  });
}

function diagnosticRecord(method, params, atMs) {
  return Object.freeze({ method, atMs, ...stableObject(params || {}) });
}

export function createControlledDiagnosticsAggregator({ now = Date.now } = {}) {
  if (typeof now !== "function") throw new TypeError("diagnostics now must be a function");
  const state = {
    consoleErrors: [],
    runtimeExceptions: [],
    unhandledRejections: [],
    windowErrors: [],
    networkFailures: [],
    crashes: [],
    commandErrors: [],
    protocolErrors: [],
    handlerErrors: [],
  };
  const at = () => Number(now());
  const aggregator = {
    recordEvent(method, params = {}, metadata = {}) {
      const atMs = at();
      const context = { sessionId: metadata.sessionId ?? null };
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        state.consoleErrors.push(diagnosticRecord(method, {
          ...context,
          type: params.type,
          values: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
        }, atMs));
      } else if (method === "Runtime.exceptionThrown") {
        state.runtimeExceptions.push(diagnosticRecord(method, {
          ...context,
          text: params.exceptionDetails?.text ?? null,
          exception: params.exceptionDetails?.exception?.description ?? null,
        }, atMs));
      } else if (method === "Network.loadingFailed"
        && params.canceled !== true
        && params.errorText !== "net::ERR_ABORTED") {
        state.networkFailures.push(diagnosticRecord(method, {
          ...context,
          type: params.type ?? null,
          errorText: params.errorText ?? null,
          blockedReason: params.blockedReason ?? null,
        }, atMs));
      } else if (method === "Inspector.targetCrashed" || method === "Target.targetCrashed") {
        state.crashes.push(diagnosticRecord(method, { ...context, ...params }, atMs));
      } else if (method === "Runtime.bindingCalled" && params.name === DIAGNOSTIC_BINDING) {
        let payload = null;
        try { payload = JSON.parse(params.payload); } catch {
          state.protocolErrors.push(diagnosticRecord(method, {
            message: "diagnostic-binding-payload-invalid",
          }, atMs));
          return;
        }
        const record = diagnosticRecord(method, { ...context, ...payload }, atMs);
        if (payload?.kind === "unhandledrejection") state.unhandledRejections.push(record);
        else if (payload?.kind === "error") state.windowErrors.push(record);
      }
    },
    recordCommandError(method, error) {
      state.commandErrors.push(diagnosticRecord("cdp-command", {
        command: method,
        message: error instanceof Error ? error.message : String(error),
      }, at()));
    },
    recordProtocolError(error) {
      state.protocolErrors.push(diagnosticRecord("cdp-protocol", {
        message: error instanceof Error ? error.message : String(error),
      }, at()));
    },
    recordHandlerError(method, error) {
      state.handlerErrors.push(diagnosticRecord("cdp-handler", {
        event: method,
        message: error instanceof Error ? error.message : String(error),
      }, at()));
    },
    recordBrowserProcessCrash(receipt) {
      state.crashes.push(diagnosticRecord("browser-process-exit", receipt, at()));
    },
    snapshot() {
      const clone = (records) => Object.freeze(records.map((record) => Object.freeze({ ...record })));
      const consoleErrors = clone(state.consoleErrors);
      return Object.freeze({
        crashCount: state.crashes.length,
        crashes: clone(state.crashes),
        consoleErrors,
        unexpectedConsoleErrors: consoleErrors,
        runtimeExceptions: clone(state.runtimeExceptions),
        unhandledRejections: clone(state.unhandledRejections),
        windowErrors: clone(state.windowErrors),
        networkFailures: clone(state.networkFailures),
        commandErrors: clone(state.commandErrors),
        protocolErrors: clone(state.protocolErrors),
        handlerErrors: clone(state.handlerErrors),
      });
    },
  };
  return Object.freeze(aggregator);
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = response.result?.result;
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description
      || response.result.exceptionDetails.text
      || "Runtime.evaluate exception");
  }
  if (result?.subtype === "error") throw new Error(result.description || "Runtime.evaluate failed");
  return result?.value;
}

async function evaluateJson(cdp, expression) {
  const value = await evaluate(cdp, `(async () => JSON.stringify(await (${expression})))()`);
  return typeof value === "string" ? JSON.parse(value) : null;
}

async function waitForDocumentReady(cdp, expectedOrigin, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      latest = await evaluateJson(cdp, `({
        readyState: document.readyState,
        location: location.href
      })`);
      if (latest?.readyState === "complete"
        && new URL(latest.location).origin === expectedOrigin) return latest;
    } catch {
      // Navigation can replace the execution context between readiness polls.
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for controlled production document: ${JSON.stringify(latest)}`);
}

export function assessControlledBrowserWindow(evidence) {
  const violations = [];
  if (evidence?.headed !== true) violations.push("headed-browser-not-proven");
  if (evidence?.windowState !== "normal") violations.push("browser-window-not-normal");
  if (evidence?.visibilityState !== "visible") violations.push("document-not-visible");
  if (evidence?.hidden !== false) violations.push("document-hidden-state-invalid");
  if (evidence?.hasFocus !== true) violations.push("browser-window-not-focused");
  if (!Number.isFinite(Number(evidence?.devicePixelRatio)) || Number(evidence.devicePixelRatio) <= 0) {
    violations.push("device-pixel-ratio-invalid");
  }
  if (/headless/i.test(String(evidence?.browserProduct || ""))
    || /headless/i.test(String(evidence?.userAgent || ""))) {
    violations.push("headless-browser-identity-observed");
  }
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

function assertControlledBrowserWindow(evidence) {
  const assessment = assessControlledBrowserWindow(evidence);
  if (!assessment.valid) {
    throw new Error(`Controlled Chrome must be headed, normal, and visible: ${JSON.stringify({
      evidence,
      violations: assessment.violations,
    })}`);
  }
  return evidence;
}

async function verifyControlledBrowserWindow(cdp, windowId, browserVersion) {
  if (!Number.isSafeInteger(windowId)) throw new Error("Owned headed Chrome window is unavailable");
  const before = await cdp.send("Browser.getWindowBounds", { windowId });
  if (before.result?.bounds?.windowState !== "normal") {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  }
  await cdp.send("Page.bringToFront");
  await wait(100);
  const documentState = await evaluateJson(cdp, `({
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  })`);
  const after = await cdp.send("Browser.getWindowBounds", { windowId });
  return assertControlledBrowserWindow(Object.freeze({
    headed: true,
    windowState: after.result?.bounds?.windowState ?? null,
    visibilityState: documentState?.visibilityState ?? null,
    hidden: documentState?.hidden ?? null,
    hasFocus: documentState?.hasFocus ?? null,
    devicePixelRatio: Number(documentState?.devicePixelRatio),
    innerWidth: Number(documentState?.innerWidth),
    innerHeight: Number(documentState?.innerHeight),
    browserProduct: browserVersion?.product ?? null,
    userAgent: browserVersion?.userAgent ?? null,
  }));
}

async function setControlledDeviceMetrics(cdp, windowId, browserVersion, viewport, dpr) {
  const normalizedViewport = normalizeViewport(viewport);
  const normalizedDpr = positiveNumber(dpr, "dpr", 0.5, 4);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: normalizedViewport.width,
    height: normalizedViewport.height,
    deviceScaleFactor: normalizedDpr,
    mobile: false,
    screenWidth: normalizedViewport.width,
    screenHeight: normalizedViewport.height,
  });
  const evidence = await verifyControlledBrowserWindow(cdp, windowId, browserVersion);
  if (evidence.innerWidth !== normalizedViewport.width
    || evidence.innerHeight !== normalizedViewport.height
    || Math.abs(evidence.devicePixelRatio - normalizedDpr) > 0.001) {
    throw new Error(`Controlled device metrics did not take effect: ${JSON.stringify({
      requested: { viewport: normalizedViewport, dpr: normalizedDpr },
      evidence,
    })}`);
  }
  return evidence;
}

export function extractHtmlAssetPaths(html) {
  const paths = new Set();
  const pattern = /<(script|link)\b([^>]*)>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    const attributes = match[2];
    const sourceMatch = attributes.match(tag === "script"
      ? /\bsrc=["']([^"']+)["']/i
      : /\bhref=["']([^"']+)["']/i);
    if (!sourceMatch) continue;
    if (tag === "link") {
      const rel = attributes.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase().split(/\s+/) ?? [];
      if (!rel.some((value) => ["modulepreload", "preload", "stylesheet"].includes(value))) continue;
      if (rel.includes("preload")) {
        const preloadAs = attributes.match(/\bas=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? null;
        if (!["script", "style"].includes(preloadAs)) continue;
      }
    }
    const raw = sourceMatch[1];
    if (!raw || /^(?:data:|https?:|\/\/)/i.test(raw)) {
      if (!raw?.startsWith("/")) continue;
    }
    try {
      const parsed = new URL(raw, "http://controlled.invalid/");
      if (parsed.origin !== "http://controlled.invalid") continue;
      const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
      if (relative) paths.add(relative);
    } catch {
      // Ignore malformed markup URLs; they cannot prove a loaded build asset.
    }
  }
  return Object.freeze([...paths].sort());
}

function fingerprintLoadedAssetPaths(paths) {
  const normalized = [...new Set(paths.map((item) => normalizeFingerprintPath(item)))].sort();
  return Object.freeze({
    count: normalized.length,
    paths: Object.freeze(normalized),
    sha256: sha256(normalized.join("\0")),
  });
}

export function controlledManagedUrlAllowed(url, managedOrigin) {
  try {
    const parsed = new URL(url);
    const managed = new URL(managedOrigin);
    if (["data:", "about:"].includes(parsed.protocol)) return true;
    if (parsed.protocol === "blob:") return String(url).startsWith(`blob:${managedOrigin}/`);
    if (["http:", "https:"].includes(parsed.protocol)) return parsed.origin === managed.origin;
    if (["ws:", "wss:"].includes(parsed.protocol)) {
      const expectedSocketProtocol = managed.protocol === "https:" ? "wss:" : "ws:";
      const effectivePort = (value) => value.port || ({
        "http:": "80",
        "https:": "443",
        "ws:": "80",
        "wss:": "443",
      })[value.protocol];
      return parsed.protocol === expectedSocketProtocol
        && parsed.hostname === managed.hostname
        && effectivePort(parsed) === effectivePort(managed);
    }
    return false;
  } catch {
    return false;
  }
}

export function controlledManagedDocumentUrlAllowed(url, managedUrl) {
  try {
    const candidate = new URL(url);
    const expected = new URL(managedUrl);
    return candidate.origin === expected.origin
      && candidate.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export async function createManagedOriginGuard(cdp, managedUrl, drawingWorkerPaths = []) {
  const managedOrigin = new URL(managedUrl).origin;
  if (!Array.isArray(drawingWorkerPaths)
    || drawingWorkerPaths.some((relativePath) => (
      typeof relativePath !== "string"
      || !/^assets\/drawing\.worker(?:-[^/]+)?\.js$/.test(relativePath)
    ))) {
    throw new TypeError("managed-origin guard drawing worker paths are invalid");
  }
  const workerPathSet = new Set(drawingWorkerPaths);
  const violations = [];
  const armedWorkerResponses = new Map();
  const workerResponseCaptures = new Map();
  const record = (kind, url, details = {}) => {
    violations.push(Object.freeze({ kind, url, at: isoNow(), ...stableObject(details) }));
  };
  const relativeManagedPath = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== managedOrigin) return null;
      return decodeURIComponent(parsed.pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      return null;
    }
  };
  const captureKey = (networkId, url) => `${networkId}\0${url}`;
  const removePaused = cdp.on("Fetch.requestPaused", async (params, message) => {
    const url = params?.request?.url || "";
    const sessionId = message?.sessionId ?? null;
    const responseStage = Object.prototype.hasOwnProperty.call(params || {}, "responseStatusCode")
      || Object.prototype.hasOwnProperty.call(params || {}, "responseErrorReason");
    if (!controlledManagedUrlAllowed(url, managedOrigin)) {
      record("off-origin-request-blocked", url, {
        resourceType: params?.resourceType ?? null,
        responseStage,
        sessionId,
      });
      await cdp.send("Fetch.failRequest", {
        requestId: params.requestId,
        errorReason: "BlockedByClient",
      }, sessionId);
      return;
    }
    if (!responseStage) {
      const relativePath = relativeManagedPath(url);
      const isDrawingWorker = workerPathSet.has(relativePath);
      if (!isDrawingWorker) {
        await cdp.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
        return;
      }
      const networkId = params?.networkId;
      const armed = typeof params?.requestId === "string"
        && params.requestId.length > 0
        && typeof networkId === "string"
        && networkId.length > 0
        && params?.resourceType === CONTROLLED_DRAWING_WORKER_FETCH_RESOURCE_TYPE
        && sessionId === null
        && !armedWorkerResponses.has(params.requestId);
      if (!armed) {
        record("drawing-worker-response-capture-arm-invalid", url, {
          fetchRequestId: params?.requestId ?? null,
          networkId: networkId ?? null,
          resourceType: params?.resourceType ?? null,
          sessionId,
        });
        await cdp.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
        return;
      }
      armedWorkerResponses.set(params.requestId, Object.freeze({
        fetchRequestId: params.requestId,
        networkId,
        relativePath,
        resourceType: params.resourceType,
        sessionId,
        url,
        armedAt: isoNow(),
      }));
      await cdp.send("Fetch.continueRequest", {
        requestId: params.requestId,
        interceptResponse: true,
      }, sessionId);
      return;
    }

    const armed = armedWorkerResponses.get(params?.requestId) ?? null;
    let captureError = null;
    try {
      const accepted = armed !== null
        && sessionId === null
        && params?.networkId === armed.networkId
        && url === armed.url
        && params?.resourceType === armed.resourceType
        && params?.responseErrorReason === undefined
        && Number.isInteger(params?.responseStatusCode)
        && params.responseStatusCode >= 200
        && params.responseStatusCode < 300;
      if (!accepted) {
        throw new Error("drawing worker response-stage identity is invalid");
      }
      const response = await cdp.send("Fetch.getResponseBody", {
        requestId: params.requestId,
      }, sessionId, false);
      const body = response?.result?.body;
      const base64Encoded = response?.result?.base64Encoded;
      if (typeof body !== "string" || typeof base64Encoded !== "boolean") {
        throw new Error("drawing worker response body receipt is invalid");
      }
      const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
      const key = captureKey(armed.networkId, armed.url);
      if (workerResponseCaptures.has(key)) {
        throw new Error("drawing worker response body capture is duplicated");
      }
      workerResponseCaptures.set(key, {
        kind: "controlled-fetch-response-body-capture",
        fetchRequestId: armed.fetchRequestId,
        networkId: armed.networkId,
        relativePath: armed.relativePath,
        resourceType: armed.resourceType,
        sessionId: armed.sessionId,
        url: armed.url,
        responseStatusCode: params.responseStatusCode,
        bodyBytes: bytes.byteLength,
        bodySha256: sha256(bytes),
        capturedAt: isoNow(),
        claimedAt: null,
        claimCount: 0,
      });
    } catch (error) {
      captureError = error;
      record("drawing-worker-response-body-capture-failed", url, {
        error: error instanceof Error ? error.message : String(error),
        fetchRequestId: params?.requestId ?? null,
        networkId: params?.networkId ?? null,
        responseErrorReason: params?.responseErrorReason ?? null,
        responseStatusCode: params?.responseStatusCode ?? null,
        resourceType: params?.resourceType ?? null,
        sessionId,
      });
    } finally {
      armedWorkerResponses.delete(params?.requestId);
      try {
        await cdp.send("Fetch.continueResponse", { requestId: params.requestId }, sessionId);
      } catch (error) {
        record("drawing-worker-response-continue-failed", url, {
          error: error instanceof Error ? error.message : String(error),
          fetchRequestId: params?.requestId ?? null,
          sessionId,
        });
        if (captureError === null) captureError = error;
      }
    }
    if (captureError !== null) return;
  });
  const removeFrame = cdp.on("Page.frameNavigated", (params) => {
    if (params?.frame?.parentId) return;
    const url = params?.frame?.url || "";
    if (!controlledManagedDocumentUrlAllowed(url, managedUrl)) {
      record("unmanaged-main-frame", url);
    }
  });
  const removeWebSocket = cdp.on("Network.webSocketCreated", (params) => {
    if (!controlledManagedUrlAllowed(params?.url || "", managedOrigin)) {
      record("off-origin-websocket", params?.url || "");
    }
  });
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "http://*/*", requestStage: "Request" },
      { urlPattern: "https://*/*", requestStage: "Request" },
    ],
  });
  return Object.freeze({
    claimWorkerResponseBodyCapture(networkId, url) {
      if (typeof networkId !== "string" || !networkId
        || typeof url !== "string" || !url) return null;
      const capture = workerResponseCaptures.get(captureKey(networkId, url)) ?? null;
      if (!capture || capture.claimCount !== 0) return null;
      capture.claimCount = 1;
      capture.claimedAt = isoNow();
      return Object.freeze({ ...capture });
    },
    assertHealthy() {
      if (violations.length > 0 || armedWorkerResponses.size > 0) {
        throw new Error(`Managed-origin guard observed forbidden traffic: ${JSON.stringify(violations)}`);
      }
    },
    snapshot() {
      return Object.freeze({
        managedOrigin,
        managedDocumentPath: new URL(managedUrl).pathname,
        passed: violations.length === 0 && armedWorkerResponses.size === 0,
        armedWorkerResponseCount: armedWorkerResponses.size,
        workerResponseCaptures: Object.freeze(
          [...workerResponseCaptures.values()].map((capture) => Object.freeze({ ...capture })),
        ),
        violations: Object.freeze(violations.map((violation) => Object.freeze({ ...violation }))),
      });
    },
    dispose() {
      removePaused();
      removeFrame();
      removeWebSocket();
    },
  });
}

export function createControlledNetworkAssetTracker(
  cdp,
  managedOrigin,
  buildReceipt,
  timeoutMs,
  mainFrameId,
  rollbackAuthority = null,
  claimWorkerResponseBodyCapture = null,
) {
  if (typeof mainFrameId !== "string" || !mainFrameId) {
    throw new Error("controlled asset tracker requires the owned main frame id");
  }
  if (claimWorkerResponseBodyCapture !== null
    && typeof claimWorkerResponseBodyCapture !== "function") {
    throw new TypeError("controlled asset tracker worker response capture must be callable");
  }
  const entryPaths = Object.freeze(["index.html", ...buildReceipt.entryAssetPaths]);
  const manifest = new Map(buildReceipt.assetFingerprint.files.map((file) => [file.path, file]));
  const drawingWorkerPaths = Object.freeze([...manifest.keys()].filter((relativePath) => (
    /^assets\/drawing\.worker(?:-[^/]+)?\.js$/.test(relativePath)
  )));
  const requests = new Map();
  const responses = new Map();
  const targetSessions = new Map();
  const inFlight = new Map();
  const pending = new Set();
  const duplicateResponseKeys = [];
  const unmanifestedResponses = [];
  const provenanceErrors = [];
  const workerConstructions = [];
  const workerConstructionFaults = [];
  const workerTargetConstructionBindings = new Map();
  const claimedWorkerConstructions = new Set();
  const workerBootstrapHandoffs = new Map();
  const workerBootstrapSourceClaims = new Map();
  const duplicateRequestKeys = new Set();
  const terminalRequestKeys = new Set();
  const responseEventKeys = new Set();
  const workerBootstrapObservationWindow = 20;
  let currentLoaderId = null;
  let currentDocumentPath = null;
  let currentDocumentUrl = null;
  let currentGeneration = 0;
  const loaderGenerations = new Map();
  let observationSequence = 0;
  const observe = () => {
    observationSequence += 1;
    return observationSequence;
  };
  const dataApiTypes = new Set(["EventSource", "Fetch", "Preflight", "XHR"]);
  const assetPath = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (parsed.origin !== managedOrigin) return null;
      const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
      return relative || "index.html";
    } catch { return null; }
  };
  const requestKey = (sessionId, requestId) => `${sessionId || "<top>"}\0${requestId}`;
  const isDataApiRequest = (relativePath, type) => (
    relativePath?.startsWith("api/") && dataApiTypes.has(type)
  );
  const recordProvenanceError = (kind, details = {}) => {
    provenanceErrors.push(Object.freeze({
      kind,
      at: isoNow(),
      generation: currentGeneration,
      observedGeneration: currentGeneration,
      ...stableObject(details),
    }));
    observe();
  };
  const reconcileWorkerConstructionBinding = (generation, url) => {
    if (typeof generation !== "number" || typeof url !== "string" || !url) return;
    const relativePath = assetPath(url);
    if (!drawingWorkerPaths.includes(relativePath)) return;
    const targets = [...targetSessions.values()].filter((target) => (
      target.generation === generation
      && target.type === "worker"
      && target.url === url
      && target.detachedAt === null
      && !workerTargetConstructionBindings.has(target.sessionId)
    ));
    const constructions = workerConstructions.filter((construction) => (
      construction.generation === generation
      && construction.url === url
      && !claimedWorkerConstructions.has(construction)
    ));
    if (targets.length !== 1 || constructions.length !== 1) return;
    workerTargetConstructionBindings.set(targets[0].sessionId, constructions[0]);
    claimedWorkerConstructions.add(constructions[0]);
  };
  const removeAttached = cdp.on("Target.attachedToTarget", (params) => {
    if (typeof params?.sessionId !== "string") return;
    const attachedObservationSequence = observe();
    const target = {
      sessionId: params.sessionId,
      generation: currentGeneration,
      targetId: params.targetInfo?.targetId ?? null,
      type: params.targetInfo?.type ?? null,
      title: params.targetInfo?.title ?? null,
      url: params.targetInfo?.url ?? null,
      attachedAt: isoNow(),
      attachedObservationSequence,
      detachedAt: null,
    };
    targetSessions.set(params.sessionId, target);
    reconcileWorkerConstructionBinding(target.generation, target.url);
  });
  const removeDetached = cdp.on("Target.detachedFromTarget", (params) => {
    const target = targetSessions.get(params?.sessionId);
    if (target) target.detachedAt = isoNow();
    if (target) observe();
  });
  const removeWorkerConstruction = cdp.on("Runtime.bindingCalled", (params, message) => {
    if (message?.sessionId || params?.name !== DIAGNOSTIC_BINDING) return;
    let payload;
    try { payload = JSON.parse(params?.payload || ""); } catch { return; }
    if (payload?.kind === "worker-constructor-fault") {
      const relativePath = assetPath(payload?.url || "");
      const accepted = rollbackAuthority !== null
        && payload?.runId === rollbackAuthority.runId
        && payload?.authorityTokenSha256 === rollbackAuthority.authorityTokenSha256
        && payload?.drillId === "worker-init-failure"
        && typeof payload?.faultId === "string"
        && /^[a-f0-9-]{36}$/.test(payload.faultId)
        && Number.isSafeInteger(payload?.sequence)
        && payload.sequence > 0
        && payload?.workerType === "module"
        && payload?.workerName === "candlescope-drawing-worker"
        && drawingWorkerPaths.includes(relativePath);
      if (!accepted) {
        recordProvenanceError("worker-constructor-fault-untrusted", {
          drillId: payload?.drillId ?? null,
          url: payload?.url ?? null,
        });
        return;
      }
      const duplicate = workerConstructionFaults.some((fault) => (
        fault.generation === currentGeneration
      ));
      if (duplicate) {
        recordProvenanceError("worker-constructor-fault-duplicate", {
          drillId: payload.drillId,
          url: payload.url,
        });
        return;
      }
      workerConstructionFaults.push(Object.freeze({
        kind: "controlled-worker-construction-fault",
        generation: currentGeneration,
        runId: payload.runId,
        authorityTokenSha256: payload.authorityTokenSha256,
        drillId: payload.drillId,
        faultId: payload.faultId,
        sequence: payload.sequence,
        url: payload.url,
        path: relativePath,
        workerType: payload.workerType,
        workerName: payload.workerName,
        observedAt: isoNow(),
        observationSequence: observe(),
      }));
      return;
    }
    if (payload?.kind !== "worker-constructor" || typeof payload?.url !== "string") return;
    if (!controlledManagedUrlAllowed(payload.url, managedOrigin)) {
      recordProvenanceError("worker-constructor-off-origin", { url: payload.url });
      return;
    }
    const construction = Object.freeze({
      kind: "controlled-worker-construction",
      generation: currentGeneration,
      url: payload.url,
      workerType: payload.workerType ?? null,
      constructedAt: isoNow(),
      observationSequence: observe(),
    });
    workerConstructions.push(construction);
    reconcileWorkerConstructionBinding(construction.generation, construction.url);
  });
  const removeRequest = cdp.on("Network.requestWillBeSent", (params, message) => {
    const sessionId = message?.sessionId ?? null;
    const requestId = params?.requestId;
    const url = params?.request?.url || "";
    const relativePath = assetPath(url);
    if (!relativePath || typeof requestId !== "string" || !requestId) return;
    const type = params?.type ?? null;
    const initiatorType = params?.initiator?.type ?? null;
    const isMainDocument = sessionId === null
      && type === "Document"
      && params?.frameId === mainFrameId;
    if (isMainDocument) {
      currentGeneration += 1;
      currentLoaderId = params?.loaderId ?? null;
      currentDocumentPath = relativePath;
      currentDocumentUrl = url;
      if (currentLoaderId !== null) loaderGenerations.set(currentLoaderId, currentGeneration);
    }
    const target = sessionId === null ? null : targetSessions.get(sessionId) ?? null;
    const currentMainLoader = currentLoaderId !== null && params?.loaderId === currentLoaderId;
    const generation = sessionId === null
      ? (isMainDocument
        ? currentGeneration
        : (loaderGenerations.get(params?.loaderId) ?? (
          currentGeneration > 0 ? currentGeneration : null
        )))
      : (target?.generation ?? null);
    const mainFrameProvenance = sessionId === null && (
      isMainDocument
      || (params?.frameId === mainFrameId && currentMainLoader)
    );
    const key = requestKey(sessionId, requestId);
    if (requests.has(key)) {
      duplicateRequestKeys.add(key);
      recordProvenanceError("duplicate-request-key", {
        generation,
        key,
        requestId,
        sessionId,
        url,
      });
    }
    const record = {
      key,
      requestId,
      sessionId,
      generation,
      path: relativePath,
      url,
      type,
      initiatorType,
      frameId: params?.frameId ?? null,
      loaderId: params?.loaderId ?? null,
      documentUrl: params?.documentURL ?? null,
      mainFrameProvenance,
      targetId: target?.targetId ?? null,
      targetType: target?.type ?? null,
      targetUrl: target?.url ?? null,
      dataApiExempt: isDataApiRequest(relativePath, type),
      requestedAt: isoNow(),
      requestObservationSequence: observe(),
    };
    requests.set(key, record);
    inFlight.set(key, record);
  });
  const canonicalWorkerBootstrapSource = (sessionId, requestId) => {
    if (sessionId === null || typeof requestId !== "string" || !requestId) return null;
    const sourceKey = requestKey(null, requestId);
    const source = requests.get(sourceKey) ?? null;
    const target = targetSessions.get(sessionId) ?? null;
    const construction = target === null
      ? null
      : workerTargetConstructionBindings.get(target.sessionId) ?? null;
    if (!source || !target || !construction) return null;
    const matchingTargets = [...targetSessions.values()].filter((candidate) => (
      candidate.generation === currentGeneration
      && candidate.type === "worker"
      && candidate.targetId === requestId
      && candidate.url === target.url
      && candidate.detachedAt === null
    ));
    const matchingConstructions = workerConstructions.filter((candidate) => (
      candidate.generation === currentGeneration && candidate.url === target.url
    ));
    const bootstrapObservationSpan = Math.max(
      construction.observationSequence,
      source.requestObservationSequence,
      target.attachedObservationSequence,
    ) - Math.min(
      construction.observationSequence,
      source.requestObservationSequence,
      target.attachedObservationSequence,
    );
    const sourceDocumentUrlAccepted = controlledManagedUrlAllowed(
      source.documentUrl,
      managedOrigin,
    ) && [currentDocumentUrl, target.url].includes(source.documentUrl);
    if (duplicateRequestKeys.has(sourceKey)
      || source.generation !== currentGeneration
      || target.generation !== currentGeneration
      || source.url !== target.url
      || source.path !== assetPath(target.url)
      || !drawingWorkerPaths.includes(source.path)
      || source.type !== "Script"
      || source.initiatorType !== "other"
      || source.frameId !== mainFrameId
      || source.loaderId !== ""
      || !sourceDocumentUrlAccepted
      || source.mainFrameProvenance !== false
      || construction.generation !== currentGeneration
      || construction.url !== target.url
      || construction.workerType !== "module"
      || construction.observationSequence >= target.attachedObservationSequence
      || source.requestObservationSequence >= target.attachedObservationSequence
      || bootstrapObservationSpan > workerBootstrapObservationWindow
      || matchingTargets.length !== 1
      || matchingTargets[0].sessionId !== sessionId
      || matchingConstructions.length !== 1
      || matchingConstructions[0] !== construction) return null;
    return { construction, source, sourceKey, target };
  };
  const clearRequestAndCanonicalInFlight = (sessionId, requestId) => {
    const clearedKeys = [];
    const key = requestKey(sessionId, requestId);
    if (inFlight.delete(key)) clearedKeys.push(key);
    const canonical = canonicalWorkerBootstrapSource(sessionId, requestId);
    if (canonical && inFlight.delete(canonical.sourceKey)) {
      clearedKeys.push(canonical.sourceKey);
    }
    if (clearedKeys.length > 0) observe();
    return clearedKeys;
  };
  const resolveWorkerBootstrapHandoff = ({
    sessionId,
    requestId,
    responseUrl,
    relativePath,
    responseType,
  }) => {
    if (sessionId === null || typeof requestId !== "string" || !requestId) return null;
    const destinationKey = requestKey(sessionId, requestId);
    const sourceKey = requestKey(null, requestId);
    const source = requests.get(sourceKey) ?? null;
    const target = targetSessions.get(sessionId) ?? null;
    const targetPath = assetPath(target?.url || "");
    const construction = target === null
      ? null
      : workerTargetConstructionBindings.get(target.sessionId) ?? null;
    const exactIdentityTargets = [...targetSessions.values()].filter((candidate) => (
      candidate.generation === currentGeneration
      && candidate.type === "worker"
      && candidate.targetId === requestId
      && candidate.url === responseUrl
      && candidate.detachedAt === null
    ));
    const exactConstructions = workerConstructions.filter((candidate) => (
      candidate.generation === currentGeneration
      && candidate.url === responseUrl
    ));
    const constructionObservationSequence = construction?.observationSequence ?? null;
    const sourceRequestObservationSequence = source?.requestObservationSequence ?? null;
    const targetAttachedObservationSequence = target?.attachedObservationSequence ?? null;
    const bootstrapObservationSequences = [
      constructionObservationSequence,
      sourceRequestObservationSequence,
      targetAttachedObservationSequence,
    ];
    const bootstrapObservationSpan = bootstrapObservationSequences.every(Number.isInteger)
      ? Math.max(...bootstrapObservationSequences) - Math.min(...bootstrapObservationSequences)
      : null;
    const sourceDocumentUrlControlled = source
      ? controlledManagedUrlAllowed(source.documentUrl, managedOrigin)
      : false;
    const sourceDocumentUrlAccepted = sourceDocumentUrlControlled
      && [currentDocumentUrl, responseUrl].includes(source?.documentUrl);
    const reasons = [];
    if (currentGeneration <= 0) reasons.push("missing-main-document-generation");
    if (!source) reasons.push("missing-top-session-source-request");
    if (duplicateRequestKeys.has(sourceKey)) reasons.push("duplicate-source-request-key");
    if (source && source.generation !== currentGeneration) reasons.push("source-generation-mismatch");
    if (source && source.requestId !== requestId) reasons.push("source-request-id-mismatch");
    if (source && (source.url !== responseUrl || source.path !== relativePath)) {
      reasons.push("source-url-path-mismatch");
    }
    if (source && source.type !== "Script") {
      reasons.push("source-request-type-mismatch");
    }
    if (source && source.initiatorType !== "other") reasons.push("source-initiator-mismatch");
    if (source && source.frameId !== mainFrameId) reasons.push("source-main-frame-mismatch");
    if (source && source.loaderId !== "") reasons.push("source-loader-mismatch");
    if (source && !sourceDocumentUrlControlled) {
      reasons.push("source-document-url-not-controlled");
    } else if (source && !sourceDocumentUrlAccepted) {
      reasons.push("source-document-url-mismatch");
    }
    if (source && source.mainFrameProvenance !== false) {
      reasons.push("source-main-frame-provenance-mismatch");
    }
    if (source && !inFlight.has(sourceKey)) reasons.push("source-request-not-in-flight");
    if (responses.has(sourceKey)) reasons.push("source-response-already-observed");
    if (workerBootstrapSourceClaims.has(sourceKey)) reasons.push("source-request-already-claimed");
    if (workerBootstrapHandoffs.has(destinationKey)) reasons.push("destination-already-handed-off");
    if (terminalRequestKeys.has(destinationKey)) reasons.push("destination-already-terminal");
    if (!target) reasons.push("missing-worker-target-session");
    if (target && target.type !== "worker") reasons.push("target-type-mismatch");
    if (target && target.targetId !== requestId) reasons.push("target-request-id-mismatch");
    if (target && (target.url !== responseUrl || targetPath !== relativePath)) {
      reasons.push("target-url-path-mismatch");
    }
    if (target && target.generation !== currentGeneration) reasons.push("target-generation-mismatch");
    if (target && target.detachedAt !== null) reasons.push("target-already-detached");
    if (exactIdentityTargets.length !== 1 || exactIdentityTargets[0]?.sessionId !== sessionId) {
      reasons.push("target-identity-not-unique");
    }
    if (!drawingWorkerPaths.includes(relativePath)) reasons.push("response-not-drawing-worker-asset");
    if (responseType !== "Script") reasons.push("response-type-mismatch");
    if (!construction) reasons.push("missing-constructor-target-binding");
    if (construction && construction.workerType !== "module") {
      reasons.push("constructor-worker-type-mismatch");
    }
    if (construction && (
      construction.generation !== currentGeneration
      || construction.url !== responseUrl
      || assetPath(construction.url) !== relativePath
    )) reasons.push("constructor-url-path-generation-mismatch");
    if (exactConstructions.length !== 1 || exactConstructions[0] !== construction) {
      reasons.push("constructor-identity-not-unique");
    }
    if (target && construction
      && construction.observationSequence >= target.attachedObservationSequence) {
      reasons.push("constructor-not-before-target-attachment");
    }
    if (source && target
      && source.requestObservationSequence >= target.attachedObservationSequence) {
      reasons.push("source-request-not-before-target-attachment");
    }
    if (bootstrapObservationSpan !== null
      && bootstrapObservationSpan > workerBootstrapObservationWindow) {
      reasons.push("bootstrap-observation-window-exceeded");
    }
    if (reasons.length > 0) {
      const clearedKeys = clearRequestAndCanonicalInFlight(sessionId, requestId);
      if (source && inFlight.delete(sourceKey)) {
        clearedKeys.push(sourceKey);
        observe();
      }
      recordProvenanceError("worker-bootstrap-handoff-rejected", {
        actualContract: {
          construction: construction ? {
            generation: construction.generation,
            observationSequence: constructionObservationSequence,
            url: construction.url,
            workerType: construction.workerType,
          } : null,
          currentDocumentUrl,
          expectedObservationWindow: workerBootstrapObservationWindow,
          observationSpan: bootstrapObservationSpan,
          response: {
            path: relativePath,
            type: responseType,
            url: responseUrl,
          },
          source: source ? {
            documentUrl: source.documentUrl,
            frameId: source.frameId,
            generation: source.generation,
            initiatorType: source.initiatorType,
            loaderId: source.loaderId,
            mainFrameProvenance: source.mainFrameProvenance,
            observationSequence: sourceRequestObservationSequence,
            path: source.path,
            requestId: source.requestId,
            type: source.type,
            url: source.url,
          } : null,
          target: target ? {
            generation: target.generation,
            observationSequence: targetAttachedObservationSequence,
            sessionId: target.sessionId,
            targetId: target.targetId,
            type: target.type,
            url: target.url,
          } : null,
        },
        clearedKeys,
        destinationKey,
        requestId,
        responseType,
        responseUrl,
        relativePath,
        sessionId,
        sourceKey,
        targetId: target?.targetId ?? null,
        reasons,
      });
      return null;
    }
    const handoffObservationSequence = observe();
    const handoffRequest = {
      ...source,
      key: destinationKey,
      sessionId,
      mainFrameProvenance: false,
      targetId: target.targetId,
      targetType: target.type,
      targetUrl: target.url,
      workerBootstrapHandoff: true,
      workerBootstrapSourceKey: sourceKey,
      workerBootstrapHandoffObservationSequence: handoffObservationSequence,
    };
    const handoff = Object.freeze({
      kind: "controlled-worker-bootstrap-network-handoff",
      generation: currentGeneration,
      requestId,
      path: relativePath,
      url: responseUrl,
      sourceKey,
      sourceSessionId: null,
      destinationKey,
      destinationSessionId: sessionId,
      targetId: target.targetId,
      constructorObservationSequence: construction.observationSequence,
      sourceRequestObservationSequence: source.requestObservationSequence,
      targetAttachedObservationSequence: target.attachedObservationSequence,
      handoffObservationSequence,
      acceptedAt: isoNow(),
    });
    requests.set(destinationKey, handoffRequest);
    inFlight.delete(sourceKey);
    inFlight.set(destinationKey, handoffRequest);
    workerBootstrapSourceClaims.set(sourceKey, destinationKey);
    workerBootstrapHandoffs.set(destinationKey, handoff);
    return handoffRequest;
  };
  const removeResponse = cdp.on("Network.responseReceived", (params, message) => {
    const sessionId = message?.sessionId ?? null;
    const key = requestKey(sessionId, params?.requestId);
    const relativePath = assetPath(params?.response?.url || "");
    if (!relativePath) return;
    const responseType = params?.type ?? null;
    let request = requests.get(key) ?? null;
    const eventGeneration = request?.generation
      ?? responses.get(key)?.generation
      ?? targetSessions.get(sessionId)?.generation
      ?? currentGeneration;
    responseEventKeys.add(key);
    if (terminalRequestKeys.has(key)) {
      const clearedKeys = clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      if (request?.dataApiExempt === true) return;
      recordProvenanceError("response-after-network-terminal", {
        generation: eventGeneration,
        clearedKeys,
        key,
        requestId: params?.requestId ?? null,
        sessionId,
      });
      return;
    }
    if (!request) {
      request = resolveWorkerBootstrapHandoff({
        sessionId,
        requestId: params?.requestId,
        responseUrl: params?.response?.url ?? null,
        relativePath,
        responseType,
      });
    }
    const generation = request?.generation ?? null;
    if (!request) {
      recordProvenanceError("response-without-request", {
        generation: eventGeneration,
        requestId: params?.requestId ?? null,
        sessionId,
        path: relativePath,
        type: responseType,
      });
      return;
    } else if (request.path !== relativePath || request.url !== params?.response?.url) {
      clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      recordProvenanceError("response-request-mismatch", {
        generation: request.generation,
        requestId: params?.requestId ?? null,
        sessionId,
        requestPath: request.path,
        responsePath: relativePath,
        requestUrl: request.url,
        responseUrl: params?.response?.url ?? null,
      });
      return;
    }
    if (!manifest.has(relativePath)) {
      if (!isDataApiRequest(relativePath, responseType)) {
        unmanifestedResponses.push(Object.freeze({
          at: isoNow(),
          generation,
          sessionId,
          requestId: params?.requestId ?? null,
          path: relativePath,
          url: params?.response?.url ?? null,
          type: params?.type ?? null,
          status: Number(params?.response?.status),
        }));
        observe();
      }
      return;
    }
    const target = sessionId === null ? null : targetSessions.get(sessionId) ?? null;
    if (responses.has(key)) {
      duplicateResponseKeys.push(Object.freeze({
        key,
        at: isoNow(),
        generation,
        sessionId,
        requestId: params?.requestId ?? null,
      }));
      observe();
      return;
    }
    const expected = manifest.get(relativePath);
    responses.set(key, {
      key,
      requestId: params?.requestId ?? null,
      sessionId,
      requestType: request?.type ?? null,
      requestObservationSequence: request?.requestObservationSequence ?? null,
      responseType,
      initiatorType: request?.initiatorType ?? null,
      frameId: request?.frameId ?? params?.frameId ?? null,
      loaderId: request?.loaderId ?? params?.loaderId ?? null,
      mainFrameProvenance: request?.mainFrameProvenance === true,
      generation,
      path: relativePath,
      url: params.response.url,
      status: Number(params.response.status),
      mimeType: params.response.mimeType ?? null,
      protocol: params.response.protocol ?? null,
      fromDiskCache: params.response.fromDiskCache === true,
      targetId: target?.targetId ?? null,
      targetType: target?.type ?? null,
      targetUrl: target?.url ?? null,
      workerBootstrapHandoff: request?.workerBootstrapHandoff === true,
      workerBootstrapSourceKey: request?.workerBootstrapSourceKey ?? null,
      workerBootstrapHandoffObservationSequence:
        request?.workerBootstrapHandoffObservationSequence ?? null,
      expectedBytes: expected.bytes,
      expectedSha256: expected.sha256,
      bodyBytes: null,
      bodySha256: null,
      bodyCaptureKind: null,
      bodyCaptureReceipt: null,
      bodyError: null,
      failed: null,
    });
    observe();
  });
  const beginNetworkTerminal = (event, params, message) => {
    const sessionId = message?.sessionId ?? null;
    const key = requestKey(sessionId, params?.requestId);
    const request = requests.get(key) ?? null;
    const generation = request?.generation
      ?? responses.get(key)?.generation
      ?? targetSessions.get(sessionId)?.generation
      ?? currentGeneration;
    const tracked = requests.has(key) || responses.has(key) || responseEventKeys.has(key);
    const canonical = canonicalWorkerBootstrapSource(sessionId, params?.requestId);
    if (!tracked && !canonical) return { abort: true, ignored: true, key, sessionId };
    if (terminalRequestKeys.has(key)) {
      const clearedKeys = clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      if (request?.dataApiExempt === true) {
        return { abort: true, ignored: true, key, sessionId };
      }
      recordProvenanceError("duplicate-network-terminal", {
        generation,
        clearedKeys,
        event,
        key,
        requestId: params?.requestId ?? null,
        sessionId,
      });
      return { abort: true, key, sessionId };
    }
    terminalRequestKeys.add(key);
    if (!responseEventKeys.has(key)) {
      const clearedKeys = clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      if (request?.dataApiExempt === true) {
        return { abort: true, ignored: true, key, sessionId };
      }
      recordProvenanceError("network-terminal-without-response", {
        generation,
        clearedKeys,
        event,
        key,
        requestId: params?.requestId ?? null,
        sessionId,
      });
      return { abort: true, key, sessionId };
    }
    return { abort: false, key, sessionId };
  };
  const removeFinished = cdp.on("Network.loadingFinished", (params, message) => {
    const terminal = beginNetworkTerminal("Network.loadingFinished", params, message);
    if (terminal.abort) return undefined;
    const { key, sessionId } = terminal;
    const request = requests.get(key) ?? null;
    const record = responses.get(key);
    const finishRequest = () => {
      if (inFlight.delete(key)) observe();
    };
    if (!record) {
      clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      return undefined;
    }
    if (record.generation !== currentGeneration) {
      finishRequest();
      return undefined;
    }
    const canonicalDrawingWorker = record.workerBootstrapHandoff === true
      && record.sessionId !== null
      && drawingWorkerPaths.includes(record.path);
    if (canonicalDrawingWorker && claimWorkerResponseBodyCapture !== null) {
      const capture = claimWorkerResponseBodyCapture(params.requestId, record.url);
      const captureAccepted = capture?.kind === "controlled-fetch-response-body-capture"
        && typeof capture.fetchRequestId === "string"
        && capture.fetchRequestId.length > 0
        && capture.networkId === params.requestId
        && capture.relativePath === record.path
        && capture.resourceType === CONTROLLED_DRAWING_WORKER_FETCH_RESOURCE_TYPE
        && capture.sessionId === null
        && capture.url === record.url
        && capture.responseStatusCode === record.status
        && Number.isSafeInteger(capture.bodyBytes)
        && capture.bodyBytes >= 0
        && /^[a-f0-9]{64}$/.test(capture.bodySha256)
        && capture.claimCount === 1
        && typeof capture.claimedAt === "string";
      if (captureAccepted) {
        record.bodyBytes = capture.bodyBytes;
        record.bodySha256 = capture.bodySha256;
        record.bodyCaptureKind = capture.kind;
        record.bodyCaptureReceipt = capture;
      } else {
        record.bodyError = "canonical drawing worker response body capture is missing or invalid";
      }
      finishRequest();
      observe();
      return undefined;
    }
    const task = cdp.send(
      "Network.getResponseBody",
      { requestId: params.requestId },
      sessionId,
      sessionId === null,
    )
      .then((response) => {
        const result = response.result || {};
        const body = Buffer.from(String(result.body || ""), result.base64Encoded ? "base64" : "utf8");
        record.bodyBytes = body.byteLength;
        record.bodySha256 = sha256(body);
        record.bodyCaptureKind = "network-response-body";
      })
      .catch((error) => {
        record.bodyError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        pending.delete(task);
        finishRequest();
        observe();
      });
    pending.add(task);
    if (request) observe();
    return task;
  });
  const removeFailed = cdp.on("Network.loadingFailed", (params, message) => {
    const terminal = beginNetworkTerminal("Network.loadingFailed", params, message);
    if (terminal.abort) return;
    const { key, sessionId } = terminal;
    const record = responses.get(key);
    if (record) record.failed = params.errorText || "loading-failed";
    if (!record) {
      clearRequestAndCanonicalInFlight(sessionId, params?.requestId);
      return;
    }
    if (inFlight.delete(key) || record) observe();
  });
  const acceptedRecord = (record) => (
    record.status >= 200
    && record.status < 300
    && record.failed === null
    && record.bodyError === null
    && record.bodyBytes === record.expectedBytes
    && record.bodySha256 === record.expectedSha256
  );
  const snapshot = () => {
    const currentResponses = [...responses.values()].filter((record) => (
      record.generation === currentGeneration
      && (record.sessionId === null
        ? record.mainFrameProvenance
        : CONTROLLED_DIAGNOSTIC_WORKER_TYPES.includes(record.targetType))
    ));
    const currentMainFrameResponses = currentResponses.filter((record) => (
      record.sessionId === null
      && record.mainFrameProvenance
      && record.loaderId === currentLoaderId
    ));
    const observedPaths = [...new Set(currentResponses.map((record) => record.path))].sort();
    const observedAssets = observedPaths.map((relativePath) => {
      const candidates = currentResponses.filter((record) => record.path === relativePath);
      const accepted = candidates.length > 0 && candidates.every(acceptedRecord);
      return Object.freeze({
        path: relativePath,
        expectedBytes: manifest.get(relativePath)?.bytes ?? null,
        expectedSha256: manifest.get(relativePath)?.sha256 ?? null,
        accepted,
        candidates: Object.freeze(candidates.map((record) => Object.freeze({ ...record }))),
      });
    });
    const mainFrameObservedPaths = [...new Set(currentMainFrameResponses.map((record) => record.path))].sort();
    const mainFrameObservedAssets = mainFrameObservedPaths.map((relativePath) => {
      const candidates = currentMainFrameResponses.filter((record) => record.path === relativePath);
      return Object.freeze({
        path: relativePath,
        expectedBytes: manifest.get(relativePath)?.bytes ?? null,
        expectedSha256: manifest.get(relativePath)?.sha256 ?? null,
        accepted: candidates.length > 0 && candidates.every(acceptedRecord),
        candidates: Object.freeze(candidates.map((record) => Object.freeze({ ...record }))),
      });
    });
    const entryAssets = entryPaths.map((relativePath) => {
      const expectedType = relativePath === "index.html"
        ? "Document"
        : (relativePath.endsWith(".css") ? "Stylesheet" : "Script");
      const candidates = currentMainFrameResponses.filter((record) => (
        record.path === relativePath
        && record.requestType === expectedType
        && record.responseType === expectedType
      ));
      return Object.freeze({
        path: relativePath,
        expectedSha256: manifest.get(relativePath)?.sha256 ?? null,
        accepted: candidates.length > 0 && candidates.every(acceptedRecord),
        candidates: Object.freeze(candidates.map((record) => Object.freeze({ ...record }))),
      });
    });
    const availableWorkerConstructions = workerConstructions
      .filter((construction) => construction.generation === currentGeneration)
      .sort((left, right) => left.observationSequence - right.observationSequence);
    const workerTargets = [...targetSessions.values()]
      .filter((target) => (
        target.generation === currentGeneration
        && CONTROLLED_DIAGNOSTIC_WORKER_TYPES.includes(target.type)
      ))
      .sort((left, right) => left.attachedObservationSequence - right.attachedObservationSequence)
      .map((target) => {
        const relativePath = assetPath(target.url || "");
        const isDrawingWorker = target.type === "worker" && drawingWorkerPaths.includes(relativePath);
        const construction = isDrawingWorker
          ? workerTargetConstructionBindings.get(target.sessionId) ?? null
          : null;
        const authorizedCandidates = currentResponses.filter((record) => {
          if (record.path !== relativePath || record.url !== target.url) return false;
          if (!isDrawingWorker) return record.sessionId === target.sessionId;
          return construction !== null
            && record.sessionId === target.sessionId
            && record.targetId === target.targetId
            && record.workerBootstrapHandoff === true
            && workerBootstrapHandoffs.get(record.key)?.targetId === target.targetId;
        });
        const acceptedCandidates = authorizedCandidates.filter(acceptedRecord);
        const networkProvenanceAccepted = isDrawingWorker
          ? authorizedCandidates.length === 1
          : authorizedCandidates.length > 0;
        const assetAccepted = networkProvenanceAccepted
          && acceptedCandidates.length === authorizedCandidates.length;
        return Object.freeze({
          ...target,
          path: relativePath,
          active: target.detachedAt === null,
          constructorProvenanceAccepted: !isDrawingWorker || construction !== null,
          constructorProvenance: construction,
          manifestBacked: relativePath !== null && manifest.has(relativePath),
          networkProvenanceAccepted,
          assetAccepted,
          expectedAssetSha256: manifest.get(relativePath)?.sha256 ?? null,
          assetSha256: acceptedCandidates[0]?.bodySha256 ?? null,
          authorizedCandidates: Object.freeze(authorizedCandidates.map((record) => Object.freeze({
            ...record,
          }))),
        });
      });
    const currentInFlight = [...inFlight.values()].filter((record) => (
      record.generation === currentGeneration
    ));
    const currentDuplicateResponseKeys = duplicateResponseKeys.filter((record) => (
      record.generation === currentGeneration
    ));
    const currentUnmanifestedResponses = unmanifestedResponses.filter((record) => (
      record.generation === currentGeneration
    ));
    const currentProvenanceErrors = provenanceErrors.filter((record) => (
      record.generation === currentGeneration
    ));
    const currentWorkerConstructionFaults = workerConstructionFaults.filter((record) => (
      record.generation === currentGeneration
    ));
    const observedPassed = observedAssets.length > 0
      && observedAssets.every((item) => item.accepted);
    const entriesPassed = entryAssets.every((item) => item.accepted);
    const drawingWorkerTargets = workerTargets.filter((target) => (
      target.type === "worker" && drawingWorkerPaths.includes(target.path)
    ));
    const unclaimedDrawingWorkerConstructions = availableWorkerConstructions.filter((construction) => (
      drawingWorkerPaths.includes(assetPath(construction.url || ""))
      && !claimedWorkerConstructions.has(construction)
    ));
    const workerAssetAuthorityPassed = drawingWorkerPaths.length === 1
      && unclaimedDrawingWorkerConstructions.length === 0
      && currentWorkerConstructionFaults.length <= 1
      && (currentWorkerConstructionFaults.length === 0 || drawingWorkerTargets.length === 0)
      && workerTargets.every((target) => (
      target.manifestBacked
      && target.constructorProvenanceAccepted
      && target.networkProvenanceAccepted
      && target.assetAccepted
      && target.assetSha256 === target.expectedAssetSha256
      ));
    const workersPassed = workerAssetAuthorityPassed
      && workerTargets.every((target) => target.active);
    const commonAssetAuthorityPassed = currentDocumentPath === "index.html"
      && currentGeneration > 0
      && entriesPassed
      && observedPassed
      && workerAssetAuthorityPassed
      && currentDuplicateResponseKeys.length === 0
      && currentUnmanifestedResponses.length === 0
      && currentProvenanceErrors.length === 0
      && pending.size === 0
      && currentInFlight.length === 0;
    return Object.freeze({
      passed: commonAssetAuthorityPassed && workersPassed,
      assetAuthorityPassed: commonAssetAuthorityPassed,
      workerAssetAuthorityPassed,
      currentGeneration,
      observationSequence,
      mainFrameId,
      currentLoaderId,
      currentDocumentPath,
      currentDocumentUrl,
      pendingCount: pending.size,
      inFlightCount: currentInFlight.length,
      inFlight: Object.freeze(currentInFlight.map((record) => Object.freeze({ ...record }))),
      expectedEntryCount: entryPaths.length,
      expectedDrawingWorkerPaths: drawingWorkerPaths,
      drawingWorkerTargetCount: drawingWorkerTargets.length,
      unclaimedDrawingWorkerConstructionCount: unclaimedDrawingWorkerConstructions.length,
      unclaimedDrawingWorkerConstructions: Object.freeze(
        unclaimedDrawingWorkerConstructions.map((record) => Object.freeze({ ...record })),
      ),
      acceptedEntryCount: entryAssets.filter((item) => item.accepted).length,
      observedAssetCount: observedAssets.length,
      acceptedObservedAssetCount: observedAssets.filter((item) => item.accepted).length,
      duplicateResponseKeys: Object.freeze([...currentDuplicateResponseKeys]),
      unmanifestedResponses: Object.freeze([...currentUnmanifestedResponses]),
      provenanceErrors: Object.freeze([...currentProvenanceErrors]),
      entryAssets: Object.freeze(entryAssets),
      observedAssets: Object.freeze(observedAssets),
      mainFrameObservedAssets: Object.freeze(mainFrameObservedAssets),
      workerTargets: Object.freeze(workerTargets),
      workerConstructions: Object.freeze(availableWorkerConstructions.map((record) => Object.freeze({
        ...record,
      }))),
      workerConstructionFaults: Object.freeze(
        currentWorkerConstructionFaults.map((record) => Object.freeze({ ...record })),
      ),
      workerBootstrapHandoffs: Object.freeze([...workerBootstrapHandoffs.values()]
        .filter((record) => record.generation === currentGeneration)),
    });
  };
  const waitForAuthority = async (authorityField) => {
    const deadline = Date.now() + timeoutMs;
    const quietWindowMs = 200;
    let latest = snapshot();
    let quietStartedAt = null;
    let quietSequence = null;
    while (Date.now() <= deadline) {
      if (pending.size > 0) {
        await waitWithCancelableTimeout(Promise.allSettled([...pending]), Math.min(500, timeoutMs));
      }
      latest = snapshot();
      if (latest[authorityField] === true && latest.pendingCount === 0 && latest.inFlightCount === 0) {
        if (quietSequence !== latest.observationSequence) {
          quietSequence = latest.observationSequence;
          quietStartedAt = Date.now();
        } else if (Date.now() - quietStartedAt >= quietWindowMs) {
          return Object.freeze({
            ...latest,
            quiescence: Object.freeze({
              passed: true,
              timedOut: false,
              authorityField,
              quietWindowMs,
              observationSequence: quietSequence,
              observedAt: isoNow(),
            }),
          });
        }
      } else {
        quietSequence = null;
        quietStartedAt = null;
      }
      await wait(25);
    }
    latest = snapshot();
    return Object.freeze({
      ...latest,
      [authorityField]: false,
      quiescence: Object.freeze({
        passed: false,
        timedOut: true,
        authorityField,
        quietWindowMs,
        observationSequence: latest.observationSequence,
        observedAt: isoNow(),
      }),
    });
  };
  return Object.freeze({
    waitForComplete: () => waitForAuthority("passed"),
    waitForAssetAuthorityComplete: () => waitForAuthority("assetAuthorityPassed"),
    snapshot,
    dispose() {
      removeAttached();
      removeDetached();
      removeWorkerConstruction();
      removeRequest();
      removeResponse();
      removeFinished();
      removeFailed();
    },
  });
}

async function readBrowserBuildEvidence(
  cdp,
  managedUrl,
  buildReceipt,
  assetTracker,
  originGuard,
  workerDiagnostics,
  { requireActiveWorkers = true } = {},
) {
  const managedOrigin = new URL(managedUrl).origin;
  await workerDiagnostics.settle();
  workerDiagnostics.assertHealthy();
  const waitForNetworkAuthority = requireActiveWorkers
    ? assetTracker.waitForComplete
    : assetTracker.waitForAssetAuthorityComplete;
  let networkAssets = await waitForNetworkAuthority();
  const handlersBeforeCapture = await cdp.settleHandlers();
  if (!handlersBeforeCapture.passed) {
    throw new Error(`CDP handlers did not settle before build capture: ${JSON.stringify(handlersBeforeCapture)}`);
  }
  originGuard.assertHealthy();
  const browser = await evaluateJson(cdp, `(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const domUrls = new Set();
    for (const node of document.querySelectorAll('script[src],link[href]')) {
      const value = node.src || node.href;
      if (value) domUrls.add(value);
    }
    const resourceEntries = [];
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry?.name) resourceEntries.push({
        url: entry.name,
        initiatorType: entry.initiatorType || null
      });
    }
    return {
      origin: location.origin,
      href: location.href,
      readyState: document.readyState,
      domUrls: Array.from(domUrls),
      resourceEntries
    };
  })()`);
  const captureBarrier = await cdp.send("Runtime.evaluate", {
    expression: "({ controlledBuildEvidenceBarrier: true })",
    returnByValue: true,
  });
  if (captureBarrier.result?.exceptionDetails) {
    throw new Error(captureBarrier.result.exceptionDetails.text || "Build evidence barrier failed");
  }
  networkAssets = await waitForNetworkAuthority();
  const handlersAfterCapture = await cdp.settleHandlers();
  if (!handlersAfterCapture.passed) {
    throw new Error(`CDP handlers did not settle after build capture: ${JSON.stringify(handlersAfterCapture)}`);
  }
  originGuard.assertHealthy();
  const dataInitiatorTypes = new Set([
    "beacon",
    "eventsource",
    "fetch",
    "ping",
    "websocket",
    "xmlhttprequest",
  ]);
  const browserAssetUrls = [
    ...(browser?.domUrls || []),
    ...(browser?.resourceEntries || []).flatMap((entry) => (
      entry?.url && !dataInitiatorTypes.has(String(entry.initiatorType || "").toLowerCase())
        ? [entry.url]
        : []
    )),
  ];
  const loadedPaths = browserAssetUrls.flatMap((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.origin !== managedOrigin) return [];
      const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
      return relative ? [relative] : [];
    } catch { return []; }
  });
  const managedPath = (value) => {
    try {
      const parsed = new URL(value);
      if (parsed.origin !== managedOrigin) return null;
      return decodeURIComponent(parsed.pathname).replace(/^\/+/, "") || null;
    } catch { return null; }
  };
  const domLoadedPaths = [...new Set((browser?.domUrls || []).map(managedPath).filter(Boolean))].sort();
  const loadedAssets = fingerprintLoadedAssetPaths(loadedPaths);
  const observedAssetByPath = new Map(networkAssets.observedAssets.map((asset) => [asset.path, asset]));
  const mainFrameAssetByPath = new Map(
    networkAssets.mainFrameObservedAssets.map((asset) => [asset.path, asset]),
  );
  const browserLoadedAssetAuthority = Object.freeze(loadedAssets.paths.map((relativePath) => Object.freeze({
    path: relativePath,
    manifestBacked: buildReceipt.assetFingerprint.files.some((file) => file.path === relativePath),
    responseBodyAccepted: observedAssetByPath.get(relativePath)?.accepted === true,
  })));
  const browserLoadedAssetsAccepted = browserLoadedAssetAuthority.every((asset) => (
    asset.manifestBacked && asset.responseBodyAccepted
  ));
  const domLoadedAssetAuthority = Object.freeze(domLoadedPaths.map((relativePath) => Object.freeze({
    path: relativePath,
    manifestBacked: buildReceipt.assetFingerprint.files.some((file) => file.path === relativePath),
    mainFrameResponseBodyAccepted: mainFrameAssetByPath.get(relativePath)?.accepted === true,
  })));
  const domLoadedAssetsAccepted = domLoadedAssetAuthority.every((asset) => (
    asset.manifestBacked && asset.mainFrameResponseBodyAccepted
  ));
  const expectedEntryDomPaths = Object.freeze([...buildReceipt.entryAssetPaths].sort());
  const expectedEntriesPresentInDom = expectedEntryDomPaths.every((relativePath) => (
    domLoadedPaths.includes(relativePath)
  ));
  const offOriginDomUrls = (browser?.domUrls || []).filter((value) => (
    !controlledManagedUrlAllowed(value, managedOrigin)
  ));
  const currentDistribution = fingerprintDistribution();
  const currentInputs = fingerprintBuildInputs();
  const currentGit = readGitBuildContext(buildReceipt.toolchain.git.path);
  const managedOriginEvidence = originGuard.snapshot();
  const workerEvidence = workerDiagnostics.snapshot();
  const commonBuildAuthority = browser?.origin === managedOrigin
    && controlledManagedDocumentUrlAllowed(browser?.href || "", managedUrl)
    && browserLoadedAssetsAccepted
    && domLoadedAssetsAccepted
    && expectedEntriesPresentInDom
    && handlersBeforeCapture.passed
    && handlersAfterCapture.passed
    && offOriginDomUrls.length === 0
    && managedOriginEvidence.passed
    && workerEvidence.passed
    && currentDistribution.sha256 === buildReceipt.assetFingerprint.sha256
    && currentInputs.sha256 === buildReceipt.inputFingerprint.sha256
    && currentGit.commit === buildReceipt.git.commit
    && stableJson(currentGit.status) === stableJson(buildReceipt.git.status);
  const assetAuthoritative = commonBuildAuthority && networkAssets.assetAuthorityPassed === true;
  return Object.freeze({
    buildId: buildReceipt.buildId,
    buildFingerprint: buildReceipt.buildFingerprint,
    assetFingerprint: buildReceipt.assetFingerprint,
    expectedEntryAssetPaths: buildReceipt.entryAssetPaths,
    loadedAssets,
    browserLoadedAssetAuthority,
    browserLoadedAssetsAccepted,
    domLoadedAssetAuthority,
    domLoadedAssetsAccepted,
    expectedEntryDomPaths,
    expectedEntriesPresentInDom,
    networkAssets,
    cdpHandlerSettlements: Object.freeze({
      beforeCapture: handlersBeforeCapture,
      afterCapture: handlersAfterCapture,
    }),
    captureBarrier: Object.freeze({ completed: true }),
    offOriginDomUrls: Object.freeze(offOriginDomUrls),
    managedOriginEvidence,
    workerDiagnostics: workerEvidence,
    currentAssetSha256: currentDistribution.sha256,
    distMatchesBuild: currentDistribution.sha256 === buildReceipt.assetFingerprint.sha256,
    currentBuildInputSha256: currentInputs.sha256,
    buildInputsMatch: currentInputs.sha256 === buildReceipt.inputFingerprint.sha256,
    currentGit,
    gitMatchesBuild: currentGit.commit === buildReceipt.git.commit
      && stableJson(currentGit.status) === stableJson(buildReceipt.git.status),
    managedOrigin,
    observedOrigin: browser?.origin ?? null,
    href: browser?.href ?? null,
    readyState: browser?.readyState ?? null,
    matchesManagedOrigin: browser?.origin === managedOrigin,
    matchesManagedDocument: controlledManagedDocumentUrlAllowed(browser?.href || "", managedUrl),
    entryAssetsLoaded: networkAssets.passed,
    networkAssetsPassed: networkAssets.passed,
    networkAssetAuthorityPassed: networkAssets.assetAuthorityPassed === true,
    assetAuthoritative,
    authoritative: commonBuildAuthority && networkAssets.passed,
  });
}

export function diagnosticBootstrapSource({
  runId = "",
  authorityToken = "",
  authorityTokenSha256 = "",
  drawingWorkerPaths = [],
} = {}) {
  if (typeof runId !== "string" || !runId) {
    throw new TypeError("controlled diagnostic bootstrap runId is required");
  }
  if (typeof authorityToken !== "string" || !authorityToken) {
    throw new TypeError("controlled diagnostic bootstrap authority token is required");
  }
  if (!/^[a-f0-9]{64}$/.test(authorityTokenSha256)) {
    throw new TypeError("controlled diagnostic bootstrap authority token digest is invalid");
  }
  if (!Array.isArray(drawingWorkerPaths)
    || drawingWorkerPaths.length !== 1
    || !drawingWorkerPaths.every((value) => (
      typeof value === "string" && /^assets\/drawing\.worker(?:-[^/]+)?\.js$/.test(value)
    ))) {
    throw new TypeError("controlled diagnostic bootstrap requires one manifest drawing worker path");
  }
  const authority = Object.freeze({
    runId,
    authorityToken,
    authorityTokenSha256,
    drawingWorkerPaths: Object.freeze([...drawingWorkerPaths]),
    drillIds: CONTROLLED_ROLLBACK_DRILL_IDS,
    storageVariants: CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS,
    sessionKey: CONTROLLED_ROLLBACK_SESSION_KEY,
    handleName: CONTROLLED_ROLLBACK_HANDLE,
  });
  return `(() => {
    const authority = Object.freeze(${JSON.stringify(authority)});
    const marker = '__CANDLESCOPE_CONTROLLED_CDP_DIAGNOSTICS_INSTALLED__';
    if (window[marker] === true) return;
    Object.defineProperty(window, marker, { value: true, configurable: false });
    const report = (payload) => {
      try { window.${DIAGNOSTIC_BINDING}(JSON.stringify(payload)); } catch {}
    };
    const cloneHeader = (value) => {
      const header = value && typeof value === 'object' ? value : null;
      const stamp = header && header.stamp && typeof header.stamp === 'object'
        ? header.stamp
        : null;
      if (!header || !stamp) return null;
      try {
        return {
          schemaVersion: header.schemaVersion,
          jobId: header.jobId,
          generation: header.generation,
          stamp: { ...stamp }
        };
      } catch { return null; }
    };
    let tokenRemoved = false;
    let token = null;
    try {
      const raw = sessionStorage.getItem(authority.sessionKey);
      if (raw !== null) {
        sessionStorage.removeItem(authority.sessionKey);
        tokenRemoved = sessionStorage.getItem(authority.sessionKey) === null;
        token = JSON.parse(raw);
      }
    } catch {}
    const tokenVariantAccepted = token?.drillId === 'indexeddb-quota-blocked'
      ? authority.storageVariants.includes(token?.variant)
      : token?.variant === null;
    const authorityAccepted = Boolean(token
      && token.runId === authority.runId
      && token.authorityToken === authority.authorityToken
      && token.authorityTokenSha256 === authority.authorityTokenSha256
      && typeof token.faultId === 'string'
      && /^[a-f0-9-]{36}$/.test(token.faultId)
      && Number.isSafeInteger(token.sequence)
      && token.sequence > 0
      && authority.drillIds.includes(token.drillId)
      && tokenVariantAccepted);
    const activeDrill = authorityAccepted ? token.drillId : null;
    const activeVariant = authorityAccepted ? token.variant : null;
    const documentInstanceId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : authority.runId + ':' + Date.now() + ':' + Math.random();
    const state = {
      runId: authority.runId,
      authorityTokenSha256: authority.authorityTokenSha256,
      authorityAccepted,
      tokenRemoved,
      drillId: activeDrill,
      variant: activeVariant,
      documentInstanceId,
      faultId: authorityAccepted ? token.faultId : null,
      sequence: authorityAccepted ? token.sequence : null,
      armed: authorityAccepted,
      armedAt: authorityAccepted ? new Date().toISOString() : null,
      observed: false,
      observedAt: null,
      expectedDrawingWorkerPaths: [...authority.drawingWorkerPaths],
      workerConstructorAttempts: 0,
      workerConstructionFailures: 0,
      workerCreations: 0,
      renderRequestCount: 0,
      renderResultCount: 0,
      typedResultCount: 0,
      bitmapResultCount: 0,
      renderRequests: [],
      renderResults: [],
      constructionFailure: null,
      storage: {
        realDatabaseName: 'candlescope-drawings-v2',
        realOpenCount: 0,
        realConnectionCount: 0,
        realCloseCount: 0,
        quotaPreparation: null,
        quotaProbe: null,
        quotaRelease: null,
        blockedInterceptorInstalled: false,
        blockedPreparation: null,
        blockedRoute: null,
        blockedEvent: null,
        blockedRelease: null
      }
    };
    const observe = () => {
      state.observed = true;
      if (state.observedAt === null) state.observedAt = new Date().toISOString();
    };
    const append = (target, value) => {
      if (target.length >= 64) target.shift();
      target.push(value);
    };
    const snapshot = () => JSON.parse(JSON.stringify(state));
    const nativeIndexedDb = globalThis.indexedDB;
    const nativeIndexedDbOpen = typeof nativeIndexedDb?.open === 'function'
      ? nativeIndexedDb.open.bind(nativeIndexedDb)
      : null;
    const nativeIndexedDbDelete = typeof nativeIndexedDb?.deleteDatabase === 'function'
      ? nativeIndexedDb.deleteDatabase.bind(nativeIndexedDb)
      : null;
    const realConnections = [];
    const closedRealConnections = new WeakSet();
    let blockedKeeper = null;
    let blockedUpgradeRequest = null;
    let blockedUpgradeSettled = null;
    let blockedRouteActive = false;
    let blockedFaultDatabaseName = null;
    let blockedKeeperConnectionId = null;
    let blockedKeeperOpenedAt = null;
    let blockedKeeperClosedAt = null;
    let blockedInterceptorInstalled = false;
    let blockedFaultConsumed = false;
    const quotaStoreName = 'quota-probe';
    const quotaBaselineKey = 'baseline';
    const quotaProbeKey = 'probe';
    const quotaFaultDatabaseName = activeDrill === 'indexeddb-quota-blocked'
      && activeVariant === 'quota'
      && state.faultId
      ? 'candlescope-rollback-quota-' + authority.runId + '-' + state.faultId
      : null;
    let quotaConnection = null;
    let quotaFaultConsumed = false;
    let quotaConnectionOpenedAt = null;
    const waitForIdbRequest = (request, operation) => new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error || new Error(operation + ' failed')), { once: true });
      request.addEventListener('blocked', () => reject(new Error(operation + ' blocked')), { once: true });
    });
    const waitForIdbTransaction = (transaction, operation) => new Promise((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('error', () => {
        reject(transaction.error || new Error(operation + ' failed'));
      }, { once: true });
      transaction.addEventListener('abort', () => {
        reject(transaction.error || new Error(operation + ' aborted'));
      }, { once: true });
    });
    const waitForIdbDeletion = (request) => Promise.race([
      new Promise((resolve) => {
        request.addEventListener('success', () => resolve({
          status: 'success', observedAt: new Date().toISOString()
        }), { once: true });
        request.addEventListener('error', () => resolve({
          status: 'error',
          name: request.error?.name || null,
          message: request.error?.message || null,
          observedAt: new Date().toISOString()
        }), { once: true });
        request.addEventListener('blocked', (event) => resolve({
          status: 'blocked',
          isTrusted: event.isTrusted === true,
          observedAt: new Date().toISOString()
        }), { once: true });
      }),
      new Promise((resolve) => setTimeout(() => resolve({
        status: 'timeout', observedAt: new Date().toISOString()
      }), 2_000))
    ]);
    const observeRealConnection = (request) => {
      request.addEventListener('success', () => {
        let database = null;
        try { database = request.result; } catch {}
        if (!database || database.name !== state.storage.realDatabaseName) return;
        state.storage.realConnectionCount += 1;
        realConnections.push(database);
        try {
          const nativeClose = database.close.bind(database);
          Object.defineProperty(database, 'close', {
            value() {
              if (!closedRealConnections.has(database)) {
                closedRealConnections.add(database);
                state.storage.realCloseCount += 1;
              }
              return nativeClose();
            },
            configurable: false,
            enumerable: false,
            writable: false
          });
        } catch {}
      }, { once: true });
    };
    const controlledIndexedDbOpen = function(name, version) {
      const normalizedName = String(name);
      const normalizedVersion = version === undefined ? null : Number(version);
      const exactProductOpen = normalizedName === state.storage.realDatabaseName
        && normalizedVersion === 1;
      if (exactProductOpen) state.storage.realOpenCount += 1;
      if (activeDrill === 'indexeddb-quota-blocked'
        && activeVariant === 'blocked'
        && exactProductOpen
        && blockedRouteActive
        && blockedFaultDatabaseName) {
        blockedRouteActive = false;
        const startedAt = new Date().toISOString();
        const requestId = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : authority.runId + ':blocked-open:' + Date.now() + ':' + Math.random();
        const request = nativeIndexedDbOpen(blockedFaultDatabaseName, 2);
        blockedUpgradeRequest = request;
        state.storage.blockedRoute = {
          consumed: true,
          requestId,
          requestedName: normalizedName,
          requestedVersion: normalizedVersion,
          routedDatabaseName: blockedFaultDatabaseName,
          routedVersion: 2,
          startedAt,
          settled: null,
          settledAt: null,
          resultClosed: false
        };
        request.addEventListener('blocked', (event) => {
          state.storage.blockedEvent = {
            type: event.type,
            isTrusted: event.isTrusted === true,
            databaseName: blockedFaultDatabaseName,
            oldVersion: event.oldVersion,
            newVersion: event.newVersion,
            observedAt: new Date().toISOString()
          };
          observe();
        }, { once: true });
        blockedUpgradeSettled = new Promise((resolve) => {
          request.addEventListener('success', () => {
            let closed = false;
            try { request.result.close(); closed = true; } catch {}
            const settledAt = new Date().toISOString();
            state.storage.blockedRoute.settled = 'success-after-keeper-close';
            state.storage.blockedRoute.settledAt = settledAt;
            state.storage.blockedRoute.resultClosed = closed;
            resolve({
              status: 'success-after-keeper-close',
              resultClosed: closed,
              observedAt: settledAt
            });
          }, { once: true });
          request.addEventListener('error', () => {
            const settledAt = new Date().toISOString();
            state.storage.blockedRoute.settled = 'error';
            state.storage.blockedRoute.settledAt = settledAt;
            resolve({
              status: 'error',
              name: request.error?.name || null,
              message: request.error?.message || null,
              observedAt: settledAt
            });
          }, { once: true });
        });
        return request;
      }
      const request = version === undefined
        ? nativeIndexedDbOpen(name)
        : nativeIndexedDbOpen(name, version);
      if (exactProductOpen) observeRealConnection(request);
      return request;
    };
    if (activeDrill === 'indexeddb-quota-blocked'
      && activeVariant === 'blocked'
      && nativeIndexedDbOpen
      && nativeIndexedDbDelete) {
      try {
        Object.defineProperty(nativeIndexedDb, 'open', {
          value: controlledIndexedDbOpen,
          configurable: false,
          enumerable: false,
          writable: false
        });
        blockedInterceptorInstalled = nativeIndexedDb.open === controlledIndexedDbOpen;
        state.storage.blockedInterceptorInstalled = blockedInterceptorInstalled;
      } catch {
        state.storage.blockedPreparation = {
          prepared: false,
          reason: 'indexeddb-open-interceptor-install-failed',
          observedAt: new Date().toISOString()
        };
      }
    }
    const prepareQuotaFault = async (expectedFaultId) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'quota'
        || expectedFaultId !== state.faultId
        || !quotaFaultDatabaseName
        || !nativeIndexedDbOpen
        || !nativeIndexedDbDelete
        || quotaFaultConsumed
        || quotaConnection) {
        throw new Error('controlled quota IndexedDB fault cannot be prepared');
      }
      quotaFaultConsumed = true;
      const request = nativeIndexedDbOpen(quotaFaultDatabaseName, 1);
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(quotaStoreName)) {
          request.result.createObjectStore(quotaStoreName);
        }
      }, { once: true });
      quotaConnection = await waitForIdbRequest(request, 'controlled quota database open');
      quotaConnectionOpenedAt = new Date().toISOString();
      const transaction = quotaConnection.transaction(quotaStoreName, 'readwrite');
      const completion = waitForIdbTransaction(transaction, 'controlled quota baseline transaction');
      transaction.objectStore(quotaStoreName).put({
        runId: authority.runId,
        faultId: state.faultId,
        kind: 'quota-baseline'
      }, quotaBaselineKey);
      await completion;
      state.storage.quotaPreparation = {
        prepared: true,
        databaseName: quotaFaultDatabaseName,
        storeName: quotaStoreName,
        baselineKey: quotaBaselineKey,
        baselineCommitted: true,
        connectionKeptOpen: quotaConnection !== null,
        connectionOpenedAt: quotaConnectionOpenedAt,
        preparedAt: new Date().toISOString()
      };
      return snapshot();
    };
    const probeQuotaFault = async (expectedFaultId) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'quota'
        || expectedFaultId !== state.faultId
        || !quotaConnection
        || state.storage.quotaPreparation?.prepared !== true
        || state.storage.quotaProbe !== null) {
        throw new Error('controlled quota IndexedDB fault cannot be probed');
      }
      const attemptedAt = new Date().toISOString();
      const transaction = quotaConnection.transaction(quotaStoreName, 'readwrite');
      let request = null;
      let requestError = null;
      let transactionErrorEvent = null;
      let abortEvent = null;
      const settlement = new Promise((resolve) => {
        transaction.addEventListener('error', (event) => {
          transactionErrorEvent = {
            type: event.type,
            isTrusted: event.isTrusted === true,
            observedAt: new Date().toISOString()
          };
        });
        transaction.addEventListener('abort', (event) => {
          abortEvent = {
            type: event.type,
            isTrusted: event.isTrusted === true,
            observedAt: new Date().toISOString()
          };
          resolve('abort');
        }, { once: true });
        transaction.addEventListener('complete', () => resolve('complete'), { once: true });
      });
      let synchronousError = null;
      try {
        request = transaction.objectStore(quotaStoreName).put({
          runId: authority.runId,
          faultId: state.faultId,
          kind: 'quota-probe'
        }, quotaProbeKey);
        request.addEventListener('error', (event) => {
          requestError = {
            type: event.type,
            isTrusted: event.isTrusted === true,
            name: request.error?.name || null,
            message: request.error?.message || null,
            observedAt: new Date().toISOString()
          };
        }, { once: true });
      } catch (error) {
        synchronousError = {
          name: error?.name || null,
          message: error?.message || String(error),
          observedAt: new Date().toISOString()
        };
      }
      const settled = synchronousError ? 'synchronous-error' : await settlement;
      const transactionError = transaction.error ? {
        name: transaction.error.name || null,
        message: transaction.error.message || null,
        observedAt: abortEvent?.observedAt || new Date().toISOString()
      } : null;
      const observedAt = new Date().toISOString();
      state.storage.quotaProbe = {
        attempted: true,
        databaseName: quotaFaultDatabaseName,
        storeName: quotaStoreName,
        key: quotaProbeKey,
        transactionMode: transaction.mode,
        attemptedAt,
        settled,
        requestError,
        transactionErrorEvent,
        transactionError,
        abortEvent,
        synchronousError,
        nativeQuotaExceeded: settled === 'abort'
          && abortEvent?.isTrusted === true
          && transactionError?.name === 'QuotaExceededError',
        observedAt
      };
      return snapshot();
    };
    const cleanupQuotaFault = async (expectedFaultId, forcedCleanup = true) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'quota'
        || expectedFaultId !== state.faultId
        || !quotaFaultDatabaseName
        || !nativeIndexedDbDelete) {
        throw new Error('controlled quota IndexedDB fault cannot be cleaned');
      }
      if (state.storage.quotaRelease?.completed === true) {
        let databaseStillPresent = state.storage.quotaRelease.databaseStillPresent;
        if (typeof nativeIndexedDb.databases === 'function') {
          const databases = await nativeIndexedDb.databases();
          databaseStillPresent = databases.some((database) => database?.name === quotaFaultDatabaseName);
        }
        state.storage.quotaRelease = {
          ...state.storage.quotaRelease,
          databaseStillPresent,
          forcedCleanup: state.storage.quotaRelease.forcedCleanup === true
            || forcedCleanup === true,
          completed: state.storage.quotaRelease.connectionClosed === true
            && state.storage.quotaRelease.deletion?.status === 'success'
            && databaseStillPresent === false,
          lastVerifiedAt: new Date().toISOString()
        };
        return snapshot();
      }
      let connectionClosed = false;
      if (quotaConnection) {
        try {
          quotaConnection.close();
          connectionClosed = true;
        } catch {}
        quotaConnection = null;
      } else {
        connectionClosed = true;
      }
      const deletion = await waitForIdbDeletion(nativeIndexedDbDelete(quotaFaultDatabaseName));
      let databaseStillPresent = null;
      if (typeof nativeIndexedDb.databases === 'function') {
        const databases = await nativeIndexedDb.databases();
        databaseStillPresent = databases.some((database) => database?.name === quotaFaultDatabaseName);
      }
      const completedAt = new Date().toISOString();
      state.storage.quotaRelease = {
        databaseName: quotaFaultDatabaseName,
        storeName: quotaStoreName,
        connectionClosed,
        deletion,
        databaseStillPresent,
        forcedCleanup: forcedCleanup === true,
        completed: connectionClosed
          && deletion?.status === 'success'
          && databaseStillPresent === false,
        completedAt
      };
      return snapshot();
    };
    const prepareBlockedFault = async (expectedFaultId) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'blocked'
        || expectedFaultId !== state.faultId
        || !nativeIndexedDbOpen
        || !nativeIndexedDbDelete
        || blockedInterceptorInstalled !== true
        || nativeIndexedDb.open !== controlledIndexedDbOpen
        || blockedFaultConsumed
        || blockedKeeper
        || blockedRouteActive) {
        throw new Error('controlled blocked IndexedDB fault cannot be prepared');
      }
      blockedFaultConsumed = true;
      blockedFaultDatabaseName = 'candlescope-rollback-blocked-' + authority.runId + '-' + state.faultId;
      blockedKeeperConnectionId = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : authority.runId + ':blocked-keeper:' + Date.now() + ':' + Math.random();
      const request = nativeIndexedDbOpen(blockedFaultDatabaseName, 1);
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains('keeper')) {
          request.result.createObjectStore('keeper');
        }
      }, { once: true });
      blockedKeeper = await waitForIdbRequest(request, 'controlled blocked keeper open');
      blockedKeeperOpenedAt = new Date().toISOString();
      const activeConnections = realConnections.filter((database) => !closedRealConnections.has(database));
      const closeCountBefore = state.storage.realCloseCount;
      let dispatchedCount = 0;
      for (const database of activeConnections) {
        try {
          const event = new IDBVersionChangeEvent('versionchange', {
            oldVersion: database.version,
            newVersion: null
          });
          if (database.dispatchEvent(event)) dispatchedCount += 1;
          else dispatchedCount += 1;
        } catch {}
      }
      const closeCountAfter = state.storage.realCloseCount;
      blockedRouteActive = true;
      state.storage.blockedPreparation = {
        prepared: activeConnections.length === 1
          && dispatchedCount === 1
          && closeCountAfter === closeCountBefore + 1,
        faultDatabaseName: blockedFaultDatabaseName,
        keeperConnectionId: blockedKeeperConnectionId,
        keeperVersion: blockedKeeper.version,
        keeperOpenedAt: blockedKeeperOpenedAt,
        activeRealConnectionCount: activeConnections.length,
        syntheticVersionChangeDispatchCount: dispatchedCount,
        realCloseCountBefore: closeCountBefore,
        realCloseCountAfter: closeCountAfter,
        preparedAt: new Date().toISOString()
      };
      if (!state.storage.blockedPreparation.prepared) {
        blockedRouteActive = false;
        blockedKeeperClosedAt = new Date().toISOString();
        try { blockedKeeper.close(); } catch {}
        blockedKeeper = null;
        const deletion = await waitForIdbDeletion(nativeIndexedDbDelete(blockedFaultDatabaseName));
        let databaseStillPresent = null;
        if (typeof nativeIndexedDb.databases === 'function') {
          const databases = await nativeIndexedDb.databases();
          databaseStillPresent = databases.some((database) => database?.name === blockedFaultDatabaseName);
        }
        state.storage.blockedRelease = {
          releasedAt: blockedKeeperClosedAt,
          settlement: null,
          deletion,
          databaseStillPresent,
          databaseName: blockedFaultDatabaseName,
          keeperConnectionId: blockedKeeperConnectionId,
          keeperOpenedAt: blockedKeeperOpenedAt,
          keeperClosedAt: blockedKeeperClosedAt,
          completedAt: new Date().toISOString(),
          forcedCleanup: true,
          completed: deletion?.status === 'success' && databaseStillPresent === false
        };
        throw new Error('controlled blocked IndexedDB cache retirement failed');
      }
      return snapshot();
    };
    const releaseBlockedFault = async (expectedFaultId) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'blocked'
        || expectedFaultId !== state.faultId
        || !blockedKeeper
        || !blockedUpgradeRequest
        || !blockedUpgradeSettled
        || state.storage.blockedRoute?.consumed !== true
        || state.storage.blockedEvent?.isTrusted !== true) {
        throw new Error('controlled blocked IndexedDB fault cannot be released');
      }
      const releasedAt = new Date().toISOString();
      blockedKeeperClosedAt = releasedAt;
      blockedKeeper.close();
      blockedKeeper = null;
      const settlement = await Promise.race([
        blockedUpgradeSettled,
        new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 2_000))
      ]);
      const deleteRequest = nativeIndexedDbDelete(blockedFaultDatabaseName);
      const deletion = await waitForIdbDeletion(deleteRequest);
      let databaseStillPresent = null;
      if (typeof nativeIndexedDb.databases === 'function') {
        const databases = await nativeIndexedDb.databases();
        databaseStillPresent = databases.some((database) => database?.name === blockedFaultDatabaseName);
      }
      state.storage.blockedRelease = {
        releasedAt,
        settlement,
        deletion,
        databaseStillPresent,
        databaseName: blockedFaultDatabaseName,
        keeperConnectionId: blockedKeeperConnectionId,
        keeperOpenedAt: blockedKeeperOpenedAt,
        keeperClosedAt: blockedKeeperClosedAt,
        completedAt: new Date().toISOString(),
        completed: settlement?.status === 'success-after-keeper-close'
          && settlement?.resultClosed === true
          && deletion?.status === 'success'
          && databaseStillPresent === false
      };
      if (!state.storage.blockedRelease.completed) {
        throw new Error('controlled blocked IndexedDB fault cleanup failed');
      }
      return snapshot();
    };
    const cleanupBlockedFault = async (expectedFaultId) => {
      if (activeDrill !== 'indexeddb-quota-blocked'
        || activeVariant !== 'blocked'
        || expectedFaultId !== state.faultId
        || !nativeIndexedDbDelete) {
        throw new Error('controlled blocked IndexedDB fault cannot be cleaned');
      }
      if (state.storage.blockedRelease?.completed === true) return snapshot();
      if (blockedKeeper) {
        blockedKeeperClosedAt = blockedKeeperClosedAt || new Date().toISOString();
        try { blockedKeeper.close(); } catch {}
        blockedKeeper = null;
      }
      let settlement = null;
      if (blockedUpgradeSettled) {
        settlement = await Promise.race([
          blockedUpgradeSettled,
          new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 2_000))
        ]);
      }
      let deletion = null;
      if (blockedFaultDatabaseName) {
        const request = nativeIndexedDbDelete(blockedFaultDatabaseName);
        deletion = await waitForIdbDeletion(request);
      }
      let databaseStillPresent = null;
      if (blockedFaultDatabaseName && typeof nativeIndexedDb.databases === 'function') {
        const databases = await nativeIndexedDb.databases();
        databaseStillPresent = databases.some((database) => database?.name === blockedFaultDatabaseName);
      }
      state.storage.blockedRelease = {
        releasedAt: blockedKeeperClosedAt,
        settlement,
        deletion,
        databaseStillPresent,
        databaseName: blockedFaultDatabaseName,
        keeperConnectionId: blockedKeeperConnectionId,
        keeperOpenedAt: blockedKeeperOpenedAt,
        keeperClosedAt: blockedKeeperClosedAt,
        completedAt: new Date().toISOString(),
        forcedCleanup: true,
        completed: deletion?.status === 'success' && databaseStillPresent === false
      };
      blockedRouteActive = false;
      return snapshot();
    };
    Object.defineProperty(window, authority.handleName, {
      value: Object.freeze({
        snapshot,
        prepareQuotaFault,
        probeQuotaFault,
        cleanupQuotaFault,
        prepareBlockedFault,
        releaseBlockedFault,
        cleanupBlockedFault
      }),
      configurable: false,
      enumerable: false,
      writable: false
    });
    if (activeDrill === 'worker-stale-generation') {
      Object.defineProperty(window, '__CANDLESCOPE_DRAWING_PERF_CONFIG__', {
        value: Object.freeze({ phase6WorkerDelayMs: 96 }),
        configurable: false,
        enumerable: false,
        writable: false
      });
    }
    try {
      const NativeWorker = window.Worker;
      if (typeof NativeWorker === 'function') {
        const ControlledWorker = new Proxy(NativeWorker, {
          construct(target, args) {
            let resolvedUrl = null;
            try { resolvedUrl = new URL(String(args[0]), location.href).href; } catch {}
            let relativePath = null;
            try {
              const parsed = new URL(resolvedUrl);
              if (parsed.origin === location.origin) {
                relativePath = decodeURIComponent(parsed.pathname).replace(/^\\/+/, '');
              }
            } catch {}
            const isDrawingWorker = authority.drawingWorkerPaths.includes(relativePath);
            const workerType = args[1]?.type || 'classic';
            const workerName = args[1]?.name || null;
            const exactDrawingWorkerConstruction = isDrawingWorker
              && workerType === 'module'
              && workerName === 'candlescope-drawing-worker';
            if (isDrawingWorker) state.workerConstructorAttempts += 1;
            if (exactDrawingWorkerConstruction && activeDrill === 'worker-init-failure') {
              state.workerConstructionFailures += 1;
              observe();
              const error = new DOMException(
                'Controlled drawing worker construction failure',
                'NotSupportedError'
              );
              state.constructionFailure = {
                url: resolvedUrl,
                workerType,
                workerName,
                name: error.name,
                message: error.message,
                observedAt: new Date().toISOString()
              };
              report({
                kind: 'worker-constructor-fault',
                runId: authority.runId,
                authorityTokenSha256: authority.authorityTokenSha256,
                drillId: activeDrill,
                faultId: state.faultId,
                sequence: state.sequence,
                url: resolvedUrl,
                workerType,
                workerName
              });
              throw error;
            }
            report({
              kind: 'worker-constructor',
              url: resolvedUrl,
              workerType
            });
            const worker = Reflect.construct(target, args, target);
            if (isDrawingWorker) {
              state.workerCreations += 1;
              const nativePostMessage = worker.postMessage;
              Object.defineProperty(worker, 'postMessage', {
                value(...postArgs) {
                  const message = postArgs[0];
                  if (message?.type === 'drawing-worker/render') {
                    state.renderRequestCount += 1;
                    append(state.renderRequests, {
                      header: cloneHeader(message.header),
                      observedAt: new Date().toISOString()
                    });
                    if (activeDrill === 'worker-stale-generation') observe();
                  }
                  return Reflect.apply(nativePostMessage, worker, postArgs);
                },
                configurable: false,
                enumerable: false,
                writable: false
              });
              worker.addEventListener('message', (event) => {
                const message = event.data;
                if (message?.type !== 'drawing-worker/result') return;
                const resultKind = message.result?.kind || null;
                state.renderResultCount += 1;
                if (resultKind === 'typed-draw-result') state.typedResultCount += 1;
                if (resultKind === 'bitmap-draw-result') state.bitmapResultCount += 1;
                append(state.renderResults, {
                  header: cloneHeader(message.header),
                  resultKind,
                  observedAt: new Date().toISOString()
                });
              });
            }
            return worker;
          }
        });
        Object.defineProperty(window, 'Worker', {
          value: ControlledWorker,
          configurable: false,
          enumerable: true,
          writable: false
        });
      }
    } catch {}
    const serialize = (value) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || null };
      try { return JSON.parse(JSON.stringify(value)); } catch { return { value: String(value) }; }
    };
    addEventListener('unhandledrejection', (event) => {
      report({ kind: 'unhandledrejection', reason: serialize(event.reason) });
    });
    addEventListener('error', (event) => {
      report({
        kind: 'error', message: event.message || null, filename: event.filename || null,
        line: event.lineno || null, column: event.colno || null, error: serialize(event.error)
      });
    });
  })();`;
}

function workerDiagnosticBootstrapSource(targetId) {
  return `(() => {
    const marker = '__CANDLESCOPE_CONTROLLED_WORKER_DIAGNOSTICS_INSTALLED__';
    if (globalThis[marker] === true) return;
    Object.defineProperty(globalThis, marker, { value: true, configurable: false });
    const serialize = (value) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || null };
      try { return JSON.parse(JSON.stringify(value)); } catch { return { value: String(value) }; }
    };
    addEventListener('unhandledrejection', (event) => {
      globalThis.${DIAGNOSTIC_BINDING}(JSON.stringify({
        kind: 'unhandledrejection', context: 'worker', targetId: ${JSON.stringify(targetId)},
        reason: serialize(event.reason)
      }));
    });
    addEventListener('error', (event) => {
      globalThis.${DIAGNOSTIC_BINDING}(JSON.stringify({
        kind: 'error', context: 'worker', targetId: ${JSON.stringify(targetId)},
        message: event.message || null, filename: event.filename || null,
        line: event.lineno || null, column: event.colno || null, error: serialize(event.error)
      }));
    });
  })();`;
}

export function createControlledWorkerDiagnosticsController(cdp, managedOrigin = null) {
  const diagnosticTargetTypes = new Set(CONTROLLED_DIAGNOSTIC_WORKER_TYPES);
  const targets = new Map();
  const pending = new Set();
  const failures = [];
  const barriers = [];
  const initializers = new Map();
  let targetSequence = 0;
  const fail = (record, error) => {
    const message = error instanceof Error ? error.message : String(error);
    record.error = record.error ? `${record.error}; ${message}` : message;
    failures.push(Object.freeze({
      sessionId: record.sessionId,
      targetId: record.targetId,
      error: message,
    }));
  };
  const initializerSnapshot = (record) => Object.freeze({
    id: record.id,
    targetType: record.targetType,
    targetUrl: record.targetUrl,
    expressionSha256: record.expressionSha256,
    timeoutMs: record.timeoutMs,
    armedAt: record.armedAt,
    armedAfterTargetSequence: record.armedAfterTargetSequence,
    claimedAt: record.claimedAt,
    claimedTargetSequence: record.claimedTargetSequence,
    claimedSessionId: record.claimedSessionId,
    state: record.state,
    matchCount: record.matchCount,
    receipt: record.receipt,
    error: record.error,
  });
  const completeInitializer = (record, state, receipt, error = null) => {
    if (record.state !== "armed" && record.state !== "claimed") return;
    record.state = state;
    record.receipt = receipt;
    record.error = error;
  };
  const removeAttached = cdp.on("Target.attachedToTarget", (params) => {
    const sessionId = params?.sessionId;
    const targetInfo = params?.targetInfo || {};
    if (typeof sessionId !== "string") return undefined;
    const sequence = ++targetSequence;
    const record = {
      sequence,
      sessionId,
      targetId: targetInfo.targetId ?? null,
      type: targetInfo.type ?? null,
      title: targetInfo.title ?? null,
      url: targetInfo.url ?? null,
      waitingForDebugger: params?.waitingForDebugger === true,
      attachedAt: isoNow(),
      initializedAt: null,
      initializerId: null,
      initializerStartedAt: null,
      initializerCompletedAt: null,
      resumeAttemptCount: 0,
      resumeAttemptedAt: null,
      resumedAt: null,
      detachedAt: null,
      error: null,
    };
    if (targets.has(sessionId)) {
      fail(record, new Error(`Duplicate attached target session ${sessionId}`));
      return undefined;
    }
    targets.set(sessionId, record);
    let claimedInitializer = null;
    let claimError = null;
    if (diagnosticTargetTypes.has(targetInfo.type)) {
      const matches = [...initializers.values()].filter((initializer) => (
        initializer.state === "armed"
        && initializer.armedAfterTargetSequence < sequence
        && initializer.targetType === targetInfo.type
        && initializer.targetUrl === targetInfo.url
      ));
      if (matches.length > 1) {
        claimError = new Error(`Multiple paused-target initializers matched ${targetInfo.url}`);
        for (const initializer of matches) {
          initializer.state = "claimed";
          initializer.matchCount += 1;
          initializer.claimedAt = isoNow();
          initializer.claimedTargetSequence = sequence;
          initializer.claimedSessionId = sessionId;
          completeInitializer(initializer, "failed", Object.freeze({
            kind: "controlled-paused-target-initializer",
            id: initializer.id,
            passed: false,
            targetSequence: sequence,
            sessionId,
            targetId: record.targetId,
            targetType: record.type,
            targetUrl: record.url,
            waitingForDebugger: record.waitingForDebugger,
            startedAt: null,
            completedAt: isoNow(),
            resumedAt: null,
            expressionSha256: initializer.expressionSha256,
            result: null,
            error: claimError.message,
          }), claimError.message);
          initializer.completionResolved = true;
          initializer.resolve(initializer.receipt);
        }
      } else if (matches.length === 1) {
        claimedInitializer = matches[0];
        claimedInitializer.state = "claimed";
        claimedInitializer.matchCount += 1;
        claimedInitializer.claimedAt = isoNow();
        claimedInitializer.claimedTargetSequence = sequence;
        claimedInitializer.claimedSessionId = sessionId;
        record.initializerId = claimedInitializer.id;
      }
    }
    const task = (async () => {
      let taskError = null;
      try {
        if (!record.waitingForDebugger) {
          throw new Error(`Auto-attached target ${record.targetId || sessionId} was not waiting for debugger`);
        }
        if (claimError) throw claimError;
        if (diagnosticTargetTypes.has(targetInfo.type)) {
          const domainCapabilities = CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES[targetInfo.type];
          if (domainCapabilities.runtime) await cdp.send("Runtime.enable", {}, sessionId);
          if (domainCapabilities.network) await cdp.send("Network.enable", {}, sessionId);
          if (domainCapabilities.fetch) {
            await cdp.send("Fetch.enable", {
              patterns: [
                { urlPattern: "http://*/*", requestStage: "Request" },
                { urlPattern: "https://*/*", requestStage: "Request" },
              ],
            }, sessionId);
          }
          await cdp.send("Runtime.addBinding", { name: DIAGNOSTIC_BINDING }, sessionId);
          const bootstrap = await cdp.send("Runtime.evaluate", {
            expression: workerDiagnosticBootstrapSource(targetInfo.targetId ?? null),
          }, sessionId);
          if (bootstrap.result?.exceptionDetails) {
            throw new Error(bootstrap.result.exceptionDetails.text || "Worker diagnostics bootstrap failed");
          }
          record.initializedAt = isoNow();
          if (claimedInitializer) {
            const initializer = claimedInitializer;
            record.initializerStartedAt = isoNow();
            let initializerResult = null;
            let initializerError = null;
            try {
              const outcome = await waitWithCancelableTimeout(cdp.send("Runtime.evaluate", {
                expression: initializer.expression,
                awaitPromise: true,
                returnByValue: true,
              }, sessionId), initializer.timeoutMs);
              if (outcome.timedOut) throw new Error(`Paused-target initializer ${initializer.id} timed out`);
              if (outcome.value?.result?.exceptionDetails) {
                throw new Error(
                  outcome.value.result.exceptionDetails.text
                    || `Paused-target initializer ${initializer.id} failed`,
                );
              }
              initializerResult = stableObject(outcome.value?.result?.result?.value ?? null);
              record.initializerCompletedAt = isoNow();
            } catch (error) {
              initializerError = error instanceof Error ? error.message : String(error);
              record.initializerCompletedAt = isoNow();
            }
            const receipt = Object.freeze({
              kind: "controlled-paused-target-initializer",
              id: initializer.id,
              passed: initializerError === null,
              targetSequence: sequence,
              sessionId,
              targetId: record.targetId,
              targetType: record.type,
              targetUrl: record.url,
              waitingForDebugger: record.waitingForDebugger,
              startedAt: record.initializerStartedAt,
              completedAt: record.initializerCompletedAt,
              resumedAt: null,
              expressionSha256: initializer.expressionSha256,
              result: initializerResult,
              error: initializerError,
            });
            completeInitializer(
              initializer,
              initializerError === null ? "consumed" : "failed",
              receipt,
              initializerError,
            );
            if (initializerError !== null) throw new Error(initializerError);
          }
        }
      } catch (error) {
        if (claimedInitializer && claimedInitializer.receipt === null) {
          const initializerError = error instanceof Error ? error.message : String(error);
          record.initializerCompletedAt = isoNow();
          completeInitializer(claimedInitializer, "failed", Object.freeze({
            kind: "controlled-paused-target-initializer",
            id: claimedInitializer.id,
            passed: false,
            targetSequence: sequence,
            sessionId,
            targetId: record.targetId,
            targetType: record.type,
            targetUrl: record.url,
            waitingForDebugger: record.waitingForDebugger,
            startedAt: record.initializerStartedAt,
            completedAt: record.initializerCompletedAt,
            resumedAt: null,
            expressionSha256: claimedInitializer.expressionSha256,
            result: null,
            error: initializerError,
          }), initializerError);
        }
        fail(record, error);
        taskError = error;
      }
      try {
        record.resumeAttemptCount += 1;
        record.resumeAttemptedAt = isoNow();
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId, false);
        record.resumedAt = isoNow();
      } catch (error) {
        fail(record, error);
        taskError ??= error;
      }
      const initializer = record.initializerId ? initializers.get(record.initializerId) : null;
      if (initializer?.receipt && !initializer.completionResolved) {
        const resumeError = record.resumedAt === null
          ? "Target did not resume after paused-target initializer"
          : initializer.receipt.error;
        initializer.receipt = Object.freeze({
          ...initializer.receipt,
          passed: initializer.receipt.passed === true && record.resumedAt !== null,
          resumedAt: record.resumedAt,
          error: resumeError,
        });
        if (record.resumedAt === null) {
          initializer.state = "failed";
          initializer.error = resumeError;
        }
        initializer.completionResolved = true;
        initializer.resolve(initializer.receipt);
      }
      if (taskError) throw taskError;
    })().finally(() => pending.delete(task));
    pending.add(task);
    return task;
  });
  const removeDetached = cdp.on("Target.detachedFromTarget", (params) => {
    const record = targets.get(params?.sessionId);
    if (record) record.detachedAt = isoNow();
  });
  const snapshot = () => {
    const targetRecords = [...targets.values()];
    const missingInitialization = targetRecords.filter((record) => (
      diagnosticTargetTypes.has(record.type) && record.initializedAt === null
    ));
    const invalidResume = targetRecords.filter((record) => (
      record.waitingForDebugger !== true
      || record.resumeAttemptCount !== 1
      || record.resumedAt === null
    ));
    const initializerRecords = [...initializers.values()];
    const incompleteInitializers = initializerRecords.filter((record) => record.state !== "consumed");
    const invalidInitializers = initializerRecords.filter((record) => (
      record.state !== "consumed"
      || record.matchCount !== 1
      || record.receipt?.passed !== true
      || record.receipt?.resumedAt === null
    ));
    return Object.freeze({
      passed: pending.size === 0
        && failures.length === 0
        && missingInitialization.length === 0
        && invalidResume.length === 0
        && invalidInitializers.length === 0,
      pendingCount: pending.size,
      failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
      missingInitialization: Object.freeze(missingInitialization.map((record) => Object.freeze({
        sessionId: record.sessionId,
        targetId: record.targetId,
        type: record.type,
      }))),
      invalidResume: Object.freeze(invalidResume.map((record) => Object.freeze({
        sessionId: record.sessionId,
        targetId: record.targetId,
        type: record.type,
        waitingForDebugger: record.waitingForDebugger,
        resumeAttemptCount: record.resumeAttemptCount,
        resumedAt: record.resumedAt,
      }))),
      initializers: Object.freeze(initializerRecords.map(initializerSnapshot)),
      incompleteInitializers: Object.freeze(incompleteInitializers.map(initializerSnapshot)),
      invalidInitializers: Object.freeze(invalidInitializers.map(initializerSnapshot)),
      barriers: Object.freeze(barriers.map((barrier) => Object.freeze({ ...barrier }))),
      targets: Object.freeze(targetRecords.map((record) => Object.freeze({ ...record }))),
    });
  };
  return Object.freeze({
    registerPausedTargetInitializer(specification) {
      if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
        throw new TypeError("paused-target initializer specification must be an object");
      }
      const allowed = new Set(["id", "targetType", "targetUrl", "expression", "timeoutMs"]);
      const unknown = Object.keys(specification).filter((key) => !allowed.has(key));
      if (unknown.length > 0) throw new Error(`Unknown paused-target initializer option: ${unknown.join(", ")}`);
      const id = String(specification.id || "");
      const targetType = String(specification.targetType || "");
      const targetUrl = String(specification.targetUrl || "");
      const expression = String(specification.expression || "");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        throw new Error("paused-target initializer id must be a stable lowercase identifier");
      }
      if (initializers.has(id)) throw new Error(`Duplicate paused-target initializer id: ${id}`);
      if (!diagnosticTargetTypes.has(targetType)) {
        throw new Error(`paused-target initializer type must be a controlled worker type: ${targetType}`);
      }
      if (!targetUrl || (managedOrigin && !controlledManagedUrlAllowed(targetUrl, managedOrigin))) {
        throw new Error(`paused-target initializer targetUrl must belong to the managed origin: ${targetUrl}`);
      }
      if (!expression.trim()) throw new Error("paused-target initializer expression is required");
      const timeout = positiveInteger(specification.timeoutMs ?? 2_000, "initializer timeoutMs", 1, 60_000);
      let resolve;
      const completion = new Promise((completionResolve) => { resolve = completionResolve; });
      const record = {
        id,
        targetType,
        targetUrl,
        expression,
        expressionSha256: sha256(expression),
        timeoutMs: timeout,
        armedAt: isoNow(),
        armedAfterTargetSequence: targetSequence,
        claimedAt: null,
        claimedTargetSequence: null,
        claimedSessionId: null,
        state: "armed",
        matchCount: 0,
        receipt: null,
        error: null,
        completion,
        completionResolved: false,
        resolve,
      };
      initializers.set(id, record);
      return Object.freeze({
        id,
        snapshot: () => initializerSnapshot(record),
        async waitForReceipt(waitTimeoutMs = timeout) {
          const outcome = await waitWithCancelableTimeout(
            completion,
            positiveInteger(waitTimeoutMs, "initializer wait timeoutMs", 1, 60_000),
          );
          if (outcome.timedOut) {
            throw new Error(`Timed out waiting for paused-target initializer ${id}`);
          }
          return initializerSnapshot(record);
        },
        assertConsumedExactlyOnce() {
          const current = initializerSnapshot(record);
          if (current.state !== "consumed"
            || current.matchCount !== 1
            || current.receipt?.passed !== true
            || current.receipt?.waitingForDebugger !== true
            || current.receipt?.resumedAt === null) {
            throw new Error(`Paused-target initializer was not consumed exactly once: ${JSON.stringify(current)}`);
          }
          return current;
        },
      });
    },
    async settle(timeoutMs = 2_000) {
      const parsedTimeoutMs = positiveInteger(timeoutMs, "worker diagnostics settle timeoutMs", 1, 60_000);
      const deadline = Date.now() + parsedTimeoutMs;
      while (pending.size > 0 && Date.now() <= deadline) {
        await waitWithCancelableTimeout(Promise.allSettled([...pending]), Math.min(250, parsedTimeoutMs));
      }
      return snapshot();
    },
    assertHealthy() {
      const current = snapshot();
      if (!current.passed) {
        throw new Error(`Worker diagnostics initialization is incomplete: ${JSON.stringify(current)}`);
      }
    },
    async barrier(timeoutMs = 2_000) {
      await this.settle(timeoutMs);
      const receipts = [];
      for (const record of targets.values()) {
        if (!diagnosticTargetTypes.has(record.type)
          || record.detachedAt !== null
          || record.initializedAt === null) continue;
        const startedAt = isoNow();
        let completedAt = null;
        let errorMessage = null;
        try {
          const outcome = await waitWithCancelableTimeout(cdp.send("Runtime.evaluate", {
            expression: "({ controlledWorkerDiagnosticsBarrier: true })",
            returnByValue: true,
          }, record.sessionId, false), timeoutMs);
          if (outcome.timedOut) throw new Error("Worker diagnostics barrier timed out");
          if (outcome.value?.result?.exceptionDetails) {
            throw new Error(
              outcome.value.result.exceptionDetails.text || "Worker diagnostics barrier failed",
            );
          }
          completedAt = isoNow();
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
          fail(record, error);
        }
        const receipt = Object.freeze({
          sessionId: record.sessionId,
          targetId: record.targetId,
          type: record.type,
          startedAt,
          completedAt,
          completed: completedAt !== null,
          error: errorMessage,
        });
        barriers.push(receipt);
        receipts.push(receipt);
      }
      return Object.freeze({
        passed: receipts.every((receipt) => receipt.completed) && snapshot().passed,
        receipts: Object.freeze(receipts),
      });
    },
    snapshot,
    dispose() {
      removeAttached();
      removeDetached();
    },
  });
}

async function launchOwnedBrowser(
  configuration,
  chromePath,
  toolchain,
  profileDirectory,
  managedUrl,
  launchState,
  runId,
) {
  const diagnostics = createControlledDiagnosticsAggregator();
  const drawingWorkerPaths = Object.freeze(
    launchState.buildReceipt.assetFingerprint.files
      .map((file) => file.path)
      .filter((relativePath) => /^assets\/drawing\.worker(?:-[^/]+)?\.js$/.test(relativePath)),
  );
  if (drawingWorkerPaths.length !== 1) {
    throw new Error("Controlled browser requires exactly one manifest drawing worker asset");
  }
  const rollbackAuthorityToken = randomUUID();
  const rollbackAuthorityTokenSha256 = sha256(rollbackAuthorityToken);
  const rollbackAuthority = Object.freeze({
    runId,
    authorityTokenSha256: rollbackAuthorityTokenSha256,
    drawingWorkerPaths,
    drillIds: CONTROLLED_ROLLBACK_DRILL_IDS,
    storageVariants: CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS,
  });
  let rollbackSequence = 0;
  let activeRollbackNavigation = null;
  let activeQuotaFault = null;
  let activeBlockedFault = null;
  let storageFaultCleanupReceipt = null;
  let cleanupControlledStorageFaults = async () => Object.freeze({
    complete: true,
    forced: false,
    quota: null,
    blocked: null,
  });
  const chromeArguments = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--window-size=${configuration.viewport.width},${configuration.viewport.height}`,
    "about:blank",
  ];
  if (chromeArguments.some((argument) => argument.startsWith("--headless"))) {
    throw new Error("Controlled Chrome launch contract forbids headless arguments");
  }
  const chrome = spawn(chromePath, chromeArguments, {
    env: controlledHostProcessEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  const output = createOutputTail(chrome);
  const lifecycle = createProcessLifecycle("headed-chrome", chrome, {
    executable: chromePath,
    arguments: chromeArguments,
    debugHost: "127.0.0.1",
    debugPort: null,
    devToolsActivePort: null,
    executableFingerprint: toolchain.browser,
    profileOwnership: "controlled-temporary-profile",
    windowsHide: false,
  });
  let browserCloseRequestedAt = null;
  lifecycle.exitPromise.then(() => {
    const cleanRequestedExit = browserCloseRequestedAt !== null
      && lifecycle.exitCode === 0
      && lifecycle.signal === null;
    if (!cleanRequestedExit && lifecycle.stopRequestedAt === null) {
      diagnostics.recordBrowserProcessCrash(processLifecycleSnapshot(lifecycle, output()));
    }
  });
  let cdp = null;
  let originGuard = null;
  let assetTracker = null;
  let workerDiagnostics = null;
  let finalization = null;
  let finalizePromise = null;
  const snapshot = () => Object.freeze({
    ...processLifecycleSnapshot(lifecycle, output()),
    diagnosticsBarrier: finalization?.diagnosticsBarrier ?? null,
    workerDiagnosticsBarrier: finalization?.workerDiagnosticsBarrier ?? null,
    handlerSettlementBeforeClose: finalization?.handlerSettlementBeforeClose ?? null,
    handlerSettlementAfterClose: finalization?.handlerSettlementAfterClose ?? null,
    browserCloseReceipt: finalization?.browserCloseReceipt ?? null,
    finalizationErrors: finalization?.finalizationErrors ?? Object.freeze([]),
    diagnosticsClosed: finalization?.diagnosticsClosed === true,
    cdpClosure: finalization?.cdpClosure ?? null,
    finalDiagnostics: finalization?.finalDiagnostics ?? null,
    finalWorkerDiagnostics: finalization?.finalWorkerDiagnostics ?? null,
    finalOriginGuard: finalization?.finalOriginGuard ?? null,
    storageFaultCleanup: finalization?.storageFaultCleanup ?? storageFaultCleanupReceipt,
  });
  const finalize = () => {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
      const finalizationErrors = [];
      try {
        storageFaultCleanupReceipt = await cleanupControlledStorageFaults("browser-finalize");
        if (storageFaultCleanupReceipt?.complete !== true) {
          finalizationErrors.push("storage-fault-cleanup-incomplete");
        }
      } catch (error) {
        finalizationErrors.push(`storage-fault-cleanup:${error instanceof Error ? error.message : error}`);
      }
      let workerDiagnosticsBarrier = Object.freeze({
        passed: false,
        receipts: Object.freeze([]),
        error: "worker-diagnostics-unavailable",
      });
      try {
        if (workerDiagnostics) workerDiagnosticsBarrier = await workerDiagnostics.barrier(2_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalizationErrors.push(`worker-barrier:${message}`);
        workerDiagnosticsBarrier = Object.freeze({
          passed: false,
          receipts: Object.freeze([]),
          error: message,
        });
      }
      const barrierStartedAt = isoNow();
      let barrierError = null;
      let barrierCompletedAt = null;
      try {
        const barrierOutcome = await waitWithCancelableTimeout(
          cdp.send("Runtime.evaluate", {
            expression: "({ controlledCdpBarrier: true })",
            returnByValue: true,
          }, null, false),
          2_000,
        );
        if (barrierOutcome.timedOut) throw new Error("CDP diagnostics barrier timed out");
        barrierCompletedAt = isoNow();
      } catch (error) {
        barrierError = error instanceof Error ? error.message : String(error);
      }
      const diagnosticsBarrier = Object.freeze({
        startedAt: barrierStartedAt,
        completedAt: barrierCompletedAt,
        completed: barrierCompletedAt !== null,
        error: barrierError,
      });
      let handlerSettlementBeforeClose = Object.freeze({ passed: false, error: "cdp-unavailable" });
      try {
        handlerSettlementBeforeClose = await cdp.settleHandlers(2_000);
      } catch (error) {
        finalizationErrors.push(`handlers-before-close:${error instanceof Error ? error.message : error}`);
      }
      const closeState = {
        kind: "controlled-browser-close",
        schemaVersion: "candlescope-controlled-browser-close/v1",
        requestedAt: null,
        commandDispatchedAt: null,
        transportAccepted: false,
        commandSettledAt: null,
        commandCompleted: false,
        commandTimedOut: false,
        commandError: null,
        commandTerminalCause: null,
        processWasRunningAtRequest: lifecycle.stoppedAt === null,
        processExitedAt: null,
        processExitCode: null,
        processSignal: null,
        processExitedAfterRequest: false,
        gracefulProcessExit: false,
        forceTerminationUsed: false,
        descendantTerminationUsed: false,
        descendantExitGrace: null,
        remoteCdpClosedAfterRequest: false,
        remoteCdpClosedAt: null,
        localCdpFallbackUsed: false,
        acceptedCloseRace: false,
        passed: false,
      };
      browserCloseRequestedAt = isoNow();
      closeState.requestedAt = browserCloseRequestedAt;
      try {
        const closeOutcome = await waitWithCancelableTimeout(
          cdp.send("Browser.close", {}, null, false, (dispatchReceipt) => {
            closeState.transportAccepted = true;
            closeState.commandDispatchedAt = dispatchReceipt.dispatchedAt;
          }),
          2_000,
        );
        closeState.commandTimedOut = closeOutcome.timedOut;
        closeState.commandCompleted = !closeOutcome.timedOut;
        closeState.commandSettledAt = isoNow();
      } catch (error) {
        closeState.commandError = error instanceof Error ? error.message : String(error);
        closeState.commandTerminalCause = error?.controlledCdpTerminalCause ?? null;
        closeState.commandSettledAt = isoNow();
      }
      try {
        closeState.gracefulProcessExit = closeState.processWasRunningAtRequest
          && await waitForLifecycleExit(lifecycle, 2_000);
      } catch (error) {
        finalizationErrors.push(`browser-graceful-exit:${error instanceof Error ? error.message : error}`);
      }
      if (closeState.gracefulProcessExit) {
        closeState.descendantExitGrace = await waitForWindowsDescendantsQuiet(
          chrome.pid,
          toolchain,
        );
      } else {
        closeState.descendantExitGrace = Object.freeze({
          kind: "windows-descendant-exit-grace",
          schemaVersion: "candlescope-windows-descendant-exit-grace/v1",
          supported: process.platform === "win32",
          passed: false,
          rootPid: chrome.pid,
          observations: Object.freeze([]),
          error: "browser-root-did-not-exit-gracefully",
        });
      }
      try {
        await stopOwnedProcess(chrome, lifecycle, 5_000, toolchain);
      } catch (error) {
        finalizationErrors.push(`browser-tree-cleanup:${error instanceof Error ? error.message : error}`);
      }
      closeState.processExitedAt = lifecycle.stoppedAt;
      closeState.processExitCode = lifecycle.exitCode;
      closeState.processSignal = lifecycle.signal;
      closeState.processExitedAfterRequest = closeState.processWasRunningAtRequest
        && lifecycle.stoppedAt !== null;
      closeState.forceTerminationUsed = lifecycle.forceStopRequestedAt !== null;
      closeState.descendantTerminationUsed = (
        lifecycle.treeStopReceipt?.descendantCensus?.terminationReceipts?.length ?? 0
      ) > 0;
      let remoteCdpClosure = Object.freeze({
        closed: false,
        timedOut: true,
        event: null,
        terminalCause: null,
      });
      let localCdpClosure = null;
      try {
        remoteCdpClosure = await cdp.waitForClose(2_000);
        if (!remoteCdpClosure.closed) {
          closeState.localCdpFallbackUsed = true;
          localCdpClosure = await cdp.close(2_000);
        }
      } catch (error) {
        finalizationErrors.push(`cdp-close:${error instanceof Error ? error.message : error}`);
      }
      const cdpClosedAt = remoteCdpClosure?.event?.observedAt ?? null;
      closeState.remoteCdpClosedAt = cdpClosedAt;
      closeState.remoteCdpClosedAfterRequest = remoteCdpClosure?.closed === true
        && validReceiptTimestamp(cdpClosedAt)
        && validReceiptTimestamp(closeState.commandDispatchedAt)
        && Date.parse(cdpClosedAt) >= Date.parse(closeState.commandDispatchedAt);
      const commandTerminalCauseAt = closeState.commandTerminalCause?.observedAt ?? null;
      const commandTerminalRace = closeState.remoteCdpClosedAfterRequest
        && closeState.commandCompleted === false
        && (
          (closeState.commandTimedOut === true && closeState.commandError === null)
          || (closeState.commandTimedOut === false
            && controlledCdpTerminalCauseErrorMessage(closeState.commandTerminalCause)
              === closeState.commandError
            && validReceiptTimestamp(commandTerminalCauseAt)
            && Date.parse(commandTerminalCauseAt) >= Date.parse(closeState.commandDispatchedAt))
        );
      closeState.acceptedCloseRace = closeState.transportAccepted && (
        (closeState.commandCompleted
          && !closeState.commandTimedOut
          && closeState.commandError === null)
        || commandTerminalRace
      );
      const cdpClosure = Object.freeze({
        closed: remoteCdpClosure.closed === true || localCdpClosure?.closed === true,
        remote: remoteCdpClosure,
        localFallbackUsed: closeState.localCdpFallbackUsed,
        local: localCdpClosure,
      });
      closeState.passed = assessControlledBrowserCloseEvidence({
        pid: lifecycle.pid,
        exited: lifecycle.stoppedAt !== null,
        stoppedAt: lifecycle.stoppedAt,
        exitCode: lifecycle.exitCode,
        signal: lifecycle.signal,
        forceStopRequestedAt: lifecycle.forceStopRequestedAt,
        treeStopReceipt: lifecycle.treeStopReceipt,
        diagnosticsClosed: cdpClosure.closed === true,
        cdpClosure,
        browserCloseReceipt: { ...closeState, passed: true },
      }).valid;
      const browserCloseReceipt = Object.freeze({ ...closeState });
      let handlerSettlementAfterClose = Object.freeze({ passed: false, error: "cdp-unavailable" });
      try {
        handlerSettlementAfterClose = await cdp.settleHandlers(2_000);
      } catch (error) {
        finalizationErrors.push(`handlers-after-close:${error instanceof Error ? error.message : error}`);
      }
      finalization = Object.freeze({
        diagnosticsBarrier,
        workerDiagnosticsBarrier,
        handlerSettlementBeforeClose,
        handlerSettlementAfterClose,
        browserCloseReceipt,
        finalizationErrors: Object.freeze(finalizationErrors),
        diagnosticsClosed: cdpClosure.closed === true,
        cdpClosure,
        finalDiagnostics: diagnostics.snapshot(),
        finalWorkerDiagnostics: workerDiagnostics?.snapshot() ?? null,
        finalOriginGuard: originGuard?.snapshot() ?? null,
        storageFaultCleanup: storageFaultCleanupReceipt,
      });
      assetTracker?.dispose();
      originGuard?.dispose();
      workerDiagnostics?.dispose();
      return snapshot();
    })();
    return finalizePromise;
  };
  try {
    const devToolsActivePort = await waitForOwnedDevToolsPort(profileDirectory, configuration.timeoutMs);
    const debugPort = devToolsActivePort.port;
    launchState.debugPort = debugPort;
    lifecycle.details.debugPort = debugPort;
    lifecycle.details.devToolsActivePort = devToolsActivePort;
    const target = await waitForDebugTarget(debugPort, configuration.timeoutMs);
    cdp = await connectOwnedCdp(target.webSocketDebuggerUrl, debugPort, configuration.timeoutMs, diagnostics);
    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Page.enable"),
      cdp.send("Network.enable"),
      cdp.send("Inspector.enable"),
      cdp.send("Target.setDiscoverTargets", { discover: true }),
    ]);
    await Promise.all([
      cdp.send("Network.setCacheDisabled", { cacheDisabled: true }),
      cdp.send("Network.setBypassServiceWorker", { bypass: true }),
    ]);
    workerDiagnostics = createControlledWorkerDiagnosticsController(cdp, new URL(managedUrl).origin);
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await cdp.send("Runtime.addBinding", { name: DIAGNOSTIC_BINDING });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: diagnosticBootstrapSource({
        runId,
        authorityToken: rollbackAuthorityToken,
        authorityTokenSha256: rollbackAuthorityTokenSha256,
        drawingWorkerPaths,
      }),
    });
    originGuard = await createManagedOriginGuard(cdp, managedUrl, drawingWorkerPaths);
    const frameTree = (await cdp.send("Page.getFrameTree")).result?.frameTree;
    const mainFrameId = frameTree?.frame?.id;
    if (typeof mainFrameId !== "string" || !mainFrameId) {
      throw new Error("Owned Chrome did not expose its main frame identity");
    }
    assetTracker = createControlledNetworkAssetTracker(
      cdp,
      new URL(managedUrl).origin,
      launchState.buildReceipt,
      configuration.timeoutMs,
      mainFrameId,
      rollbackAuthority,
      originGuard.claimWorkerResponseBodyCapture,
    );
    const browserVersion = (await cdp.send("Browser.getVersion")).result || {};
    if (!/^(?:Chrome|Chromium|Edg)\/[0-9.]+$/.test(String(browserVersion.product || ""))) {
      throw new Error(`Owned browser product is not Chrome/Edge: ${browserVersion.product || "unknown"}`);
    }
    if (/headless/i.test(String(browserVersion.product || ""))
      || /headless/i.test(String(browserVersion.userAgent || ""))) {
      throw new Error("Owned browser identified itself as headless");
    }
    const windowId = (await cdp.send("Browser.getWindowForTarget", { targetId: target.id })).result?.windowId;
    await setControlledDeviceMetrics(
      cdp,
      windowId,
      browserVersion,
      configuration.viewport,
      configuration.dpr,
    );
    await cdp.send("Page.navigate", { url: managedUrl });
    await waitForDocumentReady(cdp, new URL(managedUrl).origin, configuration.timeoutMs);
    const windowEvidence = await setControlledDeviceMetrics(
      cdp,
      windowId,
      browserVersion,
      configuration.viewport,
      configuration.dpr,
    );
    const navigateRollbackDrill = async (drillId, { variant = null } = {}) => {
      if (activeRollbackNavigation?.drillId === "indexeddb-quota-blocked") {
        throw new Error("Controlled IndexedDB rollback drill requires an exact managed cold reload before navigation");
      }
      if ((activeQuotaFault && (
        activeQuotaFault.overrideCleared !== true
        || activeQuotaFault.pageCleanupCompleted !== true
      )) || activeBlockedFault?.released === false) {
        throw new Error("Controlled storage rollback fault is still active");
      }
      if (!CONTROLLED_ROLLBACK_DRILL_IDS.includes(drillId)) {
        throw new Error(`Unknown controlled rollback drill: ${drillId}`);
      }
      const variantAccepted = drillId === "indexeddb-quota-blocked"
        ? CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS.includes(variant)
        : variant === null;
      if (!variantAccepted) {
        throw new Error(`Controlled rollback drill variant is invalid: ${drillId}:${variant}`);
      }
      rollbackSequence += 1;
      const sequence = rollbackSequence;
      const faultId = randomUUID();
      const token = Object.freeze({
        runId,
        authorityToken: rollbackAuthorityToken,
        authorityTokenSha256: rollbackAuthorityTokenSha256,
        drillId,
        variant,
        faultId,
        sequence,
      });
      const armedAt = isoNow();
      const armed = await evaluateJson(cdp, `(() => {
        const key = ${JSON.stringify(CONTROLLED_ROLLBACK_SESSION_KEY)};
        if (sessionStorage.getItem(key) !== null) return { armed: false, reason: 'token-already-present' };
        const value = ${JSON.stringify(JSON.stringify(token))};
        sessionStorage.setItem(key, value);
        return {
          armed: sessionStorage.getItem(key) === value,
          origin: location.origin,
          href: location.href
        };
      })()`);
      if (armed?.armed !== true || armed.origin !== new URL(managedUrl).origin) {
        throw new Error(`Controlled rollback drill token could not be armed: ${JSON.stringify(armed)}`);
      }
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitForDocumentReady(cdp, new URL(managedUrl).origin, configuration.timeoutMs);
      const bootstrap = await evaluateJson(cdp, `(() => {
        const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
        return handle && typeof handle.snapshot === 'function' ? handle.snapshot() : null;
      })()`);
      if (bootstrap?.authorityAccepted !== true
        || bootstrap?.tokenRemoved !== true
        || bootstrap?.runId !== runId
        || bootstrap?.authorityTokenSha256 !== rollbackAuthorityTokenSha256
        || bootstrap?.drillId !== drillId
        || bootstrap?.variant !== variant
        || bootstrap?.faultId !== faultId
        || bootstrap?.sequence !== sequence) {
        throw new Error(`Controlled rollback drill bootstrap rejected authority: ${JSON.stringify(bootstrap)}`);
      }
      const receipt = Object.freeze({
        kind: "controlled-rollback-drill-navigation",
        runId,
        authorityTokenSha256: rollbackAuthorityTokenSha256,
        drillId,
        variant,
        faultId,
        sequence,
        armedAt,
        loadedAt: isoNow(),
        bootstrap: Object.freeze({ ...bootstrap }),
      });
      activeRollbackNavigation = receipt;
      if (drillId === "indexeddb-quota-blocked" && variant === "quota") {
        activeQuotaFault = null;
      }
      if (drillId === "indexeddb-quota-blocked" && variant === "blocked") {
        activeBlockedFault = null;
      }
      return receipt;
    };
    const assertStorageFaultAuthority = (variant, faultId, transactionId) => {
      if (!CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS.includes(variant)
        || typeof transactionId !== "string"
        || !transactionId.trim()
        || activeRollbackNavigation?.runId !== runId
        || activeRollbackNavigation?.authorityTokenSha256 !== rollbackAuthorityTokenSha256
        || activeRollbackNavigation?.drillId !== "indexeddb-quota-blocked"
        || activeRollbackNavigation?.variant !== variant
        || activeRollbackNavigation?.faultId !== faultId) {
        throw new Error(`Controlled IndexedDB ${variant} authority binding is invalid`);
      }
      return Object.freeze({
        runId,
        faultId,
        authorityTokenSha256: rollbackAuthorityTokenSha256,
        variant,
        transactionId,
        sequence: activeRollbackNavigation.sequence,
      });
    };
    const readUsageAndQuota = async (origin) => {
      const response = await cdp.send("Storage.getUsageAndQuota", { origin });
      return Object.freeze({
        method: "Storage.getUsageAndQuota",
        origin,
        usageBytes: response.result?.usage ?? null,
        quotaBytes: response.result?.quota ?? null,
        overrideActive: response.result?.overrideActive === true,
        observedAt: isoNow(),
      });
    };
    const prepareIndexedDbQuotaFault = async ({ faultId, transactionId } = {}) => {
      const binding = assertStorageFaultAuthority("quota", faultId, transactionId);
      if (activeQuotaFault !== null) {
        throw new Error("Controlled IndexedDB quota fault is one-shot");
      }
      const origin = new URL(managedUrl).origin;
      const receiptId = randomUUID();
      return prepareControlledQuotaOverride({
        binding,
        receiptId,
        origin,
        overrideQuota: (parameters) => cdp.send("Storage.overrideQuotaForOrigin", parameters),
        readUsageAndQuota,
        evaluatePreparation: (expectedFaultId) => evaluateJson(cdp, `(() => {
          const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
          if (!handle || typeof handle.prepareQuotaFault !== 'function') {
            throw new Error('controlled quota IndexedDB preparation handle is unavailable');
          }
          return handle.prepareQuotaFault(${JSON.stringify(expectedFaultId)});
        })()`),
        evaluateProbe: (expectedFaultId) => evaluateJson(cdp, `(() => {
          const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
          if (!handle || typeof handle.probeQuotaFault !== 'function') {
            throw new Error('controlled quota IndexedDB probe handle is unavailable');
          }
          return handle.probeQuotaFault(${JSON.stringify(expectedFaultId)});
        })()`),
        evaluateCleanup: (expectedFaultId, forcedCleanup) => evaluateJson(cdp, `(() => {
          const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
          if (!handle || typeof handle.cleanupQuotaFault !== 'function') {
            throw new Error('controlled quota IndexedDB cleanup handle is unavailable');
          }
          return handle.cleanupQuotaFault(
            ${JSON.stringify(expectedFaultId)},
            ${JSON.stringify(forcedCleanup)}
          );
        })()`),
        publish: (state) => { activeQuotaFault = state; },
      });
    };
    const releaseIndexedDbQuotaFault = async ({ faultId, transactionId } = {}) => {
      const binding = assertStorageFaultAuthority("quota", faultId, transactionId);
      if (!activeQuotaFault
        || activeQuotaFault.receiptId === null
        || activeQuotaFault.prepared !== true
        || activeQuotaFault.overrideActive !== true
        || activeQuotaFault.overrideCleared !== false
        || activeQuotaFault.pageCleanupCompleted !== false
        || activeQuotaFault.transactionId !== binding.transactionId) {
        throw new Error("Controlled IndexedDB quota fault cannot be released");
      }
      return releaseControlledQuotaOverride(activeQuotaFault, {
        overrideQuota: (parameters) => cdp.send("Storage.overrideQuotaForOrigin", parameters),
        evaluateCleanup: (expectedFaultId, forcedCleanup) => evaluateJson(cdp, `(() => {
          const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
          if (!handle || typeof handle.cleanupQuotaFault !== 'function') {
            throw new Error('controlled quota IndexedDB cleanup handle is unavailable');
          }
          return handle.cleanupQuotaFault(
            ${JSON.stringify(expectedFaultId)},
            ${JSON.stringify(forcedCleanup)}
          );
        })()`),
        readUsageAndQuota,
        publish: (state) => { activeQuotaFault = state; },
      });
    };
    const prepareIndexedDbBlockedFault = async ({ faultId, transactionId } = {}) => {
      const binding = assertStorageFaultAuthority("blocked", faultId, transactionId);
      if (activeBlockedFault !== null) {
        throw new Error("Controlled IndexedDB blocked fault is one-shot");
      }
      return prepareControlledBlockedFault({
        binding,
        receiptId: randomUUID(),
        evaluatePreparation: (expectedFaultId) => evaluateJson(cdp, `(() => {
          const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
          if (!handle || typeof handle.prepareBlockedFault !== 'function') {
            throw new Error('controlled blocked IndexedDB handle is unavailable');
          }
          return handle.prepareBlockedFault(${JSON.stringify(expectedFaultId)});
        })()`),
        publish: (state) => { activeBlockedFault = state; },
      });
    };
    const releaseIndexedDbBlockedFault = async ({ faultId, transactionId } = {}) => {
      const binding = assertStorageFaultAuthority("blocked", faultId, transactionId);
      if (!activeBlockedFault
        || activeBlockedFault.prepared !== true
        || activeBlockedFault.released !== false
        || activeBlockedFault.transactionId !== binding.transactionId) {
        throw new Error("Controlled IndexedDB blocked fault cannot be released");
      }
      const snapshot = await evaluateJson(cdp, `(() => {
        const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
        if (!handle || typeof handle.releaseBlockedFault !== 'function') {
          throw new Error('controlled blocked IndexedDB release handle is unavailable');
        }
        return handle.releaseBlockedFault(${JSON.stringify(faultId)});
      })()`);
      if (snapshot?.runId !== runId
        || snapshot?.faultId !== faultId
        || snapshot?.variant !== "blocked"
        || snapshot?.storage?.blockedEvent?.isTrusted !== true
        || snapshot?.storage?.blockedRelease?.completed !== true
        || snapshot?.storage?.blockedRelease?.forcedCleanup === true) {
        throw new Error(`Controlled IndexedDB blocked release is invalid: ${JSON.stringify(snapshot)}`);
      }
      activeBlockedFault = {
        ...activeBlockedFault,
        released: true,
        snapshot,
      };
      return Object.freeze({ ...activeBlockedFault });
    };
    cleanupControlledStorageFaults = async (reason = "explicit-cleanup") => {
      let quota = null;
      let blocked = null;
      if (activeQuotaFault && (
        activeQuotaFault.overrideCleared !== true
        || activeQuotaFault.overrideResetRequired === true
        || activeQuotaFault.pageCleanupCompleted !== true
        || activeQuotaFault.restorationError !== null
        || !activeQuotaFault.restored
        || activeQuotaFault.restored?.quotaBytes !== activeQuotaFault.before?.quotaBytes
      )) {
        try {
          activeQuotaFault = await forceCleanupControlledQuotaOverride(activeQuotaFault, {
            overrideQuota: (parameters) => cdp.send("Storage.overrideQuotaForOrigin", parameters),
            evaluateCleanup: (expectedFaultId, forcedCleanup) => evaluateJson(cdp, `(() => {
              const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
              if (!handle || typeof handle.cleanupQuotaFault !== 'function') return null;
              return handle.cleanupQuotaFault(
                ${JSON.stringify(expectedFaultId)},
                ${JSON.stringify(forcedCleanup)}
              );
            })()`),
            readUsageAndQuota,
            publish: (state) => { activeQuotaFault = state; },
            reason,
          });
        } catch (error) {
          quota = Object.freeze({ complete: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (quota === null && activeQuotaFault) {
        quota = Object.freeze({
          complete: activeQuotaFault.overrideCleared === true
            && activeQuotaFault.overrideResetRequired === false
            && activeQuotaFault.pageCleanupCompleted === true
            && activeQuotaFault.restorationError === null
            && activeQuotaFault.restored?.overrideActive === false
            && activeQuotaFault.restored?.quotaBytes === activeQuotaFault.before?.quotaBytes,
          forced: activeQuotaFault.forcedCleanup === true,
          faultId: activeQuotaFault.faultId,
        });
      }
      if (activeBlockedFault?.released === false) {
        try {
          const cleanup = await forceCleanupControlledBlockedFault(activeBlockedFault, {
            evaluateCleanup: (expectedFaultId) => evaluateJson(cdp, `(() => {
              const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
              if (!handle || typeof handle.cleanupBlockedFault !== 'function') return null;
              return handle.cleanupBlockedFault(${JSON.stringify(expectedFaultId)});
            })()`),
            reason,
          });
          activeBlockedFault = cleanup.state;
          blocked = cleanup.receipt;
        } catch (error) {
          blocked = Object.freeze({ complete: false, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (activeBlockedFault) {
        blocked = Object.freeze({
          complete: activeBlockedFault.released === true,
          forced: activeBlockedFault.forcedCleanup === true,
          faultId: activeBlockedFault.faultId,
        });
      }
      const receipt = Object.freeze({
        complete: quota?.complete !== false && blocked?.complete !== false,
        forced: quota?.forced === true || blocked?.forced === true,
        reason,
        observedAt: isoNow(),
        quota,
        blocked,
      });
      storageFaultCleanupReceipt = receipt;
      return receipt;
    };
    const reloadManagedDocument = async ({ variant, faultId, transactionId } = {}) => {
      const binding = assertStorageFaultAuthority(variant, faultId, transactionId);
      const faultClean = variant === "quota"
        ? activeQuotaFault?.transactionId === transactionId
          && activeQuotaFault?.overrideCleared === true
          && activeQuotaFault?.overrideResetRequired === false
          && activeQuotaFault?.pageCleanupCompleted === true
          && activeQuotaFault?.releaseSnapshot?.storage?.quotaRelease?.completed === true
          && activeQuotaFault?.restored?.overrideActive === false
          && activeQuotaFault?.releaseAccepted === true
          && activeQuotaFault?.forcedCleanup !== true
        : activeBlockedFault?.transactionId === transactionId
          && activeBlockedFault?.released === true
          && activeBlockedFault?.forcedCleanup !== true;
      if (!faultClean) {
        throw new Error(`Controlled IndexedDB ${variant} fault must be explicitly cleaned before reload`);
      }
      const before = await evaluateJson(cdp, `(() => {
        const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
        return handle && typeof handle.snapshot === 'function' ? handle.snapshot() : null;
      })()`);
      if (before?.runId !== runId
        || before?.authorityTokenSha256 !== rollbackAuthorityTokenSha256
        || before?.authorityAccepted !== true
        || before?.tokenRemoved !== true
        || before?.armed !== true
        || before?.drillId !== "indexeddb-quota-blocked"
        || before?.variant !== variant
        || before?.faultId !== faultId
        || before?.sequence !== binding.sequence
        || typeof before?.documentInstanceId !== "string"
        || !before.documentInstanceId) {
        throw new Error(`Controlled reload source document identity is unavailable: ${JSON.stringify(before)}`);
      }
      const reloadedAt = isoNow();
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitForDocumentReady(cdp, new URL(managedUrl).origin, configuration.timeoutMs);
      const reloadDeadline = Date.now() + configuration.timeoutMs;
      let after = null;
      let locationAfter = null;
      while (Date.now() <= reloadDeadline) {
        try {
          const observed = await evaluateJson(cdp, `(() => {
            const handle = window[${JSON.stringify(CONTROLLED_ROLLBACK_HANDLE)}];
            return {
              bootstrap: handle && typeof handle.snapshot === 'function' ? handle.snapshot() : null,
              origin: location.origin,
              href: location.href,
              readyState: document.readyState
            };
          })()`);
          after = observed?.bootstrap ?? null;
          locationAfter = observed;
          if (after?.documentInstanceId !== before.documentInstanceId) break;
        } catch {
          // Reload can replace the execution context between identity polls.
        }
        await wait(50);
      }
      if (after?.runId !== runId
        || after?.authorityAccepted !== false
        || after?.tokenRemoved !== false
        || after?.armed !== false
        || after?.drillId !== null
        || after?.variant !== null
        || after?.faultId !== null
        || after?.sequence !== null
        || typeof after?.documentInstanceId !== "string"
        || !after.documentInstanceId
        || after.documentInstanceId === before.documentInstanceId
        || locationAfter?.origin !== new URL(managedUrl).origin
        || !controlledManagedDocumentUrlAllowed(locationAfter?.href || "", managedUrl)
        || locationAfter?.readyState !== "complete") {
        throw new Error(`Controlled reload document identity is invalid: ${JSON.stringify({ before, after, locationAfter })}`);
      }
      activeRollbackNavigation = null;
      return Object.freeze({
        kind: "controlled-managed-document-reload",
        runId,
        faultId,
        authorityTokenSha256: rollbackAuthorityTokenSha256,
        variant,
        transactionId,
        reloadedAt,
        loadedAt: isoNow(),
        beforeDocumentInstanceId: before.documentInstanceId,
        afterDocumentInstanceId: after.documentInstanceId,
        bootstrap: Object.freeze({ ...after }),
      });
    };
    lifecycle.readyAt = isoNow();
    return {
      browserVersion: Object.freeze(stableObject(browserVersion)),
      cdp,
      diagnostics,
      originGuard,
      assetTracker,
      workerDiagnostics,
      rollbackAuthority,
      navigateRollbackDrill,
      prepareIndexedDbQuotaFault,
      releaseIndexedDbQuotaFault,
      prepareIndexedDbBlockedFault,
      releaseIndexedDbBlockedFault,
      reloadManagedDocument,
      targetId: target.id,
      windowId,
      windowEvidence,
      snapshot,
      close: finalize,
    };
  } catch (error) {
    const finalizationErrors = [];
    let handlerSettlementBeforeClose = null;
    let handlerSettlementAfterClose = null;
    if (cdp) {
      try { handlerSettlementBeforeClose = await cdp.settleHandlers(1_000); } catch (settleError) {
        finalizationErrors.push(`handlers-before-startup-cleanup:${settleError instanceof Error ? settleError.message : settleError}`);
      }
    }
    try { await stopOwnedProcess(chrome, lifecycle, 5_000, toolchain); } catch (stopError) {
      finalizationErrors.push(`startup-tree-cleanup:${stopError instanceof Error ? stopError.message : stopError}`);
    }
    let cdpClosure = null;
    if (cdp) {
      try {
        cdpClosure = await cdp.waitForClose(1_000);
        if (!cdpClosure.closed) cdpClosure = await cdp.close(1_000);
      } catch (closeError) {
        finalizationErrors.push(`startup-cdp-close:${closeError instanceof Error ? closeError.message : closeError}`);
      }
      try { handlerSettlementAfterClose = await cdp.settleHandlers(1_000); } catch (settleError) {
        finalizationErrors.push(`handlers-after-startup-cleanup:${settleError instanceof Error ? settleError.message : settleError}`);
      }
    }
    try { await workerDiagnostics?.settle(1_000); } catch (settleError) {
      finalizationErrors.push(`worker-startup-cleanup:${settleError instanceof Error ? settleError.message : settleError}`);
    }
    finalization = Object.freeze({
      diagnosticsBarrier: null,
      workerDiagnosticsBarrier: null,
      handlerSettlementBeforeClose,
      handlerSettlementAfterClose,
      browserCloseReceipt: null,
      finalizationErrors: Object.freeze(finalizationErrors),
      diagnosticsClosed: cdp === null || cdpClosure?.closed === true,
      cdpClosure,
      finalDiagnostics: diagnostics.snapshot(),
      finalWorkerDiagnostics: workerDiagnostics?.snapshot() ?? null,
      finalOriginGuard: originGuard?.snapshot() ?? null,
    });
    assetTracker?.dispose();
    originGuard?.dispose();
    workerDiagnostics?.dispose();
    const browserReceipt = snapshot();
    const wrapped = new Error(`${error?.message || error}\nBrowser receipt:\n${JSON.stringify(browserReceipt)}`);
    wrapped.browserReceipt = browserReceipt;
    throw wrapped;
  }
}

async function removeOwnedProfile(profileDirectory, attempts = 8) {
  const resolved = path.resolve(profileDirectory);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith(OWNED_PROFILE_PREFIX)) {
    return Object.freeze({
      path: resolved,
      removed: false,
      attempts: 0,
      errors: Object.freeze(["profile-path-not-owned-by-controlled-runner"]),
    });
  }
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      if (!fs.existsSync(resolved)) {
        return Object.freeze({
          path: resolved,
          removed: true,
          attempts: attempt,
          errors: Object.freeze(errors),
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await wait(150 * attempt);
  }
  return Object.freeze({
    path: resolved,
    removed: !fs.existsSync(resolved),
    attempts,
    errors: Object.freeze(errors),
  });
}

function validReceiptTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function assessWindowsOwnedProcessTreeReceipt(receipt, expectedRootPid) {
  const violations = [];
  const require = (condition, violation) => {
    if (!condition) violations.push(violation);
  };
  require(receipt?.kind === "windows-owned-process-tree-cleanup", "tree-kind-invalid");
  require(
    receipt?.schemaVersion === "candlescope-windows-owned-process-tree-cleanup/v1",
    "tree-schema-invalid",
  );
  require(Number.isSafeInteger(expectedRootPid) && expectedRootPid > 0, "expected-root-pid-invalid");
  require(receipt?.rootPid === expectedRootPid, "tree-root-pid-mismatch");
  require(receipt?.exited === true, "tree-exit-invalid");
  require(receipt?.exitCode === 0, "tree-exit-code-invalid");
  require(receipt?.rootExited === true, "tree-root-not-exited");
  require(typeof receipt?.rootAlreadyExited === "boolean", "tree-root-state-invalid");

  const census = receipt?.descendantCensus;
  require(census?.kind === "windows-descendant-cleanup-census", "census-kind-invalid");
  require(
    census?.schemaVersion === "candlescope-windows-descendant-cleanup-census/v1",
    "census-schema-invalid",
  );
  require(census?.rootPid === expectedRootPid, "census-root-pid-mismatch");
  require(!census?.error, "census-error-present");
  const assessCensusSnapshot = (snapshot, phase) => {
    require(snapshot?.kind === "windows-process-descendant-census", `${phase}-census-kind-invalid`);
    require(
      snapshot?.schemaVersion === "candlescope-windows-process-descendant-census/v1",
      `${phase}-census-schema-invalid`,
    );
    require(snapshot?.supported === true, `${phase}-census-unsupported`);
    require(snapshot?.rootPid === expectedRootPid, `${phase}-census-root-pid-mismatch`);
    require(validReceiptTimestamp(snapshot?.checkedAt), `${phase}-census-time-invalid`);
    require(Array.isArray(snapshot?.descendants), `${phase}-census-descendants-invalid`);
    if (Array.isArray(snapshot?.descendants)) {
      require(
        snapshot.empty === (snapshot.descendants.length === 0),
        `${phase}-census-empty-inconsistent`,
      );
      for (const descendant of snapshot.descendants) {
        require(Number.isSafeInteger(descendant?.pid) && descendant.pid > 0, `${phase}-descendant-pid-invalid`);
        require(
          Number.isSafeInteger(descendant?.parentPid) && descendant.parentPid > 0,
          `${phase}-descendant-parent-pid-invalid`,
        );
      }
    }
  };
  assessCensusSnapshot(census?.before, "before");
  assessCensusSnapshot(census?.after, "after");
  if (validReceiptTimestamp(census?.before?.checkedAt)
    && validReceiptTimestamp(census?.after?.checkedAt)) {
    require(
      Date.parse(census.after.checkedAt) >= Date.parse(census.before.checkedAt),
      "census-time-order-invalid",
    );
  }
  require(census?.after?.empty === true, "after-census-not-empty");
  require(Array.isArray(census?.after?.descendants)
    && census.after.descendants.length === 0, "after-descendants-remain");
  require(census?.empty === census?.after?.empty, "aggregate-census-empty-inconsistent");

  const terminationReceipts = census?.terminationReceipts;
  require(Array.isArray(terminationReceipts), "termination-receipts-invalid");
  if (Array.isArray(terminationReceipts) && Array.isArray(census?.before?.descendants)) {
    const expectedPidList = census.before.descendants.map((record) => record.pid);
    const expectedPids = new Set(expectedPidList);
    const terminationPidList = terminationReceipts.map((termination) => termination?.details?.targetPid);
    const terminationPids = new Set(terminationPidList);
    require(expectedPids.size === expectedPidList.length, "before-descendant-pids-duplicate");
    require(terminationPids.size === terminationPidList.length, "termination-target-pids-duplicate");
    require(
      terminationReceipts.length === census.before.descendants.length,
      "termination-receipt-count-mismatch",
    );
    for (const termination of terminationReceipts) {
      require(termination?.kind === "windows-taskkill", "descendant-termination-kind-invalid");
      require(termination?.exited === true, "descendant-termination-not-exited");
      require(termination?.exitCode === 0, "descendant-termination-exit-code-invalid");
      require(expectedPids.has(termination?.details?.targetPid), "descendant-termination-pid-invalid");
    }
    require(
      expectedPids.size === terminationPids.size
        && [...expectedPids].every((pid) => terminationPids.has(pid)),
      "termination-target-pid-set-mismatch",
    );
  }
  if (receipt?.rootAlreadyExited === true) {
    require(receipt?.rootTermination === null, "unexpected-root-termination-receipt");
  } else if (receipt?.rootAlreadyExited === false) {
    require(receipt?.rootTermination?.kind === "windows-taskkill", "root-termination-kind-invalid");
    require(receipt?.rootTermination?.details?.targetPid === expectedRootPid, "root-termination-pid-invalid");
    require(receipt?.rootTermination?.exited === true, "root-termination-not-exited");
    require(receipt?.rootTermination?.exitCode === 0, "root-termination-exit-code-invalid");
  }
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

function controlledTerminalCauseEqual(left, right) {
  if (!left || !right || left.kind !== right.kind || left.observedAt !== right.observedAt) return false;
  if (left.kind === "cdp-close") {
    return left.code === right.code
      && (left.reason ?? null) === (right.reason ?? null)
      && (left.wasClean === true) === (right.wasClean === true);
  }
  if (left.kind === "cdp-error") return left.message === right.message;
  return false;
}

function controlledTerminalCauseShapeValid(cause) {
  if (!cause || !validReceiptTimestamp(cause.observedAt)) return false;
  if (cause.kind === "cdp-close") {
    return Number.isInteger(cause.code)
      && cause.code >= 0
      && cause.code <= 65_535
      && (cause.reason === null || typeof cause.reason === "string")
      && typeof cause.wasClean === "boolean";
  }
  return cause.kind === "cdp-error"
    && typeof cause.message === "string"
    && cause.message.length > 0;
}

function assessControlledDescendantExitGrace(receipt, expectedRootPid, processExitedAt, treeBeforeAt) {
  const violations = [];
  const require = (condition, violation) => {
    if (!condition) violations.push(violation);
  };
  require(receipt?.kind === "windows-descendant-exit-grace", "grace-kind-invalid");
  require(
    receipt?.schemaVersion === "candlescope-windows-descendant-exit-grace/v1",
    "grace-schema-invalid",
  );
  require(receipt?.supported === true, "grace-unsupported");
  require(receipt?.passed === true, "grace-not-passed");
  require(receipt?.rootPid === expectedRootPid, "grace-root-pid-mismatch");
  require(receipt?.requiredConsecutiveEmpty === 2, "grace-required-empty-invalid");
  require(receipt?.consecutiveEmpty === 2, "grace-consecutive-empty-invalid");
  require(receipt?.error === null, "grace-error-present");
  require(Array.isArray(receipt?.observations), "grace-observations-invalid");
  const observations = Array.isArray(receipt?.observations) ? receipt.observations : [];
  require(observations.length >= 2, "grace-observations-incomplete");
  let previousCheckedAt = null;
  for (const observation of observations) {
    require(observation?.kind === "windows-process-descendant-census", "grace-census-kind-invalid");
    require(
      observation?.schemaVersion === "candlescope-windows-process-descendant-census/v1",
      "grace-census-schema-invalid",
    );
    require(observation?.supported === true, "grace-census-unsupported");
    require(observation?.rootPid === expectedRootPid, "grace-census-root-pid-mismatch");
    require(validReceiptTimestamp(observation?.checkedAt), "grace-census-time-invalid");
    require(Array.isArray(observation?.descendants), "grace-census-descendants-invalid");
    if (Array.isArray(observation?.descendants)) {
      require(
        observation.empty === (observation.descendants.length === 0),
        "grace-census-empty-inconsistent",
      );
    }
    if (validReceiptTimestamp(observation?.checkedAt)) {
      if (validReceiptTimestamp(previousCheckedAt)) {
        require(
          Date.parse(observation.checkedAt) >= Date.parse(previousCheckedAt),
          "grace-census-time-order-invalid",
        );
      }
      if (validReceiptTimestamp(processExitedAt)) {
        require(
          Date.parse(observation.checkedAt) >= Date.parse(processExitedAt),
          "grace-census-before-process-exit",
        );
      }
      previousCheckedAt = observation.checkedAt;
    }
  }
  const trailing = observations.slice(-2);
  require(
    trailing.length === 2
      && trailing.every((observation) => observation?.empty === true
        && Array.isArray(observation?.descendants)
        && observation.descendants.length === 0),
    "grace-final-empty-observations-invalid",
  );
  if (validReceiptTimestamp(previousCheckedAt) && validReceiptTimestamp(treeBeforeAt)) {
    require(
      Date.parse(treeBeforeAt) >= Date.parse(previousCheckedAt),
      "tree-census-before-grace-completed",
    );
  }
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

export function assessControlledBrowserCloseEvidence(processReceipt) {
  const receipt = processReceipt?.browserCloseReceipt;
  const violations = [];
  const require = (condition, violation) => {
    if (!condition) violations.push(violation);
  };
  const requestedAt = receipt?.requestedAt;
  const dispatchedAt = receipt?.commandDispatchedAt;
  const settledAt = receipt?.commandSettledAt;
  const processExitedAt = receipt?.processExitedAt;
  require(receipt?.kind === "controlled-browser-close", "close-kind-invalid");
  require(
    receipt?.schemaVersion === "candlescope-controlled-browser-close/v1",
    "close-schema-invalid",
  );
  require(receipt?.passed === true, "close-not-passed");
  require(validReceiptTimestamp(requestedAt), "close-request-time-invalid");
  require(validReceiptTimestamp(dispatchedAt), "close-dispatch-time-invalid");
  require(validReceiptTimestamp(settledAt), "close-settlement-time-invalid");
  require(validReceiptTimestamp(processExitedAt), "close-process-exit-time-invalid");
  if (validReceiptTimestamp(requestedAt) && validReceiptTimestamp(dispatchedAt)) {
    require(Date.parse(dispatchedAt) >= Date.parse(requestedAt), "close-dispatched-before-request");
  }
  if (validReceiptTimestamp(dispatchedAt) && validReceiptTimestamp(settledAt)) {
    require(Date.parse(settledAt) >= Date.parse(dispatchedAt), "close-settled-before-dispatch");
  }
  if (validReceiptTimestamp(dispatchedAt) && validReceiptTimestamp(processExitedAt)) {
    require(Date.parse(processExitedAt) >= Date.parse(dispatchedAt), "process-exited-before-close-dispatch");
  }
  require(receipt?.transportAccepted === true, "close-transport-not-accepted");
  require(typeof receipt?.commandCompleted === "boolean", "close-command-completed-invalid");
  require(typeof receipt?.commandTimedOut === "boolean", "close-command-timeout-invalid");
  require(receipt?.commandError === null || typeof receipt?.commandError === "string", "close-command-error-invalid");

  const terminalCause = receipt?.commandTerminalCause ?? null;
  const terminalCauseAt = terminalCause?.observedAt;
  if (terminalCause !== null) {
    require(controlledTerminalCauseShapeValid(terminalCause), "close-terminal-cause-shape-invalid");
    if (validReceiptTimestamp(terminalCauseAt) && validReceiptTimestamp(dispatchedAt)) {
      require(
        Date.parse(terminalCauseAt) >= Date.parse(dispatchedAt),
        "close-terminal-cause-before-dispatch",
      );
    }
  }
  const commandCompleted = receipt?.commandCompleted === true
    && receipt?.commandTimedOut === false
    && receipt?.commandError === null
    && terminalCause === null;
  const commandTimedOut = receipt?.commandCompleted === false
    && receipt?.commandTimedOut === true
    && receipt?.commandError === null
    && terminalCause === null;
  const commandTerminatedByTransport = receipt?.commandCompleted === false
    && receipt?.commandTimedOut === false
    && typeof receipt?.commandError === "string"
    && controlledCdpTerminalCauseErrorMessage(terminalCause) === receipt.commandError;
  require(
    [commandCompleted, commandTimedOut, commandTerminatedByTransport].filter(Boolean).length === 1,
    "close-command-outcome-inconsistent",
  );

  const cdpClosure = processReceipt?.cdpClosure;
  const remoteClosure = cdpClosure?.remote;
  const remoteEvent = remoteClosure?.event;
  const remoteClosedAt = remoteEvent?.observedAt;
  require(processReceipt?.diagnosticsClosed === true, "close-diagnostics-not-closed");
  require(cdpClosure?.closed === true, "close-cdp-closure-invalid");
  require(
    cdpClosure?.closed === (remoteClosure?.closed === true || cdpClosure?.local?.closed === true),
    "close-cdp-closure-state-inconsistent",
  );
  require(cdpClosure?.localFallbackUsed === false, "close-local-fallback-observed");
  require(cdpClosure?.local === null, "close-local-closure-receipt-unexpected");
  require(remoteClosure?.closed === true, "close-remote-cdp-not-closed");
  require(remoteClosure?.timedOut === false, "close-remote-cdp-timeout-invalid");
  require(remoteEvent?.kind === "cdp-close", "close-remote-event-kind-invalid");
  require(controlledTerminalCauseShapeValid(remoteEvent), "close-remote-event-shape-invalid");
  require(validReceiptTimestamp(remoteClosedAt), "close-remote-event-time-invalid");
  if (validReceiptTimestamp(remoteClosedAt) && validReceiptTimestamp(dispatchedAt)) {
    require(
      Date.parse(remoteClosedAt) >= Date.parse(dispatchedAt),
      "close-remote-event-before-dispatch",
    );
  }
  const remoteTerminalCause = remoteClosure?.terminalCause ?? null;
  require(remoteTerminalCause !== null, "close-remote-terminal-cause-missing");
  if (remoteTerminalCause !== null) {
    require(
      controlledTerminalCauseShapeValid(remoteTerminalCause),
      "close-remote-terminal-cause-shape-invalid",
    );
    if (validReceiptTimestamp(remoteTerminalCause.observedAt) && validReceiptTimestamp(remoteClosedAt)) {
      require(
        Date.parse(remoteClosedAt) >= Date.parse(remoteTerminalCause.observedAt),
        "close-event-before-terminal-cause",
      );
    }
    if (remoteTerminalCause.kind === "cdp-close") {
      require(
        controlledTerminalCauseEqual(remoteTerminalCause, remoteEvent),
        "close-remote-close-cause-mismatch",
      );
    }
  }
  if (commandTerminatedByTransport) {
    require(
      controlledTerminalCauseEqual(terminalCause, remoteTerminalCause),
      "close-command-terminal-cause-mismatch",
    );
  }
  const remoteClosedAfterDispatch = remoteClosure?.closed === true
    && validReceiptTimestamp(remoteClosedAt)
    && validReceiptTimestamp(dispatchedAt)
    && Date.parse(remoteClosedAt) >= Date.parse(dispatchedAt);
  require(
    receipt?.remoteCdpClosedAt === remoteClosedAt,
    "close-remote-event-time-mismatch",
  );
  require(
    receipt?.remoteCdpClosedAfterRequest === remoteClosedAfterDispatch,
    "close-remote-state-inconsistent",
  );
  require(receipt?.remoteCdpClosedAfterRequest === true, "close-remote-not-after-dispatch");
  require(receipt?.localCdpFallbackUsed === cdpClosure?.localFallbackUsed, "close-local-fallback-mismatch");
  require(receipt?.localCdpFallbackUsed === false, "close-local-fallback-used");
  const acceptedCloseRace = receipt?.transportAccepted === true
    && (commandCompleted
      || (remoteClosedAfterDispatch && (commandTimedOut || commandTerminatedByTransport)));
  require(receipt?.acceptedCloseRace === acceptedCloseRace, "close-race-state-inconsistent");
  require(receipt?.acceptedCloseRace === true, "close-race-not-accepted");

  require(receipt?.processWasRunningAtRequest === true, "close-process-not-running-at-request");
  require(receipt?.processExitedAfterRequest === true, "close-process-not-exited-after-request");
  require(receipt?.gracefulProcessExit === true, "close-process-exit-not-graceful");
  require(processReceipt?.exited === true, "close-process-snapshot-not-exited");
  require(Number.isSafeInteger(processReceipt?.pid) && processReceipt.pid > 0, "close-process-pid-invalid");
  require(processReceipt?.stoppedAt === processExitedAt, "close-process-exit-time-mismatch");
  require(processReceipt?.exitCode === receipt?.processExitCode, "close-process-exit-code-mismatch");
  require(processReceipt?.signal === receipt?.processSignal, "close-process-signal-mismatch");
  require(receipt?.processExitCode === 0, "close-process-exit-code-invalid");
  require(receipt?.processSignal === null, "close-process-signal-invalid");
  require(
    receipt?.forceTerminationUsed === (processReceipt?.forceStopRequestedAt !== null),
    "close-force-termination-state-inconsistent",
  );
  require(receipt?.forceTerminationUsed === false, "close-force-termination-used");

  const tree = processReceipt?.treeStopReceipt;
  const treeAssessment = assessWindowsOwnedProcessTreeReceipt(tree, processReceipt?.pid);
  for (const violation of treeAssessment.violations) violations.push(`close-${violation}`);
  const terminationCount = tree?.descendantCensus?.terminationReceipts?.length;
  require(tree?.rootAlreadyExited === true, "close-tree-root-was-terminated");
  require(tree?.rootTermination === null, "close-tree-root-termination-receipt-unexpected");
  require(terminationCount === 0, "close-tree-descendant-termination-observed");
  require(
    receipt?.descendantTerminationUsed === (Number.isSafeInteger(terminationCount) && terminationCount > 0),
    "close-descendant-termination-state-inconsistent",
  );
  require(receipt?.descendantTerminationUsed === false, "close-descendant-termination-used");
  const graceAssessment = assessControlledDescendantExitGrace(
    receipt?.descendantExitGrace,
    processReceipt?.pid,
    processExitedAt,
    tree?.descendantCensus?.before?.checkedAt,
  );
  for (const violation of graceAssessment.violations) violations.push(`close-${violation}`);
  if (validReceiptTimestamp(processExitedAt)
    && validReceiptTimestamp(tree?.descendantCensus?.before?.checkedAt)) {
    require(
      Date.parse(tree.descendantCensus.before.checkedAt) >= Date.parse(processExitedAt),
      "close-tree-census-before-process-exit",
    );
  }
  return Object.freeze({
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

function controlledDiagnosticsHealthy(diagnostics) {
  const recordKeys = [
    "consoleErrors",
    "unexpectedConsoleErrors",
    "runtimeExceptions",
    "unhandledRejections",
    "windowErrors",
    "networkFailures",
    "crashes",
    "commandErrors",
    "protocolErrors",
    "handlerErrors",
  ];
  return diagnostics
    && Number.isSafeInteger(diagnostics.crashCount)
    && diagnostics.crashCount === 0
    && recordKeys.every((key) => Array.isArray(diagnostics[key]) && diagnostics[key].length === 0)
    && diagnostics.crashCount === diagnostics.crashes.length;
}

export function summarizeControlledCleanup(receipts) {
  const processReceipts = Array.isArray(receipts?.processes) ? receipts.processes : [];
  const portReceipts = Array.isArray(receipts?.ports) ? receipts.ports : [];
  const expectedProcessKinds = ["mock-api", "vite-preview", "headed-chrome"];
  const expectedPortKinds = ["mock-api", "vite-preview", "chrome-debug"];
  const profile = receipts?.profile ?? null;
  const failures = [];
  for (const receipt of processReceipts) {
    if (receipt?.exited !== true) failures.push(`${receipt?.kind || "unknown-process"}-not-exited`);
    if (receipt?.spawnError) failures.push(`${receipt?.kind || "unknown-process"}-spawn-error`);
    if (receipt?.kind === "headed-chrome" && receipt?.diagnosticsClosed !== true) {
      failures.push("headed-chrome-diagnostics-not-closed");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.diagnosticsBarrier?.completed !== true) {
      failures.push("headed-chrome-diagnostics-barrier-incomplete");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.workerDiagnosticsBarrier?.passed !== true) {
      failures.push("headed-chrome-worker-diagnostics-barrier-incomplete");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.handlerSettlementBeforeClose?.passed !== true) {
      failures.push("headed-chrome-pre-close-handlers-unsettled");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.handlerSettlementAfterClose?.passed !== true) {
      failures.push("headed-chrome-post-close-handlers-unsettled");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.finalWorkerDiagnostics?.passed !== true) {
      failures.push("headed-chrome-final-worker-diagnostics-invalid");
    }
    if (receipt?.kind === "headed-chrome" && receipt?.finalOriginGuard?.passed !== true) {
      failures.push("headed-chrome-final-origin-guard-invalid");
    }
    if (receipt?.kind === "headed-chrome" && !controlledDiagnosticsHealthy(receipt?.finalDiagnostics)) {
      failures.push("headed-chrome-final-diagnostics-invalid");
    }
    if (receipt?.kind === "headed-chrome"
      && !assessControlledBrowserCloseEvidence(receipt).valid) {
      failures.push("headed-chrome-intentional-close-invalid");
    }
    if (receipt?.kind === "headed-chrome"
      && (!Array.isArray(receipt?.finalizationErrors) || receipt.finalizationErrors.length > 0)) {
      failures.push("headed-chrome-finalization-errors");
    }
    if (process.platform === "win32" && expectedProcessKinds.includes(receipt?.kind)
      && !receipt?.treeStopReceipt) failures.push(`${receipt.kind}-tree-stop-receipt-missing`);
    if (receipt?.treeStopReceipt
      && !assessWindowsOwnedProcessTreeReceipt(receipt.treeStopReceipt, receipt?.pid).valid) {
      failures.push(`${receipt?.kind || "unknown-process"}-tree-stop-failed`);
    }
  }
  for (const kind of expectedProcessKinds) {
    if (processReceipts.filter((receipt) => receipt?.kind === kind).length !== 1) {
      failures.push(`${kind}-process-receipt-missing-or-duplicate`);
    }
  }
  if (profile?.removed !== true) failures.push("owned-profile-not-removed");
  for (const kind of expectedPortKinds) {
    const matching = portReceipts.filter((receipt) => receipt?.kind === kind);
    if (matching.length !== 1) failures.push(`${kind}-port-receipt-missing-or-duplicate`);
    else if (matching[0].closed !== true) failures.push(`${kind}-port-not-closed`);
  }
  for (const error of receipts?.cleanupErrors || []) failures.push(`cleanup-error:${error}`);
  return Object.freeze({
    complete: failures.length === 0,
    processCount: processReceipts.length,
    allProcessesExited: processReceipts.every((receipt) => receipt?.exited === true),
    diagnosticsClosed: processReceipts
      .filter((receipt) => receipt?.kind === "headed-chrome")
      .every((receipt) => receipt?.diagnosticsClosed === true),
    portCount: portReceipts.length,
    allOwnedPortsClosed: expectedPortKinds.every((kind) => (
      portReceipts.filter((receipt) => receipt?.kind === kind).length === 1
      && portReceipts.find((receipt) => receipt?.kind === kind)?.closed === true
    )),
    profileRemoved: profile?.removed === true,
    failures: Object.freeze(failures),
  });
}

export async function startControlledProductionCdp(options = {}) {
  assertControlledRunnerRuntime();
  assertControlledRunnerEntrypoint();
  const configuration = normalizeControlledCdpOptions(options);
  const runId = randomUUID();
  const startedAt = isoNow();
  const chromePath = findControlledChrome(configuration.chromePath);
  if (!chromePath) {
    throw new Error(configuration.chromePath
      ? `Configured Chrome/Edge executable does not exist: ${configuration.chromePath}`
      : "Chrome or Edge executable not found");
  }
  const toolchain = await readToolchainFingerprint(chromePath);
  const buildReceipt = await runProductionBuild(configuration, runId, toolchain);
  const [apiPort, previewPort] = await findDistinctLoopbackPorts(2);
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), OWNED_PROFILE_PREFIX));
  const launchState = { debugPort: null, buildReceipt };
  let servers = null;
  let browser = null;
  let failedServerReceipts = null;
  let failedBrowserReceipt = null;
  let closePromise = null;

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const requestedAt = isoNow();
      const cleanupErrors = [];
      let browserReceipt = failedBrowserReceipt;
      let serverReceipts = failedServerReceipts;
      if (browser) {
        try { browserReceipt = await browser.close(); } catch (error) {
          cleanupErrors.push(`browser:${error instanceof Error ? error.message : String(error)}`);
          browserReceipt = browser.snapshot();
        }
      }
      if (servers) {
        try { serverReceipts = await servers.close(); } catch (error) {
          cleanupErrors.push(`servers:${error instanceof Error ? error.message : String(error)}`);
          serverReceipts = servers.snapshot();
        }
      }
      const profileReceipt = await removeOwnedProfile(profileDirectory);
      const allocatedPortDescriptors = [
        { kind: "mock-api", port: apiPort },
        { kind: "vite-preview", port: previewPort },
        ...(Number.isSafeInteger(launchState.debugPort)
          ? [{ kind: "chrome-debug", port: launchState.debugPort }]
          : []),
      ];
      const checkedPorts = await waitForOwnedPortsClosed(allocatedPortDescriptors);
      const portReceipts = Number.isSafeInteger(launchState.debugPort)
        ? checkedPorts
        : Object.freeze([
          ...checkedPorts,
          Object.freeze({
            kind: "chrome-debug",
            host: "127.0.0.1",
            port: null,
            attempts: 0,
            closed: false,
            closedAt: isoNow(),
            lastProbe: "not-allocated",
          }),
        ]);
      const processes = [
        browserReceipt,
        serverReceipts?.preview,
        serverReceipts?.api,
      ].filter(Boolean);
      const summary = summarizeControlledCleanup({
        processes,
        ports: portReceipts,
        profile: profileReceipt,
        cleanupErrors,
      });
      return Object.freeze({
        runId,
        requestedAt,
        completedAt: isoNow(),
        browser: browserReceipt,
        servers: serverReceipts,
        profile: profileReceipt,
        ports: portReceipts,
        cleanupErrors: Object.freeze(cleanupErrors),
        diagnosticsClosed: browserReceipt?.diagnosticsClosed ?? null,
        diagnosticsBarrier: browserReceipt?.diagnosticsBarrier ?? null,
        workerDiagnosticsBarrier: browserReceipt?.workerDiagnosticsBarrier ?? null,
        handlerSettlementBeforeClose: browserReceipt?.handlerSettlementBeforeClose ?? null,
        handlerSettlementAfterClose: browserReceipt?.handlerSettlementAfterClose ?? null,
        browserCloseReceipt: browserReceipt?.browserCloseReceipt ?? null,
        finalizationErrors: browserReceipt?.finalizationErrors ?? null,
        finalDiagnostics: browserReceipt?.finalDiagnostics ?? null,
        finalWorkerDiagnostics: browserReceipt?.finalWorkerDiagnostics ?? null,
        finalOriginGuard: browserReceipt?.finalOriginGuard ?? null,
        summary,
      });
    })();
    return closePromise;
  };

  try {
    servers = await startManagedServers(configuration, buildReceipt, apiPort, previewPort);
    browser = await launchOwnedBrowser(
      configuration,
      chromePath,
      toolchain,
      profileDirectory,
      servers.url,
      launchState,
      runId,
    );
    const initialBuildEvidence = await readBrowserBuildEvidence(
      browser.cdp,
      servers.url,
      buildReceipt,
      browser.assetTracker,
      browser.originGuard,
      browser.workerDiagnostics,
    );
    if (!initialBuildEvidence.authoritative) {
      throw new Error(`Controlled browser did not load the managed production assets: ${JSON.stringify(
        initialBuildEvidence,
      )}`);
    }
    const guardedSend = (method, params = {}, sessionId = null) => {
      if ([
        "Browser.close",
        "Fetch.enable",
        "Fetch.disable",
        "Inspector.disable",
        "Network.disable",
        "Page.disable",
        "Page.navigate",
        "Page.reload",
        "Page.setDocumentContent",
        "Runtime.disable",
        "Runtime.removeBinding",
        "Runtime.runIfWaitingForDebugger",
        "Target.createTarget",
        "Target.detachFromTarget",
        "Target.setDiscoverTargets",
        "Target.setAutoAttach",
        "Storage.overrideQuotaForOrigin",
      ].includes(method)) {
        throw new Error(`Controlled CDP facade forbids authority-changing command ${method}`);
      }
      return browser.cdp.send(method, params, sessionId);
    };
    const assertManagedCaptureState = async () => {
      const location = await evaluateJson(browser.cdp, `({ origin: location.origin, href: location.href })`);
      const handlerSettlement = await browser.cdp.settleHandlers(2_000);
      if (!handlerSettlement.passed) {
        throw new Error(`Authoritative capture has unsettled CDP handlers: ${JSON.stringify(handlerSettlement)}`);
      }
      const workerSettlement = await browser.workerDiagnostics.settle(2_000);
      browser.workerDiagnostics.assertHealthy();
      browser.originGuard.assertHealthy();
      if (location?.origin !== servers.origin
        || !controlledManagedDocumentUrlAllowed(location?.href || "", servers.url)) {
        throw new Error(`Authoritative capture left managed origin: ${JSON.stringify(location)}`);
      }
      return Object.freeze({ location, handlerSettlement, workerSettlement });
    };
    const cdpFacade = Object.freeze({
      send: guardedSend,
      on: (method, handler) => browser.cdp.on(method, handler),
      evaluate: (expression) => evaluate(browser.cdp, expression),
      evaluateJson: (expression) => evaluateJson(browser.cdp, expression),
    });
    return Object.freeze({
      kind: "controlled-production-cdp",
      runId,
      startedAt,
      readyAt: isoNow(),
      configuration,
      managedOrigin: servers.origin,
      mockMeta: stableObject(servers.mockMeta),
      buildReceipt,
      browserVersion: browser.browserVersion,
      browserWindow: browser.windowEvidence,
      initialBuildEvidence,
      cdp: cdpFacade,
      diagnostics: () => Object.freeze({
        pageAndWorker: browser.diagnostics.snapshot(),
        workers: browser.workerDiagnostics.snapshot(),
        originGuard: browser.originGuard.snapshot(),
        cdpHandlers: browser.cdp.handlerSnapshot(),
      }),
      registerPausedTargetInitializer: (specification) => (
        browser.workerDiagnostics.registerPausedTargetInitializer(specification)
      ),
      rollbackAuthority: browser.rollbackAuthority,
      navigateRollbackDrill: (drillId, options) => browser.navigateRollbackDrill(drillId, options),
      prepareIndexedDbQuotaFault: (binding) => browser.prepareIndexedDbQuotaFault(binding),
      releaseIndexedDbQuotaFault: (binding) => browser.releaseIndexedDbQuotaFault(binding),
      prepareIndexedDbBlockedFault: (binding) => browser.prepareIndexedDbBlockedFault(binding),
      releaseIndexedDbBlockedFault: (binding) => browser.releaseIndexedDbBlockedFault(binding),
      reloadManagedDocument: (binding) => browser.reloadManagedDocument(binding),
      settleAuthoritativeState: assertManagedCaptureState,
      verifyWindow: async () => {
        await assertManagedCaptureState();
        const evidence = await verifyControlledBrowserWindow(
          browser.cdp,
          browser.windowId,
          browser.browserVersion,
        );
        await assertManagedCaptureState();
        return evidence;
      },
      setDeviceMetrics: async (viewport, dpr) => {
        await assertManagedCaptureState();
        const evidence = await setControlledDeviceMetrics(
          browser.cdp,
          browser.windowId,
          browser.browserVersion,
          viewport,
          dpr,
        );
        await assertManagedCaptureState();
        return evidence;
      },
      readBrowserBuildEvidence: async ({ requireActiveWorkers = true } = {}) => {
        if (typeof requireActiveWorkers !== "boolean") {
          throw new TypeError("requireActiveWorkers must be a boolean");
        }
        await assertManagedCaptureState();
        return readBrowserBuildEvidence(
          browser.cdp,
          servers.url,
          buildReceipt,
          browser.assetTracker,
          browser.originGuard,
          browser.workerDiagnostics,
          { requireActiveWorkers },
        );
      },
      lifecycle: () => Object.freeze({
        browser: browser.snapshot(),
        servers: servers.snapshot(),
      }),
      close,
    });
  } catch (error) {
    failedBrowserReceipt = error?.browserReceipt ?? failedBrowserReceipt;
    failedServerReceipts = error?.serverReceipts ?? failedServerReceipts;
    const cleanup = await close();
    const wrapped = new Error(`${error?.message || error}\nControlled runner cleanup:\n${JSON.stringify(cleanup)}`);
    wrapped.cause = error;
    wrapped.cleanup = cleanup;
    wrapped.runId = runId;
    throw wrapped;
  }
}
