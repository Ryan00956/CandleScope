import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { IndicatorDefinition, IndicatorLine } from "./indicatorTypes.js";

const MAX_REPORTED_RANGES = 20;
const GLOBAL_HANDLE = "__CANDLESCOPE_INDICATOR_MONITOR__";

export interface IndicatorMissingRangeDiagnostic {
  end: number;
  missingBars: number;
  start: number;
}

export interface IndicatorLineCoverageDiagnostic {
  duplicateTimes: number;
  firstTime: number | null;
  interiorMissingBars: number;
  interiorMissingRanges: IndicatorMissingRangeDiagnostic[];
  invalidPoints: number;
  lastTime: number | null;
  leadingMissingBars: number;
  lineId: string;
  name: string;
  offChartPoints: number;
  outOfOrderPoints: number;
  pointCount: number;
  status: "empty" | "gapped" | "lagging" | "ok";
  trailingMissingBars: number;
}

export interface IndicatorCoverageDiagnostic {
  error: string | null;
  id: string;
  lines: IndicatorLineCoverageDiagnostic[];
  name: string;
  status: "error" | "gapped" | "hidden" | "lagging" | "no-data" | "ok";
  visible: boolean;
}

export interface ChartCoverageDiagnostic {
  barCount: number;
  closedBarCount: number;
  duplicateTimes: number;
  firstTime: number | null;
  lastClosedTime: number | null;
  lastTime: number | null;
  outOfOrderBars: number;
}

export interface IndicatorRuntimeDiagnosticInput {
  activeIndicators: IndicatorDefinition[];
  cache?: unknown;
  chartData: KlineBar[];
  context: {
    exchange: string;
    interval: string;
    marketType: string;
    sessionKey: string;
    symbol: string;
  };
  state: Record<string, unknown>;
}

export interface IndicatorRuntimeDiagnosticSnapshot {
  cache?: unknown;
  capturedAtMs: number;
  chart: ChartCoverageDiagnostic;
  context: IndicatorRuntimeDiagnosticInput["context"];
  gates: string[];
  indicators: IndicatorCoverageDiagnostic[];
  issueCounts: Record<string, number>;
  issues: string[];
  state: Record<string, unknown>;
}

interface IndicatorDiagnosticGlobalHandle {
  schemaVersion: 1;
  snapshot: () => {
    capturedAtMs: number;
    runtimes: Array<IndicatorRuntimeDiagnosticSnapshot & { runtimeId: string }>;
    schemaVersion: 1;
  };
}

interface IndicatorDiagnosticWindow extends Window {
  __CANDLESCOPE_INDICATOR_MONITOR__?: IndicatorDiagnosticGlobalHandle;
}

const diagnosticSources = new Map<
  string,
  () => IndicatorRuntimeDiagnosticSnapshot
>();

