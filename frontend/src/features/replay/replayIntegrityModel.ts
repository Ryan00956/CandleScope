import type {
  ReplayV2IntegrityMode,
  ReplayV2Json,
  ReplayV2TimeDisclosurePolicy,
} from "./replayV2Types.js";
import {
  parseReplayReportResponse,
  type ReplayReportResponse,
} from "./replayParser.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const TIME_POLICIES = [
  "NONE",
  "HIDE_YEAR",
  "HIDE_MONTH",
  "HIDE_DAY",
  "HIDE_HOUR",
  "HIDE_MINUTE",
  "HIDE_ALL",
] as const;
const INTEGRITY_MODES = ["CHALLENGE", "PRACTICE", "SANDBOX"] as const;
export const REPLAY_POLICY_MUTATIONS = [
  "deposit",
  "withdraw",
  "change_fee_policy",
  "change_leverage_cap",
  "change_funding_policy",
  "reveal_time",
] as const;

export type ReplayPolicyMutation = typeof REPLAY_POLICY_MUTATIONS[number];
export type ReplayEquityResolution = "EVENT" | "1M" | "15M" | "1H";

export interface ReplayPublicTime {
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly timeline_ms: number;
  readonly relative_ms: number;
  readonly sequence: number;
  readonly label: string;
}

export interface ReplayIntegrityMutation {
  readonly action_sequence: number;
  readonly event_id: string;
  readonly command_id: string | null;
  readonly event_type: string;
  readonly rule_revision: number;
  readonly public_time: ReplayPublicTime;
  readonly old_value: Readonly<Record<string, ReplayV2Json>>;
  readonly new_value: Readonly<Record<string, ReplayV2Json>>;
  readonly reason: string;
  readonly state_hash_before: `sha256:${string}` | null;
  readonly state_hash_after: `sha256:${string}`;
}

export interface ReplayIntegrityResponse {
  readonly protocol: "replay.v2";
  readonly run_id: string;
  readonly integrity_mode: ReplayV2IntegrityMode;
  readonly configured_time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly effective_time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly strict_eligible: boolean;
  readonly start_time_known: boolean;
  readonly revealed: boolean;
  readonly allowed_mutations: readonly ReplayPolicyMutation[];
  readonly result_label: string;
  readonly active_rule_revision: number;
  readonly active_rule_hash: `sha256:${string}`;
  readonly active_rule: Readonly<Record<string, ReplayV2Json>>;
  readonly public_time: ReplayPublicTime;
  readonly mutations: readonly ReplayIntegrityMutation[];
}

export interface ReplayEquitySample {
  readonly source_sequence: number;
  readonly revision: number;
  readonly public_time: ReplayPublicTime;
  readonly equity: string;
  readonly cash_balance: string;
  readonly unrealized_pnl: string;
  readonly ledger_tail_hash: `sha256:${string}`;
  readonly state_hash: `sha256:${string}`;
}

export interface ReplayEquityResponse {
  readonly protocol: "replay.v2";
  readonly run_id: string;
  readonly resolution: ReplayEquityResolution;
  readonly samples: readonly ReplayEquitySample[];
  readonly bounded: true;
  readonly limits: Readonly<Record<ReplayEquityResolution, number>>;
}

export interface ReplayReviewEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly checkpoint_id: number;
  readonly source_sequence: number;
  readonly event_sequence: number;
  readonly state_hash: `sha256:${string}`;
  readonly public_time: ReplayPublicTime;
}

export interface ReplayReviewResponse {
  readonly protocol: "replay.v2";
  readonly review_id: string;
  readonly run_id: string;
  readonly read_only: true;
  readonly selected_event_id: string;
  readonly selected_state_hash: `sha256:${string}`;
  readonly original_state_hash: `sha256:${string}`;
  readonly original_cursor: {
    readonly virtual_time_ms: number;
    readonly source_sequence: number;
  };
  readonly dataset_epoch: `sha256:${string}`;
  readonly events: readonly ReplayReviewEvent[];
  readonly jump_targets: readonly {
    readonly event_id: string;
    readonly event_type: string;
  }[];
}

