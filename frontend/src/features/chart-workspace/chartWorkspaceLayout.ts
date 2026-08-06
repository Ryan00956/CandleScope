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

export const MIN_CHART_SPLIT_RATIO = 0.2;
export const MAX_CHART_SPLIT_RATIO = 0.8;

export type ChartWorkspaceSplitAxis = ChartWorkspaceSplitDirection;

export const MAIN_CONFIRMATION_PRIMARY_RATIO = 0.68;

const MAX_LAYOUT_TREE_DEPTH = 4;
const MAX_LAYOUT_TREE_NODES = CHART_CELL_IDS.length * 2 - 1;

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
): ChartWorkspaceLayoutNode {
  if (templateId === "single") return cellNode("cell-1");
  if (templateId === "split-vertical") {
    return splitNode(
      "split-vertical-root",
      "columns",
      normalizeChartSplitRatio(ratios?.splitVertical),
      cellNode("cell-1"),
      cellNode("cell-2"),
    );
  }
  if (templateId === "split-horizontal") {
    return splitNode(
      "split-horizontal-root",
      "rows",
      normalizeChartSplitRatio(ratios?.splitHorizontal),
      cellNode("cell-1"),
      cellNode("cell-2"),
    );
  }
  if (templateId === "main-confirmation") {
    return splitNode(
      "main-confirmation-root",
      "columns",
      MAIN_CONFIRMATION_PRIMARY_RATIO,
      cellNode("cell-1", "main"),
      splitNode(
        "main-confirmation-confirmations",
        "rows",
        0.5,
        cellNode("cell-2", "confirmation"),
        cellNode("cell-3", "confirmation"),
      ),
    );
  }
  return splitNode(
    "quad-root",
    "rows",
    normalizeChartSplitRatio(ratios?.quadRows),
    splitNode(
      "quad-top",
      "columns",
      normalizeChartSplitRatio(ratios?.quadColumns),
      cellNode("cell-1"),
      cellNode("cell-2"),
    ),
    splitNode(
      "quad-bottom",
      "columns",
      normalizeChartSplitRatio(ratios?.quadColumns),
      cellNode("cell-3"),
      cellNode("cell-4"),
    ),
  );
}

function layoutShape(node: ChartWorkspaceLayoutNode): string {
  if (node.kind === "cell") return node.cellId;
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
  const shape = layoutShape(tree);
  for (const [templateId, templateShape] of TEMPLATE_LAYOUT_SHAPES) {
    if (shape === templateShape) return templateId;
  }
  return "custom";
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
): ChartWorkspaceLayoutNode {
  const cellIds = new Set<ChartCellId>();
  const splitIds = new Set<string>();
  let nodeCount = 0;

  const parse = (candidate: unknown, depth: number): ChartWorkspaceLayoutNode | null => {
    if (!isRecord(candidate) || depth > MAX_LAYOUT_TREE_DEPTH) return null;
    nodeCount += 1;
    if (nodeCount > MAX_LAYOUT_TREE_NODES) return null;
    if (candidate.kind === "cell") {
      if (!CHART_CELL_IDS.includes(candidate.cellId as ChartCellId)) return null;
      const cellId = candidate.cellId as ChartCellId;
      if (cellIds.has(cellId)) return null;
      cellIds.add(cellId);
      const role = candidate.role === "main" || candidate.role === "confirmation"
        ? candidate.role
        : undefined;
      return cellNode(cellId, role);
    }
    if (candidate.kind !== "split") return null;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || id.length > 96 || splitIds.has(id)) return null;
    if (candidate.direction !== "columns" && candidate.direction !== "rows") return null;
    splitIds.add(id);
    const first = parse(candidate.first, depth + 1);
    const second = parse(candidate.second, depth + 1);
    if (!first || !second) return null;
    return splitNode(
      id,
      candidate.direction,
      normalizeChartSplitRatio(candidate.ratio),
      first,
      second,
    );
  };

  const parsed = parse(value, 0);
  return parsed && cellIds.size > 0 && cellIds.size <= CHART_CELL_IDS.length
    ? parsed
    : fallback;
}
