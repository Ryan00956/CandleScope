import {
  MAIN_CHART_WINDOW_ID,
  type ChartCellId,
  type ChartCellState,
  type ChartWindowId,
  type ChartWindowState,
  type ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";

export function chartWorkspaceCell(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
): ChartCellState {
  const cell = document.cells[cellId];
  if (!cell) throw new Error(`Unknown chart cell: ${cellId}`);
  return cell;
}

export class ChartWorkspaceRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly workspaceId: string | null;

  constructor(expectedRevision: number, actualRevision: number, workspaceId: string | null = null) {
    super(`${workspaceId ? `Workspace ${workspaceId}` : "Workspace"} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "ChartWorkspaceRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.workspaceId = workspaceId;
  }
}

export function chartWorkspaceWindow(
  document: ChartWorkspaceDocument,
  windowId: ChartWindowId = document.activeWindowId,
): ChartWindowState {
  return document.windows[windowId]
    ?? document.windows[MAIN_CHART_WINDOW_ID]
    ?? Object.values(document.windows)[0]!;
}

export function activeChartWorkspaceWindow(
  document: ChartWorkspaceDocument,
): ChartWindowState {
  return chartWorkspaceWindow(document, document.activeWindowId);
}

export function replaceChartWorkspaceWindow(
  document: ChartWorkspaceDocument,
  window: ChartWindowState,
): ChartWorkspaceDocument {
  return document.windows[window.id] === window
    ? document
    : {
      ...document,
      windows: { ...document.windows, [window.id]: window },
    };
}

export function advanceChartWorkspaceRevision(
  current: ChartWorkspaceDocument,
  candidate: ChartWorkspaceDocument,
): ChartWorkspaceDocument {
  if (candidate === current) return current;
  if (!Number.isSafeInteger(current.revision) || current.revision < 0) {
    throw new ChartWorkspaceRevisionConflictError(0, current.revision);
  }
  return { ...candidate, revision: current.revision + 1 };
}

export function compareAndSwapChartWorkspaceDocument(
  current: ChartWorkspaceDocument,
  expectedRevision: number,
  candidate: ChartWorkspaceDocument,
): ChartWorkspaceDocument {
  if (current.revision !== expectedRevision) {
    throw new ChartWorkspaceRevisionConflictError(expectedRevision, current.revision);
  }
  return advanceChartWorkspaceRevision(current, candidate);
}