export interface ReplayReviewForkResponse {
  readonly protocol: "replay.v2";
  readonly parent_run_id: string;
  readonly parent_event_id: string;
  readonly run: Readonly<Record<string, ReplayV2Json>> & {
    readonly run_id: string;
    readonly adapter_session_id: string;
    readonly dataset_epoch: `sha256:${string}`;
    readonly state_hash: `sha256:${string}`;
  };
}

export interface ReplayTrainingReportResponse {
  readonly protocol: "replay.v2";
  readonly run_id: string;
  readonly data_fidelity: ReplayReportResponse["data_fidelity"];
  readonly execution_fidelity: ReplayReportResponse["execution_fidelity"];
  readonly revealed: boolean;
  readonly report: ReplayReportResponse["report"];
  readonly integrity: ReplayIntegrityResponse;
  readonly actual_history?: NonNullable<ReplayReportResponse["actual_history"]>;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const result = objectValue(value, field);
  const actual = Object.keys(result);
  const missing = keys.filter((key) => !Object.hasOwn(result, key));
  const unknown = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0) throw new TypeError(`${field} missing ${missing.join(", ")}`);
  if (unknown.length > 0) throw new TypeError(`${field} has unknown ${unknown.join(", ")}`);
  return result;
}

function stringValue(value: unknown, field: string, max = 1_024): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TypeError(`${field} must be a bounded string`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = stringValue(value, field, 128);
  if (!IDENTIFIER.test(result)) throw new TypeError(`${field} must be a safe identifier`);
  return result;
}

function counter(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function boolValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function digest(value: unknown, field: string): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${field} must be a canonical SHA-256 digest`);
  }
  return value as `sha256:${string}`;
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical Decimal string`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${field} is unsupported`);
  }
  return value as T[number];
}

function jsonValue(value: unknown, field: string): ReplayV2Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${field} contains an unsafe number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${field}[${index}]`));
  const object = objectValue(value, field);
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, jsonValue(item, `${field}.${key}`)]),
  );
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, ReplayV2Json>> {
  const result = jsonValue(value, field);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return result as Readonly<Record<string, ReplayV2Json>>;
}

export function parseReplayPublicTime(value: unknown, field = "public_time"): ReplayPublicTime {
  const source = exactObject(value, field, ["policy", "timeline_ms", "relative_ms", "sequence", "label"]);
  return {
    policy: enumValue(source.policy, TIME_POLICIES, `${field}.policy`),
    timeline_ms: counter(source.timeline_ms, `${field}.timeline_ms`),
    relative_ms: counter(source.relative_ms, `${field}.relative_ms`),
    sequence: counter(source.sequence, `${field}.sequence`),
    label: stringValue(source.label, `${field}.label`, 64),
  };
}

function parseMutation(value: unknown, index: number): ReplayIntegrityMutation {
  const field = `mutations[${index}]`;
  const source = exactObject(value, field, [
    "action_sequence", "event_id", "command_id", "event_type", "rule_revision", "public_time",
    "old_value", "new_value", "reason", "state_hash_before", "state_hash_after",
  ]);
  return {
    action_sequence: counter(source.action_sequence, `${field}.action_sequence`),
    event_id: identifier(source.event_id, `${field}.event_id`),
    command_id: source.command_id === null ? null : identifier(source.command_id, `${field}.command_id`),
    event_type: identifier(source.event_type, `${field}.event_type`),
    rule_revision: counter(source.rule_revision, `${field}.rule_revision`),
    public_time: parseReplayPublicTime(source.public_time, `${field}.public_time`),
    old_value: jsonObject(source.old_value, `${field}.old_value`),
    new_value: jsonObject(source.new_value, `${field}.new_value`),
    reason: stringValue(source.reason, `${field}.reason`, 512),
    state_hash_before: source.state_hash_before === null
      ? null
      : digest(source.state_hash_before, `${field}.state_hash_before`),
    state_hash_after: digest(source.state_hash_after, `${field}.state_hash_after`),
  };
}

