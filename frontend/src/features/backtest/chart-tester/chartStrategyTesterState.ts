import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";

export type ChartStrategyTesterStatus =
  | "DETACHED"
  | "RESOLVING"
  | "NEEDS_DATA"
  | "READY"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "STALE"
  | "FAILED"
  | "UNSUPPORTED";

export type ChartStrategyTesterStaleReason =
  | "EXCHANGE_CHANGED"
  | "MARKET_TYPE_CHANGED"
  | "SYMBOL_CHANGED"
  | "INTERVAL_CHANGED"
  | "DRAFT_CHANGED"
  | "DRAFT_CONTENT_CHANGED"
  | "LANGUAGE_CHANGED"
  | "STRATEGY_REVISION_CHANGED"
  | "PARAMETERS_CHANGED"
  | "RANGE_CHANGED"
  | "FIDELITY_CHANGED"
  | "QUICK_PRESET_CHANGED"
  | "SOURCE_CHANGED"
  | "DATA_REVISION_CHANGED";

export interface ResultProjectionIdentity {
  cellScope: string;
  chartContextHash: string;
  strategyRevisionId: string;
  parameterHash: string;
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
  frozenContextHash: string;
  startTimeMs: number;
  endTimeMs: number;
  executionProfileRevision: string;
  runId: string;
}

export interface ChartStrategyTesterInputs {
  session: ChartSession;
  attachment: ChartStrategyAttachmentRecord;
  draftContentRevision: number | null;
  sourceKind?: "CURRENT_CHART" | "IMPORTED_DATASET" | "COMPLETED_RUN";
  datasetId?: string;
  dataEpoch?: string;
}

export interface ChartStrategyTesterError {
  code: string;
  message: string;
  action: string | null;
}

export interface ChartStrategyTesterState {
  cellScope: string;
  status: ChartStrategyTesterStatus;
  inputs: ChartStrategyTesterInputs | null;
  generation: number;
  resultIdentity: ResultProjectionIdentity | null;
  projectionVisible: boolean;
  staleReasons: ChartStrategyTesterStaleReason[];
  activeRunId: string | null;
  baselineRunId: string | null;
  actionableError: ChartStrategyTesterError | null;
}

export interface ChartStrategyTesterGenerationToken {
  cellScope: string;
  generation: number;
}

