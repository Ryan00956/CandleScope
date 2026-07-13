import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  createIndicatorRangeNetworkCapture,
  INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS,
} from "./indicator-range-network-capture.mjs";
import { runExportMatrix } from "./export-matrix.mjs";
import {
  resolveShortSwitchStepTransition,
  summarizeShortSwitchIndicatorReadiness,
} from "./short-switch-readiness.mjs";
import { runChartTypeMatrix } from "./chart-type-matrix.mjs";

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const SMOKE_MA_INDICATOR = {
  id: "ma",
  name: "Simple Moving Average",
  engineName: "MA",
  script: "# __ENGINE__:MA\nindicator(\"MA\", overlay=True)\n\nperiod = input.int(20, \"Period\", minval=1, maxval=500)\nsrc = input.source(close, \"Source\")\nline_color = input.color(color.orange, \"Color\")\n\nma = ta.sma(src, period)\nplot(ma, title=f\"MA({period})\", color=line_color, overlay=True)\n",
  params: { period: 20, source: "close", color: "#f59e0b" },
  description: "Simple Moving Average",
  category: "Trend",
  paneTarget: "main",
  kind: "builtin",
  isPreset: true,
  visible: true,
};
const SMOKE_VOL_INDICATOR = {
  id: "vol",
  name: "Volume",
  engineName: "VOL",
  script: "# __ENGINE__:VOL\nindicator(\"VOL\", overlay=False)\n\nup_color = input.color(color.green, \"Up Color\")\ndown_color = input.color(color.red, \"Down Color\")\n\nvolume_colors = color.when(close >= open, up_color, down_color)\nplot(\n    volume,\n    title=\"VOL\",\n    color=volume_colors,\n    style=plot.style_histogram,\n    overlay=False,\n    pane=\"volume\",\n)\n",
  params: { up_color: "#22c55e", down_color: "#ef4444" },
  description: "Volume histogram",
  category: "Volume",
  paneTarget: "sub",
  kind: "builtin",
  isPreset: true,
  visible: true,
};
const SMOKE_BOLL_INDICATOR = {
  id: "boll",
  name: "Bollinger Bands",
  script: "indicator(\"BOLL Smoke\", overlay=True)\n\nperiod = input.int(20, \"Period\", minval=1, maxval=500)\nmult = input.float(2.0, \"Multiplier\", minval=0.1, step=0.1)\nsrc = input.source(close, \"Source\")\nmid_color = input.color(color.orange, \"Middle Color\")\nupper_color = input.color(color.red, \"Upper Color\")\nlower_color = input.color(color.green, \"Lower Color\")\nfill_color = input.color(color.new(color.blue, 88), \"Fill Color\")\n\nupper, middle, lower = ta.bb(src, period, mult)\nupper_plot = plot(upper, title=\"BOLL Upper\", color=upper_color, overlay=True)\nmiddle_plot = plot(middle, title=f\"BOLL Mid({period})\", color=mid_color, overlay=True)\nlower_plot = plot(lower, title=\"BOLL Lower\", color=lower_color, overlay=True)\nfill(upper_plot, lower_plot, color=fill_color, title=\"BOLL Band\")\n",
  params: {
    period: 20,
    mult: 2,
    source: "close",
    mid_color: "#f59e0b",
    upper_color: "#ef4444",
    lower_color: "#22c55e",
    fill_color: "rgba(59, 130, 246, 0.12)",
  },
  description: "Bollinger Bands",
  category: "Volatility",
  paneTarget: "main",
  kind: "custom",
  isPreset: true,
  visible: true,
};
const SMOKE_RSI_INDICATOR = {
  id: "rsi",
  name: "Relative Strength Index",
  script: "indicator(\"RSI Smoke\", overlay=False)\n\nperiod = input.int(14, \"Period\", minval=1, maxval=200)\nsrc = input.source(close, \"Source\")\nline_color = input.color(color.purple, \"Color\")\noverbought = input.float(70.0, \"Overbought\", minval=0, maxval=100, step=1)\noversold = input.float(30.0, \"Oversold\", minval=0, maxval=100, step=1)\n\nrsi_line = ta.rsi(src, period)\nplot(rsi_line, title=f\"RSI({period})\", color=line_color, overlay=False, pane=\"separate\")\nhline(overbought, title=\"Overbought\", color=color.red, pane=\"separate\")\nhline(50, title=\"Middle\", color=color.gray, pane=\"separate\")\nhline(oversold, title=\"Oversold\", color=color.green, pane=\"separate\")\n",
  params: { period: 14, source: "close", color: "#8b5cf6", overbought: 70, oversold: 30 },
  description: "Relative Strength Index",
  category: "Oscillator",
  paneTarget: "sub",
  kind: "custom",
  isPreset: true,
  visible: true,
};
const SMOKE_ACTIVE_INDICATORS = [SMOKE_MA_INDICATOR];
const SMOKE_OVERLAY_HEAVY_INDICATORS = [
  SMOKE_MA_INDICATOR,
  SMOKE_VOL_INDICATOR,
  SMOKE_BOLL_INDICATOR,
  SMOKE_RSI_INDICATOR,
];

