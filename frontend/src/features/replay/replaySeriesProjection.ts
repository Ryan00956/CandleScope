import { buildChartDatasetKey } from "../chart-session/chartDatasetKey.js";
import { asSeriesKey, toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { WindowDelta } from "../market-data/klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../market-data/window/windowDeltas.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type {
  ReplayBarUpdate,
  ReplayDisplayBar,
  ReplaySessionSnapshot,
} from "./replayTypes.js";

export class ReplaySeriesProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplaySeriesProjectionError";
  }
}

function finiteDecimal(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ReplaySeriesProjectionError(`${field} cannot be represented by the chart runtime`);
  }
  return parsed;
}

export function replayDisplayBarToKline(bar: ReplayDisplayBar): KlineBar {
  const time = toEpochSeconds(Math.floor(bar.open_time_ms / 1_000));
  if (time == null) throw new ReplaySeriesProjectionError("bar open time is invalid");
  return {
    time,
    open: finiteDecimal(bar.open, "open"),
    high: finiteDecimal(bar.high, "high"),
    low: finiteDecimal(bar.low, "low"),
    close: finiteDecimal(bar.close, "close"),
    volume: finiteDecimal(bar.volume, "volume"),
    quoteVolume: bar.quote_volume === null ? null : finiteDecimal(bar.quote_volume, "quote_volume"),
    trades: bar.trades,
    takerBuyBase: bar.taker_buy_base === null ? null : finiteDecimal(bar.taker_buy_base, "taker_buy_base"),
    takerBuyQuote: bar.taker_buy_quote === null ? null : finiteDecimal(bar.taker_buy_quote, "taker_buy_quote"),
    replayCloseTimeMs: bar.close_time_ms,
    replayLastBaseOpenMs: bar.last_base_open_ms,
    replayComponentCount: bar.component_count,
    replayExpectedComponents: bar.expected_components,
    replayClosed: bar.is_closed,
    replaySynthetic: bar.synthetic,
  };
}

export function buildReplayDatasetKey(snapshot: ReplaySessionSnapshot): string {
  return buildChartDatasetKey({
    exchange: snapshot.config.exchange,
    marketType: snapshot.config.market_type,
    symbol: snapshot.config.symbol,
    interval: snapshot.config.display_interval,
    sourceKind: "replay",
    replaySessionId: snapshot.session_id,
    dataEpoch: snapshot.data_epoch,
    publicTimelineEpoch: snapshot.components.bar_builder.replay_start_ms,
  });
}

function assertRevealed(bar: ReplayDisplayBar, publicTimeMs: number): void {
  if (bar.open_time_ms > publicTimeMs || bar.last_base_open_ms > publicTimeMs) {
    throw new ReplaySeriesProjectionError("replay bar exceeds the public cursor");
  }
}

export function replaceReplaySeriesFromSnapshot(
  store: SeriesWindowStore,
  snapshot: ReplaySessionSnapshot,
): WindowDelta {
  const builder = snapshot.components.bar_builder;
  const bars = [...builder.closed_bars, ...(builder.active_bar ? [builder.active_bar] : [])];
  for (const bar of bars) assertRevealed(bar, snapshot.cursor.virtual_time_ms);
  const rows = bars.map(replayDisplayBarToKline);
  store.seriesKey = asSeriesKey(buildReplayDatasetKey(snapshot));
  store.intervalSeconds = builder.display_interval_ms / 1_000;
  return store.replace(rows, {
    source: "replay-snapshot",
    sessionId: snapshot.session_id,
    dataEpoch: snapshot.data_epoch,
    publicTimelineEpoch: builder.replay_start_ms,
    sourceSequence: snapshot.cursor.source_sequence,
  });
}

export function applyReplayBarUpdate(
  store: SeriesWindowStore,
  update: ReplayBarUpdate,
  publicTimeMs: number,
): WindowDelta {
  assertRevealed(update.bar, publicTimeMs);
  if (update.base_open_time_ms > publicTimeMs) {
    throw new ReplaySeriesProjectionError("replay source update exceeds the public cursor");
  }
  const row = replayDisplayBarToKline(update.bar);
  const meta = {
    source: `replay-${update.action}`,
    sourceSequence: update.source_sequence,
    baseOpenTimeMs: update.base_open_time_ms,
  };
  if (update.action === "append") {
    return store.isEmpty() ? store.replace([row], meta) : store.applyRange([row], meta);
  }
  const delta = store.applyTick(row, meta);
  if (delta.type === WINDOW_DELTA_TYPES.NOOP) {
    throw new ReplaySeriesProjectionError("replay tick does not target the revealed series tail");
  }
  return delta;
}

export function latestReplayBar(store: SeriesWindowStore): KlineBar | null {
  return store.last();
}
