import { t } from "../../i18n/index.js";
import type { ReplayCapabilities, ReplayCatalog, ReplayCatalogEntry } from "./replayTypes.js";
import type {
  ReplayLaunchContext,
  ReplayAccountHistoryRef,
  ReplayHedgePublicHistoryRef,
  ReplayHedgeSimulationManifestRef,
  ReplayV2AccountDataMode,
  ReplayV2BookMode,
  ReplayV2IntegrityMode,
  ReplayV2FundingMode,
  ReplayV2MarginMode,
  ReplayV2PositionMode,
  ReplayV2SourceKind,
  ReplayV2StartMode,
  ReplayV2TimeDisclosurePolicy,
  ReplayVisibleHistoryMode,
  TrainingRunCreatePayload,
  TrainingRunPreparationPayload,
} from "./replayV2Types.js";
import {
  HEDGE_ACCOUNT_FIDELITY,
  HEDGE_INSURANCE_ADL_FIDELITY,
} from "./replayV2Types.js";
import { intervalTiles, parseIntervalSeconds } from "../../utils/intervals.js";
import type { ReplaySegmentPreparePlan } from "./replaySegmentTypes.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "./replayIntegrityModel.js";

const POSITIVE_DECIMAL = /^(?:[1-9]\d*)(?:\.\d*[1-9])?$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

export interface TrainingRunDraft {
  readonly name: string;
  readonly sourceKind: ReplayV2SourceKind;
  readonly startMode: ReplayV2StartMode;
  readonly exchange: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly settlementAsset: string;
  readonly baseInterval: string;
  readonly displayInterval: string;
  readonly requestedStartMs: number | null;
  readonly randomRangeStartMs: number | null;
  readonly randomRangeEndMs: number | null;
  readonly indicatorWarmupBars: number;
  readonly visibleHistoryMode: ReplayVisibleHistoryMode;
  readonly visibleHistoryLookbackMs: number | null;
  readonly forwardCacheMs: number;
  readonly initialEquity: string;
  readonly maxLeverage: string;
  readonly makerFeeBps: string;
  readonly takerFeeBps: string;
  readonly marketSlippageBps: string;
  readonly marginMode: ReplayV2MarginMode;
  readonly positionMode: ReplayV2PositionMode;
  readonly fundingMode: ReplayV2FundingMode;
  readonly accountDataMode: ReplayV2AccountDataMode;
  readonly fixedFundingRate: string;
  readonly fundingIntervalMs: number;
  readonly bookMode: ReplayV2BookMode;
  readonly integrityMode: ReplayV2IntegrityMode;
  readonly timeDisclosurePolicy: ReplayV2TimeDisclosurePolicy;
  readonly allowedMutations: readonly ReplayPolicyMutation[];
}

export interface TrainingHubUnsupportedCapabilities {
  readonly account_history: string;
  readonly funding: string;
  readonly historical_l2: string;
  readonly rule_changes: string;
  readonly isolated_margin: string;
}

export interface TrainingRunDraftEvaluation {
  readonly canSubmit: boolean;
  readonly errors: readonly string[];
  readonly selectedEntry: ReplayCatalogEntry | null;
  readonly accountHistoryRef: ReplayAccountHistoryRef | null;
  readonly hedgePublicHistoryRef: ReplayHedgePublicHistoryRef | null;
  readonly simulationManifestRef: ReplayHedgeSimulationManifestRef | null;
  readonly unsupported: TrainingHubUnsupportedCapabilities;
}

export function getPhase6Boundaries(): TrainingHubUnsupportedCapabilities {
  return {
    account_history: t("replay.boundary.account"),
    funding: t("replay.boundary.funding"),
    historical_l2: t("replay.boundary.l2"),
    rule_changes: t("replay.boundary.rules"),
    isolated_margin: t("replay.boundary.isolated"),
  };
}

function firstEntry(catalog: ReplayCatalog): ReplayCatalogEntry | undefined {
  return catalog.entries.find((entry) => (
    entry.identity.exchange === "binance"
    && entry.identity.market_type === "futures"
    && entry.selected_base_interval !== null
  ))
    ?? catalog.entries.find((entry) => entry.selected_base_interval !== null)
    ?? catalog.entries[0];
}

