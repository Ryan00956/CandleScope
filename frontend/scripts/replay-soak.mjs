import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { freeHarnessPort } from "./replay-harness-port.mjs";
import { captureReplayReleaseEvidence } from "./replay-release-evidence.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const frontendRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = path.join(repositoryRoot, "backend");
const RELEASE_DURATION_MS = 4 * 60 * 60 * 1_000;
const RELEASE_CYCLES = 100;
const RELEASE_PROJECTION_EVENTS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_ITEMS = 10_000;
const MAX_CAPTURE_RESPONSE_BODIES = 100;
const MIB = 1024 * 1024;

function parseArgs(argv) {
  const defaultV1Output = path.join(repositoryRoot, "docs", "perf-baselines", "replay-v1-browser-soak-20260718.json");
  const result = {
    allowShort: false,
    chromePath: process.env.CHROME_PATH || "",
    cycles: RELEASE_CYCLES,
    diagnosticGapSteps: 0,
    durationMs: RELEASE_DURATION_MS,
    headed: false,
    out: defaultV1Output,
    productV2: false,
    projectionEvents: RELEASE_PROJECTION_EVENTS,
    realKlinesSource: process.env.REPLAY_REAL_KLINES_SOURCE
      ? path.resolve(process.env.REPLAY_REAL_KLINES_SOURCE)
      : "",
    sampleMs: 60_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-short") result.allowShort = true;
    else if (value === "--headed") result.headed = true;
    else if (value === "--product-v2") result.productV2 = true;
    else if (value === "--chrome-path") result.chromePath = String(argv[++index] || "");
    else if (value === "--cycles") result.cycles = Number(argv[++index]);
    else if (value === "--diagnostic-gap-steps") result.diagnosticGapSteps = Number(argv[++index]);
    else if (value === "--duration-ms") result.durationMs = Number(argv[++index]);
    else if (value === "--out") result.out = path.resolve(String(argv[++index] || ""));
    else if (value === "--projection-events") result.projectionEvents = Number(argv[++index]);
    else if (value === "--real-klines-source") result.realKlinesSource = path.resolve(String(argv[++index] || ""));
    else if (value === "--sample-ms") result.sampleMs = Number(argv[++index]);
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown replay soak option: ${value}`);
  }
  if (result.productV2 && result.out === defaultV1Output) {
    result.out = path.join(repositoryRoot, "docs", "perf-baselines", "replay-v2-browser-soak-20260722.json");
  }
  for (const [name, value, minimum] of [
    ["--duration-ms", result.durationMs, 10_000],
    ["--cycles", result.cycles, 1],
    ["--diagnostic-gap-steps", result.diagnosticGapSteps, 0],
    ["--projection-events", result.projectionEvents, 1],
    ["--sample-ms", result.sampleMs, 1_000],
    ["--timeout-ms", result.timeoutMs, 5_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer >= ${minimum}`);
    }
  }
  if (!result.allowShort && (
    result.durationMs < RELEASE_DURATION_MS
    || result.cycles < RELEASE_CYCLES
    || result.projectionEvents < RELEASE_PROJECTION_EVENTS
  )) {
    throw new Error("Release soak requires >=4h, >=100 lifecycle cycles, and >=1,000,000 browser projection events; use --allow-short only for harness validation");
  }
  if (!result.allowShort && result.diagnosticGapSteps > 0) {
    throw new Error("--diagnostic-gap-steps is available only with --allow-short");
  }
  if (
    result.realKlinesSource
    && (
      !fs.existsSync(result.realKlinesSource)
      || !fs.statSync(result.realKlinesSource).isFile()
    )
  ) {
    throw new Error("--real-klines-source must point to an existing SQLite file");
  }
  if (!result.allowShort && result.productV2 && !result.realKlinesSource) {
    throw new Error("Phase 18 replay.v2 release soak requires --real-klines-source");
  }
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const code =
      body && typeof body === "object" && typeof body.error?.code === "string"
        ? ` (${body.error.code})`
        : "";
    const error = new Error(
      `${response.status} ${response.statusText}${code}: ${url}`,
    );
    error.status = response.status;
    error.responseBody = body;
    error.url = url;
    throw error;
  }
  return body;
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

