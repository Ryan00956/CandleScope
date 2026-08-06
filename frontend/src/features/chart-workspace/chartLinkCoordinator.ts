import {
  canPublishChartLinks,
  canReceiveChartLinks,
} from "./chartWorkspaceLinkModel.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartWorkspaceDocument,
  ChartWorkspaceId,
} from "./chartWorkspaceTypes.js";

export interface ChartLinkedTimeRange {
  from: number;
  to: number;
}

export interface ChartLinkSurface {
  setLinkedCrosshairTime(time: number | null): boolean;
  setLinkedVisibleTimeAnchor(time: number): boolean;
  setLinkedVisibleTimeRange(range: ChartLinkedTimeRange): boolean;
  subscribeLinkedViewportReady?(listener: (generation: number) => void): () => void;
}

export interface ChartLinkViewportIssue {
  group: ChartLinkGroupId;
  kind: "timeAnchor" | "dateRange";
  sourceCellId: ChartCellId;
  failedCellIds: readonly ChartCellId[];
}

type ViewportIssueListener = (issue: ChartLinkViewportIssue | null) => void;
type LinkOption = "crosshair" | "timeAnchor" | "dateRange";

interface LinkedSurfaceRegistration {
  scopeKey: ChartWorkspaceId;
  surface: ChartLinkSurface;
}

interface LinkedTarget {
  cellId: ChartCellId;
  surface: ChartLinkSurface;
}

interface RetainedViewportEventBase {
  sequence: number;
  group: ChartLinkGroupId;
  sourceCellId: ChartCellId;
  failedCellIds: Set<ChartCellId>;
}

interface RetainedTimeAnchorEvent extends RetainedViewportEventBase {
  kind: "timeAnchor";
  time: number;
}

interface RetainedDateRangeEvent extends RetainedViewportEventBase {
  kind: "dateRange";
  range: ChartLinkedTimeRange;
}

type RetainedViewportEvent = RetainedTimeAnchorEvent | RetainedDateRangeEvent;

interface WorkspaceViewportState {
  deliveredByCell: Map<ChartCellId, {
    sequence: number;
    readinessGeneration: number;
  }>;
  latestByGroup: Map<ChartLinkGroupId, RetainedViewportEvent>;
  readinessGenerationByCell: Map<ChartCellId, number>;
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

function createWorkspaceViewportState(): WorkspaceViewportState {
  return {
    deliveredByCell: new Map(),
    latestByGroup: new Map(),
    readinessGenerationByCell: new Map(),
  };
}

export class ChartLinkCoordinator {
  private readonly surfaces = new Map<ChartCellId, LinkedSurfaceRegistration>();
  private readonly viewportIssueListeners = new Set<ViewportIssueListener>();
  private readonly viewportStateByScope = new Map<ChartWorkspaceId, WorkspaceViewportState>();
  private publishingCrosshair = false;
  private publishingViewport = false;
  private document: ChartWorkspaceDocument;
  private scopeKey: ChartWorkspaceId;
  private viewportSequence = 0;
  private viewportIssue: ChartLinkViewportIssue | null = null;

  constructor(document: ChartWorkspaceDocument, scopeKey: ChartWorkspaceId = "default") {
    this.document = document;
    this.scopeKey = scopeKey;
  }

  updateDocument(
    document: ChartWorkspaceDocument,
    scopeKey: ChartWorkspaceId = this.scopeKey,
  ): void {
    this.document = document;
    this.scopeKey = scopeKey;
    this.reconcileRetainedViewportEvents();
    this.setViewportIssue(null);
  }

