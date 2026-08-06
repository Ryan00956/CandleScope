const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ReplayPeriodSummaryBuildState =
  | "PREPARING"
  | "READY"
  | "FAILED"
  | "CANCELLED";

export interface ReplayPeriodSummaryBuildStatus {
  readonly set_id: string;
  readonly status: ReplayPeriodSummaryBuildState;
  readonly active: boolean;
  readonly algorithm_version: string;
  readonly candidate_count: number;
  readonly source_event_count: number;
  readonly raw_state_bytes: number;
  readonly compressed_bytes: number;
  readonly build_wall_ms: number;
  readonly build_cpu_ms: number;
  readonly build_proof_hash: `sha256:${string}` | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

export interface ReplayPeriodSummaryStatus {
  readonly schema_version: "replay.period-summary-set.v1";
  readonly latest_build: ReplayPeriodSummaryBuildStatus | null;
  readonly active_set: ReplayPeriodSummaryBuildStatus | null;
  readonly limits?: {
    readonly max_candidates: number;
    readonly max_total_compressed_bytes: number;
  };
  readonly reason_code?: "OPTIMIZATION_DISABLED";
}

export interface ReplayPeriodSummaryStatusResponse {
  readonly protocol: "replay.v3";
  readonly run_id: string;
  readonly enabled: boolean;
  readonly status: ReplayPeriodSummaryStatus;
}

export interface ReplayPeriodSummaryPrepareResponse
  extends ReplayPeriodSummaryStatusResponse {
  readonly enabled: true;
  readonly build: {
    readonly set_id: string;
    readonly status: "READY";
    readonly candidate_count: number;
    readonly source_event_count: number;
    readonly raw_state_bytes: number;
    readonly compressed_bytes: number;
    readonly build_wall_ms: number;
    readonly build_cpu_ms: number;
    readonly build_proof_hash: `sha256:${string}`;
  };
}

function objectValue(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  fieldName: string,
  fields: readonly string[],
): Record<string, unknown> {
  const object = objectValue(value, fieldName);
  const keys = Object.keys(object);
  const missing = fields.filter((field) => !Object.hasOwn(object, field));
  const unknown = keys.filter((field) => !fields.includes(field));
  if (missing.length > 0) throw new TypeError(`${fieldName} missing ${missing.join(", ")}`);
  if (unknown.length > 0) throw new TypeError(`${fieldName} has unknown ${unknown.join(", ")}`);
  return object;
}

function identifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${fieldName} must be a safe identifier`);
  }
  return value;
}

function counter(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableString(value: unknown, fieldName: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string or null`);
  }
  return value;
}

