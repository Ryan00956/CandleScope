import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTROLLED_DIAGNOSTIC_WORKER_DOMAIN_CAPABILITIES,
  CONTROLLED_DIAGNOSTIC_WORKER_TYPES,
  assessControlledBrowserCloseEvidence,
  assessControlledBrowserWindow,
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
  extractHtmlAssetPaths,
  fingerprintBuildToolImplementation,
  fingerprintFileEntries,
  normalizeControlledCdpOptions,
  parseControlledCdpMessage,
  assertControlledRunnerEntrypoint,
  assertControlledRunnerRuntime,
  summarizeControlledCleanup,
} from "./drawing-controlled-cdp.mjs";

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

async function emitWorkerConstruction(
  cdp,
  url = "http://127.0.0.1:15173/assets/drawing.worker.js",
  workerType = "module",
) {
  await cdp.emit("Runtime.bindingCalled", {
    name: "__CANDLESCOPE_CONTROLLED_CDP_REPORT__",
    payload: JSON.stringify({ kind: "worker-constructor", url, workerType }),
  });
}

async function createWorkerBootstrapHandoffFixture({
  requestId = "worker-bootstrap-target",
  targetId = requestId,
  sourceUrl = "http://127.0.0.1:15173/assets/drawing.worker.js",
  targetUrl = sourceUrl,
  constructionCount = 1,
  constructionTiming = "before-source",
  constructionWorkerType = "module",
  observationGapCount = 0,
  sourceDocumentUrl = "http://127.0.0.1:15173/",
  sourceFrameId = "main-frame",
  sourceInitiatorType = "other",
  sourceLoaderId = "",
  sourceTiming = "before-target",
  sourceType = "Script",
  timeoutMs = 500,
} = {}) {
  const files = [
    { relativePath: "index.html", content: "index" },
    { relativePath: "assets/main.js", content: "main" },
    { relativePath: "assets/drawing.worker.js", content: "worker" },
  ];
  const sessionId = "worker-session";
  const cdp = createFakeCdp({
    responseBodies: new Map([
      ["<top>\0document", { body: "index", base64Encoded: false }],
      ["<top>\0entry", { body: "main", base64Encoded: false }],
      [`${sessionId}\0${requestId}`, { body: "worker", base64Encoded: false }],
      [`${sessionId}\0worker-self-fetch`, { body: "worker", base64Encoded: false }],
    ]),
  });
  const tracker = createControlledNetworkAssetTracker(cdp, "http://127.0.0.1:15173", {
    entryAssetPaths: ["assets/main.js"],
    assetFingerprint: fingerprintFileEntries(files),
  }, timeoutMs, "main-frame");
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
      await emitWorkerConstruction(cdp, targetUrl, constructionWorkerType);
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
  await cdp.emit("Target.attachedToTarget", {
    sessionId,
    waitingForDebugger: true,
    targetInfo: {
      targetId,
      type: "worker",
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
    sessionId,
    sourceUrl,
    targetUrl,
    tracker,
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
  const cdp = createFakeCdp();
  const guard = await createManagedOriginGuard(cdp, managedUrl);
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
  assert.equal(defaults.dpr, 1);
  assert.equal(defaults.engineMode, "scene-canary");
  assert.equal(defaults.interactionSurfaceMode, "overlay");
  assert.equal(defaults.rasterBackend, "worker");
  assert.equal(defaults.timeoutMs, 45_000);
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(defaults.viewport), true);

  const configured = normalizeControlledCdpOptions({
    chromePath: "C:\\controlled\\chrome.exe",
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
    () => normalizeControlledCdpOptions({ viewport: { width: 1280, height: 720, mobile: false } }),
    /Unknown viewport option/,
  );
});

test("controlled build environment strips ambient Vite values and records explicit production inputs", () => {
  const environment = controlledBuildEnvironment({
    chromePath: "",
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
    VITE_DRAWING_DOCUMENT_AUTHORITY: "document",
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
  assert.equal(tracker.snapshot().workerTargets[0].active, false);
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
      name: "constructor after target attach",
      options: { constructionTiming: "after-target" },
      reason: "constructor-not-before-target-attachment",
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
      url: "http://127.0.0.1:15173/assets/drawing.worker.js",
    },
  });
  assert.equal(outcomes[0].status, "fulfilled");
  const receipt = await lease.waitForReceipt(1_000);
  assert.equal(receipt.state, "consumed");
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

test("Windows tree cleanup proof requires exact unique descendant PID coverage and ordered census", () => {
  const rootPid = 921;
  const receipt = passingTreeStopReceipt(rootPid);
  receipt.descendantCensus.before = passingCensus(
    rootPid,
    "2026-07-16T00:00:00.300Z",
    [
      { pid: 922, parentPid: rootPid },
      { pid: 923, parentPid: 922 },
    ],
  );
  receipt.descendantCensus.terminationReceipts = [922, 923].map((targetPid) => ({
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