export function parseReplayIntegrityResponse(value: unknown): ReplayIntegrityResponse {
  const source = exactObject(value, "integrity", [
    "protocol", "run_id", "integrity_mode", "configured_time_disclosure_policy",
    "effective_time_disclosure_policy", "strict_eligible", "start_time_known", "revealed",
    "allowed_mutations", "result_label", "active_rule_revision", "active_rule_hash",
    "active_rule", "public_time", "mutations",
  ]);
  if (source.protocol !== "replay.v2") throw new TypeError("integrity.protocol is unsupported");
  if (!Array.isArray(source.allowed_mutations)) throw new TypeError("integrity.allowed_mutations must be an array");
  const allowed = source.allowed_mutations.map((item, index) => (
    enumValue(item, REPLAY_POLICY_MUTATIONS, `integrity.allowed_mutations[${index}]`)
  ));
  if (new Set(allowed).size !== allowed.length) throw new TypeError("integrity.allowed_mutations must be unique");
  if (!Array.isArray(source.mutations)) throw new TypeError("integrity.mutations must be an array");
  const revealed = boolValue(source.revealed, "integrity.revealed");
  const effective = enumValue(
    source.effective_time_disclosure_policy,
    TIME_POLICIES,
    "integrity.effective_time_disclosure_policy",
  );
  if ((revealed && effective !== "NONE") || (!revealed && effective === "NONE"
    && source.configured_time_disclosure_policy !== "NONE")) {
    throw new TypeError("integrity effective disclosure contradicts reveal state");
  }
  return {
    protocol: "replay.v2",
    run_id: identifier(source.run_id, "integrity.run_id"),
    integrity_mode: enumValue(source.integrity_mode, INTEGRITY_MODES, "integrity.integrity_mode"),
    configured_time_disclosure_policy: enumValue(
      source.configured_time_disclosure_policy,
      TIME_POLICIES,
      "integrity.configured_time_disclosure_policy",
    ),
    effective_time_disclosure_policy: effective,
    strict_eligible: boolValue(source.strict_eligible, "integrity.strict_eligible"),
    start_time_known: boolValue(source.start_time_known, "integrity.start_time_known"),
    revealed,
    allowed_mutations: allowed,
    result_label: identifier(source.result_label, "integrity.result_label"),
    active_rule_revision: counter(source.active_rule_revision, "integrity.active_rule_revision"),
    active_rule_hash: digest(source.active_rule_hash, "integrity.active_rule_hash"),
    active_rule: jsonObject(source.active_rule, "integrity.active_rule"),
    public_time: parseReplayPublicTime(source.public_time, "integrity.public_time"),
    mutations: source.mutations.map(parseMutation),
  };
}

export function parseReplayEquityResponse(value: unknown): ReplayEquityResponse {
  const source = exactObject(value, "equity", ["protocol", "run_id", "resolution", "samples", "bounded", "limits"]);
  if (source.protocol !== "replay.v2") throw new TypeError("equity.protocol is unsupported");
  if (source.bounded !== true) throw new TypeError("equity must be bounded");
  if (!Array.isArray(source.samples)) throw new TypeError("equity.samples must be an array");
  const limits = exactObject(source.limits, "equity.limits", ["EVENT", "1M", "15M", "1H"]);
  const parsedLimits = {
    EVENT: counter(limits.EVENT, "equity.limits.EVENT"),
    "1M": counter(limits["1M"], "equity.limits.1M"),
    "15M": counter(limits["15M"], "equity.limits.15M"),
    "1H": counter(limits["1H"], "equity.limits.1H"),
  };
  const resolution = enumValue(source.resolution, ["EVENT", "1M", "15M", "1H"] as const, "equity.resolution");
  const samples = source.samples.map((item, index): ReplayEquitySample => {
    const field = `equity.samples[${index}]`;
    const sample = exactObject(item, field, [
      "source_sequence", "revision", "public_time", "equity", "cash_balance",
      "unrealized_pnl", "ledger_tail_hash", "state_hash",
    ]);
    return {
      source_sequence: counter(sample.source_sequence, `${field}.source_sequence`),
      revision: counter(sample.revision, `${field}.revision`),
      public_time: parseReplayPublicTime(sample.public_time, `${field}.public_time`),
      equity: decimal(sample.equity, `${field}.equity`),
      cash_balance: decimal(sample.cash_balance, `${field}.cash_balance`),
      unrealized_pnl: decimal(sample.unrealized_pnl, `${field}.unrealized_pnl`),
      ledger_tail_hash: digest(sample.ledger_tail_hash, `${field}.ledger_tail_hash`),
      state_hash: digest(sample.state_hash, `${field}.state_hash`),
    };
  });
  if (samples.length > parsedLimits[resolution]) throw new TypeError("equity.samples exceeds its declared bound");
  return {
    protocol: "replay.v2",
    run_id: identifier(source.run_id, "equity.run_id"),
    resolution,
    samples,
    bounded: true,
    limits: parsedLimits,
  };
}

