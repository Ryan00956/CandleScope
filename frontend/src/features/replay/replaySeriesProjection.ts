import { buildChartDatasetKey } from "../chart-session/chartDatasetKey.js";
import { asSeriesKey, toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { WindowDelta } from "../market-data/klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../market-data/window/windowDeltas.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type {
  ReplayAnyBarBuilderSnapshot,
  ReplayBarProjectionUpdate,
  ReplayBarUpdate,
  ReplayDisplayBar,
  ReplayFinalStateSeriesPatch,
  ReplaySessionSnapshot,
  ReplayTradeBarBuilderSnapshot,
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
  const volume = finiteDecimal(bar.volume, "volume");
  const quoteVolume = bar.quote_volume === null ? null : finiteDecimal(bar.quote_volume, "quote_volume");
  const takerBuyBase = bar.taker_buy_base === null ? null : finiteDecimal(bar.taker_buy_base, "taker_buy_base");
  const takerBuyQuote = bar.taker_buy_quote === null ? null : finiteDecimal(bar.taker_buy_quote, "taker_buy_quote");
  return {
    time,
    // The chart axis is the display bucket open, while viewport transfers
    // must keep the most recently revealed base-bar identity.  Keeping this
    // lineage on the row prevents a forming coarse bucket from collapsing an
    // anchor such as 12:07 back to its 12:00 display time.
    sourceFromTime: time,
    sourceToTime: Math.floor(bar.last_base_open_ms / 1_000),
    open: finiteDecimal(bar.open, "open"),
    high: finiteDecimal(bar.high, "high"),
    low: finiteDecimal(bar.low, "low"),
    close: finiteDecimal(bar.close, "close"),
    volume,
    quote_volume: quoteVolume,
    quoteVolume,
    trades: bar.trades,
    taker_buy_base: takerBuyBase,
    taker_buy_quote: takerBuyQuote,
    takerBuyBase,
    takerBuyQuote,
    replayCloseTimeMs: bar.close_time_ms,
    replayLastBaseOpenMs: bar.last_base_open_ms,
    replayComponentCount: bar.component_count,
    replayExpectedComponents: bar.expected_components,
    replayClosed: bar.is_closed,
    is_closed: bar.is_closed,
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
  if (bar.is_closed && bar.close_time_ms > publicTimeMs) {
    throw new ReplaySeriesProjectionError(
      "closed replay bar exceeds the public cursor",
    );
  }
}

function isTradeBuilder(
  builder: ReplayAnyBarBuilderSnapshot,
): builder is ReplayTradeBarBuilderSnapshot {
  return "public_projection" in builder;
}

export function replaceReplaySeriesFromSnapshot(
  store: SeriesWindowStore,
  snapshot: ReplaySessionSnapshot,
  {
    preserveRevealedPrefix = false,
  }: {
    readonly preserveRevealedPrefix?: boolean;
  } = {},
): WindowDelta {
  const builder = snapshot.components.bar_builder;
  const bars = isTradeBuilder(builder)
    ? builder.public_projection.bars
    : [...builder.closed_bars, ...(builder.active_bar ? [builder.active_bar] : [])];
  let previousOpenTimeMs: number | null = null;
  for (const bar of bars) {
    assertRevealed(bar, snapshot.cursor.virtual_time_ms);
    if (previousOpenTimeMs !== null && bar.open_time_ms <= previousOpenTimeMs) {
      throw new ReplaySeriesProjectionError("replay snapshot bars are not strictly increasing");
    }
    previousOpenTimeMs = bar.open_time_ms;
  }
  const rows = bars.map(replayDisplayBarToKline);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.time <= rows[index - 1]!.time) {
      throw new ReplaySeriesProjectionError("replay snapshot chart times are not strictly increasing");
    }
  }
  store.seriesKey = asSeriesKey(buildReplayDatasetKey(snapshot));
  store.intervalSeconds = (
    isTradeBuilder(builder) ? builder.bar_builder.display_interval_ms : builder.display_interval_ms
  ) / 1_000;
  return store.replace(rows, {
    source: "replay-snapshot",
    sessionId: snapshot.session_id,
    dataEpoch: snapshot.data_epoch,
    publicTimelineEpoch: builder.replay_start_ms,
    sourceSequence: snapshot.cursor.source_sequence,
    publicTimeMs: snapshot.cursor.virtual_time_ms,
    preserveRevealedPrefix,
  });
}

export function applyReplayBarUpdate(
  store: SeriesWindowStore,
  update: ReplayBarProjectionUpdate,
  publicTimeMs: number,
): WindowDelta {
  const updates = update.action === "batch" ? update.updates : [update];
  const planned = planReplayBarUpdates(store, updates, publicTimeMs);
  let last: WindowDelta | null = null;
  for (const item of planned) last = applyPlannedReplayBarUpdate(store, item);
  if (last === null) throw new ReplaySeriesProjectionError("replay update batch is empty");
  return last;
}

