import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildDrawingFixture,
  DEFAULT_FIXTURE_OPTIONS,
} from "./drawing-performance-fixtures.mjs";
import {
  buildDrawingPerformanceReport,
  DRAWING_PERFORMANCE_HARD_GATES,
  evaluateGates,
  stableStringify,
} from "./drawing-performance-metrics.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DEFAULT_MOCK_END_TIME = 1_783_987_200;
const PHASE0_MIN_MEASURED_RUNS = 5;
const PHASE0_MIN_WARMUP_RUNS = 1;
const PHASE0_POINTER_SAMPLES = 4_096;
const PHASE0_REQUIRED_SCENARIO_IDS = Object.freeze([
  "empty-viewport",
  "single-freehand-4096-viewport",
  "freehand-64x512-viewport",
  "entities-200-mixed",
  "entities-512-mixed",
  "active-freehand-4096",
]);
const DEFAULT_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "empty-viewport",
    fixture: "empty",
    action: "viewport",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs"],
    targetCounters: [],
  }),
  Object.freeze({
    id: "single-freehand-4096-viewport",
    fixture: "singleFreehand4096",
    action: "viewport",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
    ],
    targetCounters: ["surfacePrimitiveCount", "requestUpdatePerFrame", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "freehand-64x512-viewport",
    fixture: "freehand64x512",
    action: "viewport",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
    ],
    targetCounters: [
      "staticProjectionCount",
      "surfacePrimitiveCount",
      "requestUpdatePerFrame",
      "workerQueueDepth",
    ],
  }),
  Object.freeze({
    id: "entities-200-mixed",
    fixture: "entities200",
    action: "mixed",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs", "hitQueryMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs", "hitQueryMs"],
    targetCounters: ["surfacePrimitiveCount", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "entities-512-mixed",
    fixture: "entities512",
    action: "mixed",
    requiredMetrics: ["frameIntervalMs", "inputToNextPaintMs", "eventTimingMs", "hitQueryMs"],
    targetMetrics: ["frameIntervalMs", "inputToNextPaintMs", "hitQueryMs"],
    targetCounters: ["surfacePrimitiveCount", "workerQueueDepth"],
  }),
  Object.freeze({
    id: "active-freehand-4096",
    // Leave room below MAX_SAVED_DRAWINGS (512) for the stroke finalized by
    // this scenario; the separate entities-512 scenario covers the hard cap.
    fixture: "entities200",
    action: "active-freehand",
    requiredMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "eventTimingMs",
      "mouseupSyncMs",
      "persistenceMs",
      "activeOverlayCpuMs",
    ],
    targetMetrics: [
      "drawingMainThreadMs",
      "sceneProjectPaintMs",
      "frameIntervalMs",
      "inputToNextPaintMs",
      "mouseupSyncMs",
      "workerFinalizeMs",
      "persistenceMs",
      "exactRenderMs",
      "activeOverlayCpuMs",
    ],
    targetCounters: [
      "surfacePrimitiveCount",
      "requestUpdatePerFrame",
      "workerQueueDepth",
    ],
  }),
]);

function parseNumber(value, label, { min = 0, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(label + " must be " + (integer ? "an integer" : "a number") + " >= " + min);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    compareBefore: "",
    chromePath: process.env.CHROME_PATH || "",
    bars: 1_500,
    dpr: 1,
    runs: 5,
    warmupRuns: 1,
    seed: DEFAULT_FIXTURE_OPTIONS.seed,
    mockEndTime: DEFAULT_MOCK_END_TIME,
    intervalSeconds: 3_600,
    wheelEvents: 60,
    hoverEvents: 240,
    pointerSamples: 4_096,
    settleMs: 750,
    timeoutMs: 45_000,
    headless: false,
    smoke: false,
    phase: "phase0",
    enforceTargets: false,
    scenarios: DEFAULT_SCENARIOS.map((scenario) => scenario.id),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = String(argv[++index] || "");
    else if (arg === "--out") args.out = String(argv[++index] || "");
    else if (arg === "--compare-before") args.compareBefore = String(argv[++index] || "");
    else if (arg === "--chrome") args.chromePath = String(argv[++index] || "");
    else if (arg === "--bars") args.bars = parseNumber(argv[++index], "--bars", { min: 2, integer: true });
    else if (arg === "--dpr") args.dpr = parseNumber(argv[++index], "--dpr", { min: 0.5 });
    else if (arg === "--runs") args.runs = parseNumber(argv[++index], "--runs", { min: 1, integer: true });
    else if (arg === "--warmup-runs") {
      args.warmupRuns = parseNumber(argv[++index], "--warmup-runs", { min: 0, integer: true });
    } else if (arg === "--seed") {
      args.seed = parseNumber(argv[++index], "--seed", { min: 0, integer: true });
    } else if (arg === "--mock-end-time") {
      args.mockEndTime = parseNumber(argv[++index], "--mock-end-time", { min: 1, integer: true });
    } else if (arg === "--interval-seconds") {
      args.intervalSeconds = parseNumber(argv[++index], "--interval-seconds", { min: 1, integer: true });
    } else if (arg === "--wheel-events") {
      args.wheelEvents = parseNumber(argv[++index], "--wheel-events", { min: 1, integer: true });
    } else if (arg === "--hover-events") {
      args.hoverEvents = parseNumber(argv[++index], "--hover-events", { min: 1, integer: true });
    } else if (arg === "--pointer-samples") {
      args.pointerSamples = parseNumber(argv[++index], "--pointer-samples", { min: 2, integer: true });
    } else if (arg === "--settle-ms") {
      args.settleMs = parseNumber(argv[++index], "--settle-ms", { min: 0, integer: true });
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parseNumber(argv[++index], "--timeout-ms", { min: 1_000, integer: true });
    } else if (arg === "--scenarios") {
      args.scenarios = String(argv[++index] || "").split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--phase") {
      const phase = String(argv[++index] || "");
      if (phase !== "phase0" && phase !== "phase1") {
        throw new Error("--phase must be phase0 or phase1");
      }
      args.phase = phase;
    } else if (arg === "--headless") args.headless = true;
    else if (arg === "--smoke") args.smoke = true;
    else if (arg === "--enforce-targets") args.enforceTargets = true;
    else throw new Error("Unknown argument: " + arg);
  }

  const knownScenarioIds = new Set(DEFAULT_SCENARIOS.map((scenario) => scenario.id));
  for (const scenarioId of args.scenarios) {
    if (!knownScenarioIds.has(scenarioId)) {
      throw new Error("Unknown scenario " + scenarioId + ". Known scenarios: "
        + Array.from(knownScenarioIds).join(", "));
    }
  }
  if (args.scenarios.length === 0) throw new Error("At least one scenario is required");
  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error("HTTP " + response.statusCode + " for " + url));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await httpJson(url);
    } catch (error) {
      lastError = error;
      await wait(200);
    }
  }
  throw lastError || new Error("Timed out waiting for " + url);
}

function captureProcessOutput(child) {
  const lines = [];
  const capture = (chunk) => {
    const text = String(chunk || "").trim();
    if (!text) return;
    lines.push(...text.split(/\r?\n/));
    if (lines.length > 80) lines.splice(0, lines.length - 80);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return lines;
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(timeoutMs),
  ]);
}

async function removeDirectoryWithRetries(directory, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        console.warn("Could not remove temporary Chrome profile: " + error.message);
        return;
      }
      await wait(200 * (attempt + 1));
    }
  }
}

function findChrome(explicitPath) {
  const candidates = [
    explicitPath,
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
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitForDebugTarget(port, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await httpJson("http://127.0.0.1:" + port + "/json");
      if (Array.isArray(targets) && targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await wait(200);
  }
  throw lastError || new Error("Timed out waiting for Chrome debug target");
}

async function connectWebSocket(wsUrl) {
  if (!globalThis.WebSocket) {
    throw new Error("This Node.js runtime does not expose global WebSocket");
  }
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error: " + (event.message || "unknown")));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else deferred.resolve(message);
      return;
    }
    if (!message.method) return;
    for (const handler of handlers.get(message.method) || []) handler(message.params);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = response.result?.result;
  if (result?.subtype === "error") {
    throw new Error(result.description || result.value || "Runtime.evaluate failed");
  }
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text || "Runtime.evaluate exception");
  }
  return result?.value;
}

async function evaluateJson(cdp, functionSource) {
  const value = await evaluate(cdp, "JSON.stringify((" + functionSource + ")())");
  return typeof value === "string" ? JSON.parse(value) : null;
}

