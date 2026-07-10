import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  createIndicatorRangeNetworkCapture,
  INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS,
  summarizeIndicatorRangeRequests,
} from "./indicator-range-network-capture.mjs";

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_SAMPLE_MS = 5_000;
const DEFAULT_OUT = "docs/perf-baselines/2026-07-phase0.json";
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

function parseArgs(argv) {
  const args = {
    url: process.env.PERF_BASELINE_URL || DEFAULT_URL,
    durationMs: Number(process.env.PERF_BASELINE_DURATION_MS || DEFAULT_DURATION_MS),
    sampleMs: Number(process.env.PERF_BASELINE_SAMPLE_MS || DEFAULT_SAMPLE_MS),
    out: process.env.PERF_BASELINE_OUT || DEFAULT_OUT,
    phase: process.env.PERF_BASELINE_PHASE || "phase0",
    chromePath: process.env.CHROME_PATH || "",
    switches: Number(process.env.PERF_BASELINE_SWITCHES || 10),
    switchList: (process.env.PERF_BASELINE_SWITCH_LIST || "1m,5m,15m,1h")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--duration-ms") args.durationMs = Number(argv[++i]);
    else if (arg === "--sample-ms") args.sampleMs = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--phase") args.phase = argv[++i];
    else if (arg === "--chrome") args.chromePath = argv[++i];
    else if (arg === "--switches") args.switches = Number(argv[++i]);
    else if (arg === "--switch-list") {
      args.switchList = String(argv[++i] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  return args;
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

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeDirWithRetries(dir, attempts = 5) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (index === attempts - 1) {
        console.warn(`Could not remove temporary Chrome profile ${dir}: ${err.message}`);
        return;
      }
      await wait(250 * (index + 1));
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

async function waitForDebugTarget(port, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json`);
      if (Array.isArray(targets)) return targets;
    } catch (err) {
      lastError = err;
    }
    await wait(250);
  }
  throw lastError || new Error("Timed out waiting for Chrome debug target");
}

async function connectWebSocket(wsUrl) {
  const WebSocket = globalThis.WebSocket;
  if (!WebSocket) {
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
      reject(new Error(`CDP websocket error: ${event.message || "unknown"}`));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message);
      return;
    }
    if (message.method) {
      for (const handler of handlers.get(message.method) || []) {
        handler(message.params);
      }
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression, returnByValue = true) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue,
  });
  const result = response.result?.result;
  if (result?.subtype === "error") {
    throw new Error(result.description || result.value || "Runtime.evaluate failed");
  }
  return result?.value;
}

async function evaluateJson(cdp, expression) {
  const value = await evaluate(cdp, `JSON.stringify((${expression})())`);
  if (typeof value !== "string") return null;
  return JSON.parse(value);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeEvents(events, durationMs) {
  const byName = new Map();
  for (const event of events) {
    const list = byName.get(event.name) || [];
    list.push(event);
    byName.set(event.name, list);
  }

  const commits = byName.get("chart.data.commit") || [];
  const commitBars = commits
    .map((event) => Number(event.detail?.bars))
    .filter(Number.isFinite);
  const setDataCount = (byName.get("chart.candleSeries.setData") || []).length;
  const updateCount = (byName.get("chart.candleSeries.update") || []).length;
  const indicatorEvents = events.filter((event) => event.name.startsWith("indicator.compute."));
  const computeDurations = indicatorEvents
    .map((event) => Number(event.detail?.durationMs || event.detail?.elapsedMs))
    .filter(Number.isFinite);

  return {
    totalEvents: events.length,
    chartDataCommit: {
      count: commits.length,
      perMinute: durationMs > 0 ? Number((commits.length / (durationMs / 60_000)).toFixed(3)) : null,
      bars: {
        min: commitBars.length ? Math.min(...commitBars) : null,
        p50: percentile(commitBars, 50),
        p95: percentile(commitBars, 95),
        max: commitBars.length ? Math.max(...commitBars) : null,
        latest: commitBars.length ? commitBars[commitBars.length - 1] : null,
      },
      bySource: commits.reduce((acc, event) => {
        const source = event.detail?.source || "unknown";
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {}),
    },
    candleSeries: {
      setDataCount,
      updateCount,
      setDataToUpdateRatio: updateCount > 0 ? Number((setDataCount / updateCount).toFixed(6)) : null,
    },
    indicatorCompute: {
      eventCount: indicatorEvents.length,
      durationMs: {
        p50: percentile(computeDurations, 50),
        p95: percentile(computeDurations, 95),
        max: computeDurations.length ? Math.max(...computeDurations) : null,
      },
    },
  };
}

function summarizeHeap(samples) {
  const used = samples
    .map((sample) => Number(sample.usedJSHeapSize))
    .filter(Number.isFinite);
  const first = used[0] ?? null;
  const last = used[used.length - 1] ?? null;
  return {
    samples: used.length,
    firstUsedJSHeapSize: first,
    lastUsedJSHeapSize: last,
    maxUsedJSHeapSize: used.length ? Math.max(...used) : null,
    deltaBytes: first != null && last != null ? last - first : null,
    deltaPct: first > 0 && last != null ? Number((((last - first) / first) * 100).toFixed(3)) : null,
  };
}

function summarizeIndicatorNetworkByPhase(records) {
  const phases = Array.from(new Set(records.map((record) => record.phase).filter(Boolean)));
  return Object.fromEntries(
    phases.map((phase) => [phase, summarizeIndicatorRangeRequests(records, { phase })]),
  );
}

function dedupeKey(event) {
  return [
    event.name,
    event.sinceStoreMs,
    event.detail?.source || "",
    event.detail?.status || "",
    event.detail?.bars ?? "",
    event.detail?.lastTime ?? "",
  ].join("|");
}

async function readPerfSample(cdp) {
  try {
    return await evaluateJson(cdp, `() => {
      const report = window.__CANDLESCOPE_PERF__?.report?.() || null;
      const memory = performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      } : null;
      return { atMs: Date.now(), report, memory };
    }`);
  } catch (error) {
    return {
      atMs: Date.now(),
      report: null,
      memory: null,
      error: error?.message || String(error),
    };
  }
}

async function clickInterval(cdp, interval) {
  return evaluateJson(cdp, `() => {
    const interval = ${JSON.stringify(interval)};
    const direct = document.getElementById('interval-' + interval);
    const candidates = direct ? [direct] : Array.from(document.querySelectorAll(
      '#toolbar button, .interval-presets button, .interval-panel-row, button'
    ));
    const button = candidates.find((element) => {
      const text = (element.textContent || '').trim();
      const title = (element.getAttribute('title') || '').trim();
      const aria = (element.getAttribute('aria-label') || '').trim();
      return element === direct || text === interval || title === interval || aria === interval;
    });
    if (!button) return { ok: false, interval, reason: 'button-not-found' };
    button.click();
    return { ok: true, interval, text: (button.textContent || '').trim() };
  }`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.durationMs) || args.durationMs <= 0) {
    throw new Error("--duration-ms must be a positive number");
  }
  if (!Number.isFinite(args.sampleMs) || args.sampleMs <= 0) {
    throw new Error("--sample-ms must be a positive number");
  }

  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge executable not found. Pass --chrome <path>.");

  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-perf-"));
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  let indicatorRangeNetworkCapture;
  try {
    const targets = await waitForDebugTarget(port);
    const page = targets.find((target) => target.type === "page") || targets[0];
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    indicatorRangeNetworkCapture = createIndicatorRangeNetworkCapture(cdp);
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS);
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Page.navigate", { url: args.url });

    const startedAtMs = Date.now();
    const seenEvents = new Set();
    const events = [];
    const heapSamples = [];
    const samples = [];
    const switchAttempts = [];
    const switchEveryMs = args.switches > 0
      ? Math.max(args.sampleMs, Math.floor(args.durationMs / (args.switches + 1)))
      : Number.POSITIVE_INFINITY;
    let nextSwitchAt = startedAtMs + switchEveryMs;
    let switchIndex = 0;

    while (Date.now() - startedAtMs < args.durationMs) {
      const sample = await readPerfSample(cdp);
      samples.push({
        atMs: sample.atMs,
        timings: sample.report?.timings || null,
        eventCount: sample.report?.events?.length || 0,
        error: sample.error || null,
      });
      if (sample.memory) heapSamples.push({ atMs: sample.atMs, ...sample.memory });

      for (const event of sample.report?.events || []) {
        const key = dedupeKey(event);
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        events.push(event);
      }

      if (switchIndex < args.switches && Date.now() >= nextSwitchAt && args.switchList.length > 0) {
        const interval = args.switchList[switchIndex % args.switchList.length];
        indicatorRangeNetworkCapture.startPhase(`switch-${switchIndex + 1}:${interval}`);
        const result = await clickInterval(cdp, interval);
        switchAttempts.push({ atMs: Date.now(), ...result });
        switchIndex += 1;
        nextSwitchAt += switchEveryMs;
      }

      await wait(Math.min(args.sampleMs, Math.max(250, args.durationMs - (Date.now() - startedAtMs))));
    }

    const durationMs = Date.now() - startedAtMs;
    await indicatorRangeNetworkCapture.waitForIdle({ quietMs: 1_000, timeoutMs: 10_000 });
    await indicatorRangeNetworkCapture.flush();
    const indicatorRangeRequests = indicatorRangeNetworkCapture.records();
    const indicatorRangeNetwork = indicatorRangeNetworkCapture.summary();
    const output = {
      schemaVersion: 2,
      phase: args.phase,
      generatedAt: new Date().toISOString(),
      config: {
        url: args.url,
        durationMs,
        sampleMs: args.sampleMs,
        switchesRequested: args.switches,
        switchList: args.switchList,
      },
      summary: {
        ...summarizeEvents(events, durationMs),
        heap: summarizeHeap(heapSamples),
        switches: {
          attempted: switchAttempts.length,
          succeeded: switchAttempts.filter((item) => item.ok).length,
          failed: switchAttempts.filter((item) => !item.ok).length,
        },
        indicatorRangeNetwork: {
          ...indicatorRangeNetwork,
          byPhase: summarizeIndicatorNetworkByPhase(indicatorRangeRequests),
        },
      },
      raw: {
        samples,
        heapSamples,
        switchAttempts,
        events,
        indicatorRangeRequests,
      },
    };

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`Wrote ${args.phase} performance baseline to ${args.out}`);
    console.log(JSON.stringify(output.summary, null, 2));
  } finally {
    cdp?.close?.();
    if (chrome.exitCode === null) chrome.kill();
    await waitForProcessExit(chrome);
    await removeDirWithRetries(profileDir);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
