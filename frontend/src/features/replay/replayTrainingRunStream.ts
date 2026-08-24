import {
  parseReplayMarketTracksResponse,
  REPLAY_V2_PROTOCOL,
  type ReplayMarketTracksResponse,
} from "./replayV2Types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STREAM_SCHEMA_VERSION = "replay.training.market-tracks-stream.v1";
const STREAM_PROJECTION_MODE = "delta.v1";
const MAX_PATCH_OPERATIONS = 4_096;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type JsonRecord = Record<string, unknown>;
type PatchPath = readonly (string | number)[];

interface StreamState {
  readonly projection: ReplayMarketTracksResponse;
  readonly sequence: number;
}

class ReplayTrainingRunResyncError extends Error {}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new TypeError(`${path} fields are invalid`);
  }
}

function streamCounter(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function patchPath(value: unknown, path: string): PatchPath {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError(`${path} must be a bounded non-empty array`);
  }
  return value.map((segment, index) => {
    if (typeof segment === "number") {
      return streamCounter(segment, `${path}[${index}]`);
    }
    if (
      typeof segment !== "string"
      || segment.length < 1
      || segment.length > 128
      || FORBIDDEN_PATH_SEGMENTS.has(segment)
    ) {
      throw new TypeError(`${path}[${index}] is invalid`);
    }
    return segment;
  });
}

function own(container: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, key);
}

function updateAtPath(
  root: unknown,
  path: PatchPath,
  update: (current: unknown, parent: JsonRecord | readonly unknown[], key: string | number) => unknown,
): unknown {
  const [head, ...tail] = path;
  if (head === undefined) throw new TypeError("replay stream patch path is empty");
  if (Array.isArray(root)) {
    if (typeof head !== "number" || head >= root.length) {
      throw new TypeError("replay stream patch array path is unavailable");
    }
    const copy = root.slice();
    copy[head] = tail.length === 0
      ? update(root[head], root, head)
      : updateAtPath(root[head], tail, update);
    return copy;
  }
  const container = record(root, "replay stream patch parent");
  if (typeof head !== "string" || (tail.length > 0 && !own(container, head))) {
    throw new TypeError("replay stream patch object path is unavailable");
  }
  const copy: JsonRecord = { ...container };
  copy[head] = tail.length === 0
    ? update(container[head], container, head)
    : updateAtPath(container[head], tail, update);
  return copy;
}

function removeAtPath(root: unknown, path: PatchPath): unknown {
  const [head, ...tail] = path;
  if (head === undefined) throw new TypeError("replay stream remove path is empty");
  if (Array.isArray(root)) {
    if (typeof head !== "number" || head >= root.length) {
      throw new TypeError("replay stream remove array path is unavailable");
    }
    const copy = root.slice();
    if (tail.length === 0) copy.splice(head, 1);
    else copy[head] = removeAtPath(root[head], tail);
    return copy;
  }
  const container = record(root, "replay stream remove parent");
  if (typeof head !== "string" || !own(container, head)) {
    throw new TypeError("replay stream remove object path is unavailable");
  }
  const copy: JsonRecord = { ...container };
  if (tail.length === 0) delete copy[head];
  else copy[head] = removeAtPath(container[head], tail);
  return copy;
}

function applyPatch(projection: ReplayMarketTracksResponse, operations: unknown): ReplayMarketTracksResponse {
  if (
    !Array.isArray(operations)
    || operations.length === 0
    || operations.length > MAX_PATCH_OPERATIONS
  ) {
    throw new ReplayTrainingRunResyncError("replay training delta operation count is invalid");
  }
  let next: unknown = projection;
  try {
    operations.forEach((rawOperation, index) => {
      const operation = record(rawOperation, `replay stream operations[${index}]`);
      const op = operation.op;
      if (op === "SET") {
        exactKeys(operation, ["op", "path", "value"], `replay stream operations[${index}]`);
        const path = patchPath(operation.path, `replay stream operations[${index}].path`);
        next = updateAtPath(next, path, () => operation.value);
      } else if (op === "REMOVE") {
        exactKeys(operation, ["op", "path"], `replay stream operations[${index}]`);
        next = removeAtPath(
          next,
          patchPath(operation.path, `replay stream operations[${index}].path`),
        );
      } else if (op === "APPEND") {
        exactKeys(operation, ["op", "path", "items"], `replay stream operations[${index}]`);
        if (!Array.isArray(operation.items) || operation.items.length === 0) {
          throw new TypeError(`replay stream operations[${index}].items must be non-empty`);
        }
        const path = patchPath(operation.path, `replay stream operations[${index}].path`);
        next = updateAtPath(next, path, (current) => {
          if (!Array.isArray(current)) {
            throw new TypeError(`replay stream operations[${index}] append target is not an array`);
          }
          const target = current as unknown[];
          const items = operation.items as unknown[];
          return target.concat(items);
        });
      } else {
        throw new TypeError(`replay stream operations[${index}].op is unsupported`);
      }
    });
    return parseReplayMarketTracksResponse(next);
  } catch (cause) {
    if (cause instanceof ReplayTrainingRunResyncError) throw cause;
    throw new ReplayTrainingRunResyncError(
      cause instanceof Error ? cause.message : "replay training delta is invalid",
    );
  }
}

