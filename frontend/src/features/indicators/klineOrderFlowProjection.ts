import { t, tPlural } from "../../i18n/index.js";
import type {
  IndicatorPanePointMetadata,
  IndicatorSubPane,
} from "./indicatorPaneProjection.js";
import type { IndicatorValuePoint } from "./indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { createIntervalTimeline, type IntervalTimeline } from "../../utils/intervalTimeline.js";

const BUY_COLOR = "#22c55e";
const SELL_COLOR = "#ef4444";
const DELTA_COLOR = "#38bdf8";
const CVD_COLOR = "#a78bfa";

interface ProjectionState {
  firstTime: number | null;
  lastTime: number | null;
  length: number;
  cvd: IndicatorValuePoint[];
  delta: IndicatorValuePoint[];
  buy: IndicatorValuePoint[];
  sell: IndicatorValuePoint[];
  missing: number;
  discontinuities: number;
}

export interface KlineOrderFlowProjectionInput {
  bars: readonly KlineBar[];
  enabled: boolean;
  forceFull: boolean;
  interval?: unknown;
  intervalSeconds: number | null;
  structureRevision?: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveKlineOrderFlow(bar: KlineBar | undefined): {
  buy: number;
  sell: number;
  delta: number;
  contribution: number;
} | null {
  const buy = finite(bar?.taker_buy_base ?? bar?.takerBuyBase);
  const sell = finite(bar?.order_flow?.taker_sell_base);
  const delta = finite(bar?.order_flow?.volume_delta_base);
  const contribution = finite(bar?.order_flow?.cvd_contribution_base);
  if (
    buy !== null
    && buy >= 0
    && sell !== null
    && sell >= 0
    && delta !== null
    && contribution !== null
  ) {
    return { buy, sell, delta, contribution };
  }
  const volume = finite(bar?.volume);
  if (buy === null || buy < 0 || volume === null || volume < buy) return null;
  const derivedSell = volume - buy;
  const derivedDelta = buy - derivedSell;
  return {
    buy,
    sell: derivedSell,
    delta: derivedDelta,
    contribution: derivedDelta,
  };
}

function expectedNext(
  previous: KlineBar | undefined,
  current: KlineBar | undefined,
  timeline: IntervalTimeline | null,
): boolean {
  if (!previous || !current) return false;
  return timeline ? timeline.isSuccessor(previous.time, current.time) : current.time > previous.time;
}

function projectionTimeline(interval: unknown, intervalSeconds: number | null): IntervalTimeline | null {
  return createIntervalTimeline(interval)
    ?? createIntervalTimeline(intervalSeconds === null ? null : `${intervalSeconds}s`);
}

function tailPoint(
  points: readonly IndicatorValuePoint[],
  time: number,
  value: number | null,
  color?: string,
): IndicatorValuePoint[] {
  const next = points.slice();
  if (next.at(-1)?.time === time) next.pop();
  if (value !== null) next.push({ time, value, ...(color ? { color } : {}) });
  return next;
}

function fullProjection(bars: readonly KlineBar[], timeline: IntervalTimeline | null): ProjectionState {
  const delta: IndicatorValuePoint[] = [];
  const buy: IndicatorValuePoint[] = [];
  const sell: IndicatorValuePoint[] = [];
  let missing = 0;
  let discontinuities = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (!expectedNext(bars[index - 1], bars[index], timeline)) discontinuities += 1;
  }
  for (const bar of bars) {
    const values = resolveKlineOrderFlow(bar);
    if (!values) {
      missing += 1;
      continue;
    }
    delta.push({ time: bar.time, value: values.delta, color: values.delta >= 0 ? BUY_COLOR : SELL_COLOR });
    buy.push({ time: bar.time, value: values.buy, color: BUY_COLOR });
    sell.push({ time: bar.time, value: -values.sell, color: SELL_COLOR });
  }

  let suffixStart = bars.length;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (!resolveKlineOrderFlow(bars[index])) break;
    if (index < bars.length - 1 && !expectedNext(bars[index], bars[index + 1], timeline)) break;
    suffixStart = index;
  }
  const cvd: IndicatorValuePoint[] = [];
  let cumulative = 0;
  for (let index = suffixStart; index < bars.length; index += 1) {
    const bar = bars[index];
    const values = resolveKlineOrderFlow(bar);
    if (!bar || !values) break;
    cumulative += values.contribution;
    cvd.push({ time: bar.time, value: cumulative });
  }
  return {
    firstTime: bars.at(0)?.time ?? null,
    lastTime: bars.at(-1)?.time ?? null,
    length: bars.length,
    cvd,
    delta,
    buy,
    sell,
    missing,
    discontinuities,
  };
}

