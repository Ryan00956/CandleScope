import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";

export interface ChartLinkedTimeRange {
  from: number;
  to: number;
}

export interface ChartLinkSurface {
  setLinkedCrosshairTime(time: number | null): boolean;
  setLinkedVisibleTimeRange(range: ChartLinkedTimeRange): boolean;
}

export class ChartLinkCoordinator {
  private readonly surfaces = new Map<ChartCellId, ChartLinkSurface>();
  private publishingCrosshair = false;
  private publishingTimeRange = false;
  private document: ChartWorkspaceDocument;

  constructor(document: ChartWorkspaceDocument) {
    this.document = document;
  }

  updateDocument(document: ChartWorkspaceDocument): void {
    this.document = document;
  }

  register(cellId: ChartCellId, surface: ChartLinkSurface): () => void {
    this.surfaces.set(cellId, surface);
    return () => {
      if (this.surfaces.get(cellId) === surface) this.surfaces.delete(cellId);
    };
  }

  private linkedTargets(
    sourceCellId: ChartCellId,
    option: "crosshair" | "timeRange",
  ): ChartLinkSurface[] {
    const document = this.document;
    const sourceGroup = document.cells[sourceCellId]?.linkGroup ?? null;
    if (sourceGroup === null || !document.linkGroups[sourceGroup][option]) return [];
    const targets: ChartLinkSurface[] = [];
    for (const [cellId, surface] of this.surfaces) {
      if (cellId === sourceCellId) continue;
      if (document.cells[cellId]?.linkGroup === sourceGroup) targets.push(surface);
    }
    return targets;
  }

  publishCrosshair(sourceCellId: ChartCellId, time: number | null): void {
    if (this.publishingCrosshair) return;
    const normalizedTime = time === null || Number.isFinite(time) ? time : null;
    this.publishingCrosshair = true;
    try {
      for (const surface of this.linkedTargets(sourceCellId, "crosshair")) {
        surface.setLinkedCrosshairTime(normalizedTime);
      }
    } finally {
      this.publishingCrosshair = false;
    }
  }

  publishTimeRange(sourceCellId: ChartCellId, range: ChartLinkedTimeRange): void {
    if (this.publishingTimeRange) return;
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const normalizedRange = from <= to ? { from, to } : { from: to, to: from };
    this.publishingTimeRange = true;
    try {
      for (const surface of this.linkedTargets(sourceCellId, "timeRange")) {
        surface.setLinkedVisibleTimeRange(normalizedRange);
      }
    } finally {
      this.publishingTimeRange = false;
    }
  }

  registeredCellIds(): ChartCellId[] {
    return [...this.surfaces.keys()];
  }
}

export function sameLinkGroup(
  document: ChartWorkspaceDocument,
  left: ChartCellId,
  right: ChartCellId,
): ChartLinkGroupId | null {
  const group = document.cells[left]?.linkGroup ?? null;
  return group !== null && document.cells[right]?.linkGroup === group ? group : null;
}
