import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createChartEx,
  HistogramSeries,
  LineSeries,
} from "lightweight-charts";
import type {
  ChartOptions,
  ChartOptionsImpl,
  DeepPartial,
  IChartApi,
  IChartApiBase,
  SeriesDefinition,
  TickMarkType,
  Time,
} from "lightweight-charts";
import type { OrdinalAxisTime } from "../features/chart-representation/chartRepresentationTypes.js";
import type { ChartTime } from "./chartAdapterTypes.js";
import { createOrdinalHorzScaleBehavior } from "./ordinalHorzScaleBehavior.js";

export const chartSeriesTypes = Object.freeze({
  candlestick: CandlestickSeries,
  bar: BarSeries,
  line: LineSeries,
  histogram: HistogramSeries,
  area: AreaSeries,
  baseline: BaselineSeries,
} satisfies {
  candlestick: SeriesDefinition<"Candlestick">;
  bar: SeriesDefinition<"Bar">;
  line: SeriesDefinition<"Line">;
  histogram: SeriesDefinition<"Histogram">;
  area: SeriesDefinition<"Area">;
  baseline: SeriesDefinition<"Baseline">;
});

export interface PaneLayoutOptions {
  panes: {
    separatorColor: string;
    separatorHoverColor: string;
    enableResize: boolean;
  };
}

export function buildPaneLayoutOptions({
  separatorColor = "rgba(148, 163, 184, 0.28)",
  separatorHoverColor = "rgba(59, 130, 246, 0.6)",
  enableResize = true,
}: {
  separatorColor?: string;
  separatorHoverColor?: string;
  enableResize?: boolean;
} = {}): PaneLayoutOptions {
  return {
    panes: {
      separatorColor,
      separatorHoverColor,
      enableResize,
    },
  };
}

function ordinalSourceTime(value: unknown): Time {
  const sourceTime = value !== null && typeof value === "object"
    ? Number(Reflect.get(value, "sourceTime"))
    : Number.NaN;
  return (Number.isFinite(sourceTime) ? sourceTime : value) as Time;
}

export function buildOrdinalChartOptions(
  options: DeepPartial<ChartOptions> = {},
): DeepPartial<ChartOptionsImpl<OrdinalAxisTime>> {
  const timeFormatter = options?.localization?.timeFormatter;
  const tickMarkFormatter = options?.timeScale?.tickMarkFormatter;
  const { localization, timeScale, ...sharedOptions } = options;
  return {
    ...sharedOptions,
    ...(localization ? {
      localization: {
        ...localization,
        ...(typeof timeFormatter === "function" ? {
          timeFormatter: (value: OrdinalAxisTime) => timeFormatter(ordinalSourceTime(value)),
        } : {}),
      },
    } : {}),
    ...(timeScale ? {
      timeScale: {
        ...timeScale,
        ...(typeof tickMarkFormatter === "function" ? {
          tickMarkFormatter: (
            value: OrdinalAxisTime,
            tickMarkType: TickMarkType,
            locale: string,
          ) => tickMarkFormatter(
            ordinalSourceTime(value),
            tickMarkType,
            locale,
          ),
        } : {}),
      },
    } : {}),
  };
}

export function createChartInstance(
  container: string | HTMLElement,
  options: DeepPartial<ChartOptions> = {},
  { axisMode = "time" }: { axisMode?: string } = {},
): IChartApiBase<ChartTime> {
  if (axisMode === "ordinal" || axisMode === "derived-ordinal") {
    const ordinalBehavior = createOrdinalHorzScaleBehavior();
    return createChartEx<OrdinalAxisTime, typeof ordinalBehavior>(
      container,
      ordinalBehavior,
      buildOrdinalChartOptions(options),
    ) as IChartApiBase<ChartTime>;
  }
  return createChart(container, options) as IChartApiBase<ChartTime>;
}
