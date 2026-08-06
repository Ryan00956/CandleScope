export const DESKTOP_IPC = Object.freeze({
  bootstrap: "candlescope:desktop:bootstrap",
  reconcile: "candlescope:desktop:reconcile",
  lifecycle: "candlescope:desktop:lifecycle",
  closeRequested: "candlescope:desktop:close-requested",
  placement: "candlescope:desktop:placement",
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validBounds(value) {
  return Boolean(value)
    && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.width > 0
    && value.height > 0;
}

export function validateTopologyPayload(value) {
  if (!value || typeof value !== "object") throw new TypeError("Desktop topology must be an object");
  if (!validId(value.workspaceId)) throw new TypeError("Desktop topology workspaceId is invalid");
  if (!Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision < 0) {
    throw new TypeError("Desktop topology workspaceRevision is invalid");
  }
  if (!Number.isSafeInteger(value.expectedShellRevision) || value.expectedShellRevision < -1) {
    throw new TypeError("Desktop topology expectedShellRevision is invalid");
  }
  if (!validId(value.activeWindowId)) throw new TypeError("Desktop topology activeWindowId is invalid");
  const windows = value.windows;
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) {
    throw new TypeError("Desktop topology windows must be a record");
  }
  const entries = Object.entries(windows);
  if (entries.length < 1 || entries.length > 4) throw new RangeError("Desktop topology must contain 1 to 4 windows");
  for (const [windowId, state] of entries) {
    if (!validId(windowId) || state?.id !== windowId) throw new TypeError("Desktop topology window identity is invalid");
    if (state.boundsDip !== null && !validBounds(state.boundsDip)) {
      throw new TypeError(`Desktop topology bounds are invalid for ${windowId}`);
    }
    if (!["normal", "maximized", "minimized"].includes(state.windowState)) {
      throw new TypeError(`Desktop topology state is invalid for ${windowId}`);
    }
  }
  if (!windows[value.activeWindowId]) throw new TypeError("Desktop topology activeWindowId is missing");
  return structuredClone(value);
}
