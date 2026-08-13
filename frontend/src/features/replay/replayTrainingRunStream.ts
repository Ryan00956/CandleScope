import {
  parseReplayMarketTracksResponse,
  REPLAY_V2_PROTOCOL,
  type ReplayMarketTracksResponse,
} from "./replayV2Types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
        const projection = parseReplayMarketTracksResponse(JSON.parse(event.data));
        if (projection.run_id !== this.options.runId) {
          throw new TypeError("replay training stream changed run identity");
        }
        this.options.onProjection(projection);
      } catch (cause) {
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

  private isCurrent(
    socket: ReplayTrainingRunStreamSocket,
    generation: number,
  ): boolean {
    return !this.stopped && this.socket === socket && this.generation === generation;
  }
}
