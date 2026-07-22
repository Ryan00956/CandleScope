import type {
  ReplayCapabilities,
  ReplayCatalog,
  ReplayCatalogEntry,
  ReplayExecutionFidelity,
  ReplaySessionConfig,
  ReplaySessionState,
  ReplaySourceKind,
} from "./replayTypes.js";
import type { ReplayStoreSnapshot } from "./replayStore.js";
import type { ReplayV2RunState } from "./replayV2Types.js";

export const REPLAY_ACTIVITY_VIEW_LIMIT = 20;

export function recentReplayActivity<T>(items: readonly T[]): readonly T[] {
  return items.slice(-REPLAY_ACTIVITY_VIEW_LIMIT).reverse();
}

export interface ReplaySessionDraft {
  readonly sourceKind: ReplaySourceKind;
  readonly catalogIdentity: string;
  readonly displayInterval: string;
  readonly startPolicy: "random_eligible" | "manual";
  readonly requestedStartMs: number | null;
  readonly warmupBars: number;
  readonly horizonMs: number;
  readonly randomSeed: number;
  readonly blindMode: boolean;
  readonly initialEquity: string;
  readonly makerBps: string;
  readonly takerBps: string;
  readonly marketSlippageBps: string;
  readonly maxLeverage: string;
}

export interface ReplaySessionDraftEvaluation {
  readonly entry: ReplayCatalogEntry | null;
  readonly baseInterval: string | null;
  readonly availableDisplayIntervals: readonly string[];
  readonly dataFidelity: string;
  readonly executionFidelity: ReplayExecutionFidelity;
  readonly canSubmit: boolean;
  readonly disabledReason: string | null;
}