function metricMap(response) {
  return Object.fromEntries((response?.result?.metrics || []).map((metric) => [metric.name, metric.value]));
}

function metricDelta(before, after, name) {
  const left = Number(before?.[name]);
  const right = Number(after?.[name]);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, right - left) : null;
}

function ensureProductionBuild() {
  const viteBin = path.join(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: FRONTEND_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
}

async function startManagedServers(args) {
  if (!fs.existsSync(path.join(FRONTEND_ROOT, "dist", "index.html"))) {
    throw new Error("Production build missing. Run npm run build before perf:drawing.");
  }
  const apiPort = await freePort();
  const previewPort = await freePort();
  const api = spawn(process.execPath, [path.join(FRONTEND_ROOT, "scripts", "mock-api.mjs")], {
    cwd: FRONTEND_ROOT,
    env: {
      ...process.env,
      PORT: String(apiPort),
      CANDLESCOPE_MOCK_BAR_COUNT: String(args.bars),
      CANDLESCOPE_MOCK_INTERVAL_SECONDS: String(args.intervalSeconds),
      CANDLESCOPE_MOCK_END_TIME: String(args.mockEndTime),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const apiLogs = captureProcessOutput(api);
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
      ...process.env,
      VITE_API_PROXY_TARGET: "http://127.0.0.1:" + apiPort,
      VITE_DEV_PORT: String(previewPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const previewLogs = captureProcessOutput(preview);

  try {
    const mockMeta = await waitForHttp("http://127.0.0.1:" + apiPort + "/__mock__/meta");
    await waitForHttp("http://127.0.0.1:" + previewPort + "/api/v1/exchanges/");
    return {
      url: "http://127.0.0.1:" + previewPort + "/",
      mockMeta,
      async close() {
        await stopProcess(preview);
        await stopProcess(api);
      },
    };
  } catch (error) {
    await stopProcess(preview);
    await stopProcess(api);
    throw new Error(error.message + "\nMock API:\n" + apiLogs.join("\n")
      + "\nVite preview:\n" + previewLogs.join("\n"));
  }
}

function browserBenchmarkBootstrap(payload) {
  window.__CANDLESCOPE_DRAWING_PERF_CONFIG__ = Object.freeze({
    benchmarkRawCapture: true,
    rawCaptureCapacity: 20_000,
  });
  try {
    localStorage.setItem(payload.storageKey, payload.raw);
    localStorage.setItem("candlescope-active-indicators", "[]");
    localStorage.setItem("candlescope-vol-initialized", "1");
  } catch {
    // about:blank and restricted frames may not expose localStorage. The same
    // bootstrap runs again in the application origin before its modules load.
  }

  const makeState = () => ({
    startedAt: performance.now(),
    lastRafAt: null,
    rafIntervalsMs: [],
    inputToNextPaintMs: [],
    eventTimingMs: [],
    mouseupSyncMs: [],
    longTasks: [],
    inputEvents: 0,
    pendingPaintAt: null,
    captureStats: {
      rafIntervalsMs: { observed: 0, dropped: 0 },
      inputToNextPaintMs: { observed: 0, dropped: 0 },
      eventTimingMs: { observed: 0, dropped: 0 },
      mouseupSyncMs: { observed: 0, dropped: 0 },
    },
  });
  let state = makeState();
  let eventTimingSupported = false;
  let longTaskSupported = false;

  const boundedPush = (target, metric, value, capacity = 20_000) => {
    if (!Number.isFinite(value) || value < 0) return;
    state.captureStats[metric].observed += 1;
    target.push(value);
    if (target.length > capacity) {
      const dropped = target.length - capacity;
      target.splice(0, dropped);
      state.captureStats[metric].dropped += dropped;
    }
  };

  const rafLoop = (at) => {
    if (state.lastRafAt !== null) {
      boundedPush(state.rafIntervalsMs, "rafIntervalsMs", at - state.lastRafAt);
    }
    state.lastRafAt = at;
    if (state.pendingPaintAt !== null) {
      boundedPush(
        state.inputToNextPaintMs,
        "inputToNextPaintMs",
        Math.max(0, at - state.pendingPaintAt),
      );
      state.pendingPaintAt = null;
    }
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  const onInput = () => {
    state.inputEvents += 1;
    if (state.pendingPaintAt === null) state.pendingPaintAt = performance.now();
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    addEventListener(type, onInput, { capture: true, passive: true });
  }
  addEventListener("pointerup", () => {
    const startedAt = performance.now();
    queueMicrotask(() => boundedPush(
      state.mouseupSyncMs,
      "mouseupSyncMs",
      performance.now() - startedAt,
    ));
  }, { capture: true, passive: true });

  try {
    const eventObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "wheel"]
          .includes(entry.name)) {
          boundedPush(state.eventTimingMs, "eventTimingMs", entry.duration);
        }
      }
    });
    eventObserver.observe({ type: "event", buffered: false, durationThreshold: 0 });
    eventTimingSupported = true;
  } catch {
    // Event Timing is not available in every Chromium build.
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          attribution: Array.from(entry.attribution || [], (item) => ({
            name: item.name || null,
            containerType: item.containerType || null,
            containerName: item.containerName || null,
            containerId: item.containerId || null,
            containerSrc: item.containerSrc || null,
          })),
        });
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: false });
    longTaskSupported = true;
  } catch {
    // Long Tasks may be disabled in some embedded/headless environments.
  }

  window.__CANDLESCOPE_DRAWING_BENCH__ = Object.freeze({
    reset() {
      state = makeState();
    },
    report() {
      return {
        startedAt: state.startedAt,
        endedAt: performance.now(),
        rafIntervalsMs: state.rafIntervalsMs.slice(),
        inputToNextPaintMs: state.inputToNextPaintMs.slice(),
        eventTimingMs: state.eventTimingMs.slice(),
        mouseupSyncMs: state.mouseupSyncMs.slice(),
        longTasks: state.longTasks.slice(),
        inputEvents: state.inputEvents,
        eventTimingSupported,
        longTaskSupported,
        captureStats: structuredClone(state.captureStats),
        devicePixelRatio,
        viewport: {
          width: innerWidth,
          height: innerHeight,
        },
      };
    },
  });
}

async function installScenarioBootstrap(cdp, fixture) {
  const source = "(" + browserBenchmarkBootstrap.toString() + ")("
    + JSON.stringify({ storageKey: fixture.storageKey, raw: fixture.raw }) + ");";
  const response = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return response.result?.identifier || null;
}

async function waitForChartReady(cdp, expectedDrawingCount, timeoutMs) {
  const started = Date.now();
  let latest = null;
  let lastEvaluationError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await evaluateJson(cdp, () => {
        const report = window.__CANDLESCOPE_PERF__?.report?.() || null;
        const events = Array.isArray(report?.events) ? report.events : [];
        let commit = null;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]?.name === "chart.data.commit") {
            commit = events[index]?.detail || null;
            break;
          }
        }
        const chart = document.querySelector(
          ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
          + ".chart-pane[data-pane-id=\"single-chart\"]",
        );
        const drawingReady = Boolean(document.querySelector("[data-drawing-engine=\"ready\"]"));
        const drawingHandle = window.__CANDLESCOPE_DRAWING_PERF__;
        const runtimeSummary = drawingHandle?.readRuntimeSummary?.() || null;
        return {
          chartReady: Boolean(report?.marks?.["chart.ready"]),
          chartPresent: Boolean(chart),
          drawingReady,
          drawingHandlePresent: Boolean(drawingHandle),
          loadedDrawingCount: Number.isSafeInteger(runtimeSummary?.entityCount)
            ? runtimeSummary.entityCount
            : null,
          runtimeSummary,
          commit,
          readyState: document.readyState,
        };
      });
      lastEvaluationError = null;
    } catch (error) {
      lastEvaluationError = error;
      latest = null;
    }
    const normalizedRuntimeSummary = latest?.runtimeSummary || (expectedDrawingCount === 0
      ? { entityCount: 0, pointCount: 0, typeCounts: {} }
      : null);
    const normalizedLoadedDrawingCount = normalizedRuntimeSummary?.entityCount ?? null;
    const drawingEngineSatisfied = expectedDrawingCount === 0 || latest?.drawingReady;
    const drawingSatisfied = drawingEngineSatisfied
      && latest?.drawingHandlePresent
      && normalizedLoadedDrawingCount === expectedDrawingCount;
    if (latest?.chartReady && latest?.chartPresent && drawingSatisfied) {
      return {
        ...latest,
        loadedDrawingCount: normalizedLoadedDrawingCount,
        runtimeSummary: normalizedRuntimeSummary,
        waitedMs: Date.now() - started,
      };
    }
    await wait(100);
  }
  throw new Error("Timed out waiting for chart/drawing engine: " + JSON.stringify({
    expectedDrawingCount,
    latest,
    lastEvaluationError: lastEvaluationError?.message || null,
  }));
}

