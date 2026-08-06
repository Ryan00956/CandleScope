const STORAGE_PROTOCOL = "replay.storage.inventory.v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReplayStorageCategoryName =
  | "segments"
  | "historical_books"
  | "account_history"
  | "review_evidence";

export type ReplayStorageGcProtocol =
  | "replay.data.gc.v1"
  | "replay.historical-book.gc.v1"
  | "replay.account-history.gc.v1";

export interface ReplayStorageSummary {
  readonly object_count: number;
  readonly ready_count: number;
  readonly evicted_count: number;
  readonly quarantined_count: number;
  readonly pinned_count: number;
  readonly local_bytes: number;
  readonly max_bytes: number;
  readonly pressure_bps: number;
  readonly truncated: boolean;
}

export interface ReplayStorageObjectItem {
  readonly object_id: string;
  readonly source_kind: string;
  readonly identity: {
    readonly exchange: string;
    readonly market_type: string;
    readonly symbol: string;
    readonly base_interval?: string | null;
  };
  readonly health: string;
  readonly byte_size: number;
  readonly generation: number;
  readonly active_ref_count: number;
  readonly recoverability: string;
  readonly protection_reasons: readonly string[];
  readonly rehydration_available: boolean;
}

export interface ReplayReviewStorageItem {
  readonly run_id: string;
  readonly run_state: string;
  readonly anchor_bytes: number;
  readonly anchor_limit_bytes: number;
  readonly artifact_bytes: number;
  readonly artifact_limit_bytes: number;
  readonly critical_events: number;
  readonly critical_event_limit: number;
  readonly viewport_samples: number;
  readonly viewport_sample_limit: number;
  readonly protection_reasons: readonly string[];
  readonly gc_available: false;
}

export interface ReplayStorageObjectCategory {
  readonly summary: ReplayStorageSummary;
  readonly items: readonly ReplayStorageObjectItem[];
  readonly gc_protocol: ReplayStorageGcProtocol;
  readonly auto_gc_enabled: boolean;
}

export interface ReplayReviewStorageCategory {
  readonly summary: ReplayStorageSummary;
  readonly items: readonly ReplayReviewStorageItem[];
  readonly gc_protocol: null;
  readonly auto_gc_enabled: false;
}

export interface ReplayStorageSupport {
  readonly mode:
    | "BAR"
    | "AGG_TRADE"
    | "BOOK_ASSISTED"
    | "HISTORICAL_EXACT_ACCOUNT";
  readonly source_contract: string;
  readonly declared_scope: string;
  readonly fidelity: string;
  readonly queue_exact: false;
  readonly required_flags: readonly string[];
  readonly observed_identities: readonly ReplayStorageObjectItem["identity"][];
  readonly production_readiness: "HOLD" | "ENABLE";
  readonly reason_codes: readonly string[];
}

export interface ReplayStorageAlert {
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly code: string;
  readonly category: string;
  readonly message: string;
}

export interface ReplayStorageInventory {
  readonly protocol: typeof STORAGE_PROTOCOL;
  readonly decision: {
    readonly state: "HOLD" | "ENABLE";
    readonly default_flags_enabled: boolean;
    readonly reason_codes: readonly string[];
    readonly implementation_state: string;
  };
  readonly feature_flags: {
    readonly replay_enabled: boolean;
    readonly agg_trade_enabled: boolean;
    readonly segment_download_worker_enabled: boolean;
    readonly segment_auto_gc_enabled: boolean;
    readonly fast_forward_optimization_enabled: boolean;
    readonly historical_book_enabled: boolean;
    readonly account_history_enabled: boolean;
  };
  readonly categories: {
    readonly segments: ReplayStorageObjectCategory;
    readonly historical_books: ReplayStorageObjectCategory;
    readonly account_history: ReplayStorageObjectCategory;
    readonly review_evidence: ReplayReviewStorageCategory;
  };
  readonly support_matrix: readonly ReplayStorageSupport[];
  readonly alerts: readonly ReplayStorageAlert[];
  readonly bounds: {
    readonly max_items_per_category: number;
    readonly max_observed_identities: number;
    readonly actual_time_exposed: false;
    readonly local_paths_exposed: false;
  };
}