export function createTrainingRunDraft(
  catalog?: ReplayCatalog,
  launchContext?: ReplayLaunchContext,
): TrainingRunDraft {
  const entry = launchContext === undefined
    ? (catalog === undefined ? undefined : firstEntry(catalog))
    : catalog?.entries.find((candidate) => (
        candidate.identity.exchange === launchContext.exchange
        && candidate.identity.market_type === launchContext.market_type
        && candidate.identity.symbol === launchContext.symbol
      ));
  const symbol = launchContext?.symbol ?? entry?.identity.symbol ?? "BTCUSDT";
  const baseInterval = entry?.selected_base_interval ?? entry?.base_intervals[0] ?? "1m";
  const displayInterval = launchContext?.display_interval ?? baseInterval;
  const latestEligibleStart = entry?.eligible_ranges.length
    ? Math.max(...entry.eligible_ranges.map((range) => range.last_start_ms))
    : Math.floor(
        (Date.now() - (catalog?.horizon_ms ?? 86_400_000)) / 60_000,
      ) * 60_000;
  return {
    name: t("replay.hub.defaultName"),
    sourceKind: "BAR",
    startMode: "MANUAL",
    exchange: launchContext?.exchange ?? entry?.identity.exchange ?? "binance",
    marketType: launchContext?.market_type ?? entry?.identity.market_type ?? "futures",
    symbol,
    settlementAsset: symbol.endsWith("USDT") ? "USDT" : "USDT",
    baseInterval,
    displayInterval,
    requestedStartMs: latestEligibleStart,
    randomRangeStartMs: null,
    randomRangeEndMs: null,
    indicatorWarmupBars: catalog?.warmup_bars ?? 200,
    visibleHistoryMode: "ALL_AVAILABLE",
    visibleHistoryLookbackMs: null,
    forwardCacheMs: catalog?.horizon_ms ?? 86_400_000,
    initialEquity: "10000",
    maxLeverage: "3",
    makerFeeBps: "2",
    takerFeeBps: "5",
    marketSlippageBps: "1",
    marginMode: "CROSS",
    positionMode: "ONE_WAY",
    fundingMode: "OFF",
    accountDataMode: "APPROX_PROXY",
    fixedFundingRate: "0.0001",
    fundingIntervalMs: 28_800_000,
    bookMode: "OFF",
    integrityMode: "CHALLENGE",
    timeDisclosurePolicy: "NONE",
    allowedMutations: [],
  };
}

function matchingEntry(
  draft: TrainingRunDraft,
  catalog: ReplayCatalog,
): ReplayCatalogEntry | undefined {
  return catalog.entries.find((entry) => (
    entry.identity.exchange === draft.exchange
    && entry.identity.market_type === draft.marketType
    && entry.identity.symbol === draft.symbol
  ));
}

export interface ReplayStartWindow {
  readonly earliestHistoryMs: number | null;
  readonly earliestEligibleMs: number | null;
  readonly latestEligibleMs: number | null;
  readonly eligibleWindowCount: number;
  readonly stepSeconds: number;
}

export function replayStartWindow(entry: ReplayCatalogEntry): ReplayStartWindow {
  const ranges = entry.eligible_ranges;
  const intervalSeconds = parseIntervalSeconds(
    entry.selected_base_interval ?? entry.base_intervals[0],
  ) ?? 60;
  return {
    earliestHistoryMs: entry.bounds?.earliest_open_ms ?? null,
    earliestEligibleMs: ranges.length === 0
      ? null
      : Math.min(...ranges.map((range) => range.first_start_ms)),
    latestEligibleMs: ranges.length === 0
      ? null
      : Math.max(...ranges.map((range) => range.last_start_ms)),
    eligibleWindowCount: entry.eligible_window_count,
    stepSeconds: intervalSeconds,
  };
}

export function isEligibleReplayStart(
  entry: ReplayCatalogEntry,
  startMs: number,
): boolean {
  if (!Number.isSafeInteger(startMs) || startMs < 0) return false;
  return entry.eligible_ranges.some((range) => (
    startMs >= range.first_start_ms
    && startMs <= range.last_start_ms
    && (startMs - range.first_start_ms) % range.interval_ms === 0
  ));
}

export function requiresBlindTrainingCatalog(
  draft: Pick<TrainingRunDraft, "startMode" | "timeDisclosurePolicy">,
): boolean {
  return draft.startMode === "RANDOM" && draft.timeDisclosurePolicy !== "NONE";
}

