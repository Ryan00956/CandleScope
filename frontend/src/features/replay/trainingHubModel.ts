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
  readonly account_history: "精确账户只接受服务端已校验并固定的 mark/index/funding/规则归档；公开 K 线代理不算 exact";
  readonly funding: "HEDGE 可使用 pinned historical funding；事件、同刻 mark 或规则覆盖不完整时 fail closed";
  readonly historical_l2: "仅连续、可 pin、已验证的 Binance USD-M 历史 L2 可开启；不含真实盘口排队";
  readonly rule_changes: "费率、杠杆与 Sandbox 固定资金费可按白名单审计变更";
  readonly isolated_margin: "CROSS 与 ISOLATED 均可用；逐仓开仓前必须显式分配保证金";
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

export const PHASE_6_BOUNDARIES: TrainingHubUnsupportedCapabilities = Object.freeze({
  account_history: "精确账户只接受服务端已校验并固定的 mark/index/funding/规则归档；公开 K 线代理不算 exact",
  funding: "HEDGE 可使用 pinned historical funding；事件、同刻 mark 或规则覆盖不完整时 fail closed",
  historical_l2: "仅连续、可 pin、已验证的 Binance USD-M 历史 L2 可开启；不含真实盘口排队",
  rule_changes: "费率、杠杆与 Sandbox 固定资金费可按白名单审计变更",
  isolated_margin: "CROSS 与 ISOLATED 均可用；逐仓开仓前必须显式分配保证金",
});

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
    name: "回放训练",
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
    positionMode: "HEDGE",
    fundingMode: "HISTORICAL_EXACT",
    accountDataMode: "DETERMINISTIC_SIMULATION",
    fixedFundingRate: "0.0001",
    fundingIntervalMs: 28_800_000,
    bookMode: "BOOK_ASSISTED_REQUIRED",
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
  if (!capabilities.enabled || !capabilities.available) errors.push("回放服务当前不可用");
  if (capabilities.persistence.degraded) errors.push("回放持久化处于降级状态");
  if (!source.enabled) errors.push(`${draft.sourceKind} 历史源不可用`);
  if (!entry) errors.push("所选商品不在当前能力目录中");
  if (entry && !entry.base_intervals.includes(draft.baseInterval)) {
    errors.push("基础周期不在服务端精确覆盖范围内");
  }
  if (entry?.selected_base_interval !== draft.baseInterval) {
    errors.push("基础周期必须使用服务端选定的精确周期");
  }
  if (!intervalTiles(draft.baseInterval, draft.displayInterval)) {
    errors.push("当前显示周期不能由服务端选定的基础周期精确拼接");
  }
  if (draft.startMode === "MANUAL" && draft.requestedStartMs === null) {
    errors.push("手动开始需要明确的 UTC 时间");
  }
  if (draft.startMode === "RANDOM" && draft.requestedStartMs !== null) {
    errors.push("随机开始不能携带真实开始时间");
  }
  if (draft.bookMode === "BOOK_ASSISTED_REQUIRED") {
    if (draft.startMode !== "MANUAL" || draft.requestedStartMs === null) {
      errors.push("历史盘口必须使用明确的手动开始时间");
    }
    if (segmentPlan?.historical_book.capability_state !== "AVAILABLE_EXACT") {
      errors.push("历史盘口尚未取得连续、可 pin 的 exact L2 能力证明");
    }
  }
  if (draft.indicatorWarmupBars < 1
    || draft.indicatorWarmupBars > capabilities.limits.max_warmup_bars) {
    errors.push("指标预热 BAR 数超出服务端限制");
  }
  const baseIntervalSeconds = parseIntervalSeconds(draft.baseInterval);
  const baseIntervalMs = baseIntervalSeconds === null ? null : baseIntervalSeconds * 1_000;
  let visibleRows: number | null = null;
  if (draft.visibleHistoryMode === "DURATION") {
    if (draft.visibleHistoryLookbackMs === null
      || !Number.isSafeInteger(draft.visibleHistoryLookbackMs)
      || draft.visibleHistoryLookbackMs < 1) {
      errors.push("可见历史时长必须是正的安全整数毫秒");
    } else if (baseIntervalMs === null
      || draft.visibleHistoryLookbackMs % baseIntervalMs !== 0) {
      errors.push("可见历史时长必须精确对齐基础周期");
    } else {
      visibleRows = draft.visibleHistoryLookbackMs / baseIntervalMs;
    }
  } else if (draft.visibleHistoryMode === "ALL_AVAILABLE") {
    if (draft.visibleHistoryLookbackMs !== null) {
      errors.push("全部可用历史不能同时指定固定时长");
    }
  } else {
    errors.push("可见历史模式不受支持");
  }
  const maxForwardMs = capabilities.limits.max_horizon_days * 86_400_000;
  if (draft.forwardCacheMs < 1 || draft.forwardCacheMs > maxForwardMs) {
    errors.push("前向缓存窗口超出服务端限制");
  }
  if (baseIntervalMs !== null && visibleRows !== null) {
    const forwardRows = Math.ceil(draft.forwardCacheMs / baseIntervalMs);
    const totalRows = Math.max(draft.indicatorWarmupBars, visibleRows)
      + forwardRows
      + 1;
    if (totalRows > capabilities.limits.max_bar_dataset_rows) {
      errors.push("指标预热、可见历史与前向缓存合计超出不可变数据集上限");
    }
  }
  if (segmentPlan?.history_policy.accepted === false) {
    errors.push(`服务端拒绝当前历史策略：${segmentPlan.history_policy.blocked_reason ?? "UNKNOWN"}`);
  }
  if (entry && draft.startMode === "MANUAL" && draft.requestedStartMs !== null
    && !isEligibleReplayStart(entry, draft.requestedStartMs)) {
    errors.push("手动开始时间必须落在服务端合格窗口且对齐基础周期");
  }
  if (draft.name.trim().length < 1 || draft.name.trim().length > 80) {
    errors.push("名称必须为 1–80 个字符");
  }
  for (const [label, value] of [
    ["初始权益", draft.initialEquity],
    ["最大杠杆", draft.maxLeverage],
  ] as const) {
    if (!POSITIVE_DECIMAL.test(value)) errors.push(`${label}必须是正的规范十进制字符串`);
  }
  for (const [label, value] of [
    ["Maker 费率", draft.makerFeeBps],
    ["Taker 费率", draft.takerFeeBps],
    ["市价滑点", draft.marketSlippageBps],
  ] as const) {
    if (!NON_NEGATIVE_DECIMAL.test(value)) errors.push(`${label}必须是非负规范十进制字符串`);
  }
  if (catalog.blind_mode !== requiresBlindTrainingCatalog(draft)) {
    errors.push("当前能力目录与开始方式/时间披露策略不匹配");
  }
  const accountHistoryPlan = segmentPlan?.account_history ?? null;
  let accountHistoryRef: ReplayAccountHistoryRef | null = null;
  let hedgePublicHistoryRef: ReplayHedgePublicHistoryRef | null = null;
  let simulationManifestRef: ReplayHedgeSimulationManifestRef | null = null;
  if (draft.accountDataMode === "HISTORICAL_EXACT") {
    if (draft.startMode !== "MANUAL" || draft.requestedStartMs === null) {
      errors.push("精确账户历史必须使用明确的手动开始时间");
    }
    if (draft.fundingMode === "SANDBOX_FIXED") {
      errors.push("精确账户历史不能混用 Sandbox 合成资金费");
    }
    if (accountHistoryPlan === null) {
      errors.push("尚未按当前参数校验精确账户历史归档");
    } else if (accountHistoryPlan.requested_mode !== "HISTORICAL_EXACT"
      || accountHistoryPlan.capability_state !== "AVAILABLE_EXACT"
      || accountHistoryPlan.account_history_ref === null) {
      errors.push(`精确账户历史不可用：${accountHistoryPlan.reason}`);
    } else {
      accountHistoryRef = accountHistoryPlan.account_history_ref;
    }
  }
  if (draft.fundingMode === "HISTORICAL_EXACT") {
    if (draft.accountDataMode !== "HISTORICAL_EXACT"
      && draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push("历史精确资金费必须使用固定历史输入");
    } else if (draft.accountDataMode === "HISTORICAL_EXACT" && (accountHistoryPlan === null
      || accountHistoryPlan.capability_state !== "AVAILABLE_EXACT"
      || !accountHistoryPlan.historical_funding_exact)) {
      errors.push("当前精确账户归档没有完整 funding 与同刻 mark");
    }
  } else if (draft.fundingMode === "SANDBOX_FIXED") {
    if (draft.integrityMode !== "SANDBOX") {
      errors.push("固定资金费只允许用于 Sandbox 近似练习");
    }
    if (!SIGNED_DECIMAL.test(draft.fixedFundingRate) || draft.fixedFundingRate === "-0") {
      errors.push("固定资金费率必须是规范十进制字符串");
    }
    if (!Number.isSafeInteger(draft.fundingIntervalMs)
      || draft.fundingIntervalMs < 60_000
      || draft.fundingIntervalMs > 30 * 86_400_000) {
      errors.push("资金费结算间隔必须在 1 分钟至 30 天之间");
    }
  }
  if (draft.positionMode === "HEDGE") {
    if (draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push("双向持仓必须使用版本化确定性模拟账户");
    }
    if (draft.startMode !== "MANUAL" || draft.requestedStartMs === null) {
      errors.push("双向持仓必须使用明确的手动开始时间以 pin 全部历史输入");
    }
    if (draft.exchange !== "binance" || draft.marketType !== "futures") {
      errors.push("双向持仓当前要求 Binance USD-M futures 历史输入");
    }
    if (draft.bookMode !== "BOOK_ASSISTED_REQUIRED") {
      errors.push("双向持仓必须启用连续历史 L2 强平执行");
    }
    if (draft.fundingMode !== "HISTORICAL_EXACT") {
      errors.push("双向持仓必须使用已 pin 的历史资金费与同刻 mark");
    }
    const hedgePlan = segmentPlan?.hedge_inputs ?? null;
    if (hedgePlan === null) {
      errors.push("尚未按当前参数校验双向持仓公开历史与模拟清单");
    } else if (hedgePlan.requested_position_mode !== "HEDGE"
      || hedgePlan.capability_state !== "AVAILABLE_EXACT"
      || hedgePlan.hedge_public_history_ref === null
      || hedgePlan.simulation_manifest_ref === null) {
      errors.push(`双向持仓输入不可用：${hedgePlan.reason}`);
    } else {
      hedgePublicHistoryRef = hedgePlan.hedge_public_history_ref;
      simulationManifestRef = hedgePlan.simulation_manifest_ref;
    }
  } else if (draft.accountDataMode === "DETERMINISTIC_SIMULATION") {
    errors.push("确定性双向模拟账户不能用于单向持仓");
  }
  if (new Set(draft.allowedMutations).size !== draft.allowedMutations.length
    || draft.allowedMutations.some((item) => !REPLAY_POLICY_MUTATIONS.includes(item))) {
    errors.push("规则变更白名单包含重复或未知项");
  }
  if (draft.integrityMode === "CHALLENGE" && draft.allowedMutations.length > 0) {
    errors.push("Challenge 模式必须锁定全部规则变更");
  }
  if (draft.integrityMode === "PRACTICE" && draft.allowedMutations.length === 0) {
    errors.push("Practice 模式必须显式选择至少一项可审计变更");
  }
  return {
    canSubmit: errors.length === 0,
    errors,
    selectedEntry: entry ?? null,
    accountHistoryRef,
    hedgePublicHistoryRef,
    simulationManifestRef,
    unsupported: PHASE_6_BOUNDARIES,
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
  if (!capabilities.enabled || !capabilities.available) errors.push("回放服务当前不可用");
  if (capabilities.persistence.degraded) errors.push("回放持久化处于降级状态");
  if (!source.enabled) errors.push(`${draft.sourceKind} 历史源不可用`);
  if (draft.startMode === "MANUAL" && draft.requestedStartMs === null) {
    errors.push("手动开始需要明确的 UTC 时间");
  }
  if (draft.startMode === "RANDOM" && draft.requestedStartMs !== null) {
    errors.push("随机开始不能携带真实开始时间");
  }
  if (draft.startMode === "RANDOM") {
    if (draft.randomRangeStartMs === null || draft.randomRangeEndMs === null) {
      errors.push("区间随机需要明确的起止时间");
    } else if (draft.randomRangeEndMs < draft.randomRangeStartMs) {
      errors.push("随机区间结束时间不能早于开始时间");
    } else if ((draft.randomRangeEndMs - draft.randomRangeStartMs) % 60_000 !== 0) {
      errors.push("随机区间起止时间必须使用同一分钟网格");
    }
  }
  if (draft.bookMode === "BOOK_ASSISTED_REQUIRED"
    && (draft.startMode !== "MANUAL" || draft.requestedStartMs === null)) {
    errors.push("历史盘口必须使用明确的手动开始时间");
  }
  if (draft.indicatorWarmupBars < 1
    || draft.indicatorWarmupBars > capabilities.limits.max_warmup_bars) {
    errors.push("指标预热 BAR 数超出服务端限制");
  }
  if (draft.visibleHistoryMode === "DURATION") {
    if (draft.visibleHistoryLookbackMs === null
      || !Number.isSafeInteger(draft.visibleHistoryLookbackMs)
      || draft.visibleHistoryLookbackMs < 1) {
      errors.push("可见历史时长必须是正的安全整数毫秒");
    }
  } else if (draft.visibleHistoryMode === "ALL_AVAILABLE") {
    if (draft.visibleHistoryLookbackMs !== null) {
      errors.push("全部可用历史不能同时指定固定时长");
    }
  } else {
    errors.push("可见历史模式不受支持");
  }
  const maxForwardMs = capabilities.limits.max_horizon_days * 86_400_000;
  if (draft.forwardCacheMs < 1 || draft.forwardCacheMs > maxForwardMs) {
    errors.push("前向缓存窗口超出服务端限制");
  }
  if (draft.name.trim().length < 1 || draft.name.trim().length > 80) {
    errors.push("名称必须为 1–80 个字符");
  }
  for (const [label, value] of [
    ["初始权益", draft.initialEquity],
    ["最大杠杆", draft.maxLeverage],
  ] as const) {
    if (!POSITIVE_DECIMAL.test(value)) errors.push(`${label}必须是正的规范十进制字符串`);
  }
  for (const [label, value] of [
    ["Maker 费率", draft.makerFeeBps],
    ["Taker 费率", draft.takerFeeBps],
    ["市价滑点", draft.marketSlippageBps],
  ] as const) {
    if (!NON_NEGATIVE_DECIMAL.test(value)) errors.push(`${label}必须是非负规范十进制字符串`);
  }
  if (draft.accountDataMode === "HISTORICAL_EXACT") {
    if (draft.startMode !== "MANUAL" || draft.requestedStartMs === null) {
      errors.push("精确账户历史必须使用明确的手动开始时间");
    }
    if (draft.fundingMode === "SANDBOX_FIXED") {
      errors.push("精确账户历史不能混用 Sandbox 合成资金费");
    }
  }
  if (draft.fundingMode === "HISTORICAL_EXACT"
    && draft.accountDataMode !== "HISTORICAL_EXACT"
    && draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
    errors.push("历史精确资金费必须使用固定历史输入");
  } else if (draft.fundingMode === "SANDBOX_FIXED") {
    if (draft.integrityMode !== "SANDBOX") {
      errors.push("固定资金费只允许用于 Sandbox 近似练习");
    }
    if (!SIGNED_DECIMAL.test(draft.fixedFundingRate) || draft.fixedFundingRate === "-0") {
      errors.push("固定资金费率必须是规范十进制字符串");
    }
    if (!Number.isSafeInteger(draft.fundingIntervalMs)
      || draft.fundingIntervalMs < 60_000
      || draft.fundingIntervalMs > 30 * 86_400_000) {
      errors.push("资金费结算间隔必须在 1 分钟至 30 天之间");
    }
  }
  if (draft.positionMode === "HEDGE") {
    if (draft.accountDataMode !== "DETERMINISTIC_SIMULATION") {
      errors.push("双向持仓必须使用版本化确定性模拟账户");
    }
    if (draft.startMode !== "MANUAL" || draft.requestedStartMs === null) {
      errors.push("双向持仓必须使用明确的手动开始时间以 pin 全部历史输入");
    }
    if (draft.bookMode !== "BOOK_ASSISTED_REQUIRED") {
      errors.push("双向持仓必须启用连续历史 L2 强平执行");
    }
    if (draft.fundingMode !== "HISTORICAL_EXACT") {
      errors.push("双向持仓必须使用已 pin 的历史资金费与同刻 mark");
    }
  } else if (draft.accountDataMode === "DETERMINISTIC_SIMULATION") {
    errors.push("确定性双向模拟账户不能用于单向持仓");
  }
  if (new Set(draft.allowedMutations).size !== draft.allowedMutations.length
    || draft.allowedMutations.some((item) => !REPLAY_POLICY_MUTATIONS.includes(item))) {
    errors.push("规则变更白名单包含重复或未知项");
  }
  if (draft.integrityMode === "CHALLENGE" && draft.allowedMutations.length > 0) {
    errors.push("Challenge 模式必须锁定全部规则变更");
  }
  if (draft.integrityMode === "PRACTICE" && draft.allowedMutations.length === 0) {
    errors.push("Practice 模式必须显式选择至少一项可审计变更");
  }
  return {
    canSubmit: errors.length === 0,
    errors,
    selectedEntry: null,
    accountHistoryRef: null,
    hedgePublicHistoryRef: null,
    simulationManifestRef: null,
    unsupported: PHASE_6_BOUNDARIES,
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
