import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES,
  CONTROLLED_DIAGNOSTIC_WORKER_TYPES,
  CONTROLLED_ROLLBACK_DRILL_IDS,
  CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS,
  assessControlledBrowserCloseEvidence,
  assessControlledBrowserWindow,
  assessControlledLoadedAssetAuthority,
  assessControlledRunnerRuntimeEvidence,
  assessWindowsOwnedProcessTreeReceipt,
  assertControlledCdpResponseSession,
  controlledBuildEnvironment,
  controlledBuildFingerprint,
  controlledManagedDocumentUrlAllowed,
  controlledManagedUrlAllowed,
  createControlledCdpHandlerTracker,
  createControlledCdpCommandEnvelope,
  createControlledDiagnosticsAggregator,
  createManagedOriginGuard,
  createControlledNetworkAssetTracker,
  createControlledWorkerDiagnosticsController,
  diagnosticBootstrapSource,
  extractHtmlAssetPaths,
  fingerprintBuildToolImplementation,
  fingerprintFileEntries,
  forceCleanupControlledBlockedFault,
  forceCleanupControlledQuotaOverride,
  isControlledDetachedSessionCommandError,
  normalizeControlledCdpOptions,
  parseControlledCdpMessage,
  prepareControlledBlockedFault,
  prepareControlledQuotaOverride,
  releaseControlledQuotaOverride,
  waitForControlledQuotaCacheExpiry,
  assertControlledRunnerEntrypoint,
  assertControlledRunnerRuntime,
  summarizeControlledCleanup,
  summarizeControlledRetirement,
} from "./drawing-controlled-cdp.mjs";

const CONTROLLED_ROLLBACK_SESSION_KEY = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL_TOKEN__";
const CONTROLLED_ROLLBACK_HANDLE = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__";
const CONTROLLED_DIAGNOSTIC_BINDING = "__CANDLESCOPE_CONTROLLED_CDP_REPORT__";
const CONTROLLED_ROLLBACK_RUN_ID = "controlled-run-worker-rollback";
const CONTROLLED_ROLLBACK_AUTHORITY_TOKEN = "controlled-worker-rollback-authority";
const CONTROLLED_ROLLBACK_AUTHORITY_DIGEST = "a".repeat(64);
const CONTROLLED_ROLLBACK_FAULT_ID = "11111111-1111-4111-8111-111111111111";
const CONTROLLED_ROLLBACK_DOCUMENT_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const CONTROLLED_HASHED_DRAWING_WORKER_PATH = "assets/drawing.worker-a1b2c3d4.js";
let controlledWorkerConstructorAttempt = 0;

function controlledRollbackToken(overrides = {}) {
  return {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityToken: CONTROLLED_ROLLBACK_AUTHORITY_TOKEN,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drillId: "worker-init-failure",
    variant: null,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    sequence: 1,
    ...overrides,
  };
}

function createDiagnosticBootstrapFixture({
  token = controlledRollbackToken(),
  indexedDB = null,
  IDBVersionChangeEvent = class {
    constructor(type, init = {}) { Object.assign(this, { type, ...init }); }
  },
} = {}) {
  const values = new Map();
  if (token !== null) {
    values.set(CONTROLLED_ROLLBACK_SESSION_KEY, JSON.stringify(token));
  }
  const reports = [];
  const nativeConstructions = [];
  const listeners = new Map();
  class FakeWorker {
    constructor(url, options) {
      nativeConstructions.push({ url: String(url), options });
    }

    postMessage() {}

    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    }
  }
  const window = {
    Worker: FakeWorker,
    indexedDB,
    [CONTROLLED_DIAGNOSTIC_BINDING](payload) {
      reports.push(JSON.parse(payload));
    },
  };
  const sessionStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  const location = new URL("http://127.0.0.1:15173/");
  runInNewContext(diagnosticBootstrapSource({
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityToken: CONTROLLED_ROLLBACK_AUTHORITY_TOKEN,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drawingWorkerPaths: [CONTROLLED_HASHED_DRAWING_WORKER_PATH],
  }), {
    DOMException,
    IDBVersionChangeEvent,
    URL,
    addEventListener() {},
    crypto: {
      randomUUID: (() => {
        let sequence = 0;
        return () => `22222222-2222-4222-8222-${String(++sequence).padStart(12, "0")}`;
      })(),
    },
    indexedDB,
    location,
    clearTimeout,
    setTimeout,
    sessionStorage,
    window,
  });
  return {
    location,
    nativeConstructions,
    reports,
    sessionStorage,
    snapshot() {
      return JSON.parse(JSON.stringify(window[CONTROLLED_ROLLBACK_HANDLE].snapshot()));
    },
    window,
  };
}

function createFakeIndexedDb({ blockedEventTrusted = true, extensible = true } = {}) {
  class FakeRequest {
    constructor() {
      this.error = null;
      this.result = undefined;
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    emit(type, fields = {}) {
      const event = { type, isTrusted: false, ...fields };
      for (const listener of this.listeners.get(type) || []) listener(event);
      if (typeof this[`on${type}`] === "function") this[`on${type}`](event);
    }
  }

  const databases = new Map();
  let pendingUpgrade = null;
  let quotaFailure = {
    active: false,
    abortTrusted: true,
    errorName: "QuotaExceededError",
  };
  class FakeTransaction extends FakeRequest {
    constructor(database, storeName, mode) {
      super();
      this.database = database;
      this.storeName = storeName;
      this.mode = mode;
    }

    objectStore(name) {
      if (name !== this.storeName || !this.database.stores.has(name)) {
        throw new DOMException("Object store does not exist", "NotFoundError");
      }
      return {
        put: (_value, key) => {
          const request = new FakeRequest();
          queueMicrotask(() => {
            if (quotaFailure.active && key === "probe") {
              const error = new DOMException("Controlled native quota failure", quotaFailure.errorName);
              request.error = error;
              this.error = error;
              request.emit("error", { isTrusted: quotaFailure.abortTrusted });
              this.emit("error", { isTrusted: quotaFailure.abortTrusted });
              this.emit("abort", { isTrusted: quotaFailure.abortTrusted });
              return;
            }
            request.result = key;
            request.emit("success", { isTrusted: true });
            this.emit("complete", { isTrusted: true });
          });
          return request;
        },
      };
    }
  }

  class FakeDatabase {
    constructor(factory, name, version, stores = new Set()) {
      this.factory = factory;
      this.name = name;
      this.version = version;
      this.stores = stores;
      this.closed = false;
      this.onversionchange = null;
      this.objectStoreNames = { contains: (value) => this.stores.has(value) };
    }

    createObjectStore(name) {
      this.stores.add(String(name));
      return {};
    }

    transaction(storeName, mode) {
      if (this.closed) throw new DOMException("Database is closed", "InvalidStateError");
      return new FakeTransaction(this, String(storeName), String(mode));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (pendingUpgrade?.keeper === this) {
        const pending = pendingUpgrade;
        pendingUpgrade = null;
        queueMicrotask(() => {
          const database = new FakeDatabase(
            this.factory,
            pending.name,
            pending.version,
            pending.stores,
          );
          databases.set(pending.name, { stores: pending.stores, version: pending.version });
          pending.request.result = database;
          pending.request.emit("success");
        });
      }
    }

    dispatchEvent(event) {
      if (typeof this.onversionchange === "function") this.onversionchange(event);
      return true;
    }
  }

  const factory = {
    open(name, version) {
      const request = new FakeRequest();
      const normalizedName = String(name);
      const normalizedVersion = version === undefined
        ? (databases.get(normalizedName)?.version ?? 1)
        : Number(version);
      queueMicrotask(() => {
        const current = databases.get(normalizedName);
        if (current && normalizedVersion > current.version && current.keeper?.closed !== true) {
          pendingUpgrade = {
            keeper: current.keeper,
            name: normalizedName,
            request,
            stores: current.stores,
            version: normalizedVersion,
          };
          request.emit("blocked", {
            isTrusted: blockedEventTrusted,
            oldVersion: current.version,
            newVersion: normalizedVersion,
          });
          return;
        }
        const stores = current?.stores ?? new Set();
        const database = new FakeDatabase(factory, normalizedName, normalizedVersion, stores);
        const created = !current;
        request.result = database;
        if (created) request.emit("upgradeneeded", { oldVersion: 0, newVersion: normalizedVersion });
        databases.set(normalizedName, {
          stores,
          version: normalizedVersion,
          ...(normalizedName.startsWith("candlescope-rollback-blocked-")
            ? { keeper: database }
            : {}),
        });
        request.emit("success");
      });
      return request;
    },
    deleteDatabase(name) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        databases.delete(String(name));
        request.emit("success");
      });
      return request;
    },
    async databases() {
      return [...databases].map(([name, value]) => ({ name, version: value.version }));
    },
    setQuotaFailure(configuration = {}) {
      quotaFailure = {
        ...quotaFailure,
        ...configuration,
      };
    },
  };
  if (!extensible) {
    Object.defineProperty(factory, "open", {
      value: factory.open,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    Object.preventExtensions(factory);
  }
  return factory;
}

function waitForFakeRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function controlledQuotaSnapshot(storage) {
  return {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    variant: "quota",
    storage,
  };
}

function controlledQuotaPreparationSnapshot() {
  return controlledQuotaSnapshot({
    quotaPreparation: {
      prepared: true,
      databaseName: `candlescope-rollback-quota-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
      storeName: "quota-probe",
      baselineKey: "baseline",
      baselineCommitted: true,
      connectionKeptOpen: true,
      preparedAt: "2026-07-16T08:00:00.000Z",
    },
  });
}

function controlledQuotaProbeSnapshot(overrides = {}) {
  return controlledQuotaSnapshot({
    quotaProbe: {
      attempted: true,
      databaseName: `candlescope-rollback-quota-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
      storeName: "quota-probe",
      transactionMode: "readwrite",
      attemptedAt: "2026-07-16T08:00:36.000Z",
      settled: "abort",
      abortEvent: {
        type: "abort",
        isTrusted: true,
        observedAt: "2026-07-16T08:00:36.010Z",
      },
      transactionError: {
        name: "QuotaExceededError",
        observedAt: "2026-07-16T08:00:36.010Z",
      },
      nativeQuotaExceeded: true,
      observedAt: "2026-07-16T08:00:36.011Z",
      ...overrides,
    },
  });
}

function controlledQuotaReleaseSnapshot({ forcedCleanup }) {
  return controlledQuotaSnapshot({
    quotaRelease: {
      databaseName: `candlescope-rollback-quota-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
      storeName: "quota-probe",
      connectionClosed: true,
      deletion: { status: "success" },
      databaseStillPresent: false,
      forcedCleanup,
      completed: true,
      completedAt: "2026-07-16T08:00:37.000Z",
    },
  });
}

async function createWorkerConstructionFaultTrackerFixture() {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: CONTROLLED_HASHED_DRAWING_WORKER_PATH, content: "worker" },
  ];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0entry", { body: "main", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, 400, "main-frame", {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drawingWorkerPaths: [CONTROLLED_HASHED_DRAWING_WORKER_PATH],
    drillIds: CONTROLLED_ROLLBACK_DRILL_IDS,
  });
  const emitAsset = async (requestId, path, type, initiatorType) => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  await emitAsset("document", "/", "Document", "other");
  await emitAsset("entry", "/assets/main.js", "Script", "parser");
  return { cdp, tracker };
}

function controlledWorkerConstructionFault(overrides = {}) {
  return {
    kind: "worker-constructor-fault",
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drillId: "worker-init-failure",
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    sequence: 1,
    url: `http://127.0.0.1:15173/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
    workerType: "module",
    workerName: "candlescope-drawing-worker",
    ...overrides,
  };
}

async function emitWorkerConstructionFault(cdp, overrides = {}) {
  await ensureFakeMainExecutionContext(cdp);
  await cdp.emit("Runtime.bindingCalled", {
    name: CONTROLLED_DIAGNOSTIC_BINDING,
    executionContextId: 701,
    payload: JSON.stringify(controlledWorkerConstructionFault(overrides)),
  });
}

function createFakeCdp({ responseBodies = new Map(), evaluate = null, onSend = null } = {}) {
  const handlers = new Map();
  const sends = [];
  return {
    sends,
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    async send(method, params = {}, sessionId = null, recordErrors = true) {
      sends.push({ method, params, sessionId, recordErrors });
      if (onSend) {
        const result = await onSend({ method, params, sessionId, recordErrors, sends });
        if (result !== undefined) return result;
      }
      if (method === "Network.getResponseBody") {
        const key = `${sessionId || "<top>"}\0${params.requestId}`;
        if (!responseBodies.has(key)) throw new Error(`Missing fake response body for ${key}`);
        return { result: responseBodies.get(key) };
      }
      if (method === "Runtime.evaluate" && evaluate) {
        return evaluate({ method, params, sessionId, recordErrors, sends });
      }
      return { result: {} };
    },
    async emit(method, params = {}, message = {}) {
      const outcomes = [];
      for (const handler of handlers.get(method) || []) {
        try { outcomes.push(Promise.resolve(handler(params, message))); } catch (error) {
          outcomes.push(Promise.reject(error));
        }
      }
      return Promise.allSettled(outcomes);
    },
  };
}

const fakeMainExecutionContextCdps = new WeakSet();
async function ensureFakeMainExecutionContext(cdp) {
  if (fakeMainExecutionContextCdps.has(cdp)) return;
  fakeMainExecutionContextCdps.add(cdp);
  await cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 701,
      origin: "http://127.0.0.1:15173",
      name: "",
      auxData: {
        isDefault: true,
        type: "default",
        frameId: "main-frame",
      },
    },
  });
}

async function emitWorkerConstruction(
  cdp,
  url = "http://127.0.0.1:15173/assets/drawing.worker.js",
  workerType = "module",
  {
    controlledQuery = false,
    ensureMainContext = true,
    executionContextId = 701,
    workerName = "candlescope-drawing-worker",
  } = {},
) {
  if (ensureMainContext) await ensureFakeMainExecutionContext(cdp);
  controlledWorkerConstructorAttempt += 1;
  const constructorId = `${CONTROLLED_ROLLBACK_DOCUMENT_INSTANCE_ID}:worker:${controlledWorkerConstructorAttempt}`;
  const reportedUrl = new URL(url);
  if (controlledQuery) {
    reportedUrl.searchParams.set("__candlescope_cdp_worker_constructor", constructorId);
  }
  await cdp.emit("Runtime.bindingCalled", {
    name: "__CANDLESCOPE_CONTROLLED_CDP_REPORT__",
    executionContextId,
    payload: JSON.stringify({
      kind: "worker-constructor",
      runId: CONTROLLED_ROLLBACK_RUN_ID,
      authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
      authorityAccepted: true,
      drillId: "series-rebuild-before-export",
      documentInstanceId: CONTROLLED_ROLLBACK_DOCUMENT_INSTANCE_ID,
      faultId: CONTROLLED_ROLLBACK_FAULT_ID,
      sequence: 1,
      constructorId,
      constructorAttempt: controlledWorkerConstructorAttempt,
      url: reportedUrl.href,
      workerType,
      workerName,
    }),
  });
  return { constructorId, url: reportedUrl.href };
}

async function createWorkerBootstrapHandoffFixture({
  requestId = "worker-bootstrap-target",
  targetId = requestId,
  sourceUrl = "http://127.0.0.1:15173/assets/drawing.worker.js",
  targetUrl = sourceUrl,
  constructionCount = 1,
  constructionTiming = "before-source",
  constructionWorkerType = "module",
  constructionWorkerName = "candlescope-drawing-worker",
  observationGapCount = 0,
  sourceDocumentUrl = "http://127.0.0.1:15173/",
  sourceFrameId = "main-frame",
  sourceInitiatorType = "other",
  sourceLoaderId = "",
  sourceTiming = "before-target",
  sourceType = "Script",
  discoveredTargetTitle = null,
  discoveredTargetUrl = null,
  destroyDiscoveredTargetBeforeAttach = false,
  targetTitle = "candlescope-drawing-worker",
  timeoutMs = 500,
  claimWorkerResponseBodyCapture = null,
  captureWorkerResponseWithManagedOriginGuard = false,
} = {}) {
  if (captureWorkerResponseWithManagedOriginGuard && claimWorkerResponseBodyCapture !== null) {
    throw new Error("worker bootstrap fixture accepts only one response capture provider");
  }
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: "assets/drawing.worker.js", content: "worker" },
  ];
  const sessionId = "worker-session";
  const responseBodies = new Map([
    ["<top>\0document", { body: "index", base64Encoded: false }],
    ["<top>\0entry", { body: "main", base64Encoded: false }],
    [`${sessionId}\0${requestId}`, { body: "worker", base64Encoded: false }],
    [`${sessionId}\0worker-self-fetch`, { body: "worker", base64Encoded: false }],
  ]);
  const cdp = createFakeCdp({
    responseBodies,
    onSend: ({ method }) => (
      captureWorkerResponseWithManagedOriginGuard && method === "Fetch.getResponseBody"
        ? { result: { body: "worker", base64Encoded: false } }
        : undefined
    ),
  });
  const originGuard = captureWorkerResponseWithManagedOriginGuard
    ? await createManagedOriginGuard(
      cdp,
      "http://127.0.0.1:15173/",
      ["assets/drawing.worker.js"],
    )
    : null;
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, timeoutMs, "main-frame", null, (
    originGuard?.claimWorkerResponseBodyCapture ?? claimWorkerResponseBodyCapture
  ));
  const emitTopResponse = async (id, path, type, initiatorType) => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId: id,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId: id,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId: id });
  };
  await emitTopResponse("document", "/", "Document", "other");
  await emitTopResponse("entry", "/assets/main.js", "Script", "parser");
  const emitConstructions = async () => {
    for (let index = 0; index < constructionCount; index += 1) {
      await emitWorkerConstruction(cdp, targetUrl, constructionWorkerType, {
        workerName: constructionWorkerName,
      });
    }
  };
  if (constructionTiming === "before-source") await emitConstructions();
  const emitSourceRequest = async () => {
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: sourceFrameId,
      loaderId: sourceLoaderId,
      documentURL: sourceDocumentUrl,
      type: sourceType,
      initiator: { type: sourceInitiatorType },
      request: { url: sourceUrl },
    });
  };
  if (sourceTiming === "before-target") await emitSourceRequest();
  if (constructionTiming === "after-source" && sourceTiming === "before-target") {
    await emitConstructions();
  }
  for (let index = 0; index < observationGapCount; index += 1) {
    await cdp.emit("Target.attachedToTarget", {
      sessionId: `observation-gap-${index}`,
      targetInfo: {
        targetId: `observation-gap-target-${index}`,
        type: "iframe",
        url: "http://127.0.0.1:15173/",
      },
    });
  }
  if (discoveredTargetTitle !== null) {
    await cdp.emit("Target.targetCreated", {
      targetInfo: {
        targetId,
        type: "worker",
        title: discoveredTargetTitle,
        url: discoveredTargetUrl ?? targetUrl,
        attached: false,
        parentFrameId: "main-frame",
      },
    });
    if (destroyDiscoveredTargetBeforeAttach) {
      await cdp.emit("Target.targetDestroyed", { targetId });
    }
  }
  await cdp.emit("Target.attachedToTarget", {
    sessionId,
    waitingForDebugger: true,
    targetInfo: {
      targetId,
      type: "worker",
      title: targetTitle,
      url: targetUrl,
    },
  });
  if (sourceTiming === "after-target") await emitSourceRequest();
  if (constructionTiming === "after-source" && sourceTiming === "after-target") {
    await emitConstructions();
  }
  if (constructionTiming === "after-target") await emitConstructions();
  return {
    cdp,
    requestId,
    responseBodies,
    sessionId,
    sourceUrl,
    targetUrl,
    tracker,
    originGuard,
    async emitChildResponse(responseUrl = targetUrl) {
      await cdp.emit("Network.responseReceived", {
        requestId,
        type: "Script",
        response: { url: responseUrl, status: 200 },
      }, { sessionId });
    },
    async emitChildFinished() {
      await cdp.emit("Network.loadingFinished", { requestId }, { sessionId });
    },
  };
}

async function attachAdditionalWorkerBootstrap(fixture, {
  requestId,
  sessionId,
} = {}) {
  fixture.responseBodies.set(
    `${sessionId}\0${requestId}`,
    { body: "worker", base64Encoded: false },
  );
  await emitWorkerConstruction(fixture.cdp, fixture.targetUrl);
  await fixture.cdp.emit("Network.requestWillBeSent", {
    requestId,
    frameId: "main-frame",
    loaderId: "",
    documentURL: "http://127.0.0.1:15173/",
    type: "Script",
    initiator: { type: "other" },
    request: { url: fixture.targetUrl },
  });
  await fixture.cdp.emit("Target.attachedToTarget", {
    sessionId,
    waitingForDebugger: true,
    targetInfo: {
      targetId: requestId,
      type: "worker",
      title: "candlescope-drawing-worker",
      url: fixture.targetUrl,
    },
  });
  return {
    async emitChildResponse() {
      await fixture.cdp.emit("Network.responseReceived", {
        requestId,
        type: "Script",
        response: { url: fixture.targetUrl, status: 200 },
      }, { sessionId });
    },
    async emitChildFinished() {
      await fixture.cdp.emit("Network.loadingFinished", { requestId }, { sessionId });
    },
  };
}

function passingCensus(rootPid, checkedAt, descendants = []) {
  return {
    kind: "windows-process-descendant-census",
    schemaVersion: "candlescope-windows-process-descendant-census/v1",
    supported: true,
    checkedAt,
    rootPid,
    empty: descendants.length === 0,
    descendants,
  };
}

function passingTreeStopReceipt(rootPid) {
  return {
    kind: "windows-owned-process-tree-cleanup",
    schemaVersion: "candlescope-windows-owned-process-tree-cleanup/v1",
    exited: true,
    exitCode: 0,
    rootPid,
    rootAlreadyExited: true,
    rootExited: true,
    rootTermination: null,
    descendantCensus: {
      kind: "windows-descendant-cleanup-census",
      schemaVersion: "candlescope-windows-descendant-cleanup-census/v1",
      rootPid,
      before: passingCensus(rootPid, "2026-07-16T00:00:00.300Z"),
      terminationReceipts: [],
      after: passingCensus(rootPid, "2026-07-16T00:00:00.400Z"),
      empty: true,
    },
  };
}

