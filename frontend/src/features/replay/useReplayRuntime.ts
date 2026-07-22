import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MarketDataRuntimeContract } from "../market-data/marketDataRuntimeContract.js";
import type { ReplayEntry } from "./replayEntry.js";
import { defaultReplayApi, ReplayApiError } from "./replayApi.js";
import type { ReplayApiClient } from "./replayApi.js";
import type { ReplayCatalogQuery } from "./replayApi.js";
import type { ReplayJournalResponse, ReplayReportResponse } from "./replayParser.js";
import { assertReplayArtifactCausality } from "./replayParser.js";
import { ReplayStore } from "./replayStore.js";
import type { ReplayConnectionState, ReplayStoreError, ReplayStoreSnapshot } from "./replayStore.js";
import { ReplayStreamController, ReplayStreamError } from "./replayStreamController.js";
import type { ReplayStreamControllerOptions, ReplayStreamState } from "./replayStreamController.js";
import type {
  ReplayCapabilities,
  ReplayCatalog,
  ReplayCommandEnvelope,
  ReplayCommandResult,
  ReplayCommandTimelineEntry,
  ReplayCommandType,
  ReplayJson,
  ReplaySessionConfig,
  ReplaySessionResponse,
  ReplaySessionSnapshot,
} from "./replayTypes.js";

export type ReplayRuntimePhase =
  | "IDLE"
  | "ENTRY_ERROR"
  | "LOADING_CAPABILITIES"
  | "CONFIGURING"
  | "VALIDATING_SESSION"
  | "CONNECTING_SESSION"
  | "ACTIVE"
  | "ERROR"
  | "STOPPED";

export interface ReplayRuntimeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface ReplayStreamAckTarget {
  readonly commandId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly state: ReplaySessionSnapshot["state"];
  readonly stateHash: ReplaySessionSnapshot["state_hash"];
  readonly virtualTimeMs: number;
  readonly sourceSequence: number;
}

interface ReplayCommandRecoveryTarget {
  readonly command: ReplayCommandEnvelope;
  readonly sessionId: string;
  readonly generationFloor: number;
  readonly retryAfterGeneration: boolean;
}

export type ReplayRuntimeOperation = "catalog" | "create" | "fork" | "command" | "report" | "journal" | null;

export interface ReplayRuntimeSnapshot {
  readonly phase: ReplayRuntimePhase;
  readonly capabilities: ReplayCapabilities | null;
  readonly catalog: ReplayCatalog | null;
  readonly error: ReplayRuntimeError | null;
  readonly sessionId: string | null;
  readonly clientInstanceId: string;
  readonly operation: ReplayRuntimeOperation;
  readonly forkPending: boolean;
  readonly commandRecoveryPending: boolean;
  readonly commandRecoveryInFlight: boolean;
  readonly commandRecoveryReady: boolean;
  readonly pendingCommand: ReplayCommandEnvelope | null;
  readonly commandError: ReplayRuntimeError | null;
  readonly commandTimeline: readonly ReplayCommandTimelineEntry[];
  readonly report: ReplayReportResponse | null;
  readonly reportError: ReplayRuntimeError | null;
  readonly store: ReplayStoreSnapshot;
}

interface ReplayApiBoundary {
  capabilities(signal?: AbortSignal): ReturnType<ReplayApiClient["capabilities"]>;
  getSession(sessionId: string, signal?: AbortSignal): ReturnType<ReplayApiClient["getSession"]>;
  catalog?(query?: ReplayCatalogQuery, signal?: AbortSignal): Promise<ReplayCatalog>;
  createSession?(config: ReplaySessionConfig, signal?: AbortSignal): Promise<ReplaySessionResponse>;
  command?(sessionId: string, command: ReplayCommandEnvelope, signal?: AbortSignal): Promise<ReplayCommandResult>;
  forkSession?(sessionId: string, signal?: AbortSignal): Promise<ReplaySessionResponse>;
  report?(sessionId: string, signal?: AbortSignal): Promise<ReplayReportResponse>;
  journal?(sessionId: string, signal?: AbortSignal): Promise<ReplayJournalResponse>;
}

interface ReplayStreamBoundary {
  start(): void;
  stop(): void;
  requestResync(reason?: string): void;
}

export interface ReplayRuntimeLifecycleOptions {
  entry: ReplayEntry;
  api?: ReplayApiBoundary;
  store?: ReplayStore;
  streamFactory?: (options: ReplayStreamControllerOptions) => ReplayStreamBoundary;
  clientInstanceId?: string;
  commandIdFactory?: () => string;
  replaceSessionUrl?: (sessionId: string) => void;
}

type Listener = () => void;

function runtimeError(error: unknown): ReplayRuntimeError {
  if (error instanceof ReplayApiError || error instanceof ReplayStreamError) {
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof ReplayApiError && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) return { code: "REPLAY_RUNTIME_ERROR", message: error.message };
  return { code: "REPLAY_RUNTIME_ERROR", message: "Unknown replay runtime failure" };
}

function isDefinitiveCommandRejection(error: unknown): boolean {
  return error instanceof ReplayApiError
    && error.status !== null
    && error.status >= 400
    && error.status < 500
    && error.code !== "REPLAY_TRANSPORT_ERROR"
    && error.code !== "REPLAY_PROTOCOL_ERROR";
}

function assertCommandAcknowledgement(
  sessionId: string,
  command: ReplayCommandEnvelope,
  result: ReplayCommandResult,
): void {
  if (result.session_id !== sessionId) {
    throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "command response session identity changed", { fatal: false });
  }
  if (result.command_id !== command.command_id) {
    throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "command response command identity changed", { fatal: false });
  }
  if (result.revision !== command.expected_revision + 1) {
    throw new ReplayStreamError(
      "REPLAY_PROTOCOL_ERROR",
      "command response revision did not acknowledge the request",
      { fatal: false },
    );
  }
}

let fallbackIdentityCounter = 0;

function randomIdentity(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackIdentityCounter += 1;
  return `${prefix}-${Date.now()}-${fallbackIdentityCounter}`;
}

