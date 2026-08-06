import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CAPACITY_SCHEMA_VERSION = "candlescope.multi-chart.capacity/1";
export const HARDWARE_SCHEMA_VERSION = "candlescope.multi-chart.hardware/1";
export const CURRENT_PRODUCT_CELL_LIMIT = 4;
export const SUPPORTED_CELL_ARGUMENTS = Object.freeze([1, 2, 4, 8, 16]);
export const SUPPORTED_SCENARIOS = Object.freeze(["S1", "S2", "S3", "S4", "S5"]);
const EVIDENCE_SCENARIOS = new Set([
  ...SUPPORTED_SCENARIOS,
  "C1", "W1", "W2", "W3", "F1", "F2", "F3",
]);

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:18080";
const DEFAULT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
const INTERVALS = Object.freeze(["1m", "5m", "15m", "1h"]);

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv, environment = process.env) {
  const args = {
    url: environment.MULTI_CHART_URL || DEFAULT_URL,
    backendUrl: environment.MULTI_CHART_BACKEND_URL || DEFAULT_BACKEND_URL,
    cells: Number(environment.MULTI_CHART_CELLS || 1),
    scenario: environment.MULTI_CHART_SCENARIO || "S1",
    durationMs: Number(environment.MULTI_CHART_DURATION_MS || 10_000),
    readyTimeoutMs: Number(environment.MULTI_CHART_READY_TIMEOUT_MS || 60_000),
    out: environment.MULTI_CHART_OUT || "docs/perf-baselines/multi-chart-workspace/phase0-capacity.json",
    artifactsDir: environment.MULTI_CHART_ARTIFACTS_DIR || "output/playwright/multi-chart-capacity",
    hardwareOut: environment.MULTI_CHART_HARDWARE_OUT || "docs/perf-baselines/multi-chart-workspace/hardware-profile.json",
    chromePath: environment.CHROME_PATH || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") args.url = requireValue(argv, index++, value);
    else if (value === "--backend-url") args.backendUrl = requireValue(argv, index++, value);
    else if (value === "--cells") args.cells = Number(requireValue(argv, index++, value));
    else if (value === "--scenario") args.scenario = requireValue(argv, index++, value).toUpperCase();
    else if (value === "--duration-ms") args.durationMs = Number(requireValue(argv, index++, value));
    else if (value === "--ready-timeout-ms") args.readyTimeoutMs = Number(requireValue(argv, index++, value));
    else if (value === "--out") args.out = requireValue(argv, index++, value);
    else if (value === "--artifacts-dir") args.artifactsDir = requireValue(argv, index++, value);
    else if (value === "--hardware-out") args.hardwareOut = requireValue(argv, index++, value);
    else if (value === "--chrome") args.chromePath = requireValue(argv, index++, value);
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!SUPPORTED_CELL_ARGUMENTS.includes(args.cells)) {
    throw new Error(`--cells must be one of ${SUPPORTED_CELL_ARGUMENTS.join(", ")}`);
  }
  if (!SUPPORTED_SCENARIOS.includes(args.scenario)) {
    throw new Error(`--scenario must be one of ${SUPPORTED_SCENARIOS.join(", ")}`);
  }
  if (!Number.isFinite(args.durationMs) || args.durationMs < 1_000) {
    throw new Error("--duration-ms must be at least 1000");
  }
  if (!Number.isFinite(args.readyTimeoutMs) || args.readyTimeoutMs < 1_000) {
    throw new Error("--ready-timeout-ms must be at least 1000");
  }
  return args;
}

function usage() {
  return `Usage: npm run capacity:multi-chart -- [options]

  --cells <1|2|4|8|16>       Logical cells to request
  --scenario <S1|S2|S3|S4|S5>
  --url <frontend-url>        Existing frontend origin
  --backend-url <url>         Existing backend origin
  --duration-ms <ms>          Measured duration after readiness (>=1000)
  --ready-timeout-ms <ms>     Readiness timeout (>=1000)
  --out <json-path>           Capacity evidence output
  --artifacts-dir <path>      Screenshot and trace directory
  --hardware-out <json-path>  Hardware profile output
  --chrome <path>             Chrome or Edge executable`;
}

