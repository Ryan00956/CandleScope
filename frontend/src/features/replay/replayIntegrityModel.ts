import {
  parseReplayAccountAuditResponse,
  parseReplayTrainingPortfolio,
  type ReplayAccountAuditResponse,
  type ReplayTrainingPortfolio,
  type ReplayV2IntegrityMode,
  type ReplayV2Json,
  type ReplayV2TimeDisclosurePolicy,
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

export interface ReplayPublicTimeBatchItem {
  readonly input_timeline_ms: number;
  readonly public_time: ReplayPublicTime;
}

export interface ReplayPublicTimeBatchResponse {
  readonly protocol: "replay.v2";
  readonly run_id: string;
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly items: readonly ReplayPublicTimeBatchItem[];
}

export interface ReplayStartSelection {
  readonly schema_version: "replay.start-selection.v1";
  readonly start_mode: "MANUAL" | "RANDOM";
  readonly seed_source: "SERVER" | "MANUAL" | "LEGACY_CLIENT" | "FORK";
  readonly seed_disclosed: boolean;
  readonly random_seed: number | null;
  readonly dataset_epoch: `sha256:${string}`;
  readonly parent_selection_hash: `sha256:${string}` | null;
  readonly selection_hash: `sha256:${string}`;
  readonly public_start: ReplayPublicTime;
  readonly public_end: ReplayPublicTime;
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
  readonly start_selection: ReplayStartSelection;
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
  readonly category: string;
  readonly timeline_sequence: number;
  readonly checkpoint_id: number;
  readonly source_sequence: number;
  readonly event_sequence: number;
  readonly state_hash: `sha256:${string}`;
  readonly account_hash: `sha256:${string}`;
  readonly ledger_tail_hash: `sha256:${string}`;
  readonly viewer_revision: number;
  readonly anchor_set_hash: `sha256:${string}`;
  readonly event_hash: `sha256:${string}`;
  readonly public_time: ReplayPublicTime;
  readonly detail: Readonly<Record<string, ReplayV2Json>> | null;
}

export interface ReplayReviewBudget {
  readonly critical_events: number;
  readonly critical_event_limit: number;
  readonly viewport_samples: number;
  readonly viewport_sample_limit: number;
  readonly anchor_used_bytes: number;
  readonly anchor_limit_bytes: number;
  readonly artifact_used_bytes: number;
  readonly artifact_limit_bytes: number;
}

export interface ReplayRunRuleRevision {
  readonly kind: "FEE_POLICY" | "LEVERAGE_CAP" | "FUNDING_POLICY";
  readonly revision: number;
  readonly effective_cursor: {
    readonly virtual_time_ms: number;
    readonly source_sequence: number;
  };
  readonly public_time: ReplayPublicTime;
  readonly policy_hash: `sha256:${string}`;
  readonly fidelity: string;
  readonly reason: string;
  readonly command_id: string | null;
  readonly old: Readonly<Record<string, ReplayV2Json>> | null;
  readonly new: Readonly<Record<string, ReplayV2Json>>;
  readonly maker_fee_bps?: string;
  readonly taker_fee_bps?: string;
  readonly max_leverage?: string;
  readonly funding_mode?: "OFF" | "HISTORICAL_EXACT" | "SANDBOX_FIXED";
  readonly fixed_funding_rate?: string | null;
  readonly funding_interval_ms?: number | null;
}

export interface ReplayRunInstrumentRule {
  readonly track_id: string;
  readonly revision: number;
  readonly effective_virtual_time_ms: number;
  readonly rule: Readonly<Record<string, ReplayV2Json>>;
  readonly rule_hash: `sha256:${string}`;
  readonly fidelity: string;
  readonly immutable_exchange_rule: true;
}

export interface ReplayRunRulesResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.run-rules.v1";
  readonly run_id: string;
  readonly effective_cursor: {
    readonly virtual_time_ms: number;
    readonly source_sequence: number;
  };
  readonly fee_policy: ReplayRunRuleRevision & {
    readonly kind: "FEE_POLICY";
    readonly maker_fee_bps: string;
    readonly taker_fee_bps: string;
  };
  readonly leverage_policy: ReplayRunRuleRevision & {
    readonly kind: "LEVERAGE_CAP";
    readonly max_leverage: string;
  };
  readonly funding_policy: ReplayRunRuleRevision & {
    readonly kind: "FUNDING_POLICY";
    readonly funding_mode: "OFF" | "HISTORICAL_EXACT" | "SANDBOX_FIXED";
    readonly fixed_funding_rate: string | null;
    readonly funding_interval_ms: number | null;
  };
  readonly instrument_rules: readonly ReplayRunInstrumentRule[];
  readonly effective_leverage_by_track: Readonly<Record<string, string>>;
  readonly history: readonly ReplayRunRuleRevision[];
}

export interface ReplayReviewProjection {
  readonly schema_version: "replay.review.timeline.v1";
  readonly run_id: string;
  readonly cursor: {
    readonly virtual_time_ms: number;
    readonly source_sequence: number;
  };
  readonly tracks: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly orders: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly fills: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly ledger: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly markers: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly liquidations: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly books: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly account: Readonly<Record<string, ReplayV2Json>>;
  readonly account_hash: `sha256:${string}`;
  readonly rules: ReplayRunRulesResponse;
  readonly viewer_state: Readonly<Record<string, ReplayV2Json>>;
  readonly viewer_hash: `sha256:${string}`;
  readonly drawing_document_hash: `sha256:${string}` | null;
  readonly drawing_revision: number;
  readonly domain: Readonly<Record<string, ReplayV2Json>>;
}