export function formatUtcReplayStartInput(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return "";
  try {
    return new Date(value).toISOString().slice(0, 19);
  } catch {
    return "";
  }
}

export function parseUtcReplayStartInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) return null;
  const [, yearToken, monthToken, dayToken, hourToken, minuteToken, secondToken = "0"] = match;
  const parts = [yearToken, monthToken, dayToken, hourToken, minuteToken, secondToken]
    .map((part) => Number(part));
  const [year, month, day, hour, minute, second] = parts;
  if ([year, month, day, hour, minute, second].some((part) => !Number.isInteger(part))
    || year === undefined || month === undefined || day === undefined
    || hour === undefined || minute === undefined || second === undefined) return null;
  const result = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isSafeInteger(result) || result < 0) return null;
  const instant = new Date(result);
  if (instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day
    || instant.getUTCHours() !== hour
    || instant.getUTCMinutes() !== minute
    || instant.getUTCSeconds() !== second) return null;
  return result;
}

export function evaluateTrainingRunDraft(
  draft: TrainingRunDraft,
  capabilities: ReplayCapabilities,
  catalog: ReplayCatalog,
  segmentPlan: ReplaySegmentPreparePlan | null = null,
): TrainingRunDraftEvaluation {
  const errors: string[] = [];
  const entry = matchingEntry(draft, catalog);
  const source = draft.sourceKind === "BAR"
    ? capabilities.sources.bar
    : capabilities.sources.agg_trade;
  if (!capabilities.enabled || !capabilities.available) errors.push(t("replay.err.unavailable"));
  if (capabilities.persistence.degraded) errors.push(t("replay.err.degraded"));
  if (!source.enabled) errors.push(t("replay.err.sourceOff", { kind: draft.sourceKind }));
  if (!entry) errors.push(t("replay.err.notInCatalog"));
  if (entry && !entry.base_intervals.includes(draft.baseInterval)) {
    errors.push(t("replay.err.baseNotCovered"));
  }
  if (entry?.selected_base_interval !== draft.baseInterval) {
    errors.push(t("replay.err.baseMustMatch"));
  }
  if (!intervalTiles(draft.baseInterval, draft.displayInterval)) {
    errors.push(t("replay.err.displayNotTile"));
  }
  if (draft.startMode === "MANUAL" && draft.requestedStartMs === null) {
    errors.push(t("replay.err.manualUtc"));
  }
  if (draft.startMode === "RANDOM" && draft.requestedStartMs !== null) {
    errors.push(t("replay.err.randomNoTime"));
  }
  if (draft.bookMode === "BOOK_ASSISTED_REQUIRED") {
    if (segmentPlan?.historical_book.capability_state !== "AVAILABLE_EXACT") {
      errors.push(t("replay.err.l2Proof"));
    }
  }
  if (draft.indicatorWarmupBars < 1
    || draft.indicatorWarmupBars > capabilities.limits.max_warmup_bars) {
    errors.push(t("replay.err.warmupLimit"));
  }
  const baseIntervalSeconds = parseIntervalSeconds(draft.baseInterval);
  const baseIntervalMs = baseIntervalSeconds === null ? null : baseIntervalSeconds * 1_000;
  let visibleRows: number | null = null;
  if (draft.visibleHistoryMode === "DURATION") {
    if (draft.visibleHistoryLookbackMs === null
      || !Number.isSafeInteger(draft.visibleHistoryLookbackMs)
      || draft.visibleHistoryLookbackMs < 1) {
      errors.push(t("replay.err.visibleMs"));
    } else if (baseIntervalMs === null
      || draft.visibleHistoryLookbackMs % baseIntervalMs !== 0) {
      errors.push(t("replay.err.visibleAlign"));
    } else {
      visibleRows = draft.visibleHistoryLookbackMs / baseIntervalMs;
    }
  } else if (draft.visibleHistoryMode === "ALL_AVAILABLE") {
    if (draft.visibleHistoryLookbackMs !== null) {
      errors.push(t("replay.err.allNoDuration"));
    }
  } else {
    errors.push(t("replay.err.visibleMode"));
  }
  const maxForwardMs = capabilities.limits.max_horizon_days * 86_400_000;
  if (draft.forwardCacheMs < 1 || draft.forwardCacheMs > maxForwardMs) {
    errors.push(t("replay.err.forwardLimit"));
  }
  if (baseIntervalMs !== null && visibleRows !== null) {
    const forwardRows = Math.ceil(draft.forwardCacheMs / baseIntervalMs);
    const totalRows = Math.max(draft.indicatorWarmupBars, visibleRows)
      + forwardRows
      + 1;
    if (totalRows > capabilities.limits.max_bar_dataset_rows) {
      errors.push(t("replay.err.datasetCap"));
    }
  }
  if (segmentPlan?.history_policy.accepted === false) {
    errors.push(t("replay.err.policyRejected", { reason: segmentPlan.history_policy.blocked_reason ?? "UNKNOWN" }));
  }
  if (entry && draft.startMode === "MANUAL" && draft.requestedStartMs !== null
    && !isEligibleReplayStart(entry, draft.requestedStartMs)) {
    errors.push(t("replay.err.manualWindow"));
  }
  if (draft.name.trim().length < 1 || draft.name.trim().length > 80) {
    errors.push(t("replay.err.nameLen"));
  }
  for (const [label, value] of [
    [t("replay.hub.initialEquity"), draft.initialEquity],
    [t("replay.hub.maxLeverage"), draft.maxLeverage],
  ] as const) {
    if (!POSITIVE_DECIMAL.test(value)) errors.push(t("replay.err.positiveDecimal", { label }));
  }
  for (const [label, value] of [
    [t("replay.err.makerFee"), draft.makerFeeBps],
    [t("replay.err.takerFee"), draft.takerFeeBps],
    [t("replay.err.slippage"), draft.marketSlippageBps],
  ] as const) {
    if (!NON_NEGATIVE_DECIMAL.test(value)) errors.push(t("replay.err.nonNegDecimal", { label }));
  }
  if (catalog.blind_mode !== requiresBlindTrainingCatalog(draft)) {
    errors.push(t("replay.err.catalogMismatch"));
  }
  const accountHistoryPlan = segmentPlan?.account_history ?? null;
  let accountHistoryRef: ReplayAccountHistoryRef | null = null;
  let hedgePublicHistoryRef: ReplayHedgePublicHistoryRef | null = null;
  let simulationManifestRef: ReplayHedgeSimulationManifestRef | null = null;
  if (draft.accountDataMode === "HISTORICAL_EXACT") {
    if (draft.fundingMode === "SANDBOX_FIXED") {
      errors.push(t("replay.err.exactNoSandbox"));
    }
    if (accountHistoryPlan === null) {
      errors.push(t("replay.err.exactUnchecked"));
    } else if (accountHistoryPlan.requested_mode !== "HISTORICAL_EXACT"
      || accountHistoryPlan.capability_state !== "AVAILABLE_EXACT"
      || accountHistoryPlan.account_history_ref === null) {
      errors.push(t("replay.err.exactUnavailable", { reason: accountHistoryPlan.reason }));
    } else {
      accountHistoryRef = accountHistoryPlan.account_history_ref;
    }
  }
  if (draft.fundingMode === "HISTORICAL_EXACT") {
    if (draft.accountDataMode !== "HISTORICAL_EXACT"
      && draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push(t("replay.err.fundingFixedHist"));
    } else if (draft.accountDataMode === "HISTORICAL_EXACT" && (accountHistoryPlan === null
      || accountHistoryPlan.capability_state !== "AVAILABLE_EXACT"
      || !accountHistoryPlan.historical_funding_exact)) {
      errors.push(t("replay.err.noFundingMark"));
    }
  } else if (draft.fundingMode === "SANDBOX_FIXED") {
    if (draft.integrityMode !== "SANDBOX") {
      errors.push(t("replay.err.fixedSandboxOnly"));
    }
    if (!SIGNED_DECIMAL.test(draft.fixedFundingRate) || draft.fixedFundingRate === "-0") {
      errors.push(t("replay.err.fixedRate"));
    }
    if (!Number.isSafeInteger(draft.fundingIntervalMs)
      || draft.fundingIntervalMs < 60_000
      || draft.fundingIntervalMs > 30 * 86_400_000) {
      errors.push(t("replay.err.fundingInterval"));
    }
  }
  if (draft.positionMode === "HEDGE") {
    if (draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push(t("replay.err.hedgeSim"));
    }
    if (draft.exchange !== "binance" || draft.marketType !== "futures") {
      errors.push(t("replay.err.hedgeBinance"));
    }
    const hedgePlan = segmentPlan?.hedge_inputs ?? null;
    if (hedgePlan === null) {
      errors.push(t("replay.err.hedgeUnchecked"));
    } else if (hedgePlan.requested_position_mode !== "HEDGE"
      || (hedgePlan.capability_state !== "AVAILABLE_EXACT"
        && hedgePlan.capability_state !== "AVAILABLE_APPROX")
      || hedgePlan.hedge_public_history_ref === null
      || hedgePlan.simulation_manifest_ref === null) {
      errors.push(t("replay.err.hedgeUnavailable", { reason: hedgePlan.reason }));
    } else {
      hedgePublicHistoryRef = hedgePlan.hedge_public_history_ref;
      simulationManifestRef = hedgePlan.simulation_manifest_ref;
    }
  } else if (draft.accountDataMode === "DETERMINISTIC_SIMULATION") {
    errors.push(t("replay.err.hedgeNotOneWay"));
  }
  if (new Set(draft.allowedMutations).size !== draft.allowedMutations.length
    || draft.allowedMutations.some((item) => !REPLAY_POLICY_MUTATIONS.includes(item))) {
    errors.push(t("replay.err.whitelist"));
  }
  if (draft.integrityMode === "CHALLENGE" && draft.allowedMutations.length > 0) {
    errors.push(t("replay.err.challengeLock"));
  }
  if (draft.integrityMode === "PRACTICE" && draft.allowedMutations.length === 0) {
    errors.push(t("replay.err.practiceNeed"));
  }
  return {
    canSubmit: errors.length === 0,
    errors,
    selectedEntry: entry ?? null,
    accountHistoryRef,
    hedgePublicHistoryRef,
    simulationManifestRef,
    unsupported: getPhase6Boundaries(),
  };
}

