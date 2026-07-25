import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIndicatorRangeNetworkCapture,
  INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS,
} from "./indicator-range-network-capture.mjs";
import {
  assessIndicatorStackSample,
  compactDebugSnapshot,
  compactIndicatorDiagnostics,
  compactStorageHealth,
  formatIndicatorStackMarkdown,
  summarizeIndicatorStackMonitoring,
} from "./indicator-stack-monitor-core.mjs";

const DEFAULT_URL = "http://127.0.0.1:15173/";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:18080";
const DEFAULT_SAMPLE_MS = 2_000;
const DEFAULT_DEEP_SAMPLE_MS = 10_000;
const MAX_IN_MEMORY_EVENTS = 50_000;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "CandleScope full-stack indicator monitor",
    "",
    "Usage:",
    "  npm run monitor:indicators -- [options]",
    "",
    "Options:",
    `  --url <url>              Frontend URL (default ${DEFAULT_URL})`,
    `  --backend-url <url>      Backend URL (default ${DEFAULT_BACKEND_URL})`,
    `  --sample-ms <ms>         Runtime/storage sample period (default ${DEFAULT_SAMPLE_MS})`,
    `  --deep-sample-ms <ms>    Heavy /debug/snapshot period (default ${DEFAULT_DEEP_SAMPLE_MS})`,
    "  --duration-ms <ms>       Stop automatically; 0 waits for Ctrl+C (default 0)",
    "  --headless               Run Chrome without a visible window",
    "  --chrome <path>          Explicit Chrome or Edge executable",
    "  --out-dir <path>         Exact artifact directory",
    "  --fail-on-issues         Exit non-zero when the final report has issues",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    url: process.env.CANDLESCOPE_MONITOR_URL || DEFAULT_URL,
    backendUrl: process.env.CANDLESCOPE_MONITOR_BACKEND_URL || DEFAULT_BACKEND_URL,
    sampleMs: Number(process.env.CANDLESCOPE_MONITOR_SAMPLE_MS || DEFAULT_SAMPLE_MS),
    deepSampleMs: Number(
      process.env.CANDLESCOPE_MONITOR_DEEP_SAMPLE_MS || DEFAULT_DEEP_SAMPLE_MS,
    ),
    durationMs: Number(process.env.CANDLESCOPE_MONITOR_DURATION_MS || 0),
    chromePath: process.env.CHROME_PATH || "",
    outDir: process.env.CANDLESCOPE_MONITOR_OUT_DIR || "",
    headless: process.env.CANDLESCOPE_MONITOR_HEADLESS === "1",
    failOnIssues: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = argv[++index];
    else if (arg === "--backend-url") args.backendUrl = argv[++index];
    else if (arg === "--sample-ms") args.sampleMs = Number(argv[++index]);
    else if (arg === "--deep-sample-ms") args.deepSampleMs = Number(argv[++index]);
    else if (arg === "--duration-ms") args.durationMs = Number(argv[++index]);
    else if (arg === "--chrome") args.chromePath = argv[++index];
    else if (arg === "--out-dir") args.outDir = argv[++index];
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--fail-on-issues") args.failOnIssues = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.sampleMs) || args.sampleMs < 250) {
    throw new Error("--sample-ms must be at least 250");
  }
  if (!Number.isFinite(args.deepSampleMs) || args.deepSampleMs < args.sampleMs) {
    throw new Error("--deep-sample-ms must be at least --sample-ms");
  }
  if (!Number.isFinite(args.durationMs) || args.durationMs < 0) {
    throw new Error("--duration-ms must be zero or positive");
  }
  args.url = new URL(args.url).toString();
  args.backendUrl = new URL(args.backendUrl).toString().replace(/\/$/, "");
  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
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
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
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