export interface ReplayStorageGcItem {
  readonly object_id: string;
  readonly byte_size: number;
  readonly recoverability?: string;
  readonly protection_reasons: readonly string[];
}

export interface ReplayStorageGcPlan {
  readonly protocol: ReplayStorageGcProtocol;
  readonly mode: "DRY_RUN";
  readonly plan_hash: string;
  readonly request: {
    readonly target_reclaim_bytes: number;
    readonly max_objects: number;
  };
  readonly current_local_bytes: number;
  readonly estimated_reclaim_bytes: number;
  readonly candidates: readonly ReplayStorageGcItem[];
  readonly protected: readonly ReplayStorageGcItem[];
}

export interface ReplayStorageGcRunResult {
  readonly protocol: ReplayStorageGcProtocol;
  readonly mode: "RUN";
  readonly plan_hash: string;
  readonly reclaimed_bytes: number;
  readonly exact_dry_run_set: boolean;
  readonly reclaimed: readonly ReplayStorageGcItem[];
  readonly skipped: readonly ReplayStorageGcItem[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  field: string,
  fields: readonly string[],
): Record<string, unknown> {
  const payload = record(value, field);
  const actual = Object.keys(payload).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])) {
    throw new TypeError(`${field} fields are incompatible`);
  }
  return payload;
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function positive(value: unknown, field: string): number {
  const parsed = count(value, field);
  if (parsed < 1) throw new TypeError(`${field} must be positive`);
  return parsed;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded string`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const parsed = text(value, field, 128);
  if (!SAFE_ID.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function code(value: unknown, field: string): string {
  const parsed = text(value, field, 128);
  if (!SAFE_CODE.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function array(value: unknown, field: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  return value;
}

function codes(value: unknown, field: string): readonly string[] {
  return array(value, field, 256).map((item, index) => code(item, `${field}[${index}]`));
}

function assertNoPrivateStorageFields(value: unknown, field = "storage"): void {
  const blocked = new Set([
    "range",
    "range_start_ms",
    "range_end_ms",
    "actual_time_ms",
    "actual_start_ms",
    "actual_end_ms",
    "checksum_sha256",
    "dataset_epoch",
    "trusted_source_path",
    "local_path",
    "trusted_file",
    "trusted_url",
  ]);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateStorageFields(item, `${field}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value)) {
    if (name.startsWith("_") || blocked.has(name)) {
      throw new TypeError(`${field}.${name} crosses the replay storage boundary`);
    }
    assertNoPrivateStorageFields(item, `${field}.${name}`);
  }
}

function parseIdentity(
  value: unknown,
  field: string,
): ReplayStorageObjectItem["identity"] {
  const payload = record(value, field);
  const fields = Object.keys(payload).sort().join(",");
  if (fields !== "exchange,market_type,symbol"
    && fields !== "base_interval,exchange,market_type,symbol") {
    throw new TypeError(`${field} fields are incompatible`);
  }
  const base = payload.base_interval;
  if (base !== undefined && base !== null && typeof base !== "string") {
    throw new TypeError(`${field}.base_interval is invalid`);
  }
  return {
    exchange: text(payload.exchange, `${field}.exchange`, 64),
    market_type: text(payload.market_type, `${field}.market_type`, 64),
    symbol: text(payload.symbol, `${field}.symbol`, 128),
    ...(base === undefined ? {} : {
      base_interval: base === null ? null : text(base, `${field}.base_interval`, 32),
    }),
  };
}

function parseSummary(value: unknown, field: string): ReplayStorageSummary {
  const payload = exact(value, field, [
    "object_count",
    "ready_count",
    "evicted_count",
    "quarantined_count",
    "pinned_count",
    "local_bytes",
    "max_bytes",
    "pressure_bps",
    "truncated",
  ]);
  const parsed = {
    object_count: count(payload.object_count, `${field}.object_count`),
    ready_count: count(payload.ready_count, `${field}.ready_count`),
    evicted_count: count(payload.evicted_count, `${field}.evicted_count`),
    quarantined_count: count(payload.quarantined_count, `${field}.quarantined_count`),
    pinned_count: count(payload.pinned_count, `${field}.pinned_count`),
    local_bytes: count(payload.local_bytes, `${field}.local_bytes`),
    max_bytes: count(payload.max_bytes, `${field}.max_bytes`),
    pressure_bps: count(payload.pressure_bps, `${field}.pressure_bps`),
    truncated: bool(payload.truncated, `${field}.truncated`),
  };
  if (parsed.ready_count + parsed.evicted_count + parsed.quarantined_count
      > parsed.object_count
    || parsed.pinned_count > parsed.object_count
    || parsed.pressure_bps > 1_000_000) {
    throw new TypeError(`${field} counts are inconsistent`);
  }
  return parsed;
}

