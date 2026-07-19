import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { buildLiquidationPane } from "../liquidations/liquidationProjection.js";
import type {
  LiquidationRuntimeView,
  LiquidationSnapshot,
} from "../liquidations/liquidationTypes.js";
import type { MarketStateRecord } from "./advancedMarketDataTypes.js";
import {
  buildFundingRateHistoryProjection,
  buildFundingRatePaneFromHistoryProjection,
  buildOpenInterestPane,
  type FundingRateHistoryProjection,
} from "./metricPaneProjection.js";

export interface AdvancedMarketStatePaneProjectionInput {
  bars: readonly KlineBar[];
  /** SeriesWindowStore.axisRevision; advances when the in-place time axis changes. */
  barsAxisRevision: number;
  enabled: boolean;
  fundingActive: boolean;
  fundingHistory: readonly MarketStateRecord[];
  fundingPreview: MarketStateRecord | null;
  fundingRealtimeHistory: readonly MarketStateRecord[];
  interval: unknown;
  nowMs: number;
  openInterestActive: boolean;
  openInterestHistory: readonly MarketStateRecord[];
}

export interface AdvancedMarketStatePaneProjection {
  fundingPane: IndicatorSubPane | null;
  openInterestPane: IndicatorSubPane | null;
}

export interface AdvancedMarketPaneProjectionBuilders {
  buildFundingHistory(
    history: readonly MarketStateRecord[],
    bars: readonly KlineBar[],
    interval: unknown,
  ): FundingRateHistoryProjection;
  buildFundingPane(
    history: FundingRateHistoryProjection,
    realtime: {
      fundingPreview: MarketStateRecord | null;
      fundingRealtimeHistory: readonly MarketStateRecord[];
    },
    nowMs: number,
  ): IndicatorSubPane;
  buildOpenInterestPane(
    metrics: { openInterestHistory: readonly MarketStateRecord[] },
    bars: readonly KlineBar[],
  ): IndicatorSubPane;
}

export interface AdvancedMarketLiquidationPaneProjectionInput {
  bars: readonly KlineBar[];
  /** SeriesWindowStore.axisRevision; advances when the in-place time axis changes. */
  barsAxisRevision: number;
  enabled: boolean;
  interval: unknown;
  liquidationActive: boolean;
  snapshot: LiquidationSnapshot;
  view: LiquidationRuntimeView;
}

export interface AdvancedMarketLiquidationPaneProjectionBuilders {
  buildLiquidationPane(
    snapshot: LiquidationSnapshot,
    bars: readonly KlineBar[],
    interval: unknown,
    view: LiquidationRuntimeView,
  ): IndicatorSubPane;
}

const DEFAULT_BUILDERS: AdvancedMarketPaneProjectionBuilders = {
  buildFundingHistory: buildFundingRateHistoryProjection,
  buildFundingPane: buildFundingRatePaneFromHistoryProjection,
  buildOpenInterestPane,
};

const DEFAULT_LIQUIDATION_BUILDERS: AdvancedMarketLiquidationPaneProjectionBuilders = {
  buildLiquidationPane,
};

/**
 * Reference-keyed memo shared by the hook and deterministic unit tests. Each
 * market lane owns its cache, so an unrelated liquidation render cannot invoke
 * the funding/OI builders even if the caller asks for the state projection.
 */
