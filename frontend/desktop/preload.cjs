const { contextBridge, ipcRenderer } = require("electron");

const channels = {
  bootstrap: "candlescope:desktop:bootstrap",
  reconcile: "candlescope:desktop:reconcile",
  lifecycle: "candlescope:desktop:lifecycle",
  closeRequested: "candlescope:desktop:close-requested",
  placement: "candlescope:desktop:placement",
};

function subscribe(channel, listener) {
  if (typeof listener !== "function") throw new TypeError("Desktop listener must be a function");
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("candlescopeDesktop", Object.freeze({
  apiBase: `http://127.0.0.1:${process.env.CANDLESCOPE_DESKTOP_BACKEND_PORT || "18080"}/api/v1`,
  getBootstrap: () => ipcRenderer.invoke(channels.bootstrap),
  reconcileWorkspace: (payload) => ipcRenderer.invoke(channels.reconcile, payload),
  onLifecycle: (listener) => subscribe(channels.lifecycle, listener),
  onCloseRequested: (listener) => subscribe(channels.closeRequested, listener),
  onPlacement: (listener) => subscribe(channels.placement, listener),
}));
