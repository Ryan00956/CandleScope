import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const frontendRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = path.join(repositoryRoot, "backend");
const RELEASE_DURATION_MS = 4 * 60 * 60 * 1_000;
const RELEASE_CYCLES = 100;
const RELEASE_PROJECTION_EVENTS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_ITEMS = 10_000;
const MIB = 1024 * 1024;

function parseArgs(argv) {
  const result = {
    allowShort: false,
    chromePath: process.env.CHROME_PATH || "",
    cycles: RELEASE_CYCLES,
    diagnosticGapSteps: 0,
    durationMs: RELEASE_DURATION_MS,
    headed: false,
    out: path.join(repositoryRoot, "docs", "perf-baselines", "replay-v1-browser-soak-20260718.json"),
    projectionEvents: RELEASE_PROJECTION_EVENTS,
    sampleMs: 60_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-short") result.allowShort = true;
    else if (value === "--headed") result.headed = true;
    else if (value === "--chrome-path") result.chromePath = String(argv[++index] || "");
    else if (value === "--cycles") result.cycles = Number(argv[++index]);
    else if (value === "--diagnostic-gap-steps") result.diagnosticGapSteps = Number(argv[++index]);
    else if (value === "--duration-ms") result.durationMs = Number(argv[++index]);
    else if (value === "--out") result.out = path.resolve(String(argv[++index] || ""));
    else if (value === "--projection-events") result.projectionEvents = Number(argv[++index]);
    else if (value === "--sample-ms") result.sampleMs = Number(argv[++index]);
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown replay soak option: ${value}`);
  }
  for (const [name, value, minimum] of [
    ["--duration-ms", result.durationMs, 10_000],
    ["--cycles", result.cycles, 1],
    ["--diagnostic-gap-steps", result.diagnosticGapSteps, 0],
    ["--projection-events", result.projectionEvents, 1],
    ["--sample-ms", result.sampleMs, 1_000],
    ["--timeout-ms", result.timeoutMs, 5_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer >= ${minimum}`);
    }
  }
  if (!result.allowShort && (
    result.durationMs < RELEASE_DURATION_MS
    || result.cycles < RELEASE_CYCLES
    || result.projectionEvents < RELEASE_PROJECTION_EVENTS
  )) {
    throw new Error("Release soak requires >=4h, >=100 lifecycle cycles, and >=1,000,000 browser projection events; use --allow-short only for harness validation");
  }
  if (!result.allowShort && result.diagnosticGapSteps > 0) {
    throw new Error("--diagnostic-gap-steps is available only with --allow-short");
  }
  return result;
}

