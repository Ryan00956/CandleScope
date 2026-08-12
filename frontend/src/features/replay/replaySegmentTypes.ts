import {
  parseReplayAccountHistoryRef,
  parseReplayHedgePublicHistoryRef,
  parseReplayHedgeSimulationManifestRef,
} from "./replayV2Types.js";
import type {
  ReplayAccountHistoryRef,
  ReplayHedgePublicHistoryRef,
  ReplayHedgeSimulationManifestRef,
  ReplayV2AccountDataMode,
  ReplayV2SourceKind,
  TrainingRunPreparationPayload,
} from "./replayV2Types.js";


export interface ReplayHistoricalBookCapabilityPlan {
  readonly feature_enabled: boolean;
  readonly requested_mode: "OFF" | "BOOK_ASSISTED_REQUIRED";
  readonly capability_state:
    | "AVAILABLE_EXACT"
    | "UNSUPPORTED_NO_HISTORY"
    | "UNSUPPORTED_SOURCE_MODE"
    | "DEGRADED";
  readonly reason: string;
  readonly source: "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1";
  readonly snapshot_and_ordered_deltas: boolean;
  readonly continuity_contract: "SNAPSHOT_BRIDGE_AND_U_u_pu";
  readonly pinnable: boolean;
  readonly queue_exact: false;
  readonly execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE";
  readonly ready_archive_bytes: number;
  readonly max_archive_bytes: number;
}

export interface ReplaySegmentHistoryPolicyPlan {
  readonly schema_version: "replay.data-policy.v1";
  readonly indicator_warmup_bars: number;
  readonly visible_history_lookback: {
    readonly mode: "DURATION" | "ALL_AVAILABLE";
    readonly duration_ms: number | null;
  };
  readonly visible_history_rows_estimate: number | null;
  readonly effective_warmup_bars_estimate: number;
  readonly forward_cache_ms: number;
  readonly forward_rows_estimate: number;
  readonly estimate_kind: "EXACT" | "SELECTION_DEPENDENT";
  readonly max_dataset_rows: number;
  readonly accepted: boolean;
  readonly blocked_reason:
    | "VISIBLE_HISTORY_INTERVAL_MISMATCH"
    | "VISIBLE_HISTORY_BUDGET_EXCEEDED"
    | null;
}

export interface ReplayAccountHistoryCapabilityPlan {
  readonly protocol: "replay.account-history.archive.v1";
  readonly feature_enabled: boolean;
  readonly requested_mode: ReplayV2AccountDataMode;
  readonly capability_state:
    | "AVAILABLE_EXACT"
    | "UNSUPPORTED_NO_HISTORY"
    | "UNSUPPORTED_SOURCE_MODE"
    | "DEGRADED";
  readonly reason: string;
  readonly fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT";
  readonly supported_contract_model: "LINEAR_QUOTE_SETTLED_V1";
  readonly supported_position_mode: "ONE_WAY";
  readonly supported_margin_asset_mode: "SINGLE_QUOTE";
  readonly historical_funding_exact: boolean;
  readonly public_kline_proxy_accepted: false;
  readonly ready_archive_bytes: number;
  readonly max_archive_bytes: number;
  readonly coverage: {
    readonly range_start_ms: number;
    readonly range_end_ms: number;
  } | null;
  readonly account_history_ref: ReplayAccountHistoryRef | null;
}