const INTERVAL_MS: Readonly<Record<string, number>> = {
  "1s": 1_000,
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

export function replayCatalogIdentity(entry: ReplayCatalogEntry): string {
  const { exchange, market_type: marketType, symbol } = entry.identity;
  return `${exchange}:${marketType}:${symbol}`;
}

function canonicalDecimal(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return fallback;
  const parsed = trimmed.replace(/^\+/, "");
  const [whole = "0", fraction = ""] = parsed.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

export function createReplaySessionDraft(catalog: ReplayCatalog | null): ReplaySessionDraft {
  const entry = catalog?.entries[0] ?? null;
  const baseInterval = entry?.selected_base_interval ?? entry?.base_intervals[0] ?? "1m";
  return {
    sourceKind: "bar",
    catalogIdentity: entry ? replayCatalogIdentity(entry) : "",
    displayInterval: baseInterval === "1m" ? "5m" : baseInterval,
    startPolicy: "random_eligible",
    requestedStartMs: null,
    warmupBars: catalog?.warmup_bars ?? 500,
    horizonMs: catalog?.horizon_ms ?? 604_800_000,
    randomSeed: 20_260_718,
    blindMode: catalog?.blind_mode ?? true,
    initialEquity: "10000",
    makerBps: "2",
    takerBps: "4",
    marketSlippageBps: "1",
    maxLeverage: "5",
  };
}

export function replayDisplayIntervals(baseInterval: string | null): readonly string[] {
  const baseMs = baseInterval ? INTERVAL_MS[baseInterval] : undefined;
  if (!baseMs) return baseInterval ? [baseInterval] : [];
  return Object.entries(INTERVAL_MS)
    .filter(([, intervalMs]) => intervalMs >= baseMs && intervalMs % baseMs === 0)
    .map(([interval]) => interval);
}

export function evaluateReplaySessionDraft(
  draft: ReplaySessionDraft,
  capabilities: ReplayCapabilities | null,
  catalog: ReplayCatalog | null,
): ReplaySessionDraftEvaluation {
  const entry = catalog?.entries.find((candidate) => replayCatalogIdentity(candidate) === draft.catalogIdentity) ?? null;
  const baseInterval = entry?.selected_base_interval ?? entry?.base_intervals[0] ?? null;
  const availableDisplayIntervals = replayDisplayIntervals(baseInterval);
  const sourceCapability = capabilities?.sources[draft.sourceKind];
  let disabledReason: string | null = null;
  if (!capabilities?.enabled || !capabilities.available) disabledReason = capabilities?.reason ?? "Replay capability unavailable";
  else if (!sourceCapability?.enabled) {
    disabledReason = sourceCapability?.reason
      ?? (draft.sourceKind === "agg_trade" ? "Aggregate-trade replay unavailable" : "BAR replay unavailable");
  } else if (!entry) disabledReason = "No eligible exact reference BAR dataset is available";
  else if (!baseInterval) disabledReason = "The selected dataset has no resolved base interval";
  else if (!availableDisplayIntervals.includes(draft.displayInterval)) disabledReason = "Display interval cannot be aggregated from the resolved base interval";
  else if (entry.eligible_window_count < 1) disabledReason = "No eligible replay window matches the current bounds";
  else if (draft.startPolicy === "manual" && draft.requestedStartMs === null) disabledReason = "Choose a manual start time";
  return {
    entry,
    baseInterval,
    availableDisplayIntervals,
    dataFidelity: sourceCapability?.fidelity
      ?? (draft.sourceKind === "bar" ? entry?.quality : null)
      ?? "UNAVAILABLE",
    executionFidelity: draft.sourceKind === "agg_trade" ? "AGG_TRADE_TAPE" : "BAR_CONSERVATIVE",
    canSubmit: disabledReason === null,
    disabledReason,
  };
}

export function buildReplaySessionConfig(
  draft: ReplaySessionDraft,
  evaluation: ReplaySessionDraftEvaluation,
): ReplaySessionConfig {
  if (!evaluation.canSubmit || !evaluation.entry || !evaluation.baseInterval) {
    throw new Error(evaluation.disabledReason ?? "Replay session configuration is incomplete");
  }
  const identity = evaluation.entry.identity;
  return {
    protocol: "replay.v1",
    source_kind: draft.sourceKind,
    exchange: identity.exchange,
    market_type: identity.market_type,
    symbol: identity.symbol,
    base_interval: evaluation.baseInterval,
    display_interval: draft.displayInterval,
    start_policy: draft.startPolicy,
    requested_start_ms: draft.startPolicy === "manual" ? draft.requestedStartMs : null,
    warmup_bars: Math.max(1, Math.trunc(draft.warmupBars)),
    horizon_ms: Math.max(60_000, Math.trunc(draft.horizonMs)),
    random_seed: Math.max(0, Math.trunc(draft.randomSeed)),
    quality_mode: "exact",
    blind_mode: draft.blindMode,
    initial_equity: canonicalDecimal(draft.initialEquity, "10000"),
    quote_asset: "USDT",
    execution_model: "paper_linear_v1",
    fee_model: {
      maker_bps: canonicalDecimal(draft.makerBps, "2"),
      taker_bps: canonicalDecimal(draft.takerBps, "4"),
    },
    slippage_model: {
      kind: "fixed_bps",
      market_bps: canonicalDecimal(draft.marketSlippageBps, "1"),
    },
    max_leverage: canonicalDecimal(draft.maxLeverage, "5"),
    pause_on_controller_loss: true,
  };
}

export function replayOwnsController(store: ReplayStoreSnapshot, clientInstanceId: string): boolean {
  return store.controllerClientId === clientInstanceId;
}

export function replayEffectiveTrainingState(
  globalState: ReplayV2RunState | null | undefined,
  adapterState: ReplaySessionState | null,
  controllerClientId: string | null,
): ReplaySessionState | ReplayV2RunState | null {
  if (globalState === "ERROR" || adapterState === "ERROR") return "ERROR";
  if (globalState === "ENDED" || adapterState === "ENDED") return "ENDED";
  if (controllerClientId === null && (globalState === "PLAYING" || globalState === "ADVANCING")) {
    return adapterState === "INITIALIZING" ? "INITIALIZING" : "PAUSED";
  }
  if (controllerClientId === null && adapterState === "PLAYING") return "PAUSED";
  return globalState ?? adapterState;
}

export function replayProgress(store: ReplayStoreSnapshot): number | null {
  const config = store.sessionConfig;
  if (!config || store.virtualTimeMs === null || store.replayStartMs === null || config.horizon_ms <= 0) return null;
  return Math.max(0, Math.min(1, (store.virtualTimeMs - store.replayStartMs) / config.horizon_ms));
}

export function formatReplaySyntheticTime(valueMs: number, originMs: number): string {
  const delta = valueMs - originMs;
  const sign = delta < 0 ? "-" : "+";
  const magnitude = Math.abs(delta);
  const day = Math.floor(magnitude / 86_400_000);
  const withinDay = magnitude % 86_400_000;
  const hours = Math.floor(withinDay / 3_600_000);
  const minutes = Math.floor((withinDay % 3_600_000) / 60_000);
  const seconds = Math.floor((withinDay % 60_000) / 1_000);
  return `D${sign}${day} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatReplayPublicTime(
  valueMs: number | null,
  { blindMode, originMs }: { blindMode: boolean; originMs: number | null },
): string {
  if (valueMs === null) return "--";
  if (blindMode && originMs !== null) return formatReplaySyntheticTime(valueMs, originMs);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(valueMs);
}
