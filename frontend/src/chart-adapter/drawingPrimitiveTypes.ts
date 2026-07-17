import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
} from "lightweight-charts";
import type { ChartTime } from "./chartAdapterTypes.js";

/** Lightweight Charts plugin types isolated behind the chart-adapter boundary. */
export type ChartSeriesAttachedParameter = SeriesAttachedParameter<ChartTime, SeriesType>;
export type ChartPrimitivePaneRenderer = IPrimitivePaneRenderer;
export type ChartPrimitivePaneView = IPrimitivePaneView;
export type ChartPrimitiveCanvasTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
