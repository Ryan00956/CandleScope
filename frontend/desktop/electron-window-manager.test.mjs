import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ElectronWindowManager } from "./electron-window-manager.mjs";
import { emptyShellState, normalizeShellState } from "./shell-state-store.mjs";

const display = {
  id: 1,
  label: "primary",
  internal: true,
  rotation: 0,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1707, height: 1067 },
  workArea: { x: 0, y: 0, width: 1707, height: 1019 },
};

class FakeWindow extends EventEmitter {
  static created = [];

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.minimized = false;
    this.maximized = false;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.sent = [];
    this.webContents = {
      on: () => {},
      setWindowOpenHandler: (handler) => { this.openHandler = handler; },
      send: (channel, payload) => this.sent.push({ channel, payload }),
    };
    FakeWindow.created.push(this);
  }

  async loadURL(url) {
    this.url = url;
    this.emit("ready-to-show");
  }

  isDestroyed() { return this.destroyed; }
  isFocused() { return false; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  restore() { this.minimized = false; }
  hide() { this.visible = false; this.emit("hide"); }
  minimize() { this.minimized = true; this.emit("minimize"); }
  maximize() { this.maximized = true; }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  close() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit("close", event);
    if (event.prevented) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

class MemoryStore {
  constructor(state) { this.state = normalizeShellState(state); }
  snapshot() { return structuredClone(this.state); }
  async compareAndSwap(expected, candidate) {
    assert.equal(this.state.workspaceRevision, expected);
    this.state = normalizeShellState(candidate);
    return this.snapshot();
  }
}

function topology(revision, ids) {
  return {
    schemaVersion: "candlescope.desktop-shell-state/1",
    workspaceId: "workspace-default",
    workspaceRevision: revision,
    activeWindowId: "main-window",
    windows: Object.fromEntries(ids.map((id, index) => [id, {
      id,
      boundsDip: { x: index * 200, y: 0, width: 900, height: 700 },
      monitorFingerprint: null,
      dpiScale: 1.5,
      windowState: "normal",
    }])),
  };
}

function createManager(store, multiWindowEnabled = true) {
  FakeWindow.created = [];
  return new ElectronWindowManager({
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayMatching: () => display,
    },
    store,
    channels: { lifecycle: "lifecycle", placement: "placement", closeRequested: "close" },
    preloadPath: "preload.cjs",
    appUrl: "http://127.0.0.1:15287/",
    multiWindowEnabled,
  });
}

test("cached four-window topology restores four native windows with scoped URLs", async () => {
  const state = topology(4, ["main-window", "window-2", "window-3", "window-4"]);
  const manager = createManager(new MemoryStore(state));
  await manager.restoreCached(state);
  assert.deepEqual(manager.diagnostics().windowIds, ["main-window", "window-2", "window-3", "window-4"]);
  assert.match(manager.windows.get("window-3").url, /windowId=window-3/);
});

test("desktop authority rejects unknown windows, subframes and external navigation", async () => {
  const manager = createManager(new MemoryStore(topology(0, ["main-window"])));
  await manager.restoreCached(manager.options.store.snapshot());
  const window = manager.windows.get("main-window");
  const sender = window.webContents;
  const frame = {};
  sender.mainFrame = frame;
  sender.getURL = () => window.url;
  assert.equal(manager.assertTrustedSender({ sender, senderFrame: frame }), "main-window");
  assert.throws(() => manager.assertTrustedSender({ sender, senderFrame: {} }));
  assert.throws(() => manager.assertTrustedSender({ sender: {}, senderFrame: frame }));
  sender.getURL = () => "https://attacker.example/";
  assert.throws(() => manager.assertTrustedSender({ sender, senderFrame: frame }));
  assert.deepEqual(window.openHandler({ url: "about:blank" }), { action: "deny" });
  assert.equal(manager.appWindows.size, 0);
  const created = await manager.openAppPage("/replay.html?run=one");
  assert.ok(manager.appWindows.has(created.windowId));
  assert.equal(new URL(manager.appWindows.get(created.windowId).url).searchParams.get("windowId"), created.windowId);
  assert.deepEqual(await manager.openAppPage("/"), { windowId: "main-window" });
  assert.equal(manager.appWindows.size, 1);
  assert.equal(window.focused, true);
});

test("flag-off restore opens only main-window without deleting cached secondary state", async () => {
  const state = topology(9, ["main-window", "window-2", "window-3"]);
  const store = new MemoryStore(state);
  const manager = createManager(store, false);
  await manager.restoreCached(state);
  assert.deepEqual(manager.diagnostics().windowIds, ["main-window"]);
  assert.deepEqual(Object.keys(store.snapshot().windows), ["main-window", "window-2", "window-3"]);
});

test("reconcile closes one approved native window without touching its peers", async () => {
  const current = topology(2, ["main-window", "window-2", "window-3"]);
  const store = new MemoryStore(current);
  const manager = createManager(store);
  await manager.restoreCached(current);
  const candidate = topology(3, ["main-window", "window-3"]);
  await manager.reconcile({
    ...candidate,
    expectedShellRevision: 2,
  });
  assert.deepEqual(manager.diagnostics().windowIds, ["main-window", "window-3"]);
  assert.equal(manager.windows.get("main-window").isDestroyed(), false);
  assert.equal(manager.windows.get("window-3").isDestroyed(), false);
});

test("first topology commit advances from the empty shell revision", async () => {
  const store = new MemoryStore(emptyShellState());
  const manager = createManager(store);
  const candidate = topology(0, ["main-window"]);
  const result = await manager.reconcile({ ...candidate, expectedShellRevision: -1 });
  assert.deepEqual(result, { shellRevision: 0, idempotent: false });
});
