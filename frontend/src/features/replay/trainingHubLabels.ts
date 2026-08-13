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
      return "待选商品";
    case "PAUSED":
      return "已暂停";
    case "PLAYING":
      return "进行中";
    case "ADVANCING":
      return "推进中";
    case "ENDED":
      return "已结束";
    case "ERROR":
      return "异常";
  }
}

export function trainingIntegrityLabel(mode: ReplayV2IntegrityMode): string {
  switch (mode) {
    case "CHALLENGE":
      return "挑战";
    case "PRACTICE":
      return "练习";
    case "SANDBOX":
      return "沙盒";
  }
}

export function trainingSourceKindLabel(kind: ReplayV2SourceKind): string {
  return kind === "AGG_TRADE" ? "成交" : "K 线";
}

export function trainingTimeDisclosureLabel(
  policy: ReplayV2TimeDisclosurePolicy,
): string {
  switch (policy) {
    case "NONE":
      return "显示历史时间";
    case "HIDE_YEAR":
      return "隐藏年份";
    case "HIDE_MONTH":
      return "隐藏年月";
    case "HIDE_DAY":
      return "相对日期";
    case "HIDE_HOUR":
      return "相对小时";
    case "HIDE_MINUTE":
      return "相对分钟";
    case "HIDE_ALL":
      return "完全相对时间";
  }
}

export function trainingCompatibilityLabel(
  value: TrainingRunCompatibility,
): string {
  return value === "READY" ? "可用" : "不可用";
}

export function trainingMarketTypeLabel(marketType: string): string {
  switch (marketType) {
    case "futures":
      return "永续";
    case "spot":
      return "现货";
    case "margin":
      return "杠杆";
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
  if (blind) return "覆盖已按披露策略隐藏";
  const bounds = entry.bounds;
  if (bounds === null) return "覆盖范围待确认";
  return `${formatReplayUtcDate(bounds.earliest_open_ms)} – ${formatReplayUtcDate(bounds.latest_closed_open_ms)}`;
}
