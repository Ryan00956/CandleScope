import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type { IndicatorValuePoint } from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";

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
  intervalSeconds: number | null;
  structureRevision?: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flow(bar: KlineBar | undefined): {
  buy: number;
  sell: number;
  delta: number;
  contribution: number;
} | null {
  const buy = finite(bar?.taker_buy_base);
  const sell = finite(bar?.order_flow?.taker_sell_base);
  const delta = finite(bar?.order_flow?.volume_delta_base);
  const contribution = finite(bar?.order_flow?.cvd_contribution_base);
  if (buy === null || buy < 0 || sell === null || sell < 0 || delta === null || contribution === null) {
    return null;
  }
  return { buy, sell, delta, contribution };
}

function expectedNext(previous: KlineBar | undefined, current: KlineBar | undefined, step: number | null): boolean {
  if (!previous || !current) return false;
  return step === null ? current.time > previous.time : current.time === previous.time + step;
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

function fullProjection(bars: readonly KlineBar[], intervalSeconds: number | null): ProjectionState {
  const delta: IndicatorValuePoint[] = [];
  const buy: IndicatorValuePoint[] = [];
  const sell: IndicatorValuePoint[] = [];
  let missing = 0;
  let discontinuities = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (!expectedNext(bars[index - 1], bars[index], intervalSeconds)) discontinuities += 1;
  }
  for (const bar of bars) {
    const values = flow(bar);
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
    if (!flow(bars[index])) break;
    if (index < bars.length - 1 && !expectedNext(bars[index], bars[index + 1], intervalSeconds)) break;
    suffixStart = index;
  }
  const cvd: IndicatorValuePoint[] = [];
  let cumulative = 0;
  for (let index = suffixStart; index < bars.length; index += 1) {
    const bar = bars[index];
    const values = flow(bar);
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
  intervalSeconds: number | null,
): ProjectionState | null {
  const bar = bars.at(-1);
  if (!bar
    || previous.length !== bars.length
    || previous.firstTime !== (bars.at(0)?.time ?? null)
    || previous.lastTime !== bar.time) return null;
  const values = flow(bar);
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
    const contiguous = !before || expectedNext(before, bar, intervalSeconds);
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

function panes(state: ProjectionState): readonly IndicatorSubPane[] {
  const latestCvd = state.cvd.at(-1);
  const latestDelta = state.delta.at(-1);
  const hasGap = state.missing > 0 || state.discontinuities > 0;
  const coverageParts = [
    "K线代理",
    ...(state.missing > 0 ? [`${state.missing} 根不可用`] : []),
    ...(state.discontinuities > 0 ? [`${state.discontinuities} 处时间缺口`] : []),
  ];
  const coverage = hasGap
    ? `${coverageParts.join(" · ")} · CVD 从最近连续段锚定 0`
    : "K线代理 · 当前连续窗口锚定 0";
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
        description: "K线 taker volume 的连续前缀和；不是全历史绝对值",
        color: CVD_COLOR,
      }],
      pointMetadata: latestCvd ? [{
        time: latestCvd.time,
        value: latestCvd.value,
        valueLabel: formatValue(latestCvd.value),
        sourceLabel: "K线代理",
        qualityLabel: hasGap ? "最近连续段锚定 0" : "窗口锚定 0",
        appearance: "estimated",
        accessibilityLabel: `CVD ${formatValue(latestCvd.value)}`,
      }] : [],
      pointMetadataFallback: "latest",
      missingPointText: "当前 K 线源不提供可信订单流字段",
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
          name: "主动买",
          type: "histogram",
          color: BUY_COLOR,
          data: state.buy,
        },
        {
          id: "trade-flow-taker-sell-base",
          name: "主动卖",
          type: "histogram",
          color: SELL_COLOR,
          data: state.sell,
        },
      ],
      legendItems: [
        { id: "delta", label: "Delta", appearance: "estimated", description: "主动买量 - 主动卖量", color: DELTA_COLOR },
        { id: "buy", label: "主动买", appearance: "estimated", description: "Taker buy base volume", color: BUY_COLOR },
        { id: "sell", label: "主动卖", appearance: "estimated", description: "Taker sell base volume（图中为负轴）", color: SELL_COLOR },
      ],
      pointMetadata: latestDelta ? [{
        time: latestDelta.time,
        value: latestDelta.value,
        valueLabel: formatValue(latestDelta.value),
        sourceLabel: "K线代理",
        qualityLabel: "单根 K 线",
        appearance: "estimated",
        accessibilityLabel: `Volume Delta ${formatValue(latestDelta.value)}`,
      }] : [],
      pointMetadataFallback: "latest",
      missingPointText: "当前 K 线源不提供可信订单流字段",
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
  return {
    project({ bars, enabled, forceFull, intervalSeconds, structureRevision = 0 }) {
      if (!enabled) {
        state = null;
        output = Object.freeze([]);
        return output;
      }
      const structureChanged = structureRevision !== previousStructureRevision;
      previousStructureRevision = structureRevision;
      const next = !forceFull && !structureChanged && state
        ? tailProjection(state, bars, intervalSeconds)
        : null;
      state = next ?? fullProjection(bars, intervalSeconds);
      output = panes(state);
      return output;
    },
  };
}