function passingDescendantExitGrace(rootPid) {
  return {
    kind: "windows-descendant-exit-grace",
    schemaVersion: "candlescope-windows-descendant-exit-grace/v1",
    supported: true,
    passed: true,
    rootPid,
    requiredConsecutiveEmpty: 2,
    consecutiveEmpty: 2,
    observations: [
      passingCensus(rootPid, "2026-07-16T00:00:00.200Z"),
      passingCensus(rootPid, "2026-07-16T00:00:00.250Z"),
    ],
    error: null,
  };
}

function passingCdpClosure() {
  const closeEvent = {
    kind: "cdp-close",
    observedAt: "2026-07-16T00:00:00.080Z",
    code: 1000,
    reason: null,
    wasClean: true,
  };
  return {
    closed: true,
    remote: {
      closed: true,
      timedOut: false,
      event: closeEvent,
      terminalCause: closeEvent,
    },
    localFallbackUsed: false,
    local: null,
  };
}

function healthyFinalDiagnostics() {
  return {
    crashCount: 0,
    crashes: [],
    consoleErrors: [],
    unexpectedConsoleErrors: [],
    runtimeExceptions: [],
    unhandledRejections: [],
    windowErrors: [],
    networkFailures: [],
    commandErrors: [],
    protocolErrors: [],
    handlerErrors: [],
  };
}

function passingBrowserCloseReceipt(rootPid = 101) {
  return {
    kind: "controlled-browser-close",
    schemaVersion: "candlescope-controlled-browser-close/v1",
    requestedAt: "2026-07-16T00:00:00.000Z",
    commandDispatchedAt: "2026-07-16T00:00:00.010Z",
    transportAccepted: true,
    commandSettledAt: "2026-07-16T00:00:00.050Z",
    commandCompleted: true,
    commandTimedOut: false,
    commandError: null,
    commandTerminalCause: null,
    processWasRunningAtRequest: true,
    processExitedAt: "2026-07-16T00:00:00.100Z",
    processExitCode: 0,
    processSignal: null,
    processExitedAfterRequest: true,
    gracefulProcessExit: true,
    forceTerminationUsed: false,
    descendantTerminationUsed: false,
    descendantExitGrace: passingDescendantExitGrace(rootPid),
    remoteCdpClosedAfterRequest: true,
    remoteCdpClosedAt: "2026-07-16T00:00:00.080Z",
    localCdpFallbackUsed: false,
    acceptedCloseRace: true,
    passed: true,
  };
}

function passingHeadedChromeCloseEvidence(rootPid = 101) {
  return {
    kind: "headed-chrome",
    pid: rootPid,
    exited: true,
    stoppedAt: "2026-07-16T00:00:00.100Z",
    exitCode: 0,
    signal: null,
    forceStopRequestedAt: null,
    diagnosticsClosed: true,
    cdpClosure: passingCdpClosure(),
    treeStopReceipt: passingTreeStopReceipt(rootPid),
    browserCloseReceipt: passingBrowserCloseReceipt(rootPid),
  };
}

test("diagnostic rollback authority faults only the exact manifest drawing worker construction", () => {
  const fixture = createDiagnosticBootstrapFixture();
  const drawingWorkerUrl = new URL(
    `/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
    fixture.location,
  ).href;

  assert.equal(fixture.sessionStorage.getItem(CONTROLLED_ROLLBACK_SESSION_KEY), null);
  assert.doesNotThrow(() => new fixture.window.Worker(
    "http://127.0.0.1:15173/assets/unrelated.worker.js",
    { type: "module", name: "candlescope-drawing-worker" },
  ));
  assert.doesNotThrow(() => new fixture.window.Worker(
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    { type: "module", name: "candlescope-drawing-worker" },
  ));
  assert.doesNotThrow(() => new fixture.window.Worker(drawingWorkerUrl, {
    name: "candlescope-drawing-worker",
  }));
  assert.doesNotThrow(() => new fixture.window.Worker(drawingWorkerUrl, {
    type: "module",
    name: "other-worker",
  }));
  assert.throws(
    () => new fixture.window.Worker(drawingWorkerUrl, {
      type: "module",
      name: "candlescope-drawing-worker",
    }),
    (error) => error?.name === "NotSupportedError"
      && error?.message === "Controlled drawing worker construction failure",
  );

  const snapshot = fixture.snapshot();
  assert.equal(snapshot.authorityAccepted, true);
  assert.equal(snapshot.tokenRemoved, true);
  assert.equal(snapshot.drillId, "worker-init-failure");
  assert.equal(snapshot.workerConstructorAttempts, 3);
  assert.equal(snapshot.workerConstructionFailures, 1);
  assert.equal(snapshot.workerCreations, 2);
  assert.equal(snapshot.observed, true);
  assert.equal(snapshot.constructionFailure.url, drawingWorkerUrl);
  assert.equal(snapshot.constructionFailure.workerType, "module");
  assert.equal(snapshot.constructionFailure.workerName, "candlescope-drawing-worker");
  assert.equal(snapshot.constructionFailure.name, "NotSupportedError");
  assert.equal(fixture.nativeConstructions.length, 4);
  assert.deepEqual(fixture.reports.filter((report) => (
    report.kind === "worker-constructor-fault"
  )), [{
    kind: "worker-constructor-fault",
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drillId: "worker-init-failure",
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    sequence: 1,
    url: drawingWorkerUrl,
    workerType: "module",
    workerName: "candlescope-drawing-worker",
  }]);
});

test("diagnostic rollback bootstrap rejects missing or mismatched session authority", async (t) => {
  const cases = [
    { name: "missing token", token: null, tokenRemoved: false },
    {
      name: "mismatched token",
      token: controlledRollbackToken({ authorityToken: "wrong-authority" }),
      tokenRemoved: true,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const fixture = createDiagnosticBootstrapFixture({ token: scenario.token });
      assert.doesNotThrow(() => new fixture.window.Worker(
        `http://127.0.0.1:15173/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
        { type: "module", name: "candlescope-drawing-worker" },
      ));
      const snapshot = fixture.snapshot();
      assert.equal(snapshot.authorityAccepted, false);
      assert.equal(snapshot.tokenRemoved, scenario.tokenRemoved);
      assert.equal(snapshot.drillId, null);
      assert.equal(snapshot.workerConstructorAttempts, 1);
      assert.equal(snapshot.workerConstructionFailures, 0);
      assert.equal(snapshot.workerCreations, 1);
      assert.equal(snapshot.observed, false);
      assert.equal(fixture.nativeConstructions.length, 1);
      assert.equal(fixture.reports.some((report) => (
        report.kind === "worker-constructor-fault"
      )), false);
    });
  }
});

test("diagnostic rollback authority binds exact worker, storage, and lifecycle variants", async (t) => {
  assert.deepEqual([...CONTROLLED_ROLLBACK_DRILL_IDS], [
    "worker-init-failure",
    "offscreen-canvas-unsupported",
    "worker-stale-generation",
    "indexeddb-quota-blocked",
    "active-gesture-chart-boundary",
    "series-rebuild-before-export",
    "continuous-dpr-resize",
    "canary-to-legacy-snapshot",
  ]);
  assert.deepEqual([...CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS], ["quota", "blocked"]);

  await t.test("accepts active-gesture lifecycle without a variant", () => {
    const fixture = createDiagnosticBootstrapFixture({
      token: controlledRollbackToken({
        drillId: "active-gesture-chart-boundary",
        variant: null,
      }),
    });
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.authorityAccepted, true);
    assert.equal(snapshot.drillId, "active-gesture-chart-boundary");
    assert.equal(snapshot.variant, null);
  });

  await t.test("accepts series-rebuild export lifecycle without a variant", () => {
    const fixture = createDiagnosticBootstrapFixture({
      token: controlledRollbackToken({
        drillId: "series-rebuild-before-export",
        variant: null,
      }),
    });
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.authorityAccepted, true);
    assert.equal(snapshot.drillId, "series-rebuild-before-export");
    assert.equal(snapshot.variant, null);
  });

  for (const variant of CONTROLLED_STORAGE_ROLLBACK_DRILL_VARIANTS) {
    await t.test(`accepts IndexedDB ${variant}`, () => {
      const fixture = createDiagnosticBootstrapFixture({
        token: controlledRollbackToken({
          drillId: "indexeddb-quota-blocked",
          variant,
        }),
      });
      const snapshot = fixture.snapshot();
      assert.equal(snapshot.authorityAccepted, true);
      assert.equal(snapshot.drillId, "indexeddb-quota-blocked");
      assert.equal(snapshot.variant, variant);
      assert.match(snapshot.documentInstanceId, /\S/);
      assert.equal(fixture.sessionStorage.getItem(CONTROLLED_ROLLBACK_SESSION_KEY), null);
    });
  }

  const rejected = [
    controlledRollbackToken({ variant: "quota" }),
    controlledRollbackToken({ drillId: "indexeddb-quota-blocked", variant: null }),
    controlledRollbackToken({ drillId: "indexeddb-quota-blocked", variant: "other" }),
    controlledRollbackToken({ drillId: "active-gesture-chart-boundary", variant: "chart-type" }),
    controlledRollbackToken({ drillId: "series-rebuild-before-export", variant: "chart-type" }),
  ];
  for (const [index, token] of rejected.entries()) {
    await t.test(`rejects mismatched variant ${index + 1}`, () => {
      const snapshot = createDiagnosticBootstrapFixture({ token }).snapshot();
      assert.equal(snapshot.authorityAccepted, false);
      assert.equal(snapshot.drillId, null);
      assert.equal(snapshot.variant, null);
    });
  }
});

test("series-rebuild export gate pauses exactly the first product checkpoint", async () => {
  const fixture = createDiagnosticBootstrapFixture({
    token: controlledRollbackToken({
      drillId: "series-rebuild-before-export",
      variant: null,
    }),
  });
  const handle = fixture.window[CONTROLLED_ROLLBACK_HANDLE];
  const signal = new AbortController().signal;
  const pending = handle.awaitSeriesRebuildExportCapture({
    transactionId: "drawing-export-1-lease-7",
    leaseId: 7,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 5,
    surfaceGeneration: 3,
    hideDrawings: false,
    signal,
  });
  const paused = fixture.snapshot();
  assert.equal(paused.seriesRebuildExport.checkpointCount, 1);
  assert.equal(paused.seriesRebuildExport.pauseConsumed, true);
  assert.equal(paused.seriesRebuildExport.releaseCount, 0);
  assert.equal(paused.seriesRebuildExport.activeCheckpointId, `${CONTROLLED_ROLLBACK_FAULT_ID}:export:1`);
  assert.equal(paused.seriesRebuildExport.checkpoints[0].paused, true);
  assert.equal(paused.seriesRebuildExport.checkpoints[0].releasedAt, null);

  const releasedSnapshot = handle.releaseSeriesRebuildExportCapture({
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    checkpointId: paused.seriesRebuildExport.activeCheckpointId,
  });
  assert.equal(releasedSnapshot.seriesRebuildExport.releaseCount, 1);
  assert.equal(releasedSnapshot.seriesRebuildExport.activeCheckpointId, null);
  const firstReceipt = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(firstReceipt)), {
    accepted: true,
    checkpointId: `${CONTROLLED_ROLLBACK_FAULT_ID}:export:1`,
    paused: true,
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    documentInstanceId: paused.documentInstanceId,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    sequence: 1,
    transactionId: "drawing-export-1-lease-7",
    leaseId: 7,
  });

  const visibleReceipt = await handle.awaitSeriesRebuildExportCapture({
    transactionId: "drawing-export-2-lease-8",
    leaseId: 8,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 5,
    surfaceGeneration: 4,
    hideDrawings: false,
    signal,
  });
  const hiddenReceipt = await handle.awaitSeriesRebuildExportCapture({
    transactionId: "drawing-export-3-lease-9",
    leaseId: 9,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 5,
    surfaceGeneration: null,
    hideDrawings: true,
    signal,
  });
  assert.equal(visibleReceipt.paused, false);
  assert.equal(hiddenReceipt.paused, false);
  const completed = fixture.snapshot();
  assert.equal(completed.seriesRebuildExport.checkpointCount, 3);
  assert.equal(completed.seriesRebuildExport.releaseCount, 1);
  assert.deepEqual(
    completed.seriesRebuildExport.checkpoints.map((checkpoint) => checkpoint.releaseReason),
    ["harness-release", "not-paused", "not-paused"],
  );
  assert.equal(completed.observed, true);
});

test("quota cache-expiry guard proves the full monotonic 35 second wait", async () => {
  let monotonic = 1_000;
  let reads = 0;
  const guard = await waitForControlledQuotaCacheExpiry({
    origin: "http://127.0.0.1:15173",
    readUsageAndQuota: async () => {
      reads += 1;
      return { quotaBytes: 1, overrideActive: true, observedAt: "after-cache-expiry" };
    },
    waitFor: async (milliseconds) => { monotonic += milliseconds; },
    monotonicNow: () => monotonic,
    observedAt: (() => {
      const values = ["guard-start", "guard-complete"];
      return () => values.shift();
    })(),
  });
  assert.deepEqual(guard, {
    kind: "indexeddb-bucket-space-cache-expiry",
    cacheTimeLimitMs: 30_000,
    guardMs: 5_000,
    requestedWaitMs: 35_000,
    elapsedMs: 35_000,
    startedAt: "guard-start",
    completedAt: "guard-complete",
    verification: { quotaBytes: 1, overrideActive: true, observedAt: "after-cache-expiry" },
  });
  assert.equal(reads, 1);

  monotonic = 0;
  const earlyWaits = [];
  const recovered = await waitForControlledQuotaCacheExpiry({
    origin: "http://127.0.0.1:15173",
    readUsageAndQuota: async () => ({ quotaBytes: 1, overrideActive: true }),
    waitFor: async (milliseconds) => {
      earlyWaits.push(milliseconds);
      monotonic += earlyWaits.length === 1 ? 34_999 : milliseconds;
    },
    monotonicNow: () => monotonic,
  });
  assert.deepEqual(earlyWaits, [35_000, 1]);
  assert.equal(recovered.elapsedMs, 35_000);

  monotonic = 0;
  await assert.rejects(
    waitForControlledQuotaCacheExpiry({
      origin: "http://127.0.0.1:15173",
      readUsageAndQuota: async () => { throw new Error("must not read"); },
      waitFor: async () => {},
      monotonicNow: () => monotonic,
    }),
    /elapsed only 0ms; required 35000ms/,
  );
});

test("quota preparation binds the sacrificial database, protocol override, cache guard, and native probe", async () => {
  const origin = "http://127.0.0.1:15173";
  const order = [];
  const published = [];
  let usageRead = 0;
  const result = await prepareControlledQuotaOverride({
    binding: {
      runId: CONTROLLED_ROLLBACK_RUN_ID,
      faultId: CONTROLLED_ROLLBACK_FAULT_ID,
      authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
      variant: "quota",
      transactionId: "quota-transaction",
      sequence: 1,
    },
    receiptId: "quota-receipt",
    origin,
    evaluatePreparation: async () => {
      order.push("page-preparation");
      assert.equal(published.length, 1);
      assert.equal(published[0].pageCleanupRequired, true);
      assert.equal(published[0].before, null);
      return controlledQuotaPreparationSnapshot();
    },
    readUsageAndQuota: async () => {
      usageRead += 1;
      order.push(usageRead === 1 ? "usage-before" : "usage-immediate");
      return usageRead === 1
        ? { quotaBytes: 1024, usageBytes: 128, overrideActive: false, observedAt: "before" }
        : { quotaBytes: 1, usageBytes: 128, overrideActive: true, observedAt: "immediate" };
    },
    overrideQuota: async (parameters) => {
      order.push("override");
      assert.deepEqual(parameters, { origin, quotaSize: 1 });
    },
    waitForCacheExpiry: async () => {
      order.push("cache-guard");
      return {
        kind: "indexeddb-bucket-space-cache-expiry",
        cacheTimeLimitMs: 30_000,
        guardMs: 5_000,
        requestedWaitMs: 35_000,
        elapsedMs: 35_001,
        startedAt: "guard-start",
        completedAt: "guard-complete",
        verification: {
          quotaBytes: 1,
          usageBytes: 128,
          overrideActive: true,
          observedAt: "after-cache-expiry",
        },
      };
    },
    evaluateProbe: async () => {
      order.push("native-probe");
      return controlledQuotaProbeSnapshot();
    },
    evaluateCleanup: async () => { throw new Error("cleanup must not run"); },
    publish: (state) => { published.push(structuredClone(state)); },
    observedAt: () => "override-command",
  });
  assert.deepEqual(order, [
    "page-preparation",
    "usage-before",
    "override",
    "usage-immediate",
    "cache-guard",
    "native-probe",
  ]);
  assert.equal(result.prepared, true);
  assert.equal(result.sacrificialStoreName, "quota-probe");
  assert.deepEqual(result.quotaPlan, {
    kind: "nonzero-below-existing-usage",
    quotaSizeBytes: 1,
    baselineUsageBytes: 128,
    baselineUsageExceedsQuota: true,
  });
  assert.equal(result.cacheExpiryGuard.elapsedMs, 35_001);
  assert.equal(result.probeSnapshot.storage.quotaProbe.nativeQuotaExceeded, true);
});

test("quota controller rejects zero as unlimited and requires existing usage above the one-byte plan", async (t) => {
  const origin = "http://127.0.0.1:15173";
  const binding = {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    variant: "quota",
    transactionId: "quota-transaction",
    sequence: 1,
  };

  await t.test("rejects a baseline whose usage does not exceed one byte", async () => {
    const commands = [];
    let reads = 0;
    await assert.rejects(
      prepareControlledQuotaOverride({
        binding,
        receiptId: "baseline-too-small",
        origin,
        overrideQuota: async (parameters) => { commands.push(parameters); },
        readUsageAndQuota: async () => {
          reads += 1;
          return reads === 1
            ? { usageBytes: 1, quotaBytes: 1024, overrideActive: false }
            : { usageBytes: 0, quotaBytes: 1024, overrideActive: false };
        },
        evaluatePreparation: async () => controlledQuotaPreparationSnapshot(),
        evaluateProbe: async () => controlledQuotaProbeSnapshot(),
        evaluateCleanup: async () => controlledQuotaReleaseSnapshot({ forcedCleanup: true }),
        publish: () => {},
      }),
      /baseline quota is invalid/,
    );
    assert.deepEqual(commands, []);
  });

  for (const scenario of ["immediate", "after-cache-expiry"]) {
    await t.test(`rejects a zero-byte ${scenario} receipt`, async () => {
      const commands = [];
      let reads = 0;
      const waitForCacheExpiry = async () => ({
        kind: "indexeddb-bucket-space-cache-expiry",
        cacheTimeLimitMs: 30_000,
        guardMs: 5_000,
        requestedWaitMs: 35_000,
        elapsedMs: 35_000,
        startedAt: "guard-start",
        completedAt: "guard-complete",
        verification: {
          usageBytes: 128,
          quotaBytes: scenario === "after-cache-expiry" ? 0 : 1,
          overrideActive: true,
        },
      });
      await assert.rejects(
        prepareControlledQuotaOverride({
          binding,
          receiptId: `zero-${scenario}`,
          origin,
          overrideQuota: async (parameters) => { commands.push({ ...parameters }); },
          readUsageAndQuota: async () => {
            reads += 1;
            if (reads === 1) {
              return { usageBytes: 128, quotaBytes: 1024, overrideActive: false };
            }
            if (reads === 2) {
              return {
                usageBytes: 128,
                quotaBytes: scenario === "immediate" ? 0 : 1,
                overrideActive: true,
              };
            }
            return { usageBytes: 0, quotaBytes: 1024, overrideActive: false };
          },
          evaluatePreparation: async () => controlledQuotaPreparationSnapshot(),
          evaluateProbe: async () => controlledQuotaProbeSnapshot(),
          evaluateCleanup: async () => controlledQuotaReleaseSnapshot({ forcedCleanup: true }),
          waitForCacheExpiry,
          publish: () => {},
        }),
        scenario === "immediate"
          ? /quota override did not become authoritative/
          : /quota cache-expiry verification failed/,
      );
      assert.deepEqual(commands, [
        { origin, quotaSize: 1 },
        { origin },
      ]);
      assert.ok(commands.every((command) => command.quotaSize !== 0));
    });
  }
});

