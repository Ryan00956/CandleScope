import { app, BrowserWindow, ipcMain, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ElectronWindowManager } from "./electron-window-manager.mjs";
import { DESKTOP_IPC, validateTopologyPayload } from "./ipc-contract.mjs";
import { SidecarSupervisor } from "./sidecar-supervisor.mjs";
import { DesktopShellStateStore } from "./shell-state-store.mjs";

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
const gotSingleInstanceLock = app.requestSingleInstanceLock({ source: "desktop-shell" });

let manager = null;
let supervisor = null;
let shutdownComplete = false;
let shutdownPromise = null;

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
      || process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT) {
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

  screen.on("display-added", () => manager.recoverOffscreenWindows());
  screen.on("display-removed", () => manager.recoverOffscreenWindows());
  screen.on("display-metrics-changed", () => manager.recoverOffscreenWindows());

  const spikeOutput = process.env.CANDLESCOPE_DESKTOP_SPIKE_OUT;
  const restoreOutput = process.env.CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT;
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
