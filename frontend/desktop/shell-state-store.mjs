import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DESKTOP_SHELL_STATE_SCHEMA = "candlescope.desktop-shell-state/1";
export const MAX_DESKTOP_WINDOWS = 4;

export class DesktopTopologyRevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Desktop topology revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "DesktopTopologyRevisionConflictError";
    this.code = "DESKTOP_TOPOLOGY_REVISION_CONFLICT";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function emptyShellState() {
  return {
    schemaVersion: DESKTOP_SHELL_STATE_SCHEMA,
    workspaceId: null,
    workspaceRevision: -1,
    activeWindowId: "main-window",
    windows: {},
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeShellState(value) {
  if (!isRecord(value) || value.schemaVersion !== DESKTOP_SHELL_STATE_SCHEMA) {
    return emptyShellState();
  }
  const entries = Object.entries(isRecord(value.windows) ? value.windows : {})
    .filter(([windowId, windowState]) => (
      typeof windowId === "string"
      && windowId.length > 0
      && windowId.length <= 128
      && isRecord(windowState)
    ))
    .slice(0, MAX_DESKTOP_WINDOWS);
  const windows = Object.fromEntries(entries);
  const activeWindowId = typeof value.activeWindowId === "string" && windows[value.activeWindowId]
    ? value.activeWindowId
    : (windows["main-window"] ? "main-window" : entries[0]?.[0] || "main-window");
  return {
    schemaVersion: DESKTOP_SHELL_STATE_SCHEMA,
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId.slice(0, 128) : null,
    workspaceRevision: Number.isSafeInteger(value.workspaceRevision)
      ? value.workspaceRevision
      : -1,
    activeWindowId,
    windows,
  };
}

export function compareAndSwapShellState(current, expectedRevision, candidate) {
  const normalizedCurrent = normalizeShellState(current);
  if (normalizedCurrent.workspaceRevision !== expectedRevision) {
    throw new DesktopTopologyRevisionConflictError(
      expectedRevision,
      normalizedCurrent.workspaceRevision,
    );
  }
  const normalizedCandidate = normalizeShellState(candidate);
  if (Object.keys(normalizedCandidate.windows).length > MAX_DESKTOP_WINDOWS) {
    throw new RangeError(`Desktop topology exceeds ${MAX_DESKTOP_WINDOWS} windows`);
  }
  return normalizedCandidate;
}

export class DesktopShellStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyShellState();
  }

  async load() {
    try {
      this.state = normalizeShellState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
      this.state = emptyShellState();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async compareAndSwap(expectedRevision, candidate) {
    const committed = compareAndSwapShellState(this.state, expectedRevision, candidate);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(committed, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
    this.state = committed;
    return this.snapshot();
  }
}
