import { API_BASE } from "../../services/apiConfig.js";
import {
  parseReplayCapabilities,
  parseReplayCatalog,
  parseReplayCommandResult,
  parseReplayErrorEnvelope,
  parseReplaySessionResponse,
  ReplayPayloadParseError,
} from "./replayParser.js";
import type {
  ReplayCapabilities,
  ReplayCatalog,
  ReplayCommandEnvelope,
  ReplayCommandResult,
  ReplayErrorCode,
  ReplaySessionResponse,
} from "./replayTypes.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReplayApiErrorCode = ReplayErrorCode | "REPLAY_TRANSPORT_ERROR" | "REPLAY_PROTOCOL_ERROR";

export class ReplayApiError extends Error {
  readonly code: ReplayApiErrorCode;
  readonly status: number | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReplayApiErrorCode,
    message: string,
    { status = null, details = {}, cause }: {
      status?: number | null;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReplayApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ReplayCatalogQuery {
  warmupBars?: number;
  horizonMs?: number;
  qualityMode?: "exact" | "best_effort";
  blindMode?: boolean;
  sourceKind?: "BAR" | "AGG_TRADE";
}

export interface ReplayApiClientOptions {
  basePath?: string;
  fetcher?: typeof fetch;
}

type PayloadParser<T> = (value: unknown) => T;

function sessionSegment(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new ReplayApiError("REPLAY_PROTOCOL_ERROR", "invalid replay session id");
  }
  return encodeURIComponent(sessionId);
}

export class ReplayApiClient {
  private readonly basePath: string;
  private readonly fetcher: typeof fetch;

  constructor({ basePath = `${API_BASE}/replay`, fetcher = globalThis.fetch }: ReplayApiClientOptions = {}) {
    if (typeof fetcher !== "function") {
      throw new ReplayApiError("REPLAY_TRANSPORT_ERROR", "Fetch API is unavailable");
    }
    this.basePath = basePath.replace(/\/$/, "");
    this.fetcher = fetcher;
  }

  capabilities(signal?: AbortSignal): Promise<ReplayCapabilities> {
    return this.request("/capabilities", parseReplayCapabilities, signal ? { signal } : {});
  }

  catalog(query: ReplayCatalogQuery = {}, signal?: AbortSignal): Promise<ReplayCatalog> {
    const params = new URLSearchParams();
    if (query.warmupBars !== undefined) params.set("warmup_bars", String(query.warmupBars));
    if (query.horizonMs !== undefined) params.set("horizon_ms", String(query.horizonMs));
    if (query.qualityMode !== undefined) params.set("quality_mode", query.qualityMode);
    if (query.blindMode !== undefined) params.set("blind_mode", String(query.blindMode));
    if (query.sourceKind !== undefined) params.set("source_kind", query.sourceKind);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request(`/catalog${suffix}`, parseReplayCatalog, signal ? { signal } : {});
  }

  getSession(sessionId: string, signal?: AbortSignal): Promise<ReplaySessionResponse> {
    return this.request(`/runs/session/${sessionSegment(sessionId)}`, parseReplaySessionResponse, signal ? { signal } : {});
  }

  command(sessionId: string, command: ReplayCommandEnvelope, signal?: AbortSignal): Promise<ReplayCommandResult> {
    return this.request(`/runs/session/${sessionSegment(sessionId)}/commands`, parseReplayCommandResult, {
      method: "POST",
      body: JSON.stringify(command),
      ...(signal ? { signal } : {}),
    });
  }

  private async request<T>(
    path: string,
    parser: PayloadParser<T>,
    options: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      // Native `window.fetch` is a Web IDL method and rejects an arbitrary
      // receiver. Read it into a local before calling so the client never
      // invokes it as `ReplayApiClient.prototype.fetcher(...)`.
      const fetcher = this.fetcher;
      response = await fetcher(`${this.basePath}${path}`, {
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...options.headers },
        ...options,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ReplayApiError("REPLAY_TRANSPORT_ERROR", "replay request failed", { cause: error });
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ReplayApiError("REPLAY_PROTOCOL_ERROR", "replay response is not valid JSON", {
        status: response.status,
        cause: error,
      });
    }

    if (!response.ok) {
      try {
        const parsed = parseReplayErrorEnvelope(payload);
        throw new ReplayApiError(parsed.error.code, parsed.error.message, {
          status: response.status,
          details: parsed.error.details,
        });
      } catch (error) {
        if (error instanceof ReplayApiError) throw error;
        throw new ReplayApiError("REPLAY_PROTOCOL_ERROR", "replay error response violates replay.v1", {
          status: response.status,
          cause: error,
        });
      }
    }

    try {
      return parser(payload);
    } catch (error) {
      const message = error instanceof ReplayPayloadParseError
        ? error.message
        : "replay response violates replay.v1";
      throw new ReplayApiError("REPLAY_PROTOCOL_ERROR", message, {
        status: response.status,
        cause: error,
      });
    }
  }
}

export const defaultReplayApi = new ReplayApiClient();
