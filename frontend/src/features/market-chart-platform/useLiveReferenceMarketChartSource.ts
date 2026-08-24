import { useEffect, useMemo } from "react";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { MarketDataRuntimeContract } from "../market-data/marketDataRuntimeContract.js";
import {
  createLiveReferenceSource,
  type LiveReferenceMarketChartSourceRuntime,
} from "./marketChartSourceRuntime.js";
import { marketChartSourceEffectGuard } from "./marketChartSourceLifecycle.js";

export function useLiveReferenceMarketChartSource(input: {
  sourceId: string;
  session: ChartSession;
  datasetKey: string;
  marketData: MarketDataRuntimeContract;
  paused: boolean;
}): LiveReferenceMarketChartSourceRuntime {
  const { sourceId } = input;
  const source = useMemo(
    () => createLiveReferenceSource(input),
    // The adapter is intentionally retained for the lifetime of one source id.
    // Its explicit update method keeps the Host-owned runtime binding current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId],
  );
  source.update(input);

  useEffect(() => {
    if (input.paused) source.pause();
    else source.resume();
  }, [input.paused, source]);

  useEffect(() => marketChartSourceEffectGuard.mount(source), [source]);
  return source;
}