  register(
    cellId: ChartCellId,
    surface: ChartLinkSurface,
    scopeKey: ChartWorkspaceId = this.scopeKey,
  ): () => void {
    const registration = { scopeKey, surface };
    this.surfaces.set(cellId, registration);
    const state = this.viewportState(scopeKey);
    state.deliveredByCell.delete(cellId);
    state.readinessGenerationByCell.delete(cellId);
    const unsubscribeReady = surface.subscribeLinkedViewportReady?.((generation) => {
      if (this.surfaces.get(cellId) !== registration) return;
      const normalizedGeneration = Number.isFinite(generation)
        ? Math.max(0, Math.floor(generation))
        : 0;
      this.viewportState(scopeKey).readinessGenerationByCell.set(
        cellId,
        normalizedGeneration,
      );
      this.catchUpViewport(cellId, true, normalizedGeneration);
    }) ?? (() => {});
    this.catchUpViewport(cellId, false);
    return () => {
      unsubscribeReady();
      if (this.surfaces.get(cellId) !== registration) return;
      this.surfaces.delete(cellId);
      this.viewportState(scopeKey).deliveredByCell.delete(cellId);
      this.viewportState(scopeKey).readinessGenerationByCell.delete(cellId);
    };
  }

  subscribeViewportIssue(listener: ViewportIssueListener): () => void {
    this.viewportIssueListeners.add(listener);
    return () => { this.viewportIssueListeners.delete(listener); };
  }

  getViewportIssue(): ChartLinkViewportIssue | null {
    return this.viewportIssue;
  }

  private viewportState(scopeKey: ChartWorkspaceId = this.scopeKey): WorkspaceViewportState {
    const current = this.viewportStateByScope.get(scopeKey);
    if (current) return current;
    const created = createWorkspaceViewportState();
    this.viewportStateByScope.set(scopeKey, created);
    return created;
  }

  private setViewportIssue(issue: ChartLinkViewportIssue | null): void {
    if (sameViewportIssue(this.viewportIssue, issue)) return;
    this.viewportIssue = issue;
    for (const listener of [...this.viewportIssueListeners]) listener(issue);
  }

  private sourceGroupForOption(
    sourceCellId: ChartCellId,
    option: LinkOption,
  ): ChartLinkGroupId | null {
    const sourceCell = this.document.cells[sourceCellId];
    const sourceGroup = sourceCell?.linkGroup ?? null;
    if (sourceGroup === null
      || !canPublishChartLinks(sourceCell.linkRole)
      || !this.document.linkGroups[sourceGroup]?.[option]) return null;
    return sourceGroup;
  }

  private linkedTargets(
    sourceCellId: ChartCellId,
    option: LinkOption,
  ): { group: ChartLinkGroupId | null; targets: LinkedTarget[] } {
    const group = this.sourceGroupForOption(sourceCellId, option);
    if (group === null) return { group: null, targets: [] };
    const targets: LinkedTarget[] = [];
    for (const [cellId, registration] of this.surfaces) {
      if (registration.scopeKey !== this.scopeKey) continue;
      const cell = this.document.cells[cellId];
      if (cellId === sourceCellId
        || cell?.linkGroup !== group
        || !canReceiveChartLinks(cell.linkRole)) continue;
      targets.push({ cellId, surface: registration.surface });
    }
    return { group, targets };
  }

  private reconcileRetainedViewportEvents(): void {
    const state = this.viewportState();
    for (const [group, event] of state.latestByGroup) {
      if (this.sourceGroupForOption(event.sourceCellId, event.kind) !== group) {
        state.latestByGroup.delete(group);
      }
    }
    for (const cellId of state.deliveredByCell.keys()) {
      const cell = this.document.cells[cellId];
      const event = cell?.linkGroup == null
        ? null
        : state.latestByGroup.get(cell.linkGroup) ?? null;
      if (!event || !canReceiveChartLinks(cell.linkRole)) {
        state.deliveredByCell.delete(cellId);
        state.readinessGenerationByCell.delete(cellId);
      }
    }
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
    if (route.group === null) return;
    const event: RetainedTimeAnchorEvent = {
      sequence: ++this.viewportSequence,
      group: route.group,
      kind: "timeAnchor",
      sourceCellId,
      time,
      failedCellIds: new Set(),
    };
    this.publishViewportToTargets(event, route.targets);
  }

