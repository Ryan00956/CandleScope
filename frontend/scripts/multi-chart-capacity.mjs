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
export const CURRENT_PRODUCT_CELL_LIMIT = 16;
export const SUPPORTED_CELL_ARGUMENTS = Object.freeze([1, 2, 4, 8, 16]);
export const SUPPORTED_SCENARIOS = Object.freeze(["S1", "S2", "S3", "S4", "S5", "C1"]);
const EVIDENCE_SCENARIOS = new Set([
  ...SUPPORTED_SCENARIOS,
  "C1", "W1", "W2", "W3", "F1", "F2", "F3",
]);

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:18080";
const DEFAULT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const SYMBOLS = Object.freeze([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT",
  "TRXUSDT", "NEARUSDT", "APTUSDT", "FILUSDT",
]);
const INTERVALS = Object.freeze(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"]);

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
    requireDatabaseState: environment.MULTI_CHART_REQUIRE_DATABASE_STATE || "auto",
    workload: environment.MULTI_CHART_WORKLOAD || "observe",
    sampleMs: Number(environment.MULTI_CHART_SAMPLE_MS || 5_000),
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
    else if (value === "--require-database-state") args.requireDatabaseState = requireValue(argv, index++, value).toLowerCase();
    else if (value === "--workload") args.workload = requireValue(argv, index++, value).toLowerCase();
    else if (value === "--sample-ms") args.sampleMs = Number(requireValue(argv, index++, value));
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!SUPPORTED_CELL_ARGUMENTS.includes(args.cells)) {
    throw new Error(`--cells must be one of ${SUPPORTED_CELL_ARGUMENTS.join(", ")}`);
  }
  if (!SUPPORTED_SCENARIOS.includes(args.scenario)) {
    throw new Error(`--scenario must be one of ${SUPPORTED_SCENARIOS.join(", ")}`);
  }
  if (!["auto", "warm", "empty"].includes(args.requireDatabaseState)) {
    throw new Error("--require-database-state must be auto, warm, or empty");
  }
  if (!["observe", "soak"].includes(args.workload)) {
    throw new Error("--workload must be observe or soak");
  }
  if (!Number.isFinite(args.sampleMs) || args.sampleMs < 1_000) {
    throw new Error("--sample-ms must be at least 1000");
  }
  if (args.scenario === "C1" && args.requireDatabaseState === "auto") {
    args.requireDatabaseState = "empty";
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
  --scenario <S1|S2|S3|S4|S5|C1>
  --url <frontend-url>        Existing frontend origin
  --backend-url <url>         Existing backend origin
  --duration-ms <ms>          Measured duration after readiness (>=1000)
  --ready-timeout-ms <ms>     Readiness timeout (>=1000)
  --out <json-path>           Capacity evidence output
  --artifacts-dir <path>      Screenshot and trace directory
  --hardware-out <json-path>  Hardware profile output
  --chrome <path>             Chrome or Edge executable
  --require-database-state <auto|warm|empty>
  --workload <observe|soak>   Run observation only or the release interaction loop
  --sample-ms <ms>            Heap/backend sample period during soak (>=1000)`;
}

function scenarioCells(scenario, cellCount) {
  const cells = [];
  for (let index = 0; index < cellCount; index += 1) {
    const visibleIndex = index % Math.max(1, cellCount);
    const symbol = ["S3", "S4", "S5", "C1"].includes(scenario)
      ? SYMBOLS[visibleIndex % SYMBOLS.length]
      : SYMBOLS[0];
    const interval = scenario === "S2"
      ? INTERVALS[visibleIndex % INTERVALS.length]
      : INTERVALS[0];
    const indicators = ["S4", "C1"].includes(scenario)
      ? [
          // Indicator identifiers are cell-local. Use the real catalog ids so
          // the release interaction exercises the same remove/restore path as
          // a user-created workspace instead of an artificial unmatched id.
          { id: "ma", name: "MA", engineName: "MA", kind: "builtin", executionTarget: "local", params: { period: 20 }, visible: true },
          { id: "rsi", name: "RSI", engineName: "RSI", kind: "builtin", executionTarget: "local", params: { period: 14 }, visible: true },
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
      linkGroup: index < 2 ? "A" : null,
      linkRole: index === 0 ? "source" : index === 1 ? "destination" : "bidirectional",
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
  const columns = cellCount === 2 ? 2 : cellCount === 4 ? 2 : cellCount === 8 ? 4 : 4;
  const rows = cellCount / columns;
  const combine = (nodes, direction, prefix) => {
    if (nodes.length === 1) return nodes[0];
    const firstCount = Math.floor(nodes.length / 2);
    return {
      kind: "split",
      id: `${prefix}-${nodes.length}`,
      direction,
      ratio: firstCount / nodes.length,
      first: combine(nodes.slice(0, firstCount), direction, `${prefix}-first`),
      second: combine(nodes.slice(firstCount), direction, `${prefix}-second`),
    };
  };
  const rowNodes = Array.from({ length: rows }, (_, rowIndex) => combine(
    Array.from({ length: columns }, (_, columnIndex) => cell(rowIndex * columns + columnIndex + 1)),
    "columns",
    `capacity-row-${rowIndex + 1}`,
  ));
  return combine(rowNodes, "rows", "capacity-rows");
}

export function buildWorkspaceBootstrap({ cells, scenario, now = Date.now() }) {
  if (!SUPPORTED_CELL_ARGUMENTS.includes(cells) || cells > CURRENT_PRODUCT_CELL_LIMIT) {
    throw new Error(`Workspace schema v6 cannot represent ${cells} visible cells`);
  }
  const states = scenarioCells(scenario, cells);
  const windowState = {
    id: "main-window",
    layoutTree: layoutTree(cells),
    layoutLocked: true,
    activeCellId: "cell-1",
    maximizedCellId: null,
    boundsDip: null,
    monitorFingerprint: null,
    dpiScale: null,
    windowState: "normal",
  };
  const document = {
    schemaVersion: 6,
    revision: 1,
    activeWindowId: "main-window",
    windows: { "main-window": windowState },
    linkGroups: Object.fromEntries(["A", "B", "C", "D"].map((group) => [group, {
      market: group !== "A",
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
    name: `Phase 5 ${scenario} ${cells} Cell`,
    createdAt: now,
    updatedAt: now,
    document,
  };
  const expectedClaimsBySeries = Object.fromEntries(states.reduce((claims, state) => {
    const requestedKey = `${state.session.symbol}@${state.session.interval}`;
    claims.set(requestedKey, (claims.get(requestedKey) || 0) + 1);
    if (state.session.interval !== "1m") {
      const baseKey = `${state.session.symbol}@1m`;
      claims.set(baseKey, (claims.get(baseKey) || 0) + 1);
    }
    return claims;
  }, new Map()));
  const expectedLeaseClaimsBySeries = { ...expectedClaimsBySeries };
  for (const state of states) {
    const ownsHostedIndicatorStream = state.indicators.some((indicator) => (
      indicator.executionTarget === "hosted"
    ));
    if (!ownsHostedIndicatorStream) continue;
    const requestedKey = `${state.session.symbol}@${state.session.interval}`;
    expectedLeaseClaimsBySeries[requestedKey] = Number(
      expectedLeaseClaimsBySeries[requestedKey] || 0,
    ) + 1;
  }
  return {
    record,
    library: { activeWorkspaceId: record.id, workspaces: [record] },
    expectedSeries: Array.from(new Set(states.map((state) => (
      `${state.session.symbol}@${state.session.interval}`
    )))).sort(),
    expectedSymbols: Array.from(new Set(states.map((state) => state.session.symbol))).sort(),
    // K-line batch claims and DataManager lease claims differ only for hosted
    // indicators: each hosted series has one additional indicator-stream
    // owner, while local MA/RSI adds no backend lease.
    expectedClaimsBySeries,
    expectedLeaseClaimsBySeries,
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

export function findChrome(explicitPath) {
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

export async function connectWebSocket(url) {
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

export async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = response.result;
  if (result?.subtype === "error") throw new Error(result.description || "Runtime.evaluate failed");
  return result?.value;
}

export async function evaluateJson(cdp, expression) {
  const value = await evaluate(cdp, `JSON.stringify((${expression})())`);
  return typeof value === "string" ? JSON.parse(value) : null;
}

export async function evaluateAsyncJson(cdp, expression) {
  const value = await evaluate(cdp, `(async () => JSON.stringify(await (${expression})()))()`);
  return typeof value === "string" ? JSON.parse(value) : null;
}

export async function writeProtocolStream(cdp, streamHandle, outputPath) {
  if (!streamHandle) throw new Error("Tracing did not return an IO stream handle");
  const fileHandle = fs.openSync(outputPath, "w");
  try {
    while (true) {
      const chunk = await cdp.send("IO.read", {
        handle: streamHandle,
        size: 1024 * 1024,
      });
      const data = chunk.base64Encoded
        ? Buffer.from(chunk.data || "", "base64")
        : Buffer.from(chunk.data || "", "utf8");
      if (data.length > 0) fs.writeSync(fileHandle, data);
      if (chunk.eof) break;
    }
  } finally {
    fs.closeSync(fileHandle);
    await cdp.send("IO.close", { handle: streamHandle }).catch(() => {});
  }
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

export function eventLoopLagForWindow(before, after) {
  const beforeSequence = Number(before?.sample_sequence ?? before?.samples ?? 0);
  const samples = Array.isArray(after?.recent_samples)
    ? after.recent_samples
        .filter((sample) => Number(sample?.sequence) > beforeSequence)
        .map((sample) => Number(sample?.value_ms))
        .filter(Number.isFinite)
    : [];
  const hasAuthoritativeWindow = after?.window_after_sequence === beforeSequence;
  return {
    beforeSequence,
    afterSequence: Number(after?.sample_sequence ?? after?.samples ?? 0),
    samples,
    ...(hasAuthoritativeWindow ? {
      complete: after?.window_complete === true,
      sampleCount: Number(after?.window_sample_count || 0),
    } : {}),
    p99Ms: hasAuthoritativeWindow
      && after?.window_complete === true
      ? Number(after?.window_p99_ms)
      : samples.length > 0 ? percentile(samples, 99) : null,
  };
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
      longTasks: [], inputEvents: [], canvasAdded: 0, canvasRemoved: 0,
      canvasMutations: [], chartSurfaceAdded: 0, chartSurfaceRemoved: 0,
      chartSurfaceMutations: [], lastCanvasMutationAt: performance.now(),
      lastChartSurfaceMutationAt: performance.now(), measuring: false,
    };
    const recordCanvasMutation = (canvas, field) => {
      const now = performance.now();
      state[field] += 1;
      state.lastCanvasMutationAt = now;
      state.canvasMutations.push({
        atMs: Number(now.toFixed(3)),
        field,
        cellId: canvas.closest?.('.multi-chart-cell')?.getAttribute('data-chart-cell-id') || null,
        className: typeof canvas.className === 'string' ? canvas.className : null,
        parentClassName: typeof canvas.parentElement?.className === 'string'
          ? canvas.parentElement.className
          : null,
      });
      if (state.canvasMutations.length > 128) state.canvasMutations.splice(0, state.canvasMutations.length - 128);
    };
    const canvasesIn = (nodes) => {
      const canvases = [];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('canvas')) canvases.push(node);
        for (const canvas of node.querySelectorAll?.('canvas') || []) {
          canvases.push(canvas);
        }
      }
      return canvases;
    };
    const chartSurfacesIn = (nodes) => {
      const surfaces = [];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.tv-lightweight-charts')) surfaces.push(node);
        for (const surface of node.querySelectorAll?.('.tv-lightweight-charts') || []) {
          surfaces.push(surface);
        }
      }
      return surfaces;
    };
    const recordChartSurfaceMutation = (surface, field) => {
      const now = performance.now();
      state[field] += 1;
      state.lastChartSurfaceMutationAt = now;
      state.chartSurfaceMutations.push({
        atMs: Number(now.toFixed(3)),
        field,
        cellId: surface.closest?.('.multi-chart-cell')?.getAttribute('data-chart-cell-id') || null,
      });
      if (state.chartSurfaceMutations.length > 128) {
        state.chartSurfaceMutations.splice(0, state.chartSurfaceMutations.length - 128);
      }
    };
    new MutationObserver((records) => {
      const removed = [];
      const removedSurfaces = [];
      for (const record of records) {
        for (const canvas of canvasesIn(record.addedNodes)) {
          recordCanvasMutation(canvas, 'canvasAdded');
        }
        for (const surface of chartSurfacesIn(record.addedNodes)) {
          recordChartSurfaceMutation(surface, 'chartSurfaceAdded');
        }
        removed.push(...canvasesIn(record.removedNodes));
        removedSurfaces.push(...chartSurfacesIn(record.removedNodes));
      }
      // Moving a keyed Cell within the stable layout layer produces a
      // childList removal and insertion for the same connected DOM nodes.
      // Count only canvases that are actually detached after the complete
      // mutation batch; mount-token evidence below independently guards the
      // React component lifecycle.
      for (const canvas of removed) {
        if (!canvas.isConnected) recordCanvasMutation(canvas, 'canvasRemoved');
      }
      // Lightweight Charts owns one stable root per mounted chart instance.
      // Drawing and indicator panes legitimately replace their internal
      // canvases, so only a detached root is an actual chart remount.
      for (const surface of removedSurfaces) {
        if (!surface.isConnected) recordChartSurfaceMutation(surface, 'chartSurfaceRemoved');
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

export function isCapacityReadySnapshot(snapshot, cellCount) {
  const chartDataReady = snapshot?.marketDataReady?.every((ready) => ready === "true");
  return snapshot?.visibleCells === cellCount
    && snapshot.canvasCount >= cellCount
    && snapshot.chartSurfaceCount === cellCount
    && snapshot.chartSurfaceQuietMs >= 500
    && snapshot.documentVisibility === "visible"
    && chartDataReady;
}

export function isRealtimeSettledSnapshot(snapshot, cellCount) {
  return snapshot?.visibleCells === cellCount
    && snapshot?.statuses?.length === cellCount
    && snapshot.statuses.every((status) => /\b(live|fallback)\b/.test(status));
}

async function waitForCapacityReady(cdp, cellCount, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      latest = await evaluateJson(cdp, `() => {
        const cells = Array.from(document.querySelectorAll('.multi-chart-cell'));
        const statuses = cells.map((cell) => cell.querySelector('.multi-chart-cell-status')?.className || 'missing');
        const capacityState = window.__CANDLESCOPE_MULTI_CHART_CAPACITY__ || {};
        return {
          documentReady: document.readyState,
          documentVisibility: document.visibilityState,
          visibleCells: cells.length,
          cellIds: cells.map((cell) => cell.getAttribute('data-chart-cell-id')),
          marketDataReady: cells.map((cell) => cell.getAttribute('data-market-data-ready')),
          canvasQuietMs: Math.max(0, performance.now() - Number(capacityState.lastCanvasMutationAt || 0)),
          chartSurfaceQuietMs: Math.max(0, performance.now() - Number(capacityState.lastChartSurfaceMutationAt || 0)),
          canvasMutations: (capacityState.canvasMutations || []).slice(-32),
          chartSurfaceMutations: (capacityState.chartSurfaceMutations || []).slice(-32),
          statuses,
          canvasCount: cells.reduce((count, cell) => count + cell.querySelectorAll('canvas').length, 0),
          chartSurfaceCount: cells.reduce((count, cell) => count + cell.querySelectorAll('.tv-lightweight-charts').length, 0),
          errorText: Array.from(document.querySelectorAll('.error-message, .chart-error')).map((node) => node.textContent?.trim()).filter(Boolean),
        };
      }`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/navigated or closed|context.*destroyed|Cannot find context/i.test(message)) throw error;
      await wait(100);
      continue;
    }
    if (isCapacityReadySnapshot(latest, cellCount)) {
      return { ready: true, readyMs: Date.now() - startedAt, ...latest };
    }
    if (latest?.documentVisibility !== "visible") {
      await cdp.send("Page.bringToFront").catch(() => {});
    }
    // A 250 ms probe interval adds up to 249 ms of observer delay to the
    // readiness metric and is too coarse for a 3 s p95 gate. The readiness
    // contract itself (including 500 ms Canvas quiet time) is unchanged.
    await wait(50);
  }
  return { ready: false, readyMs: Date.now() - startedAt, ...(latest || {}) };
}

async function waitForRealtimeSettlement(cdp, cellCount, timeoutMs) {
  const startedAt = Date.now();
  const snapshot = await waitForBrowserValue(cdp, `() => {
    const cells = Array.from(document.querySelectorAll('.multi-chart-cell'));
    const statuses = cells.map((cell) => cell.querySelector('.multi-chart-cell-status')?.className || 'missing');
    return {
      ready: cells.length === ${cellCount}
        && statuses.length === ${cellCount}
        && statuses.every((status) => /\\b(live|fallback)\\b/.test(status)),
      visibleCells: cells.length,
      statuses,
    };
  }`, timeoutMs, "all K-line subscriptions to settle");
  return { ...snapshot, settledMs: Date.now() - startedAt };
}

async function waitForBrowserValue(cdp, expression, timeoutMs, description) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await evaluateJson(cdp, expression);
    if (latest?.ready === true) return latest;
    await wait(200);
  }
  throw new Error(`${description} did not become ready: ${JSON.stringify(latest)}`);
}

async function drawingDocumentStats(cdp) {
  return evaluateAsyncJson(cdp, `async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((item) => item.name === 'candlescope-drawings-v2')) {
      return { documents: 0, entities: 0 };
    }
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open('candlescope-drawings-v2');
      request.onerror = () => reject(request.error || new Error('drawing database open failed'));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('documents')) {
          database.close();
          resolve({ documents: 0, entities: 0 });
          return;
        }
        const transaction = database.transaction('documents', 'readonly');
        const read = transaction.objectStore('documents').getAll();
        read.onerror = () => reject(read.error || new Error('drawing document read failed'));
        read.onsuccess = () => {
          const records = Array.isArray(read.result) ? read.result : [];
          database.close();
          resolve({
            documents: records.length,
            entities: records.reduce((total, record) => total + Number(record?.document?.entities?.length || record?.entities?.length || 0), 0),
          });
        };
      };
    });
  }`);
}

async function runProductBoundaryDrill(cdp, cellCount, timeoutMs) {
  const beforeDrawings = await drawingDocumentStats(cdp);
  const mountTokensBefore = await evaluateJson(cdp, `() => Object.fromEntries(
    Array.from(document.querySelectorAll('.multi-chart-cell')).map((cell) => [
      cell.getAttribute('data-chart-cell-id'),
      cell.getAttribute('data-runtime-mount-token'),
    ]),
  )`);
  await evaluate(cdp, `document.querySelector('.multi-chart-cell[data-chart-cell-id="cell-1"]')?.click()`);
  const maximize = await evaluateJson(cdp, `() => {
    const button = document.querySelector('.multi-chart-cell[data-chart-cell-id="cell-1"] [aria-label="最大化图表"]');
    if (!(button instanceof HTMLButtonElement)) return { ready: false, reason: 'maximize button unavailable' };
    button.click();
    return { ready: true };
  }`);
  if (!maximize?.ready) throw new Error(`Boundary drill could not maximize cell-1: ${JSON.stringify(maximize)}`);
  const maximized = await waitForBrowserValue(cdp, `() => {
    const layers = Array.from(document.querySelectorAll('[data-layout-cell-id]'));
    return {
      ready: layers.length === ${cellCount} && layers.filter((node) => node.getAttribute('data-obscured') === 'true').length === ${Math.max(0, cellCount - 1)},
      mountedCells: layers.length,
      obscuredCells: layers.filter((node) => node.getAttribute('data-obscured') === 'true').length,
    };
  }`, timeoutMs, "maximized stable cell layer");

  const drawingReady = await waitForBrowserValue(cdp, `() => ({
    ready: document.querySelector('[data-drawing-toolbar-state="ready"] [data-drawing-tool="pen"]:not([disabled])') instanceof HTMLButtonElement,
  })`, timeoutMs, "drawing toolbar");
  if (!drawingReady.ready) throw new Error("Drawing toolbar was not ready");
  await evaluate(cdp, `document.querySelector('[data-drawing-tool="pen"]')?.click()`);
  const drawingRect = await evaluateJson(cdp, `() => {
    const host = document.querySelector('.multi-chart-cell[data-chart-cell-id="cell-1"] .multi-chart-cell-canvas');
    if (!(host instanceof HTMLElement)) return null;
    const rect = host.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }`);
  if (!drawingRect || drawingRect.width < 100 || drawingRect.height < 100) {
    throw new Error(`Drawing host is too small: ${JSON.stringify(drawingRect)}`);
  }
  const drawingPoints = [
    { x: drawingRect.left + drawingRect.width * 0.25, y: drawingRect.top + drawingRect.height * 0.35 },
    { x: drawingRect.left + drawingRect.width * 0.40, y: drawingRect.top + drawingRect.height * 0.45 },
    { x: drawingRect.left + drawingRect.width * 0.55, y: drawingRect.top + drawingRect.height * 0.40 },
  ];
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...drawingPoints[0], button: "left", clickCount: 1 });
  for (const point of drawingPoints.slice(1)) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1 });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...drawingPoints.at(-1), button: "left", clickCount: 1 });
  await wait(2_000);
  const afterDrawings = await drawingDocumentStats(cdp);

  const exportOpen = await evaluateJson(cdp, `() => {
    const button = document.querySelector('[data-drawing-action="export"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return { ready: false };
    button.click();
    return { ready: true };
  }`);
  if (!exportOpen?.ready) throw new Error("Export action was unavailable");
  const exportPanel = await waitForBrowserValue(cdp, `() => ({
    ready: document.querySelector('[role="dialog"][aria-label="截图导出设置"]') instanceof HTMLElement,
  })`, timeoutMs, "export panel");
  await evaluate(cdp, `document.querySelector('[aria-label="关闭导出面板"]')?.click()`);

  await evaluate(cdp, `document.querySelector('.multi-chart-cell[data-chart-cell-id="cell-1"] [aria-label="还原图表"]')?.click()`);
  const restored = await waitForBrowserValue(cdp, `() => {
    const layers = Array.from(document.querySelectorAll('[data-layout-cell-id]'));
    return {
      ready: layers.length === ${cellCount} && layers.every((node) => node.getAttribute('data-obscured') === 'false'),
      mountedCells: layers.length,
      obscuredCells: layers.filter((node) => node.getAttribute('data-obscured') === 'true').length,
    };
  }`, timeoutMs, "restored stable cell layer");

  const unlocked = await evaluateJson(cdp, `() => {
    const root = document.querySelector('.multi-chart-grid');
    if (root?.getAttribute('data-layout-locked') !== 'true') return { ready: true, changed: false };
    const button = document.querySelector('[aria-label="解锁布局"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return { ready: false, changed: false };
    button.click();
    return { ready: true, changed: true };
  }`);
  if (!unlocked?.ready) throw new Error("Layout lock could not be released for the drag boundary drill");
  await waitForBrowserValue(cdp, `() => ({
    ready: document.querySelector('.multi-chart-grid')?.getAttribute('data-layout-locked') === 'false',
  })`, timeoutMs, "unlocked layout");

  const dragBefore = await evaluateJson(cdp, `() => Object.fromEntries(Array.from(document.querySelectorAll('[data-layout-cell-id]')).slice(0, 2).map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.getAttribute('data-layout-cell-id'), { left: rect.left, top: rect.top }];
  }))`);
  const dragRects = await evaluateJson(cdp, `() => {
    const handle = document.querySelector('.multi-chart-cell[data-chart-cell-id="cell-1"] .multi-chart-cell-drag-handle');
    const target = document.querySelector('[data-layout-cell-id="cell-2"]');
    if (!(handle instanceof HTMLElement) || !(target instanceof HTMLElement)) return null;
    const sourceRect = handle.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      source: { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 },
      target: { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 },
    };
  }`);
  if (!dragRects) throw new Error("Layout drag handles were unavailable");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...dragRects.source, button: "left", clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dragRects.source.x + ((dragRects.target.x - dragRects.source.x) * step) / 8,
      y: dragRects.source.y + ((dragRects.target.y - dragRects.source.y) * step) / 8,
      button: "left",
      buttons: 1,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...dragRects.target, button: "left", clickCount: 1 });
  await wait(800);
  const dragAfter = await evaluateJson(cdp, `() => Object.fromEntries(Array.from(document.querySelectorAll('[data-layout-cell-id]')).slice(0, 2).map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.getAttribute('data-layout-cell-id'), { left: rect.left, top: rect.top }];
  }))`);
  const dragSwapped = Boolean(
    dragBefore?.["cell-1"] && dragBefore?.["cell-2"] && dragAfter?.["cell-1"] && dragAfter?.["cell-2"]
    && dragBefore["cell-1"].left === dragAfter["cell-2"].left
    && dragBefore["cell-1"].top === dragAfter["cell-2"].top
    && dragBefore["cell-2"].left === dragAfter["cell-1"].left
    && dragBefore["cell-2"].top === dragAfter["cell-1"].top
  );
  const mountTokensAfter = await evaluateJson(cdp, `() => Object.fromEntries(
    Array.from(document.querySelectorAll('.multi-chart-cell')).map((cell) => [
      cell.getAttribute('data-chart-cell-id'),
      cell.getAttribute('data-runtime-mount-token'),
    ]),
  )`);
  const stableMountTokens = Object.keys(mountTokensBefore || {}).length === cellCount
    && Object.keys(mountTokensAfter || {}).length === cellCount
    && Object.entries(mountTokensBefore || {}).every(([cellId, token]) => (
      mountTokensAfter?.[cellId] === token
    ));

  return {
    supported: true,
    maximized,
    restored,
    drawing: {
      before: beforeDrawings,
      after: afterDrawings,
      persistedEntityDelta: Number(afterDrawings?.entities || 0) - Number(beforeDrawings?.entities || 0),
    },
    export: { panelOpened: exportPanel.ready === true },
    layoutLock: { releasedForDrag: unlocked.changed === true },
    layoutDrag: { before: dragBefore, after: dragAfter, swapped: dragSwapped },
    mountTokens: { before: mountTokensBefore, after: mountTokensAfter, stable: stableMountTokens },
  };
}

async function selectSymbolThroughUi(cdp, symbol, timeoutMs) {
  await evaluate(cdp, `document.querySelector('#symbol-selector')?.click()`);
  await waitForBrowserValue(cdp, `() => ({
    ready: document.querySelector('.sym-modal-search-input') instanceof HTMLInputElement,
  })`, timeoutMs, "symbol search input");
  await evaluate(cdp, `(() => {
    const input = document.querySelector('.sym-modal-search-input');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(symbol)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitForBrowserValue(cdp, `() => {
    const pair = Array.from(document.querySelectorAll('.sym-modal-row-pair')).find((node) => {
      const ownText = Array.from(node.childNodes).filter((item) => item.nodeType === Node.TEXT_NODE).map((item) => item.textContent || '').join('').trim();
      return ownText === ${JSON.stringify(symbol)};
    });
    return { ready: pair instanceof HTMLElement };
  }`, timeoutMs, `symbol result ${symbol}`);
  const selected = await evaluate(cdp, `(() => {
    const pair = Array.from(document.querySelectorAll('.sym-modal-row-pair')).find((node) => {
      const ownText = Array.from(node.childNodes).filter((item) => item.nodeType === Node.TEXT_NODE).map((item) => item.textContent || '').join('').trim();
      return ownText === ${JSON.stringify(symbol)};
    });
    const row = pair?.closest('.sym-modal-row');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`);
  if (selected !== true) throw new Error(`Could not select ${symbol} through the symbol UI`);
  await waitForBrowserValue(cdp, `() => ({
    ready: document.querySelector('#symbol-selector .symbol-name')?.textContent?.trim() === ${JSON.stringify(symbol)},
  })`, timeoutMs, `active symbol ${symbol}`);
}

async function performSoakInteraction(cdp, iteration, cellCount, timeoutMs) {
  const cellId = `cell-${(iteration % cellCount) + 1}`;
  const actions = [];
  const failures = [];
  const runAction = async (name, action) => {
    try {
      await action();
      actions.push(name);
    } catch (error) {
      failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  };

  await runAction("activate-cell", async () => {
    const activated = await evaluate(cdp, `(() => {
      const cell = document.querySelector('.multi-chart-cell[data-chart-cell-id="${cellId}"]');
      if (!(cell instanceof HTMLElement)) return false;
      cell.click();
      return true;
    })()`);
    if (activated !== true) throw new Error(`${cellId} is unavailable`);
    await wait(250);
  });

  await runAction("interval-cycle", async () => {
    for (const interval of ["5m", "1m"]) {
      const switched = await evaluate(cdp, `(() => {
        const button = document.querySelector('#interval-${interval}');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      })()`);
      if (switched !== true) throw new Error(`${interval} interval is unavailable`);
      await wait(600);
    }
  });

  if (iteration % 4 === 0) {
    await runAction("maximize-restore", async () => {
      const maximized = await evaluate(cdp, `(() => {
        const button = document.querySelector('.multi-chart-cell[data-chart-cell-id="${cellId}"] [aria-label="最大化图表"]');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      if (maximized !== true) throw new Error("maximize button unavailable");
      await wait(500);
      const restored = await evaluate(cdp, `(() => {
        const button = document.querySelector('.multi-chart-cell[data-chart-cell-id="${cellId}"] [aria-label="还原图表"]');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      if (restored !== true) throw new Error("restore button unavailable");
      await wait(500);
    });
  }

  if (iteration % 6 === 0) {
    await runAction("indicator-remove-add", async () => {
      await evaluate(cdp, `document.querySelector('.indicator-toggle-btn[title="指标 (Indicators)"]')?.click()`);
      await waitForBrowserValue(cdp, `() => ({
        ready: Boolean(document.querySelector('.indicator-tab-bar')),
      })`, timeoutMs, "indicator panel");
      await evaluate(cdp, `(() => {
        const tab = Array.from(document.querySelectorAll('.indicator-tab')).find((item) => item.textContent?.includes('指标库'));
        if (tab instanceof HTMLButtonElement && !tab.classList.contains('active')) tab.click();
      })()`);
      await waitForBrowserValue(cdp, `() => ({
        ready: Boolean(document.querySelector('.indicator-preset-item[data-indicator-id="ma"] .indicator-add-btn.added')),
      })`, timeoutMs, "MA indicator preset");
      for (let toggle = 0; toggle < 2; toggle += 1) {
        const toggled = await evaluate(cdp, `(() => {
          const button = document.querySelector('.indicator-preset-item[data-indicator-id="ma"] .indicator-add-btn');
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        })()`);
        if (toggled !== true) throw new Error("MA indicator toggle unavailable");
        const expectedAdded = toggle === 1;
        await waitForBrowserValue(cdp, `() => {
          const button = document.querySelector('.indicator-preset-item[data-indicator-id="ma"] .indicator-add-btn');
          return { ready: button instanceof HTMLButtonElement && button.classList.contains('added') === ${expectedAdded} };
        }`, timeoutMs, expectedAdded ? "MA indicator restored" : "MA indicator removed");
      }
      await evaluate(cdp, `document.querySelector('.indicator-panel-close')?.click()`);
    });
  }

  if (iteration % 8 === 0) {
    await runAction("symbol-cycle", async () => {
      const original = await evaluate(cdp, `document.querySelector('#symbol-selector .symbol-name')?.textContent?.trim() || null`);
      if (typeof original !== "string" || !original) throw new Error("active symbol unavailable");
      const alternate = original === "BTCUSDT" ? "ETHUSDT" : "BTCUSDT";
      await selectSymbolThroughUi(cdp, alternate, timeoutMs);
      await wait(800);
      await selectSymbolThroughUi(cdp, original, timeoutMs);
      await wait(800);
    });
  }
  return { iteration, cellId, actions, failures };
}

async function waitForBackendQuiescence(args, timeoutMs) {
  const startedAt = Date.now();
  let consecutiveIdleSnapshots = 0;
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await httpJson(
      `${args.backendUrl}/debug/capacity?detail_limit=0`,
      Math.min(args.readyTimeoutMs, 10_000),
    );
    const idle = Number(latest?.backfill?.activeRequests || 0) === 0
      && Number(latest?.backfill?.pendingRequests || 0) === 0
      && Number(latest?.backfill?.runningChunks || 0) === 0
      && Number(latest?.executors?.storage?.pending || 0) === 0;
    consecutiveIdleSnapshots = idle ? consecutiveIdleSnapshots + 1 : 0;
    if (consecutiveIdleSnapshots >= 3) {
      return { durationMs: Date.now() - startedAt, snapshots: consecutiveIdleSnapshots, capacity: latest };
    }
    await wait(1_000);
  }
  throw new Error(`Backend did not become quiescent before the soak baseline: ${JSON.stringify({
    backfill: latest?.backfill || null,
    storageExecutor: latest?.executors?.storage || null,
  })}`);
}

async function runSoakPrecondition(cdp, args) {
  if (args.workload !== "soak") return null;
  const startedAt = Date.now();
  const actions = [];
  for (let iteration = 0; iteration < args.cells; iteration += 1) {
    const result = await performSoakInteraction(cdp, iteration, args.cells, args.readyTimeoutMs);
    actions.push(result);
    if (result.failures.length) {
      throw new Error(`Soak preconditioning failed: ${JSON.stringify(result.failures)}`);
    }
  }
  const readiness = await waitForCapacityReady(cdp, args.cells, args.readyTimeoutMs);
  const quiescence = await waitForBackendQuiescence(
    args,
    Math.max(args.readyTimeoutMs, 120_000),
  );
  const stabilizationMs = args.durationMs >= 30 * 60_000 ? 120_000 : 0;
  const stabilizationStartedAt = Date.now();
  while (Date.now() - stabilizationStartedAt < stabilizationMs) {
    // Warm the same read-only diagnostics path used by the release sampler so
    // Python/ORJSON allocator arenas and steady live-stream buffers are part
    // of the baseline, not reported as a leak in minute one.
    await httpJson(
      `${args.backendUrl}/debug/capacity?detail_limit=0`,
      Math.min(args.readyTimeoutMs, 10_000),
    );
    await wait(Math.min(5_000, stabilizationMs - (Date.now() - stabilizationStartedAt)));
  }
  const stabilized = stabilizationMs > 0
    ? await waitForBackendQuiescence(args, Math.max(args.readyTimeoutMs, 120_000))
    : quiescence;
  return {
    durationMs: Date.now() - startedAt,
    actionCount: actions.length,
    actionNames: [...new Set(actions.flatMap((entry) => entry.actions))].sort(),
    readiness,
    stabilizationMs,
    quiescence: {
      durationMs: stabilized.durationMs,
      cacheSeries: Number(stabilized.capacity?.dataManager?.cacheSeries || 0),
      cacheBars: Number(stabilized.capacity?.dataManager?.cacheBars || 0),
      privateBytes: Number(stabilized.capacity?.runtime?.processMemory?.privateBytes || 0),
    },
  };
}

export function seriesAnalysis(samples, field) {
  const values = samples
    .filter((sample) => sample[field] !== null && sample[field] !== undefined)
    .map((sample) => Number(sample[field]))
    .filter(Number.isFinite);
  if (values.length < 2) {
    return { samples: values.length, start: values[0] ?? null, end: values.at(-1) ?? null, deltaPct: null, finalWindowDeltaPct: null, plateau: false };
  }
  const start = values[0];
  const end = values.at(-1);
  const finalWindow = values.slice(Math.max(0, Math.floor(values.length * 0.8)));
  const finalStart = finalWindow[0];
  const finalEnd = finalWindow.at(-1);
  const deltaPct = start > 0 ? ((end - start) / start) * 100 : null;
  const finalWindowDeltaPct = finalStart > 0 ? ((finalEnd - finalStart) / finalStart) * 100 : null;
  return {
    samples: values.length,
    start,
    end,
    min: Math.min(...values),
    max: Math.max(...values),
    deltaPct: deltaPct === null ? null : Number(deltaPct.toFixed(3)),
    finalWindowDeltaPct: finalWindowDeltaPct === null ? null : Number(finalWindowDeltaPct.toFixed(3)),
    plateau: finalWindowDeltaPct !== null && finalWindowDeltaPct <= 5,
  };
}

async function runMeasuredWindow(cdp, args, eventLoopLagBaseline) {
  if (args.workload !== "soak") {
    await wait(args.durationMs);
    return { mode: "observe", samples: [], actions: [], reconnects: [], actionFailures: [], analysis: null };
  }
  const startedAt = Date.now();
  let nextSampleAt = startedAt;
  let nextActionAt = startedAt;
  let nextReconnectAt = startedAt + 15 * 60_000;
  let nextRetainedHeapAt = startedAt;
  const retainedHeapIntervalMs = Math.max(60_000, Math.min(6 * 60_000, Math.floor(args.durationMs / 10)));
  let iteration = 0;
  const samples = [];
  const actions = [];
  const reconnects = [];
  while (Date.now() - startedAt < args.durationMs) {
    const now = Date.now();
    if (now >= nextActionAt) {
      const result = await performSoakInteraction(cdp, iteration, args.cells, args.readyTimeoutMs);
      actions.push({ atMs: now - startedAt, ...result });
      iteration += 1;
      nextActionAt = now + 30_000;
    }
    if (now >= nextReconnectAt) {
      const reconnectStartedAt = Date.now();
      try {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
        await wait(2_000);
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        reconnects.push({ atMs: reconnectStartedAt - startedAt, atEpochMs: reconnectStartedAt, offlineMs: Date.now() - reconnectStartedAt, restored: true });
      } catch (error) {
        reconnects.push({ atMs: reconnectStartedAt - startedAt, atEpochMs: reconnectStartedAt, restored: false, error: error instanceof Error ? error.message : String(error) });
      }
      nextReconnectAt += 15 * 60_000;
    }
    if (now >= nextSampleAt) {
      let heapRetainedBytes = null;
      if (now >= nextRetainedHeapAt) {
        await cdp.send("HeapProfiler.collectGarbage");
        const retainedHeap = await cdp.send("Runtime.getHeapUsage");
        heapRetainedBytes = Number(retainedHeap.usedSize || 0);
        nextRetainedHeapAt = now + retainedHeapIntervalMs;
      }
      const heap = await cdp.send("Runtime.getHeapUsage");
      let backend = null;
      let backendError = null;
      try {
        backend = await httpJson(`${args.backendUrl}/debug/capacity?detail_limit=0`, Math.min(args.readyTimeoutMs, 10_000));
      } catch (error) {
        backendError = error instanceof Error ? error.message : String(error);
      }
      const browser = await evaluateJson(cdp, `() => ({
        visibleCells: document.querySelectorAll('.multi-chart-cell').length,
        render: window.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__?.snapshot?.() || null,
        broker: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.() || null,
      })`);
      samples.push({
        atMs: now - startedAt,
        heapUsedBytes: Number(heap.usedSize || 0),
        heapRetainedBytes,
        backendPrivateBytes: Number(backend?.runtime?.processMemory?.privateBytes || 0),
        backendRssBytes: Number(backend?.runtime?.processMemory?.rssBytes || 0),
        eventLoopLagP99Ms: eventLoopLagForWindow(
          eventLoopLagBaseline,
          backend?.runtime?.eventLoopLag,
        ).p99Ms,
        activeSeries: Number(backend?.dataManager?.activeSeries || 0),
        streamLeases: Number(backend?.dataManager?.streamLeases || 0),
        batchLogicalSubscriptions: Number(backend?.klineBatch?.logical_subscriptions || 0),
        batchOutboxDepth: Number(backend?.klineBatch?.outbox_depth || 0),
        batchAuthoritativeTimeouts: Number(backend?.klineBatch?.outbox_authoritative_timeouts || 0),
        activeBackfills: Number(backend?.backfill?.activeRequests || 0),
        pendingBackfills: Number(backend?.backfill?.pendingRequests || 0),
        cacheSeries: Number(backend?.dataManager?.cacheSeries || 0),
        cacheBars: Number(backend?.dataManager?.cacheBars || 0),
        visibleCells: Number(browser?.visibleCells || 0),
        totalReactRenders: Number(browser?.render?.totalReactRenders || 0),
        totalDomCommits: Number(browser?.render?.totalDomCommits || 0),
        backendError,
      });
      nextSampleAt = now + args.sampleMs;
    }
    const nextDue = Math.min(nextSampleAt, nextActionAt, nextReconnectAt, startedAt + args.durationMs);
    await wait(Math.max(25, Math.min(1_000, nextDue - Date.now())));
  }
  if (samples.length) {
    await cdp.send("HeapProfiler.collectGarbage");
    const retainedHeap = await cdp.send("Runtime.getHeapUsage");
    samples.push({
      ...samples.at(-1),
      atMs: Date.now() - startedAt,
      heapUsedBytes: Number(retainedHeap.usedSize || 0),
      heapRetainedBytes: Number(retainedHeap.usedSize || 0),
      finalRetainedHeapCheckpoint: true,
    });
  }
  const actionFailures = actions.flatMap((entry) => entry.failures.map((failure) => ({
    atMs: entry.atMs,
    iteration: entry.iteration,
    cellId: entry.cellId,
    ...failure,
  })));
  return {
    mode: "soak",
    durationMs: Date.now() - startedAt,
    sampleMs: args.sampleMs,
    samples,
    actions,
    reconnects,
    actionFailures,
    analysis: {
      heap: seriesAnalysis(samples, "heapRetainedBytes"),
      rawHeap: seriesAnalysis(samples, "heapUsedBytes"),
      privateBytes: seriesAnalysis(samples, "backendPrivateBytes"),
      rss: seriesAnalysis(samples, "backendRssBytes"),
      maxEventLoopLagP99Ms: Math.max(
        0,
        ...samples.map((sample) => sample.eventLoopLagP99Ms).filter(Number.isFinite),
      ),
      maxActiveSeries: Math.max(0, ...samples.map((sample) => sample.activeSeries)),
      maxStreamLeases: Math.max(0, ...samples.map((sample) => sample.streamLeases)),
      maxBatchOutboxDepth: Math.max(0, ...samples.map((sample) => sample.batchOutboxDepth)),
      authoritativeTimeouts: Math.max(0, ...samples.map((sample) => sample.batchAuthoritativeTimeouts)),
      backendSampleErrors: samples.filter((sample) => sample.backendError !== null).length,
      visibleCellViolations: samples.filter((sample) => sample.visibleCells !== args.cells).length,
    },
  };
}

function classifyWebSockets(records) {
  const created = records.filter((record) => record.event === "created");
  const kline = created.filter((record) => /\/stream\/klines(?:_multi|_batch)?(?:\?|$)/.test(record.url));
  const indicator = created.filter((record) => /\/stream\/indicators(?:\?|$)/.test(record.url));
  const peakActive = (matching) => {
    const ids = new Set(matching.map((record) => record.requestId));
    const active = new Set();
    let peak = 0;
    for (const record of records) {
      if (!ids.has(record.requestId)) continue;
      if (record.event === "created") active.add(record.requestId);
      else if (record.event === "closed") active.delete(record.requestId);
      peak = Math.max(peak, active.size);
    }
    return peak;
  };
  return {
    all: created,
    kline,
    indicator,
    klinePeakActive: peakActive(kline),
    indicatorPeakActive: peakActive(indicator),
    other: created.filter((record) => !kline.includes(record) && !indicator.includes(record)),
  };
}

export function leaseMapping(before, after, expectedSeries, expectedClaimsBySeries, batchEnabled) {
  const beforeMap = before?.dataManager?.directSubscriptionsBySeries || {};
  const afterMap = after?.dataManager?.directSubscriptionsBySeries || {};
  const bySeries = Object.fromEntries(expectedSeries.map((series) => [series, {
    before: Number(beforeMap[series] || 0),
    after: Number(afterMap[series] || 0),
    delta: Number(afterMap[series] || 0) - Number(beforeMap[series] || 0),
    expectedDelta: batchEnabled ? Number(expectedClaimsBySeries[series] || 0) : 1,
  }]));
  // Batch client identities are stable and replace an immediately preceding
  // browser session without requiring the shared DataManager lease count to
  // drop to zero between CDP runs. The invariant is therefore the absolute
  // active claim count. Legacy per-socket evidence still uses a delta because
  // its consumer identity is not stable across runs.
  const observedClaims = (series) => (
    batchEnabled ? bySeries[series].after : bySeries[series].delta
  );
  const claimMismatches = expectedSeries.filter((series) => (
    observedClaims(series) !== bySeries[series].expectedDelta
  ));
  return {
    bySeries,
    observedSeries: expectedSeries.filter((series) => bySeries[series].after > 0).length,
    leases: expectedSeries.reduce((total, series) => total + Math.max(0, observedClaims(series)), 0),
    duplicateSeries: expectedSeries.filter((series) => observedClaims(series) > bySeries[series].expectedDelta),
    missingSeries: expectedSeries.filter((series) => observedClaims(series) < bySeries[series].expectedDelta),
    claimMismatches,
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
      summary: backfill.summary || null,
      detail: backfill.detail || null,
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
    limits: snapshot?.limits || null,
    klineBatch: snapshot?.klineBatch || null,
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
  backgroundSuppression,
  releaseMetrics = null,
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
    realtimeSubscriptionsSettled: {
      actual: {
        settled: readiness.realtimeSettled ?? false,
        statuses: readiness.realtimeStatuses ?? [],
      },
      expected: `${requestedCells} live or explicit polling fallback subscriptions`,
      passed: readiness.realtimeSettled === true,
    },
    documentVisible: { actual: readiness.documentVisibility || null, expected: "visible", passed: readiness.documentVisibility === "visible" },
    consoleErrors: { actual: errors.console.length, expected: 0, passed: errors.console.length === 0 },
    runtimeExceptions: { actual: errors.exceptions.length, expected: 0, passed: errors.exceptions.length === 0 },
    networkFailures: { actual: errors.network.length, expected: 0, passed: errors.network.length === 0 },
    backendSnapshot: { actual: backendAfter?.schemaVersion || null, expected: "candlescope.backend.capacity/1", passed: backendAfter?.ok === true },
    expectedBackendSeries: { actual: mapping.observedSeries, expected: mapping.expectedSeries, passed: mapping.observedSeries === mapping.expectedSeries },
    duplicateBackendLease: { actual: mapping.duplicateSeries, expected: [], passed: mapping.duplicateSeries.length === 0 },
    exactBackendLeaseClaims: { actual: mapping.claimMismatches, expected: [], passed: mapping.claimMismatches.length === 0 },
    canvasRemounts: { actual: canvasRemounts, expected: 0, passed: canvasRemounts === 0 },
    backgroundSuppression: {
      actual: backgroundSuppression || null,
      expected: { hidden: true, allMinimized: true, formingDelta: 0, previewDelta: 0, pendingFrames: 0 },
      passed: backgroundSuppression?.hidden === true
        && backgroundSuppression?.allMinimized === true
        && backgroundSuppression?.formingDelta === 0
        && backgroundSuppression?.previewDelta === 0
        && backgroundSuppression?.pendingFrames === 0,
    },
  };
  if (releaseMetrics) {
    const hotScenario = releaseMetrics.scenario !== "C1";
    checks.hotReadyP95 = {
      actual: releaseMetrics.readyMs,
      expected: hotScenario ? "<= 3000 ms" : "reported separately for cold C1",
      passed: hotScenario ? releaseMetrics.readyMs <= 3_000 : true,
    };
    checks.inputResponseP95 = {
      actual: releaseMetrics.inputP95Ms,
      expected: "<= 100 ms",
      passed: releaseMetrics.inputP95Ms !== null && releaseMetrics.inputP95Ms <= 100,
    };
    checks.longTasksPerMinute = {
      actual: releaseMetrics.longTasksPerMinute,
      expected: "<= 5/min",
      passed: releaseMetrics.longTasksPerMinute <= 5,
    };
    checks.backendEventLoopLagP99 = {
      actual: releaseMetrics.eventLoopLagP99Ms,
      expected: "<= 50 ms",
      passed: releaseMetrics.eventLoopLagP99Ms !== null
        && releaseMetrics.eventLoopLagP99Ms <= 50,
    };
    checks.batchBrowserPhysicalKlineSockets = {
      actual: releaseMetrics.klineSockets,
      expected: releaseMetrics.batchEnabled ? 1 : ">= 1 on legacy fallback",
      passed: releaseMetrics.batchEnabled
        ? releaseMetrics.klineSockets === 1
        : releaseMetrics.klineSockets >= 1,
    };
    checks.batchLogicalClients = {
      actual: releaseMetrics.batchSnapshot?.logical_clients ?? null,
      expected: releaseMetrics.batchEnabled ? requestedCells : "not applicable",
      passed: !releaseMetrics.batchEnabled
        || releaseMetrics.batchSnapshot?.logical_clients === requestedCells,
    };
    checks.batchLogicalSubscriptions = {
      actual: releaseMetrics.batchSnapshot?.logical_subscriptions ?? null,
      expected: releaseMetrics.batchEnabled
        ? releaseMetrics.expectedLogicalSubscriptions
        : "not applicable",
      passed: !releaseMetrics.batchEnabled
        || releaseMetrics.batchSnapshot?.logical_subscriptions
          === releaseMetrics.expectedLogicalSubscriptions,
    };
    checks.batchAuthoritativeTimeouts = {
      actual: releaseMetrics.batchSnapshot?.outbox_authoritative_timeouts ?? 0,
      expected: 0,
      passed: Number(releaseMetrics.batchSnapshot?.outbox_authoritative_timeouts || 0) === 0,
    };
    const linkCounts = releaseMetrics.linkDrill?.snapshot?.counts;
    checks.linkBoundary = {
      actual: linkCounts || releaseMetrics.linkDrill || null,
      expected: "crosshair and date-range delivered to the linked destination",
      passed: releaseMetrics.linkDrill?.supported === true
        && Number(linkCounts?.crosshairTargetDeliveries || 0) >= 1
        && Number(linkCounts?.dateRangePublishes || 0) >= 1
        && Number(linkCounts?.viewportTargetDeliveries || 0) >= 1,
    };
    if (releaseMetrics.scenario === "S4") {
      const boundary = releaseMetrics.productBoundaryDrill;
      checks.productBoundaryDrill = {
        actual: boundary || null,
        expected: "stable maximize/restore, persisted drawing, export panel, and drag swap",
        passed: boundary?.supported === true
          && boundary.maximized?.mountedCells === requestedCells
          && boundary.maximized?.obscuredCells === requestedCells - 1
          && boundary.restored?.mountedCells === requestedCells
          && boundary.restored?.obscuredCells === 0
          && boundary.drawing?.persistedEntityDelta >= 1
          && boundary.export?.panelOpened === true
          && boundary.layoutDrag?.swapped === true
          && boundary.mountTokens?.stable === true,
      };
    }
    if (releaseMetrics.measuredWindow?.mode === "soak") {
      const measuredWindow = releaseMetrics.measuredWindow;
      const actionNames = new Set(measuredWindow.actions.flatMap((entry) => entry.actions));
      checks.soakInteractions = {
        actual: {
          actionCount: measuredWindow.actions.length,
          actionNames: [...actionNames].sort(),
          failures: measuredWindow.actionFailures,
        },
        expected: "interval, symbol, maximize, and indicator cycles with zero failures",
        passed: measuredWindow.actionFailures.length === 0
          && ["interval-cycle", "symbol-cycle", "maximize-restore", "indicator-remove-add"]
            .every((name) => actionNames.has(name)),
      };
      checks.soakSampling = {
        actual: measuredWindow.analysis,
        expected: "no backend sample errors, visibility violations, or authoritative outbox timeouts",
        passed: measuredWindow.analysis?.backendSampleErrors === 0
          && measuredWindow.analysis?.visibleCellViolations === 0
          && measuredWindow.analysis?.authoritativeTimeouts === 0,
      };
      if (releaseMetrics.durationMs >= 60 * 60_000) {
        checks.soakReconnects = {
          actual: measuredWindow.reconnects,
          expected: "at least three controlled offline/recovery cycles",
          passed: measuredWindow.reconnects.length >= 3
            && measuredWindow.reconnects.every((item) => item.restored === true),
        };
      }
    }
    if (releaseMetrics.durationMs >= 30 * 60_000) {
      const heapAnalysis = releaseMetrics.measuredWindow?.analysis?.heap;
      checks.longSoakHeapGrowth = {
        actual: heapAnalysis || releaseMetrics.heapDeltaPct,
        expected: "<= 15% after at least 30 minutes and <= 5% growth in the final 20% window",
        passed: releaseMetrics.heapDeltaPct !== null
          && releaseMetrics.heapDeltaPct <= 15
          && heapAnalysis?.plateau === true,
      };
    }
    if (releaseMetrics.durationMs >= 60 * 60_000) {
      const privateBytesAnalysis = releaseMetrics.measuredWindow?.analysis?.privateBytes;
      checks.longSoakPrivateBytesGrowth = {
        actual: privateBytesAnalysis || releaseMetrics.privateBytesDeltaPct,
        expected: "<= 15% after at least 1 hour and <= 5% growth in the final 20% window",
        passed: releaseMetrics.privateBytesDeltaPct !== null
          && releaseMetrics.privateBytesDeltaPct <= 15
          && privateBytesAnalysis?.plateau === true,
      };
    }
  }
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

export function createNetworkFailureTracker() {
  const requests = new Map();
  return {
    requestWillBeSent(event) {
      requests.set(event.requestId, {
        method: event.request?.method || null,
        type: event.type || null,
        url: event.request?.url || null,
      });
    },
    loadingFinished(event) {
      requests.delete(event.requestId);
    },
    loadingFailed(event) {
      const request = requests.get(event.requestId) || {};
      requests.delete(event.requestId);
      if (event.canceled || event.errorText === "net::ERR_ABORTED") return null;
      return {
        atMs: Date.now(),
        method: request.method || null,
        type: event.type || request.type || null,
        url: request.url || null,
        errorText: event.errorText,
        blockedReason: event.blockedReason || null,
        corsErrorStatus: event.corsErrorStatus || null,
      };
    },
  };
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
  if (args.requireDatabaseState !== "auto" && backendBefore?.database?.state !== args.requireDatabaseState) {
    throw new Error(
      `Scenario ${args.scenario} requires a ${args.requireDatabaseState} database, `
      + `but the sidecar reported ${backendBefore?.database?.state || "unknown"}`,
    );
  }
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
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: false });

  let cdp;
  let tracingStarted = false;
  const webSockets = [];
  const errors = { console: [], exceptions: [], network: [] };
  const networkFailureTracker = createNetworkFailureTracker();
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
    cdp.on("Network.requestWillBeSent", (event) => networkFailureTracker.requestWillBeSent(event));
    cdp.on("Network.loadingFinished", (event) => networkFailureTracker.loadingFinished(event));
    cdp.on("Network.loadingFailed", (event) => {
      const failure = networkFailureTracker.loadingFailed(event);
      if (failure) errors.network.push(failure);
    });
    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("Page.enable"),
      cdp.send("Performance.enable"),
      cdp.send("HeapProfiler.enable"),
    ]);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initializationScript(bootstrap) });
    await cdp.send("Tracing.start", {
      // A full disabled-by-default timeline grows beyond V8's single-string
      // limit during the required one-hour soak. The soak keeps navigation,
      // loading, and product user-timing events while its dedicated observers
      // record long tasks, input, React commits, Canvas lifecycle, heap, and
      // backend samples. Short release scenarios retain the detailed trace.
      categories: args.workload === "soak"
        ? "blink.user_timing,loading"
        : "devtools.timeline,blink.user_timing,loading,disabled-by-default-devtools.timeline",
      options: "record-as-much-as-possible",
      transferMode: "ReturnAsStream",
    });
    tracingStarted = true;
    const browserWindow = await cdp.send("Browser.getWindowForTarget", { targetId: page.id });
    await cdp.send("Browser.setWindowBounds", {
      windowId: browserWindow.windowId,
      bounds: { windowState: "normal" },
    }).catch(() => {});
    await cdp.send("Page.bringToFront");
    const navigationStartedAt = Date.now();
    await cdp.send("Page.navigate", { url: args.url });
    await cdp.send("Page.bringToFront");
    const readiness = await waitForCapacityReady(cdp, args.cells, args.readyTimeoutMs);
    readiness.navigationToReadyMs = Date.now() - navigationStartedAt;
    const realtimeSettlement = await waitForRealtimeSettlement(
      cdp,
      args.cells,
      args.readyTimeoutMs,
    );
    readiness.realtimeSettled = isRealtimeSettledSnapshot(realtimeSettlement, args.cells);
    readiness.realtimeSettledMs = Date.now() - navigationStartedAt;
    readiness.realtimeStatuses = realtimeSettlement.statuses;

    await cdp.send("Page.bringToFront");
    const linkDrillInitial = await evaluateJson(cdp, `() => {
      const diagnostics = window.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__;
      if (!diagnostics) return { supported: false, reason: 'diagnostics unavailable' };
      const now = Math.floor(Date.now() / 1000);
      diagnostics.publishCrosshair('cell-1', now);
      diagnostics.publishTimeAnchor('cell-1', now);
      diagnostics.publishDateRange('cell-1', { from: now - 3600, to: now });
      return { supported: true, snapshot: diagnostics.snapshot() };
    }`);
    const linkDrill = linkDrillInitial.supported
      ? await waitForBrowserValue(cdp, `() => {
          const diagnostics = window.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__;
          const snapshot = diagnostics?.snapshot?.() || null;
          return {
            ready: Number(snapshot?.counts?.crosshairTargetDeliveries || 0) >= 1
              && Number(snapshot?.counts?.viewportTargetDeliveries || 0) >= 1
              && snapshot?.viewportIssue == null,
            supported: Boolean(snapshot),
            snapshot,
          };
        }`, 5_000, "linked crosshair/date-range delivery")
      : linkDrillInitial;
    const productBoundaryDrill = args.scenario === "S4"
      ? await runProductBoundaryDrill(cdp, args.cells, args.readyTimeoutMs)
      : { supported: false, reason: "The product boundary drill runs once in S4" };

    const rectangles = await evaluateJson(cdp, `() => Array.from(document.querySelectorAll('.multi-chart-cell')).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(20, rect.height / 2) };
    })`);
    for (const rectangle of rectangles || []) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rectangle.x, y: rectangle.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rectangle.x, y: rectangle.y, button: "left", clickCount: 1 });
      await wait(100);
    }
    // Memory leak gates begin only after the finite workload state has been
    // materialized. Otherwise the expected 1m/5m and alternate-symbol caches
    // are misclassified as unbounded growth during the first soak minutes.
    const preconditioning = await runSoakPrecondition(cdp, args);
    const measurementBaseline = await httpJson(
      `${args.backendUrl}/debug/capacity?detail_limit=0`,
      args.readyTimeoutMs,
    );
    await cdp.send("HeapProfiler.collectGarbage");
    await evaluate(cdp, `(() => {
      const state = window.__CANDLESCOPE_MULTI_CHART_CAPACITY__;
      if (state) {
        state.measuring = true;
        state.canvasAdded = 0;
        state.canvasRemoved = 0;
        state.canvasMutations = [];
        state.chartSurfaceAdded = 0;
        state.chartSurfaceRemoved = 0;
        state.chartSurfaceMutations = [];
        state.longTasks = [];
        state.inputEvents = [];
      }
      window.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__?.reset?.();
    })()`);
    const heapBefore = await cdp.send("Runtime.getHeapUsage");
    const measuredWindow = await runMeasuredWindow(
      cdp,
      args,
      measurementBaseline.runtime?.eventLoopLag,
    );

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
        chartSurfaceAdded: state.chartSurfaceAdded || 0,
        chartSurfaceRemoved: state.chartSurfaceRemoved || 0,
        longTasks: state.longTasks || [],
        inputEvents: state.inputEvents || [],
        display: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, devicePixelRatio, colorDepth: screen.colorDepth },
        webgl: { vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null, renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null },
        perf: window.__CANDLESCOPE_PERF__?.report?.() || null,
        windowBroker: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.() || null,
        renderDiagnostics: window.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__?.snapshot?.() || null,
        linkDiagnostics: window.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__?.snapshot?.() || null,
        canvasMutations: state.canvasMutations || [],
        chartSurfaceMutations: state.chartSurfaceMutations || [],
      };
    }`);
    const replaceableCommitCounts = (snapshot) => {
      const cells = snapshot?.scheduler?.cells || [];
      return {
        forming: cells.reduce((total, cell) => total + Number(cell.committed?.['kline-forming'] || 0), 0),
        preview: cells.reduce((total, cell) => total + Number(cell.committed?.['indicator-preview'] || 0), 0),
      };
    };
    const backgroundPage = await cdp.send("Target.createTarget", { url: "about:blank" });
    await cdp.send("Target.activateTarget", { targetId: backgroundPage.targetId });
    const backgroundBaseline = await waitForBrowserValue(cdp, `() => ({
      ready: document.visibilityState === 'hidden',
      documentVisibility: document.visibilityState,
      windowBroker: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.() || null,
    })`, 5_000, "background suppression baseline");
    await wait(1_200);
    const backgroundSnapshot = await evaluateJson(cdp, `() => ({
      documentVisibility: document.visibilityState,
      windowBroker: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.() || null,
    })`);
    await cdp.send("Target.activateTarget", { targetId: page.id });
    await cdp.send("Target.closeTarget", { targetId: backgroundPage.targetId }).catch(() => {});
    await cdp.send("Page.bringToFront");
    const replaceableBeforeBackground = replaceableCommitCounts(backgroundBaseline.windowBroker);
    const replaceableAfterBackground = replaceableCommitCounts(backgroundSnapshot.windowBroker);
    const minimizedCells = backgroundSnapshot.windowBroker?.scheduler?.cells || [];
    const backgroundSuppression = {
      hidden: backgroundSnapshot.documentVisibility === "hidden",
      allMinimized: minimizedCells.length === args.cells
        && minimizedCells.every((cell) => cell.tier === "minimized"),
      formingDelta: replaceableAfterBackground.forming - replaceableBeforeBackground.forming,
      previewDelta: replaceableAfterBackground.preview - replaceableBeforeBackground.preview,
      pendingFrames: Number(backgroundSnapshot.windowBroker?.scheduler?.pendingFrames || 0),
    };
    const heapAfter = await cdp.send("Runtime.getHeapUsage");
    const lagAfterSequence = Number(
      measurementBaseline.runtime?.eventLoopLag?.sample_sequence
      ?? measurementBaseline.runtime?.eventLoopLag?.samples
      ?? 0,
    );
    const backendAfter = await httpJson(
      `${args.backendUrl}/debug/capacity?include_database_hash=true&event_loop_after_sequence=${lagAfterSequence}`,
      args.readyTimeoutMs,
    );
    const backendDebug = await httpJson(`${args.backendUrl}/debug/snapshot`, args.readyTimeoutMs);
    const eventLoopLagWindow = eventLoopLagForWindow(
      measurementBaseline.runtime?.eventLoopLag,
      backendAfter.runtime?.eventLoopLag,
    );
    const socketSummary = classifyWebSockets(webSockets);
    const batchEnabled = backendAfter?.limits?.klineBatchEnabled === true;
    const mapping = leaseMapping(
      backendBefore,
      backendAfter,
      bootstrap.expectedSeries,
      bootstrap.expectedLeaseClaimsBySeries,
      batchEnabled,
    );
    mapping.expectedSeries = bootstrap.expectedSeries.length;

    const screenshotPath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.png`);
    const tracePath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.trace.json`);
    const backendPath = path.resolve(args.artifactsDir, `${args.scenario.toLowerCase()}-${args.cells}cell.backend.json`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(backendPath, `${JSON.stringify({ capacity: backendAfter, debug: backendDebug }, null, 2)}\n`);

    const traceComplete = new Promise((resolve) => {
      const off = cdp.on("Tracing.tracingComplete", (event) => { off(); resolve(event); });
    });
    await cdp.send("Tracing.end");
    const traceResult = await traceComplete;
    tracingStarted = false;
    await writeProtocolStream(cdp, traceResult?.stream, tracePath);

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
    const expectedNetworkFailures = errors.network.filter((failure) => measuredWindow.reconnects.some((reconnect) => (
      reconnect.restored === true
      && failure.atMs >= reconnect.atEpochMs - 250
      && failure.atMs <= reconnect.atEpochMs + reconnect.offlineMs + 5_000
    )));
    const unexpectedNetworkFailures = errors.network.filter((failure) => !expectedNetworkFailures.includes(failure));
    const gate = evaluateCapacityResult({
      supported: true,
      requestedCells: args.cells,
      readiness,
      errors: { ...errors, network: unexpectedNetworkFailures },
      backendAfter,
      mapping,
      canvasRemounts: measured.chartSurfaceRemoved || 0,
      backgroundSuppression,
      releaseMetrics: {
        scenario: args.scenario,
        durationMs: args.durationMs,
        readyMs: readiness.navigationToReadyMs,
        inputP95Ms: percentile(inputDurations, 95),
        longTasksPerMinute: durationMinutes > 0
          ? Number((measured.longTasks.length / durationMinutes).toFixed(3))
          : Number.POSITIVE_INFINITY,
        eventLoopLagP99Ms: eventLoopLagWindow.p99Ms,
        batchEnabled,
        klineSockets: socketSummary.klinePeakActive,
        batchSnapshot: backendAfter.klineBatch || null,
        expectedLogicalSubscriptions: Object.values(bootstrap.expectedClaimsBySeries)
          .reduce((total, value) => total + Number(value || 0), 0),
        linkDrill,
        productBoundaryDrill,
        preconditioning,
        measuredWindow,
        heapDeltaPct: measuredWindow.analysis?.heap?.deltaPct ?? (heapBefore.usedSize > 0
          ? Number(((heapDelta / heapBefore.usedSize) * 100).toFixed(3))
          : null),
        privateBytesDeltaPct: measuredWindow.analysis?.privateBytes?.deltaPct ?? (Number(backendBefore.runtime?.processMemory?.privateBytes) > 0
          ? Number((((Number(backendAfter.runtime?.processMemory?.privateBytes || 0)
            - Number(backendBefore.runtime.processMemory.privateBytes))
            / Number(backendBefore.runtime.processMemory.privateBytes)) * 100).toFixed(3))
          : null),
      },
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
        reactRenders: {
          source: "instrumented LiveChartCell function entry",
          total: measured.renderDiagnostics?.totalReactRenders ?? null,
          cells: measured.renderDiagnostics?.cells || [],
        },
        domCommits: {
          source: "instrumented LiveChartCell useLayoutEffect commit",
          total: measured.renderDiagnostics?.totalDomCommits ?? null,
          cells: measured.renderDiagnostics?.cells || [],
        },
        chartSurfaceRemounts: measured.chartSurfaceRemoved || 0,
        chartSurfaceAddsAfterBaseline: measured.chartSurfaceAdded || 0,
        chartSurfaceMutations: measured.chartSurfaceMutations || [],
        paneCanvasRemovals: measured.canvasRemoved || 0,
        paneCanvasAddsAfterBaseline: measured.canvasAdded || 0,
        // Backward-compatible evidence key; its value now has the precise
        // product meaning: a detached Lightweight Charts root, not an
        // internal drawing/indicator canvas lifecycle event.
        canvasRemounts: measured.chartSurfaceRemoved || 0,
        canvasMutations: measured.canvasMutations || readiness.canvasMutations || [],
        backgroundSuppression,
        klineWebSockets: socketSummary.klinePeakActive,
        klineWebSocketCreates: socketSummary.kline.length,
        indicatorWebSockets: socketSummary.indicatorPeakActive,
        indicatorWebSocketCreates: socketSummary.indicator.length,
        webSockets: socketSummary,
        perf: compactPerfSnapshot(measured.perf),
        windowBroker: measured.windowBroker,
        linkDrill,
        linkDiagnostics: measured.linkDiagnostics,
        productBoundaryDrill,
        preconditioning,
        measuredWindow,
        errors: {
          ...errors,
          expectedNetworkFailures,
          unexpectedNetworkFailures,
        },
      },
      backend: {
        activeSeries: backendAfter.dataManager?.activeSeries || 0,
        streamLeases: backendAfter.dataManager?.streamLeases || 0,
        eventLoopLag: backendAfter.runtime?.eventLoopLag || null,
        eventLoopLagWindow,
        privateBytes: backendAfter.runtime?.processMemory || null,
        backfill: compactBackendSnapshot(backendAfter).backfill,
        indicatorExecutor: backendAfter.executors?.indicator || null,
        before: compactBackendSnapshot(backendBefore),
        measurementBaseline: compactBackendSnapshot(measurementBaseline),
        after: compactBackendSnapshot(backendAfter),
        scenarioMapping: mapping,
      },
      upstream: {
        physicalWebSockets: backendAfter.exchange?.physicalWebSockets || 0,
        physicalWebSocketDelta: (backendAfter.exchange?.physicalWebSockets || 0) - (backendBefore.exchange?.physicalWebSockets || 0),
        httpRequests: backendAfter.exchange?.ingestion?.ingress?.transport?.metrics?.counters || null,
        httpRequestsSupported: Boolean(backendAfter.exchange?.ingestion?.ingress?.transport?.metrics?.counters),
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
    frontend: { unsupportedReason: `Workspace schema v6 exposes at most ${CURRENT_PRODUCT_CELL_LIMIT} cells per window` },
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