export function evaluateTrainingRunSetupDraft(
  draft: TrainingRunDraft,
  capabilities: ReplayCapabilities,
): TrainingRunDraftEvaluation {
  const errors: string[] = [];
  const source = draft.sourceKind === "BAR"
    ? capabilities.sources.bar
    : capabilities.sources.agg_trade;
  if (!capabilities.enabled || !capabilities.available) errors.push(t("replay.err.unavailable"));
  if (capabilities.persistence.degraded) errors.push(t("replay.err.degraded"));
  if (!source.enabled) errors.push(t("replay.err.sourceOff", { kind: draft.sourceKind }));
  if (draft.startMode === "MANUAL" && draft.requestedStartMs === null) {
    errors.push(t("replay.err.manualUtc"));
  }
  if (draft.startMode === "RANDOM" && draft.requestedStartMs !== null) {
    errors.push(t("replay.err.randomNoTime"));
  }
  if (draft.startMode === "RANDOM") {
    if (draft.randomRangeStartMs === null || draft.randomRangeEndMs === null) {
      errors.push(t("replay.err.rangeNeedTimes"));
    } else if (draft.randomRangeEndMs < draft.randomRangeStartMs) {
      errors.push(t("replay.err.rangeOrder"));
    } else if ((draft.randomRangeEndMs - draft.randomRangeStartMs) % 60_000 !== 0) {
      errors.push(t("replay.err.rangeGrid"));
    }
  }
  if (draft.indicatorWarmupBars < 1
    || draft.indicatorWarmupBars > capabilities.limits.max_warmup_bars) {
    errors.push(t("replay.err.warmupLimit"));
  }
  if (draft.visibleHistoryMode === "DURATION") {
    if (draft.visibleHistoryLookbackMs === null
      || !Number.isSafeInteger(draft.visibleHistoryLookbackMs)
      || draft.visibleHistoryLookbackMs < 1) {
      errors.push(t("replay.err.visibleMs"));
    }
  } else if (draft.visibleHistoryMode === "ALL_AVAILABLE") {
    if (draft.visibleHistoryLookbackMs !== null) {
      errors.push(t("replay.err.allNoDuration"));
    }
  } else {
    errors.push(t("replay.err.visibleMode"));
  }
  const maxForwardMs = capabilities.limits.max_horizon_days * 86_400_000;
  if (draft.forwardCacheMs < 1 || draft.forwardCacheMs > maxForwardMs) {
    errors.push(t("replay.err.forwardLimit"));
  }
  if (draft.name.trim().length < 1 || draft.name.trim().length > 80) {
    errors.push(t("replay.err.nameLen"));
  }
  for (const [label, value] of [
    [t("replay.hub.initialEquity"), draft.initialEquity],
    [t("replay.hub.maxLeverage"), draft.maxLeverage],
  ] as const) {
    if (!POSITIVE_DECIMAL.test(value)) errors.push(t("replay.err.positiveDecimal", { label }));
  }
  for (const [label, value] of [
    [t("replay.err.makerFee"), draft.makerFeeBps],
    [t("replay.err.takerFee"), draft.takerFeeBps],
    [t("replay.err.slippage"), draft.marketSlippageBps],
  ] as const) {
    if (!NON_NEGATIVE_DECIMAL.test(value)) errors.push(t("replay.err.nonNegDecimal", { label }));
  }
  if (draft.accountDataMode === "HISTORICAL_EXACT") {
    if (draft.fundingMode === "SANDBOX_FIXED") {
      errors.push(t("replay.err.exactNoSandbox"));
    }
  }
  if (draft.fundingMode === "HISTORICAL_EXACT"
    && draft.accountDataMode !== "HISTORICAL_EXACT"
    && draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
    errors.push(t("replay.err.fundingFixedHist"));
  } else if (draft.fundingMode === "SANDBOX_FIXED") {
    if (draft.integrityMode !== "SANDBOX") {
      errors.push(t("replay.err.fixedSandboxOnly"));
    }
    if (!SIGNED_DECIMAL.test(draft.fixedFundingRate) || draft.fixedFundingRate === "-0") {
      errors.push(t("replay.err.fixedRate"));
    }
    if (!Number.isSafeInteger(draft.fundingIntervalMs)
      || draft.fundingIntervalMs < 60_000
      || draft.fundingIntervalMs > 30 * 86_400_000) {
      errors.push(t("replay.err.fundingInterval"));
    }
  }
  if (draft.positionMode === "HEDGE") {
    if (draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push(t("replay.err.hedgeSim"));
    }
  } else if (draft.accountDataMode === "DETERMINISTIC_SIMULATION") {
    errors.push(t("replay.err.hedgeNotOneWay"));
  }
  if (new Set(draft.allowedMutations).size !== draft.allowedMutations.length
    || draft.allowedMutations.some((item) => !REPLAY_POLICY_MUTATIONS.includes(item))) {
    errors.push(t("replay.err.whitelist"));
  }
  if (draft.integrityMode === "CHALLENGE" && draft.allowedMutations.length > 0) {
    errors.push(t("replay.err.challengeLock"));
  }
  if (draft.integrityMode === "PRACTICE" && draft.allowedMutations.length === 0) {
    errors.push(t("replay.err.practiceNeed"));
  }
  return {
    canSubmit: errors.length === 0,
    errors,
    selectedEntry: null,
    accountHistoryRef: null,
    hedgePublicHistoryRef: null,
    simulationManifestRef: null,
    unsupported: getPhase6Boundaries(),
  };
}

