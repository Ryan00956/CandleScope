import { resolveChartLinkTargetsForChannel } from "./chartWorkspaceLinkModel.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartWorkspaceDocument,
  ChartWorkspaceId,
} from "./chartWorkspaceTypes.js";
import type {
  WorkspaceBusClient,
  WorkspaceBusLinkEvent,
} from "./workspaceBus.js";

export interface ChartLinkedTimeRange {
  from: number;
  to: number;
}

export interface ChartLinkSurface {
  setLinkedCrosshairTime(time: number | null): boolean;
  setLinkedVisibleTimeAnchor(time: number): boolean;
  setLinkedVisibleTimeRange(range: ChartLinkedTimeRange): boolean;
  subscribeLinkedViewportReady?(listener: (generation: number) => void): () => void;
  setLinkedDrawingRevision?(scopeKey: string, revision: number): boolean;
}

export interface ChartLinkViewportIssue {
  group: ChartLinkGroupId;
  kind: "timeAnchor" | "dateRange";
  sourceCellId: ChartCellId;
  failedCellIds: readonly ChartCellId[];
}

export interface ChartLinkDiagnosticsSnapshot {
  scopeKey: ChartWorkspaceId;
  registeredCellIds: ChartCellId[];
  retainedViewportGroups: Array<{
    group: ChartLinkGroupId;
    kind: "timeAnchor" | "dateRange";
    sourceCellId: ChartCellId;
    failedCellIds: ChartCellId[];
  }>;
  viewportIssue: ChartLinkViewportIssue | null;
  counts: {
    crosshairPublishes: number;
    crosshairTargetAttempts: number;
    crosshairTargetDeliveries: number;
    crosshairTargetFailures: number;
    timeAnchorPublishes: number;
    dateRangePublishes: number;
    viewportTargetAttempts: number;
    viewportTargetDeliveries: number;
    viewportTargetFailures: number;
  };
}

type ViewportIssueListener = (issue: ChartLinkViewportIssue | null) => void;
type LinkOption = "crosshair" | "timeAnchor" | "dateRange" | "drawings";

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
  latestBySourceAndKind: Map<string, RetainedViewportEvent>;
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
    latestBySourceAndKind: new Map(),
    readinessGenerationByCell: new Map(),
  };
}

function viewportEventKey(event: Pick<RetainedViewportEvent, "sourceCellId" | "kind">): string {
  return `${event.sourceCellId}\u0000${event.kind}`;
}

export class ChartLinkCoordinator {
  private readonly surfaces = new Map<ChartCellId, LinkedSurfaceRegistration>();
  private readonly viewportIssueListeners = new Set<ViewportIssueListener>();
  private readonly viewportStateByScope = new Map<ChartWorkspaceId, WorkspaceViewportState>();
  private publishingCrosshair = false;
  private publishingViewport = false;
  private forwardingRemote = false;
  private workspaceBus: WorkspaceBusClient | null = null;
  private unsubscribeWorkspaceBus: (() => void) | null = null;
  private document: ChartWorkspaceDocument;
  private scopeKey: ChartWorkspaceId;
  private viewportSequence = 0;
  private viewportIssue: ChartLinkViewportIssue | null = null;
  private readonly diagnostics = {
    crosshairPublishes: 0,
    crosshairTargetAttempts: 0,
    crosshairTargetDeliveries: 0,
    crosshairTargetFailures: 0,
    timeAnchorPublishes: 0,
    dateRangePublishes: 0,
    viewportTargetAttempts: 0,
    viewportTargetDeliveries: 0,
    viewportTargetFailures: 0,
  };

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

  connectWorkspaceBus(bus: WorkspaceBusClient | null): () => void {
    this.unsubscribeWorkspaceBus?.();
    this.workspaceBus = bus;
    this.unsubscribeWorkspaceBus = bus?.subscribeLink((event) => this.applyWorkspaceBusEvent(event)) ?? null;
    return () => {
      this.unsubscribeWorkspaceBus?.();
      this.unsubscribeWorkspaceBus = null;
      if (this.workspaceBus === bus) this.workspaceBus = null;
    };
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
      this.viewportState(scopeKey).readinessGenerationByCell.set(cellId, normalizedGeneration);
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
    const sourceGroupId = sourceCell?.linkGroupId ?? null;
    if (!sourceCell || !sourceGroupId || !this.document.linkGroups[sourceGroupId]) return null;
    return resolveChartLinkTargetsForChannel(this.document, sourceCellId, option).length > 0
      ? sourceGroupId
      : null;
  }

