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

function parseArgs(argv) {
  const args = {
    url: process.env.SMOKE_URL || DEFAULT_URL,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    chromePath: process.env.CHROME_PATH || "",
    screenshot: process.env.SMOKE_SCREENSHOT || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--chrome") args.chromePath = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
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

async function openSettings(cdp) {
  const clickResult = await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('.settings-btn'); if (!button) return false; button.click(); return true; })()",
    returnByValue: true,
  });

  let settingsOpened = false;
  for (let i = 0; i < 20; i += 1) {
    await wait(500);
    const settingsResult = await cdp.send("Runtime.evaluate", {
      expression: "Boolean(document.querySelector('.st-overlay .st-panel') && document.querySelector('.st-sidebar') && document.querySelector('.st-btn-close'))",
      returnByValue: true,
    });
    settingsOpened = Boolean(settingsResult.result?.value);
    if (settingsOpened) break;
  }

  return {
    settingsButtonClicked: Boolean(clickResult.result?.value),
    settingsOpened,
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
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: args.url });

    const { bodyText, loadedAt } = await waitForChartReady(cdp, args.timeoutMs);
    const settings = await openSettings(cdp);
    const screenshotData = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(screenshot, Buffer.from(screenshotData.data, "base64"));

    const report = {
      url: args.url,
      loadedAtMs: loadedAt,
      bars: parseBarCount(bodyText),
      connected: bodyText.includes("Connected to Binance"),
      live: bodyText.includes("Live (WebSocket)"),
      ...settings,
      apiResponses: responses.slice(0, 20),
      failures,
      warnings: warnings.slice(0, 20),
      screenshot,
    };

    console.log(JSON.stringify(report, null, 2));

    const failed = !report.connected || !report.live || report.bars <= 0 || !report.settingsOpened || failures.length > 0;
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