function finiteTime(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countTimelineDefects(times: number[]): {
  duplicateTimes: number;
  outOfOrder: number;
} {
  let duplicates = 0;
  let outOfOrder = 0;
  const seen = new Set<number>();
  let previous: number | null = null;
  for (const time of times) {
    if (seen.has(time)) duplicates += 1;
    seen.add(time);
    if (previous != null && time < previous) outOfOrder += 1;
    previous = time;
  }
  return { duplicateTimes: duplicates, outOfOrder };
}

function lineLabel(line: IndicatorLine, index: number): string {
  return String(
    line.id
    || line.localId
    || line.outputName
    || line.name
    || line.title
    || `line-${index + 1}`,
  );
}

function missingRanges(
  chartTimes: number[],
  lineTimes: ReadonlySet<number>,
  startIndex: number,
  endIndex: number,
): { count: number; ranges: IndicatorMissingRangeDiagnostic[] } {
  let count = 0;
  const ranges: IndicatorMissingRangeDiagnostic[] = [];
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;
  let rangeCount = 0;
  const flush = () => {
    if (rangeStart == null || rangeEnd == null || rangeCount <= 0) return;
    if (ranges.length < MAX_REPORTED_RANGES) {
      ranges.push({ start: rangeStart, end: rangeEnd, missingBars: rangeCount });
    }
    rangeStart = null;
    rangeEnd = null;
    rangeCount = 0;
  };

  for (let index = startIndex; index <= endIndex; index += 1) {
    const time = chartTimes[index];
    if (time == null) continue;
    if (lineTimes.has(time)) {
      flush();
      continue;
    }
    count += 1;
    rangeStart ??= time;
    rangeEnd = time;
    rangeCount += 1;
  }
  flush();
  return { count, ranges };
}

export function analyzeIndicatorLineCoverage(
  line: IndicatorLine,
  chartTimes: number[],
  index = 0,
): IndicatorLineCoverageDiagnostic {
  const validPoints = (line.data || []).flatMap((point) => {
    const time = finiteTime(point?.time);
    const value = Number(point?.value);
    return time == null || !Number.isFinite(value) ? [] : [{ time, value }];
  });
  const pointTimes = validPoints.map((point) => point.time);
  const invalidPoints = Math.max(0, (line.data?.length || 0) - validPoints.length);
  const defects = countTimelineDefects(pointTimes);
  const uniqueChartTimes = Array.from(new Set(chartTimes)).sort((a, b) => a - b);
  const chartTimeSet = new Set(uniqueChartTimes);
  const lineTimeSet = new Set(pointTimes);
  const onChartTimes = Array.from(lineTimeSet)
    .filter((time) => chartTimeSet.has(time))
    .sort((a, b) => a - b);
  const firstTime = pointTimes.length ? Math.min(...pointTimes) : null;
  const lastTime = pointTimes.length ? Math.max(...pointTimes) : null;
  const offChartPoints = pointTimes.filter((time) => !chartTimeSet.has(time)).length;

  let leadingMissingBars = uniqueChartTimes.length;
  let trailingMissingBars = uniqueChartTimes.length;
  let interiorMissingBars = 0;
  let interiorMissingRanges: IndicatorMissingRangeDiagnostic[] = [];
  if (onChartTimes.length > 0) {
    const firstOnChart = onChartTimes[0];
    const lastOnChart = onChartTimes.at(-1);
    const firstIndex = firstOnChart == null ? -1 : uniqueChartTimes.indexOf(firstOnChart);
    const lastIndex = lastOnChart == null ? -1 : uniqueChartTimes.indexOf(lastOnChart);
    if (firstIndex < 0 || lastIndex < firstIndex) {
      return {
        duplicateTimes: defects.duplicateTimes,
        firstTime,
        interiorMissingBars,
        interiorMissingRanges,
        invalidPoints,
        lastTime,
        leadingMissingBars,
        lineId: lineLabel(line, index),
        name: String(line.name || line.title || line.outputName || lineLabel(line, index)),
        offChartPoints,
        outOfOrderPoints: defects.outOfOrder,
        pointCount: validPoints.length,
        status: pointTimes.length === 0 ? "empty" : "lagging",
        trailingMissingBars,
      };
    }
    leadingMissingBars = firstIndex;
    trailingMissingBars = uniqueChartTimes.length - lastIndex - 1;
    const missing = missingRanges(
      uniqueChartTimes,
      lineTimeSet,
      firstIndex,
      lastIndex,
    );
    interiorMissingBars = missing.count;
    interiorMissingRanges = missing.ranges;
  }

  const status = pointTimes.length === 0
    ? "empty"
    : interiorMissingBars > 0 || defects.duplicateTimes > 0 || defects.outOfOrder > 0
      ? "gapped"
      : trailingMissingBars > 0
        ? "lagging"
        : "ok";
  return {
    duplicateTimes: defects.duplicateTimes,
    firstTime,
    interiorMissingBars,
    interiorMissingRanges,
    invalidPoints,
    lastTime,
    leadingMissingBars,
    lineId: lineLabel(line, index),
    name: String(line.name || line.title || line.outputName || lineLabel(line, index)),
    offChartPoints,
    outOfOrderPoints: defects.outOfOrder,
    pointCount: validPoints.length,
    status,
    trailingMissingBars,
  };
}

export function buildIndicatorRuntimeDiagnosticSnapshot(
  input: IndicatorRuntimeDiagnosticInput,
  now: () => number = Date.now,
): IndicatorRuntimeDiagnosticSnapshot {
  const chartTimes = input.chartData
    .filter((bar) => bar?.is_closed !== false)
    .map((bar) => finiteTime(bar?.time))
    .filter((time): time is number => time != null);
  const allChartTimes = input.chartData
    .map((bar) => finiteTime(bar?.time))
    .filter((time): time is number => time != null);
  const chartDefects = countTimelineDefects(allChartTimes);
  const sortedChartTimes = Array.from(new Set(allChartTimes)).sort((a, b) => a - b);
  const sortedClosedTimes = Array.from(new Set(chartTimes)).sort((a, b) => a - b);
  const indicators = (input.activeIndicators || []).map((indicator) => {
    const visible = indicator.visible !== false;
    const lines = (indicator.lines || []).map((line, index) => (
      analyzeIndicatorLineCoverage(line, sortedClosedTimes, index)
    ));
    const hasNoData = visible && (lines.length === 0 || lines.every((line) => line.pointCount === 0));
    const hasGap = lines.some((line) => line.status === "gapped");
    const isLagging = lines.some((line) => line.status === "lagging");
    const status = !visible
      ? "hidden"
      : indicator.error
        ? "error"
        : hasNoData
          ? "no-data"
          : hasGap
            ? "gapped"
            : isLagging
              ? "lagging"
              : "ok";
    return {
      error: indicator.error || null,
      id: String(indicator.id),
      lines,
      name: String(indicator.name || indicator.engineName || indicator.id),
      status,
      visible,
    } satisfies IndicatorCoverageDiagnostic;
  });

  const issueCounts: Record<string, number> = {};
  const issues: string[] = [];
  const gates: string[] = [];
  const recordIssue = (code: string) => {
    issueCounts[code] = (issueCounts[code] || 0) + 1;
    if (!issues.includes(code)) issues.push(code);
  };
  if (chartDefects.duplicateTimes > 0) recordIssue("chart-duplicate-times");
  if (chartDefects.outOfOrder > 0) recordIssue("chart-out-of-order");
  const coverageSettled = input.state.chartDataReady !== false
    && input.state.initialHydrationSettled !== false;
  for (const indicator of indicators) {
    if (indicator.status === "no-data" && coverageSettled) {
      recordIssue("visible-indicator-no-data");
    }
    if (indicator.status === "error") recordIssue("visible-indicator-error");
    if (indicator.status === "gapped" && coverageSettled) {
      recordIssue("indicator-interior-gap");
    }
    if (indicator.status === "lagging" && coverageSettled) {
      recordIssue("indicator-trailing-gap");
    }
  }
  if (input.state.initialHistoryPending === true) gates.push("initial-history-pending");
  if (input.state.historyWindowPending === true) gates.push("history-window-pending");
  if (input.state.initialHydrationSettled === false) gates.push("initial-hydration-unsettled");

  return {
    cache: input.cache,
    capturedAtMs: now(),
    chart: {
      barCount: allChartTimes.length,
      closedBarCount: sortedClosedTimes.length,
      duplicateTimes: chartDefects.duplicateTimes,
      firstTime: sortedChartTimes.at(0) ?? null,
      lastClosedTime: sortedClosedTimes.at(-1) ?? null,
      lastTime: sortedChartTimes.at(-1) ?? null,
      outOfOrderBars: chartDefects.outOfOrder,
    },
    context: { ...input.context },
    gates,
    indicators,
    issueCounts,
    issues,
    state: { ...input.state },
  };
}

function installGlobalHandle(): void {
  if (typeof window === "undefined") return;
  const target = window as IndicatorDiagnosticWindow;
  // Replace the handle on every module generation. Vite HMR can retain the
  // old global object after this module's source registry has been recreated.
  target[GLOBAL_HANDLE] = {
    schemaVersion: 1,
    snapshot: () => ({
      capturedAtMs: Date.now(),
      runtimes: Array.from(diagnosticSources.entries()).flatMap(([runtimeId, source]) => {
        try {
          return [{ runtimeId, ...source() }];
        } catch (error) {
          return [{
            runtimeId,
            ...buildIndicatorRuntimeDiagnosticSnapshot({
              activeIndicators: [],
              chartData: [],
              context: {
                exchange: "",
                interval: "",
                marketType: "",
                sessionKey: "",
                symbol: "",
              },
              state: {
                diagnosticError: error instanceof Error ? error.message : String(error),
              },
            }),
          }];
        }
      }),
      schemaVersion: 1,
    }),
  };
}

export function registerIndicatorRuntimeDiagnosticSource(
  runtimeId: string,
  source: () => IndicatorRuntimeDiagnosticSnapshot,
): () => void {
  const key = String(runtimeId || "indicator-runtime");
  diagnosticSources.set(key, source);
  installGlobalHandle();
  return () => {
    if (diagnosticSources.get(key) === source) diagnosticSources.delete(key);
  };
}