export function createAdvancedMarketStatePaneProjectionMemo(
  builders: AdvancedMarketPaneProjectionBuilders = DEFAULT_BUILDERS,
) {
  let fundingHistoryInput: readonly MarketStateRecord[] | null = null;
  let fundingHistoryBars: readonly KlineBar[] | null = null;
  let fundingHistoryBarsAxisRevision: number | null = null;
  let fundingHistoryInterval: unknown = Symbol("unset");
  let fundingHistoryProjection: FundingRateHistoryProjection | null = null;
  let fundingPaneBase: FundingRateHistoryProjection | null = null;
  let fundingPaneBarsAxisRevision: number | null = null;
  let fundingPaneRealtime: readonly MarketStateRecord[] | null = null;
  let fundingPanePreview: MarketStateRecord | null = null;
  let fundingPaneNowMs: number | null = null;
  let fundingPane: IndicatorSubPane | null = null;
  let openInterestInput: readonly MarketStateRecord[] | null = null;
  let openInterestBars: readonly KlineBar[] | null = null;
  let openInterestBarsAxisRevision: number | null = null;
  let openInterestPane: IndicatorSubPane | null = null;
  let lastFundingPane: IndicatorSubPane | null = null;
  let lastOpenInterestPane: IndicatorSubPane | null = null;
  let lastProjection: AdvancedMarketStatePaneProjection = {
    fundingPane: null,
    openInterestPane: null,
  };

  const project = (
    input: AdvancedMarketStatePaneProjectionInput,
  ): AdvancedMarketStatePaneProjection => {
    let nextFundingPane: IndicatorSubPane | null = null;
    if (input.enabled && input.fundingActive) {
      if (fundingHistoryInput !== input.fundingHistory
        || fundingHistoryBars !== input.bars
        || fundingHistoryBarsAxisRevision !== input.barsAxisRevision
        || fundingHistoryInterval !== input.interval
        || !fundingHistoryProjection) {
        fundingHistoryInput = input.fundingHistory;
        fundingHistoryBars = input.bars;
        fundingHistoryBarsAxisRevision = input.barsAxisRevision;
        fundingHistoryInterval = input.interval;
        fundingHistoryProjection = builders.buildFundingHistory(
          input.fundingHistory,
          input.bars,
          input.interval,
        );
      }
      const hasRealtime = input.fundingPreview !== null
        || input.fundingRealtimeHistory.length > 0;
      const effectiveNowMs = hasRealtime ? input.nowMs : 0;
      if (fundingPaneBase !== fundingHistoryProjection
        || fundingPaneBarsAxisRevision !== input.barsAxisRevision
        || fundingPaneRealtime !== input.fundingRealtimeHistory
        || fundingPanePreview !== input.fundingPreview
        || fundingPaneNowMs !== effectiveNowMs
        || !fundingPane) {
        fundingPaneBase = fundingHistoryProjection;
        fundingPaneBarsAxisRevision = input.barsAxisRevision;
        fundingPaneRealtime = input.fundingRealtimeHistory;
        fundingPanePreview = input.fundingPreview;
        fundingPaneNowMs = effectiveNowMs;
        fundingPane = builders.buildFundingPane(
          fundingHistoryProjection,
          {
            fundingPreview: input.fundingPreview,
            fundingRealtimeHistory: input.fundingRealtimeHistory,
          },
          input.nowMs,
        );
      }
      nextFundingPane = fundingPane;
    }

    let nextOpenInterestPane: IndicatorSubPane | null = null;
    if (input.enabled && input.openInterestActive) {
      if (openInterestInput !== input.openInterestHistory
        || openInterestBars !== input.bars
        || openInterestBarsAxisRevision !== input.barsAxisRevision
        || !openInterestPane) {
        openInterestInput = input.openInterestHistory;
        openInterestBars = input.bars;
        openInterestBarsAxisRevision = input.barsAxisRevision;
        openInterestPane = builders.buildOpenInterestPane(
          { openInterestHistory: input.openInterestHistory },
          input.bars,
        );
      }
      nextOpenInterestPane = openInterestPane;
    }

    if (lastFundingPane === nextFundingPane && lastOpenInterestPane === nextOpenInterestPane) {
      return lastProjection;
    }
    lastFundingPane = nextFundingPane;
    lastOpenInterestPane = nextOpenInterestPane;
    lastProjection = {
      fundingPane: nextFundingPane,
      openInterestPane: nextOpenInterestPane,
    };
    return lastProjection;
  };

  return { project };
}

/**
 * Liquidation owns a separate cache so its high-frequency snapshots do not
 * invalidate funding/OI, while bar mutations still invalidate this lane by
 * SeriesWindowStore.axisRevision even when snapshot() returns the same array.
 */
export function createAdvancedMarketLiquidationPaneProjectionMemo(
  builders: AdvancedMarketLiquidationPaneProjectionBuilders = DEFAULT_LIQUIDATION_BUILDERS,
) {
  let bars: readonly KlineBar[] | null = null;
  let barsAxisRevision: number | null = null;
  let interval: unknown = Symbol("unset");
  let snapshot: LiquidationSnapshot | null = null;
  let view: LiquidationRuntimeView | null = null;
  let pane: IndicatorSubPane | null = null;

  const project = (
    input: AdvancedMarketLiquidationPaneProjectionInput,
  ): IndicatorSubPane | null => {
    if (!input.enabled || !input.liquidationActive) return null;
    if (bars !== input.bars
      || barsAxisRevision !== input.barsAxisRevision
      || interval !== input.interval
      || snapshot !== input.snapshot
      || view !== input.view
      || !pane) {
      bars = input.bars;
      barsAxisRevision = input.barsAxisRevision;
      interval = input.interval;
      snapshot = input.snapshot;
      view = input.view;
      pane = builders.buildLiquidationPane(
        input.snapshot,
        input.bars,
        input.interval,
        input.view,
      );
    }
    return pane;
  };

  return { project };
}
