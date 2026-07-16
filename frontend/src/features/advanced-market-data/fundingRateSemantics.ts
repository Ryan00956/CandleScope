import {
  FUNDING_RATE_PROVENANCE,
  FUNDING_RATE_QUALITY,
  type FundingRateData,
  type FundingRateProvenance,
  type FundingRateQuality,
  type MarketStateRecord,
} from "./advancedMarketDataTypes.js";

const LEGACY_DERIVED_PROVENANCE = "derived_estimate";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fundingData(record: MarketStateRecord): FundingRateData {
  return record.data as FundingRateData;
}

export function normalizeFundingRateProvenance(value: unknown): FundingRateProvenance | null {
  if (value === LEGACY_DERIVED_PROVENANCE) return "derived_history";
  return typeof value === "string"
    && (FUNDING_RATE_PROVENANCE as readonly string[]).includes(value)
    ? value as FundingRateProvenance
    : null;
}

export function normalizeFundingRateQuality(value: unknown): FundingRateQuality | null {
  return typeof value === "string"
    && (FUNDING_RATE_QUALITY as readonly string[]).includes(value)
    ? value as FundingRateQuality
    : null;
}

export function fundingRateProvenance(record: MarketStateRecord): FundingRateProvenance {
  const data = fundingData(record);
  const explicit = normalizeFundingRateProvenance(data.provenance);
  if (explicit) return explicit;
  if (data.sample_kind === "settlement" || data.is_final === true) {
    return "exchange_settlement";
  }
  if (data.sample_kind === "estimate" || data.sample_kind === "derived") {
    return "derived_history";
  }
  return "exchange_realtime";
}

export function fundingRateQuality(record: MarketStateRecord): FundingRateQuality {
  const data = fundingData(record);
  const explicit = normalizeFundingRateQuality(data.quality);
  if (explicit) return explicit;
  const provenance = fundingRateProvenance(record);
  if (provenance === "exchange_settlement") return "final";
  if (provenance === "derived_history") return "estimated";
  if (data.stale === true) return "stale";
  if (data.carried === true) return "carried";
  return "live";
}

export function fundingRateSampleTimeMs(record: MarketStateRecord): number {
  const data = fundingData(record);
  const provenance = fundingRateProvenance(record);
  if (provenance === "exchange_settlement") {
    if (record.key.params.view === "hybrid") return record.event_time_ms;
    return finiteNumber(data.funding_time_ms) ?? record.event_time_ms;
  }
  if (provenance === "derived_history") {
    // Hybrid history is keyed to the chart candle open. sample_time_ms is
    // retained as the no-lookahead observation cutoff for provenance details.
    return record.event_time_ms;
  }
  return finiteNumber(data.observed_at_ms) ?? record.received_at_ms;
}

export function fundingRateTargetTimeMs(record: MarketStateRecord): number | null {
  const data = fundingData(record);
  return finiteNumber(data.target_funding_time_ms)
    ?? finiteNumber(data.next_funding_time_ms)
    ?? finiteNumber(data.funding_cycle_ms)
    ?? finiteNumber(data.funding_time_ms);
}

export function isFundingRateRealtime(record: MarketStateRecord): boolean {
  return fundingRateProvenance(record) === "exchange_realtime";
}

export function isFundingRateHistory(record: MarketStateRecord): boolean {
  return !isFundingRateRealtime(record);
}

export function isFundingRateRealtimeUsable(
  record: MarketStateRecord,
  chartTimeMs: number,
  chartCloseTimeMs: number,
): boolean {
  if (!isFundingRateRealtime(record)) return false;
  const targetTimeMs = fundingRateTargetTimeMs(record);
  if (targetTimeMs !== null) {
    return chartTimeMs < targetTimeMs && chartCloseTimeMs <= targetTimeMs;
  }
  const observedAtMs = fundingRateSampleTimeMs(record);
  // Without an exchange cycle boundary, the observation is safe only in the
  // candle that actually received it. It must never become an unbounded carry.
  return observedAtMs >= chartTimeMs && observedAtMs < chartCloseTimeMs;
}
