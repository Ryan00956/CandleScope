import { chartTimeKey, compareChartTimes } from "./chartTime.js";
import type {
  IChartApiBase,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  PrimitivePaneViewZOrder,
} from "lightweight-charts";
import type {
  BgcolorRegion,
  ChartTime,
  IndicatorBgcolorGroup,
  MutableRef,
  PaneHandle,
  PerfEventRecorder,
} from "./chartAdapterTypes.js";

export function flattenBgcolorRegions(
  indicatorBgcolors: IndicatorBgcolorGroup[] = [],
): BgcolorRegion[] {
  const regions: BgcolorRegion[] = [];
  for (const bg of indicatorBgcolors || []) {
    const color = bg?.color || "rgba(59,130,246,0.1)";
    for (const region of bg?.regions || []) {
      if (region?.time == null) continue;
      regions.push({ time: region.time, color });
    }
  }
  regions.sort((a, b) => compareChartTimes(a.time, b.time));
  return regions;
}

export function buildBgcolorSignature(regions: BgcolorRegion[] = []): string {
  if (!regions.length) return "empty";
  return JSON.stringify(regions.map((region) => [chartTimeKey(region.time), region.color]));
}

export function sliceBgcolorRegionsForVisibleRange(
  regions: readonly BgcolorRegion[],
  visibleRange: { from: ChartTime; to: ChartTime } | null | undefined,
): readonly BgcolorRegion[] {
  if (!visibleRange || regions.length === 0) return regions;
  const from = compareChartTimes(visibleRange.from, visibleRange.to) <= 0
    ? visibleRange.from
    : visibleRange.to;
  const to = from === visibleRange.from ? visibleRange.to : visibleRange.from;
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const region = regions[middle];
    if (region && compareChartTimes(region.time, from) < 0) low = middle + 1;
    else high = middle;
  }
  const firstVisible = low;
  low = firstVisible;
  high = regions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const region = regions[middle];
    if (region && compareChartTimes(region.time, to) <= 0) low = middle + 1;
    else high = middle;
  }
  // Keep one neighbor on each side because a partially visible bar can have
  // its center just outside the time range while its background still clips
  // into the viewport.
  const start = Math.max(0, firstVisible - 1);
  const end = Math.min(regions.length, low + 1);
  return regions.slice(start, end);
}

interface BgcolorRendererData {
  chart: IChartApiBase<ChartTime> | null;
  regions: BgcolorRegion[];
}

class BgcolorPaneRenderer implements IPrimitivePaneRenderer {
  private _data: BgcolorRendererData;

  constructor() {
    this._data = { chart: null, regions: [] };
  }

  update(data: BgcolorRendererData): void {
    this._data = data;
  }

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    const { chart, regions } = this._data;
    if (!chart || !regions?.length) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const width = scope.bitmapSize.width;
      const height = scope.bitmapSize.height;
      const timeScale = chart.timeScale();
      const visibleRegions = sliceBgcolorRegionsForVisibleRange(
        regions,
        timeScale.getVisibleRange?.() ?? null,
      );
      const barSpacing = Math.max(1, timeScale.options?.()?.barSpacing || 8);
      const barWidth = Math.max(1, barSpacing - 1);

      for (const region of visibleRegions) {
        const x = timeScale.timeToCoordinate(region.time);
        if (x == null || !Number.isFinite(x)) continue;

        const left = Math.round((x - barWidth / 2) * hRatio);
        const right = Math.round((x + barWidth / 2) * hRatio);
        const rectWidth = Math.max(1, right - left);
        if (left > width || left + rectWidth < 0) continue;

        ctx.fillStyle = region.color;
        ctx.fillRect(left, 0, rectWidth, height);
      }
    });
  }
}

class BgcolorPaneView implements IPanePrimitivePaneView {
  private readonly _source: BgcolorPanePrimitive;
  private readonly _renderer: BgcolorPaneRenderer;