export type ChartStrategyTesterEvent =
  | { type: "SYNC_INPUTS"; inputs: ChartStrategyTesterInputs | null }
  | { type: "BEGIN_REQUEST"; status?: "RESOLVING" | "QUEUED" | "RUNNING" }
  | {
    type: "REQUEST_STATUS";
    token: ChartStrategyTesterGenerationToken;
    status: Exclude<ChartStrategyTesterStatus, "DETACHED" | "STALE" | "COMPLETED" | "FAILED">;
    activeRunId?: string | null;
  }
  | {
    type: "REQUEST_COMPLETED";
    token: ChartStrategyTesterGenerationToken;
    identity: ResultProjectionIdentity;
    baselineRunId?: string | null;
  }
  | {
    type: "REQUEST_FAILED";
    token: ChartStrategyTesterGenerationToken;
    error: ChartStrategyTesterError;
  }
  | {
    type: "BIND_STRATEGY_REVISION";
    token: ChartStrategyTesterGenerationToken;
    strategyRevisionId: string;
  }
  | { type: "STOP_OBSERVING" }
  | { type: "CLEAR_RESULT" }
  | { type: "DETACH" };

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(",")}}`;
  }
  return "null";
}

function cloneInputs(inputs: ChartStrategyTesterInputs): ChartStrategyTesterInputs {
  return {
    session: { ...inputs.session },
    attachment: {
      ...inputs.attachment,
      parameters: JSON.parse(canonicalJson(inputs.attachment.parameters)) as Record<string, unknown>,
      customRange: inputs.attachment.customRange
        ? { ...inputs.attachment.customRange }
        : null,
    },
    draftContentRevision: inputs.draftContentRevision,
    ...(inputs.sourceKind === undefined ? {} : { sourceKind: inputs.sourceKind }),
    ...(inputs.datasetId === undefined ? {} : { datasetId: inputs.datasetId }),
    ...(inputs.dataEpoch === undefined ? {} : { dataEpoch: inputs.dataEpoch }),
  };
}

export function chartStrategyTesterStaleReasons(
  previous: ChartStrategyTesterInputs,
  next: ChartStrategyTesterInputs,
): ChartStrategyTesterStaleReason[] {
  const reasons: ChartStrategyTesterStaleReason[] = [];
  if (previous.session.exchange !== next.session.exchange) reasons.push("EXCHANGE_CHANGED");
  if (previous.session.marketType !== next.session.marketType) reasons.push("MARKET_TYPE_CHANGED");
  if (previous.session.symbol !== next.session.symbol) reasons.push("SYMBOL_CHANGED");
  if (previous.session.interval !== next.session.interval) reasons.push("INTERVAL_CHANGED");
  const left = previous.attachment;
  const right = next.attachment;
  if (left.strategyDraftId !== right.strategyDraftId) reasons.push("DRAFT_CHANGED");
  if (previous.draftContentRevision !== next.draftContentRevision) {
    reasons.push("DRAFT_CONTENT_CHANGED");
  }
  if (left.language !== right.language) reasons.push("LANGUAGE_CHANGED");
  if (left.strategyRevisionId !== right.strategyRevisionId) {
    reasons.push("STRATEGY_REVISION_CHANGED");
  }
  if (canonicalJson(left.parameters) !== canonicalJson(right.parameters)) {
    reasons.push("PARAMETERS_CHANGED");
  }
  if (left.rangeMode !== right.rangeMode
    || canonicalJson(left.customRange) !== canonicalJson(right.customRange)) {
    reasons.push("RANGE_CHANGED");
  }
  if (left.fidelityPreference !== right.fidelityPreference) {
    reasons.push("FIDELITY_CHANGED");
  }
  if (left.quickPresetId !== right.quickPresetId) reasons.push("QUICK_PRESET_CHANGED");
  if (previous.sourceKind !== next.sourceKind || previous.datasetId !== next.datasetId) {
    reasons.push("SOURCE_CHANGED");
  }
  if (previous.dataEpoch !== next.dataEpoch) reasons.push("DATA_REVISION_CHANGED");
  return reasons;
}

export function createChartStrategyTesterState(
  inputs: ChartStrategyTesterInputs | null = null,
  cellScope = "",
): ChartStrategyTesterState {
  return {
    cellScope,
    status: inputs ? "READY" : "DETACHED",
    inputs: inputs ? cloneInputs(inputs) : null,
    generation: 0,
    resultIdentity: null,
    projectionVisible: false,
    staleReasons: [],
    activeRunId: null,
    baselineRunId: null,
    actionableError: null,
  };
}

export function currentChartStrategyTesterToken(
  state: ChartStrategyTesterState,
): ChartStrategyTesterGenerationToken {
  return { cellScope: state.cellScope, generation: state.generation };
}

export function reduceChartStrategyTesterState(
  state: ChartStrategyTesterState,
  event: ChartStrategyTesterEvent,
): ChartStrategyTesterState {
  if (event.type === "DETACH" || (event.type === "SYNC_INPUTS" && !event.inputs)) {
    return {
      ...createChartStrategyTesterState(null, state.cellScope),
      generation: state.generation + 1,
    };
  }
  if (event.type === "SYNC_INPUTS") {
    const nextInputs = cloneInputs(event.inputs!);
    if (!state.inputs) {
      return { ...state, status: "READY", inputs: nextInputs, generation: state.generation + 1 };
    }
    const staleReasons = chartStrategyTesterStaleReasons(state.inputs, nextInputs);
    if (staleReasons.length === 0) return state;
    const hasResult = state.resultIdentity !== null;
    return {
      ...state,
      inputs: nextInputs,
      generation: state.generation + 1,
      status: hasResult ? "STALE" : "READY",
      projectionVisible: false,
      staleReasons,
      activeRunId: null,
      actionableError: null,
    };
  }
  if (event.type === "BEGIN_REQUEST") {
    if (!state.inputs) return state;
    return {
      ...state,
      status: event.status ?? "RESOLVING",
      generation: state.generation + 1,
      staleReasons: [],
      projectionVisible: false,
      actionableError: null,
    };
  }
  if (event.type === "CLEAR_RESULT") {
    return {
      ...state,
      status: state.inputs ? "READY" : "DETACHED",
      resultIdentity: null,
      projectionVisible: false,
      staleReasons: [],
      activeRunId: null,
      baselineRunId: null,
      actionableError: null,
    };
  }
  if (event.type === "STOP_OBSERVING") {
    return {
      ...state,
      status: state.inputs ? "READY" : "DETACHED",
      generation: state.generation + 1,
      projectionVisible: false,
      actionableError: null,
    };
  }
  if (event.token.cellScope !== state.cellScope
    || event.token.generation !== state.generation) return state;
  if (event.type === "BIND_STRATEGY_REVISION") {
    if (!state.inputs) return state;
    return {
      ...state,
      inputs: {
        ...state.inputs,
        attachment: {
          ...state.inputs.attachment,
          strategyRevisionId: event.strategyRevisionId,
        },
      },
    };
  }
  if (event.type === "REQUEST_STATUS") {
    return {
      ...state,
      status: event.status,
      activeRunId: event.activeRunId === undefined ? state.activeRunId : event.activeRunId,
    };
  }
  if (event.type === "REQUEST_COMPLETED") {
    if (event.identity.cellScope !== state.cellScope) return state;
    return {
      ...state,
      status: "COMPLETED",
      resultIdentity: { ...event.identity },
      projectionVisible: true,
      staleReasons: [],
      activeRunId: event.identity.runId,
      baselineRunId: event.baselineRunId ?? null,
      actionableError: null,
    };
  }
  return {
    ...state,
    status: "FAILED",
    projectionVisible: false,
    actionableError: { ...event.error },
  };
}
