import { app, BrowserWindow, ipcMain, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { isTrustedAppUrl, startDesktopAssetServer } from "./app-origin.mjs";

import { ElectronWindowManager } from "./electron-window-manager.mjs";
import { AppWorkBudgetHub } from "./app-work-budget-hub.mjs";
import { DESKTOP_IPC, validateTopologyPayload } from "./ipc-contract.mjs";
import {
  analyzeMemoryWarmupPlateau,
  analyzePhase8Soak,
  histogramPercentileDelta,
  percentile,
} from "./phase8-analysis.mjs";
import { Phase8Fault429Proxy } from "./phase8-fault-proxy.mjs";
import { SidecarSupervisor } from "./sidecar-supervisor.mjs";
import { SeriesSnapshotHub } from "./series-snapshot-hub.mjs";
import { DesktopShellStateStore } from "./shell-state-store.mjs";
import { WorkspaceBusConflictError, WorkspaceBusHub } from "./workspace-bus-hub.mjs";
import { displayFingerprint, restoreWindowPlacement, snapshotDisplay } from "./window-placement.mjs";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopDir, "../..");
const runtimeRoot = app.isPackaged ? process.resourcesPath : repoRoot;
const backendRoot = path.join(runtimeRoot, "backend");
app.setName("CandleScope");
if (process.env.CANDLESCOPE_DESKTOP_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.CANDLESCOPE_DESKTOP_USER_DATA));
}
app.setAppLogsPath(path.join(app.getPath("userData"), "logs"));
const multiWindowEnabled = process.env.MULTI_WINDOW_ENABLED === "1"
  || process.env.VITE_MULTI_WINDOW_ENABLED === "1";
let appUrl = process.env.CANDLESCOPE_DESKTOP_URL || "http://127.0.0.1:15173/";
let assetServer = null;
const managementSession = {
  sessionToken: randomBytes(32).toString("base64url"),
  csrfToken: randomBytes(32).toString("base64url"),
};
const backendPort = Number(process.env.CANDLESCOPE_DESKTOP_BACKEND_PORT || 18080);
const phase7Scenario = String(process.env.CANDLESCOPE_DESKTOP_PHASE7_SCENARIO || "W1").toUpperCase();
const phase8Output = process.env.CANDLESCOPE_DESKTOP_PHASE8_OUT || "";
const phase8Mode = String(process.env.CANDLESCOPE_DESKTOP_PHASE8_MODE || "W3").toUpperCase();
const phase8DurationMs = Math.max(1_000, Number(process.env.CANDLESCOPE_DESKTOP_PHASE8_DURATION_MS || 60_000));
const phase8SampleMs = Math.max(1_000, Number(process.env.CANDLESCOPE_DESKTOP_PHASE8_SAMPLE_MS || 5_000));
const phase8ReadyTimeoutMs = Math.max(10_000, Number(process.env.CANDLESCOPE_DESKTOP_PHASE8_READY_TIMEOUT_MS || 180_000));
const phase8RollbackStage = String(
  process.env.CANDLESCOPE_DESKTOP_PHASE8_ROLLBACK_STAGE || "",
).toUpperCase();
function instrumentedAppUrl() {
  const target = new URL(appUrl);
  if (phase8Output) target.searchParams.set("capacityProbe", "phase8");
  else if (process.env.CANDLESCOPE_DESKTOP_PHASE7_OUT) {
    target.searchParams.set("capacityProbe", "phase7");
  }
  return target.href;
}
if (phase8Output) app.commandLine.appendSwitch("js-flags", "--expose-gc");
const gotSingleInstanceLock = app.requestSingleInstanceLock({ source: "desktop-shell" });

let manager = null;
let supervisor = null;
let shutdownComplete = false;
let shutdownPromise = null;
let phase7TopologyArmed = false;
const workspaceBus = new WorkspaceBusHub();
const appWorkBudget = new AppWorkBudgetHub();
const seriesSnapshots = new SeriesSnapshotHub();
const registeredWorkspaceContents = new WeakSet();
const phase8RuntimeErrors = [];
const phase8DisplayEvents = { added: 0, removed: 0, metricsChanged: 0 };

function windowIdForSender(sender) {
  return manager?.windowIdForContents(sender) ?? null;
}

const trustedIpc = {
  handle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      manager.assertTrustedSender(event);
      return handler(event, ...args);
    });
  },
  on(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      try {
        manager.assertTrustedSender(event);
        handler(event, ...args);
      } catch { event.returnValue = { ok: false, code: "DESKTOP_SENDER_REJECTED" }; }
    });
  },
};

function registerWorkspaceSender(sender) {
  const windowId = windowIdForSender(sender);
  if (!windowId) throw new Error("WorkspaceBus sender is not a managed CandleScope window");
  if (!registeredWorkspaceContents.has(sender)) {
    registeredWorkspaceContents.add(sender);
    workspaceBus.register(windowId, (message) => {
      if (!sender.isDestroyed()) sender.send(DESKTOP_IPC.workspaceBusEvent, message);
    });
    sender.once("destroyed", () => {
      workspaceBus.disconnect(windowId);
      appWorkBudget.releaseWindow(windowId);
    });
  }
  return windowId;
}

function parseSidecarCommand() {
  const override = process.env.CANDLESCOPE_DESKTOP_SIDECAR_COMMAND_JSON;
  if (override) {
    const parsed = JSON.parse(override);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((part) => typeof part !== "string")) {
      throw new TypeError("CANDLESCOPE_DESKTOP_SIDECAR_COMMAND_JSON must be a JSON string array");
    }
    return { command: parsed[0], args: parsed.slice(1) };
  }
  return {
    command: process.env.CANDLESCOPE_PYTHON || "python",
    args: [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
    ],
  };
}

function createSupervisor() {
  if (process.env.CANDLESCOPE_DESKTOP_SKIP_SIDECAR === "1") return null;
  const command = parseSidecarCommand();
  return new SidecarSupervisor({
    ...command,
    cwd: backendRoot,
    env: {
      CANDLE_HOST: "127.0.0.1",
      CANDLE_PORT: String(backendPort),
      CORS_ORIGINS: new URL(appUrl).origin,
      CANDLESCOPE_PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS: new URL(appUrl).origin,
      CANDLESCOPE_DESKTOP_PLUGIN_SESSION: managementSession.sessionToken,
      CANDLESCOPE_DESKTOP_PLUGIN_CSRF: managementSession.csrfToken,
      PYTHONPATH: [
        path.join(runtimeRoot, "packages", "candlescope-plugin-sdk", "src"),
        process.env.PYTHONPATH,
      ].filter(Boolean).join(path.delimiter),
    },
    healthUrl: `http://127.0.0.1:${backendPort}/health`,
    healthTimeoutMs: Number(process.env.CANDLESCOPE_DESKTOP_SIDECAR_TIMEOUT_MS || 90_000),
    shutdownTimeoutMs: 15_000,
    logPath: path.join(app.getPath("logs"), "backend-sidecar.log"),
  });
}

function syntheticSpikeTopology(current, windowCount) {
  const primary = screen.getPrimaryDisplay();
  const width = Math.max(640, Math.floor(primary.workArea.width * 0.48));
  const height = Math.max(480, Math.floor(primary.workArea.height * 0.48));
  const ids = ["main-window", "window-2", "window-3", "window-4"].slice(0, windowCount);
  return {
    workspaceId: "workspace-default",
    workspaceRevision: Math.max(0, current.workspaceRevision + 1),
    expectedShellRevision: current.workspaceRevision,
    activeWindowId: "main-window",
    windows: Object.fromEntries(ids.map((id, index) => [id, {
      id,
      boundsDip: {
        x: primary.workArea.x + (index % 2) * Math.max(1, primary.workArea.width - width),
        y: primary.workArea.y + Math.floor(index / 2) * Math.max(1, primary.workArea.height - height),
        width,
        height,
      },
      monitorFingerprint: null,
      dpiScale: primary.scaleFactor,
      windowState: "normal",
    }])),
  };
}

async function exerciseNativeLifecycle() {
  const target = manager.windows.get("window-2") || manager.windows.get("main-window");
  if (!target) return { result: "fail", reason: "no-window" };
  target.minimize();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const minimized = {
    native: target.isMinimized(),
    rendererVisibility: await target.webContents.executeJavaScript("document.visibilityState"),
    schedulerVisible: await target.webContents.executeJavaScript(
      "window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot()?.scheduler?.windowVisible ?? null",
    ),
  };
  target.restore();
  target.show();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const restored = {
    native: !target.isMinimized() && target.isVisible(),
    rendererVisibility: await target.webContents.executeJavaScript("document.visibilityState"),
    schedulerVisible: await target.webContents.executeJavaScript(
      "window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot()?.scheduler?.windowVisible ?? null",
    ),
  };
  return {
    result: minimized.native
      && minimized.rendererVisibility === "hidden"
      && minimized.schedulerVisible === false
      && restored.native
      && restored.rendererVisibility === "visible"
      && restored.schedulerVisible === true
      ? "pass"
      : "fail",
    windowId: manager.windows.has("window-2") ? "window-2" : "main-window",
    minimized,
    restored,
  };
}

