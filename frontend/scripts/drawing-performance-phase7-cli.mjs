#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { attributeLongTasks } from "./drawing-performance-metrics.mjs";
import { buildDrawingFixture } from "./drawing-performance-fixtures.mjs";
import {
  buildPhase7Acceptance,
  buildPhase7V2Record,
  PHASE7_DATABASE_NAME,
  PHASE7_DATABASE_VERSION,
  PHASE7_ENTITY_COUNT,
  PHASE7_MIN_RUNS,
  PHASE7_STORE_NAME,
  phase7BrowserProbeBootstrap,
  phase7SeedNativeIndexedDb,
} from "./drawing-performance-phase7.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(SCRIPT_DIRECTORY, "..", "output", "phase7-browser-acceptance.json");
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 1000 });

function usage() {
  return [
    "Phase 7 headed browser acceptance",
    "",
    "Run an application build configured with document authority and scene-canary, then:",
    "  node scripts/drawing-performance-phase7-cli.mjs --url http://127.0.0.1:15173/",
    "",
    "Options:",
    "  --url <url>          Running CandleScope frontend URL",
    "  --chrome <path>      Chrome/Edge executable",
    `  --runs <n>           Repetitions (default/minimum gate ${PHASE7_MIN_RUNS}; lower is smoke-only)`,
    "  --timeout-ms <n>     Per-stage timeout (default 45000)",
    "  --dpr <n>            Browser device scale factor (default 1)",
    `  --out <path>         JSON report (default ${DEFAULT_OUTPUT})`,
    "  --help               Show this help",
  ].join("\n");
}

function positiveNumber(value, name, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
    throw new TypeError(`${name} must be a positive ${integer ? "integer" : "number"}`);
  }
  return number;
}

export function parsePhase7CliArgs(argv = process.argv.slice(2)) {
  const args = {
    url: "http://127.0.0.1:15173/",
    chromePath: process.env.CHROME_PATH || "",
    runs: PHASE7_MIN_RUNS,
    timeoutMs: 45_000,
    dpr: 1,
    out: DEFAULT_OUTPUT,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") args.url = String(argv[++index] || "");
    else if (argument === "--chrome") args.chromePath = String(argv[++index] || "");
    else if (argument === "--runs") {
      args.runs = positiveNumber(argv[++index], "--runs", { integer: true });
    } else if (argument === "--timeout-ms") {
      args.timeoutMs = positiveNumber(argv[++index], "--timeout-ms", { integer: true });
    } else if (argument === "--dpr") args.dpr = positiveNumber(argv[++index], "--dpr");
    else if (argument === "--out") args.out = path.resolve(String(argv[++index] || ""));
    else if (argument === "--help" || argument === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.url) throw new Error("--url is required");
  if (!args.url.endsWith("/")) args.url += "/";
  return Object.freeze(args);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function httpText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        } else {
          resolve(body);
        }
      });
    });
    request.on("error", reject);
  });
}

function httpJson(url) {
  return httpText(url).then((body) => JSON.parse(body));
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await httpText(url);
    } catch (error) {
      lastError = error;
      await wait(200);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
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

async function waitForDebugTarget(port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json`);
      if (Array.isArray(targets) && targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await wait(200);
  }
  throw lastError || new Error("Timed out waiting for Chrome debug target");
}

async function connectWebSocket(webSocketUrl) {
  if (!globalThis.WebSocket) throw new Error("This Node.js runtime does not expose WebSocket");
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to CDP")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || "CDP websocket error"));
    }, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else deferred.resolve(message);
  });
  return {
    send(method, params = {}) {
      sequence += 1;
      socket.send(JSON.stringify({ id: sequence, method, params }));
      return new Promise((resolve, reject) => pending.set(sequence, { resolve, reject }));
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
  if (result?.subtype === "error") throw new Error(result.description || "Runtime.evaluate failed");
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description
      || response.result.exceptionDetails.text
      || "Runtime.evaluate exception");
  }
  return result?.value;
}

async function evaluateFunction(cdp, fn, payload) {
  return evaluate(cdp, `(${fn.toString()})(${JSON.stringify(payload)})`);
}

async function evaluateJson(cdp, expression) {
  const value = await evaluate(cdp, `JSON.stringify(${expression})`);
  return typeof value === "string" ? JSON.parse(value) : null;
}

async function waitForExpression(cdp, expression, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now();
  let lastValue = null;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await evaluateJson(cdp, expression);
      lastError = null;
      if (lastValue?.ready === true) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for Phase 7 browser evidence: ${JSON.stringify({
    lastValue,
    lastError: lastError?.message || null,
  })}`);
}