function readHttpJson(url, { method = "GET", timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP timeout: ${url}`)));
    request.once("error", reject);
    request.end();
  });
}

function encodeWsFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  let headerLength = 2;
  if (payload.length >= 126 && payload.length <= 65_535) headerLength = 4;
  if (payload.length > 65_535) headerLength = 10;
  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) frame[1] = 0x80 | payload.length;
  else if (payload.length <= 65_535) {
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
  for (let index = 0; index < payload.length; index += 1) {
    frame[payloadOffset + index] = payload[index] ^ mask[index % 4];
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
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
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
    this.socket = net.createConnection({ host, port });
    this.socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.write([
      `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
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
        this.socket.on("error", (error) => this.close(error));
        this.socket.on("close", () => this.close(new Error("CDP socket closed")));
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
    for (const handler of this.handlers.get(event) || []) {
      try {
        const result = handler(payload);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // Individual diagnostic handlers must not break the CDP stream.
      }
    }
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const decoded = decodeWsFrames(this.buffer);
    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close(new Error("CDP peer closed"));
        continue;
      }
      if (frame.opcode === 0x9) {
        this.socket?.write(encodeWsFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const deferred = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(deferred.timer);
        if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else deferred.resolve(message.result);
      } else if (message.method) {
        this.emit(message.method, message.params);
      }
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error(`CDP is closed before ${method}`));
    }
    const id = this.nextId++;
    this.socket.write(encodeWsFrame(JSON.stringify({ id, method, params })));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close(error = new Error("CDP connection closed")) {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    for (const deferred of this.pending.values()) {
      clearTimeout(deferred.timer);
      deferred.reject(error);
    }
    this.pending.clear();
  }
}

async function waitForDevTools(debugBase, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readHttpJson(`${debugBase}/json/version`, { timeoutMs: 1_000 });
      return;
    } catch {
      await wait(200);
    }
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint");
}

async function waitForPageTarget(debugBase, targetUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const expected = new URL(targetUrl);
  while (Date.now() < deadline) {
    const targets = await readHttpJson(`${debugBase}/json/list`, { timeoutMs: 2_000 });
    const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
    const matching = pageTargets.find((target) => {
      try {
        const candidate = new URL(target.url);
        return candidate.origin === expected.origin;
      } catch {
        return false;
      }
    });
    if (matching) return matching;
    if (pageTargets.length > 0) return pageTargets[0];
    await wait(200);
  }
  throw new Error("Timed out waiting for a Chrome page target");
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function remoteObjectText(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  if ("value" in value) {
    if (typeof value.value === "string") return value.value;
    try { return JSON.stringify(value.value); } catch { return String(value.value); }
  }
  return value.description || value.unserializableValue || value.type || "";
}

function monitoredApiPath(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.replace(/\/+$/, "");
    if (pathname.startsWith("/api/v1/indicators/")) return pathname;
    if (pathname.startsWith("/api/v1/klines/")) return pathname;
  } catch {
    return null;
  }
  return null;
}

function summarizeLines(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => summarizeLines(item, depth + 1));
  if (typeof value !== "object") return [];
  const records = [];
  if (Array.isArray(value.lines)) {
    for (const line of value.lines) {
      const data = Array.isArray(line?.data) ? line.data : [];
      const times = data.map((point) => Number(point?.time)).filter(Number.isFinite);
      records.push({
        id: line?.id || line?.name || line?.title || null,
        points: data.length,
        firstTime: times.length ? Math.min(...times) : null,
        lastTime: times.length ? Math.max(...times) : null,
      });
    }
  }
  for (const child of Object.values(value)) records.push(...summarizeLines(child, depth + 1));
  return records.slice(0, 50);
}

function collectLogicalCodes(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectLogicalCodes(item, depth + 1));
  if (typeof value !== "object") return [];
  const codes = [];
  if (typeof value.code === "string") codes.push(value.code);
  for (const child of Object.values(value)) codes.push(...collectLogicalCodes(child, depth + 1));
  return Array.from(new Set(codes)).slice(0, 20);
}

