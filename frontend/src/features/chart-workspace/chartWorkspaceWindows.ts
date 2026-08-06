import {
  MAX_CELLS_PER_APP,
  MAX_WINDOWS_PER_WORKSPACE,
} from "./chartWorkspaceCapacity.js";
import {
  compareAndSwapChartWorkspaceDocument,
  chartWorkspaceWindow,
} from "./chartWorkspaceDocument.js";
import { createChartCellId } from "./chartWorkspaceIdentity.js";
import { visibleCellIds } from "./chartWorkspaceLayout.js";
import type {
  ChartCellId,
  ChartWindowId,
  ChartWindowState,
  ChartWorkspaceDocument,
  ChartWorkspaceLayoutNode,
} from "./chartWorkspaceTypes.js";

function cloneSerializable<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function createChartWindowId(occupied: ReadonlySet<ChartWindowId>): ChartWindowId | null {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const candidate = `window-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return null;
}

function remapLayoutTree(
  node: ChartWorkspaceLayoutNode,
  cellIds: ReadonlyMap<ChartCellId, ChartCellId>,
): ChartWorkspaceLayoutNode {
  if (node.kind === "cell") return { ...node, cellId: cellIds.get(node.cellId)! };
  return {
    ...node,
    first: remapLayoutTree(node.first, cellIds),
    second: remapLayoutTree(node.second, cellIds),
  };
}

export interface CreateChartWorkspaceWindowOptions {
  sourceWindowId?: ChartWindowId;
  createWindowId?: (occupied: ReadonlySet<ChartWindowId>) => ChartWindowId | null;
  createCellId?: (occupied: ReadonlySet<ChartCellId>) => ChartCellId | null;
}

export function createChartWorkspaceWindowCandidate(
  document: ChartWorkspaceDocument,
  options: CreateChartWorkspaceWindowOptions = {},
): ChartWorkspaceDocument {
  const windowIds = Object.keys(document.windows);
  if (windowIds.length >= MAX_WINDOWS_PER_WORKSPACE) return document;
  const source = chartWorkspaceWindow(document, options.sourceWindowId ?? document.activeWindowId);
  const sourceCellIds = visibleCellIds(source.layoutTree);
  if (Object.keys(document.cells).length + sourceCellIds.length > MAX_CELLS_PER_APP) return document;

  const windowId = (options.createWindowId ?? createChartWindowId)(new Set(windowIds));
  if (!windowId || document.windows[windowId]) return document;
  const occupiedCells = new Set(Object.keys(document.cells));
  const cellIds = new Map<ChartCellId, ChartCellId>();
  for (const sourceCellId of sourceCellIds) {
    const targetCellId = (options.createCellId ?? createChartCellId)(occupiedCells);
    if (!targetCellId || occupiedCells.has(targetCellId)) return document;
    occupiedCells.add(targetCellId);
    cellIds.set(sourceCellId, targetCellId);
  }
  const cells = { ...document.cells };
  for (const [sourceCellId, targetCellId] of cellIds) {
    cells[targetCellId] = { ...cloneSerializable(document.cells[sourceCellId]!), id: targetCellId };
  }
  const window: ChartWindowState = {
    ...cloneSerializable(source),
    id: windowId,
    layoutTree: remapLayoutTree(source.layoutTree, cellIds),
    activeCellId: cellIds.get(source.activeCellId) ?? cellIds.values().next().value!,
    maximizedCellId: source.maximizedCellId ? cellIds.get(source.maximizedCellId) ?? null : null,
    boundsDip: null,
    monitorFingerprint: null,
    dpiScale: null,
    windowState: "normal",
  };
  return {
    ...document,
    activeWindowId: windowId,
    windows: { ...document.windows, [windowId]: window },
    cells,
  };
}

export function createChartWorkspaceWindow(
  document: ChartWorkspaceDocument,
  expectedRevision: number,
  options: CreateChartWorkspaceWindowOptions = {},
): ChartWorkspaceDocument {
  return compareAndSwapChartWorkspaceDocument(
    document,
    expectedRevision,
    createChartWorkspaceWindowCandidate(document, options),
  );
}

export function closeChartWorkspaceWindowCandidate(
  document: ChartWorkspaceDocument,
  windowId: ChartWindowId,
): ChartWorkspaceDocument {
  if (windowId === "main-window" || !document.windows[windowId]) return document;
  const removedCellIds = new Set(visibleCellIds(document.windows[windowId].layoutTree));
  const windows = { ...document.windows };
  delete windows[windowId];
  const referenced = new Set(Object.values(windows).flatMap((window) => visibleCellIds(window.layoutTree)));
  const cells = Object.fromEntries(Object.entries(document.cells).filter(([cellId]) => (
    !removedCellIds.has(cellId) || referenced.has(cellId)
  )));
  return {
    ...document,
    activeWindowId: document.activeWindowId === windowId
      ? (windows["main-window"] ? "main-window" : Object.keys(windows)[0]!)
      : document.activeWindowId,
    windows,
    cells,
  };
}

export function closeChartWorkspaceWindow(
  document: ChartWorkspaceDocument,
  expectedRevision: number,
  windowId: ChartWindowId,
): ChartWorkspaceDocument {
  return compareAndSwapChartWorkspaceDocument(
    document,
    expectedRevision,
    closeChartWorkspaceWindowCandidate(document, windowId),
  );
}

export function updateChartWorkspaceWindowPlacementCandidate(
  document: ChartWorkspaceDocument,
  windowId: ChartWindowId,
  placement: Pick<ChartWindowState, "boundsDip" | "monitorFingerprint" | "dpiScale" | "windowState">,
): ChartWorkspaceDocument {
  const current = document.windows[windowId];
  if (!current) return document;
  const unchanged = JSON.stringify({
    boundsDip: current.boundsDip,
    monitorFingerprint: current.monitorFingerprint,
    dpiScale: current.dpiScale,
    windowState: current.windowState,
  }) === JSON.stringify(placement);
  if (unchanged) return document;
  return {
    ...document,
    windows: { ...document.windows, [windowId]: { ...current, ...placement } },
  };
}