function scenarioCells(scenario, cellCount) {
  const cells = [];
  for (let index = 0; index < 4; index += 1) {
    const visibleIndex = index % Math.max(1, cellCount);
    const symbol = ["S3", "S4", "S5"].includes(scenario)
      ? SYMBOLS[visibleIndex % SYMBOLS.length]
      : SYMBOLS[0];
    const interval = scenario === "S2"
      ? INTERVALS[visibleIndex % INTERVALS.length]
      : INTERVALS[0];
    const indicators = scenario === "S4"
      ? [
          { id: `capacity-ma-${index + 1}`, name: "MA", engineName: "MA", kind: "builtin", params: { period: 20 }, visible: true },
          { id: `capacity-rsi-${index + 1}`, name: "RSI", engineName: "RSI", kind: "builtin", params: { period: 14 }, visible: true },
        ]
      : scenario === "S5"
        ? [{
            id: `capacity-pyne-${index + 1}`,
            name: "Capacity hosted SMA",
            kind: "script",
            language: "pyne",
            executionTarget: "hosted",
            script: "plot(ta.sma(close, 50), title='SMA 50')",
            params: {},
            visible: true,
          }]
        : [];
    cells.push({
      id: `cell-${index + 1}`,
      linkGroup: null,
      linkRole: "bidirectional",
      drawingLayerSet: "1",
      session: { exchange: "binance", marketType: "spot", symbol, interval },
      chartSettings: {},
      priceScale: { invertScale: false, priceScaleMode: 0 },
      indicators,
    });
  }
  return cells;
}

function layoutTree(cellCount) {
  const cell = (index) => ({ kind: "cell", cellId: `cell-${index}` });
  if (cellCount === 1) return cell(1);
  if (cellCount === 2) {
    return { kind: "split", id: "capacity-root", direction: "columns", ratio: 0.5, first: cell(1), second: cell(2) };
  }
  return {
    kind: "split",
    id: "capacity-root",
    direction: "columns",
    ratio: 0.5,
    first: { kind: "split", id: "capacity-left", direction: "rows", ratio: 0.5, first: cell(1), second: cell(2) },
    second: { kind: "split", id: "capacity-right", direction: "rows", ratio: 0.5, first: cell(3), second: cell(4) },
  };
}