async function getChartRect(cdp) {
  return evaluateJson(cdp, () => {
    const element = document.querySelector(
      ".chart-pane[data-pane-id=\"main\"] .chart-pane-container, "
      + ".chart-pane[data-pane-id=\"single-chart\"]",
    );
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function clickTool(cdp, tool) {
  const expression = "(() => {"
    + "const el=document.querySelector('[data-drawing-tool=" + JSON.stringify(tool) + "]');"
    + "if(!el||el.disabled)return false;el.click();return true;"
    + "})()";
  return Boolean(await evaluate(cdp, expression));
}

async function waitNextAnimationFrame(cdp) {
  await evaluate(cdp, "new Promise((resolve)=>requestAnimationFrame(()=>resolve(true)))");
}

async function dispatchMouseMove(cdp, x, y, buttons = 0) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: buttons ? "left" : "none",
    buttons,
  });
}

async function runWheel(cdp, rect, count) {
  const x = Math.round(rect.x + rect.width * 0.56);
  const y = Math.round(rect.y + rect.height * 0.52);
  for (let index = 0; index < count; index += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: index % 2 === 0 ? -92 : 92,
    });
    await wait(24);
  }
  return count;
}

async function runPan(cdp, rect) {
  await clickTool(cdp, "cursor");
  const fromX = Math.round(rect.x + rect.width * 0.72);
  const toX = Math.round(rect.x + rect.width * 0.30);
  const y = Math.round(rect.y + rect.height * 0.62);
  await dispatchMouseMove(cdp, fromX, y);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const steps = 36;
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(fromX + (toX - fromX) * (step / steps));
    await dispatchMouseMove(cdp, x, y, 1);
    await wait(12);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return steps;
}

async function runHover(cdp, rect, count) {
  await clickTool(cdp, "eraser");
  const left = rect.x + rect.width * 0.08;
  const top = rect.y + rect.height * 0.12;
  const width = rect.width * 0.84;
  const height = rect.height * 0.72;
  for (let index = 0; index < count; index += 1) {
    const progress = index / Math.max(1, count - 1);
    const x = Math.round(left + width * progress);
    const y = Math.round(top + height * (0.5 + Math.sin(index * 0.19) * 0.32));
    await dispatchMouseMove(cdp, x, y);
    if (index % 4 === 3) await waitNextAnimationFrame(cdp);
  }
  return count;
}

async function runActiveFreehand(cdp, rect, count) {
  const activated = await clickTool(cdp, "pen");
  if (!activated) throw new Error("Pen tool is not available");
  await wait(100);
  const left = rect.x + rect.width * 0.08;
  const top = rect.y + rect.height * 0.18;
  const width = Math.max(120, rect.width * 0.82);
  const height = Math.max(80, rect.height * 0.60);
  const startX = Math.round(left);
  const startY = Math.round(top + height * 0.50);
  await dispatchMouseMove(cdp, startX, startY);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX,
    y: startY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

  const batchSize = 32;
  for (let offset = 0; offset < count; offset += batchSize) {
    const pending = [];
    const end = Math.min(count, offset + batchSize);
    for (let index = offset; index < end; index += 1) {
      const x = Math.round(left + ((index * 3.25) % width));
      const y = Math.round(top + height * (0.50
        + Math.sin(index * 0.071) * 0.28
        + Math.cos(index * 0.017) * 0.12));
      pending.push(cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
      }));
    }
    await Promise.all(pending);
    await waitNextAnimationFrame(cdp);
  }
  const endX = Math.round(left + (((count - 1) * 3.25) % width));
  const endY = Math.round(top + height * (0.50 + Math.sin((count - 1) * 0.071) * 0.28));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return count;
}

async function runScenarioAction(cdp, scenario, args, rect) {
  const result = {
    action: scenario.action,
    wheelEventsDispatched: 0,
    hoverEventsDispatched: 0,
    panEventsDispatched: 0,
    pointerSamplesDispatched: 0,
  };
  if (scenario.action === "viewport" || scenario.action === "mixed") {
    result.wheelEventsDispatched = await runWheel(cdp, rect, args.wheelEvents);
    result.panEventsDispatched = await runPan(cdp, rect);
  }
  if (scenario.action === "mixed") {
    result.hoverEventsDispatched = await runHover(cdp, rect, args.hoverEvents);
  }
  if (scenario.action === "active-freehand") {
    result.pointerSamplesDispatched = await runActiveFreehand(cdp, rect, args.pointerSamples);
  }
  return result;
}

function durationSamples(snapshot, key) {
  const samples = snapshot?.durations?.[key]?.samples;
  return Array.isArray(samples) ? samples.filter(Number.isFinite) : [];
}

function durationCapture(rawCapture, snapshot, key) {
  const captured = rawCapture?.enabled ? rawCapture?.metrics?.[key] : null;
  if (captured && Array.isArray(captured.samples)) {
    const samples = captured.samples.filter(Number.isFinite);
    const observed = Number(captured.observedCount);
    const dropped = Number(captured.droppedCount);
    return {
      samples,
      completeness: {
        complete: Number.isFinite(observed)
          && Number.isFinite(dropped)
          && dropped === 0
          && samples.length === observed,
        observed,
        retained: samples.length,
        dropped,
        source: "drawing-perf-raw-capture",
      },
    };
  }
  const histogram = snapshot?.durations?.[key];
  const samples = durationSamples(snapshot, key);
  const observed = Number(histogram?.totalCount);
  return {
    samples,
    completeness: {
      complete: Number.isFinite(observed) && samples.length === observed,
      observed,
      retained: samples.length,
      dropped: Number.isFinite(observed) ? Math.max(0, observed - samples.length) : null,
      source: "rolling-histogram-fallback",
    },
  };
}

function browserCapture(bench, key) {
  const samples = Array.isArray(bench?.[key]) ? bench[key].filter(Number.isFinite) : [];
  const stats = bench?.captureStats?.[key];
  const observed = Number(stats?.observed);
  const dropped = Number(stats?.dropped);
  return {
    samples,
    completeness: {
      complete: Number.isFinite(observed)
        && Number.isFinite(dropped)
        && dropped === 0
        && samples.length === observed,
      observed,
      retained: samples.length,
      dropped,
      source: "browser-observer",
    },
  };
}

function maxCounter(snapshot, key) {
  const maximum = Number(snapshot?.counterMaxima?.[key]);
  const current = Number(snapshot?.counters?.[key]);
  if (Number.isFinite(maximum)) return maximum;
  return Number.isFinite(current) ? current : null;
}

function maxGauge(snapshot, key) {
  const maximum = Number(snapshot?.gaugeMaxima?.[key]);
  const current = Number(snapshot?.gauges?.[key]);
  if (Number.isFinite(maximum)) return maximum;
  return Number.isFinite(current) ? current : null;
}

async function readSavedDrawingCount(cdp, storageKey) {
  const expression = "(() => {try {const raw=localStorage.getItem("
    + JSON.stringify(storageKey) + ");const value=raw?JSON.parse(raw):[];"
    + "return Array.isArray(value)?value.length:-1;}catch{return -1;}})()";
  return Number(await evaluate(cdp, expression));
}

async function readSavedDrawingSummary(cdp, storageKey) {
  const expression = "(() => {try {const raw=localStorage.getItem("
    + JSON.stringify(storageKey) + ");const drawings=raw?JSON.parse(raw):[];"
    + "if(!Array.isArray(drawings))return null;let pointCount=0;const typeCounts={};"
    + "for(const drawing of drawings){if(!drawing||typeof drawing!=='object')continue;"
    + "const type=typeof drawing.type==='string'?drawing.type:'unknown';"
    + "typeCounts[type]=(typeCounts[type]||0)+1;"
    + "if(Array.isArray(drawing.stroke?.points))pointCount+=drawing.stroke.points.length;"
    + "else if(Array.isArray(drawing.dataPoints))pointCount+=drawing.dataPoints.length;"
    + "else if(drawing.dataPoint)pointCount+=1;}"
    + "return JSON.stringify({entityCount:drawings.length,pointCount,typeCounts});"
    + "}catch{return null;}})()";
  const value = await evaluate(cdp, expression);
  return typeof value === "string" ? JSON.parse(value) : null;
}

