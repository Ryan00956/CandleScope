import {
  canPublishChartLinks,
  canReceiveChartLinks,
} from "./chartWorkspaceLinkModel.js";
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
  setLinkedVisibleTimeAnchor(time: number): boolean;
  setLinkedVisibleTimeRange(range: ChartLinkedTimeRange): boolean;
}

export interface ChartLinkViewportIssue {
  group: ChartLinkGroupId;
  kind: "timeAnchor" | "dateRange";
  sourceCellId: ChartCellId;
  failedCellIds: readonly ChartCellId[];
}

type ViewportIssueListener = (issue: ChartLinkViewportIssue | null) => void;
type LinkOption = "crosshair" | "timeAnchor" | "dateRange";

interface LinkedTarget {
  cellId: ChartCellId;
  surface: ChartLinkSurface;
}

function sameViewportIssue(
  left: ChartLinkViewportIssue | null,
  right: ChartLinkViewportIssue | null,
): boolean {
  return left === right || Boolean(left && right
    && left.group === right.group
    && left.kind === right.kind
    && left.sourceCellId === right.sourceCellId
    && left.failedCellIds.join("\u0000") === right.failedCellIds.join("\u0000"));
}

export class ChartLinkCoordinator {
  private readonly surfaces = new Map<ChartCellId, ChartLinkSurface>();
  private readonly viewportIssueListeners = new Set<ViewportIssueListener>();
  private publishingCrosshair = false;
  private publishingViewport = false;
  private document: ChartWorkspaceDocument;
  private viewportIssue: ChartLinkViewportIssue | null = null;

  constructor(document: ChartWorkspaceDocument) {
    this.document = document;
  }

  updateDocument(document: ChartWorkspaceDocument): void {
    if (document !== this.document) this.setViewportIssue(null);
    this.document = document;
  }

  register(cellId: ChartCellId, surface: ChartLinkSurface): () => void {
    this.surfaces.set(cellId, surface);
    return () => {
      if (this.surfaces.get(cellId) === surface) this.surfaces.delete(cellId);
    };
  }

  subscribeViewportIssue(listener: ViewportIssueListener): () => void {
    this.viewportIssueListeners.add(listener);
    return () => { this.viewportIssueListeners.delete(listener); };
  }

  getViewportIssue(): ChartLinkViewportIssue | null {
    return this.viewportIssue;
  }

  private setViewportIssue(issue: ChartLinkViewportIssue | null): void {
    if (sameViewportIssue(this.viewportIssue, issue)) return;
    this.viewportIssue = issue;
    for (const listener of [...this.viewportIssueListeners]) listener(issue);
  }

  private linkedTargets(
    sourceCellId: ChartCellId,
    option: LinkOption,
  ): { group: ChartLinkGroupId | null; targets: LinkedTarget[] } {
    const document = this.document;
    const sourceCell = document.cells[sourceCellId];
    const sourceGroup = sourceCell?.linkGroup ?? null;
    if (sourceGroup === null
      || !canPublishChartLinks(sourceCell.linkRole)
      || !document.linkGroups[sourceGroup][option]) {
      return { group: sourceGroup, targets: [] };
    }
    const targets: LinkedTarget[] = [];
    for (const [cellId, surface] of this.surfaces) {
      const cell = document.cells[cellId];
      if (cellId === sourceCellId
        || cell?.linkGroup !== sourceGroup
        || !canReceiveChartLinks(cell.linkRole)) continue;
      targets.push({ cellId, surface });
    }
    return { group: sourceGroup, targets };
  }

  publishCrosshair(sourceCellId: ChartCellId, time: number | null): void {
    if (this.publishingCrosshair) return;
    const normalizedTime = time === null || Number.isFinite(time) ? time : null;
    this.publishingCrosshair = true;
    try {
      for (const { surface } of this.linkedTargets(sourceCellId, "crosshair").targets) {
        try {
          surface.setLinkedCrosshairTime(normalizedTime);
        } catch {
          // One unavailable target must not block the other linked charts.
        }
      }
    } finally {
      this.publishingCrosshair = false;
    }
  }

  publishTimeAnchor(sourceCellId: ChartCellId, time: number): void {
    if (this.publishingViewport || !Number.isFinite(time)) return;
    const route = this.linkedTargets(sourceCellId, "timeAnchor");
    this.publishViewportToTargets(sourceCellId, route, "timeAnchor", ({ surface }) => (
      surface.setLinkedVisibleTimeAnchor(time)
    ));
  }

  publishDateRange(sourceCellId: ChartCellId, range: ChartLinkedTimeRange): void {
    if (this.publishingViewport) return;
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const normalizedRange = from <= to ? { from, to } : { from: to, to: from };
    const route = this.linkedTargets(sourceCellId, "dateRange");
    this.publishViewportToTargets(sourceCellId, route, "dateRange", ({ surface }) => (
      surface.setLinkedVisibleTimeRange(normalizedRange)
    ));
  }

  private publishViewportToTargets(
    sourceCellId: ChartCellId,
    route: { group: ChartLinkGroupId | null; targets: LinkedTarget[] },
    kind: ChartLinkViewportIssue["kind"],
    deliver: (target: LinkedTarget) => boolean,
  ): void {
    if (route.group === null || route.targets.length === 0) return;
    const failedCellIds: ChartCellId[] = [];
    this.publishingViewport = true;
    try {
      for (const target of route.targets) {
        try {
          if (!deliver(target)) failedCellIds.push(target.cellId);
        } catch {
          failedCellIds.push(target.cellId);
        }
      }
    } finally {
      this.publishingViewport = false;
    }
    this.setViewportIssue(failedCellIds.length === 0 ? null : {
      group: route.group,
      kind,
      sourceCellId,
      failedCellIds,
    });
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