export function buildWorkspaceBootstrap({ cells, scenario, now = Date.now() }) {
  if (![1, 2, 4].includes(cells)) {
    throw new Error(`Workspace schema v5 cannot represent ${cells} visible cells`);
  }
  const states = scenarioCells(scenario, cells);
  const document = {
    schemaVersion: 5,
    layoutTree: layoutTree(cells),
    layoutLocked: true,
    activeCellId: "cell-1",
    maximizedCellId: null,
    linkGroups: Object.fromEntries(["A", "B", "C", "D"].map((group) => [group, {
      market: true,
      interval: false,
      crosshair: true,
      timeAnchor: false,
      dateRange: true,
      drawings: false,
    }])),
    cells: Object.fromEntries(states.map((state) => [state.id, state])),
  };
  const record = {
    schemaVersion: 1,
    id: "workspace-capacity-phase0",
    name: `Phase 0 ${scenario} ${cells} Cell`,
    createdAt: now,
    updatedAt: now,
    document,
  };
  return {
    record,
    library: { activeWorkspaceId: record.id, workspaces: [record] },
    expectedSeries: Array.from(new Set(states.slice(0, cells).map((state) => (
      `${state.session.symbol}@${state.session.interval}`
    )))).sort(),
    expectedSymbols: Array.from(new Set(states.slice(0, cells).map((state) => state.session.symbol))).sort(),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpJson(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`${url} returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
  });
}

function httpStatus(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", () => {
        const status = response.statusCode || 0;
        if (status >= 200 && status < 400) resolve(status);
        else reject(new Error(`${url} returned HTTP ${status}`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
  });
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await httpJson(url, Math.min(5_000, timeoutMs));
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await httpStatus(url, Math.min(5_000, timeoutMs));
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function findChrome(explicitPath) {
  return [
    explicitPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

async function connectWebSocket(url) {
  if (!globalThis.WebSocket) throw new Error("Node.js WebSocket is unavailable");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const pendingRequest = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) pendingRequest.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pendingRequest.resolve(message.result || {});
      return;
    }
    for (const handler of handlers.get(message.method) || []) handler(message.params || {});
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
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = response.result;
  if (result?.subtype === "error") throw new Error(result.description || "Runtime.evaluate failed");
  return result?.value;
}

async function evaluateJson(cdp, expression) {
  const value = await evaluate(cdp, `JSON.stringify((${expression})())`);
  return typeof value === "string" ? JSON.parse(value) : null;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || result.stderr).trim() : null;
}

function gitSnapshot() {
  const commit = commandVersion("git", ["rev-parse", "HEAD"]);
  const status = commandVersion("git", ["status", "--porcelain=v1"]);
  return { commit, dirty: Boolean(status), statusLines: status ? status.split(/\r?\n/).length : 0 };
}

function windowsPowerShellJson(script) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function windowsGraphicsProfile() {
  const value = windowsPowerShellJson([
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate | ConvertTo-Json -Compress",
  ].join("; "));
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function windowsMonitorProfile() {
  return windowsPowerShellJson([
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [PSCustomObject]@{ deviceName = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; bitsPerPixel = $_.BitsPerPixel } })",
    "[PSCustomObject]@{ monitorCount = $monitors.Count; monitors = $monitors } | ConvertTo-Json -Depth 4 -Compress",
  ].join("; "));
}

function buildHostProfile({ browser, display, webgl, database }) {
  const profileBasis = {
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model || null,
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      graphics: windowsGraphicsProfile(),
      monitorTopology: windowsMonitorProfile(),
    },
    software: {
      node: process.version,
      python: commandVersion("python", ["--version"]),
      browser,
    },
    display,
    webgl,
  };
  return {
    schemaVersion: HARDWARE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    profileSha256: sha256Json(profileBasis),
    ...profileBasis,
    database,
  };
}

function initializationScript(bootstrap) {
  return `(() => {
    const record = ${JSON.stringify(bootstrap.record)};
    const library = ${JSON.stringify(bootstrap.library)};
    localStorage.setItem('candlescope-active-workspace-id-v1', record.id);
    localStorage.setItem('candlescope-active-workspace-bootstrap-v1', JSON.stringify(record));
    localStorage.setItem('candlescope-workspace-library-fallback-v1', JSON.stringify(library));
    const state = window.__CANDLESCOPE_MULTI_CHART_CAPACITY__ = {
      longTasks: [], inputEvents: [], canvasAdded: 0, canvasRemoved: 0, measuring: false,
    };
    const observeCanvas = (nodes, field) => {
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('canvas')) state[field] += 1;
        state[field] += node.querySelectorAll?.('canvas').length || 0;
      }
    };
    new MutationObserver((records) => {
      if (!state.measuring) return;
      for (const record of records) {
        observeCanvas(record.addedNodes, 'canvasAdded');
        observeCanvas(record.removedNodes, 'canvasRemoved');
      }
    }).observe(document, { childList: true, subtree: true });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.inputEvents.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, interactionId: entry.interactionId || 0 });
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {}
  })();`;
}

async function waitForCapacityReady(cdp, cellCount, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await evaluateJson(cdp, `() => {
      const cells = Array.from(document.querySelectorAll('.multi-chart-cell'));
      const statuses = cells.map((cell) => cell.querySelector('.multi-chart-cell-status')?.className || 'missing');
      return {
        documentReady: document.readyState,
        visibleCells: cells.length,
        cellIds: cells.map((cell) => cell.getAttribute('data-chart-cell-id')),
        statuses,
        canvasCount: cells.reduce((count, cell) => count + cell.querySelectorAll('canvas').length, 0),
        errorText: Array.from(document.querySelectorAll('.error-message, .chart-error')).map((node) => node.textContent?.trim()).filter(Boolean),
      };
    }`);
    const statusesReady = latest?.statuses?.every((status) => /\b(live|fallback)\b/.test(status));
    if (latest?.visibleCells === cellCount && latest.canvasCount >= cellCount && statusesReady) {
      return { ready: true, readyMs: Date.now() - startedAt, ...latest };
    }
    await wait(250);
  }
  return { ready: false, readyMs: Date.now() - startedAt, ...(latest || {}) };
}

function classifyWebSockets(records) {
  const created = records.filter((record) => record.event === "created");
  const kline = created.filter((record) => /\/stream\/klines(?:_multi|_batch)?(?:\?|$)/.test(record.url));
  const indicator = created.filter((record) => /\/stream\/indicators(?:\?|$)/.test(record.url));
  return {
    all: created,
    kline,
    indicator,
    other: created.filter((record) => !kline.includes(record) && !indicator.includes(record)),
  };
}

function leaseMapping(before, after, expectedSeries) {
  const beforeMap = before?.dataManager?.directSubscriptionsBySeries || {};
  const afterMap = after?.dataManager?.directSubscriptionsBySeries || {};
  const bySeries = Object.fromEntries(expectedSeries.map((series) => [series, {
    before: Number(beforeMap[series] || 0),
    after: Number(afterMap[series] || 0),
    delta: Number(afterMap[series] || 0) - Number(beforeMap[series] || 0),
  }]));
  return {
    bySeries,
    observedSeries: expectedSeries.filter((series) => bySeries[series].after > 0).length,
    leases: expectedSeries.reduce((total, series) => total + Math.max(0, bySeries[series].delta), 0),
    duplicateSeries: expectedSeries.filter((series) => bySeries[series].delta > 1),
  };
}

function compactExchangeSnapshot(exchange) {
  const ingress = exchange?.ingestion?.ingress || {};
  const transport = ingress.transport || {};
  const rateLimits = transport.exchange_rate_limits || {};
  return {
    physicalWebSockets: Number(exchange?.physicalWebSockets || 0),
    sharedPhysicalWebSockets: Number(exchange?.sharedPhysicalWebSockets || 0),
    dedicatedPhysicalWebSockets: Number(exchange?.dedicatedPhysicalWebSockets || 0),
    sharedWs: ingress.shared_ws || null,
    pipelineCount: Object.keys(ingress.pipelines || {}).length,
    pipelineKeys: Object.keys(ingress.pipelines || {}).sort(),
    transport: {
      activeHttpEndpoint: transport.active_http_endpoint || null,
      activeWsEndpoint: transport.active_ws_endpoint || null,
      metrics: transport.metrics || null,
      rateLimits: Object.fromEntries(Object.entries(rateLimits).map(([key, value]) => [key, {
        rule: value?.rule || null,
        algorithm: value?.algorithm || null,
        capacity: value?.capacity ?? null,
        tokens: value?.tokens ?? null,
        maxConcurrency: value?.max_concurrency ?? null,
        cooldownRemainingSeconds: value?.cooldown_remaining_seconds ?? null,
        deferredRequests: value?.deferred_requests ?? null,
      }])),
    },
  };
}

function compactBackendSnapshot(snapshot) {
  const dataManager = snapshot?.dataManager || {};
  const backfill = snapshot?.backfill || {};
  const indicators = snapshot?.indicators || {};
  const rangeCache = indicators.rangeCache || {};
  const runtimeRouting = indicators.runtimeRouting || {};
  return {
    schemaVersion: snapshot?.schemaVersion || null,
    generatedAtMs: snapshot?.generatedAtMs || null,
    readOnly: snapshot?.readOnly === true,
    ok: snapshot?.ok === true,
    errors: snapshot?.errors || [],
    database: snapshot?.database || null,
    dataManager: {
      activeSeries: Number(dataManager.activeSeries || 0),
      streamLeases: Number(dataManager.streamLeases || 0),
      logicalSubscribers: Number(dataManager.logicalSubscribers || 0),
      cacheSeries: Number(dataManager.cacheSeries || 0),
      cacheBars: Number(dataManager.cacheBars || 0),
      directSubscriptionsBySeries: dataManager.directSubscriptionsBySeries || {},
      streams: dataManager.streams || [],
    },
    backfill: {
      activeRequests: Number(backfill.activeRequests || 0),
      pendingRequests: Number(backfill.pendingRequests || 0),
      runningChunks: Number(backfill.runningChunks || 0),
      readyChunks: Number(backfill.readyChunks || 0),
    },
    executors: snapshot?.executors || null,
    indicators: {
      activeInstances: Number(indicators.activeInstances || 0),
      streamSubscriptions: Number(indicators.streamSubscriptions || 0),
      rangeCache: {
        entries: Number(rangeCache.entries || 0),
        maxEntries: Number(rangeCache.maxEntries || 0),
        series: Number(rangeCache.series || 0),
        inFlight: Number(rangeCache.inFlight || 0),
        hits: Number(rangeCache.hits || 0),
        misses: Number(rangeCache.misses || 0),
        computes: Number(rangeCache.computes || 0),
        singleflightJoins: Number(rangeCache.singleflightJoins || 0),
      },
      runtimeRouting: {
        started: runtimeRouting.started === true,
        source: runtimeRouting.source || null,
        counts: runtimeRouting.counts || {},
        pendingShadow: Number(runtimeRouting.pendingShadow || 0),
      },
    },
    exchange: compactExchangeSnapshot(snapshot?.exchange || {}),
    runtime: snapshot?.runtime || null,
  };
}

function compactPerfSnapshot(perf) {
  if (!perf || typeof perf !== "object") return null;
  const selectedMarkNames = [
    "app.boot.start",
    "app.root.render.requested",
    "chart.initialLoad.start",
    "chart.initialLoad.history.request",
    "chart.initialLoad.history.commit",
    "chart.firstBars",
    "chart.ready",
    "chart.activeHistoryHydration.complete",
    "ws.kline.open",
    "ws.kline.live",
    "ws.kline.firstTick",
    "indicator.ws.open",
    "indicator.compute.complete",
  ];
  const marks = Object.fromEntries(selectedMarkNames
    .filter((name) => perf.marks?.[name])
    .map((name) => [name, perf.marks[name]]));
  const eventsByName = {};
  for (const event of Array.isArray(perf.events) ? perf.events : []) {
    if (typeof event?.name !== "string") continue;
    eventsByName[event.name] = Number(eventsByName[event.name] || 0) + 1;
  }
  return {
    namespace: perf.namespace || null,
    createdAtMs: perf.createdAtMs ?? null,
    timings: perf.timings || {},
    marks,
    eventCount: Array.isArray(perf.events) ? perf.events.length : 0,
    eventsByName: Object.fromEntries(Object.entries(eventsByName).sort()),
  };
}

export function evaluateCapacityResult({
  supported,
  requestedCells,
  readiness,
  errors,
  backendAfter,
  mapping,
  canvasRemounts,
}) {
  if (!supported) {
    return {
      result: "unsupported",
      checks: {
        productCellLimit: { actual: CURRENT_PRODUCT_CELL_LIMIT, expected: `>= ${requestedCells}`, passed: false },
      },
    };
  }
  const checks = {
    visibleCells: { actual: readiness.visibleCells ?? 0, expected: requestedCells, passed: readiness.visibleCells === requestedCells },
    allCellsReady: { actual: readiness.ready, expected: true, passed: readiness.ready === true },
    consoleErrors: { actual: errors.console.length, expected: 0, passed: errors.console.length === 0 },
    runtimeExceptions: { actual: errors.exceptions.length, expected: 0, passed: errors.exceptions.length === 0 },
    networkFailures: { actual: errors.network.length, expected: 0, passed: errors.network.length === 0 },
    backendSnapshot: { actual: backendAfter?.schemaVersion || null, expected: "candlescope.backend.capacity/1", passed: backendAfter?.ok === true },
    expectedBackendSeries: { actual: mapping.observedSeries, expected: mapping.expectedSeries, passed: mapping.observedSeries === mapping.expectedSeries },
    duplicateBackendLease: { actual: mapping.duplicateSeries, expected: [], passed: mapping.duplicateSeries.length === 0 },
    canvasRemounts: { actual: canvasRemounts, expected: 0, passed: canvasRemounts === 0 },
  };
  return {
    result: Object.values(checks).every((check) => check.passed) ? "pass" : "fail",
    checks,
  };
}

export function validateCapacityEvidence(value) {
  const errors = [];
  if (!value || typeof value !== "object") return ["evidence must be an object"];
  if (value.schemaVersion !== CAPACITY_SCHEMA_VERSION) errors.push("schemaVersion is invalid");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) errors.push("generatedAt is invalid");
  if (!value.git || typeof value.git.commit !== "string" || typeof value.git.dirty !== "boolean") errors.push("git is invalid");
  if (!value.hardware || !/^sha256:[0-9a-f]{64}$/.test(value.hardware.profileSha256)) errors.push("hardware is invalid");
  if (
    !value.scenario
    || !EVIDENCE_SCENARIOS.has(value.scenario.id)
    || !Number.isInteger(value.scenario.cells)
    || value.scenario.cells < 1
    || value.scenario.cells > 64
    || !Number.isInteger(value.scenario.windows)
    || value.scenario.windows < 1
    || value.scenario.windows > 4
  ) errors.push("scenario is invalid");
  if (!value.data || typeof value.data !== "object") errors.push("data is missing");
  if (
    !value.frontend || typeof value.frontend !== "object"
    || !value.backend || typeof value.backend !== "object"
    || !value.upstream || typeof value.upstream !== "object"
  ) errors.push("capacity sections are missing");
  if (!["pass", "fail", "unsupported"].includes(value.result)) errors.push("result is invalid");
  if (!value.gates || typeof value.gates !== "object") errors.push("gates are missing");
  return errors;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(5_000),
  ]);
  if (child.exitCode === null && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
}

async function runSupported(args) {
  const bootstrap = buildWorkspaceBootstrap({ cells: args.cells, scenario: args.scenario });
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; pass --chrome");
  const backendBefore = await waitForJson(`${args.backendUrl}/debug/capacity`, args.readyTimeoutMs);
  await waitForHttp(args.url, args.readyTimeoutMs).catch((error) => {
    throw new Error(`Frontend is not reachable at ${args.url}: ${error.message}`);
  });

  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-multi-chart-"));
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-precise-memory-info",
    "--disable-background-networking",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: false });

  let cdp;
  let tracingStarted = false;
  const traceEvents = [];
  const webSockets = [];
  const errors = { console: [], exceptions: [], network: [] };
  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`, args.readyTimeoutMs);
    const page = targets.find((target) => target.type === "page") || targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target");
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    cdp.on("Network.webSocketCreated", (event) => webSockets.push({ event: "created", atMs: Date.now(), requestId: event.requestId, url: event.url }));
    cdp.on("Network.webSocketClosed", (event) => webSockets.push({ event: "closed", atMs: Date.now(), requestId: event.requestId }));
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") errors.console.push({ atMs: Date.now(), args: (event.args || []).map((arg) => arg.value ?? arg.description ?? null) });
    });
    cdp.on("Runtime.exceptionThrown", (event) => errors.exceptions.push({ atMs: Date.now(), text: event.exceptionDetails?.text || "", description: event.exceptionDetails?.exception?.description || null }));
    cdp.on("Network.loadingFailed", (event) => {
      if (!event.canceled && event.errorText !== "net::ERR_ABORTED") errors.network.push({ atMs: Date.now(), type: event.type, errorText: event.errorText, blockedReason: event.blockedReason || null });
    });
    cdp.on("Tracing.dataCollected", (event) => traceEvents.push(...(event.value || [])));

    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("Page.enable"),
      cdp.send("Performance.enable"),
    ]);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initializationScript(bootstrap) });
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,blink.user_timing,loading,disabled-by-default-devtools.timeline",
      options: "record-as-much-as-possible",
      transferMode: "ReportEvents",
    });
    tracingStarted = true;
    await cdp.send("Page.bringToFront");
    const navigationStartedAt = Date.now();
    await cdp.send("Page.navigate", { url: args.url });
    const readiness = await waitForCapacityReady(cdp, args.cells, args.readyTimeoutMs);
    readiness.navigationToReadyMs = Date.now() - navigationStartedAt;

    await evaluate(cdp, `(() => {
      const state = window.__CANDLESCOPE_MULTI_CHART_CAPACITY__;
      if (state) { state.measuring = true; state.canvasAdded = 0; state.canvasRemoved = 0; state.longTasks = []; state.inputEvents = []; }
    })()`);
    const heapBefore = await cdp.send("Runtime.getHeapUsage");

    const rectangles = await evaluateJson(cdp, `() => Array.from(document.querySelectorAll('.multi-chart-cell')).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(20, rect.height / 2) };
    })`);
    for (const rectangle of rectangles || []) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rectangle.x, y: rectangle.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rectangle.x, y: rectangle.y, button: "left", clickCount: 1 });
      await wait(100);
    }
    await wait(args.durationMs);

    const measured = await evaluateJson(cdp, `() => {
      const state = window.__CANDLESCOPE_MULTI_CHART_CAPACITY__ || {};
      const cells = Array.from(document.querySelectorAll('.multi-chart-cell'));
      const webglCanvas = document.createElement('canvas');
      const gl = webglCanvas.getContext('webgl');
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        visibleCells: cells.length,
        cellIds: cells.map((cell) => cell.getAttribute('data-chart-cell-id')),
        statuses: cells.map((cell) => cell.querySelector('.multi-chart-cell-status')?.className || 'missing'),
        canvasCount: cells.reduce((count, cell) => count + cell.querySelectorAll('canvas').length, 0),
        canvasAdded: state.canvasAdded || 0,
        canvasRemoved: state.canvasRemoved || 0,
        longTasks: state.longTasks || [],
        inputEvents: state.inputEvents || [],
        display: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, devicePixelRatio, colorDepth: screen.colorDepth },
        webgl: { vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null, renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null },
        perf: window.__CANDLESCOPE_PERF__?.report?.() || null,
      };
    }`);
    const heapAfter = await cdp.send("Runtime.getHeapUsage");
    const backendAfter = await httpJson(`${args.backendUrl}/debug/capacity?include_database_hash=true`, args.readyTimeoutMs);
    const backendDebug = await httpJson(`${args.backendUrl}/debug/snapshot`, args.readyTimeoutMs);
    const socketSummary = classifyWebSockets(webSockets);
    const mapping = leaseMapping(backendBefore, backendAfter, bootstrap.expectedSeries);
    mapping.expectedSeries = bootstrap.expectedSeries.length;

    const screenshotPath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.png`);
    const tracePath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.trace.json`);
    const backendPath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.backend.json`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(backendPath, `${JSON.stringify({ capacity: backendAfter, debug: backendDebug }, null, 2)}\n`);

    const traceComplete = new Promise((resolve) => {
      const off = cdp.on("Tracing.tracingComplete", () => { off(); resolve(); });
    });
    await cdp.send("Tracing.end");
    await traceComplete;
    tracingStarted = false;
    fs.writeFileSync(tracePath, `${JSON.stringify({ traceEvents })}\n`);

    const debugVersion = await httpJson(`http://127.0.0.1:${debugPort}/json/version`);
    const hardware = buildHostProfile({
      browser: { product: debugVersion.Browser || null, protocolVersion: debugVersion["Protocol-Version"] || null, executable: chromePath },
      display: measured.display,
      webgl: measured.webgl,
      database: backendAfter.database,
    });
    fs.mkdirSync(path.dirname(path.resolve(args.hardwareOut)), { recursive: true });
    fs.writeFileSync(path.resolve(args.hardwareOut), `${JSON.stringify(hardware, null, 2)}\n`);

    const durationMinutes = args.durationMs / 60_000;
    const heapDelta = Number(heapAfter.usedSize || 0) - Number(heapBefore.usedSize || 0);
    const inputDurations = (measured.inputEvents || []).map((entry) => Number(entry.duration)).filter(Number.isFinite);
    const gate = evaluateCapacityResult({
      supported: true,
      requestedCells: args.cells,
      readiness,
      errors,
      backendAfter,
      mapping,
      canvasRemounts: measured.canvasRemoved || 0,
    });
    const evidence = {
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      git: gitSnapshot(),
      hardware: { profileSha256: hardware.profileSha256, profilePath: path.resolve(args.hardwareOut) },
      scenario: {
        id: args.scenario,
        windows: 1,
        cells: args.cells,
        expectedSeries: bootstrap.expectedSeries,
        expectedSymbols: bootstrap.expectedSymbols,
        durationMs: args.durationMs,
      },
      data: {
        databaseState: backendAfter.database?.state || "unknown",
        datasetSha256: backendAfter.database?.sha256 || null,
        database: backendAfter.database,
      },
      frontend: {
        readiness,
        heap: {
          beforeBytes: heapBefore.usedSize || 0,
          afterBytes: heapAfter.usedSize || 0,
          deltaBytes: heapDelta,
          deltaPct: heapBefore.usedSize > 0 ? Number(((heapDelta / heapBefore.usedSize) * 100).toFixed(3)) : null,
        },
        longTasks: {
          count: measured.longTasks.length,
          perMinute: durationMinutes > 0 ? Number((measured.longTasks.length / durationMinutes).toFixed(3)) : null,
          durationsMs: measured.longTasks.map((entry) => entry.duration),
        },
        inputResponse: { samples: inputDurations.length, p95Ms: percentile(inputDurations, 95), rawMs: inputDurations },
        reactCommits: { supported: false, reason: "React profiler is not enabled in the production build" },
        canvasRemounts: measured.canvasRemoved || 0,
        canvasAddsAfterReady: measured.canvasAdded || 0,
        klineWebSockets: socketSummary.kline.length,
        indicatorWebSockets: socketSummary.indicator.length,
        webSockets: socketSummary,
        perf: compactPerfSnapshot(measured.perf),
        errors,
      },
      backend: {
        activeSeries: backendAfter.dataManager?.activeSeries || 0,
        streamLeases: backendAfter.dataManager?.streamLeases || 0,
        eventLoopLag: backendAfter.runtime?.eventLoopLag || null,
        privateBytes: { supported: false, reason: "process private-bytes sampler is introduced at the long-soak gate" },
        backfill: compactBackendSnapshot(backendAfter).backfill,
        indicatorExecutor: backendAfter.executors?.indicator || null,
        before: compactBackendSnapshot(backendBefore),
        after: compactBackendSnapshot(backendAfter),
        scenarioMapping: mapping,
      },
      upstream: {
        physicalWebSockets: backendAfter.exchange?.physicalWebSockets || 0,
        physicalWebSocketDelta: (backendAfter.exchange?.physicalWebSockets || 0) - (backendBefore.exchange?.physicalWebSockets || 0),
        httpRequests: null,
        httpRequestsSupported: false,
        exchange: compactExchangeSnapshot(backendAfter.exchange || {}),
      },
      artifacts: { screenshot: screenshotPath, trace: tracePath, backendSnapshot: backendPath },
      gates: gate.checks,
      result: gate.result,
    };
    const validationErrors = validateCapacityEvidence(evidence);
    if (validationErrors.length) throw new Error(`Generated evidence is invalid: ${validationErrors.join("; ")}`);
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ out: path.resolve(args.out), result: evidence.result, gates: evidence.gates, artifacts: evidence.artifacts }, null, 2));
    if (evidence.result !== "pass") process.exitCode = 1;
  } finally {
    if (tracingStarted && cdp) await cdp.send("Tracing.end").catch(() => {});
    cdp?.close?.();
    await stopProcess(chrome);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Chrome can briefly retain profile files on Windows; they live in the OS temp tree.
    }
  }
}