function findKlineMetadata(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  const candidates = [value.metadata, value.meta, value.history, value.detail];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (
      "history_state" in candidate
      || "verified_contiguous" in candidate
      || "missing_ranges" in candidate
      || "backfill_triggered" in candidate
    ) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findKlineMetadata(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function compactApiResponse(pathname, body) {
  if (!body || typeof body !== "object") return { parsed: false };
  if (pathname.startsWith("/api/v1/indicators/")) {
    return {
      parsed: true,
      ok: typeof body.ok === "boolean" ? body.ok : null,
      code: body.code || null,
      message: body.message || body.detail?.message || null,
      logicalCodes: collectLogicalCodes(body),
      range: body.range || body.detail?.range || null,
      lines: summarizeLines(body),
    };
  }
  const metadata = findKlineMetadata(body) || {};
  const bars = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.bars)
      ? body.bars
      : Array.isArray(body.items)
        ? body.items
        : [];
  return {
    parsed: true,
    barCount: bars.length,
    historyState: metadata.history_state || null,
    complete: typeof metadata.complete === "boolean" ? metadata.complete : null,
    retryable: typeof metadata.retryable === "boolean" ? metadata.retryable : null,
    verifiedContiguous: typeof metadata.verified_contiguous === "boolean"
      ? metadata.verified_contiguous
      : null,
    allRowsFinal: typeof metadata.all_rows_final === "boolean" ? metadata.all_rows_final : null,
    backfillTriggered: typeof metadata.backfill_triggered === "boolean"
      ? metadata.backfill_triggered
      : null,
    missingRanges: Array.isArray(metadata.missing_ranges)
      ? metadata.missing_ranges.slice(0, 20)
      : [],
  };
}

function compactWebSocketPayload(raw) {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { bytes: Buffer.byteLength(String(raw || "")), parsed: false };
  }
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  const values = parsed.values && typeof parsed.values === "object" ? parsed.values : {};
  return {
    parsed: true,
    type: parsed.type || parsed.event || parsed.action || null,
    sequence: parsed.seq ?? parsed.sequence ?? data.seq ?? null,
    indicatorId: parsed.indicatorId || parsed.clientId || data.indicatorId || null,
    indicatorIds: Array.isArray(parsed.indicatorIds) ? parsed.indicatorIds : null,
    barTime: parsed.barTime ?? parsed.time ?? data.barTime ?? data.time ?? null,
    valueCount: Array.isArray(parsed.values)
      ? parsed.values.length
      : Object.keys(values).length,
    lineCount: Array.isArray(parsed.lines) ? parsed.lines.length : null,
    bytes: Buffer.byteLength(raw),
  };
}

function isAppOwnedWebSocket(rawUrl, frontendUrl, backendUrl) {
  try {
    const candidate = new URL(rawUrl);
    const frontend = new URL(frontendUrl);
    const backend = new URL(backendUrl);
    return candidate.hostname === frontend.hostname
      || candidate.hostname === backend.hostname;
  } catch {
    return false;
  }
}

