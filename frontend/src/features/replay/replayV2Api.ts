import { ReplayApiClient } from "./replayApi.js";
import type { ReplayApiClientOptions, ReplayCatalogQuery } from "./replayApi.js";
import type { ReplayCapabilities, ReplayCatalog } from "./replayTypes.js";
import { parseReplayCatalog } from "./replayParser.js";
import {
  parseReplayTradeFlowPage,
  type ReplayTradeFlowPage,
} from "./replayTradeFlow.js";
import {
  parseReplaySegmentPreparePlan,
  type ReplaySegmentPreparePlan,
} from "./replaySegmentTypes.js";
import {
  parseReplayStorageGcPlan,
  parseReplayStorageGcRunResult,
  parseReplayStorageInventory,
  parseReplayStorageRehydrateAck,
  type ReplayStorageGcPlan,
  type ReplayStorageGcProtocol,
  type ReplayStorageGcRunResult,
  type ReplayStorageInventory,
} from "./replayStorageModel.js";
import {
  parseReplayPeriodSummaryPrepare,
  parseReplayPeriodSummaryStatus,
  type ReplayPeriodSummaryPrepareResponse,
  type ReplayPeriodSummaryStatusResponse,
} from "./replayPeriodSummary.js";
import {
  parseReplayDisplayProjection,
  type ReplayDisplayProjectionResponse,
} from "./replayDisplayProjection.js";
import {
  parseTrainingRunListResponse,
  parseTrainingRunMarketSelectionResponse,
  parseTrainingRunMutationResponse,
  parseTrainingRunDeleteResponse,
  parseTrainingRunReturnResponse,
  parseReplayAccountRecordPage,
  parseReplayAccountAuditResponse,
  parseReplayAdvanceProgressResponse,
  parseReplayMarketTracksResponse,
  parseReplayOrderCapacity,
  parseReplayOrderPreview,
  parseReplayTrainingResultsResponse,
  parseReplayV2CommandResult,
  parseReplayViewerStateResponse,
} from "./replayV2Types.js";
import {
  parseReplayCurrentDrawingDocumentResponse,
  parseReplayDrawingDocumentResponse,
  parseReplayEquityResponse,
  parseReplayIntegrityResponse,
  parseReplayPublicTimeBatchResponse,
  parseReplayReviewControlResponse,
  parseReplayReviewForkResponse,
  parseReplayReviewMarkerResponse,
  parseReplayReviewResponse,
  parseReplayRunRulesResponse,
  parseReplayTrainingReportResponse,
} from "./replayIntegrityModel.js";
import type {
  ReplayCurrentDrawingDocumentResponse,
  ReplayDrawingDocumentResponse,
  ReplayEquityResponse,
  ReplayIntegrityResponse,
  ReplayPublicTimeBatchResponse,
  ReplayReviewControlResponse,
  ReplayReviewForkResponse,
  ReplayReviewMarkerResponse,
  ReplayReviewResponse,
  ReplayRunRulesResponse,
  ReplayTrainingReportResponse,
} from "./replayIntegrityModel.js";
import type {
  ReplayAdvanceProgressResponse,
  ReplayAccountOrderScope,
  ReplayAccountRecordPage,
  ReplayAccountRecordType,
  ReplayAccountAuditResponse,
  ReplayMarketTracksResponse,
  ReplayOrderCapacity,
  ReplayOrderCapacityRequest,
  ReplayOrderPreview,
  ReplayOrderPreviewRequest,
  ReplayTrainingResultsResponse,
  ReplayV2Command,
  ReplayV2CommandResult,
  ReplayViewerStateResponse,
  TrainingRunCreatePayload,
  TrainingRunMarketSelectionPayload,
  TrainingRunMarketSelectionResponse,
  TrainingRunPreparationPayload,
  TrainingRunDeleteResponse,
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

function safeIdentifier(value: string, fieldName: string): string {
  if (!SAFE_ID.test(value)) {
    throw new ReplayV2ApiError("REPLAY_V2_PROTOCOL_ERROR", `${fieldName} is invalid`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number,
  fieldName: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ReplayV2ApiError(
      "REPLAY_V2_PROTOCOL_ERROR",
      `${fieldName} is invalid`,
    );
  }
  return value;
}

function storageBoundary(protocol: ReplayStorageGcProtocol): {
  readonly path: string;
  readonly maxField: "max_segments" | "max_archives";
} {
  if (protocol === "replay.data.gc.v1") {
    return {
      path: "/runs/data-segments",
      maxField: "max_segments",
    };
  }
  if (protocol === "replay.historical-book.gc.v1") {
    return {
      path: "/runs/historical-books",
      maxField: "max_archives",
    };
  }
  if (protocol === "replay.account-history.gc.v1") {
    return {
      path: "/runs/account-history",
      maxField: "max_archives",
    };
  }
  throw new ReplayV2ApiError(
    "REPLAY_V2_PROTOCOL_ERROR",
    "storage GC protocol is invalid",
  );
}

function parseErrorEnvelope(value: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("replay.v3 error must be an object");
  }
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "error,protocol" || envelope.protocol !== "replay.v3") {
    throw new TypeError("replay.v3 error envelope is invalid");
  }
  if (envelope.error === null || typeof envelope.error !== "object" || Array.isArray(envelope.error)) {
    throw new TypeError("replay.v3 error body is invalid");
  }
  const error = envelope.error as Record<string, unknown>;
  if (Object.keys(error).sort().join(",") !== "code,details,message") {
    throw new TypeError("replay.v3 error fields are invalid");
  }
  if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(error.code)) {
    throw new TypeError("replay.v3 error code is invalid");
  }
  if (typeof error.message !== "string" || error.message.length < 1 || error.message.length > 1024) {
    throw new TypeError("replay.v3 error message is invalid");
  }
  if (error.details === null || typeof error.details !== "object" || Array.isArray(error.details)) {
    throw new TypeError("replay.v3 error details are invalid");
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
  private readonly adapterApi: ReplayApiClient;

  constructor({
    basePath = "/api/v1/replay",
    fetcher = globalThis.fetch,
  }: ReplayApiClientOptions = {}) {
    if (typeof fetcher !== "function") {
      throw new ReplayV2ApiError("REPLAY_V2_TRANSPORT_ERROR", "Fetch API is unavailable");
    }
    this.basePath = basePath.replace(/\/$/, "");
    this.fetcher = fetcher;
    this.adapterApi = new ReplayApiClient({ basePath: this.basePath, fetcher });
  }

  capabilities(signal?: AbortSignal): Promise<ReplayCapabilities> {
    return this.adapterApi.capabilities(signal);
  }

  catalog(query: ReplayCatalogQuery = {}, signal?: AbortSignal): Promise<ReplayCatalog> {
    return this.adapterApi.catalog(query, signal);
  }

  marketCatalog(runId: string, signal?: AbortSignal): Promise<ReplayCatalog> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/market-catalog`,
      parseReplayCatalog,
      signal ? { signal } : {},
    );
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

  selectInitialMarket(
    runId: string,
    payload: TrainingRunMarketSelectionPayload,
    signal?: AbortSignal,
  ): Promise<TrainingRunMarketSelectionResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/markets`,
      parseTrainingRunMarketSelectionResponse,
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
  }

  planInitialMarket(
    runId: string,
    payload: TrainingRunMarketSelectionPayload,
    signal?: AbortSignal,
  ): Promise<ReplaySegmentPreparePlan> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/markets/plan`,
      parseReplaySegmentPreparePlan,
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
  }

  deleteRun(runId: string, signal?: AbortSignal): Promise<TrainingRunDeleteResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}`,
      parseTrainingRunDeleteResponse,
      { method: "DELETE", ...(signal ? { signal } : {}) },
    );
  }

  segmentPlan(
    payload: TrainingRunPreparationPayload,
    signal?: AbortSignal,
  ): Promise<ReplaySegmentPreparePlan> {
    return this.request("/runs/data-segments/plan", parseReplaySegmentPreparePlan, {
      method: "POST",
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  }

  storageInventory(signal?: AbortSignal): Promise<ReplayStorageInventory> {
    return this.request(
      "/runs/storage",
      parseReplayStorageInventory,
      signal ? { signal } : {},
    );
  }

  storageGcPlan(
    protocol: ReplayStorageGcProtocol,
    {
      targetReclaimBytes,
      maxObjects,
    }: {
      readonly targetReclaimBytes: number;
      readonly maxObjects: number;
    },
    signal?: AbortSignal,
  ): Promise<ReplayStorageGcPlan> {
    const boundary = storageBoundary(protocol);
    return this.request(
      `${boundary.path}/gc/dry-run`,
      parseReplayStorageGcPlan,
      {
        method: "POST",
        body: JSON.stringify({
          protocol,
          target_reclaim_bytes: boundedPositiveInteger(
            targetReclaimBytes,
            "target reclaim bytes",
            1_000_000_000_000,
          ),
          [boundary.maxField]: boundedPositiveInteger(
            maxObjects,
            "maximum GC objects",
            10_000,
          ),
        }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  storageGcRun(
    plan: ReplayStorageGcPlan,
    signal?: AbortSignal,
  ): Promise<ReplayStorageGcRunResult> {
    const boundary = storageBoundary(plan.protocol);
    return this.request(
      `${boundary.path}/gc/run`,
      parseReplayStorageGcRunResult,
      {
        method: "POST",
        body: JSON.stringify({
          protocol: plan.protocol,
          target_reclaim_bytes: plan.request.target_reclaim_bytes,
          [boundary.maxField]: plan.request.max_objects,
          plan_hash: plan.plan_hash,
          confirm: true,
        }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  storageRehydrate(
    protocol: ReplayStorageGcProtocol,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly object_id: string; readonly health: "READY" }> {
    const boundary = storageBoundary(protocol);
    return this.request(
      `${boundary.path}/${safeSegment(objectId, "storage object id")}/rehydrate`,
      parseReplayStorageRehydrateAck,
      {
        method: "POST",
        body: "{}",
        ...(signal ? { signal } : {}),
      },
    );
  }

  getRun(runId: string, signal?: AbortSignal): Promise<TrainingRunCardResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}`,
      (value) => ({ run: parseTrainingRunMutationResponse({
        protocol: "replay.v3",
        created: false,
        run: value,
      }).run }),
      signal ? { signal } : {},
    );
  }

  returnToHub(runId: string, signal?: AbortSignal): Promise<TrainingRunReturnResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/return-to-hub`,
      parseTrainingRunReturnResponse,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
  }

  viewerBySession(sessionId: string, signal?: AbortSignal): Promise<ReplayViewerStateResponse> {
    return this.request(
      `/runs/session/${safeSegment(sessionId, "session id")}/viewer`,
      parseReplayViewerStateResponse,
      signal ? { signal } : {},
    );
  }

  displayProjectionBySession(
    sessionId: string,
    {
      trackId,
      displayInterval,
      revealedBoundaryMs,
      dataEpoch,
      limit = 1_000,
    }: {
      readonly trackId: string;
      readonly displayInterval: string;
      readonly revealedBoundaryMs: number;
      readonly dataEpoch: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<ReplayDisplayProjectionResponse> {
    if (!Number.isSafeInteger(revealedBoundaryMs) || revealedBoundaryMs < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000
      || !/^sha256:[0-9a-f]{64}$/.test(dataEpoch)) {
      return Promise.reject(new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "display projection request is invalid",
      ));
    }
    const params = new URLSearchParams({
      track_id: safeIdentifier(trackId, "track id"),
      display_interval: safeIdentifier(displayInterval, "display interval"),
      revealed_boundary_ms: String(revealedBoundaryMs),
      data_epoch: dataEpoch,
      limit: String(limit),
    });
    return this.request(
      `/runs/session/${safeSegment(sessionId, "session id")}/display-projection?${params}`,
      parseReplayDisplayProjection,
      signal ? { signal } : {},
    );
  }

  tracksBySession(sessionId: string, signal?: AbortSignal): Promise<ReplayMarketTracksResponse> {
    return this.request(
      `/runs/session/${safeSegment(sessionId, "session id")}/tracks`,
      parseReplayMarketTracksResponse,
      signal ? { signal } : {},
    );
  }

  tracksRun(runId: string, signal?: AbortSignal): Promise<ReplayMarketTracksResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/tracks`,
      parseReplayMarketTracksResponse,
      signal ? { signal } : {},
    );
  }

  auditAccount(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReplayAccountAuditResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/account-audit`,
      parseReplayAccountAuditResponse,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
  }

  async resyncHistoricalBook(runId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      `/runs/${safeSegment(runId, "run id")}/historical-book/resync`,
      (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("historical book resync response must be an object");
        }
        const response = value as Record<string, unknown>;
        if (Object.keys(response).sort().join(",")
          !== "fallback_applied,protocol,resynced_track_count,run_id,tracks"
          || response.protocol !== "replay.historical-book.resync.v1"
          || response.run_id !== runId
          || !Number.isSafeInteger(response.resynced_track_count)
          || (response.resynced_track_count as number) < 1
          || response.fallback_applied !== false
          || !Array.isArray(response.tracks)) {
          throw new TypeError("historical book resync response is incompatible");
        }
        return undefined;
      },
      { method: "POST", ...(signal ? { signal } : {}) },
    );
  }

  tradeFlowRun(
    runId: string,
    query: {
      readonly trackId?: string;
      readonly afterSequence?: number;
      readonly limit?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ReplayTradeFlowPage> {
    const params = new URLSearchParams();
    if (query.trackId !== undefined) {
      params.set("track_id", safeIdentifier(query.trackId, "track id"));
    }
    if (query.afterSequence !== undefined) {
      if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
        throw new ReplayV2ApiError("REPLAY_V2_PROTOCOL_ERROR", "after sequence is invalid");
      }
      params.set("after_sequence", String(query.afterSequence));
    }
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1_000) {
        throw new ReplayV2ApiError("REPLAY_V2_PROTOCOL_ERROR", "trade-flow limit is invalid");
      }
      params.set("limit", String(query.limit));
    }
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/trade-flow${suffix}`,
      parseReplayTradeFlowPage,
      signal ? { signal } : {},
    );
  }

  accountRecordsRun(
    runId: string,
    query: {
      readonly recordType: ReplayAccountRecordType;
      readonly orderScope?: ReplayAccountOrderScope;
      readonly trackId?: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<ReplayAccountRecordPage> {
    const params = new URLSearchParams({ record_type: query.recordType });
    if (query.orderScope !== undefined) {
      params.set("order_scope", query.orderScope);
    }
    if (query.trackId !== undefined) {
      params.set("track_id", safeIdentifier(query.trackId, "track id"));
    }
    if (query.cursor !== undefined) {
      if (
        query.cursor.length < 1
        || query.cursor.length > 2_048
        || !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      ) {
        throw new ReplayV2ApiError(
          "REPLAY_V2_PROTOCOL_ERROR",
          "account record cursor is invalid",
        );
      }
      params.set("cursor", query.cursor);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(boundedPositiveInteger(
        query.limit,
        "account record limit",
        200,
      )));
    }
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/account-records?${params.toString()}`,
      parseReplayAccountRecordPage,
      signal ? { signal } : {},
    );
  }

  async commandRun(
    runId: string,
    command: ReplayV2Command,
    signal?: AbortSignal,
  ): Promise<ReplayV2CommandResult> {
    if (command.run_id !== runId) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "replay.v3 command run_id does not match the route",
        {
          details: {
            command_run_id: command.run_id,
            route_run_id: runId,
          },
        },
      );
    }
    const result = await this.request(
      `/runs/${safeSegment(runId, "run id")}/commands`,
      parseReplayV2CommandResult,
      {
        method: "POST",
        body: JSON.stringify(command),
        ...(signal ? { signal } : {}),
      },
    );
    if (
      result.run_id !== runId
      || result.command_id !== command.command_id
    ) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_RESPONSE_IDENTITY_MISMATCH",
        "replay.v3 command response identity does not match the request",
        {
          details: {
            request_command_id: command.command_id,
            request_run_id: runId,
            response_command_id: result.command_id,
            response_run_id: result.run_id,
          },
        },
      );
    }
    return result;
  }

  previewOrder(
    runId: string,
    payload: ReplayOrderPreviewRequest,
    signal?: AbortSignal,
  ): Promise<ReplayOrderPreview> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/order-preview`,
      parseReplayOrderPreview,
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
  }

  orderCapacity(
    runId: string,
    payload: ReplayOrderCapacityRequest,
    signal?: AbortSignal,
  ): Promise<ReplayOrderCapacity> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/order-capacity`,
      parseReplayOrderCapacity,
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
  }

  trainingResultsRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReplayTrainingResultsResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/training-results?limit=2000`,
      parseReplayTrainingResultsResponse,
      signal ? { signal } : {},
    );
  }

  advanceProgress(
    runId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<ReplayAdvanceProgressResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/advances/${safeSegment(commandId, "command id")}`,
      parseReplayAdvanceProgressResponse,
      signal ? { signal } : {},
    );
  }

  periodSummaryStatusRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReplayPeriodSummaryStatusResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/fast-forward-summaries`,
      parseReplayPeriodSummaryStatus,
      signal ? { signal } : {},
    );
  }

  preparePeriodSummariesRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReplayPeriodSummaryPrepareResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/fast-forward-summaries/prepare`,
      parseReplayPeriodSummaryPrepare,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
  }

  integrityRun(runId: string, signal?: AbortSignal): Promise<ReplayIntegrityResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/integrity`,
      parseReplayIntegrityResponse,
      signal ? { signal } : {},
    );
  }

  publicTimesRun(
    runId: string,
    timelineMs: readonly number[],
    signal?: AbortSignal,
  ): Promise<ReplayPublicTimeBatchResponse> {
    if (timelineMs.length < 1 || timelineMs.length > 2_000
      || timelineMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "public time batch is invalid",
      );
    }
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/public-times`,
      parseReplayPublicTimeBatchResponse,
      {
        method: "POST",
        body: JSON.stringify({ timeline_ms: timelineMs }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  equityRun(
    runId: string,
    resolution: "AUTO" | "EVENT" | "1M" | "15M" | "1H" = "AUTO",
    limit = 1_000,
    signal?: AbortSignal,
  ): Promise<ReplayEquityResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new ReplayV2ApiError("REPLAY_V2_PROTOCOL_ERROR", "equity limit is invalid");
    }
    const params = new URLSearchParams({ resolution, limit: String(limit) });
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/equity?${params.toString()}`,
      parseReplayEquityResponse,
      signal ? { signal } : {},
    );
  }

  rulesRun(runId: string, signal?: AbortSignal): Promise<ReplayRunRulesResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/rules`,
      parseReplayRunRulesResponse,
      signal ? { signal } : {},
    );
  }

  currentDrawingRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReplayCurrentDrawingDocumentResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/drawings/current`,
      parseReplayCurrentDrawingDocumentResponse,
      signal ? { signal } : {},
    );
  }

  recordDrawingRun(
    runId: string,
    payload: {
      readonly command_id: string;
      readonly document_hash: `sha256:${string}`;
      readonly document: Readonly<Record<string, unknown>>;
      readonly entity_count: number;
    },
    signal?: AbortSignal,
  ): Promise<ReplayDrawingDocumentResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/drawings`,
      parseReplayDrawingDocumentResponse,
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "replay.review.drawing-document.v1",
          ...payload,
        }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  recordMarkerRun(
    runId: string,
    text: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<ReplayReviewMarkerResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/markers`,
      parseReplayReviewMarkerResponse,
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "replay.review.marker.v1",
          command_id: commandId,
          text,
        }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  reviewRun(
    runId: string,
    eventId: string | null = null,
    signal?: AbortSignal,
  ): Promise<ReplayReviewResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/review`,
      parseReplayReviewResponse,
      {
        method: "POST",
        body: JSON.stringify({ event_id: eventId }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  controlReviewRun(
    runId: string,
    reviewId: string,
    payload: {
      readonly action: "JUMP" | "PREVIOUS" | "NEXT" | "PLAY" | "PAUSE";
      readonly event_id: string | null;
      readonly expected_cursor_revision: number;
      readonly playback_rate: "0.25" | "0.5" | "1" | "2" | "4" | "8" | null;
    },
    signal?: AbortSignal,
  ): Promise<ReplayReviewControlResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/reviews/${safeSegment(reviewId, "review id")}/cursor`,
      parseReplayReviewControlResponse,
      {
        method: "POST",
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
    );
  }

  forkRun(
    runId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<ReplayReviewForkResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/fork`,
      parseReplayReviewForkResponse,
      {
        method: "POST",
        body: JSON.stringify({ event_id: safeIdentifier(eventId, "event id") }),
        ...(signal ? { signal } : {}),
      },
    );
  }

  reportRun(runId: string, signal?: AbortSignal): Promise<ReplayTrainingReportResponse> {
    return this.request(
      `/runs/${safeSegment(runId, "run id")}/report`,
      parseReplayTrainingReportResponse,
      signal ? { signal } : {},
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
      throw new ReplayV2ApiError("REPLAY_V2_TRANSPORT_ERROR", "replay.v3 request failed", { cause: error });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch (error) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "replay.v3 response is not valid JSON",
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
          "replay.v3 error response violates the contract",
          { status: response.status, cause: error },
        );
      }
    }
    try {
      return parser(payload);
    } catch (error) {
      throw new ReplayV2ApiError(
        "REPLAY_V2_PROTOCOL_ERROR",
        "replay.v3 response violates the contract",
        { status: response.status, cause: error },
      );
    }
  }
}

export interface TrainingRunCardResponse {
  readonly run: TrainingRunMutationResponse["run"];
}

export const defaultReplayV2Api = new ReplayV2ApiClient();