test("quota finalizer independently retries override, lost page cleanup, and restoration drift", async () => {
  const origin = "http://127.0.0.1:15173";
  const commands = [];
  let clearAttempts = 0;
  let cleanupAttempts = 0;
  let usageReads = 0;
  let active = null;
  const overrideQuota = async (parameters) => {
    commands.push({ ...parameters });
    if (!("quotaSize" in parameters)) {
      clearAttempts += 1;
      if (clearAttempts === 1) throw new Error("immediate clear failed");
    }
  };
  const readUsageAndQuota = async () => {
    usageReads += 1;
    if (usageReads === 1) {
      return { quotaBytes: 1024, usageBytes: 128, overrideActive: false };
    }
    if (usageReads === 2) throw new Error("immediate verification read failed");
    if (usageReads === 3) {
      return { quotaBytes: 2048, usageBytes: 128, overrideActive: false };
    }
    return { quotaBytes: 1024, usageBytes: 128, overrideActive: false };
  };
  const evaluateCleanup = async () => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) throw new Error("Runtime.evaluate cleanup response lost");
    return controlledQuotaReleaseSnapshot({ forcedCleanup: true });
  };
  await assert.rejects(
    prepareControlledQuotaOverride({
      binding: {
        runId: CONTROLLED_ROLLBACK_RUN_ID,
        faultId: CONTROLLED_ROLLBACK_FAULT_ID,
        authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
        variant: "quota",
        transactionId: "quota-transaction",
        sequence: 1,
      },
      receiptId: "quota-receipt",
      origin,
      overrideQuota,
      readUsageAndQuota,
      evaluatePreparation: async () => controlledQuotaPreparationSnapshot(),
      evaluateProbe: async () => controlledQuotaProbeSnapshot(),
      evaluateCleanup,
      publish: (state) => { active = state; },
      observedAt: () => "2026-07-16T08:00:00.000Z",
    }),
    /immediate verification read failed/,
  );
  assert.equal(clearAttempts, 1);
  assert.equal(cleanupAttempts, 1);
  assert.equal(active.overrideCleared, false);
  assert.equal(active.pageCleanupCompleted, false);
  assert.equal(active.overrideCleanupError, "immediate clear failed");
  assert.equal(active.pageCleanupError, "Runtime.evaluate cleanup response lost");

  active = await forceCleanupControlledQuotaOverride(active, {
    overrideQuota,
    evaluateCleanup,
    readUsageAndQuota,
    publish: (state) => { active = state; },
    reason: "browser-finalize",
    observedAt: () => "2026-07-16T08:00:01.000Z",
  });
  assert.equal(active.overrideCleared, true);
  assert.equal(active.pageCleanupCompleted, true);
  assert.equal(active.restorationError, "controlled quota restoration drifted");
  assert.equal(active.restored.quotaBytes, 2048);

  active = await forceCleanupControlledQuotaOverride(active, {
    overrideQuota,
    evaluateCleanup,
    readUsageAndQuota,
    publish: (state) => { active = state; },
    reason: "browser-finalize-retry",
  });
  assert.equal(active.restorationError, null);
  assert.equal(active.restored.quotaBytes, 1024);
  assert.equal(clearAttempts, 2);
  assert.equal(cleanupAttempts, 2);
  const effectCounts = { clearAttempts, cleanupAttempts, usageReads };
  active = await forceCleanupControlledQuotaOverride(active, {
    overrideQuota,
    evaluateCleanup,
    readUsageAndQuota,
    reason: "idempotence-check",
  });
  assert.deepEqual({ clearAttempts, cleanupAttempts, usageReads }, effectCounts);
  assert.equal(active.forcedCleanup, true);
  assert.deepEqual(commands, [
    { origin, quotaSize: 1 },
    { origin },
    { origin },
  ]);
});

test("explicit quota release clears override, deletes the exact page database, then verifies restoration", async () => {
  const origin = "http://127.0.0.1:15173";
  const order = [];
  let active = {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    variant: "quota",
    origin,
    before: { quotaBytes: 1024, overrideActive: false },
    sacrificialDatabaseName: `candlescope-rollback-quota-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
    sacrificialStoreName: "quota-probe",
    overrideActive: true,
    overrideCleared: false,
    overrideResetRequired: true,
    pageCleanupCompleted: false,
    pageCleanupRequired: true,
    releaseAccepted: false,
    forcedCleanup: false,
  };
  active = await releaseControlledQuotaOverride(active, {
    overrideQuota: async (parameters) => {
      order.push("clear-override");
      assert.deepEqual(parameters, { origin });
    },
    evaluateCleanup: async (_faultId, forcedCleanup) => {
      order.push("page-cleanup");
      assert.equal(forcedCleanup, false);
      return controlledQuotaReleaseSnapshot({ forcedCleanup: false });
    },
    readUsageAndQuota: async () => {
      order.push("restored-usage");
      return { quotaBytes: 1024, overrideActive: false, observedAt: "restored" };
    },
    publish: (state) => { active = state; },
    observedAt: () => "clear-command",
  });
  assert.deepEqual(order, ["clear-override", "page-cleanup", "restored-usage"]);
  assert.equal(active.releaseAccepted, true);
  assert.equal(active.pageCleanupCompleted, true);
  assert.equal(active.releaseSnapshot.storage.quotaRelease.forcedCleanup, false);
  assert.equal(active.restored.overrideActive, false);

  await assert.rejects(
    releaseControlledQuotaOverride({
      ...active,
      overrideActive: true,
      overrideCleared: false,
      overrideResetRequired: true,
      pageCleanupCompleted: false,
      pageCleanupRequired: true,
      releaseAccepted: false,
      releaseSnapshot: null,
      restored: null,
    }, {
      overrideQuota: async () => {},
      evaluateCleanup: async () => controlledQuotaReleaseSnapshot({ forcedCleanup: false }),
      readUsageAndQuota: async () => ({ quotaBytes: 2048, overrideActive: false }),
      publish: (state) => { active = state; },
    }),
    /restoration drifted/,
  );
  assert.equal(active.pageCleanupCompleted, true);
  assert.equal(active.releaseAccepted, false);
  assert.equal(active.restored.quotaBytes, 2048);
  assert.equal(active.restorationError, "controlled quota restoration drifted");
});

test("quota IndexedDB seam commits a baseline, observes a trusted native abort, and deletes idempotently", async () => {
  const indexedDB = createFakeIndexedDb();
  const fixture = createDiagnosticBootstrapFixture({
    indexedDB,
    token: controlledRollbackToken({
      drillId: "indexeddb-quota-blocked",
      variant: "quota",
    }),
  });
  const handle = fixture.window[CONTROLLED_ROLLBACK_HANDLE];
  const prepared = await handle.prepareQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.deepEqual(
    {
      baselineCommitted: prepared.storage.quotaPreparation.baselineCommitted,
      connectionKeptOpen: prepared.storage.quotaPreparation.connectionKeptOpen,
      databaseName: prepared.storage.quotaPreparation.databaseName,
      storeName: prepared.storage.quotaPreparation.storeName,
    },
    {
      baselineCommitted: true,
      connectionKeptOpen: true,
      databaseName: `candlescope-rollback-quota-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
      storeName: "quota-probe",
    },
  );

  indexedDB.setQuotaFailure({ active: true });
  const probed = await handle.probeQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.equal(probed.storage.quotaProbe.transactionMode, "readwrite");
  assert.equal(probed.storage.quotaProbe.abortEvent.type, "abort");
  assert.equal(probed.storage.quotaProbe.abortEvent.isTrusted, true);
  assert.equal(probed.storage.quotaProbe.transactionError.name, "QuotaExceededError");
  assert.equal(probed.storage.quotaProbe.nativeQuotaExceeded, true);
  assert.match(probed.storage.quotaProbe.attemptedAt, /T/);
  assert.match(probed.storage.quotaProbe.abortEvent.observedAt, /T/);
  assert.match(probed.storage.quotaProbe.observedAt, /T/);

  indexedDB.setQuotaFailure({ active: false });
  const released = await handle.cleanupQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID, false);
  assert.equal(released.storage.quotaRelease.connectionClosed, true);
  assert.equal(released.storage.quotaRelease.deletion.status, "success");
  assert.equal(released.storage.quotaRelease.databaseStillPresent, false);
  assert.equal(released.storage.quotaRelease.forcedCleanup, false);
  assert.equal(released.storage.quotaRelease.completed, true);
  const reverified = await handle.cleanupQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID, true);
  assert.equal(reverified.storage.quotaRelease.completed, true);
  assert.equal(reverified.storage.quotaRelease.databaseStillPresent, false);
  assert.equal(reverified.storage.quotaRelease.forcedCleanup, true);
  assert.match(reverified.storage.quotaRelease.lastVerifiedAt, /T/);
});

test("quota probe evidence fails closed for an untrusted abort", async () => {
  const indexedDB = createFakeIndexedDb();
  const fixture = createDiagnosticBootstrapFixture({
    indexedDB,
    token: controlledRollbackToken({
      drillId: "indexeddb-quota-blocked",
      variant: "quota",
    }),
  });
  const handle = fixture.window[CONTROLLED_ROLLBACK_HANDLE];
  await handle.prepareQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID);
  indexedDB.setQuotaFailure({ active: true, abortTrusted: false });
  const probed = await handle.probeQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.equal(probed.storage.quotaProbe.transactionError.name, "QuotaExceededError");
  assert.equal(probed.storage.quotaProbe.abortEvent.isTrusted, false);
  assert.equal(probed.storage.quotaProbe.nativeQuotaExceeded, false);
  const cleaned = await handle.cleanupQuotaFault(CONTROLLED_ROLLBACK_FAULT_ID, true);
  assert.equal(cleaned.storage.quotaRelease.completed, true);
});

test("blocked finalizer cleans a page fault when the preparation response is lost", async () => {
  let active = null;
  let pageFaultActive = false;
  const binding = {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    variant: "blocked",
    transactionId: "blocked-transaction",
    sequence: 1,
  };
  await assert.rejects(
    prepareControlledBlockedFault({
      binding,
      receiptId: "blocked-receipt",
      evaluatePreparation: async () => {
        pageFaultActive = true;
        throw new Error("Runtime.evaluate response lost");
      },
      publish: (state) => { active = state; },
    }),
    /response lost/,
  );
  assert.ok(active);
  assert.equal(active.prepared, false);
  assert.equal(active.released, false);
  assert.equal(pageFaultActive, true);

  const cleanup = await forceCleanupControlledBlockedFault(active, {
    evaluateCleanup: async (faultId) => {
      assert.equal(faultId, CONTROLLED_ROLLBACK_FAULT_ID);
      assert.equal(pageFaultActive, true);
      pageFaultActive = false;
      return {
        storage: {
          blockedRelease: {
            completed: true,
            databaseStillPresent: false,
          },
        },
      };
    },
    reason: "browser-finalize",
  });
  active = cleanup.state;
  assert.equal(pageFaultActive, false);
  assert.equal(active.released, true);
  assert.equal(active.forcedCleanup, true);
  assert.equal(active.forcedCleanupReason, "browser-finalize");
  assert.deepEqual(cleanup.receipt, {
    complete: true,
    forced: true,
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
  });
});

test("blocked IndexedDB seam routes one exact product open through a trusted native event", async () => {
  const indexedDB = createFakeIndexedDb();
  const fixture = createDiagnosticBootstrapFixture({
    indexedDB,
    token: controlledRollbackToken({
      drillId: "indexeddb-quota-blocked",
      variant: "blocked",
    }),
  });
  const handle = fixture.window[CONTROLLED_ROLLBACK_HANDLE];
  const realRequest = fixture.window.indexedDB.open("candlescope-drawings-v2", 1);
  const realDatabase = await waitForFakeRequest(realRequest);
  realDatabase.onversionchange = () => realDatabase.close();

  const prepared = await handle.prepareBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.equal(prepared.storage.blockedInterceptorInstalled, true);
  assert.equal(prepared.storage.blockedPreparation.prepared, true);
  assert.equal(prepared.storage.blockedPreparation.realCloseCountAfter, 1);
  assert.equal(
    prepared.storage.blockedPreparation.faultDatabaseName,
    `candlescope-rollback-blocked-${CONTROLLED_ROLLBACK_RUN_ID}-${CONTROLLED_ROLLBACK_FAULT_ID}`,
  );

  const unrelated = fixture.window.indexedDB.open("unrelated-database", 1);
  assert.equal((await waitForFakeRequest(unrelated)).name, "unrelated-database");
  const routed = fixture.window.indexedDB.open("candlescope-drawings-v2", 1);
  await new Promise((resolve) => routed.addEventListener("blocked", resolve));
  const blocked = handle.snapshot();
  assert.equal(blocked.storage.blockedRoute.consumed, true);
  assert.equal(blocked.storage.blockedEvent.isTrusted, true);
  assert.equal(blocked.storage.blockedEvent.oldVersion, 1);
  assert.equal(blocked.storage.blockedEvent.newVersion, 2);

  const released = await handle.releaseBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.equal(released.storage.blockedRoute.settled, "success-after-keeper-close");
  assert.equal(released.storage.blockedRelease.completed, true);
  assert.equal(released.storage.blockedRelease.databaseStillPresent, false);
  await assert.rejects(
    handle.prepareBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID),
    /cannot be prepared/,
  );
});

test("blocked IndexedDB seam cleans an untrusted event and fails closed on install drift", async () => {
  const indexedDB = createFakeIndexedDb({ blockedEventTrusted: false });
  const fixture = createDiagnosticBootstrapFixture({
    indexedDB,
    token: controlledRollbackToken({
      drillId: "indexeddb-quota-blocked",
      variant: "blocked",
    }),
  });
  const handle = fixture.window[CONTROLLED_ROLLBACK_HANDLE];
  const realDatabase = await waitForFakeRequest(
    fixture.window.indexedDB.open("candlescope-drawings-v2", 1),
  );
  realDatabase.onversionchange = () => realDatabase.close();
  await handle.prepareBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID);
  const routed = fixture.window.indexedDB.open("candlescope-drawings-v2", 1);
  await new Promise((resolve) => routed.addEventListener("blocked", resolve));
  await assert.rejects(
    handle.releaseBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID),
    /cannot be released/,
  );
  const cleanup = await handle.cleanupBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID);
  assert.equal(cleanup.storage.blockedRelease.forcedCleanup, true);
  assert.equal(cleanup.storage.blockedRelease.completed, true);
  assert.equal(cleanup.storage.blockedRelease.databaseStillPresent, false);

  const immutableFactory = createFakeIndexedDb({ extensible: false });
  const rejectedFixture = createDiagnosticBootstrapFixture({
    indexedDB: immutableFactory,
    token: controlledRollbackToken({
      drillId: "indexeddb-quota-blocked",
      variant: "blocked",
    }),
  });
  const rejectedState = rejectedFixture.snapshot();
  assert.equal(rejectedState.storage.blockedInterceptorInstalled, false);
  assert.equal(
    rejectedState.storage.blockedPreparation.reason,
    "indexeddb-open-interceptor-install-failed",
  );
  await assert.rejects(
    rejectedFixture.window[CONTROLLED_ROLLBACK_HANDLE]
      .prepareBlockedFault(CONTROLLED_ROLLBACK_FAULT_ID),
    /cannot be prepared/,
  );
});

test("diagnostic rollback bootstrap counts and synchronously fails repeated exact faults", () => {
  const fixture = createDiagnosticBootstrapFixture();
  const construct = () => new fixture.window.Worker(
    `http://127.0.0.1:15173/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
    { type: "module", name: "candlescope-drawing-worker" },
  );
  assert.throws(construct, { name: "NotSupportedError" });
  assert.throws(construct, { name: "NotSupportedError" });

  const snapshot = fixture.snapshot();
  assert.equal(snapshot.workerConstructorAttempts, 2);
  assert.equal(snapshot.workerConstructionFailures, 2);
  assert.equal(snapshot.workerCreations, 0);
  assert.equal(snapshot.observed, true);
  assert.equal(fixture.nativeConstructions.length, 0);
  assert.equal(fixture.reports.filter((report) => (
    report.kind === "worker-constructor-fault"
  )).length, 2);
});

test("asset tracker accepts only the completely clean initial no-worker state", async () => {
  const cleanFixture = await createWorkerConstructionFaultTrackerFixture();
  let snapshot = cleanFixture.tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(snapshot.cleanInitialWorkerStateAccepted, true);
  assert.equal(snapshot.drawingWorkerTargetCount, 0);
  assert.equal(snapshot.workerConstructions.length, 0);
  assert.equal(snapshot.workerConstructionFaults.length, 0);
  assert.equal(snapshot.unclaimedDrawingWorkerConstructionCount, 0);
  cleanFixture.tracker.dispose();

  const unclaimedFixture = await createWorkerConstructionFaultTrackerFixture();
  await emitWorkerConstruction(
    unclaimedFixture.cdp,
    `http://127.0.0.1:15173/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
    "module",
    { controlledQuery: true },
  );
  snapshot = unclaimedFixture.tracker.snapshot();
  assert.equal(snapshot.assetAuthorityPassed, false);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.cleanInitialWorkerStateAccepted, false);
  assert.equal(snapshot.workerConstructions.length, 1);
  assert.equal(snapshot.unclaimedDrawingWorkerConstructionCount, 1);
  unclaimedFixture.tracker.dispose();
});

test("asset tracker accepts one exact controlled worker construction fault in the current generation", async () => {
  const fixture = await createWorkerConstructionFaultTrackerFixture();
  await emitWorkerConstructionFault(fixture.cdp);

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.drawingWorkerTargetCount, 0);
  assert.deepEqual(snapshot.workerConstructionFaults, [{
    ...snapshot.workerConstructionFaults[0],
    kind: "controlled-worker-construction-fault",
    generation: 1,
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drillId: "worker-init-failure",
    faultId: CONTROLLED_ROLLBACK_FAULT_ID,
    sequence: 1,
    url: `http://127.0.0.1:15173/${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`,
    path: CONTROLLED_HASHED_DRAWING_WORKER_PATH,
    workerType: "module",
    workerName: "candlescope-drawing-worker",
  }]);
  fixture.tracker.dispose();
});

test("asset tracker rejects mismatched controlled worker construction fault receipts", async (t) => {
  const cases = [
    { name: "run id", overrides: { runId: "other-run" } },
    { name: "token digest", overrides: { authorityTokenSha256: "b".repeat(64) } },
    { name: "fault id", overrides: { faultId: "not-a-fault-id" } },
    {
      name: "worker URL",
      overrides: { url: "http://127.0.0.1:15173/assets/drawing.worker-other.js" },
    },
    { name: "worker type", overrides: { workerType: "classic" } },
    { name: "worker name", overrides: { workerName: "other-worker" } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await createWorkerConstructionFaultTrackerFixture();
      await emitWorkerConstructionFault(fixture.cdp, scenario.overrides);
      const snapshot = fixture.tracker.snapshot();
      assert.equal(snapshot.passed, false);
      assert.equal(snapshot.workerConstructionFaults.length, 0);
      assert.equal(snapshot.provenanceErrors.length, 1);
      assert.equal(snapshot.provenanceErrors[0].kind, "worker-constructor-fault-untrusted");
      assert.equal(snapshot.cleanInitialWorkerStateAccepted, false);
      fixture.tracker.dispose();
    });
  }
});

test("asset tracker fails closed on a duplicate current-generation construction fault", async () => {
  const fixture = await createWorkerConstructionFaultTrackerFixture();
  await emitWorkerConstructionFault(fixture.cdp);
  await emitWorkerConstructionFault(fixture.cdp);

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.workerConstructionFaults.length, 1);
  assert.equal(snapshot.provenanceErrors.length, 1);
  assert.equal(snapshot.provenanceErrors[0].kind, "worker-constructor-fault-duplicate");
  fixture.tracker.dispose();
});

test("managed URL guard treats HTTP and WebSocket scheme families consistently", () => {
  const origin = "http://127.0.0.1:15173";
  assert.equal(controlledManagedUrlAllowed("http://127.0.0.1:15173/api/v1/exchanges", origin), true);
  assert.equal(controlledManagedUrlAllowed("ws://127.0.0.1:15173/ws/market", origin), true);
  assert.equal(controlledManagedUrlAllowed("wss://127.0.0.1:15173/ws/market", origin), false);
  assert.equal(controlledManagedUrlAllowed("ws://127.0.0.1:15174/ws/market", origin), false);
  assert.equal(controlledManagedUrlAllowed("ws://localhost:15173/ws/market", origin), false);
  assert.equal(controlledManagedUrlAllowed("https://127.0.0.1:15173/api", origin), false);
  assert.equal(controlledManagedUrlAllowed("blob:http://127.0.0.1:15173/worker-id", origin), true);
  assert.equal(controlledManagedDocumentUrlAllowed("http://127.0.0.1:15173/?drill=1", `${origin}/`), true);
  assert.equal(controlledManagedDocumentUrlAllowed("http://127.0.0.1:15173/missing", `${origin}/`), false);
  assert.equal(controlledManagedDocumentUrlAllowed("http://127.0.0.1:15173/api/v1/", `${origin}/`), false);
});

