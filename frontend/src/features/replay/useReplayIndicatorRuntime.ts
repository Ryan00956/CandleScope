import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { IndicatorSubPane } from "../indicators/indicatorPaneProjection.js";
import type {
  IndicatorLine,
  IndicatorValuePoint,
} from "../indicators/indicatorTypes.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import {
  loadReplayIndicatorPreferences,
  REPLAY_LOCAL_INDICATOR_CATALOG,
  saveReplayIndicatorPreferences,
} from "./replayIndicatorPreferences.js";
import type {
  ReplayIndicatorPreferenceSnapshot,
  ReplayLocalIndicatorId,
  ReplayLocalIndicatorPreference,
} from "./replayIndicatorPreferences.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";

export interface ReplayIndicatorCatalogItem {
  readonly id: ReplayLocalIndicatorId;
  readonly name: string;
  readonly description: string;
  readonly pane: "main" | "sub";
  readonly added: boolean;
  readonly visible: boolean;
  readonly period: number;
  readonly periodEditable: boolean;
  readonly available: boolean;
  readonly availability: string;
}

export interface ReplayIndicatorRuntime {
  readonly mainOverlayLines: readonly IndicatorLine[];
  readonly subPanes: readonly IndicatorSubPane[];
  readonly catalog: readonly ReplayIndicatorCatalogItem[];
  readonly status: {
    readonly mode: "local_revealed_only";
    readonly sourceBarCount: number;
    readonly latestSourceTimeMs: number | null;
    readonly activeIndicatorCount: number;
    readonly visibleIndicatorCount: number;
    readonly orderFlowBarCount: number;
    readonly inheritedFromLiveWorkspace: boolean;
    readonly unsupportedLiveIndicators: readonly string[];
    readonly disabledCapabilities: readonly ["hosted", "range", "security"];
  };
  readonly actions: {
    add(id: ReplayLocalIndicatorId): void;
    remove(id: ReplayLocalIndicatorId): void;
    toggleVisibility(id: ReplayLocalIndicatorId): void;
    updatePeriod(id: ReplayLocalIndicatorId, period: number): void;
  };
}