export function replaceReplaySeriesFromFinalState(
  store: SeriesWindowStore,
  patch: ReplayFinalStateSeriesPatch,
  publicTimeMs: number,
  sourceSequence: number,
): WindowDelta {
  for (const bar of patch.bars) assertRevealed(bar, publicTimeMs);
  if (patch.retained_count === 0) {
    if (patch.bars.length !== 0) {
      throw new ReplaySeriesProjectionError("empty final-state series carries bars");
    }
    return store.replace([], {
      source: "replay-final-state",
      sourceSequence,
      publicTimeMs,
    });
  }
  const retainedStart = patch.retained_start_open_ms;
  const retainedEnd = patch.retained_end_open_ms;
  const replaceFrom = patch.replace_from_open_ms;
  if (retainedStart === null || retainedEnd === null || replaceFrom === null) {
    throw new ReplaySeriesProjectionError("final-state series boundaries are incomplete");
  }
  const prefix = store.snapshot().filter((row) => {
    const openTimeMs = Number(row.time) * 1_000;
    return openTimeMs >= retainedStart && openTimeMs < replaceFrom;
  });
  const suffix = patch.bars.map(replayDisplayBarToKline);
  const rows = [...prefix, ...suffix];
  if (rows.length !== patch.retained_count) {
    throw new ReplaySeriesProjectionError("final-state retained bar count does not converge");
  }
  if (Number(rows[0]?.time) * 1_000 !== retainedStart
    || Number(rows.at(-1)?.time) * 1_000 !== retainedEnd) {
    throw new ReplaySeriesProjectionError("final-state retained series boundary does not converge");
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.time <= rows[index - 1]!.time) {
      throw new ReplaySeriesProjectionError("final-state retained series is not strictly increasing");
    }
  }
  return store.replace(rows, {
    source: "replay-final-state",
    sourceSequence,
    publicTimeMs,
  });
}

interface PlannedReplayBarUpdate {
  readonly update: ReplayBarUpdate;
  readonly row: KlineBar;
}

function sameKlineBar(left: KlineBar, right: KlineBar): boolean {
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && Object.is(leftRecord[key], rightRecord[key]));
}

function planReplayBarUpdates(
  store: SeriesWindowStore,
  updates: readonly ReplayBarUpdate[],
  publicTimeMs: number,
): readonly PlannedReplayBarUpdate[] {
  if (updates.length === 0) throw new ReplaySeriesProjectionError("replay update batch is empty");
  const planned: PlannedReplayBarUpdate[] = [];
  let simulatedTail = store.last();
  let previousSourceSequence: number | null = null;
  let previousBaseOpenTimeMs: number | null = null;
  for (const update of updates) {
    assertRevealed(update.bar, publicTimeMs);
    if (update.base_open_time_ms > publicTimeMs) {
      throw new ReplaySeriesProjectionError("replay source update exceeds the public cursor");
    }
    if (previousSourceSequence !== null && update.source_sequence < previousSourceSequence) {
      throw new ReplaySeriesProjectionError("replay update batch source sequence moved backward");
    }
    if (previousBaseOpenTimeMs !== null && update.base_open_time_ms < previousBaseOpenTimeMs) {
      throw new ReplaySeriesProjectionError("replay update batch base time moved backward");
    }
    const row = replayDisplayBarToKline(update.bar);
    if (update.action === "append") {
      if (simulatedTail !== null && row.time <= simulatedTail.time) {
        throw new ReplaySeriesProjectionError("replay append does not extend the revealed series tail");
      }
    } else {
      if (simulatedTail === null || row.time !== simulatedTail.time) {
        throw new ReplaySeriesProjectionError("replay tick does not target the revealed series tail");
      }
      if (sameKlineBar(simulatedTail, row)) {
        throw new ReplaySeriesProjectionError("replay tick does not change the revealed series tail");
      }
    }
    simulatedTail = row;
    previousSourceSequence = update.source_sequence;
    previousBaseOpenTimeMs = update.base_open_time_ms;
    planned.push({ update, row });
  }
  return planned;
}

function applyPlannedReplayBarUpdate(
  store: SeriesWindowStore,
  planned: PlannedReplayBarUpdate,
): WindowDelta {
  const { update, row } = planned;
  const meta = {
    source: `replay-${update.action}`,
    sourceSequence: update.source_sequence,
    baseOpenTimeMs: update.base_open_time_ms,
  };
  if (update.action === "append") {
    return store.isEmpty() ? store.replace([row], meta) : store.applyRange([row], meta);
  }
  const delta = store.applyTick(row, meta);
  if (delta.type !== WINDOW_DELTA_TYPES.TICK) {
    throw new ReplaySeriesProjectionError("replay tick does not target the revealed series tail");
  }
  return delta;
}

export function latestReplayBar(store: SeriesWindowStore): KlineBar | null {
  return store.last();
}