function parseObjectItem(value: unknown, field: string): ReplayStorageObjectItem {
  const payload = exact(value, field, [
    "object_id",
    "source_kind",
    "identity",
    "health",
    "byte_size",
    "generation",
    "active_ref_count",
    "recoverability",
    "protection_reasons",
    "rehydration_available",
  ]);
  return {
    object_id: identifier(payload.object_id, `${field}.object_id`),
    source_kind: text(payload.source_kind, `${field}.source_kind`, 64),
    identity: parseIdentity(payload.identity, `${field}.identity`),
    health: text(payload.health, `${field}.health`, 32),
    byte_size: count(payload.byte_size, `${field}.byte_size`),
    generation: positive(payload.generation, `${field}.generation`),
    active_ref_count: count(payload.active_ref_count, `${field}.active_ref_count`),
    recoverability: text(payload.recoverability, `${field}.recoverability`, 128),
    protection_reasons: codes(payload.protection_reasons, `${field}.protection_reasons`),
    rehydration_available: bool(
      payload.rehydration_available,
      `${field}.rehydration_available`,
    ),
  };
}

function parseReviewItem(value: unknown, field: string): ReplayReviewStorageItem {
  const payload = exact(value, field, [
    "run_id",
    "run_state",
    "anchor_bytes",
    "anchor_limit_bytes",
    "artifact_bytes",
    "artifact_limit_bytes",
    "critical_events",
    "critical_event_limit",
    "viewport_samples",
    "viewport_sample_limit",
    "protection_reasons",
    "gc_available",
  ]);
  if (payload.gc_available !== false) {
    throw new TypeError(`${field}.gc_available must remain false`);
  }
  const item = {
    run_id: identifier(payload.run_id, `${field}.run_id`),
    run_state: text(payload.run_state, `${field}.run_state`, 32),
    anchor_bytes: count(payload.anchor_bytes, `${field}.anchor_bytes`),
    anchor_limit_bytes: positive(payload.anchor_limit_bytes, `${field}.anchor_limit_bytes`),
    artifact_bytes: count(payload.artifact_bytes, `${field}.artifact_bytes`),
    artifact_limit_bytes: positive(payload.artifact_limit_bytes, `${field}.artifact_limit_bytes`),
    critical_events: count(payload.critical_events, `${field}.critical_events`),
    critical_event_limit: positive(payload.critical_event_limit, `${field}.critical_event_limit`),
    viewport_samples: count(payload.viewport_samples, `${field}.viewport_samples`),
    viewport_sample_limit: positive(payload.viewport_sample_limit, `${field}.viewport_sample_limit`),
    protection_reasons: codes(payload.protection_reasons, `${field}.protection_reasons`),
    gc_available: false as const,
  };
  if (item.anchor_bytes > item.anchor_limit_bytes
    || item.artifact_bytes > item.artifact_limit_bytes
    || item.critical_events > item.critical_event_limit
    || item.viewport_samples > item.viewport_sample_limit) {
    throw new TypeError(`${field} exceeds a frozen review budget`);
  }
  return item;
}

function parseObjectCategory(
  value: unknown,
  field: string,
  protocol: ReplayStorageGcProtocol,
): ReplayStorageObjectCategory {
  const payload = exact(value, field, [
    "summary",
    "items",
    "gc_protocol",
    "auto_gc_enabled",
  ]);
  if (payload.gc_protocol !== protocol) {
    throw new TypeError(`${field}.gc_protocol is incompatible`);
  }
  const summary = parseSummary(payload.summary, `${field}.summary`);
  const items = array(payload.items, `${field}.items`, 200).map(
    (item, index) => parseObjectItem(item, `${field}.items[${index}]`),
  );
  if ((!summary.truncated && items.length !== summary.object_count)
    || items.length > summary.object_count) {
    throw new TypeError(`${field} item count is inconsistent`);
  }
  return {
    summary,
    items,
    gc_protocol: protocol,
    auto_gc_enabled: bool(payload.auto_gc_enabled, `${field}.auto_gc_enabled`),
  };
}

