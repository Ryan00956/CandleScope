import { chartTimeKey, compareChartTimes } from "./chartTime.js";

export function flattenBgcolorRegions(indicatorBgcolors = []) {
  const regions = [];
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

export function buildBgcolorSignature(regions = []) {
  if (!regions.length) return "empty";
  return JSON.stringify(regions.map((region) => [chartTimeKey(region.time), region.color]));
}

class BgcolorPaneRenderer {
  constructor() {
    this._data = { chart: null, regions: [] };
  }

  update(data) {
    this._data = data;
  }

  draw(target) {
    const { chart, regions } = this._data;
    if (!chart || !regions?.length) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const width = scope.bitmapSize.width;
      const height = scope.bitmapSize.height;
      const timeScale = chart.timeScale();
      const barSpacing = Math.max(1, timeScale.options?.()?.barSpacing || 8);
      const barWidth = Math.max(1, barSpacing - 1);

      for (const region of regions) {
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

class BgcolorPaneView {
  constructor(source) {
    this._source = source;
    this._renderer = new BgcolorPaneRenderer();
  }

  update() {
    this._renderer.update({
      chart: this._source._chart,
      regions: this._source._regions,
    });
  }

  renderer() {
    return this._renderer;
  }

  zOrder() {
    return "bottom";
  }
}

class BgcolorPanePrimitive {
  constructor(regions) {
    this._chart = null;
    this._requestUpdate = null;
    this._regions = regions;
    this._paneView = new BgcolorPaneView(this);
  }

  attached({ chart, requestUpdate }) {
    this._chart = chart;
    this._requestUpdate = requestUpdate;
    this._requestUpdate?.();
  }

  detached() {
    this._chart = null;
    this._requestUpdate = null;
  }

  setRegions(regions) {
    this._regions = regions;
    this._requestUpdate?.();
  }

  updateAllViews() {
    this._paneView.update();
  }

  paneViews() {
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
}) {
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
    bgcolorStateRef.current = { pane, signature };
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
    bgcolorStateRef.current = { pane, signature };
  } catch (error) {
    onError?.(error);
  }
}