async function exerciseCloseIsolation(store) {
  const current = store.snapshot();
  const removableId = Object.keys(current.windows).find((windowId) => windowId !== "main-window");
  if (!removableId) return { result: "fail", reason: "no-secondary-window" };
  const saved = current.windows[removableId];
  const remaining = { ...current.windows };
  delete remaining[removableId];
  const removedRevision = current.workspaceRevision + 1;
  await manager.reconcile({
    workspaceId: current.workspaceId,
    workspaceRevision: removedRevision,
    expectedShellRevision: current.workspaceRevision,
    activeWindowId: "main-window",
    windows: remaining,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const peers = [];
  for (const [windowId, window] of manager.windows) {
    peers.push({
      windowId,
      alive: !window.isDestroyed(),
      canvasCount: await window.webContents.executeJavaScript("document.querySelectorAll('canvas').length"),
    });
  }
  await manager.reconcile({
    workspaceId: current.workspaceId,
    workspaceRevision: removedRevision + 1,
    expectedShellRevision: removedRevision,
    activeWindowId: "main-window",
    windows: { ...remaining, [removableId]: saved },
  });
  const restored = manager.windows.get(removableId);
  const readinessDeadline = Date.now() + 20_000;
  let restoredCanvasCount = 0;
  while (restored && Date.now() < readinessDeadline) {
    restoredCanvasCount = await restored.webContents.executeJavaScript(
      "document.querySelectorAll('canvas').length",
    );
    if (restoredCanvasCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    result: peers.length === 3
      && peers.every((peer) => peer.alive && peer.canvasCount > 0)
      && restoredCanvasCount > 0
      ? "pass"
      : "fail",
    removedWindowId: removableId,
    peers,
    restoredCanvasCount,
  };
}

async function writeSpikeEvidence(store, output, probeMode, lifecycle, closeIsolation) {
  if (!output) return;
  const observations = [];
  for (const [windowId, window] of manager.windows) {
    const readinessDeadline = Date.now() + 20_000;
    while (Date.now() < readinessDeadline) {
      const ready = await window.webContents.executeJavaScript(`Boolean(
        document.querySelectorAll('canvas').length > 0
        && document.querySelector('.right-market-rail')
        && document.querySelector('[data-drawing-action="export"]')
      )`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const renderer = await window.webContents.executeJavaScript(`({
      title: document.title,
      chartRoots: document.querySelectorAll('[data-chart-cell-id]').length,
      dataReadyRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-ready="true"]').length,
      canvasCount: document.querySelectorAll('canvas').length,
      hasRightRail: Boolean(document.querySelector('.right-market-rail')),
      hasExportControl: Boolean(document.querySelector('[data-drawing-action="export"]')),
      visibility: document.visibilityState,
      location: location.href
    })`);
    observations.push({
      windowId,
      boundsDip: window.getBounds(),
      normalBoundsDip: window.getNormalBounds(),
      minimized: window.isMinimized(),
      visible: window.isVisible(),
      renderer,
    });
  }
  const evidence = {
    schemaVersion: "candlescope.desktop-spike/1",
    generatedAt: new Date().toISOString(),
    result: observations.length === Number(process.env.CANDLESCOPE_DESKTOP_SPIKE_WINDOW_COUNT || 4)
      && observations.every((item) => item.renderer.canvasCount > 0
        && item.renderer.hasRightRail
        && item.renderer.hasExportControl)
      && (supervisor === null || supervisor.diagnostics().running)
      && lifecycle.result === "pass"
      && closeIsolation.result === "pass"
      ? "pass"
      : "fail",
    probeMode,
    selection: {
      selected: "Electron 43.3.0",
      rationale: "Existing Chromium renderer compatibility plus native single-instance, BrowserWindow, DIP display, and process supervision APIs",
      tauriConstraint: "Microsoft C++ Build Tools were not discoverable on the validation host",
    },
    shell: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      singleInstanceLock: app.hasSingleInstanceLock(),
      logsPath: app.getPath("logs"),
      userDataPath: app.getPath("userData"),
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      updatePolicy: "manual-release-artifact",
      state: store.snapshot(),
      ...manager.diagnostics(),
    },
    sidecar: supervisor?.diagnostics() || { skipped: true },
    lifecycle,
    closeIsolation,
    observations,
    limitations: screen.getAllDisplays().length < 4
      ? ["Host exposes fewer than four physical displays; placement algorithms use deterministic multi-DPI fixtures, while physical four-display validation remains pending."]
      : [],
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (evidence.result !== "pass") process.exitCode = 1;
}

async function waitForPhase7Condition(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Phase 7 condition timed out after ${timeoutMs} ms`);
}

async function phase7WindowObservation(windowId, window) {
  return {
    windowId,
    destroyed: window.isDestroyed(),
    renderer: await window.webContents.executeJavaScript(`({
      location: location.href,
      visibility: document.visibilityState,
      chartRoots: document.querySelectorAll('[data-chart-cell-id]').length,
      dataReadyRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-ready="true"]').length,
      chartIds: [...document.querySelectorAll('[data-chart-cell-id]')].map((node) => node.getAttribute('data-chart-cell-id')),
      canvasCount: document.querySelectorAll('canvas').length,
      broker: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.() ?? null,
      scheduler: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot()?.scheduler ?? null,
      link: window.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__?.snapshot?.() ?? null,
      workspace: window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.() ?? null
    })`),
  };
}

async function phase7BackendCapacity(detailLimit = 100) {
  const response = await fetch(
    `http://127.0.0.1:${backendPort}/debug/capacity?detail_limit=${detailLimit}`,
    // Capacity is a release diagnostic, not the user-facing ready path. A
    // four-window indicator burst can legitimately contend with its read-only
    // SQLite snapshot for more than two seconds; keep a hard bound without
    // aborting a multi-hour probe on ordinary diagnostic jitter.
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    throw new Error(`Phase 7 backend capacity returned HTTP ${response.status}`);
  }
  const raw = await response.json();
  return {
    schemaVersion: raw.schemaVersion ?? null,
    ok: raw.ok === true,
    limits: raw.limits ?? null,
    dataManager: raw.dataManager ?? null,
    klineBatch: raw.klineBatch ?? null,
    backfill: raw.backfill ?? null,
    indicators: raw.indicators ?? null,
    exchange: raw.exchange ?? null,
    runtime: raw.runtime ?? null,
  };
}

async function phase7W2Symbols(limit = 64) {
  const response = await fetch(
    `http://127.0.0.1:${backendPort}/api/v1/symbols/exchange-info?exchange=binance&market_type=spot&quote_asset=USDT`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error(`Phase 7 W2 symbol catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  const symbols = [...new Set((Array.isArray(payload?.symbols) ? payload.symbols : [])
    .map((item) => typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "")
    .filter(Boolean))].slice(0, limit);
  if (symbols.length !== limit) {
    throw new Error(`Phase 7 W2 needs ${limit} active Binance spot USDT symbols, received ${symbols.length}`);
  }
  return symbols;
}

function phase8ProductErrorSymbols(sample) {
  const symbols = new Set();
  for (const window of sample?.windows || []) {
    for (const message of window.renderer?.productErrors || []) {
      const match = String(message).match(/history unavailable for ([A-Z0-9_-]+)@/i);
      if (match?.[1]) symbols.add(match[1].toUpperCase());
    }
  }
  return symbols;
}

async function phase8WaitForWorkspaceBusQuiescence({
  stableMs = 1_500,
  timeoutMs = 30_000,
} = {}) {
  let signature = null;
  let stableSince = 0;
  await waitForPhase7Condition(async () => {
    if (manager.windows.size !== 4) return false;
    const states = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript("window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.() ?? null")
    )));
    const diagnostics = workspaceBus.diagnostics();
    const revisions = states.map((state) => state?.document?.revision ?? null);
    const healthy = states.length === 4
      && states.every((state) => state?.ready === true
        && state?.status?.saveState === "saved"
        && !state?.status?.error)
      && new Set(revisions).size === 1
      && diagnostics.participantCount === 4
      && diagnostics.pendingCrosshair === 0;
    if (!healthy) {
      signature = null;
      stableSince = 0;
      return false;
    }
    const nextSignature = JSON.stringify({
      sequence: diagnostics.sequence,
      revisions,
      writerWindowId: diagnostics.writerWindowId,
    });
    if (nextSignature !== signature) {
      signature = nextSignature;
      stableSince = Date.now();
      return false;
    }
    return Date.now() - stableSince >= stableMs;
  }, timeoutMs);
}

async function phase8ScenarioMatches(symbols, indicatorCount) {
  const expectedSymbols = [...symbols].sort();
  const matches = await Promise.all([...manager.windows.values()].map((window) => (
    window.webContents.executeJavaScript(`(() => {
      const document = window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().document;
      if (!document || Object.keys(document.cells || {}).length !== 64) return false;
      const cells = Object.values(document.cells);
      return JSON.stringify(cells.map((cell) => cell.session.symbol).sort())
          === ${JSON.stringify(JSON.stringify(expectedSymbols))}
        && cells.every((cell) => cell.session.interval === '1m'
          && (cell.indicators || []).length === ${Number(indicatorCount)});
    })()`)
  )));
  return matches.length === 4 && matches.every(Boolean);
}

async function phase8ApplyScenario(mainWindow, controlCall, symbols, indicatorCount, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await phase8WaitForWorkspaceBusQuiescence();
    await mainWindow.webContents.executeJavaScript(controlCall);
    try {
      await waitForPhase7Condition(
        () => phase8ScenarioMatches(symbols, indicatorCount),
        10_000,
      );
      await phase8WaitForWorkspaceBusQuiescence();
      if (await phase8ScenarioMatches(symbols, indicatorCount)) return;
      lastError = new Error(`${label} was superseded after reaching all four renderers`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} did not commit after three bounded CAS retries`, { cause: lastError });
}

async function phase8SelectHealthySymbols(mainWindow, candidates) {
  let selected = candidates.slice(0, 64);
  let replacementIndex = 64;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await phase8ApplyScenario(
      mainWindow,
      `window.__CANDLESCOPE_PHASE7_CONTROL__.configureHealth(${JSON.stringify(selected)})`,
      selected,
      0,
      "Phase 8 health selection",
    );
    const deadline = Date.now() + phase8ReadyTimeoutMs;
    let observation = null;
    let rejected = new Set();
    let exactIdentity = false;
    while (Date.now() < deadline) {
      observation = await phase8CollectSample(Date.now());
      rejected = phase8ProductErrorSymbols(observation);
      exactIdentity = phase8ExactW2Identity(observation);
      if (rejected.size > 0 || exactIdentity) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (rejected.size === 0 && !exactIdentity) {
      if (phase8Output) {
        await writeFile(
          `${phase8Output}.selection.latest.json`,
          `${JSON.stringify(observation, null, 2)}\n`,
          "utf8",
        );
      }
      throw new Error(`Phase 8 W2 identity did not converge while selecting symbols after ${phase8ReadyTimeoutMs} ms`);
    }
    if (rejected.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      observation = await phase8CollectSample(Date.now());
      rejected = phase8ProductErrorSymbols(observation);
    }
    if (rejected.size === 0) return selected;
    selected = selected.map((symbol) => {
      if (!rejected.has(symbol)) return symbol;
      while (replacementIndex < candidates.length && selected.includes(candidates[replacementIndex])) {
        replacementIndex += 1;
      }
      const replacement = candidates[replacementIndex];
      replacementIndex += 1;
      if (!replacement) {
        throw new Error(`Phase 8 exhausted healthy symbol candidates after rejecting ${[...rejected].join(",")}`);
      }
      return replacement;
    });
  }
  throw new Error("Phase 8 could not find 64 product-error-free Binance spot symbols");
}

async function runPhase7Evidence(store, output) {
  if (phase7Scenario !== "W1" && phase7Scenario !== "W2") {
    throw new Error(`Unsupported Phase 7 scenario: ${phase7Scenario}`);
  }
  const topology = syntheticSpikeTopology(store.snapshot(), 4);
  await manager.reconcile(topology);
  const mainWindow = await waitForPhase7Condition(() => {
    const candidate = manager.windows.get("main-window");
    return candidate && !candidate.isDestroyed() ? candidate : null;
  });
  await waitForPhase7Condition(() => mainWindow.webContents.executeJavaScript(
    "Boolean(window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().ready)",
  ));
  phase7TopologyArmed = true;
  await mainWindow.webContents.executeJavaScript("window.__CANDLESCOPE_PHASE7_CONTROL__.configure64()");
  await waitForPhase7Condition(async () => {
    if (manager.windows.size !== 4) return false;
    const counts = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript("document.querySelectorAll('[data-chart-cell-id]').length")
    )));
    return counts.every((count) => count === 16);
  }, 60_000);
  if (phase7Scenario === "W2") {
    const symbols = await waitForPhase7Condition(() => phase7W2Symbols(), 60_000);
    await mainWindow.webContents.executeJavaScript(
      `window.__CANDLESCOPE_PHASE7_CONTROL__.configureW2(${JSON.stringify(symbols)})`,
    );
    await waitForPhase7Condition(() => mainWindow.webContents.executeJavaScript(`(() => {
      const document = window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().document;
      if (!document || Object.keys(document.cells || {}).length !== 64) return false;
      const cells = Object.values(document.cells);
      return new Set(cells.map((cell) => cell.session.symbol)).size === 64
        && cells.every((cell) => cell.session.interval === '1m');
    })()`), 30_000);
  }
  await waitForPhase7Condition(async () => {
    const revisions = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript(
        "window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().document?.revision ?? -1",
      )
    )));
    const busRevision = Object.values(workspaceBus.diagnostics().revisions)[0] ?? -1;
    return revisions.length === 4
      && revisions.every((revision) => revision === revisions[0])
      && revisions[0] === busRevision;
  }, 30_000);
  let latestConnectionAccounting = null;
  const expectedSubscriptionsPerWindow = phase7Scenario === "W1" ? 32 : 16;
  const expectedLogicalSubscriptions = phase7Scenario === "W1" ? 128 : 64;
  const expectedActiveSeries = phase7Scenario === "W1" ? 5 : 64;
  try {
    await waitForPhase7Condition(async () => {
      const frontendStreams = await Promise.all([...manager.windows].map(([windowId, window]) => (
        window.webContents.executeJavaScript(`({
          windowId: ${JSON.stringify(windowId)},
          open: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().klineStream?.open === true,
          physical: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().klineStream?.physicalStreams ?? -1,
          logical: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().klineStream?.logicalSubscribers ?? -1,
          subscriptions: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().klineStream?.logicalSubscriptions ?? -1
        })`)
      )));
      const capacity = await phase7BackendCapacity();
      latestConnectionAccounting = {
        frontendStreams,
        backend: capacity.klineBatch,
        dataManager: capacity.dataManager,
      };
      return frontendStreams.every((stream) => (
        stream.open && stream.physical === 1 && stream.logical === 16
        && stream.subscriptions === expectedSubscriptionsPerWindow
      ))
        && capacity.limits?.klineBatchEnabled === true
        && capacity.klineBatch?.websocket_connections === 4
        && capacity.klineBatch?.logical_clients === 64
        && capacity.klineBatch?.logical_series === 64
        && capacity.klineBatch?.logical_subscriptions === expectedLogicalSubscriptions
        && capacity.dataManager?.activeSeries === expectedActiveSeries
        && capacity.dataManager?.leasedSeries === expectedActiveSeries;
    }, 60_000);
  } catch (error) {
    throw new Error(
      `Phase 7 ${phase7Scenario} connection accounting did not converge: ${JSON.stringify(latestConnectionAccounting)}`,
      { cause: error },
    );
  }
  let recoveryWindowId = null;
  let dataReadiness = null;
  try {
    await waitForPhase7Condition(async () => {
      const windows = await Promise.all([...manager.windows].map(([windowId, window]) => (
        window.webContents.executeJavaScript(`(() => {
          const roots = [...document.querySelectorAll('[data-chart-cell-id]')];
          const documentSnapshot = window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().document;
          const readyCellIds = roots
            .filter((node) => node.getAttribute('data-market-data-ready') === 'true')
            .map((node) => node.getAttribute('data-chart-cell-id'));
          const ready = new Set(readyCellIds);
          return {
            windowId: ${JSON.stringify(windowId)},
            readyCount: readyCellIds.length,
            readyCellIds,
            missing: roots
              .map((node) => node.getAttribute('data-chart-cell-id'))
              .filter((cellId) => !ready.has(cellId))
              .map((cellId) => ({
                cellId,
                symbol: documentSnapshot?.cells?.[cellId]?.session?.symbol ?? null,
                interval: documentSnapshot?.cells?.[cellId]?.session?.interval ?? null
              })),
            sharedSeries: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().sharedSeries ?? null
          };
        })()`)
      )));
      const hub = seriesSnapshots.diagnostics();
      const secondaryReady = windows.find((item) => (
        item.windowId !== "main-window" && item.readyCount === 16
      ));
      dataReadiness = { windows, hub };
      if (phase7Scenario === "W1") {
        recoveryWindowId = secondaryReady?.windowId ?? null;
        return windows.every((item) => item.readyCount === 16)
          && hub.entries === 4
          && recoveryWindowId;
      }
      recoveryWindowId = secondaryReady?.windowId ?? null;
      return recoveryWindowId && hub.entries >= 16;
    }, 120_000);
  } catch (error) {
    throw new Error(
      `Phase 7 ${phase7Scenario} shared-series recovery target did not converge: ${JSON.stringify(dataReadiness)}`,
      { cause: error },
    );
  }

  const beforeLink = await Promise.all([...manager.windows].map(([windowId, window]) => (
    phase7WindowObservation(windowId, window)
  )));
  const mainSnapshot = beforeLink.find((item) => item.windowId === "main-window")?.renderer.workspace;
  const sourceCellId = mainSnapshot?.document?.windows?.["main-window"]?.activeCellId;
  await mainWindow.webContents.executeJavaScript(
    `window.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__?.publishCrosshair(${JSON.stringify(sourceCellId)}, 1700000000)`,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterLink = await Promise.all([...manager.windows].map(([windowId, window]) => (
    phase7WindowObservation(windowId, window)
  )));
  const backendCapacity = await phase7BackendCapacity();

  const minimizedTarget = [...manager.windows].find(([windowId]) => windowId === recoveryWindowId);
  if (!minimizedTarget) throw new Error("Phase 7 requires a secondary window");
  minimizedTarget[1].minimize();
  await waitForPhase7Condition(async () => {
    const observation = await phase7WindowObservation(minimizedTarget[0], minimizedTarget[1]);
    const scheduler = observation.renderer.scheduler;
    return scheduler?.windowVisible === false
      && scheduler?.pendingFrames === 0
      && !appWorkBudget.diagnostics().previewLanes.some((lane) => lane.windowId === minimizedTarget[0]);
  }, 60_000);
  const minimizedBeforeIdle = await phase7WindowObservation(minimizedTarget[0], minimizedTarget[1]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const minimized = await phase7WindowObservation(minimizedTarget[0], minimizedTarget[1]);
  const minimizedBudget = appWorkBudget.diagnostics();
  const replaceableCommitCount = (observation) => (observation.renderer.scheduler?.cells || [])
    .reduce((total, cell) => total
      + Number(cell.committed?.["indicator-preview"] || 0)
      + Number(cell.committed?.["kline-forming"] || 0), 0);
  const minimizedActivity = {
    replaceableCommitsBefore: replaceableCommitCount(minimizedBeforeIdle),
    replaceableCommitsAfter: replaceableCommitCount(minimized),
    previewLanePresent: minimizedBudget.previewLanes.some((lane) => lane.windowId === minimizedTarget[0]),
  };
  minimizedTarget[1].restore();
  minimizedTarget[1].show();
  await waitForPhase7Condition(() => (
    store.snapshot().windows[minimizedTarget[0]]?.windowState === "normal"
  ));

  const crashWindowId = minimizedTarget[0];
  minimizedTarget[1].destroy();
  await waitForPhase7Condition(() => workspaceBus.diagnostics().participantCount === 3);
  const afterCrash = {
    workspaceBus: workspaceBus.diagnostics(),
    appWork: appWorkBudget.diagnostics(),
    seriesSnapshots: seriesSnapshots.diagnostics(),
  };
  const saved = store.snapshot().windows[crashWindowId];
  if (!saved) throw new Error(`Missing saved placement for ${crashWindowId}`);
  await manager.createWindow(store.snapshot().workspaceId, saved);
  await waitForPhase7Condition(async () => {
    const restored = manager.windows.get(crashWindowId);
    if (!restored || restored.isDestroyed()) return false;
    const restoredState = await restored.webContents.executeJavaScript(`({
      chartRoots: document.querySelectorAll('[data-chart-cell-id]').length,
      dataReadyRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-ready="true"]').length,
      dataSettledRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-settled="true"]').length,
      canvasCount: document.querySelectorAll('canvas').length,
      workspace: window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.() ?? null
    })`);
    const busRevision = Object.values(workspaceBus.diagnostics().revisions)[0] ?? -1;
    return restoredState.chartRoots === 16
      && restoredState.dataReadyRoots === 16
      && restoredState.canvasCount > 0
      && restoredState.workspace?.ready === true
      && restoredState.workspace?.document?.revision === busRevision
      && appWorkBudget.diagnostics().previewLanes.some((lane) => lane.windowId === crashWindowId);
  }, 60_000);
  const restored = await phase7WindowObservation(crashWindowId, manager.windows.get(crashWindowId));
  const finalBudget = {
    workspaceBus: workspaceBus.diagnostics(),
    appWork: appWorkBudget.diagnostics(),
    seriesSnapshots: seriesSnapshots.diagnostics(),
  };
  const finalSnapshot = restored.renderer.workspace?.document || mainSnapshot?.document;
  const cellIds = finalSnapshot ? Object.keys(finalSnapshot.cells || {}) : [];
  const allWindowsReady = afterLink.length === 4
    && afterLink.every((item) => item.renderer.chartRoots === 16 && item.renderer.canvasCount > 0);
  const linkDeliveredToSecondaries = afterLink
    .filter((item) => item.windowId !== "main-window")
    .every((item, index) => (
      (item.renderer.link?.counts?.crosshairPublishes || 0)
      > (beforeLink.filter((before) => before.windowId !== "main-window")[index]?.renderer.link?.counts?.crosshairPublishes || 0)
    ));
  const gates = {
    fourWindowsSixteenCells: allWindowsReady ? "pass" : "fail",
    uniqueSixtyFourCellIds: cellIds.length === 64 && new Set(cellIds).size === 64 ? "pass" : "fail",
    oneWorkspaceRevision: afterLink.every((item) => (
      item.renderer.workspace?.document?.revision === afterLink[0]?.renderer.workspace?.document?.revision
    )) ? "pass" : "fail",
    crossWindowLink: linkDeliveredToSecondaries ? "pass" : "fail",
    scenarioIdentityAccounting: beforeLink.every((item) => (
      item.renderer.broker?.klineStream?.open === true
      && item.renderer.broker?.klineStream?.physicalStreams === 1
      && item.renderer.broker?.klineStream?.logicalSubscribers === 16
      && item.renderer.broker?.klineStream?.logicalSubscriptions === expectedSubscriptionsPerWindow
    ))
      && backendCapacity.limits?.klineBatchEnabled === true
      && backendCapacity.klineBatch?.websocket_connections === 4
      && backendCapacity.klineBatch?.logical_clients === 64
      && backendCapacity.klineBatch?.logical_series === 64
      && backendCapacity.klineBatch?.logical_subscriptions === expectedLogicalSubscriptions
      && backendCapacity.dataManager?.activeSeries === expectedActiveSeries
      && backendCapacity.dataManager?.leasedSeries === expectedActiveSeries
      ? "pass" : "fail",
    minimizedWorkZero: minimized.renderer.scheduler?.windowVisible === false
      && minimized.renderer.scheduler?.pendingFrames === 0
      && minimizedActivity.previewLanePresent === false
      && minimizedActivity.replaceableCommitsAfter === minimizedActivity.replaceableCommitsBefore
      ? "pass" : "fail",
    crashLeaseCleanup: afterCrash.workspaceBus.participantCount === 3
      && !afterCrash.appWork.previewLanes.some((lane) => lane.windowId === crashWindowId) ? "pass" : "fail",
    sameWindowIdRecovery: restored.windowId === crashWindowId
      && restored.renderer.chartRoots === 16
      && restored.renderer.dataReadyRoots === 16
      && restored.renderer.canvasCount > 0
      && restored.renderer.broker?.sharedSeries?.hydrations >= 1
      && restored.renderer.broker?.sharedSeries?.hydratedBars > 0
      && restored.renderer.workspace?.ready === true
      && restored.renderer.workspace?.document?.revision
        === finalBudget.workspaceBus.revisions[restored.renderer.workspace?.workspaceId]
      && finalBudget.appWork.previewLanes.some((lane) => lane.windowId === crashWindowId)
      ? "pass" : "fail",
    appBudgetBounded: finalBudget.appWork.maxPreviewLanes === 4
      && finalBudget.appWork.maxConcurrent === 16
      && finalBudget.workspaceBus.participantCount === 4 ? "pass" : "fail",
  };
  const evidence = {
    schemaVersion: "candlescope.multi-chart.phase7/1",
    generatedAt: new Date().toISOString(),
    result: Object.values(gates).every((gate) => gate === "pass") ? "pass" : "fail",
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      updatePolicy: "manual-release-artifact",
      userData: app.getPath("userData"),
      displayCount: screen.getAllDisplays().length,
      backendPort,
      scenario: phase7Scenario,
    },
    gates,
    beforeLink,
    afterLink,
    backendCapacity,
    dataReadiness,
    minimized: { observation: minimized, activity: minimizedActivity, appWork: minimizedBudget },
    crash: { windowId: crashWindowId, afterCrash, restored },
    finalBudget,
    sidecar: supervisor?.diagnostics() || { skipped: true },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (evidence.result !== "pass") process.exitCode = 1;
}

const phase8ObservedContents = new WeakSet();

function observePhase8Runtime(windowId, window) {
  const contents = window.webContents;
  if (phase8ObservedContents.has(contents)) return;
  phase8ObservedContents.add(contents);
  contents.on("console-message", (details) => {
    const level = details?.level;
    const message = details?.message;
    const line = details?.lineNumber;
    const sourceId = details?.sourceId;
    const label = String(level ?? "").toLowerCase();
    const numeric = Number(level);
    if (label !== "error" && label !== "fatal" && !(Number.isFinite(numeric) && numeric >= 3)) return;
    phase8RuntimeErrors.push({ type: "console", windowId, level, message, line, sourceId });
  });
  contents.on("render-process-gone", (_event, details) => {
    phase8RuntimeErrors.push({ type: "render-process-gone", windowId, details });
  });
  contents.on("unresponsive", () => phase8RuntimeErrors.push({ type: "unresponsive", windowId }));
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3 || !isMainFrame) return;
    phase8RuntimeErrors.push({ type: "did-fail-load", windowId, errorCode, errorDescription, validatedURL });
  });
}

