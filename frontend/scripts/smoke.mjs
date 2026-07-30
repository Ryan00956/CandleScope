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
  summarizeShortSwitchLongTasks,
} from "./short-switch-readiness.mjs";
import { runChartTypeMatrix } from "./chart-type-matrix.mjs";
import {
  assessDrawingEngineDomEvidence,
  drawingEngineDomEvidenceBrowserSnapshot,
  formatDrawingEngineDomEvidenceFailure,
  shouldRequireDrawingEngineDomEvidenceForSmoke,
} from "./drawing-engine-dom-evidence.mjs";
import {
  assessTwoClickDrawingCreationEvidence,
} from "./drawing-two-click-creation-evidence.mjs";

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DRAWING_DOCUMENT_DATABASE_NAME = "candlescope-drawings-v2";
const DRAWING_DOCUMENT_STORE_NAME = "documents";
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
const ADVANCED_MARKET_STUDIES = [
  {
    id: "market:funding-rate",
    name: "资金费率 (Funding Rate)",
    paneId: "funding-rate",
  },
  {
    id: "market:open-interest",
    name: "未平仓量 (Open Interest)",
    paneId: "open-interest",
  },
];
const ADVANCED_MARKET_HIDDEN_STATUS = "已隐藏，实时订阅已暂停";

function parseArgs(argv) {
  const args = {
    url: process.env.SMOKE_URL || DEFAULT_URL,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    chromePath: process.env.CHROME_PATH || "",
    screenshot: process.env.SMOKE_SCREENSHOT || "",
    marketType: process.env.SMOKE_MARKET_TYPE || "futures",
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
    else if (arg === "--market-type") args.marketType = argv[++i];
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

async function readAdvancedMarketState(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const metricIds = ["mark-price", "index-price", "basis"];
      const paneIds = ["funding-rate", "open-interest"];
      const parseFiniteValue = (element) => {
        if (!element) return null;
        const candidates = [
          element.getAttribute("data-market-value"),
          element.getAttribute("data-value"),
          element.getAttribute("aria-label"),
          element.textContent,
        ];
        for (const candidate of candidates) {
          const match = String(candidate || "")
            .replaceAll(",", "")
            .match(/[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?/i);
          if (!match) continue;
          const value = Number(match[0]);
          if (Number.isFinite(value)) return value;
        }
        return null;
      };
      const metrics = Object.fromEntries(metricIds.map((id) => {
        const selector = '[data-market-metric="' + id + '"]';
        const element = document.querySelector(selector);
        return [id, {
          selector,
          present: Boolean(element),
          text: String(element?.textContent || "").trim(),
          value: parseFiniteValue(element),
        }];
      }));
      const panes = Object.fromEntries(paneIds.map((id) => {
        const selector = '[data-market-pane="' + id + '"]';
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return [id, {
          selector,
          present: Boolean(element),
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          text: String(element?.textContent || "").trim(),
        }];
      }));
      const summaryReady = Object.values(metrics).every((item) => Number.isFinite(item.value));
      const panesVisible = Object.values(panes).every((item) => item.present && item.visible);
      const panesHidden = Object.values(panes).every((item) => !item.present);
      return {
        metrics,
        panes,
        summaryReady,
        panesVisible,
        panesHidden,
        ready: summaryReady && panesVisible,
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || {
    metrics: {},
    panes: {},
    summaryReady: false,
    panesVisible: false,
    panesHidden: false,
    ready: false,
  };
}

async function waitForAdvancedMarketState(cdp, timeoutMs = 15_000) {
  const started = Date.now();
  let state = await readAdvancedMarketState(cdp);
  while (!state.ready && Date.now() - started < timeoutMs) {
    await wait(250);
    state = await readAdvancedMarketState(cdp);
  }
  return {
    ...state,
    checked: true,
    readyAtMs: state.ready ? Date.now() - started : null,
  };
}

async function waitForAdvancedMarketDefaultState(cdp, timeoutMs = 15_000) {
  const started = Date.now();
  let state = await readAdvancedMarketState(cdp);
  const isReady = () => state.summaryReady && state.panesHidden;
  while (!isReady() && Date.now() - started < timeoutMs) {
    await wait(250);
    state = await readAdvancedMarketState(cdp);
  }
  const ready = isReady();
  return {
    ...state,
    checked: true,
    ready,
    readyAtMs: ready ? Date.now() - started : null,
  };
}

async function clickMarketStudyAddButton(cdp, study) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const expectedName = ${JSON.stringify(study.name)};
      const groups = Array.from(document.querySelectorAll('.indicator-category-group'));
      const group = groups.find((element) => (
        element.querySelector('.indicator-category-label')?.textContent?.includes('合约数据')
      ));
      if (!group) return { ok: false, reason: 'contract-data-group-not-found' };
      const items = Array.from(group.querySelectorAll('.indicator-preset-item'));
      const item = items.find((element) => (
        element.querySelector('.indicator-preset-name')?.textContent?.includes(expectedName)
      ));
      if (!item) return { ok: false, reason: 'study-not-found', expectedName };
      const button = item.querySelector('.indicator-add-btn');
      if (!(button instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'add-button-not-found', expectedName };
      }
      if (button.disabled) {
        return {
          ok: false,
          reason: 'add-button-disabled',
          expectedName,
          title: button.title,
        };
      }
      button.click();
      return { ok: true, expectedName, buttonText: button.textContent?.trim() || '' };
    })()`,
    returnByValue: true,
  });
  const click = result.result?.value || { ok: false, reason: "evaluation-failed" };
  if (!click.ok) return { ...study, click, reflected: false };

  const reflected = await waitForExpression(
    cdp,
    `(() => {
      const expectedName = ${JSON.stringify(study.name)};
      return Array.from(document.querySelectorAll('.indicator-preset-item.is-active')).some(
        (element) => element.querySelector('.indicator-preset-name')?.textContent?.includes(expectedName)
      );
    })()`,
    5_000,
    50,
  );
  return { ...study, click, reflected };
}

async function addAdvancedMarketStudiesThroughUi(cdp) {
  const indicatorButtonClicked = await clickSelector(
    cdp,
    '.indicator-toggle-btn:not(.alert-toggle-btn)',
  );
  const indicatorPanelOpened = indicatorButtonClicked
    && await waitForSelector(cdp, '.indicator-panel-overlay .indicator-panel', 5_000);
  const contractDataSectionFound = indicatorPanelOpened && await waitForExpression(
    cdp,
    `Array.from(document.querySelectorAll('.indicator-category-label')).some(
      (element) => element.textContent?.includes('合约数据')
    )`,
    5_000,
    50,
  );
  const studies = [];
  if (contractDataSectionFound) {
    for (const study of ADVANCED_MARKET_STUDIES) {
      studies.push(await clickMarketStudyAddButton(cdp, study));
    }
  }
  const panelClosed = indicatorPanelOpened
    ? await clickSelector(cdp, '.indicator-panel-close')
    : false;
  const ready = indicatorButtonClicked
    && indicatorPanelOpened
    && contractDataSectionFound
    && studies.length === ADVANCED_MARKET_STUDIES.length
    && studies.every((study) => study.click?.ok && study.reflected);
  return {
    indicatorButtonClicked,
    indicatorPanelOpened,
    contractDataSectionFound,
    studies,
    panelClosed,
    ready,
  };
}

async function openAddedMarketStudies(cdp) {
  const indicatorButtonClicked = await clickSelector(
    cdp,
    '.indicator-toggle-btn:not(.alert-toggle-btn)',
  );
  const indicatorPanelOpened = indicatorButtonClicked
    && await waitForSelector(cdp, '.indicator-panel-overlay .indicator-panel', 5_000);
  const activeTabClick = indicatorPanelOpened
    ? await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const tab = Array.from(document.querySelectorAll('.indicator-tab')).find(
            (element) => element.textContent?.includes('已添加')
          );
          if (!(tab instanceof HTMLButtonElement)) return false;
          tab.click();
          return true;
        })()`,
        returnByValue: true,
      })
    : null;
  const activeTabClicked = Boolean(activeTabClick?.result?.value);
  const activeStudiesVisible = activeTabClicked && await waitForExpression(
    cdp,
    `(() => {
      const expectedNames = ${JSON.stringify(ADVANCED_MARKET_STUDIES.map((study) => study.name))};
      const names = Array.from(document.querySelectorAll('.indicator-active-name')).map(
        (element) => element.textContent || ''
      );
      return expectedNames.every((expectedName) => names.some((name) => name.includes(expectedName)));
    })()`,
    5_000,
    50,
  );
  return {
    indicatorButtonClicked,
    indicatorPanelOpened,
    activeTabClicked,
    activeStudiesVisible,
    ready: indicatorButtonClicked
      && indicatorPanelOpened
      && activeTabClicked
      && activeStudiesVisible,
  };
}

