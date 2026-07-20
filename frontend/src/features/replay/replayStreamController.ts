import {
  assertReplayEventCausality,
  parseReplayErrorEnvelope,
  parseReplayEvent,
  ReplayPayloadParseError,
} from "./replayParser.js";
import type {
  ReplayDigest,
  ReplayParsedEvent,
  ReplaySessionSnapshot,
} from "./replayTypes.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReplayStreamGenerationReason = "initial" | "reconnect" | "resync";
export type ReplayStreamState = "idle" | "connecting" | "connected" | "reconnecting" | "resyncing" | "closed" | "error";

export interface ReplayStreamSocket {
  readonly readyState: number;
  readonly OPEN?: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

export interface ReplayStreamTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ReplayStreamGeneration {
  readonly generation: number;
  readonly reason: ReplayStreamGenerationReason;
  readonly resetAuthoritativeState: boolean;
}

export interface ReplayStreamCallbacks {
  onGeneration?(value: ReplayStreamGeneration): void;
  onState?(state: ReplayStreamState, generation: number): void;
  onSnapshot?(snapshot: ReplaySessionSnapshot, generation: number): void;
  onEvent?(event: ReplayParsedEvent, generation: number): void;
  onError?(error: ReplayStreamError, generation: number): void;
}

export interface ReplayStreamControllerOptions extends ReplayStreamCallbacks {
  sessionId: string;
  clientInstanceId?: string;
  shouldHeartbeat?: () => boolean;
  heartbeatMs?: number;
  initialDataEpoch?: ReplayDigest;
  baseUrl?: string;
  socketFactory?: (url: string) => ReplayStreamSocket;
  timers?: ReplayStreamTimers;
  location?: Pick<Location, "protocol" | "host">;
  backoffMs?: readonly number[];
  maxConsecutiveProtocolFaults?: number;
}

export class ReplayStreamError extends Error {
  readonly code: string;
  readonly fatal: boolean;

  constructor(code: string, message: string, { fatal, cause }: { fatal: boolean; cause?: unknown }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReplayStreamError";
    this.code = code;
    this.fatal = fatal;
  }
}

const defaultTimers: ReplayStreamTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function defaultSocketFactory(url: string): ReplayStreamSocket {
  if (typeof WebSocket !== "function") {
    throw new ReplayStreamError("REPLAY_TRANSPORT_ERROR", "WebSocket API is unavailable", { fatal: true });
  }
  return new WebSocket(url);
}

export function buildReplayStreamUrl({
  sessionId,
  baseUrl,
  location = globalThis.location,
  afterSequence,
  dataEpoch,
}: {
  sessionId: string;
  baseUrl?: string;
  location?: Pick<Location, "protocol" | "host">;
  afterSequence?: number;
  dataEpoch?: ReplayDigest;
}): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("invalid replay session id");
  const origin = baseUrl?.replace(/\/$/, "") ?? (() => {
    if (!location?.host) throw new Error("browser location is unavailable");
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  })();
  const params = new URLSearchParams();
  if (afterSequence !== undefined) params.set("after_sequence", String(afterSequence));
  if (dataEpoch !== undefined) params.set("data_epoch", dataEpoch);
  const suffix = params.size ? `?${params.toString()}` : "";
  return `${origin}/api/v1/stream/replay/${encodeURIComponent(sessionId)}${suffix}`;
}

export class ReplayStreamController {
  private readonly options: ReplayStreamControllerOptions;
  private readonly socketFactory: (url: string) => ReplayStreamSocket;
  private readonly timers: ReplayStreamTimers;
  private readonly backoffMs: readonly number[];
  private readonly maxConsecutiveProtocolFaults: number;
  private socket: ReplayStreamSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private stopped = true;
  private reconnectAttempt = 0;
  private consecutiveProtocolFaults = 0;
  private pendingReason: ReplayStreamGenerationReason | null = null;
  private hasAuthoritativeState = false;
  private lastSequence: number | null = null;
  private lastRevision: number | null = null;
  private lastVirtualTimeMs: number | null = null;
  private lastSourceSequence: number | null = null;
  private lastStateHash: ReplayDigest | null = null;
  private dataEpoch: ReplayDigest | undefined;
  private state: ReplayStreamState = "idle";