test("managed origin guard keeps Fetch interception on the top-level page session", async () => {
  const managedUrl = "http://127.0.0.1:15173/";
  const workerBody = "captured drawing worker";
  let releaseWorkerBody;
  const workerBodyReceipt = new Promise((resolve) => { releaseWorkerBody = resolve; });
  const cdp = createFakeCdp({
    onSend: ({ method }) => method === "Fetch.getResponseBody"
      ? workerBodyReceipt
      : undefined,
  });
  const guard = await createManagedOriginGuard(
    cdp,
    managedUrl,
    [CONTROLLED_HASHED_DRAWING_WORKER_PATH],
  );
  const enable = cdp.sends.find((entry) => entry.method === "Fetch.enable");
  assert.ok(enable);
  assert.equal(enable.sessionId, null);
  assert.deepEqual(enable.params.patterns, [
    { urlPattern: "http://*/*", requestStage: "Request" },
    { urlPattern: "https://*/*", requestStage: "Request" },
  ]);

  const allowed = await cdp.emit("Fetch.requestPaused", {
    requestId: "managed-request",
    resourceType: "Script",
    request: { url: "http://127.0.0.1:15173/assets/main.js" },
  });
  assert.equal(allowed[0].status, "fulfilled");
  assert.ok(cdp.sends.some((entry) => (
    entry.method === "Fetch.continueRequest"
    && entry.params.requestId === "managed-request"
    && entry.sessionId === null
  )));

  const workerUrl = `${managedUrl}${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`;
  const workerRequest = await cdp.emit("Fetch.requestPaused", {
    requestId: "worker-fetch-request",
    networkId: "worker-network-request",
    resourceType: "Other",
    request: { url: workerUrl },
  });
  assert.equal(workerRequest[0].status, "fulfilled");
  assert.ok(cdp.sends.some((entry) => (
    entry.method === "Fetch.continueRequest"
    && entry.params.requestId === "worker-fetch-request"
    && entry.params.interceptResponse === true
    && entry.sessionId === null
  )));
  assert.equal(guard.snapshot().armedWorkerResponseCount, 1);
  assert.doesNotThrow(() => guard.assertNoViolations());
  assert.throws(() => guard.assertHealthy(), /armedWorkerResponses/);
  const guardSettlement = guard.settle(500);

  const workerResponsePending = cdp.emit("Fetch.requestPaused", {
    requestId: "worker-fetch-request",
    networkId: "worker-network-request",
    resourceType: "Other",
    responseStatusCode: 200,
    responseStatusText: "OK",
    responseHeaders: [],
    request: { url: workerUrl },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cdp.sends.some((entry) => (
    entry.method === "Fetch.continueResponse"
    && entry.params.requestId === "worker-fetch-request"
  )), false);
  releaseWorkerBody({ result: { body: workerBody, base64Encoded: false } });
  const workerResponse = await workerResponsePending;
  assert.equal(workerResponse[0].status, "fulfilled");
  const settledGuard = await guardSettlement;
  assert.equal(settledGuard.passed, true);
  assert.equal(settledGuard.armedWorkerResponseCount, 0);
  assert.ok(cdp.sends.some((entry) => (
    entry.method === "Fetch.getResponseBody"
    && entry.params.requestId === "worker-fetch-request"
    && entry.sessionId === null
    && entry.recordErrors === false
  )));
  assert.ok(cdp.sends.some((entry) => (
    entry.method === "Fetch.continueResponse"
    && entry.params.requestId === "worker-fetch-request"
    && entry.sessionId === null
  )));
  assert.equal(cdp.sends.filter((entry) => (
    entry.method === "Fetch.continueResponse"
    && entry.params.requestId === "worker-fetch-request"
  )).length, 1);
  const capture = guard.claimWorkerResponseBodyCapture("worker-network-request", workerUrl);
  assert.ok(capture);
  assert.equal(capture.bodyBytes, Buffer.byteLength(workerBody));
  assert.equal(capture.bodySha256, fingerprintFileEntries([{
    relativePath: CONTROLLED_HASHED_DRAWING_WORKER_PATH,
    content: workerBody,
  }]).files[0].sha256);
  assert.equal(capture.claimCount, 1);
  assert.equal(guard.claimWorkerResponseBodyCapture("worker-network-request", workerUrl), null);
  assert.equal(guard.snapshot().workerResponseCaptures[0].claimCount, 1);

  const blocked = await cdp.emit("Fetch.requestPaused", {
    requestId: "off-origin-request",
    resourceType: "Script",
    request: { url: "https://example.invalid/foreign.js" },
  });
  assert.equal(blocked[0].status, "fulfilled");
  assert.ok(cdp.sends.some((entry) => (
    entry.method === "Fetch.failRequest"
    && entry.params.requestId === "off-origin-request"
    && entry.params.errorReason === "BlockedByClient"
    && entry.sessionId === null
  )));
  assert.equal(guard.snapshot().passed, false);
  assert.throws(() => guard.assertHealthy(), /off-origin-request-blocked/);
  guard.dispose();
});

test("managed origin guard unblocks a failed worker body capture and records it fail closed", async () => {
  const managedUrl = "http://127.0.0.1:15173/";
  const workerUrl = `${managedUrl}${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`;
  const cdp = createFakeCdp({
    onSend: ({ method }) => {
      if (method === "Fetch.getResponseBody") throw new Error("simulated body read failure");
      return undefined;
    },
  });
  const guard = await createManagedOriginGuard(
    cdp,
    managedUrl,
    [CONTROLLED_HASHED_DRAWING_WORKER_PATH],
  );
  await cdp.emit("Fetch.requestPaused", {
    requestId: "worker-fetch-request",
    networkId: "worker-network-request",
    resourceType: "Other",
    request: { url: workerUrl },
  });
  const response = await cdp.emit("Fetch.requestPaused", {
    requestId: "worker-fetch-request",
    networkId: "worker-network-request",
    resourceType: "Other",
    responseStatusCode: 200,
    request: { url: workerUrl },
  });

  assert.equal(response[0].status, "fulfilled");
  assert.equal(cdp.sends.filter((entry) => (
    entry.method === "Fetch.continueResponse"
    && entry.params.requestId === "worker-fetch-request"
  )).length, 1);
  assert.equal(cdp.sends.find((entry) => (
    entry.method === "Fetch.getResponseBody"
    && entry.params.requestId === "worker-fetch-request"
  )).recordErrors, false);
  assert.equal(guard.claimWorkerResponseBodyCapture("worker-network-request", workerUrl), null);
  const snapshot = guard.snapshot();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.armedWorkerResponseCount, 0);
  assert.equal(snapshot.violations[0].kind, "drawing-worker-response-body-capture-failed");
  assert.match(snapshot.violations[0].error, /simulated body read failure/);
  assert.throws(() => guard.assertHealthy(), /drawing-worker-response-body-capture-failed/);
  guard.dispose();
});

test("managed origin guard rejects worker response identity drift and duplicate captures", async (t) => {
  const managedUrl = "http://127.0.0.1:15173/";
  const workerUrl = `${managedUrl}${CONTROLLED_HASHED_DRAWING_WORKER_PATH}`;
  const makeGuard = async () => {
    const cdp = createFakeCdp({
      onSend: ({ method }) => method === "Fetch.getResponseBody"
        ? { result: { body: "worker", base64Encoded: false } }
        : undefined,
    });
    const guard = await createManagedOriginGuard(
      cdp,
      managedUrl,
      [CONTROLLED_HASHED_DRAWING_WORKER_PATH],
    );
    const request = (overrides = {}) => {
      const { message = {}, ...params } = overrides;
      return cdp.emit("Fetch.requestPaused", {
        requestId: "worker-fetch-request",
        networkId: "worker-network-request",
        resourceType: "Other",
        request: { url: workerUrl },
        ...params,
      }, message);
    };
    const response = (overrides = {}) => {
      const { message = {}, ...params } = overrides;
      return cdp.emit("Fetch.requestPaused", {
        requestId: "worker-fetch-request",
        networkId: "worker-network-request",
        resourceType: "Other",
        responseStatusCode: 200,
        request: { url: workerUrl },
        ...params,
      }, message);
    };
    return { cdp, guard, request, response };
  };

  await t.test("unarmed response", async () => {
    const fixture = await makeGuard();
    await fixture.response();
    const snapshot = fixture.guard.snapshot();
    assert.equal(snapshot.passed, false);
    assert.equal(snapshot.armedWorkerResponseCount, 0);
    assert.match(snapshot.violations[0].error, /identity is invalid/);
    assert.equal(fixture.cdp.sends.some((entry) => entry.method === "Fetch.getResponseBody"), false);
    assert.equal(fixture.cdp.sends.filter((entry) => entry.method === "Fetch.continueResponse").length, 1);
    fixture.guard.dispose();
  });

  await t.test("child-session arm", async () => {
    const fixture = await makeGuard();
    await fixture.request({ message: { sessionId: "worker-session" } });
    const snapshot = fixture.guard.snapshot();
    assert.equal(snapshot.passed, false);
    assert.equal(snapshot.violations[0].kind, "drawing-worker-response-capture-arm-invalid");
    const continued = fixture.cdp.sends.find((entry) => entry.method === "Fetch.continueRequest");
    assert.equal(continued.sessionId, "worker-session");
    assert.equal(continued.params.interceptResponse, undefined);
    fixture.guard.dispose();
  });

  await t.test("unexpected Fetch resource type", async () => {
    const fixture = await makeGuard();
    await fixture.request({ resourceType: "Script" });
    const snapshot = fixture.guard.snapshot();
    assert.equal(snapshot.passed, false);
    assert.equal(snapshot.violations[0].kind, "drawing-worker-response-capture-arm-invalid");
    assert.equal(snapshot.violations[0].resourceType, "Script");
    const continued = fixture.cdp.sends.find((entry) => entry.method === "Fetch.continueRequest");
    assert.equal(continued.params.interceptResponse, undefined);
    fixture.guard.dispose();
  });

  await t.test("network identity mismatch", async () => {
    const fixture = await makeGuard();
    await fixture.request();
    await fixture.response({ networkId: "other-network-request" });
    const snapshot = fixture.guard.snapshot();
    assert.equal(snapshot.passed, false);
    assert.equal(snapshot.armedWorkerResponseCount, 0);
    assert.match(snapshot.violations[0].error, /identity is invalid/);
    assert.equal(fixture.cdp.sends.some((entry) => entry.method === "Fetch.getResponseBody"), false);
    assert.equal(fixture.cdp.sends.filter((entry) => entry.method === "Fetch.continueResponse").length, 1);
    fixture.guard.dispose();
  });

  await t.test("duplicate response capture", async () => {
    const fixture = await makeGuard();
    await fixture.request();
    await fixture.response();
    await fixture.request();
    await fixture.response();
    const snapshot = fixture.guard.snapshot();
    assert.equal(snapshot.passed, false);
    assert.match(snapshot.violations[0].error, /capture is duplicated/);
    assert.equal(snapshot.workerResponseCaptures.length, 1);
    assert.equal(fixture.cdp.sends.filter((entry) => entry.method === "Fetch.getResponseBody").length, 2);
    assert.equal(fixture.cdp.sends.filter((entry) => entry.method === "Fetch.continueResponse").length, 2);
    fixture.guard.dispose();
  });
});

test("flattened CDP command envelopes preserve worker session authority", () => {
  assert.deepEqual(createControlledCdpCommandEnvelope(
    7,
    "Network.getResponseBody",
    { requestId: "shared-request" },
    "worker-session",
  ), {
    id: 7,
    method: "Network.getResponseBody",
    params: { requestId: "shared-request" },
    sessionId: "worker-session",
  });
  assert.deepEqual(createControlledCdpCommandEnvelope(8, "Runtime.evaluate", {}), {
    id: 8,
    method: "Runtime.evaluate",
    params: {},
  });
  assert.throws(() => createControlledCdpCommandEnvelope(0, "Runtime.evaluate"), /id must be positive/);
  assert.throws(
    () => createControlledCdpCommandEnvelope(9, "Runtime.evaluate", {}, 123),
    /sessionId must be null or a non-empty string/,
  );
  assert.throws(
    () => createControlledCdpCommandEnvelope(9, "Runtime.evaluate", {}, "   "),
    /sessionId must be null or a non-empty string/,
  );
});

test("controlled CDP parser preserves flattened response and event sessions", () => {
  const workerResponse = parseControlledCdpMessage(JSON.stringify({
    id: 7,
    sessionId: "worker-session",
    result: { body: "encoded", base64Encoded: true },
  }));
  assert.deepEqual(workerResponse, {
    kind: "response",
    id: 7,
    sessionId: "worker-session",
    result: { body: "encoded", base64Encoded: true },
  });
  assert.equal(assertControlledCdpResponseSession(workerResponse, "worker-session"), true);
  assert.throws(
    () => assertControlledCdpResponseSession(workerResponse, null),
    /session mismatch/,
  );
  assert.deepEqual(parseControlledCdpMessage(JSON.stringify({
    method: "Network.requestWillBeSent",
    sessionId: "worker-session",
    params: { requestId: "worker-request" },
  })), {
    kind: "event",
    method: "Network.requestWillBeSent",
    sessionId: "worker-session",
    params: { requestId: "worker-request" },
  });
  assert.deepEqual(parseControlledCdpMessage('{"id":8,"result":{}}'), {
    kind: "response",
    id: 8,
    sessionId: null,
    result: {},
  });
  assert.deepEqual(parseControlledCdpMessage('{"method":"Page.loadEventFired"}'), {
    kind: "event",
    method: "Page.loadEventFired",
    sessionId: null,
    params: {},
  });
});

test("detached child command classifier accepts only Chromium's exact root error", () => {
  const detached = parseControlledCdpMessage(JSON.stringify({
    id: 9,
    error: { code: -32001, message: "Session with given id not found." },
  }));
  assert.equal(detached.sessionId, null);
  assert.equal(isControlledDetachedSessionCommandError(detached, "worker-session"), true);

  const invalid = [
    { ...detached, sessionId: "worker-session" },
    { ...detached, error: { ...detached.error, code: -32000 } },
    { ...detached, error: { ...detached.error, message: "Session with given id not found" } },
    { kind: "response", id: 9, sessionId: null, result: {} },
  ];
  for (const message of invalid) {
    assert.equal(isControlledDetachedSessionCommandError(message, "worker-session"), false);
  }
  assert.equal(isControlledDetachedSessionCommandError(detached, null), false);
});

test("controlled CDP parser rejects ambiguous or malformed protocol messages", () => {
  const invalidMessages = [
    "not-json",
    "null",
    "[]",
    "1",
    "{}",
    '{"id":0,"result":{}}',
    '{"id":1.5,"result":{}}',
    '{"id":"1","result":{}}',
    '{"id":1,"method":"Page.loadEventFired","result":{}}',
    '{"id":1}',
    '{"id":1,"result":{},"error":{}}',
    '{"id":1,"result":null}',
    '{"method":"   ","params":{}}',
    '{"method":"Page.loadEventFired","params":[]}',
    '{"method":"Page.loadEventFired","params":null}',
    '{"method":"Page.loadEventFired","sessionId":"   "}',
    '{"method":"Page.loadEventFired","sessionId":null}',
    '{"method":"Page.loadEventFired","sessionId":12}',
  ];
  for (const raw of invalidMessages) {
    assert.throws(() => parseControlledCdpMessage(raw), undefined, raw);
  }
  assert.throws(() => parseControlledCdpMessage(Buffer.from("{}")), /must be textual JSON/);
});

test("controlled diagnostics require dedicated, shared, and service workers", () => {
  assert.deepEqual(CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES, {
    worker: { runtime: true, network: true, fetch: false },
    shared_worker: { runtime: true, network: true, fetch: true },
    service_worker: { runtime: true, network: true, fetch: true },
  });
  assert.equal(Object.isFrozen(CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES), true);
  assert.ok(Object.values(CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES).every(Object.isFrozen));
  assert.deepEqual(CONTROLLED_DIAGNOSTIC_WORKER_TYPES, [
    "worker",
    "shared_worker",
    "service_worker",
  ]);
  assert.equal(Object.isFrozen(CONTROLLED_DIAGNOSTIC_WORKER_TYPES), true);
});

test("controlled CDP options select a fixed headed production configuration", () => {
  const defaults = normalizeControlledCdpOptions({ chromePath: "" });
  assert.deepEqual(defaults.viewport, { width: 1440, height: 900 });
  assert.equal(defaults.documentAuthority, "document");
  assert.equal(defaults.dpr, 1);
  assert.equal(defaults.engineMode, "scene-canary");
  assert.equal(defaults.interactionSurfaceMode, "overlay");
  assert.equal(defaults.rasterBackend, "worker");
  assert.equal(defaults.timeoutMs, 45_000);
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(defaults.viewport), true);

  const configured = normalizeControlledCdpOptions({
    chromePath: "C:\\controlled\\chrome.exe",
    documentAuthority: "legacy",
    dpr: 1.5,
    engineMode: "legacy",
    interactionSurfaceMode: "legacy",
    mockBars: 512,
    mockEndTime: 2_000_000_000,
    mockIntervalSeconds: 60,
    rasterBackend: "main-thread",
    timeoutMs: 90_000,
    viewport: { width: 1280, height: 720 },
  });
  assert.deepEqual(configured, {
    chromePath: "C:\\controlled\\chrome.exe",
    documentAuthority: "legacy",
    dpr: 1.5,
    engineMode: "legacy",
    interactionSurfaceMode: "legacy",
    mockBars: 512,
    mockEndTime: 2_000_000_000,
    mockIntervalSeconds: 60,
    rasterBackend: "main-thread",
    timeoutMs: 90_000,
    viewport: { width: 1280, height: 720 },
  });
});

test("controlled CDP rejects external browser, server, profile, and transport state", () => {
  for (const forbidden of [
    { url: "http://example.test" },
    { cdpUrl: "ws://example.test/devtools/page/fake" },
    { webSocketUrl: "ws://127.0.0.1:9999/devtools/page/fake" },
    { headless: false },
    { transport: {} },
    { spawn: () => {} },
    { processFactory: () => {} },
    { profileDirectory: "C:\\external-profile" },
    { debugPort: 9222 },
    { apiPort: 8000 },
    { previewPort: 15173 },
    { browserArgs: [] },
    { environment: {} },
    { frontendRoot: "C:\\external-repository" },
  ]) {
    assert.throws(
      () => normalizeControlledCdpOptions(forbidden),
      /does not accept externally controlled state/,
    );
  }
  assert.throws(() => normalizeControlledCdpOptions({ unknown: true }), /Unknown controlled CDP option/);
  assert.throws(() => normalizeControlledCdpOptions({ dpr: 0 }), /dpr must be between/);
  assert.throws(
    () => normalizeControlledCdpOptions({ documentAuthority: "external" }),
    /documentAuthority must be document or legacy/,
  );
  assert.throws(
    () => normalizeControlledCdpOptions({ viewport: { width: 1280, height: 720, mobile: false } }),
    /Unknown viewport option/,
  );
});

test("controlled build environment strips ambient Vite values and records explicit production inputs", () => {
  const environment = controlledBuildEnvironment({
    chromePath: "",
    documentAuthority: "legacy",
    engineMode: "scene",
    interactionSurfaceMode: "overlay",
    rasterBackend: "worker",
  }, {
    PATH: "controlled-path",
    NODE_ENV: "development",
    NODE_OPTIONS: "--require=untrusted-preload.cjs",
    NODE_PATH: "C:\\untrusted-modules",
    VITE_API_BASE: "https://untrusted.invalid/api",
    VITE_DRAWING_ENGINE_MODE: "legacy",
    VITE_UNRELATED_FLAG: "leak",
  });
  assert.deepEqual(environment.explicit, {
    NODE_ENV: "production",
    VITE_API_BASE: "/api/v1",
    VITE_DRAWING_COORDINATE_PROJECTOR: "batch",
    VITE_DRAWING_DOCUMENT_AUTHORITY: "legacy",
    VITE_DRAWING_ENGINE_MODE: "scene",
    VITE_DRAWING_INTERACTION_OVERLAY: "overlay",
    VITE_DRAWING_RASTER_BACKEND: "worker",
  });
  assert.equal(environment.processEnvironment.PATH, "controlled-path");
  assert.equal(environment.processEnvironment.VITE_UNRELATED_FLAG, undefined);
  assert.equal(environment.processEnvironment.NODE_OPTIONS, undefined);
  assert.equal(environment.processEnvironment.NODE_PATH, undefined);
  assert.equal(environment.processEnvironment.NODE_ENV, "production");
});

test("file and controlled build fingerprints are deterministic and content bound", () => {
  const first = fingerprintFileEntries([
    { relativePath: "assets/index.js", content: "console.log('a')" },
    { relativePath: "index.html", content: "<main>A</main>" },
  ]);
  const reordered = fingerprintFileEntries([
    { relativePath: "index.html", content: "<main>A</main>" },
    { relativePath: "assets\\index.js", content: "console.log('a')" },
  ]);
  const changed = fingerprintFileEntries([
    { relativePath: "assets/index.js", content: "console.log('b')" },
    { relativePath: "index.html", content: "<main>A</main>" },
  ]);
  assert.equal(first.sha256, reordered.sha256);
  assert.notEqual(first.sha256, changed.sha256);
  assert.deepEqual(first.files.map((file) => file.path), ["assets/index.js", "index.html"]);
  assert.throws(
    () => fingerprintFileEntries([{ relativePath: "../outside", content: "x" }]),
    /relative and contained/,
  );

  const scene = controlledBuildFingerprint({
    NODE_ENV: "production",
    VITE_DRAWING_ENGINE_MODE: "scene-canary",
  }, first);
  const same = controlledBuildFingerprint({
    VITE_DRAWING_ENGINE_MODE: "scene-canary",
    NODE_ENV: "production",
  }, reordered);
  const legacy = controlledBuildFingerprint({
    NODE_ENV: "production",
    VITE_DRAWING_ENGINE_MODE: "legacy",
  }, first);
  assert.equal(scene.sha256, same.sha256);
  assert.notEqual(scene.sha256, legacy.sha256);
  assert.notEqual(scene.sha256, controlledBuildFingerprint({
    NODE_ENV: "production",
    VITE_DRAWING_ENGINE_MODE: "scene-canary",
  }, changed).sha256);
});

test("production entry asset extraction is same-origin path based and deterministic", () => {
  const assets = extractHtmlAssetPaths(`
    <link rel="stylesheet" href="/assets/main-b.css?rev=1">
    <script type="module" src="/assets/main-a.js"></script>
    <script src="https://cdn.invalid/external.js"></script>
    <link rel="icon" href="data:image/png;base64,abc">
    <link rel="icon" href="/vite.svg">
    <link rel="preload" as="font" href="/assets/font.woff2">
    <script src="/assets/main-a.js"></script>
  `);
  assert.deepEqual(assets, ["assets/main-a.js", "assets/main-b.css"]);
  assert.equal(Object.isFrozen(assets), true);
});

test("loaded asset authority requires response bodies for entries without misclassifying passive manifest assets", () => {
  const base = {
    loadedPaths: ["assets/main.js", "assets/main.css", "brand.svg"],
    domLoadedPaths: ["assets/main.js", "assets/main.css", "brand.svg"],
    expectedEntryPaths: ["assets/main.js", "assets/main.css"],
    manifestPaths: ["index.html", "assets/main.js", "assets/main.css", "brand.svg"],
    observedAssets: [
      { path: "assets/main.js", accepted: true },
      { path: "assets/main.css", accepted: true },
    ],
    mainFrameObservedAssets: [
      { path: "assets/main.js", accepted: true },
      { path: "assets/main.css", accepted: true },
    ],
  };
  const passiveAsset = assessControlledLoadedAssetAuthority(base);
  assert.equal(passiveAsset.browserLoadedAssetsAccepted, true);
  assert.equal(passiveAsset.domLoadedAssetsAccepted, true);
  assert.equal(passiveAsset.expectedEntriesPresentInDom, true);
  assert.deepEqual(
    passiveAsset.browserLoadedAssetAuthority.find((asset) => asset.path === "brand.svg"),
    {
      path: "brand.svg",
      entryAuthorityRequired: false,
      manifestBacked: true,
      responseBodyAccepted: false,
    },
  );

  const missingBrowserEntryBody = assessControlledLoadedAssetAuthority({
    ...base,
    observedAssets: base.observedAssets.filter((asset) => asset.path !== "assets/main.js"),
  });
  assert.equal(missingBrowserEntryBody.browserLoadedAssetsAccepted, false);

  const missingMainFrameEntryBody = assessControlledLoadedAssetAuthority({
    ...base,
    mainFrameObservedAssets: base.mainFrameObservedAssets.filter((asset) => (
      asset.path !== "assets/main.css"
    )),
  });
  assert.equal(missingMainFrameEntryBody.domLoadedAssetsAccepted, false);

  const missingEntryDom = assessControlledLoadedAssetAuthority({
    ...base,
    domLoadedPaths: base.domLoadedPaths.filter((path) => path !== "assets/main.css"),
  });
  assert.equal(missingEntryDom.expectedEntriesPresentInDom, false);

  const unmanifestedPassiveAsset = assessControlledLoadedAssetAuthority({
    ...base,
    manifestPaths: base.manifestPaths.filter((path) => path !== "brand.svg"),
  });
  assert.equal(unmanifestedPassiveAsset.browserLoadedAssetsAccepted, false);
  assert.equal(unmanifestedPassiveAsset.domLoadedAssetsAccepted, false);
});