const MAIN_COLORS: Readonly<Record<string, string>> = {
  sma: "#f59e0b",
  ema: "#38bdf8",
  bollMiddle: "#a78bfa",
  bollUpper: "#22c55e",
  bollLower: "#ef4444",
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function closeValue(row: KlineBar): number | null {
  return finite(row.close);
}

function revealedRows(
  rows: readonly KlineBar[],
  cursorMs: number | null,
  intervalSeconds: number | null = null,
): KlineBar[] {
  const revealed = cursorMs === null
    ? []
    : rows.filter((row) => (
        Number(row.time) * 1_000 <= cursorMs
        && closeValue(row) !== null
      ));
  if (
    intervalSeconds === null
    || !Number.isSafeInteger(intervalSeconds)
    || intervalSeconds < 1
  ) return revealed;
  let segmentStart = 0;
  for (let index = 1; index < revealed.length; index += 1) {
    if (
      Number(revealed[index]?.time)
      !== Number(revealed[index - 1]?.time) + intervalSeconds
    ) segmentStart = index;
  }
  return revealed.slice(segmentStart);
}

function line(
  id: string,
  name: string,
  data: IndicatorValuePoint[],
  options: Partial<IndicatorLine> = {},
): IndicatorLine {
  return {
    id,
    indicatorId: id.split(":")[0] ?? id,
    outputName: name,
    name,
    color: "#38bdf8",
    lineWidth: 2,
    type: "line",
    data,
    ...options,
  };
}

function movingAveragePoints(
  rows: readonly KlineBar[],
  period: number,
): IndicatorValuePoint[] {
  const data: IndicatorValuePoint[] = [];
  let sum = 0;
  const window: number[] = [];
  for (const row of rows) {
    const close = closeValue(row);
    if (close === null) continue;
    window.push(close);
    sum += close;
    if (window.length > period) sum -= window.shift() ?? 0;
    if (window.length === period) data.push({ time: Number(row.time), value: sum / period });
  }
  return data;
}

export function buildReplaySmaLine(
  rows: readonly KlineBar[],
  cursorMs: number | null,
  period = 20,
  intervalSeconds: number | null = null,
): IndicatorLine {
  return line(
    `replay-local-sma-${period}`,
    `SMA ${period} · revealed only`,
    movingAveragePoints(
      revealedRows(rows, cursorMs, intervalSeconds),
      period,
    ),
    { color: MAIN_COLORS.sma!, overlay: true, pane: "main" },
  );
}

function emaPoints(
  rows: readonly KlineBar[],
  period: number,
): IndicatorValuePoint[] {
  if (rows.length < period) return [];
  const seedRows = rows.slice(0, period);
  const seed = seedRows.reduce((total, row) => total + (closeValue(row) ?? 0), 0) / period;
  const points: IndicatorValuePoint[] = [{
    time: Number(seedRows.at(-1)?.time),
    value: seed,
  }];
  const multiplier = 2 / (period + 1);
  let current = seed;
  for (const row of rows.slice(period)) {
    const close = closeValue(row);
    if (close === null) continue;
    current = (close - current) * multiplier + current;
    points.push({ time: Number(row.time), value: current });
  }
  return points;
}

function bollingerLines(
  rows: readonly KlineBar[],
  period: number,
): IndicatorLine[] {
  const middle: IndicatorValuePoint[] = [];
  const upper: IndicatorValuePoint[] = [];
  const lower: IndicatorValuePoint[] = [];
  const window: number[] = [];
  let sum = 0;
  for (const row of rows) {
    const close = closeValue(row);
    if (close === null) continue;
    window.push(close);
    sum += close;
    if (window.length > period) sum -= window.shift() ?? 0;
    if (window.length !== period) continue;
    const average = sum / period;
    const variance = window.reduce((total, value) => total + (value - average) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * 2;
    const time = Number(row.time);
    middle.push({ time, value: average });
    upper.push({ time, value: average + deviation });
    lower.push({ time, value: average - deviation });
  }
  return [
    line("boll:middle", `BOLL ${period}`, middle, { color: MAIN_COLORS.bollMiddle!, overlay: true, pane: "main" }),
    line("boll:upper", "BOLL Upper", upper, { color: MAIN_COLORS.bollUpper!, lineWidth: 1, overlay: true, pane: "main" }),
    line("boll:lower", "BOLL Lower", lower, { color: MAIN_COLORS.bollLower!, lineWidth: 1, overlay: true, pane: "main" }),
  ];
}

function rsiPoints(rows: readonly KlineBar[], period: number): IndicatorValuePoint[] {
  if (rows.length <= period) return [];
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = (closeValue(rows[index]!) ?? 0) - (closeValue(rows[index - 1]!) ?? 0);
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const value = () => averageLoss === 0
    ? 100
    : 100 - (100 / (1 + averageGain / averageLoss));
  const points: IndicatorValuePoint[] = [{
    time: Number(rows[period]!.time),
    value: value(),
  }];
  for (let index = period + 1; index < rows.length; index += 1) {
    const change = (closeValue(rows[index]!) ?? 0) - (closeValue(rows[index - 1]!) ?? 0);
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    points.push({ time: Number(rows[index]!.time), value: value() });
  }
  return points;
}

function trueRange(current: KlineBar, previous: KlineBar | undefined): number | null {
  const high = finite(current.high);
  const low = finite(current.low);
  if (high === null || low === null) return null;
  const previousClose = previous ? closeValue(previous) : null;
  return previousClose === null
    ? high - low
    : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
}

function atrPoints(rows: readonly KlineBar[], period: number): IndicatorValuePoint[] {
  if (rows.length < period) return [];
  const ranges = rows.map((row, index) => trueRange(row, rows[index - 1]));
  if (ranges.slice(0, period).some((value) => value === null)) return [];
  let initialTotal = 0;
  for (let index = 0; index < period; index += 1) {
    initialTotal += ranges[index] ?? 0;
  }
  let average = initialTotal / period;
  const points: IndicatorValuePoint[] = [{
    time: Number(rows[period - 1]!.time),
    value: average,
  }];
  for (let index = period; index < rows.length; index += 1) {
    const range = ranges[index];
    if (range === null || range === undefined) continue;
    average = (average * (period - 1) + range) / period;
    points.push({ time: Number(rows[index]!.time), value: average });
  }
  return points;
}

function macdLines(rows: readonly KlineBar[]): IndicatorLine[] {
  const fast = new Map(emaPoints(rows, 12).map((point) => [point.time, point.value]));
  const slow = new Map(emaPoints(rows, 26).map((point) => [point.time, point.value]));
  const macd: IndicatorValuePoint[] = [];
  for (const row of rows) {
    const time = Number(row.time);
    const fastValue = fast.get(time);
    const slowValue = slow.get(time);
    if (fastValue !== undefined && slowValue !== undefined) {
      macd.push({ time, value: fastValue - slowValue });
    }
  }
  const signal: IndicatorValuePoint[] = [];
  if (macd.length >= 9) {
    let current = macd.slice(0, 9).reduce((total, point) => total + point.value, 0) / 9;
    signal.push({ time: macd[8]!.time, value: current });
    const multiplier = 2 / 10;
    for (const point of macd.slice(9)) {
      current = (point.value - current) * multiplier + current;
      signal.push({ time: point.time, value: current });
    }
  }
  const signalByTime = new Map(signal.map((point) => [point.time, point.value]));
  const histogram = macd.flatMap((point) => {
    const signalValue = signalByTime.get(point.time);
    return signalValue === undefined
      ? []
      : [{
          time: point.time,
          value: point.value - signalValue,
          color: point.value >= signalValue ? "#22c55e" : "#ef4444",
        }];
  });
  return [
    line("macd:macd", "MACD", macd, { color: "#38bdf8", pane: "macd" }),
    line("macd:signal", "Signal", signal, { color: "#f59e0b", pane: "macd" }),
    line("macd:histogram", "Histogram", histogram, { color: "#94a3b8", type: "histogram", pane: "macd" }),
  ];
}

function orderFlow(row: KlineBar): { buy: number; sell: number; delta: number } | null {
  const direct = row.order_flow;
  const buy = finite(row.taker_buy_base ?? row.takerBuyBase);
  const volume = finite(row.volume);
  const sell = finite(direct?.taker_sell_base);
  const delta = finite(direct?.volume_delta_base);
  if (buy !== null && buy >= 0 && sell !== null && sell >= 0 && delta !== null) {
    return { buy, sell, delta };
  }
  if (buy === null || volume === null || buy < 0 || volume < buy) return null;
  return { buy, sell: volume - buy, delta: buy * 2 - volume };
}

function orderFlowPanes(
  rows: readonly KlineBar[],
  activeIds: ReadonlySet<ReplayLocalIndicatorId>,
  intervalSeconds: number | null,
): { panes: IndicatorSubPane[]; validRows: number } {
  const cvd: IndicatorValuePoint[] = [];
  const delta: IndicatorValuePoint[] = [];
  const buy: IndicatorValuePoint[] = [];
  const sell: IndicatorValuePoint[] = [];
  let cumulative = 0;
  let previousTime: number | null = null;
  let validRows = 0;
  for (const row of rows) {
    const time = Number(row.time);
    const values = orderFlow(row);
    const contiguous = previousTime === null
      || intervalSeconds === null
      || time === previousTime + intervalSeconds;
    if (!values || !contiguous) cumulative = 0;
    if (values) {
      cumulative += values.delta;
      validRows += 1;
      cvd.push({ time, value: cumulative });
      delta.push({ time, value: values.delta, color: values.delta >= 0 ? "#22c55e" : "#ef4444" });
      buy.push({ time, value: values.buy, color: "#22c55e" });
      sell.push({ time, value: -values.sell, color: "#ef4444" });
    }
    previousTime = time;
  }
  const coverage = validRows === rows.length
    ? "K 线 taker volume · 当前连续窗口锚定 0"
    : `K 线 taker volume · ${rows.length - validRows} 根缺少主动量字段`;
  const panes: IndicatorSubPane[] = [];
  if (activeIds.has("cvd")) {
    panes.push({
      id: "replay-cvd",
      label: "CVD",
      owner: { kind: "trade-flow", id: "cvd" },
      dataMarketPane: "order-flow-cvd",
      lines: [line("cvd:value", "CVD", cvd, { color: "#a78bfa", pane: "replay-cvd" })],
      missingPointText: "当前冻结 K 线不含 taker buy volume",
      statusText: coverage,
    });
  }
  if (activeIds.has("delta")) {
    panes.push({
      id: "replay-delta",
      label: "Volume Delta",
      owner: { kind: "trade-flow", id: "delta" },
      dataMarketPane: "order-flow-delta",
      lines: [
        line("delta:value", "Delta", delta, { type: "histogram", pane: "replay-delta" }),
        line("delta:buy", "主动买", buy, { color: "#22c55e", type: "histogram", pane: "replay-delta" }),
        line("delta:sell", "主动卖", sell, { color: "#ef4444", type: "histogram", pane: "replay-delta" }),
      ],
      missingPointText: "当前冻结 K 线不含 taker buy volume",
      statusText: coverage,
    });
  }
  return { panes, validRows };
}

function subPane(
  id: ReplayLocalIndicatorId,
  label: string,
  lines: IndicatorLine[],
): IndicatorSubPane {
  return {
    id: `replay-${id}`,
    label,
    owner: { kind: "indicator", id },
    lines,
  };
}

function normalizePeriod(id: ReplayLocalIndicatorId, value: number): number {
  const fallback = REPLAY_LOCAL_INDICATOR_CATALOG.find((item) => item.id === id)?.defaultPeriod ?? 20;
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : fallback;
}

function updatePreference(
  current: ReplayIndicatorPreferenceSnapshot,
  id: ReplayLocalIndicatorId,
  transform: (
    value: ReplayLocalIndicatorPreference | undefined,
  ) => ReplayLocalIndicatorPreference | null,
): ReplayIndicatorPreferenceSnapshot {
  const existing = current.indicators.find((item) => item.id === id);
  const nextValue = transform(existing);
  const next = current.indicators.filter((item) => item.id !== id);
  if (nextValue !== null) next.push(nextValue);
  return { ...current, indicators: next };
}

export function useReplayIndicatorRuntime(
  runtime: ReplayRuntime,
  projectedSeriesStore?: SeriesWindowStore,
): ReplayIndicatorRuntime {
  const storeSnapshot = runtime.store;
  const seriesStore = projectedSeriesStore ?? runtime.replayStore.seriesStore;
  const sessionId = runtime.store.sessionId ?? "pending";
  const [preferences, setPreferences] = useState<ReplayIndicatorPreferenceSnapshot>(
    () => loadReplayIndicatorPreferences(sessionId),
  );
  useEffect(() => {
    setPreferences(loadReplayIndicatorPreferences(sessionId));
  }, [sessionId]);
  useEffect(() => {
    saveReplayIndicatorPreferences(sessionId, preferences);
  }, [preferences, sessionId]);
  const subscribeSeries = useCallback((listener: () => void) => {
    const unsubscribe = seriesStore.subscribe(listener);
    return () => { unsubscribe(); };
  }, [seriesStore]);
  const getSeriesRevision = useCallback(() => Number(seriesStore.version), [seriesStore]);
  const seriesRevision = useSyncExternalStore(
    subscribeSeries,
    getSeriesRevision,
    getSeriesRevision,
  );
  const projection = useMemo(() => {
    void seriesRevision;
    const cursorMs = storeSnapshot.virtualTimeMs;
    const rows = revealedRows(
      seriesStore.snapshot(),
      cursorMs,
      seriesStore.intervalSeconds,
    );
    const visible = preferences.indicators.filter((item) => item.visible);
    const visibleById = new Map(visible.map((item) => [item.id, item]));
    const mainOverlayLines: IndicatorLine[] = [];
    const subPanes: IndicatorSubPane[] = [];
    const sma = visibleById.get("sma");
    if (sma) {
      mainOverlayLines.push(buildReplaySmaLine(
        rows,
        cursorMs,
        sma.period,
        seriesStore.intervalSeconds,
      ));
    }
    const ema = visibleById.get("ema");
    if (ema) {
      mainOverlayLines.push(line(
        `ema:${ema.period}`,
        `EMA ${ema.period}`,
        emaPoints(rows, ema.period),
        { color: MAIN_COLORS.ema!, overlay: true, pane: "main" },
      ));
    }
    const boll = visibleById.get("boll");
    if (boll) mainOverlayLines.push(...bollingerLines(rows, boll.period));
    const rsi = visibleById.get("rsi");
    if (rsi) {
      subPanes.push(subPane("rsi", `RSI ${rsi.period}`, [
        line(`rsi:${rsi.period}`, `RSI ${rsi.period}`, rsiPoints(rows, rsi.period), {
          color: "#a78bfa",
          pane: "replay-rsi",
        }),
      ]));
    }
    if (visibleById.has("macd")) {
      subPanes.push(subPane("macd", "MACD 12 / 26 / 9", macdLines(rows)));
    }
    const atr = visibleById.get("atr");
    if (atr) {
      subPanes.push(subPane("atr", `ATR ${atr.period}`, [
        line(`atr:${atr.period}`, `ATR ${atr.period}`, atrPoints(rows, atr.period), {
          color: "#f97316",
          pane: "replay-atr",
        }),
      ]));
    }
    if (visibleById.has("vol")) {
      const volume = rows.flatMap((row) => {
        const value = finite(row.volume);
        return value === null ? [] : [{
          time: Number(row.time),
          value,
          color: (closeValue(row) ?? 0) >= (finite(row.open) ?? 0) ? "#22c55e" : "#ef4444",
        }];
      });
      subPanes.push(subPane("vol", "VOL", [
        line("vol:value", "VOL", volume, { color: "#64748b", type: "histogram", pane: "replay-vol" }),
      ]));
    }
    const orderFlowProjection = orderFlowPanes(
      rows,
      new Set(visible.map((item) => item.id)),
      seriesStore.intervalSeconds,
    );
    subPanes.push(...orderFlowProjection.panes);
    return {
      mainOverlayLines,
      subPanes,
      rows,
      orderFlowBarCount: orderFlowProjection.validRows,
    };
  }, [preferences.indicators, seriesRevision, seriesStore, storeSnapshot]);

  const setPreference = useCallback((
    id: ReplayLocalIndicatorId,
    transform: (
      value: ReplayLocalIndicatorPreference | undefined,
    ) => ReplayLocalIndicatorPreference | null,
  ) => {
    setPreferences((current) => updatePreference(current, id, transform));
  }, []);
  const actions = useMemo(() => ({
    add: (id: ReplayLocalIndicatorId) => setPreference(id, (value) => value ?? {
      id,
      visible: true,
      period: normalizePeriod(id, Number.NaN),
    }),
    remove: (id: ReplayLocalIndicatorId) => setPreference(id, () => null),
    toggleVisibility: (id: ReplayLocalIndicatorId) => setPreference(id, (value) => (
      value === undefined ? null : { ...value, visible: !value.visible }
    )),
    updatePeriod: (id: ReplayLocalIndicatorId, period: number) => setPreference(id, (value) => (
      value === undefined ? null : { ...value, period: normalizePeriod(id, period) }
    )),
  }), [setPreference]);

  const catalog = useMemo<ReplayIndicatorCatalogItem[]>(() => {
    const active = new Map(preferences.indicators.map((item) => [item.id, item]));
    return REPLAY_LOCAL_INDICATOR_CATALOG.map((item) => {
      const preference = active.get(item.id);
      const flow = item.id === "cvd" || item.id === "delta";
      const available = !flow || projection.orderFlowBarCount > 0;
      return {
        ...item,
        added: preference !== undefined,
        visible: preference?.visible ?? false,
        period: preference?.period ?? item.defaultPeriod,
        periodEditable: !["macd", "vol", "cvd", "delta"].includes(item.id),
        available,
        availability: available
          ? "仅使用已揭示 K 线"
          : "冻结 K 线缺少 taker buy volume",
      };
    });
  }, [preferences.indicators, projection.orderFlowBarCount]);

  const sourceTimes = projection.rows.map((row) => Number(row.time) * 1_000);
  return {
    mainOverlayLines: projection.mainOverlayLines,
    subPanes: projection.subPanes,
    catalog,
    status: {
      mode: "local_revealed_only",
      sourceBarCount: projection.rows.length,
      latestSourceTimeMs: sourceTimes.at(-1) ?? null,
      activeIndicatorCount: preferences.indicators.length,
      visibleIndicatorCount: preferences.indicators.filter((item) => item.visible).length,
      orderFlowBarCount: projection.orderFlowBarCount,
      inheritedFromLiveWorkspace: preferences.inheritedFromLiveWorkspace,
      unsupportedLiveIndicators: preferences.unsupportedLiveIndicators,
      disabledCapabilities: ["hosted", "range", "security"],
    },
    actions,
  };
}
