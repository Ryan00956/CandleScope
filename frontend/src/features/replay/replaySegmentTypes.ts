import type { ReplayV2SourceKind, TrainingRunCreatePayload } from "./replayV2Types.js";


export interface ReplaySegmentPreparePlan {
  readonly protocol: "replay.data.prepare.v1";
  readonly state: "PREPARE_ON_CREATE";
  readonly source_kind: ReplayV2SourceKind;
  readonly identity: {
    readonly exchange: string;
    readonly market_type: string;
    readonly symbol: string;
    readonly base_interval: string;
  };
  readonly estimated_size_bytes: number;
  readonly estimated_rows: number;
  readonly prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE" | "VERIFY_LOCAL_AGG_TRADE";
  readonly existing_ready_segments: number;
  readonly existing_ready_bytes: number;
  readonly selection_loads_history: false;
  readonly create_loads_only_selected_range: true;
  readonly download_worker_enabled: boolean;
  readonly auto_gc_enabled: boolean;
  readonly failure_policy: "QUARANTINE_AND_FAIL_CLOSED";
}

export interface ReplaySegmentPlanApi {
  segmentPlan(
    payload: TrainingRunCreatePayload,
    signal?: AbortSignal,
  ): Promise<ReplaySegmentPreparePlan>;
}

function objectValue(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  fieldName: string,
  fields: readonly string[],
): Record<string, unknown> {
  const payload = objectValue(value, fieldName);
  const actual = Object.keys(payload).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new TypeError(`${fieldName} fields are incompatible`);
  }
  return payload;
}

function displayString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new TypeError(`${fieldName} must be a bounded string`);
  }
  return value;
}

function count(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value as number;
}

export function parseReplaySegmentPreparePlan(value: unknown): ReplaySegmentPreparePlan {
  const payload = exactObject(value, "segment prepare plan", [
    "protocol",
    "state",
    "source_kind",
    "identity",
    "estimated_size_bytes",
    "estimated_rows",
    "prepare_action",
    "existing_ready_segments",
    "existing_ready_bytes",
    "selection_loads_history",
    "create_loads_only_selected_range",
    "download_worker_enabled",
    "auto_gc_enabled",
    "failure_policy",
  ]);
  const identity = exactObject(payload.identity, "segment prepare plan.identity", [
    "exchange",
    "market_type",
    "symbol",
    "base_interval",
  ]);
  if (payload.protocol !== "replay.data.prepare.v1" || payload.state !== "PREPARE_ON_CREATE") {
    throw new TypeError("segment prepare plan protocol is unsupported");
  }
  if (payload.source_kind !== "BAR" && payload.source_kind !== "AGG_TRADE") {
    throw new TypeError("segment prepare plan source_kind is unsupported");
  }
  if (payload.prepare_action !== "SNAPSHOT_LOCAL_BAR_RANGE"
    && payload.prepare_action !== "VERIFY_LOCAL_AGG_TRADE") {
    throw new TypeError("segment prepare plan action is unsupported");
  }
  if (payload.selection_loads_history !== false
    || payload.create_loads_only_selected_range !== true
    || typeof payload.download_worker_enabled !== "boolean"
    || typeof payload.auto_gc_enabled !== "boolean"
    || payload.failure_policy !== "QUARANTINE_AND_FAIL_CLOSED") {
    throw new TypeError("segment prepare plan safety contract is unsupported");
  }
  return {
    protocol: "replay.data.prepare.v1",
    state: "PREPARE_ON_CREATE",
    source_kind: payload.source_kind,
    identity: {
      exchange: displayString(identity.exchange, "segment identity.exchange"),
      market_type: displayString(identity.market_type, "segment identity.market_type"),
      symbol: displayString(identity.symbol, "segment identity.symbol"),
      base_interval: displayString(identity.base_interval, "segment identity.base_interval"),
    },
    estimated_size_bytes: count(payload.estimated_size_bytes, "estimated_size_bytes"),
    estimated_rows: count(payload.estimated_rows, "estimated_rows"),
    prepare_action: payload.prepare_action,
    existing_ready_segments: count(payload.existing_ready_segments, "existing_ready_segments"),
    existing_ready_bytes: count(payload.existing_ready_bytes, "existing_ready_bytes"),
    selection_loads_history: false,
    create_loads_only_selected_range: true,
    download_worker_enabled: payload.download_worker_enabled,
    auto_gc_enabled: payload.auto_gc_enabled,
    failure_policy: "QUARANTINE_AND_FAIL_CLOSED",
  };
}