function defaultReplaceSessionUrl(sessionId: string): void {
  if (typeof history !== "object" || typeof location !== "object") return;
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/[^/]*$/, "replay.html");
  url.search = new URLSearchParams({ session: sessionId }).toString();
  url.hash = "";
  history.replaceState(null, "", url);
}

function connectionState(state: ReplayStreamState): ReplayConnectionState {
  return state;
}

function assertInitialStreamAuthorityFloor(
  validation: ReplaySessionSnapshot,
  snapshot: ReplaySessionSnapshot,
): void {
  const sequenceAdvance = snapshot.sequence - validation.sequence;
  const revisionAdvance = snapshot.revision - validation.revision;
  const sourceAdvance = snapshot.cursor.source_sequence - validation.cursor.source_sequence;
  const intentionalSeek = snapshot.status_reason === "seek_complete"
    && snapshot.state === "PAUSED"
    && sequenceAdvance > 0
    && revisionAdvance > 0;
  const sameConfig = JSON.stringify(snapshot.config) === JSON.stringify(validation.config);
  const samePublicOrigin = snapshot.components.bar_builder.replay_start_ms
    === validation.components.bar_builder.replay_start_ms;
  if (!sameConfig || !samePublicOrigin) {
    throw new ReplayStreamError(
      "REPLAY_PROTOCOL_ERROR",
      "first replay stream snapshot changed immutable session identity",
      { fatal: false },
    );
  }
  if (sequenceAdvance < 0
    || revisionAdvance < 0
    || revisionAdvance > sequenceAdvance
    || (!intentionalSeek && sourceAdvance < 0)
    || (!intentionalSeek && sourceAdvance > sequenceAdvance)
    || (!intentionalSeek
      && snapshot.cursor.virtual_time_ms < validation.cursor.virtual_time_ms)
    || (validation.revealed && !snapshot.revealed)
    || (validation.state === "ENDED" && snapshot.state !== "ENDED")) {
    throw new ReplayStreamError(
      "REPLAY_PROTOCOL_ERROR",
      "first replay stream snapshot predates HTTP validation authority",
      { fatal: false },
    );
  }
}

export class ReplayRuntimeLifecycle {
  readonly store: ReplayStore;
  private readonly entry: ReplayEntry;
  private readonly api: ReplayApiBoundary;
  private readonly streamFactory: (options: ReplayStreamControllerOptions) => ReplayStreamBoundary;
  private readonly clientInstanceId: string;
  private readonly commandIdFactory: () => string;
  private readonly replaceSessionUrl: (sessionId: string) => void;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribeStore: () => void;
  private phase: ReplayRuntimePhase = "IDLE";
  private capabilities: ReplayCapabilities | null = null;
  private catalog: ReplayCatalog | null = null;
  private error: ReplayRuntimeError | null = null;
  private sessionId: string | null = null;
  private operation: ReplayRuntimeOperation = null;
  private forkPending = false;
  private pendingCommand: ReplayCommandEnvelope | null = null;
  private awaitingStreamAck: ReplayStreamAckTarget | null = null;
  private commandRecoveryTarget: ReplayCommandRecoveryTarget | null = null;
  private commandRecoveryRequest: Promise<ReplayCommandResult> | null = null;
  private commandError: ReplayRuntimeError | null = null;
  private commandTimeline: ReplayCommandTimelineEntry[] = [];
  private report: ReplayReportResponse | null = null;
  private reportError: ReplayRuntimeError | null = null;
  private reportRequest: Promise<ReplayReportResponse> | null = null;
  private reportRefreshQueued = false;
  private createRequest: Promise<string> | null = null;
  private forkRequest: Promise<string> | null = null;
  private stream: ReplayStreamBoundary | null = null;
  private abortController: AbortController | null = null;
  private runToken = 0;
  private streamToken = 0;
  private catalogRequestToken = 0;
  private started = false;
  private disposed = false;
  private acquireAfterSnapshot = false;
  private commandRevisionFloor = 0;
  private snapshot: ReplayRuntimeSnapshot;

  constructor({
    entry,
    api = defaultReplayApi,
    store = new ReplayStore(),
    streamFactory = (options) => new ReplayStreamController(options),
    clientInstanceId = randomIdentity("browser"),
    commandIdFactory = () => randomIdentity("command"),
    replaceSessionUrl = defaultReplaceSessionUrl,
  }: ReplayRuntimeLifecycleOptions) {
    this.entry = entry;
    this.api = api;
    this.store = store;
    this.streamFactory = streamFactory;
    this.clientInstanceId = clientInstanceId;
    this.commandIdFactory = commandIdFactory;
    this.replaceSessionUrl = replaceSessionUrl;
    this.snapshot = this.buildSnapshot();
    this.unsubscribeStore = this.store.subscribe(() => this.publish());
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReplayRuntimeSnapshot => this.snapshot;

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.run();
  }

  restart(): void {
    if (this.disposed) return;
    this.stopCurrentRun(true);
    this.started = true;
    this.error = null;
    void this.run();
  }

  requestResync(reason?: string): void {
    this.stream?.requestResync(reason);
  }

  async loadCatalog(query: ReplayCatalogQuery = {
    warmupBars: 200,
    horizonMs: 86_400_000,
    qualityMode: "exact",
    blindMode: true,
  }): Promise<ReplayCatalog> {
    const catalogApi = this.api.catalog;
    if (!catalogApi) throw new Error("replay catalog API is unavailable");
    if (this.disposed) throw new Error("replay runtime is stopped");
    const token = this.runToken;
    const requestToken = this.catalogRequestToken + 1;
    this.catalogRequestToken = requestToken;
    this.operation = "catalog";
    this.error = null;
    this.publish();
    try {
      const catalog = await catalogApi.call(this.api, query, this.abortController?.signal);
      if (!this.isCurrent(token)) {
        throw new Error("replay runtime changed while loading the catalog");
      }
      if (requestToken !== this.catalogRequestToken) return catalog;
      this.catalog = catalog;
      return catalog;
    } catch (error) {
      if (this.isCurrent(token)
        && requestToken === this.catalogRequestToken
        && !(error instanceof DOMException && error.name === "AbortError")) {
        this.error = runtimeError(error);
      }
      throw error;
    } finally {
      if (this.isCurrent(token) && requestToken === this.catalogRequestToken) {
        if (this.operation === "catalog") this.operation = null;
        this.publish();
      }
    }
  }