function parseArgs(argv) {
  const args = {
    url: process.env.SMOKE_URL || DEFAULT_URL,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    chromePath: process.env.CHROME_PATH || "",
    screenshot: process.env.SMOKE_SCREENSHOT || "",
    seedIndicators: process.env.SMOKE_SEED_INDICATORS !== "0",
    overlayHeavy: process.env.SMOKE_OVERLAY_HEAVY === "1",
    drawingCheck: process.env.SMOKE_DRAWING_CHECK === "1",
    chartTypeMatrix: process.env.SMOKE_CHART_TYPE_MATRIX === "1",
    exportMatrix: process.env.SMOKE_EXPORT_MATRIX === "1",
    shortSwitch: process.env.SMOKE_SHORT_SWITCH === "1",
    shortSwitchIntervals: (process.env.SMOKE_SHORT_SWITCH_INTERVALS || "15m,3m")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    shortSwitchSettleMs: Number(process.env.SMOKE_SHORT_SWITCH_SETTLE_MS || 4_000),
    shortSwitchMaxIndicatorRequests: Number(
      process.env.SMOKE_SHORT_SWITCH_MAX_INDICATOR_REQUESTS || 0,
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--chrome") args.chromePath = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--no-seed-indicators") args.seedIndicators = false;
    else if (arg === "--overlay-heavy") args.overlayHeavy = true;
    else if (arg === "--drawing-check") args.drawingCheck = true;
    else if (arg === "--chart-type-matrix") args.chartTypeMatrix = true;
    else if (arg === "--export-matrix") args.exportMatrix = true;
    else if (arg === "--short-switch") args.shortSwitch = true;
    else if (arg === "--short-switch-intervals") {
      args.shortSwitchIntervals = String(argv[++i] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--short-switch-settle-ms") {
      args.shortSwitchSettleMs = Number(argv[++i]);
    } else if (arg === "--short-switch-max-indicator-requests") {
      args.shortSwitchMaxIndicatorRequests = Number(argv[++i]);
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill();
  await Promise.race([
    new Promise((resolve) => {
      processHandle.once("exit", resolve);
    }),
    wait(2_000),
  ]);
}

async function removeDirectoryWithRetries(directory, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < attempts - 1) await wait(500);
    }
  }
}

function readHttpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text);
  let headerLength = 2;
  if (payload.length >= 126 && payload.length <= 65_535) headerLength = 4;
  if (payload.length > 65_535) headerLength = 10;

  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
  } else if (payload.length <= 65_535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const maskOffset = headerLength;
  const payloadOffset = headerLength + 4;
  const mask = crypto.randomBytes(4);
  mask.copy(frame, maskOffset);
  for (let i = 0; i < payload.length; i += 1) {
    frame[payloadOffset + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: payload.toString("utf8") });
    offset += frameLength;
  }

  return { frames, rest: buffer.subarray(offset) };
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
  }

  async connect() {
    const port = Number(this.wsUrl.port || 80);
    const host = this.wsUrl.hostname;
    const key = crypto.randomBytes(16).toString("base64");
    const pathWithQuery = `${this.wsUrl.pathname}${this.wsUrl.search}`;

    this.socket = net.createConnection({ host, port });
    this.socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });

    this.socket.write([
      `GET ${pathWithQuery} HTTP/1.1`,
      `Host: ${host}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));

    await new Promise((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        this.socket.off("data", onData);
        const headers = handshake.subarray(0, headerEnd).toString("utf8");
        if (!headers.includes(" 101 ")) {
          reject(new Error(`CDP WebSocket handshake failed: ${headers.split("\r\n")[0]}`));
          return;
        }
        this.buffer = handshake.subarray(headerEnd + 4);
        this.socket.on("data", (data) => this.onData(data));
        if (this.buffer.length > 0) this.onData(Buffer.alloc(0));
        resolve();
      };
      this.socket.on("data", onData);
      this.socket.once("error", reject);
    });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const decoded = decodeWsFrames(this.buffer);
    this.buffer = decoded.rest;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      const message = JSON.parse(frame.text);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        this.emit(message.method, message.params);
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeWsFrame(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

async function waitForDevTools(debugBase) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      await readHttpJson(`${debugBase}/json/version`);
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint");
}

function parseBarCount(text) {
  const counts = [...text.matchAll(/(\d+)\s+bars/g)].map((match) => Number(match[1]));
  return counts.length ? Math.max(...counts) : 0;
}

async function waitForChartReady(cdp, timeoutMs) {
  const started = Date.now();
  let bodyText = "";
  let loadedAt = null;

  while (Date.now() - started < timeoutMs) {
    await wait(1_000);
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    bodyText = result.result?.value || "";
    const bars = parseBarCount(bodyText);
    if (bars > 0 && bodyText.includes("Connected to Binance") && bodyText.includes("Live (WebSocket)")) {
      loadedAt = Date.now() - started;
      break;
    }
  }

  return { bodyText, loadedAt };
}

async function readPerfReport(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "window.__CANDLESCOPE_PERF__?.report ? window.__CANDLESCOPE_PERF__.report() : null",
    returnByValue: true,
  });
  return result.result?.value || null;
}

async function waitForPerfTiming(cdp, timingKey, timeoutMs = 10_000, pollMs = 500) {
  const started = Date.now();
  let report = await readPerfReport(cdp);
  while (Date.now() - started < timeoutMs) {
    if (report?.timings?.[timingKey] != null) return report;
    await wait(pollMs);
    report = await readPerfReport(cdp);
  }
  return report;
}

function getIndicatorSnapshotIds(performanceReport) {
  const events = Array.isArray(performanceReport?.events) ? performanceReport.events : [];
  return new Set(
    events
      .filter((event) => event?.name === "indicator.ws.snapshot" && event.detail?.indicatorId)
      .map((event) => event.detail.indicatorId),
  );
}

function getIndicatorReadyIds(performanceReport) {
  const events = Array.isArray(performanceReport?.events) ? performanceReport.events : [];
  return new Set(
    events
      .filter((event) => (
        event?.name === "indicator.ws.snapshot"
        || event?.name === "indicator.ws.subscribed"
      ) && event.detail?.indicatorId)
      .map((event) => event.detail.indicatorId),
  );
}

function indicatorSeriesDataEvents(performanceReport, { sinceAtMs = null } = {}) {
  const events = Array.isArray(performanceReport?.events) ? performanceReport.events : [];
  return events.filter((event) => (
    event?.name === "chart.indicatorSeries.setData"
    && Number(event.detail?.points) > 0
    && (sinceAtMs == null || Number(event.atMs) >= Number(sinceAtMs))
  ));
}

function hasIndicatorSeriesDataCoverage(
  performanceReport,
  { overlayHeavy = false, sinceAtMs = null } = {},
) {
  const expectedSeriesCount = overlayHeavy ? 6 : 1;
  return indicatorSeriesDataEvents(performanceReport, { sinceAtMs }).length >= expectedSeriesCount;
}

function hasSeededIndicatorCoverage(performanceReport, { overlayHeavy = false } = {}) {
  const expectedIds = overlayHeavy ? ["ma", "vol", "boll", "rsi"] : ["ma"];
  const readyIds = getIndicatorReadyIds(performanceReport);
  const { chartEventCounts } = summarizePerformanceEvents(performanceReport);
  if (!expectedIds.every((id) => readyIds.has(id))) return false;
  if ((chartEventCounts["chart.indicatorSeries.create"] || 0) <= 0) return false;
  if (!hasIndicatorSeriesDataCoverage(performanceReport, { overlayHeavy })) return false;
  if (!overlayHeavy) return true;
  return (chartEventCounts["chart.fillSeries.create"] || 0) > 0
    && (chartEventCounts["chart.hline.create"] || 0) > 0;
}

async function waitForSeededIndicatorReport(cdp, args) {
  if (!args.seedIndicators) return readPerfReport(cdp);

  const started = Date.now();
  let report = await readPerfReport(cdp);
  const timeoutMs = Math.max(5_000, Math.min(args.timeoutMs, 30_000));
  while (Date.now() - started < timeoutMs) {
    if (hasSeededIndicatorCoverage(report, { overlayHeavy: args.overlayHeavy })) return report;
    await wait(500);
    report = await readPerfReport(cdp);
  }
  return report;
}

function summarizePerformanceEvents(performanceReport) {
  const events = Array.isArray(performanceReport?.events) ? performanceReport.events : [];
  const eventCounts = {};
  const chartEventCounts = {};
  for (const event of events) {
    const name = event?.name;
    if (!name) continue;
    eventCounts[name] = (eventCounts[name] || 0) + 1;
    if (name.startsWith("chart.")) {
      chartEventCounts[name] = (chartEventCounts[name] || 0) + 1;
    }
  }
  return { eventCounts, chartEventCounts };
}

async function waitForExpression(cdp, expression, timeoutMs = 5_000, pollMs = 50) {
  const started = Date.now();
  let matched = false;
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    matched = Boolean(result.result?.value);
    if (matched) return true;
    await wait(pollMs);
  }
  return false;
}

async function markShortSwitchStepStart(cdp, phase, interval) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const event = window.__CANDLESCOPE_PERF__?.event?.(
        "smoke.shortSwitch.step.start",
        { phase: ${JSON.stringify(phase)}, interval: ${JSON.stringify(interval)} }
      );
      return Math.max(0, Math.floor(Number(event?.at ?? performance.now())));
    })()`,
    returnByValue: true,
  });
  return Number(result.result?.value) || 0;
}