async function phase8RendererObservation(windowId, window, {
  compact = false,
  includeCumulativeMetrics = true,
} = {}) {
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const broker = window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.(${compact ? "{ compact: true }" : ""}) ?? null;
    const rawMetrics = window.__CANDLESCOPE_PHASE7_CONTROL__?.metrics?.() ?? null;
    const rawWorkspace = window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.() ?? null;
    const chartNodes = [...document.querySelectorAll('[data-chart-cell-id]')];
    const indicatorSnapshot = ${compact
      ? "null"
      : "window.__CANDLESCOPE_INDICATOR_MONITOR__?.snapshot?.() ?? { runtimes: [] }"};
    const runtimes = indicatorSnapshot?.runtimes || [];
    const statusCounts = {};
    let definitionCount = 0;
    let issueCount = 0;
    const issueSamples = [];
    for (const runtime of runtimes) {
      issueCount += (runtime.issues || []).length;
      for (const issue of runtime.issues || []) {
        if (issueSamples.length < 10) issueSamples.push({ cellId: runtime.cellId, issue });
      }
      for (const indicator of runtime.indicators || []) {
        definitionCount += 1;
        statusCounts[indicator.status] = (statusCounts[indicator.status] || 0) + 1;
      }
    }
    const compactIndicatorDefinitionCount = chartNodes.reduce((sum, node) => {
      const cellId = node.getAttribute('data-chart-cell-id');
      return sum + Number(rawWorkspace?.document?.cells?.[cellId]?.indicators?.length || 0);
    }, 0);
    return {
      windowId: ${JSON.stringify(windowId)},
      chartRoots: chartNodes.length,
      dataReadyRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-ready="true"]').length,
      dataSettledRoots: document.querySelectorAll('[data-chart-cell-id][data-market-data-settled="true"]').length,
      canvasCount: document.querySelectorAll('canvas').length,
      visibility: document.visibilityState,
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      metrics: ${includeCumulativeMetrics ? "rawMetrics" : `rawMetrics ? {
        durationMs: rawMetrics.durationMs,
        longTaskCount: rawMetrics.longTasks?.length ?? 0,
        inputCount: rawMetrics.inputLatencies?.length ?? 0
      } : null`},
      workspace: rawWorkspace ? {
        workspaceId: rawWorkspace.workspaceId,
        document: rawWorkspace.document ? {
          schemaVersion: rawWorkspace.document.schemaVersion,
          revision: rawWorkspace.document.revision,
          activeWindowId: rawWorkspace.document.activeWindowId,
          cellCount: Object.keys(rawWorkspace.document.cells || {}).length,
          windowCount: Object.keys(rawWorkspace.document.windows || {}).length
        } : null,
        windowId: rawWorkspace.windowId,
        ready: rawWorkspace.ready,
        status: rawWorkspace.status
      } : null,
      broker,
      scheduler: ${compact ? `broker?.scheduler ? {
        activeAsync: broker.scheduler.activeAsync,
        activeHydration: broker.scheduler.activeHydration,
        disposed: broker.scheduler.disposed,
        pendingAsync: broker.scheduler.pendingAsync,
        pendingFrames: broker.scheduler.pendingFrames,
        windowVisible: broker.scheduler.windowVisible
      } : null` : "broker?.scheduler ?? null"},
      authoritativeCommits: Number(broker?.authoritativeCommits || 0)
        || (broker?.scheduler?.cells || []).reduce(
          (sum, cell) => sum + Number(cell.committed?.['authoritative-final'] || 0),
          0
        ),
      indicators: ${compact ? `{
        runtimeCount: chartNodes.length,
        definitionCount: compactIndicatorDefinitionCount,
        issueCount: 0,
        statusCounts: {},
        issueSamples: []
      }` : `{
        runtimeCount: runtimes.length,
        definitionCount,
        issueCount,
        statusCounts,
        issueSamples
      }`},
      productErrors: [...document.querySelectorAll('.error-message, .chart-error')]
        .map((node) => node.textContent?.trim()).filter(Boolean)
    };
  })()`);
  const pid = window.webContents.getOSProcessId();
  const memory = app.getAppMetrics().find((metric) => metric.pid === pid)?.memory || {};
  return {
    windowId,
    process: {
      pid,
      privateBytes: Number(memory.privateBytes || 0) * 1024,
      workingSetBytes: Number(memory.workingSetSize || 0) * 1024,
      peakWorkingSetBytes: Number(memory.peakWorkingSetSize || 0) * 1024,
    },
    renderer,
  };
}

async function phase8CollectWindowState(options = {}) {
  return Promise.all([...manager.windows].map(([windowId, window]) => (
    phase8RendererObservation(windowId, window, options)
  )));
}

async function phase8CollectSample(startedAt, {
  compact = false,
  includeCumulativeMetrics = true,
  backendDetailLimit = 4,
} = {}) {
  const [windows, backend] = await Promise.all([
    phase8CollectWindowState({ compact, includeCumulativeMetrics }),
    phase7BackendCapacity(backendDetailLimit),
  ]);
  return {
    atMs: Date.now() - startedAt,
    capturedAt: new Date().toISOString(),
    windows,
    backend,
    appMetrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpuPercent: metric.cpu?.percentCPUUsage ?? null,
      memory: metric.memory ?? null,
    })),
    budgets: {
      workspaceBus: workspaceBus.diagnostics(),
      appWork: appWorkBudget.diagnostics(),
      seriesSnapshots: seriesSnapshots.diagnostics(),
    },
    runtimeErrors: phase8RuntimeErrors.slice(),
  };
}

function phase8ExactW3Identity(sample) {
  const batch = sample?.backend?.klineBatch;
  const dataManager = sample?.backend?.dataManager;
  return sample?.windows?.length === 4
    && sample.windows.every((window) => (
      window.renderer.chartRoots === 16
      && window.renderer.dataReadyRoots === 16
      && window.renderer.broker?.klineStream?.open === true
      && window.renderer.broker?.klineStream?.physicalStreams === 1
      && window.renderer.broker?.klineStream?.logicalSubscribers === 16
      && window.renderer.broker?.klineStream?.logicalSubscriptions === 16
      && window.renderer.broker?.klineStream?.activeLogicalSubscriptions === 16
      && window.renderer.indicators?.runtimeCount === 16
      && window.renderer.indicators?.definitionCount === 32
      && window.renderer.indicators?.issueCount === 0
    ))
    && batch?.websocket_connections === 4
    && batch?.logical_clients === 64
    && batch?.logical_series === 64
    && batch?.logical_subscriptions === 64
    && dataManager?.activeSeries === 64
    && dataManager?.leasedSeries === 64
    && dataManager?.streamLeases === 64
    && dataManager?.uniqueLeaseConsumers === 64;
}

function phase8ExactW2Identity(sample) {
  const batch = sample?.backend?.klineBatch;
  const dataManager = sample?.backend?.dataManager;
  return sample?.windows?.length === 4
    && sample.windows.every((window) => (
      window.renderer.chartRoots === 16
      && window.renderer.dataReadyRoots === 16
      && window.renderer.broker?.klineStream?.open === true
      && window.renderer.broker?.klineStream?.physicalStreams === 1
      && window.renderer.broker?.klineStream?.logicalSubscribers === 16
      && window.renderer.broker?.klineStream?.logicalSubscriptions === 16
      && window.renderer.broker?.klineStream?.activeLogicalSubscriptions === 16
    ))
    && batch?.websocket_connections === 4
    && batch?.logical_clients === 64
    && batch?.logical_series === 64
    && batch?.logical_subscriptions === 64
    && dataManager?.activeSeries === 64
    && dataManager?.leasedSeries === 64
    && dataManager?.streamLeases === 64
    && dataManager?.uniqueLeaseConsumers === 64;
}

function phase8DataPlaneIdle(sample) {
  return (sample?.windows || []).every((window) => (
    Number(window.renderer?.scheduler?.activeAsync || 0) === 0
    && Number(window.renderer?.scheduler?.pendingAsync || 0) === 0
    && Number(window.renderer?.scheduler?.pendingFrames || 0) === 0
    && Number(window.renderer?.broker?.klineHttp?.logicalInflight || 0) === 0
    && Number(window.renderer?.broker?.klineHttp?.physicalInflight || 0) === 0
  ))
    && Number(sample?.backend?.backfill?.activeRequests || 0) === 0
    && Number(sample?.backend?.backfill?.pendingRequests || 0) === 0;
}

async function phase8WaitForHotStability(
  timeoutMs = phase8Mode === "SOAK" ? 300_000 : phase8ReadyTimeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = null;
  let stableIntervals = 0;
  const requiredStableIntervals = phase8Mode === "SOAK" ? 30 : 5;
  while (Date.now() < deadline) {
    const sample = await phase8CollectSample(Date.now());
    const idle = phase8ExactW3Identity(sample) && sample.windows.every((window) => (
      Number(window.renderer.dataSettledRoots || 0) === 16
    )) && phase8DataPlaneIdle(sample);
    const signature = idle ? JSON.stringify({
      backfillCompleted: Number(sample.backend?.klineBatch?.sent_by_type?.backfill_completed || 0),
      windows: sample.windows.map((window) => ({
        statusCounts: window.renderer.indicators?.statusCounts,
        seriesStores: window.renderer.broker?.seriesStores,
        schedulerCommits: (window.renderer.scheduler?.cells || []).map((cell) => ({
          cellId: cell.cellId,
          initialHistory: Number(cell.committed?.["initial-history"] || 0),
          loadMore: Number(cell.committed?.["load-more"] || 0),
          hydration: Number(cell.committed?.["active-hydration"] || 0),
        })),
      })),
    }) : null;
    if (signature !== null && signature === previousSignature) stableIntervals += 1;
    else stableIntervals = 0;
    if (stableIntervals >= requiredStableIntervals) return sample;
    previousSignature = signature;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Phase 8 W3 hot state did not stabilize after ${timeoutMs} ms`);
}

