import type { ChartWorkLane } from "../market-data/chartWorkScheduler.js";
import type {
  ChartCellId,
  ChartWindowId,
  ChartWorkspaceId,
  ChartWorkspaceLibrarySnapshot,
} from "./chartWorkspaceTypes.js";

export type WorkspaceBusLinkKind = "crosshair" | "dateRange" | "drawings" | "timeAnchor";

export interface WorkspaceBusLinkEvent {
  eventId?: string;
  emittedAt?: number;
  workspaceId: ChartWorkspaceId;
  sourceWindowId: ChartWindowId;
  sourceCellId: ChartCellId;
  kind: WorkspaceBusLinkKind;
  payload: unknown;
}

export interface WorkspaceBusState {
  ok: boolean;
  ready: boolean;
  sequence: number;
  writerWindowId: ChartWindowId | null;
  revisions: Record<ChartWorkspaceId, number>;
  snapshot: ChartWorkspaceLibrarySnapshot | null;
  idempotent?: boolean;
  code?: string;
  message?: string;
  conflict?: unknown;
}

export interface AppWorkLease {
  leaseId: string;
  windowId: ChartWindowId;
  cellId: ChartCellId;
  lane: ChartWorkLane;
}

type SnapshotListener = (state: WorkspaceBusState) => void;
type LinkListener = (event: WorkspaceBusLinkEvent) => void;

function isState(value: unknown): value is WorkspaceBusState {
  const state = value as Partial<WorkspaceBusState> | null;
  return Boolean(state)
    && typeof state?.ok === "boolean"
    && typeof state.ready === "boolean"
    && Number.isSafeInteger(state.sequence)
    && (state.writerWindowId === null || typeof state.writerWindowId === "string")
    && Boolean(state.revisions && typeof state.revisions === "object");
}

function isLinkEvent(value: unknown): value is WorkspaceBusLinkEvent {
  const event = value as Partial<WorkspaceBusLinkEvent> | null;
  return Boolean(event)
    && typeof event?.workspaceId === "string"
    && typeof event.sourceWindowId === "string"
    && typeof event.sourceCellId === "string"
    && ["crosshair", "dateRange", "drawings", "timeAnchor"].includes(String(event.kind));
}

function cloneSnapshot(snapshot: ChartWorkspaceLibrarySnapshot): ChartWorkspaceLibrarySnapshot {
  return structuredClone(snapshot);
}

export class WorkspaceBusClient {
  private state: WorkspaceBusState = {
    ok: true,
    ready: false,
    sequence: -1,
    writerWindowId: null,
    revisions: {},
    snapshot: null,
  };
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly linkListeners = new Set<LinkListener>();
  private bridgeUnsubscribe: (() => void) | null = null;
  private channel: BroadcastChannel | null = null;
  private connected = false;
  private linkPublishes = 0;
  private conflicts = 0;

  constructor(readonly windowId: ChartWindowId) {}

  isNative(): boolean {
    return Boolean(globalThis.window?.candlescopeDesktop);
  }

  isWriter(): boolean {
    return this.state.writerWindowId === this.windowId;
  }

  get current(): WorkspaceBusState {
    return this.state;
  }

  async connect(snapshot: ChartWorkspaceLibrarySnapshot): Promise<WorkspaceBusState> {
    if (this.connected && this.state.ready) return this.state;
    this.connected = true;
    const bridge = globalThis.window?.candlescopeDesktop;
    if (bridge) {
      this.bridgeUnsubscribe ??= bridge.onWorkspaceBusEvent((message) => this.handleMessage(message));
      const response = await bridge.workspaceBusConnect({ snapshot });
      if (!isState(response)) throw new Error("Native WorkspaceBus returned an invalid connect response");
      this.applyState(response, false);
      return this.state;
    }
    this.connectBroadcastChannel(snapshot);
    return this.state;
  }

  async commit(snapshot: ChartWorkspaceLibrarySnapshot): Promise<WorkspaceBusState> {
    const bridge = globalThis.window?.candlescopeDesktop;
    if (bridge) {
      const response = await bridge.workspaceBusCommit({
        expectedSequence: this.state.sequence,
        expectedRevisions: this.state.revisions,
        baseSnapshot: this.state.snapshot,
        snapshot,
      });
      if (!isState(response)) throw new Error("Native WorkspaceBus returned an invalid commit response");
      if (!response.ok) this.conflicts += response.code === "WORKSPACE_REVISION_CONFLICT" ? 1 : 0;
      this.applyState(response, !response.ok);
      return response;
    }
    if (!this.state.ready) throw new Error("Broadcast WorkspaceBus is not connected");
    const next: WorkspaceBusState = {
      ok: true,
      ready: true,
      sequence: this.state.sequence + 1,
      writerWindowId: this.state.writerWindowId,
      revisions: Object.fromEntries(snapshot.workspaces.map((record) => [record.id, record.document.revision])),
      snapshot: cloneSnapshot(snapshot),
    };
    this.applyState(next, true);
    this.channel?.postMessage({ type: "snapshot", ...next, sourceWindowId: this.windowId });
    return next;
  }

