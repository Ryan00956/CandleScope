import { chartSeriesTypes } from "./lightweightChartSurface.js";
import type {
  IChartApiBase,
  IPriceLine,
  ISeriesApi,
  LineStyle,
  LineWidth,
} from "lightweight-charts";
import type {
  ChartTime,
  FillRenderResult,
  IndicatorHline,
  MainSeriesHandle,
  MutableRef,
  PerfEventRecorder,
} from "./chartAdapterTypes.js";

type AreaSeriesHandle = ISeriesApi<"Area", ChartTime>;

export function buildHlineSignature(
  indicatorHlines: IndicatorHline[] | null | undefined = [],
): string {
  if (!indicatorHlines?.length) return "empty";
  return indicatorHlines
    .map((hline) => [
      hline.price ?? "",
      hline.color || "#787b86",
      hline.linestyle ?? "dashed",
      hline.title || "",
    ].join(":"))
    .join("|");
}

export function renderFillSeries({
  chart,
  fillPayload,
  fillSeriesRef,
  fillSeriesStateRef,
  paneId,
  paneIndex,
  definitionsCount,
  recordPerfEvent,
  onError,
}: {
  chart: IChartApiBase<ChartTime>;
  fillPayload: FillRenderResult;
  fillSeriesRef: MutableRef<AreaSeriesHandle[]>;
  fillSeriesStateRef: MutableRef<{
    chart: IChartApiBase<ChartTime> | null;
    paneIndex: number | null;
    signature: string;
    structureSignature?: string;
  }>;
  paneId: string;
  paneIndex: number;
  definitionsCount: number;
  recordPerfEvent: PerfEventRecorder;
  onError?: (error: unknown) => void;
}): void {
  if (
    fillSeriesStateRef.current.chart === chart
    && fillSeriesStateRef.current.signature === fillPayload.signature
    && fillSeriesStateRef.current.paneIndex === paneIndex
  ) {
    return;
  }

  const canReuseSeries = fillSeriesStateRef.current.chart === chart
    && fillSeriesStateRef.current.paneIndex === paneIndex
    && fillSeriesStateRef.current.structureSignature === fillPayload.structureSignature
    && fillSeriesRef.current.length === fillPayload.entries.length * 2;
  if (canReuseSeries) {
    try {
      for (const [index, entry] of fillPayload.entries.entries()) {
        fillSeriesRef.current[index * 2]?.setData(entry.upperData);
        fillSeriesRef.current[index * 2 + 1]?.setData(entry.lowerData);
      }
      fillSeriesStateRef.current = {
        chart,
        paneIndex,
        signature: fillPayload.signature,
        structureSignature: fillPayload.structureSignature,
      };
      recordPerfEvent("chart.fillSeries.setData", {
        paneId,
        fills: fillPayload.matchedFillCount,
        points: fillPayload.pointCount,
        series: fillSeriesRef.current.length,
      });
      return;
    } catch (error) {
      onError?.(error);
    }
  }

  const removedFillSeries = fillSeriesRef.current.length;
  for (const fillSeries of fillSeriesRef.current) {
    try {
      chart.removeSeries(fillSeries);
    } catch {
      // Series may already be removed during chart teardown.
    }
  }
  if (removedFillSeries > 0) {
    recordPerfEvent("chart.fillSeries.remove", {
      paneId,
      series: removedFillSeries,
    });
  }
  fillSeriesRef.current = [];
  fillSeriesStateRef.current = {
    chart,
    paneIndex,
    signature: fillPayload.signature,
    structureSignature: fillPayload.structureSignature,
  };

  if (fillPayload.entries.length === 0) return;

  let createdFillSeries = 0;
  for (const entry of fillPayload.entries) {
    try {
      const areaSeries = chart.addSeries(chartSeriesTypes.area, {
        lineColor: "transparent",
        lineWidth: 0 as LineWidth,
        topColor: entry.fillColor,
        bottomColor: "transparent",
        priceScaleId: "right",
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }, paneIndex);
      areaSeries.setData(entry.upperData);
      fillSeriesRef.current.push(areaSeries);
      createdFillSeries += 1;

      const lowerSeries = chart.addSeries(chartSeriesTypes.area, {
        lineColor: "transparent",
        lineWidth: 0 as LineWidth,
        topColor: entry.backgroundColor,
        bottomColor: entry.backgroundColor,
        priceScaleId: "right",
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }, paneIndex);
      lowerSeries.setData(entry.lowerData);
      fillSeriesRef.current.push(lowerSeries);
      createdFillSeries += 1;
    } catch (error) {
      onError?.(error);
    }
  }

  recordPerfEvent("chart.fillSeries.create", {
    paneId,
    fills: fillPayload.matchedFillCount,
    definitions: definitionsCount,
    series: createdFillSeries,
    points: fillPayload.pointCount,
  });
}

export function renderHlines({
  series,
  indicatorHlines,
  hlinesRef,
  hlinesStateRef,
  paneId,
  recordPerfEvent,
  onError,
}: {
  series: MainSeriesHandle | null | undefined;
  indicatorHlines: IndicatorHline[] | null | undefined;
  hlinesRef: MutableRef<Array<{ series: MainSeriesHandle; priceLine: IPriceLine }>>;
  hlinesStateRef: MutableRef<{
    target: MainSeriesHandle | null | undefined;
    signature: string;
  }>;
  paneId: string;
  recordPerfEvent: PerfEventRecorder;
  onError?: (error: unknown) => void;
}): void {
  const signature = buildHlineSignature(indicatorHlines);

  if (hlinesStateRef.current.target === series && hlinesStateRef.current.signature === signature) {
    return;
  }

  const removedHlines = hlinesRef.current.length;
  for (const item of hlinesRef.current) {
    try {
      item.series.removePriceLine(item.priceLine);
    } catch {
      // Price lines can already be detached during chart teardown.
    }
  }
  if (removedHlines > 0) {
    recordPerfEvent("chart.hline.remove", {
      paneId,
      hlines: removedHlines,
    });
  }
  hlinesRef.current = [];
  hlinesStateRef.current = { target: series, signature };

  if (!series || !indicatorHlines || indicatorHlines.length === 0) return;

  const lineStyleMap: Readonly<Record<string, LineStyle>> = {
    solid: 0,
    dotted: 1,
    dashed: 2,
    large_dashed: 3,
    sparse_dotted: 4,
  };
  let createdHlines = 0;

  for (const hline of indicatorHlines) {
    if (hline.price == null || !isFinite(hline.price)) continue;
    try {
      const priceLine = series.createPriceLine({
        price: hline.price,
        color: hline.color || "#787b86",
        lineWidth: 1,
        lineStyle: typeof hline.linestyle === "number"
          ? hline.linestyle
          : (typeof hline.linestyle === "string" ? lineStyleMap[hline.linestyle] ?? 2 : 2),
        axisLabelVisible: true,
        title: hline.title || "",
      });
      hlinesRef.current.push({ series, priceLine });
      createdHlines += 1;
    } catch (error) {
      onError?.(error);
    }
  }

  recordPerfEvent("chart.hline.create", {
    paneId,
    hlines: createdHlines,
    definitions: indicatorHlines.length,
  });
}