async function phase8CollectRendererGarbage() {
  await Promise.all([...manager.windows.values()].map((window) => (
    window.webContents.executeJavaScript(`(() => {
      globalThis.gc?.();
      return true;
    })()`)
  )));
}

async function phase8WaitForBackendMemoryPlateau({
  minimumDurationMs = 10 * 60_000,
  timeoutMs = 30 * 60_000,
  sampleMs = 60_000,
  rollingSamples = 5,
} = {}) {
  if (phase8Mode !== "SOAK") {
    return { result: "not-required", durationMs: 0, samples: [], plateau: null };
  }
  const startedAt = Date.now();
  const samples = [];
  while (Date.now() - startedAt <= timeoutMs) {
    const sample = await phase8CollectSample(startedAt, {
      compact: true,
      includeCumulativeMetrics: false,
      backendDetailLimit: 0,
    });
    const privateBytes = Number(sample.backend?.runtime?.processMemory?.privateBytes || 0);
    const identity = phase8ExactW3Identity(sample);
    const idle = phase8DataPlaneIdle(sample);
    const errorCount = sample.runtimeErrors.length
      + sample.windows.reduce((sum, window) => (
        sum + Number(window.renderer?.productErrors?.length || 0)
      ), 0);
    samples.push({
      atMs: sample.atMs,
      privateBytes,
      cacheSeries: Number(sample.backend?.dataManager?.cacheSeries || 0),
      identity,
      idle,
      errorCount,
    });
    const elapsedMs = Date.now() - startedAt;
    const rolling = samples.slice(-rollingSamples);
    const plateau = analyzeMemoryWarmupPlateau(
      rolling.map((entry) => entry.privateBytes),
      { minSamples: rollingSamples, maxSpreadPercent: 5, maxTrendPercent: 5 },
    );
    const pass = elapsedMs >= minimumDurationMs
      && identity
      && idle
      && errorCount === 0
      && rolling.every((entry) => entry.identity && entry.idle && entry.errorCount === 0)
      && plateau.pass;
    if (phase8Output) {
      await writeFile(`${phase8Output}.warmup`, `${JSON.stringify({
        schemaVersion: "candlescope.multi-chart.phase8-memory-warmup/1",
        result: pass ? "pass" : "pending",
        durationMs: elapsedMs,
        samples,
        plateau,
      })}\n`, "utf8");
    }
    if (pass) {
      return { result: "pass", durationMs: elapsedMs, samples, plateau };
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  const rolling = samples.slice(-rollingSamples);
  const failedPlateau = analyzeMemoryWarmupPlateau(
    rolling.map((entry) => entry.privateBytes),
    { minSamples: rollingSamples, maxSpreadPercent: 5, maxTrendPercent: 5 },
  );
  if (phase8Output) {
    await writeFile(`${phase8Output}.warmup`, `${JSON.stringify({
      schemaVersion: "candlescope.multi-chart.phase8-memory-warmup/1",
      result: "fail",
      durationMs: Date.now() - startedAt,
      samples,
      plateau: failedPlateau,
    })}\n`, "utf8");
  }
  throw new Error(`Phase 8 backend memory did not reach a bounded plateau: ${JSON.stringify({
    durationMs: Date.now() - startedAt,
    samples: rolling,
    plateau: failedPlateau,
  })}`);
}

async function phase8ResetMetricsAndCollectGarbage() {
  await Promise.all([...manager.windows.values()].map((window) => (
    window.webContents.executeJavaScript("window.__CANDLESCOPE_PHASE7_CONTROL__?.resetMetrics?.()")
  )));
  await phase8CollectRendererGarbage();
}

async function phase8ExerciseInputs() {
  for (const window of manager.windows.values()) {
    if (window.isDestroyed() || window.isMinimized()) continue;
    window.show();
    window.focus();
    window.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const point = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-chart-cell-id]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(24, rect.height / 2)) };
    })()`);
    if (!point) continue;
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function phase8ArrangeVisibleWindows() {
  const entries = [...manager.windows];
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  for (let index = 0; index < entries.length; index += 1) {
    const [, window] = entries[index];
    let bounds;
    if (displays.length >= entries.length) {
      const area = displays[index].workArea;
      bounds = { x: area.x, y: area.y, width: area.width, height: area.height };
    } else {
      const area = primary.workArea;
      const width = Math.floor(area.width / 2);
      const height = Math.floor(area.height / 2);
      bounds = {
        x: area.x + (index % 2) * width,
        y: area.y + Math.floor(index / 2) * height,
        width: index % 2 === 0 ? width : area.width - width,
        height: index < 2 ? height : area.height - height,
      };
    }
    window.setBounds(bounds);
    window.show();
  }
  entries.at(-1)?.[1]?.focus();
  await waitForPhase7Condition(async () => {
    const states = await Promise.all(entries.map(([, window]) => window.webContents.executeJavaScript(`({
      visibility: document.visibilityState,
      schedulerVisible: window.__CANDLESCOPE_WINDOW_BROKER__?.snapshot?.().scheduler?.windowVisible ?? null
    })`)));
    return states.every((state) => state.visibility === "visible" && state.schedulerVisible === true);
  }, 20_000);
}

async function phase8CaptureScreenshot(output, suffix) {
  const mainWindow = manager.windows.get("main-window") || manager.windows.values().next().value;
  if (!mainWindow) return null;
  const screenshotPath = output.replace(/\.json$/i, `-${suffix}.png`);
  const image = await mainWindow.webContents.capturePage();
  await writeFile(screenshotPath, image.toPNG());
  return screenshotPath;
}

async function phase8PrepareW3(store) {
  const topology = syntheticSpikeTopology(store.snapshot(), 4);
  await manager.reconcile(topology);
  manager.windows.forEach((window, windowId) => observePhase8Runtime(windowId, window));
  const mainWindow = await waitForPhase7Condition(() => {
    const candidate = manager.windows.get("main-window");
    return candidate && !candidate.isDestroyed() ? candidate : null;
  });
  await waitForPhase7Condition(async () => {
    if (manager.windows.size !== 4) return false;
    const ready = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript("Boolean(window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().ready)")
    )));
    return ready.every(Boolean);
  }, 60_000);
  phase7TopologyArmed = true;
  await mainWindow.webContents.executeJavaScript("window.__CANDLESCOPE_PHASE7_CONTROL__.configure64()");
  await waitForPhase7Condition(async () => {
    if (manager.windows.size !== 4) return false;
    const counts = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript("document.querySelectorAll('[data-chart-cell-id]').length")
    )));
    return counts.every((count) => count === 16);
  }, 60_000);
  await phase8ArrangeVisibleWindows();
  await phase8WaitForWorkspaceBusQuiescence();
  let candidates;
  if (process.env.CANDLESCOPE_DESKTOP_PHASE8_SYMBOLS_JSON) {
    const pinned = JSON.parse(process.env.CANDLESCOPE_DESKTOP_PHASE8_SYMBOLS_JSON);
    if (!Array.isArray(pinned)
      || pinned.length < 64
      || pinned.length > 128
      || pinned.some((symbol) => typeof symbol !== "string" || !symbol.trim())
      || new Set(pinned).size !== pinned.length) {
      throw new Error("CANDLESCOPE_DESKTOP_PHASE8_SYMBOLS_JSON must contain 64-128 unique symbols");
    }
    candidates = pinned;
  } else {
    candidates = await waitForPhase7Condition(() => phase7W2Symbols(128), 60_000);
  }
  const symbols = await phase8SelectHealthySymbols(mainWindow, candidates);
  const configuredAt = Date.now();
  await phase8ApplyScenario(
    mainWindow,
    `window.__CANDLESCOPE_PHASE7_CONTROL__.configureW3(${JSON.stringify(symbols)})`,
    symbols,
    2,
    "Phase 8 W3 configuration",
  );
  await waitForPhase7Condition(() => mainWindow.webContents.executeJavaScript(`(() => {
    const document = window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().document;
    if (!document || Object.keys(document.cells || {}).length !== 64) return false;
    const cells = Object.values(document.cells);
    return new Set(cells.map((cell) => cell.session.symbol)).size === 64
      && cells.every((cell) => cell.session.interval === '1m' && cell.indicators?.length === 2);
  })()`), 60_000);
  let latest = null;
  try {
    await waitForPhase7Condition(async () => {
      latest = await phase8CollectSample(configuredAt);
      return phase8ExactW3Identity(latest);
    }, phase8ReadyTimeoutMs);
  } catch (error) {
    const summary = latest ? {
      windows: latest.windows.map((window) => ({
        windowId: window.windowId,
        chartRoots: window.renderer.chartRoots,
        dataReadyRoots: window.renderer.dataReadyRoots,
        kline: window.renderer.broker?.klineStream,
        indicators: window.renderer.indicators,
        scheduler: {
          activeAsync: window.renderer.scheduler?.activeAsync,
          pendingAsync: window.renderer.scheduler?.pendingAsync,
          pendingFrames: window.renderer.scheduler?.pendingFrames,
        },
        productErrors: window.renderer.productErrors,
      })),
      backend: {
        dataManager: latest.backend.dataManager,
        klineBatch: latest.backend.klineBatch,
        indicators: latest.backend.indicators,
      },
      runtimeErrors: latest.runtimeErrors,
    } : null;
    if (phase8Output) {
      await writeFile(`${phase8Output}.latest.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }
    throw new Error(`Phase 8 W3 identity did not converge: ${JSON.stringify(summary)}`, { cause: error });
  }
  const readyMs = Date.now() - configuredAt;
  try {
    await phase8WaitForHotStability();
  } catch (error) {
    const hot = await phase8CollectSample(configuredAt).catch(() => null);
    if (phase8Output) {
      await writeFile(`${phase8Output}.latest.json`, `${JSON.stringify({
        stage: "hot-stability",
        error: error instanceof Error ? error.message : String(error),
        sample: hot,
      }, null, 2)}\n`, "utf8");
    }
    throw error;
  }
  await phase8ExerciseInputs();
  // Showing and focusing all four windows resumes work that was legitimately
  // paused while a renderer was obscured.  Do not start the memory clock while
  // that post-focus history work is still allocating backend/cache state.
  await phase8WaitForHotStability();
  const memoryWarmup = await phase8WaitForBackendMemoryPlateau();
  const transportBaseline = (await phase8WaitForTransportQuiet()).counts;
  await phase8ResetMetricsAndCollectGarbage();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    configuredAt,
    mainWindow,
    readyMs,
    symbols,
    ready: latest,
    memoryWarmup,
    transportBaseline,
  };
}