  publishLink(event: Omit<WorkspaceBusLinkEvent, "sourceWindowId">): void {
    const linkEvent: WorkspaceBusLinkEvent = { ...event, sourceWindowId: this.windowId };
    this.linkPublishes += 1;
    const bridge = globalThis.window?.candlescopeDesktop;
    if (bridge) {
      void bridge.workspaceBusPublishLink(linkEvent);
      return;
    }
    this.channel?.postMessage({ type: "link", event: linkEvent });
  }

  reportWindow(state: { focused: boolean; visible: boolean }): void {
    globalThis.window?.candlescopeDesktop?.workspaceBusReportWindow(state);
  }

  subscribeSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  }

  subscribeLink(listener: LinkListener): () => void {
    this.linkListeners.add(listener);
    return () => { this.linkListeners.delete(listener); };
  }

  async acquireWork(cellId: ChartCellId, lane: ChartWorkLane): Promise<AppWorkLease | null> {
    const bridge = globalThis.window?.candlescopeDesktop;
    if (!bridge) return null;
    const response = await bridge.acquireAppWork({ cellId, lane }) as Partial<AppWorkLease> | null;
    if (!response || typeof response.leaseId !== "string") throw new Error("App work lease was rejected");
    return response as AppWorkLease;
  }

  releaseWork(lease: AppWorkLease | null): void {
    if (lease) globalThis.window?.candlescopeDesktop?.releaseAppWork(lease.leaseId);
  }

  async requestPreview(cellId: ChartCellId, pinned = false): Promise<{ ok: boolean; code?: string; message?: string }> {
    const bridge = globalThis.window?.candlescopeDesktop;
    if (!bridge) return { ok: true };
    return await bridge.requestAppPreview({ cellId, pinned }) as { ok: boolean; code?: string; message?: string };
  }

  releasePreview(cellId: ChartCellId): void {
    globalThis.window?.candlescopeDesktop?.releaseAppPreview({ cellId });
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const native = await globalThis.window?.candlescopeDesktop?.getAppBudgetDiagnostics();
    return {
      native: native ?? null,
      local: {
        connected: this.connected,
        sequence: this.state.sequence,
        writerWindowId: this.state.writerWindowId,
        linkPublishes: this.linkPublishes,
        conflicts: this.conflicts,
      },
    };
  }

  dispose(): void {
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = null;
    this.channel?.close();
    this.channel = null;
    this.connected = false;
  }

  private applyState(state: WorkspaceBusState, notify: boolean): void {
    this.state = {
      ...state,
      revisions: { ...state.revisions },
      snapshot: state.snapshot ? cloneSnapshot(state.snapshot) : null,
    };
    if (notify) for (const listener of [...this.snapshotListeners]) listener(this.state);
  }

  private handleMessage(value: unknown): void {
    const message = value as { type?: string; event?: unknown } & Partial<WorkspaceBusState>;
    const messageType = message?.type;
    if (messageType === "link" && isLinkEvent(message.event)) {
      for (const listener of [...this.linkListeners]) listener(message.event);
      return;
    }
    if ((messageType === "snapshot" || messageType === "health") && isState(message)) {
      this.applyState(message, messageType === "snapshot");
    }
  }

  private connectBroadcastChannel(snapshot: ChartWorkspaceLibrarySnapshot): void {
    const revisions = Object.fromEntries(snapshot.workspaces.map((record) => [record.id, record.document.revision]));
    this.applyState({
      ok: true,
      ready: true,
      sequence: 0,
      writerWindowId: this.windowId,
      revisions,
      snapshot: cloneSnapshot(snapshot),
    }, false);
    if (typeof BroadcastChannel !== "function") return;
    this.channel = new BroadcastChannel(`candlescope-workspace-bus-${snapshot.activeWorkspaceId}`);
    this.channel.addEventListener("message", (event) => this.handleMessage(event.data));
    this.channel.postMessage({ type: "snapshot", ...this.state, sourceWindowId: this.windowId });
  }
}

let defaultClient: WorkspaceBusClient | null = null;

export function defaultWorkspaceBus(windowId: ChartWindowId): WorkspaceBusClient {
  if (!defaultClient || defaultClient.windowId !== windowId) defaultClient = new WorkspaceBusClient(windowId);
  return defaultClient;
}