function sameTypeCounts(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function runtimeMatchesSavedSummary(runtimeSummary, savedSummary) {
  return Boolean(runtimeSummary && savedSummary
    && runtimeSummary.entityCount === savedSummary.entityCount
    && runtimeSummary.pointCount === savedSummary.pointCount
    && sameTypeCounts(runtimeSummary.typeCounts, savedSummary.typeCounts));
}

async function waitForSavedDrawingCount(cdp, storageKey, expectedCount, timeoutMs) {
  const started = Date.now();
  let count = -1;
  let lastError = null;
  do {
    try {
      count = await readSavedDrawingCount(cdp, storageKey);
      lastError = null;
      if (count === expectedCount) {
        return {
          expectedCount,
          count,
          matched: true,
          waitedMs: Date.now() - started,
          error: null,
        };
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  } while (Date.now() - started < timeoutMs);

  return {
    expectedCount,
    count,
    matched: false,
    waitedMs: Date.now() - started,
    error: lastError?.message || null,
  };
}

function expectedDrawingCountAfterAction(scenario, fixture) {
  return fixture.metadata.drawingCount + (scenario.action === "active-freehand" ? 1 : 0);
}

function createReloadRestoreResult(expectedCount, persisted, persistedSummary = null) {
  const reloadedCount = persisted.count >= 0 ? persisted.count : expectedCount;
  return {
    attempted: false,
    fixtureBootstrapRemovedBeforeReload: false,
    fixtureWriteBlockedOnReload: false,
    expectedSavedDrawingCount: expectedCount,
    savedDrawingCountBeforeReload: persisted.count,
    persistenceMatchedBeforeReload: persisted.matched,
    persistenceWaitedMs: persisted.waitedMs,
    savedSummaryBeforeReload: persistedSummary,
    reloadExpectedDrawingCount: reloadedCount,
    savedDrawingCountAfterReload: null,
    loadedDrawingCountAfterReload: null,
    runtimeSummaryAfterReload: null,
    runtimeSummaryMatchesSaved: false,
    chartReadyAfterReload: false,
    drawingEngineReadyAfterReload: false,
    drawingEngineExpectedAfterReload: expectedCount > 0,
    drawingEngineRequirementSatisfiedAfterReload: false,
    drawingPerfHandleReadyAfterReload: false,
    reloadWaitedMs: null,
    durationMs: null,
    passed: false,
    error: null,
  };
}

async function verifyReloadRestore(
  cdp,
  fixture,
  expectedCount,
  persisted,
  persistedSummary,
  args,
) {
  const started = Date.now();
  const result = createReloadRestoreResult(expectedCount, persisted, persistedSummary);
  result.fixtureBootstrapRemovedBeforeReload = true;
  result.fixtureWriteBlockedOnReload = true;

  try {
    result.attempted = true;
    await cdp.send("Page.reload", { ignoreCache: true });
    const ready = await waitForChartReady(cdp, result.reloadExpectedDrawingCount, args.timeoutMs);
    const savedDrawingCountAfterReload = await readSavedDrawingCount(cdp, fixture.storageKey);
    result.savedDrawingCountAfterReload = savedDrawingCountAfterReload;
    result.loadedDrawingCountAfterReload = ready.loadedDrawingCount;
    result.runtimeSummaryAfterReload = ready.runtimeSummary;
    result.runtimeSummaryMatchesSaved = runtimeMatchesSavedSummary(
      ready.runtimeSummary,
      persistedSummary,
    );
    result.chartReadyAfterReload = ready.chartReady && ready.chartPresent;
    result.drawingEngineReadyAfterReload = ready.drawingReady;
    result.drawingEngineRequirementSatisfiedAfterReload = expectedCount === 0
      || ready.drawingReady;
    result.drawingPerfHandleReadyAfterReload = ready.drawingHandlePresent;
    result.reloadWaitedMs = ready.waitedMs;
    result.passed = result.persistenceMatchedBeforeReload
      && savedDrawingCountAfterReload === expectedCount
      && ready.loadedDrawingCount === expectedCount
      && result.runtimeSummaryMatchesSaved
      && result.chartReadyAfterReload
      && result.drawingEngineRequirementSatisfiedAfterReload
      && result.drawingPerfHandleReadyAfterReload;
    if (!result.passed) {
      result.error = "Reload completed but persisted and restored drawing evidence did not match";
    }
  } catch (error) {
    result.error = error.message;
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function readDrawingSnapshots(cdp) {
  return evaluateJson(cdp, () => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const flushed = handle?.flush?.("benchmark-end") || null;
    const snapshot = handle?.report?.() || flushed?.snapshot || null;
    const rawCapture = handle?.drainRawCapture?.() || null;
    const runtimeSummary = handle?.readRuntimeSummary?.() || null;
    const bench = window.__CANDLESCOPE_DRAWING_BENCH__?.report?.() || null;
    const perf = window.__CANDLESCOPE_PERF__?.report?.() || null;
    return { snapshot, rawCapture, runtimeSummary, bench, perf };
  });
}

async function runOneScenario(cdp, scenario, fixture, args, iteration, warmup, diagnostics) {
  let bootstrapIdentifier = await installScenarioBootstrap(cdp, fixture);
  const runStartedAt = Date.now();
  const consoleStart = diagnostics.consoleErrors.length;
  const exceptionStart = diagnostics.runtimeExceptions.length;
  const networkStart = diagnostics.networkFailures.length;
  try {
    await cdp.send("Page.navigate", {
      url: args.url + (args.url.includes("?") ? "&" : "?")
        + "drawingPerf=" + encodeURIComponent(scenario.id + "-" + iteration),
    });
    const ready = await waitForChartReady(cdp, fixture.metadata.drawingCount, args.timeoutMs);
    const rect = await getChartRect(cdp);
    if (!rect || rect.width < 200 || rect.height < 120) {
      throw new Error("Chart rectangle is unavailable or too small");
    }
    const initialRestoredCount = await readSavedDrawingCount(cdp, fixture.storageKey);
    if (initialRestoredCount !== fixture.metadata.drawingCount) {
      throw new Error("Expected " + fixture.metadata.drawingCount
        + " restored drawings, observed " + initialRestoredCount);
    }
    const initialSavedSummary = await readSavedDrawingSummary(cdp, fixture.storageKey);
    const expectedFixtureSummary = {
      entityCount: fixture.metadata.drawingCount,
      pointCount: fixture.metadata.pointCount,
      typeCounts: fixture.metadata.drawingTypes,
    };
    if (!runtimeMatchesSavedSummary(ready.runtimeSummary, initialSavedSummary)
      || !runtimeMatchesSavedSummary(ready.runtimeSummary, expectedFixtureSummary)) {
      throw new Error("The application runtime did not restore the fixture entity/type/point summary");
    }

    await wait(100);
    await evaluate(cdp, "window.__CANDLESCOPE_DRAWING_BENCH__?.reset?.();"
      + "window.__CANDLESCOPE_DRAWING_PERF__?.reset?.();true");
    const beforeMetrics = metricMap(await cdp.send("Performance.getMetrics"));
    const beforeHeap = await cdp.send("Runtime.getHeapUsage");
    const actionStartedAt = Number(await evaluate(cdp, "performance.now()"));
    const action = await runScenarioAction(cdp, scenario, args, rect);
    const actionEndedAt = Number(await evaluate(cdp, "performance.now()"));
    await wait(args.settleMs);
    const measurementEndedAt = Number(await evaluate(cdp, "performance.now()"));
    const snapshots = await readDrawingSnapshots(cdp);
    const afterMetrics = metricMap(await cdp.send("Performance.getMetrics"));
    const afterHeap = await cdp.send("Runtime.getHeapUsage");
    const drawing = snapshots?.snapshot;
    const bench = snapshots?.bench;
    const rawCapture = snapshots?.rawCapture;
    const runtimeSummary = snapshots?.runtimeSummary;
    const captures = {
      drawingMainThreadMs: durationCapture(rawCapture, drawing, "drawingMainThreadMs"),
      sceneProjectPaintMs: durationCapture(rawCapture, drawing, "sceneProjectPaintMs"),
      hitQueryMs: durationCapture(rawCapture, drawing, "hitQueryMs"),
      mouseupSyncMs: durationCapture(rawCapture, drawing, "mouseupSyncMs"),
      persistenceMs: durationCapture(rawCapture, drawing, "persistenceMs"),
      activeOverlayCpuMs: durationCapture(rawCapture, drawing, "activeOverlayCpuMs"),
      frameIntervalMs: browserCapture(bench, "rafIntervalsMs"),
      inputToNextPaintMs: browserCapture(bench, "inputToNextPaintMs"),
      eventTimingMs: browserCapture(bench, "eventTimingMs"),
    };
    const counters = {
      rawPoints: maxGauge(drawing, "rawPoints"),
      renderedPoints: maxGauge(drawing, "renderedPoints"),
      visibleEntities: maxGauge(drawing, "visibleEntities"),
      culledEntities: maxGauge(drawing, "culledEntities"),
      lodRatio: maxGauge(drawing, "lodRatio"),
      anchorResolveCount: maxCounter(drawing, "anchorResolveCount"),
      finalProjectionCount: maxCounter(drawing, "finalProjectionCount"),
      sceneRebuildCount: maxCounter(drawing, "sceneRebuildCount"),
      requestUpdateCount: maxCounter(drawing, "requestUpdateCount"),
      surfacePrimitiveCount: Number.isSafeInteger(runtimeSummary?.entityCount)
        ? runtimeSummary.entityCount
        : null,
      workerQueueDepth: maxGauge(drawing, "workerQueue"),
    };
    const actionEvidence = {
      ...action,
      processedInputCount: maxCounter(drawing, "inputCount"),
    };

    const expectedSavedDrawingCount = expectedDrawingCountAfterAction(scenario, fixture);
    const persisted = await waitForSavedDrawingCount(
      cdp,
      fixture.storageKey,
      expectedSavedDrawingCount,
      Math.min(args.timeoutMs, 5_000),
    );
    const persistedSummary = await readSavedDrawingSummary(cdp, fixture.storageKey);
    const expectedActiveFreehandCount = (fixture.metadata.drawingTypes.freehand || 0)
      + (scenario.action === "active-freehand" ? 1 : 0);
    if (!persistedSummary
      || persistedSummary.entityCount !== expectedSavedDrawingCount
      || (persistedSummary.typeCounts.freehand || 0) !== expectedActiveFreehandCount
      || (scenario.action === "active-freehand"
        && persistedSummary.pointCount <= fixture.metadata.pointCount)) {
      persisted.matched = false;
      persisted.error = "Persisted drawing entity/type/point summary did not match the action";
    }
    let restore;
    try {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: bootstrapIdentifier,
      });
      bootstrapIdentifier = null;
      restore = await verifyReloadRestore(
        cdp,
        fixture,
        expectedSavedDrawingCount,
        persisted,
        persistedSummary,
        args,
      );
    } catch (error) {
      restore = createReloadRestoreResult(expectedSavedDrawingCount, persisted, persistedSummary);
      restore.error = "Fixture bootstrap could not be removed before reload: " + error.message;
      restore.durationMs = 0;
    }

    return {
      id: scenario.id + "-" + iteration,
      iteration,
      warmup,
      samples: {
        drawingMainThreadMs: captures.drawingMainThreadMs.samples,
        inputToNextPaintMs: captures.inputToNextPaintMs.samples,
        eventTimingMs: captures.eventTimingMs.samples,
        sceneProjectPaintMs: captures.sceneProjectPaintMs.samples,
        frameIntervalMs: captures.frameIntervalMs.samples,
        hitQueryMs: captures.hitQueryMs.samples,
        mouseupSyncMs: captures.mouseupSyncMs.samples,
        workerFinalizeMs: [],
        persistenceMs: captures.persistenceMs.samples,
        exactRenderMs: [],
        activeOverlayCpuMs: captures.activeOverlayCpuMs.samples,
      },
      sampleCompleteness: Object.fromEntries(Object.entries(captures)
        .map(([key, capture]) => [key, capture.completeness])),
      counters,
      longTasks: bench?.longTasks || [],
      drawingWindows: [{
        startTime: actionStartedAt,
        endTime: measurementEndedAt,
        name: scenario.action,
      }],
      scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, "ScriptDuration"),
      heap: {
        before: beforeHeap.result || null,
        after: afterHeap.result || null,
        usedSizeDelta: Number(afterHeap.result?.usedSize) - Number(beforeHeap.result?.usedSize),
      },
      worker: {
        queueDepthMax: counters.workerQueueDepth,
        staleResultPublishCount: maxCounter(drawing, "staleWorkerResultCount"),
      },
      fixture: fixture.metadata,
      ready,
      restoredCount: initialRestoredCount,
      initialRestoredCount,
      initialSavedSummary,
      initialRuntimeSummary: ready.runtimeSummary,
      restore,
      action: actionEvidence,
      measurementWindow: {
        actionStartedAt,
        actionEndedAt,
        measurementEndedAt,
        settleMs: args.settleMs,
      },
      bench: {
        inputEvents: bench?.inputEvents ?? 0,
        eventTimingSupported: bench?.eventTimingSupported === true,
        longTaskSupported: bench?.longTaskSupported === true,
        devicePixelRatio: bench?.devicePixelRatio ?? null,
        viewport: bench?.viewport ?? null,
        captureStats: bench?.captureStats ?? null,
      },
      drawingSnapshot: drawing,
      drawingRawCapture: rawCapture,
      runtimeSummary,
      perfReport: snapshots?.perf,
      diagnostics: {
        consoleErrors: diagnostics.consoleErrors.slice(consoleStart),
        runtimeExceptions: diagnostics.runtimeExceptions.slice(exceptionStart),
        networkFailures: diagnostics.networkFailures.slice(networkStart),
      },
      durationMs: Date.now() - runStartedAt,
    };
  } finally {
    if (bootstrapIdentifier) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: bootstrapIdentifier,
      }).catch(() => {});
    }
  }
}