async function phase8Measure(output, durationMs, sampleMs) {
  const startedAt = Date.now();
  const inputExerciseIntervalMs = 60_000;
  let nextInputExerciseAt = startedAt;
  const sampleOptions = {
    compact: true,
    includeCumulativeMetrics: false,
    backendDetailLimit: 0,
  };
  const first = await phase8CollectSample(startedAt, sampleOptions);
  first.memoryCheckpointAtMs = 0;
  const samples = [first];
  let nextMemoryCheckpointMs = 30 * 60_000;
  while (Date.now() - startedAt < durationMs) {
    if (Date.now() >= nextInputExerciseAt) {
      await phase8ExerciseInputs();
      nextInputExerciseAt = Date.now() + inputExerciseIntervalMs;
    }
    const remaining = durationMs - (Date.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(sampleMs, Math.max(1, remaining))));
    let checkpointAtMs = null;
    if (Date.now() - startedAt >= nextMemoryCheckpointMs) {
      checkpointAtMs = nextMemoryCheckpointMs;
      nextMemoryCheckpointMs += 30 * 60_000;
      await phase8CollectRendererGarbage();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const sample = await phase8CollectSample(startedAt, sampleOptions);
    if (checkpointAtMs !== null) sample.memoryCheckpointAtMs = checkpointAtMs;
    samples.push(sample);
    await writeFile(`${output}.partial`, `${JSON.stringify({
      schemaVersion: "candlescope.multi-chart.phase8-soak-checkpoint/2",
      mode: phase8Mode,
      samples,
    })}\n`, "utf8");
  }
  await phase8CollectRendererGarbage();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const settled = await phase8WaitForTransportQuiet(startedAt, 5_000, {
    // The last sample performs the full indicator coverage audit. Intermediate
    // samples use document-level definition identity so the diagnostic scan
    // itself does not manufacture renderer long tasks every five seconds.
    compact: false,
    includeCumulativeMetrics: true,
    backendDetailLimit: 0,
  });
  settled.sample.memoryCheckpointAtMs = durationMs;
  if (settled.sample.atMs > samples.at(-1).atMs) samples.push(settled.sample);
  return samples;
}

