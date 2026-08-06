import type {
  ChartCellId,
  ChartWorkspaceCellRole,
  ChartWorkspaceLayoutNode,
  ChartWorkspaceSplitDirection,
} from "./chartWorkspaceTypes.js";

export interface WorkspaceLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceLayoutLeafGeometry {
  cellId: ChartCellId;
  role: ChartWorkspaceCellRole | null;
  rect: WorkspaceLayoutRect;
  visualIndex: number;
}

export interface WorkspaceLayoutSplitGeometry {
  splitId: string;
  direction: ChartWorkspaceSplitDirection;
  ratio: number;
  rect: WorkspaceLayoutRect;
  handleRect: WorkspaceLayoutRect;
}

export interface WorkspaceLayoutGeometry {
  leaves: readonly WorkspaceLayoutLeafGeometry[];
  splits: readonly WorkspaceLayoutSplitGeometry[];
}

const HANDLE_HALF_SIZE = 0.004;

export function computeWorkspaceLayoutGeometry(
  tree: ChartWorkspaceLayoutNode,
): WorkspaceLayoutGeometry {
  const leaves: WorkspaceLayoutLeafGeometry[] = [];
  const splits: WorkspaceLayoutSplitGeometry[] = [];
  const visit = (node: ChartWorkspaceLayoutNode, rect: WorkspaceLayoutRect) => {
    if (node.kind === "cell") {
      leaves.push({
        cellId: node.cellId,
        role: node.role ?? null,
        rect,
        visualIndex: leaves.length,
      });
      return;
    }
    if (node.direction === "columns") {
      const firstWidth = rect.width * node.ratio;
      const boundary = rect.x + firstWidth;
      splits.push({
        splitId: node.id,
        direction: node.direction,
        ratio: node.ratio,
        rect,
        handleRect: {
          x: boundary - HANDLE_HALF_SIZE,
          y: rect.y,
          width: HANDLE_HALF_SIZE * 2,
          height: rect.height,
        },
      });
      visit(node.first, { ...rect, width: firstWidth });
      visit(node.second, {
        x: boundary,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      });
      return;
    }
    const firstHeight = rect.height * node.ratio;
    const boundary = rect.y + firstHeight;
    splits.push({
      splitId: node.id,
      direction: node.direction,
      ratio: node.ratio,
      rect,
      handleRect: {
        x: rect.x,
        y: boundary - HANDLE_HALF_SIZE,
        width: rect.width,
        height: HANDLE_HALF_SIZE * 2,
      },
    });
    visit(node.first, { ...rect, height: firstHeight });
    visit(node.second, {
      x: rect.x,
      y: boundary,
      width: rect.width,
      height: rect.height - firstHeight,
    });
  };
  visit(tree, { x: 0, y: 0, width: 1, height: 1 });
  return { leaves, splits };
}

function percent(value: number): string {
  return `${value * 100}%`;
}

export function workspaceLayoutRectStyle(rect: WorkspaceLayoutRect): Readonly<Record<string, string>> {
  return {
    left: percent(rect.x),
    top: percent(rect.y),
    width: percent(rect.width),
    height: percent(rect.height),
  };
}

export type WorkspaceCellDensity = "full" | "compact" | "minimal";

export function workspaceCellDensityForSize(width: number, height: number): WorkspaceCellDensity {
  if (width < 280 || height < 170) return "minimal";
  if (width < 440 || height < 260) return "compact";
  return "full";
}

export interface WorkspaceLayoutSpaceAssessment {
  sufficient: boolean;
  minimumCellWidth: number;
  minimumCellHeight: number;
  requiredCellWidth: number;
  requiredCellHeight: number;
}

export function assessWorkspaceLayoutSpace(
  geometry: WorkspaceLayoutGeometry,
  width: number,
  height: number,
): WorkspaceLayoutSpaceAssessment {
  const minimumCellWidth = geometry.leaves.length === 0
    ? 0
    : Math.min(...geometry.leaves.map((leaf) => leaf.rect.width * width));
  const minimumCellHeight = geometry.leaves.length === 0
    ? 0
    : Math.min(...geometry.leaves.map((leaf) => leaf.rect.height * height));
  const requiredCellWidth = geometry.leaves.length >= 16 ? 420 : 220;
  const requiredCellHeight = geometry.leaves.length >= 16 ? 190 : 140;
  return {
    sufficient: minimumCellWidth >= requiredCellWidth && minimumCellHeight >= requiredCellHeight,
    minimumCellWidth,
    minimumCellHeight,
    requiredCellWidth,
    requiredCellHeight,
  };
}

export function nextWorkspaceCellInDirection(
  geometry: WorkspaceLayoutGeometry,
  cellId: ChartCellId,
  direction: "left" | "right" | "up" | "down",
): ChartCellId | null {
  const source = geometry.leaves.find((leaf) => leaf.cellId === cellId);
  if (!source) return null;
  const sourceX = source.rect.x + source.rect.width / 2;
  const sourceY = source.rect.y + source.rect.height / 2;
  const candidates = geometry.leaves.flatMap((leaf) => {
    if (leaf.cellId === cellId) return [];
    const x = leaf.rect.x + leaf.rect.width / 2;
    const y = leaf.rect.y + leaf.rect.height / 2;
    const primary = direction === "left" ? sourceX - x
      : direction === "right" ? x - sourceX
        : direction === "up" ? sourceY - y
          : y - sourceY;
    if (primary <= 0) return [];
    const secondary = direction === "left" || direction === "right"
      ? Math.abs(y - sourceY)
      : Math.abs(x - sourceX);
    return [{ cellId: leaf.cellId, score: primary + secondary * 2 }];
  });
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]?.cellId ?? null;
}