export interface ReplayHedgeInputCapabilityPlan {
  readonly schema_version: "replay.hedge-input-plan.v1";
  readonly feature_enabled: true;
  readonly requested_position_mode: "ONE_WAY" | "HEDGE";
  readonly capability_state:
    | "NOT_REQUIRED"
    | "AVAILABLE_EXACT"
    | "AVAILABLE_APPROX"
    | "UNSUPPORTED_NO_HISTORY"
    | "UNSUPPORTED_SOURCE_MODE"
    | "DEGRADED";
  readonly reason: string;
  readonly public_fidelity:
    | "PINNED_HISTORICAL_PUBLIC_INPUT"
    | "VERSIONED_HYBRID_PUBLIC_INPUT";
  readonly private_fidelity: "VERSIONED_DETERMINISTIC_SIMULATION";
  readonly historical_exchange_private_state: false;
  readonly fallback_applied: boolean;
  readonly coverage: {
    readonly range_start_ms: number;
    readonly range_end_ms: number;
  } | null;
  readonly historical_l2_ref: {
    readonly archive_id: string;
    readonly dataset_epoch: string;
    readonly checksum_sha256: string;
  } | null;
  readonly hedge_public_history_ref: ReplayHedgePublicHistoryRef | null;
  readonly simulation_manifest_ref: ReplayHedgeSimulationManifestRef | null;
}

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
  readonly history_policy: ReplaySegmentHistoryPolicyPlan;
  readonly prepare_action: "SNAPSHOT_LOCAL_BAR_RANGE" | "VERIFY_LOCAL_AGG_TRADE";
  readonly existing_ready_segments: number;
  readonly existing_ready_bytes: number;
  readonly selection_loads_history: false;
  readonly create_loads_only_selected_range: true;
  readonly download_worker_enabled: boolean;
  readonly auto_gc_enabled: boolean;
  readonly failure_policy: "QUARANTINE_AND_FAIL_CLOSED";
  readonly historical_book: ReplayHistoricalBookCapabilityPlan;
  readonly account_history: ReplayAccountHistoryCapabilityPlan;
  readonly hedge_inputs: ReplayHedgeInputCapabilityPlan;
}