export function applyReplayTrainingRunStreamMessage(
  value: unknown,
  previous: StreamState | null,
): StreamState {
  const message = record(value, "replay training stream message");
  if (message.schema_version === undefined) {
    return { projection: parseReplayMarketTracksResponse(message), sequence: 0 };
  }
  if (message.schema_version !== STREAM_SCHEMA_VERSION || message.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError("replay training stream contract is unsupported");
  }
  if (message.type === "SNAPSHOT") {
    exactKeys(message, [
      "protocol", "schema_version", "type", "run_id", "sequence", "projection",
    ], "replay training snapshot");
    const projection = parseReplayMarketTracksResponse(message.projection);
    if (message.run_id !== projection.run_id) {
      throw new TypeError("replay training snapshot changed run identity");
    }
    return {
      projection,
      sequence: streamCounter(message.sequence, "replay training snapshot.sequence"),
    };
  }
  if (message.type !== "DELTA") {
    throw new TypeError("replay training stream message type is unsupported");
  }
  exactKeys(message, [
    "protocol", "schema_version", "type", "run_id", "base_sequence", "sequence", "operations",
  ], "replay training delta");
  const baseSequence = streamCounter(message.base_sequence, "replay training delta.base_sequence");
  const sequence = streamCounter(message.sequence, "replay training delta.sequence");
  if (
    previous === null
    || message.run_id !== previous.projection.run_id
    || baseSequence !== previous.sequence
    || sequence !== baseSequence + 1
  ) {
    throw new ReplayTrainingRunResyncError("replay training delta sequence has a gap");
  }
  return {
    projection: applyPatch(previous.projection, message.operations),
    sequence,
  };
}

export interface ReplayTrainingRunStreamSocket {
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  close(code?: number, reason?: string): void;
}

export interface ReplayTrainingRunStreamOptions {
  readonly runId: string;
  readonly onProjection: (projection: ReplayMarketTracksResponse) => void;
  readonly onError?: (error: Error, fatal: boolean) => void;
  readonly baseUrl?: string;
  readonly location?: Pick<Location, "protocol" | "host">;
  readonly socketFactory?: (url: string) => ReplayTrainingRunStreamSocket;
  readonly backoffMs?: readonly number[];
}

export function buildReplayTrainingRunStreamUrl({
  runId,
  baseUrl,
  location = globalThis.location,
}: {
  readonly runId: string;
  readonly baseUrl?: string;
  readonly location?: Pick<Location, "protocol" | "host">;
}): string {
  if (!SAFE_ID.test(runId)) throw new Error("invalid replay training run id");
  const origin = baseUrl?.replace(/\/$/, "") ?? (() => {
    if (!location?.host) throw new Error("browser location is unavailable");
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  })();
  const params = new URLSearchParams({ protocol: REPLAY_V2_PROTOCOL });
  params.set("projection", STREAM_PROJECTION_MODE);
  return `${origin}/api/v1/stream/replay/runs/${encodeURIComponent(runId)}?${params.toString()}`;
}

function defaultSocketFactory(url: string): ReplayTrainingRunStreamSocket {
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket API is unavailable");
  }
  return new WebSocket(url);
}

export class ReplayTrainingRunStream {
  private readonly options: ReplayTrainingRunStreamOptions;
  private readonly socketFactory: (url: string) => ReplayTrainingRunStreamSocket;
  private readonly backoffMs: readonly number[];
  private socket: ReplayTrainingRunStreamSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private stopped = true;
  private streamState: StreamState | null = null;

  constructor(options: ReplayTrainingRunStreamOptions) {
    if (!SAFE_ID.test(options.runId)) throw new Error("invalid replay training run id");
    this.options = options;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.backoffMs = options.backoffMs !== undefined && options.backoffMs.length > 0
      ? options.backoffMs
      : [250, 500, 1_000, 2_000, 4_000, 8_000];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.streamState = null;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(1000, "replay training runtime stopped"); } catch { /* closed */ }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = this.generation + 1;
    this.generation = generation;
    this.streamState = null;
    let socket: ReplayTrainingRunStreamSocket;
    try {
      socket = this.socketFactory(buildReplayTrainingRunStreamUrl({
        runId: this.options.runId,
        ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
        ...(this.options.location === undefined ? {} : { location: this.options.location }),
      }));
    } catch (cause) {
      this.options.onError?.(
        cause instanceof Error ? cause : new Error("failed to create replay training stream"),
        true,
      );
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.reconnectAttempt = 0;
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      try {
        const state = applyReplayTrainingRunStreamMessage(
          JSON.parse(event.data),
          this.streamState,
        );
        const projection = state.projection;
        if (projection.run_id !== this.options.runId) {
          throw new TypeError("replay training stream changed run identity");
        }
        this.streamState = state;
        this.options.onProjection(projection);
      } catch (cause) {
        if (cause instanceof ReplayTrainingRunResyncError) {
          this.requestResync(socket, cause);
          return;
        }
        this.options.onError?.(
          cause instanceof Error ? cause : new Error("invalid replay training projection"),
          true,
        );
        this.stop();
      }
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.options.onError?.(new Error("replay training stream transport error"), false);
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      if (this.stopped) return;
      if (event.code === 1008) {
        this.options.onError?.(new Error("replay training stream was rejected"), true);
        this.stop();
        return;
      }
      const delay = this.backoffMs[
        Math.min(this.reconnectAttempt, this.backoffMs.length - 1)
      ] ?? 8_000;
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }

  private requestResync(socket: ReplayTrainingRunStreamSocket, cause: Error): void {
    this.options.onError?.(cause, false);
    this.streamState = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.socket = null;
    try { socket.close(1012, "replay training projection resync"); } catch { /* closed */ }
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.backoffMs[0] ?? 250;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private isCurrent(
    socket: ReplayTrainingRunStreamSocket,
    generation: number,
  ): boolean {
    return !this.stopped && this.socket === socket && this.generation === generation;
  }
}