function tailProjection(
  previous: ProjectionState,
  bars: readonly KlineBar[],
  timeline: IntervalTimeline | null,
): ProjectionState | null {
  const bar = bars.at(-1);
  if (!bar
    || previous.length !== bars.length
    || previous.firstTime !== (bars.at(0)?.time ?? null)
    || previous.lastTime !== bar.time) return null;
  const values = resolveKlineOrderFlow(bar);
  const hadDelta = previous.delta.at(-1)?.time === bar.time;
  // A forming bar can switch between unavailable and available order-flow
  // fields. That changes the start of the latest valid CVD suffix, so a tail
  // patch cannot reconstruct the correct prefix from the previous output.
  if (Boolean(values) !== hadDelta) return null;
  const missing = Math.max(0, previous.missing + (values ? 0 : 1) - (hadDelta ? 0 : 1));
  const before = bars.at(-2);
  let cvdValue: number | null = null;
  if (values) {
    const cvdWithoutTail = previous.cvd.at(-1)?.time === bar.time
      ? previous.cvd.slice(0, -1)
      : previous.cvd;
    const base = cvdWithoutTail.at(-1);
    const contiguous = !before || expectedNext(before, bar, timeline);
    cvdValue = contiguous && (!before || base?.time === before.time)
      ? (base?.value ?? 0) + values.contribution
      : values.contribution;
  }
  return {
    ...previous,
    cvd: tailPoint(previous.cvd, bar.time, cvdValue),
    delta: tailPoint(
      previous.delta,
      bar.time,
      values?.delta ?? null,
      values ? (values.delta >= 0 ? BUY_COLOR : SELL_COLOR) : undefined,
    ),
    buy: tailPoint(previous.buy, bar.time, values?.buy ?? null, BUY_COLOR),
    sell: tailPoint(previous.sell, bar.time, values ? -values.sell : null, SELL_COLOR),
    missing,
  };
}

function formatValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function orderFlowPointMetadata(
  points: readonly IndicatorValuePoint[],
  label: string,
  qualityLabel: string,
): IndicatorPanePointMetadata[] {
  return points.map((point) => {
    const valueLabel = formatValue(point.value);
    return {
      time: point.time,
      value: point.value,
      valueLabel,
      sourceLabel: t("pane.flow.klineProxy"),
      qualityLabel,
      appearance: "estimated",
      accessibilityLabel: `${label} ${valueLabel}`,
    };
  });
}

function panes(state: ProjectionState): readonly IndicatorSubPane[] {
  const hasGap = state.missing > 0 || state.discontinuities > 0;
  const coverageParts = [
    t("pane.flow.klineProxy"),
    ...(state.missing > 0 ? [tPlural("pane.flow.missing", state.missing)] : []),
    ...(state.discontinuities > 0 ? [tPlural("pane.flow.gaps", state.discontinuities)] : []),
  ];
  const coverage = hasGap
    ? t("pane.flow.cvdGap", { coverage: coverageParts.join(" · ") })
    : t("pane.flow.cvdWindow");
  return [
    {
      id: "trade-flow-cvd",
      label: "CVD",
      owner: { kind: "trade-flow", id: "trade-flow:cvd" },
      dataMarketPane: "order-flow-cvd",
      lines: [{
        id: "trade-flow-cvd-base",
        name: "CVD",
        type: "line",
        color: CVD_COLOR,
        lineWidth: 2,
        data: state.cvd,
      }],
      legendItems: [{
        id: "cvd-proxy",
        label: "CVD",
        appearance: "estimated",
        description: t("pane.flow.cvdDesc"),
        color: CVD_COLOR,
      }],
      pointMetadata: orderFlowPointMetadata(
        state.cvd,
        "CVD",
        hasGap ? t("pane.flow.anchorGap") : t("pane.flow.anchorWindow"),
      ),
      pointMetadataFallback: "none",
      missingPointText: t("pane.flow.missingFields"),
      statusText: coverage,
    },
    {
      id: "trade-flow-delta",
      label: "Volume Delta",
      owner: { kind: "trade-flow", id: "trade-flow:delta" },
      dataMarketPane: "order-flow-delta",
      lines: [
        {
          id: "trade-flow-delta-base",
          name: "Delta",
          type: "histogram",
          color: DELTA_COLOR,
          data: state.delta,
        },
        {
          id: "trade-flow-taker-buy-base",
          name: t("pane.flow.buy"),
          type: "histogram",
          color: BUY_COLOR,
          data: state.buy,
        },
        {
          id: "trade-flow-taker-sell-base",
          name: t("pane.flow.sell"),
          type: "histogram",
          color: SELL_COLOR,
          data: state.sell,
        },
      ],
      legendItems: [
        { id: "delta", label: "Delta", appearance: "estimated", description: t("pane.flow.deltaDesc"), color: DELTA_COLOR },
        { id: "buy", label: t("pane.flow.buy"), appearance: "estimated", description: t("pane.flow.buyDesc"), color: BUY_COLOR },
        { id: "sell", label: t("pane.flow.sell"), appearance: "estimated", description: t("pane.flow.sellDesc"), color: SELL_COLOR },
      ],
      pointMetadata: orderFlowPointMetadata(state.delta, "Volume Delta", t("pane.flow.singleBar")),
      pointMetadataFallback: "none",
      missingPointText: t("pane.flow.missingFields"),
      statusText: coverage,
    },
  ];
}

export function createKlineOrderFlowProjectionMemo(): {
  project(input: KlineOrderFlowProjectionInput): readonly IndicatorSubPane[];
} {
  let state: ProjectionState | null = null;
  let output: readonly IndicatorSubPane[] = Object.freeze([]);
  let previousStructureRevision = -1;
  let previousTimelineInterval = "";
  return {
    project({ bars, enabled, forceFull, interval, intervalSeconds, structureRevision = 0 }) {
      if (!enabled) {
        state = null;
        output = Object.freeze([]);
        return output;
      }
      const timeline = projectionTimeline(interval, intervalSeconds);
      const timelineInterval = timeline?.interval ?? "";
      const structureChanged = structureRevision !== previousStructureRevision
        || timelineInterval !== previousTimelineInterval;
      previousStructureRevision = structureRevision;
      previousTimelineInterval = timelineInterval;
      const next = !forceFull && !structureChanged && state
        ? tailProjection(state, bars, timeline)
        : null;
      state = next ?? fullProjection(bars, timeline);
      output = panes(state);
      return output;
    },
  };
}