  createSession(config: ReplaySessionConfig): Promise<string> {
    if (this.createRequest !== null) return this.createRequest;
    const request = this.performCreateSession(config);
    this.createRequest = request;
    void request.then(
      () => this.completeCreateRequest(request),
      () => this.completeCreateRequest(request),
    );
    return request;
  }

  private async performCreateSession(config: ReplaySessionConfig): Promise<string> {
    const createApi = this.api.createSession;
    if (!createApi) throw new Error("replay session creation API is unavailable");
    if (this.phase !== "CONFIGURING") throw new Error("replay runtime is not configuring a session");
    this.operation = "create";
    this.error = null;
    this.publish();
    const token = this.runToken;
    try {
      const response = await createApi.call(this.api, config, this.abortController?.signal);
      if (!this.isCurrent(token) || this.sessionId !== null || this.phase !== "CONFIGURING") {
        throw new Error("replay runtime changed while creating a session");
      }
      if (response.snapshot.session_id !== response.session_id) {
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "create response session identity is inconsistent", { fatal: false });
      }
      this.replaceSessionUrl(response.session_id);
      this.acquireAfterSnapshot = true;
      this.connectValidatedSession(response.snapshot, token);
      return response.session_id;
    } catch (error) {
      if (this.isCurrent(token) && !(error instanceof DOMException && error.name === "AbortError")) {
        this.phase = "CONFIGURING";
        this.error = runtimeError(error);
      }
      throw error;
    } finally {
      if (this.isCurrent(token)) {
        this.operation = null;
        this.publish();
      }
    }
  }

  private completeCreateRequest(request: Promise<string>): void {
    if (this.createRequest === request) this.createRequest = null;
  }

  forkSession(): Promise<string> {
    if (this.forkRequest !== null) return this.forkRequest;
    this.forkPending = true;
    const request = this.performForkSession();
    this.forkRequest = request;
    void request.then(
      () => this.completeForkRequest(request),
      () => this.completeForkRequest(request),
    );
    return request;
  }

  private async performForkSession(): Promise<string> {
    const forkApi = this.api.forkSession;
    const sessionId = this.sessionId;
    if (!forkApi || !sessionId) throw new Error("replay fork API is unavailable");
    if (this.pendingCommand) throw new Error("wait for the pending replay command");
    this.operation = "fork";
    this.publish();
    const token = this.runToken;
    try {
      const response = await forkApi.call(this.api, sessionId, this.abortController?.signal);
      if (!this.isCurrent(token) || this.sessionId !== sessionId) {
        throw new Error("replay runtime changed while forking a session");
      }
      if (response.session_id === sessionId
        || response.snapshot.session_id !== response.session_id
        || response.forked !== true
        || response.forked_from_session_id !== sessionId) {
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "fork response is not bound to its parent session", { fatal: false });
      }
      this.replaceSessionUrl(response.session_id);
      this.acquireAfterSnapshot = true;
      this.connectValidatedSession(response.snapshot, token);
      return response.session_id;
    } catch (error) {
      if (this.isCurrent(token)) this.commandError = runtimeError(error);
      throw error;
    } finally {
      if (this.isCurrent(token)) {
        this.publish();
      }
    }
  }

  private completeForkRequest(request: Promise<string>): void {
    if (this.forkRequest !== request) return;
    this.forkRequest = null;
    this.forkPending = false;
    if (this.operation === "fork") this.operation = null;
    this.publish();
    this.drainQueuedReportRefresh();
  }

  async submitCommand(
    type: ReplayCommandType,
    payload: Readonly<Record<string, ReplayJson>> = {},
  ): Promise<ReplayCommandResult> {
    const commandApi = this.api.command;
    const sessionId = this.sessionId;
    if (!commandApi || !sessionId || this.phase !== "ACTIVE") {
      throw new Error("replay session is not command-ready");
    }
    if (this.forkRequest !== null) throw new Error("wait for the pending replay fork");
    if (this.pendingCommand !== null) throw new Error("another replay command is pending");
    if (this.store.getSnapshot().connectionState !== "connected") {
      throw new Error("replay stream must reconnect before commands are accepted");
    }
    if (this.store.getSnapshot().sessionId !== sessionId) {
      throw new Error("replay session identity is not authoritative");
    }
    const token = this.runToken;
    const submittedRevision = Math.max(this.store.getSnapshot().revision, this.commandRevisionFloor);
    const command: ReplayCommandEnvelope = {
      protocol: "replay.v1",
      command_id: this.commandIdFactory(),
      client_instance_id: this.clientInstanceId,
      expected_revision: submittedRevision,
      type,
      payload,
    };
    const submittedAtMs = Date.now();
    const timelineEntry: ReplayCommandTimelineEntry = {
      command_id: command.command_id,
      type,
      submitted_revision: submittedRevision,
      acknowledged_revision: null,
      submitted_at_ms: submittedAtMs,
      status: "pending",
      error_code: null,
    };
    this.pendingCommand = command;
    this.commandError = null;
    this.operation = "command";
    this.commandTimeline = [...this.commandTimeline.slice(-199), timelineEntry];
    this.publish();
    try {
      const result = await commandApi.call(this.api, sessionId, command, this.abortController?.signal);
      if (!this.isCurrent(token) || this.sessionId !== sessionId) {
        throw new Error("replay runtime changed while submitting a command");
      }
      assertCommandAcknowledgement(sessionId, command, result);
      this.commandRevisionFloor = Math.max(this.commandRevisionFloor, result.revision);
      this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
        ? { ...entry, status: "acknowledged", acknowledged_revision: result.revision }
        : entry);
      this.awaitingStreamAck = {
        commandId: command.command_id,
        sessionId,
        sequence: result.sequence,
        revision: result.revision,
        state: result.state,
        stateHash: result.state_hash,
        virtualTimeMs: result.cursor.virtual_time_ms,
        sourceSequence: result.cursor.source_sequence,
      };
      this.completePendingCommandFromStream();
      return result;
    } catch (error) {
      if (this.isCurrent(token) && this.sessionId === sessionId) {
        const view = runtimeError(error);
        if (isDefinitiveCommandRejection(error)) {
          this.commandError = view;
          this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
            ? { ...entry, status: "rejected", error_code: view.code }
            : entry);
          if (view.code === "REVISION_CONFLICT") this.stream?.requestResync("command revision conflict");
        } else {
          this.commandError = {
            ...view,
            details: {
              ...(view.details ?? {}),
              outcome: "unknown",
              needs_resync: true,
            },
          };
          this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
            ? { ...entry, status: "unknown", error_code: view.code }
            : entry);
          this.commandRecoveryTarget = {
            command,
            sessionId,
            generationFloor: this.store.getSnapshot().generation,
            retryAfterGeneration: true,
          };
          this.stream?.requestResync("command outcome is unknown after HTTP acknowledgement loss");
        }
      }
      throw error;
    } finally {
      if (this.isCurrent(token) && this.sessionId === sessionId) {
        if (this.awaitingStreamAck?.commandId !== command.command_id
          && this.commandRecoveryTarget?.command.command_id !== command.command_id) {
          if (this.pendingCommand?.command_id === command.command_id) this.pendingCommand = null;
          if (this.operation === "command") this.operation = null;
        } else {
          this.completePendingCommandFromStream();
        }
        this.publish();
      }
    }
  }

  retryPendingCommandRecovery(): Promise<ReplayCommandResult> {
    if (this.commandRecoveryRequest !== null) return this.commandRecoveryRequest;
    const target = this.commandRecoveryTarget;
    const authority = this.store.getAuthoritySnapshot();
    if (target === null || this.pendingCommand?.command_id !== target.command.command_id) {
      return Promise.reject(new Error("no replay command is awaiting idempotent reconciliation"));
    }
    if (authority.sessionId !== target.sessionId
      || authority.connectionState !== "connected"
      || authority.generation <= target.generationFloor) {
      return Promise.reject(new Error("wait for a newer authoritative replay snapshot before reconciliation"));
    }
    const request = this.performCommandRecovery(target);
    this.commandRecoveryRequest = request;
    void request.then(
      () => this.completeCommandRecoveryRequest(request),
      () => this.completeCommandRecoveryRequest(request),
    );
    this.publish();
    return request;
  }

  private async performCommandRecovery(target: ReplayCommandRecoveryTarget): Promise<ReplayCommandResult> {
    const commandApi = this.api.command;
    const token = this.runToken;
    const { command, sessionId } = target;
    if (!commandApi) throw new Error("replay command API is unavailable");
    try {
      const result = await commandApi.call(this.api, sessionId, command, this.abortController?.signal);
      if (!this.isCurrent(token)
        || this.sessionId !== sessionId
        || this.commandRecoveryTarget?.command.command_id !== command.command_id) {
        throw new Error("replay runtime changed while reconciling a command");
      }
      assertCommandAcknowledgement(sessionId, command, result);
      this.commandRevisionFloor = Math.max(this.commandRevisionFloor, result.revision);
      this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
        ? {
            ...entry,
            status: "acknowledged",
            acknowledged_revision: result.revision,
            error_code: null,
          }
        : entry);
      this.awaitingStreamAck = {
        commandId: command.command_id,
        sessionId,
        sequence: result.sequence,
        revision: result.revision,
        state: result.state,
        stateHash: result.state_hash,
        virtualTimeMs: result.cursor.virtual_time_ms,
        sourceSequence: result.cursor.source_sequence,
      };
      this.commandRecoveryTarget = null;
      this.commandError = null;
      this.completePendingCommandFromStream();
      return result;
    } catch (error) {
      if (this.isCurrent(token)
        && this.sessionId === sessionId
        && this.pendingCommand?.command_id === command.command_id) {
        const view = runtimeError(error);
        if (isDefinitiveCommandRejection(error)) {
          this.commandRecoveryTarget = null;
          this.commandError = view;
          this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
            ? { ...entry, status: "rejected", error_code: view.code }
            : entry);
          this.pendingCommand = null;
          if (this.operation === "command") this.operation = null;
          if (view.code === "REVISION_CONFLICT") this.stream?.requestResync("command revision conflict");
        } else {
          this.commandError = {
            ...view,
            details: {
              ...(view.details ?? {}),
              outcome: "unknown",
              needs_resync: true,
            },
          };
          this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === command.command_id
            ? { ...entry, status: "unknown", error_code: view.code }
            : entry);
          this.commandRecoveryTarget = {
            command,
            sessionId,
            generationFloor: this.store.getAuthoritySnapshot().generation,
            retryAfterGeneration: false,
          };
          this.stream?.requestResync("idempotent command reconciliation outcome is unknown");
        }
      }
      throw error;
    }
  }

  private completeCommandRecoveryRequest(request: Promise<ReplayCommandResult>): void {
    if (this.commandRecoveryRequest !== request) return;
    this.commandRecoveryRequest = null;
    this.publish();
  }

  loadReport(): Promise<ReplayReportResponse> {
    if (this.forkPending) return Promise.reject(new Error("wait for the pending replay fork"));
    if (this.reportRequest !== null) return this.reportRequest;
    const request = this.performLoadReport();
    this.reportRequest = request;
    void request.then(
      () => this.completeReportRequest(request),
      () => this.completeReportRequest(request),
    );
    return request;
  }

  private async performLoadReport(): Promise<ReplayReportResponse> {
    const reportApi = this.api.report;
    const sessionId = this.sessionId;
    if (!reportApi || !sessionId) throw new Error("replay report API is unavailable");
    const token = this.runToken;
    const generation = this.store.getSnapshot().generation;
    this.operation = "report";
    this.reportError = null;
    this.publish();
    try {
      const report = await reportApi.call(this.api, sessionId, this.abortController?.signal);
      if (!this.isCurrent(token) || this.sessionId !== sessionId) {
        throw new Error("replay runtime changed while loading the report");
      }
      const snapshot = this.store.getSnapshot();
      if (snapshot.generation !== generation || snapshot.sessionId !== sessionId) {
        throw new Error("replay stream generation changed while loading the report");
      }
      if (report.session_id !== sessionId) {
        this.stream?.requestResync("report response session identity changed");
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "report response session identity changed", { fatal: false });
      }
      const hasActualHistory = Object.hasOwn(report, "actual_history");
      if (report.revealed !== snapshot.revealed || hasActualHistory !== snapshot.revealed) {
        if (!this.reportRefreshQueued) {
          this.stream?.requestResync("report reveal state disagrees with the authoritative replay state");
        }
        throw new ReplayStreamError(
          "REPLAY_PROTOCOL_ERROR",
          "report reveal state disagrees with the authoritative replay state",
          { fatal: false },
        );
      }
      const authoritativeEnded = snapshot.state === "ENDED";
      if (report.report.ended !== authoritativeEnded) {
        if (!this.reportRefreshQueued) {
          this.stream?.requestResync("report ended state disagrees with the authoritative replay state");
        }
        throw new ReplayStreamError(
          "REPLAY_PROTOCOL_ERROR",
          "report ended state disagrees with the authoritative replay state",
          { fatal: false },
        );
      }
      try {
        assertReplayArtifactCausality(
          report.report,
          snapshot.sourceSequence,
          "$.report",
          snapshot.virtualTimeMs ?? undefined,
        );
      } catch (error) {
        this.stream?.requestResync("report crossed the authoritative replay cursor");
        throw error;
      }
      this.report = report;
      return report;
    } catch (error) {
      if (this.isCurrent(token)
        && this.sessionId === sessionId
        && this.store.getSnapshot().generation === generation) {
        this.reportError = runtimeError(error);
      }
      throw error;
    } finally {
      if (this.isCurrent(token) && this.sessionId === sessionId && this.operation === "report") {
        this.operation = null;
        this.publish();
      }
    }
  }

  private completeReportRequest(request: Promise<ReplayReportResponse>): void {
    if (this.reportRequest !== request) return;
    this.reportRequest = null;
    this.drainQueuedReportRefresh();
  }

  private queueReportRefresh(): void {
    if (!this.api.report || !this.sessionId || this.disposed) return;
    if (this.reportRequest !== null || this.forkPending) {
      this.reportRefreshQueued = true;
      return;
    }
    void this.loadReport().catch(() => undefined);
  }

  private drainQueuedReportRefresh(): void {
    if (!this.reportRefreshQueued
      || this.disposed
      || this.forkPending
      || this.reportRequest !== null) return;
    this.reportRefreshQueued = false;
    void this.loadReport().catch(() => undefined);
  }

  async refreshJournal(): Promise<ReplayJournalResponse> {
    const journalApi = this.api.journal;
    const sessionId = this.sessionId;
    if (!journalApi || !sessionId) throw new Error("replay journal API is unavailable");
    const token = this.runToken;
    const generation = this.store.getSnapshot().generation;
    this.operation = "journal";
    this.publish();
    try {
      const journal = await journalApi.call(this.api, sessionId, this.abortController?.signal);
      if (!this.isCurrent(token) || this.sessionId !== sessionId) {
        throw new Error("replay runtime changed while loading the journal");
      }
      if (journal.session_id !== sessionId) {
        this.stream?.requestResync("journal response session identity changed");
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "journal response session identity changed", { fatal: false });
      }
      const snapshot = this.store.getSnapshot();
      if (snapshot.generation !== generation || snapshot.sessionId !== sessionId) {
        throw new Error("replay stream generation changed while loading the journal");
      }
      const authoritativeVirtualTimeMs = snapshot.virtualTimeMs;
      if (
        authoritativeVirtualTimeMs === null
        || journal.entries.some((entry) => entry.virtual_time_ms > authoritativeVirtualTimeMs)
      ) {
        this.stream?.requestResync("journal crossed the authoritative replay time");
        throw new ReplayStreamError(
          "REPLAY_PROTOCOL_ERROR",
          "journal crossed the authoritative replay time",
          { fatal: false },
        );
      }
      if (!this.store.replaceJournal(generation, journal.entries)) {
        this.stream?.requestResync("journal store generation rejected the response");
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "journal store generation rejected the response", { fatal: false });
      }
      return journal;
    } finally {
      if (this.isCurrent(token) && this.sessionId === sessionId && this.operation === "journal") {
        this.operation = null;
        this.publish();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCurrentRun();
    this.phase = "STOPPED";
    this.unsubscribeStore();
    this.store.dispose();
    this.publish();
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    const token = this.runToken + 1;
    this.runToken = token;
    if (this.entry.kind === "error") {
      this.phase = "ENTRY_ERROR";
      this.error = { code: this.entry.code, message: this.entry.message };
      this.publish();
      return;
    }
    const abortController = new AbortController();
    this.abortController = abortController;
    this.phase = "LOADING_CAPABILITIES";
    this.error = null;
    this.publish();
    try {
      const capabilities = await this.api.capabilities(abortController.signal);
      if (!this.isCurrent(token)) return;
      this.capabilities = capabilities;
      if (!capabilities.enabled || !capabilities.available) {
        this.fail({
          code: capabilities.reason ?? (capabilities.persistence.degraded ? "PERSISTENCE_DEGRADED" : "REPLAY_DISABLED"),
          message: capabilities.persistence.degraded_reason ?? "K-line replay is unavailable",
        });
        return;
      }
      const currentSessionId = this.sessionId ?? (this.entry.kind === "session" ? this.entry.sessionId : null);
      if (currentSessionId === null) {
        this.phase = "CONFIGURING";
        this.publish();
        if (this.api.catalog) {
          const request = this.loadCatalog();
          // loadCatalog increments its token synchronously before the first
          // await. A later user refresh owns the configuration surface; a
          // late rejection from this bootstrap request must not turn that
          // newer state into a runtime-wide ERROR.
          const requestToken = this.catalogRequestToken;
          try {
            await request;
          } catch (error) {
            if (!this.isCurrent(token) || requestToken !== this.catalogRequestToken) return;
            throw error;
          }
        }
        return;
      }

      this.sessionId = currentSessionId;
      this.phase = "VALIDATING_SESSION";
      this.publish();
      // This HTTP snapshot is validation only. It is deliberately never
      // published; the WebSocket atomic snapshot is the first chart truth.
      const response = await this.api.getSession(currentSessionId, abortController.signal);
      if (!this.isCurrent(token)) return;
      if (response.session_id !== currentSessionId || response.snapshot.session_id !== currentSessionId) {
        throw new ReplayStreamError("REPLAY_PROTOCOL_ERROR", "session response identity changed", { fatal: true });
      }
      this.acquireAfterSnapshot = response.snapshot.controller_client_id === null;
      this.connectValidatedSession(response.snapshot, token);
    } catch (error) {
      if (!this.isCurrent(token) || (error instanceof DOMException && error.name === "AbortError")) return;
      this.fail(runtimeError(error));
    }
  }

  private connectValidatedSession(validationSnapshot: ReplaySessionSnapshot, token: number): void {
    const preservePendingCommand = this.pendingCommand !== null
      && this.sessionId === validationSnapshot.session_id
      && (this.awaitingStreamAck?.sessionId === validationSnapshot.session_id
        || this.commandRecoveryTarget?.sessionId === validationSnapshot.session_id);
    this.stream?.stop();
    this.stream = null;
    this.sessionId = validationSnapshot.session_id;
    this.report = null;
    this.reportError = null;
    this.reportRequest = null;
    this.reportRefreshQueued = false;
    if (!preservePendingCommand) {
      this.pendingCommand = null;
      this.commandError = null;
      this.commandTimeline = [];
      this.awaitingStreamAck = null;
      this.commandRecoveryTarget = null;
    } else if (this.commandRecoveryTarget !== null) {
      this.commandRecoveryTarget = {
        ...this.commandRecoveryTarget,
        generationFloor: this.store.getAuthoritySnapshot().generation,
        retryAfterGeneration: true,
      };
      this.operation = "command";
    }
    this.commandRecoveryRequest = null;
    this.commandRevisionFloor = validationSnapshot.revision;
    this.phase = "CONNECTING_SESSION";
    this.publish();
    const streamToken = this.streamToken + 1;
    this.streamToken = streamToken;
    this.stream = this.createStream(validationSnapshot, token, streamToken);
    this.stream.start();
  }

  private createStream(
    validationSnapshot: ReplaySessionSnapshot,
    token: number,
    streamToken: number,
  ): ReplayStreamBoundary {
    let initialAuthorityFloor: ReplaySessionSnapshot | null = validationSnapshot;
    const generationMap = new Map<number, number>();
    const mappedGeneration = (localGeneration: number): number | null => (
      generationMap.get(localGeneration) ?? null
    );
    const isCurrentStream = (): boolean => (
      this.isCurrent(token)
      && this.streamToken === streamToken
      && this.sessionId === validationSnapshot.session_id
    );
    return this.streamFactory({
      sessionId: validationSnapshot.session_id,
      initialDataEpoch: validationSnapshot.data_epoch,
      clientInstanceId: this.clientInstanceId,
      shouldHeartbeat: () => {
        const snapshot = this.store.getSnapshot();
        return snapshot.controllerClientId === this.clientInstanceId && snapshot.state !== "ENDED";
      },
      onGeneration: ({ generation, reason, resetAuthoritativeState }) => {
        if (!isCurrentStream()) return;
        const globalGeneration = this.store.getSnapshot().generation + 1;
        generationMap.set(generation, globalGeneration);
        if (resetAuthoritativeState) {
          this.report = null;
          this.reportError = null;
          this.reportRefreshQueued = false;
        }
        this.store.beginGeneration(globalGeneration, {
          resetAuthoritativeState,
          connectionState: reason === "resync" ? "resyncing" : reason === "reconnect" ? "reconnecting" : "connecting",
        });
      },
      onState: (state, generation) => {
        if (!isCurrentStream()) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration !== null) this.store.setConnectionState(globalGeneration, connectionState(state));
      },
      onSnapshot: (snapshot, generation) => {
        const globalGeneration = mappedGeneration(generation);
        if (!isCurrentStream() || globalGeneration === null) return;
        if (initialAuthorityFloor !== null) {
          assertInitialStreamAuthorityFloor(initialAuthorityFloor, snapshot);
        }
        if (!this.store.applyAtomicSnapshot(globalGeneration, snapshot)) {
          throw new Error("replay store rejected the atomic snapshot generation");
        }
        initialAuthorityFloor = null;
        // Reports are point-in-time artifacts. The atomic snapshot is the
        // current broker authority, so an artifact from an older generation
        // must never cover its orders/trades while a fresh report is loading.
        this.report = null;
        this.reportError = null;
        this.maybeRetryUncertainCommand(globalGeneration);
        this.completePendingCommandFromStream();
        this.phase = "ACTIVE";
        this.commandRevisionFloor = Math.max(this.commandRevisionFloor, snapshot.revision);
        this.error = null;
        this.publish();
        if (this.acquireAfterSnapshot && snapshot.controller_client_id === null) {
          this.acquireAfterSnapshot = false;
          void this.submitCommand("acquire_controller", {}).catch(() => undefined);
        }
        if (snapshot.state === "ENDED") {
          if (this.reportRequest !== null) this.reportRefreshQueued = true;
          else void this.loadReport().catch(() => undefined);
        }
      },
      onEvent: (event, generation) => {
        if (!isCurrentStream()) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration === null) return;
        if (!this.store.applyEvent(globalGeneration, event)) {
          throw new Error("replay store rejected the authoritative event generation");
        }
        if (this.completePendingCommandFromStream()) this.publish();
        this.store.clearError(globalGeneration);
        this.commandRevisionFloor = Math.max(this.commandRevisionFloor, event.revision);
        if (event.type === "replay.ended") {
          this.queueReportRefresh();
        } else {
          const data = event.data as {
            readonly reason?: string;
            readonly projection?: { readonly fills?: readonly unknown[] };
          };
          if (event.type === "replay.status" && data.reason === "history_revealed") {
            this.queueReportRefresh();
          } else if ((data.projection?.fills?.length ?? 0) > 0) {
            this.queueReportRefresh();
          }
        }
      },
      onError: (error, generation) => {
        if (!isCurrentStream()) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration === null) return;
        const view = runtimeError(error);
        this.store.setError(globalGeneration, view as ReplayStoreError);
        if (error.fatal) this.fail(view);
      },
    });
  }

  private fail(error: ReplayRuntimeError): void {
    this.error = error;
    this.phase = "ERROR";
    this.publish();
  }

  private stopCurrentRun(preservePendingCommand = false): void {
    const pendingSessionId = this.sessionId;
    const pendingCommand = this.pendingCommand;
    if (preservePendingCommand
      && pendingCommand !== null
      && pendingSessionId !== null
      && this.awaitingStreamAck === null
      && this.commandRecoveryTarget === null) {
      const view: ReplayRuntimeError = {
        code: "REPLAY_COMMAND_OUTCOME_UNKNOWN",
        message: "replay runtime restarted before the command outcome was acknowledged",
        details: { outcome: "unknown", needs_resync: true },
      };
      this.commandError = view;
      this.commandTimeline = this.commandTimeline.map((entry) => entry.command_id === pendingCommand.command_id
        ? { ...entry, status: "unknown", error_code: view.code }
        : entry);
      this.commandRecoveryTarget = {
        command: pendingCommand,
        sessionId: pendingSessionId,
        generationFloor: this.store.getAuthoritySnapshot().generation,
        retryAfterGeneration: true,
      };
    } else if (preservePendingCommand && this.commandRecoveryTarget !== null) {
      this.commandRecoveryTarget = {
        ...this.commandRecoveryTarget,
        generationFloor: this.store.getAuthoritySnapshot().generation,
        retryAfterGeneration: true,
      };
    }
    this.runToken += 1;
    this.streamToken += 1;
    this.started = false;
    this.abortController?.abort();
    this.abortController = null;
    this.stream?.stop();
    this.stream = null;
    if (!preservePendingCommand) {
      this.pendingCommand = null;
      this.awaitingStreamAck = null;
      this.commandRecoveryTarget = null;
    }
    this.commandRecoveryRequest = null;
    this.createRequest = null;
    this.forkRequest = null;
    this.forkPending = false;
    this.operation = preservePendingCommand && this.pendingCommand !== null ? "command" : null;
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && token === this.runToken;
  }

  private completePendingCommandFromStream(): boolean {
    const target = this.awaitingStreamAck;
    if (target === null) return false;
    const authoritative = this.store.getAuthoritySnapshot();
    if (authoritative.sessionId !== target.sessionId
      || authoritative.sequence < target.sequence
      || authoritative.revision < target.revision) return false;
    if (authoritative.sequence === target.sequence) {
      const matches = authoritative.revision === target.revision
        && authoritative.state === target.state
        && authoritative.stateHash === target.stateHash
        && authoritative.virtualTimeMs === target.virtualTimeMs
        && authoritative.sourceSequence === target.sourceSequence;
      if (!matches) {
        this.stream?.requestResync("command acknowledgement disagrees with stream authority");
        return false;
      }
    }
    this.awaitingStreamAck = null;
    if (this.pendingCommand?.command_id === target.commandId) this.pendingCommand = null;
    if (this.operation === "command") this.operation = null;
    return true;
  }

  private maybeRetryUncertainCommand(generation: number): void {
    const target = this.commandRecoveryTarget;
    if (target === null
      || !target.retryAfterGeneration
      || generation <= target.generationFloor
      || this.commandRecoveryRequest !== null) return;
    this.commandRecoveryTarget = { ...target, retryAfterGeneration: false };
    void this.retryPendingCommandRecovery().catch(() => undefined);
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ReplayRuntimeSnapshot {
    return {
      phase: this.phase,
      capabilities: this.capabilities,
      catalog: this.catalog,
      error: this.error,
      sessionId: this.sessionId,
      clientInstanceId: this.clientInstanceId,
      operation: this.operation,
      forkPending: this.forkPending,
      commandRecoveryPending: this.commandRecoveryTarget !== null,
      commandRecoveryInFlight: this.commandRecoveryRequest !== null,
      commandRecoveryReady: this.commandRecoveryTarget !== null
        && this.commandRecoveryRequest === null
        && this.store.getAuthoritySnapshot().connectionState === "connected"
        && this.store.getAuthoritySnapshot().generation > this.commandRecoveryTarget.generationFloor,
      pendingCommand: this.pendingCommand,
      commandError: this.commandError,
      commandTimeline: this.commandTimeline,
      report: this.report,
      reportError: this.reportError,
      store: this.store.getSnapshot(),
    };
  }
}