function readGitContext() {
  const run = (args) => execFileSync("git", args, {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  try {
    const commit = run(["rev-parse", "HEAD"]);
    const status = run(["status", "--short"]);
    return {
      commit,
      shortCommit: commit.slice(0, 8),
      dirty: status.length > 0,
      status: status ? status.split(/\r?\n/) : [],
    };
  } catch {
    return { commit: null, shortCommit: "unknown", dirty: null, status: [] };
  }
}

function machineContext() {
  const cpu = os.cpus()?.[0]?.model || null;
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu,
    logicalCores: os.cpus()?.length || null,
    memoryBytes: os.totalmem(),
  };
}

function fixtureTimeOffsetDenominator(fixtureName) {
  if (fixtureName === "singleFreehand4096") return 4_095;
  if (fixtureName === "freehand64x512") return 511;
  if (fixtureName === "entities200") return 399;
  if (fixtureName === "entities512") return 1_023;
  return 1;
}

function assertFixtureOverlapsMockPriceRange(fixture, mockMeta) {
  if (fixture.metadata.priceRange?.min == null || fixture.metadata.priceRange?.max == null) return;
  const fixtureMin = Number(fixture.metadata.priceRange?.min);
  const fixtureMax = Number(fixture.metadata.priceRange?.max);
  if (!Number.isFinite(fixtureMin) || !Number.isFinite(fixtureMax)) return;
  const mockMin = Number(mockMeta?.price_min);
  const mockMax = Number(mockMeta?.price_max);
  if (!Number.isFinite(mockMin) || !Number.isFinite(mockMax)) {
    throw new Error("Managed mock did not publish a finite price range");
  }
  if (fixtureMax < mockMin || fixtureMin > mockMax) {
    throw new Error("Fixture price range does not overlap the deterministic mock candles");
  }
}

function estimateRefreshRateHz(allScenarioRuns) {
  const intervals = allScenarioRuns.flatMap(({ runs }) => runs
    .filter((run) => !run.warmup)
    .flatMap((run) => run.samples.frameIntervalMs))
    .filter((value) => Number.isFinite(value) && value >= 5 && value <= 50)
    .sort((left, right) => left - right);
  if (intervals.length === 0) return null;
  const median = intervals[Math.floor(intervals.length / 2)];
  return Number.isFinite(median) && median > 0
    ? Number((1_000 / median).toFixed(2))
    : null;
}

function applicableHardGates(scenarioSummary) {
  const definition = DEFAULT_SCENARIOS.find((scenario) => scenario.id === scenarioSummary.id);
  const targetMetrics = new Set(definition?.targetMetrics || []);
  const targetCounters = new Set(definition?.targetCounters || []);
  return DRAWING_PERFORMANCE_HARD_GATES.filter((gate) => {
    const metricMatch = String(gate.path || "").match(/^metrics\.([^.]+)\./);
    if (metricMatch) return targetMetrics.has(metricMatch[1]);
    const counterMatch = String(gate.path || "").match(/^counters\.([^.]+)\./);
    if (counterMatch) return targetCounters.has(counterMatch[1]);
    if (String(gate.path || "").startsWith("longTasks.")) return true;
    return false;
  });
}

function applyRestoreValidity(report, args) {
  const expectedChecksPerScenario = args.runs + args.warmupRuns;
  for (const scenario of report.scenarios) {
    const runs = Array.isArray(scenario.rawRuns) ? scenario.rawRuns : [];
    const restoreChecks = runs.map((run) => run?.restore).filter(Boolean);
    const restoreChecksComplete = runs.length === expectedChecksPerScenario
      && restoreChecks.length === expectedChecksPerScenario;
    const failedRunIds = runs
      .filter((run) => !run?.restore?.passed)
      .map((run) => run?.id ?? null);
    const restoreChecksPassed = restoreChecksComplete && failedRunIds.length === 0;
    const metricsValid = scenario.repetitions.valid;
    scenario.repetitions.metricsValid = metricsValid;
    scenario.repetitions.restoreChecksExpected = expectedChecksPerScenario;
    scenario.repetitions.restoreChecksObserved = restoreChecks.length;
    scenario.repetitions.restoreChecksComplete = restoreChecksComplete;
    scenario.repetitions.restoreChecksPassed = restoreChecksPassed;
    scenario.repetitions.failedRestoreRunIds = failedRunIds;
    scenario.repetitions.valid = metricsValid && restoreChecksPassed;
    scenario.passed = scenario.repetitions.valid && scenario.gates.passed;
  }

  const failedScenarioIds = report.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id);
  const invalidScenarioIds = report.scenarios
    .filter((scenario) => !scenario.repetitions.valid)
    .map((scenario) => scenario.id);
  report.acceptance = {
    ...report.acceptance,
    passed: report.scenarios.length > 0 && failedScenarioIds.length === 0,
    scenarioCount: report.scenarios.length,
    passedScenarioCount: report.scenarios.length - failedScenarioIds.length,
    failedScenarioIds,
    invalidScenarioIds,
    restoreChecksRequired: true,
  };
}