async function clickMarketStudyVisibilityButton(cdp, study, hidden) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const expectedName = ${JSON.stringify(study.name)};
      const expectedHidden = ${JSON.stringify(hidden)};
      const item = Array.from(document.querySelectorAll('.indicator-active-item')).find(
        (element) => element.querySelector('.indicator-active-name')?.textContent?.includes(expectedName)
      );
      if (!item) return { ok: false, reason: 'active-study-not-found', expectedName };
      const button = item.querySelector('.indicator-visibility-btn');
      if (!(button instanceof HTMLButtonElement)) {
        return { ok: false, reason: 'visibility-button-not-found', expectedName };
      }
      if (button.disabled) {
        return { ok: false, reason: 'visibility-button-disabled', expectedName };
      }
      const beforeHidden = button.classList.contains('hidden');
      if (beforeHidden === expectedHidden) {
        return {
          ok: false,
          reason: 'unexpected-initial-visibility',
          expectedName,
          beforeHidden,
          expectedHidden,
        };
      }
      button.click();
      return { ok: true, expectedName, beforeHidden, expectedHidden };
    })()`,
    returnByValue: true,
  });
  const click = result.result?.value || { ok: false, reason: "evaluation-failed" };
  if (!click.ok) {
    return {
      ...study,
      hidden,
      click,
      reflected: false,
      hiddenStatusVisible: false,
    };
  }

  const reflected = await waitForExpression(
    cdp,
    `(() => {
      const expectedName = ${JSON.stringify(study.name)};
      const expectedHidden = ${JSON.stringify(hidden)};
      const item = Array.from(document.querySelectorAll('.indicator-active-item')).find(
        (element) => element.querySelector('.indicator-active-name')?.textContent?.includes(expectedName)
      );
      const button = item?.querySelector('.indicator-visibility-btn');
      return button instanceof HTMLButtonElement
        && button.classList.contains('hidden') === expectedHidden;
    })()`,
    5_000,
    50,
  );
  const hiddenStatusVisible = hidden && reflected
    ? await waitForExpression(
        cdp,
        `(() => {
          const expectedName = ${JSON.stringify(study.name)};
          const item = Array.from(document.querySelectorAll('.indicator-active-item')).find(
            (element) => element.querySelector('.indicator-active-name')?.textContent?.includes(expectedName)
          );
          return Boolean(item?.textContent?.includes(${JSON.stringify(ADVANCED_MARKET_HIDDEN_STATUS)}));
        })()`,
        5_000,
        50,
      )
    : false;
  return {
    ...study,
    hidden,
    click,
    reflected,
    hiddenStatusVisible,
  };
}

async function waitForMarketPaneVisibility(cdp, study, visible, timeoutMs) {
  const started = Date.now();
  let state = await readAdvancedMarketState(cdp);
  const matches = () => {
    const pane = state.panes?.[study.paneId];
    return visible
      ? Boolean(pane?.present && pane?.visible)
      : !pane?.present;
  };
  while (!matches() && Date.now() - started < timeoutMs) {
    await wait(250);
    state = await readAdvancedMarketState(cdp);
  }
  return {
    paneId: study.paneId,
    expectedVisible: visible,
    pane: state.panes?.[study.paneId] || null,
    matched: matches(),
    readyAtMs: matches() ? Date.now() - started : null,
  };
}

async function verifyAdvancedMarketStudyVisibilityWorkflow(cdp, timeoutMs) {
  const panel = await openAddedMarketStudies(cdp);
  const hiddenStudies = [];
  if (panel.ready) {
    for (const study of ADVANCED_MARKET_STUDIES) {
      const interaction = await clickMarketStudyVisibilityButton(cdp, study, true);
      const pane = await waitForMarketPaneVisibility(cdp, study, false, timeoutMs);
      hiddenStudies.push({ ...interaction, pane });
    }
  }
  const hiddenState = panel.ready
    ? await waitForAdvancedMarketDefaultState(cdp, timeoutMs)
    : { ...await readAdvancedMarketState(cdp), checked: true, ready: false, readyAtMs: null };

  const restoredStudies = [];
  if (panel.ready) {
    for (const study of ADVANCED_MARKET_STUDIES) {
      const interaction = await clickMarketStudyVisibilityButton(cdp, study, false);
      const pane = await waitForMarketPaneVisibility(cdp, study, true, timeoutMs);
      restoredStudies.push({ ...interaction, pane });
    }
  }
  const panelClosed = panel.indicatorPanelOpened
    ? await clickSelector(cdp, '.indicator-panel-close')
    : false;
  const restoredState = panel.ready
    ? await waitForAdvancedMarketState(cdp, timeoutMs)
    : { ...await readAdvancedMarketState(cdp), checked: true, ready: false, readyAtMs: null };
  const hiddenReady = hiddenStudies.length === ADVANCED_MARKET_STUDIES.length
    && hiddenStudies.every((study) => (
      study.click?.ok
      && study.reflected
      && study.hiddenStatusVisible
      && study.pane?.matched
    ))
    && hiddenState.ready;
  const restoredReady = restoredStudies.length === ADVANCED_MARKET_STUDIES.length
    && restoredStudies.every((study) => (
      study.click?.ok
      && study.reflected
      && study.pane?.matched
    ))
    && restoredState.ready;
  return {
    panel,
    hiddenStudies,
    hiddenState,
    hiddenReady,
    restoredStudies,
    restoredState,
    restoredReady,
    panelClosed,
    ready: panel.ready && hiddenReady && restoredReady,
  };
}

async function verifyAdvancedMarketStudyWorkflow(cdp, timeoutMs = 15_000) {
  const defaultState = await waitForAdvancedMarketDefaultState(cdp, timeoutMs);
  const ui = defaultState.ready
    ? await addAdvancedMarketStudiesThroughUi(cdp)
    : {
        indicatorButtonClicked: false,
        indicatorPanelOpened: false,
        contractDataSectionFound: false,
        studies: [],
        panelClosed: false,
        ready: false,
        reason: "default-state-not-ready",
      };
  const addedState = ui.ready
    ? await waitForAdvancedMarketState(cdp, timeoutMs)
    : { ...await readAdvancedMarketState(cdp), checked: true, readyAtMs: null };
  const visibilityWorkflow = addedState.ready
    ? await verifyAdvancedMarketStudyVisibilityWorkflow(cdp, timeoutMs)
    : {
        ready: false,
        reason: "added-state-not-ready",
        restoredState: addedState,
      };
  const finalState = visibilityWorkflow.restoredState || addedState;
  return {
    ...finalState,
    checked: true,
    ready: defaultState.ready
      && ui.ready
      && addedState.ready
      && visibilityWorkflow.ready
      && finalState.ready,
    defaultState,
    ui,
    addedState,
    visibilityWorkflow,
  };
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

function exportPaneLayoutBrowserSnapshot() {
  const chart = globalThis.document?.querySelector?.(
    '.chart-pane[data-pane-id="single-chart"]',
  );
  const chartRect = chart?.getBoundingClientRect?.() || null;
  if (!chart || !chartRect || chartRect.width <= 0 || chartRect.height <= 0) {
    return { ready: false, paneBandCount: 0, chartHeight: 0, paneBands: [] };
  }
  const candidates = Array.from(chart.querySelectorAll("canvas"))
    .map((canvas) => canvas.getBoundingClientRect())
    .filter((rect) => (
      rect.width >= chartRect.width * 0.5
      && rect.height >= 48
      && rect.top >= chartRect.top - 1
      && rect.bottom <= chartRect.bottom + 1
    ))
    .sort((left, right) => left.top - right.top || right.height - left.height);
  const paneBands = [];
  for (const rect of candidates) {
    const top = Math.round(rect.top - chartRect.top);
    const height = Math.round(rect.height);
    if (paneBands.some((band) => (
      Math.abs(band.top - top) <= 2
      && Math.abs(band.height - height) <= 2
    ))) continue;
    paneBands.push({ top, height });
  }
  const mainPaneShorterThanChart = paneBands.length > 1
    && paneBands.some((band) => band.height < chartRect.height - 24);
  return {
    ready: paneBands.length > 1 && mainPaneShorterThanChart,
    paneBandCount: paneBands.length,
    chartHeight: Math.round(chartRect.height),
    mainPaneShorterThanChart,
    paneBands,
  };
}

async function readExportPaneLayout(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(${exportPaneLayoutBrowserSnapshot.toString()})()`,
    returnByValue: true,
  });
  return result.result?.value || null;
}