function buildReplayMarketDataRuntime(
  snapshot: ReplayRuntimeSnapshot,
  lifecycle: ReplayRuntimeLifecycle,
): MarketDataRuntimeContract {
  const store = lifecycle.store;
  const lastPrice = snapshot.store.lastPrice;
  const displayData = lastPrice?.open !== undefined
    && lastPrice.high !== undefined
    && lastPrice.low !== undefined
    && lastPrice.close !== undefined
    ? {
        time: lastPrice.time,
        open: lastPrice.open,
        high: lastPrice.high,
        low: lastPrice.low,
        close: lastPrice.close,
        ...(lastPrice.volume === undefined ? {} : { volume: lastPrice.volume }),
      }
    : null;
  const priceChange = displayData?.open
    ? ((displayData.close - displayData.open) / displayData.open) * 100
    : 0;
  const wsStatus = snapshot.store.connectionState === "connected"
    ? "live"
    : snapshot.store.connectionState === "reconnecting" || snapshot.store.connectionState === "resyncing"
      ? "reconnecting"
      : snapshot.store.connectionState === "connecting"
        ? "connecting"
        : "disconnected";
  return {
    view: {
      bars: store.seriesStore.snapshot(),
      seriesStore: store.seriesStore,
      meta: {
        version: snapshot.store.renderRevision,
        status: snapshot.store.hasAuthoritativeSnapshot ? "ready" : "loading",
        source: "replay",
        seriesKey: store.seriesStore.seriesKey,
        ...(snapshot.store.sessionConfig
          ? {
              symbol: snapshot.store.sessionConfig.symbol,
              interval: snapshot.store.sessionConfig.display_interval,
            }
          : {}),
        bars: store.seriesStore.barCount,
        firstTime: store.seriesStore.first()?.time ?? null,
        lastTime: store.seriesStore.last()?.time ?? null,
        committedAt: snapshot.store.virtualTimeMs,
        dataRevision: store.seriesStore.version,
      },
      loading: !["ACTIVE", "CONFIGURING", "ERROR", "ENTRY_ERROR"].includes(snapshot.phase),
      error: snapshot.error,
      crosshairData: null,
      lastPrice,
      connectionStatus: snapshot.store.connectionState,
      dataSource: "replay",
      wsStatus,
      display: {
        displayData,
        priceChange,
        isUp: priceChange >= 0,
        amplitude: displayData?.open
          ? (((displayData.high - displayData.low) / displayData.open) * 100).toFixed(2)
          : "0.00",
        wsStatusLabel: snapshot.store.connectionState === "connected" ? "Replay stream" : "Replay disconnected",
        exchangeLabel: snapshot.store.sessionConfig?.exchange ?? "Replay",
        marketLabel: snapshot.store.sessionConfig?.market_type ?? "Historical",
      },
    },
    actions: {
      retry: () => lifecycle.restart(),
      loadMoreLeft: async () => undefined,
      onCrosshairMove: (value) => store.setCrosshairData(value),
      onVisibleRangeChange: () => store.markVisibleRangePending(),
      consumeIndicatorRangeRequest: (requestId) => store.consumeIndicatorRequest(requestId),
    },
    status: {
      hasMoreLeft: false,
      loadingMoreLeft: false,
      activeChartReady: snapshot.store.hasAuthoritativeSnapshot && store.seriesStore.barCount > 0,
      canLoadMoreLeft: false,
      canRestoreLatestWindow: false,
      barCount: store.seriesStore.barCount,
      cacheDiagnostics: () => ({
        owner: "replay",
        sessionId: snapshot.store.sessionId,
        dataEpoch: snapshot.store.dataEpoch,
        seriesKey: store.seriesStore.seriesKey,
        bars: store.seriesStore.barCount,
      }),
      trimCacheEntries: () => ({ owner: "replay", removedCount: 0 }),
      indicatorRangeRequests: [],
      requestDemand: null,
    },
  };
}