function phase8TransportCounts(sample) {
  const sent = (eventType) => Number(sample?.backend?.klineBatch?.sent_by_type?.[eventType] || 0);
  const renderer = (field) => (sample?.windows || [])
    .reduce((sum, window) => sum + Number(window.renderer?.broker?.klineStream?.counts?.[field] || 0), 0);
  const commits = (sample?.windows || []).reduce((sum, window) => (
    sum + Number(window.renderer?.authoritativeCommits || 0)
  ), 0);
  return {
    sentClosed: sent("bar.closed"),
    sentAmended: sent("bar.amended"),
    receivedClosed: renderer("closed"),
    receivedAmended: renderer("amended"),
    parseErrors: renderer("parseErrors"),
    socketOpens: renderer("socketOpens"),
    authoritativeCommits: commits,
    eventLoopHistogram: sample?.backend?.runtime?.eventLoopLag?.histogram ?? null,
  };
}

async function phase8WaitForTransportQuiet(
  startedAt = Date.now(),
  timeoutMs = 5_000,
  sampleOptions = {},
) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = null;
  let stableIntervals = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await phase8CollectSample(startedAt, sampleOptions);
    const counts = phase8TransportCounts(latest);
    const signature = JSON.stringify({
      sentClosed: counts.sentClosed,
      sentAmended: counts.sentAmended,
      receivedClosed: counts.receivedClosed,
      receivedAmended: counts.receivedAmended,
      authoritativeCommits: counts.authoritativeCommits,
      outboxDepth: latest.backend?.klineBatch?.outbox_depth,
      cacheSeries: latest.backend?.dataManager?.cacheSeries,
      httpPhysical: (latest.windows || []).reduce((sum, window) => (
        sum + Number(window.renderer?.broker?.klineHttp?.totalPhysical || 0)
      ), 0),
    });
    if (phase8DataPlaneIdle(latest) && signature === previousSignature) stableIntervals += 1;
    else stableIntervals = 0;
    if (stableIntervals >= 3) return { counts, sample: latest };
    previousSignature = signature;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Phase 8 transport counters did not settle after ${timeoutMs} ms`);
}

function phase8ShortAnalysis(setup, samples) {
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = Number(last.atMs || 0) - Number(first.atMs || 0);
  const durationMinutes = Math.max(durationMs / 60_000, 1 / 60);
  const latencies = last.windows.flatMap((window) => window.renderer.metrics?.inputLatencies || []);
  const longTasks = last.windows.map((window) => (
    (window.renderer.metrics?.longTasks || []).filter((task) => Number(task.duration) > 50).length
  ));
  const focusedLongTasks = last.windows.reduce((sum, window) => (
    sum + (window.renderer.metrics?.longTasks || [])
      .filter((task) => Number(task.duration) > 50 && task.focused === true).length
  ), 0);
  const transportLast = phase8TransportCounts(last);
  const eventLoopLagP99Ms = histogramPercentileDelta(
    setup.transportBaseline.eventLoopHistogram,
    transportLast.eventLoopHistogram,
    0.99,
  ) ?? Number(last.backend.runtime?.eventLoopLag?.p99_ms || 0);
  const authoritative = {
    sentClosed: Math.max(0, transportLast.sentClosed - setup.transportBaseline.sentClosed),
    sentAmended: Math.max(0, transportLast.sentAmended - setup.transportBaseline.sentAmended),
    receivedClosed: Math.max(0, transportLast.receivedClosed - setup.transportBaseline.receivedClosed),
    receivedAmended: Math.max(0, transportLast.receivedAmended - setup.transportBaseline.receivedAmended),
    committed: Math.max(0, transportLast.authoritativeCommits - setup.transportBaseline.authoritativeCommits),
  };
  const connectionFailures = (sample) => (sample.backend.klineBatch.connections || [])
    .reduce((sum, connection) => (
      sum + Number(connection.item_failures || 0) + Number(connection.interval_failures || 0)
    ), 0);
  const itemFailures = Math.max(0, connectionFailures(last) - connectionFailures(first));
  const inputP95Ms = percentile(latencies, 0.95);
  const globalLongTasksPerMinute = longTasks.reduce((sum, value) => sum + value, 0) / durationMinutes;
  const focusLongTasksPerMinute = focusedLongTasks / durationMinutes;
  const gates = {
    readyP95: setup.readyMs <= 8_000,
    exactIdentity: samples.every(phase8ExactW3Identity),
    inputP95: latencies.length > 0 && Number(inputP95Ms) <= 150,
    longTasks: globalLongTasksPerMinute <= 15 && focusLongTasksPerMinute <= 5,
    eventLoopLag: Number(eventLoopLagP99Ms) <= 100,
    queues: last.backend.klineBatch.outbox_depth === 0
      && last.backend.klineBatch.outbox_dropped_replaceable === 0
      && last.backend.klineBatch.outbox_authoritative_timeouts === 0,
    noSilentFailure: phase8RuntimeErrors.length === 0
      && itemFailures === 0
      && transportLast.parseErrors === 0
      && last.windows.every((window) => window.renderer.productErrors.length === 0),
    authoritativeExactWhenObserved: authoritative.sentClosed + authoritative.sentAmended === 0
      || (authoritative.sentClosed === authoritative.receivedClosed
        && authoritative.sentAmended === authoritative.receivedAmended
        && authoritative.committed === authoritative.receivedClosed + authoritative.receivedAmended),
  };
  return {
    result: Object.values(gates).every(Boolean) ? "pass" : "fail",
    gates,
    measurements: {
      durationMs,
      readyMs: setup.readyMs,
      inputP95Ms,
      inputCount: latencies.length,
      globalLongTasksPerMinute,
      focusLongTasksPerMinute,
      eventLoopLagP99Ms,
      itemFailures,
      authoritative,
    },
  };
}

async function phase8FetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function phase8RunF1(store) {
  const setup = await phase8PrepareW3(store);
  const startedAt = Date.now();
  const before = await phase8CollectSample(startedAt);
  const proxy = new Phase8Fault429Proxy();
  const settingsUrl = `http://127.0.0.1:${backendPort}/api/v1/settings/proxy`;
  const original = await phase8FetchJson(settingsUrl);
  let during = null;
  let restored = null;
  try {
    await proxy.start();
    await phase8FetchJson(settingsUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "custom", custom_proxy: proxy.url() }),
    });
    await waitForPhase7Condition(() => proxy.diagnostics().counts.responses429 > 0, 60_000);
    during = {
      proxy: proxy.diagnostics(),
      windows: await phase8CollectWindowState(),
      backend: await phase7BackendCapacity(4),
    };
  } finally {
    await phase8FetchJson(settingsUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: original.mode, custom_proxy: original.custom_proxy || null }),
    }).catch((error) => phase8RuntimeErrors.push({ type: "proxy-restore", message: String(error) }));
    await proxy.stop();
  }
  await waitForPhase7Condition(async () => {
    restored = await phase8CollectSample(startedAt);
    return phase8ExactW3Identity(restored);
  }, 180_000);
  const beforeRevision = before.windows[0]?.renderer.workspace?.document?.revision;
  const gates = {
    controlled429Observed: during?.proxy?.counts?.responses429 > 0,
    cachedChartsRemainVisible: during?.windows?.every((window) => (
      window.renderer.chartRoots === 16 && window.renderer.dataReadyRoots === 16
    )),
    exactIdentityRecovered: phase8ExactW3Identity(restored),
    workspaceRevisionStable: restored.windows.every((window) => (
      window.renderer.workspace?.document?.revision === beforeRevision
    )),
    noSilentFailure: phase8RuntimeErrors.length === 0
      && phase8TransportCounts(restored).parseErrors === 0
      && (restored.backend.klineBatch.connections || []).every((connection) => connection.item_failures === 0),
  };
  return { setup: { readyMs: setup.readyMs }, before, during, restored, gates, result: Object.values(gates).every(Boolean) ? "pass" : "fail" };
}

