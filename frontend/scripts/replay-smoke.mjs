import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { captureReplayReleaseEvidence } from "./replay-release-evidence.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = path.join(repositoryRoot, "backend");
const DEFAULT_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const result = { headed: false, timeoutMs: DEFAULT_TIMEOUT_MS, chromePath: process.env.CHROME_PATH || "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--headed") result.headed = true;
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else if (value === "--chrome-path") result.chromePath = String(argv[++index] || "");
    else if (/^[0-9]+$/.test(value)) result.timeoutMs = Number(value);
    else throw new Error(`Unknown replay smoke option: ${value}`);
  }
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs < 5_000) throw new Error("--timeout-ms must be at least 5000");
  return result;
}

function findChrome(explicit = "") {
  const candidates = [
    explicit,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function waitForHttp(url, child, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Process exited before ${url}: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

function processTail(child, maxLines = 100) {
  const lines = [];
  const append = (chunk) => {
    lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => [...lines];
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(3_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params || {});
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.socket.close(); } catch { /* target may already be closed */ }
  }
}

async function createTarget(debugBase, url = "about:blank") {
  const target = await readJson(`${debugBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable")]);
  return { target, cdp };
}

async function evaluate(cdp, expression, { userGesture = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForValue(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    try {
      value = await evaluate(cdp, expression);
      if (value) return value;
    } catch { /* page may be navigating */ }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(value)}`);
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.matches(":disabled")) return false;
    element.click();
    return true;
  })()`, { userGesture: true });
  if (!clicked) throw new Error(`Cannot click ${selector}`);
}

function captureTarget(cdp) {
  const capture = {
    requests: [],
    responses: [],
    webSockets: [],
    replayFrames: [],
    exceptions: [],
    consoleErrors: [],
  };
  cdp.on("Network.requestWillBeSent", (event) => capture.requests.push(event.request?.url || ""));
  cdp.on("Network.responseReceived", (event) => capture.responses.push({ url: event.response?.url || "", status: event.response?.status || 0 }));
  cdp.on("Network.webSocketCreated", (event) => capture.webSockets.push(event.url || ""));
  cdp.on("Network.webSocketFrameReceived", (event) => {
    try {
      const payload = JSON.parse(event.response?.payloadData || "");
      if (payload?.protocol === "replay.v1") capture.replayFrames.push(payload);
    } catch { /* HMR and pongs are not replay envelopes */ }
  });
  cdp.on("Runtime.exceptionThrown", (event) => capture.exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "exception"));
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") capture.consoleErrors.push(event.args?.map((item) => item.value || item.description || "").join(" ") || "console error");
  });
  return capture;
}

async function replayStatus(cdp) {
  return evaluate(cdp, `(() => {
    const status = document.querySelector("#replay-status-bar");
    if (!(status instanceof HTMLElement)) return null;
    return {
      connection: status.dataset.replayConnection,
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      lastBarClosed: status.dataset.replayLastBarClosed,
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) bars/) || [])[1] || 0),
    };
  })()`);
}

async function waitForReplayStatus(cdp, predicateSource, timeoutMs, label) {
  return waitForValue(cdp, `(() => {
    const status = document.querySelector("#replay-status-bar");
    if (!(status instanceof HTMLElement)) return null;
    const value = {
      connection: status.dataset.replayConnection,
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      lastBarClosed: status.dataset.replayLastBarClosed,
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) bars/) || [])[1] || 0),
    };
    return (${predicateSource})(value) ? value : null;
  })()`, timeoutMs, label);
}

async function waitForCommandReady(cdp, timeoutMs) {
  return waitForValue(cdp, `(() => {
    const button = document.querySelector('[data-replay-action="step"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, timeoutMs, "replay command readiness");
}

async function stepOnce(cdp, timeoutMs) {
  await waitForCommandReady(cdp, timeoutMs);
  const before = await replayStatus(cdp);
  await click(cdp, '[data-replay-action="step"]');
  return waitForReplayStatus(cdp, `(value) => value.sourceSequence > ${before.sourceSequence}`, timeoutMs, "step source sequence");
}

async function liveSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body?.innerText || "";
    const interval = document.querySelector(".interval-btn.active")?.textContent?.trim() || "";
    const symbolInput = document.querySelector('input[placeholder*="symbol" i], input[placeholder*="交易对"]');
    const symbolText = symbolInput instanceof HTMLInputElement ? symbolInput.value : "BTCUSDT";
    const bars = Math.max(0, ...[...text.matchAll(/([0-9]+)[ ]+bars/g)].map((match) => Number(match[1])));
    return {
      url: location.href,
      interval,
      symbol: symbolText || "BTCUSDT",
      bars,
      canvasCount: document.querySelectorAll("canvas").length,
      prefs: localStorage.getItem("candlescope-user-prefs"),
      replayEntry: document.querySelector('[data-replay-entry="enabled"]')?.textContent?.trim() || "",
    };
  })()`);
}

function assert(condition, message, detail = undefined) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

function assertReplayNetwork(capture, frontendOrigin) {
  const forbiddenApi = /\/api\/v1\/(?:klines|market|trade[_-]?flow|liquidations?|order[_-]?book|full[_-]?order[_-]?book|symbols|exchanges|subscriptions|indicators|alerts|settings)/i;
  const badRequests = capture.requests.filter((url) => {
    if (!url) return false;
    const parsed = new URL(url);
    return parsed.origin !== frontendOrigin || forbiddenApi.test(parsed.pathname);
  });
  const badSockets = capture.webSockets.filter((url) => {
    if (!url) return false;
    const parsed = new URL(url);
    return parsed.host !== new URL(frontendOrigin).host || (/\/api\/v1\/stream\//.test(parsed.pathname) && !/\/api\/v1\/stream\/replay\//.test(parsed.pathname));
  });
  assert(badRequests.length === 0, "replay target emitted forbidden HTTP", badRequests);
  assert(badSockets.length === 0, "replay target emitted forbidden WebSocket", badSockets);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseEvidence = captureReplayReleaseEvidence(repositoryRoot);
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; set CHROME_PATH or --chrome-path");
  const [backendPort, frontendPort, debugPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-replay-smoke-"));
  const userDataDir = path.join(tempRoot, "chrome-profile");
  fs.mkdirSync(userDataDir);
  const python = fs.existsSync(path.join(backendRoot, ".venv", "Scripts", "python.exe"))
    ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
    : "python";
  const offlineOrigin = "http://127.0.0.1:9";
  const backendEnv = {
    ...process.env,
    REPLAY_ENABLED: "1",
    KLINES_DB_PATH: path.join(tempRoot, "candlescope.db"),
    REPLAY_DB_PATH: path.join(tempRoot, "replay.db"),
    CANDLE_DATA_DIR: path.join(tempRoot, "data"),
    BINANCE_BASE_URL: offlineOrigin,
    BINANCE_WS_URL: "ws://127.0.0.1:9",
    BINANCE_FUTURES_BASE_URL: offlineOrigin,
    BINANCE_FUTURES_WS_URL: "ws://127.0.0.1:9",
    REQUEST_TIMEOUT: "1",
    MAX_RETRIES: "0",
    RAW_AGG_TRADE_ARCHIVE_ENABLED: "0",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const backend = spawn(python, ["-m", "scripts.replay_smoke_fixture", "--port", String(backendPort)], {
    cwd: backendRoot,
    env: backendEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const backendTail = processTail(backend);
  const vite = spawn(process.execPath, [path.join(frontendRoot, "node_modules", "vite", "bin", "vite.js")], {
    cwd: frontendRoot,
    env: {
      ...process.env,
      VITE_DEV_PORT: String(frontendPort),
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
      VITE_REPLAY_ENTRY_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const viteTail = processTail(vite);
  const chromeArguments = [
    ...(args.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1600,1000",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const chrome = spawn(chromePath, chromeArguments, { stdio: ["ignore", "ignore", "pipe"] });
  const chromeTail = processTail(chrome);
  const connections = [];
  try {
    await waitForHttp(`http://127.0.0.1:${backendPort}/__replay_smoke__/fixture`, backend, args.timeoutMs);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`, vite, args.timeoutMs);
    const debugBase = `http://127.0.0.1:${debugPort}`;
    await waitForHttp(`${debugBase}/json/version`, chrome, args.timeoutMs);
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    const live = await createTarget(debugBase);
    connections.push(live.cdp);
    const liveCapture = captureTarget(live.cdp);
    await live.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("candlescope-user-prefs", JSON.stringify({ lastExchange: "binance", lastMarketType: "spot", lastSymbol: "BTCUSDT", lastInterval: "1m" })); } catch {}`,
    });
    await live.cdp.send("Page.navigate", { url: `${frontendOrigin}/` });
    await waitForValue(live.cdp, `document.querySelector('[data-replay-entry="enabled"]') !== null`, args.timeoutMs, "enabled live replay entry");
    await waitForValue(live.cdp, `document.querySelectorAll("canvas").length > 0 && [...document.body.innerText.matchAll(/([0-9]+)[ ]+bars/g)].some((match) => Number(match[1]) > 0)`, args.timeoutMs, "live chart fixture bars");
    const liveBefore = await liveSnapshot(live.cdp);
    const liveBeforeAtMs = Date.now();
    assert(liveBefore.replayEntry === "K 线回放 ↗", "live TopBar replay entry text mismatch", liveBefore);
    assert(liveBefore.bars > 0 && liveBefore.canvasCount > 0, "live fixture chart did not become ready", {
      liveBefore,
      apiResponses: liveCapture.responses.filter((item) => item.url.includes("/api/")),
      consoleErrors: liveCapture.consoleErrors,
      exceptions: liveCapture.exceptions,
    });

    const targetsBefore = await readJson(`${debugBase}/json/list`);
    await click(live.cdp, '[data-replay-entry="enabled"]');
    const replayTarget = await (async () => {
      const started = Date.now();
      while (Date.now() - started < args.timeoutMs) {
        const targets = await readJson(`${debugBase}/json/list`);
        const found = targets.find((target) => target.type === "page" && /\/replay\.html(?:$|\?)/.test(target.url) && !targetsBefore.some((old) => old.id === target.id));
        if (found) return found;
        await wait(100);
      }
      throw new Error("live replay entry did not open a new target");
    })();
    const replayCdp = new CdpConnection(replayTarget.webSocketDebuggerUrl);
    await replayCdp.connect();
    connections.push(replayCdp);
    await Promise.all([replayCdp.send("Page.enable"), replayCdp.send("Runtime.enable"), replayCdp.send("Network.enable")]);
    const replayCapture = captureTarget(replayCdp);
    assert(await evaluate(replayCdp, "window.opener === null"), "replay target retained window.opener");
    const initialReplayUrl = await evaluate(replayCdp, "location.href");
    assert(new URL(initialReplayUrl).search === "", "new replay target must begin without a session query");
    // Re-navigate under an already-enabled Network domain so the capture
    // includes the replay document's first controlled request.
    await replayCdp.send("Page.navigate", { url: "about:blank" });
    await waitForValue(replayCdp, `location.href === "about:blank"`, args.timeoutMs, "blank replay capture boundary");
    await replayCdp.send("Page.navigate", { url: initialReplayUrl });
    await waitForValue(replayCdp, `location.pathname.endsWith("/replay.html")`, args.timeoutMs, "controlled replay document navigation");
    assert(await evaluate(replayCdp, "window.opener === null"), "controlled replay navigation restored an opener");
    try {
      await waitForValue(replayCdp, `(() => { const button = document.querySelector('[data-replay-action="create-session"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "replay session dialog readiness");
    } catch (error) {
      const diagnostics = await evaluate(replayCdp, `({ text: document.body?.innerText || "", html: document.querySelector(".replay-session-dialog")?.innerHTML || "" })`).catch(() => null);
      throw new Error(`${error.message}\nReplay dialog diagnostics: ${JSON.stringify({ diagnostics, responses: replayCapture.responses, consoleErrors: replayCapture.consoleErrors, exceptions: replayCapture.exceptions })}`);
    }
    await click(replayCdp, '[data-replay-action="create-session"]');
    const initial = await waitForReplayStatus(replayCdp, `(value) => value.connection === "connected" && value.state === "PAUSED" && value.bars > 0`, args.timeoutMs, "initial replay atomic snapshot");
    assert(initial.maxBarMs <= initial.cursorMs, "initial replay store exceeds cursor", initial);
    assert(/\?session=[A-Za-z0-9._:-]+$/.test(await evaluate(replayCdp, "location.href")), "session URL is not opaque/restorable");
    const blindDomText = await evaluate(replayCdp, "document.body.innerText");
    const calendarDateMatches = [...String(blindDomText).matchAll(/\b20\d{2}(?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月]))/g)].map((match) => ({
      value: match[0],
      context: String(blindDomText).slice(Math.max(0, match.index - 40), (match.index ?? 0) + 44),
    }));
    assert(calendarDateMatches.length === 0, "blind replay DOM contains a calendar date", calendarDateMatches);

    const stepStates = [];
    for (let index = 0; index < 5; index += 1) stepStates.push(await stepOnce(replayCdp, args.timeoutMs));
    assert(stepStates.slice(0, 4).every((state) => state.lastBarClosed === "false"), "first four 1m steps did not stay in one forming 5m bar", stepStates);
    assert(stepStates[4].lastBarClosed === "true", "fifth 1m step did not close the 5m bar", stepStates[4]);
    assert(stepStates.every((state) => state.maxBarMs <= state.cursorMs), "stepped replay store exceeds cursor", stepStates);

    const beforeOrder = await replayStatus(replayCdp);
    await click(replayCdp, '[data-replay-action="place-order"]');
    await waitForReplayStatus(replayCdp, `(value) => value.orderCount > ${beforeOrder.orderCount}`, args.timeoutMs, "paper market order");
    const beforeFill = await replayStatus(replayCdp);
    const filled = await stepOnce(replayCdp, args.timeoutMs);
    await waitForReplayStatus(replayCdp, `(value) => value.fillCount > ${beforeFill.fillCount}`, args.timeoutMs, "market next-open fill");
    assert(filled.maxBarMs <= filled.cursorMs, "fill step exceeded public cursor", filled);

    await evaluate(replayCdp, `(() => { const select = document.querySelector('[data-replay-action="speed"]'); select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await waitForCommandReady(replayCdp, args.timeoutMs);
    await click(replayCdp, '[data-replay-action="play"]');
    const playing = await waitForReplayStatus(replayCdp, `(value) => value.state === "PLAYING"`, args.timeoutMs, "60x play ack");
    await waitForReplayStatus(replayCdp, `(value) => value.sourceSequence > ${playing.sourceSequence}`, args.timeoutMs, "60x source progress");
    await click(replayCdp, '[data-replay-action="pause"]');
    const paused = await waitForReplayStatus(replayCdp, `(value) => value.state === "PAUSED"`, args.timeoutMs, "pause ack");
    await wait(350);
    const pauseStable = await replayStatus(replayCdp);
    assert(pauseStable.sourceSequence === paused.sourceSequence, "cursor advanced after pause ack", { paused, pauseStable });
    await click(replayCdp, '[data-replay-action="advance"]');
    const advanced = await waitForReplayStatus(replayCdp, `(value) => value.sourceSequence > ${paused.sourceSequence}`, args.timeoutMs, "advance_by 5m");

    const bookmarkUrl = await evaluate(replayCdp, "location.href");
    const bookmarkState = advanced;
    await evaluate(replayCdp, `globalThis.__CANDLESCOPE_REPLAY_SMOKE_OLD_DOCUMENT__ = true`);
    await replayCdp.send("Page.reload", { ignoreCache: true });
    await waitForValue(
      replayCdp,
      `globalThis.__CANDLESCOPE_REPLAY_SMOKE_OLD_DOCUMENT__ !== true`,
      args.timeoutMs,
      "bookmark reload new document",
    );
    const restored = await waitForReplayStatus(replayCdp, `(value) => value.connection === "connected" && value.state === "PAUSED" && value.sourceSequence >= ${bookmarkState.sourceSequence}`, args.timeoutMs, "bookmark restore");
    assert(await evaluate(replayCdp, "window.opener === null"), "restored replay unexpectedly has opener");
    assert((await evaluate(replayCdp, "location.href")) === bookmarkUrl, "bookmark session URL changed on refresh");
    const takeoverVisible = await evaluate(replayCdp, `(() => { const button = document.querySelector('[data-replay-action="takeover-controller"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`);
    if (takeoverVisible) {
      await click(replayCdp, '[data-replay-action="takeover-controller"]');
      await waitForCommandReady(replayCdp, args.timeoutMs);
    }

    const activeSessionId = new URL(await evaluate(replayCdp, "location.href")).searchParams.get("session");
    assert(activeSessionId, "replay URL lost its session before disconnect test");
    const disconnectRequest = readJson(
      `http://127.0.0.1:${backendPort}/__replay_smoke__/disconnect-replay/${encodeURIComponent(activeSessionId)}`,
      { method: "POST" },
    );
    await waitForReplayStatus(replayCdp, `(value) => value.connection === "reconnecting" || value.connection === "resyncing"`, args.timeoutMs, "replay disconnect feedback");
    await disconnectRequest;
    const reconnected = await waitForReplayStatus(replayCdp, `(value) => value.connection === "connected" && value.sourceSequence >= ${restored.sourceSequence}`, args.timeoutMs, "replay reconnect convergence");
    assert(reconnected.maxBarMs <= reconnected.cursorMs, "reconnected store exceeds cursor", reconnected);
    const reconnectTakeoverVisible = await evaluate(replayCdp, `(() => { const button = document.querySelector('[data-replay-action="takeover-controller"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`);
    if (reconnectTakeoverVisible) {
      await click(replayCdp, '[data-replay-action="takeover-controller"]');
    }
    await waitForCommandReady(replayCdp, args.timeoutMs);

    const submitEnd = async () => {
      await click(replayCdp, '[data-replay-action="end"]');
      await waitForValue(
        replayCdp,
        `(() => { const button = document.querySelector('[data-replay-action="confirm-end"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
        args.timeoutMs,
        "end confirmation readiness",
      );
      await click(replayCdp, '[data-replay-action="confirm-end"]');
    };
    await submitEnd();
    let ended;
    try {
      ended = await waitForReplayStatus(replayCdp, `(value) => value.state === "ENDED"`, Math.min(args.timeoutMs, 5_000), "ended replay state");
    } catch (error) {
      const controllerConflict = await evaluate(replayCdp, `document.querySelector(".replay-command-error")?.getAttribute("data-replay-command-error") === "CONTROLLER_CONFLICT"`).catch(() => false);
      if (controllerConflict) {
        await waitForValue(
          replayCdp,
          `(() => { const button = document.querySelector('[data-replay-action="takeover-controller"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
          args.timeoutMs,
          "end retry controller readiness",
        );
        await click(replayCdp, '[data-replay-action="takeover-controller"]');
        await waitForCommandReady(replayCdp, args.timeoutMs);
        await submitEnd();
        ended = await waitForReplayStatus(replayCdp, `(value) => value.state === "ENDED"`, args.timeoutMs, "ended replay state after controller reacquire");
      } else {
        const diagnostics = await evaluate(replayCdp, `({
          status: (() => { const node = document.querySelector("#replay-status-bar"); return node instanceof HTMLElement ? { text: node.innerText, data: { ...node.dataset } } : null; })(),
          commandError: document.querySelector(".replay-command-error")?.textContent || "",
          bodyTail: (document.body?.innerText || "").slice(-2000),
        })()`).catch(() => null);
        throw new Error(`${error.message}\nEnd diagnostics: ${JSON.stringify({
          diagnostics,
          apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/v1/replay")).slice(-20),
          frames: replayCapture.replayFrames.slice(-10),
          consoleErrors: replayCapture.consoleErrors,
          exceptions: replayCapture.exceptions,
        })}`);
      }
    }
    await waitForValue(replayCdp, `document.querySelector('[data-replay-panel="report"]') !== null`, args.timeoutMs, "training report panel");
    assert(ended.revealed === "false", "session end implicitly revealed actual history", ended);
    // Ending a session intentionally releases the controller lease. The report
    // can render from the replay.ended event before the end command's pending
    // state is cleared, so a one-shot enabled check races that acknowledgement.
    await waitForValue(
      replayCdp,
      `(() => { const button = document.querySelector('[data-replay-action="takeover-controller"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "reveal takeover readiness",
    );
    await click(replayCdp, '[data-replay-action="takeover-controller"]');
    await waitForValue(replayCdp, `(() => { const button = document.querySelector('[data-replay-action="reveal-history"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "reveal controller readiness");
    await click(replayCdp, '[data-replay-action="reveal-history"]');
    await waitForValue(replayCdp, `document.querySelector('[data-replay-history-revealed="true"]') !== null`, args.timeoutMs, "explicit history reveal");

    const storageBeforeRevealAudit = await evaluate(replayCdp, `Object.fromEntries(Object.entries(localStorage))`);
    assert(!Object.values(storageBeforeRevealAudit).some((value) => /1700\d{9}/.test(String(value))), "replay localStorage leaked fixture timestamps", storageBeforeRevealAudit);
    assertReplayNetwork(replayCapture, frontendOrigin);
    assert(replayCapture.exceptions.length === 0, "replay target threw runtime exceptions", replayCapture.exceptions);
    const replayApiFailures = replayCapture.responses.filter((item) => item.url.includes("/api/v1/replay") && item.status >= 400);
    assert(replayApiFailures.length === 0, "replay API returned failure", replayApiFailures);
    assert(replayCapture.replayFrames.length > 0, "no replay.v1 WebSocket frames captured");

    const missing = await createTarget(debugBase, `${frontendOrigin}/replay.html?session=missing-session`);
    connections.push(missing.cdp);
    await waitForValue(missing.cdp, `document.querySelector('[data-replay-state="error"][data-replay-error="SESSION_NOT_FOUND"]') !== null`, args.timeoutMs, "missing session fail-closed state");
    assert(await evaluate(missing.cdp, "window.opener === null"), "direct missing-session page has opener");
    await missing.cdp.send("Page.close");

    await replayCdp.send("Page.close");
    await wait(250);
    const liveAfter = await liveSnapshot(live.cdp);
    assert(liveAfter.symbol === liveBefore.symbol, "replay changed live symbol", { liveBefore, liveAfter });
    assert(liveAfter.interval === liveBefore.interval, "replay changed live interval", { liveBefore, liveAfter });
    const allowedLiveGrowth = Math.ceil((Date.now() - liveBeforeAtMs) / 60_000) + 1;
    assert(
      liveAfter.bars >= liveBefore.bars && liveAfter.bars <= liveBefore.bars + allowedLiveGrowth,
      "live bar window did not progress monotonically during replay",
      { liveBefore, liveAfter, allowedLiveGrowth },
    );
    assert(liveAfter.prefs === liveBefore.prefs, "replay changed live persisted identity", { liveBefore, liveAfter });
    assert(!liveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)), "live target opened replay WebSocket", liveCapture.webSockets);

    const summary = {
      schema_version: "replay-v1-browser-smoke.v1",
      recorded_at: releaseEvidence.recorded_at,
      release_evidence: releaseEvidence.evidence,
      passed: true,
      fixture: { offline: true, rows: 4_000, backendPort, frontendPort },
      live: { before: liveBefore, after: liveAfter, webSockets: [...new Set(liveCapture.webSockets)] },
      replay: {
        initial,
        fifthStep: stepStates[4],
        paused,
        advanced,
        restored,
        reconnected,
        ended,
        requests: replayCapture.requests.length,
        replayFrames: replayCapture.replayFrames.length,
        openerNull: true,
        missingSessionFailClosed: true,
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    error.message = `${error.message}\nRelease evidence:\n${JSON.stringify(releaseEvidence, null, 2)}\nBackend tail:\n${backendTail().join("\n")}\nVite tail:\n${viteTail().join("\n")}\nChrome tail:\n${chromeTail().join("\n")}`;
    throw error;
  } finally {
    for (const connection of connections) connection.close();
    await Promise.all([stopProcessTree(chrome), stopProcessTree(vite), stopProcessTree(backend)]);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