function processTail(child, maxLines = 120, patterns = {}) {
  const lines = [];
  const counts = Object.fromEntries(Object.keys(patterns).map((name) => [name, 0]));
  const append = (chunk) => {
    const text = String(chunk);
    lines.push(...text.split(/\r?\n/).filter(Boolean));
    for (const [name, pattern] of Object.entries(patterns)) {
      counts[name] += text.match(pattern)?.length ?? 0;
    }
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const snapshot = () => [...lines];
  snapshot.counts = () => ({ ...counts });
  return snapshot;
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

async function stopBackendGracefully(child, backendOrigin) {
  if (!child || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  try {
    const response = await fetch(`${backendOrigin}/__replay_smoke__/shutdown`, { method: "POST" });
    if (!response.ok) return;
    if (child.exitCode !== null) return;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      wait(15_000),
    ]);
  } catch {
    // The exact fixture process is force-stopped below if graceful shutdown is unavailable.
  }
}

function boundedPush(items, value, maximum = MAX_CAPTURE_ITEMS) {
  items.push(value);
  if (items.length > maximum) items.splice(0, items.length - maximum);
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
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
    cdp.send("HeapProfiler.enable"),
  ]);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
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
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      value = await evaluate(cdp, expression);
      if (value) return value;
      lastError = null;
    } catch (error) {
      // Navigation replaces the execution context. Preserve the final error so
      // a genuinely dead target is distinguishable from a not-yet-ready DOM.
      lastError = error?.message || String(error);
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}; last value=${JSON.stringify(value)}; last error=${JSON.stringify(lastError)}`);
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

async function clickButtonByText(cdp, text, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const clicked = await evaluate(cdp, `(() => {
        const element = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
        if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
        element.click();
        return true;
      })()`, { userGesture: true });
      if (clicked) return;
    } catch { /* the report surface may be replaced by an authoritative refresh */ }
    await wait(100);
  }
  throw new Error(`Cannot click button text ${text}`);
}

async function pressKey(cdp, key, { shift = false } = {}) {
  const keyMap = {
    " ": { code: "Space", windowsVirtualKeyCode: 32 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  };
  const identity = keyMap[key];
  assert(identity, `Unsupported keyboard audit key: ${key}`);
  const modifiers = shift ? 8 : 0;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: identity.code,
    modifiers,
    windowsVirtualKeyCode: identity.windowsVirtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: identity.code,
    modifiers,
    windowsVirtualKeyCode: identity.windowsVirtualKeyCode,
  });
}

async function keyboardActivateButton(cdp, { action = null, text: buttonText = null }, timeoutMs) {
  await evaluate(cdp, `(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  })()`);
  const started = Date.now();
  let tabs = 0;
  while (Date.now() - started < timeoutMs && tabs <= 160) {
    const active = await evaluate(cdp, `(() => {
      const item = document.activeElement;
      return item instanceof HTMLButtonElement ? {
        action: item.dataset.replayAction || null,
        disabled: item.disabled,
        text: item.textContent?.trim() || "",
      } : null;
    })()`);
    if (active && !active.disabled
      && (action === null || active.action === action)
      && (buttonText === null || active.text === buttonText)) {
      // Space activates a focused native button on key-up. Unlike Enter, it
      // does not require a text/char CDP event to reach Chromium's default
      // button activation path, so this remains a real trusted keyboard input.
      await pressKey(cdp, " ");
      return { tabs, key: "Space", active };
    }
    await pressKey(cdp, "Tab");
    tabs += 1;
  }
  throw new Error(`Keyboard traversal could not activate button: ${JSON.stringify({ action, text: buttonText, tabs })}`);
}

function captureTarget(cdp, { auditReplayBoundaries = false } = {}) {
  const responseByRequest = new Map();
  const bodyTasks = new Set();
  const boundaryAudits = auditReplayBoundaries
    ? {
        http: createStreamingBoundaryAudit("http"),
        websocket: createStreamingBoundaryAudit("websocket"),
      }
    : null;
  const capture = {
    boundaryAudits,
    requestCount: 0,
    requests: [],
    responseBodies: [],
    responseCount: 0,
    responses: [],
    webSocketCount: 0,
    webSockets: [],
    webSocketFramesReceived: [],
    webSocketFramesSent: [],
    exceptions: [],
    consoleErrors: [],
    failedRequests: [],
    async settle() {
      await Promise.allSettled([...bodyTasks]);
    },
  };
  cdp.on("Network.requestWillBeSent", (event) => {
    capture.requestCount += 1;
    const item = {
      method: event.request?.method || "",
      postData: event.request?.postData || "",
      url: event.request?.url || "",
    };
    boundedPush(capture.requests, item);
    if (boundaryAudits && /\/api\/v1\/replay(?:\/|\?|$)/.test(item.url)) {
      boundaryAudits.http.add({ kind: "request", ...item });
    }
  });
  cdp.on("Network.responseReceived", (event) => {
    const item = { url: event.response?.url || "", status: event.response?.status || 0 };
    capture.responseCount += 1;
    boundedPush(capture.responses, item);
    if (/\/api\/v1\/replay(?:\/|\?|$)/.test(item.url)) responseByRequest.set(event.requestId, item.url);
  });
  cdp.on("Network.loadingFinished", (event) => {
    const url = responseByRequest.get(event.requestId);
    if (!url) return;
    responseByRequest.delete(event.requestId);
    const task = cdp.send("Network.getResponseBody", { requestId: event.requestId })
      .then((result) => {
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body;
        const item = { url, body };
        boundaryAudits?.http.add({ kind: "response", ...item });
        boundedPush(capture.responseBodies, item, MAX_CAPTURE_RESPONSE_BODIES);
      })
      .catch(() => undefined)
      .finally(() => bodyTasks.delete(task));
    bodyTasks.add(task);
  });
  cdp.on("Network.loadingFailed", (event) => {
    boundedPush(capture.failedRequests, {
      requestId: event.requestId || "",
      errorText: event.errorText || "",
      canceled: event.canceled === true,
      blockedReason: event.blockedReason || "",
    });
  });
  cdp.on("Network.webSocketCreated", (event) => {
    capture.webSocketCount += 1;
    boundedPush(capture.webSockets, event.url || "");
  });
  cdp.on("Network.webSocketFrameReceived", (event) => {
    const payload = event.response?.payloadData || "";
    boundaryAudits?.websocket.add({ direction: "received", payload });
    boundedPush(capture.webSocketFramesReceived, payload);
  });
  cdp.on("Network.webSocketFrameSent", (event) => {
    const payload = event.response?.payloadData || "";
    boundaryAudits?.websocket.add({ direction: "sent", payload });
    boundedPush(capture.webSocketFramesSent, payload);
  });
  cdp.on("Runtime.exceptionThrown", (event) => {
    boundedPush(capture.exceptions, event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "exception");
  });
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") {
      const args = (event.args || []).map((item) => ({
        type: item.type || "",
        value: item.value ?? null,
        description: item.description || "",
      }));
      boundedPush(capture.consoleErrors, {
        message: args.map((item) => item.value ?? item.description).filter(Boolean).join(" ") || "console error",
        arguments: args,
        stack: (event.stackTrace?.callFrames || []).slice(0, 30).map((frame) => ({
          functionName: frame.functionName || "",
          url: frame.url || "",
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        })),
      });
    }
  });
  return capture;
}

function assert(condition, message, detail = undefined) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function replayStatus(cdp) {
  return evaluate(cdp, `(() => {
    const status = document.querySelector('#replay-status-bar, #status-bar[data-runtime-source="replay"]');
    if (!(status instanceof HTMLElement)) return null;
    return {
      connection: status.dataset.replayConnection || status.dataset.connectionStatus,
      generation: Number(status.dataset.replayGeneration || 0),
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) (?:display )?bars/) || [])[1] || 0),
    };
  })()`);
}

async function waitForReplayStatus(cdp, predicateSource, timeoutMs, label) {
  return waitForValue(cdp, `(() => {
    const status = document.querySelector('#replay-status-bar, #status-bar[data-runtime-source="replay"]');
    if (!(status instanceof HTMLElement)) return null;
    const value = {
      connection: status.dataset.replayConnection || status.dataset.connectionStatus,
      generation: Number(status.dataset.replayGeneration || 0),
      state: status.dataset.replaySessionState,
      sourceSequence: Number(status.dataset.replaySourceSequence || 0),
      revision: Number(status.dataset.replayRevision || 0),
      stateHash: status.dataset.replayStateHash || "",
      cursorMs: Number(status.dataset.replayCursorMs || 0),
      maxBarMs: Number(status.dataset.replayMaxBarMs || 0),
      orderCount: Number(status.dataset.replayOrderCount || 0),
      fillCount: Number(status.dataset.replayFillCount || 0),
      revealed: status.dataset.replayRevealed,
      bars: Number((status.innerText.match(/([0-9]+) (?:display )?bars/) || [])[1] || 0),
    };
    return (${predicateSource})(value) ? value : null;
  })()`, timeoutMs, label);
}

function isAuthoritativeReplayStatus(value) {
  return value !== null
    && typeof value === "object"
    && value.connection === "connected"
    && typeof value.stateHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(value.stateHash)
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && Number.isSafeInteger(value.sourceSequence)
    && value.sourceSequence >= 0;
}

async function waitForAuthoritativeReplayStatus(cdp, predicateSource, timeoutMs, label) {
  const authoritative = isAuthoritativeReplayStatus.toString();
  return waitForReplayStatus(
    cdp,
    `(value) => (${authoritative})(value) && (${predicateSource})(value)`,
    timeoutMs,
    label,
  );
}

export function replayStepAction(productV2 = false) {
  return productV2 ? "advance-display" : "step";
}

export function replaySpeedAction(productV2 = false) {
  return productV2 ? "playback-rate" : "speed";
}

async function waitForCommandReady(cdp, timeoutMs, productV2 = false) {
  const action = replayStepAction(productV2);
  return waitForValue(cdp, `(() => {
    const button = document.querySelector('[data-replay-action="${action}"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, timeoutMs, "replay command readiness");
}

async function restoreCommandReadinessAfterReconnect(cdp, timeoutMs, productV2 = false) {
  const action = replayStepAction(productV2);
  const recovery = await waitForValue(cdp, `(() => {
    const command = document.querySelector('[data-replay-action="${action}"]');
    if (command instanceof HTMLButtonElement && !command.disabled) return "ready";
    const takeover = document.querySelector('[data-replay-action="takeover-controller"]');
    if (takeover instanceof HTMLButtonElement && !takeover.disabled) return "takeover";
    return null;
  })()`, timeoutMs, "replay reconnect command or takeover readiness");
  if (recovery === "takeover") {
    await click(cdp, '[data-replay-action="takeover-controller"]');
  }
  await waitForCommandReady(cdp, timeoutMs, productV2);
  return recovery;
}

async function restoreTrainingPlaybackAtCycleStart(cdp, timeoutMs, productV2 = false) {
  const recovery = await waitForValue(cdp, `(() => {
    const pause = document.querySelector('[data-replay-action="pause"]');
    if (pause instanceof HTMLButtonElement && !pause.disabled) return "playing";
    const play = document.querySelector('[data-replay-action="play"]');
    if (play instanceof HTMLButtonElement && !play.disabled) return "paused";
    const takeover = document.querySelector('[data-replay-action="takeover-controller"]');
    if (takeover instanceof HTMLButtonElement && !takeover.disabled) return "takeover";
    return null;
  })()`, timeoutMs, "training cycle playback or controller recovery readiness");
  if (recovery === "takeover") {
    await click(cdp, '[data-replay-action="takeover-controller"]');
    await waitForCommandReady(cdp, timeoutMs, productV2);
  }
  const status = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.state === "PAUSED" || value.state === "PLAYING"`,
    timeoutMs,
    "authoritative training cycle recovered state",
  );
  if (status.state === "PAUSED") {
    await click(cdp, '[data-replay-action="play"]');
  }
  const playing = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.state === "PLAYING"`,
    timeoutMs,
    "authoritative training cycle start",
  );
  await waitForValue(cdp, `(() => {
    const pause = document.querySelector('[data-replay-action="pause"]');
    return pause instanceof HTMLButtonElement && !pause.disabled;
  })()`, timeoutMs, "training cycle pause readiness");
  return { recovery, status: playing };
}

async function trainingActionCycle({ cdp, backendOrigin, sessionId, diagnosticGapSteps, index, productV2, timeoutMs }) {
  const cycleStart = await restoreTrainingPlaybackAtCycleStart(cdp, timeoutMs, productV2);
  const before = cycleStart.status;
  await click(cdp, '[data-replay-action="pause"]');
  const paused = await waitForAuthoritativeReplayStatus(cdp, `(value) => value.state === "PAUSED"`, timeoutMs, "training pause ack");
  await wait(250);
  const pauseStable = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.state === "PAUSED" && value.revision >= ${paused.revision}`,
    timeoutMs,
    "authoritative training pause stability snapshot",
  );
  assert(pauseStable.sourceSequence === paused.sourceSequence, "training cursor advanced after pause ack", { paused, pauseStable });

  const targetSpeed = [60, 120, 300, 600][index % 4];
  const speedAction = replaySpeedAction(productV2);
  const speedChanged = await evaluate(cdp, `(() => {
    const select = document.querySelector('[data-replay-action="${speedAction}"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = "${targetSpeed}";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(speedChanged, "training speed control was unavailable", { index, targetSpeed });
  const accelerated = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.revision > ${paused.revision}`,
    timeoutMs,
    "training speed ack",
  );
  await waitForCommandReady(cdp, timeoutMs, productV2);

  const side = index % 2 === 0 ? "BUY" : "SELL";
  const sideChanged = await evaluate(cdp, `(() => {
    const ticket = document.querySelector('.replay-order-ticket');
    const button = [...(ticket?.querySelectorAll('button') || [])].find((item) => item.textContent?.trim() === "${side}");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(sideChanged, "training order side control was unavailable", { index, side });
  const beforeOrder = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.state === "PAUSED"`,
    timeoutMs,
    "authoritative pre-order snapshot",
  );
  await click(cdp, '[data-replay-action="place-order"]');
  const ordered = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.orderCount > ${beforeOrder.orderCount}`,
    timeoutMs,
    "training market order ack",
  );
  const immediatelyFilled = productV2
    ? await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.fillCount > ${beforeOrder.fillCount}`,
      timeoutMs,
      "training immediate v2 market fill",
    )
    : null;
  await waitForCommandReady(cdp, timeoutMs, productV2);
  await click(cdp, '[data-replay-action="play"]');
  await waitForAuthoritativeReplayStatus(cdp, `(value) => value.state === "PLAYING"`, timeoutMs, "accelerated play ack");
  const filled = productV2
    ? await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.sourceSequence > ${ordered.sourceSequence}`,
      timeoutMs,
      "training v2 post-fill progress",
    )
    : await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.sourceSequence > ${ordered.sourceSequence} && value.fillCount > ${ordered.fillCount}`,
      timeoutMs,
      "training market fill",
    );
  await click(cdp, '[data-replay-action="pause"]');
  const filledPaused = await waitForAuthoritativeReplayStatus(cdp, `(value) => value.state === "PAUSED"`, timeoutMs, "post-fill pause ack");
  await wait(250);
  const filledPauseStable = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.state === "PAUSED" && value.revision >= ${filledPaused.revision}`,
    timeoutMs,
    "authoritative post-fill pause stability snapshot",
  );
  assert(
    filledPauseStable.sourceSequence === filledPaused.sourceSequence,
    "training cursor advanced after post-fill pause ack",
    { filledPaused, filledPauseStable },
  );

  let adapterRecovery = null;
  if (productV2) {
    const evicted = await readJson(
      `${backendOrigin}/__replay_smoke__/evict-replay-adapter/${encodeURIComponent(sessionId)}`,
      { method: "POST" },
    );
    assert(
      evicted.evicted === true
        && evicted.session_id === sessionId
        && Number.isSafeInteger(evicted.release_attempts)
        && evicted.release_attempts >= 1
        && evicted.sessions_evicted_after === evicted.sessions_evicted_before + 1,
      "primary replay adapter eviction was not recorded",
      evicted,
    );
    const recovered = await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.state === "PAUSED" && value.generation > ${filledPauseStable.generation} && value.sourceSequence >= ${filledPauseStable.sourceSequence}`,
      timeoutMs,
      "authoritative primary adapter recovery",
    );
    const readiness = await restoreCommandReadinessAfterReconnect(cdp, timeoutMs, productV2);
    adapterRecovery = { evicted, recovered, readiness };
  }

  let gapStatus = adapterRecovery?.recovered ?? filledPauseStable;
  for (let stepIndex = 0; stepIndex < diagnosticGapSteps; stepIndex += 1) {
    await waitForCommandReady(cdp, timeoutMs, productV2);
    const beforeGapStep = await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.state === "PAUSED"`,
      timeoutMs,
      "authoritative pre-gap-step snapshot",
    );
    await click(cdp, `[data-replay-action="${replayStepAction(productV2)}"]`);
    gapStatus = await waitForAuthoritativeReplayStatus(
      cdp,
      `(value) => value.sourceSequence > ${beforeGapStep.sourceSequence}`,
      timeoutMs,
      "diagnostic gap step",
    );
  }

  const normalSpeedChanged = await evaluate(cdp, `(() => {
    const select = document.querySelector('[data-replay-action="${speedAction}"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(normalSpeedChanged, "training speed reset control was unavailable", { index });
  const normalSpeed = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.revision > ${gapStatus.revision}`,
    timeoutMs,
    "training speed reset ack",
  );
  await waitForCommandReady(cdp, timeoutMs, productV2);

  const disconnectRequest = readJson(
    `${backendOrigin}/__replay_smoke__/disconnect-replay/${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  );
  await waitForReplayStatus(
    cdp,
    `(value) => value.connection === "reconnecting" || value.connection === "resyncing"`,
    timeoutMs,
    "training replay disconnect feedback",
  );
  await disconnectRequest;
  const reconnected = await waitForAuthoritativeReplayStatus(
    cdp,
    `(value) => value.connection === "connected" && value.sourceSequence >= ${normalSpeed.sourceSequence}`,
    timeoutMs,
    "training replay reconnect convergence",
  );
  const reconnectRecovery = await restoreCommandReadinessAfterReconnect(cdp, timeoutMs, productV2);
  await click(cdp, '[data-replay-action="play"]');
  const resumed = await waitForAuthoritativeReplayStatus(cdp, `(value) => value.state === "PLAYING"`, timeoutMs, "training resume ack");
  return {
    targetSpeed,
    side,
    cycleStart,
    before,
    paused,
    pauseStable,
    accelerated,
    ordered,
    immediatelyFilled,
    filled,
    filledPaused,
    filledPauseStable,
    adapterRecovery,
    diagnosticGapSteps,
    gapStatus,
    normalSpeed,
    reconnected,
    reconnectRecovery,
    resumed,
  };
}

function replayV2Command(runId, commandId, session, type, payload = {}) {
  const snapshot = session?.snapshot;
  const cursor = snapshot?.cursor;
  assert(snapshot && cursor, "v2 lifecycle session snapshot is missing", session);
  return {
    protocol: "replay.v2",
    run_id: runId,
    command_id: commandId,
    client_instance_id: "phase10-browser-soak",
    expected_revision: snapshot.revision,
    expected_cursor: {
      virtual_time_ms: cursor.virtual_time_ms,
      source_sequence: cursor.source_sequence,
      revision: snapshot.revision,
    },
    type,
    payload,
  };
}

async function postJson(url, payload = undefined) {
  return readJson(url, {
    method: "POST",
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function isCatalogEpochMismatch(error) {
  return (
    error?.status === 409
    && error?.responseBody?.error?.code === "CATALOG_EPOCH_MISMATCH"
  );
}

async function createV2ArchiveRun({
  backendOrigin,
  createPayload,
  index,
  requestJson = readJson,
}) {
  const catalogQuery = new URLSearchParams({
    warmup_bars: String(createPayload.warmup_bars),
    horizon_ms: String(createPayload.forward_cache_ms),
    quality_mode: "exact",
    blind_mode: String(createPayload.time_disclosure_policy !== "NONE"),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const catalog = await requestJson(
      `${backendOrigin}/api/v1/replay/catalog?${catalogQuery}`,
    );
    const catalogEntry = catalog?.entries?.find((entry) => (
      entry.identity?.exchange === createPayload.exchange
      && entry.identity?.market_type === createPayload.market_type
      && entry.identity?.symbol === createPayload.symbol
      && entry.selected_base_interval === createPayload.base_interval
    ));
    assert(
      catalogEntry && typeof catalog.catalog_epoch === "string",
      "v2 lifecycle catalog no longer contains the exact create identity",
      catalog,
    );
    const request = {
      ...createPayload,
      catalog_epoch: catalog.catalog_epoch,
      name: `Phase 10 lifecycle ${String(index + 1).padStart(3, "0")}`,
      random_seed:
        (Number(createPayload.random_seed || 0) + index + 1)
        % 2_147_483_647,
    };
    try {
      const created = await requestJson(
        `${backendOrigin}/api/v1/replay/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      return {
        created,
        catalogEpoch: catalog.catalog_epoch,
        catalogEpochRefreshes: attempt,
      };
    } catch (error) {
      if (attempt === 0 && isCatalogEpochMismatch(error)) continue;
      throw error;
    }
  }
  throw new Error("v2 lifecycle catalog refresh exhausted without a result");
}

async function v2ArchiveLifecycleCycle({ backendOrigin, createPayload, index }) {
  const {
    created,
    catalogEpoch,
    catalogEpochRefreshes,
  } = await createV2ArchiveRun({ backendOrigin, createPayload, index });
  const runId = created?.run?.run_id;
  const sessionId = created?.run?.adapter_session_id;
  assert(typeof runId === "string" && typeof sessionId === "string", "v2 lifecycle create did not return identities", created);

  const returned = await postJson(
    `${backendOrigin}/api/v1/replay/runs/session/${encodeURIComponent(sessionId)}/return-to-hub`,
  );
  assert(returned?.state === "PAUSED" && returned?.checkpointed === true && returned?.released === true, "v2 lifecycle return-to-hub failed", returned);

  const resumed = await readJson(`${backendOrigin}/api/v1/replay/sessions/${encodeURIComponent(sessionId)}`);
  assert(resumed?.snapshot?.state === "PAUSED", "v2 lifecycle resume did not restore PAUSED", resumed);
  const acquired = await postJson(
    `${backendOrigin}/api/v1/replay/runs/${encodeURIComponent(runId)}/commands`,
    replayV2Command(runId, `phase10-acquire-${index + 1}`, resumed, "acquire_controller", { takeover: false }),
  );
  assert(acquired?.state === "PAUSED", "v2 lifecycle acquire changed the paused state", acquired);

  const acquiredSession = await readJson(`${backendOrigin}/api/v1/replay/sessions/${encodeURIComponent(sessionId)}`);
  const ended = await postJson(
    `${backendOrigin}/api/v1/replay/runs/${encodeURIComponent(runId)}/commands`,
    replayV2Command(runId, `phase10-end-${index + 1}`, acquiredSession, "end", {
      open_order_disposition: "expire",
      position_disposition: "keep",
    }),
  );
  assert(ended?.state === "ENDED", "v2 lifecycle end did not persist ENDED", ended);

  const beforeReview = await readJson(`${backendOrigin}/api/v1/replay/sessions/${encodeURIComponent(sessionId)}`);
  const report = await readJson(`${backendOrigin}/api/v1/replay/runs/${encodeURIComponent(runId)}/report`);
  const review = await postJson(`${backendOrigin}/api/v1/replay/runs/${encodeURIComponent(runId)}/review`, {});
  const afterReview = await readJson(`${backendOrigin}/api/v1/replay/sessions/${encodeURIComponent(sessionId)}`);
  const beforeStateHash = beforeReview?.snapshot?.state_hash;
  const afterStateHash = afterReview?.snapshot?.state_hash;
  assert(review?.read_only === true && typeof review?.selected_event_id === "string", "v2 lifecycle review is not read-only", review);
  assert(typeof beforeStateHash === "string" && beforeStateHash.startsWith("sha256:"), "v2 lifecycle session state hash is missing", beforeReview);
  assert(beforeStateHash === afterStateHash, "v2 lifecycle review mutated the original session state hash", {
    before: beforeStateHash,
    after: afterStateHash,
  });
  assert(typeof review.original_state_hash === "string" && review.original_state_hash.startsWith("sha256:"), "v2 review original state hash is missing", review);
  assert(report?.run_id === runId || report?.report?.run_id === runId, "v2 lifecycle report identity drifted", report);
  return {
    runId,
    sessionId,
    stateHash: afterStateHash,
    reviewStateHash: review.original_state_hash,
    reportHash: report?.report_hash ?? report?.report?.report_hash ?? null,
    selectedEventId: review.selected_event_id,
    returnedToHub: returned.released,
    resumedState: resumed.snapshot.state,
    endedState: ended.state,
    reviewReadOnly: review.read_only,
    catalogEpoch,
    catalogEpochRefreshes,
  };
}

async function v2AccessibilityAudit(cdp, timeoutMs) {
  const paperTabKeyboard = await keyboardActivateButton(cdp, { text: "纸面交易" }, timeoutMs);
  await waitForValue(
    cdp,
    `(() => { const button = document.querySelector('[data-replay-action="place-order"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
    timeoutMs,
    "paper trading keyboard tab activation",
  );
  const beforeOrder = await replayStatus(cdp);
  const orderKeyboard = await keyboardActivateButton(cdp, { action: "place-order" }, timeoutMs);
  const ordered = await waitForReplayStatus(
    cdp,
    `(value) => value.orderCount > ${beforeOrder.orderCount} && value.fillCount > ${beforeOrder.fillCount}`,
    timeoutMs,
    "keyboard-only v2 market order",
  );

  const endKeyboard = await keyboardActivateButton(cdp, { action: "end" }, timeoutMs);
  const dialog = await waitForValue(cdp, `(() => {
    const item = document.querySelector('[role="dialog"][data-replay-focus-trap="active"]');
    const describedBy = item?.getAttribute("aria-describedby") || "";
    const active = document.activeElement;
    return item instanceof HTMLElement && describedBy === "replay-end-description"
      && active instanceof HTMLElement && active.dataset.replayAction === "cancel-end"
      ? { describedBy, initialAction: active.dataset.replayAction }
      : null;
  })()`, timeoutMs, "danger dialog initial focus and ARIA");
  await pressKey(cdp, "Tab");
  const confirmFocused = await waitForValue(
    cdp,
    `document.activeElement?.getAttribute("data-replay-action") === "confirm-end"`,
    timeoutMs,
    "danger dialog confirm tab stop",
  );
  await pressKey(cdp, "Tab");
  const wrapped = await waitForValue(
    cdp,
    `document.activeElement instanceof HTMLSelectElement && document.activeElement.value === "expire"`,
    timeoutMs,
    "danger dialog focus trap wrap",
  );
  await pressKey(cdp, "Escape");
  const restored = await waitForValue(
    cdp,
    `document.querySelector('[role="dialog"]') === null && document.activeElement?.getAttribute("data-replay-action") === "end"`,
    timeoutMs,
    "danger dialog Escape and focus restoration",
  );

  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedMotion = await evaluate(cdp, `(() => {
    const host = document.querySelector(".replay-control-stack");
    if (!(host instanceof HTMLElement)) return null;
    const probe = document.createElement("span");
    probe.className = "replay-loading-spinner";
    host.append(probe);
    const result = {
      mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationName: getComputedStyle(probe).animationName,
      transitionDuration: getComputedStyle(probe).transitionDuration,
    };
    probe.remove();
    return result;
  })()`);
  assert(
    reducedMotion?.mediaMatches === true
      && reducedMotion?.animationName === "none"
      && ["0.00001s", "1e-05s"].includes(reducedMotion?.transitionDuration),
    "reduced-motion policy was not effective",
    reducedMotion,
  );
  await cdp.send("Emulation.setEmulatedMedia", { media: "screen", features: [] });

  await evaluate(cdp, `(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  })()`);
  const pausedBeforeShortcut = await replayStatus(cdp);
  assert(pausedBeforeShortcut?.state === "PAUSED", "keyboard shortcut audit requires PAUSED", pausedBeforeShortcut);
  await pressKey(cdp, " ");
  const playing = await waitForReplayStatus(cdp, `(value) => value.state === "PLAYING"`, timeoutMs, "Space play shortcut");
  await waitForValue(
    cdp,
    `(() => { const button = document.querySelector('[data-replay-action="pause"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
    timeoutMs,
    "Space pause shortcut readiness",
  );
  await wait(250);
  await pressKey(cdp, " ");
  const paused = await waitForReplayStatus(cdp, `(value) => value.state === "PAUSED"`, timeoutMs, "Space pause shortcut");
  // The PAUSED status DOM can commit one task before React replaces the
  // window-level shortcut closure. Wait for the matching enabled control and
  // one bounded turn so ArrowRight is assessed against the PAUSED handler.
  await waitForCommandReady(cdp, timeoutMs, true);
  await wait(250);
  await pressKey(cdp, "ArrowRight");
  const stepped = await waitForReplayStatus(
    cdp,
    `(value) => value.sourceSequence > ${paused.sourceSequence}`,
    timeoutMs,
    "ArrowRight display-step shortcut",
  );

  return {
    keyboardOnly: {
      paperTab: paperTabKeyboard,
      order: orderKeyboard,
      endDanger: endKeyboard,
      orderAndImmediateFill: ordered,
      shortcuts: { playing, paused, stepped },
    },
    dangerDialog: { ...dialog, confirmFocused: Boolean(confirmFocused), wrapped: Boolean(wrapped), restored: Boolean(restored) },
    reducedMotion,
  };
}

async function liveSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body?.innerText || "";
    const interval = document.querySelector(".interval-btn.active")?.textContent?.trim() || "";
    const bars = Math.max(0, ...[...text.matchAll(/([0-9]+)[ ]+bars/g)].map((match) => Number(match[1])));
    return {
      url: location.href,
      interval,
      bars,
      canvasCount: document.querySelectorAll("canvas").length,
      prefs: localStorage.getItem("candlescope-user-prefs"),
      replayEntry: document.querySelector('[data-replay-entry="enabled"]')?.textContent?.trim() || "",
    };
  })()`);
}

async function browserMetrics(cdp, collectGarbage = true) {
  if (collectGarbage) await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const [heap, performance, dom] = await Promise.all([
    cdp.send("Runtime.getHeapUsage"),
    cdp.send("Performance.getMetrics"),
    evaluate(cdp, `({
      elements: document.querySelectorAll("*").length,
      canvases: document.querySelectorAll("canvas").length,
      bodyTextBytes: new TextEncoder().encode(document.body?.innerText || "").length,
    })`),
  ]);
  const metrics = Object.fromEntries((performance.metrics || []).map((item) => [item.name, item.value]));
  return {
    atMs: Date.now(),
    heap: {
      usedSize: heap.usedSize,
      totalSize: heap.totalSize,
      embedderHeapUsedSize: heap.embedderHeapUsedSize,
      backingStorageSize: heap.backingStorageSize,
    },
    dom,
    performance: {
      documents: metrics.Documents ?? null,
      frames: metrics.Frames ?? null,
      jsEventListeners: metrics.JSEventListeners ?? null,
      layoutCount: metrics.LayoutCount ?? null,
      nodes: metrics.Nodes ?? null,
      taskDuration: metrics.TaskDuration ?? null,
    },
  };
}

async function runProjectionSoak(cdp, eventCount) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const before = await cdp.send("Runtime.getHeapUsage");
  const result = await evaluate(cdp, `(async () => {
    const [{ ReplayStore }, parser, fixtures] = await Promise.all([
      import("/src/features/replay/replayStore.ts"),
      import("/src/features/replay/replayParser.ts"),
      import("/src/features/replay/__tests__/fixtures.ts"),
    ]);
    let store = new ReplayStore();
    store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
    store.applyAtomicSnapshot(1, parser.parseReplaySessionResponse(fixtures.replayTradeSessionResponse()).snapshot);
    const count = ${JSON.stringify(eventCount)};
    const milestones = {};
    const targets = new Map([
      [Math.ceil(count * 0.25), "25pct"],
      [Math.ceil(count * 0.50), "50pct"],
      [Math.ceil(count * 0.75), "75pct"],
      [count, "100pct"],
    ]);
    const started = performance.now();
    for (let index = 1; index <= count; index += 1) {
      const parsed = parser.parseReplayEvent(fixtures.replayTradeDeltaEvent({ sequence: index, sourceSequence: index + 1 }));
      if (!store.applyEvent(1, parsed)) throw new Error("ReplayStore rejected browser projection event " + index);
      const label = targets.get(index);
      if (label) milestones[label] = performance.memory?.usedJSHeapSize ?? null;
    }
    const elapsedMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = store.getSnapshot();
    const output = {
      events: count,
      elapsedMs,
      eventsPerSecond: count / (elapsedMs / 1000),
      heapMilestones: milestones,
      seriesBars: store.seriesStore.barCount,
      sourceSequence: snapshot.sourceSequence,
      uiFlushCount: snapshot.uiFlushCount,
      renderRevision: snapshot.renderRevision,
      transient: store.transientDiagnostics(),
    };
    store.dispose();
    store = null;
    return output;
  })()`);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const after = await cdp.send("Runtime.getHeapUsage");
  return {
    ...result,
    scope: "Vite browser + real ReplayStore + replayParser + SeriesWindowStore; React chart rendering is covered by the separate 4h app soak",
    heapBeforeGcBytes: before.usedSize,
    heapAfterDisposeGcBytes: after.usedSize,
    retainedHeapDeltaBytes: after.usedSize - before.usedSize,
  };
}

async function dumpIndexedDb(cdp) {
  return evaluate(cdp, `(async () => {
    if (typeof indexedDB.databases !== "function") return { supported: false, databases: [] };
    const descriptors = await indexedDB.databases();
    const databases = [];
    for (const descriptor of descriptors) {
      if (!descriptor.name) continue;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(descriptor.name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const stores = {};
      for (const storeName of db.objectStoreNames) {
        stores[storeName] = await new Promise((resolve, reject) => {
          const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(null, 1000);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }
      databases.push({ name: descriptor.name, version: descriptor.version, stores });
      db.close();
    }
    return { supported: true, databases };
  })()`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const forbiddenBoundaries = [
  // Match a standalone fixture epoch token in JSON, text, or a URL. Do not
  // classify the same digit run inside a Decimal amount, hash, or identifier.
  { name: "fixture_epoch_milliseconds", pattern: /(?<![0-9A-Za-z.])1700\d{9}(?![0-9A-Za-z.])/g },
  { name: "fixture_calendar_date", pattern: /\b202[34](?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月]))/g },
  { name: "windows_filesystem_path", pattern: /[A-Za-z]:(?:\\\\|[\\/])(?![\\/])[^\s"']+/g },
  { name: "unix_filesystem_path", pattern: /\/(?:tmp|home|Users)\/[^\s"']+/g },
  { name: "archive_or_database_path", pattern: /[^\s"']+\.(?:parquet|duckdb|sqlite|db)(?:\b|$)/gi },
];

function boundaryText(value) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : String(serialized);
}

function collectForbiddenBoundaryMatches(text, matchesByBoundary = new Map()) {
  for (const boundary of forbiddenBoundaries) {
    let match = matchesByBoundary.get(boundary.name);
    if (!match) {
      match = { boundary: boundary.name, values: [], contexts: [] };
      matchesByBoundary.set(boundary.name, match);
    }
    const remaining = 20 - match.values.length;
    if (remaining <= 0) continue;
    boundary.pattern.lastIndex = 0;
    let collected = 0;
    for (const found of text.matchAll(boundary.pattern)) {
      match.values.push(found[0]);
      match.contexts.push(text.slice(
        Math.max(0, (found.index ?? 0) - 160),
        (found.index ?? 0) + found[0].length + 160,
      ));
      collected += 1;
      if (collected >= remaining) break;
    }
  }
  return matchesByBoundary;
}

function finalizedBoundaryMatches(matchesByBoundary) {
  return forbiddenBoundaries
    .map((boundary) => matchesByBoundary.get(boundary.name))
    .filter((match) => match && match.values.length > 0);
}

function createStreamingBoundaryAudit(label) {
  const digest = createHash("sha256");
  const matchesByBoundary = new Map();
  let bytes = 0;
  let itemCount = 0;
  let result = null;
  return {
    add(value) {
      if (result) {
        result.itemsAfterFinish += 1;
        return false;
      }
      const text = boundaryText(value);
      const itemBytes = Buffer.byteLength(text);
      digest.update(`${itemBytes}:`);
      digest.update(text);
      digest.update("\n");
      bytes += itemBytes;
      itemCount += 1;
      collectForbiddenBoundaryMatches(text, matchesByBoundary);
      return true;
    },
    finish() {
      if (result) return result;
      const matches = finalizedBoundaryMatches(matchesByBoundary);
      result = {
        label,
        bytes,
        itemCount,
        itemsAfterFinish: 0,
        framing: "length-prefixed-json-lines.v1",
        sha256: `sha256:${digest.digest("hex")}`,
        forbiddenMatches: matches,
        passed: matches.length === 0,
      };
      return result;
    },
  };
}

function auditBoundary(label, value) {
  const text = boundaryText(value);
  const matches = finalizedBoundaryMatches(collectForbiddenBoundaryMatches(text));
  return {
    label,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    forbiddenMatches: matches,
    passed: matches.length === 0,
  };
}

function assertReplayNetwork(capture, frontendOrigin) {
  const forbiddenApi = /\/api\/v1\/(?:klines|market|trade[_-]?flow|liquidations?|order[_-]?book|full[_-]?order[_-]?book|symbols|exchanges|subscriptions|indicators|alerts|settings)/i;
  const badRequests = capture.requests.filter((item) => {
    if (!item.url) return false;
    const parsed = new URL(item.url);
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

async function waitForDownload(directory, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json") && !name.endsWith(".crdownload"));
    if (files.length > 0) return path.join(directory, files[0]);
    await wait(100);
  }
  throw new Error("Timed out waiting for replay JSON export");
}

function actorDiagnostics(payload, sessionId) {
  return payload?.replay?.sessions?.[sessionId] || null;
}

async function waitForSubscriberCount(diagnosticsUrl, sessionId, maximum, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const payload = await readJson(diagnosticsUrl);
    last = actorDiagnostics(payload, sessionId);
    if (last && Number(last.subscribers) <= maximum) return { payload, actor: last };
    await wait(100);
  }
  throw new Error(`Replay subscriber count did not return to <=${maximum}: ${JSON.stringify(last)}`);
}

async function lifecycleCycle({ debugBase, diagnosticsUrl, frontendOrigin, sessionId, timeoutMs }) {
  const opened = Date.now();
  const page = await createTarget(debugBase);
  const capture = captureTarget(page.cdp);
  let navigation = null;
  try {
    const url = `${frontendOrigin}/replay.html?session=${encodeURIComponent(sessionId)}`;
    navigation = await page.cdp.send("Page.navigate", { url });
    assert(!navigation?.errorText, "lifecycle target navigation failed", navigation);
    const before = await waitForReplayStatus(
      page.cdp,
      `(value) => value.connection === "connected" && (value.state === "PLAYING" || value.state === "PAUSED")`,
      timeoutMs,
      "lifecycle recovery snapshot",
    );
    assert(await evaluate(page.cdp, "window.opener === null"), "lifecycle replay target retained opener");
    const beforeMetrics = await browserMetrics(page.cdp);
    const diagnosticsDuring = await readJson(diagnosticsUrl);
    const subscriberCountDuring = Number(actorDiagnostics(diagnosticsDuring, sessionId)?.subscribers ?? 0);
    const targetCountDuring = (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length;
    await evaluate(page.cdp, "globalThis.__CANDLESCOPE_REPLAY_SOAK_OLD_DOCUMENT__ = true");
    await page.cdp.send("Page.reload", { ignoreCache: true });
    await waitForValue(
      page.cdp,
      "globalThis.__CANDLESCOPE_REPLAY_SOAK_OLD_DOCUMENT__ !== true",
      timeoutMs,
      "lifecycle reload document",
    );
    const after = await waitForReplayStatus(
      page.cdp,
      `(value) => value.connection === "connected" && value.sourceSequence >= ${before.sourceSequence}`,
      timeoutMs,
      "lifecycle reload convergence",
    );
    const afterMetrics = await browserMetrics(page.cdp);
    assert(capture.exceptions.length === 0, "lifecycle target raised runtime exception", capture.exceptions);
    return {
      elapsedMs: Date.now() - opened,
      before,
      after,
      beforeMetrics,
      afterMetrics,
      subscriberCountDuring,
      targetCountDuring,
      consoleErrors: capture.consoleErrors,
    };
  } catch (error) {
    await capture.settle();
    const diagnostics = {
      phase: "lifecycle-cycle",
      elapsedMs: Date.now() - opened,
      navigation,
      status: await replayStatus(page.cdp).catch(() => null),
      page: await evaluate(page.cdp, `({
        url: location.href,
        readyState: document.readyState,
        title: document.title,
        text: (document.body?.innerText || "").slice(-5000),
        html: (document.documentElement?.outerHTML || "").slice(-5000),
      })`).catch((pageError) => ({ error: pageError?.message || String(pageError) })),
      navigationHistory: await page.cdp.send("Page.getNavigationHistory").catch((historyError) => ({ error: historyError?.message || String(historyError) })),
      target: await readJson(`${debugBase}/json/list`)
        .then((targets) => targets.find((target) => target.id === page.target.id) || page.target)
        .catch((targetError) => ({ error: targetError?.message || String(targetError) })),
      backend: await readJson(diagnosticsUrl).catch((backendError) => ({ error: backendError?.message || String(backendError) })),
      apiRequests: capture.requests.filter((item) => item.url.includes("/api/")).slice(-50),
      apiResponses: capture.responses.filter((item) => item.url.includes("/api/")).slice(-50),
      responseBodies: capture.responseBodies.slice(-50),
      failedRequests: capture.failedRequests.slice(-50),
      webSockets: capture.webSockets.slice(-50),
      webSocketFramesReceived: capture.webSocketFramesReceived.slice(-50),
      consoleErrors: capture.consoleErrors.slice(-50),
      exceptions: capture.exceptions.slice(-50),
      error: error?.stack || error?.message || String(error),
    };
    if (error && typeof error === "object") error.replayPhaseDiagnostics = diagnostics;
    throw error;
  } finally {
    await page.cdp.send("Page.close").catch(() => undefined);
    page.cdp.close();
    await waitForSubscriberCount(diagnosticsUrl, sessionId, 1, timeoutMs);
  }
}

function writeJson(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseEvidence = captureReplayReleaseEvidence(repositoryRoot);
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; set CHROME_PATH or --chrome-path");
  const [backendPort, frontendPort, debugPort] = await Promise.all([
    freeHarnessPort(),
    freeHarnessPort(),
    freeHarnessPort(),
  ]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-replay-soak-"));
  const expectedTempPrefix = path.resolve(os.tmpdir()) + path.sep;
  assert(path.resolve(tempRoot).startsWith(expectedTempPrefix), "temporary soak root escaped the OS temp directory", tempRoot);
  const userDataDir = path.join(tempRoot, "chrome-profile");
  const downloadDir = path.join(tempRoot, "downloads");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(downloadDir);
  const python = fs.existsSync(path.join(backendRoot, ".venv", "Scripts", "python.exe"))
    ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
    : "python";
  const offlineOrigin = "http://127.0.0.1:9";
  const backendArgs = [
    "-m",
    "scripts.replay_smoke_fixture",
    "--port",
    String(backendPort),
    "--live-window",
    "--disable-gap-maintenance",
    ...(args.realKlinesSource
      ? ["--real-klines-source", args.realKlinesSource]
      : []),
  ];
  const backend = spawn(python, backendArgs, {
    cwd: backendRoot,
    env: {
      ...process.env,
      REPLAY_ENABLED: "1",
      REPLAY_PRODUCT_V2_ENABLED: args.productV2 ? "1" : "0",
      REPLAY_HISTORICAL_BOOK_ENABLED: "0",
      REPLAY_IDLE_TTL_SECONDS: args.productV2 ? "1" : (process.env.REPLAY_IDLE_TTL_SECONDS || "3600"),
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
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const backendTail = processTail(backend, 1_000, {
    backfillFailures: /Backfill FAILED:/g,
    backfillFetchIssues: /Backfill fetch task issue:/g,
  });
  const vite = spawn(process.execPath, [path.join(frontendRoot, "node_modules", "vite", "bin", "vite.js")], {
    cwd: frontendRoot,
    env: {
      ...process.env,
      VITE_DEV_PORT: String(frontendPort),
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
      VITE_REPLAY_ENTRY_ENABLED: "1",
      VITE_REPLAY_PRODUCT_V2_ENABLED: args.productV2 ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const viteTail = processTail(vite);
  const chrome = spawn(chromePath, [
    ...(args.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1600,1000",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--enable-precise-memory-info",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const chromeTail = processTail(chrome);
  const connections = new Set();
  let result = null;
  let phaseDiagnostics = null;
  try {
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    const debugBase = `http://127.0.0.1:${debugPort}`;
    const diagnosticsUrl = `${backendOrigin}/__replay_smoke__/diagnostics`;
    await waitForHttp(`${backendOrigin}/__replay_smoke__/fixture`, backend, args.timeoutMs);
    await waitForHttp(`${frontendOrigin}/`, vite, args.timeoutMs);
    await waitForHttp(`${debugBase}/json/version`, chrome, args.timeoutMs);
    const fixture = await readJson(`${backendOrigin}/__replay_smoke__/fixture`);
    const liveSymbol = fixture.live_window?.symbol;
    assert(
      typeof liveSymbol === "string"
        && Object.values(fixture.live_window?.rows_by_interval || {}).every((rows) => Number(rows) >= 2_000)
        && Number(fixture.live_window?.future_horizon_ms) >= RELEASE_DURATION_MS,
      "browser soak fixture did not enable its isolated gap-free live window",
      fixture,
    );
    assert(fixture.gap_maintenance_enabled === false, "offline browser soak fixture left gap maintenance enabled", fixture);
    if (!args.allowShort && args.productV2) {
      assert(
        fixture.source_profile === "REAL_BAR_SQLITE"
          && fixture.real_source === true
          && fixture.real_source_evidence?.read_only === true
          && fixture.real_source_evidence?.identities?.length >= 2,
        "formal replay.v2 soak did not load the validated real BAR profile",
        fixture,
      );
    }

    const projectionPage = await createTarget(debugBase);
    connections.add(projectionPage.cdp);
    await projectionPage.cdp.send("Page.navigate", { url: `${frontendOrigin}/replay.html` });
    await waitForValue(
      projectionPage.cdp,
      args.productV2
        ? "document.querySelector('[data-training-hub-phase]') !== null"
        : "document.querySelector('[data-replay-action=\"create-session\"]') !== null",
      args.timeoutMs,
      "projection soak module host",
    );
    console.error(`browser projection soak starting: ${args.projectionEvents} events`);
    const projectionSoak = await runProjectionSoak(projectionPage.cdp, args.projectionEvents);
    console.error(`browser projection soak complete: ${projectionSoak.eventsPerSecond.toFixed(2)} events/s`);
    await projectionPage.cdp.send("Page.close").catch(() => undefined);
    projectionPage.cdp.close();
    connections.delete(projectionPage.cdp);

    const replay = await createTarget(debugBase);
    connections.add(replay.cdp);
    const replayCapture = captureTarget(replay.cdp, { auditReplayBoundaries: true });
    await replay.cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    await replay.cdp.send("Page.navigate", { url: `${frontendOrigin}/replay.html` });
    let hubKeyboard = null;
    if (args.productV2) {
      await waitForValue(replay.cdp, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "新建训练"); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "v2 Training Hub readiness");
      const opened = await keyboardActivateButton(replay.cdp, { text: "新建训练" }, args.timeoutMs);
      try {
        await waitForValue(replay.cdp, `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "创建并进入训练"); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "v2 create plan readiness");
      } catch (error) {
        await replayCapture.settle();
        phaseDiagnostics = {
          phase: "v2-create-plan-readiness",
          page: await evaluate(replay.cdp, `({
            url: location.href,
            text: (document.body?.innerText || "").slice(-5000),
            buttons: [...document.querySelectorAll("button")].map((button) => ({
              text: button.textContent?.trim() || "",
              disabled: button.disabled,
            })),
          })`).catch(() => null),
          apiRequests: replayCapture.requests.filter((item) => item.url.includes("/api/")).slice(-30),
          apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
          responseBodies: replayCapture.responseBodies.slice(-30),
          consoleErrors: replayCapture.consoleErrors,
          exceptions: replayCapture.exceptions,
        };
        throw error;
      }
      const created = await keyboardActivateButton(replay.cdp, { text: "创建并进入训练" }, args.timeoutMs);
      hubKeyboard = { opened, created };
    } else {
      await waitForValue(replay.cdp, `(() => { const button = document.querySelector('[data-replay-action="create-session"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`, args.timeoutMs, "replay session dialog");
      await click(replay.cdp, '[data-replay-action="create-session"]');
    }
    let initial;
    try {
      initial = await waitForReplayStatus(replay.cdp, `(value) => value.connection === "connected" && value.state === "PAUSED" && value.bars > 0`, args.timeoutMs, "initial replay snapshot");
    } catch (error) {
      await replayCapture.settle();
      phaseDiagnostics = {
        phase: "initial-replay-snapshot",
        page: await evaluate(replay.cdp, `({
          url: location.href,
          text: (document.body?.innerText || "").slice(-5000),
          replayStatus: window.__candlescopeReplayStatus || null,
          buttons: [...document.querySelectorAll("button")].map((button) => ({
            text: button.textContent?.trim() || "",
            disabled: button.disabled,
          })),
        })`).catch(() => null),
        apiRequests: replayCapture.requests.filter((item) => item.url.includes("/api/")).slice(-30),
        apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
        responseBodies: replayCapture.responseBodies.slice(-30),
        webSockets: replayCapture.webSockets,
        consoleErrors: replayCapture.consoleErrors,
        exceptions: replayCapture.exceptions,
      };
      throw error;
    }
    const sessionId = new URL(await evaluate(replay.cdp, "location.href")).searchParams.get("session");
    assert(sessionId, "replay session URL is missing an opaque session id");
    const v2CreateRequest = args.productV2
      ? [...replayCapture.requests].reverse().find((item) => (
        item.method === "POST" && /\/api\/v1\/replay\/runs$/.test(new URL(item.url).pathname)
      ))
      : null;
    const v2CreatePayload = v2CreateRequest?.postData ? JSON.parse(v2CreateRequest.postData) : null;
    if (args.productV2) assert(v2CreatePayload?.protocol === "replay.v2", "v2 create payload was not captured", v2CreateRequest);
    assert(await evaluate(replay.cdp, "window.opener === null"), "primary replay target retained opener");
    const blindInitialDom = await evaluate(replay.cdp, "document.body.innerText");
    assert(!/\b20\d{2}(?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月]))/.test(String(blindInitialDom)), "blind replay DOM rendered a calendar date before reveal");
    const accessibility = args.productV2 ? await v2AccessibilityAudit(replay.cdp, args.timeoutMs) : null;

    // Establish the live/replay coexistence proof only after the archive session
    // exists. An offline live target can legitimately probe missing present-day
    // ranges; it must not starve the deterministic Training Hub create gate.
    const live = await createTarget(debugBase);
    connections.add(live.cdp);
    const liveCapture = captureTarget(live.cdp);
    const livePreferences = JSON.stringify({ lastExchange: "binance", lastMarketType: "spot", lastSymbol: liveSymbol, lastInterval: "1m" });
    await live.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("candlescope-user-prefs", ${JSON.stringify(livePreferences)}); } catch {}`,
    });
    await live.cdp.send("Page.navigate", { url: `${frontendOrigin}/` });
    await waitForValue(live.cdp, "document.querySelector('[data-replay-entry=\"enabled\"]') !== null", args.timeoutMs, "live replay entry");
    try {
      await waitForValue(
        live.cdp,
        `document.querySelectorAll("canvas").length > 0
          && [...document.body.innerText.matchAll(/([0-9]+)[ ]+bars/g)].some((match) => Number(match[1]) > 0)`,
        args.timeoutMs,
        "live chart fixture bars",
      );
    } catch (error) {
      const diagnostics = await evaluate(live.cdp, `({
        snapshotText: (document.body?.innerText || "").slice(-3000),
        canvases: document.querySelectorAll("canvas").length,
        url: location.href,
      })`).catch(() => null);
      throw new Error(`${error.message}\nLive diagnostics: ${JSON.stringify({
        diagnostics,
        apiResponses: liveCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
        consoleErrors: liveCapture.consoleErrors,
        exceptions: liveCapture.exceptions,
      })}`);
    }
    const liveBefore = await liveSnapshot(live.cdp);
    assert(liveBefore.bars > 0 && liveBefore.canvasCount > 0, "live page failed to become ready", liveBefore);
    await replay.cdp.send("Page.bringToFront");

    const beforeSpeed = await replayStatus(replay.cdp);
    const speedAction = replaySpeedAction(args.productV2);
    const primarySpeed = await evaluate(replay.cdp, `(() => {
      const select = document.querySelector('[data-replay-action="${speedAction}"]');
      if (!(select instanceof HTMLSelectElement)) return null;
      const previous = select.value;
      if (previous !== "1") {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { previous, current: select.value, changed: previous !== "1" };
    })()`);
    assert(
      primarySpeed?.current === "1",
      "primary replay speed control was unavailable or rejected 1x",
      {
        primarySpeed,
        action: speedAction,
        productV2: args.productV2,
      },
    );
    if (primarySpeed.changed) {
      await waitForReplayStatus(
        replay.cdp,
        `(value) => value.revision > ${beforeSpeed.revision}`,
        args.timeoutMs,
        "1x speed ack",
      );
    }
    assert(primarySpeed !== null, "primary replay speed state is missing", {
      action: speedAction,
      productV2: args.productV2,
    });
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="play"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "play command readiness",
    );
    await click(replay.cdp, '[data-replay-action="play"]');
    let playing;
    try {
      playing = await waitForReplayStatus(replay.cdp, `(value) => value.state === "PLAYING"`, args.timeoutMs, "1x play ack");
    } catch (error) {
      await replayCapture.settle();
      phaseDiagnostics = {
        phase: "primary-play-ack",
        status: await replayStatus(replay.cdp).catch(() => null),
        page: await evaluate(replay.cdp, `({
          url: location.href,
          text: (document.body?.innerText || "").slice(-5000),
          play: (() => { const button = document.querySelector('[data-replay-action="play"]'); return button instanceof HTMLButtonElement ? { disabled: button.disabled, text: button.textContent?.trim() || "" } : null; })(),
          commandErrors: [...document.querySelectorAll('.replay-error-summary, .replay-command-error')].map((item) => item.textContent?.trim() || ""),
        })`).catch(() => null),
        apiRequests: replayCapture.requests.filter((item) => item.url.includes("/api/")).slice(-30),
        apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
        responseBodies: replayCapture.responseBodies.slice(-30),
        webSockets: replayCapture.webSockets,
        consoleErrors: replayCapture.consoleErrors,
        exceptions: replayCapture.exceptions,
      };
      throw error;
    }
    const targetBaseline = (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length;
    const initialMetrics = {
      replay: await browserMetrics(replay.cdp),
      live: await browserMetrics(live.cdp),
      targets: targetBaseline,
      backend: await readJson(diagnosticsUrl),
      status: playing,
    };
    const startedAtMs = Date.now();
    const plannedEndMs = startedAtMs + args.durationMs;
    const samples = [{ elapsedMs: 0, ...initialMetrics }];
    const cycles = [];
    const trainingCycles = [];
    const archiveLifecycleCycles = [];
    let cycleIndex = 0;
    let nextSampleAt = startedAtMs + args.sampleMs;
    let lastProgressAt = 0;
    while (Date.now() < plannedEndMs || cycleIndex < args.cycles) {
      const now = Date.now();
      const cycleDueAt = startedAtMs + Math.floor((args.durationMs * cycleIndex) / args.cycles);
      if (cycleIndex < args.cycles && now >= cycleDueAt) {
        let training;
        try {
          training = await trainingActionCycle({
            cdp: replay.cdp,
            backendOrigin,
            sessionId,
            diagnosticGapSteps: args.diagnosticGapSteps,
            index: cycleIndex,
            productV2: args.productV2,
            timeoutMs: args.timeoutMs,
          });
        } catch (error) {
          await replayCapture.settle();
          phaseDiagnostics = {
            phase: "training-action-cycle",
            cycle: cycleIndex + 1,
            elapsedFromStartMs: Date.now() - startedAtMs,
            status: await replayStatus(replay.cdp).catch(() => null),
            page: await evaluate(replay.cdp, `({
              url: location.href,
              text: (document.body?.innerText || "").slice(-5000),
              actions: [...document.querySelectorAll("[data-replay-action]")].map((item) => ({
                action: item.getAttribute("data-replay-action"),
                disabled: item instanceof HTMLButtonElement || item instanceof HTMLSelectElement ? item.disabled : null,
                text: item.textContent?.trim() || "",
              })),
              commandErrors: [...document.querySelectorAll('.replay-error-summary, .replay-command-error')].map((item) => item.textContent?.trim() || ""),
            })`).catch(() => null),
            backend: await readJson(diagnosticsUrl).catch((backendError) => ({ error: backendError.message || String(backendError) })),
            apiRequests: replayCapture.requests.filter((item) => item.url.includes("/api/")).slice(-30),
            apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/")).slice(-30),
            responseBodies: replayCapture.responseBodies.slice(-30),
            webSockets: replayCapture.webSockets,
            consoleErrors: replayCapture.consoleErrors,
            exceptions: replayCapture.exceptions,
            error: error.stack || error.message || String(error),
          };
          throw error;
        }
        trainingCycles.push({ index: cycleIndex + 1, elapsedFromStartMs: Date.now() - startedAtMs, ...training });
        if (args.productV2) {
          let archiveLifecycle;
          try {
            archiveLifecycle = await v2ArchiveLifecycleCycle({
              backendOrigin,
              createPayload: v2CreatePayload,
              index: cycleIndex,
            });
          } catch (error) {
            phaseDiagnostics = {
              phase: "v2-archive-lifecycle",
              cycle: cycleIndex + 1,
              elapsedFromStartMs: Date.now() - startedAtMs,
              backend: await readJson(diagnosticsUrl).catch((backendError) => ({
                error: backendError.message || String(backendError),
              })),
              http: {
                status: error?.status ?? null,
                url: error?.url ?? null,
                responseBody: error?.responseBody ?? null,
              },
              error: error?.stack || error?.message || String(error),
            };
            throw error;
          }
          archiveLifecycleCycles.push({
            index: cycleIndex + 1,
            elapsedFromStartMs: Date.now() - startedAtMs,
            ...archiveLifecycle,
          });
        }
        let cycle;
        try {
          cycle = await lifecycleCycle({
            debugBase,
            diagnosticsUrl,
            frontendOrigin,
            sessionId,
            timeoutMs: args.timeoutMs,
          });
        } catch (error) {
          phaseDiagnostics = {
            cycle: cycleIndex + 1,
            elapsedFromStartMs: Date.now() - startedAtMs,
            ...(error?.replayPhaseDiagnostics || {
              phase: "lifecycle-cycle",
              error: error?.stack || error?.message || String(error),
            }),
          };
          throw error;
        }
        cycles.push({ index: cycleIndex + 1, elapsedFromStartMs: Date.now() - startedAtMs, ...cycle });
        cycleIndex += 1;
        if (cycleIndex % 10 === 0 || cycleIndex === args.cycles) console.error(`replay lifecycle cycles: ${cycleIndex}/${args.cycles}`);
        continue;
      }
      if (now >= nextSampleAt || (now >= plannedEndMs && cycleIndex >= args.cycles)) {
        const status = await replayStatus(replay.cdp);
        assert(status?.connection === "connected", "primary replay connection left connected state", status);
        assert(status.state === "PLAYING", "primary replay stopped during soak", status);
        const sample = {
          elapsedMs: Date.now() - startedAtMs,
          replay: await browserMetrics(replay.cdp),
          live: await browserMetrics(live.cdp),
          targets: (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length,
          backend: await readJson(diagnosticsUrl),
          status,
        };
        samples.push(sample);
        nextSampleAt = Date.now() + args.sampleMs;
        if (now >= plannedEndMs && cycleIndex >= args.cycles) break;
      }
      if (now - lastProgressAt >= 60_000) {
        lastProgressAt = now;
        const status = await replayStatus(replay.cdp).catch(() => null);
        console.error(`replay browser soak: ${Math.floor((now - startedAtMs) / 60_000)}m/${Math.ceil(args.durationMs / 60_000)}m, cycles=${cycleIndex}/${args.cycles}, source=${status?.sourceSequence ?? "?"}`);
      }
      await wait(Math.min(1_000, Math.max(50, Math.min(nextSampleAt, cycleDueAt) - Date.now())));
    }
    const finalSoakStatus = await replayStatus(replay.cdp);
    const finalMetrics = {
      elapsedMs: Date.now() - startedAtMs,
      replay: await browserMetrics(replay.cdp),
      live: await browserMetrics(live.cdp),
      targets: (await readJson(`${debugBase}/json/list`)).filter((item) => item.type === "page").length,
      backend: await readJson(diagnosticsUrl),
      status: finalSoakStatus,
    };
    samples.push(finalMetrics);

    if (finalSoakStatus.state === "PLAYING") {
      await click(replay.cdp, '[data-replay-action="pause"]');
      await waitForReplayStatus(replay.cdp, `(value) => value.state === "PAUSED"`, args.timeoutMs, "final soak pause");
    }
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="end"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "end command readiness",
    );
    await click(replay.cdp, '[data-replay-action="end"]');
    await waitForValue(
      replay.cdp,
      `(() => { const button = document.querySelector('[data-replay-action="confirm-end"]'); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "end confirmation readiness",
    );
    await click(replay.cdp, '[data-replay-action="confirm-end"]');
    let ended;
    try {
      ended = await waitForReplayStatus(replay.cdp, `(value) => value.state === "ENDED"`, args.timeoutMs, "soak session end");
    } catch (error) {
      const diagnostics = await evaluate(replay.cdp, `({
        status: (() => { const node = document.querySelector("#replay-status-bar"); return node instanceof HTMLElement ? { text: node.innerText, data: { ...node.dataset } } : null; })(),
        commandError: document.querySelector(".replay-command-error")?.textContent || "",
        controllerBanner: document.querySelector(".replay-controller-banner")?.textContent || "",
        endDialog: document.querySelector(".replay-end-dialog")?.textContent || "",
        bodyTail: (document.body?.innerText || "").slice(-2000),
      })()`).catch(() => null);
      throw new Error(`${error.message}\nEnd diagnostics: ${JSON.stringify({
        diagnostics,
        apiResponses: replayCapture.responses.filter((item) => item.url.includes("/api/v1/replay")).slice(-20),
        frames: replayCapture.webSocketFramesReceived.slice(-10),
        consoleErrors: replayCapture.consoleErrors,
        exceptions: replayCapture.exceptions,
      })}`);
    }
    await waitForValue(replay.cdp, "document.querySelector('[data-replay-panel=\"report\"]') !== null", args.timeoutMs, "soak report panel");
    assert(ended.revealed === "false", "session end implicitly revealed actual history", ended);
    await waitForValue(
      replay.cdp,
      `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "导出 JSON"); return button instanceof HTMLButtonElement && !button.disabled; })()`,
      args.timeoutMs,
      "replay JSON export readiness",
    );
    await clickButtonByText(replay.cdp, "导出 JSON", args.timeoutMs);
    const exportPath = await waitForDownload(downloadDir, args.timeoutMs);
    const exportedText = fs.readFileSync(exportPath, "utf8");
    const exported = JSON.parse(exportedText);
    assert(exported.protocol === (args.productV2 ? "replay.v2" : "replay.v1"), "report export protocol drifted", exported);
    assert(exported.revealed === false && !Object.hasOwn(exported, "actual_history"), "unrevealed export included actual history", exported);
    const exportedReportHash = args.productV2
      ? exported.report?.report_hash
      : exported.integrity?.report_hash;
    assert(typeof exportedReportHash === "string" && exportedReportHash.startsWith("sha256:"), "report export hash is missing", exported);
    await wait(300);
    await replayCapture.settle();
    await replay.cdp.send("Network.disable");
    await wait(100);
    await replayCapture.settle();

    assert(replayCapture.boundaryAudits, "replay boundary audit was not initialized");
    const boundaries = [
      replayCapture.boundaryAudits.http.finish(),
      replayCapture.boundaryAudits.websocket.finish(),
      auditBoundary("dom", await evaluate(replay.cdp, "({ text: document.body.innerText, html: document.body.innerHTML })")),
      auditBoundary("localStorage", await evaluate(replay.cdp, "Object.fromEntries(Object.entries(localStorage))")),
      auditBoundary("indexedDB", await dumpIndexedDb(replay.cdp)),
      auditBoundary("export", exportedText),
    ];
    const blindAuditPassed = boundaries.every((item) => item.passed);
    assert(blindAuditPassed, "blind boundary audit found forbidden actual history or paths", boundaries);
    assertReplayNetwork(replayCapture, frontendOrigin);
    assert(replayCapture.exceptions.length === 0, "primary replay target raised runtime exceptions", replayCapture.exceptions);
    assert(replayCapture.consoleErrors.length === 0, "primary replay target logged console errors", replayCapture.consoleErrors);
    const replayApiFailures = replayCapture.responses.filter((item) => /\/api\/v1\/replay(?:\/|\?|$)/.test(item.url) && item.status >= 400);
    assert(replayApiFailures.length === 0, "replay API returned failures during soak", replayApiFailures);
    const backendLogCounts = backendTail.counts();
    assert(backendLogCounts.backfillFailures === 0, "live coexistence fixture triggered an offline backfill failure", backendLogCounts);

    const liveAfter = await liveSnapshot(live.cdp);
    assert(liveAfter.interval === liveBefore.interval, "replay soak changed live interval", { liveBefore, liveAfter });
    assert(liveAfter.prefs === liveBefore.prefs, "replay soak changed live persisted identity", { liveBefore, liveAfter });
    assert(liveAfter.canvasCount > 0 && liveAfter.bars >= liveBefore.bars, "live chart did not remain healthy", { liveBefore, liveAfter });
    assert(!liveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)), "live target opened replay WebSocket", liveCapture.webSockets);

    const halfSample = samples.reduce((best, sample) => (
      Math.abs(sample.elapsedMs - args.durationMs / 2) < Math.abs(best.elapsedMs - args.durationMs / 2) ? sample : best
    ), samples[0]);
    const primaryHeapGrowth = finalMetrics.replay.heap.usedSize - initialMetrics.replay.heap.usedSize;
    const lateHeapGrowth = finalMetrics.replay.heap.usedSize - halfSample.replay.heap.usedSize;
    const domGrowth = finalMetrics.replay.dom.elements - initialMetrics.replay.dom.elements;
    const sourceProgress = finalSoakStatus.sourceSequence - playing.sourceSequence;
    const maxTargets = Math.max(
      ...samples.map((sample) => sample.targets),
      ...cycles.map((cycle) => cycle.targetCountDuring),
    );
    const maxSubscribers = Math.max(
      ...samples.map((sample) => Number(actorDiagnostics(sample.backend, sessionId)?.subscribers ?? 0)),
      ...cycles.map((cycle) => cycle.subscriberCountDuring),
    );
    const finalActor = actorDiagnostics(finalMetrics.backend, sessionId);
    const minimumSourceProgress = Math.max(0, Math.floor(args.durationMs / 60_000) - 3);
    const checks = {
      real_bar_source_profile: !args.productV2 || args.allowShort || (
        fixture.source_profile === "REAL_BAR_SQLITE"
        && fixture.real_source === true
        && fixture.real_source_evidence?.read_only === true
        && fixture.real_source_evidence?.identities?.length >= 2
      ),
      duration_complete: finalMetrics.elapsedMs >= args.durationMs,
      lifecycle_cycles_complete: cycles.length === args.cycles,
      training_action_cycles_complete: trainingCycles.length === args.cycles,
      v2_archive_lifecycle_cycles_complete: !args.productV2 || archiveLifecycleCycles.length === args.cycles,
      v2_archive_lifecycle_exact: !args.productV2 || archiveLifecycleCycles.every((cycle) => (
        cycle.returnedToHub === true
        && cycle.resumedState === "PAUSED"
        && cycle.endedState === "ENDED"
        && cycle.reviewReadOnly === true
        && typeof cycle.stateHash === "string"
        && cycle.stateHash.startsWith("sha256:")
        && Number.isSafeInteger(cycle.catalogEpochRefreshes)
        && cycle.catalogEpochRefreshes >= 0
        && cycle.catalogEpochRefreshes <= 1
      )),
      v2_keyboard_accessible: !args.productV2 || (
        hubKeyboard?.opened?.active?.text === "新建训练"
        && hubKeyboard?.created?.active?.text === "创建并进入训练"
        && accessibility?.keyboardOnly?.paperTab?.active?.text === "纸面交易"
        && accessibility?.keyboardOnly?.order?.active?.action === "place-order"
        && accessibility?.dangerDialog?.initialAction === "cancel-end"
        && accessibility?.dangerDialog?.confirmFocused === true
        && accessibility?.dangerDialog?.wrapped === true
        && accessibility?.dangerDialog?.restored === true
      ),
      v2_reduced_motion_effective: !args.productV2 || (
        accessibility?.reducedMotion?.mediaMatches === true
        && accessibility?.reducedMotion?.animationName === "none"
      ),
      training_orders_and_fills_complete: trainingCycles.every((cycle) => (
        cycle.ordered.orderCount > cycle.before.orderCount
        && cycle.filled.fillCount > cycle.before.fillCount
      )),
      training_reconnects_complete: trainingCycles.every((cycle) => (
        cycle.reconnected.connection === "connected"
        && cycle.resumed.state === "PLAYING"
      )),
      training_controller_lease_recoveries_bounded: trainingCycles.filter(
        (cycle) => cycle.cycleStart.recovery === "takeover",
      ).length <= 1,
      v2_primary_actor_recoveries_complete: !args.productV2 || trainingCycles.every((cycle) => (
        cycle.adapterRecovery?.evicted?.evicted === true
        && Number.isSafeInteger(cycle.adapterRecovery.evicted.release_attempts)
        && cycle.adapterRecovery.evicted.release_attempts >= 1
        && cycle.adapterRecovery.evicted.sessions_evicted_after
          === cycle.adapterRecovery.evicted.sessions_evicted_before + 1
        && cycle.adapterRecovery.recovered.generation > cycle.filledPauseStable.generation
        && cycle.adapterRecovery.recovered.sourceSequence >= cycle.filledPauseStable.sourceSequence
        && ["ready", "takeover"].includes(cycle.adapterRecovery.readiness)
      )),
      projection_events_complete: projectionSoak.events === args.projectionEvents,
      projection_series_bounded: projectionSoak.seriesBars <= 2,
      projection_retained_heap_bounded: projectionSoak.retainedHeapDeltaBytes <= 64 * MIB,
      primary_retained_heap_bounded: primaryHeapGrowth <= 64 * MIB,
      primary_late_heap_bounded: lateHeapGrowth <= 32 * MIB,
      primary_dom_bounded: domGrowth <= 250,
      source_progress_expected: sourceProgress >= minimumSourceProgress,
      target_count_bounded: maxTargets <= targetBaseline + 1,
      subscriber_count_bounded: maxSubscribers <= 2 && Number(finalActor?.subscribers ?? 99) <= 1,
      blind_boundaries_clean: blindAuditPassed && boundaries
        .filter((item) => item.framing === "length-prefixed-json-lines.v1")
        .every((item) => item.itemsAfterFinish === 0),
      replay_runtime_clean: replayCapture.exceptions.length === 0 && replayCapture.consoleErrors.length === 0,
      lifecycle_runtime_clean: cycles.every((cycle) => cycle.consoleErrors.length === 0),
      live_runtime_isolated: !liveCapture.webSockets.some((url) => /\/stream\/replay\//.test(url)),
      live_offline_backfill_quiet: backendLogCounts.backfillFailures === 0,
    };
    result = {
      schema_version: args.productV2 ? "replay-v2-browser-soak.v1" : "replay-v1-browser-soak.v1",
      recorded_at: releaseEvidence.recorded_at,
      release_evidence: releaseEvidence.evidence,
      mode: args.allowShort ? "harness-validation" : "release-4h",
      passed: true,
      config: {
        durationMs: args.durationMs,
        cycles: args.cycles,
        diagnosticGapSteps: args.diagnosticGapSteps,
        sampleMs: args.sampleMs,
        projectionEvents: args.projectionEvents,
        product: args.productV2 ? "replay.v2" : "replay.v1",
        chrome: path.basename(chromePath),
        sourceProfile: fixture.source_profile,
        realSource: fixture.real_source,
        realSourceSha256: fixture.real_source_evidence?.file_sha256 ?? null,
        realSourceIdentityCount: fixture.real_source_evidence?.identities?.length ?? 0,
        fixtureRows: fixture.fixture_rows,
        liveWindow: fixture.live_window,
        fixtureIdentityHash: sha256(JSON.stringify(fixture)),
      },
      projectionSoak,
      replay: {
        initial,
        playing,
        finalSoakStatus,
        ended,
        sourceProgress,
        minimumSourceProgress,
        primaryHeapGrowthBytes: primaryHeapGrowth,
        lateHeapGrowthBytes: lateHeapGrowth,
        domGrowth,
        targetBaseline,
        maxTargets,
        maxSubscribers,
        requestCount: replayCapture.requestCount,
        responseCount: replayCapture.responseCount,
        webSocketCount: replayCapture.webSocketCount,
        webSocketFramesReceived: replayCapture.webSocketFramesReceived.length,
        exportSha256: sha256(exportedText),
        reportHash: exportedReportHash,
      },
      live: {
        before: liveBefore,
        after: liveAfter,
        webSockets: [...new Set(liveCapture.webSockets)],
        backendLogCounts,
      },
      lifecycle: {
        completed: cycles.length,
        maxReloadHeapDeltaBytes: Math.max(...cycles.map((cycle) => cycle.afterMetrics.heap.usedSize - cycle.beforeMetrics.heap.usedSize)),
        cycles,
      },
      trainingActions: {
        completed: trainingCycles.length,
        ordersPlaced: trainingCycles.reduce((total, cycle) => total + cycle.ordered.orderCount - cycle.before.orderCount, 0),
        fillsObserved: trainingCycles.reduce((total, cycle) => total + cycle.filled.fillCount - cycle.before.fillCount, 0),
        reconnectsCompleted: trainingCycles.filter((cycle) => cycle.reconnected.connection === "connected").length,
        speedSequence: trainingCycles.map((cycle) => cycle.targetSpeed),
        cycles: trainingCycles,
      },
      archiveLifecycle: {
        completed: archiveLifecycleCycles.length,
        catalogEpochRefreshes: archiveLifecycleCycles.reduce(
          (total, cycle) => total + cycle.catalogEpochRefreshes,
          0,
        ),
        cycles: archiveLifecycleCycles,
      },
      accessibility: {
        hubKeyboard,
        audit: accessibility,
      },
      samples,
      blindAudit: { passed: blindAuditPassed, boundaries },
      acceptance: {
        passed: Object.values(checks).every(Boolean),
        checks,
        thresholds: {
          projectionRetainedHeapBytes: 64 * MIB,
          primaryRetainedHeapBytes: 64 * MIB,
          primaryLateHeapBytes: 32 * MIB,
          primaryDomGrowth: 250,
          maxExtraTargets: 1,
          maxSubscribers: 2,
        },
      },
    };
    assert(result.acceptance.passed, "browser soak acceptance failed", result.acceptance);
    writeJson(args.out, result);
    fs.rmSync(`${args.out}.failed.json`, { force: true });
    console.log(JSON.stringify({
      passed: true,
      out: args.out,
      durationMs: finalMetrics.elapsedMs,
      cycles: cycles.length,
      trainingActionCycles: trainingCycles.length,
      archiveLifecycleCycles: archiveLifecycleCycles.length,
      projectionEvents: projectionSoak.events,
      projectionEventsPerSecond: projectionSoak.eventsPerSecond,
      primaryHeapGrowthBytes: primaryHeapGrowth,
      lateHeapGrowthBytes: lateHeapGrowth,
      blindAuditPassed,
      reportHash: result.replay.reportHash,
    }, null, 2));
  } catch (error) {
    const failure = {
      schema_version: args.productV2 ? "replay-v2-browser-soak-failure.v1" : "replay-v1-browser-soak-failure.v1",
      recorded_at: releaseEvidence.recorded_at,
      release_evidence: releaseEvidence.evidence,
      passed: false,
      error: error.stack || error.message || String(error),
      phaseDiagnostics,
      backendTail: backendTail(),
      viteTail: viteTail(),
      chromeTail: chromeTail(),
    };
    writeJson(`${args.out}.failed.json`, failure);
    throw error;
  } finally {
    for (const connection of connections) connection.close();
    await stopBackendGracefully(backend, `http://127.0.0.1:${backendPort}`);
    await Promise.all([stopProcessTree(chrome), stopProcessTree(vite), stopProcessTree(backend)]);
    await wait(300);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  return result;
}

export {
  auditBoundary,
  createV2ArchiveRun,
  createStreamingBoundaryAudit,
  isAuthoritativeReplayStatus,
  restoreCommandReadinessAfterReconnect,
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
