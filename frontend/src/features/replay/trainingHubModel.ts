import type { ReplayCapabilities, ReplayCatalog, ReplayCatalogEntry } from "./replayTypes.js";
import type {
  ReplayV2IntegrityMode,
  ReplayV2SourceKind,
  ReplayV2StartMode,
  ReplayV2TimeDisclosurePolicy,
  TrainingRunCreatePayload,
} from "./replayV2Types.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "./replayIntegrityModel.js";

const POSITIVE_DECIMAL = /^(?:[1-9]\d*)(?:\.\d*[1-9])?$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

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
  readonly warmupBars: number;
  readonly forwardCacheMs: number;
  readonly randomSeed: number;
  readonly initialEquity: string;
  readonly maxLeverage: string;
  readonly makerFeeBps: string;
  readonly takerFeeBps: string;
  readonly marketSlippageBps: string;
  readonly integrityMode: ReplayV2IntegrityMode;
  readonly timeDisclosurePolicy: ReplayV2TimeDisclosurePolicy;
  readonly allowedMutations: readonly ReplayPolicyMutation[];
}

export interface TrainingHubUnsupportedCapabilities {
  readonly funding: "Phase 6 尚未实现；当前只能 OFF";
  readonly historical_l2: "Phase 9 可选能力尚未实现；当前只能 OFF";
  readonly rule_changes: "Phase 4 仅支持入金、出金与不可逆时间揭示；费率、杠杆和资金费变更仍拒绝";
  readonly isolated_margin: "Phase 6 尚未实现；当前只允许 CROSS";
}

export interface TrainingRunDraftEvaluation {
  readonly canSubmit: boolean;
  readonly errors: readonly string[];
  readonly selectedEntry: ReplayCatalogEntry | null;
  readonly unsupported: TrainingHubUnsupportedCapabilities;
}

export const PHASE_5_UNSUPPORTED: TrainingHubUnsupportedCapabilities = Object.freeze({
  funding: "Phase 6 尚未实现；当前只能 OFF",
  historical_l2: "Phase 9 可选能力尚未实现；当前只能 OFF",
  rule_changes: "Phase 4 仅支持入金、出金与不可逆时间揭示；费率、杠杆和资金费变更仍拒绝",
  isolated_margin: "Phase 6 尚未实现；当前只允许 CROSS",
});

function firstEntry(catalog: ReplayCatalog): ReplayCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.selected_base_interval !== null)
    ?? catalog.entries[0];
}

export function createTrainingRunDraft(catalog: ReplayCatalog): TrainingRunDraft {
  const entry = firstEntry(catalog);
  const symbol = entry?.identity.symbol ?? "BTCUSDT";
  const baseInterval = entry?.selected_base_interval ?? entry?.base_intervals[0] ?? "1m";
  return {
    name: `${symbol} 训练`,
    sourceKind: "BAR",
    startMode: "RANDOM",
    exchange: entry?.identity.exchange ?? "binance",
    marketType: entry?.identity.market_type ?? "spot",
    symbol,
    settlementAsset: symbol.endsWith("USDT") ? "USDT" : "USDT",
    baseInterval,
    displayInterval: baseInterval,
    requestedStartMs: null,
    warmupBars: catalog.warmup_bars,
    forwardCacheMs: catalog.horizon_ms,
    randomSeed: 42,
    initialEquity: "10000",
    maxLeverage: "3",
    makerFeeBps: "2",
    takerFeeBps: "5",
    marketSlippageBps: "1",
    integrityMode: "CHALLENGE",
    timeDisclosurePolicy: catalog.blind_mode ? "HIDE_ALL" : "NONE",
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

export function evaluateTrainingRunDraft(
  draft: TrainingRunDraft,
  capabilities: ReplayCapabilities,
  catalog: ReplayCatalog,
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
  if (draft.startMode === "MANUAL" && draft.requestedStartMs === null) {
    errors.push("手动开始需要明确的毫秒时间");
  }
  if (draft.startMode === "RANDOM" && draft.requestedStartMs !== null) {
    errors.push("随机开始不能携带真实开始时间");
  }
  if (draft.warmupBars < 1 || draft.warmupBars > capabilities.limits.max_warmup_bars) {
    errors.push("预热 BAR 数超出服务端限制");
  }
  const maxForwardMs = capabilities.limits.max_horizon_days * 86_400_000;
  if (draft.forwardCacheMs < 1 || draft.forwardCacheMs > maxForwardMs) {
    errors.push("前向缓存窗口超出服务端限制");
  }
  if (!Number.isSafeInteger(draft.randomSeed) || draft.randomSeed < 0) {
    errors.push("随机种子必须是非负安全整数");
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
  if (draft.timeDisclosurePolicy !== "NONE" && !catalog.blind_mode) {
    errors.push("隐藏时间训练必须使用盲化能力目录");
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
    unsupported: PHASE_5_UNSUPPORTED,
  };
}

export function buildTrainingRunCreateRequest(
  draft: TrainingRunDraft,
  evaluation: TrainingRunDraftEvaluation,
  catalog: ReplayCatalog,
): TrainingRunCreatePayload {
  if (!evaluation.canSubmit || evaluation.selectedEntry === null) {
    throw new TypeError("training run draft is not ready to submit");
  }
  return {
    protocol: "replay.v2",
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
    warmup_bars: draft.warmupBars,
    forward_cache_ms: draft.forwardCacheMs,
    random_seed: draft.randomSeed,
    initial_equity: draft.initialEquity,
    max_leverage: draft.maxLeverage,
    maker_fee_bps: draft.makerFeeBps,
    taker_fee_bps: draft.takerFeeBps,
    market_slippage_bps: draft.marketSlippageBps,
    integrity_mode: draft.integrityMode,
    time_disclosure_policy: draft.timeDisclosurePolicy,
    book_mode: "OFF",
    margin_mode: "CROSS",
    funding_mode: "OFF",
    allow_rule_changes: draft.integrityMode !== "CHALLENGE",
    allowed_mutations: draft.integrityMode === "SANDBOX"
      ? REPLAY_POLICY_MUTATIONS
      : draft.allowedMutations,
  };
}