function writeUnsupported(args) {
  const gate = evaluateCapacityResult({ supported: false, requestedCells: args.cells });
  const hardware = buildHostProfile({ browser: null, display: null, webgl: null, database: null });
  fs.mkdirSync(path.dirname(path.resolve(args.hardwareOut)), { recursive: true });
  fs.writeFileSync(path.resolve(args.hardwareOut), `${JSON.stringify(hardware, null, 2)}\n`);
  const evidence = {
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    git: gitSnapshot(),
    hardware: { profileSha256: hardware.profileSha256, profilePath: path.resolve(args.hardwareOut) },
    scenario: { id: args.scenario, windows: 1, cells: args.cells, durationMs: 0 },
    data: { databaseState: "not_measured", datasetSha256: null },
    frontend: { unsupportedReason: `Workspace schema v5 exposes at most ${CURRENT_PRODUCT_CELL_LIMIT} cells` },
    backend: { unsupportedReason: "Logical chart request was rejected before runtime measurement" },
    upstream: { physicalWebSockets: 0, httpRequests: 0 },
    artifacts: {},
    gates: gate.checks,
    result: gate.result,
  };
  const validationErrors = validateCapacityEvidence(evidence);
  if (validationErrors.length) throw new Error(`Generated unsupported evidence is invalid: ${validationErrors.join("; ")}`);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ out: path.resolve(args.out), result: "unsupported", gates: gate.checks }, null, 2));
  process.exitCode = 2;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.cells > CURRENT_PRODUCT_CELL_LIMIT) {
    writeUnsupported(args);
    return;
  }
  await runSupported(args);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
