import { t } from "../../i18n/index.js";
import { parseIntervalSeconds } from "../../utils/intervals.js";
import type { LiquidationCapability } from "./liquidationTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveLiquidationCapability({
  marketType,
  interval,
  raw,
}: {
  marketType: string;
  interval: unknown;
  raw: Record<string, unknown> | null;
}): LiquidationCapability {
  const normalizedMarketType = marketType.trim().toLowerCase();
  if (normalizedMarketType === "spot") {
    return { supported: false, reason: t("market.cap.futuresOnly") };
  }
  const intervalSeconds = parseIntervalSeconds(interval);
  if (intervalSeconds === null || intervalSeconds < 60) {
    return { supported: false, reason: t("liq.cap.minInterval") };
  }
  if (!raw) return { supported: false, reason: t("market.cap.notReady") };
  const channels = Array.isArray(raw.channels) ? raw.channels : [];
  for (const item of channels) {
    if (!isRecord(item) || String(item.channel || "").trim().toLowerCase() !== "liquidation") {
      continue;
    }
    const marketTypes = Array.isArray(item.market_types)
      ? item.market_types.map((value) => String(value).trim().toLowerCase())
      : [];
    if (!marketTypes.includes(normalizedMarketType)) continue;
    if (item.realtime === true) return { supported: true, reason: null };
  }
  return { supported: false, reason: t("liq.cap.noStream") };
}
