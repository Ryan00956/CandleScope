export const REPLAY_V2_PROTOCOL = "replay.v2" as const;
export const REPLAY_V2_SCHEMA_VERSION = "replay.contract.v2.phase0" as const;

function enumValues<const T extends readonly string[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

export const REPLAY_V2_ENUMS = Object.freeze({
  run_state: enumValues("PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"),
  track_state: enumValues("DORMANT", "PREPARING", "READY", "DEGRADED", "ERROR"),
  source_kind: enumValues("BAR", "AGG_TRADE"),
  start_mode: enumValues("MANUAL", "RANDOM"),
  integrity_mode: enumValues("CHALLENGE", "PRACTICE", "SANDBOX"),
  time_disclosure_policy: enumValues(
    "NONE",
    "HIDE_YEAR",
    "HIDE_MONTH",
    "HIDE_DAY",
    "HIDE_HOUR",
    "HIDE_MINUTE",
    "HIDE_ALL",
  ),
  subscription_tier: enumValues("NONE", "WARM", "FULL"),
  capability_kind: enumValues(
    "OHLCV",
    "INDICATORS",
    "AGG_TRADE_TAPE",
    "ORDER_FLOW",
    "OPEN_INTEREST",
    "MARKET_LIQUIDATIONS",
    "MARK_PRICE",
    "INDEX_PRICE",
    "BASIS",
    "FUNDING",
    "ORDER_BOOK",
    "SIMULATED_LIQUIDATION",
  ),
  capability_state: enumValues(
    "AVAILABLE_EXACT",
    "AVAILABLE_APPROX",
    "UNSUPPORTED_NO_HISTORY",
    "UNSUPPORTED_SOURCE_MODE",
    "LOADING",
    "DEGRADED",
  ),
  fast_forward_plan: enumValues(
    "CHECKPOINT_JUMP",
    "AGGREGATE_SCAN",
    "FULL_EVENT_SCAN",
    "BLOCKED",
  ),
  book_mode: enumValues("OFF", "BOOK_ASSISTED_REQUIRED"),
  margin_mode: enumValues("CROSS", "ISOLATED"),
  execution_model: enumValues("TOUCH_OR_TAPE_V2"),
  command_type: enumValues(
    "acquire_controller",
    "heartbeat_controller",
    "release_controller",
    "takeover_controller",
    "play",
    "pause",
    "set_speed",
    "step_event",
    "step_base",
    "step_display",
    "advance_by",
    "advance_to",
    "cancel_advance",
    "select_track",
    "set_display_interval",
    "set_chart_type",
    "record_view_action",
    "add_track",
    "set_subscription_tier",
    "remove_unowned_track",
    "place_order",
    "cancel_order",
    "close_position",
    "allocate_isolated_margin",
    "deposit",
    "withdraw",
    "change_fee_policy",
    "change_leverage_cap",
    "change_funding_policy",
    "reveal_time",
    "save",
    "end",
    "fork",
    "start_review",
  ),
  event_type: enumValues(
    "RUN_SNAPSHOT",
    "RUN_STATE_CHANGED",
    "TRACK_PROJECTION",
    "ACCOUNT_PROJECTION",
    "AUDIT_EVENT",
    "ADVANCE_PROGRESS",
    "RESYNC_REQUIRED",
  ),
});

type EnumValue<T extends readonly string[]> = T[number];

export type ReplayV2RunState = EnumValue<typeof REPLAY_V2_ENUMS.run_state>;
export type ReplayV2TrackState = EnumValue<typeof REPLAY_V2_ENUMS.track_state>;
export type ReplayV2SourceKind = EnumValue<typeof REPLAY_V2_ENUMS.source_kind>;
export type ReplayV2StartMode = EnumValue<typeof REPLAY_V2_ENUMS.start_mode>;
export type ReplayV2IntegrityMode = EnumValue<typeof REPLAY_V2_ENUMS.integrity_mode>;
export type ReplayV2TimeDisclosurePolicy = EnumValue<
  typeof REPLAY_V2_ENUMS.time_disclosure_policy
>;
export type ReplayV2SubscriptionTier = EnumValue<typeof REPLAY_V2_ENUMS.subscription_tier>;
export type ReplayV2CapabilityKind = EnumValue<typeof REPLAY_V2_ENUMS.capability_kind>;
export type ReplayV2CapabilityState = EnumValue<typeof REPLAY_V2_ENUMS.capability_state>;
export type ReplayV2CommandType = EnumValue<typeof REPLAY_V2_ENUMS.command_type>;
export type ReplayV2EventType = EnumValue<typeof REPLAY_V2_ENUMS.event_type>;

export interface ReplayV2Cursor {
  readonly virtual_time_ms: number;
  readonly source_sequence: number;
  readonly revision: number;
}

export interface ReplayV2TrainingRun {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly state: ReplayV2RunState;
  readonly source_kind: ReplayV2SourceKind;
  readonly start_mode: ReplayV2StartMode;
  readonly book_mode: EnumValue<typeof REPLAY_V2_ENUMS.book_mode>;
  readonly integrity_mode: ReplayV2IntegrityMode;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly initial_equity: string;
  readonly active_rule_revision: number;
  readonly cursor: ReplayV2Cursor;
}

export interface ReplayV2MarketTrack {
  readonly run_id: string;
  readonly track_id: string;
  readonly state: ReplayV2TrackState;
  readonly source_kind: ReplayV2SourceKind;
  readonly subscription_tier: ReplayV2SubscriptionTier;
  readonly cursor: ReplayV2Cursor;
  readonly forced_full_reasons: readonly string[];
  readonly capabilities: Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>>;
}

type ReplayV2Json = null | string | boolean | number | readonly ReplayV2Json[] | {
  readonly [key: string]: ReplayV2Json;
};

export interface ReplayV2Command {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly command_id: string;
  readonly client_instance_id: string;
  readonly expected_revision: number;
  readonly expected_cursor: ReplayV2Cursor;
  readonly type: ReplayV2CommandType;
  readonly payload: Readonly<Record<string, ReplayV2Json>>;
}

export interface ReplayV2Event {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly sequence: number;
  readonly revision: number;
  readonly cursor: ReplayV2Cursor;
  readonly type: ReplayV2EventType;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly capabilities: Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>>;
  readonly data: Readonly<Record<string, ReplayV2Json>>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POSITIVE_CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

function objectValue(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  fieldName: string,
  expected: readonly string[],
): Record<string, unknown> {
  const payload = objectValue(value, fieldName);
  const keys = Object.keys(payload);
  const missing = expected.filter((key) => !Object.hasOwn(payload, key));
  const unknown = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0) throw new TypeError(`${fieldName} missing ${missing.join(", ")}`);
  if (unknown.length > 0) throw new TypeError(`${fieldName} has unknown ${unknown.join(", ")}`);
  return payload;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fieldName: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${fieldName} is unsupported`);
  }
  return value as T[number];
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

function timestamp(value: unknown, fieldName: string): number {
  const parsed = counter(value, fieldName);
  if (parsed > MAX_TIMESTAMP_MS) throw new TypeError(`${fieldName} is out of range`);
  return parsed;
}

function positiveDecimal(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !POSITIVE_CANONICAL_DECIMAL.test(value) || value === "0") {
    throw new TypeError(`${fieldName} must be a positive canonical Decimal string`);
  }
  return value;
}

function parseCursor(value: unknown, fieldName: string): ReplayV2Cursor {
  const cursor = exactObject(
    value,
    fieldName,
    ["virtual_time_ms", "source_sequence", "revision"],
  );
  return {
    virtual_time_ms: timestamp(cursor.virtual_time_ms, `${fieldName}.virtual_time_ms`),
    source_sequence: counter(cursor.source_sequence, `${fieldName}.source_sequence`),
    revision: counter(cursor.revision, `${fieldName}.revision`),
  };
}

function jsonValue(value: unknown, fieldName: string): ReplayV2Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${fieldName} cannot contain binary floats or unsafe integers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => jsonValue(child, `${fieldName}[${index}]`));
  }
  const payload = objectValue(value, fieldName);
  return Object.fromEntries(
    Object.entries(payload).map(([key, child]) => [key, jsonValue(child, `${fieldName}.${key}`)]),
  );
}

function jsonObject(value: unknown, fieldName: string): Readonly<Record<string, ReplayV2Json>> {
  const payload = objectValue(value, fieldName);
  return Object.fromEntries(
    Object.entries(payload).map(([key, child]) => [key, jsonValue(child, `${fieldName}.${key}`)]),
  );
}

function capabilities(
  value: unknown,
): Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>> {
  const payload = objectValue(value, "capabilities");
  const parsed: Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>> = {};
  for (const [rawKind, rawState] of Object.entries(payload)) {
    const kind = enumValue(rawKind, REPLAY_V2_ENUMS.capability_kind, "capability kind");
    parsed[kind] = enumValue(rawState, REPLAY_V2_ENUMS.capability_state, "capability state");
  }
  return parsed;
}

export function parseReplayV2TrainingRun(value: unknown): ReplayV2TrainingRun {
  const run = exactObject(value, "run", [
    "protocol",
    "run_id",
    "state",
    "source_kind",
    "start_mode",
    "book_mode",
    "integrity_mode",
    "time_disclosure_policy",
    "initial_equity",
    "active_rule_revision",
    "cursor",
  ]);
  if (run.protocol !== REPLAY_V2_PROTOCOL) throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(run.run_id, "run_id"),
    state: enumValue(run.state, REPLAY_V2_ENUMS.run_state, "state"),
    source_kind: enumValue(run.source_kind, REPLAY_V2_ENUMS.source_kind, "source_kind"),
    start_mode: enumValue(run.start_mode, REPLAY_V2_ENUMS.start_mode, "start_mode"),
    book_mode: enumValue(run.book_mode, REPLAY_V2_ENUMS.book_mode, "book_mode"),
    integrity_mode: enumValue(run.integrity_mode, REPLAY_V2_ENUMS.integrity_mode, "integrity_mode"),
    time_disclosure_policy: enumValue(
      run.time_disclosure_policy,
      REPLAY_V2_ENUMS.time_disclosure_policy,
      "time_disclosure_policy",
    ),
    initial_equity: positiveDecimal(run.initial_equity, "initial_equity"),
    active_rule_revision: counter(run.active_rule_revision, "active_rule_revision"),
    cursor: parseCursor(run.cursor, "cursor"),
  };
}

export function parseReplayV2MarketTrack(
  value: unknown,
  expectedSource?: ReplayV2SourceKind,
): ReplayV2MarketTrack {
  const track = exactObject(value, "track", [
    "run_id",
    "track_id",
    "state",
    "source_kind",
    "subscription_tier",
    "cursor",
    "forced_full_reasons",
    "capabilities",
  ]);
  const sourceKind = enumValue(track.source_kind, REPLAY_V2_ENUMS.source_kind, "source_kind");
  if (expectedSource !== undefined && sourceKind !== expectedSource) {
    throw new TypeError("track source_kind must match TrainingRun source_kind");
  }
  if (!Array.isArray(track.forced_full_reasons)) {
    throw new TypeError("forced_full_reasons must be an array");
  }
  const reasons = track.forced_full_reasons.map((reason) => identifier(reason, "forced_full_reasons"));
  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError("forced_full_reasons must be unique");
  }
  return {
    run_id: identifier(track.run_id, "run_id"),
    track_id: identifier(track.track_id, "track_id"),
    state: enumValue(track.state, REPLAY_V2_ENUMS.track_state, "state"),
    source_kind: sourceKind,
    subscription_tier: enumValue(
      track.subscription_tier,
      REPLAY_V2_ENUMS.subscription_tier,
      "subscription_tier",
    ),
    cursor: parseCursor(track.cursor, "cursor"),
    forced_full_reasons: reasons,
    capabilities: capabilities(track.capabilities),
  };
}

export function parseReplayV2Command(value: unknown): ReplayV2Command {
  const command = exactObject(value, "command", [
    "protocol",
    "run_id",
    "command_id",
    "client_instance_id",
    "expected_revision",
    "expected_cursor",
    "type",
    "payload",
  ]);
  if (command.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  const expectedRevision = counter(command.expected_revision, "expected_revision");
  const expectedCursor = parseCursor(command.expected_cursor, "expected_cursor");
  if (expectedCursor.revision !== expectedRevision) {
    throw new TypeError("expected_cursor.revision must equal expected_revision");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(command.run_id, "run_id"),
    command_id: identifier(command.command_id, "command_id"),
    client_instance_id: identifier(command.client_instance_id, "client_instance_id"),
    expected_revision: expectedRevision,
    expected_cursor: expectedCursor,
    type: enumValue(command.type, REPLAY_V2_ENUMS.command_type, "command type"),
    payload: jsonObject(command.payload, "payload"),
  };
}

const DISCLOSURE_RANK = new Map(
  REPLAY_V2_ENUMS.time_disclosure_policy.map((policy, rank) => [policy, rank]),
);

export function assertReplayV2NoDisclosureDowngrade(
  authoritative: ReplayV2TimeDisclosurePolicy,
  candidate: ReplayV2TimeDisclosurePolicy,
): void {
  const authoritativeRank = DISCLOSURE_RANK.get(authoritative);
  const candidateRank = DISCLOSURE_RANK.get(candidate);
  if (authoritativeRank === undefined || candidateRank === undefined) {
    throw new TypeError("time_disclosure_policy is unsupported");
  }
  if (candidateRank < authoritativeRank) {
    throw new TypeError("time_disclosure_policy downgrade requires an audited reveal event");
  }
}

export function parseReplayV2Event(
  value: unknown,
  authoritativePolicy?: ReplayV2TimeDisclosurePolicy,
): ReplayV2Event {
  const event = exactObject(value, "event", [
    "protocol",
    "run_id",
    "sequence",
    "revision",
    "cursor",
    "type",
    "time_disclosure_policy",
    "capabilities",
    "data",
  ]);
  if (event.protocol !== REPLAY_V2_PROTOCOL) throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  const sequence = counter(event.sequence, "sequence");
  if (sequence === 0) throw new TypeError("sequence must be positive");
  const revision = counter(event.revision, "revision");
  const cursor = parseCursor(event.cursor, "cursor");
  if (cursor.revision !== revision) throw new TypeError("cursor.revision must equal event revision");
  const policy = enumValue(
    event.time_disclosure_policy,
    REPLAY_V2_ENUMS.time_disclosure_policy,
    "time_disclosure_policy",
  );
  if (authoritativePolicy !== undefined) {
    assertReplayV2NoDisclosureDowngrade(authoritativePolicy, policy);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(event.run_id, "run_id"),
    sequence,
    revision,
    cursor,
    type: enumValue(event.type, REPLAY_V2_ENUMS.event_type, "event type"),
    time_disclosure_policy: policy,
    capabilities: capabilities(event.capabilities),
    data: jsonObject(event.data, "data"),
  };
}

const replayV2EnvironmentFlag: unknown = (import.meta as {
  readonly env?: { readonly VITE_REPLAY_PRODUCT_V2_ENABLED?: unknown };
}).env?.VITE_REPLAY_PRODUCT_V2_ENABLED;

export function replayV2ProductFlagEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true";
}

export const REPLAY_PRODUCT_V2_ENABLED = replayV2ProductFlagEnabled(
  typeof replayV2EnvironmentFlag === "string" ? replayV2EnvironmentFlag : undefined,
);