async function ensureForegroundWindow(cdp, windowId) {
  if (!Number.isSafeInteger(windowId)) throw new Error("Headed Chrome window is unavailable");
  const before = await cdp.send("Browser.getWindowBounds", { windowId });
  if (before.result?.bounds?.windowState !== "normal") {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  }
  await cdp.send("Page.bringToFront");
  await wait(100);
  const visibility = await evaluateJson(cdp, `({
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    devicePixelRatio: window.devicePixelRatio
  })`);
  const after = await cdp.send("Browser.getWindowBounds", { windowId });
  const evidence = {
    headed: true,
    windowState: after.result?.bounds?.windowState ?? null,
    visibilityState: visibility?.visibilityState ?? null,
    hidden: visibility?.hidden ?? null,
    devicePixelRatio: Number(visibility?.devicePixelRatio),
  };
  if (evidence.windowState !== "normal"
    || evidence.visibilityState !== "visible"
    || evidence.hidden !== false) {
    throw new Error(`Phase 7 browser must remain visible: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(5_000),
  ]);
}

async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await wait(200 * (attempt + 1));
    }
  }
}

function manifestKey(scopeKey) {
  return `candlescope-drawings-v2-manifest-${encodeURIComponent(scopeKey)}`;
}

function legacyKey(scopeKey) {
  return `candlescope-drawings-${scopeKey}`;
}

async function readManifest(cdp, key) {
  return evaluateJson(cdp, `(() => {
    const raw = localStorage.getItem(${JSON.stringify(key)});
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return { invalid: true, raw }; }
  })()`);
}

async function runPhase7Iteration({
  cdp,
  args,
  browserWindowId,
  fixture,
  record,
  iteration,
}) {
  const scopeKey = fixture.metadata.scopeKey;
  const expectedManifestKey = manifestKey(scopeKey);
  const expectedLegacyKey = legacyKey(scopeKey);
  const seed = await evaluateFunction(cdp, phase7SeedNativeIndexedDb, {
    databaseName: PHASE7_DATABASE_NAME,
    databaseVersion: PHASE7_DATABASE_VERSION,
    storeName: PHASE7_STORE_NAME,
    manifestKey: expectedManifestKey,
    legacyKey: expectedLegacyKey,
    record,
  });

  await cdp.send("Page.navigate", {
    url: `${args.url}${args.url.includes("?") ? "&" : "?"}drawingPhase7=${iteration}`,
  });
  const ready = await waitForExpression(cdp, `(() => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const runtime = handle?.readRuntimeSummary?.() || null;
    const metrics = handle?.report?.()?.durations || null;
    const restore = metrics?.restoreChunkMs || null;
    const engineReady = Boolean(document.querySelector('[data-drawing-engine="ready"]'));
    return {
      ready: document.readyState === 'complete'
        && engineReady
        && runtime?.entityCount === ${PHASE7_ENTITY_COUNT}
        && Number(restore?.totalCount) >= 1,
      documentReady: document.readyState,
      engineReady,
      runtime,
      restore
    };
  })()`, args.timeoutMs);
  await evaluate(cdp, "window.__CANDLESCOPE_PHASE7_PROBE__?.endWindow?.('restore')");
  const browser = await ensureForegroundWindow(cdp, browserWindowId);
  const repairedManifest = await readManifest(cdp, expectedManifestKey);
  const beforePersistenceCount = Number(ready.restore?.totalCount) >= 0
    ? Number((await evaluateJson(cdp,
        "window.__CANDLESCOPE_DRAWING_PERF__?.report?.()?.durations?.persistenceMs || null"
      ))?.totalCount || 0)
    : 0;

  await evaluate(cdp, "window.__CANDLESCOPE_PHASE7_PROBE__?.beginWindow?.('persistence')");
  const clearResult = await evaluateJson(cdp, `(() => {
    const button = document.querySelector('[data-drawing-action="clear"]');
    if (!button || button.disabled) return { clicked: false };
    button.click();
    return { clicked: true };
  })()`);
  if (!clearResult?.clicked) throw new Error("Phase 7 could not execute the clear mutation");

  const persisted = await waitForExpression(cdp, `(() => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const runtime = handle?.readRuntimeSummary?.() || null;
    const persistence = handle?.report?.()?.durations?.persistenceMs || null;
    let manifest = null;
    try {
      const raw = localStorage.getItem(${JSON.stringify(expectedManifestKey)});
      manifest = raw === null ? null : JSON.parse(raw);
    } catch {}
    return {
      ready: runtime?.entityCount === 0
        && Number(persistence?.totalCount) > ${beforePersistenceCount}
        && manifest?.count === 0,
      runtime,
      persistence,
      manifest
    };
  })()`, args.timeoutMs);
  await evaluate(cdp, "window.__CANDLESCOPE_PHASE7_PROBE__?.endWindow?.('persistence')");

  const evidence = await evaluateJson(cdp, `(() => ({
    performance: window.__CANDLESCOPE_DRAWING_PERF__?.report?.() || null,
    runtime: window.__CANDLESCOPE_DRAWING_PERF__?.readRuntimeSummary?.() || null,
    phase6: window.__CANDLESCOPE_DRAWING_PERF__?.readPhase6Runtime?.() || null,
    probe: window.__CANDLESCOPE_PHASE7_PROBE__?.report?.() || null
  }))()`);
  const probe = evidence?.probe || {};
  const windows = Object.values(probe.windows || {}).filter((window) => (
    Number.isFinite(window?.startTime) && Number.isFinite(window?.endTime)
  ));
  const attributed = attributeLongTasks(probe.longTasks, windows, {
    thresholdMs: 50,
    minimumOverlapMs: 0,
  });
  const runtime = ready.runtime || {};
  const sceneEntityCount = runtime.scenePublicationReady === true
    ? runtime.entityCount
    : null;

  return {
    iteration,
    browser,
    seed,
    restore: {
      entityCount: runtime.entityCount ?? null,
      sceneEntityCount,
      effectiveEngineMode: runtime.effectiveEngineMode ?? null,
      scenePublicationReady: runtime.scenePublicationReady ?? null,
      manifest: repairedManifest,
      legacyStorageRead: Array.isArray(probe.storageReads)
        ? probe.storageReads.includes(expectedLegacyKey)
        : null,
    },
    persistence: {
      entityCountAfterClear: persisted.runtime?.entityCount ?? null,
      manifestAfterClear: persisted.manifest ?? null,
    },
    metrics: {
      restoreChunkMs: evidence?.performance?.durations?.restoreChunkMs ?? null,
      persistenceMs: evidence?.performance?.durations?.persistenceMs ?? null,
    },
    longTasks: {
      observerSupported: probe.longTaskSupported === true,
      windowCount: windows.length,
      ...attributed,
    },
  };
}

export async function runPhase7BrowserAcceptance(args) {
  await waitForHttp(args.url, args.timeoutMs);
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge executable not found; pass --chrome <path>");

  const fixture = buildDrawingFixture("entities512");
  const savedDrawings = JSON.parse(fixture.raw);
  const record = buildPhase7V2Record(fixture.metadata.scopeKey, savedDrawings, Date.now());
  const debugPort = await freePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-phase7-"));
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ], {
    stdio: "ignore",
    windowsHide: false,
  });

  let cdp = null;
  try {
    const targets = await waitForDebugTarget(debugPort, args.timeoutMs);
    const page = targets.find((target) => target.type === "page") || targets[0];
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
    ]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: args.dpr,
      mobile: false,
      screenWidth: DEFAULT_VIEWPORT.width,
      screenHeight: DEFAULT_VIEWPORT.height,
    });
    const browserWindowId = (await cdp.send("Browser.getWindowForTarget", {
      targetId: page.id,
    })).result?.windowId;
    await cdp.send("Page.bringToFront");
    await cdp.send("Page.navigate", { url: args.url });
    await waitForExpression(cdp, "({ ready: document.readyState === 'complete' })", args.timeoutMs);
    await ensureForegroundWindow(cdp, browserWindowId);

    const bootstrapSource = `(${phase7BrowserProbeBootstrap.toString()})(${JSON.stringify({
      manifestKey: manifestKey(fixture.metadata.scopeKey),
    })});`;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource });

    const runs = [];
    for (let iteration = 1; iteration <= args.runs; iteration += 1) {
      runs.push(await runPhase7Iteration({
        cdp,
        args,
        browserWindowId,
        fixture,
        record: { ...record, updatedAt: Date.now() + iteration },
        iteration,
      }));
    }
    const report = {
      schemaVersion: 1,
      phase: "phase7",
      generatedAt: new Date().toISOString(),
      configuration: {
        url: args.url,
        runs: args.runs,
        dpr: args.dpr,
        headed: true,
        fixture: fixture.metadata,
      },
      browser: (await cdp.send("Browser.getVersion")).result,
      runs,
    };
    report.acceptance = buildPhase7Acceptance(report);
    return report;
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await removeDirectory(profileDirectory);
  }
}

async function main() {
  const args = parsePhase7CliArgs();
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await runPhase7BrowserAcceptance(args);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output: args.out,
    acceptance: report.acceptance,
  }, null, 2)}\n`);
  if (!report.acceptance.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