  private linkedTargets(
    sourceCellId: ChartCellId,
    option: LinkOption,
  ): { group: ChartLinkGroupId | null; targets: LinkedTarget[] } {
    const group = this.sourceGroupForOption(sourceCellId, option);
    if (group === null) return { group: null, targets: [] };
    const targets = resolveChartLinkTargetsForChannel(this.document, sourceCellId, option)
      .flatMap(({ cellId }) => {
        const registration = this.surfaces.get(cellId);
        return registration?.scopeKey === this.scopeKey
          ? [{ cellId, surface: registration.surface }]
          : [];
      });
    return { group, targets };
  }

  private eventTargetsCell(event: RetainedViewportEvent, cellId: ChartCellId): boolean {
    return resolveChartLinkTargetsForChannel(this.document, event.sourceCellId, event.kind)
      .some((target) => target.cellId === cellId);
  }

  private reconcileRetainedViewportEvents(): void {
    const state = this.viewportState();
    for (const [key, event] of state.latestBySourceAndKind) {
      if (this.sourceGroupForOption(event.sourceCellId, event.kind) !== event.group) {
        state.latestBySourceAndKind.delete(key);
      }
    }
    for (const cellId of state.deliveredByCell.keys()) {
      if (!this.document.cells[cellId]) {
        state.deliveredByCell.delete(cellId);
        state.readinessGenerationByCell.delete(cellId);
      }
    }
  }

  publishCrosshair(sourceCellId: ChartCellId, time: number | null): void {
    if (this.publishingCrosshair) return;
    const normalizedTime = time === null || Number.isFinite(time) ? time : null;
    const route = this.linkedTargets(sourceCellId, "crosshair");
    if (route.group === null) return;
    this.diagnostics.crosshairPublishes += 1;
    this.diagnostics.crosshairTargetAttempts += route.targets.length;
    this.publishingCrosshair = true;
    try {
      for (const { surface } of route.targets) {
        try {
          if (surface.setLinkedCrosshairTime(normalizedTime)) {
            this.diagnostics.crosshairTargetDeliveries += 1;
          } else {
            this.diagnostics.crosshairTargetFailures += 1;
          }
        } catch {
          this.diagnostics.crosshairTargetFailures += 1;
        }
      }
    } finally {
      this.publishingCrosshair = false;
    }
    if (!this.forwardingRemote) {
      this.workspaceBus?.publishLink({
        workspaceId: this.scopeKey,
        sourceCellId,
        kind: "crosshair",
        payload: { time: normalizedTime },
      });
    }
  }

  publishTimeAnchor(sourceCellId: ChartCellId, time: number): void {
    if (this.publishingViewport || !Number.isFinite(time)) return;
    const route = this.linkedTargets(sourceCellId, "timeAnchor");
    if (route.group === null) return;
    this.diagnostics.timeAnchorPublishes += 1;
    const event: RetainedTimeAnchorEvent = {
      sequence: ++this.viewportSequence,
      group: route.group,
      kind: "timeAnchor",
      sourceCellId,
      time,
      failedCellIds: new Set(),
    };
    this.publishViewportToTargets(event, route.targets);
    if (!this.forwardingRemote) {
      this.workspaceBus?.publishLink({
        workspaceId: this.scopeKey,
        sourceCellId,
        kind: "timeAnchor",
        payload: { time },
      });
    }
  }

  publishDateRange(sourceCellId: ChartCellId, range: ChartLinkedTimeRange): void {
    if (this.publishingViewport) return;
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const route = this.linkedTargets(sourceCellId, "dateRange");
    if (route.group === null) return;
    this.diagnostics.dateRangePublishes += 1;
    const event: RetainedDateRangeEvent = {
      sequence: ++this.viewportSequence,
      group: route.group,
      kind: "dateRange",
      sourceCellId,
      range: from <= to ? { from, to } : { from: to, to: from },
      failedCellIds: new Set(),
    };
    this.publishViewportToTargets(event, route.targets);
    if (!this.forwardingRemote) {
      this.workspaceBus?.publishLink({
        workspaceId: this.scopeKey,
        sourceCellId,
        kind: "dateRange",
        payload: { range: event.range },
      });
    }
  }