function buildPhase0Acceptance(report, args) {
  const heavy = report.scenarios.find((scenario) => scenario.id === "freehand-64x512-viewport");
  const active = report.scenarios.find((scenario) => scenario.id === "active-freehand-4096");
  const presentScenarioIds = new Set(report.scenarios.map((scenario) => scenario.id));
  const missingRequiredScenarioIds = PHASE0_REQUIRED_SCENARIO_IDS
    .filter((scenarioId) => !presentScenarioIds.has(scenarioId));
  const requiredScenarioCoveragePassed = missingRequiredScenarioIds.length === 0;
  const measuredRunCoveragePassed = args.runs >= PHASE0_MIN_MEASURED_RUNS
    && report.scenarios.every((scenario) => (
      scenario.repetitions.measuredRuns >= PHASE0_MIN_MEASURED_RUNS
    ));
  const warmupCoveragePassed = args.warmupRuns >= PHASE0_MIN_WARMUP_RUNS
    && report.scenarios.every((scenario) => (
      scenario.repetitions.warmupRuns >= PHASE0_MIN_WARMUP_RUNS
    ));
  const executionPassed = report.executionAcceptance?.passed === true;
  const phase0Runs = report.scenarios.flatMap((scenario) => scenario.rawRuns || []);
  const instrumentationCoveragePassed = phase0Runs.length > 0 && phase0Runs.every((run) => (
    run.drawingRawCapture?.enabled === true
    && run.bench?.eventTimingSupported === true
    && run.sampleCompleteness?.eventTimingMs?.complete === true
    && Number(run.sampleCompleteness?.eventTimingMs?.observed) > 0
    && Number(run.sampleCompleteness?.eventTimingMs?.dropped) === 0
    && run.bench?.longTaskSupported === true
    && Number.isFinite(run.scriptDurationMs)
    && Number.isFinite(run.heap?.before?.usedSize)
    && Number.isFinite(run.heap?.after?.usedSize)
    && Number.isFinite(run.worker?.queueDepthMax)
  ));
  const restoreChecksPassed = report.scenarios.length > 0
    && report.scenarios.every((scenario) => scenario.repetitions.restoreChecksPassed);
  const geometryCounterCoveragePassed = report.scenarios
    .filter((scenario) => Number(scenario.fixture?.entities) > 0)
    .every((scenario) => (scenario.rawRuns || []).every((run) => (
      Number(run.counters?.rawPoints) >= Number(scenario.fixture.points)
      && Number(run.counters?.renderedPoints) > 0
      && Number(run.counters?.visibleEntities) > 0
      && typeof run.counters?.culledEntities === "number"
      && Number.isFinite(run.counters.culledEntities)
      && run.counters.culledEntities >= 0
      && Number(run.counters?.lodRatio) > 0
      && Number(run.counters?.anchorResolveCount) > 0
      && Number(run.counters?.finalProjectionCount) > 0
      && Number(run.counters?.sceneRebuildCount) > 0
    )));
  const heavyFixturePassed = heavy?.fixture?.entities === 64
    && heavy?.fixture?.points === 32_768;
  const activeFixturePassed = active?.fixture?.entities === 200
    && active?.fixture?.points === 400;
  const heavyReproduced = Boolean(heavy && heavyFixturePassed && (
    (heavy.metrics.frameIntervalMs.p95 ?? 0) > 33.4
    || heavy.longTasks.attributableCount > 0
  ));
  const activeMeasuredRuns = active?.rawRuns?.filter((run) => !run.warmup) ?? [];
  const activeRunCoverage = args.pointerSamples === PHASE0_POINTER_SAMPLES
    && activeFixturePassed
    && activeMeasuredRuns.length >= PHASE0_MIN_MEASURED_RUNS
    && activeMeasuredRuns.every((run) => (
      run.action?.pointerSamplesDispatched === PHASE0_POINTER_SAMPLES
      && run.action?.processedInputCount >= PHASE0_POINTER_SAMPLES
      && Number(run.counters?.rawPoints) > Number(active.fixture.points)
      && Number(run.counters?.visibleEntities) > Number(active.fixture.entities)
      && Number(run.counters?.requestUpdateCount) > 0
      && run.restore?.runtimeSummaryMatchesSaved === true
    ));
  const activeReproduced = Boolean(active && activeFixturePassed && (
    (active.metrics.frameIntervalMs.p99 ?? 0) > 33.4
    || active.longTasks.attributableCount > 0
  ));
  const productionBuildPassed = report.environment?.productionBuild === true
    && report.environment?.productionBuildVerification === "managed-vite-preview";
  const phase0Eligible = !args.smoke && productionBuildPassed;
  const passed = phase0Eligible
    && requiredScenarioCoveragePassed
    && measuredRunCoveragePassed
    && warmupCoveragePassed
    && executionPassed
    && instrumentationCoveragePassed
    && geometryCounterCoveragePassed
    && restoreChecksPassed
    && heavyReproduced
    && activeRunCoverage
    && activeReproduced;
  const failureReasons = [];
  if (args.smoke) failureReasons.push("smoke-only-run");
  if (!productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!requiredScenarioCoveragePassed) failureReasons.push("missing-required-scenarios");
  if (!measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!instrumentationCoveragePassed) failureReasons.push("instrumentation-coverage-incomplete");
  if (!geometryCounterCoveragePassed) failureReasons.push("geometry-counter-coverage-incomplete");
  if (!restoreChecksPassed) failureReasons.push("reload-restore-check-failed");
  if (!heavyReproduced) failureReasons.push("heavy-stall-not-reproduced");
  if (!activeRunCoverage) failureReasons.push("active-4096-coverage-failed");
  if (!activeReproduced) failureReasons.push("active-stall-not-reproduced");
  return {
    passed,
    smokeOnly: args.smoke,
    phase0Eligible,
    productionBuildPassed,
    requiredScenarioIds: [...PHASE0_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds,
    requiredScenarioCoveragePassed,
    minimumMeasuredRuns: PHASE0_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE0_MIN_WARMUP_RUNS,
    warmupCoveragePassed,
    executionPassed,
    instrumentationCoveragePassed,
    geometryCounterCoveragePassed,
    restoreChecksPassed,
    heavyFixturePassed,
    heavyReproduced,
    activeFixturePassed,
    activeRunCoverage,
    activeReproduced,
    expectedLegacyTargetMiss: true,
    failureReasons,
  };
}

function buildSmokeAcceptance(report, args) {
  const executionPassed = report.executionAcceptance?.passed === true;
  return {
    applicable: args.smoke,
    smokeOnly: args.smoke,
    passed: args.smoke && executionPassed,
    executionPassed,
    scenarioCount: report.scenarios.length,
    invalidScenarioIds: [...(report.executionAcceptance?.invalidScenarioIds ?? [])],
    note: args.smoke
      ? "Smoke reports never satisfy Phase 0 acceptance."
      : "Use --smoke explicitly for a non-Phase-0 subset run.",
  };
}

function buildPhase1Acceptance(report, args) {
  const phase0Structure = buildPhase0Acceptance(report, args);
  const viewportScenarioIds = new Set([
    "single-freehand-4096-viewport",
    "freehand-64x512-viewport",
  ]);
  const viewportScenarios = report.scenarios
    .filter((scenario) => viewportScenarioIds.has(scenario.id));
  const viewportAnchorCachePassed = viewportScenarios.length === viewportScenarioIds.size
    && viewportScenarios.every((scenario) => (scenario.rawRuns || []).every((run) => (
      Number(run.counters?.anchorResolveCount) === 0
    )));
  const geometryProjectionCoveragePassed = report.scenarios
    .filter((scenario) => Number(scenario.fixture?.entities) > 0)
    .every((scenario) => (scenario.rawRuns || []).every((run) => (
      Number(run.counters?.rawPoints) >= Number(scenario.fixture.points)
      && Number(run.counters?.renderedPoints) > 0
      && Number(run.counters?.visibleEntities) > 0
      && Number(run.counters?.finalProjectionCount) > 0
      && Number(run.counters?.sceneRebuildCount) > 0
    )));
  const projectorMode = report.configuration?.drawingCoordinateProjectorMode;
  const batchProjectorPassed = projectorMode === "batch";
  const performanceComparisonPassed = report.phase1Comparison?.passed === true;
  const phase1Eligible = !args.smoke && phase0Structure.productionBuildPassed;
  const passed = phase1Eligible
    && batchProjectorPassed
    && phase0Structure.requiredScenarioCoveragePassed
    && phase0Structure.measuredRunCoveragePassed
    && phase0Structure.warmupCoveragePassed
    && phase0Structure.executionPassed
    && phase0Structure.instrumentationCoveragePassed
    && phase0Structure.restoreChecksPassed
    && phase0Structure.heavyFixturePassed
    && phase0Structure.activeFixturePassed
    && phase0Structure.activeRunCoverage
    && geometryProjectionCoveragePassed
    && viewportAnchorCachePassed
    && performanceComparisonPassed;
  const failureReasons = [];
  if (args.smoke) failureReasons.push("smoke-only-run");
  if (!phase0Structure.productionBuildPassed) failureReasons.push("production-build-unverified");
  if (!batchProjectorPassed) failureReasons.push("batch-projector-not-selected");
  if (!phase0Structure.requiredScenarioCoveragePassed) failureReasons.push("missing-required-scenarios");
  if (!phase0Structure.measuredRunCoveragePassed) failureReasons.push("measured-runs-below-five");
  if (!phase0Structure.warmupCoveragePassed) failureReasons.push("warmup-runs-below-one");
  if (!phase0Structure.executionPassed) failureReasons.push("scenario-execution-invalid");
  if (!phase0Structure.instrumentationCoveragePassed) {
    failureReasons.push("instrumentation-coverage-incomplete");
  }
  if (!phase0Structure.restoreChecksPassed) failureReasons.push("reload-restore-check-failed");
  if (!phase0Structure.heavyFixturePassed) failureReasons.push("heavy-fixture-mismatch");
  if (!phase0Structure.activeFixturePassed) failureReasons.push("active-fixture-mismatch");
  if (!phase0Structure.activeRunCoverage) failureReasons.push("active-4096-coverage-failed");
  if (!geometryProjectionCoveragePassed) failureReasons.push("geometry-projection-coverage-incomplete");
  if (!viewportAnchorCachePassed) failureReasons.push("viewport-anchor-cache-miss");
  if (!performanceComparisonPassed) failureReasons.push("performance-comparison-failed");
  return {
    passed,
    smokeOnly: args.smoke,
    phase1Eligible,
    productionBuildPassed: phase0Structure.productionBuildPassed,
    projectorMode,
    batchProjectorPassed,
    requiredScenarioIds: [...PHASE0_REQUIRED_SCENARIO_IDS],
    missingRequiredScenarioIds: phase0Structure.missingRequiredScenarioIds,
    requiredScenarioCoveragePassed: phase0Structure.requiredScenarioCoveragePassed,
    minimumMeasuredRuns: PHASE0_MIN_MEASURED_RUNS,
    measuredRunCoveragePassed: phase0Structure.measuredRunCoveragePassed,
    minimumWarmupRuns: PHASE0_MIN_WARMUP_RUNS,
    warmupCoveragePassed: phase0Structure.warmupCoveragePassed,
    executionPassed: phase0Structure.executionPassed,
    instrumentationCoveragePassed: phase0Structure.instrumentationCoveragePassed,
    restoreChecksPassed: phase0Structure.restoreChecksPassed,
    geometryProjectionCoveragePassed,
    viewportAnchorCachePassed,
    performanceComparisonPassed,
    activeRunCoverage: phase0Structure.activeRunCoverage,
    failureReasons,
  };
}

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildPhase1Comparison(report, compareBefore) {
  if (!compareBefore) {
    return {
      applicable: false,
      passed: false,
      failureReasons: ["before-baseline-not-provided"],
    };
  }
  const baselinePath = path.resolve(process.cwd(), compareBefore);
  let before = null;
  try {
    before = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return {
      applicable: true,
      baselinePath,
      passed: false,
      failureReasons: ["before-baseline-unreadable"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const scenarioId = "freehand-64x512-viewport";
  const beforeScenario = before.scenarios?.find?.((scenario) => scenario?.id === scenarioId);
  const afterScenario = report.scenarios?.find?.((scenario) => scenario?.id === scenarioId);
  const beforeScriptP95 = finiteMetric(beforeScenario?.metrics?.scriptDurationMs?.p95);
  const afterScriptP95 = finiteMetric(afterScenario?.metrics?.scriptDurationMs?.p95);
  const beforeDrawingP95 = finiteMetric(beforeScenario?.metrics?.drawingMainThreadMs?.p95);
  const afterDrawingP95 = finiteMetric(afterScenario?.metrics?.drawingMainThreadMs?.p95);
  const scriptReductionRatio = beforeScriptP95 && afterScriptP95 !== null
    ? 1 - afterScriptP95 / beforeScriptP95
    : null;
  const drawingReductionRatio = beforeDrawingP95 && afterDrawingP95 !== null
    ? 1 - afterDrawingP95 / beforeDrawingP95
    : null;
  const comparable = beforeScenario?.fixture?.bars === afterScenario?.fixture?.bars
    && beforeScenario?.fixture?.dpr === afterScenario?.fixture?.dpr
    && beforeScenario?.fixture?.entities === afterScenario?.fixture?.entities
    && beforeScenario?.fixture?.points === afterScenario?.fixture?.points
    && before.configuration?.seed === report.configuration?.seed
    && JSON.stringify(before.environment?.viewport) === JSON.stringify(report.environment?.viewport)
    && before.environment?.dpr === report.environment?.dpr
    && before.context?.browser?.version === report.context?.browser?.version;
  const scriptDurationClearlyDown = scriptReductionRatio !== null
    && scriptReductionRatio >= 0.5;
  const drawingMainClearlyDown = drawingReductionRatio !== null
    && drawingReductionRatio >= 0.5;
  const failureReasons = [];
  if (!beforeScenario || !afterScenario) failureReasons.push("heavy-scenario-missing");
  if (!comparable) failureReasons.push("baseline-context-mismatch");
  if (!scriptDurationClearlyDown) failureReasons.push("script-duration-not-clearly-down");
  if (!drawingMainClearlyDown) failureReasons.push("drawing-main-not-clearly-down");
  return {
    applicable: true,
    baselinePath,
    scenarioId,
    comparable,
    minimumReductionRatio: 0.5,
    scriptDurationMs: {
      beforeP95: beforeScriptP95,
      afterP95: afterScriptP95,
      reductionRatio: scriptReductionRatio,
      clearlyDown: scriptDurationClearlyDown,
    },
    drawingMainThreadMs: {
      beforeP95: beforeDrawingP95,
      afterP95: afterDrawingP95,
      reductionRatio: drawingReductionRatio,
      clearlyDown: drawingMainClearlyDown,
    },
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const git = readGitContext();
  const configuredProjectorMode = process.env.VITE_DRAWING_COORDINATE_PROJECTOR;
  const drawingCoordinateProjectorMode = configuredProjectorMode === "scalar"
    || configuredProjectorMode === "parity"
    || configuredProjectorMode === "batch"
    ? configuredProjectorMode
    : "batch";
  const selectedScenarios = DEFAULT_SCENARIOS.filter((scenario) => args.scenarios.includes(scenario.id));
  const managed = !args.url;
  if (managed) ensureProductionBuild();
  const servers = managed ? await startManagedServers(args) : null;
  if (servers) args.url = servers.url;
  if (!args.url.endsWith("/")) args.url += "/";

  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge executable not found. Pass --chrome <path>.");
  const debugPort = await freePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-drawing-perf-"));
  const chromeArgs = [
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profileDirectory,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-precise-memory-info",
    "--window-size=" + DEFAULT_VIEWPORT.width + "," + DEFAULT_VIEWPORT.height,
  ];
  if (args.headless) chromeArgs.push("--headless=new", "--disable-gpu");
  chromeArgs.push("about:blank");
  const chrome = spawn(chromePath, chromeArgs, {
    stdio: "ignore",
    windowsHide: args.headless,
  });

  let cdp = null;
  try {
    const targets = await waitForDebugTarget(debugPort, args.timeoutMs);
    const page = targets.find((target) => target.type === "page") || targets[0];
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    const diagnostics = {
      consoleErrors: [],
      runtimeExceptions: [],
      networkFailures: [],
    };
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event?.type !== "error") return;
      diagnostics.consoleErrors.push({
        atMs: Date.now(),
        values: (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
      });
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      diagnostics.runtimeExceptions.push({
        atMs: Date.now(),
        text: event?.exceptionDetails?.text || null,
        exception: event?.exceptionDetails?.exception?.description || null,
      });
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (event?.canceled || event?.errorText === "net::ERR_ABORTED") return;
      diagnostics.networkFailures.push({
        atMs: Date.now(),
        type: event?.type || null,
        errorText: event?.errorText || null,
      });
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: args.dpr,
      mobile: false,
      screenWidth: DEFAULT_VIEWPORT.width,
      screenHeight: DEFAULT_VIEWPORT.height,
    });
    await cdp.send("Page.bringToFront");
    const browserVersion = await cdp.send("Browser.getVersion");
    const allScenarioRuns = [];
    const totalRuns = args.warmupRuns + args.runs;
    const fixtureStartTime = args.mockEndTime - (args.bars - 1) * args.intervalSeconds;

    for (const scenario of selectedScenarios) {
      const fixture = buildDrawingFixture(scenario.fixture, {
        scopeKey: "binance:spot:BTCUSDT__main",
        startTime: fixtureStartTime,
        intervalSeconds: (args.intervalSeconds * Math.max(1, args.bars - 1))
          / fixtureTimeOffsetDenominator(scenario.fixture),
        seed: args.seed,
      });
      if (managed) assertFixtureOverlapsMockPriceRange(fixture, servers?.mockMeta);
      const runs = [];
      for (let iteration = 0; iteration < totalRuns; iteration += 1) {
        const warmup = iteration < args.warmupRuns;
        console.log("[" + scenario.id + "] run " + (iteration + 1) + "/" + totalRuns
          + (warmup ? " (warm-up)" : ""));
        const run = await runOneScenario(
          cdp,
          scenario,
          fixture,
          args,
          iteration + 1,
          warmup,
          diagnostics,
        );
        runs.push(run);
        console.log("  " + run.durationMs + "ms; rAF samples="
          + run.samples.frameIntervalMs.length + "; longTasks=" + run.longTasks.length);
      }
      allScenarioRuns.push({ scenario, fixture, runs });
    }

    const report = buildDrawingPerformanceReport({
      generatedAt: new Date().toISOString(),
      context: {
        commit: git.commit,
        browser: {
          name: browserVersion.result?.product || "Chromium",
          version: browserVersion.result?.product || null,
          userAgent: browserVersion.result?.userAgent || null,
        },
        machine: machineContext(),
        mode: "legacy",
      },
      environment: {
        viewport: DEFAULT_VIEWPORT,
        dpr: args.dpr,
        refreshRateHz: estimateRefreshRateHz(allScenarioRuns),
        productionBuild: managed,
      },
      configuration: {
        requiredMeasuredRuns: args.runs,
        warmupRuns: args.warmupRuns,
        longTaskThresholdMs: 50,
        seed: args.seed,
      },
      scenarios: allScenarioRuns.map(({ scenario, fixture, runs }) => ({
        id: scenario.id,
        fixture: {
          bars: args.bars,
          entities: fixture.metadata.drawingCount,
          points: fixture.metadata.pointCount,
          mode: "legacy",
          dpr: args.dpr,
        },
        runs,
        requiredMetrics: scenario.requiredMetrics,
        gates: [],
      })),
    });
    report.context.git = git;
    report.environment.mock = servers?.mockMeta || null;
    report.environment.productionBuildVerification = managed
      ? "managed-vite-preview"
      : "external-url-unverified";
    report.configuration.url = args.url;
    report.configuration.serverMode = managed ? "managed-preview" : "external-url";
    report.configuration.headless = args.headless;
    report.configuration.smokeOnly = args.smoke;
    report.configuration.scenarios = args.scenarios;
    report.configuration.wheelEvents = args.wheelEvents;
    report.configuration.hoverEvents = args.hoverEvents;
    report.configuration.pointerSamples = args.pointerSamples;
    report.configuration.drawingCoordinateProjectorMode = drawingCoordinateProjectorMode;
    report.configuration.compareBefore = args.compareBefore || null;
    report.runMode = {
      name: args.smoke ? "smoke" : args.phase,
      smokeOnly: args.smoke,
      phase0Eligible: !args.smoke,
      phase1Eligible: !args.smoke,
    };
    applyRestoreValidity(report, args);
    report.executionAcceptance = {
      ...report.acceptance,
      failedScenarioIds: [...report.acceptance.failedScenarioIds],
      invalidScenarioIds: [...report.acceptance.invalidScenarioIds],
    };
    report.targetAssessment = Object.fromEntries(report.scenarios.map((scenario) => [
      scenario.id,
      evaluateGates(scenario, applicableHardGates(scenario)),
    ]));
    report.phase1Comparison = buildPhase1Comparison(report, args.compareBefore);
    report.phase0Acceptance = buildPhase0Acceptance(report, args);
    report.phase1Acceptance = buildPhase1Acceptance(report, args);
    report.smokeAcceptance = buildSmokeAcceptance(report, args);
    const phaseAcceptance = args.phase === "phase1"
      ? report.phase1Acceptance
      : report.phase0Acceptance;
    report.acceptance = {
      ...report.executionAcceptance,
      kind: args.phase,
      passed: phaseAcceptance.passed,
      smokeOnly: args.smoke,
      phase0Eligible: !args.smoke,
      phase1Eligible: !args.smoke,
      executionPassed: report.executionAcceptance.passed,
    };

    const safeDpr = String(args.dpr).replace(".", "_");
    const generatedStamp = report.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const defaultOut = path.resolve(
      FRONTEND_ROOT,
      "..",
      "docs",
      "perf-baselines",
      "drawing-engine-v2",
      (args.smoke ? "smoke-" : args.phase === "phase1" ? "baseline-after-" : "baseline-before-")
        + git.shortCommit
        + "-" + generatedStamp + "-bars" + args.bars + "-dpr" + safeDpr + ".json",
    );
    const outputPath = args.out ? path.resolve(process.cwd(), args.out) : defaultOut;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, stableStringify(report, 2) + "\n", "utf8");
    console.log("Wrote drawing performance baseline to " + outputPath);
    console.log(JSON.stringify({
      phase0Acceptance: report.phase0Acceptance,
      phase1Acceptance: report.phase1Acceptance,
      phase1Comparison: report.phase1Comparison,
      smokeAcceptance: report.smokeAcceptance,
      invalidScenarios: report.acceptance.invalidScenarioIds,
      targetAssessment: Object.fromEntries(Object.entries(report.targetAssessment)
        .map(([id, value]) => [id, { passed: value.passed, failedCount: value.failedCount }])),
    }, null, 2));

    const targetPassed = Object.values(report.targetAssessment).every((assessment) => assessment.passed);
    const selectedModePassed = args.smoke
      ? report.smokeAcceptance.passed
      : phaseAcceptance.passed;
    if (!selectedModePassed || (args.enforceTargets && !targetPassed)) {
      process.exitCode = 1;
    }
  } finally {
    cdp?.close?.();
    await stopProcess(chrome);
    await removeDirectoryWithRetries(profileDirectory);
    await servers?.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