test("controlled CDP diagnostics preserve raw errors, rejections, failures, and crashes", () => {
  let clock = 100;
  const diagnostics = createControlledDiagnosticsAggregator({ now: () => ++clock });
  diagnostics.recordEvent("Runtime.consoleAPICalled", {
    type: "error",
    args: [{ value: "console failure" }],
  }, { sessionId: "worker-session-1" });
  diagnostics.recordEvent("Runtime.consoleAPICalled", { type: "log", args: [{ value: "ignored" }] });
  diagnostics.recordEvent("Runtime.exceptionThrown", {
    exceptionDetails: { text: "Uncaught", exception: { description: "Error: broken" } },
  });
  diagnostics.recordEvent("Network.loadingFailed", {
    type: "Stylesheet",
    errorText: "net::ERR_TIMED_OUT",
  });
  diagnostics.recordEvent("Network.loadingFailed", {
    type: "Fetch",
    errorText: "net::ERR_ABORTED",
  });
  diagnostics.recordEvent("Runtime.bindingCalled", {
    name: "__CANDLESCOPE_CONTROLLED_CDP_REPORT__",
    payload: JSON.stringify({ kind: "unhandledrejection", reason: { message: "rejected" } }),
  });
  diagnostics.recordEvent("Runtime.bindingCalled", {
    name: "__CANDLESCOPE_CONTROLLED_CDP_REPORT__",
    payload: JSON.stringify({ kind: "error", message: "window failure" }),
  });
  diagnostics.recordEvent("Runtime.bindingCalled", {
    name: "__CANDLESCOPE_CONTROLLED_CDP_REPORT__",
    payload: "not-json",
  });
  diagnostics.recordEvent("Inspector.targetCrashed", { status: "crashed" });
  diagnostics.recordCommandError("Page.navigate", new Error("command failure"));
  diagnostics.recordProtocolError(new Error("protocol failure"));
  diagnostics.recordHandlerError("Runtime.consoleAPICalled", new Error("handler failure"));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.consoleErrors.length, 1);
  assert.equal(snapshot.consoleErrors[0].sessionId, "worker-session-1");
  assert.equal(snapshot.unexpectedConsoleErrors.length, 1);
  assert.equal(snapshot.runtimeExceptions.length, 1);
  assert.equal(snapshot.networkFailures.length, 1);
  assert.equal(snapshot.unhandledRejections.length, 1);
  assert.equal(snapshot.windowErrors.length, 1);
  assert.equal(snapshot.crashCount, 1);
  assert.equal(snapshot.commandErrors.length, 1);
  assert.equal(snapshot.protocolErrors.length, 2);
  assert.equal(snapshot.handlerErrors.length, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.consoleErrors), true);
});

test("controlled CDP handler settlement drains deferred work and preserves async failures", async () => {
  const diagnostics = createControlledDiagnosticsAggregator();
  const tracker = createControlledCdpHandlerTracker(diagnostics);
  let releaseDeferred;
  const deferred = new Promise((resolve) => { releaseDeferred = resolve; });
  tracker.on("Target.attachedToTarget", async () => deferred);
  tracker.dispatch("Target.attachedToTarget", { targetInfo: { type: "worker" } }, {
    sessionId: "worker-session",
  });
  assert.equal(tracker.snapshot().pendingCount, 1);
  const settlementPromise = tracker.settleHandlers(1_000);
  releaseDeferred();
  const settled = await settlementPromise;
  assert.equal(settled.completed, true);
  assert.equal(settled.passed, true);
  assert.equal(settled.scheduledAtEnd, 1);
  assert.equal(settled.completedAtEnd, 1);

  tracker.on("Network.loadingFinished", async () => {
    throw new Error("body hash failed");
  });
  tracker.dispatch("Network.loadingFinished", { requestId: "asset-1" }, { sessionId: "worker-session" });
  const rejected = await tracker.settleHandlers(1_000);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.failureCount, 1);
  assert.equal(rejected.failures[0].event, "Network.loadingFinished");
  assert.equal(rejected.failures[0].sessionId, "worker-session");
  assert.match(rejected.failures[0].error, /body hash failed/);
  assert.equal(diagnostics.snapshot().handlerErrors.length, 1);
});

test("controlled CDP handler settlement times out fail closed and observes new pending work", async () => {
  const diagnostics = createControlledDiagnosticsAggregator();
  const tracker = createControlledCdpHandlerTracker(diagnostics);
  let releaseFirst;
  let releaseSecond;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const second = new Promise((resolve) => { releaseSecond = resolve; });
  tracker.on("first", async () => first);
  tracker.on("second", async () => second);
  tracker.dispatch("first");
  const timedOut = await tracker.settleHandlers(5);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.completed, false);
  assert.equal(timedOut.pendingCount, 1);

  const draining = tracker.settleHandlers(1_000);
  tracker.dispatch("second");
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.snapshot().pendingCount, 1);
  releaseSecond();
  const settled = await draining;
  assert.equal(settled.passed, true);
  assert.equal(settled.scheduledAtEnd, 2);
  assert.equal(settled.completedAtEnd, 2);
});

test("controlled asset evidence hashes entry, dynamic, and worker responses per CDP session", async () => {
  const files = [
    { relativePath: "index.html", content: "<script src='/assets/main.js'></script>" },
    { relativePath: "assets/main.js", content: "import('./dynamic.js')" },
    { relativePath: "assets/dynamic.js", content: "export const dynamic = true" },
    { relativePath: "assets/drawing.worker.js", content: "self.onmessage = () => {}" },
  ];
  const assetFingerprint = fingerprintFileEntries(files);
  const bodies = new Map([
    ["<top>\0document", { body: files[0].content, base64Encoded: false }],
    ["<top>\0entry", { body: files[1].content, base64Encoded: false }],
    ["<top>\0shared", { body: files[2].content, base64Encoded: false }],
    ["worker-session\0drawing-worker-target", {
      body: Buffer.from(files[3].content).toString("base64"),
      base64Encoded: true,
    }],
  ]);
  const cdp = createFakeCdp({ responseBodies: bodies });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint,
  }, 1_000, "main-frame");
  const response = async (
    requestId,
    url,
    type,
    sessionId = null,
    initiatorType = type === "Document" ? "other" : "script",
  ) => {
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: sessionId ? "" : "loader-1",
      type,
      initiator: { type: initiatorType },
      request: { url },
    }, sessionId ? { sessionId } : {});
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: sessionId ? "" : "loader-1",
      type,
      response: { url, status: 200, mimeType: "text/javascript", protocol: "http/1.1" },
    }, sessionId ? { sessionId } : {});
    await cdp.emit("Network.loadingFinished", { requestId }, sessionId ? { sessionId } : {});
  };
  await response("document", "http://127.0.0.1:15173/", "Document");
  await response("entry", "http://127.0.0.1:15173/assets/main.js", "Script", null, "parser");
  await response("shared", "http://127.0.0.1:15173/assets/dynamic.js", "Script");
  await emitWorkerConstruction(cdp);
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "drawing-worker-target",
    frameId: "main-frame",
    loaderId: "",
    documentURL: "http://127.0.0.1:15173/",
    type: "Script",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/assets/drawing.worker.js" },
  });
  await cdp.emit("Target.attachedToTarget", {
    sessionId: "worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "drawing-worker-target",
      type: "worker",
      title: "candlescope-drawing-worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "drawing-worker-target",
    type: "Script",
    response: {
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
      status: 200,
      mimeType: "text/javascript",
      protocol: "http/1.1",
    },
  }, { sessionId: "worker-session" });
  await cdp.emit("Network.loadingFinished", {
    requestId: "drawing-worker-target",
  }, { sessionId: "worker-session" });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.observedAssetCount, 4);
  assert.equal(snapshot.acceptedObservedAssetCount, 4);
  assert.equal(snapshot.workerTargets.length, 1);
  assert.equal(snapshot.workerTargets[0].assetAccepted, true);
  assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, true);
  assert.equal(snapshot.workerTargets[0].assetSha256, snapshot.workerTargets[0].expectedAssetSha256);
  assert.equal(snapshot.workerTargets[0].manifestBacked, true);
  assert.equal(snapshot.duplicateResponseKeys.length, 0);
  const bodyReads = cdp.sends.filter((entry) => entry.method === "Network.getResponseBody");
  assert.ok(bodyReads.some((entry) => entry.params.requestId === "shared" && entry.sessionId === null));
  assert.ok(bodyReads.some((entry) => (
    entry.params.requestId === "drawing-worker-target" && entry.sessionId === "worker-session"
  )));
  const quiescent = await tracker.waitForComplete();
  assert.equal(quiescent.passed, true);
  assert.equal(quiescent.quiescence.passed, true);
  assert.equal(quiescent.inFlightCount, 0);
  await cdp.emit("Target.detachedFromTarget", { sessionId: "worker-session" });
  assert.equal(tracker.snapshot().passed, false);
  assert.equal(tracker.snapshot().assetAuthorityPassed, true);
  assert.equal(tracker.snapshot().workerAssetAuthorityPassed, true);
  assert.equal(tracker.snapshot().workerTargets[0].active, false);
  const detachedQuiescent = await tracker.waitForAssetAuthorityComplete();
  assert.equal(detachedQuiescent.assetAuthorityPassed, true);
  assert.equal(detachedQuiescent.passed, false);
  assert.equal(detachedQuiescent.quiescence.passed, true);
  assert.equal(detachedQuiescent.quiescence.authorityField, "assetAuthorityPassed");
  tracker.dispose();
});

test("controlled asset evidence rejects any corrupt or unmanifested loaded resource", async () => {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "trusted" },
  ];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0trusted", { body: "trusted", base64Encoded: false }],
      ["<top>\0corrupt", { body: "corrupt", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, 1_000, "main-frame");
  const emitResponse = async (requestId, path, type = path === "/" ? "Document" : "Script") => {
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      initiator: { type: type === "Document" ? "other" : "script" },
      request: { url: `http://127.0.0.1:15173${path}` },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url: `http://127.0.0.1:15173${path}`, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  await emitResponse("document", "/");
  await emitResponse("trusted", "/assets/main.js");
  await emitResponse("corrupt", "/assets/main.js?second=1");
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "evil",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Script",
    initiator: { type: "parser" },
    request: { url: "http://127.0.0.1:15173/assets/not-in-build.js" },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "evil",
    loaderId: "loader-1",
    type: "Script",
    response: { url: "http://127.0.0.1:15173/assets/not-in-build.js", status: 200 },
  });
  await cdp.emit("Network.loadingFinished", { requestId: "evil" });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.assetAuthorityPassed, false);
  assert.equal(snapshot.entryAssets.find((asset) => asset.path === "assets/main.js").accepted, false);
  assert.equal(snapshot.unmanifestedResponses.length, 1);
  tracker.dispose();
});

test("page preload or fetch of a worker URL cannot authorize the worker target", async () => {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: "assets/drawing.worker.js", content: "worker" },
  ];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0entry", { body: "main", base64Encoded: false }],
      ["<top>\0preload", { body: "worker", base64Encoded: false }],
      ["<top>\0fetch", { body: "worker", base64Encoded: false }],
      ["<top>\0dynamic", { body: "worker", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, 400, "main-frame");
  const emit = async (requestId, path, type, initiatorType) => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  await emit("document", "/", "Document", "other");
  await emit("entry", "/assets/main.js", "Script", "parser");
  await cdp.emit("Target.attachedToTarget", {
    sessionId: "worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "drawing-worker-target",
      type: "worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  await emit("preload", "/assets/drawing.worker.js", "Script", "parser");
  await emit("fetch", "/assets/drawing.worker.js", "Fetch", "script");
  await emit("dynamic", "/assets/drawing.worker.js", "Script", "script");

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.observedAssets.find((asset) => (
    asset.path === "assets/drawing.worker.js"
  )).accepted, true);
  assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, false);
  assert.equal(snapshot.workerTargets[0].assetAccepted, false);
  assert.equal(snapshot.passed, false);
  tracker.dispose();
});

test("api data requests are exempt but api script resources fail closed", async () => {
  const files = [{ relativePath: "index.html", content: "index" }];
  const cdp = createFakeCdp({
    responseBodies: new Map([["<top>\0document", { body: "index", base64Encoded: false }]]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: [],
    assetFingerprint: fingerprintFileEntries(files),
  }, 400, "main-frame");
  const emit = async (requestId, path, type, initiatorType) => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  await emit("document", "/", "Document", "other");
  await emit("data", "/api/v1/bars", "Fetch", "script");
  await emit("evil", "/api/evil.js", "Script", "parser");

  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.unmanifestedResponses.map((record) => record.path), ["api/evil.js"]);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.passed, false);
  tracker.dispose();
});

test("runtime-generated blob resources stay outside build asset authority", async () => {
  const files = [{ relativePath: "index.html", content: "index" }];
  const cdp = createFakeCdp({
    responseBodies: new Map([["<top>\0document", { body: "index", base64Encoded: false }]]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: [],
    assetFingerprint: fingerprintFileEntries(files),
  }, 400, "main-frame");
  const documentUrl = "http://127.0.0.1:15173/";
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "document",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Document",
    initiator: { type: "other" },
    request: { url: documentUrl },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "document",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Document",
    response: { url: documentUrl, status: 200 },
  });
  await cdp.emit("Network.loadingFinished", { requestId: "document" });

  const blobUrl = "blob:http://127.0.0.1:15173/76a4f481-b7a6-4c45-b028-b74a6d8138c0";
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "blob-image",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Image",
    initiator: { type: "script" },
    request: { url: blobUrl },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "blob-image",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Image",
    response: { url: blobUrl, status: 200 },
  });
  await cdp.emit("Network.loadingFinished", { requestId: "blob-image" });

  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.unmanifestedResponses, []);
  assert.deepEqual(snapshot.observedAssets.map((asset) => asset.path), ["index.html"]);
  assert.equal(cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody" && entry.params.requestId === "blob-image"
  )), false);
  tracker.dispose();
});

test("same-origin iframe traffic cannot switch or satisfy main-frame build authority", async () => {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
  ];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0main-document", { body: "index", base64Encoded: false }],
      ["iframe-session\0iframe-entry", { body: "main", base64Encoded: false }],
      ["<top>\0iframe-document", { body: "index", base64Encoded: false }],
      ["<top>\0fetch-entry", { body: "main", base64Encoded: false }],
      ["<top>\0main-entry", { body: "main", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, 400, "main-frame");
  const emit = async ({ requestId, path, type, frameId, loaderId, sessionId = null }) => {
    const url = `http://127.0.0.1:15173${path}`;
    const message = sessionId ? { sessionId } : {};
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId,
      loaderId,
      type,
      initiator: { type: type === "Document" ? "other" : "parser" },
      request: { url },
    }, message);
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId,
      loaderId,
      type,
      response: { url, status: 200 },
    }, message);
    await cdp.emit("Network.loadingFinished", { requestId }, message);
  };
  await emit({
    requestId: "main-document",
    path: "/",
    type: "Document",
    frameId: "main-frame",
    loaderId: "main-loader-1",
  });
  await cdp.emit("Target.attachedToTarget", {
    sessionId: "iframe-session",
    targetInfo: { targetId: "iframe-target", type: "iframe", url: "http://127.0.0.1:15173/" },
  });
  await emit({
    requestId: "iframe-entry",
    path: "/assets/main.js",
    type: "Script",
    frameId: "child-frame",
    loaderId: "child-loader",
    sessionId: "iframe-session",
  });
  await emit({
    requestId: "iframe-document",
    path: "/",
    type: "Document",
    frameId: "child-frame",
    loaderId: "child-loader",
  });
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.currentLoaderId, "main-loader-1");
  assert.equal(snapshot.entryAssets.find((asset) => asset.path === "assets/main.js").accepted, false);

  await emit({
    requestId: "fetch-entry",
    path: "/assets/main.js",
    type: "Fetch",
    frameId: "main-frame",
    loaderId: "main-loader-1",
  });
  snapshot = tracker.snapshot();
  assert.equal(snapshot.entryAssets.find((asset) => asset.path === "assets/main.js").accepted, false);

  await emit({
    requestId: "main-entry",
    path: "/assets/main.js",
    type: "Script",
    frameId: "main-frame",
    loaderId: "main-loader-1",
  });
  snapshot = tracker.snapshot();
  assert.equal(snapshot.entryAssets.find((asset) => asset.path === "assets/main.js").accepted, true);
  assert.deepEqual(
    snapshot.entryAssets.find((asset) => asset.path === "assets/main.js").candidates.map((item) => item.sessionId),
    [null],
  );

  await cdp.emit("Network.requestWillBeSent", {
    requestId: "next-main-document",
    frameId: "main-frame",
    loaderId: "main-loader-2",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });
  snapshot = tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.currentLoaderId, "main-loader-2");
  tracker.dispose();
});

test("late prior-generation network terminals cannot poison current build authority", async () => {
  const cdp = createFakeCdp();
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: [],
    assetFingerprint: fingerprintFileEntries([
      { relativePath: "index.html", content: "index" },
      { relativePath: "assets/main.js", content: "main" },
    ]),
  }, 400, "main-frame");
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "prior-document",
    frameId: "main-frame",
    loaderId: "main-loader-1",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "prior-entry",
    frameId: "main-frame",
    loaderId: "main-loader-1",
    type: "Script",
    initiator: { type: "parser" },
    request: { url: "http://127.0.0.1:15173/assets/main.js" },
  });
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "current-document",
    frameId: "main-frame",
    loaderId: "main-loader-2",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });

  await cdp.emit("Network.loadingFailed", {
    requestId: "prior-entry",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "prior-entry",
    frameId: "main-frame",
    loaderId: "main-loader-1",
    type: "Script",
    response: { url: "http://127.0.0.1:15173/assets/main.js", status: 200 },
  });
  await cdp.emit("Network.loadingFailed", {
    requestId: "prior-entry",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.inFlightCount, 1);
  assert.deepEqual(snapshot.provenanceErrors, []);

  await cdp.emit("Network.loadingFailed", {
    requestId: "current-document",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
  snapshot = tracker.snapshot();
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.provenanceErrors.length, 1);
  assert.equal(snapshot.provenanceErrors[0].kind, "network-terminal-without-response");
  assert.equal(snapshot.provenanceErrors[0].generation, 2);
  tracker.dispose();
});

test("late prior-generation loading completion skips invalid response body reads", async () => {
  const cdp = createFakeCdp();
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: [],
    assetFingerprint: fingerprintFileEntries([
      { relativePath: "index.html", content: "index" },
    ]),
  }, 400, "main-frame");
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "prior-document",
    frameId: "main-frame",
    loaderId: "main-loader-1",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: "prior-document",
    frameId: "main-frame",
    loaderId: "main-loader-1",
    type: "Document",
    response: { url: "http://127.0.0.1:15173/", status: 200 },
  });
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "current-document",
    frameId: "main-frame",
    loaderId: "main-loader-2",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });

  await cdp.emit("Network.loadingFinished", { requestId: "prior-document" });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.pendingCount, 0);
  assert.deepEqual(snapshot.inFlight.map((record) => record.requestId), ["current-document"]);
  assert.equal(cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody" && entry.params.requestId === "prior-document"
  )), false);
  tracker.dispose();
});

test("aborted data API requests clear in-flight state without poisoning asset authority", async () => {
  const cdp = createFakeCdp();
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: [],
    assetFingerprint: fingerprintFileEntries([
      { relativePath: "index.html", content: "index" },
    ]),
  }, 400, "main-frame");
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "document",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Document",
    initiator: { type: "other" },
    request: { url: "http://127.0.0.1:15173/" },
  });
  await cdp.emit("Network.requestWillBeSent", {
    requestId: "api-fetch",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Fetch",
    initiator: { type: "script" },
    request: { url: "http://127.0.0.1:15173/api/v1/bars" },
  });
  await cdp.emit("Network.loadingFailed", {
    requestId: "api-fetch",
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.inFlightCount, 1);
  assert.deepEqual(snapshot.inFlight.map((record) => record.requestId), ["document"]);
  assert.deepEqual(snapshot.provenanceErrors, []);
  tracker.dispose();
});

test("legacy top-session worker bootstrap response cannot authorize a drawing worker", async () => {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: "assets/drawing.worker.js", content: "worker" },
  ];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0entry", { body: "main", base64Encoded: false }],
      ["<top>\0worker-bootstrap", { body: "worker", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, 500, "main-frame");
  const emit = async (requestId, path, type, initiatorType, loaderId = "loader-1") => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId,
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId,
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  await emit("document", "/", "Document", "other");
  await emit("entry", "/assets/main.js", "Script", "parser");
  await emitWorkerConstruction(cdp);
  await cdp.emit("Target.attachedToTarget", {
    sessionId: "worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "drawing-worker-target",
      type: "worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  await emit("worker-bootstrap", "/assets/drawing.worker.js", "Script", "script", "");

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.drawingWorkerTargetCount, 1);
  assert.equal(snapshot.workerTargets[0].authorizedCandidates.length, 0);
  assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, false);
  assert.equal(snapshot.workerTargets[0].assetAccepted, false);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  tracker.dispose();
});

