import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:5173/";
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

function hasOverlayHeavyCoverage(performanceReport) {
  const expectedSnapshotIds = ["ma", "vol", "boll", "rsi"];
  const snapshotIds = getIndicatorSnapshotIds(performanceReport);
  const { chartEventCounts } = summarizePerformanceEvents(performanceReport);
  return expectedSnapshotIds.every((id) => snapshotIds.has(id))
    && (chartEventCounts["chart.fillSeries.create"] || 0) > 0
    && (chartEventCounts["chart.hline.create"] || 0) > 0;
}

async function waitForSeededIndicatorReport(cdp, args) {
  if (!args.seedIndicators) return readPerfReport(cdp);
  if (!args.overlayHeavy) return waitForPerfTiming(cdp, "indicatorHostedSnapshotMs");

  const started = Date.now();
  let report = await readPerfReport(cdp);
  const timeoutMs = Math.max(15_000, Math.min(args.timeoutMs, 30_000));
  while (Date.now() - started < timeoutMs) {
    if (hasOverlayHeavyCoverage(report)) return report;
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

  if (rect && lineToolActive && drawingEngineReady) {
    const y = Math.round(rect.y + rect.height * 0.45);
    await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.35), y);
    await wait(150);
    await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.58), Math.round(rect.y + rect.height * 0.42));
    drawingPersistedCount = await waitForSavedDrawing(cdp, drawingKey);

    if (drawingPersistedCount > 0) {
      await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.94), Math.round(rect.y + rect.height * 0.35));
      await wait(150);
      await dispatchClick(cdp, Math.round(rect.x + rect.width * 0.97), Math.round(rect.y + rect.height * 0.43));
      await wait(500);
      const savedDrawings = await readSavedDrawings(cdp, drawingKey);
      futureAnchorStored = savedDrawings.some((drawing) => (
        Array.isArray(drawing?.dataPoints)
        && drawing.dataPoints.some((point) => (
          Number.isFinite(point?.barOffsetFromLast)
          && point.time == null
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
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to the browser executable.");
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-smoke-"));
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
  const failures = [];
  const responses = [];
  const requestUrls = new Map();
  let cdp;

  try {
    await waitForDevTools(debugBase);
    const target = await readHttpJson(`${debugBase}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.connect();

    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (["warning", "error"].includes(event.type)) {
        warnings.push({
          type: event.type,
          text: event.args?.map((arg) => arg.value || arg.description || "").join(" "),
        });
      }
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
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
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
    const drawingWorkflow = args.drawingCheck ? await verifyDrawingWorkflow(cdp, args.timeoutMs) : null;
    const lazySurfaces = await verifyLazySurfaces(cdp);
    const settings = await openSettings(cdp);
    const performanceTimings = await waitForSeededIndicatorReport(cdp, args);
    const performanceEventSummary = summarizePerformanceEvents(performanceTimings);
    const overlayHeavyCoverage = args.overlayHeavy ? hasOverlayHeavyCoverage(performanceTimings) : null;
    const indicatorSnapshotIds = Array.from(getIndicatorSnapshotIds(performanceTimings));
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
      smokeTimings: {
        chartLoadedAtMs: loadedAt,
        drawingToolbarReadyMs: lazySurfaces.drawingToolbarReadyMs,
        symbolSearchOpenMs: lazySurfaces.symbolSearchOpenMs,
        settingsOpenMs: settings.settingsOpenMs,
      },
      performance: performanceTimings,
      performanceEventSummary,
      indicatorSnapshotIds,
      overlayHeavyCoverage,
      apiResponses: responses.slice(0, 20),
      failures,
      warnings: warnings.slice(0, 20),
      screenshot,
      seededIndicators: args.seedIndicators,
      overlayHeavy: args.overlayHeavy,
      drawingCheck: args.drawingCheck,
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
      || (args.seedIndicators && !performanceTimings?.timings?.indicatorHostedSnapshotMs)
      || (args.seedIndicators && args.overlayHeavy && !overlayHeavyCoverage)
      || failures.length > 0;
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    await stopProcess(chrome);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 9) await wait(500);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