  publishDateRange(sourceCellId: ChartCellId, range: ChartLinkedTimeRange): void {
    if (this.publishingViewport) return;
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const route = this.linkedTargets(sourceCellId, "dateRange");
    if (route.group === null) return;
    const event: RetainedDateRangeEvent = {
      sequence: ++this.viewportSequence,
      group: route.group,
      kind: "dateRange",
      sourceCellId,
      range: from <= to ? { from, to } : { from: to, to: from },
      failedCellIds: new Set(),
    };
    this.publishViewportToTargets(event, route.targets);
  }

  private deliverViewportEvent(
    event: RetainedViewportEvent,
    target: LinkedTarget,
    reportFailure: boolean,
    readinessGeneration: number,
  ): boolean {
    let delivered = false;
    this.publishingViewport = true;
    try {
      delivered = event.kind === "timeAnchor"
        ? target.surface.setLinkedVisibleTimeAnchor(event.time)
        : target.surface.setLinkedVisibleTimeRange(event.range);
    } catch {
      delivered = false;
    } finally {
      this.publishingViewport = false;
    }
    const state = this.viewportState();
    if (delivered) {
      state.deliveredByCell.set(target.cellId, {
        sequence: event.sequence,
        readinessGeneration,
      });
      event.failedCellIds.delete(target.cellId);
    } else if (reportFailure) {
      event.failedCellIds.add(target.cellId);
    }
    return delivered;
  }

  private publishViewportToTargets(
    event: RetainedViewportEvent,
    targets: LinkedTarget[],
  ): void {
    const state = this.viewportState();
    state.latestByGroup.set(event.group, event);
    this.setViewportIssue(null);
    for (const target of targets) {
      this.deliverViewportEvent(
        event,
        target,
        true,
        state.readinessGenerationByCell.get(target.cellId) ?? 0,
      );
    }
    this.publishViewportIssue(event);
  }

  private catchUpViewport(
    cellId: ChartCellId,
    reportFailure: boolean,
    readinessGeneration = this.viewportState().readinessGenerationByCell.get(cellId) ?? 0,
  ): boolean {
    if (this.publishingViewport) return false;
    const registration = this.surfaces.get(cellId);
    if (!registration || registration.scopeKey !== this.scopeKey) return false;
    const cell = this.document.cells[cellId];
    const group = cell?.linkGroup ?? null;
    if (group === null || !canReceiveChartLinks(cell.linkRole)) return false;
    const state = this.viewportState();
    const event = state.latestByGroup.get(group);
    const delivered = state.deliveredByCell.get(cellId);
    if (!event
      || event.sourceCellId === cellId
      || (delivered?.sequence === event.sequence
        && delivered.readinessGeneration >= readinessGeneration)
      || this.sourceGroupForOption(event.sourceCellId, event.kind) !== group) return false;
    const applied = this.deliverViewportEvent(event, {
      cellId,
      surface: registration.surface,
    }, reportFailure, readinessGeneration);
    this.publishViewportIssue(event);
    return applied;
  }

  private publishViewportIssue(event: RetainedViewportEvent): void {
    const current = this.viewportState().latestByGroup.get(event.group);
    if (current !== event) return;
    const failedCellIds = [...event.failedCellIds].filter((cellId) => {
      const cell = this.document.cells[cellId];
      return cell?.linkGroup === event.group && canReceiveChartLinks(cell.linkRole);
    });
    if (failedCellIds.length === 0) {
      if (this.viewportIssue?.group === event.group
        && this.viewportIssue.sourceCellId === event.sourceCellId
        && this.viewportIssue.kind === event.kind) this.setViewportIssue(null);
      return;
    }
    this.setViewportIssue({
      group: event.group,
      kind: event.kind,
      sourceCellId: event.sourceCellId,
      failedCellIds,
    });
  }

  registeredCellIds(): ChartCellId[] {
    return [...this.surfaces.entries()]
      .filter(([, registration]) => registration.scopeKey === this.scopeKey)
      .map(([cellId]) => cellId);
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
