const { contextBridge, ipcRenderer } = require("electron");

const channels = {
  bootstrap: "candlescope:desktop:bootstrap",
  reconcile: "candlescope:desktop:reconcile",
  lifecycle: "candlescope:desktop:lifecycle",
  closeRequested: "candlescope:desktop:close-requested",
  placement: "candlescope:desktop:placement",
  workspaceBusEvent: "candlescope:workspace-bus:event",
  workspaceBusConnect: "candlescope:workspace-bus:connect",
  workspaceBusCommit: "candlescope:workspace-bus:commit",
  workspaceBusLink: "candlescope:workspace-bus:link",
  workspaceBusWindow: "candlescope:workspace-bus:window",
  appWorkAcquire: "candlescope:app-work:acquire",
  appWorkRelease: "candlescope:app-work:release",
  appPreviewRequest: "candlescope:app-preview:request",
  appPreviewRelease: "candlescope:app-preview:release",
  appBudgetDiagnostics: "candlescope:app-budget:diagnostics",
  seriesSnapshotRead: "candlescope:series-snapshot:read",
  seriesSnapshotPublish: "candlescope:series-snapshot:publish",
  seriesSnapshotDiagnostics: "candlescope:series-snapshot:diagnostics",
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
  workspaceBusConnect: (payload) => ipcRenderer.invoke(channels.workspaceBusConnect, payload),
  workspaceBusCommit: (payload) => ipcRenderer.invoke(channels.workspaceBusCommit, payload),
  workspaceBusPublishLink: (payload) => ipcRenderer.invoke(channels.workspaceBusLink, payload),
  workspaceBusReportWindow: (payload) => ipcRenderer.send(channels.workspaceBusWindow, payload),
  onWorkspaceBusEvent: (listener) => subscribe(channels.workspaceBusEvent, listener),
  acquireAppWork: (payload) => ipcRenderer.invoke(channels.appWorkAcquire, payload),
  releaseAppWork: (leaseId) => ipcRenderer.send(channels.appWorkRelease, leaseId),
  requestAppPreview: (payload) => ipcRenderer.invoke(channels.appPreviewRequest, payload),
  releaseAppPreview: (payload) => ipcRenderer.send(channels.appPreviewRelease, payload),
  getAppBudgetDiagnostics: () => ipcRenderer.invoke(channels.appBudgetDiagnostics),
  readSeriesSnapshot: (key) => ipcRenderer.sendSync(channels.seriesSnapshotRead, key),
  publishSeriesSnapshot: (payload) => ipcRenderer.send(channels.seriesSnapshotPublish, payload),
  getSeriesSnapshotDiagnostics: () => ipcRenderer.invoke(channels.seriesSnapshotDiagnostics),
}));