function findChrome(explicit = "") {
  const candidates = [
    explicit,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function waitForHttp(url, child, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Process exited before ${url}: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

function processTail(child, maxLines = 120) {
  const lines = [];
  const append = (chunk) => {
    lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => [...lines];
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(3_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function stopBackendGracefully(child, backendOrigin) {
  if (!child || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  try {
    const response = await fetch(`${backendOrigin}/__replay_smoke__/shutdown`, { method: "POST" });
    if (!response.ok) return;
    if (child.exitCode !== null) return;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      wait(15_000),
    ]);
  } catch {
    // The exact fixture process is force-stopped below if graceful shutdown is unavailable.
  }
}

function boundedPush(items, value, maximum = MAX_CAPTURE_ITEMS) {
  items.push(value);
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params || {});
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.socket.close(); } catch { /* target may already be closed */ }
  }
}

async function createTarget(debugBase, url = "about:blank") {
  const target = await readJson(`${debugBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
    cdp.send("HeapProfiler.enable"),
  ]);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  return { target, cdp };
}

async function evaluate(cdp, expression, { userGesture = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForValue(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    try {
      value = await evaluate(cdp, expression);
      if (value) return value;
    } catch { /* page may be navigating */ }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(value)}`);
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.matches(":disabled")) return false;
    element.click();
    return true;
  })()`, { userGesture: true });
  if (!clicked) throw new Error(`Cannot click ${selector}`);
}

async function clickButtonByText(cdp, text) {
  const clicked = await evaluate(cdp, `(() => {
    const element = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`, { userGesture: true });
  if (!clicked) throw new Error(`Cannot click button text ${text}`);
}

function captureTarget(cdp) {
  const responseByRequest = new Map();
  const bodyTasks = new Set();
  const capture = {
    requestCount: 0,
    requests: [],
    responseBodies: [],
    responseCount: 0,
    responses: [],
    webSocketCount: 0,
    webSockets: [],
    webSocketFramesReceived: [],
    webSocketFramesSent: [],
    exceptions: [],
    consoleErrors: [],
    async settle() {
      await Promise.allSettled([...bodyTasks]);
    },
  };
  cdp.on("Network.requestWillBeSent", (event) => {
    capture.requestCount += 1;
    boundedPush(capture.requests, {
      method: event.request?.method || "",
      postData: event.request?.postData || "",
      url: event.request?.url || "",
    });
  });
  cdp.on("Network.responseReceived", (event) => {
    const item = { url: event.response?.url || "", status: event.response?.status || 0 };
    capture.responseCount += 1;
    boundedPush(capture.responses, item);
    if (/\/api\/v1\/replay(?:\/|\?|$)/.test(item.url)) responseByRequest.set(event.requestId, item.url);
  });
  cdp.on("Network.loadingFinished", (event) => {
    const url = responseByRequest.get(event.requestId);
    if (!url) return;
    responseByRequest.delete(event.requestId);
    const task = cdp.send("Network.getResponseBody", { requestId: event.requestId })
      .then((result) => {
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body;
        boundedPush(capture.responseBodies, { url, body });
      })
      .catch(() => undefined)
      .finally(() => bodyTasks.delete(task));
    bodyTasks.add(task);
  });
  cdp.on("Network.webSocketCreated", (event) => {
    capture.webSocketCount += 1;
    boundedPush(capture.webSockets, event.url || "");
  });
  cdp.on("Network.webSocketFrameReceived", (event) => {
    boundedPush(capture.webSocketFramesReceived, event.response?.payloadData || "");
  });
  cdp.on("Network.webSocketFrameSent", (event) => {
    boundedPush(capture.webSocketFramesSent, event.response?.payloadData || "");
  });
  cdp.on("Runtime.exceptionThrown", (event) => {
    boundedPush(capture.exceptions, event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "exception");
  });
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      boundedPush(capture.consoleErrors, event.args?.map((item) => item.value || item.description || "").join(" ") || "console error");
    }
  });
  return capture;
}

function assert(condition, message, detail = undefined) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function replayStatus(cdp) {
  return evaluate(cdp, `(() => {
    const status = document.querySelector("#replay-status-bar");
    if (!(status instanceof HTMLElement)) return null;
    return {
      connection: status.dataset.replayConnection,
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) bars/) || [])[1] || 0),
    };
  })()`);
}

async function waitForReplayStatus(cdp, predicateSource, timeoutMs, label) {
  return waitForValue(cdp, `(() => {
    const status = document.querySelector("#replay-status-bar");
    if (!(status instanceof HTMLElement)) return null;
    const value = {
      connection: status.dataset.replayConnection,
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) bars/) || [])[1] || 0),
    };
    return (${predicateSource})(value) ? value : null;
  })()`, timeoutMs, label);
}

async function waitForCommandReady(cdp, timeoutMs) {
  return waitForValue(cdp, `(() => {
    const button = document.querySelector('[data-replay-action="step"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, timeoutMs, "replay command readiness");
}

async function trainingActionCycle({ cdp, backendOrigin, sessionId, diagnosticGapSteps, index, timeoutMs }) {
  const before = await replayStatus(cdp);
  assert(before?.state === "PLAYING", "training cycle did not begin in PLAYING", before);
  await click(cdp, '[data-replay-action="pause"]');
  const paused = await waitForReplayStatus(cdp, `(value) => value.state === "PAUSED"`, timeoutMs, "training pause ack");
  await wait(250);
  const pauseStable = await replayStatus(cdp);
  assert(pauseStable.sourceSequence === paused.sourceSequence, "training cursor advanced after pause ack", { paused, pauseStable });

  const targetSpeed = [60, 120, 300, 600][index % 4];
  const speedChanged = await evaluate(cdp, `(() => {
    const select = document.querySelector('[data-replay-action="speed"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = "${targetSpeed}";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(speedChanged, "training speed control was unavailable", { index, targetSpeed });
  const accelerated = await waitForReplayStatus(
    cdp,
    `(value) => value.revision > ${paused.revision}`,
    timeoutMs,
    "training speed ack",
  );
  await waitForCommandReady(cdp, timeoutMs);

  const side = index % 2 === 0 ? "BUY" : "SELL";
  const sideChanged = await evaluate(cdp, `(() => {
    const ticket = document.querySelector('.replay-order-ticket');
    const button = [...(ticket?.querySelectorAll('button') || [])].find((item) => item.textContent?.trim() === "${side}");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(sideChanged, "training order side control was unavailable", { index, side });
  const beforeOrder = await replayStatus(cdp);
  await click(cdp, '[data-replay-action="place-order"]');
  const ordered = await waitForReplayStatus(
    cdp,
    `(value) => value.orderCount > ${beforeOrder.orderCount}`,
    timeoutMs,
    "training market order ack",
  );
  await waitForCommandReady(cdp, timeoutMs);
  await click(cdp, '[data-replay-action="play"]');
  await waitForReplayStatus(cdp, `(value) => value.state === "PLAYING"`, timeoutMs, "accelerated play ack");
  const filled = await waitForReplayStatus(
    cdp,
    `(value) => value.sourceSequence > ${ordered.sourceSequence} && value.fillCount > ${ordered.fillCount}`,
    timeoutMs,
    "training market fill",
  );
  await click(cdp, '[data-replay-action="pause"]');
  const filledPaused = await waitForReplayStatus(cdp, `(value) => value.state === "PAUSED"`, timeoutMs, "post-fill pause ack");
  await wait(250);
  const filledPauseStable = await replayStatus(cdp);
  assert(
    filledPauseStable.sourceSequence === filledPaused.sourceSequence,
    "training cursor advanced after post-fill pause ack",
    { filledPaused, filledPauseStable },
  );

  let gapStatus = filledPaused;
  for (let stepIndex = 0; stepIndex < diagnosticGapSteps; stepIndex += 1) {
    await waitForCommandReady(cdp, timeoutMs);
    const beforeGapStep = await replayStatus(cdp);
    await click(cdp, '[data-replay-action="step"]');
    gapStatus = await waitForReplayStatus(
      cdp,
      `(value) => value.sourceSequence > ${beforeGapStep.sourceSequence}`,
      timeoutMs,
      "diagnostic gap step",
    );
  }

  const normalSpeedChanged = await evaluate(cdp, `(() => {
    const select = document.querySelector('[data-replay-action="speed"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(normalSpeedChanged, "training speed reset control was unavailable", { index });
  const normalSpeed = await waitForReplayStatus(
    cdp,
    `(value) => value.revision > ${gapStatus.revision}`,
    timeoutMs,
    "training speed reset ack",
  );
  await waitForCommandReady(cdp, timeoutMs);

  const disconnectRequest = readJson(
    `${backendOrigin}/__replay_smoke__/disconnect-replay/${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  );
  await waitForReplayStatus(
    cdp,
    `(value) => value.connection === "reconnecting" || value.connection === "resyncing"`,
    timeoutMs,
    "training replay disconnect feedback",
  );
  await disconnectRequest;
  const reconnected = await waitForReplayStatus(
    cdp,
    `(value) => value.connection === "connected" && value.sourceSequence >= ${normalSpeed.sourceSequence}`,
    timeoutMs,
    "training replay reconnect convergence",
  );
  const takeoverVisible = await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-replay-action="takeover-controller"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`);
  if (takeoverVisible) {
    await click(cdp, '[data-replay-action="takeover-controller"]');
    await waitForCommandReady(cdp, timeoutMs);
  }
  await click(cdp, '[data-replay-action="play"]');
  const resumed = await waitForReplayStatus(cdp, `(value) => value.state === "PLAYING"`, timeoutMs, "training resume ack");
  return {
    targetSpeed,
    side,
    before,
    paused,
    accelerated,
    ordered,
    filled,
    diagnosticGapSteps,
    gapStatus,
    normalSpeed,
    reconnected,
    resumed,
  };
}

async function liveSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body?.innerText || "";
    const interval = document.querySelector(".interval-btn.active")?.textContent?.trim() || "";
    const bars = Math.max(0, ...[...text.matchAll(/([0-9]+)[ ]+bars/g)].map((match) => Number(match[1])));
    return {
      url: location.href,
      interval,
      bars,
      canvasCount: document.querySelectorAll("canvas").length,
      prefs: localStorage.getItem("candlescope-user-prefs"),
      replayEntry: document.querySelector('[data-replay-entry="enabled"]')?.textContent?.trim() || "",
    };
  })()`);
}

async function browserMetrics(cdp, collectGarbage = true) {
  if (collectGarbage) await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const [heap, performance, dom] = await Promise.all([
    cdp.send("Runtime.getHeapUsage"),
    cdp.send("Performance.getMetrics"),
    evaluate(cdp, `({
      elements: document.querySelectorAll("*").length,
      canvases: document.querySelectorAll("canvas").length,
      bodyTextBytes: new TextEncoder().encode(document.body?.innerText || "").length,
    })`),
  ]);
  const metrics = Object.fromEntries((performance.metrics || []).map((item) => [item.name, item.value]));
  return {
    atMs: Date.now(),
    heap: {
      usedSize: heap.usedSize,
      totalSize: heap.totalSize,
      embedderHeapUsedSize: heap.embedderHeapUsedSize,
      backingStorageSize: heap.backingStorageSize,
    },
    dom,
    performance: {
      documents: metrics.Documents ?? null,
      frames: metrics.Frames ?? null,
      jsEventListeners: metrics.JSEventListeners ?? null,
      layoutCount: metrics.LayoutCount ?? null,
      nodes: metrics.Nodes ?? null,
      taskDuration: metrics.TaskDuration ?? null,
    },
  };
}

async function runProjectionSoak(cdp, eventCount) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const before = await cdp.send("Runtime.getHeapUsage");
  const result = await evaluate(cdp, `(async () => {
    const [{ ReplayStore }, parser, fixtures] = await Promise.all([
      import("/src/features/replay/replayStore.ts"),
      import("/src/features/replay/replayParser.ts"),
      import("/src/features/replay/__tests__/fixtures.ts"),
    ]);
    let store = new ReplayStore();
    store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
    store.applyAtomicSnapshot(1, parser.parseReplaySessionResponse(fixtures.replayTradeSessionResponse()).snapshot);
    const count = ${JSON.stringify(eventCount)};
    const milestones = {};
    const targets = new Map([
      [Math.ceil(count * 0.25), "25pct"],
      [Math.ceil(count * 0.50), "50pct"],
      [Math.ceil(count * 0.75), "75pct"],
      [count, "100pct"],
    ]);
    const started = performance.now();
    for (let index = 1; index <= count; index += 1) {
      const parsed = parser.parseReplayEvent(fixtures.replayTradeDeltaEvent({ sequence: index, sourceSequence: index + 1 }));
      if (!store.applyEvent(1, parsed)) throw new Error("ReplayStore rejected browser projection event " + index);
      const label = targets.get(index);
      if (label) milestones[label] = performance.memory?.usedJSHeapSize ?? null;
    }
    const elapsedMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = store.getSnapshot();
    const output = {
      events: count,
      elapsedMs,
      eventsPerSecond: count / (elapsedMs / 1000),
      heapMilestones: milestones,
      seriesBars: store.seriesStore.barCount,
      sourceSequence: snapshot.sourceSequence,
      uiFlushCount: snapshot.uiFlushCount,
      renderRevision: snapshot.renderRevision,
      transient: store.transientDiagnostics(),
    };
    store.dispose();
    store = null;
    return output;
  })()`);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const after = await cdp.send("Runtime.getHeapUsage");
  return {
    ...result,
    scope: "Vite browser + real ReplayStore + replayParser + SeriesWindowStore; React chart rendering is covered by the separate 4h app soak",
    heapBeforeGcBytes: before.usedSize,
    heapAfterDisposeGcBytes: after.usedSize,
    retainedHeapDeltaBytes: after.usedSize - before.usedSize,
  };
}

async function dumpIndexedDb(cdp) {
  return evaluate(cdp, `(async () => {
    if (typeof indexedDB.databases !== "function") return { supported: false, databases: [] };
    const descriptors = await indexedDB.databases();
    const databases = [];
    for (const descriptor of descriptors) {
      if (!descriptor.name) continue;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(descriptor.name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const stores = {};
      for (const storeName of db.objectStoreNames) {
        stores[storeName] = await new Promise((resolve, reject) => {
          const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(null, 1000);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }
      databases.push({ name: descriptor.name, version: descriptor.version, stores });
      db.close();
    }
    return { supported: true, databases };
  })()`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const forbiddenBoundaries = [
  // Match a standalone fixture epoch token in JSON, text, or a URL. Do not
  // classify the same digit run inside a Decimal amount, hash, or identifier.
  { name: "fixture_epoch_milliseconds", pattern: /(?<![0-9A-Za-z.])1700\d{9}(?![0-9A-Za-z.])/g },
  { name: "fixture_calendar_date", pattern: /\b202[34](?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月]))/g },
  { name: "windows_filesystem_path", pattern: /[A-Za-z]:(?:\\\\|[\\/])(?![\\/])[^\s"']+/g },
  { name: "unix_filesystem_path", pattern: /\/(?:tmp|home|Users)\/[^\s"']+/g },
  { name: "archive_or_database_path", pattern: /[^\s"']+\.(?:parquet|duckdb|sqlite|db)(?:\b|$)/gi },
];

function auditBoundary(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const matches = [];
  for (const boundary of forbiddenBoundaries) {
    boundary.pattern.lastIndex = 0;
    const found = [...text.matchAll(boundary.pattern)].slice(0, 20);
    if (found.length > 0) {
      matches.push({
        boundary: boundary.name,
        values: found.map((item) => item[0]),
        contexts: found.map((item) => text.slice(Math.max(0, (item.index ?? 0) - 160), (item.index ?? 0) + item[0].length + 160)),
      });
    }
  }
  return {
    label,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    forbiddenMatches: matches,
    passed: matches.length === 0,
  };
}

function assertReplayNetwork(capture, frontendOrigin) {
  const forbiddenApi = /\/api\/v1\/(?:klines|market|trade[_-]?flow|liquidations?|order[_-]?book|full[_-]?order[_-]?book|symbols|exchanges|subscriptions|indicators|alerts|settings)/i;
  const badRequests = capture.requests.filter((item) => {
    if (!item.url) return false;
    const parsed = new URL(item.url);
    return parsed.origin !== frontendOrigin || forbiddenApi.test(parsed.pathname);
  });
  const badSockets = capture.webSockets.filter((url) => {
    if (!url) return false;
    const parsed = new URL(url);
    return parsed.host !== new URL(frontendOrigin).host || (/\/api\/v1\/stream\//.test(parsed.pathname) && !/\/api\/v1\/stream\/replay\//.test(parsed.pathname));
  });
  assert(badRequests.length === 0, "replay target emitted forbidden HTTP", badRequests);
  assert(badSockets.length === 0, "replay target emitted forbidden WebSocket", badSockets);
}

async function waitForDownload(directory, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json") && !name.endsWith(".crdownload"));
    if (files.length > 0) return path.join(directory, files[0]);
    await wait(100);
  }
  throw new Error("Timed out waiting for replay JSON export");
}

function actorDiagnostics(payload, sessionId) {
  return payload?.replay?.sessions?.[sessionId] || null;
}

async function waitForSubscriberCount(diagnosticsUrl, sessionId, maximum, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const payload = await readJson(diagnosticsUrl);
    last = actorDiagnostics(payload, sessionId);
    if (last && Number(last.subscribers) <= maximum) return { payload, actor: last };
    await wait(100);
  }
  throw new Error(`Replay subscriber count did not return to <=${maximum}: ${JSON.stringify(last)}`);
}

async function lifecycleCycle({ debugBase, diagnosticsUrl, frontendOrigin, sessionId, timeoutMs }) {
  const opened = Date.now();
  const page = await createTarget(debugBase);
  const capture = captureTarget(page.cdp);
  try {
    const url = `${frontendOrigin}/replay.html?session=${encodeURIComponent(sessionId)}`;
    await page.cdp.send("Page.navigate", { url });
    const before = await waitForReplayStatus(
      page.cdp,
      `(value) => value.connection === "connected" && (value.state === "PLAYING" || value.state === "PAUSED")`,
      timeoutMs,
      "lifecycle recovery snapshot",
    );
    assert(await evaluate(page.cdp, "window.opener === null"), "lifecycle replay target retained opener");
    const beforeMetrics = await browserMetrics(page.cdp);
    const diagnosticsDuring = await readJson(diagnosticsUrl);
    const subscriberCountDuring = Number(actorDiagnostics(diagnosticsDuring, sessionId)?.subscribers ?? 0);
    const targetCountDuring = (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length;
    await evaluate(page.cdp, "globalThis.__CANDLESCOPE_REPLAY_SOAK_OLD_DOCUMENT__ = true");
    await page.cdp.send("Page.reload", { ignoreCache: true });
    await waitForValue(
      page.cdp,
      "globalThis.__CANDLESCOPE_REPLAY_SOAK_OLD_DOCUMENT__ !== true",
      timeoutMs,
      "lifecycle reload document",
    );
    const after = await waitForReplayStatus(
      page.cdp,
      `(value) => value.connection === "connected" && value.sourceSequence >= ${before.sourceSequence}`,
      timeoutMs,
      "lifecycle reload convergence",
    );
    const afterMetrics = await browserMetrics(page.cdp);
    assert(capture.exceptions.length === 0, "lifecycle target raised runtime exception", capture.exceptions);
    return {
      elapsedMs: Date.now() - opened,
      before,
      after,
      beforeMetrics,
      afterMetrics,
      subscriberCountDuring,
      targetCountDuring,
      consoleErrors: capture.consoleErrors,
    };
  } finally {
    await page.cdp.send("Page.close").catch(() => undefined);
    page.cdp.close();
    await waitForSubscriberCount(diagnosticsUrl, sessionId, 1, timeoutMs);
  }
}

function writeJson(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; set CHROME_PATH or --chrome-path");
  const [backendPort, frontendPort, debugPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-replay-soak-"));
  const expectedTempPrefix = path.resolve(os.tmpdir()) + path.sep;
  assert(path.resolve(tempRoot).startsWith(expectedTempPrefix), "temporary soak root escaped the OS temp directory", tempRoot);
  const userDataDir = path.join(tempRoot, "chrome-profile");
  const downloadDir = path.join(tempRoot, "downloads");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(downloadDir);
  const python = fs.existsSync(path.join(backendRoot, ".venv", "Scripts", "python.exe"))
    ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
    : "python";
  const offlineOrigin = "http://127.0.0.1:9";
  const backend = spawn(python, ["-m", "scripts.replay_smoke_fixture", "--port", String(backendPort)], {
    cwd: backendRoot,
    env: {
      ...process.env,
      REPLAY_ENABLED: "1",
      KLINES_DB_PATH: path.join(tempRoot, "candlescope.db"),
      REPLAY_DB_PATH: path.join(tempRoot, "replay.db"),
      CANDLE_DATA_DIR: path.join(tempRoot, "data"),
      BINANCE_BASE_URL: offlineOrigin,
      BINANCE_WS_URL: "ws://127.0.0.1:9",
      BINANCE_FUTURES_BASE_URL: offlineOrigin,
      BINANCE_FUTURES_WS_URL: "ws://127.0.0.1:9",
      REQUEST_TIMEOUT: "1",
      MAX_RETRIES: "0",
      RAW_AGG_TRADE_ARCHIVE_ENABLED: "0",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const backendTail = processTail(backend);
  const vite = spawn(process.execPath, [path.join(frontendRoot, "node_modules", "vite", "bin", "vite.js")], {
    cwd: frontendRoot,
    env: {
      ...process.env,
      VITE_DEV_PORT: String(frontendPort),
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
      VITE_REPLAY_ENTRY_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const viteTail = processTail(vite);
  const chrome = spawn(chromePath, [
    ...(args.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1600,1000",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--enable-precise-memory-info",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const chromeTail = processTail(chrome);
  const connections = new Set();
  let result = null;
  try {
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    const debugBase = `http://127.0.0.1:${debugPort}`;
    const diagnosticsUrl = `${backendOrigin}/__replay_smoke__/diagnostics`;
    await waitForHttp(`${backendOrigin}/__replay_smoke__/fixture`, backend, args.timeoutMs);
    await waitForHttp(`${frontendOrigin}/`, vite, args.timeoutMs);
    await waitForHttp(`${debugBase}/json/version`, chrome, args.timeoutMs);
    const fixture = await readJson(`${backendOrigin}/__replay_smoke__/fixture`);

    const live = await createTarget(debugBase);
    connections.add(live.cdp);
    const liveCapture = captureTarget(live.cdp);
    await live.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("candlescope-user-prefs", JSON.stringify({ lastExchange: "binance", lastMarketType: "spot", lastSymbol: "BTCUSDT", lastInterval: "1m" })); } catch {}`,
    });
    await live.cdp.send("Page.navigate", { url: `${frontendOrigin}/` });
    await waitForValue(live.cdp, "document.querySelector('[data-replay-entry=\"enabled\"]') !== null", args.timeoutMs, "live replay entry");
    try {
      await waitForValue(
        live.cdp,
        `document.querySelectorAll("canvas").length > 0
          && [...document.body.innerText.matchAll(/([0-9]+)[ ]+bars/g)].some((match) => Number(match[1]) > 0)`,
        args.timeoutMs,
        "live chart fixture bars",
      );
    } catch (error) {
      const diagnostics = await evaluate(live.cdp, `({
        snapshotText: (document.body?.innerText || "").slice(-3000),
        canvases: document.querySelectorAll("canvas").length,
        url: location.href,
      })`).catch(() => null);
      throw new Error(`${error.message}\nLive diagnostics: ${JSON.stringify({
        diagnostics,
        apiResponses: liveCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
        consoleErrors: liveCapture.consoleErrors,
        exceptions: liveCapture.exceptions,
      })}`);
    }
    const liveBefore = await liveSnapshot(live.cdp);
    assert(liveBefore.bars > 0 && liveBefore.canvasCount > 0, "live page failed to become ready", liveBefore);

    const projectionPage = await createTarget(debugBase);
    connections.add(projectionPage.cdp);
    await projectionPage.cdp.send("Page.navigate", { url: `${frontendOrigin}/replay.html` });
    await waitForValue(projectionPage.cdp, "document.querySelector('[data-replay-action=\"create-session\"]') !== null", args.timeoutMs, "projection soak module host");
    console.error(`browser projection soak starting: ${args.projectionEvents} events`);
    const projectionSoak = await runProjectionSoak(projectionPage.cdp, args.projectionEvents);
    console.error(`browser projection soak complete: ${projectionSoak.eventsPerSecond.toFixed(2)} events/s`);
    await projectionPage.cdp.send("Page.close").catch(() => undefined);
    projectionPage.cdp.close();
    connections.delete(projectionPage.cdp);

    const replay = await createTarget(debugBase);
    connections.add(replay.cdp);
    const replayCapture = captureTarget(replay.cdp);
    await replay.cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    await replay.cdp.send("Page.navigate", { url: `${frontendOrigin}/replay.html` });
    await waitForValue(replay.cdp, `(() => { const button = document.querySelector('[data-replay-action="create-session"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "replay session dialog");
    await click(replay.cdp, '[data-replay-action="create-session"]');
    const initial = await waitForReplayStatus(replay.cdp, `(value) => value.connection === "connected" && value.state === "PAUSED" && value.bars > 0`, args.timeoutMs, "initial replay snapshot");
    const sessionId = new URL(await evaluate(replay.cdp, "location.href")).searchParams.get("session");
    assert(sessionId, "replay session URL is missing an opaque session id");
    assert(await evaluate(replay.cdp, "window.opener === null"), "primary replay target retained opener");
    const blindInitialDom = await evaluate(replay.cdp, "document.body.innerText");
    assert(!/\b20\d{2}(?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月]))/.test(String(blindInitialDom)), "blind replay DOM rendered a calendar date before reveal");

    const beforeSpeed = await replayStatus(replay.cdp);
    await evaluate(replay.cdp, `(() => { const select = document.querySelector('[data-replay-action="speed"]'); if (!(select instanceof HTMLSelectElement)) return false; select.value = "1"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await waitForReplayStatus(replay.cdp, `(value) => value.revision > ${beforeSpeed.revision}`, args.timeoutMs, "1x speed ack");
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="play"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "play command readiness",
    );
    await click(replay.cdp, '[data-replay-action="play"]');
    const playing = await waitForReplayStatus(replay.cdp, `(value) => value.state === "PLAYING"`, args.timeoutMs, "1x play ack");
    const targetBaseline = (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length;
    const initialMetrics = {
      replay: await browserMetrics(replay.cdp),
      live: await browserMetrics(live.cdp),
      targets: targetBaseline,
      backend: await readJson(diagnosticsUrl),
      status: playing,
    };
    const startedAtMs = Date.now();
    const plannedEndMs = startedAtMs + args.durationMs;
    const samples = [{ elapsedMs: 0, ...initialMetrics }];
    const cycles = [];
    const trainingCycles = [];
    let cycleIndex = 0;
    let nextSampleAt = startedAtMs + args.sampleMs;
    let lastProgressAt = 0;
    while (Date.now() < plannedEndMs || cycleIndex < args.cycles) {
      const now = Date.now();
      const cycleDueAt = startedAtMs + Math.floor((args.durationMs * cycleIndex) / args.cycles);
      if (cycleIndex < args.cycles && now >= cycleDueAt) {
        const training = await trainingActionCycle({
          cdp: replay.cdp,
          backendOrigin,
          sessionId,
          diagnosticGapSteps: args.diagnosticGapSteps,
          index: cycleIndex,
          timeoutMs: args.timeoutMs,
        });
        trainingCycles.push({ index: cycleIndex + 1, elapsedFromStartMs: Date.now() - startedAtMs, ...training });
        const cycle = await lifecycleCycle({
          debugBase,
          diagnosticsUrl,
          frontendOrigin,
          sessionId,
          timeoutMs: args.timeoutMs,
        });
        cycles.push({ index: cycleIndex + 1, elapsedFromStartMs: Date.now() - startedAtMs, ...cycle });
        cycleIndex += 1;
        if (cycleIndex % 10 === 0 || cycleIndex === args.cycles) console.error(`replay lifecycle cycles: ${cycleIndex}/${args.cycles}`);
        continue;
      }
      if (now >= nextSampleAt || (now >= plannedEndMs && cycleIndex >= args.cycles)) {
        const status = await replayStatus(replay.cdp);
        assert(status?.connection === "connected", "primary replay connection left connected state", status);
        assert(status.state === "PLAYING", "primary replay stopped during soak", status);
        const sample = {
          elapsedMs: Date.now() - startedAtMs,
          replay: await browserMetrics(replay.cdp),
          live: await browserMetrics(live.cdp),
          targets: (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length,
          backend: await readJson(diagnosticsUrl),
          status,
        };
        samples.push(sample);
        nextSampleAt = Date.now() + args.sampleMs;
        if (now >= plannedEndMs && cycleIndex >= args.cycles) break;
      }
      if (now - lastProgressAt >= 60_000) {
        lastProgressAt = now;
        const status = await replayStatus(replay.cdp).catch(() => null);
        console.error(`replay browser soak: ${Math.floor((now - startedAtMs) / 60_000)}m/${Math.ceil(args.durationMs / 60_000)}m, cycles=${cycleIndex}/${args.cycles}, source=${status?.sourceSequence ?? "?"}`);
      }
      await wait(Math.min(1_000, Math.max(50, Math.min(nextSampleAt, cycleDueAt) - Date.now())));
    }
    const finalSoakStatus = await replayStatus(replay.cdp);
    const finalMetrics = {
      elapsedMs: Date.now() - startedAtMs,
      replay: await browserMetrics(replay.cdp),
      live: await browserMetrics(live.cdp),
      targets: (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length,
      backend: await readJson(diagnosticsUrl),
      status: finalSoakStatus,
    };
    samples.push(finalMetrics);

    if (finalSoakStatus.state === "PLAYING") {
      await click(replay.cdp, '[data-replay-action="pause"]');
      await waitForReplayStatus(replay.cdp, `(value) => value.state === "PAUSED"`, args.timeoutMs, "final soak pause");
    }
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="end"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "end command readiness",
    );
    await click(replay.cdp, '[data-replay-action="end"]');
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="confirm-end"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "end confirmation readiness",
    );
    await click(replay.cdp, '[data-replay-action="confirm-end"]');
    let ended;
    try {
      ended = await waitForReplayStatus(replay.cdp, `(value) => value.state === "ENDED"`, args.timeoutMs, "soak session end");
    } catch (error) {
      const diagnostics = await evaluate(replay.cdp, `({
        status: (() => { const node = document.querySelector("#replay-status-bar"); return node instanceof HTMLElement ? { text: node.innerText, data: { ...node.dataset } } : null; })(),
        commandError: document.querySelector(".replay-command-error")?.textContent || "",
        controllerBanner: document.querySelector(".replay-controller-banner")?.textContent || "",
        endDialog: document.querySelector(".replay-end-dialog")?.textContent || "",
        bodyTail: (document.body?.innerText || "").slice(-2000),
      })()`).catch(() => null);
      throw new Error(`${error.message}\nEnd diagnostics: ${JSON.stringify({
        diagnostics,
        apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/v1/replay")).slice(-20),
        frames: replayCapture.webSocketFramesReceived.slice(-10),
        consoleErrors: replayCapture.consoleErrors,
        exceptions: replayCapture.exceptions,
      })}`);
    }
    await waitForValue(replay.cdp, "document.querySelector('[data-replay-panel=\"report\"]') !== null", args.timeoutMs, "soak report panel");
    assert(ended.revealed === "false", "session end implicitly revealed actual history", ended);
    await waitForValue(
      replay.cdp,
      `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "导出 JSON"); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "replay JSON export readiness",
    );
    await clickButtonByText(replay.cdp, "导出 JSON");
    const exportPath = await waitForDownload(downloadDir, args.timeoutMs);
    const exportedText = fs.readFileSync(exportPath, "utf8");
    const exported = JSON.parse(exportedText);
    assert(exported.revealed === false && !Object.hasOwn(exported, "actual_history"), "unrevealed export included actual history", exported);
    await wait(300);
    await replayCapture.settle();

    const replayApiRequests = replayCapture.requests.filter((item) => /\/api\/v1\/replay(?:\/|\?|$)/.test(item.url));
    const boundaries = [
      auditBoundary("http", { requests: replayApiRequests, responses: replayCapture.responseBodies }),
      auditBoundary("websocket", { sent: replayCapture.webSocketFramesSent, received: replayCapture.webSocketFramesReceived }),
      auditBoundary("dom", await evaluate(replay.cdp, "({ text: document.body.innerText, html: document.body.innerHTML })")),
      auditBoundary("localStorage", await evaluate(replay.cdp, "Object.fromEntries(Object.entries(localStorage))")),
      auditBoundary("indexedDB", await dumpIndexedDb(replay.cdp)),
      auditBoundary("export", exportedText),
    ];
    const blindAuditPassed = boundaries.every((item) => item.passed);
    assert(blindAuditPassed, "blind boundary audit found forbidden actual history or paths", boundaries);
    assertReplayNetwork(replayCapture, frontendOrigin);
    assert(replayCapture.exceptions.length === 0, "primary replay target raised runtime exceptions", replayCapture.exceptions);
    assert(replayCapture.consoleErrors.length === 0, "primary replay target logged console errors", replayCapture.consoleErrors);
    const replayApiFailures = replayCapture.responses.filter((item) => /\/api\/v1\/replay(?:\/|\?|$)/.test(item.url) && item.status >= 400);
    assert(replayApiFailures.length === 0, "replay API returned failures during soak", replayApiFailures);

    const liveAfter = await liveSnapshot(live.cdp);
    assert(liveAfter.interval === liveBefore.interval, "replay soak changed live interval", { liveBefore, liveAfter });
    assert(liveAfter.prefs === liveBefore.prefs, "replay soak changed live persisted identity", { liveBefore, liveAfter });
    assert(liveAfter.canvasCount > 0 && liveAfter.bars >= liveBefore.bars, "live chart did not remain healthy", { liveBefore, liveAfter });
    assert(!liveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)), "live target opened replay WebSocket", liveCapture.webSockets);

    const halfSample = samples.reduce((best, sample) => (
      Math.abs(sample.elapsedMs - args.durationMs / 2) < Math.abs(best.elapsedMs - args.durationMs / 2) ? sample : best
    ), samples[0]);
    const primaryHeapGrowth = finalMetrics.replay.heap.usedSize - initialMetrics.replay.heap.usedSize;
    const lateHeapGrowth = finalMetrics.replay.heap.usedSize - halfSample.replay.heap.usedSize;
    const domGrowth = finalMetrics.replay.dom.elements - initialMetrics.replay.dom.elements;
    const sourceProgress = finalSoakStatus.sourceSequence - playing.sourceSequence;
    const maxTargets = Math.max(
      ...samples.map((sample) => sample.targets),
      ...cycles.map((cycle) => cycle.targetCountDuring),
    );
    const maxSubscribers = Math.max(
      ...samples.map((sample) => Number(actorDiagnostics(sample.backend, sessionId)?.subscribers ?? 0)),
      ...cycles.map((cycle) => cycle.subscriberCountDuring),
    );
    const finalActor = actorDiagnostics(finalMetrics.backend, sessionId);
    const minimumSourceProgress = Math.max(0, Math.floor(args.durationMs / 60_000) - 3);
    const checks = {
      duration_complete: finalMetrics.elapsedMs >= args.durationMs,
      lifecycle_cycles_complete: cycles.length === args.cycles,
      training_action_cycles_complete: trainingCycles.length === args.cycles,
      training_orders_and_fills_complete: trainingCycles.every((cycle) => (
        cycle.ordered.orderCount > cycle.before.orderCount
        && cycle.filled.fillCount > cycle.before.fillCount
      )),
      training_reconnects_complete: trainingCycles.every((cycle) => (
        cycle.reconnected.connection === "connected"
        && cycle.resumed.state === "PLAYING"
      )),
      projection_events_complete: projectionSoak.events === args.projectionEvents,
      projection_series_bounded: projectionSoak.seriesBars <= 2,
      projection_retained_heap_bounded: projectionSoak.retainedHeapDeltaBytes <= 64 * MIB,
      primary_retained_heap_bounded: primaryHeapGrowth <= 64 * MIB,
      primary_late_heap_bounded: lateHeapGrowth <= 32 * MIB,
      primary_dom_bounded: domGrowth <= 250,
      source_progress_expected: sourceProgress >= minimumSourceProgress,
      target_count_bounded: maxTargets <= targetBaseline + 1,
      subscriber_count_bounded: maxSubscribers <= 2 && Number(finalActor?.subscribers ?? 99) <= 1,
      blind_boundaries_clean: blindAuditPassed,
      replay_runtime_clean: replayCapture.exceptions.length === 0 && replayCapture.consoleErrors.length === 0,
      lifecycle_runtime_clean: cycles.every((cycle) => cycle.consoleErrors.length === 0),
      live_runtime_isolated: !liveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)),
    };
    result = {
      schema_version: "replay-v1-browser-soak.v1",
      recorded_at: "2026-07-18",
      mode: args.allowShort ? "harness-validation" : "release-4h",
      config: {
        durationMs: args.durationMs,
        cycles: args.cycles,
        diagnosticGapSteps: args.diagnosticGapSteps,
        sampleMs: args.sampleMs,
        projectionEvents: args.projectionEvents,
        chrome: path.basename(chromePath),
        fixtureRows: fixture.fixture_rows,
        fixtureIdentityHash: sha256(JSON.stringify(fixture)),
      },
      projectionSoak,
      replay: {
        initial,
        playing,
        finalSoakStatus,
        ended,
        sourceProgress,
        minimumSourceProgress,
        primaryHeapGrowthBytes: primaryHeapGrowth,
        lateHeapGrowthBytes: lateHeapGrowth,
        domGrowth,
        targetBaseline,
        maxTargets,
        maxSubscribers,
        requestCount: replayCapture.requestCount,
        responseCount: replayCapture.responseCount,
        webSocketCount: replayCapture.webSocketCount,
        webSocketFramesReceived: replayCapture.webSocketFramesReceived.length,
        exportSha256: sha256(exportedText),
        reportHash: exported.integrity?.report_hash ?? null,
      },
      live: { before: liveBefore, after: liveAfter, webSockets: [...new Set(liveCapture.webSockets)] },
      lifecycle: {
        completed: cycles.length,
        maxReloadHeapDeltaBytes: Math.max(...cycles.map((cycle) => cycle.afterMetrics.heap.usedSize - cycle.beforeMetrics.heap.usedSize)),
        cycles,
      },
      trainingActions: {
        completed: trainingCycles.length,
        ordersPlaced: trainingCycles.reduce((total, cycle) => total + cycle.ordered.orderCount - cycle.before.orderCount, 0),
        fillsObserved: trainingCycles.reduce((total, cycle) => total + cycle.filled.fillCount - cycle.before.fillCount, 0),
        reconnectsCompleted: trainingCycles.filter((cycle) => cycle.reconnected.connection === "connected").length,
        speedSequence: trainingCycles.map((cycle) => cycle.targetSpeed),
        cycles: trainingCycles,
      },
      samples,
      blindAudit: { passed: blindAuditPassed, boundaries },
      acceptance: {
        passed: Object.values(checks).every(Boolean),
        checks,
        thresholds: {
          projectionRetainedHeapBytes: 64 * MIB,
          primaryRetainedHeapBytes: 64 * MIB,
          primaryLateHeapBytes: 32 * MIB,
          primaryDomGrowth: 250,
          maxExtraTargets: 1,
          maxSubscribers: 2,
        },
      },
    };
    assert(result.acceptance.passed, "browser soak acceptance failed", result.acceptance);
    writeJson(args.out, result);
    fs.rmSync(`${args.out}.failed.json`, { force: true });
    console.log(JSON.stringify({
      passed: true,
      out: args.out,
      durationMs: finalMetrics.elapsedMs,
      cycles: cycles.length,
      trainingActionCycles: trainingCycles.length,
      projectionEvents: projectionSoak.events,
      projectionEventsPerSecond: projectionSoak.eventsPerSecond,
      primaryHeapGrowthBytes: primaryHeapGrowth,
      lateHeapGrowthBytes: lateHeapGrowth,
      blindAuditPassed,
      reportHash: result.replay.reportHash,
    }, null, 2));
  } catch (error) {
    const failure = {
      schema_version: "replay-v1-browser-soak-failure.v1",
      recorded_at: "2026-07-18",
      passed: false,
      error: error.stack || error.message || String(error),
      backendTail: backendTail(),
      viteTail: viteTail(),
      chromeTail: chromeTail(),
    };
    writeJson(`${args.out}.failed.json`, failure);
    throw error;
  } finally {
    for (const connection of connections) connection.close();
    await stopBackendGracefully(backend, `http://127.0.0.1:${backendPort}`);
    await Promise.all([stopProcessTree(chrome), stopProcessTree(vite), stopProcessTree(backend)]);
    await wait(300);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  return result;
}

export { auditBoundary };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
