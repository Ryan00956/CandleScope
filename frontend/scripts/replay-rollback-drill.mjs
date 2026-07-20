import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureReplayReleaseEvidence } from "./replay-release-evidence.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = path.join(repositoryRoot, "backend");
const fixtureScript = path.join(backendRoot, "scripts", "replay_smoke_fixture.py");
const DEFAULT_BASELINE = "c9a1ddbfe316c68c91787b69c783baeeb0670a9f";
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const result = {
    baseline: DEFAULT_BASELINE,
    chromePath: process.env.CHROME_PATH || "",
    headed: false,
    out: path.join(repositoryRoot, "docs", "perf-baselines", "replay-v1-rollback-drill-20260718.json"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--baseline") result.baseline = String(argv[++index] || "");
    else if (value === "--chrome-path") result.chromePath = String(argv[++index] || "");
    else if (value === "--headed") result.headed = true;
    else if (value === "--out") result.out = path.resolve(String(argv[++index] || ""));
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else if (/^[0-9]+$/.test(value)) result.timeoutMs = Number(value);
    else throw new Error(`Unknown replay rollback option: ${value}`);
  }
  if (!result.baseline) throw new Error("--baseline requires a commit");
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 5_000) {
    throw new Error("--timeout-ms must be an integer >= 5000");
  }
  return result;
}

function assert(condition, message, detail = undefined) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
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

function nativePython() {
  const candidate = process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
    : path.join(backendRoot, ".venv", "bin", "python");
  return fs.existsSync(candidate) ? candidate : "python";
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, ok: response.ok, body };
}

async function readJson(url, options = {}) {
  const response = await request(url, options);
  if (!response.ok) throw new Error(`${response.status}: ${url}: ${JSON.stringify(response.body)}`);
  return response.body;
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

function processTail(child, maxLines = 120) {
  const lines = [];
  const append = (chunk) => {
    lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => [...lines];
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? null;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(timeoutMs),
  ]);
  if (child.exitCode === null) throw new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`);
  return child.exitCode;
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

async function gracefulStopBackend(origin, child, timeoutMs) {
  const response = await request(`${origin}/__replay_smoke__/shutdown`, { method: "POST" });
  assert(response.status === 200 && response.body?.graceful === true, "fixture rejected graceful shutdown", response);
  const exitCode = await waitForExit(child, timeoutMs);
  assert(exitCode === 0, "fixture backend graceful shutdown was nonzero", { exitCode });
}

function runSync(command, args, { cwd = repositoryRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return String(result.stdout || "").trim();
}

function startBackend({ python, root, port, enabled, paths, baseline = false }) {
  const backendEnv = {
    ...process.env,
    REPLAY_ENABLED: enabled ? "1" : "0",
    KLINES_DB_PATH: paths.klines,
    REPLAY_DB_PATH: paths.replay,
    CANDLE_DATA_DIR: paths.data,
    BINANCE_BASE_URL: "http://127.0.0.1:9",
    BINANCE_WS_URL: "ws://127.0.0.1:9",
    BINANCE_FUTURES_BASE_URL: "http://127.0.0.1:9",
    BINANCE_FUTURES_WS_URL: "ws://127.0.0.1:9",
    REQUEST_TIMEOUT: "1",
    MAX_RETRIES: "0",
    RAW_AGG_TRADE_ARCHIVE_ENABLED: "0",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const args = baseline
    ? [fixtureScript, "--port", String(port)]
    : ["-m", "scripts.replay_smoke_fixture", "--port", String(port)];
  if (baseline) backendEnv.PYTHONPATH = root;
  const child = spawn(python, args, {
    cwd: root,
    env: backendEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, tail: processTail(child) };
}

function startVite({ root, port, backendPort, entryEnabled }) {
  const vitePath = path.join(root, "node_modules", "vite", "bin", "vite.js");
  assert(fs.existsSync(vitePath), "Vite entrypoint is missing", { vitePath });
  // The detached baseline worktree deliberately reuses the installed
  // node_modules tree. Rebuild Vite's optimizer cache on every transition so
  // a force-stopped current build cannot leave stale metadata for the old one.
  const child = spawn(process.execPath, [vitePath, "--force"], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_PORT: String(port),
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
      VITE_REPLAY_ENTRY_ENABLED: entryEnabled ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, tail: processTail(child) };
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

function captureTarget(cdp) {
  const requestUrls = new Map();
  const capture = {
    consoleErrors: [],
    exceptions: [],
    failedResponses: [],
    loadingFailures: [],
    webSockets: [],
  };
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (requestId && request?.url) requestUrls.set(requestId, request.url);
  });
  cdp.on("Network.responseReceived", ({ response }) => {
    if (Number(response?.status) >= 400) {
      capture.failedResponses.push({ status: response.status, url: response.url });
    }
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, canceled, type }) => {
    capture.loadingFailures.push({
      url: requestUrls.get(requestId) || null,
      errorText: errorText || "unknown",
      canceled: Boolean(canceled),
      type: type || null,
    });
  });
  cdp.on("Network.webSocketCreated", ({ url }) => capture.webSockets.push(url));
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    capture.exceptions.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "runtime exception");
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error" || type === "assert") capture.consoleErrors.push(args?.map((item) => item.value ?? item.description).join(" ") || type);
  });
  return capture;
}

async function browserDiagnostic(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body?.innerText || "";
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      canvasCount: document.querySelectorAll("canvas").length,
      barMatches: [...text.matchAll(/([0-9]+)[ ]+bars/g)].map((match) => Number(match[1])),
      bodyTail: text.slice(-4_000),
      viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent?.slice(-4_000) || "",
    };
  })()`);
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
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`, { userGesture: true });
  assert(clicked, `Element not clickable: ${selector}`);
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
      bars: Number((status.innerText.match(/([0-9]+) bars/) || [])[1] || 0),
    };
    return (${predicateSource})(value) ? value : null;
  })()`, timeoutMs, label);
}