  publishDrawingRevision(sourceCellId: ChartCellId, scopeKey: string, revision: number): void {
    if (!scopeKey || !Number.isSafeInteger(revision) || revision < 0) return;
    const route = this.linkedTargets(sourceCellId, "drawings");
    if (route.group === null) return;
    for (const target of route.targets) {
      try {
        target.surface.setLinkedDrawingRevision?.(scopeKey, revision);
      } catch {
        // A drawing surface can recover from the next authoritative revision.
      }
    }
    if (!this.forwardingRemote) {
      this.workspaceBus?.publishLink({
        workspaceId: this.scopeKey,
        sourceCellId,
        kind: "drawings",
        payload: { scopeKey, revision },
      });
    }
  }

  private applyWorkspaceBusEvent(event: WorkspaceBusLinkEvent): void {
    if (event.workspaceId !== this.scopeKey || event.sourceWindowId === this.workspaceBus?.windowId) return;
    this.forwardingRemote = true;
    try {
      if (event.kind === "crosshair") {
        const time = (event.payload as { time?: unknown } | null)?.time;
        this.publishCrosshair(event.sourceCellId, typeof time === "number" ? time : null);
      } else if (event.kind === "timeAnchor") {
        const time = (event.payload as { time?: unknown } | null)?.time;
        if (typeof time === "number") this.publishTimeAnchor(event.sourceCellId, time);
      } else if (event.kind === "dateRange") {
        const range = (event.payload as { range?: ChartLinkedTimeRange } | null)?.range;
        if (range) this.publishDateRange(event.sourceCellId, range);
      } else if (event.kind === "drawings") {
        const payload = event.payload as { revision?: unknown; scopeKey?: unknown } | null;
        if (typeof payload?.revision === "number" && typeof payload.scopeKey === "string") {
          this.publishDrawingRevision(event.sourceCellId, payload.scopeKey, payload.revision);
        }
      }
    } finally {
      this.forwardingRemote = false;
    }
  }

  private deliverViewportEvent(
    event: RetainedViewportEvent,
    target: LinkedTarget,
    reportFailure: boolean,
    readinessGeneration: number,
  ): boolean {
    let delivered = false;
    this.diagnostics.viewportTargetAttempts += 1;
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
      this.diagnostics.viewportTargetDeliveries += 1;
      state.deliveredByCell.set(target.cellId, {
        sequence: event.sequence,
        readinessGeneration,
      });
      event.failedCellIds.delete(target.cellId);
    } else if (reportFailure) {
      this.diagnostics.viewportTargetFailures += 1;
      event.failedCellIds.add(target.cellId);
    }
    return delivered;
  }

  private publishViewportToTargets(
    event: RetainedViewportEvent,
    targets: LinkedTarget[],
  ): void {
    const state = this.viewportState();
    state.latestBySourceAndKind.set(viewportEventKey(event), event);
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
    if (!registration || registration.scopeKey !== this.scopeKey || !this.document.cells[cellId]) return false;
    const event = [...this.viewportState().latestBySourceAndKind.values()]
      .filter((candidate) => candidate.sourceCellId !== cellId && this.eventTargetsCell(candidate, cellId))
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (!event) return false;
    const delivered = this.viewportState().deliveredByCell.get(cellId);
    if (delivered?.sequence === event.sequence
      && delivered.readinessGeneration >= readinessGeneration) return false;
    const applied = this.deliverViewportEvent(event, {
      cellId,
      surface: registration.surface,
    }, reportFailure, readinessGeneration);
    this.publishViewportIssue(event);
    return applied;
  }

  private publishViewportIssue(event: RetainedViewportEvent): void {
    const current = this.viewportState().latestBySourceAndKind.get(viewportEventKey(event));
    if (current !== event) return;
    const failedCellIds = [...event.failedCellIds]
      .filter((cellId) => this.eventTargetsCell(event, cellId));
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

  snapshot(): ChartLinkDiagnosticsSnapshot {
    const state = this.viewportState();
    return {
      scopeKey: this.scopeKey,
      registeredCellIds: this.registeredCellIds().sort(),
      retainedViewportGroups: [...state.latestBySourceAndKind.values()]
        .map((event) => ({
          group: event.group,
          kind: event.kind,
          sourceCellId: event.sourceCellId,
          failedCellIds: [...event.failedCellIds].sort(),
        }))
        .sort((left, right) => left.group.localeCompare(right.group)),
      viewportIssue: this.viewportIssue ? { ...this.viewportIssue } : null,
      counts: { ...this.diagnostics },
    };
  }
}

export function sameLinkGroup(
  document: ChartWorkspaceDocument,
  left: ChartCellId,
  right: ChartCellId,
): ChartLinkGroupId | null {
  const group = document.cells[left]?.linkGroupId ?? null;
  return group !== null && document.cells[right]?.linkGroupId === group ? group : null;
}