function parseReviewCategory(
  value: unknown,
  field: string,
): ReplayReviewStorageCategory {
  const payload = exact(value, field, [
    "summary",
    "items",
    "gc_protocol",
    "auto_gc_enabled",
  ]);
  if (payload.gc_protocol !== null || payload.auto_gc_enabled !== false) {
    throw new TypeError(`${field} must not expose GC`);
  }
  const summary = parseSummary(payload.summary, `${field}.summary`);
  const items = array(payload.items, `${field}.items`, 200).map(
    (item, index) => parseReviewItem(item, `${field}.items[${index}]`),
  );
  if ((!summary.truncated && items.length !== summary.object_count)
    || items.length > summary.object_count) {
    throw new TypeError(`${field} item count is inconsistent`);
  }
  return {
    summary,
    items,
    gc_protocol: null,
    auto_gc_enabled: false,
  };
}

export function parseReplayStorageInventory(value: unknown): ReplayStorageInventory {
  assertNoPrivateStorageFields(value);
  const payload = exact(value, "storage inventory", [
    "protocol",
    "decision",
    "feature_flags",
    "categories",
    "support_matrix",
    "alerts",
    "bounds",
  ]);
  if (payload.protocol !== STORAGE_PROTOCOL) {
    throw new TypeError("storage inventory protocol is unsupported");
  }
  const decision = exact(payload.decision, "storage inventory.decision", [
    "state",
    "default_flags_enabled",
    "reason_codes",
    "implementation_state",
  ]);
  if ((decision.state !== "HOLD" && decision.state !== "ENABLE")
    || typeof decision.default_flags_enabled !== "boolean"
    || (decision.state === "HOLD" && decision.default_flags_enabled)
    || (decision.state === "ENABLE" && !decision.default_flags_enabled)) {
    throw new TypeError("storage inventory decision is inconsistent");
  }
  const flags = exact(payload.feature_flags, "storage inventory.feature_flags", [
    "replay_enabled",
    "agg_trade_enabled",
    "segment_download_worker_enabled",
    "segment_auto_gc_enabled",
    "fast_forward_optimization_enabled",
    "historical_book_enabled",
    "account_history_enabled",
  ]);
  const categories = exact(payload.categories, "storage inventory.categories", [
    "segments",
    "historical_books",
    "account_history",
    "review_evidence",
  ]);
  const bounds = exact(payload.bounds, "storage inventory.bounds", [
    "max_items_per_category",
    "max_observed_identities",
    "actual_time_exposed",
    "local_paths_exposed",
  ]);
  if (bounds.actual_time_exposed !== false || bounds.local_paths_exposed !== false) {
    throw new TypeError("storage inventory disclosure boundary is invalid");
  }
  const maxItems = positive(
    bounds.max_items_per_category,
    "storage inventory.bounds.max_items_per_category",
  );
  const maxIdentities = positive(
    bounds.max_observed_identities,
    "storage inventory.bounds.max_observed_identities",
  );
  if (maxItems > 200 || maxIdentities > 100) {
    throw new TypeError("storage inventory bounds exceed the client contract");
  }
  const supportMatrix = array(payload.support_matrix, "storage inventory.support_matrix", 4)
    .map((item, index): ReplayStorageSupport => {
      const support = exact(item, `storage inventory.support_matrix[${index}]`, [
        "mode",
        "source_contract",
        "declared_scope",
        "fidelity",
        "queue_exact",
        "required_flags",
        "observed_identities",
        "production_readiness",
        "reason_codes",
      ]);
      if (!["BAR", "AGG_TRADE", "BOOK_ASSISTED", "HISTORICAL_EXACT_ACCOUNT"]
        .includes(String(support.mode))
        || support.queue_exact !== false
        || (support.production_readiness !== "HOLD"
          && support.production_readiness !== "ENABLE")) {
        throw new TypeError("storage support declaration is incompatible");
      }
      return {
        mode: support.mode as ReplayStorageSupport["mode"],
        source_contract: text(support.source_contract, "support.source_contract", 256),
        declared_scope: text(support.declared_scope, "support.declared_scope", 256),
        fidelity: text(support.fidelity, "support.fidelity", 256),
        queue_exact: false,
        required_flags: array(support.required_flags, "support.required_flags", 16)
          .map((flag, flagIndex) => code(flag, `support.required_flags[${flagIndex}]`)),
        observed_identities: array(
          support.observed_identities,
          "support.observed_identities",
          maxIdentities,
        ).map((identityValue, identityIndex) => parseIdentity(
          identityValue,
          `support.observed_identities[${identityIndex}]`,
        )),
        production_readiness: support.production_readiness,
        reason_codes: codes(support.reason_codes, "support.reason_codes"),
      };
    });
  if (new Set(supportMatrix.map((item) => item.mode)).size !== 4) {
    throw new TypeError("storage support matrix must declare four unique modes");
  }
  const alerts = array(payload.alerts, "storage inventory.alerts", 128)
    .map((item, index): ReplayStorageAlert => {
      const alert = exact(item, `storage inventory.alerts[${index}]`, [
        "severity",
        "code",
        "category",
        "message",
      ]);
      if (!["INFO", "WARNING", "CRITICAL"].includes(String(alert.severity))) {
        throw new TypeError("storage alert severity is unsupported");
      }
      return {
        severity: alert.severity as ReplayStorageAlert["severity"],
        code: code(alert.code, `storage inventory.alerts[${index}].code`),
        category: text(alert.category, `storage inventory.alerts[${index}].category`, 64),
        message: text(alert.message, `storage inventory.alerts[${index}].message`, 512),
      };
    });
  return {
    protocol: STORAGE_PROTOCOL,
    decision: {
      state: decision.state,
      default_flags_enabled: decision.default_flags_enabled,
      reason_codes: codes(decision.reason_codes, "storage inventory.decision.reason_codes"),
      implementation_state: text(
        decision.implementation_state,
        "storage inventory.decision.implementation_state",
        128,
      ),
    },
    feature_flags: {
      replay_enabled: bool(flags.replay_enabled, "feature_flags.replay_enabled"),
      agg_trade_enabled: bool(
        flags.agg_trade_enabled,
        "feature_flags.agg_trade_enabled",
      ),
      segment_download_worker_enabled: bool(
        flags.segment_download_worker_enabled,
        "feature_flags.segment_download_worker_enabled",
      ),
      segment_auto_gc_enabled: bool(
        flags.segment_auto_gc_enabled,
        "feature_flags.segment_auto_gc_enabled",
      ),
      fast_forward_optimization_enabled: bool(
        flags.fast_forward_optimization_enabled,
        "feature_flags.fast_forward_optimization_enabled",
      ),
      historical_book_enabled: bool(
        flags.historical_book_enabled,
        "feature_flags.historical_book_enabled",
      ),
      account_history_enabled: bool(
        flags.account_history_enabled,
        "feature_flags.account_history_enabled",
      ),
    },
    categories: {
      segments: parseObjectCategory(
        categories.segments,
        "storage inventory.categories.segments",
        "replay.data.gc.v1",
      ),
      historical_books: parseObjectCategory(
        categories.historical_books,
        "storage inventory.categories.historical_books",
        "replay.historical-book.gc.v1",
      ),
      account_history: parseObjectCategory(
        categories.account_history,
        "storage inventory.categories.account_history",
        "replay.account-history.gc.v1",
      ),
      review_evidence: parseReviewCategory(
        categories.review_evidence,
        "storage inventory.categories.review_evidence",
      ),
    },
    support_matrix: supportMatrix,
    alerts,
    bounds: {
      max_items_per_category: maxItems,
      max_observed_identities: maxIdentities,
      actual_time_exposed: false,
      local_paths_exposed: false,
    },
  };
}

