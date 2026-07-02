import { useEffect } from "react";

const PREFETCH_DELAY_MS = 2_000;
const PREFETCH_INTERVAL_GAP_MS = 200;
const PREFETCH_BAR_LIMIT = 500;

export function useChartBackgroundPrefetch({
  symbol,
  exchange,
  marketType,
  trackedIntervals,
  hasCache,
  seriesDataFeed,
  enabled = true,
}) {
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    const prefetch = async () => {
      for (const intv of trackedIntervals) {
        if (cancelled) break;
        if (hasCache(symbol, intv, { marketType, exchange })) continue;

        try {
          await seriesDataFeed.getLatest(
            { exchange, marketType, symbol, interval: intv },
            {
              limit: PREFETCH_BAR_LIMIT,
              source: "background-prefetch",
              apiSource: "background-prefetch",
              commit: "cache",
            },
          );
          if (cancelled) break;
        } catch {
          // Best-effort warming only; active interval loading owns user-visible errors.
        }

        await new Promise((resolve) => setTimeout(resolve, PREFETCH_INTERVAL_GAP_MS));
      }
    };

    const timer = setTimeout(prefetch, PREFETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, exchange, hasCache, marketType, seriesDataFeed, symbol, trackedIntervals]);
}