async function fetchBackendJson(baseUrl, pathname, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function endpointError(error, sampledAtMs) {
  return {
    error: error instanceof Error ? error.message : String(error),
    sampledAtMs,
  };
}

async function removeDirectoryWithRetries(directory) {
  if (!directory) return;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await wait(250);
    }
  }
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill();
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    wait(2_000),
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge was not found; pass --chrome <path>");

  const startedAtMs = Date.now();
  const defaultOutput = path.resolve(
    scriptDirectory,
    "../../output/playwright",
    `indicator-stack-monitor-${timestampSlug(new Date(startedAtMs))}`,
  );
  const outputDirectory = args.outDir ? path.resolve(process.cwd(), args.outDir) : defaultOutput;
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Artifact directory is not empty: ${outputDirectory}`);
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const timelinePath = path.join(outputDirectory, "timeline.jsonl");
  const eventsPath = path.join(outputDirectory, "events.jsonl");
  const chromeLogPath = path.join(outputDirectory, "chrome.log");
  const profileDirectory = path.join(
    os.tmpdir(),
    `candlescope-indicator-monitor-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(profileDirectory, { recursive: true });

  let eventSequence = 0;
  const inMemoryEvents = [];
  const eventCounts = {};
  const latestWebSocketFrames = new Map();
  let inMemoryEventsDropped = 0;
  const appendEvent = (event) => {
    const record = { sequence: ++eventSequence, atMs: Date.now(), ...event };
    fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
    eventCounts[record.type] = (eventCounts[record.type] || 0) + 1;
    if (record.type === "websocket-frame") {
      latestWebSocketFrames.set(`${record.url || ""}|${record.direction || ""}`, record);
    } else if (inMemoryEvents.length < MAX_IN_MEMORY_EVENTS) {
      inMemoryEvents.push(record);
    } else {
      inMemoryEventsDropped += 1;
    }
    return record;
  };

  const debugPort = await getFreePort();
  const chromeArguments = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--window-size=1600,1000",
    ...(args.headless ? ["--headless=new", "--disable-gpu"] : []),
    args.url,
  ];
  const chromeLog = fs.createWriteStream(chromeLogPath, { flags: "a" });
  const browserProcess = spawn(chromePath, chromeArguments, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: args.headless,
  });
  browserProcess.stdout?.pipe(chromeLog);
  browserProcess.stderr?.pipe(chromeLog);
  appendEvent({ type: "browser-launched", pid: browserProcess.pid, chromePath, debugPort });

  let stopping = false;
  let stopReason = null;
  const requestStop = (reason) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  browserProcess.once("exit", (code, signal) => {
    appendEvent({ type: "browser-exit", code, signal });
    requestStop("browser-exit");
  });

  let cdp = null;
  let rangeCapture = null;
  const samples = [];
  const backendState = {};
  let lastDeepSampleAtMs = 0;
  let report = null;
  try {
    const debugBase = `http://127.0.0.1:${debugPort}`;
    await waitForDevTools(debugBase);
    const target = await waitForPageTarget(debugBase, args.url);
    cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.connect();

    const networkRequests = new Map();
    const allRequests = new Map();
    const websocketUrls = new Map();
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (!['error', 'warning', 'assert'].includes(event?.type)) return;
      appendEvent({
        type: event.type === "error" ? "console-error" : "console-warning",
        level: event.type,
        text: (event.args || []).map(remoteObjectText).join(" ").slice(0, 4_000),
        stackTrace: event.stackTrace || null,
      });
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      appendEvent({
        type: "runtime-exception",
        text: event?.exceptionDetails?.exception?.description
          || event?.exceptionDetails?.text
          || "runtime exception",
        details: event?.exceptionDetails || null,
      });
    });
    cdp.on("Log.entryAdded", (event) => {
      if (!event?.entry || !["error", "warning"].includes(event.entry.level)) return;
      appendEvent({
        type: event.entry.level === "error" ? "console-error" : "console-warning",
        level: event.entry.level,
        source: event.entry.source,
        text: String(event.entry.text || "").slice(0, 4_000),
        url: event.entry.url || null,
      });
    });
    cdp.on("Network.requestWillBeSent", (event) => {
      allRequests.set(event.requestId, {
        url: event?.request?.url || null,
        method: event?.request?.method || null,
      });
      const pathname = monitoredApiPath(event?.request?.url);
      if (!pathname) return;
      networkRequests.set(event.requestId, {
        pathname,
        url: event.request.url,
        method: event.request.method,
        startedAtMs: Date.now(),
        requestBody: parseJson(event.request.postData),
      });
    });
    cdp.on("Network.responseReceived", (event) => {
      const request = networkRequests.get(event?.requestId);
      if (!request) return;
      request.status = event.response?.status ?? null;
      request.mimeType = event.response?.mimeType || null;
    });
    cdp.on("Network.loadingFailed", (event) => {
      const request = networkRequests.get(event?.requestId);
      const anyRequest = allRequests.get(event?.requestId);
      appendEvent({
        type: event?.canceled ? "network-canceled" : "network-failure",
        requestId: event?.requestId || null,
        pathname: request?.pathname || null,
        url: request?.url || anyRequest?.url || null,
        errorText: event?.errorText || null,
        canceled: Boolean(event?.canceled),
      });
      networkRequests.delete(event?.requestId);
      allRequests.delete(event?.requestId);
    });
    cdp.on("Network.loadingFinished", async (event) => {
      const request = networkRequests.get(event?.requestId);
      allRequests.delete(event?.requestId);
      if (!request) return;
      networkRequests.delete(event.requestId);
      let response = { parsed: false };
      let bodyError = null;
      try {
        const result = await cdp.send("Network.getResponseBody", { requestId: event.requestId });
        const raw = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body;
        response = compactApiResponse(request.pathname, parseJson(raw));
      } catch (error) {
        bodyError = error instanceof Error ? error.message : String(error);
      }
      appendEvent({
        type: "api-response",
        requestId: event.requestId,
        pathname: request.pathname,
        method: request.method,
        status: request.status ?? null,
        durationMs: Date.now() - request.startedAtMs,
        encodedDataLength: Number(event.encodedDataLength) || 0,
        requestBody: request.requestBody,
        response,
        bodyError,
      });
    });
    cdp.on("Network.webSocketCreated", (event) => {
      const url = event.url || null;
      const appOwned = isAppOwnedWebSocket(url, args.url, args.backendUrl);
      websocketUrls.set(event.requestId, { url, appOwned });
      appendEvent({ type: "websocket-created", requestId: event.requestId, url, appOwned });
    });
    cdp.on("Network.webSocketClosed", (event) => {
      const socket = websocketUrls.get(event.requestId) || {};
      appendEvent({
        type: "websocket-closed",
        requestId: event.requestId,
        url: socket.url || null,
        appOwned: socket.appOwned === true,
      });
      websocketUrls.delete(event.requestId);
    });
    cdp.on("Network.webSocketFrameError", (event) => {
      const socket = websocketUrls.get(event.requestId) || {};
      appendEvent({
        type: "websocket-error",
        requestId: event.requestId,
        url: socket.url || null,
        appOwned: socket.appOwned === true,
        errorMessage: event.errorMessage || null,
      });
    });
    const recordWebSocketFrame = (direction) => (event) => {
      const socket = websocketUrls.get(event.requestId) || {};
      if (socket.appOwned !== true) return null;
      return appendEvent({
        type: "websocket-frame",
        direction,
        requestId: event.requestId,
        url: socket.url || null,
        appOwned: true,
        payload: compactWebSocketPayload(event.response?.payloadData || ""),
      });
    };
    cdp.on("Network.webSocketFrameReceived", recordWebSocketFrame("received"));
    cdp.on("Network.webSocketFrameSent", recordWebSocketFrame("sent"));

    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
      cdp.send("Performance.enable"),
      cdp.send("Network.enable", INDICATOR_RANGE_NETWORK_ENABLE_OPTIONS),
    ]);
    rangeCapture = createIndicatorRangeNetworkCapture(cdp, {
      initialPhase: "interactive-monitor",
    });

    console.log(`Monitor browser: ${args.url}`);
    console.log(`Artifacts: ${outputDirectory}`);
    console.log(args.durationMs > 0
      ? `Monitoring for ${args.durationMs} ms...`
      : "在这个新浏览器窗口里复现；完成后回终端按 Ctrl+C。"
    );

    while (!stopping) {
      const sampleStartedAtMs = Date.now();
      if (args.durationMs > 0 && sampleStartedAtMs - startedAtMs >= args.durationMs) {
        requestStop("duration-complete");
        break;
      }
      let frontendResult = {};
      try {
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const text = document.body?.innerText || "";
            const counts = Array.from(text.matchAll(/(\\d+)\\s+bars/g), (match) => Number(match[1]));
            const perf = window.__CANDLESCOPE_PERF__?.report?.() || null;
            const perfEvents = Array.isArray(perf?.events) ? perf.events : [];
            let indicatorRuntime = null;
            try { indicatorRuntime = window.__CANDLESCOPE_INDICATOR_MONITOR__?.snapshot?.() || null; }
            catch (error) { indicatorRuntime = { error: error?.message || String(error), runtimes: [] }; }
            const longTasks = performance.getEntriesByType?.("longtask") || [];
            return {
              browser: {
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                visibilityState: document.visibilityState,
                barCount: counts.length ? Math.max(...counts) : 0,
                loadingVisible: text.includes("Loading..."),
                liveWebSocketVisible: text.includes("Live (WebSocket)"),
                connectedVisible: text.includes("Connected to Binance"),
                bodyTextTail: text.slice(-1000),
                heap: performance.memory ? {
                  usedJSHeapSize: performance.memory.usedJSHeapSize,
                  totalJSHeapSize: performance.memory.totalJSHeapSize,
                  jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                } : null,
                longTasks: {
                  count: longTasks.length,
                  totalDurationMs: longTasks.reduce((total, item) => total + item.duration, 0),
                  last: longTasks.length ? {
                    startTime: longTasks.at(-1).startTime,
                    duration: longTasks.at(-1).duration,
                  } : null,
                },
              },
              frontend: indicatorRuntime || { runtimes: [] },
              performance: perf ? {
                eventCount: perfEvents.length,
                latestEvents: perfEvents.slice(-20),
                result: perf.result || null,
              } : null,
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        frontendResult = evaluation?.result?.value || {};
      } catch (error) {
        appendEvent({
          type: "monitor-evaluation-error",
          error: error instanceof Error ? error.message : String(error),
        });
        frontendResult = {
          browser: { readyState: null, barCount: 0 },
          frontend: { runtimes: [], error: "evaluation-failed" },
        };
      }

      const shouldDeepSample = sampleStartedAtMs - lastDeepSampleAtMs >= args.deepSampleMs;
      const endpointTasks = [
        ["health", "/health", (value) => value],
        ["storage", "/api/v1/settings/storage/health", compactStorageHealth],
        ["indicators", "/api/v1/indicators/diagnostics", compactIndicatorDiagnostics],
        ...(shouldDeepSample
          ? [["debug", "/debug/snapshot", compactDebugSnapshot]]
          : []),
      ];
      const endpointResults = await Promise.all(endpointTasks.map(async ([name, pathname, compact]) => {
        try {
          const raw = await fetchBackendJson(args.backendUrl, pathname);
          return [name, { ...compact(raw), sampledAtMs: sampleStartedAtMs }];
        } catch (error) {
          return [name, endpointError(error, sampleStartedAtMs)];
        }
      }));
      for (const [name, value] of endpointResults) backendState[name] = value;
      if (shouldDeepSample) lastDeepSampleAtMs = sampleStartedAtMs;

      const sample = {
        atMs: sampleStartedAtMs,
        elapsedMs: sampleStartedAtMs - startedAtMs,
        browser: frontendResult.browser || {},
        frontend: frontendResult.frontend || { runtimes: [] },
        performance: frontendResult.performance || null,
        backend: structuredClone(backendState),
      };
      sample.issues = assessIndicatorStackSample(sample);
      samples.push(sample);
      fs.appendFileSync(timelinePath, `${JSON.stringify(sample)}\n`);
      const runtimeCount = sample.frontend?.runtimes?.length || 0;
      const indicatorCount = (sample.frontend?.runtimes || []).reduce(
        (total, runtime) => total + (runtime.indicators?.length || 0),
        0,
      );
      const scheduler = sample.backend?.storage?.scheduler || {};
      const issueText = sample.issues.length ? sample.issues.join(",") : "none";
      const gateList = Array.from(new Set((sample.frontend?.runtimes || []).flatMap(
        (runtime) => runtime.gates || [],
      )));
      const gateText = gateList.length ? gateList.join(",") : "none";
      console.log(
        `[${Math.round(sample.elapsedMs / 1000)}s] bars=${sample.browser.barCount || 0}`
        + ` runtimes=${runtimeCount} indicators=${indicatorCount}`
        + ` backfill=${scheduler.runningChunks ?? "?"}/${scheduler.readyChunks ?? "?"}`
        + ` gates=${gateText} issues=${issueText}`,
      );
      const elapsed = Date.now() - sampleStartedAtMs;
      if (!stopping && elapsed < args.sampleMs) await wait(args.sampleMs - elapsed);
    }

    if (rangeCapture) {
      await rangeCapture.waitForIdle({ quietMs: 250, timeoutMs: 2_000 });
      await rangeCapture.flush(2_000);
    }
    try {
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      fs.writeFileSync(path.join(outputDirectory, "final.png"), Buffer.from(screenshot.data, "base64"));
    } catch (error) {
      appendEvent({
        type: "screenshot-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const indicatorRangeRecords = rangeCapture?.records?.() || [];
    const indicatorRangeSummary = rangeCapture?.summary?.() || {};
    fs.writeFileSync(
      path.join(outputDirectory, "indicator-range-requests.json"),
      `${JSON.stringify(indicatorRangeRecords, null, 2)}\n`,
    );
    report = summarizeIndicatorStackMonitoring({
      startedAtMs,
      endedAtMs: Date.now(),
      samples,
      events: [...inMemoryEvents, ...latestWebSocketFrames.values()],
      eventCounts,
      indicatorRange: indicatorRangeSummary,
    });
    report.stopReason = stopReason;
    report.inMemoryEventsDropped = inMemoryEventsDropped;
    report.artifacts = {
      timeline: timelinePath,
      events: eventsPath,
      screenshot: path.join(outputDirectory, "final.png"),
      indicatorRangeRequests: path.join(outputDirectory, "indicator-range-requests.json"),
    };
    fs.writeFileSync(
      path.join(outputDirectory, "summary.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outputDirectory, "summary.md"),
      formatIndicatorStackMarkdown(report),
    );
  } finally {
    cdp?.close();
    await stopProcess(browserProcess);
    chromeLog.end();
    await removeDirectoryWithRetries(profileDirectory);
  }

  console.log(`Report: ${path.join(outputDirectory, "summary.md")}`);
  if (report && args.failOnIssues && !report.clean) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