export interface ReplaySegmentPlanApi {
  segmentPlan(
    payload: TrainingRunPreparationPayload,
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

function nullableCount(value: unknown, fieldName: string): number | null {
  return value === null ? null : count(value, fieldName);
}

export function parseReplaySegmentPreparePlan(value: unknown): ReplaySegmentPreparePlan {
  const payload = exactObject(value, "segment prepare plan", [
    "protocol",
    "state",
    "source_kind",
    "identity",
    "estimated_size_bytes",
    "estimated_rows",
    "history_policy",
    "prepare_action",
    "existing_ready_segments",
    "existing_ready_bytes",
    "selection_loads_history",
    "create_loads_only_selected_range",
    "download_worker_enabled",
    "auto_gc_enabled",
    "failure_policy",
    "historical_book",
    "account_history",
    "hedge_inputs",
  ]);
  const identity = exactObject(payload.identity, "segment prepare plan.identity", [
    "exchange",
    "market_type",
    "symbol",
    "base_interval",
  ]);
  const historyPolicy = exactObject(
    payload.history_policy,
    "segment prepare plan.history_policy",
    [
      "schema_version",
      "indicator_warmup_bars",
      "visible_history_lookback",
      "visible_history_rows_estimate",
      "effective_warmup_bars_estimate",
      "forward_cache_ms",
      "forward_rows_estimate",
      "estimate_kind",
      "max_dataset_rows",
      "accepted",
      "blocked_reason",
    ],
  );
  const visibleHistory = exactObject(
    historyPolicy.visible_history_lookback,
    "segment prepare plan.history_policy.visible_history_lookback",
    ["mode", "duration_ms"],
  );
  const historicalBook = exactObject(
    payload.historical_book,
    "segment prepare plan.historical_book",
    [
      "feature_enabled",
      "requested_mode",
      "capability_state",
      "reason",
      "source",
      "snapshot_and_ordered_deltas",
      "continuity_contract",
      "pinnable",
      "queue_exact",
      "execution_fidelity",
      "ready_archive_bytes",
      "max_archive_bytes",
    ],
  );
  const accountHistory = exactObject(
    payload.account_history,
    "segment prepare plan.account_history",
    [
      "protocol",
      "feature_enabled",
      "requested_mode",
      "capability_state",
      "reason",
      "fidelity",
      "supported_contract_model",
      "supported_position_mode",
      "supported_margin_asset_mode",
      "historical_funding_exact",
      "public_kline_proxy_accepted",
      "ready_archive_bytes",
      "max_archive_bytes",
      "coverage",
      "account_history_ref",
    ],
  );
  const hedgeInputs = exactObject(
    payload.hedge_inputs,
    "segment prepare plan.hedge_inputs",
    [
      "schema_version",
      "feature_enabled",
      "requested_position_mode",
      "capability_state",
      "reason",
      "public_fidelity",
      "private_fidelity",
      "historical_exchange_private_state",
      "fallback_applied",
      "coverage",
      "historical_l2_ref",
      "hedge_public_history_ref",
      "simulation_manifest_ref",
    ],
  );
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
  if (historyPolicy.schema_version !== "replay.data-policy.v1"
    || (visibleHistory.mode !== "DURATION"
      && visibleHistory.mode !== "ALL_AVAILABLE")
    || (historyPolicy.estimate_kind !== "EXACT"
      && historyPolicy.estimate_kind !== "SELECTION_DEPENDENT")
    || typeof historyPolicy.accepted !== "boolean") {
    throw new TypeError("segment history policy plan is unsupported");
  }
  const durationMs = nullableCount(
    visibleHistory.duration_ms,
    "segment history policy.duration_ms",
  );
  const visibleRows = nullableCount(
    historyPolicy.visible_history_rows_estimate,
    "segment history policy.visible_history_rows_estimate",
  );
  const blockedReason = historyPolicy.blocked_reason;
  if ((blockedReason !== null
      && blockedReason !== "VISIBLE_HISTORY_INTERVAL_MISMATCH"
      && blockedReason !== "VISIBLE_HISTORY_BUDGET_EXCEEDED")
    || (historyPolicy.accepted && blockedReason !== null)
    || (!historyPolicy.accepted && blockedReason === null)
    || (visibleHistory.mode === "DURATION"
      && (durationMs === null || durationMs < 1
        || (visibleRows === null
          && blockedReason !== "VISIBLE_HISTORY_INTERVAL_MISMATCH")
        || historyPolicy.estimate_kind !== "EXACT"))
    || (visibleHistory.mode === "ALL_AVAILABLE"
      && (durationMs !== null || visibleRows !== null
        || historyPolicy.estimate_kind !== "SELECTION_DEPENDENT"))) {
    throw new TypeError("segment history policy proof is inconsistent");
  }
  const indicatorWarmup = count(
    historyPolicy.indicator_warmup_bars,
    "segment history policy.indicator_warmup_bars",
  );
  const effectiveWarmup = count(
    historyPolicy.effective_warmup_bars_estimate,
    "segment history policy.effective_warmup_bars_estimate",
  );
  const forwardRows = count(
    historyPolicy.forward_rows_estimate,
    "segment history policy.forward_rows_estimate",
  );
  if (indicatorWarmup < 1
    || effectiveWarmup < indicatorWarmup
    || (visibleRows !== null && effectiveWarmup < visibleRows)
    || count(payload.estimated_rows, "estimated_rows")
      !== effectiveWarmup + forwardRows + 1) {
    throw new TypeError("segment history policy row estimates are inconsistent");
  }
  if (payload.selection_loads_history !== false
    || payload.create_loads_only_selected_range !== true
    || typeof payload.download_worker_enabled !== "boolean"
    || typeof payload.auto_gc_enabled !== "boolean"
    || payload.failure_policy !== "QUARANTINE_AND_FAIL_CLOSED") {
    throw new TypeError("segment prepare plan safety contract is unsupported");
  }
  if (typeof historicalBook.feature_enabled !== "boolean"
    || (historicalBook.requested_mode !== "OFF"
      && historicalBook.requested_mode !== "BOOK_ASSISTED_REQUIRED")
    || ![
      "AVAILABLE_EXACT",
      "UNSUPPORTED_NO_HISTORY",
      "UNSUPPORTED_SOURCE_MODE",
      "DEGRADED",
    ].includes(String(historicalBook.capability_state))
    || historicalBook.source !== "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1"
    || typeof historicalBook.snapshot_and_ordered_deltas !== "boolean"
    || historicalBook.continuity_contract !== "SNAPSHOT_BRIDGE_AND_U_u_pu"
    || typeof historicalBook.pinnable !== "boolean"
    || historicalBook.queue_exact !== false
    || historicalBook.execution_fidelity !== "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE") {
    throw new TypeError("historical book capability plan is unsupported");
  }
  const bookCapability = historicalBook.capability_state as (
    ReplayHistoricalBookCapabilityPlan["capability_state"]
  );
  const exact = bookCapability === "AVAILABLE_EXACT";
  if (historicalBook.snapshot_and_ordered_deltas !== exact
    || historicalBook.pinnable !== exact) {
    throw new TypeError("historical book exact capability proof is inconsistent");
  }
  if (accountHistory.protocol !== "replay.account-history.archive.v1"
    || typeof accountHistory.feature_enabled !== "boolean"
    || (accountHistory.requested_mode !== "APPROX_PROXY"
      && accountHistory.requested_mode !== "HISTORICAL_EXACT"
      && accountHistory.requested_mode !== "DETERMINISTIC_SIMULATION")
    || ![
      "AVAILABLE_EXACT",
      "UNSUPPORTED_NO_HISTORY",
      "UNSUPPORTED_SOURCE_MODE",
      "DEGRADED",
    ].includes(String(accountHistory.capability_state))
    || accountHistory.fidelity !== "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
    || accountHistory.supported_contract_model !== "LINEAR_QUOTE_SETTLED_V1"
    || accountHistory.supported_position_mode !== "ONE_WAY"
    || accountHistory.supported_margin_asset_mode !== "SINGLE_QUOTE"
    || typeof accountHistory.historical_funding_exact !== "boolean"
    || accountHistory.public_kline_proxy_accepted !== false) {
    throw new TypeError("account-history capability plan is unsupported");
  }
  const accountCapability = accountHistory.capability_state as (
    ReplayAccountHistoryCapabilityPlan["capability_state"]
  );
  const accountCoverage = accountHistory.coverage === null
    ? null
    : exactObject(
        accountHistory.coverage,
        "segment prepare plan.account_history.coverage",
        ["range_start_ms", "range_end_ms"],
      );
  const parsedCoverage = accountCoverage === null
    ? null
    : {
        range_start_ms: count(
          accountCoverage.range_start_ms,
          "account history.coverage.range_start_ms",
        ),
        range_end_ms: count(
          accountCoverage.range_end_ms,
          "account history.coverage.range_end_ms",
        ),
      };
  const accountReference = accountHistory.account_history_ref === null
    ? null
    : parseReplayAccountHistoryRef(
        accountHistory.account_history_ref,
        "segment prepare plan.account_history.account_history_ref",
      );
  const accountReadyBytes = count(
    accountHistory.ready_archive_bytes,
    "account history.ready_archive_bytes",
  );
  const accountMaxBytes = count(
    accountHistory.max_archive_bytes,
    "account history.max_archive_bytes",
  );
  const accountExact = accountCapability === "AVAILABLE_EXACT";
  if (
    accountReadyBytes > accountMaxBytes
    || (parsedCoverage !== null
      && parsedCoverage.range_end_ms < parsedCoverage.range_start_ms)
    || (accountExact !== (parsedCoverage !== null && accountReference !== null))
    || (accountExact && !accountHistory.feature_enabled)
    || (!accountExact && accountReadyBytes !== 0)
  ) {
    throw new TypeError("account-history exact capability proof is inconsistent");
  }
  if (hedgeInputs.schema_version !== "replay.hedge-input-plan.v1"
    || hedgeInputs.feature_enabled !== true
    || (hedgeInputs.requested_position_mode !== "ONE_WAY"
      && hedgeInputs.requested_position_mode !== "HEDGE")
    || ![
      "NOT_REQUIRED",
      "AVAILABLE_EXACT",
      "AVAILABLE_APPROX",
      "UNSUPPORTED_NO_HISTORY",
      "UNSUPPORTED_SOURCE_MODE",
      "DEGRADED",
    ].includes(String(hedgeInputs.capability_state))
    || (hedgeInputs.public_fidelity !== "PINNED_HISTORICAL_PUBLIC_INPUT"
      && hedgeInputs.public_fidelity !== "VERSIONED_HYBRID_PUBLIC_INPUT")
    || hedgeInputs.private_fidelity !== "VERSIONED_DETERMINISTIC_SIMULATION"
    || hedgeInputs.historical_exchange_private_state !== false
    || typeof hedgeInputs.fallback_applied !== "boolean") {
    throw new TypeError("HEDGE input capability plan is unsupported");
  }
  const hedgeCapability = hedgeInputs.capability_state as (
    ReplayHedgeInputCapabilityPlan["capability_state"]
  );
  const hedgeCoverage = hedgeInputs.coverage === null
    ? null
    : exactObject(
        hedgeInputs.coverage,
        "segment prepare plan.hedge_inputs.coverage",
        ["range_start_ms", "range_end_ms"],
      );
  const hedgeL2 = hedgeInputs.historical_l2_ref === null
    ? null
    : exactObject(
        hedgeInputs.historical_l2_ref,
        "segment prepare plan.hedge_inputs.historical_l2_ref",
        ["archive_id", "dataset_epoch", "checksum_sha256"],
      );
  const hedgePublicRef = hedgeInputs.hedge_public_history_ref === null
    ? null
    : parseReplayHedgePublicHistoryRef(
        hedgeInputs.hedge_public_history_ref,
        "segment prepare plan.hedge_inputs.hedge_public_history_ref",
      );
  const hedgeSimulationRef = hedgeInputs.simulation_manifest_ref === null
    ? null
    : parseReplayHedgeSimulationManifestRef(
        hedgeInputs.simulation_manifest_ref,
        "segment prepare plan.hedge_inputs.simulation_manifest_ref",
      );
  const hedgeAvailable = hedgeCapability === "AVAILABLE_EXACT"
    || hedgeCapability === "AVAILABLE_APPROX";
  if ((hedgeInputs.requested_position_mode === "ONE_WAY")
      !== (hedgeCapability === "NOT_REQUIRED")
    || hedgeAvailable !== (
      hedgeCoverage !== null
      && hedgePublicRef !== null
      && hedgeSimulationRef !== null
    )
    || (!hedgeAvailable && (
      hedgeCoverage !== null
      || hedgeL2 !== null
      || hedgePublicRef !== null
      || hedgeSimulationRef !== null
    ))
    || (hedgeCapability === "AVAILABLE_EXACT"
      && (hedgeInputs.public_fidelity !== "PINNED_HISTORICAL_PUBLIC_INPUT"
        || hedgeInputs.fallback_applied !== false))
    || (hedgeCapability === "AVAILABLE_APPROX"
      && (hedgeInputs.public_fidelity !== "VERSIONED_HYBRID_PUBLIC_INPUT"
        || hedgeInputs.fallback_applied !== true))) {
    throw new TypeError("HEDGE input capability proof is inconsistent");
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
    history_policy: {
      schema_version: "replay.data-policy.v1",
      indicator_warmup_bars: indicatorWarmup,
      visible_history_lookback: {
        mode: visibleHistory.mode,
        duration_ms: durationMs,
      },
      visible_history_rows_estimate: visibleRows,
      effective_warmup_bars_estimate: effectiveWarmup,
      forward_cache_ms: count(
        historyPolicy.forward_cache_ms,
        "segment history policy.forward_cache_ms",
      ),
      forward_rows_estimate: forwardRows,
      estimate_kind: historyPolicy.estimate_kind,
      max_dataset_rows: count(
        historyPolicy.max_dataset_rows,
        "segment history policy.max_dataset_rows",
      ),
      accepted: historyPolicy.accepted,
      blocked_reason: blockedReason,
    },
    prepare_action: payload.prepare_action,
    existing_ready_segments: count(payload.existing_ready_segments, "existing_ready_segments"),
    existing_ready_bytes: count(payload.existing_ready_bytes, "existing_ready_bytes"),
    selection_loads_history: false,
    create_loads_only_selected_range: true,
    download_worker_enabled: payload.download_worker_enabled,
    auto_gc_enabled: payload.auto_gc_enabled,
    failure_policy: "QUARANTINE_AND_FAIL_CLOSED",
    historical_book: {
      feature_enabled: historicalBook.feature_enabled,
      requested_mode: historicalBook.requested_mode,
      capability_state: bookCapability,
      reason: displayString(historicalBook.reason, "historical book.reason"),
      source: "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1",
      snapshot_and_ordered_deltas: historicalBook.snapshot_and_ordered_deltas,
      continuity_contract: "SNAPSHOT_BRIDGE_AND_U_u_pu",
      pinnable: historicalBook.pinnable,
      queue_exact: false,
      execution_fidelity: "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
      ready_archive_bytes: count(
        historicalBook.ready_archive_bytes,
        "historical book.ready_archive_bytes",
      ),
      max_archive_bytes: count(
        historicalBook.max_archive_bytes,
        "historical book.max_archive_bytes",
      ),
    },
    account_history: {
      protocol: "replay.account-history.archive.v1",
      feature_enabled: accountHistory.feature_enabled,
      requested_mode: accountHistory.requested_mode,
      capability_state: accountCapability,
      reason: displayString(accountHistory.reason, "account history.reason"),
      fidelity: "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      supported_contract_model: "LINEAR_QUOTE_SETTLED_V1",
      supported_position_mode: "ONE_WAY",
      supported_margin_asset_mode: "SINGLE_QUOTE",
      historical_funding_exact: accountHistory.historical_funding_exact,
      public_kline_proxy_accepted: false,
      ready_archive_bytes: accountReadyBytes,
      max_archive_bytes: accountMaxBytes,
      coverage: parsedCoverage,
      account_history_ref: accountReference,
    },
    hedge_inputs: {
      schema_version: "replay.hedge-input-plan.v1",
      feature_enabled: true,
      requested_position_mode: hedgeInputs.requested_position_mode,
      capability_state: hedgeCapability,
      reason: displayString(hedgeInputs.reason, "HEDGE input.reason"),
      public_fidelity: hedgeInputs.public_fidelity,
      private_fidelity: "VERSIONED_DETERMINISTIC_SIMULATION",
      historical_exchange_private_state: false,
      fallback_applied: hedgeInputs.fallback_applied,
      coverage: hedgeCoverage === null ? null : {
        range_start_ms: count(
          hedgeCoverage.range_start_ms,
          "HEDGE input.coverage.range_start_ms",
        ),
        range_end_ms: count(
          hedgeCoverage.range_end_ms,
          "HEDGE input.coverage.range_end_ms",
        ),
      },
      historical_l2_ref: hedgeL2 === null ? null : {
        archive_id: displayString(hedgeL2.archive_id, "HEDGE input.L2.archive_id"),
        dataset_epoch: displayString(
          hedgeL2.dataset_epoch,
          "HEDGE input.L2.dataset_epoch",
        ),
        checksum_sha256: displayString(
          hedgeL2.checksum_sha256,
          "HEDGE input.L2.checksum_sha256",
        ),
      },
      hedge_public_history_ref: hedgePublicRef,
      simulation_manifest_ref: hedgeSimulationRef,
    },
  };
}