function parseGcCandidate(
  value: unknown,
  field: string,
  protocol: ReplayStorageGcProtocol,
  protectedItem: boolean,
): ReplayStorageGcItem {
  const payload = record(value, field);
  const objectField = protocol === "replay.data.gc.v1" ? "segment_id" : "archive_id";
  const required = protocol === "replay.data.gc.v1"
    ? [
        objectField,
        "generation",
        "byte_size",
        "last_used_at_ms",
        "checksum_sha256",
        "affected_run_ids",
        "recoverability",
        ...(protectedItem ? ["protection_reasons"] : []),
      ]
    : protocol === "replay.historical-book.gc.v1"
      ? [
          objectField,
          "generation",
          "byte_size",
          "last_used_at_ms",
          "checksum_sha256",
          "active_ref_count",
          "recoverability",
          ...(protectedItem ? ["protection_reasons"] : []),
        ]
      : [
          objectField,
          "generation",
          "byte_size",
          "active_pin_count",
          "recoverability",
          ...(protectedItem ? ["protection_reasons"] : []),
        ];
  exact(payload, field, required);
  if ("checksum_sha256" in payload
    && (typeof payload.checksum_sha256 !== "string"
      || !SHA256.test(payload.checksum_sha256))) {
    throw new TypeError(`${field}.checksum_sha256 is invalid`);
  }
  if ("affected_run_ids" in payload) {
    array(payload.affected_run_ids, `${field}.affected_run_ids`, 10_000)
      .forEach((item, index) => identifier(item, `${field}.affected_run_ids[${index}]`));
  }
  return {
    object_id: identifier(payload[objectField], `${field}.${objectField}`),
    byte_size: count(payload.byte_size, `${field}.byte_size`),
    recoverability: text(payload.recoverability, `${field}.recoverability`, 128),
    protection_reasons: protectedItem
      ? codes(payload.protection_reasons, `${field}.protection_reasons`)
      : [],
  };
}