async function waitForExportPaneLayout(cdp, args) {
  const required = Boolean(args.seedIndicators && args.overlayHeavy);
  if (!required) {
    return { required: false, ready: true, elapsedMs: 0, snapshot: await readExportPaneLayout(cdp) };
  }
  const started = Date.now();
  const timeoutMs = Math.max(5_000, Math.min(args.timeoutMs, 15_000));
  let snapshot = await readExportPaneLayout(cdp);
  while (Date.now() - started < timeoutMs) {
    if (snapshot?.ready) {
      // Let the chart finish the layout frame that exposed the pane canvases;
      // export then captures the same stable pane generation.
      await wait(50);
      const stableSnapshot = await readExportPaneLayout(cdp);
      if (stableSnapshot?.ready) {
        return {
          required: true,
          ready: true,
          elapsedMs: Date.now() - started,
          snapshot: stableSnapshot,
        };
      }
    }
    await wait(100);
    snapshot = await readExportPaneLayout(cdp);
  }
  return {
    required: true,
    ready: false,
    elapsedMs: Date.now() - started,
    snapshot,
  };
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

async function readDrawingEngineDomEvidence(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(${drawingEngineDomEvidenceBrowserSnapshot.toString()})()`,
    returnByValue: true,
  });
  return result.result?.value ?? null;
}

async function waitForDrawingEngineDomEvidence(cdp, {
  required,
  timeoutMs = 5_000,
} = {}) {
  if (!required) return assessDrawingEngineDomEvidence(null, { required: false });
  const started = Date.now();
  let assessment = assessDrawingEngineDomEvidence(null);
  while (Date.now() - started < timeoutMs) {
    assessment = assessDrawingEngineDomEvidence(await readDrawingEngineDomEvidence(cdp));
    if (assessment.passed) return assessment;
    await wait(100);
  }
  return assessment;
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

async function startShortSwitchLongTaskObserver(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const previous = window.__CANDLESCOPE_SHORT_SWITCH_LONG_TASKS__;
      previous?.observer?.disconnect?.();
      const state = {
        supported: typeof PerformanceObserver === 'function',
        entries: [],
        observer: null,
      };
      if (state.supported) {
        try {
          state.observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              state.entries.push({
                startTime: Number(entry.startTime),
                duration: Number(entry.duration),
                name: String(entry.name || 'self'),
                attribution: Array.from(entry.attribution || [], (attribution) => ({
                  name: String(attribution?.name || ''),
                  containerType: String(attribution?.containerType || ''),
                  containerName: String(attribution?.containerName || ''),
                  containerId: String(attribution?.containerId || ''),
                  containerSrc: String(attribution?.containerSrc || ''),
                })),
              });
            }
          });
          state.observer.observe({ type: 'longtask', buffered: false });
        } catch {
          state.supported = false;
          state.observer = null;
        }
      }
      window.__CANDLESCOPE_SHORT_SWITCH_LONG_TASKS__ = state;
      return state.supported;
    })()`,
    returnByValue: true,
  });
  return result.result?.value === true;
}

