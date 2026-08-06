import {
  CHART_CELL_IDS,
  type ChartCellCreationMode,
  type ChartCellId,
  type ChartCellState,
  type ChartWorkspaceDocument,
  type ChartWorkspaceLayoutNode,
  type ChartWorkspaceSplitDirection,
} from "./chartWorkspaceTypes.js";
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

export interface ChartWorkspaceLayoutUndoEntry {
  layoutTree: ChartWorkspaceLayoutNode;
  activeCellId: ChartCellId;
  maximizedCellId: ChartCellId | null;
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
  existing: ChartCellState,
  id: ChartCellId,
): ChartCellState {
  return {
    ...cloneSerializable(existing),
    id,
    linkGroup: null,
    linkRole: "bidirectional",
    session: cloneSerializable(source.session),
    priceScale: { invertScale: false, priceScaleMode: 0 },
    indicators: [],
  };
}

export function splitChartWorkspaceDocument(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
  direction: ChartWorkspaceSplitDirection,
  creationMode: ChartCellCreationMode,
): ChartWorkspaceEditResult {
  if (document.layoutLocked) return { document, restoreCellIds: [] };
  const newCellId = firstAvailableChartCellId(document.layoutTree);
  if (!newCellId) return { document, restoreCellIds: [] };
  const layoutTree = splitChartWorkspaceCell(
    document.layoutTree,
    cellId,
    newCellId,
    direction,
  );
  if (layoutTree === document.layoutTree) return { document, restoreCellIds: [] };
  const source = document.cells[cellId];
  const nextCell = creationMode === "copy"
    ? copiedCell(source, newCellId)
    : blankCell(source, document.cells[newCellId], newCellId);
  return {
    document: {
      ...document,
      layoutTree,
      activeCellId: newCellId,
      maximizedCellId: null,
      cells: {
        ...document.cells,
        [newCellId]: nextCell,
      },
    },
    restoreCellIds: [newCellId],
  };
}

export function closeChartWorkspaceDocument(
  document: ChartWorkspaceDocument,
  cellId: ChartCellId,
): ChartWorkspaceEditResult {
  if (document.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = closeChartWorkspaceCell(document.layoutTree, cellId);
  if (layoutTree === document.layoutTree) return { document, restoreCellIds: [] };
  const remaining = visibleCellIds(layoutTree);
  const activeCellId = document.activeCellId === cellId
    ? remaining[0] ?? document.activeCellId
    : document.activeCellId;
  return {
    document: {
      ...document,
      layoutTree,
      activeCellId,
      maximizedCellId: document.maximizedCellId === cellId
        ? null
        : document.maximizedCellId,
    },
    restoreCellIds: [],
  };
}

export function swapChartWorkspaceDocumentCells(
  document: ChartWorkspaceDocument,
  firstCellId: ChartCellId,
  secondCellId: ChartCellId,
): ChartWorkspaceEditResult {
  if (document.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = swapChartWorkspaceCells(
    document.layoutTree,
    firstCellId,
    secondCellId,
  );
  return layoutTree === document.layoutTree
    ? { document, restoreCellIds: [] }
    : { document: { ...document, layoutTree }, restoreCellIds: [] };
}

export function resetChartWorkspaceDocumentLayout(
  document: ChartWorkspaceDocument,
): ChartWorkspaceEditResult {
  if (document.layoutLocked) return { document, restoreCellIds: [] };
  const layoutTree = resetChartWorkspaceLayout(document.activeCellId);
  if (document.layoutTree.kind === "cell"
    && document.layoutTree.cellId === document.activeCellId
    && document.maximizedCellId === null) {
    return { document, restoreCellIds: [] };
  }
  return {
    document: {
      ...document,
      layoutTree,
      maximizedCellId: null,
    },
    restoreCellIds: [],
  };
}

export function createChartWorkspaceLayoutUndoEntry(
  document: ChartWorkspaceDocument,
  restoreCellIds: readonly ChartCellId[],
): ChartWorkspaceLayoutUndoEntry {
  const snapshot = cloneSerializable(document);
  return {
    layoutTree: snapshot.layoutTree,
    activeCellId: snapshot.activeCellId,
    maximizedCellId: snapshot.maximizedCellId,
    restoredCells: Object.fromEntries(restoreCellIds.map((cellId) => [
      cellId,
      snapshot.cells[cellId],
    ])) as Partial<Record<ChartCellId, ChartCellState>>,
  };
}

export function applyChartWorkspaceLayoutUndo(
  document: ChartWorkspaceDocument,
  undo: ChartWorkspaceLayoutUndoEntry,
): ChartWorkspaceDocument {
  return {
    ...document,
    layoutTree: cloneSerializable(undo.layoutTree),
    activeCellId: undo.activeCellId,
    maximizedCellId: undo.maximizedCellId,
    cells: {
      ...document.cells,
      ...cloneSerializable(undo.restoredCells),
    },
  };
}

function restoredCellIds(
  entry: ChartWorkspaceLayoutUndoEntry,
): ChartCellId[] {
  return CHART_CELL_IDS.filter((cellId) => entry.restoredCells[cellId] !== undefined);
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
  if (document.layoutLocked) return null;
  const source = direction === "undo" ? history.past : history.future;
  const entry = source.at(-1);
  if (!entry) return null;
  const inverse = createChartWorkspaceLayoutUndoEntry(
    document,
    restoredCellIds(entry),
  );
  const remaining = source.slice(0, -1);
  return {
    document: applyChartWorkspaceLayoutUndo(document, entry),
    history: direction === "undo"
      ? {
        past: remaining,
        future: boundedHistory([...history.future, inverse]),
      }
      : {
        past: boundedHistory([...history.past, inverse]),
        future: remaining,
      },
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