export function parseReplayStorageGcPlan(value: unknown): ReplayStorageGcPlan {
  const payload = record(value, "storage GC plan");
  const protocol = payload.protocol;
  if (protocol !== "replay.data.gc.v1"
    && protocol !== "replay.historical-book.gc.v1"
    && protocol !== "replay.account-history.gc.v1") {
    throw new TypeError("storage GC protocol is unsupported");
  }
  const currentField = protocol === "replay.data.gc.v1"
    ? "current_external_bytes"
    : "current_local_bytes";
  const extra = protocol === "replay.data.gc.v1"
    ? ["non_rebuildable_auto_reclaimed"]
    : ["pinned_auto_reclaimed"];
  const exactPayload = exact(payload, "storage GC plan", [
    "protocol",
    "mode",
    "plan_hash",
    "request",
    currentField,
    "estimated_reclaim_bytes",
    "candidates",
    "protected",
    ...extra,
  ]);
  if (exactPayload.mode !== "DRY_RUN"
    || typeof exactPayload.plan_hash !== "string"
    || !SHA256.test(exactPayload.plan_hash)
    || exactPayload[extra[0]!] !== false) {
    throw new TypeError("storage GC plan proof is invalid");
  }
  const requestFields = protocol === "replay.data.gc.v1"
    ? ["target_reclaim_bytes", "max_segments"]
    : ["target_reclaim_bytes", "max_archives"];
  const request = exact(exactPayload.request, "storage GC plan.request", requestFields);
  const maxField = protocol === "replay.data.gc.v1" ? "max_segments" : "max_archives";
  const candidates = array(exactPayload.candidates, "storage GC plan.candidates", 10_000)
    .map((item, index) => parseGcCandidate(
      item,
      `storage GC plan.candidates[${index}]`,
      protocol,
      false,
    ));
  const protectedItems = array(exactPayload.protected, "storage GC plan.protected", 10_000)
    .map((item, index) => parseGcCandidate(
      item,
      `storage GC plan.protected[${index}]`,
      protocol,
      true,
    ));
  const estimated = count(
    exactPayload.estimated_reclaim_bytes,
    "storage GC plan.estimated_reclaim_bytes",
  );
  if (candidates.reduce((total, item) => total + item.byte_size, 0) !== estimated) {
    throw new TypeError("storage GC estimated reclaim bytes are inconsistent");
  }
  return {
    protocol,
    mode: "DRY_RUN",
    plan_hash: exactPayload.plan_hash,
    request: {
      target_reclaim_bytes: positive(
        request.target_reclaim_bytes,
        "storage GC plan.request.target_reclaim_bytes",
      ),
      max_objects: positive(request[maxField], `storage GC plan.request.${maxField}`),
    },
    current_local_bytes: count(
      exactPayload[currentField],
      `storage GC plan.${currentField}`,
    ),
    estimated_reclaim_bytes: estimated,
    candidates,
    protected: protectedItems,
  };
}

