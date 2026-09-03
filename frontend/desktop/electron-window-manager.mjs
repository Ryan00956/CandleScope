import { restoreWindowPlacement, snapshotDisplay } from "./window-placement.mjs";
import { DesktopTopologyRevisionConflictError } from "./shell-state-store.mjs";
import { isTrustedAppUrl } from "./app-origin.mjs";

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ElectronWindowManager {
  constructor(options) {
    this.options = options;
    this.windows = new Map();
    this.appWindows = new Map();
    this.nextAppWindow = 1;
    this.closingApproved = new Set();
    this.boundTimers = new Map();
    this.quitting = false;
  }

  diagnostics() {
    return {
      windowCount: this.windows.size,
      windowIds: [...this.windows.keys()].sort(),
      displays: this.options.screen.getAllDisplays().map(snapshotDisplay),
      multiWindowEnabled: this.options.multiWindowEnabled,
    };
  }

  windowIdForContents(sender) {
    return [...this.windows, ...this.appWindows]
      .find(([, window]) => !window.isDestroyed() && window.webContents === sender)?.[0] ?? null;
  }

  assertTrustedSender(event) {
    const id = this.windowIdForContents(event.sender);
    if (!id || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || !isTrustedAppUrl(event.sender.getURL(), this.options.appUrl)) {
      throw new Error("Desktop IPC requires a managed application main frame");
    }
    return id;
  }

  protectWindow(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isTrustedAppUrl(url, this.options.appUrl)) void this.openAppPage(url).catch(() => {});
      return { action: "deny" };
    });
    const protectNavigation = (event, url) => {
      if (!isTrustedAppUrl(url, this.options.appUrl)) {
        event.preventDefault();
      } else if ([...this.appWindows.values()].includes(window) && this.isLivePage(url)) {
        event.preventDefault();
        void this.openAppPage(url).catch(() => {});
      }
    };
    window.webContents.on("will-navigate", protectNavigation);
    window.webContents.on("will-redirect", protectNavigation);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  }

  isLivePage(value) {
    const path = new URL(value, this.options.appUrl).pathname;
    const base = new URL(".", this.options.appUrl).pathname;
    return path === base || path === `${base}index.html`;
  }

  async openAppPage(value) {
    const target = new URL(value, this.options.appUrl);
    if (!isTrustedAppUrl(target.href, this.options.appUrl)) throw new Error("Untrusted application page");
    if (this.isLivePage(target.href)) {
      const live = this.windows.get("main-window") ?? this.windows.values().next().value;
      if (!live || live.isDestroyed()) throw new Error("Live workspace window is unavailable");
      if (live.isMinimized()) live.restore();
      live.show();
      live.focus();
      return { windowId: this.windowIdForContents(live.webContents) };
    }
    const id = `app-window-${this.nextAppWindow++}`;
    target.searchParams.set("windowId", id);
    const window = new this.options.BrowserWindow({
      width: 1280, height: 850, show: false, title: "CandleScope",
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.appWindows.set(id, window);
    this.protectWindow(window);
    window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
    window.on("closed", () => this.appWindows.delete(id));
    try { await window.loadURL(target.href); } catch (error) { window.close(); throw error; }
    return { windowId: id };
  }

  sendAll(channel, payload) {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  lifecycle(windowId, state) {
    const window = this.windows.get(windowId);
    if (!window || window.isDestroyed()) return;
    const display = this.options.screen.getDisplayMatching(window.getBounds());
    this.sendAll(this.options.channels.lifecycle, {
      windowId,
      state,
      focused: window.isFocused(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      placement: {
        boundsDip: window.getNormalBounds(),
        monitorFingerprint: snapshotDisplay(display).fingerprint,
        dpiScale: display.scaleFactor,
        windowState: window.isMinimized() ? "minimized" : window.isMaximized() ? "maximized" : "normal",
      },
    });
  }

  schedulePlacement(windowId) {
    const previous = this.boundTimers.get(windowId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.boundTimers.delete(windowId);
      const window = this.windows.get(windowId);
      if (!window || window.isDestroyed() || window.isMinimized()) return;
      const display = this.options.screen.getDisplayMatching(window.getBounds());
      this.sendAll(this.options.channels.placement, {
        windowId,
        boundsDip: window.getNormalBounds(),
        monitorFingerprint: snapshotDisplay(display).fingerprint,
        dpiScale: display.scaleFactor,
        windowState: window.isMaximized() ? "maximized" : "normal",
      });
    }, 150);
    this.boundTimers.set(windowId, timer);
  }

  async createWindow(workspaceId, saved) {
    const existing = this.windows.get(saved.id);
    if (existing && !existing.isDestroyed()) return existing;
    const displays = this.options.screen.getAllDisplays();
    const primary = this.options.screen.getPrimaryDisplay();
    const restored = restoreWindowPlacement(saved, displays, primary.id);
    const window = new this.options.BrowserWindow({
      ...restored.boundsDip,
      minWidth: 640,
      minHeight: 480,
      show: false,
      backgroundColor: "#0b0f14",
      title: saved.id === "main-window" ? "CandleScope" : `CandleScope — ${saved.id}`,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.windows.set(saved.id, window);
    this.protectWindow(window);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("focus", () => this.lifecycle(saved.id, "focused"));
    window.on("blur", () => this.lifecycle(saved.id, "visible-secondary"));
    window.on("minimize", () => this.lifecycle(saved.id, "minimized"));
    window.on("restore", () => this.lifecycle(saved.id, "restored"));
    window.on("show", () => this.lifecycle(saved.id, "shown"));
    window.on("hide", () => this.lifecycle(saved.id, "hidden"));
    window.on("move", () => this.schedulePlacement(saved.id));
    window.on("resize", () => this.schedulePlacement(saved.id));
    window.on("close", (event) => {
      if (this.quitting || this.closingApproved.has(saved.id)) return;
      if (saved.id === "main-window") {
        this.quitting = true;
        return;
      }
      event.preventDefault();
      this.sendAll(this.options.channels.closeRequested, { windowId: saved.id });
    });
    window.on("closed", () => {
      this.windows.delete(saved.id);
      this.closingApproved.delete(saved.id);
    });
    const target = new URL(this.options.appUrl);
    target.searchParams.set("workspaceId", workspaceId);
    target.searchParams.set("windowId", saved.id);
    await window.loadURL(target.href);
    if (saved.windowState === "maximized") window.maximize();
    else if (saved.windowState === "minimized") window.minimize();
    return window;
  }

  async restoreCached(state) {
    const requested = this.options.multiWindowEnabled
      ? Object.values(state.windows)
      : [state.windows["main-window"]].filter(Boolean);
    const fallback = requested.length > 0 ? requested : [{
      id: "main-window",
      boundsDip: null,
      monitorFingerprint: null,
      dpiScale: null,
      windowState: "normal",
    }];
    for (const saved of fallback.slice(0, 4)) {
      await this.createWindow(state.workspaceId || "workspace-default", saved);
    }
  }

  async reconcile(payload) {
    const current = this.options.store.snapshot();
    const projectedWindows = this.options.multiWindowEnabled
      ? payload.windows
      : { "main-window": payload.windows["main-window"] || Object.values(payload.windows)[0] };
    const candidate = {
      schemaVersion: current.schemaVersion,
      workspaceId: payload.workspaceId,
      workspaceRevision: payload.workspaceRevision,
      activeWindowId: projectedWindows[payload.activeWindowId]
        ? payload.activeWindowId
        : "main-window",
      windows: projectedWindows,
    };
    if (current.workspaceRevision === candidate.workspaceRevision) {
      if (!sameJson(current, candidate)) {
        throw new DesktopTopologyRevisionConflictError(
          payload.expectedShellRevision,
          current.workspaceRevision,
        );
      }
      return { shellRevision: current.workspaceRevision, idempotent: true };
    }
    if (payload.expectedShellRevision !== current.workspaceRevision) {
      throw new DesktopTopologyRevisionConflictError(
        payload.expectedShellRevision,
        current.workspaceRevision,
      );
    }
    if (candidate.workspaceRevision < current.workspaceRevision) {
      throw new DesktopTopologyRevisionConflictError(
        candidate.workspaceRevision,
        current.workspaceRevision,
      );
    }
    await this.options.store.compareAndSwap(current.workspaceRevision, candidate);
    for (const saved of Object.values(projectedWindows)) {
      await this.createWindow(payload.workspaceId, saved);
    }
    for (const [windowId, window] of this.windows) {
      if (projectedWindows[windowId]) continue;
      this.closingApproved.add(windowId);
      window.close();
    }
    return { shellRevision: candidate.workspaceRevision, idempotent: false };
  }

  recoverOffscreenWindows() {
    const displays = this.options.screen.getAllDisplays();
    const primary = this.options.screen.getPrimaryDisplay();
    const cached = this.options.store.snapshot();
    for (const [windowId, window] of this.windows) {
      if (window.isDestroyed()) continue;
      const saved = cached.windows[windowId] || {
        id: windowId,
        boundsDip: window.getNormalBounds(),
      };
      const restored = restoreWindowPlacement(saved, displays, primary.id);
      window.setBounds(restored.boundsDip, false);
      this.schedulePlacement(windowId);
    }
  }

  approveQuit() {
    this.quitting = true;
    for (const timer of this.boundTimers.values()) clearTimeout(timer);
    this.boundTimers.clear();
  }
}