export interface ReplayRuntime extends ReplayRuntimeSnapshot {
  readonly lifecycle: ReplayRuntimeLifecycle;
  readonly replayStore: ReplayStore;
  readonly marketData: MarketDataRuntimeContract;
  readonly actions: {
    retry(): void;
    requestResync(reason?: string): void;
    loadCatalog(query?: ReplayCatalogQuery): Promise<ReplayCatalog>;
    createSession(config: ReplaySessionConfig): Promise<string>;
    forkSession(): Promise<string>;
    submitCommand(type: ReplayCommandType, payload?: Readonly<Record<string, ReplayJson>>): Promise<ReplayCommandResult>;
    retryPendingCommandRecovery(): Promise<ReplayCommandResult>;
    acquireController(takeover?: boolean): Promise<ReplayCommandResult>;
    loadReport(): Promise<ReplayReportResponse>;
    refreshJournal(): Promise<ReplayJournalResponse>;
  };
}

export interface ReplayLifecycleLease {
  start(): void;
  dispose(): void;
}

/**
 * React development StrictMode deliberately runs an effect as
 * setup -> cleanup -> setup. ReplayRuntimeLifecycle disposal is terminal, so
 * defer the terminal cleanup by one microtask and cancel it only when the same
 * lifecycle instance is immediately leased again. Different instances retain
 * independent pending disposals and cannot keep an obsolete runtime alive.
 */
