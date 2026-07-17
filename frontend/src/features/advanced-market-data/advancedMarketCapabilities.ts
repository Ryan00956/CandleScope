import {
  ADVANCED_MARKET_CHANNELS,
  type AdvancedMarketChannel,
} from "./advancedMarketDataTypes.js";

export interface AdvancedMarketCapabilityInput {
  marketType: string;
  raw: Record<string, unknown> | null;
}

export interface AdvancedMarketChannelSupport {
  supported: boolean;
  realtime: boolean;
  history: boolean;
  reason: string | null;
}

export interface AdvancedMarketCapabilitySnapshot {
  channels: Record<AdvancedMarketChannel, AdvancedMarketChannelSupport>;
  summarySupported: boolean;
}

const METRIC_CHANNELS = new Set<AdvancedMarketChannel>([
  "funding_rate",
  "open_interest",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailableReason(marketType: string, raw: Record<string, unknown> | null): string {
  if (!raw) return "交易所能力信息尚未就绪";
  if (marketType.trim().toLowerCase() === "spot") return "仅合约市场支持";
  return "当前交易所或市场不支持";
}

function unsupported(reason: string): AdvancedMarketChannelSupport {
  return {
    supported: false,
    realtime: false,
    history: false,
    reason,
  };
}

export function resolveAdvancedMarketCapabilities({
  marketType,
  raw,
}: AdvancedMarketCapabilityInput): AdvancedMarketCapabilitySnapshot {
  const reason = unavailableReason(marketType, raw);
  const channels = Object.fromEntries(
    ADVANCED_MARKET_CHANNELS.map((channel) => [channel, unsupported(reason)]),
  ) as Record<AdvancedMarketChannel, AdvancedMarketChannelSupport>;

  if (!raw) return { channels, summarySupported: false };

  const normalizedMarketType = marketType.trim().toLowerCase();
  const rawChannels = Array.isArray(raw.channels) ? raw.channels : [];
  for (const item of rawChannels) {
    if (!isRecord(item) || typeof item.channel !== "string") continue;
    const channel = item.channel.trim().toLowerCase() as AdvancedMarketChannel;
    if (!ADVANCED_MARKET_CHANNELS.includes(channel)) continue;
    const marketTypes = Array.isArray(item.market_types)
      ? item.market_types.map((value) => String(value).trim().toLowerCase())
      : [];
    if (!marketTypes.includes(normalizedMarketType)) continue;

    const realtime = item.realtime === true;
    const history = item.history === true;
    const requiresHistory = METRIC_CHANNELS.has(channel);
    const supported = realtime && (!requiresHistory || history);
    channels[channel] = {
      supported,
      realtime,
      history,
      reason: supported
        ? null
        : requiresHistory
          ? "当前频道缺少完整的实时或历史能力"
          : "当前频道不支持实时数据",
    };
  }

  const summarySupported = (
    channels.mark_price.supported
    && channels.index_price.supported
  );
  channels.basis = summarySupported
    ? {
        supported: true,
        realtime: true,
        history: false,
        reason: null,
      }
    : unsupported(reason);

  return { channels, summarySupported };
}