export function parseReplayReviewResponse(value: unknown): ReplayReviewResponse {
  const source = exactObject(value, "review", [
    "protocol", "review_id", "run_id", "read_only", "selected_event_id",
    "selected_state_hash", "original_state_hash", "original_cursor", "dataset_epoch",
    "events", "jump_targets",
  ]);
  if (source.protocol !== "replay.v2") throw new TypeError("review.protocol is unsupported");
  if (source.read_only !== true) throw new TypeError("review must be read-only");
  if (!Array.isArray(source.events) || !Array.isArray(source.jump_targets)) {
    throw new TypeError("review events and jump targets must be arrays");
  }
  const originalCursor = exactObject(source.original_cursor, "review.original_cursor", ["virtual_time_ms", "source_sequence"]);
  const events = source.events.map((item, index): ReplayReviewEvent => {
    const field = `review.events[${index}]`;
    const event = exactObject(item, field, [
      "event_id", "event_type", "checkpoint_id", "source_sequence", "event_sequence",
      "state_hash", "public_time",
    ]);
    return {
      event_id: identifier(event.event_id, `${field}.event_id`),
      event_type: identifier(event.event_type, `${field}.event_type`),
      checkpoint_id: counter(event.checkpoint_id, `${field}.checkpoint_id`),
      source_sequence: counter(event.source_sequence, `${field}.source_sequence`),
      event_sequence: counter(event.event_sequence, `${field}.event_sequence`),
      state_hash: digest(event.state_hash, `${field}.state_hash`),
      public_time: parseReplayPublicTime(event.public_time, `${field}.public_time`),
    };
  });
  const jumpTargets = source.jump_targets.map((item, index) => {
    const target = exactObject(item, `review.jump_targets[${index}]`, ["event_id", "event_type"]);
    return {
      event_id: identifier(target.event_id, `review.jump_targets[${index}].event_id`),
      event_type: identifier(target.event_type, `review.jump_targets[${index}].event_type`),
    };
  });
  const selectedEventId = identifier(source.selected_event_id, "review.selected_event_id");
  if (!events.some((event) => event.event_id === selectedEventId)) {
    throw new TypeError("review selected event is missing");
  }
  return {
    protocol: "replay.v2",
    review_id: identifier(source.review_id, "review.review_id"),
    run_id: identifier(source.run_id, "review.run_id"),
    read_only: true,
    selected_event_id: selectedEventId,
    selected_state_hash: digest(source.selected_state_hash, "review.selected_state_hash"),
    original_state_hash: digest(source.original_state_hash, "review.original_state_hash"),
    original_cursor: {
      virtual_time_ms: counter(originalCursor.virtual_time_ms, "review.original_cursor.virtual_time_ms"),
      source_sequence: counter(originalCursor.source_sequence, "review.original_cursor.source_sequence"),
    },
    dataset_epoch: digest(source.dataset_epoch, "review.dataset_epoch"),
    events,
    jump_targets: jumpTargets,
  };
}

