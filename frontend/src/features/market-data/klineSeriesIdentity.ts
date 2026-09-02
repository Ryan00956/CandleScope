export const DEFAULT_KLINE_SERIES_SEMANTICS = {
  assetClass: "crypto",
  seriesVariant: "native",
  priceAdjustment: "raw",
  sessionVariant: "continuous",
  volumeSemantics: "base_asset",
} as const;

export interface KlineSeriesIdentityInput {
  providerId?: string;
  venue?: string;
  assetClass?: string;
  seriesVariant?: string;
  priceAdjustment?: string;
  sessionVariant?: string;
  volumeSemantics?: string;
}

export interface ResolvedKlineSeriesIdentity {
  providerId: string;
  venue: string;
  assetClass: string;
  seriesVariant: string;
  priceAdjustment: string;
  sessionVariant: string;
  volumeSemantics: string;
}

function normalized(value: unknown, fallback: string): string {
  return String(value || fallback).trim().toLowerCase() || fallback;
}

export function resolveKlineSeriesIdentity(
  exchange: unknown,
  identity: KlineSeriesIdentityInput | null | undefined = undefined,
): ResolvedKlineSeriesIdentity {
  const route = normalized(exchange, "unknown");
  return {
    providerId: normalized(identity?.providerId, route),
    venue: normalized(identity?.venue, route),
    assetClass: normalized(identity?.assetClass, DEFAULT_KLINE_SERIES_SEMANTICS.assetClass),
    seriesVariant: normalized(identity?.seriesVariant, DEFAULT_KLINE_SERIES_SEMANTICS.seriesVariant),
    priceAdjustment: normalized(identity?.priceAdjustment, DEFAULT_KLINE_SERIES_SEMANTICS.priceAdjustment),
    sessionVariant: normalized(identity?.sessionVariant, DEFAULT_KLINE_SERIES_SEMANTICS.sessionVariant),
    volumeSemantics: normalized(identity?.volumeSemantics, DEFAULT_KLINE_SERIES_SEMANTICS.volumeSemantics),
  };
}

export function isLegacyKlineSeriesIdentity(
  exchange: unknown,
  identity: KlineSeriesIdentityInput | null | undefined,
): boolean {
  const resolved = resolveKlineSeriesIdentity(exchange, identity);
  const route = normalized(exchange, "unknown");
  return resolved.providerId === route
    && resolved.venue === route
    && resolved.assetClass === DEFAULT_KLINE_SERIES_SEMANTICS.assetClass
    && resolved.seriesVariant === DEFAULT_KLINE_SERIES_SEMANTICS.seriesVariant
    && resolved.priceAdjustment === DEFAULT_KLINE_SERIES_SEMANTICS.priceAdjustment
    && resolved.sessionVariant === DEFAULT_KLINE_SERIES_SEMANTICS.sessionVariant
    && resolved.volumeSemantics === DEFAULT_KLINE_SERIES_SEMANTICS.volumeSemantics;
}

export function klineSeriesIdentityKey(
  exchange: unknown,
  identity: KlineSeriesIdentityInput | null | undefined,
): string {
  const resolved = resolveKlineSeriesIdentity(exchange, identity);
  return [
    resolved.providerId,
    resolved.venue,
    resolved.assetClass,
    resolved.seriesVariant,
    resolved.priceAdjustment,
    resolved.sessionVariant,
    resolved.volumeSemantics,
  ].join(":");
}

export function klineSeriesIdentityQuery(
  exchange: unknown,
  identity: KlineSeriesIdentityInput | null | undefined,
): Record<string, string> {
  if (isLegacyKlineSeriesIdentity(exchange, identity)) return {};
  const resolved = resolveKlineSeriesIdentity(exchange, identity);
  return {
    provider_id: resolved.providerId,
    venue: resolved.venue,
    asset_class: resolved.assetClass,
    series_variant: resolved.seriesVariant,
    price_adjustment: resolved.priceAdjustment,
    session_variant: resolved.sessionVariant,
    volume_semantics: resolved.volumeSemantics,
  };
}