export class ReplayLifecycleEffectGuard {
  private readonly pendingDisposals = new Map<ReplayLifecycleLease, symbol>();

  mount(lifecycle: ReplayLifecycleLease): () => void {
    this.pendingDisposals.delete(lifecycle);
    lifecycle.start();
    return () => {
      const token = Symbol("replay-lifecycle-dispose");
      this.pendingDisposals.set(lifecycle, token);
      queueMicrotask(() => {
        if (this.pendingDisposals.get(lifecycle) !== token) return;
        this.pendingDisposals.delete(lifecycle);
        lifecycle.dispose();
      });
    };
  }
}

export function useReplayRuntime(
  entry: ReplayEntry,
  {
    api,
    store,
    streamFactory,
    clientInstanceId,
    commandIdFactory,
    replaceSessionUrl,
  }: Omit<ReplayRuntimeLifecycleOptions, "entry"> = {},
): ReplayRuntime {
  const lifecycle = useMemo(() => new ReplayRuntimeLifecycle({
    entry,
    ...(api === undefined ? {} : { api }),
    ...(store === undefined ? {} : { store }),
    ...(streamFactory === undefined ? {} : { streamFactory }),
    ...(clientInstanceId === undefined ? {} : { clientInstanceId }),
    ...(commandIdFactory === undefined ? {} : { commandIdFactory }),
    ...(replaceSessionUrl === undefined ? {} : { replaceSessionUrl }),
  }), [api, clientInstanceId, commandIdFactory, entry, replaceSessionUrl, store, streamFactory]);
  const lifecycleEffectGuard = useMemo(() => new ReplayLifecycleEffectGuard(), []);
  useEffect(
    () => lifecycleEffectGuard.mount(lifecycle),
    [lifecycle, lifecycleEffectGuard],
  );
  const snapshot = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const marketData = useMemo(
    () => buildReplayMarketDataRuntime(snapshot, lifecycle),
    [lifecycle, snapshot],
  );
  return useMemo(() => ({
    ...snapshot,
    lifecycle,
    replayStore: lifecycle.store,
    marketData,
    actions: {
      retry: () => lifecycle.restart(),
      requestResync: (reason?: string) => lifecycle.requestResync(reason),
      loadCatalog: (query?: ReplayCatalogQuery) => lifecycle.loadCatalog(query),
      createSession: (config: ReplaySessionConfig) => lifecycle.createSession(config),
      forkSession: () => lifecycle.forkSession(),
      submitCommand: (type: ReplayCommandType, payload?: Readonly<Record<string, ReplayJson>>) => (
        lifecycle.submitCommand(type, payload)
      ),
      retryPendingCommandRecovery: () => lifecycle.retryPendingCommandRecovery(),
      acquireController: (takeover = false) => lifecycle.submitCommand("acquire_controller", { takeover }),
      loadReport: () => lifecycle.loadReport(),
      refreshJournal: () => lifecycle.refreshJournal(),
    },
  }), [lifecycle, marketData, snapshot]);
}
