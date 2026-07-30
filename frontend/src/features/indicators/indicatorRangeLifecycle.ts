export interface IndicatorRangeDemandIdentity {
  scope: string;
  generation: number;
}

/** Exact ownership key for hosted range work and revision supersession. */
export function buildIndicatorRangeLifecycleKey(
  seriesKey: string,
  demand: Readonly<IndicatorRangeDemandIdentity> | null | undefined,
): string {
  return JSON.stringify([
    seriesKey,
    demand?.scope || "",
    demand?.generation ?? "",
  ]);
}