async function stopShortSwitchLongTaskObserver(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const state = window.__CANDLESCOPE_SHORT_SWITCH_LONG_TASKS__;
      state?.observer?.disconnect?.();
      const entries = Array.isArray(state?.entries) ? state.entries.slice() : [];
      delete window.__CANDLESCOPE_SHORT_SWITCH_LONG_TASKS__;
      return entries;
    })()`,
    returnByValue: true,
  });
  return Array.isArray(result.result?.value) ? result.result.value : [];
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

function buildShortSwitchReadinessOptions(
  interval,
  datasetKey,
  sincePerfMs,
  args,
  { enforceSubmissionBudget = false } = {},
) {
  const expectedIndicatorIds = (args.overlayHeavy
    ? SMOKE_OVERLAY_HEAVY_INDICATORS
    : SMOKE_ACTIVE_INDICATORS)
    .map((indicator) => indicator.id);
  const expectedSeriesCounts = args.overlayHeavy
    ? { ma: 1, vol: 1, boll: 3, rsi: 1 }
    : { ma: 1 };
  return {
    datasetKey,
    ...(enforceSubmissionBudget ? { expectedMainSetDataCount: 1 } : {}),
    expectedIndicatorIds,
    expectedSeriesCounts,
    interval,
    ...(enforceSubmissionBudget ? { maxSetDataPerSeries: 1 } : {}),
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
    { enforceSubmissionBudget: phase.startsWith("short-switch-measured:") },
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
    ready: Boolean(
      indicatorBarrierWait.ready
      && finalBarrierDetail.indicatorDataReady
      && finalBarrierDetail.protocolReady
      && finalBarrierDetail.submissionReady
    ),
    detail: finalBarrierDetail,
  };
  const indicatorDataReady = Boolean(finalBarrierDetail.indicatorDataReady);
  const commitAtMs = Number(ready.detail?.commit?.atMs);
  const lastSubmissionAtMs = Number(finalBarrierDetail.lastSubmissionAtMs);
  const attributionEndPerfMs = Math.max(
    sincePerfMs,
    ...(Number.isFinite(commitAtMs) ? [commitAtMs] : []),
    ...(Number.isFinite(lastSubmissionAtMs) ? [lastSubmissionAtMs] : []),
  );
  return {
    phase,
    interval,
    startedAtMs,
    elapsedMs: Date.now() - startedAtMs,
    sincePerfMs,
    attributionEndPerfMs,
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
  const longTaskSupported = await startShortSwitchLongTaskObserver(cdp);
  let observedLongTasks = [];
  try {
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
  } finally {
    observedLongTasks = await stopShortSwitchLongTaskObserver(cdp);
  }

  const measured = networkCapture.summary({ phasePrefix: "short-switch-measured:" });
  const longTasks = summarizeShortSwitchLongTasks(observedLongTasks, steps);
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
    longTasks: {
      supported: longTaskSupported,
      ...longTasks,
    },
    acceptance: {
      maxIndicatorRangeRequests: maxIndicatorRequests,
      actualIndicatorRangeRequests: measured.requestCount,
      attributableLongTasksOver50Ms: longTasks.count,
      longTaskInstrumentationSupported: longTaskSupported,
      stepsReady,
      passed: stepsReady
        && measured.requestCount <= maxIndicatorRequests
        && longTaskSupported
        && longTasks.count === 0,
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

async function createDrawingEngineRequestGate(cdp) {
  const heldRequestIds = new Set();
  const continuationErrors = [];
  let holding = true;
  let disabled = false;

  cdp.on("Fetch.requestPaused", (event) => {
    if (!event?.requestId) return;
    if (holding) {
      heldRequestIds.add(event.requestId);
      return;
    }
    void cdp.send("Fetch.continueRequest", { requestId: event.requestId })
      .catch((error) => continuationErrors.push(String(error)));
  });
  await cdp.send("Fetch.enable", {
    patterns: [{
      requestStage: "Request",
      urlPattern: "*DrawingEngineHost*",
    }],
  });

  return {
    async waitForHeldRequest(timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (heldRequestIds.size > 0) return true;
        await wait(25);
      }
      return false;
    },
    snapshot() {
      return {
        continuationErrors: [...continuationErrors],
        heldRequestCount: heldRequestIds.size,
      };
    },
    async release() {
      if (disabled) return;
      holding = false;
      const requestIds = [...heldRequestIds];
      heldRequestIds.clear();
      await Promise.all(requestIds.map(async (requestId) => {
        try {
          await cdp.send("Fetch.continueRequest", { requestId });
        } catch (error) {
          continuationErrors.push(String(error));
        }
      }));
      await cdp.send("Fetch.disable");
      disabled = true;
    },
  };
}

async function verifyDrawingToolbarReadinessGate(cdp, requestGate, timeoutMs) {
  const waitingToolbarPresent = await waitForSelector(
    cdp,
    '[data-drawing-toolbar-state="waiting-for-engine"]',
    timeoutMs,
  );
  const drawingEngineRequestHeld = await requestGate.waitForHeldRequest(timeoutMs);
  const stateResult = await cdp.send("Runtime.evaluate", {
    expression: `({
      activePenPresent: Boolean(document.querySelector('[data-drawing-tool="pen"].active')),
      clickablePenPresent: Boolean(document.querySelector('.drawing-toolbar [data-drawing-tool="pen"]:not(:disabled)')),
      disabledPenPresent: Boolean(document.querySelector('.drawing-toolbar [data-drawing-tool="pen"]:disabled')),
      chartTypePresent: Boolean(document.querySelector('.drawing-toolbar [data-chart-type]')),
      exportPresent: Boolean(document.querySelector('.drawing-toolbar [data-drawing-action="export"]')),
      engineReady: Boolean(document.querySelector('[data-drawing-engine="ready"]'))
    })`,
    returnByValue: true,
  });
  const state = stateResult.result?.value ?? {};
  const gateSnapshot = requestGate.snapshot();
  return {
    passed: waitingToolbarPresent
      && drawingEngineRequestHeld
      && state.clickablePenPresent !== true
      && state.disabledPenPresent === true
      && state.activePenPresent !== true
      && state.chartTypePresent === true
      && state.exportPresent === true
      && state.engineReady !== true
      && gateSnapshot.continuationErrors.length === 0,
    waitingToolbarPresent,
    drawingEngineRequestHeld,
    clickablePenPresentWhileEngineBlocked: state.clickablePenPresent === true,
    disabledPenPresentWhileEngineBlocked: state.disabledPenPresent === true,
    activePenPresentWhileEngineBlocked: state.activePenPresent === true,
    chartTypePresentWhileEngineBlocked: state.chartTypePresent === true,
    exportPresentWhileEngineBlocked: state.exportPresent === true,
    engineReadyWhileBlocked: state.engineReady === true,
    ...gateSnapshot,
  };
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
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function waitForAnimationFrames(cdp, frameCount = 2) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const expected = ${JSON.stringify(frameCount)};
      let completed = 0;
      const tick = () => {
        completed += 1;
        if (completed >= expected) resolve(completed);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  return Number(result.result?.value) || 0;
}

async function dispatchDrag(
  cdp,
  fromX,
  fromY,
  toX,
  toY,
  steps = 8,
  { afterPressFrames = 0 } = {},
) {
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
  const committedFrames = afterPressFrames > 0
    ? await waitForAnimationFrames(cdp, afterPressFrames)
    : 0;
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
  return committedFrames;
}

async function dispatchFreehandStroke(cdp, points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const first = points[0];
  const last = points.at(-1);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    button: "none",
    buttons: 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await waitForAnimationFrames(cdp, 2);
  for (let offset = 1; offset < points.length; offset += 16) {
    const batch = points.slice(offset, offset + 16).map((point) => (
      cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
      })
    ));
    await Promise.all(batch);
    await waitForAnimationFrames(cdp, 1);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return points.length;
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

async function readDrawingDocumentRecord(cdp, drawingKey) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      try {
        if (typeof indexedDB.databases === "function") {
          const databases = await indexedDB.databases();
          if (!databases.some((entry) => entry?.name === ${JSON.stringify(DRAWING_DOCUMENT_DATABASE_NAME)})) {
            return null;
          }
        }
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(${JSON.stringify(DRAWING_DOCUMENT_DATABASE_NAME)});
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error("drawing IndexedDB open failed"));
          request.onblocked = () => reject(new Error("drawing IndexedDB open blocked"));
        });
        try {
          if (!database.objectStoreNames.contains(${JSON.stringify(DRAWING_DOCUMENT_STORE_NAME)})) return null;
          return await new Promise((resolve, reject) => {
            const transaction = database.transaction(${JSON.stringify(DRAWING_DOCUMENT_STORE_NAME)}, "readonly");
            const request = transaction.objectStore(${JSON.stringify(DRAWING_DOCUMENT_STORE_NAME)}).get(${JSON.stringify(drawingKey)});
            let value = null;
            request.onsuccess = () => { value = request.result || null; };
            request.onerror = () => reject(request.error || new Error("drawing IndexedDB read failed"));
            transaction.oncomplete = () => resolve(value);
            transaction.onerror = () => reject(transaction.error || new Error("drawing IndexedDB transaction failed"));
            transaction.onabort = () => reject(transaction.error || new Error("drawing IndexedDB transaction aborted"));
          });
        } finally {
          database.close();
        }
      } catch {
        return null;
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value;
  return value && typeof value === "object" ? value : null;
}

async function readDrawingRuntimeSummary(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const summary = window.__CANDLESCOPE_DRAWING_PERF__?.readRuntimeSummary?.();
      if (!summary || !Number.isSafeInteger(summary.entityCount)) return null;
      return {
        entityCount: summary.entityCount,
        pointCount: Number.isSafeInteger(summary.pointCount) ? summary.pointCount : null,
        typeCounts: summary.typeCounts && typeof summary.typeCounts === "object"
          ? { ...summary.typeCounts }
          : {},
        effectiveEngineMode: summary.effectiveEngineMode ?? null,
        scenePublicationReady: summary.scenePublicationReady === true,
      };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  return value && typeof value === "object" ? value : null;
}

async function readDrawingCreationSnapshot(cdp, drawingKey) {
  const [record, savedDrawings, runtimeSummary] = await Promise.all([
    readDrawingDocumentRecord(cdp, drawingKey),
    readSavedDrawings(cdp, drawingKey),
    readDrawingRuntimeSummary(cdp),
  ]);
  const entities = Array.isArray(record?.entities) ? record.entities : [];
  return {
    documentRevision: Number.isSafeInteger(record?.documentRevision)
      ? record.documentRevision
      : null,
    savedDrawingCount: savedDrawings.length,
    entityCount: entities.length,
    runtimeSummary,
    savedDrawings: savedDrawings.map((drawing) => ({
      id: drawing?.id ?? null,
      type: drawing?.type ?? null,
      lineType: drawing?.lineType ?? null,
      dataPoints: drawing?.type === "line" && Array.isArray(drawing.dataPoints)
        ? drawing.dataPoints
        : null,
    })),
    entities: entities.map((entity) => ({
      id: entity?.id ?? null,
      kind: entity?.kind ?? null,
      geometryKind: entity?.geometry?.kind ?? null,
      lineType: entity?.geometry?.lineType ?? null,
      dataPointCount: Array.isArray(entity?.geometry?.dataPoints)
        ? entity.geometry.dataPoints.length
        : 0,
    })),
  };
}

async function waitForDrawingCreationSnapshotCount(
  cdp,
  drawingKey,
  expectedCount,
  timeoutMs = 5_000,
) {
  const started = Date.now();
  let snapshot = await readDrawingCreationSnapshot(cdp, drawingKey);
  const converged = () => snapshot.savedDrawingCount === expectedCount
    && snapshot.entityCount === expectedCount
    && snapshot.runtimeSummary?.entityCount === expectedCount;
  while (!converged() && Date.now() - started < timeoutMs) {
    await wait(100);
    snapshot = await readDrawingCreationSnapshot(cdp, drawingKey);
  }
  return snapshot;
}

async function readDrawingPersistenceSnapshot(cdp, drawingKey, drawingId) {
  const record = await readDrawingDocumentRecord(cdp, drawingKey);
  const savedDrawings = await readSavedDrawings(cdp, drawingKey);
  const entity = Array.isArray(record?.entities)
    ? record.entities.find((candidate) => candidate?.id === drawingId)
    : null;
  const saved = savedDrawings.find((candidate) => candidate?.id === drawingId) || null;
  if (!entity || !saved || !Array.isArray(saved.dataPoints)) return null;
  return {
    drawingId,
    documentRevision: Number.isFinite(record?.documentRevision) ? record.documentRevision : null,
    geometryRevision: Number.isFinite(entity.geometryRevision) ? entity.geometryRevision : null,
    entityCount: Array.isArray(record?.entities) ? record.entities.length : null,
    savedDrawingCount: savedDrawings.length,
    idbGeometry: entity.geometry || null,
    idbDataPoints: Array.isArray(entity.geometry?.dataPoints) ? entity.geometry.dataPoints : null,
    savedDataPoints: saved.dataPoints,
  };
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

async function waitForSavedDrawingCountAtLeast(cdp, drawingKey, minimum, timeoutMs = 5_000) {
  const started = Date.now();
  let count = await readSavedDrawingCount(cdp, drawingKey);
  while (Date.now() - started < timeoutMs) {
    if (count >= minimum) return count;
    await wait(100);
    count = await readSavedDrawingCount(cdp, drawingKey);
  }
  return count;
}

function drawingPersistenceChangeEvidence(previous, current) {
  const idbGeometryChanged = Boolean(previous && current)
    && JSON.stringify(current.idbGeometry) !== JSON.stringify(previous.idbGeometry);
  const savedDrawingGeometryChanged = Boolean(previous && current)
    && JSON.stringify(current.savedDataPoints) !== JSON.stringify(previous.savedDataPoints);
  const documentRevisionAdvanced = Number.isFinite(previous?.documentRevision)
    && Number.isFinite(current?.documentRevision)
    && current.documentRevision > previous.documentRevision;
  const geometryRevisionAdvanced = Number.isFinite(previous?.geometryRevision)
    && Number.isFinite(current?.geometryRevision)
    && current.geometryRevision > previous.geometryRevision;
  const idbSavedDrawingGeometryMatched = Boolean(current)
    && Array.isArray(current.idbDataPoints)
    && JSON.stringify(current.idbDataPoints) === JSON.stringify(current.savedDataPoints);
  const entityCountUnchanged = Number.isFinite(previous?.entityCount)
    && current?.entityCount === previous.entityCount;
  const savedDrawingCountUnchanged = Number.isFinite(previous?.savedDrawingCount)
    && current?.savedDrawingCount === previous.savedDrawingCount;
  return {
    passed: idbGeometryChanged
      && savedDrawingGeometryChanged
      && documentRevisionAdvanced
      && geometryRevisionAdvanced
      && idbSavedDrawingGeometryMatched
      && entityCountUnchanged
      && savedDrawingCountUnchanged,
    drawingId: previous?.drawingId ?? current?.drawingId ?? null,
    documentRevisionBefore: previous?.documentRevision ?? null,
    documentRevisionAfter: current?.documentRevision ?? null,
    geometryRevisionBefore: previous?.geometryRevision ?? null,
    geometryRevisionAfter: current?.geometryRevision ?? null,
    idbGeometryChanged,
    savedDrawingGeometryChanged,
    documentRevisionAdvanced,
    geometryRevisionAdvanced,
    idbSavedDrawingGeometryMatched,
    entityCountBefore: previous?.entityCount ?? null,
    entityCountAfter: current?.entityCount ?? null,
    savedDrawingCountBefore: previous?.savedDrawingCount ?? null,
    savedDrawingCountAfter: current?.savedDrawingCount ?? null,
    entityCountUnchanged,
    savedDrawingCountUnchanged,
    dataPointsBefore: previous?.savedDataPoints ?? null,
    dataPointsAfter: current?.savedDataPoints ?? null,
  };
}

async function waitForSavedDrawingGeometryChange(
  cdp,
  drawingKey,
  previousSnapshot,
  timeoutMs = 5_000,
) {
  const started = Date.now();
  let latestSnapshot = null;
  while (Date.now() - started < timeoutMs) {
    latestSnapshot = await readDrawingPersistenceSnapshot(
      cdp,
      drawingKey,
      previousSnapshot.drawingId,
    );
    const evidence = drawingPersistenceChangeEvidence(previousSnapshot, latestSnapshot);
    if (evidence.passed) return evidence;
    await wait(100);
  }
  return drawingPersistenceChangeEvidence(previousSnapshot, latestSnapshot);
}

async function verifyDrawingWorkflow(cdp, timeoutMs, drawingToolbarGate = null) {
  const drawingKey = "binance:spot:BTCUSDT__main";
  const penButtonSelector = '[data-drawing-tool="pen"]';
  const lineButtonSelector = '[data-drawing-tool="line-segment"]';
  const cursorButtonSelector = '[data-drawing-tool="cursor"]';
  const chartSelector = '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]';

  const penToolAvailable = await waitForSelector(
    cdp,
    `.drawing-toolbar ${penButtonSelector}:not(:disabled)`,
    timeoutMs,
  );
  let penToolClicked = false;
  let penToolActive = false;
  let drawingEngineMounted = false;
  let drawingEngineReady = false;

  const rect = await getRect(cdp, chartSelector);
  let lineToolClicked = false;
  let lineToolActive = false;
  let lineToolStayedActive = false;
  let drawingPenCreation = null;
  let drawingTwoClickCreation = null;
  let drawingPersistedCount = 0;
  let drawingDragPersisted = false;
  let drawingDragPersistence = null;
  let drawingCursorToolActive = false;
  let drawingLineToolReactivated = false;
  let drawingSelectionCommitFrames = 0;
  let drawingDragPointerDownCommitFrames = 0;
  let drawingInitialGeometryValid = false;
  let drawingFinalPersistedCount = 0;
  let drawingRestoredCount = 0;
  let reloadLoadedAtMs = null;
  let futureAnchorStored = false;
  let chartLastTime = null;

  if (rect && penToolAvailable) {
    chartLastTime = await readLatestChartLastTime(cdp);
    const initialSnapshot = await readDrawingCreationSnapshot(cdp, drawingKey);
    const penPoints = Array.from({ length: 64 }, (_, index) => ({
      x: Math.round(rect.x + rect.width * (0.23 + index * 0.0018)),
      y: Math.round(rect.y + rect.height * (0.62 + Math.sin(index * 0.28) * 0.035)),
    }));
    const toolClickStartedAtMs = Date.now();
    penToolClicked = await clickSelector(cdp, penButtonSelector);
    const gestureStartedAtMs = Date.now();
    if (penToolClicked) await dispatchFreehandStroke(cdp, penPoints);
    const afterPenSnapshot = await waitForDrawingCreationSnapshotCount(
      cdp,
      drawingKey,
      initialSnapshot.savedDrawingCount + 1,
    );
    const penActiveResult = await cdp.send("Runtime.evaluate", {
      expression: `Boolean(document.querySelector(${JSON.stringify(`${penButtonSelector}.active`)}))`,
      returnByValue: true,
    });
    penToolActive = Boolean(penActiveResult.result?.value);
    const drawingEngineStateResult = await cdp.send("Runtime.evaluate", {
      expression: `({
        mounted: Boolean(document.querySelector("[data-drawing-engine]")),
        ready: Boolean(document.querySelector('[data-drawing-engine="ready"]'))
      })`,
      returnByValue: true,
    });
    drawingEngineMounted = Boolean(drawingEngineStateResult.result?.value?.mounted);
    drawingEngineReady = Boolean(drawingEngineStateResult.result?.value?.ready);
    const initialSavedIds = new Set(initialSnapshot.savedDrawings.map((drawing) => drawing.id));
    const initialEntityIds = new Set(initialSnapshot.entities.map((entity) => entity.id));
    const addedPenSaved = afterPenSnapshot.savedDrawings.filter(
      (drawing) => !initialSavedIds.has(drawing.id),
    );
    const addedPenEntities = afterPenSnapshot.entities.filter(
      (entity) => !initialEntityIds.has(entity.id),
    );
    const penDrawingId = addedPenSaved.length === 1
      && addedPenEntities.length === 1
      && addedPenSaved[0]?.id === addedPenEntities[0]?.id
      ? addedPenSaved[0].id
      : null;
    const penCountsAdvanced = afterPenSnapshot.savedDrawingCount
      === initialSnapshot.savedDrawingCount + 1
      && afterPenSnapshot.entityCount === initialSnapshot.entityCount + 1
      && afterPenSnapshot.runtimeSummary?.entityCount
        === initialSnapshot.runtimeSummary?.entityCount + 1;
    const penKindsMatched = addedPenSaved[0]?.type === "freehand"
      && addedPenEntities[0]?.kind === "freehand"
      && (afterPenSnapshot.runtimeSummary?.typeCounts?.freehand ?? 0)
        === (initialSnapshot.runtimeSummary?.typeCounts?.freehand ?? 0) + 1;
    drawingPenCreation = {
      passed: penCountsAdvanced && penKindsMatched && penDrawingId !== null,
      drawingId: penDrawingId,
      activationToGestureMs: gestureStartedAtMs - toolClickStartedAtMs,
      immediateAfterToolActivation: gestureStartedAtMs - toolClickStartedAtMs < 100,
      scenePublicationReadyBeforeGesture:
        initialSnapshot.runtimeSummary?.scenePublicationReady === true,
      countsAdvanced: penCountsAdvanced,
      kindsMatched: penKindsMatched,
      before: initialSnapshot,
      after: afterPenSnapshot,
    };

    lineToolClicked = await clickSelector(cdp, lineButtonSelector);
    lineToolActive = lineToolClicked
      && await waitForSelector(cdp, `${lineButtonSelector}.active`);

    const firstLineStart = {
      x: Math.round(rect.x + rect.width * 0.38),
      y: Math.round(rect.y + rect.height * 0.40),
    };
    const firstLineEnd = {
      x: Math.round(rect.x + rect.width * 0.50),
      y: Math.round(rect.y + rect.height * 0.45),
    };
    const secondLineStart = {
      x: Math.round(rect.x + rect.width * 0.58),
      y: Math.round(rect.y + rect.height * 0.53),
    };
    const secondLineEnd = {
      x: Math.round(rect.x + rect.width * 0.70),
      y: Math.round(rect.y + rect.height * 0.47),
    };
    let firstLineEvidence = null;
    let secondLineEvidence = null;

    if (drawingPenCreation.passed && lineToolActive) {
      const beforeFirstLine = afterPenSnapshot;
      await dispatchClick(cdp, firstLineStart.x, firstLineStart.y);
      await waitForAnimationFrames(cdp, 2);
      await wait(150);
      const afterFirstLineFirstClick = await readDrawingCreationSnapshot(cdp, drawingKey);
      await dispatchClick(cdp, firstLineEnd.x, firstLineEnd.y);
      const afterFirstLineSecondClick = await waitForDrawingCreationSnapshotCount(
        cdp,
        drawingKey,
        beforeFirstLine.savedDrawingCount + 1,
      );
      firstLineEvidence = assessTwoClickDrawingCreationEvidence({
        beforeFirstClick: beforeFirstLine,
        afterFirstClick: afterFirstLineFirstClick,
        afterSecondClick: afterFirstLineSecondClick,
      });

      lineToolStayedActive = await waitForSelector(cdp, `${lineButtonSelector}.active`);
      if (firstLineEvidence.passed && lineToolStayedActive) {
        const beforeSecondLine = afterFirstLineSecondClick;
        await dispatchClick(cdp, secondLineStart.x, secondLineStart.y);
        await waitForAnimationFrames(cdp, 2);
        await wait(150);
        const afterSecondLineFirstClick = await readDrawingCreationSnapshot(cdp, drawingKey);
        await dispatchClick(cdp, secondLineEnd.x, secondLineEnd.y);
        const afterSecondLineSecondClick = await waitForDrawingCreationSnapshotCount(
          cdp,
          drawingKey,
          beforeSecondLine.savedDrawingCount + 1,
        );
        secondLineEvidence = assessTwoClickDrawingCreationEvidence({
          beforeFirstClick: beforeSecondLine,
          afterFirstClick: afterSecondLineFirstClick,
          afterSecondClick: afterSecondLineSecondClick,
        });
        drawingPersistedCount = afterSecondLineSecondClick.savedDrawingCount;
      }
    }

    drawingTwoClickCreation = {
      passed: drawingPenCreation.passed
        && lineToolActive
        && lineToolStayedActive
        && firstLineEvidence?.passed === true
        && secondLineEvidence?.passed === true,
      penToSegment: firstLineEvidence,
      consecutiveSegment: secondLineEvidence,
      lineToolStayedActive,
    };

    if (drawingTwoClickCreation.passed && drawingPersistedCount > 0) {
      const beforeDragDrawings = await readSavedDrawings(cdp, drawingKey);
      const dragDrawing = beforeDragDrawings.find(
        (drawing) => drawing?.id === firstLineEvidence.addedDrawingId,
      ) || null;
      if (dragDrawing?.id && Array.isArray(dragDrawing.dataPoints)) {
        const firstPoint = dragDrawing.dataPoints[0] || null;
        const lastPoint = dragDrawing.dataPoints.at(-1) || null;
        drawingInitialGeometryValid = dragDrawing.dataPoints.length >= 2
          && JSON.stringify(firstPoint) !== JSON.stringify(lastPoint);
        const beforeDragPersistence = drawingInitialGeometryValid
          ? await readDrawingPersistenceSnapshot(cdp, drawingKey, dragDrawing.id)
          : null;
        const dragFromX = Math.round((firstLineStart.x + firstLineEnd.x) / 2);
        const dragFromY = Math.round((firstLineStart.y + firstLineEnd.y) / 2);
        const cursorClicked = await clickSelector(cdp, cursorButtonSelector);
        drawingCursorToolActive = cursorClicked
          && await waitForSelector(cdp, `${cursorButtonSelector}.active`);
        if (beforeDragPersistence && drawingCursorToolActive) {
          // Clear the selection left by creation, then select the committed
          // static scene entity through the passive cursor. Two animation
          // frames guarantee React committed that selection before the drag
          // tool is reactivated.
          await dispatchClick(
            cdp,
            Math.round(rect.x + rect.width * 0.18),
            Math.round(rect.y + rect.height * 0.78),
          );
          await waitForAnimationFrames(cdp, 2);
          await dispatchClick(cdp, dragFromX, dragFromY);
          drawingSelectionCommitFrames = await waitForAnimationFrames(cdp, 2);

          const lineReactivated = await clickSelector(cdp, lineButtonSelector);
          drawingLineToolReactivated = lineReactivated
            && await waitForSelector(cdp, `${lineButtonSelector}.active`);
          if (drawingLineToolReactivated) {
            // pointerdown establishes the overlay drag descriptor and selects
            // the same static entity. Hold the real mouse button across two
            // React frames before pointermove/pointerup to exercise cleanup.
            drawingDragPointerDownCommitFrames = await dispatchDrag(
              cdp,
              dragFromX,
              dragFromY,
              dragFromX + Math.round(rect.width * 0.04),
              dragFromY + Math.round(rect.height * 0.02),
              8,
              { afterPressFrames: 2 },
            );
            drawingDragPersistence = await waitForSavedDrawingGeometryChange(
              cdp,
              drawingKey,
              beforeDragPersistence,
            );
            drawingDragPersisted = drawingDragPersistence.passed;
          }
        }
      }

      await clickSelector(cdp, cursorButtonSelector);
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
      await waitForSavedDrawingCountAtLeast(cdp, drawingKey, drawingPersistedCount + 1);
      const savedDrawings = await readSavedDrawings(cdp, drawingKey);
      drawingFinalPersistedCount = savedDrawings.length;
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
    drawingPenToolClicked: penToolClicked,
    drawingPenToolActive: penToolActive,
    drawingLineToolClicked: lineToolClicked,
    drawingLineToolActive: lineToolActive,
    drawingLineToolStayedActive: lineToolStayedActive,
    drawingEngineReady,
    drawingEngineMounted,
    drawingToolbarGate,
    drawingChartRectFound: Boolean(rect),
    drawingPenCreation,
    drawingTwoClickCreation,
    drawingPersistedCount,
    drawingInitialGeometryValid,
    drawingCursorToolActive,
    drawingLineToolReactivated,
    drawingSelectionCommitFrames,
    drawingDragPointerDownCommitFrames,
    drawingDragPersisted,
    drawingDragPersistence,
    drawingFinalPersistedCount,
    futureAnchorStored,
    drawingReloadLoadedAtMs: reloadLoadedAtMs,
    drawingRestoredCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.marketType = String(args.marketType || "").trim().toLowerCase();
  if (!new Set(["spot", "futures"]).has(args.marketType)) {
    throw new Error("--market-type must be either spot or futures");
  }
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
  let drawingEngineRequestGate;

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
      const isReplacedExportBlob = args.exportMatrix
        && event.errorText === "net::ERR_FILE_NOT_FOUND"
        && url.startsWith("blob:");
      const isOptionalExternalFont = event.type === "Font"
        && /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//i.test(url);
      // Export previews revoke the previous object URL after replacing it.
      // The export matrix separately verifies the new preview and downloaded
      // file bytes, so a late fetch against that retired blob is cancellation.
      // Google Fonts are cosmetic and may be unavailable in an offline CI run;
      // the browser fallback font does not invalidate the product smoke.
      const isCanceled = event.canceled
        || event.errorText === "net::ERR_ABORTED"
        || isReplacedExportBlob
        || isOptionalExternalFont;
      if (event.errorText && !isCanceled) {
        failures.push({ errorText: event.errorText, requestId: event.requestId, type: event.type, url });
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS);
    await cdp.send("Page.enable");
    if (args.drawingCheck) {
      drawingEngineRequestGate = await createDrawingEngineRequestGate(cdp);
    }
    if (args.exportMatrix) {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          const raw = localStorage.getItem("candlescope-user-prefs");
          const current = raw ? JSON.parse(raw) : {};
          const prefs = current && typeof current === "object" ? current : {};
          prefs.lastExchange = "binance";
          prefs.lastMarketType = ${JSON.stringify(args.marketType)};
          prefs.lastSymbol = "BTCUSDT";
          localStorage.setItem("candlescope-user-prefs", JSON.stringify(prefs));
        } catch {}
      `,
    });
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

    const chartReadyPromise = waitForChartReady(cdp, args.timeoutMs);
    let drawingWorkflowPromise = null;
    if (drawingEngineRequestGate) {
      const drawingToolbarGate = await verifyDrawingToolbarReadinessGate(
        cdp,
        drawingEngineRequestGate,
        args.timeoutMs,
      );
      await drawingEngineRequestGate.release();
      drawingWorkflowPromise = args.seedIndicators
        ? (async () => {
            // The no-seed drawing smoke exercises the first interactive frame.
            // With seeded indicators, let native pane materialization settle so
            // later selection/drag coordinates are measured against one layout.
            await chartReadyPromise;
            await waitForSeededIndicatorReport(cdp, args);
            await indicatorRangeNetworkCapture.waitForIdle({
              quietMs: 500,
              timeoutMs: Math.min(args.timeoutMs, 10_000),
            });
            await waitForAnimationFrames(cdp, 2);
            return verifyDrawingWorkflow(cdp, args.timeoutMs, drawingToolbarGate);
          })()
        : verifyDrawingWorkflow(
            cdp,
            args.timeoutMs,
            drawingToolbarGate,
          );
    }
    const { bodyText, loadedAt } = await chartReadyPromise;
    const drawingWorkflow = drawingWorkflowPromise
      ? await drawingWorkflowPromise
      : null;
    const advancedMarket = args.marketType === "futures"
      ? await verifyAdvancedMarketStudyWorkflow(cdp, Math.min(args.timeoutMs, 15_000))
      : {
          checked: false,
          ready: true,
          readyAtMs: null,
          reason: "advanced market data is futures-only",
          metrics: {},
          panes: {},
        };
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
    // drawingWorkflow reloads the page after persistence verification. Chart
    // readiness covers bars/connectivity only; seeded indicator series and
    // their native pane layout restore asynchronously after that boundary.
    // Export must wait for both or main-pane scope can accidentally capture
    // the full one-pane chart generation.
    const exportSeededIndicatorReport = args.exportMatrix && args.seedIndicators
      ? await waitForSeededIndicatorReport(cdp, args)
      : null;
    const exportPaneLayout = args.exportMatrix
      ? await waitForExportPaneLayout(cdp, args)
      : null;
    const exportReadiness = args.exportMatrix
      ? {
          seededIndicatorCoverage: !args.seedIndicators || hasSeededIndicatorCoverage(
            exportSeededIndicatorReport,
            { overlayHeavy: args.overlayHeavy },
          ),
          paneLayout: exportPaneLayout,
        }
      : null;
    const drawingEngineDomEvidence = await waitForDrawingEngineDomEvidence(cdp, {
      required: shouldRequireDrawingEngineDomEvidenceForSmoke(args),
      timeoutMs: Math.min(args.timeoutMs, 5_000),
    });
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
    }) || hasSeededIndicatorCoverage(exportSeededIndicatorReport, {
      overlayHeavy: args.overlayHeavy,
    });
    const overlayHeavyCoverage = args.overlayHeavy ? seededIndicatorCoverage : null;
    const indicatorSnapshotIds = Array.from(getIndicatorSnapshotIds(performanceTimings));
    await indicatorRangeNetworkCapture.waitForIdle({ quietMs: 500, timeoutMs: 3_000 });
    await indicatorRangeNetworkCapture.flush();
    const indicatorRangeRequests = indicatorRangeNetworkCapture.records();
    const indicatorRangeNetwork = indicatorRangeNetworkCapture.summary();
    const failedApiResponses = responses.filter((response) => response.status >= 400);
    const screenshotData = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(screenshot, Buffer.from(screenshotData.data, "base64"));

    const criticalConsoleWarnings = warnings.filter(({ text }) => (
      text.includes("Maximum update depth exceeded")
      || text.includes("Drawing document-only scene failed closed")
      || text.includes("Drawing scene runtime failed after the fallback boundary")
      || text.includes("drawing scene publication was rejected by the current surface")
    ));
    const report = {
      url: args.url,
      loadedAtMs: loadedAt,
      bars: parseBarCount(bodyText),
      connected: bodyText.includes("Connected to Binance"),
      live: bodyText.includes("Live (WebSocket)"),
      marketType: args.marketType,
      advancedMarket,
      ...lazySurfaces,
      ...settings,
      drawingWorkflow,
      drawingEngineDomEvidence,
      exportReadiness,
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
      failedApiResponses: failedApiResponses.slice(0, 20),
      failures,
      warnings: warnings.slice(0, 20),
      criticalConsoleWarnings: criticalConsoleWarnings.slice(0, 20),
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
    if (drawingEngineDomEvidence.required && !drawingEngineDomEvidence.passed) {
      console.error(formatDrawingEngineDomEvidenceFailure(drawingEngineDomEvidence, "Smoke"));
    }

    const failed = !report.connected
      || !report.live
      || report.bars <= 0
      || !report.advancedMarket.ready
      || !report.drawingToolbarLoaded
      || !report.symbolSearchOpened
      || !report.settingsOpened
      || (args.drawingCheck && (
        !drawingWorkflow?.drawingToolbarGate?.passed
        || !drawingWorkflow?.drawingPenToolClicked
        || !drawingWorkflow?.drawingPenToolActive
        || !drawingWorkflow?.drawingPenCreation?.passed
        || !drawingWorkflow?.drawingPenCreation?.immediateAfterToolActivation
        || !drawingWorkflow?.drawingLineToolClicked
        || !drawingWorkflow?.drawingLineToolActive
        || !drawingWorkflow?.drawingLineToolStayedActive
        || !drawingWorkflow?.drawingTwoClickCreation?.passed
        || !drawingWorkflow?.drawingEngineReady
        || !drawingWorkflow?.drawingEngineMounted
        || !drawingWorkflow?.drawingChartRectFound
        || drawingWorkflow?.drawingPersistedCount
          !== drawingWorkflow?.drawingTwoClickCreation?.consecutiveSegment
            ?.counts?.afterSecondClick?.saved
        || !drawingWorkflow?.drawingInitialGeometryValid
        || !drawingWorkflow?.drawingCursorToolActive
        || !drawingWorkflow?.drawingLineToolReactivated
        || drawingWorkflow?.drawingSelectionCommitFrames < 2
        || drawingWorkflow?.drawingDragPointerDownCommitFrames < 2
        || !drawingWorkflow?.drawingDragPersisted
        || drawingWorkflow?.drawingFinalPersistedCount !== drawingWorkflow.drawingPersistedCount + 1
        || !drawingWorkflow?.futureAnchorStored
        || drawingWorkflow?.drawingRestoredCount !== drawingWorkflow?.drawingFinalPersistedCount
      ))
      || (drawingEngineDomEvidence.required && !drawingEngineDomEvidence.passed)
      || (args.seedIndicators && !seededIndicatorCoverage)
      || (args.seedIndicators && args.overlayHeavy && !overlayHeavyCoverage)
      || (args.exportMatrix && (
        !exportReadiness?.seededIndicatorCoverage
        || (exportReadiness.paneLayout?.required && !exportReadiness.paneLayout.ready)
      ))
      || (args.shortSwitch && !shortSwitch?.acceptance?.passed)
      || (args.chartTypeMatrix && !chartTypeMatrix?.passed)
      || (args.exportMatrix && !exportMatrix?.passed)
      || criticalConsoleWarnings.length > 0
      || exceptions.length > 0
      || failedApiResponses.length > 0
      || failures.length > 0;
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (drawingEngineRequestGate) {
      try {
        await drawingEngineRequestGate.release();
      } catch {
        // Browser/process cleanup below is the final fallback for a broken
        // interception session.
      }
    }
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