export function buildTrainingRunPreparationRequest(
  draft: TrainingRunDraft,
  evaluation: TrainingRunDraftEvaluation,
  catalog: ReplayCatalog,
  launchContext?: ReplayLaunchContext,
): TrainingRunPreparationPayload {
  if (!evaluation.canSubmit || evaluation.selectedEntry === null) {
    throw new TypeError("training run draft is not ready to submit");
  }
  return {
    protocol: "replay.v3",
    catalog_epoch: catalog.catalog_epoch,
    name: draft.name.trim(),
    source_kind: draft.sourceKind,
    start_mode: draft.startMode,
    exchange: draft.exchange,
    market_type: draft.marketType,
    symbol: draft.symbol,
    settlement_asset: draft.settlementAsset,
    base_interval: draft.baseInterval,
    display_interval: draft.displayInterval,
    requested_start_ms: draft.startMode === "MANUAL" ? draft.requestedStartMs : null,
    indicator_warmup_bars: draft.indicatorWarmupBars,
    visible_history_lookback: {
      mode: draft.visibleHistoryMode,
      duration_ms: draft.visibleHistoryLookbackMs,
    },
    forward_cache_ms: draft.forwardCacheMs,
    random_seed: null,
    initial_equity: draft.initialEquity,
    max_leverage: draft.maxLeverage,
    maker_fee_bps: draft.makerFeeBps,
    taker_fee_bps: draft.takerFeeBps,
    market_slippage_bps: draft.marketSlippageBps,
    integrity_mode: draft.integrityMode,
    time_disclosure_policy: draft.timeDisclosurePolicy,
    book_mode: draft.bookMode,
    margin_mode: draft.marginMode,
    position_mode: draft.positionMode,
    funding_mode: draft.fundingMode,
    account_data_mode: draft.accountDataMode,
    account_history_ref: draft.accountDataMode === "HISTORICAL_EXACT"
      ? evaluation.accountHistoryRef
      : null,
    hedge_public_history_ref: draft.positionMode === "HEDGE"
      ? evaluation.hedgePublicHistoryRef
      : null,
    simulation_manifest_ref: draft.positionMode === "HEDGE"
      ? evaluation.simulationManifestRef
      : null,
    account_fidelity: draft.positionMode === "HEDGE" ? HEDGE_ACCOUNT_FIDELITY : null,
    insurance_adl_fidelity: draft.positionMode === "HEDGE"
      ? HEDGE_INSURANCE_ADL_FIDELITY
      : null,
    fixed_funding_rate: draft.fundingMode === "SANDBOX_FIXED"
      ? draft.fixedFundingRate
      : null,
    funding_interval_ms: draft.fundingMode === "SANDBOX_FIXED"
      ? draft.fundingIntervalMs
      : null,
    allow_rule_changes: draft.integrityMode !== "CHALLENGE",
    allowed_mutations: draft.integrityMode === "SANDBOX"
      ? REPLAY_POLICY_MUTATIONS
      : draft.allowedMutations,
    ...(launchContext === undefined ? {} : {
      launch_context: {
        ...launchContext,
        exchange: draft.exchange,
        market_type: draft.marketType,
        symbol: draft.symbol,
        display_interval: draft.displayInterval,
      },
    }),
  };
}

