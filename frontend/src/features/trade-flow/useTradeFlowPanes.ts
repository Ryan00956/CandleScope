import { useMemo, useState, useSyncExternalStore } from "react";
import type { WindowDelta } from "../market-data/klineContracts.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import { createKlineOrderFlowProjectionMemo } from "./klineOrderFlowProjection.js";
import type { TradeFlowRuntime } from "./tradeFlowTypes.js";

const EMPTY_PANES: readonly IndicatorSubPane[] = Object.freeze([]);

function requiresFullProjection(delta: WindowDelta): boolean {
  return delta.type !== "tick"
    || delta.appended === true
    || Number(delta.trimmedLeft || 0) !== 0
    || Number(delta.trimmedRight || 0) !== 0;
}

interface SeriesProjectionRevision {
  version: number;
  structureRevision: number;
}

const EMPTY_REVISION: SeriesProjectionRevision = Object.freeze({ version: 0, structureRevision: 0 });

function createSeriesProjectionRevisionSource(
  seriesStore: SeriesWindowStore | null | undefined,
  enabled: boolean,
): {
  getSnapshot(): SeriesProjectionRevision;
  subscribe(listener: () => void): () => void;
} {
  if (!enabled || !seriesStore) {
    return { getSnapshot: () => EMPTY_REVISION, subscribe: () => () => undefined };
  }
  let snapshot: SeriesProjectionRevision = Object.freeze({
    version: Number(seriesStore.version),
    structureRevision: 0,
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => seriesStore.subscribe((delta) => {
      snapshot = Object.freeze({
        version: Number(seriesStore.version),
        structureRevision: snapshot.structureRevision + (requiresFullProjection(delta) ? 1 : 0),
      });
      listener();
    }),
  };
}

export function useTradeFlowPanes(
  runtime: TradeFlowRuntime,
  seriesStore: SeriesWindowStore | null | undefined,
): readonly IndicatorSubPane[] {
  const { cvd, delta } = runtime.view.preferences.indicators;
  const cvdVisible = cvd.added && cvd.visible;
  const deltaVisible = delta.added && delta.visible;
  const enabled = cvdVisible || deltaVisible;
  const revisionSource = useMemo(
    () => createSeriesProjectionRevisionSource(seriesStore, enabled),
    [enabled, seriesStore],
  );
  const revision = useSyncExternalStore(
    revisionSource.subscribe,
    revisionSource.getSnapshot,
    () => EMPTY_REVISION,
  );
  const [projection] = useState(createKlineOrderFlowProjectionMemo);

  return useMemo(() => {
    if (!enabled || !seriesStore) return EMPTY_PANES;
    const panes = projection.project({
      bars: seriesStore.snapshot(),
      enabled: true,
      forceFull: false,
      intervalSeconds: seriesStore.intervalSeconds,
      structureRevision: revision.structureRevision,
    });
    return panes.filter((pane) => (
      (pane.id === "trade-flow-cvd" && cvdVisible)
      || (pane.id === "trade-flow-delta" && deltaVisible)
    ));
  }, [cvdVisible, deltaVisible, enabled, projection, revision, seriesStore]);
}