  constructor(source: BgcolorPanePrimitive) {
    this._source = source;
    this._renderer = new BgcolorPaneRenderer();
  }

  update(): void {
    this._renderer.update({
      chart: this._source._chart,
      regions: this._source._regions,
    });
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }
}

class BgcolorPanePrimitive implements IPanePrimitive<ChartTime> {
  _chart: IChartApiBase<ChartTime> | null;
  _requestUpdate: (() => void) | null;
  _regions: BgcolorRegion[];
  private readonly _paneView: BgcolorPaneView;

  constructor(regions: BgcolorRegion[]) {
    this._chart = null;
    this._requestUpdate = null;
    this._regions = regions;
    this._paneView = new BgcolorPaneView(this);
  }

  attached({ chart, requestUpdate }: PaneAttachedParameter<ChartTime>): void {
    this._chart = chart;
    this._requestUpdate = requestUpdate;
    this._requestUpdate?.();
  }

  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  setRegions(regions: BgcolorRegion[]): void {
    this._regions = regions;
    this._requestUpdate?.();
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return [this._paneView];
  }
}

export function renderBgcolors({
  chart,
  pane,
  indicatorBgcolors,
  bgcolorPrimitiveRef,
  bgcolorStateRef,
  paneId,
  recordPerfEvent,
  onError,
}: {
  chart: IChartApiBase<ChartTime> | null | undefined;
  pane: PaneHandle | null | undefined;
  indicatorBgcolors: IndicatorBgcolorGroup[];
  bgcolorPrimitiveRef: MutableRef<BgcolorPanePrimitive | null>;
  bgcolorStateRef: MutableRef<{
    pane: PaneHandle | null | undefined;
    signature: string;
    source?: IndicatorBgcolorGroup[] | null;
  }>;
  paneId: string;
  recordPerfEvent: PerfEventRecorder;
  onError?: (error: unknown) => void;
}): void {
  if (
    bgcolorStateRef.current.pane === pane
    && bgcolorStateRef.current.source === indicatorBgcolors
  ) {
    return;
  }
  const regions = flattenBgcolorRegions(indicatorBgcolors);
  const signature = buildBgcolorSignature(regions);

  if (
    bgcolorStateRef.current.pane === pane
    && bgcolorStateRef.current.signature === signature
  ) {
    return;
  }

  if (!chart || !pane || regions.length === 0) {
    if (bgcolorPrimitiveRef.current && bgcolorStateRef.current.pane) {
      try {
        bgcolorStateRef.current.pane.detachPrimitive(bgcolorPrimitiveRef.current);
      } catch (error) {
        onError?.(error);
      }
      bgcolorPrimitiveRef.current = null;
      recordPerfEvent("chart.bgcolorPrimitive.remove", { paneId });
    }
    bgcolorStateRef.current = { pane, signature, source: indicatorBgcolors };
    return;
  }

  if (bgcolorPrimitiveRef.current && bgcolorStateRef.current.pane !== pane) {
    try {
      bgcolorStateRef.current.pane?.detachPrimitive(bgcolorPrimitiveRef.current);
    } catch (error) {
      onError?.(error);
    }
    bgcolorPrimitiveRef.current = null;
    recordPerfEvent("chart.bgcolorPrimitive.remove", { paneId, reason: "pane-change" });
  }

  try {
    if (!bgcolorPrimitiveRef.current) {
      const primitive = new BgcolorPanePrimitive(regions);
      pane.attachPrimitive(primitive);
      bgcolorPrimitiveRef.current = primitive;
      recordPerfEvent("chart.bgcolorPrimitive.create", {
        paneId,
        regions: regions.length,
      });
    } else {
      bgcolorPrimitiveRef.current.setRegions(regions);
      recordPerfEvent("chart.bgcolorPrimitive.update", {
        paneId,
        regions: regions.length,
      });
    }
    bgcolorStateRef.current = { pane, signature, source: indicatorBgcolors };
  } catch (error) {
    onError?.(error);
  }
}