export function parseReplayReviewForkResponse(value: unknown): ReplayReviewForkResponse {
  const source = exactObject(value, "fork", ["protocol", "parent_run_id", "parent_event_id", "run"]);
  if (source.protocol !== "replay.v2") throw new TypeError("fork.protocol is unsupported");
  const run = jsonObject(source.run, "fork.run");
  return {
    protocol: "replay.v2",
    parent_run_id: identifier(source.parent_run_id, "fork.parent_run_id"),
    parent_event_id: identifier(source.parent_event_id, "fork.parent_event_id"),
    run: {
      ...run,
      run_id: identifier(run.run_id, "fork.run.run_id"),
      adapter_session_id: identifier(run.adapter_session_id, "fork.run.adapter_session_id"),
      dataset_epoch: digest(run.dataset_epoch, "fork.run.dataset_epoch"),
      state_hash: digest(run.state_hash, "fork.run.state_hash"),
    },
  };
}

export function parseReplayTrainingReportResponse(value: unknown): ReplayTrainingReportResponse {
  const source = objectValue(value, "training_report");
  const hasActual = Object.hasOwn(source, "actual_history");
  const exact = exactObject(source, "training_report", [
    "protocol", "run_id", "data_fidelity", "execution_fidelity", "revealed", "report",
    "integrity", ...(hasActual ? ["actual_history"] : []),
  ]);
  if (exact.protocol !== "replay.v2") throw new TypeError("training_report.protocol is unsupported");
  const runId = identifier(exact.run_id, "training_report.run_id");
  const parsed = parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: runId,
    data_fidelity: exact.data_fidelity,
    execution_fidelity: exact.execution_fidelity,
    revealed: exact.revealed,
    report: exact.report,
    ...(hasActual ? { actual_history: exact.actual_history } : {}),
  }, "training_report");
  const integrity = parseReplayIntegrityResponse(exact.integrity);
  if (integrity.run_id !== runId || integrity.revealed !== parsed.revealed) {
    throw new TypeError("training report integrity does not reconcile");
  }
  return {
    protocol: "replay.v2",
    run_id: runId,
    data_fidelity: parsed.data_fidelity,
    execution_fidelity: parsed.execution_fidelity,
    revealed: parsed.revealed,
    report: parsed.report,
    integrity,
    ...(parsed.actual_history ? { actual_history: parsed.actual_history } : {}),
  };
}

interface ScaledDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function scaledDecimal(value: string): ScaledDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);
  return { coefficient, scale: fraction.length };
}

function graphNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function buildEquityPolyline(
  samples: readonly ReplayEquitySample[],
  width: number,
  height: number,
): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError("equity graph dimensions must be positive finite numbers");
  }
  if (samples.length === 0) return "";
  const decimals = samples.map((sample) => scaledDecimal(decimal(sample.equity, "sample.equity")));
  const scale = Math.max(...decimals.map((item) => item.scale));
  const values = decimals.map((item) => item.coefficient * (10n ** BigInt(scale - item.scale)));
  const minimum = values.reduce((left, right) => left < right ? left : right);
  const maximum = values.reduce((left, right) => left > right ? left : right);
  const span = maximum - minimum;
  return values.map((value, index) => {
    const x = samples.length === 1 ? width / 2 : (index * width) / (samples.length - 1);
    const y = span === 0n ? height / 2 : height - (Number(value - minimum) / Number(span)) * height;
    return `${graphNumber(x)},${graphNumber(y)}`;
  }).join(" ");
}

export interface SemanticViewAction {
  readonly event_type: string;
  readonly semantic_key: string;
  readonly value: Readonly<Record<string, ReplayV2Json>>;
}

export class SemanticViewActionSampler {
  private readonly pending = new Map<string, SemanticViewAction>();

  get pendingCount(): number {
    return this.pending.size;
  }

  offer(eventType: string, semanticKey: string, value: Readonly<Record<string, ReplayV2Json>>): void {
    const normalizedType = identifier(eventType, "event_type");
    const normalizedKey = identifier(semanticKey, "semantic_key");
    this.pending.set(normalizedKey, {
      event_type: normalizedType,
      semantic_key: normalizedKey,
      value: jsonObject(value, "view_action.value"),
    });
  }

  flush(): readonly SemanticViewAction[] {
    const result = [...this.pending.values()];
    this.pending.clear();
    return result;
  }
}