  constructor(options: ReplayStreamControllerOptions) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error("invalid replay session id");
    this.options = options;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.timers = options.timers ?? defaultTimers;
    this.backoffMs = options.backoffMs ?? [250, 500, 1_000, 2_000, 4_000, 8_000];
    this.maxConsecutiveProtocolFaults = options.maxConsecutiveProtocolFaults ?? 3;
    if (options.clientInstanceId !== undefined && !SESSION_ID.test(options.clientInstanceId)) {
      throw new Error("invalid replay client instance id");
    }
    if (options.heartbeatMs !== undefined
      && (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs < 250)) {
      throw new Error("replay heartbeat interval must be an integer of at least 250ms");
    }
    this.dataEpoch = options.initialDataEpoch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect("initial");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingReason = null;
    this.cancelReconnect();
    this.cancelHeartbeat();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(1000, "replay runtime stopped"); } catch { /* already closed */ }
    }
    this.setState("closed", this.generation);
  }

  requestResync(reason = "client requested replay resync"): void {
    if (this.stopped) return;
    const error = new ReplayStreamError("REPLAY_RESYNC_REQUIRED", reason, { fatal: false });
    this.options.onError?.(error, this.generation);
    this.beginResync();
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    return {
      state: this.state,
      generation: this.generation,
      stopped: this.stopped,
      reconnectAttempt: this.reconnectAttempt,
      consecutiveProtocolFaults: this.consecutiveProtocolFaults,
      hasAuthoritativeState: this.hasAuthoritativeState,
      lastSequence: this.lastSequence,
      lastRevision: this.lastRevision,
      lastVirtualTimeMs: this.lastVirtualTimeMs,
      lastSourceSequence: this.lastSourceSequence,
      lastStateHash: this.lastStateHash,
      dataEpoch: this.dataEpoch ?? null,
      heartbeatScheduled: this.heartbeatTimer !== null,
    };
  }

  private connect(reason: ReplayStreamGenerationReason): void {
    if (this.stopped) return;
    this.cancelReconnect();
    const generation = this.generation + 1;
    this.generation = generation;
    const resetAuthoritativeState = reason !== "reconnect";
    if (resetAuthoritativeState) {
      this.hasAuthoritativeState = false;
    }
    // Initial construction has the HTTP validation snapshot as its external
    // floor. Later resync generations must retain the last accepted stream
    // authority so a stale same-session snapshot cannot roll counters back.
    if (reason === "initial") {
      this.lastSequence = null;
      this.lastRevision = null;
      this.lastVirtualTimeMs = null;
      this.lastSourceSequence = null;
      this.lastStateHash = null;
    }
    this.options.onGeneration?.({ generation, reason, resetAuthoritativeState });
    this.setState(reason === "resync" ? "resyncing" : reason === "reconnect" ? "reconnecting" : "connecting", generation);

    let url: string;
    try {
      url = buildReplayStreamUrl({
        sessionId: this.options.sessionId,
        ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
        ...(this.options.location === undefined ? {} : { location: this.options.location }),
        ...(reason === "reconnect" && this.lastSequence !== null ? { afterSequence: this.lastSequence } : {}),
        ...(this.dataEpoch === undefined ? {} : { dataEpoch: this.dataEpoch }),
      });
      this.socket = this.socketFactory(url);
    } catch (error) {
      this.failFatal(new ReplayStreamError("REPLAY_TRANSPORT_ERROR", "failed to create replay WebSocket", { fatal: true, cause: error }), generation);
      return;
    }
    const socket = this.socket;
    socket.onopen = () => {
      if (!this.isCurrent(generation, socket)) return;
      // A TCP/WebSocket handshake is not an authoritative replay handshake.
      // Keep commands gated until the first valid snapshot or contiguous
      // catch-up event proves this generation has converged with the actor.
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(generation, socket)) return;
      this.handleMessage(event.data, generation, socket);
    };
    socket.onerror = () => {
      if (!this.isCurrent(generation, socket)) return;
      this.options.onError?.(new ReplayStreamError("REPLAY_TRANSPORT_ERROR", "replay WebSocket transport error", { fatal: false }), generation);
    };
    socket.onclose = () => {
      if (!this.isCurrent(generation, socket)) return;
      this.cancelHeartbeat();
      this.socket = null;
      if (this.stopped) return;
      const nextReason = this.pendingReason ?? "reconnect";
      this.pendingReason = null;
      this.setState(nextReason === "resync" ? "resyncing" : "reconnecting", generation);
      this.scheduleConnect(nextReason);
    };
  }

  private handleMessage(raw: unknown, generation: number, socket: ReplayStreamSocket): void {
    // WebSocket close is asynchronous. Once a resync has started, messages
    // already queued by the old transport must not repair or advance the
    // generation that was just declared causally unsafe.
    if (!this.isCurrent(generation, socket) || this.pendingReason !== null) return;
    if (typeof raw !== "string") {
      this.protocolFault("replay WebSocket message is not text", generation, socket);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (error) {
      this.protocolFault("replay WebSocket message is not valid JSON", generation, socket, error);
      return;
    }

    try {
      const envelope = parseReplayErrorEnvelope(payload);
      this.failFatal(new ReplayStreamError(envelope.error.code, envelope.error.message, { fatal: true }), generation);
      return;
    } catch {
      // A normal replay event is intentionally not an error envelope.
    }

    let event: ReplayParsedEvent;
    try {
      event = parseReplayEvent(payload);
    } catch (error) {
      const message = error instanceof ReplayPayloadParseError ? error.message : "replay event violates replay.v1";
      this.protocolFault(message, generation, socket, error);
      return;
    }
    if (event.session_id !== this.options.sessionId) {
      this.protocolFault("replay event session id changed", generation, socket);
      return;
    }
    if (this.dataEpoch !== undefined && event.data_epoch !== this.dataEpoch) {
      this.failFatal(new ReplayStreamError("DATASET_MISMATCH", "replay event data epoch changed", { fatal: true }), generation);
      return;
    }
    if (event.type === "replay.resync_required") {
      const error = new ReplayStreamError("REPLAY_RESYNC_REQUIRED", "server requires replay resynchronization", { fatal: false });
      this.options.onError?.(error, generation);
      this.beginResync();
      return;
    }
    if (event.type === "replay.snapshot") {
      const snapshot = (event.data as { snapshot: ReplaySessionSnapshot }).snapshot;
      const lastSequence = this.lastSequence;
      const lastRevision = this.lastRevision;
      const lastVirtualTimeMs = this.lastVirtualTimeMs;
      const lastSourceSequence = this.lastSourceSequence;
      const hasAuthorityFloor = lastSequence !== null
        && lastRevision !== null
        && lastVirtualTimeMs !== null
        && lastSourceSequence !== null;
      const isIntentionalSeekReset = hasAuthorityFloor
        && snapshot.status_reason === "seek_complete"
        && snapshot.state === "PAUSED"
        && snapshot.sequence === lastSequence + 1
        && snapshot.revision === lastRevision + 1;
      if (hasAuthorityFloor
        && ((snapshot.sequence < lastSequence)
          || (snapshot.revision < lastRevision)
          || (!isIntentionalSeekReset
            && ((snapshot.cursor.virtual_time_ms < lastVirtualTimeMs)
              || (snapshot.cursor.source_sequence < lastSourceSequence))))) {
        this.protocolFault("atomic replay snapshot moved authoritative state backward", generation, socket);
        return;
      }
      if (!isIntentionalSeekReset
        && hasAuthorityFloor
        && this.lastSequence !== null
        && this.lastSourceSequence !== null) {
        const transportAdvance = snapshot.sequence - this.lastSequence;
        const sourceAdvance = snapshot.cursor.source_sequence - this.lastSourceSequence;
        const sameSequenceChanged = transportAdvance === 0
          && ((this.lastRevision !== null && snapshot.revision !== this.lastRevision)
            || (this.lastVirtualTimeMs !== null && snapshot.cursor.virtual_time_ms !== this.lastVirtualTimeMs)
            || sourceAdvance !== 0
            || (this.lastStateHash !== null && snapshot.state_hash !== this.lastStateHash));
        if (sameSequenceChanged || sourceAdvance > transportAdvance) {
          this.protocolFault("atomic replay snapshot crossed its causal sequence boundary", generation, socket);
          return;
        }
      }
      try {
        this.options.onSnapshot?.(snapshot, generation);
      } catch (error) {
        this.protocolFault("replay snapshot projection failed", generation, socket, error);
        return;
      }
      this.dataEpoch = snapshot.data_epoch;
      this.lastSequence = snapshot.sequence;
      this.lastRevision = snapshot.revision;
      this.lastVirtualTimeMs = snapshot.cursor.virtual_time_ms;
      this.lastSourceSequence = snapshot.cursor.source_sequence;
      this.lastStateHash = snapshot.state_hash;
      this.hasAuthoritativeState = true;
      this.reconnectAttempt = 0;
      this.consecutiveProtocolFaults = 0;
      this.markTransportReady(generation, socket);
      return;
    }
    if (!this.hasAuthoritativeState || this.lastSequence === null) {
      this.protocolFault("incremental replay event arrived before an atomic snapshot", generation, socket);
      return;
    }
    const sequenceFrom = event.sequence_from ?? event.sequence;
    const sequenceTo = event.sequence_to ?? event.sequence;
    if (sequenceFrom !== this.lastSequence + 1 || sequenceTo !== event.sequence) {
      this.protocolFault(`replay sequence gap: expected range from ${this.lastSequence + 1}, got ${sequenceFrom}-${sequenceTo}`, generation, socket);
      return;
    }
    if (this.lastRevision !== null && event.revision < this.lastRevision) {
      this.protocolFault("replay revision moved backward", generation, socket);
      return;
    }
    if (this.lastVirtualTimeMs !== null && event.virtual_time_ms < this.lastVirtualTimeMs) {
      this.protocolFault("replay virtual time moved backward", generation, socket);
      return;
    }
    if (this.lastSourceSequence === null) {
      this.protocolFault("replay source cursor is unavailable", generation, socket);
      return;
    }
    try {
      assertReplayEventCausality(event, this.lastSourceSequence);
    } catch (error) {
      const message = error instanceof ReplayPayloadParseError ? error.message : "replay event violates causal sequence";
      this.protocolFault(message, generation, socket, error);
      return;
    }
    try {
      this.options.onEvent?.(event, generation);
    } catch (error) {
      this.protocolFault("replay event projection failed", generation, socket, error);
      return;
    }
    this.lastSequence = event.sequence;
    this.lastRevision = event.revision;
    this.lastVirtualTimeMs = event.virtual_time_ms;
    this.lastStateHash = event.state_hash;
    if (event.type === "replay.delta") {
      this.lastSourceSequence = (event.data as { readonly source_sequence: number }).source_sequence;
    }
    this.reconnectAttempt = 0;
    this.consecutiveProtocolFaults = 0;
    this.markTransportReady(generation, socket);
  }

  private protocolFault(message: string, generation: number, socket: ReplayStreamSocket, cause?: unknown): void {
    if (!this.isCurrent(generation, socket)) return;
    this.consecutiveProtocolFaults += 1;
    const fatal = this.consecutiveProtocolFaults >= this.maxConsecutiveProtocolFaults;
    const error = new ReplayStreamError("REPLAY_PROTOCOL_ERROR", message, { fatal, cause });
    if (fatal) {
      this.failFatal(error, generation);
      return;
    }
    this.options.onError?.(error, generation);
    this.beginResync();
  }

  private beginResync(): void {
    if (this.stopped) return;
    this.cancelReconnect();
    this.cancelHeartbeat();
    this.pendingReason = "resync";
    this.setState("resyncing", this.generation);
    const socket = this.socket;
    if (socket) {
      // Disable old-transport delivery immediately; the close handshake may
      // complete after additional MessageEvents have already been queued.
      socket.onmessage = null;
      try { socket.close(1012, "replay resync"); } catch { /* close callback will recover */ }
      this.timers.setTimeout(() => {
        if (!this.stopped && this.pendingReason === "resync" && this.socket === socket) {
          this.socket = null;
          this.pendingReason = null;
          this.scheduleConnect("resync");
        }
      }, 0);
    } else {
      this.pendingReason = null;
      this.scheduleConnect("resync");
    }
  }

  private failFatal(error: ReplayStreamError, generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.stopped = true;
    this.pendingReason = null;
    this.cancelReconnect();
    this.cancelHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(1008, error.code); } catch { /* already closed */ }
    }
    this.setState("error", generation);
    this.options.onError?.(error, generation);
  }

  private scheduleConnect(reason: ReplayStreamGenerationReason): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = reason === "resync"
      ? 0
      : this.backoffMs[Math.min(this.reconnectAttempt, this.backoffMs.length - 1)] ?? 8_000;
    if (reason === "reconnect") this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(reason);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleHeartbeat(generation: number, socket: ReplayStreamSocket): void {
    const clientInstanceId = this.options.clientInstanceId;
    if (clientInstanceId === undefined || this.heartbeatTimer !== null) return;
    const delayMs = this.options.heartbeatMs ?? 1_000;
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(generation, socket)) return;
      if (this.options.shouldHeartbeat?.() === true) {
        try {
          socket.send(JSON.stringify({
            type: "replay.heartbeat",
            protocol: "replay.v1",
            client_instance_id: clientInstanceId,
          }));
        } catch (error) {
          this.options.onError?.(new ReplayStreamError(
            "REPLAY_TRANSPORT_ERROR",
            "failed to send replay controller heartbeat",
            { fatal: false, cause: error },
          ), generation);
        }
      }
      this.scheduleHeartbeat(generation, socket);
    }, delayMs);
  }

  private markTransportReady(generation: number, socket: ReplayStreamSocket): void {
    if (!this.isCurrent(generation, socket) || this.pendingReason !== null) return;
    if (this.state !== "connected") this.setState("connected", generation);
    this.scheduleHeartbeat(generation, socket);
  }

  private cancelHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private isCurrent(generation: number, socket: ReplayStreamSocket): boolean {
    return !this.stopped && generation === this.generation && socket === this.socket;
  }

  private setState(state: ReplayStreamState, generation: number): void {
    this.state = state;
    this.options.onState?.(state, generation);
  }
}