function parseGcResultItem(value: unknown, field: string): ReplayStorageGcItem {
  const payload = record(value, field);
  const objectField = "segment_id" in payload ? "segment_id" : "archive_id";
  if (!(objectField in payload)
    || !("reclaimed" in payload)
    || !("byte_size" in payload)
    || !("reason" in payload)) {
    throw new TypeError(`${field} fields are incompatible`);
  }
  if (typeof payload.reclaimed !== "boolean") {
    throw new TypeError(`${field}.reclaimed must be boolean`);
  }
  return {
    object_id: identifier(payload[objectField], `${field}.${objectField}`),
    byte_size: count(payload.byte_size, `${field}.byte_size`),
    recoverability: text(payload.reason, `${field}.reason`, 256),
    protection_reasons: payload.protection_reasons === undefined
      ? []
      : codes(payload.protection_reasons, `${field}.protection_reasons`),
  };
}

export function parseReplayStorageGcRunResult(
  value: unknown,
): ReplayStorageGcRunResult {
  const payload = record(value, "storage GC result");
  const protocol = payload.protocol;
  if (protocol !== "replay.data.gc.v1"
    && protocol !== "replay.historical-book.gc.v1"
    && protocol !== "replay.account-history.gc.v1") {
    throw new TypeError("storage GC result protocol is unsupported");
  }
  const fields = [
    "protocol",
    "mode",
    "plan_hash",
    "request",
    "reclaimed",
    "skipped",
    "reclaimed_bytes",
    "exact_dry_run_set",
    ...(protocol === "replay.data.gc.v1" ? [] : ["pinned_auto_reclaimed"]),
  ];
  const exactPayload = exact(payload, "storage GC result", fields);
  if (exactPayload.mode !== "RUN"
    || typeof exactPayload.plan_hash !== "string"
    || !SHA256.test(exactPayload.plan_hash)
    || typeof exactPayload.exact_dry_run_set !== "boolean"
    || ("pinned_auto_reclaimed" in exactPayload
      && exactPayload.pinned_auto_reclaimed !== false)) {
    throw new TypeError("storage GC result proof is invalid");
  }
  const reclaimed = array(exactPayload.reclaimed, "storage GC result.reclaimed", 10_000)
    .map((item, index) => parseGcResultItem(
      item,
      `storage GC result.reclaimed[${index}]`,
    ));
  const skipped = array(exactPayload.skipped, "storage GC result.skipped", 10_000)
    .map((item, index) => parseGcResultItem(
      item,
      `storage GC result.skipped[${index}]`,
    ));
  const reclaimedBytes = count(
    exactPayload.reclaimed_bytes,
    "storage GC result.reclaimed_bytes",
  );
  if (reclaimed.reduce((total, item) => total + item.byte_size, 0) !== reclaimedBytes
    || (exactPayload.exact_dry_run_set && skipped.length > 0)) {
    throw new TypeError("storage GC result byte proof is inconsistent");
  }
  return {
    protocol,
    mode: "RUN",
    plan_hash: exactPayload.plan_hash,
    reclaimed_bytes: reclaimedBytes,
    exact_dry_run_set: exactPayload.exact_dry_run_set,
    reclaimed,
    skipped,
  };
}

export function parseReplayStorageRehydrateAck(
  value: unknown,
): { readonly object_id: string; readonly health: "READY" } {
  const payload = record(value, "storage rehydrate response");
  const rawId = payload.segment_id ?? payload.archive_id;
  if (payload.health !== "READY") {
    throw new TypeError("storage rehydrate response is not READY");
  }
  return {
    object_id: identifier(rawId, "storage rehydrate response.object_id"),
    health: "READY",
  };
}