export function buildTrainingRunCreateRequest(
  draft: TrainingRunDraft,
  evaluation: TrainingRunDraftEvaluation,
  marketSelectionHint?: ReplayLaunchContext,
): TrainingRunCreatePayload {
  if (!evaluation.canSubmit) {
    throw new TypeError("training run setup is not ready to submit");
  }
  return {
    protocol: "replay.v3",
    name: draft.name.trim(),
    source_kind: draft.sourceKind,
    start_mode: draft.startMode,
    settlement_asset: draft.settlementAsset,
    requested_start_ms: draft.startMode === "MANUAL" ? draft.requestedStartMs : null,
    random_range_start_ms: draft.startMode === "RANDOM" ? draft.randomRangeStartMs : null,
    random_range_end_ms: draft.startMode === "RANDOM" ? draft.randomRangeEndMs : null,
    indicator_warmup_bars: draft.indicatorWarmupBars,
    visible_history_lookback: {
      mode: draft.visibleHistoryMode,
      duration_ms: draft.visibleHistoryLookbackMs,
    },
    forward_cache_ms: draft.forwardCacheMs,
    random_seed: null,
    initial_equity: draft.initialEquity,
    max_leverage: draft.maxLeverage,
    maker_fee_bps: draft.makerFeeBps,
    taker_fee_bps: draft.takerFeeBps,
    market_slippage_bps: draft.marketSlippageBps,
    integrity_mode: draft.integrityMode,
    time_disclosure_policy: draft.timeDisclosurePolicy,
    book_mode: draft.bookMode,
    margin_mode: draft.marginMode,
    position_mode: draft.positionMode,
    funding_mode: draft.fundingMode,
    account_data_mode: draft.accountDataMode,
    account_fidelity: draft.positionMode === "HEDGE" ? HEDGE_ACCOUNT_FIDELITY : null,
    insurance_adl_fidelity: draft.positionMode === "HEDGE"
      ? HEDGE_INSURANCE_ADL_FIDELITY
      : null,
    fixed_funding_rate: draft.fundingMode === "SANDBOX_FIXED"
      ? draft.fixedFundingRate
      : null,
    funding_interval_ms: draft.fundingMode === "SANDBOX_FIXED"
      ? draft.fundingIntervalMs
      : null,
    allow_rule_changes: draft.integrityMode !== "CHALLENGE",
    allowed_mutations: draft.integrityMode === "SANDBOX"
      ? REPLAY_POLICY_MUTATIONS
      : draft.allowedMutations,
    market_selection_hint: marketSelectionHint ?? null,
  };
}