async function phase8RunF2(store) {
  const setup = await phase8PrepareW3(store);
  const startedAt = Date.now();
  const before = await phase8CollectSample(startedAt);
  const beforePid = supervisor.diagnostics().pid;
  await supervisor.stop();
  await waitForPhase7Condition(async () => {
    try {
      await fetch(`http://127.0.0.1:${backendPort}/health`, { signal: AbortSignal.timeout(500) });
      return false;
    } catch {
      return true;
    }
  }, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const outageWindows = await phase8CollectWindowState();
  const restartedSidecar = await supervisor.start();
  let restored = null;
  await waitForPhase7Condition(async () => {
    restored = await phase8CollectSample(startedAt);
    return phase8ExactW3Identity(restored);
  }, 180_000);
  const beforeTransport = phase8TransportCounts(before);
  const afterTransport = phase8TransportCounts(restored);
  const gates = {
    newSidecarPid: restartedSidecar.pid !== beforePid && restartedSidecar.running === true,
    cachedChartsRemainVisible: outageWindows.every((window) => (
      window.renderer.chartRoots === 16 && window.renderer.dataReadyRoots === 16
    )),
    fourSocketsReconnected: afterTransport.socketOpens >= beforeTransport.socketOpens + 4,
    exactIdentityRecovered: phase8ExactW3Identity(restored),
    noDuplicateOrSilentFailure: phase8RuntimeErrors.length === 0
      && afterTransport.parseErrors === 0
      && (restored.backend.klineBatch.connections || []).every((connection) => connection.item_failures === 0),
  };
  return {
    setup: { readyMs: setup.readyMs },
    before,
    outage: { sidecarRunning: false, windows: outageWindows },
    restartedSidecar,
    restored,
    gates,
    result: Object.values(gates).every(Boolean) ? "pass" : "fail",
  };
}

async function phase8RunF3(store) {
  const setup = await phase8PrepareW3(store);
  const target = [...manager.windows].find(([windowId]) => windowId !== "main-window");
  if (!target) throw new Error("Phase 8 F3 requires a secondary native window");
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const before = target[1].getBounds();
  target[1].setBounds({ ...before, x: primary.workArea.x + primary.workArea.width + 5_000 }, false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const offscreen = target[1].getBounds();
  manager.recoverOffscreenWindows();
  await waitForPhase7Condition(() => {
    const bounds = target[1].getBounds();
    const area = primary.workArea;
    return bounds.x >= area.x && bounds.y >= area.y
      && bounds.x + bounds.width <= area.x + area.width
      && bounds.y + bounds.height <= area.y + area.height;
  }, 30_000);
  const recovered = target[1].getBounds();
  const syntheticDisplays = [
    { id: 1, label: "primary-100", internal: true, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, label: "left-125", internal: false, scaleFactor: 1.25, bounds: { x: -2048, y: 0, width: 1638, height: 1152 }, workArea: { x: -2048, y: 0, width: 1638, height: 1112 } },
    { id: 3, label: "top-150", internal: false, scaleFactor: 1.5, bounds: { x: 0, y: -960, width: 1707, height: 960 }, workArea: { x: 0, y: -960, width: 1707, height: 920 } },
    { id: 4, label: "right-200", internal: false, scaleFactor: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
  ];
  const savedOnRemovedDisplay = {
    boundsDip: syntheticDisplays[1].workArea,
    monitorFingerprint: displayFingerprint(syntheticDisplays[1]),
  };
  const missingDisplayRecovery = restoreWindowPlacement(savedOnRemovedDisplay, [syntheticDisplays[0]], 1);
  const fixturePlacements = syntheticDisplays.map((display) => restoreWindowPlacement({
    boundsDip: display.workArea,
    monitorFingerprint: displayFingerprint(display),
  }, syntheticDisplays, 1));
  const implementationGates = {
    actualOffscreenMove: offscreen.x > primary.workArea.x + primary.workArea.width,
    actualPrimaryRecovery: recovered.x >= primary.workArea.x
      && recovered.x + recovered.width <= primary.workArea.x + primary.workArea.width,
    missingDisplayFallback: missingDisplayRecovery.reason === "missing-monitor"
      && missingDisplayRecovery.displayId === 1,
    mixedDpiFixtures: fixturePlacements.map((placement) => placement.dpiScale).join(",") === "1,1.25,1.5,2",
    w3RemainsReady: (await phase8CollectWindowState()).every((window) => window.renderer.dataReadyRoots === 16),
  };
  const physicalGates = {
    fourDisplaysPresent: displays.length >= 4,
    displayRemovedObserved: phase8DisplayEvents.removed > 0,
    dpiMetricsChangedObserved: phase8DisplayEvents.metricsChanged > 0,
  };
  const implementationPass = Object.values(implementationGates).every(Boolean);
  const physicalPass = Object.values(physicalGates).every(Boolean);
  return {
    setup: { readyMs: setup.readyMs },
    displays: displays.map(snapshotDisplay),
    displayEvents: { ...phase8DisplayEvents },
    actual: { windowId: target[0], before, offscreen, recovered },
    fixtures: { missingDisplayRecovery, fixturePlacements },
    gates: { implementation: implementationGates, physical: physicalGates },
    result: implementationPass && physicalPass ? "pass" : implementationPass ? "implementation-pass-hardware-pending" : "fail",
  };
}

async function phase8RollbackStorageSnapshot(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const canonicalJson = (value) => {
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
      if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => (
          JSON.stringify(key) + ':' + canonicalJson(value[key])
        )).join(',') + '}';
      }
      return JSON.stringify(value);
    };
    const sha256 = async (value) => {
      const bytes = new TextEncoder().encode(canonicalJson(value));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return 'sha256:' + Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const open = (name, version, storeName) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = async (name, storeName) => {
      const database = await open(name, 1, storeName);
      try {
        return await new Promise((resolve, reject) => {
          const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    };
    const v6Records = (await all('candlescope-chart-workspaces-v6', 'workspaces-v6'))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const v5Records = (await all('candlescope-chart-workspaces', 'workspaces'))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const activeId = localStorage.getItem('candlescope-active-workspace-id-v2');
    const active = v6Records.find((record) => record.id === activeId) || v6Records[0] || null;
    const sentinel = v5Records.find((record) => record.id === 'phase8-v5-sentinel') || null;
    const documentContent = active?.document
      ? Object.fromEntries(Object.entries(active.document).filter(([key]) => key !== 'revision'))
      : null;
    return {
      v6: {
        activeId,
        recordCount: v6Records.length,
        recordsSha256: await sha256(v6Records),
        documentSha256: await sha256(active?.document ?? null),
        documentContentSha256: await sha256(documentContent),
        cellCount: Object.keys(active?.document?.cells || {}).length,
        windowCount: Object.keys(active?.document?.windows || {}).length,
        revision: active?.document?.revision ?? null,
      },
      v5: {
        recordCount: v5Records.length,
        sentinel,
        sentinelSha256: await sha256(sentinel),
        localSentinelSha256: await sha256(
          JSON.parse(localStorage.getItem('candlescope-phase8-v5-sentinel') || 'null'),
        ),
      },
    };
  })()`);
}

async function phase8SeedRollbackV5Sentinel(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const sentinel = Object.freeze({
      id: 'phase8-v5-sentinel',
      schemaVersion: 5,
      value: 'preserve-across-64-16-4',
      seededAt: '2026-08-07T00:00:00.000Z'
    });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('candlescope-chart-workspaces', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('workspaces')) {
          request.result.createObjectStore('workspaces', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('workspaces', 'readwrite');
        transaction.objectStore('workspaces').put(sentinel);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
    localStorage.setItem('candlescope-phase8-v5-sentinel', JSON.stringify(sentinel));
    return sentinel;
  })()`);
}

async function phase8RunRollback(store) {
  if (!["64", "16", "4"].includes(phase8RollbackStage)) {
    throw new Error(`Unsupported Phase 8 rollback stage: ${phase8RollbackStage}`);
  }
  if (phase8RollbackStage === "64") {
    await manager.reconcile(syntheticSpikeTopology(store.snapshot(), 4));
  } else {
    await manager.restoreCached(store.snapshot());
  }
  manager.windows.forEach((window, windowId) => observePhase8Runtime(windowId, window));
  const mainWindow = await waitForPhase7Condition(() => {
    const candidate = manager.windows.get("main-window");
    return candidate && !candidate.isDestroyed() ? candidate : null;
  }, 60_000);
  await waitForPhase7Condition(() => mainWindow.webContents.executeJavaScript(
    "Boolean(window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().ready)",
  ), 60_000);
  phase7TopologyArmed = true;
  if (phase8RollbackStage === "64") {
    await mainWindow.webContents.executeJavaScript(
      "window.__CANDLESCOPE_PHASE7_CONTROL__.configure64()",
    );
    await phase8SeedRollbackV5Sentinel(mainWindow);
  }
  const expectedRoots = phase8RollbackStage === "4" ? 4 : 16;
  const expectedNativeWindows = phase8RollbackStage === "64" ? 4 : 1;
  await waitForPhase7Condition(async () => {
    if (manager.windows.size !== expectedNativeWindows) return false;
    const snapshot = await mainWindow.webContents.executeJavaScript(
      "window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.() ?? null",
    );
    if (!snapshot?.ready || Object.keys(snapshot.document?.cells || {}).length !== 64) return false;
    const roots = await Promise.all([...manager.windows.values()].map((window) => (
      window.webContents.executeJavaScript("document.querySelectorAll('[data-chart-cell-id]').length")
    )));
    return roots.every((count) => count === expectedRoots);
  }, 60_000);
  if (phase8RollbackStage === "64") {
    await waitForPhase7Condition(() => mainWindow.webContents.executeJavaScript(
      "window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().status?.saveState === 'saved'",
    ), 60_000);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const windows = await phase8CollectWindowState();
  const storageBefore = await phase8RollbackStorageSnapshot(mainWindow);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const storage = await phase8RollbackStorageSnapshot(mainWindow);
  const rendererStatus = await mainWindow.webContents.executeJavaScript(
    "window.__CANDLESCOPE_PHASE7_CONTROL__?.snapshot?.().status ?? null",
  );
  const gates = {
    exactNativeWindows: windows.length === expectedNativeWindows,
    exactVisibleCells: windows.every((window) => window.renderer.chartRoots === expectedRoots),
    v6DocumentStill64: storage.v6.cellCount === 64 && storage.v6.windowCount === 4,
    v5SentinelPresent: storage.v5.sentinel?.value === "preserve-across-64-16-4",
    storageStable: storageBefore.v6.documentSha256 === storage.v6.documentSha256
      && storageBefore.v5.sentinelSha256 === storage.v5.sentinelSha256,
    persistenceHealthy: rendererStatus?.saveState !== "error",
    noRuntimeErrors: phase8RuntimeErrors.length === 0,
  };
  return {
    stage: phase8RollbackStage,
    build: {
      multiChart16Enabled: process.env.CANDLESCOPE_DESKTOP_ROLLBACK_MULTI16 === "1",
      multiWindowEnabled,
      multiChart64Enabled: process.env.CANDLESCOPE_DESKTOP_ROLLBACK_MULTI64 === "1",
      chartWindowBrokerEnabled: process.env.CANDLESCOPE_DESKTOP_ROLLBACK_BROKER === "1",
      klineBatchEnabled: process.env.CANDLESCOPE_DESKTOP_ROLLBACK_BATCH === "1",
    },
    userData: app.getPath("userData"),
    windows,
    rendererStatus,
    storage,
    runtimeErrors: phase8RuntimeErrors,
    gates,
    result: Object.values(gates).every(Boolean) ? "pass" : "fail",
  };
}

async function runPhase8Evidence(store, output) {
  await mkdir(path.dirname(output), { recursive: true });
  let payload;
  if (phase8Mode === "ROLLBACK") payload = await phase8RunRollback(store);
  else if (phase8Mode === "F1") payload = await phase8RunF1(store);
  else if (phase8Mode === "F2") payload = await phase8RunF2(store);
  else if (phase8Mode === "F3") payload = await phase8RunF3(store);
  else if (phase8Mode === "W3" || phase8Mode === "SOAK") {
    const setup = await phase8PrepareW3(store);
    const screenshotBefore = await phase8CaptureScreenshot(output, "ready");
    const samples = await phase8Measure(output, phase8DurationMs, phase8SampleMs);
    const screenshotAfter = await phase8CaptureScreenshot(output, "final");
    const analysis = phase8Mode === "SOAK"
      ? analyzePhase8Soak(samples, {
        requiredDurationMs: 14_400_000,
        transportBaseline: setup.transportBaseline,
      })
      : phase8ShortAnalysis(setup, samples);
    payload = {
      setup: {
        readyMs: setup.readyMs,
        symbols: setup.symbols,
        memoryWarmup: setup.memoryWarmup,
        transportBaseline: setup.transportBaseline,
      },
      durationMs: phase8DurationMs,
      sampleMs: phase8SampleMs,
      samples,
      analysis,
      artifacts: { screenshotBefore, screenshotAfter, checkpoint: `${output}.partial` },
      result: analysis.result,
    };
  } else {
    throw new Error(`Unsupported Phase 8 mode: ${phase8Mode}`);
  }
  const evidence = {
    schemaVersion: "candlescope.multi-chart.phase8-runtime/1",
    generatedAt: new Date().toISOString(),
    mode: phase8Mode,
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      updatePolicy: "manual-release-artifact",
      userData: app.getPath("userData"),
      displayCount: screen.getAllDisplays().length,
      backendPort,
    },
    sidecar: supervisor?.diagnostics() || { skipped: true },
    ...payload,
  };
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.exitCode = evidence.result === "fail" ? 1 : 0;
}

async function boot() {
  if (app.isPackaged && !process.env.CANDLESCOPE_DESKTOP_URL) {
    assetServer = await startDesktopAssetServer(path.join(app.getAppPath(), "dist"), {
      port: Number(process.env.CANDLESCOPE_DESKTOP_UI_PORT || 18079),
    });
    appUrl = assetServer.appUrl;
  }
  if (!isTrustedAppUrl(appUrl, appUrl)) throw new Error("Desktop URL must be a loopback application page");
  supervisor = createSupervisor();
  await supervisor?.start();

  const store = new DesktopShellStateStore(path.join(app.getPath("userData"), "desktop-windows-v1.json"));
  const cached = await store.load();
  manager = new ElectronWindowManager({
    BrowserWindow,
    screen,
    store,
    channels: DESKTOP_IPC,
    preloadPath: path.join(desktopDir, "preload.cjs"),
    appUrl: instrumentedAppUrl(),
    multiWindowEnabled,
  });

  trustedIpc.on(DESKTOP_IPC.managementSession, (event) => {
    event.returnValue = supervisor ? {
      apiBase: `http://127.0.0.1:${backendPort}/api/v2/plugins`,
      ...managementSession,
    } : null;
  });
  trustedIpc.handle(DESKTOP_IPC.openAppPage, (_event, url) => manager.openAppPage(url));

  trustedIpc.handle(DESKTOP_IPC.bootstrap, (event) => {
    const windowId = manager.assertTrustedSender(event);
    const state = store.snapshot();
    return {
      mode: "native",
      multiWindowAvailable: true,
      multiWindowEnabled,
      windowId,
      workspaceId: state.workspaceId,
      shellRevision: state.workspaceRevision,
      displayCount: screen.getAllDisplays().length,
      sidecar: supervisor?.diagnostics() || { skipped: true },
      logsPath: app.getPath("logs"),
    };
  });
  trustedIpc.handle(DESKTOP_IPC.reconcile, async (_event, raw) => {
    if (process.env.CANDLESCOPE_DESKTOP_SPIKE_OUT
      || process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT
      || (process.env.CANDLESCOPE_DESKTOP_PHASE7_OUT && !phase7TopologyArmed)
      || (phase8Output && !phase7TopologyArmed)) {
      return {
        ok: false,
        code: "SPIKE_TOPOLOGY_OWNED_BY_SHELL",
        message: "Automated desktop spike freezes its four-window topology until evidence is captured",
        shellRevision: store.snapshot().workspaceRevision,
      };
    }
    try {
      const result = await manager.reconcile(validateTopologyPayload(raw));
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "DESKTOP_TOPOLOGY_REJECTED",
        message: error instanceof Error ? error.message : String(error),
        shellRevision: store.snapshot().workspaceRevision,
      };
    }
  });
  trustedIpc.handle(DESKTOP_IPC.workspaceBusConnect, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return workspaceBus.connect(windowId, raw?.snapshot ?? null);
    } catch (error) {
      return {
        ...workspaceBus.stateResult(),
        ok: false,
        code: error?.code || "WORKSPACE_BUS_CONNECT_REJECTED",
        message: String(error?.message || error),
      };
    }
  });
  trustedIpc.handle(DESKTOP_IPC.workspaceBusCommit, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return workspaceBus.commit(windowId, raw);
    } catch (error) {
      const state = workspaceBus.stateResult();
      return {
        ...state,
        ok: false,
        code: error?.code || "WORKSPACE_BUS_COMMIT_REJECTED",
        message: String(error?.message || error),
        conflict: error instanceof WorkspaceBusConflictError ? error.details : null,
      };
    }
  });
  trustedIpc.handle(DESKTOP_IPC.workspaceBusLink, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return workspaceBus.publishLink(windowId, raw);
    } catch (error) {
      return { ok: false, code: "WORKSPACE_LINK_REJECTED", message: String(error?.message || error) };
    }
  });
  trustedIpc.on(DESKTOP_IPC.workspaceBusWindow, (event, raw) => {
    try {
      workspaceBus.reportWindow(registerWorkspaceSender(event.sender), raw);
    } catch {
      // A destroyed or unmanaged sender has no remaining health authority.
    }
  });
  trustedIpc.handle(DESKTOP_IPC.appWorkAcquire, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return appWorkBudget.acquire({ ...raw, windowId });
    } catch {
      return { released: true };
    }
  });
  trustedIpc.on(DESKTOP_IPC.appWorkRelease, (_event, leaseId) => {
    if (typeof leaseId === "string") appWorkBudget.release(leaseId);
  });
  trustedIpc.handle(DESKTOP_IPC.appPreviewRequest, (event, raw) => {
    const windowId = registerWorkspaceSender(event.sender);
    return appWorkBudget.requestPreview({ ...raw, windowId });
  });
  trustedIpc.on(DESKTOP_IPC.appPreviewRelease, (event, raw) => {
    const windowId = windowIdForSender(event.sender);
    if (windowId) appWorkBudget.releasePreview({ ...raw, windowId });
  });
  trustedIpc.handle(DESKTOP_IPC.appBudgetDiagnostics, () => ({
    workspaceBus: workspaceBus.diagnostics(),
    appWork: appWorkBudget.diagnostics(),
    seriesSnapshots: seriesSnapshots.diagnostics(),
  }));
  trustedIpc.on(DESKTOP_IPC.seriesSnapshotRead, (event, rawKey) => {
    event.returnValue = windowIdForSender(event.sender)
      ? seriesSnapshots.read(rawKey)
      : { ok: false, code: "SERIES_SNAPSHOT_SENDER_UNMANAGED", rows: [] };
  });
  trustedIpc.on(DESKTOP_IPC.seriesSnapshotPublish, (event, raw) => {
    if (!windowIdForSender(event.sender)) return;
    try {
      seriesSnapshots.publish(raw);
    } catch {
      // The hub records bounded validation rejects; renderer state is never trusted.
    }
  });
  trustedIpc.handle(DESKTOP_IPC.seriesSnapshotDiagnostics, () => seriesSnapshots.diagnostics());

  screen.on("display-added", () => {
    phase8DisplayEvents.added += 1;
    manager.recoverOffscreenWindows();
  });
  screen.on("display-removed", () => {
    phase8DisplayEvents.removed += 1;
    manager.recoverOffscreenWindows();
  });
  screen.on("display-metrics-changed", () => {
    phase8DisplayEvents.metricsChanged += 1;
    manager.recoverOffscreenWindows();
  });

  const spikeOutput = process.env.CANDLESCOPE_DESKTOP_SPIKE_OUT;
  const restoreOutput = process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT;
  const phase7Output = process.env.CANDLESCOPE_DESKTOP_PHASE7_OUT;
  if (phase8Output) {
    await runPhase8Evidence(store, phase8Output);
    app.quit();
    return;
  }
  if (phase7Output) {
    await runPhase7Evidence(store, phase7Output);
    app.quit();
    return;
  }
  if (spikeOutput || restoreOutput) {
    if (spikeOutput) {
      const topology = syntheticSpikeTopology(
        cached,
        Math.min(4, Math.max(1, Number(process.env.CANDLESCOPE_DESKTOP_SPIKE_WINDOW_COUNT || 4))),
      );
      await manager.reconcile(topology);
    } else {
      await manager.restoreCached(cached);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const closeIsolation = await exerciseCloseIsolation(store);
    const lifecycle = await exerciseNativeLifecycle();
    await writeSpikeEvidence(
      store,
      spikeOutput || restoreOutput,
      spikeOutput ? "create" : "restore",
      lifecycle,
      closeIsolation,
    );
    app.quit();
    return;
  }
  await manager.restoreCached(cached);
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = manager?.windows.get("main-window") || manager?.windows.values().next().value;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.whenReady().then(boot).catch(async (error) => {
    await mkdir(app.getPath("logs"), { recursive: true });
    await writeFile(
      path.join(app.getPath("logs"), "desktop-startup-error.log"),
      `${new Date().toISOString()} ${error?.stack || error}\n`,
      { flag: "a" },
    );
    await supervisor?.stop();
    await assetServer?.close();
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  manager?.approveQuit();
  if (shutdownComplete || (!supervisor && !assetServer)) return;
  event.preventDefault();
  shutdownPromise ??= Promise.all([supervisor?.stop(), assetServer?.close()]).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
