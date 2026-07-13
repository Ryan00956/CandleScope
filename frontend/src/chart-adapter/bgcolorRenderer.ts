import type { IChartApiBase } from "lightweight-charts";
import type { MutableRef, PerfEventRecorder } from "./chartAdapterTypes.js";

interface LegacyBgcolorGroup {
  color?: string;
  regions?: Array<{ time: number }>;
}

export function renderBgcolorOverlay({
  chart,
  container,
  indicatorBgcolors,
  bgCanvasRef,
  bgAnimFrameRef,
  paneId,
  recordPerfEvent,
}: {
  chart: IChartApiBase<number> | null | undefined;
  container: HTMLElement | null | undefined;
  indicatorBgcolors: LegacyBgcolorGroup[] | null | undefined;
  bgCanvasRef: MutableRef<HTMLCanvasElement | null>;
  bgAnimFrameRef: MutableRef<number | null>;
  paneId: string;
  recordPerfEvent: PerfEventRecorder;
}): (() => void) | undefined {
  if (!chart || !container) return undefined;
  if (!indicatorBgcolors || indicatorBgcolors.length === 0) {
    // Remove existing canvas if no bgcolors
    if (bgCanvasRef.current) {
      try { bgCanvasRef.current.remove(); } catch { /* */ }
      bgCanvasRef.current = null;
      recordPerfEvent("chart.bgcolorOverlay.remove", { paneId });
    }
    return undefined;
  }

  // Create or reuse canvas overlay
  let canvas = bgCanvasRef.current;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "bgcolor-overlay-canvas";
    canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;";
    container.style.position = "relative";
    // Insert canvas as first child so it's behind chart elements
    container.insertBefore(canvas, container.firstChild);
    bgCanvasRef.current = canvas;
    recordPerfEvent("chart.bgcolorOverlay.create", { paneId });
  }
  const renderCanvas = canvas;

  // Build time→color map from all bgcolor sources
  const colorRegions: Array<{ time: number; color: string }> = [];
  for (const bg of indicatorBgcolors) {
    if (!bg.regions || !Array.isArray(bg.regions)) continue;
    const bgColor = bg.color || "rgba(59,130,246,0.1)";
    for (const region of bg.regions) {
      if (region.time != null) {
        colorRegions.push({ time: region.time, color: bgColor });
      }
    }
  }
  if (colorRegions.length === 0) return undefined;

  const timeColorMap = new Map<number, string>();
  for (const r of colorRegions) {
    timeColorMap.set(r.time, r.color);
  }

  // Render function — called on scroll/resize
  const renderBg = () => {
    const timeScale = chart.timeScale();
    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Update canvas size
    const dpr = window.devicePixelRatio || 1;
    renderCanvas.width = w * dpr;
    renderCanvas.height = h * dpr;
    renderCanvas.style.width = w + "px";
    renderCanvas.style.height = h + "px";

    const ctx2d = renderCanvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);

    // Get visible range
    const visibleRange = timeScale.getVisibleRange();
    if (!visibleRange) return;

    // For each colored region, compute x coordinates and draw
    let visibleRegions = 0;
    for (const [time, color] of timeColorMap) {
      if (time < visibleRange.from || time > visibleRange.to) continue;

      const x = timeScale.timeToCoordinate(time);
      if (x === null || x === undefined) continue;
      visibleRegions += 1;

      // Get bar width from barSpacing
      const barSpacing = timeScale.options().barSpacing || 8;
      const barW = Math.max(1, barSpacing - 1);

      ctx2d.fillStyle = color;
      ctx2d.fillRect(x - barW / 2, 0, barW, h);
    }
    recordPerfEvent("chart.bgcolorOverlay.render", {
      paneId,
      regions: timeColorMap.size,
      visibleRegions,
      width: Math.round(w),
      height: Math.round(h),
    });
  };

  // Initial render
  renderBg();

  // Re-render on visible range changes
  const onRangeChange = () => {
    if (bgAnimFrameRef.current) cancelAnimationFrame(bgAnimFrameRef.current);
    bgAnimFrameRef.current = requestAnimationFrame(renderBg);
  };

  const tsObj = chart.timeScale();
  tsObj.subscribeVisibleLogicalRangeChange(onRangeChange);

  // Also re-render on resize
  const ro = new ResizeObserver(onRangeChange);
  ro.observe(container);

  return () => {
    tsObj.unsubscribeVisibleLogicalRangeChange(onRangeChange);
    ro.disconnect();
    if (bgAnimFrameRef.current) cancelAnimationFrame(bgAnimFrameRef.current);
  };
}
