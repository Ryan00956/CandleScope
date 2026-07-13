import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
} from "lightweight-charts";

/** Lightweight Charts plugin types isolated behind the chart-adapter boundary. */
export type ChartSeriesAttachedParameter = SeriesAttachedParameter<unknown, SeriesType>;
export type ChartPrimitivePaneRenderer = IPrimitivePaneRenderer;
export type ChartPrimitivePaneView = IPrimitivePaneView;
export type ChartPrimitiveCanvasTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