async function clickInterval(cdp, interval) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const interval = ${JSON.stringify(interval)};
      const direct = document.getElementById("interval-" + interval);
      const candidates = direct ? [direct] : Array.from(document.querySelectorAll(
        '#toolbar button, .interval-presets button, .interval-panel-row, button'
      ));
      const target = candidates.find((element) => {
        const text = (element.textContent || '').trim();
        const title = (element.getAttribute('title') || '').trim();
        const aria = (element.getAttribute('aria-label') || '').trim();
        return element === direct || text === interval || title === interval || aria === interval;
      });
      if (!target) return { ok: false, interval, reason: 'button-not-found' };
      const wasActive = Boolean(
        target.classList.contains('active')
        || document.querySelector('.interval-more-value')?.textContent?.trim() === interval
      );
      target.click();
      return { ok: true, interval, text: (target.textContent || '').trim(), wasActive };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, interval, reason: "evaluation-failed" };
}

async function waitForIntervalReady(cdp, interval, sincePerfMs, timeoutMs) {
  const started = Date.now();
  let detail = null;
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const interval = ${JSON.stringify(interval)};
        const since = ${JSON.stringify(sincePerfMs)};
        const activeButton = document.getElementById("interval-" + interval);
        const activeValue = document.querySelector('.interval-more-value')?.textContent?.trim();
        const active = Boolean(activeButton?.classList.contains('active') || activeValue === interval);
        const events = window.__CANDLESCOPE_PERF__?.report?.()?.events || [];
        const commit = [...events].reverse().find((event) => (
          event?.name === 'chart.data.commit'
          && event.atMs >= since
          && event.detail?.interval === interval
          && event.detail?.status === 'ready'
          && Number(event.detail?.bars || 0) > 0
        ));
        return { active, commit: commit || null };
      })()`,
      returnByValue: true,
    });
    detail = result.result?.value || null;
    if (detail?.active && detail?.commit) {
      return { ready: true, elapsedMs: Date.now() - started, detail };
    }
    await wait(100);
  }
  return { ready: false, elapsedMs: Date.now() - started, detail };
}

function buildShortSwitchReadinessOptions(interval, datasetKey, sincePerfMs, args) {
  const expectedIndicatorIds = (args.overlayHeavy
    ? SMOKE_OVERLAY_HEAVY_INDICATORS
    : SMOKE_ACTIVE_INDICATORS)
    .map((indicator) => indicator.id);
  const expectedSeriesCounts = args.overlayHeavy
    ? { ma: 1, vol: 1, boll: 3, rsi: 1 }
    : { ma: 1 };
  return {
    datasetKey,
    expectedIndicatorIds,
    expectedSeriesCounts,
    interval,
    sinceAtMs: sincePerfMs,
  };
}

async function waitForShortSwitchIndicatorBarrier(cdp, readinessOptions, args) {
  const started = Date.now();
  const timeoutMs = Math.max(15_000, Math.min(args.timeoutMs, 30_000));
  let detail = summarizeShortSwitchIndicatorReadiness(null, readinessOptions);
  while (Date.now() - started < timeoutMs) {
    const performanceReport = await readPerfReport(cdp);
    detail = summarizeShortSwitchIndicatorReadiness(performanceReport, readinessOptions);
    if (detail.ready) {
      return { ready: true, elapsedMs: Date.now() - started, detail };
    }
    await wait(100);
  }
  return { ready: false, elapsedMs: Date.now() - started, detail };
}

async function runShortSwitchStep(
  cdp,
  networkCapture,
  interval,
  phase,
  args,
  { allowInitialPrime = false } = {},
) {
  networkCapture.startPhase(phase);
  const sincePerfMs = await markShortSwitchStepStart(cdp, phase, interval);
  const startedAtMs = Date.now();
  const click = await clickInterval(cdp, interval);
  const transition = resolveShortSwitchStepTransition({
    allowInitialPrime,
    clickOk: click.ok,
    wasActive: click.wasActive,
  });
  const readinessSincePerfMs = transition.primedFromInitial ? 0 : sincePerfMs;
  const ready = transition.readyEligible
    ? await waitForIntervalReady(cdp, interval, readinessSincePerfMs, args.timeoutMs)
    : {
      ready: false,
      elapsedMs: 0,
      detail: { reason: click.wasActive ? "already-active-no-transition" : click.reason || "click-failed" },
    };
  const datasetKey = ready.detail?.commit?.detail?.datasetKey || null;
  const readinessOptions = buildShortSwitchReadinessOptions(
    interval,
    datasetKey,
    readinessSincePerfMs,
    args,
  );
  const indicatorBarrierWait = ready.ready
    ? await waitForShortSwitchIndicatorBarrier(cdp, readinessOptions, args)
    : { ready: false, elapsedMs: 0, detail: null };
  await wait(Math.max(0, args.shortSwitchSettleMs));
  const networkIdle = await networkCapture.waitForIdle({
    quietMs: 1_000,
    timeoutMs: Math.max(5_000, args.shortSwitchSettleMs + 5_000),
  });
  const performanceReport = await readPerfReport(cdp);
  const finalBarrierDetail = summarizeShortSwitchIndicatorReadiness(
    performanceReport,
    readinessOptions,
  );
  const indicatorBarrier = {
    ...indicatorBarrierWait,
    ready: Boolean(indicatorBarrierWait.ready && finalBarrierDetail.indicatorDataReady),
    detail: finalBarrierDetail,
  };
  const indicatorDataReady = Boolean(finalBarrierDetail.indicatorDataReady);
  return {
    phase,
    interval,
    startedAtMs,
    elapsedMs: Date.now() - startedAtMs,
    sincePerfMs,
    transitioned: transition.transitioned,
    primedFromInitial: transition.primedFromInitial,
    click,
    ready,
    indicatorBarrier,
    networkIdle,
    indicatorDataReady,
    indicatorRangeNetwork: networkCapture.summary({ phase }),
  };
}

async function runShortSwitchAcceptance(cdp, networkCapture, args) {
  const [first, second] = args.shortSwitchIntervals;
  if (!first || !second) {
    throw new Error("--short-switch-intervals requires exactly two comma-separated intervals");
  }

  const steps = [];
  steps.push(await runShortSwitchStep(
    cdp,
    networkCapture,
    first,
    `short-switch-warm:${first}`,
    args,
    { allowInitialPrime: true },
  ));
  steps.push(await runShortSwitchStep(
    cdp,
    networkCapture,
    second,
    `short-switch-warm:${second}`,
    args,
  ));
  steps.push(await runShortSwitchStep(
    cdp,
    networkCapture,
    first,
    `short-switch-measured:${first}`,
    args,
  ));
  steps.push(await runShortSwitchStep(
    cdp,
    networkCapture,
    second,
    `short-switch-measured:${second}`,
    args,
  ));

  const measured = networkCapture.summary({ phasePrefix: "short-switch-measured:" });
  const maxIndicatorRequests = Math.max(0, args.shortSwitchMaxIndicatorRequests);
  const stepsReady = steps.every((step) => (
    step.click.ok
    && step.ready.ready
    && step.indicatorBarrier?.ready
    && step.networkIdle
    && step.indicatorDataReady
  ));
  return {
    intervals: [first, second],
    sequence: [first, second, first, second],
    settleMs: args.shortSwitchSettleMs,
    steps,
    measured,
    acceptance: {
      maxIndicatorRangeRequests: maxIndicatorRequests,
      actualIndicatorRangeRequests: measured.requestCount,
      stepsReady,
      passed: stepsReady && measured.requestCount <= maxIndicatorRequests,
    },
  };
}

async function openSettings(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('.settings-btn'); if (!button) return false; button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); button.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); button.focus(); return true; })()",
    returnByValue: true,
  });
  await wait(350);
  const started = Date.now();
  const clickResult = await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('.settings-btn'); if (!button) return false; button.click(); return true; })()",
    returnByValue: true,
  });

  const [settingsReport, settingsOpened] = await Promise.all([
    waitForPerfTiming(cdp, "settingsOpenMs", 5_000, 25),
    waitForExpression(
      cdp,
      "Boolean(document.querySelector('.st-overlay .st-panel') && document.querySelector('.st-sidebar') && document.querySelector('.st-btn-close'))",
      5_000,
      25,
    ),
  ]);
  const settingsOpenMs = settingsReport?.timings?.settingsOpenMs ?? (settingsOpened ? Date.now() - started : null);

  return {
    settingsButtonClicked: Boolean(clickResult.result?.value),
    settingsOpened,
    settingsOpenMs,
  };
}

async function verifyLazySurfaces(cdp) {
  const [toolbarReport, drawingToolbarLoaded] = await Promise.all([
    waitForPerfTiming(cdp, "drawingToolbarReadyMs", 10_000, 50),
    waitForExpression(
      cdp,
      "Boolean(document.querySelector('.drawing-toolbar:not(.drawing-toolbar-loading) .drawing-tool-btn'))",
      10_000,
      50,
    ),
  ]);
  const drawingToolbarReadyMs = toolbarReport?.timings?.drawingToolbarReadyMs ?? null;

  await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('#symbol-selector'); if (!button) return false; button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); button.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); button.focus(); return true; })()",
    returnByValue: true,
  });
  await wait(350);
  const symbolStarted = Date.now();
  const symbolClickResult = await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('#symbol-selector'); if (!button) return false; button.click(); return true; })()",
    returnByValue: true,
  });

  const [symbolReport, symbolSearchOpened] = await Promise.all([
    waitForPerfTiming(cdp, "symbolSearchOpenMs", 5_000, 25),
    waitForExpression(cdp, "Boolean(document.querySelector('.sym-modal-overlay .sym-modal'))", 5_000, 25),
  ]);
  const symbolSearchOpenMs = symbolReport?.timings?.symbolSearchOpenMs ?? (symbolSearchOpened ? Date.now() - symbolStarted : null);

  await cdp.send("Runtime.evaluate", {
    expression: "document.querySelector('.sym-modal-close-btn')?.click()",
    returnByValue: true,
  });

  return {
    drawingToolbarLoaded,
    drawingToolbarReadyMs,
    symbolSearchButtonClicked: Boolean(symbolClickResult.result?.value),
    symbolSearchOpened,
    symbolSearchOpenMs,
  };
}

async function clickSelector(cdp, selector) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    returnByValue: true,
  });
  return Boolean(result.result?.value);
}

async function waitForSelector(cdp, selector, timeoutMs = 5_000) {
  const started = Date.now();
  let found = false;
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      returnByValue: true,
    });
    found = Boolean(result.result?.value);
    if (found) return true;
    await wait(250);
  }
  return false;
}

async function getRect(cdp, selector) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || null;
}

async function dispatchClick(cdp, x, y) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const x = ${JSON.stringify(x)};
      const y = ${JSON.stringify(y)};
      const target = document.elementFromPoint(x, y);
      if (!target) return false;
      const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
      target.dispatchEvent(new MouseEvent("mousedown", { ...common, buttons: 1 }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      target.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
      target.dispatchEvent(new MouseEvent("click", common));
      return true;
    })()`,
    returnByValue: true,
  });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchDrag(cdp, fromX, fromY, toX, toY, steps = 8) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fromX,
    y: fromY,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(fromX + (toX - fromX) * progress),
      y: Math.round(fromY + (toY - fromY) * progress),
      button: "left",
      buttons: 1,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function readSavedDrawingCount(cdp, drawingKey) {
  const drawings = await readSavedDrawings(cdp, drawingKey);
  return drawings.length;
}