function digest(value: unknown, fieldName: string): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${fieldName} must be a SHA-256 digest`);
  }
  return value as `sha256:${string}`;
}

function buildStatus(
  value: unknown,
  fieldName: string,
): ReplayPeriodSummaryBuildStatus {
  const build = exact(value, fieldName, [
    "set_id",
    "status",
    "active",
    "algorithm_version",
    "candidate_count",
    "source_event_count",
    "raw_state_bytes",
    "compressed_bytes",
    "build_wall_ms",
    "build_cpu_ms",
    "build_proof_hash",
    "error_code",
    "error_message",
  ]);
  if (!["PREPARING", "READY", "FAILED", "CANCELLED"].includes(String(build.status))) {
    throw new TypeError(`${fieldName}.status is unsupported`);
  }
  if (typeof build.active !== "boolean") {
    throw new TypeError(`${fieldName}.active must be a boolean`);
  }
  if (typeof build.algorithm_version !== "string" || build.algorithm_version.length < 1) {
    throw new TypeError(`${fieldName}.algorithm_version is invalid`);
  }
  return {
    set_id: identifier(build.set_id, `${fieldName}.set_id`),
    status: build.status as ReplayPeriodSummaryBuildState,
    active: build.active,
    algorithm_version: build.algorithm_version,
    candidate_count: counter(build.candidate_count, `${fieldName}.candidate_count`),
    source_event_count: counter(build.source_event_count, `${fieldName}.source_event_count`),
    raw_state_bytes: counter(build.raw_state_bytes, `${fieldName}.raw_state_bytes`),
    compressed_bytes: counter(build.compressed_bytes, `${fieldName}.compressed_bytes`),
    build_wall_ms: counter(build.build_wall_ms, `${fieldName}.build_wall_ms`),
    build_cpu_ms: counter(build.build_cpu_ms, `${fieldName}.build_cpu_ms`),
    build_proof_hash: build.build_proof_hash === null
      ? null
      : digest(build.build_proof_hash, `${fieldName}.build_proof_hash`),
    error_code: nullableString(build.error_code, `${fieldName}.error_code`),
    error_message: nullableString(build.error_message, `${fieldName}.error_message`),
  };
}

function statusValue(
  value: unknown,
  enabled: boolean,
): ReplayPeriodSummaryStatus {
  const fields = enabled
    ? ["schema_version", "latest_build", "active_set", "limits"]
    : ["schema_version", "latest_build", "active_set", "reason_code"];
  const status = exact(value, "period summary status", fields);
  if (status.schema_version !== "replay.period-summary-set.v1") {
    throw new TypeError("period summary status schema is incompatible");
  }
  const latest = status.latest_build === null
    ? null
    : buildStatus(status.latest_build, "period summary latest build");
  const active = status.active_set === null
    ? null
    : buildStatus(status.active_set, "period summary active set");
  if (!enabled) {
    if (status.reason_code !== "OPTIMIZATION_DISABLED") {
      throw new TypeError("disabled period summary reason is incompatible");
    }
    return {
      schema_version: "replay.period-summary-set.v1",
      latest_build: latest,
      active_set: active,
      reason_code: "OPTIMIZATION_DISABLED",
    };
  }
  const limits = exact(status.limits, "period summary limits", [
    "max_candidates",
    "max_total_compressed_bytes",
  ]);
  return {
    schema_version: "replay.period-summary-set.v1",
    latest_build: latest,
    active_set: active,
    limits: {
      max_candidates: counter(limits.max_candidates, "period summary max candidates"),
      max_total_compressed_bytes: counter(
        limits.max_total_compressed_bytes,
        "period summary max bytes",
      ),
    },
  };
}

export function parseReplayPeriodSummaryStatus(
  value: unknown,
): ReplayPeriodSummaryStatusResponse {
  const response = exact(value, "period summary response", [
    "protocol",
    "run_id",
    "enabled",
    "status",
  ]);
  if (response.protocol !== "replay.v3" || typeof response.enabled !== "boolean") {
    throw new TypeError("period summary response envelope is incompatible");
  }
  return {
    protocol: "replay.v3",
    run_id: identifier(response.run_id, "period summary run_id"),
    enabled: response.enabled,
    status: statusValue(response.status, response.enabled),
  };
}

export function parseReplayPeriodSummaryPrepare(
  value: unknown,
): ReplayPeriodSummaryPrepareResponse {
  const response = exact(value, "period summary prepare response", [
    "protocol",
    "run_id",
    "enabled",
    "build",
    "status",
  ]);
  if (response.protocol !== "replay.v3" || response.enabled !== true) {
    throw new TypeError("period summary prepare envelope is incompatible");
  }
  const build = exact(response.build, "period summary build", [
    "set_id",
    "status",
    "candidate_count",
    "source_event_count",
    "raw_state_bytes",
    "compressed_bytes",
    "build_wall_ms",
    "build_cpu_ms",
    "build_proof_hash",
  ]);
  if (build.status !== "READY") {
    throw new TypeError("period summary prepare did not return READY");
  }
  return {
    protocol: "replay.v3",
    run_id: identifier(response.run_id, "period summary run_id"),
    enabled: true,
    build: {
      set_id: identifier(build.set_id, "period summary build set_id"),
      status: "READY",
      candidate_count: counter(build.candidate_count, "period summary candidate count"),
      source_event_count: counter(build.source_event_count, "period summary source events"),
      raw_state_bytes: counter(build.raw_state_bytes, "period summary raw bytes"),
      compressed_bytes: counter(build.compressed_bytes, "period summary compressed bytes"),
      build_wall_ms: counter(build.build_wall_ms, "period summary build wall ms"),
      build_cpu_ms: counter(build.build_cpu_ms, "period summary build cpu ms"),
      build_proof_hash: digest(build.build_proof_hash, "period summary build proof"),
    },
    status: statusValue(response.status, true),
  };
}