export interface ReplayReviewImmutabilityProof {
  readonly original_account_hash: `sha256:${string}`;
  readonly original_ledger_tail_hash: `sha256:${string}`;
  readonly original_viewer_revision: number;
  readonly original_viewer_hash: `sha256:${string}`;
  readonly verified: true;
}

export interface ReplayReviewResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.review.timeline.v1";
  readonly review_id: string;
  readonly run_id: string;
  readonly read_only: true;
  readonly selected_event_id: string;
  readonly selected_timeline_sequence: number;
  readonly selected_state_hash: `sha256:${string}`;
  readonly original_state_hash: `sha256:${string}`;
  readonly original_cursor: {
    readonly virtual_time_ms: number;
    readonly source_sequence: number;
  };
  readonly dataset_epoch: `sha256:${string}`;
  readonly cursor_revision: number;
  readonly playback_state: "PAUSED" | "PLAYING";
  readonly playback_rate: "0.25" | "0.5" | "1" | "2" | "4" | "8";
  readonly projection: ReplayReviewProjection;
  readonly drawing_document: Readonly<Record<string, ReplayV2Json>> | null;
  readonly immutability_proof: ReplayReviewImmutabilityProof;
  readonly budget: ReplayReviewBudget;
  readonly events: readonly ReplayReviewEvent[];
  readonly jump_targets: readonly {
    readonly event_id: string;
    readonly event_type: string;
    readonly category: string;
  }[];
}

export interface ReplayReviewControlResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.review.timeline.v1";
  readonly review_id: string;
  readonly run_id: string;
  readonly read_only: true;
  readonly selected_event_id: string;
  readonly selected_timeline_sequence: number;
  readonly selected_state_hash: `sha256:${string}`;
  readonly original_state_hash: `sha256:${string}`;
  readonly cursor_revision: number;
  readonly playback_state: "PAUSED" | "PLAYING";
  readonly playback_rate: "0.25" | "0.5" | "1" | "2" | "4" | "8";
  readonly selected_event: {
    readonly event_id: string;
    readonly event_type: string;
    readonly category: string;
    readonly timeline_sequence: number;
    readonly public_time: ReplayPublicTime;
    readonly detail: Readonly<Record<string, ReplayV2Json>> | null;
  };
  readonly projection: ReplayReviewProjection;
  readonly drawing_document: Readonly<Record<string, ReplayV2Json>> | null;
  readonly immutability_proof: ReplayReviewImmutabilityProof;
  readonly budget: ReplayReviewBudget;
}

export interface ReplayReviewForkResponse {
  readonly protocol: "replay.v2";
  readonly parent_run_id: string;
  readonly parent_event_id: string;
  readonly parent_timeline_sequence: number;
  readonly anchor_set_hash: `sha256:${string}`;
  readonly run: Readonly<Record<string, ReplayV2Json>> & {
    readonly run_id: string;
    readonly adapter_session_id: string;
    readonly dataset_epoch: `sha256:${string}`;
    readonly state_hash: `sha256:${string}`;
  };
  readonly tracks: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly account_audit: Readonly<Record<string, ReplayV2Json>> | null;
}

export interface ReplayDrawingDocumentResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.review.drawing-document.v1";
  readonly run_id: string;
  readonly document_hash: `sha256:${string}`;
  readonly revision: number;
  readonly entity_count: number;
  readonly deduplicated: boolean;
  readonly budget: ReplayReviewBudget;
}

export interface ReplayCurrentDrawingDocumentResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.review.drawing-current.v1";
  readonly run_id: string;
  readonly document_hash: `sha256:${string}` | null;
  readonly revision: number;
  readonly entity_count: number;
  readonly document: Readonly<Record<string, ReplayV2Json>> | null;
  readonly budget: ReplayReviewBudget;
}

export interface ReplayReviewMarkerResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.review.marker.v1";
  readonly run_id: string;
  readonly marker_id: string;
  readonly command_id: string;
  readonly text: string;
  readonly content_hash: `sha256:${string}`;
  readonly event_id: string;
  readonly timeline_sequence: number;
  readonly deduplicated: boolean;
  readonly budget: ReplayReviewBudget;
}

