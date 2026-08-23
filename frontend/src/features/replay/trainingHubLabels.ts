import { t } from "../../i18n/index.js";
import type { ReplayCatalogEntry } from "./replayTypes.js";
import type {
  ReplayV2IntegrityMode,
  ReplayV2RunState,
  ReplayV2SourceKind,
  ReplayV2TimeDisclosurePolicy,
  TrainingRunCompatibility,
} from "./replayV2Types.js";

export function trainingRunStateLabel(state: ReplayV2RunState): string {
  switch (state) {
    case "AWAITING_MARKET":
      return t("replay.state.awaiting");
    case "PAUSED":
      return t("replay.state.paused");
    case "PLAYING":
      return t("replay.state.playing");
    case "ADVANCING":
      return t("replay.state.advancing");
    case "ENDED":
      return t("replay.state.ended");
    case "ERROR":
      return t("replay.state.error");
  }
}

export function trainingIntegrityLabel(mode: ReplayV2IntegrityMode): string {
  switch (mode) {
    case "CHALLENGE":
      return t("replay.hub.challenge");
    case "PRACTICE":
      return t("replay.hub.practice");
    case "SANDBOX":
      return t("replay.hub.sandbox");
  }
}

export function trainingSourceKindLabel(kind: ReplayV2SourceKind): string {
  return kind === "AGG_TRADE" ? t("replay.source.agg") : t("replay.source.bar");
}

export function trainingTimeDisclosureLabel(
  policy: ReplayV2TimeDisclosurePolicy,
): string {
  switch (policy) {
    case "NONE":
      return t("replay.time.none");
    case "HIDE_YEAR":
      return t("replay.time.hideYear");
    case "HIDE_MONTH":
      return t("replay.time.hideMonth");
    case "HIDE_DAY":
      return t("replay.time.hideDay");
    case "HIDE_HOUR":
      return t("replay.time.hideHour");
    case "HIDE_MINUTE":
      return t("replay.time.hideMinute");
    case "HIDE_ALL":
      return t("replay.time.hideAll");
  }
}

export function trainingCompatibilityLabel(
  value: TrainingRunCompatibility,
): string {
  return value === "READY" ? t("replay.compat.ready") : t("replay.compat.blocked");
}

export function trainingMarketTypeLabel(marketType: string): string {
  switch (marketType) {
    case "futures":
      return t("replay.market.futures");
    case "spot":
      return t("replay.market.spot");
    case "margin":
      return t("replay.market.margin");
    default:
      return marketType;
  }
}

export function trainingExchangeLabel(exchange: string): string {
  switch (exchange) {
    case "binance":
      return "Binance";
    case "okx":
      return "OKX";
    default:
      return exchange;
  }
}

export function trainingVenueLabel(entry: Pick<ReplayCatalogEntry, "identity">): string {
  return `${trainingExchangeLabel(entry.identity.exchange)} · ${trainingMarketTypeLabel(entry.identity.market_type)}`;
}

export function trainingMarketKey(entry: Pick<ReplayCatalogEntry, "identity">): string {
  return `${entry.identity.exchange}:${entry.identity.market_type}:${entry.identity.symbol}`;
}

export function isReplayInitialMarketAvailable(entry: ReplayCatalogEntry): boolean {
  return entry.selected_base_interval !== null
    && entry.start_compatibility?.state === "READY";
}

function padUtc(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatReplayUtcDate(ms: number): string {
  const instant = new Date(ms);
  return `${instant.getUTCFullYear()}-${padUtc(instant.getUTCMonth() + 1)}-${padUtc(instant.getUTCDate())}`;
}

export function formatReplayUtcDateTime(ms: number): string {
  const instant = new Date(ms);
  return `${formatReplayUtcDate(ms)} ${padUtc(instant.getUTCHours())}:${padUtc(instant.getUTCMinutes())} UTC`;
}

export function formatTrainingEquity(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function formatReplayMarketCoverage(
  entry: ReplayCatalogEntry,
  blind: boolean,
): string {
  if (blind) return t("replay.coverage.hidden");
  const bounds = entry.bounds;
  if (bounds === null) return t("replay.coverage.pending");
  return `${formatReplayUtcDate(bounds.earliest_open_ms)} – ${formatReplayUtcDate(bounds.latest_closed_open_ms)}`;
}
