import type {
  ChartWindowId,
  ChartWindowState,
  ChartWorkspaceDocument,
  ChartWorkspaceId,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import type { KlineBar } from "../features/market-data/marketDataTypes.js";

export interface DesktopBootstrap {
  mode: "web" | "native";
  multiWindowAvailable: boolean;
  multiWindowEnabled: boolean;
  windowId: ChartWindowId;
  workspaceId: ChartWorkspaceId | null;
  shellRevision: number;
  displayCount: number;
  logsPath: string | null;
  sidecar: Record<string, unknown> | null;
}

export interface DesktopWindowLifecycleEvent {
  windowId: ChartWindowId;
  state: "focused" | "visible-secondary" | "minimized" | "restored" | "shown" | "hidden";
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  placement: DesktopWindowPlacement;
}

export interface DesktopWindowPlacement {
  windowId?: ChartWindowId;
  boundsDip: ChartWindowState["boundsDip"];
  monitorFingerprint: string | null;
  dpiScale: number | null;
  windowState: ChartWindowState["windowState"];
}

export interface DesktopTopologyPayload {
  workspaceId: ChartWorkspaceId;
  workspaceRevision: number;
  expectedShellRevision: number;
  activeWindowId: ChartWindowId;
  windows: Record<ChartWindowId, Pick<
    ChartWindowState,
    "id" | "boundsDip" | "monitorFingerprint" | "dpiScale" | "windowState"
  >>;
}

export interface DesktopTopologyResult {
  ok: boolean;
  shellRevision: number;
  idempotent?: boolean;
  code?: string;
  message?: string;
}

interface NativeDesktopBridge {
  readonly apiBase: string;
  getPluginManagementSession?(): { apiBase: string; sessionToken: string; csrfToken: string } | null;
  openAppPage?(url: string): Promise<{ windowId: string }>;
  getBootstrap(): Promise<DesktopBootstrap>;
  reconcileWorkspace(payload: DesktopTopologyPayload): Promise<DesktopTopologyResult>;
  onLifecycle(listener: (event: DesktopWindowLifecycleEvent) => void): () => void;
  onCloseRequested(listener: (event: { windowId: ChartWindowId }) => void): () => void;
  onPlacement(listener: (event: DesktopWindowPlacement & { windowId: ChartWindowId }) => void): () => void;
  workspaceBusConnect(payload: unknown): Promise<unknown>;
  workspaceBusCommit(payload: unknown): Promise<unknown>;
  workspaceBusPublishLink(payload: unknown): Promise<unknown>;
  workspaceBusReportWindow(payload: unknown): void;
  onWorkspaceBusEvent(listener: (event: unknown) => void): () => void;
  acquireAppWork(payload: unknown): Promise<unknown>;
  releaseAppWork(leaseId: string): void;
  requestAppPreview(payload: unknown): Promise<unknown>;
  releaseAppPreview(payload: unknown): void;
  getAppBudgetDiagnostics(): Promise<unknown>;
  readSeriesSnapshot(key: string): unknown;
  publishSeriesSnapshot(payload: { key: string; rows: readonly KlineBar[] }): void;
  getSeriesSnapshotDiagnostics(): Promise<unknown>;
}

declare global {
  interface Window {
    candlescopeDesktop?: NativeDesktopBridge;
  }
}

export function requestedDesktopWindowId(locationSearch = globalThis.location?.search || ""): ChartWindowId {
  const value = new URLSearchParams(locationSearch).get("windowId")?.trim();
  return value && value.length <= 128 ? value : "main-window";
}

function browserBootstrap(): DesktopBootstrap {
  return {
    mode: "web",
    multiWindowAvailable: false,
    multiWindowEnabled: false,
    windowId: "main-window",
    workspaceId: null,
    shellRevision: -1,
    displayCount: 1,
    logsPath: null,
    sidecar: null,
  };
}

export function desktopTopologyFromDocument(
  workspaceId: ChartWorkspaceId,
  document: ChartWorkspaceDocument,
  expectedShellRevision: number,
): DesktopTopologyPayload {
  return {
    workspaceId,
    workspaceRevision: document.revision,
    expectedShellRevision,
    activeWindowId: document.activeWindowId,
    windows: Object.fromEntries(Object.entries(document.windows).map(([windowId, windowState]) => [
      windowId,
      {
        id: windowState.id,
        boundsDip: windowState.boundsDip,
        monitorFingerprint: windowState.monitorFingerprint,
        dpiScale: windowState.dpiScale,
        windowState: windowState.windowState,
      },
    ])),
  };
}

export class DesktopWindowManager {
  readonly windowId = requestedDesktopWindowId();
  private bootstrap: DesktopBootstrap = browserBootstrap();
  private bootstrapPromise: Promise<DesktopBootstrap> | null = null;

  isNative(): boolean {
    return Boolean(globalThis.window?.candlescopeDesktop);
  }

  get cachedBootstrap(): DesktopBootstrap {
    return this.bootstrap;
  }

  async getBootstrap(): Promise<DesktopBootstrap> {
    const bridge = globalThis.window?.candlescopeDesktop;
    if (!bridge) return this.bootstrap;
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = bridge.getBootstrap().then((bootstrap) => {
        this.bootstrap = bootstrap;
        return bootstrap;
      });
    } else {
      await this.bootstrapPromise;
    }
    return this.bootstrap;
  }

  async reconcileWorkspace(
    workspaceId: ChartWorkspaceId,
    document: ChartWorkspaceDocument,
  ): Promise<DesktopTopologyResult> {
    const bridge = globalThis.window?.candlescopeDesktop;
    if (!bridge) {
      return { ok: false, code: "NATIVE_MULTI_WINDOW_UNAVAILABLE", shellRevision: -1 };
    }
    const bootstrap = await this.getBootstrap();
    const result = await bridge.reconcileWorkspace(desktopTopologyFromDocument(
      workspaceId,
      document,
      bootstrap.shellRevision,
    ));
    this.bootstrap = { ...bootstrap, shellRevision: result.shellRevision };
    return result;
  }

  onLifecycle(listener: (event: DesktopWindowLifecycleEvent) => void): () => void {
    return globalThis.window?.candlescopeDesktop?.onLifecycle(listener) || (() => undefined);
  }

  onCloseRequested(listener: (event: { windowId: ChartWindowId }) => void): () => void {
    return globalThis.window?.candlescopeDesktop?.onCloseRequested(listener) || (() => undefined);
  }

  onPlacement(
    listener: (event: DesktopWindowPlacement & { windowId: ChartWindowId }) => void,
  ): () => void {
    return globalThis.window?.candlescopeDesktop?.onPlacement(listener) || (() => undefined);
  }

  readSeriesSnapshot(key: string): KlineBar[] {
    const result = globalThis.window?.candlescopeDesktop?.readSeriesSnapshot(key) as {
      ok?: boolean;
      hit?: boolean;
      rows?: KlineBar[];
    } | undefined;
    return result?.ok === true && result.hit === true && Array.isArray(result.rows)
      ? result.rows
      : [];
  }

  publishSeriesSnapshot(key: string, rows: readonly KlineBar[]): void {
    globalThis.window?.candlescopeDesktop?.publishSeriesSnapshot({ key, rows });
  }
}

export const desktopWindowManager = new DesktopWindowManager();