async function liveSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body?.innerText || "";
    const interval = document.querySelector(".interval-btn.active")?.textContent?.trim() || "";
    const symbolInput = document.querySelector('input[placeholder*="symbol" i], input[placeholder*="交易对"]');
    const symbolText = symbolInput instanceof HTMLInputElement ? symbolInput.value : "BTCUSDT";
    const bars = Math.max(0, ...[...text.matchAll(/([0-9]+)[ ]+bars/g)].map((match) => Number(match[1])));
    return {
      interval,
      symbol: symbolText || "BTCUSDT",
      bars,
      canvasCount: document.querySelectorAll("canvas").length,
      prefs: localStorage.getItem("candlescope-user-prefs"),
      replayEntry: document.querySelector('[data-replay-entry="enabled"]')?.textContent?.trim() || "",
      anyReplayEntry: document.querySelector("[data-replay-entry]") !== null,
    };
  })()`);
}

async function waitForLiveReady(cdp, timeoutMs) {
  return waitForValue(
    cdp,
    `document.querySelectorAll("canvas").length > 0 && [...(document.body?.innerText || "").matchAll(/([0-9]+)[ ]+bars/g)].some((match) => Number(match[1]) > 0)`,
    timeoutMs,
    "live chart fixture bars",
  );
}

async function openReplayFromLive({ liveCdp, debugBase, timeoutMs }) {
  const targetsBefore = await readJson(`${debugBase}/json/list`);
  await click(liveCdp, '[data-replay-entry="enabled"]');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await readJson(`${debugBase}/json/list`);
    const found = targets.find((target) => (
      target.type === "page"
      && /\/replay\.html(?:$|\?)/.test(target.url)
      && !targetsBefore.some((old) => old.id === target.id)
    ));
    if (found) {
      const cdp = new CdpConnection(found.webSocketDebuggerUrl);
      await cdp.connect();
      await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable")]);
      return { target: found, cdp };
    }
    await wait(100);
  }
  throw new Error("live replay entry did not open a new target");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function replayDatabaseDigest(dbPath) {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      name: path.basename(candidate),
      size: fs.statSync(candidate).size,
      sha256: fileHash(candidate),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert(files.some((item) => item.name === path.basename(dbPath)), "replay database was not created", files);
  return {
    files,
    sha256: sha256Buffer(JSON.stringify(files)),
  };
}

function queryReplaySession(python, dbPath, sessionId) {
  const source = [
    "import json, sqlite3, sys",
    "path, session_id = sys.argv[1], sys.argv[2]",
    "connection = sqlite3.connect(f'file:{path}?mode=ro', uri=True)",
    "connection.row_factory = sqlite3.Row",
    "row = connection.execute('SELECT session_id, state, status_reason, revision, event_sequence, source_sequence, state_hash FROM replay_session WHERE session_id = ?', (session_id,)).fetchone()",
    "connection.close()",
    "print(json.dumps(dict(row) if row is not None else None, sort_keys=True))",
  ].join("\n");
  const output = runSync(python, ["-c", source, dbPath, sessionId], { cwd: backendRoot });
  return JSON.parse(output);
}

function sameDigest(left, right) {
  return left.sha256 === right.sha256 && JSON.stringify(left.files) === JSON.stringify(right.files);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseEvidence = captureReplayReleaseEvidence(repositoryRoot);
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; set CHROME_PATH or --chrome-path");
  const python = nativePython();
  const baselineCommit = runSync("git", ["rev-parse", `${args.baseline}^{commit}`]);
  const currentCommit = runSync("git", ["rev-parse", "HEAD"]);
  assert(currentCommit === releaseEvidence.evidence.git_head, "release evidence HEAD changed before rollback drill", {
    captured: releaseEvidence.evidence.git_head,
    current: currentCommit,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-replay-rollback-"));
  const oldWorktree = path.join(tempRoot, "old-build");
  const paths = {
    data: path.join(tempRoot, "data"),
    klines: path.join(tempRoot, "candlescope.db"),
    replay: path.join(tempRoot, "replay.db"),
  };
  const chromeProfile = path.join(tempRoot, "chrome-profile");
  fs.mkdirSync(paths.data, { recursive: true });
  fs.mkdirSync(chromeProfile, { recursive: true });
  fs.writeFileSync(path.join(paths.data, "proxy_settings.json"), '{"mode":"none","custom_proxy":null}\n', "utf8");

  const [backendPort, frontendPort, debugPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const currentBackendOrigin = `http://127.0.0.1:${backendPort}`;
  const currentFrontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const debugBase = `http://127.0.0.1:${debugPort}`;
  const chromeArguments = [
    ...(args.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    "--window-size=1600,1000",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const chrome = spawn(chromePath, chromeArguments, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const chromeTail = processTail(chrome);
  const connections = [];
  const processes = [];
  const processRecords = [];
  const browserCaptures = [];
  const trackProcess = (label, started) => {
    processes.push(started.child);
    processRecords.push({ label, ...started });
    return started;
  };
  const trackBrowser = (label, cdp) => {
    const capture = captureTarget(cdp);
    browserCaptures.push({ label, cdp, capture });
    return capture;
  };
  let oldWorktreeAdded = false;
  let oldNodeModulesLinked = false;
  let result = null;
  let failure = null;

  try {
    await waitForHttp(`${debugBase}/json/version`, chrome, args.timeoutMs);

    const enabledBackend = trackProcess(
      "current-enabled-backend",
      startBackend({ python, root: backendRoot, port: backendPort, enabled: true, paths }),
    );
    await waitForHttp(`${currentBackendOrigin}/__replay_smoke__/fixture`, enabledBackend.child, args.timeoutMs);
    const enabledVite = trackProcess(
      "current-enabled-vite",
      startVite({ root: frontendRoot, port: frontendPort, backendPort, entryEnabled: true }),
    );
    await waitForHttp(`${currentFrontendOrigin}/`, enabledVite.child, args.timeoutMs);

    const live = await createTarget(debugBase);
    connections.push(live.cdp);
    const liveCapture = trackBrowser("current-live", live.cdp);
    const preferences = JSON.stringify({ lastExchange: "binance", lastMarketType: "spot", lastSymbol: "BTCUSDT", lastInterval: "1m" });
    await live.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("candlescope-user-prefs", ${JSON.stringify(preferences)}); } catch {}`,
    });
    await live.cdp.send("Page.navigate", { url: `${currentFrontendOrigin}/` });
    await waitForValue(live.cdp, `document.querySelector('[data-replay-entry="enabled"]') !== null`, args.timeoutMs, "enabled replay entry");
    await waitForLiveReady(live.cdp, args.timeoutMs);
    const liveBefore = await liveSnapshot(live.cdp);
    assert(liveBefore.replayEntry === "K 线回放 ↗", "enabled build did not expose replay entry", liveBefore);

    const replay = await openReplayFromLive({ liveCdp: live.cdp, debugBase, timeoutMs: args.timeoutMs });
    connections.push(replay.cdp);
    const replayCapture = trackBrowser("current-replay", replay.cdp);
    await waitForValue(replay.cdp, `(() => { const button = document.querySelector('[data-replay-action="create-session"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "replay session dialog");
    await click(replay.cdp, '[data-replay-action="create-session"]');
    const initial = await waitForReplayStatus(replay.cdp, `(value) => value.connection === "connected" && value.state === "PAUSED" && value.bars > 0`, args.timeoutMs, "initial replay snapshot");
    const sessionUrl = await evaluate(replay.cdp, "location.href");
    const sessionId = new URL(sessionUrl).searchParams.get("session");
    assert(sessionId, "replay session URL lost its session id");
    await evaluate(replay.cdp, `(() => { const select = document.querySelector('[data-replay-action="speed"]'); if (!(select instanceof HTMLSelectElement)) return false; select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await waitForReplayStatus(replay.cdp, `(value) => value.revision > ${initial.revision}`, args.timeoutMs, "speed ack");
    await waitForValue(replay.cdp, `(() => { const button = document.querySelector('[data-replay-action="play"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "play readiness");
    await click(replay.cdp, '[data-replay-action="play"]');
    const playing = await waitForReplayStatus(replay.cdp, `(value) => value.state === "PLAYING"`, args.timeoutMs, "active replay before rollback");
    const progressed = await waitForReplayStatus(replay.cdp, `(value) => value.state === "PLAYING" && value.sourceSequence > ${playing.sourceSequence}`, args.timeoutMs, "active replay progress before rollback");
    const replayStreamsBeforeRestart = replayCapture.webSockets.filter((url) => /\/api\/v1\/stream\/replay\//.test(url)).length;

    await gracefulStopBackend(currentBackendOrigin, enabledBackend.child, args.timeoutMs);
    await stopProcessTree(enabledVite.child);
    const persisted = queryReplaySession(python, paths.replay, sessionId);
    assert(persisted?.state === "PAUSED", "graceful feature rollback did not persist PAUSED", persisted);
    assert(persisted?.status_reason === "shutdown_pause", "graceful feature rollback did not persist shutdown_pause", persisted);
    const digestAfterGracefulShutdown = replayDatabaseDigest(paths.replay);

    const disabledBackend = trackProcess(
      "current-disabled-backend",
      startBackend({ python, root: backendRoot, port: backendPort, enabled: false, paths }),
    );
    await waitForHttp(`${currentBackendOrigin}/__replay_smoke__/fixture`, disabledBackend.child, args.timeoutMs);
    const disabledVite = trackProcess(
      "current-disabled-vite",
      startVite({ root: frontendRoot, port: frontendPort, backendPort, entryEnabled: false }),
    );
    await waitForHttp(`${currentFrontendOrigin}/`, disabledVite.child, args.timeoutMs);
    const disabledCapabilities = await readJson(`${currentBackendOrigin}/api/v1/replay/capabilities`);
    assert(disabledCapabilities?.enabled === false && disabledCapabilities?.available === false, "disabled backend advertised replay", disabledCapabilities);
    assert(disabledCapabilities?.persistence?.opened === false, "disabled backend opened replay persistence", disabledCapabilities);

    await live.cdp.send("Page.navigate", { url: `${currentFrontendOrigin}/` });
    await waitForLiveReady(live.cdp, args.timeoutMs);
    await waitForValue(live.cdp, `document.querySelector("[data-replay-entry]") === null`, args.timeoutMs, "hidden replay entry after rollback");
    const liveAfterDisable = await liveSnapshot(live.cdp);
    assert(liveAfterDisable.prefs === liveBefore.prefs, "feature rollback changed live preferences", { liveBefore, liveAfterDisable });
    assert(liveAfterDisable.symbol === liveBefore.symbol && liveAfterDisable.interval === liveBefore.interval, "feature rollback changed live identity", { liveBefore, liveAfterDisable });
    assert(liveAfterDisable.bars > 0 && liveAfterDisable.canvasCount > 0, "feature rollback broke live chart", liveAfterDisable);

    const replayStreamsBeforeDisabledDocument = replayCapture.webSockets.filter((url) => /\/api\/v1\/stream\/replay\//.test(url)).length;
    const transitionRejectedReplaySocketAttempts = replayStreamsBeforeDisabledDocument - replayStreamsBeforeRestart;
    await replay.cdp.send("Page.navigate", { url: sessionUrl });
    await waitForValue(replay.cdp, `document.querySelector('[data-replay-state="error"][data-replay-error="REPLAY_DISABLED"]') !== null`, args.timeoutMs, "open replay page disabled state");
    const disabledReplay = await evaluate(replay.cdp, `({
      error: document.querySelector('[data-replay-state="error"]')?.getAttribute("data-replay-error") || "",
      canvasCount: document.querySelectorAll("canvas").length,
      text: (document.body?.innerText || "").slice(0, 500),
    })`);
    assert(disabledReplay.error === "REPLAY_DISABLED" && disabledReplay.canvasCount === 0, "open replay page did not fail closed", disabledReplay);
    await wait(300);
    const replayStreamsAfterDisabledDocument = replayCapture.webSockets.filter((url) => /\/api\/v1\/stream\/replay\//.test(url)).length;
    assert(replayStreamsAfterDisabledDocument === replayStreamsBeforeDisabledDocument, "disabled replay document opened a replay WebSocket", replayCapture.webSockets);
    const digestWhileDisabled = replayDatabaseDigest(paths.replay);
    assert(sameDigest(digestAfterGracefulShutdown, digestWhileDisabled), "disabled backend changed replay database bytes", { digestAfterGracefulShutdown, digestWhileDisabled });

    const currentKlines = await readJson(`${currentBackendOrigin}/api/v1/klines/?symbol=BTCUSDT&interval=1m&limit=10&exchange=binance&market_type=spot`);
    const currentSettings = await readJson(`${currentBackendOrigin}/api/v1/settings/proxy`);
    assert(currentKlines?.count > 0 && Array.isArray(currentKlines?.data), "disabled current build broke live K-lines", currentKlines);
    assert(currentSettings?.mode === "none", "disabled current build broke settings", currentSettings);
    await gracefulStopBackend(currentBackendOrigin, disabledBackend.child, args.timeoutMs);
    await stopProcessTree(disabledVite.child);
    const digestAfterDisabledShutdown = replayDatabaseDigest(paths.replay);
    assert(sameDigest(digestAfterGracefulShutdown, digestAfterDisabledShutdown), "disabled restart changed replay database", { digestAfterGracefulShutdown, digestAfterDisabledShutdown });

    runSync("git", ["worktree", "add", "--detach", oldWorktree, baselineCommit]);
    oldWorktreeAdded = true;
    const oldFrontendRoot = path.join(oldWorktree, "frontend");
    const oldBackendRoot = path.join(oldWorktree, "backend");
    const oldNodeModules = path.join(oldFrontendRoot, "node_modules");
    const currentNodeModules = path.join(frontendRoot, "node_modules");
    const dependencySentinelBefore = fileHash(path.join(currentNodeModules, "vite", "package.json"));
    fs.symlinkSync(currentNodeModules, oldNodeModules, "junction");
    oldNodeModulesLinked = true;
    assert(fs.lstatSync(oldNodeModules).isSymbolicLink(), "old build node_modules is not a junction");

    const [oldBackendPort, oldFrontendPort] = await Promise.all([freePort(), freePort()]);
    const oldBackendOrigin = `http://127.0.0.1:${oldBackendPort}`;
    const oldFrontendOrigin = `http://127.0.0.1:${oldFrontendPort}`;
    const oldBackend = trackProcess(
      "baseline-backend",
      startBackend({ python, root: oldBackendRoot, port: oldBackendPort, enabled: true, paths, baseline: true }),
    );
    await waitForHttp(`${oldBackendOrigin}/__replay_smoke__/fixture`, oldBackend.child, args.timeoutMs);
    const oldVite = trackProcess(
      "baseline-vite",
      startVite({ root: oldFrontendRoot, port: oldFrontendPort, backendPort: oldBackendPort, entryEnabled: true }),
    );
    await waitForHttp(`${oldFrontendOrigin}/`, oldVite.child, args.timeoutMs);

    const oldKlines = await readJson(`${oldBackendOrigin}/api/v1/klines/?symbol=BTCUSDT&interval=1m&limit=10&exchange=binance&market_type=spot`);
    const oldSettings = await readJson(`${oldBackendOrigin}/api/v1/settings/proxy`);
    const oldReplayRoute = await request(`${oldBackendOrigin}/api/v1/replay/capabilities`);
    assert(oldKlines?.count > 0 && Array.isArray(oldKlines?.data), "old build failed to serve K-lines", oldKlines);
    assert(oldSettings?.mode === "none", "old build failed to load settings", oldSettings);
    assert(oldReplayRoute.status === 404, "old backend unexpectedly mounted replay routes", oldReplayRoute);

    const oldLive = await createTarget(debugBase);
    connections.push(oldLive.cdp);
    const oldLiveCapture = trackBrowser("baseline-live", oldLive.cdp);
    await oldLive.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("candlescope-user-prefs", ${JSON.stringify(preferences)}); } catch {}`,
    });
    await oldLive.cdp.send("Page.navigate", { url: `${oldFrontendOrigin}/` });
    await waitForLiveReady(oldLive.cdp, args.timeoutMs);
    const oldLiveSnapshot = await liveSnapshot(oldLive.cdp);
    assert(oldLiveSnapshot.bars > 0 && oldLiveSnapshot.canvasCount > 0, "old build live chart was unhealthy", oldLiveSnapshot);
    assert(oldLiveSnapshot.symbol === liveBefore.symbol && oldLiveSnapshot.interval === liveBefore.interval, "old build changed live identity", { liveBefore, oldLiveSnapshot });
    assert(oldLiveSnapshot.anyReplayEntry === false, "old frontend exposed a replay entry", oldLiveSnapshot);
    assert(oldLiveCapture.exceptions.length === 0, "old live target raised runtime exceptions", oldLiveCapture.exceptions);
    assert(!oldLiveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)), "old live target opened replay WebSocket", oldLiveCapture.webSockets);

    const digestWhileOldBuildRuns = replayDatabaseDigest(paths.replay);
    assert(sameDigest(digestAfterGracefulShutdown, digestWhileOldBuildRuns), "old build changed replay database while running", { digestAfterGracefulShutdown, digestWhileOldBuildRuns });
    await gracefulStopBackend(oldBackendOrigin, oldBackend.child, args.timeoutMs);
    await stopProcessTree(oldVite.child);
    const digestAfterOldBuild = replayDatabaseDigest(paths.replay);
    assert(sameDigest(digestAfterGracefulShutdown, digestAfterOldBuild), "old build changed replay database after shutdown", { digestAfterGracefulShutdown, digestAfterOldBuild });
    const dependencySentinelAfter = fileHash(path.join(currentNodeModules, "vite", "package.json"));
    assert(dependencySentinelAfter === dependencySentinelBefore, "old build changed the shared Vite dependency sentinel");

    const checks = {
      active_session_was_playing: progressed.state === "PLAYING" && progressed.sourceSequence > playing.sourceSequence,
      graceful_shutdown_persisted_paused: persisted.state === "PAUSED" && persisted.status_reason === "shutdown_pause",
      disabled_capability_closed: disabledCapabilities.enabled === false && disabledCapabilities.persistence.opened === false,
      disabled_entry_hidden: liveAfterDisable.anyReplayEntry === false,
      open_replay_failed_closed: disabledReplay.error === "REPLAY_DISABLED" && disabledReplay.canvasCount === 0,
      live_identity_preserved: liveAfterDisable.symbol === liveBefore.symbol && liveAfterDisable.interval === liveBefore.interval && liveAfterDisable.prefs === liveBefore.prefs,
      live_data_and_settings_preserved: currentKlines.count > 0 && currentSettings.mode === "none",
      disabled_restart_preserved_replay_db: sameDigest(digestAfterGracefulShutdown, digestAfterDisabledShutdown),
      old_backend_ignored_replay_route: oldReplayRoute.status === 404,
      old_frontend_ignored_replay_entry: oldLiveSnapshot.anyReplayEntry === false,
      old_live_data_and_settings_healthy: oldKlines.count > 0 && oldSettings.mode === "none" && oldLiveSnapshot.bars > 0,
      old_build_preserved_replay_db: sameDigest(digestAfterGracefulShutdown, digestAfterOldBuild),
      browser_runtime_clean: liveCapture.exceptions.length === 0 && oldLiveCapture.exceptions.length === 0,
    };
    assert(Object.values(checks).every(Boolean), "rollback acceptance failed", checks);

    result = {
      schema_version: "replay-v1-rollback-drill.v1",
      recorded_at: releaseEvidence.recorded_at,
      release_evidence: releaseEvidence.evidence,
      passed: true,
      configuration: {
        currentCommit,
        baselineCommit,
        replayDbRetained: true,
        isolatedFixtureRows: 4_000,
      },
      featureFlagRollback: {
        enabled: { liveBefore, initial, playing, progressed, sessionId, persisted },
        disabled: {
          capabilities: disabledCapabilities,
          liveAfter: liveAfterDisable,
          replayPage: disabledReplay,
          transitionRejectedReplaySocketAttempts,
          replayStreamsAfterDisabledDocument,
          klines: { count: currentKlines.count, source: currentKlines.source },
          settings: { mode: currentSettings.mode },
        },
        replayDatabase: {
          afterGracefulShutdown: digestAfterGracefulShutdown,
          whileDisabled: digestWhileDisabled,
          afterDisabledShutdown: digestAfterDisabledShutdown,
        },
      },
      oldBuildRollback: {
        commit: baselineCommit,
        replayCapabilitiesStatus: oldReplayRoute.status,
        live: oldLiveSnapshot,
        klines: { count: oldKlines.count, source: oldKlines.source },
        settings: { mode: oldSettings.mode },
        replayDatabase: {
          whileRunning: digestWhileOldBuildRuns,
          afterShutdown: digestAfterOldBuild,
        },
      },
      acceptance: { passed: true, checks },
    };
    writeJson(args.out, result);
    if (fs.existsSync(`${args.out}.failed.json`)) fs.rmSync(`${args.out}.failed.json`, { force: true });
    console.log(JSON.stringify({
      passed: true,
      out: args.out,
      baselineCommit,
      pausedReason: persisted.status_reason,
      replayDbSha256: digestAfterGracefulShutdown.sha256,
      oldReplayRouteStatus: oldReplayRoute.status,
    }, null, 2));
  } catch (error) {
    failure = error;
    const browserTargets = await Promise.all(browserCaptures.map(async ({ label, cdp, capture }) => ({
      label,
      capture,
      page: await browserDiagnostic(cdp).catch((diagnosticError) => ({
        diagnosticError: diagnosticError?.message || String(diagnosticError),
      })),
    })));
    writeJson(`${args.out}.failed.json`, {
      schema_version: "replay-v1-rollback-drill-failure.v1",
      recorded_at: releaseEvidence.recorded_at,
      release_evidence: releaseEvidence.evidence,
      passed: false,
      error: error.stack || error.message || String(error),
      processTails: processRecords.map(({ label, child, tail }) => ({
        label,
        pid: child.pid,
        exitCode: child.exitCode,
        tail: tail(),
      })),
      browserTargets,
      chromeTail: chromeTail(),
    });
  } finally {
    for (const connection of connections) connection.close();
    await Promise.all(processes.map((child) => stopProcessTree(child)));
    await stopProcessTree(chrome);
    if (oldNodeModulesLinked) {
      const oldNodeModules = path.join(oldWorktree, "frontend", "node_modules");
      if (fs.existsSync(oldNodeModules)) {
        assert(fs.lstatSync(oldNodeModules).isSymbolicLink(), "refusing to remove a non-junction old node_modules", { oldNodeModules });
        fs.unlinkSync(oldNodeModules);
      }
    }
    if (oldWorktreeAdded) {
      runSync("git", ["worktree", "remove", "--force", oldWorktree]);
      runSync("git", ["worktree", "prune"]);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (failure) throw failure;
  return result;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