test("worker bootstrap response hands off exactly once from top to its child session", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.deepEqual(snapshot.workerBootstrapHandoffs[0], {
    ...snapshot.workerBootstrapHandoffs[0],
    kind: "controlled-worker-bootstrap-network-handoff",
    generation: 1,
    requestId: fixture.requestId,
    path: "assets/drawing.worker.js",
    url: fixture.targetUrl,
    sourceKey: `<top>\0${fixture.requestId}`,
    sourceSessionId: null,
    destinationKey: `${fixture.sessionId}\0${fixture.requestId}`,
    destinationSessionId: fixture.sessionId,
    targetId: fixture.requestId,
  });
  assert.ok(
    snapshot.workerBootstrapHandoffs[0].constructorObservationSequence
      < snapshot.workerBootstrapHandoffs[0].sourceRequestObservationSequence,
  );
  assert.ok(
    snapshot.workerBootstrapHandoffs[0].sourceRequestObservationSequence
      < snapshot.workerBootstrapHandoffs[0].targetAttachedObservationSequence,
  );
  assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, true);
  assert.equal(snapshot.workerTargets[0].assetAccepted, true);
  assert.equal(snapshot.workerTargets[0].authorizedCandidates.length, 1);
  assert.equal(snapshot.workerTargets[0].authorizedCandidates[0].sessionId, fixture.sessionId);
  assert.equal(snapshot.workerTargets[0].authorizedCandidates[0].initiatorType, "other");
  assert.equal(snapshot.workerTargets[0].assetSha256, snapshot.workerTargets[0].expectedAssetSha256);
  const workerBodyReads = fixture.cdp.sends.filter((entry) => (
    entry.method === "Network.getResponseBody" && entry.params.requestId === fixture.requestId
  ));
  assert.deepEqual(workerBodyReads.map((entry) => entry.sessionId), [fixture.sessionId]);
  fixture.tracker.dispose();
});

test("detached canonical worker consumes its top-session Fetch capture without a child body read", async () => {
  const workerAsset = fingerprintFileEntries([{
    relativePath: "assets/drawing.worker.js",
    content: "worker",
  }]).files[0];
  const claims = [];
  const fixture = await createWorkerBootstrapHandoffFixture({
    claimWorkerResponseBodyCapture(networkId, url) {
      claims.push({ networkId, url });
      return {
        kind: "controlled-fetch-response-body-capture",
        fetchRequestId: "worker-fetch-request",
        networkId,
        relativePath: "assets/drawing.worker.js",
        resourceType: "Other",
        sessionId: null,
        url,
        responseStatusCode: 200,
        bodyBytes: workerAsset.bytes,
        bodySha256: workerAsset.sha256,
        capturedAt: "2026-07-17T00:00:00.000Z",
        claimedAt: "2026-07-17T00:00:00.001Z",
        claimCount: 1,
      };
    },
  });
  await fixture.emitChildResponse();
  await fixture.cdp.emit("Target.detachedFromTarget", { sessionId: fixture.sessionId });
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const worker = snapshot.workerTargets[0];
  const candidate = worker.authorizedCandidates[0];
  assert.deepEqual(claims, [{
    networkId: fixture.requestId,
    url: fixture.targetUrl,
  }]);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.equal(candidate.workerBootstrapHandoff, true);
  assert.equal(candidate.bodyCaptureKind, "controlled-fetch-response-body-capture");
  assert.equal(candidate.bodyCaptureReceipt.fetchRequestId, "worker-fetch-request");
  assert.equal(candidate.bodyCaptureReceipt.networkId, fixture.requestId);
  assert.equal(candidate.bodyCaptureReceipt.sessionId, null);
  assert.equal(candidate.bodyCaptureReceipt.claimCount, 1);
  assert.equal(candidate.bodySha256, worker.expectedAssetSha256);
  assert.equal(worker.networkProvenanceAccepted, true);
  assert.equal(worker.assetAccepted, true);
  assert.equal(worker.active, false);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(snapshot.workerAssetAuthorityPassed, true);
  assert.equal(fixture.cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody"
    && entry.params.requestId === fixture.requestId
  )), false);
  fixture.tracker.dispose();
});

test("managed Fetch capture composes with the canonical worker handoff across detach", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    captureWorkerResponseWithManagedOriginGuard: true,
  });
  const fetchRequestId = "worker-fetch-request";
  const requestStage = await fixture.cdp.emit("Fetch.requestPaused", {
    requestId: fetchRequestId,
    networkId: fixture.requestId,
    resourceType: "Other",
    request: { url: fixture.targetUrl },
  });
  const responseStage = await fixture.cdp.emit("Fetch.requestPaused", {
    requestId: fetchRequestId,
    networkId: fixture.requestId,
    resourceType: "Other",
    responseStatusCode: 200,
    request: { url: fixture.targetUrl },
  });
  assert.equal(requestStage[0].status, "fulfilled");
  assert.equal(responseStage[0].status, "fulfilled");
  fixture.originGuard.assertHealthy();

  await fixture.emitChildResponse();
  await fixture.cdp.emit("Target.detachedFromTarget", { sessionId: fixture.sessionId });
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const worker = snapshot.workerTargets[0];
  const candidate = worker.authorizedCandidates[0];
  const guardSnapshot = fixture.originGuard.snapshot();
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.equal(worker.active, false);
  assert.equal(worker.assetAccepted, true);
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(candidate.bodyCaptureKind, "controlled-fetch-response-body-capture");
  assert.equal(candidate.bodyCaptureReceipt.fetchRequestId, fetchRequestId);
  assert.equal(candidate.bodyCaptureReceipt.networkId, fixture.requestId);
  assert.equal(candidate.bodyCaptureReceipt.url, fixture.targetUrl);
  assert.equal(candidate.bodyCaptureReceipt.claimCount, 1);
  assert.equal(candidate.bodySha256, worker.expectedAssetSha256);
  assert.equal(guardSnapshot.passed, true);
  assert.equal(guardSnapshot.workerResponseCaptures.length, 1);
  assert.equal(guardSnapshot.workerResponseCaptures[0].claimCount, 1);
  assert.equal(
    fixture.originGuard.claimWorkerResponseBodyCapture(fixture.requestId, fixture.targetUrl),
    null,
  );
  assert.equal(fixture.cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody"
    && entry.params.requestId === fixture.requestId
  )), false);
  fixture.originGuard.dispose();
  fixture.tracker.dispose();
});

test("canonical worker capture remains fail closed without falling back to its child session", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    claimWorkerResponseBodyCapture: () => null,
  });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const candidate = snapshot.workerTargets[0].authorizedCandidates[0];
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.assetAuthorityPassed, false);
  assert.equal(snapshot.workerAssetAuthorityPassed, false);
  assert.equal(candidate.bodyError, "canonical drawing worker response body capture is missing or invalid");
  assert.equal(candidate.bodySha256, null);
  assert.equal(fixture.cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody"
    && entry.params.requestId === fixture.requestId
  )), false);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff accepts request before constructor within the attach window", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    constructionTiming: "after-source",
    sourceDocumentUrl: "http://127.0.0.1:15173/assets/drawing.worker.js",
  });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const handoff = snapshot.workerBootstrapHandoffs[0];
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.ok(handoff.sourceRequestObservationSequence < handoff.constructorObservationSequence);
  assert.ok(handoff.constructorObservationSequence < handoff.targetAttachedObservationSequence);
  assert.equal(snapshot.workerTargets[0].assetAccepted, true);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff accepts a delayed constructor binding after target attachment", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    constructionTiming: "after-target",
  });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const handoff = snapshot.workerBootstrapHandoffs[0];
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.ok(handoff.sourceRequestObservationSequence < handoff.targetAttachedObservationSequence);
  assert.ok(handoff.targetAttachedObservationSequence < handoff.constructorObservationSequence);
  assert.equal(snapshot.workerTargets[0].assetAccepted, true);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff defers response and terminal until its constructor binding arrives", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    constructionTiming: "after-child-response",
    timeoutMs: 100,
  });
  const responseTask = fixture.emitChildResponse();
  const terminalTask = fixture.emitChildFinished();
  assert.equal(fixture.tracker.snapshot().deferredWorkerBootstrapResponseCount, 1);

  await emitWorkerConstruction(fixture.cdp, fixture.targetUrl);
  await Promise.all([responseTask, terminalTask]);

  const snapshot = fixture.tracker.snapshot();
  const handoff = snapshot.workerBootstrapHandoffs[0];
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.deferredWorkerBootstrapResponseCount, 0);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.ok(handoff.sourceRequestObservationSequence < handoff.targetAttachedObservationSequence);
  assert.ok(handoff.targetAttachedObservationSequence < handoff.constructorObservationSequence);
  assert.equal(snapshot.workerTargets[0].assetAccepted, true);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff times out fail closed when the constructor binding never arrives", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    constructionTiming: "missing",
    timeoutMs: 25,
  });
  await Promise.all([
    fixture.emitChildResponse(),
    fixture.emitChildFinished(),
  ]);

  const snapshot = fixture.tracker.snapshot();
  const rejection = snapshot.provenanceErrors.find((record) => (
    record.kind === "worker-bootstrap-handoff-rejected"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.deferredWorkerBootstrapResponseCount, 0);
  assert.ok(rejection.reasons.includes("missing-constructor-target-binding"));
  assert.ok(rejection.reasons.includes("constructor-identity-not-unique"));
  fixture.tracker.dispose();
});

test("worker bootstrap handoff accepts empty discovery before exact attachment", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({
    discoveredTargetTitle: "",
    discoveredTargetUrl: "",
  });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.equal(snapshot.workerTargets[0].constructorProvenanceAccepted, true);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff rejects constructor name and attached target title drift", async (t) => {
  for (const scenario of [
    {
      name: "constructor worker name",
      options: { constructionWorkerName: "other-worker" },
      reason: "constructor-worker-name-mismatch",
    },
    {
      name: "attached target title",
      options: { targetTitle: "other-worker" },
      reason: "target-title-mismatch",
    },
    {
      name: "discovered target title history",
      options: { discoveredTargetTitle: "other-worker" },
      reason: "target-discovery-history-mismatch",
    },
    {
      name: "discovered target URL query history",
      options: {
        discoveredTargetTitle: "candlescope-drawing-worker",
        discoveredTargetUrl: "http://127.0.0.1:15173/assets/drawing.worker.js?wrong=query",
      },
      reason: "target-discovery-history-mismatch",
    },
    {
      name: "destroyed target before attachment",
      options: {
        discoveredTargetTitle: "candlescope-drawing-worker",
        destroyDiscoveredTargetBeforeAttach: true,
      },
      reason: "target-discovery-history-mismatch",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createWorkerBootstrapHandoffFixture(scenario.options);
      await fixture.emitChildResponse();
      await fixture.emitChildFinished();

      const snapshot = fixture.tracker.snapshot();
      const rejection = snapshot.provenanceErrors.find((record) => (
        record.kind === "worker-bootstrap-handoff-rejected"
      ));
      assert.equal(snapshot.passed, false);
      assert.equal(snapshot.workerAssetAuthorityPassed, false);
      assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
      assert.ok(rejection?.reasons.includes(scenario.reason));
      assert.equal(snapshot.workerTargets[0].constructorProvenanceAccepted, false);
      fixture.tracker.dispose();
    });
  }
});

test("destroyed pre-attach worker retires only with exact discovery, constructor, and body authority", async () => {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: "assets/drawing.worker.js", content: "worker" },
  ];
  const fingerprint = fingerprintFileEntries(files);
  const workerAsset = fingerprint.files.find((entry) => (
    entry.path === "assets/drawing.worker.js"
  ));
  const captures = new Map();
  const claims = [];
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0entry", { body: "main", base64Encoded: false }],
    ]),
  });
  const claimWorkerResponseBodyCapture = (networkId, url) => {
    const key = `${networkId}\0${url}`;
    const capture = captures.get(key) ?? null;
    if (!capture || capture.claimCount !== 0) return null;
    capture.claimCount = 1;
    capture.claimedAt = "2026-07-17T00:00:00.001Z";
    claims.push({ networkId, url });
    return Object.freeze({ ...capture });
  };
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprint,
  }, 500, "main-frame", {
    runId: CONTROLLED_ROLLBACK_RUN_ID,
    authorityTokenSha256: CONTROLLED_ROLLBACK_AUTHORITY_DIGEST,
    drawingWorkerPaths: ["assets/drawing.worker.js"],
    drillIds: CONTROLLED_ROLLBACK_DRILL_IDS,
  }, claimWorkerResponseBodyCapture);
  const emitTopAsset = async (requestId, path, type, initiatorType) => {
    const url = `http://127.0.0.1:15173${path}`;
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      documentURL: "http://127.0.0.1:15173/",
      type,
      initiator: { type: initiatorType },
      request: { url },
    });
    await cdp.emit("Network.responseReceived", {
      requestId,
      frameId: "main-frame",
      loaderId: "loader-1",
      type,
      response: { url, status: 200 },
    });
    await cdp.emit("Network.loadingFinished", { requestId });
  };
  const registerCapture = (networkId, url) => {
    captures.set(`${networkId}\0${url}`, {
      kind: "controlled-fetch-response-body-capture",
      fetchRequestId: `fetch-${networkId}`,
      networkId,
      relativePath: "assets/drawing.worker.js",
      resourceType: "Other",
      sessionId: null,
      url,
      responseStatusCode: 200,
      bodyBytes: workerAsset.bytes,
      bodySha256: workerAsset.sha256,
      capturedAt: "2026-07-17T00:00:00.000Z",
      claimedAt: null,
      claimCount: 0,
    });
  };
  const emitWorkerSource = async (requestId, url) => {
    await cdp.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main-frame",
      loaderId: "",
      documentURL: url,
      type: "Script",
      initiator: { type: "other" },
      request: { url },
    });
  };

  await emitTopAsset("document", "/", "Document", "other");
  await emitTopAsset("entry", "/assets/main.js", "Script", "parser");

  const orphan = await emitWorkerConstruction(
    cdp,
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    "module",
    { controlledQuery: true },
  );
  const orphanTargetId = "orphan-worker-target";
  registerCapture(orphanTargetId, orphan.url);
  await cdp.emit("Target.targetCreated", {
    targetInfo: {
      targetId: orphanTargetId,
      type: "worker",
      title: "candlescope-drawing-worker",
      url: orphan.url,
      attached: false,
      openerFrameId: "main-frame",
    },
  });
  await emitWorkerSource(orphanTargetId, orphan.url);
  await cdp.emit("Target.targetDestroyed", { targetId: orphanTargetId });

  const unresolvedOrphan = await emitWorkerConstruction(
    cdp,
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    "module",
    { controlledQuery: true },
  );
  const unresolvedOrphanTargetId = "unresolved-orphan-worker-target";
  registerCapture(unresolvedOrphanTargetId, unresolvedOrphan.url);
  await cdp.emit("Target.targetCreated", {
    targetInfo: {
      targetId: unresolvedOrphanTargetId,
      type: "worker",
      title: "",
      url: "",
      attached: false,
      parentFrameId: "main-frame",
    },
  });
  await emitWorkerSource(unresolvedOrphanTargetId, unresolvedOrphan.url);
  await cdp.emit("Target.targetDestroyed", { targetId: unresolvedOrphanTargetId });

  const active = await emitWorkerConstruction(
    cdp,
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    "module",
    { controlledQuery: true },
  );
  const activeTargetId = "active-worker-target";
  const activeSessionId = "active-worker-session";
  registerCapture(activeTargetId, active.url);
  await cdp.emit("Target.targetCreated", {
    targetInfo: {
      targetId: activeTargetId,
      type: "worker",
      title: "candlescope-drawing-worker",
      url: active.url,
      attached: false,
      openerFrameId: "main-frame",
    },
  });
  await emitWorkerSource(activeTargetId, active.url);
  await cdp.emit("Target.attachedToTarget", {
    sessionId: activeSessionId,
    waitingForDebugger: true,
    targetInfo: {
      targetId: activeTargetId,
      type: "worker",
      title: "candlescope-drawing-worker",
      url: active.url,
    },
  });
  await cdp.emit("Network.responseReceived", {
    requestId: activeTargetId,
    type: "Script",
    response: { url: active.url, status: 200 },
  }, { sessionId: activeSessionId });
  await cdp.emit("Network.loadingFinished", {
    requestId: activeTargetId,
  }, { sessionId: activeSessionId });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.passed, true, JSON.stringify({
    inFlight: snapshot.inFlight,
    provenanceErrors: snapshot.provenanceErrors,
    retiredBeforeAttachWorkerSources: snapshot.retiredBeforeAttachWorkerSources,
    unclaimedDrawingWorkerConstructions: snapshot.unclaimedDrawingWorkerConstructions,
  }));
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(snapshot.retiredBeforeAttachWorkerSourceCount, 2);
  assert.deepEqual(
    snapshot.retiredBeforeAttachWorkerSources.map((record) => ({
      constructorId: record.constructorId,
      targetIdentityMode: record.targetIdentityMode,
    })),
    [
      {
        constructorId: orphan.constructorId,
        targetIdentityMode: "populated-target-info",
      },
      {
        constructorId: unresolvedOrphan.constructorId,
        targetIdentityMode: "unresolved-target-info-before-destroy",
      },
    ],
  );
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.equal(snapshot.workerBootstrapHandoffs[0].targetId, activeTargetId);
  assert.equal(snapshot.unclaimedDrawingWorkerConstructionCount, 0);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.deepEqual(claims, [
    { networkId: orphanTargetId, url: orphan.url },
    { networkId: unresolvedOrphanTargetId, url: unresolvedOrphan.url },
    { networkId: activeTargetId, url: active.url },
  ]);
  await cdp.emit("Target.targetDestroyed", { targetId: orphanTargetId });
  assert.ok(tracker.snapshot().provenanceErrors.some((record) => (
    record.kind === "worker-target-destroyed-duplicate"
      && record.targetId === orphanTargetId
  )));

  const partialIdentity = await emitWorkerConstruction(
    cdp,
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    "module",
    { controlledQuery: true },
  );
  const partialIdentityTargetId = "partial-identity-worker-target";
  registerCapture(partialIdentityTargetId, partialIdentity.url);
  await cdp.emit("Target.targetCreated", {
    targetInfo: {
      targetId: partialIdentityTargetId,
      type: "worker",
      title: "",
      url: partialIdentity.url,
      attached: false,
      parentFrameId: "main-frame",
    },
  });
  await emitWorkerSource(partialIdentityTargetId, partialIdentity.url);
  await cdp.emit("Target.targetDestroyed", { targetId: partialIdentityTargetId });

  const partialIdentitySnapshot = tracker.snapshot();
  assert.equal(partialIdentitySnapshot.passed, false);
  assert.equal(partialIdentitySnapshot.retiredBeforeAttachWorkerSourceCount, 2);
  assert.equal(partialIdentitySnapshot.unclaimedDrawingWorkerConstructionCount, 1);
  assert.equal(partialIdentitySnapshot.inFlightCount, 1);
  assert.equal(
    captures.get(`${partialIdentityTargetId}\0${partialIdentity.url}`).claimCount,
    0,
  );
  for (const scenario of [
    { label: "changed", emitInfoChange: true },
    { label: "type-drift", emitInfoChange: true, changedType: "iframe" },
    { label: "wrong-parent", parentFrameId: "other-frame" },
    { label: "source-before-create", sourceBeforeCreate: true },
    { label: "attached", attach: true },
  ]) {
    const candidate = await emitWorkerConstruction(
      cdp,
      "http://127.0.0.1:15173/assets/drawing.worker.js",
      "module",
      { controlledQuery: true },
    );
    const targetId = `${scenario.label}-unresolved-worker-target`;
    registerCapture(targetId, candidate.url);
    if (scenario.sourceBeforeCreate) await emitWorkerSource(targetId, candidate.url);
    await cdp.emit("Target.targetCreated", {
      targetInfo: {
        targetId,
        type: "worker",
        title: "",
        url: "",
        attached: false,
        parentFrameId: scenario.parentFrameId ?? "main-frame",
      },
    });
    if (scenario.emitInfoChange) {
      await cdp.emit("Target.targetInfoChanged", {
        targetInfo: {
          targetId,
          type: scenario.changedType ?? "worker",
          title: "",
          url: "",
          attached: false,
          parentFrameId: "main-frame",
        },
      });
    }
    if (!scenario.sourceBeforeCreate) await emitWorkerSource(targetId, candidate.url);
    if (scenario.attach) {
      await cdp.emit("Target.attachedToTarget", {
        sessionId: `${scenario.label}-session`,
        targetInfo: {
          targetId,
          type: "worker",
          title: "candlescope-drawing-worker",
          url: candidate.url,
        },
      });
      await cdp.emit("Target.detachedFromTarget", { sessionId: `${scenario.label}-session` });
    }
    await cdp.emit("Target.targetDestroyed", { targetId });
    const rejected = tracker.snapshot();
    assert.equal(rejected.retiredBeforeAttachWorkerSourceCount, 2, scenario.label);
    assert.equal(captures.get(`${targetId}\0${candidate.url}`).claimCount, 0, scenario.label);
    assert.equal(
      rejected.retiredBeforeAttachWorkerSources.some((record) => record.targetId === targetId),
      false,
      scenario.label,
    );
  }
  assert.ok(tracker.snapshot().provenanceErrors.some((record) => (
    record.kind === "worker-target-type-mismatch"
      && record.targetId === "type-drift-unresolved-worker-target"
      && record.actualType === "iframe"
  )));
  await cdp.emit("Target.targetInfoChanged", {
    targetInfo: {
      targetId: "changed-unresolved-worker-target",
      type: "worker",
      title: "candlescope-drawing-worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
      attached: false,
      parentFrameId: "main-frame",
    },
  });
  assert.ok(tracker.snapshot().provenanceErrors.some((record) => (
    record.kind === "worker-target-info-after-destroy"
      && record.targetId === "changed-unresolved-worker-target"
  )));
  await emitWorkerConstruction(
    cdp,
    "http://127.0.0.1:15173/assets/drawing.worker.js",
    "module",
    { controlledQuery: true, ensureMainContext: false, executionContextId: 702 },
  );
  assert.ok(tracker.snapshot().provenanceErrors.some((record) => (
    record.kind === "worker-constructor-main-context-untrusted"
      && record.executionContextId === 702
  )));
  tracker.dispose();
});

