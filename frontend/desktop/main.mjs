import { app, BrowserWindow, ipcMain, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ElectronWindowManager } from "./electron-window-manager.mjs";
import { AppWorkBudgetHub } from "./app-work-budget-hub.mjs";
import { DESKTOP_IPC, validateTopologyPayload } from "./ipc-contract.mjs";
import { SidecarSupervisor } from "./sidecar-supervisor.mjs";
import { SeriesSnapshotHub } from "./series-snapshot-hub.mjs";
import { DesktopShellStateStore } from "./shell-state-store.mjs";
import { WorkspaceBusConflictError, WorkspaceBusHub } from "./workspace-bus-hub.mjs";

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
const appUrl = process.env.CANDLESCOPE_DESKTOP_URL || (app.isPackaged
  ? pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href
  : "http://127.0.0.1:15173/");
const backendPort = Number(process.env.CANDLESCOPE_DESKTOP_BACKEND_PORT || 18080);
const phase7Scenario = String(process.env.CANDLESCOPE_DESKTOP_PHASE7_SCENARIO || "W1").toUpperCase();
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

function windowIdForSender(sender) {
  const window = BrowserWindow.fromWebContents(sender);
  return [...(manager?.windows || [])].find(([, candidate]) => candidate === window)?.[0] || null;
}

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

async function phase7BackendCapacity() {
  const response = await fetch(
    `http://127.0.0.1:${backendPort}/debug/capacity?detail_limit=100`,
    { signal: AbortSignal.timeout(2_000) },
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
    indicators: raw.indicators ?? null,
    exchange: raw.exchange ?? null,
    runtime: raw.runtime ?? null,
  };
}

async function phase7W2Symbols() {
  const response = await fetch(
    `http://127.0.0.1:${backendPort}/api/v1/symbols/exchange-info?exchange=binance&market_type=spot&quote_asset=USDT`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error(`Phase 7 W2 symbol catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  const symbols = [...new Set((Array.isArray(payload?.symbols) ? payload.symbols : [])
    .map((item) => typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "")
    .filter(Boolean))].slice(0, 64);
  if (symbols.length !== 64) {
    throw new Error(`Phase 7 W2 needs 64 active Binance spot USDT symbols, received ${symbols.length}`);
  }
  return symbols;
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

async function boot() {
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
    appUrl,
    multiWindowEnabled,
  });

  ipcMain.handle(DESKTOP_IPC.bootstrap, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const windowId = [...manager.windows].find(([, candidate]) => candidate === window)?.[0]
      || "main-window";
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
  ipcMain.handle(DESKTOP_IPC.reconcile, async (_event, raw) => {
    if (process.env.CANDLESCOPE_DESKTOP_SPIKE_OUT
      || process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT
      || (process.env.CANDLESCOPE_DESKTOP_PHASE7_OUT && !phase7TopologyArmed)) {
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
  ipcMain.handle(DESKTOP_IPC.workspaceBusConnect, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return workspaceBus.connect(windowId, raw?.snapshot ?? null);
    } catch (error) {
      return { ok: false, ready: false, code: error?.code || "WORKSPACE_BUS_CONNECT_REJECTED", message: String(error?.message || error) };
    }
  });
  ipcMain.handle(DESKTOP_IPC.workspaceBusCommit, (event, raw) => {
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
  ipcMain.handle(DESKTOP_IPC.workspaceBusLink, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return workspaceBus.publishLink(windowId, raw);
    } catch (error) {
      return { ok: false, code: "WORKSPACE_LINK_REJECTED", message: String(error?.message || error) };
    }
  });
  ipcMain.on(DESKTOP_IPC.workspaceBusWindow, (event, raw) => {
    try {
      workspaceBus.reportWindow(registerWorkspaceSender(event.sender), raw);
    } catch {
      // A destroyed or unmanaged sender has no remaining health authority.
    }
  });
  ipcMain.handle(DESKTOP_IPC.appWorkAcquire, (event, raw) => {
    try {
      const windowId = registerWorkspaceSender(event.sender);
      return appWorkBudget.acquire({ ...raw, windowId });
    } catch {
      return { released: true };
    }
  });
  ipcMain.on(DESKTOP_IPC.appWorkRelease, (_event, leaseId) => {
    if (typeof leaseId === "string") appWorkBudget.release(leaseId);
  });
  ipcMain.handle(DESKTOP_IPC.appPreviewRequest, (event, raw) => {
    const windowId = registerWorkspaceSender(event.sender);
    return appWorkBudget.requestPreview({ ...raw, windowId });
  });
  ipcMain.on(DESKTOP_IPC.appPreviewRelease, (event, raw) => {
    const windowId = windowIdForSender(event.sender);
    if (windowId) appWorkBudget.releasePreview({ ...raw, windowId });
  });
  ipcMain.handle(DESKTOP_IPC.appBudgetDiagnostics, () => ({
    workspaceBus: workspaceBus.diagnostics(),
    appWork: appWorkBudget.diagnostics(),
    seriesSnapshots: seriesSnapshots.diagnostics(),
  }));
  ipcMain.on(DESKTOP_IPC.seriesSnapshotRead, (event, rawKey) => {
    event.returnValue = windowIdForSender(event.sender)
      ? seriesSnapshots.read(rawKey)
      : { ok: false, code: "SERIES_SNAPSHOT_SENDER_UNMANAGED", rows: [] };
  });
  ipcMain.on(DESKTOP_IPC.seriesSnapshotPublish, (event, raw) => {
    if (!windowIdForSender(event.sender)) return;
    try {
      seriesSnapshots.publish(raw);
    } catch {
      // The hub records bounded validation rejects; renderer state is never trusted.
    }
  });
  ipcMain.handle(DESKTOP_IPC.seriesSnapshotDiagnostics, () => seriesSnapshots.diagnostics());

  screen.on("display-added", () => manager.recoverOffscreenWindows());
  screen.on("display-removed", () => manager.recoverOffscreenWindows());
  screen.on("display-metrics-changed", () => manager.recoverOffscreenWindows());

  const spikeOutput = process.env.CANDLESCOPE_DESKTOP_SPIKE_OUT;
  const restoreOutput = process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT;
  const phase7Output = process.env.CANDLESCOPE_DESKTOP_PHASE7_OUT;
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
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  manager?.approveQuit();
  if (shutdownComplete || !supervisor) return;
  event.preventDefault();
  shutdownPromise ??= supervisor.stop().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
