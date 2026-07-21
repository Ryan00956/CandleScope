import { ReplayApiClient } from "./replayApi.js";
import type { ReplayApiClientOptions, ReplayCatalogQuery } from "./replayApi.js";
import type { ReplayCapabilities, ReplayCatalog } from "./replayTypes.js";
import {
  parseTrainingRunListResponse,
  parseTrainingRunMutationResponse,
  parseTrainingRunReturnResponse,
} from "./replayV2Types.js";
import type {
  TrainingRunCreatePayload,
  TrainingRunListResponse,
  TrainingRunMutationResponse,
  TrainingRunReturnResponse,
} from "./replayV2Types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TrainingRunListQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly state?: string;
  readonly sourceKind?: string;
  readonly compatibility?: string;
}

export class ReplayV2ApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    {
      status = null,
      details = {},
      cause,
    }: {
      status?: number | null;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReplayV2ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function safeSegment(value: string, fieldName: string): string {
  if (!SAFE_ID.test(value)) {
    throw new ReplayV2ApiError("REPLAY_V2_PROTOCOL_ERROR", `${fieldName} is invalid`);
  }
  return encodeURIComponent(value);
}

function parseErrorEnvelope(value: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("replay.v2 error must be an object");
  }
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "error,protocol" || envelope.protocol !== "replay.v2") {
    throw new TypeError("replay.v2 error envelope is invalid");
  }
  if (envelope.error === null || typeof envelope.error !== "object" || Array.isArray(envelope.error)) {
    throw new TypeError("replay.v2 error body is invalid");
  }
  const error = envelope.error as Record<string, unknown>;
  if (Object.keys(error).sort().join(",") !== "code,details,message") {
    throw new TypeError("replay.v2 error fields are invalid");
  }
  if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(error.code)) {
    throw new TypeError("replay.v2 error code is invalid");
  }
  if (typeof error.message !== "string" || error.message.length < 1 || error.message.length > 1024) {
    throw new TypeError("replay.v2 error message is invalid");
  }
  if (error.details === null || typeof error.details !== "object" || Array.isArray(error.details)) {
    throw new TypeError("replay.v2 error details are invalid");
  }
  return {
    code: error.code,
    message: error.message,
    details: error.details as Readonly<Record<string, unknown>>,
  };
}

type Parser<T> = (value: unknown) => T;

export class ReplayV2ApiClient {
  private readonly basePath: string;
  private readonly fetcher: typeof fetch;
  private readonly replayV1: ReplayApiClient;

  constructor({
    basePath = "/api/v1/replay",
    fetcher = globalThis.fetch,
  }: ReplayApiClientOptions = {}) {
    if (typeof fetcher !== "function") {
      throw new ReplayV2ApiError("REPLAY_V2_TRANSPORT_ERROR", "Fetch API is unavailable");
    }
    this.basePath = basePath.replace(/\/$/, "");
    this.fetcher = fetcher;
    this.replayV1 = new ReplayApiClient({ basePath: this.basePath, fetcher });
  }

  capabilities(signal?: AbortSignal): Promise<ReplayCapabilities> {
    return this.replayV1.capabilities(signal);
  }

  catalog(query: ReplayCatalogQuery = {}, signal?: AbortSignal): Promise<ReplayCatalog> {
    return this.replayV1.catalog(query, signal);
  }

  listRuns(query: TrainingRunListQuery = {}, signal?: AbortSignal): Promise<TrainingRunListResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.state !== undefined) params.set("state", query.state);
    if (query.sourceKind !== undefined) params.set("source_kind", query.sourceKind);
    if (query.compatibility !== undefined) params.set("compatibility", query.compatibility);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/runs${suffix}`, parseTrainingRunListResponse, signal ? { signal } : {});
  }

  createRun(
    payload: TrainingRunCreatePayload,
    signal?: AbortSignal,
  ): Promise<TrainingRunMutationResponse> {
    return this.request("/runs", parseTrainingRunMutationResponse, {
      method: "POST",
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  }

  getRun(runId: string, signal?: AbortSignal): Promise<TrainingRunCardResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}`,
      (value) => ({ run: parseTrainingRunMutationResponse({
        protocol: "replay.v2",
        created: false,
        migrated: false,
        run: value,
      }).run }),
      signal ? { signal } : {},
    );
  }

  migrateLegacy(
    sessionId: string,
    name: string | null = null,
    signal?: AbortSignal,
  ): Promise<TrainingRunMutationResponse> {
    return this.request(
      `/runs/${safeSegment(sessionId, "legacy session id")}/migrate`,
      parseTrainingRunMutationResponse,
      {
        method: "POST",
        body: JSON.stringify({ protocol: "replay.v2", name }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  returnToHub(sessionId: string, signal?: AbortSignal): Promise<TrainingRunReturnResponse> {
    return this.request(
      `/runs/session/${safeSegment(sessionId, "session id")}/return-to-hub`,
      parseTrainingRunReturnResponse,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
  }

  private async request<T>(path: string, parser: Parser<T>, options: RequestInit): Promise<T> {
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(`${this.basePath}${path}`, {
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...options.headers },
        ...options,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ReplayV2ApiError("REPLAY_V2_TRANSPORT_ERROR", "replay.v2 request failed", { cause: error });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch (error) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "replay.v2 response is not valid JSON",
        { status: response.status, cause: error },
      );
    }
    if (!response.ok) {
      try {
        const parsed = parseErrorEnvelope(payload);
        throw new ReplayV2ApiError(parsed.code, parsed.message, {
          status: response.status,
          details: parsed.details,
        });
      } catch (error) {
        if (error instanceof ReplayV2ApiError) throw error;
        throw new ReplayV2ApiError(
          "REPLAY_V2_PROTOCOL_ERROR",
          "replay.v2 error response violates the contract",
          { status: response.status, cause: error },
        );
      }
    }
    try {
      return parser(payload);
    } catch (error) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "replay.v2 response violates the contract",
        { status: response.status, cause: error },
      );
    }
  }
}

export interface TrainingRunCardResponse {
  readonly run: TrainingRunMutationResponse["run"];
}

export const defaultReplayV2Api = new ReplayV2ApiClient();
