import {
  type ChartCellCreationMode,
  type ChartCellId,
  type ChartCellState,
  type ChartWindowId,
  type ChartWindowState,
  type ChartWorkspaceDocument,
  type ChartWorkspaceSplitDirection,
} from "./chartWorkspaceTypes.js";
import {
  LEGACY_VISIBLE_CELLS_PER_WINDOW,
  MAX_CELLS_PER_APP,
  MAX_CELLS_PER_WINDOW,
} from "./chartWorkspaceCapacity.js";
import { createChartCellId } from "./chartWorkspaceIdentity.js";
import {
  chartWorkspaceWindow,
  replaceChartWorkspaceWindow,
} from "./chartWorkspaceDocument.js";
import {
  closeChartWorkspaceCell,
  firstAvailableChartCellId,
  resetChartWorkspaceLayout,
  splitChartWorkspaceCell,
  swapChartWorkspaceCells,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";

export interface ChartWorkspaceEditResult {
  document: ChartWorkspaceDocument;
  restoreCellIds: readonly ChartCellId[];
}

export interface ChartWorkspaceEditOptions {
  windowId?: ChartWindowId;
  allowDynamicCellIds?: boolean;
  maxCellsPerWindow?: number;
  maxCellsPerApp?: number;
  createCellId?: (occupied: ReadonlySet<ChartCellId>) => ChartCellId | null;
}

export interface ChartWorkspaceLayoutUndoEntry {
  window: ChartWindowState;
  restoredCells: Partial<Record<ChartCellId, ChartCellState>>;
}

export interface ChartWorkspaceLayoutHistory {
  past: readonly ChartWorkspaceLayoutUndoEntry[];
  future: readonly ChartWorkspaceLayoutUndoEntry[];
}

export interface ChartWorkspaceLayoutHistoryStep {
  document: ChartWorkspaceDocument;
  history: ChartWorkspaceLayoutHistory;
}

export const CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT = 20;

export function createEmptyChartWorkspaceLayoutHistory(): ChartWorkspaceLayoutHistory {
  return { past: [], future: [] };
}

function cloneSerializable<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // Persistence already requires JSON-safe chart workspace state.
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function copiedCell(source: ChartCellState, id: ChartCellId): ChartCellState {
  return { ...cloneSerializable(source), id };
}

function blankCell(
  source: ChartCellState,
  existing: ChartCellState | undefined,
  id: ChartCellId,
): ChartCellState {
  return {
    ...cloneSerializable(existing ?? source),
    id,
    linkGroup: null,
    linkRole: "bidirectional",
    session: cloneSerializable(source.session),
    priceScale: { invertScale: false, priceScaleMode: 0 },
    indicators: [],
  };
}

function editWindow(
  document: ChartWorkspaceDocument,
  options: ChartWorkspaceEditOptions,
): ChartWindowState {
  return chartWorkspaceWindow(document, options.windowId ?? document.activeWindowId);
}

function allocateCellId(
  document: ChartWorkspaceDocument,
  window: ChartWindowState,
  options: ChartWorkspaceEditOptions,
): ChartCellId | null {
  const maxCellsPerWindow = Math.min(
    MAX_CELLS_PER_WINDOW,
    Math.max(1, options.maxCellsPerWindow ?? LEGACY_VISIBLE_CELLS_PER_WINDOW),
  );
  if (visibleCellIds(window.layoutTree).length >= maxCellsPerWindow) return null;
  if (!options.allowDynamicCellIds) return firstAvailableChartCellId(window.layoutTree);
  const occupied = new Set(Object.keys(document.cells));
  const maxCellsPerApp = Math.min(
    MAX_CELLS_PER_APP,
    Math.max(1, options.maxCellsPerApp ?? MAX_CELLS_PER_APP),
  );
  if (occupied.size >= maxCellsPerApp) return null;
  return (options.createCellId ?? createChartCellId)(occupied);
}

export function splitChartWorkspaceDocument(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  direction: ChartWorkspaceSplitDirection,
  creationMode: ChartCellCreationMode,
  options: ChartWorkspaceEditOptions = {},
): ChartWorkspaceEditResult {
  const window = editWindow(document, options);
  if (window.layoutLocked) return { document, restoreCellIds: [] };
  const newCellId = allocateCellId(document, window, options);
  if (!newCellId) return { document, restoreCellIds: [] };
  const maxCellsPerWindow = options.maxCellsPerWindow ?? LEGACY_VISIBLE_CELLS_PER_WINDOW;
  const layoutTree = splitChartWorkspaceCell(
    window.layoutTree,
    cellId,
    newCellId,
    direction,
    maxCellsPerWindow,
  );
  if (layoutTree === window.layoutTree) return { document, restoreCellIds: [] };
  const source = document.cells[cellId];
  if (!source) return { document, restoreCellIds: [] };
  const previous = document.cells[newCellId];
  const nextCell = creationMode === "copy"
    ? copiedCell(source, newCellId)
    : blankCell(source, previous, newCellId);
  return {
    document: replaceChartWorkspaceWindow({
      ...document,
      cells: { ...document.cells, [newCellId]: nextCell },
    }, {
      ...window,
      layoutTree,
      activeCellId: newCellId,
      maximizedCellId: null,
    }),
    restoreCellIds: previous ? [newCellId] : [],
  };
}

export function closeChartWorkspaceDocument(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  options: ChartWorkspaceEditOptions = {},
): ChartWorkspaceEditResult {
  const window = editWindow(document, options);
  if (window.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = closeChartWorkspaceCell(window.layoutTree, cellId);
  if (layoutTree === window.layoutTree) return { document, restoreCellIds: [] };
  const remaining = visibleCellIds(layoutTree);
  return {
    document: replaceChartWorkspaceWindow(document, {
      ...window,
      layoutTree,
      activeCellId: window.activeCellId === cellId
        ? remaining[0] ?? window.activeCellId
        : window.activeCellId,
      maximizedCellId: window.maximizedCellId === cellId ? null : window.maximizedCellId,
    }),
    restoreCellIds: [],
  };
}

export function swapChartWorkspaceDocumentCells(
  document: ChartWorkspaceDocument,
  firstCellId: ChartCellId,
  secondCellId: ChartCellId,
  options: ChartWorkspaceEditOptions = {},
): ChartWorkspaceEditResult {
  const window = editWindow(document, options);
  if (window.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = swapChartWorkspaceCells(window.layoutTree, firstCellId, secondCellId);
  return layoutTree === window.layoutTree
    ? { document, restoreCellIds: [] }
    : {
      document: replaceChartWorkspaceWindow(document, { ...window, layoutTree }),
      restoreCellIds: [],
    };
}

export function resetChartWorkspaceDocumentLayout(
  document: ChartWorkspaceDocument,
  options: ChartWorkspaceEditOptions = {},
): ChartWorkspaceEditResult {
  const window = editWindow(document, options);
  if (window.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = resetChartWorkspaceLayout(window.activeCellId);
  if (window.layoutTree.kind === "cell"
    && window.layoutTree.cellId === window.activeCellId
    && window.maximizedCellId === null) {
    return { document, restoreCellIds: [] };
  }
  return {
    document: replaceChartWorkspaceWindow(document, {
      ...window,
      layoutTree,
      maximizedCellId: null,
    }),
    restoreCellIds: [],
  };
}

export function createChartWorkspaceLayoutUndoEntry(
  document: ChartWorkspaceDocument,
  restoreCellIds: readonly ChartCellId[],
  windowId: ChartWindowId = document.activeWindowId,
): ChartWorkspaceLayoutUndoEntry {
  const snapshot = cloneSerializable(document);
  const restoredCells: Partial<Record<ChartCellId, ChartCellState>> = {};
  for (const cellId of restoreCellIds) {
    const cell = snapshot.cells[cellId];
    if (cell) restoredCells[cellId] = cell;
  }
  return {
    window: chartWorkspaceWindow(snapshot, windowId),
    restoredCells,
  };
}

export function applyChartWorkspaceLayoutUndo(
  document: ChartWorkspaceDocument,
  undo: ChartWorkspaceLayoutUndoEntry,
): ChartWorkspaceDocument {
  const restoredCells: Record<ChartCellId, ChartCellState> = { ...document.cells };
  for (const [cellId, cell] of Object.entries(cloneSerializable(undo.restoredCells))) {
    if (cell) restoredCells[cellId] = cell;
  }
  return replaceChartWorkspaceWindow({
    ...document,
    cells: restoredCells,
  }, cloneSerializable(undo.window));
}

function restoredCellIds(entry: ChartWorkspaceLayoutUndoEntry): ChartCellId[] {
  return Object.keys(entry.restoredCells);
}

function boundedHistory(
  entries: readonly ChartWorkspaceLayoutUndoEntry[],
): readonly ChartWorkspaceLayoutUndoEntry[] {
  return entries.length <= CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT
    ? entries
    : entries.slice(-CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT);
}

export function recordChartWorkspaceLayoutEdit(
  history: ChartWorkspaceLayoutHistory,
  before: ChartWorkspaceDocument,
  result: ChartWorkspaceEditResult,
): ChartWorkspaceLayoutHistory {
  if (result.document === before) return history;
  return {
    past: boundedHistory([
      ...history.past,
      createChartWorkspaceLayoutUndoEntry(before, result.restoreCellIds),
    ]),
    future: [],
  };
}

function traverseChartWorkspaceLayoutHistory(
  document: ChartWorkspaceDocument,
  history: ChartWorkspaceLayoutHistory,
  direction: "undo" | "redo",
): ChartWorkspaceLayoutHistoryStep | null {
  const window = chartWorkspaceWindow(document);
  if (window.layoutLocked) return null;
  const source = direction === "undo" ? history.past : history.future;
  const entry = source.at(-1);
  if (!entry) return null;
  const inverse = createChartWorkspaceLayoutUndoEntry(
    document,
    restoredCellIds(entry),
    entry.window.id,
  );
  const remaining = source.slice(0, -1);
  return {
    document: applyChartWorkspaceLayoutUndo(document, entry),
    history: direction === "undo"
      ? { past: remaining, future: boundedHistory([...history.future, inverse]) }
      : { past: boundedHistory([...history.past, inverse]), future: remaining },
  };
}

export function undoChartWorkspaceLayoutEdit(
  document: ChartWorkspaceDocument,
  history: ChartWorkspaceLayoutHistory,
): ChartWorkspaceLayoutHistoryStep | null {
  return traverseChartWorkspaceLayoutHistory(document, history, "undo");
}

export function redoChartWorkspaceLayoutEdit(
  document: ChartWorkspaceDocument,
  history: ChartWorkspaceLayoutHistory,
): ChartWorkspaceLayoutHistoryStep | null {
  return traverseChartWorkspaceLayoutHistory(document, history, "redo");
}