export interface ReplayTrainingReportResponse {
  readonly protocol: "replay.v2";
  readonly run_id: string;
  readonly data_fidelity: ReplayReportResponse["data_fidelity"];
  readonly execution_fidelity: ReplayReportResponse["execution_fidelity"];
  readonly revealed: boolean;
  readonly report: ReplayReportResponse["report"];
  readonly integrity: ReplayIntegrityResponse;
  readonly public_time_index: ReplayPublicTimeBatchResponse;
  readonly modelled_account: ReplayTrainingPortfolio;
  readonly account_audit: ReplayAccountAuditResponse | null;
  readonly liquidation_channel_contract: {
    readonly simulated_account: "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED";
    readonly historical_market: "INDEPENDENT_FEED_OR_UNSUPPORTED";
  };
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

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
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

function parseCursor(
  value: unknown,
  field: string,
): { readonly virtual_time_ms: number; readonly source_sequence: number } {
  const source = exactObject(value, field, ["virtual_time_ms", "source_sequence"]);
  return {
    virtual_time_ms: counter(source.virtual_time_ms, `${field}.virtual_time_ms`),
    source_sequence: counter(source.source_sequence, `${field}.source_sequence`),
  };
}

function parseReviewBudget(value: unknown, field = "review.budget"): ReplayReviewBudget {
  const source = exactObject(value, field, [
    "critical_events", "critical_event_limit", "viewport_samples",
    "viewport_sample_limit", "anchor_used_bytes", "anchor_limit_bytes",
    "artifact_used_bytes", "artifact_limit_bytes",
  ]);
  const result = {
    critical_events: counter(source.critical_events, `${field}.critical_events`),
    critical_event_limit: counter(source.critical_event_limit, `${field}.critical_event_limit`),
    viewport_samples: counter(source.viewport_samples, `${field}.viewport_samples`),
    viewport_sample_limit: counter(source.viewport_sample_limit, `${field}.viewport_sample_limit`),
    anchor_used_bytes: counter(source.anchor_used_bytes, `${field}.anchor_used_bytes`),
    anchor_limit_bytes: counter(source.anchor_limit_bytes, `${field}.anchor_limit_bytes`),
    artifact_used_bytes: counter(source.artifact_used_bytes, `${field}.artifact_used_bytes`),
    artifact_limit_bytes: counter(source.artifact_limit_bytes, `${field}.artifact_limit_bytes`),
  };
  if (result.critical_event_limit !== 8_192
    || result.viewport_sample_limit !== 2_048
    || result.anchor_limit_bytes !== 512 * 1024 * 1024
    || result.artifact_limit_bytes !== 128 * 1024 * 1024
    || result.critical_events > result.critical_event_limit
    || result.viewport_samples > result.viewport_sample_limit
    || result.anchor_used_bytes > result.anchor_limit_bytes
    || result.artifact_used_bytes > result.artifact_limit_bytes) {
    throw new TypeError(`${field} contradicts the Phase 17 hard budgets`);
  }
  return result;
}

function parseRuleRevision(value: unknown, field: string): ReplayRunRuleRevision {
  const raw = objectValue(value, field);
  const kind = enumValue(
    raw.kind,
    ["FEE_POLICY", "LEVERAGE_CAP", "FUNDING_POLICY"] as const,
    `${field}.kind`,
  );
  const kindFields = kind === "FEE_POLICY"
    ? ["maker_fee_bps", "taker_fee_bps"]
    : kind === "LEVERAGE_CAP"
      ? ["max_leverage"]
      : ["funding_mode", "fixed_funding_rate", "funding_interval_ms"];
  const source = exactObject(raw, field, [
    "kind", "revision", "effective_cursor", "public_time", ...kindFields,
    "policy_hash", "fidelity", "reason", "command_id", "old", "new",
  ]);
  const oldValue = source.old === null ? null : jsonObject(source.old, `${field}.old`);
  const result: ReplayRunRuleRevision = {
    kind,
    revision: counter(source.revision, `${field}.revision`),
    effective_cursor: parseCursor(source.effective_cursor, `${field}.effective_cursor`),
    public_time: parseReplayPublicTime(source.public_time, `${field}.public_time`),
    policy_hash: digest(source.policy_hash, `${field}.policy_hash`),
    fidelity: stringValue(source.fidelity, `${field}.fidelity`, 128),
    reason: stringValue(source.reason, `${field}.reason`, 512),
    command_id: source.command_id === null
      ? null
      : identifier(source.command_id, `${field}.command_id`),
    old: oldValue,
    new: jsonObject(source.new, `${field}.new`),
    ...(kind === "FEE_POLICY" ? {
      maker_fee_bps: decimal(source.maker_fee_bps, `${field}.maker_fee_bps`),
      taker_fee_bps: decimal(source.taker_fee_bps, `${field}.taker_fee_bps`),
    } : {}),
    ...(kind === "LEVERAGE_CAP" ? {
      max_leverage: decimal(source.max_leverage, `${field}.max_leverage`),
    } : {}),
    ...(kind === "FUNDING_POLICY" ? {
      funding_mode: enumValue(
        source.funding_mode,
        ["OFF", "HISTORICAL_EXACT", "SANDBOX_FIXED"] as const,
        `${field}.funding_mode`,
      ),
      fixed_funding_rate: source.fixed_funding_rate === null
        ? null
        : decimal(source.fixed_funding_rate, `${field}.fixed_funding_rate`),
      funding_interval_ms: source.funding_interval_ms === null
        ? null
        : counter(source.funding_interval_ms, `${field}.funding_interval_ms`),
    } : {}),
  };
  return result;
}

export function parseReplayRunRulesResponse(value: unknown): ReplayRunRulesResponse {
  const source = exactObject(value, "run_rules", [
    "protocol", "schema_version", "run_id", "effective_cursor", "fee_policy",
    "leverage_policy", "funding_policy", "instrument_rules",
    "effective_leverage_by_track", "history",
  ]);
  if (source.protocol !== "replay.v2" || source.schema_version !== "replay.run-rules.v1") {
    throw new TypeError("run_rules schema is unsupported");
  }
  const fee = parseRuleRevision(source.fee_policy, "run_rules.fee_policy");
  const leverage = parseRuleRevision(source.leverage_policy, "run_rules.leverage_policy");
  const funding = parseRuleRevision(source.funding_policy, "run_rules.funding_policy");
  if (fee.kind !== "FEE_POLICY" || leverage.kind !== "LEVERAGE_CAP"
    || funding.kind !== "FUNDING_POLICY"
    || fee.maker_fee_bps === undefined || fee.taker_fee_bps === undefined
    || leverage.max_leverage === undefined || funding.funding_mode === undefined
    || funding.fixed_funding_rate === undefined
    || funding.funding_interval_ms === undefined) {
    throw new TypeError("run_rules active policies are inconsistent");
  }
  if (!Array.isArray(source.instrument_rules) || !Array.isArray(source.history)) {
    throw new TypeError("run_rules histories must be arrays");
  }
  const instrumentRules = source.instrument_rules.map((value, index): ReplayRunInstrumentRule => {
    const field = `run_rules.instrument_rules[${index}]`;
    const rule = exactObject(value, field, [
      "track_id", "revision", "effective_virtual_time_ms", "rule",
      "rule_hash", "fidelity", "immutable_exchange_rule",
    ]);
    if (rule.immutable_exchange_rule !== true) {
      throw new TypeError(`${field} must remain an immutable exchange rule`);
    }
    return {
      track_id: identifier(rule.track_id, `${field}.track_id`),
      revision: counter(rule.revision, `${field}.revision`),
      effective_virtual_time_ms: counter(
        rule.effective_virtual_time_ms,
        `${field}.effective_virtual_time_ms`,
      ),
      rule: jsonObject(rule.rule, `${field}.rule`),
      rule_hash: digest(rule.rule_hash, `${field}.rule_hash`),
      fidelity: stringValue(rule.fidelity, `${field}.fidelity`, 128),
      immutable_exchange_rule: true,
    };
  });
  const rawLeverage = objectValue(
    source.effective_leverage_by_track,
    "run_rules.effective_leverage_by_track",
  );
  const effectiveLeverage = Object.fromEntries(
    Object.entries(rawLeverage).map(([trackId, amount]) => [
      identifier(trackId, "run_rules.effective_leverage_by_track key"),
      decimal(amount, `run_rules.effective_leverage_by_track.${trackId}`),
    ]),
  );
  const history = source.history.map((item, index) => (
    parseRuleRevision(item, `run_rules.history[${index}]`)
  ));
  return {
    protocol: "replay.v2",
    schema_version: "replay.run-rules.v1",
    run_id: identifier(source.run_id, "run_rules.run_id"),
    effective_cursor: parseCursor(source.effective_cursor, "run_rules.effective_cursor"),
    fee_policy: {
      ...fee,
      kind: "FEE_POLICY",
      maker_fee_bps: fee.maker_fee_bps,
      taker_fee_bps: fee.taker_fee_bps,
    },
    leverage_policy: {
      ...leverage,
      kind: "LEVERAGE_CAP",
      max_leverage: leverage.max_leverage,
    },
    funding_policy: {
      ...funding,
      kind: "FUNDING_POLICY",
      funding_mode: funding.funding_mode,
      fixed_funding_rate: funding.fixed_funding_rate,
      funding_interval_ms: funding.funding_interval_ms,
    },
    instrument_rules: instrumentRules,
    effective_leverage_by_track: effectiveLeverage,
    history,
  };
}

function rejectPrivateReviewFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateReviewFields(item, `${field}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("_")
      || key === "archive_id"
      || key === "as_of_actual_ms"
      || key === "actual_time_ms"
      || key === "actual_replay_start_ms"
      || key === "actual_visible_history_start_ms") {
      throw new TypeError(`${field}.${key} crosses the review disclosure boundary`);
    }
    rejectPrivateReviewFields(item, `${field}.${key}`);
  }
}

function parseReviewProjection(value: unknown): ReplayReviewProjection {
  rejectPrivateReviewFields(value, "review.projection");
  const source = exactObject(value, "review.projection", [
    "schema_version", "run_id", "cursor", "tracks", "orders", "fills", "ledger",
    "markers", "liquidations", "books", "account", "account_hash", "rules",
    "viewer_state", "viewer_hash", "drawing_document_hash", "drawing_revision",
    "domain",
  ]);
  if (source.schema_version !== "replay.review.timeline.v1") {
    throw new TypeError("review projection schema is unsupported");
  }
  const objectArray = (input: unknown, field: string) => {
    if (!Array.isArray(input)) throw new TypeError(`${field} must be an array`);
    return input.map((item, index) => jsonObject(item, `${field}[${index}]`));
  };
  return {
    schema_version: "replay.review.timeline.v1",
    run_id: identifier(source.run_id, "review.projection.run_id"),
    cursor: parseCursor(source.cursor, "review.projection.cursor"),
    tracks: objectArray(source.tracks, "review.projection.tracks"),
    orders: objectArray(source.orders, "review.projection.orders"),
    fills: objectArray(source.fills, "review.projection.fills"),
    ledger: objectArray(source.ledger, "review.projection.ledger"),
    markers: objectArray(source.markers, "review.projection.markers"),
    liquidations: objectArray(source.liquidations, "review.projection.liquidations"),
    books: objectArray(source.books, "review.projection.books"),
    account: jsonObject(source.account, "review.projection.account"),
    account_hash: digest(source.account_hash, "review.projection.account_hash"),
    rules: parseReplayRunRulesResponse(source.rules),
    viewer_state: jsonObject(source.viewer_state, "review.projection.viewer_state"),
    viewer_hash: digest(source.viewer_hash, "review.projection.viewer_hash"),
    drawing_document_hash: source.drawing_document_hash === null
      ? null
      : digest(source.drawing_document_hash, "review.projection.drawing_document_hash"),
    drawing_revision: counter(source.drawing_revision, "review.projection.drawing_revision"),
    domain: jsonObject(source.domain, "review.projection.domain"),
  };
}

function parseImmutabilityProof(value: unknown): ReplayReviewImmutabilityProof {
  const source = exactObject(value, "review.immutability_proof", [
    "original_account_hash", "original_ledger_tail_hash",
    "original_viewer_revision", "original_viewer_hash", "verified",
  ]);
  if (source.verified !== true) throw new TypeError("review immutability proof is not verified");
  return {
    original_account_hash: digest(
      source.original_account_hash,
      "review.immutability_proof.original_account_hash",
    ),
    original_ledger_tail_hash: digest(
      source.original_ledger_tail_hash,
      "review.immutability_proof.original_ledger_tail_hash",
    ),
    original_viewer_revision: counter(
      source.original_viewer_revision,
      "review.immutability_proof.original_viewer_revision",
    ),
    original_viewer_hash: digest(
      source.original_viewer_hash,
      "review.immutability_proof.original_viewer_hash",
    ),
    verified: true,
  };
}

export function parseReplayPublicTime(value: unknown, field = "public_time"): ReplayPublicTime {
  const source = exactObject(value, field, ["policy", "timeline_ms", "relative_ms", "sequence", "label"]);
  return {
    policy: enumValue(source.policy, TIME_POLICIES, `${field}.policy`),
    timeline_ms: counter(source.timeline_ms, `${field}.timeline_ms`),
    relative_ms: safeInteger(source.relative_ms, `${field}.relative_ms`),
    sequence: counter(source.sequence, `${field}.sequence`),
    label: stringValue(source.label, `${field}.label`, 64),
  };
}

export function parseReplayPublicTimeBatchResponse(
  value: unknown,
  {
    maxItems = 2_000,
    allowEmpty = false,
  }: {
    readonly maxItems?: number;
    readonly allowEmpty?: boolean;
  } = {},
): ReplayPublicTimeBatchResponse {
  const source = exactObject(value, "public_times", [
    "protocol", "run_id", "policy", "items",
  ]);
  if (source.protocol !== "replay.v2") {
    throw new TypeError("public_times.protocol is unsupported");
  }
  if (!Array.isArray(source.items)
    || (!allowEmpty && source.items.length < 1)
    || source.items.length > maxItems) {
    throw new TypeError("public_times.items must be a bounded non-empty array");
  }
  const policy = enumValue(source.policy, TIME_POLICIES, "public_times.policy");
  const items = source.items.map((value, index): ReplayPublicTimeBatchItem => {
    const field = `public_times.items[${index}]`;
    const item = exactObject(value, field, ["input_timeline_ms", "public_time"]);
    const input = counter(item.input_timeline_ms, `${field}.input_timeline_ms`);
    const publicTime = parseReplayPublicTime(item.public_time, `${field}.public_time`);
    if (publicTime.policy !== policy) {
      throw new TypeError(`${field} contradicts the batch policy`);
    }
    return { input_timeline_ms: input, public_time: publicTime };
  });
  return {
    protocol: "replay.v2",
    run_id: identifier(source.run_id, "public_times.run_id"),
    policy,
    items,
  };
}

function parseStartSelection(value: unknown): ReplayStartSelection {
  const source = exactObject(value, "integrity.start_selection", [
    "schema_version", "start_mode", "seed_source", "seed_disclosed",
    "random_seed", "dataset_epoch", "parent_selection_hash", "selection_hash",
    "public_start", "public_end",
  ]);
  if (source.schema_version !== "replay.start-selection.v1") {
    throw new TypeError("integrity.start_selection schema is unsupported");
  }
  const seedDisclosed = boolValue(
    source.seed_disclosed,
    "integrity.start_selection.seed_disclosed",
  );
  const randomSeed = source.random_seed === null
    ? null
    : counter(source.random_seed, "integrity.start_selection.random_seed");
  if (seedDisclosed !== (randomSeed !== null)) {
    throw new TypeError("integrity.start_selection seed disclosure is inconsistent");
  }
  return {
    schema_version: "replay.start-selection.v1",
    start_mode: enumValue(
      source.start_mode,
      ["MANUAL", "RANDOM"] as const,
      "integrity.start_selection.start_mode",
    ),
    seed_source: enumValue(
      source.seed_source,
      ["SERVER", "MANUAL", "LEGACY_CLIENT", "FORK"] as const,
      "integrity.start_selection.seed_source",
    ),
    seed_disclosed: seedDisclosed,
    random_seed: randomSeed,
    dataset_epoch: digest(
      source.dataset_epoch,
      "integrity.start_selection.dataset_epoch",
    ),
    parent_selection_hash: source.parent_selection_hash === null
      ? null
      : digest(
        source.parent_selection_hash,
        "integrity.start_selection.parent_selection_hash",
      ),
    selection_hash: digest(
      source.selection_hash,
      "integrity.start_selection.selection_hash",
    ),
    public_start: parseReplayPublicTime(
      source.public_start,
      "integrity.start_selection.public_start",
    ),
    public_end: parseReplayPublicTime(
      source.public_end,
      "integrity.start_selection.public_end",
    ),
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
    "active_rule", "start_selection", "public_time", "mutations",
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
    start_selection: parseStartSelection(source.start_selection),
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
    "protocol", "schema_version", "review_id", "run_id", "read_only",
    "selected_event_id", "selected_timeline_sequence", "selected_state_hash",
    "original_state_hash", "original_cursor", "dataset_epoch", "cursor_revision",
    "playback_state", "playback_rate", "projection", "drawing_document",
    "immutability_proof", "budget", "events", "jump_targets",
  ]);
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.review.timeline.v1") {
    throw new TypeError("review schema is unsupported");
  }
  if (source.read_only !== true) throw new TypeError("review must be read-only");
  if (!Array.isArray(source.events) || !Array.isArray(source.jump_targets)) {
    throw new TypeError("review events and jump targets must be arrays");
  }
  const events = source.events.map((item, index): ReplayReviewEvent => {
    const field = `review.events[${index}]`;
    const event = exactObject(item, field, [
      "event_id", "event_type", "category", "timeline_sequence", "checkpoint_id",
      "source_sequence", "event_sequence", "state_hash", "account_hash",
      "ledger_tail_hash", "viewer_revision", "anchor_set_hash", "event_hash",
      "public_time", "detail",
    ]);
    return {
      event_id: identifier(event.event_id, `${field}.event_id`),
      event_type: identifier(event.event_type, `${field}.event_type`),
      category: identifier(event.category, `${field}.category`),
      timeline_sequence: counter(event.timeline_sequence, `${field}.timeline_sequence`),
      checkpoint_id: counter(event.checkpoint_id, `${field}.checkpoint_id`),
      source_sequence: counter(event.source_sequence, `${field}.source_sequence`),
      event_sequence: counter(event.event_sequence, `${field}.event_sequence`),
      state_hash: digest(event.state_hash, `${field}.state_hash`),
      account_hash: digest(event.account_hash, `${field}.account_hash`),
      ledger_tail_hash: digest(event.ledger_tail_hash, `${field}.ledger_tail_hash`),
      viewer_revision: counter(event.viewer_revision, `${field}.viewer_revision`),
      anchor_set_hash: digest(event.anchor_set_hash, `${field}.anchor_set_hash`),
      event_hash: digest(event.event_hash, `${field}.event_hash`),
      public_time: parseReplayPublicTime(event.public_time, `${field}.public_time`),
      detail: event.detail === null ? null : jsonObject(event.detail, `${field}.detail`),
    };
  });
  const jumpTargets = source.jump_targets.map((item, index) => {
    const target = exactObject(
      item,
      `review.jump_targets[${index}]`,
      ["event_id", "event_type", "category"],
    );
    return {
      event_id: identifier(target.event_id, `review.jump_targets[${index}].event_id`),
      event_type: identifier(target.event_type, `review.jump_targets[${index}].event_type`),
      category: identifier(target.category, `review.jump_targets[${index}].category`),
    };
  });
  const selectedEventId = identifier(source.selected_event_id, "review.selected_event_id");
  const selectedSequence = counter(
    source.selected_timeline_sequence,
    "review.selected_timeline_sequence",
  );
  if (!events.some((event) => (
    event.event_id === selectedEventId && event.timeline_sequence === selectedSequence
  ))) {
    throw new TypeError("review selected event is missing");
  }
  const projection = parseReviewProjection(source.projection);
  const runId = identifier(source.run_id, "review.run_id");
  if (projection.run_id !== runId || projection.rules.run_id !== runId) {
    throw new TypeError("review projection run identity drifted");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.timeline.v1",
    review_id: identifier(source.review_id, "review.review_id"),
    run_id: runId,
    read_only: true,
    selected_event_id: selectedEventId,
    selected_timeline_sequence: selectedSequence,
    selected_state_hash: digest(source.selected_state_hash, "review.selected_state_hash"),
    original_state_hash: digest(source.original_state_hash, "review.original_state_hash"),
    original_cursor: parseCursor(source.original_cursor, "review.original_cursor"),
    dataset_epoch: digest(source.dataset_epoch, "review.dataset_epoch"),
    cursor_revision: counter(source.cursor_revision, "review.cursor_revision"),
    playback_state: enumValue(
      source.playback_state,
      ["PAUSED", "PLAYING"] as const,
      "review.playback_state",
    ),
    playback_rate: enumValue(
      source.playback_rate,
      ["0.25", "0.5", "1", "2", "4", "8"] as const,
      "review.playback_rate",
    ),
    projection,
    drawing_document: source.drawing_document === null
      ? null
      : jsonObject(source.drawing_document, "review.drawing_document"),
    immutability_proof: parseImmutabilityProof(source.immutability_proof),
    budget: parseReviewBudget(source.budget),
    events,
    jump_targets: jumpTargets,
  };
}

export function parseReplayReviewControlResponse(value: unknown): ReplayReviewControlResponse {
  const source = exactObject(value, "review_control", [
    "protocol", "schema_version", "review_id", "run_id", "read_only",
    "selected_event_id", "selected_timeline_sequence", "selected_state_hash",
    "original_state_hash", "cursor_revision", "playback_state", "playback_rate",
    "selected_event", "projection", "drawing_document", "immutability_proof", "budget",
  ]);
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.review.timeline.v1"
    || source.read_only !== true) {
    throw new TypeError("review control schema is unsupported");
  }
  const selected = exactObject(source.selected_event, "review_control.selected_event", [
    "event_id", "event_type", "category", "timeline_sequence", "public_time", "detail",
  ]);
  const selectedEventId = identifier(
    source.selected_event_id,
    "review_control.selected_event_id",
  );
  const selectedSequence = counter(
    source.selected_timeline_sequence,
    "review_control.selected_timeline_sequence",
  );
  if (selected.event_id !== selectedEventId
    || selected.timeline_sequence !== selectedSequence) {
    throw new TypeError("review control selected event is inconsistent");
  }
  const runId = identifier(source.run_id, "review_control.run_id");
  const projection = parseReviewProjection(source.projection);
  if (projection.run_id !== runId || projection.rules.run_id !== runId) {
    throw new TypeError("review control projection run identity drifted");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.timeline.v1",
    review_id: identifier(source.review_id, "review_control.review_id"),
    run_id: runId,
    read_only: true,
    selected_event_id: selectedEventId,
    selected_timeline_sequence: selectedSequence,
    selected_state_hash: digest(
      source.selected_state_hash,
      "review_control.selected_state_hash",
    ),
    original_state_hash: digest(
      source.original_state_hash,
      "review_control.original_state_hash",
    ),
    cursor_revision: counter(source.cursor_revision, "review_control.cursor_revision"),
    playback_state: enumValue(
      source.playback_state,
      ["PAUSED", "PLAYING"] as const,
      "review_control.playback_state",
    ),
    playback_rate: enumValue(
      source.playback_rate,
      ["0.25", "0.5", "1", "2", "4", "8"] as const,
      "review_control.playback_rate",
    ),
    selected_event: {
      event_id: selectedEventId,
      event_type: identifier(
        selected.event_type,
        "review_control.selected_event.event_type",
      ),
      category: identifier(
        selected.category,
        "review_control.selected_event.category",
      ),
      timeline_sequence: selectedSequence,
      public_time: parseReplayPublicTime(
        selected.public_time,
        "review_control.selected_event.public_time",
      ),
      detail: selected.detail === null
        ? null
        : jsonObject(selected.detail, "review_control.selected_event.detail"),
    },
    projection,
    drawing_document: source.drawing_document === null
      ? null
      : jsonObject(source.drawing_document, "review_control.drawing_document"),
    immutability_proof: parseImmutabilityProof(source.immutability_proof),
    budget: parseReviewBudget(source.budget, "review_control.budget"),
  };
}

export function parseReplayReviewForkResponse(value: unknown): ReplayReviewForkResponse {
  const source = exactObject(value, "fork", [
    "protocol", "parent_run_id", "parent_event_id", "parent_timeline_sequence",
    "anchor_set_hash", "run", "tracks", "account_audit",
  ]);
  if (source.protocol !== "replay.v2") throw new TypeError("fork.protocol is unsupported");
  const run = jsonObject(source.run, "fork.run");
  if (!Array.isArray(source.tracks)) throw new TypeError("fork.tracks must be an array");
  return {
    protocol: "replay.v2",
    parent_run_id: identifier(source.parent_run_id, "fork.parent_run_id"),
    parent_event_id: identifier(source.parent_event_id, "fork.parent_event_id"),
    parent_timeline_sequence: counter(
      source.parent_timeline_sequence,
      "fork.parent_timeline_sequence",
    ),
    anchor_set_hash: digest(source.anchor_set_hash, "fork.anchor_set_hash"),
    run: {
      ...run,
      run_id: identifier(run.run_id, "fork.run.run_id"),
      adapter_session_id: identifier(run.adapter_session_id, "fork.run.adapter_session_id"),
      dataset_epoch: digest(run.dataset_epoch, "fork.run.dataset_epoch"),
      state_hash: digest(run.state_hash, "fork.run.state_hash"),
    },
    tracks: source.tracks.map((track, index) => (
      jsonObject(track, `fork.tracks[${index}]`)
    )),
    account_audit: source.account_audit === null
      ? null
      : jsonObject(source.account_audit, "fork.account_audit"),
  };
}

export function parseReplayDrawingDocumentResponse(
  value: unknown,
): ReplayDrawingDocumentResponse {
  const source = exactObject(value, "drawing_document", [
    "protocol", "schema_version", "run_id", "document_hash", "revision",
    "entity_count", "deduplicated", "budget",
  ]);
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.review.drawing-document.v1") {
    throw new TypeError("drawing document response schema is unsupported");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.drawing-document.v1",
    run_id: identifier(source.run_id, "drawing_document.run_id"),
    document_hash: digest(source.document_hash, "drawing_document.document_hash"),
    revision: counter(source.revision, "drawing_document.revision"),
    entity_count: counter(source.entity_count, "drawing_document.entity_count"),
    deduplicated: boolValue(source.deduplicated, "drawing_document.deduplicated"),
    budget: parseReviewBudget(source.budget, "drawing_document.budget"),
  };
}

export function parseReplayCurrentDrawingDocumentResponse(
  value: unknown,
): ReplayCurrentDrawingDocumentResponse {
  const source = exactObject(value, "current_drawing", [
    "protocol", "schema_version", "run_id", "document_hash", "revision",
    "entity_count", "document", "budget",
  ]);
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.review.drawing-current.v1") {
    throw new TypeError("current drawing response schema is unsupported");
  }
  const runId = identifier(source.run_id, "current_drawing.run_id");
  const revision = counter(source.revision, "current_drawing.revision");
  const entityCount = counter(
    source.entity_count,
    "current_drawing.entity_count",
  );
  if (entityCount > 512) {
    throw new TypeError("current_drawing.entity_count exceeds the hard bound");
  }
  if (source.document === null) {
    if (source.document_hash !== null || revision !== 0 || entityCount !== 0) {
      throw new TypeError("empty current drawing metadata is inconsistent");
    }
    return {
      protocol: "replay.v2",
      schema_version: "replay.review.drawing-current.v1",
      run_id: runId,
      document_hash: null,
      revision: 0,
      entity_count: 0,
      document: null,
      budget: parseReviewBudget(source.budget, "current_drawing.budget"),
    };
  }
  if (revision < 1 || source.document_hash === null) {
    throw new TypeError("current drawing content requires a revision and hash");
  }
  const rawDocument = exactObject(source.document, "current_drawing.document", [
    "documentSchemaVersion", "scopeKey", "documentRevision", "updatedAt", "entities",
  ]);
  if (rawDocument.documentSchemaVersion !== 1
    || typeof rawDocument.scopeKey !== "string"
    || !rawDocument.scopeKey.startsWith("replay-run:")
    || !Number.isSafeInteger(rawDocument.documentRevision)
    || (rawDocument.documentRevision as number) < 0
    || !Number.isSafeInteger(rawDocument.updatedAt)
    || (rawDocument.updatedAt as number) < 0
    || !Array.isArray(rawDocument.entities)
    || rawDocument.entities.length !== entityCount) {
    throw new TypeError("current drawing document is not a bounded canonical record");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.drawing-current.v1",
    run_id: runId,
    document_hash: digest(
      source.document_hash,
      "current_drawing.document_hash",
    ),
    revision,
    entity_count: entityCount,
    document: jsonObject(source.document, "current_drawing.document"),
    budget: parseReviewBudget(source.budget, "current_drawing.budget"),
  };
}

export function parseReplayReviewMarkerResponse(
  value: unknown,
): ReplayReviewMarkerResponse {
  const source = exactObject(value, "review_marker", [
    "protocol", "schema_version", "run_id", "marker_id", "command_id", "text",
    "content_hash", "event_id", "timeline_sequence", "deduplicated", "budget",
  ]);
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.review.marker.v1") {
    throw new TypeError("review marker response schema is unsupported");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.review.marker.v1",
    run_id: identifier(source.run_id, "review_marker.run_id"),
    marker_id: identifier(source.marker_id, "review_marker.marker_id"),
    command_id: identifier(source.command_id, "review_marker.command_id"),
    text: stringValue(source.text, "review_marker.text", 500),
    content_hash: digest(source.content_hash, "review_marker.content_hash"),
    event_id: identifier(source.event_id, "review_marker.event_id"),
    timeline_sequence: counter(
      source.timeline_sequence,
      "review_marker.timeline_sequence",
    ),
    deduplicated: boolValue(source.deduplicated, "review_marker.deduplicated"),
    budget: parseReviewBudget(source.budget, "review_marker.budget"),
  };
}

export function parseReplayTrainingReportResponse(value: unknown): ReplayTrainingReportResponse {
  const source = objectValue(value, "training_report");
  const hasActual = Object.hasOwn(source, "actual_history");
  const exact = exactObject(source, "training_report", [
    "protocol", "run_id", "data_fidelity", "execution_fidelity", "revealed", "report",
    "integrity", "public_time_index", "modelled_account", "account_audit",
    "liquidation_channel_contract", ...(hasActual ? ["actual_history"] : []),
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
  const publicTimeIndex = parseReplayPublicTimeBatchResponse(
    exact.public_time_index,
    { maxItems: 20_000, allowEmpty: true },
  );
  if (integrity.run_id !== runId || integrity.revealed !== parsed.revealed) {
    throw new TypeError("training report integrity does not reconcile");
  }
  if (publicTimeIndex.run_id !== runId
    || publicTimeIndex.policy !== integrity.effective_time_disclosure_policy) {
    throw new TypeError("training report public-time index does not reconcile");
  }
  const modelledAccount = parseReplayTrainingPortfolio(exact.modelled_account);
  const accountAudit = exact.account_audit === null
    ? null
    : parseReplayAccountAuditResponse(exact.account_audit);
  const liquidationChannels = exactObject(
    exact.liquidation_channel_contract,
    "training_report.liquidation_channel_contract",
    ["simulated_account", "historical_market"],
  );
  if (liquidationChannels.simulated_account
      !== "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED"
    || liquidationChannels.historical_market !== "INDEPENDENT_FEED_OR_UNSUPPORTED"
    || (modelledAccount.schema_version === "replay.training.portfolio.v2"
      && modelledAccount.account_history.mode === "HISTORICAL_EXACT"
      && accountAudit === null)) {
    throw new TypeError("training report account/liquidation audit contract is inconsistent");
  }
  return {
    protocol: "replay.v2",
    run_id: runId,
    data_fidelity: parsed.data_fidelity,
    execution_fidelity: parsed.execution_fidelity,
    revealed: parsed.revealed,
    report: parsed.report,
    integrity,
    public_time_index: publicTimeIndex,
    modelled_account: modelledAccount,
    account_audit: accountAudit,
    liquidation_channel_contract: {
      simulated_account: "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED",
      historical_market: "INDEPENDENT_FEED_OR_UNSUPPORTED",
    },
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
