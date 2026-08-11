import type {
  ChartCellId,
  ChartWorkspaceCellLayoutNode,
  ChartWorkspaceCellRole,
  ChartWorkspaceLayout,
  ChartWorkspaceLayoutNode,
  ChartWorkspaceLayoutRatios,
  ChartWorkspaceSplitDirection,
  ChartWorkspaceSplitLayoutNode,
  ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import {
  CHART_CELL_IDS,
  CHART_WORKSPACE_TEMPLATE_IDS,
} from "./chartWorkspaceTypes.js";
import {
  LEGACY_VISIBLE_CELLS_PER_WINDOW,
  MAX_CELLS_PER_WINDOW,
} from "./chartWorkspaceCapacity.js";
import { isChartCellId } from "./chartWorkspaceIdentity.js";

export const MIN_CHART_SPLIT_RATIO = 0.2;
export const MAX_CHART_SPLIT_RATIO = 0.8;

export type ChartWorkspaceSplitAxis = ChartWorkspaceSplitDirection;

export const MAIN_CONFIRMATION_PRIMARY_RATIO = 0.68;

export const MAX_LAYOUT_TREE_DEPTH = 16;
export const MAX_LAYOUT_TREE_NODES = MAX_CELLS_PER_WINDOW * 2 - 1;

export interface ChartWorkspaceMatrixPreset {
  rows: number;
  columns: number;
}

export const CHART_WORKSPACE_MATRIX_PRESETS = Object.freeze({
  "grid-6": Object.freeze({ rows: 2, columns: 3 }),
  "grid-8": Object.freeze({ rows: 2, columns: 4 }),
  "grid-9": Object.freeze({ rows: 3, columns: 3 }),
  "grid-12": Object.freeze({ rows: 3, columns: 4 }),
  "grid-16": Object.freeze({ rows: 4, columns: 4 }),
} satisfies Record<Extract<ChartWorkspaceTemplateId, `grid-${number}`>, ChartWorkspaceMatrixPreset>);

export function chartWorkspaceTemplateCellCount(templateId: ChartWorkspaceTemplateId): number {
  if (templateId === "single") return 1;
  if (templateId === "split-vertical" || templateId === "split-horizontal") return 2;
  if (templateId === "main-confirmation") return 3;
  if (templateId === "quad") return 4;
  const preset = CHART_WORKSPACE_MATRIX_PRESETS[templateId];
  return preset.rows * preset.columns;
}

export interface ChartWorkspaceLayoutDiagnostic {
  code:
    | "invalid-node"
    | "max-depth"
    | "max-nodes"
    | "invalid-cell-id"
    | "dangling-cell-id"
    | "duplicate-cell-id"
    | "invalid-split-id"
    | "duplicate-split-id"
    | "invalid-direction"
    | "max-cells";
  path: string;
}

export interface NormalizeChartWorkspaceLayoutOptions {
  knownCellIds?: ReadonlySet<ChartCellId>;
  maxCells?: number;
  maxDepth?: number;
  maxNodes?: number;
  path?: string;
}

export interface NormalizeChartWorkspaceLayoutResult {
  tree: ChartWorkspaceLayoutNode | null;
  diagnostics: ChartWorkspaceLayoutDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cellNode(
  cellId: ChartCellId,
  role?: ChartWorkspaceCellRole,
): ChartWorkspaceCellLayoutNode {
  return role ? { kind: "cell", cellId, role } : { kind: "cell", cellId };
}

function splitNode(
  id: string,
  direction: ChartWorkspaceSplitDirection,
  ratio: number,
  first: ChartWorkspaceLayoutNode,
  second: ChartWorkspaceLayoutNode,
): ChartWorkspaceSplitLayoutNode {
  return { kind: "split", id, direction, ratio, first, second };
}

function defaultTemplateCellIds(count: number): ChartCellId[] {
  return Array.from({ length: count }, (_, index) => `cell-${index + 1}`);
}

function combineLayoutNodes(
  nodes: readonly ChartWorkspaceLayoutNode[],
  direction: ChartWorkspaceSplitDirection,
  idPrefix: string,
): ChartWorkspaceLayoutNode {
  if (nodes.length === 1) return nodes[0]!;
  const firstCount = Math.floor(nodes.length / 2);
  return splitNode(
    `${idPrefix}-${nodes.length}`,
    direction,
    firstCount / nodes.length,
    combineLayoutNodes(nodes.slice(0, firstCount), direction, `${idPrefix}-first`),
    combineLayoutNodes(nodes.slice(firstCount), direction, `${idPrefix}-second`),
  );
}

export function createChartWorkspaceMatrixLayoutTree(
  cellIds: readonly ChartCellId[],
  preset: ChartWorkspaceMatrixPreset,
  idPrefix = "matrix",
): ChartWorkspaceLayoutNode {
  const expected = preset.rows * preset.columns;
  if (cellIds.length !== expected
    || expected < 1
    || expected > MAX_CELLS_PER_WINDOW
    || new Set(cellIds).size !== cellIds.length
    || cellIds.some((cellId) => !isChartCellId(cellId))) {
    throw new Error(`Matrix layout requires ${expected} unique valid Cell IDs`);
  }
  const rows = Array.from({ length: preset.rows }, (_, rowIndex) => (
    combineLayoutNodes(
      cellIds
        .slice(rowIndex * preset.columns, (rowIndex + 1) * preset.columns)
        .map((cellId) => cellNode(cellId)),
      "columns",
      `${idPrefix}-row-${rowIndex + 1}`,
    )
  ));
  return combineLayoutNodes(rows, "rows", `${idPrefix}-rows`);
}

export function normalizeChartSplitRatio(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CHART_SPLIT_RATIO, Math.max(MIN_CHART_SPLIT_RATIO, parsed));
}

export function ratioFromPointerPosition(
  pointerPosition: number,
  containerStart: number,
  containerSize: number,
): number | null {
  if (!Number.isFinite(pointerPosition)
    || !Number.isFinite(containerStart)
    || !Number.isFinite(containerSize)
    || containerSize <= 0) return null;
  return normalizeChartSplitRatio((pointerPosition - containerStart) / containerSize);
}

export function createChartWorkspaceLayoutTree(
  templateId: ChartWorkspaceTemplateId,
  ratios?: Partial<ChartWorkspaceLayoutRatios>,
  requestedCellIds?: readonly ChartCellId[],
): ChartWorkspaceLayoutNode {
  const cellIds = requestedCellIds
    ?? defaultTemplateCellIds(chartWorkspaceTemplateCellCount(templateId));
  if (cellIds.length !== chartWorkspaceTemplateCellCount(templateId)) {
    throw new Error(`${templateId} requires ${chartWorkspaceTemplateCellCount(templateId)} Cell IDs`);
  }
  if (templateId === "single") return cellNode(cellIds[0]!);
  if (templateId === "split-vertical") {
    return splitNode(
      "split-vertical-root",
      "columns",
      normalizeChartSplitRatio(ratios?.splitVertical),
      cellNode(cellIds[0]!),
      cellNode(cellIds[1]!),
    );
  }
  if (templateId === "split-horizontal") {
    return splitNode(
      "split-horizontal-root",
      "rows",
      normalizeChartSplitRatio(ratios?.splitHorizontal),
      cellNode(cellIds[0]!),
      cellNode(cellIds[1]!),
    );
  }
  if (templateId === "main-confirmation") {
    return splitNode(
      "main-confirmation-root",
      "columns",
      MAIN_CONFIRMATION_PRIMARY_RATIO,
      cellNode(cellIds[0]!, "main"),
      splitNode(
        "main-confirmation-confirmations",
        "rows",
        0.5,
        cellNode(cellIds[1]!, "confirmation"),
        cellNode(cellIds[2]!, "confirmation"),
      ),
    );
  }
  if (templateId === "quad") {
    return splitNode(
      "quad-root",
      "rows",
      normalizeChartSplitRatio(ratios?.quadRows),
      splitNode(
        "quad-top",
        "columns",
        normalizeChartSplitRatio(ratios?.quadColumns),
        cellNode(cellIds[0]!),
        cellNode(cellIds[1]!),
      ),
      splitNode(
        "quad-bottom",
        "columns",
        normalizeChartSplitRatio(ratios?.quadColumns),
        cellNode(cellIds[2]!),
        cellNode(cellIds[3]!),
      ),
    );
  }
  return createChartWorkspaceMatrixLayoutTree(
    cellIds,
    CHART_WORKSPACE_MATRIX_PRESETS[templateId],
    templateId,
  );
}

function layoutShape(node: ChartWorkspaceLayoutNode): string {
  if (node.kind === "cell") {
    return `cell:${node.role ?? "standard"}`;
  }
  return `${node.direction}(${layoutShape(node.first)},${layoutShape(node.second)})`;
}

const TEMPLATE_LAYOUT_SHAPES = new Map<ChartWorkspaceTemplateId, string>(
  CHART_WORKSPACE_TEMPLATE_IDS.map((templateId) => [
    templateId,
    layoutShape(createChartWorkspaceLayoutTree(templateId)),
  ]),
);

export function detectChartWorkspaceLayout(
  tree: ChartWorkspaceLayoutNode,
): ChartWorkspaceLayout {
  if (tree.kind === "cell") return "single";
  const shape = layoutShape(tree);
  for (const [templateId, templateShape] of TEMPLATE_LAYOUT_SHAPES) {
    if (shape === templateShape) return templateId;
  }
  return "custom";
}

function clearCellRoles(node: ChartWorkspaceLayoutNode): ChartWorkspaceLayoutNode {
  if (node.kind === "cell") {
    return node.role ? { kind: "cell", cellId: node.cellId } : node;
  }
  const first = clearCellRoles(node.first);
  const second = clearCellRoles(node.second);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

function layoutSplitIds(tree: ChartWorkspaceLayoutNode): Set<string> {
  const ids = new Set<string>();
  const visit = (node: ChartWorkspaceLayoutNode) => {
    if (node.kind === "cell") return;
    ids.add(node.id);
    visit(node.first);
    visit(node.second);
  };
  visit(tree);
  return ids;
}

function nextSplitId(
  tree: ChartWorkspaceLayoutNode,
  targetCellId: ChartCellId,
  newCellId: ChartCellId,
  direction: ChartWorkspaceSplitDirection,
): string {
  const occupied = layoutSplitIds(tree);
  const stem = `custom-${direction}-${targetCellId}-${newCellId}`;
  if (!occupied.has(stem)) return stem;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${stem}-overflow`;
}

export interface FirstAvailableChartCellIdOptions {
  occupiedCellIds?: Iterable<ChartCellId>;
  maxCells?: number;
  createCellId?: (occupied: ReadonlySet<ChartCellId>) => ChartCellId | null;
}

export function firstAvailableChartCellId(
  tree: ChartWorkspaceLayoutNode,
  options: FirstAvailableChartCellIdOptions = {},
): ChartCellId | null {
  const visibleCellIdList = visibleCellIds(tree);
  const maxCells = Math.min(
    MAX_CELLS_PER_WINDOW,
    Math.max(1, options.maxCells ?? MAX_CELLS_PER_WINDOW),
  );
  if (visibleCellIdList.length >= maxCells) return null;
  const occupied = new Set(options.occupiedCellIds ?? visibleCellIdList);
  for (const cellId of visibleCellIdList) occupied.add(cellId);
  const factory = options.createCellId ?? ((ids: ReadonlySet<ChartCellId>) => (
    CHART_CELL_IDS.find((cellId) => !ids.has(cellId)) ?? null
  ));
  return factory(occupied);
}

export function projectChartWorkspaceLayoutTree(
  tree: ChartWorkspaceLayoutNode,
  maxCells: number,
): ChartWorkspaceLayoutNode {
  const limit = Math.min(MAX_CELLS_PER_WINDOW, Math.max(1, Math.floor(maxCells)));
  const cellIds = visibleCellIds(tree);
  if (cellIds.length <= limit) return tree;
  const projected = cellIds.slice(0, limit);
  if (limit === 1) return cellNode(projected[0]!);
  if (limit === 2) {
    return createChartWorkspaceLayoutTree("split-vertical", undefined, projected);
  }
  if (limit === 3) {
    return createChartWorkspaceLayoutTree("main-confirmation", undefined, projected);
  }
  if (limit === 4) return createChartWorkspaceLayoutTree("quad", undefined, projected);
  const rows = Math.floor(Math.sqrt(limit));
  const columns = Math.ceil(limit / rows);
  if (rows * columns !== limit) {
    return combineLayoutNodes(projected.map((cellId) => cellNode(cellId)), "columns", "projection");
  }
  return createChartWorkspaceMatrixLayoutTree(projected, { rows, columns }, "projection");
}

export function splitChartWorkspaceCell(
  tree: ChartWorkspaceLayoutNode,
  targetCellId: ChartCellId,
  newCellId: ChartCellId,
  direction: ChartWorkspaceSplitDirection,
  maxCells = LEGACY_VISIBLE_CELLS_PER_WINDOW,
): ChartWorkspaceLayoutNode {
  const visible = visibleCellIds(tree);
  if (!visible.includes(targetCellId)
    || visible.includes(newCellId)
    || visible.length >= Math.min(MAX_CELLS_PER_WINDOW, maxCells)) return tree;
  const splitId = nextSplitId(tree, targetCellId, newCellId, direction);
  const replace = (node: ChartWorkspaceLayoutNode): ChartWorkspaceLayoutNode => {
    if (node.kind === "cell") {
      if (node.cellId !== targetCellId) return node;
      return splitNode(
        splitId,
        direction,
        0.5,
        cellNode(targetCellId),
        cellNode(newCellId),
      );
    }
    const first = replace(node.first);
    const second = replace(node.second);
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  };
  return clearCellRoles(replace(tree));
}

export function closeChartWorkspaceCell(
  tree: ChartWorkspaceLayoutNode,
  cellId: ChartCellId,
): ChartWorkspaceLayoutNode {
  const visible = visibleCellIds(tree);
  if (visible.length <= 1 || !visible.includes(cellId)) return tree;
  const remove = (node: ChartWorkspaceLayoutNode): ChartWorkspaceLayoutNode | null => {
    if (node.kind === "cell") return node.cellId === cellId ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  };
  return clearCellRoles(remove(tree) ?? tree);
}

export function swapChartWorkspaceCells(
  tree: ChartWorkspaceLayoutNode,
  firstCellId: ChartCellId,
  secondCellId: ChartCellId,
): ChartWorkspaceLayoutNode {
  if (firstCellId === secondCellId) return tree;
  const visible = visibleCellIds(tree);
  if (!visible.includes(firstCellId) || !visible.includes(secondCellId)) return tree;
  const swap = (node: ChartWorkspaceLayoutNode): ChartWorkspaceLayoutNode => {
    if (node.kind === "cell") {
      if (node.cellId === firstCellId) return { ...node, cellId: secondCellId };
      if (node.cellId === secondCellId) return { ...node, cellId: firstCellId };
      return node;
    }
    const first = swap(node.first);
    const second = swap(node.second);
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  };
  return swap(tree);
}

export function resetChartWorkspaceLayout(
  activeCellId: ChartCellId,
): ChartWorkspaceLayoutNode {
  return cellNode(activeCellId);
}

export function visibleCellIds(
  tree: ChartWorkspaceLayoutNode,
  maximizedCellId: ChartCellId | null = null,
): ChartCellId[] {
  if (maximizedCellId) return [maximizedCellId];
  const cells: ChartCellId[] = [];
  const visit = (node: ChartWorkspaceLayoutNode) => {
    if (node.kind === "cell") {
      cells.push(node.cellId);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  visit(tree);
  return cells;
}

export function findChartWorkspaceCellRole(
  tree: ChartWorkspaceLayoutNode,
  cellId: ChartCellId,
): ChartWorkspaceCellRole | null {
  if (tree.kind === "cell") return tree.cellId === cellId ? tree.role ?? null : null;
  return findChartWorkspaceCellRole(tree.first, cellId)
    ?? findChartWorkspaceCellRole(tree.second, cellId);
}

export function updateChartWorkspaceSplitRatio(
  tree: ChartWorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): ChartWorkspaceLayoutNode {
  if (tree.kind === "cell") return tree;
  if (tree.id === splitId) {
    const normalized = normalizeChartSplitRatio(ratio, tree.ratio);
    return normalized === tree.ratio ? tree : { ...tree, ratio: normalized };
  }
  const first = updateChartWorkspaceSplitRatio(tree.first, splitId, ratio);
  const second = updateChartWorkspaceSplitRatio(tree.second, splitId, ratio);
  return first === tree.first && second === tree.second
    ? tree
    : { ...tree, first, second };
}

export function normalizeChartWorkspaceLayoutTree(
  value: unknown,
  fallback: ChartWorkspaceLayoutNode = createChartWorkspaceLayoutTree("single"),
  options: NormalizeChartWorkspaceLayoutOptions = {},
): ChartWorkspaceLayoutNode {
  return parseChartWorkspaceLayoutTree(value, options).tree ?? fallback;
}

export function parseChartWorkspaceLayoutTree(
  value: unknown,
  options: NormalizeChartWorkspaceLayoutOptions = {},
): NormalizeChartWorkspaceLayoutResult {
  const cellIds = new Set<ChartCellId>();
  const splitIds = new Set<string>();
  const diagnostics: ChartWorkspaceLayoutDiagnostic[] = [];
  const knownCellIds = options.knownCellIds ?? new Set<ChartCellId>(CHART_CELL_IDS);
  const maxCells = Math.min(MAX_CELLS_PER_WINDOW, Math.max(1, options.maxCells ?? CHART_CELL_IDS.length));
  const maxDepth = Math.min(MAX_LAYOUT_TREE_DEPTH, Math.max(1, options.maxDepth ?? MAX_LAYOUT_TREE_DEPTH));
  const maxNodes = Math.min(MAX_LAYOUT_TREE_NODES, Math.max(1, options.maxNodes ?? MAX_LAYOUT_TREE_NODES));
  const rootPath = options.path ?? "layoutTree";
  let nodeCount = 0;

  const fail = (code: ChartWorkspaceLayoutDiagnostic["code"], path: string) => {
    diagnostics.push({ code, path });
    return null;
  };
  const parse = (
    candidate: unknown,
    depth: number,
    path: string,
  ): ChartWorkspaceLayoutNode | null => {
    if (!isRecord(candidate)) return fail("invalid-node", path);
    if (depth > maxDepth) return fail("max-depth", path);
    nodeCount += 1;
    if (nodeCount > maxNodes) return fail("max-nodes", path);
    if (candidate.kind === "cell") {
      if (!isChartCellId(candidate.cellId)) return fail("invalid-cell-id", `${path}.cellId`);
      const cellId = candidate.cellId;
      if (!knownCellIds.has(cellId)) return fail("dangling-cell-id", `${path}.cellId`);
      if (cellIds.has(cellId)) return fail("duplicate-cell-id", `${path}.cellId`);
      if (cellIds.size >= maxCells) return fail("max-cells", `${path}.cellId`);
      cellIds.add(cellId);
      const role = candidate.role === "main" || candidate.role === "confirmation"
        ? candidate.role
        : undefined;
      return cellNode(cellId, role);
    }
    if (candidate.kind !== "split") return fail("invalid-node", `${path}.kind`);
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || id.length > 96) return fail("invalid-split-id", `${path}.id`);
    if (splitIds.has(id)) return fail("duplicate-split-id", `${path}.id`);
    if (candidate.direction !== "columns" && candidate.direction !== "rows") {
      return fail("invalid-direction", `${path}.direction`);
    }
    splitIds.add(id);
    const first = parse(candidate.first, depth + 1, `${path}.first`);
    const second = parse(candidate.second, depth + 1, `${path}.second`);
    if (!first || !second) return null;
    return splitNode(
      id,
      candidate.direction,
      normalizeChartSplitRatio(candidate.ratio),
      first,
      second,
    );
  };

  const tree = parse(value, 0, rootPath);
  return {
    tree: tree && cellIds.size > 0 && cellIds.size <= maxCells ? tree : null,
    diagnostics,
  };
}