test("worker bootstrap handoff accepts serial reconstruction in one document generation", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();
  await fixture.cdp.emit("Target.detachedFromTarget", { sessionId: fixture.sessionId });

  const replacement = await attachAdditionalWorkerBootstrap(fixture, {
    requestId: "worker-bootstrap-target-2",
    sessionId: "worker-session-2",
  });
  await replacement.emitChildResponse();
  await replacement.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(snapshot.workerAssetAuthorityPassed, true);
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 2);
  assert.equal(snapshot.workerTargets.length, 2);
  assert.equal(snapshot.activeDrawingWorkerTargetCount, 1);
  assert.equal(snapshot.detachedDrawingWorkerTargetCount, 1);
  assert.equal(snapshot.serialWorkerLifecycleAccepted, true);
  assert.deepEqual(snapshot.workerTargets.map((target) => target.active), [false, true]);
  assert.ok(
    snapshot.workerTargets[0].detachedObservationSequence
      < snapshot.workerTargets[1].attachedObservationSequence,
  );
  assert.ok(snapshot.workerTargets.every((target) => target.assetAccepted));
  assert.equal(new Set(snapshot.workerBootstrapHandoffs.map((handoff) => (
    handoff.constructorObservationSequence
  ))).size, 2);
  fixture.tracker.dispose();
});

test("worker lifecycle rejects an overlapping replacement even when both handoffs are authorized", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const replacement = await attachAdditionalWorkerBootstrap(fixture, {
    requestId: "worker-bootstrap-target-2",
    sessionId: "worker-session-2",
  });
  await fixture.cdp.emit("Target.detachedFromTarget", { sessionId: fixture.sessionId });
  await replacement.emitChildResponse();
  await replacement.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.assetAuthorityPassed, true);
  assert.equal(snapshot.workerAssetAuthorityPassed, true);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 2);
  assert.equal(snapshot.activeDrawingWorkerTargetCount, 1);
  assert.equal(snapshot.detachedDrawingWorkerTargetCount, 1);
  assert.equal(snapshot.serialWorkerLifecycleAccepted, false);
  assert.ok(
    snapshot.workerTargets[0].detachedObservationSequence
      > snapshot.workerTargets[1].attachedObservationSequence,
  );
  fixture.tracker.dispose();
});

test("worker bootstrap handoff still rejects concurrent same-generation constructors", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const concurrent = await attachAdditionalWorkerBootstrap(fixture, {
    requestId: "worker-bootstrap-target-2",
    sessionId: "worker-session-2",
  });
  await concurrent.emitChildResponse();

  const snapshot = fixture.tracker.snapshot();
  const rejection = snapshot.provenanceErrors.find((record) => (
    record.kind === "worker-bootstrap-handoff-rejected"
  ));
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 1);
  assert.equal(snapshot.workerTargets.length, 2);
  assert.equal(snapshot.serialWorkerLifecycleAccepted, false);
  assert.ok(snapshot.workerTargets.every((target) => target.active));
  assert.deepEqual(rejection.reasons, ["constructor-identity-not-unique"]);
  fixture.tracker.dispose();
});

test("drawing worker child self-fetch cannot replace bootstrap handoff authority", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.cdp.emit("Network.requestWillBeSent", {
    requestId: "worker-self-fetch",
    loaderId: "",
    type: "Script",
    initiator: { type: "other" },
    request: { url: fixture.targetUrl },
  }, { sessionId: fixture.sessionId });
  await fixture.cdp.emit("Network.responseReceived", {
    requestId: "worker-self-fetch",
    type: "Script",
    response: { url: fixture.targetUrl, status: 200 },
  }, { sessionId: fixture.sessionId });
  await fixture.cdp.emit("Network.loadingFinished", {
    requestId: "worker-self-fetch",
  }, { sessionId: fixture.sessionId });

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  assert.equal(snapshot.workerTargets[0].authorizedCandidates.length, 0);
  assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, false);
  assert.equal(snapshot.workerTargets[0].assetAccepted, false);
  fixture.tracker.dispose();
});

test("worker bootstrap handoff rejects ambiguous constructor candidates", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({ constructionCount: 2 });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const rejection = snapshot.provenanceErrors.find((record) => (
    record.kind === "worker-bootstrap-handoff-rejected"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.ok(rejection.reasons.includes("missing-constructor-target-binding"));
  assert.ok(rejection.reasons.includes("constructor-identity-not-unique"));
  fixture.tracker.dispose();
});

test("worker bootstrap handoff rejects a target identity mismatch", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture({ targetId: "different-target-id" });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const rejection = snapshot.provenanceErrors.find((record) => (
    record.kind === "worker-bootstrap-handoff-rejected"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.ok(rejection.reasons.includes("target-request-id-mismatch"));
  assert.ok(rejection.reasons.includes("target-identity-not-unique"));
  fixture.tracker.dispose();
});

test("worker bootstrap handoff rejects Chrome event-contract or attach-window drift", async (t) => {
  const cases = [
    { name: "request type", options: { sourceType: "Other" }, reason: "source-request-type-mismatch" },
    {
      name: "initiator",
      options: { sourceInitiatorType: "script" },
      reason: "source-initiator-mismatch",
    },
    { name: "frame", options: { sourceFrameId: "other-frame" }, reason: "source-main-frame-mismatch" },
    { name: "loader", options: { sourceLoaderId: "loader-1" }, reason: "source-loader-mismatch" },
    {
      name: "mismatched controlled document URL",
      options: { sourceDocumentUrl: "http://127.0.0.1:15173/other" },
      reason: "source-document-url-mismatch",
    },
    {
      name: "off-origin document URL",
      options: { sourceDocumentUrl: "https://example.test/" },
      reason: "source-document-url-not-controlled",
    },
    {
      name: "source request after target attach",
      options: { sourceTiming: "after-target" },
      reason: "source-request-not-before-target-attachment",
    },
    {
      name: "distant bootstrap observations",
      options: { observationGapCount: 21 },
      reason: "bootstrap-observation-window-exceeded",
    },
    {
      name: "worker constructor type",
      options: { constructionWorkerType: "classic" },
      reason: "constructor-worker-type-mismatch",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await createWorkerBootstrapHandoffFixture(scenario.options);
      await fixture.emitChildResponse();
      await fixture.emitChildFinished();
      const snapshot = fixture.tracker.snapshot();
      const rejection = snapshot.provenanceErrors.find((record) => (
        record.kind === "worker-bootstrap-handoff-rejected"
      ));
      assert.equal(snapshot.passed, false);
      assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
      assert.equal(snapshot.workerTargets[0].authorizedCandidates.length, 0);
      assert.equal(snapshot.workerTargets[0].networkProvenanceAccepted, false);
      assert.ok(rejection.reasons.includes(scenario.reason));
      assert.equal(snapshot.inFlightCount, 0);
      assert.equal(rejection.actualContract.expectedObservationWindow, 20);
      assert.equal(rejection.actualContract.response.url, fixture.targetUrl);
      assert.equal(rejection.actualContract.source.requestId, fixture.requestId);
      assert.equal(rejection.actualContract.target.targetId, fixture.requestId);
      fixture.tracker.dispose();
    });
  }
});

test("late worker bootstrap handoff cannot revive a terminal top-session request", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.cdp.emit("Network.loadingFinished", { requestId: fixture.requestId });
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const rejection = snapshot.provenanceErrors.find((record) => (
    record.kind === "worker-bootstrap-handoff-rejected"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.ok(rejection.reasons.includes("source-request-not-in-flight"));
  assert.equal(fixture.cdp.sends.some((entry) => (
    entry.method === "Network.getResponseBody" && entry.params.requestId === fixture.requestId
  )), false);
  fixture.tracker.dispose();
});

test("child terminal before worker bootstrap response clears its canonical top request", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildFinished();

  let snapshot = fixture.tracker.snapshot();
  const terminalFailure = snapshot.provenanceErrors.find((record) => (
    record.kind === "network-terminal-without-response"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  assert.equal(terminalFailure.event, "Network.loadingFinished");
  assert.ok(terminalFailure.clearedKeys.includes(`<top>\0${fixture.requestId}`));

  await fixture.emitChildResponse();
  snapshot = fixture.tracker.snapshot();
  assert.ok(snapshot.provenanceErrors.some((record) => (
    record.kind === "response-after-network-terminal"
  )));
  assert.equal(snapshot.workerBootstrapHandoffs.length, 0);
  fixture.tracker.dispose();
});

test("worker loading failure without a response clears canonical authority immediately", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.cdp.emit("Network.loadingFailed", {
    requestId: fixture.requestId,
    errorText: "net::ERR_FAILED",
  }, { sessionId: fixture.sessionId });

  const snapshot = fixture.tracker.snapshot();
  const terminalFailure = snapshot.provenanceErrors.find((record) => (
    record.kind === "network-terminal-without-response"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(terminalFailure.event, "Network.loadingFailed");
  assert.ok(terminalFailure.clearedKeys.includes(`<top>\0${fixture.requestId}`));
  fixture.tracker.dispose();
});

test("untracked child terminal is ignored without disturbing canonical worker bootstrap state", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.cdp.emit("Network.loadingFinished", {
    requestId: "untracked-request",
  }, { sessionId: fixture.sessionId });

  const snapshot = fixture.tracker.snapshot();
  assert.equal(snapshot.provenanceErrors.length, 0);
  assert.equal(snapshot.inFlightCount, 1);
  assert.equal(snapshot.inFlight[0].requestId, fixture.requestId);
  fixture.tracker.dispose();
});

test("duplicate worker terminal is a permanent provenance failure without a second body read", async () => {
  const fixture = await createWorkerBootstrapHandoffFixture();
  await fixture.emitChildResponse();
  await fixture.emitChildFinished();
  await fixture.emitChildFinished();

  const snapshot = fixture.tracker.snapshot();
  const duplicate = snapshot.provenanceErrors.find((record) => (
    record.kind === "duplicate-network-terminal"
  ));
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(duplicate.event, "Network.loadingFinished");
  const workerBodyReads = fixture.cdp.sends.filter((entry) => (
    entry.method === "Network.getResponseBody" && entry.params.requestId === fixture.requestId
  ));
  assert.equal(workerBodyReads.length, 1);
  fixture.tracker.dispose();
});

test("worker construction without a matching target remains fail closed", async () => {
  const trackerCdp = createFakeCdp();
  const tracker = createControlledNetworkAssetTracker(trackerCdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries([
      { relativePath: "index.html", content: "index" },
      { relativePath: "assets/main.js", content: "main" },
      { relativePath: "assets/drawing.worker.js", content: "worker" },
    ]),
  }, 250, "main-frame");
  await emitWorkerConstruction(trackerCdp);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.passed, false);
  assert.equal(snapshot.drawingWorkerTargetCount, 0);
  assert.equal(snapshot.unclaimedDrawingWorkerConstructionCount, 1);
  assert.equal(snapshot.unclaimedDrawingWorkerConstructions[0].url, (
    "http://127.0.0.1:15173/assets/drawing.worker.js"
  ));
  tracker.dispose();
});

test("asset quiescence fails closed for late unmanifested or unfinished requests", async () => {
  const makeFixture = async (timeoutMs) => {
    const files = [
      { relativePath: "index.html", content: "index" },
      { relativePath: "assets/main.js", content: "main" },
      { relativePath: "assets/drawing.worker.js", content: "worker" },
      { relativePath: "assets/late.js", content: "late" },
    ];
    const cdp = createFakeCdp({
      responseBodies: new Map([
        ["<top>\0document", { body: "index", base64Encoded: false }],
        ["<top>\0entry", { body: "main", base64Encoded: false }],
        ["worker-session\0drawing-worker-target", { body: "worker", base64Encoded: false }],
      ]),
    });
    const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
      entryAssetPaths: ["assets/main.js"],
      assetFingerprint: fingerprintFileEntries(files),
    }, timeoutMs, "main-frame");
    const emit = async (requestId, path, type, sessionId = null) => {
      const url = `http://127.0.0.1:15173${path}`;
      const message = sessionId ? { sessionId } : {};
      await cdp.emit("Network.requestWillBeSent", {
        requestId,
        frameId: "main-frame",
        loaderId: sessionId ? "" : "loader-1",
        type,
        initiator: { type: type === "Document" ? "other" : "script" },
        request: { url },
      }, message);
      await cdp.emit("Network.responseReceived", {
        requestId,
        frameId: "main-frame",
        loaderId: sessionId ? "" : "loader-1",
        type,
        response: { url, status: 200 },
      }, message);
      await cdp.emit("Network.loadingFinished", { requestId }, message);
    };
    await emit("document", "/", "Document");
    await emit("entry", "/assets/main.js", "Script");
    await emitWorkerConstruction(cdp);
    await cdp.emit("Network.requestWillBeSent", {
      requestId: "drawing-worker-target",
      frameId: "main-frame",
      loaderId: "",
      documentURL: "http://127.0.0.1:15173/",
      type: "Script",
      initiator: { type: "other" },
      request: { url: "http://127.0.0.1:15173/assets/drawing.worker.js" },
    });
    await cdp.emit("Target.attachedToTarget", {
      sessionId: "worker-session",
      targetInfo: {
        targetId: "drawing-worker-target",
        type: "worker",
        url: "http://127.0.0.1:15173/assets/drawing.worker.js",
      },
    });
    await cdp.emit("Network.responseReceived", {
      requestId: "drawing-worker-target",
      type: "Script",
      response: {
        url: "http://127.0.0.1:15173/assets/drawing.worker.js",
        status: 200,
      },
    }, { sessionId: "worker-session" });
    await cdp.emit("Network.loadingFinished", {
      requestId: "drawing-worker-target",
    }, { sessionId: "worker-session" });
    return { cdp, tracker };
  };

  const late = await makeFixture(350);
  const waitingForQuiet = late.tracker.waitForComplete();
  const lateEmission = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await late.cdp.emit("Network.requestWillBeSent", {
      requestId: "late-evil",
      frameId: "main-frame",
      loaderId: "loader-1",
      type: "Script",
      initiator: { type: "script" },
      request: { url: "http://127.0.0.1:15173/assets/late-evil.js" },
    });
    await late.cdp.emit("Network.responseReceived", {
      requestId: "late-evil",
      frameId: "main-frame",
      loaderId: "loader-1",
      type: "Script",
      response: { url: "http://127.0.0.1:15173/assets/late-evil.js", status: 200 },
    });
    await late.cdp.emit("Network.loadingFinished", { requestId: "late-evil" });
  })();
  const eventLoopBlock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(eventLoopBlock, 0, 0, 250);
  await lateEmission;
  const lateReceipt = await waitingForQuiet;
  assert.equal(lateReceipt.passed, false);
  assert.equal(lateReceipt.quiescence.timedOut, true);
  assert.deepEqual(lateReceipt.unmanifestedResponses.map((record) => record.path), [
    "assets/late-evil.js",
  ]);
  late.tracker.dispose();

  const unfinished = await makeFixture(250);
  await unfinished.cdp.emit("Network.requestWillBeSent", {
    requestId: "unfinished",
    frameId: "main-frame",
    loaderId: "loader-1",
    type: "Script",
    initiator: { type: "script" },
    request: { url: "http://127.0.0.1:15173/assets/late.js" },
  });
  const unfinishedReceipt = await unfinished.tracker.waitForComplete();
  assert.equal(unfinishedReceipt.passed, false);
  assert.equal(unfinishedReceipt.quiescence.timedOut, true);
  assert.equal(unfinishedReceipt.inFlightCount, 1);
  assert.equal(unfinishedReceipt.inFlight[0].path, "assets/late.js");
  unfinished.tracker.dispose();
});

test("flattened worker diagnostics honor the exact target domain matrix and resume each target once", async () => {
  const cdp = createFakeCdp({
    onSend: ({ method, sessionId }) => {
      if (sessionId === "worker-session" && method === "Fetch.enable") {
        throw new Error("'Fetch.enable' wasn't found");
      }
      return undefined;
    },
  });
  const controller = createControlledWorkerDiagnosticsController(cdp, "http://127.0.0.1:15173");
  for (const targetType of CONTROLLED_DIAGNOSTIC_WORKER_TYPES) {
    const outcomes = await cdp.emit("Target.attachedToTarget", {
      sessionId: `${targetType}-session`,
      waitingForDebugger: true,
      targetInfo: {
        targetId: `${targetType}-target`,
        type: targetType,
        title: `candlescope-${targetType}`,
        url: `http://127.0.0.1:15173/assets/${targetType}.js`,
      },
    });
    assert.equal(outcomes[0].status, "fulfilled");
  }
  const expectedBaseMethods = ["Runtime.enable", "Network.enable"];
  const expectedFinalMethods = [
    "Runtime.addBinding",
    "Runtime.evaluate",
    "Runtime.runIfWaitingForDebugger",
  ];
  for (const targetType of CONTROLLED_DIAGNOSTIC_WORKER_TYPES) {
    const sessionId = `${targetType}-session`;
    const sessionSends = cdp.sends.filter((entry) => entry.sessionId === sessionId);
    const expectedMethods = [
      ...expectedBaseMethods,
      ...(CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES[targetType].fetch
        ? ["Fetch.enable"]
        : []),
      ...expectedFinalMethods,
    ];
    assert.deepEqual(sessionSends.map((entry) => entry.method), expectedMethods);
    assert.equal(sessionSends.filter((entry) => (
      entry.method === "Runtime.runIfWaitingForDebugger"
    )).length, 1);
    const fetchEnable = sessionSends.find((entry) => entry.method === "Fetch.enable");
    if (targetType === "worker") {
      assert.equal(fetchEnable, undefined);
    } else {
      assert.deepEqual(fetchEnable.params.patterns, [
        { urlPattern: "http://*/*", requestStage: "Request" },
        { urlPattern: "https://*/*", requestStage: "Request" },
      ]);
    }
  }
  const snapshot = controller.snapshot();
  assert.equal(snapshot.passed, true);
  assert.equal(snapshot.targets.length, 3);
  assert.ok(snapshot.targets.every((target) => (
    target.initializedAt !== null
    && target.resumeAttemptCount === 1
    && target.resumedAt !== null
  )));
  assert.equal(cdp.sends.filter((entry) => (
    entry.method === "Runtime.runIfWaitingForDebugger"
  )).length, 3);
  controller.dispose();
});

test("paused worker initializer runs before exactly one resume and binds exact identity", async () => {
  const cdp = createFakeCdp({
    evaluate: ({ params }) => ({
      result: {
        result: { value: params.expression === "globalThis.__drill = true" ? { installed: true } : null },
      },
    }),
  });
  const controller = createControlledWorkerDiagnosticsController(cdp, "http://127.0.0.1:15173");
  const lease = controller.registerPausedTargetInitializer({
    id: "offscreen-canvas-unsupported",
    targetType: "worker",
    targetUrl: "http://127.0.0.1:15173/assets/drawing.worker.js",
    allowControlledConstructorQuery: true,
    expression: "globalThis.__drill = true",
    timeoutMs: 1_000,
  });
  const outcomes = await cdp.emit("Target.attachedToTarget", {
    sessionId: "worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "worker-target",
      type: "worker",
      title: "candlescope-drawing-worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js?__candlescope_cdp_worker_constructor=22222222-2222-4222-8222-222222222222%3Aworker%3A1",
    },
  });
  assert.equal(outcomes[0].status, "fulfilled");
  const receipt = await lease.waitForReceipt(1_000);
  assert.equal(receipt.state, "consumed");
  assert.equal(receipt.allowControlledConstructorQuery, true);
  assert.equal(receipt.receipt.passed, true);
  assert.equal(receipt.receipt.waitingForDebugger, true);
  assert.equal(receipt.receipt.sessionId, "worker-session");
  assert.equal(receipt.receipt.targetId, "worker-target");
  assert.equal(receipt.receipt.result.installed, true);
  assert.ok(receipt.receipt.resumedAt);
  lease.assertConsumedExactlyOnce();
  const initializerIndex = cdp.sends.findIndex((entry) => (
    entry.method === "Runtime.evaluate" && entry.params.expression === "globalThis.__drill = true"
  ));
  const resumeIndexes = cdp.sends.flatMap((entry, index) => (
    entry.method === "Runtime.runIfWaitingForDebugger" ? [index] : []
  ));
  assert.ok(initializerIndex >= 0);
  assert.deepEqual(resumeIndexes, [cdp.sends.length - 1]);
  assert.ok(initializerIndex < resumeIndexes[0]);
  assert.ok(cdp.sends.every((entry) => (
    !["Runtime.enable", "Network.enable", "Fetch.enable", "Runtime.addBinding", "Runtime.evaluate",
      "Runtime.runIfWaitingForDebugger"].includes(entry.method)
      || entry.sessionId === "worker-session"
  )));
  assert.equal(controller.snapshot().passed, true);
  controller.dispose();
});