async function readSavedDrawings(cdp, drawingKey) {
  const storageKey = `candlescope-drawings-${drawingKey}`;
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        const raw = localStorage.getItem(${JSON.stringify(storageKey)});
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })()`,
    returnByValue: true,
  });
  return Array.isArray(result.result?.value) ? result.result.value : [];
}

async function readLatestChartLastTime(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const report = window.__CANDLESCOPE_PERF__?.report?.();
      const events = Array.isArray(report?.events) ? report.events : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.name !== "chart.data.commit") continue;
        const detail = event.detail || {};
        if (
          detail.symbol === "BTCUSDT"
          && detail.interval === "1h"
          && (detail.status === "ready" || detail.status === "provisional")
          && Number.isFinite(detail.lastTime)
        ) {
          return detail.lastTime;
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  return Number.isFinite(value) ? value : null;
}

async function waitForSavedDrawing(cdp, drawingKey, timeoutMs = 5_000) {
  const started = Date.now();
  let count = await readSavedDrawingCount(cdp, drawingKey);
  while (Date.now() - started < timeoutMs) {
    if (count > 0) return count;
    await wait(250);
    count = await readSavedDrawingCount(cdp, drawingKey);
  }
  return count;
}

async function verifyDrawingWorkflow(cdp, timeoutMs) {
  const drawingKey = "binance:spot:BTCUSDT__main";
  const lineButtonSelector = '[data-drawing-tool="line-segment"]';
  const chartSelector = '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]';

  const lineToolClicked = await clickSelector(cdp, lineButtonSelector);
  await wait(250);
  const activeResult = await cdp.send("Runtime.evaluate", {
    expression: `Boolean(document.querySelector(${JSON.stringify(`${lineButtonSelector}.active`)}))`,
    returnByValue: true,
  });
  const lineToolActive = Boolean(activeResult.result?.value);
  const drawingEngineReady = lineToolActive
    ? await waitForSelector(cdp, '[data-drawing-engine="ready"]')
    : false;

  const rect = await getRect(cdp, chartSelector);
  let drawingPersistedCount = 0;
  let drawingRestoredCount = 0;
  let reloadLoadedAtMs = null;
  let futureAnchorStored = false;
  let chartLastTime = null;

  if (rect && lineToolActive && drawingEngineReady) {
    chartLastTime = await readLatestChartLastTime(cdp);
    const y = Math.round(rect.y + rect.height * 0.45);
    await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.35), y);
    await wait(150);
    await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.58), Math.round(rect.y + rect.height * 0.42));
    drawingPersistedCount = await waitForSavedDrawing(cdp, drawingKey);

    if (drawingPersistedCount > 0) {
      await clickSelector(cdp, '[data-drawing-tool="cursor"]');
      await wait(150);
      await dispatchDrag(
        cdp,
        Math.round(rect.x + rect.width * 0.72),
        Math.round(rect.y + rect.height * 0.58),
        Math.round(rect.x + rect.width * 0.38),
        Math.round(rect.y + rect.height * 0.58),
      );
      await wait(300);
      await clickSelector(cdp, lineButtonSelector);
      await wait(150);
      await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.76), Math.round(rect.y + rect.height * 0.35));
      await wait(150);
      await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.86), Math.round(rect.y + rect.height * 0.43));
      await wait(500);
      const savedDrawings = await readSavedDrawings(cdp, drawingKey);
      futureAnchorStored = savedDrawings.some((drawing) => (
        Array.isArray(drawing?.dataPoints)
        && drawing.dataPoints.length > 0
        && drawing.dataPoints.every((point) => Number.isFinite(point?.time))
        && drawing.dataPoints.some((point) => (
          chartLastTime != null
          && point.time > chartLastTime
          && !Number.isFinite(point?.barOffsetFromLast)
        ))
      ));
      await cdp.send("Page.reload", { ignoreCache: true });
      const reloadResult = await waitForChartReady(cdp, timeoutMs);
      reloadLoadedAtMs = reloadResult.loadedAt;
      drawingRestoredCount = await readSavedDrawingCount(cdp, drawingKey);
    }
  }

  return {
    drawingLineToolClicked: lineToolClicked,
    drawingLineToolActive: lineToolActive,
    drawingEngineReady,
    drawingChartRectFound: Boolean(rect),
    drawingPersistedCount,
    futureAnchorStored,
    drawingReloadLoadedAtMs: reloadLoadedAtMs,
    drawingRestoredCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.shortSwitch && args.shortSwitchIntervals.length !== 2) {
    throw new Error("--short-switch-intervals requires exactly two comma-separated intervals");
  }
  if (args.shortSwitch && !args.seedIndicators) {
    throw new Error("--short-switch requires seeded indicators; remove --no-seed-indicators");
  }
  if (!Number.isFinite(args.shortSwitchSettleMs) || args.shortSwitchSettleMs < 0) {
    throw new Error("--short-switch-settle-ms must be a non-negative number");
  }
  if (
    !Number.isFinite(args.shortSwitchMaxIndicatorRequests)
    || args.shortSwitchMaxIndicatorRequests < 0
  ) {
    throw new Error("--short-switch-max-indicator-requests must be a non-negative number");
  }
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to the browser executable.");
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-smoke-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-downloads-"));
  const screenshot = args.screenshot || path.join(os.tmpdir(), "candlescope-smoke.png");
  const debugPort = await getFreePort();
  const debugBase = `http://127.0.0.1:${debugPort}`;
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const warnings = [];
  const exceptions = [];
  const failures = [];
  const responses = [];
  const requestUrls = new Map();
  let cdp;
  let indicatorRangeNetworkCapture;

  try {
    await waitForDevTools(debugBase);
    const target = await readHttpJson(`${debugBase}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.connect();
    indicatorRangeNetworkCapture = createIndicatorRangeNetworkCapture(cdp);

    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (["warning", "error"].includes(event.type)) {
        warnings.push({
          type: event.type,
          text: event.args?.map((arg) => arg.value || arg.description || "").join(" "),
        });
      }
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      exceptions.push({
        atMs: Date.now(),
        timestamp: event.timestamp ?? null,
        text: event.exceptionDetails?.exception?.description
          || event.exceptionDetails?.text
          || "Uncaught runtime exception",
        url: event.exceptionDetails?.url || "",
        lineNumber: event.exceptionDetails?.lineNumber ?? null,
        columnNumber: event.exceptionDetails?.columnNumber ?? null,
      });
    });
    cdp.on("Network.requestWillBeSent", (event) => {
      if (event.requestId && event.request?.url) requestUrls.set(event.requestId, event.request.url);
    });
    cdp.on("Network.responseReceived", (event) => {
      if (event.response?.url?.includes("/api/")) {
        responses.push({ status: event.response.status, url: event.response.url });
      }
    });
    cdp.on("Network.loadingFailed", (event) => {
      const url = requestUrls.get(event.requestId) || "";
      const isCanceled = event.canceled || event.errorText === "net::ERR_ABORTED";
      if (event.errorText && !isCanceled) {
        failures.push({ errorText: event.errorText, requestId: event.requestId, type: event.type, url });
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS);
    await cdp.send("Page.enable");
    if (args.exportMatrix) {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    }
    if (args.seedIndicators) {
      const activeIndicators = args.overlayHeavy ? SMOKE_OVERLAY_HEAVY_INDICATORS : SMOKE_ACTIVE_INDICATORS;
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          try {
            localStorage.setItem("candlescope-active-indicators", ${JSON.stringify(JSON.stringify(activeIndicators))});
            localStorage.setItem("candlescope-vol-initialized", "1");
          } catch {}
        `,
      });
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: args.url });

    const { bodyText, loadedAt } = await waitForChartReady(cdp, args.timeoutMs);
    const chartTypeMatrix = args.chartTypeMatrix
      ? await runChartTypeMatrix({
          args,
          cdp,
          consoleMessages: warnings,
          wait,
          waitForChartReady,
          waitForExpression,
        })
      : null;
    let shortSwitch = null;
    let initialSeededIndicatorReport = null;
    if (args.shortSwitch) {
      initialSeededIndicatorReport = await waitForSeededIndicatorReport(cdp, args);
      await indicatorRangeNetworkCapture.waitForIdle({ quietMs: 1_000, timeoutMs: 10_000 });
      shortSwitch = await runShortSwitchAcceptance(cdp, indicatorRangeNetworkCapture, args);
      indicatorRangeNetworkCapture.startPhase("post-short-switch");
    }
    const drawingWorkflow = args.drawingCheck ? await verifyDrawingWorkflow(cdp, args.timeoutMs) : null;
    const exportMatrix = args.exportMatrix
      ? await runExportMatrix({
          cdp,
          args,
          downloadDir,
          clickSelector,
          wait,
          waitForExpression,
          waitForSelector,
          getRuntimeIssueCount: () => exceptions.length,
        })
      : null;
    const lazySurfaces = await verifyLazySurfaces(cdp);
    const settings = await openSettings(cdp);
    const performanceTimings = await waitForSeededIndicatorReport(cdp, args);
    const performanceEventSummary = summarizePerformanceEvents(performanceTimings);
    const seededIndicatorCoverage = hasSeededIndicatorCoverage(performanceTimings, {
      overlayHeavy: args.overlayHeavy,
    }) || hasSeededIndicatorCoverage(initialSeededIndicatorReport, {
      overlayHeavy: args.overlayHeavy,
    });
    const overlayHeavyCoverage = args.overlayHeavy ? seededIndicatorCoverage : null;
    const indicatorSnapshotIds = Array.from(getIndicatorSnapshotIds(performanceTimings));
    await indicatorRangeNetworkCapture.waitForIdle({ quietMs: 500, timeoutMs: 3_000 });
    await indicatorRangeNetworkCapture.flush();
    const indicatorRangeRequests = indicatorRangeNetworkCapture.records();
    const indicatorRangeNetwork = indicatorRangeNetworkCapture.summary();
    const screenshotData = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(screenshot, Buffer.from(screenshotData.data, "base64"));

    const report = {
      url: args.url,
      loadedAtMs: loadedAt,
      bars: parseBarCount(bodyText),
      connected: bodyText.includes("Connected to Binance"),
      live: bodyText.includes("Live (WebSocket)"),
      ...lazySurfaces,
      ...settings,
      drawingWorkflow,
      exportMatrix,
      smokeTimings: {
        chartLoadedAtMs: loadedAt,
        drawingToolbarReadyMs: lazySurfaces.drawingToolbarReadyMs,
        symbolSearchOpenMs: lazySurfaces.symbolSearchOpenMs,
        settingsOpenMs: settings.settingsOpenMs,
      },
      performance: performanceTimings,
      performanceEventSummary,
      indicatorSnapshotIds,
      seededIndicatorCoverage,
      overlayHeavyCoverage,
      indicatorRangeNetwork: {
        ...indicatorRangeNetwork,
        requests: indicatorRangeRequests,
      },
      shortSwitch,
      chartTypeMatrix,
      apiResponses: responses.slice(0, 20),
      failures,
      warnings: warnings.slice(0, 20),
      exceptions: exceptions.slice(0, 20),
      screenshot,
      seededIndicators: args.seedIndicators,
      overlayHeavy: args.overlayHeavy,
      drawingCheck: args.drawingCheck,
      chartTypeMatrixCheck: args.chartTypeMatrix,
      exportMatrixCheck: args.exportMatrix,
      shortSwitchCheck: args.shortSwitch,
    };

    console.log(JSON.stringify(report, null, 2));

    const failed = !report.connected
      || !report.live
      || report.bars <= 0
      || !report.drawingToolbarLoaded
      || !report.symbolSearchOpened
      || !report.settingsOpened
      || (args.drawingCheck && (
        !drawingWorkflow?.drawingLineToolClicked
        || !drawingWorkflow?.drawingLineToolActive
        || !drawingWorkflow?.drawingEngineReady
        || !drawingWorkflow?.drawingChartRectFound
        || drawingWorkflow?.drawingPersistedCount <= 0
        || !drawingWorkflow?.futureAnchorStored
        || drawingWorkflow?.drawingRestoredCount <= 0
      ))
      || (args.seedIndicators && !seededIndicatorCoverage)
      || (args.seedIndicators && args.overlayHeavy && !overlayHeavyCoverage)
      || (args.shortSwitch && !shortSwitch?.acceptance?.passed)
      || (args.chartTypeMatrix && !chartTypeMatrix?.passed)
      || (args.exportMatrix && !exportMatrix?.passed)
      || exceptions.length > 0
      || responses.some((response) => response.status >= 400)
      || failures.length > 0;
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    await stopProcess(chrome);
    await removeDirectoryWithRetries(userDataDir);
    await removeDirectoryWithRetries(downloadDir);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
