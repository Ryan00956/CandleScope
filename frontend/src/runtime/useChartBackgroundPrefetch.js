import { useEffect } from "react";
import { fetchLatestKlines } from "../services/api";

const PREFETCH_DELAY_MS = 2_000;
const PREFETCH_INTERVAL_GAP_MS = 200;
const PREFETCH_BAR_LIMIT = 500;

export function useChartBackgroundPrefetch({
  symbol,
  exchange,
  marketType,
  trackedIntervals,
  hasCache,
  setCache,
}) {
  useEffect(() => {
    let cancelled = false;

    const prefetch = async () => {
      for (const intv of trackedIntervals) {
        if (cancelled) break;
        if (hasCache(symbol, intv, { marketType, exchange })) continue;

        try {
          const result = await fetchLatestKlines(
            symbol,
            intv,
            PREFETCH_BAR_LIMIT,
            marketType,
            exchange,
            "background-prefetch",
          );
          if (cancelled) break;
          if (result?.data?.length) {
            setCache(symbol, intv, result.data, { marketType, exchange });
          }
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
  }, [exchange, hasCache, marketType, setCache, symbol, trackedIntervals]);
}