test("paused worker initializer is atomically claimed by only one concurrent matching target", async () => {
  const cdp = createFakeCdp({
    evaluate: ({ params }) => ({
      result: { result: { value: params.expression === "globalThis.__once = true" } },
    }),
  });
  const controller = createControlledWorkerDiagnosticsController(cdp, "http://127.0.0.1:15173");
  const lease = controller.registerPausedTargetInitializer({
    id: "single-consumer",
    targetType: "worker",
    targetUrl: "http://127.0.0.1:15173/assets/drawing.worker.js",
    expression: "globalThis.__once = true",
  });
  const attach = (sessionId, targetId) => cdp.emit("Target.attachedToTarget", {
    sessionId,
    waitingForDebugger: true,
    targetInfo: {
      targetId,
      type: "worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  await Promise.all([
    attach("concurrent-session-a", "concurrent-target-a"),
    attach("concurrent-session-b", "concurrent-target-b"),
  ]);
  const receipt = await lease.waitForReceipt(1_000);
  assert.equal(receipt.state, "consumed");
  assert.equal(receipt.matchCount, 1);
  assert.equal(cdp.sends.filter((entry) => (
    entry.method === "Runtime.evaluate" && entry.params.expression === "globalThis.__once = true"
  )).length, 1);
  assert.equal(cdp.sends.filter((entry) => entry.method === "Runtime.runIfWaitingForDebugger").length, 2);
  assert.equal(controller.snapshot().invalidInitializers.length, 0);
  assert.equal(controller.snapshot().passed, true);
  controller.dispose();
});

test("paused worker initializer failures and unmatched leases remain fail closed while targets resume", async () => {
  const cdp = createFakeCdp({
    evaluate: ({ params }) => (params.expression === "throw new Error('injected')"
      ? { result: { exceptionDetails: { text: "injected initializer failure" } } }
      : { result: { result: { value: null } } }),
  });
  const controller = createControlledWorkerDiagnosticsController(cdp, "http://127.0.0.1:15173");
  const failing = controller.registerPausedTargetInitializer({
    id: "failing-initializer",
    targetType: "worker",
    targetUrl: "http://127.0.0.1:15173/assets/drawing.worker.js",
    expression: "throw new Error('injected')",
  });
  const outcomes = await cdp.emit("Target.attachedToTarget", {
    sessionId: "failed-worker-session",
    waitingForDebugger: true,
    targetInfo: {
      targetId: "failed-worker",
      type: "worker",
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  assert.equal(outcomes[0].status, "rejected");
  const failure = await failing.waitForReceipt(1_000);
  assert.equal(failure.state, "failed");
  assert.equal(failure.receipt.passed, false);
  assert.ok(failure.receipt.resumedAt);
  assert.equal(cdp.sends.filter((entry) => entry.method === "Runtime.runIfWaitingForDebugger").length, 1);
  assert.equal(controller.snapshot().passed, false);

  const unmatched = controller.registerPausedTargetInitializer({
    id: "unmatched-initializer",
    targetType: "worker",
    targetUrl: "http://127.0.0.1:15173/assets/other.worker.js",
    expression: "globalThis.__never = true",
  });
  assert.equal(unmatched.snapshot().state, "armed");
  assert.throws(() => unmatched.assertConsumedExactlyOnce(), /not consumed exactly once/);
  assert.equal(controller.snapshot().incompleteInitializers.length, 2);
  assert.ok(controller.snapshot().incompleteInitializers.some((item) => (
    item.id === "unmatched-initializer" && item.state === "armed"
  )));
  controller.dispose();
});

test("controlled runtime rejects preload injection and fingerprints native build tools", () => {
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalExecArgv = [...process.execArgv];
  try {
    process.env.NODE_OPTIONS = "--require=untrusted.cjs";
    assert.throws(() => assertControlledRunnerRuntime(), /forbids Node code injection/);
    delete process.env.NODE_OPTIONS;
    for (const argument of [
      "-runtrusted.cjs",
      "-euntrusted()",
      "--eval=untrusted()",
      "-puntrusted()",
      "--print=untrusted()",
      "--input-type=module",
    ]) {
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv, argument);
      assert.throws(() => assertControlledRunnerRuntime(), /forbids Node code injection/);
    }
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
  const smokeEntrypoint = fileURLToPath(new URL("./drawing-controlled-cdp-smoke.mjs", import.meta.url));
  const smokeLauncher = fileURLToPath(new URL("./drawing-controlled-cdp-smoke.ps1", import.meta.url));
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows").replace(/[\\/]$/, "");
  const powershellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const standardPowerShellArguments = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    smokeLauncher,
  ];
  const nativeInvocation = {
    kind: "native-process-invocation",
    schemaVersion: "candlescope-native-process-invocation/v1",
    supported: true,
    pid: 401,
    executablePath: process.execPath,
    arguments: [process.execPath, smokeEntrypoint, "--receipt", "controlled.json"],
    parent: {
      pid: 400,
      executablePath: powershellPath,
      arguments: standardPowerShellArguments,
    },
  };
  const passingRuntime = {
    nativeInvocation,
    pid: 401,
    execPath: process.execPath,
    execArgv: [],
    argv: [process.execPath, smokeEntrypoint, "--receipt", "controlled.json"],
    nodeOptions: null,
    nodePath: null,
    webSocketValid: true,
  };
  assert.deepEqual(assessControlledRunnerRuntimeEvidence(passingRuntime), {
    valid: true,
    violations: [],
    nativeEntrypoint: smokeEntrypoint,
    nativeLauncher: smokeLauncher,
  });
  assert.equal(assessControlledRunnerRuntimeEvidence({
    ...passingRuntime,
    nativeInvocation: {
      ...nativeInvocation,
      parent: {
        ...nativeInvocation.parent,
        arguments: [powershellPath, ...standardPowerShellArguments.slice(1, -1), smokeLauncher.toUpperCase()],
      },
    },
  }).valid, true);
  for (const parent of [
    {
      ...nativeInvocation.parent,
      executablePath: "C:\\controlled\\powershell.exe",
    },
    {
      ...nativeInvocation.parent,
      arguments: [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        `& node.exe ${smokeEntrypoint}`,
        "-File",
        smokeLauncher,
      ],
    },
    {
      ...nativeInvocation.parent,
      arguments: [
        "powershell.exe",
        "-NoProfile",
        "-EncodedCommand",
        "ZgBhAGsAZQA=",
        "-File",
        smokeLauncher,
      ],
    },
    {
      ...nativeInvocation.parent,
      arguments: [...standardPowerShellArguments, "-File", smokeLauncher],
    },
  ]) {
    assert.deepEqual(assessControlledRunnerRuntimeEvidence({
      ...passingRuntime,
      nativeInvocation: { ...nativeInvocation, parent },
    }).violations, ["native-launcher-parent-invalid"]);
  }
  assert.deepEqual(
    assessControlledRunnerRuntimeEvidence({ ...passingRuntime, execArgv: ["--inspect"] }).violations,
    ["node-exec-argv-not-empty"],
  );
  assert.deepEqual(
    assessControlledRunnerRuntimeEvidence({
      ...passingRuntime,
      nativeInvocation: {
        ...nativeInvocation,
        arguments: [process.execPath, fileURLToPath(import.meta.url)],
      },
    }).violations,
    ["native-entrypoint-invalid", "native-launcher-parent-invalid", "javascript-argv-mismatch"],
  );
  assert.throws(() => assertControlledRunnerEntrypoint(), /trusted native entrypoint/);
  const fingerprint = fingerprintBuildToolImplementation();
  assert.ok(fingerprint.files.some((file) => (
    file.path.startsWith("@rollup/") && file.path.endsWith(".node")
  )));
  assert.ok(fingerprint.files.some((file) => file.path.startsWith("@esbuild/")));
});

test("controlled browser state fails closed for hidden, minimized, or headless evidence", () => {
  const passing = assessControlledBrowserWindow({
    headed: true,
    windowState: "normal",
    visibilityState: "visible",
    hidden: false,
    hasFocus: true,
    devicePixelRatio: 1.5,
    browserProduct: "Chrome/150.0.0.0",
    userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
  });
  assert.deepEqual(passing, { valid: true, violations: [] });

  const forbidden = assessControlledBrowserWindow({
    headed: false,
    windowState: "minimized",
    visibilityState: "hidden",
    hidden: true,
    hasFocus: false,
    devicePixelRatio: 0,
    browserProduct: "HeadlessChrome/150.0.0.0",
    userAgent: "HeadlessChrome/150.0.0.0",
  });
  assert.equal(forbidden.valid, false);
  assert.deepEqual(forbidden.violations, [
    "headed-browser-not-proven",
    "browser-window-not-normal",
    "document-not-visible",
    "document-hidden-state-invalid",
    "browser-window-not-focused",
    "device-pixel-ratio-invalid",
    "headless-browser-identity-observed",
  ]);
});

test("browser close evidence rejects contradictory command, remote, exit, and grace receipts", () => {
  const passing = passingHeadedChromeCloseEvidence(901);
  assert.deepEqual(assessControlledBrowserCloseEvidence(passing), {
    valid: true,
    violations: [],
  });

  const cases = [
    ["missing remote closure proof", (receipt) => { receipt.cdpClosure = null; }, "close-cdp-closure-invalid"],
    ["process exit before dispatch", (receipt) => {
      receipt.stoppedAt = "2026-07-16T00:00:00.005Z";
      receipt.browserCloseReceipt.processExitedAt = receipt.stoppedAt;
    }, "process-exited-before-close-dispatch"],
    ["impossible command state", (receipt) => {
      receipt.browserCloseReceipt.commandCompleted = false;
      receipt.browserCloseReceipt.commandTimedOut = false;
    }, "close-command-outcome-inconsistent"],
    ["remote close before dispatch", (receipt) => {
      const observedAt = "2026-07-16T00:00:00.005Z";
      receipt.cdpClosure.remote.event.observedAt = observedAt;
      receipt.cdpClosure.remote.terminalCause.observedAt = observedAt;
      receipt.browserCloseReceipt.remoteCdpClosedAt = observedAt;
    }, "close-remote-event-before-dispatch"],
    ["unproven descendant grace", (receipt) => {
      receipt.browserCloseReceipt.descendantExitGrace = { passed: true };
    }, "close-grace-schema-invalid"],
    ["grace for another process", (receipt) => {
      receipt.browserCloseReceipt.descendantExitGrace.rootPid = 902;
    }, "close-grace-root-pid-mismatch"],
  ];
  for (const [name, mutate, expectedViolation] of cases) {
    const receipt = structuredClone(passing);
    mutate(receipt);
    const assessment = assessControlledBrowserCloseEvidence(receipt);
    assert.equal(assessment.valid, false, name);
    assert.ok(assessment.violations.includes(expectedViolation), `${name}: ${assessment.violations.join(",")}`);
  }
});

test("browser close evidence accepts a structured websocket error then remote close race", () => {
  const receipt = passingHeadedChromeCloseEvidence(911);
  const terminalCause = {
    kind: "cdp-error",
    observedAt: "2026-07-16T00:00:00.060Z",
    message: "socket reset while Chrome was exiting",
  };
  receipt.browserCloseReceipt.commandCompleted = false;
  receipt.browserCloseReceipt.commandTimedOut = false;
  receipt.browserCloseReceipt.commandError = "Owned Chrome CDP websocket error: socket reset while Chrome was exiting";
  receipt.browserCloseReceipt.commandTerminalCause = terminalCause;
  receipt.browserCloseReceipt.commandSettledAt = "2026-07-16T00:00:00.070Z";
  receipt.cdpClosure.remote.terminalCause = terminalCause;
  assert.deepEqual(assessControlledBrowserCloseEvidence(receipt), {
    valid: true,
    violations: [],
  });
});

test("Windows tree cleanup proof requires exact top-level subtree coverage and ordered census", () => {
  const rootPid = 921;
  const receipt = passingTreeStopReceipt(rootPid);
  receipt.descendantCensus.before = passingCensus(
    rootPid,
    "2026-07-16T00:00:00.300Z",
    [
      { pid: 922, parentPid: rootPid },
      { pid: 923, parentPid: 922 },
      { pid: 924, parentPid: rootPid },
    ],
  );
  receipt.descendantCensus.terminationReceipts = [922, 924].map((targetPid) => ({
    kind: "windows-taskkill",
    exited: true,
    exitCode: 0,
    details: { targetPid },
  }));
  assert.deepEqual(assessWindowsOwnedProcessTreeReceipt(receipt, rootPid), {
    valid: true,
    violations: [],
  });

  const duplicateSubstitution = structuredClone(receipt);
  duplicateSubstitution.descendantCensus.terminationReceipts[1].details.targetPid = 922;
  const duplicateAssessment = assessWindowsOwnedProcessTreeReceipt(duplicateSubstitution, rootPid);
  assert.equal(duplicateAssessment.valid, false);
  assert.ok(duplicateAssessment.violations.includes("termination-target-pids-duplicate"));
  assert.ok(duplicateAssessment.violations.includes("termination-target-pid-set-mismatch"));

  const unboundParent = structuredClone(receipt);
  unboundParent.descendantCensus.before.descendants[1].parentPid = 999;
  const unboundAssessment = assessWindowsOwnedProcessTreeReceipt(unboundParent, rootPid);
  assert.equal(unboundAssessment.valid, false);
  assert.ok(unboundAssessment.violations.includes("before-descendant-parent-unbound"));

  const reversedCensus = structuredClone(receipt);
  reversedCensus.descendantCensus.after.checkedAt = "2026-07-16T00:00:00.200Z";
  const reversedAssessment = assessWindowsOwnedProcessTreeReceipt(reversedCensus, rootPid);
  assert.equal(reversedAssessment.valid, false);
  assert.ok(reversedAssessment.violations.includes("census-time-order-invalid"));
});

test("cleanup summary requires every owned process exit and profile removal", () => {
  const complete = summarizeControlledCleanup({
    processes: [
      {
        kind: "headed-chrome",
        pid: 101,
        exited: true,
        stoppedAt: "2026-07-16T00:00:00.100Z",
        exitCode: 0,
        signal: null,
        forceStopRequestedAt: null,
        spawnError: null,
        diagnosticsClosed: true,
        cdpClosure: passingCdpClosure(),
        diagnosticsBarrier: { completed: true },
        workerDiagnosticsBarrier: { passed: true },
        handlerSettlementBeforeClose: { passed: true },
        handlerSettlementAfterClose: { passed: true },
        finalWorkerDiagnostics: { passed: true },
        finalOriginGuard: { passed: true },
        finalDiagnostics: healthyFinalDiagnostics(),
        browserCloseReceipt: passingBrowserCloseReceipt(),
        finalizationErrors: [],
        treeStopReceipt: passingTreeStopReceipt(101),
      },
      {
        kind: "vite-preview",
        pid: 102,
        exited: true,
        spawnError: null,
        treeStopReceipt: passingTreeStopReceipt(102),
      },
      {
        kind: "mock-api",
        pid: 103,
        exited: true,
        spawnError: null,
        treeStopReceipt: passingTreeStopReceipt(103),
      },
    ],
    ports: [
      { kind: "mock-api", closed: true },
      { kind: "vite-preview", closed: true },
      { kind: "chrome-debug", closed: true },
    ],
    profile: { removed: true },
  });
  assert.deepEqual(complete, {
    complete: true,
    processCount: 3,
    allProcessesExited: true,
    diagnosticsClosed: true,
    portCount: 3,
    allOwnedPortsClosed: true,
    profileRemoved: true,
    failures: [],
  });

  const incomplete = summarizeControlledCleanup({
    processes: [
      {
        kind: "headed-chrome",
        pid: 201,
        exited: false,
        spawnError: null,
        diagnosticsClosed: false,
        handlerSettlementBeforeClose: { passed: false },
        handlerSettlementAfterClose: { passed: false },
        treeStopReceipt: passingTreeStopReceipt(201),
      },
      {
        kind: "vite-preview",
        pid: 202,
        exited: true,
        spawnError: "spawn failed",
        treeStopReceipt: passingTreeStopReceipt(202),
      },
    ],
    ports: [
      { kind: "mock-api", closed: true },
      { kind: "vite-preview", closed: false },
    ],
    profile: { removed: false },
  });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.failures, [
    "headed-chrome-not-exited",
    "headed-chrome-diagnostics-not-closed",
    "headed-chrome-diagnostics-barrier-incomplete",
    "headed-chrome-worker-diagnostics-barrier-incomplete",
    "headed-chrome-pre-close-handlers-unsettled",
    "headed-chrome-post-close-handlers-unsettled",
    "headed-chrome-final-worker-diagnostics-invalid",
    "headed-chrome-final-origin-guard-invalid",
    "headed-chrome-final-diagnostics-invalid",
    "headed-chrome-intentional-close-invalid",
    "headed-chrome-finalization-errors",
    "vite-preview-spawn-error",
    "mock-api-process-receipt-missing-or-duplicate",
    "owned-profile-not-removed",
    "vite-preview-port-not-closed",
    "chrome-debug-port-receipt-missing-or-duplicate",
  ]);
  assert.equal(incomplete.diagnosticsClosed, false);
  assert.equal(incomplete.allOwnedPortsClosed, false);

  const descendantsRemain = summarizeControlledCleanup({
    processes: [
      {
        kind: "headed-chrome",
        pid: 301,
        exited: true,
        stoppedAt: "2026-07-16T00:00:00.100Z",
        exitCode: 0,
        signal: null,
        forceStopRequestedAt: null,
        diagnosticsClosed: true,
        cdpClosure: passingCdpClosure(),
        diagnosticsBarrier: { completed: true },
        workerDiagnosticsBarrier: { passed: true },
        handlerSettlementBeforeClose: { passed: true },
        handlerSettlementAfterClose: { passed: true },
        finalWorkerDiagnostics: { passed: true },
        finalOriginGuard: { passed: true },
        finalDiagnostics: healthyFinalDiagnostics(),
        browserCloseReceipt: passingBrowserCloseReceipt(301),
        finalizationErrors: [],
        treeStopReceipt: {
          ...passingTreeStopReceipt(301),
          descendantCensus: {
            ...passingTreeStopReceipt(301).descendantCensus,
            empty: false,
          },
        },
      },
      { kind: "vite-preview", pid: 302, exited: true, treeStopReceipt: passingTreeStopReceipt(302) },
      { kind: "mock-api", pid: 303, exited: true, treeStopReceipt: passingTreeStopReceipt(303) },
    ],
    ports: [
      { kind: "mock-api", closed: true },
      { kind: "vite-preview", closed: true },
      { kind: "chrome-debug", closed: true },
    ],
    profile: { removed: true },
  });
  assert.equal(descendantsRemain.complete, false);
  assert.ok(descendantsRemain.failures.includes("headed-chrome-tree-stop-failed"));

  const forgedReceipts = summarizeControlledCleanup({
    processes: [
      {
        kind: "headed-chrome",
        pid: 501,
        exited: true,
        stoppedAt: "2026-07-16T00:00:00.100Z",
        exitCode: 0,
        signal: null,
        forceStopRequestedAt: null,
        diagnosticsClosed: true,
        cdpClosure: passingCdpClosure(),
        diagnosticsBarrier: { completed: true },
        workerDiagnosticsBarrier: { passed: true },
        handlerSettlementBeforeClose: { passed: true },
        handlerSettlementAfterClose: { passed: true },
        finalWorkerDiagnostics: { passed: true },
        finalOriginGuard: { passed: true },
        finalDiagnostics: {
          ...healthyFinalDiagnostics(),
          runtimeExceptions: [{ text: "late failure" }],
        },
        browserCloseReceipt: {
          ...passingBrowserCloseReceipt(501),
          forceTerminationUsed: true,
        },
        finalizationErrors: [],
        treeStopReceipt: {
          exited: true,
          exitCode: 0,
          rootExited: true,
          descendantCensus: { empty: true },
        },
      },
      { kind: "vite-preview", pid: 502, exited: true, treeStopReceipt: passingTreeStopReceipt(502) },
      { kind: "mock-api", pid: 503, exited: true, treeStopReceipt: passingTreeStopReceipt(503) },
    ],
    ports: [
      { kind: "mock-api", closed: true },
      { kind: "vite-preview", closed: true },
      { kind: "chrome-debug", closed: true },
    ],
    profile: { removed: true },
  });
  assert.equal(forgedReceipts.complete, false);
  assert.ok(forgedReceipts.failures.includes("headed-chrome-final-diagnostics-invalid"));
  assert.ok(forgedReceipts.failures.includes("headed-chrome-intentional-close-invalid"));
  assert.ok(forgedReceipts.failures.includes("headed-chrome-tree-stop-failed"));
});

test("retirement summary requires strict process cleanup while retaining the owned profile", () => {
  const browser = passingHeadedChromeCloseEvidence(601);
  browser.diagnosticsBarrier = { completed: true };
  browser.workerDiagnosticsBarrier = { passed: true };
  browser.handlerSettlementBeforeClose = { passed: true };
  browser.handlerSettlementAfterClose = { passed: true };
  browser.finalWorkerDiagnostics = { passed: true };
  browser.finalOriginGuard = { passed: true };
  browser.finalDiagnostics = healthyFinalDiagnostics();
  browser.finalizationErrors = [];
  browser.storageFaultCleanup = { complete: true, forced: false };
  const receipts = {
    browser,
    servers: {
      preview: {
        kind: "vite-preview",
        pid: 602,
        exited: true,
        spawnError: null,
        treeStopReceipt: passingTreeStopReceipt(602),
      },
      api: {
        kind: "mock-api",
        pid: 603,
        exited: true,
        spawnError: null,
        treeStopReceipt: passingTreeStopReceipt(603),
      },
    },
    ports: [
      { kind: "mock-api", closed: true },
      { kind: "vite-preview", closed: true },
      { kind: "chrome-debug", closed: true },
    ],
    profile: {
      retained: true,
      exists: true,
      profileId: "controlled-profile:retirement-test",
      profileDirectorySha256: "a".repeat(64),
    },
  };
  assert.deepEqual(summarizeControlledRetirement(receipts), {
    kind: "controlled-canary-retirement",
    schemaVersion: "candlescope-controlled-canary-retirement/v1",
    complete: true,
    processCount: 3,
    allProcessesExited: true,
    diagnosticsClosed: true,
    portCount: 3,
    allOwnedPortsClosed: true,
    profileRetained: true,
    storageFaultCleanupComplete: true,
    profileId: "controlled-profile:retirement-test",
    profileDirectorySha256: "a".repeat(64),
    failures: [],
  });

  receipts.profile.exists = false;
  const missingProfile = summarizeControlledRetirement(receipts);
  assert.equal(missingProfile.complete, false);
  assert.ok(missingProfile.failures.includes("owned-profile-not-retained"));

  receipts.profile.exists = true;
  receipts.servers.preview.exited = false;
  const livePreview = summarizeControlledRetirement(receipts);
  assert.equal(livePreview.complete, false);
  assert.ok(livePreview.failures.includes("vite-preview-not-exited"));

  receipts.servers.preview.exited = true;
  receipts.browser.storageFaultCleanup = { complete: true, forced: true };
  const forcedStorageCleanup = summarizeControlledRetirement(receipts);
  assert.equal(forcedStorageCleanup.complete, false);
  assert.ok(forcedStorageCleanup.failures.includes("storage-fault-cleanup-incomplete"));
});
