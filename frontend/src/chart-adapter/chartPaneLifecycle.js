import { createChartInstance } from "./lightweightChartSurface.js";
import { createAlignmentSeries, createMainSeries } from "./seriesLifecycle.js";

export function buildLocalizationOptions(timezone = "Local", interval = "1h") {
  const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
  try {
    const showSeconds = /^\d+s$/.test(String(interval));
    const tooltipFormatOptions = {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    };
    const datePartsOptions = {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    };
    if (timeZoneOpt) {
      tooltipFormatOptions.timeZone = timeZoneOpt;
      datePartsOptions.timeZone = timeZoneOpt;
    }
    const tooltipFormatter = new Intl.DateTimeFormat("en-GB", tooltipFormatOptions);
    const partsFormatter = new Intl.DateTimeFormat("en-GB", datePartsOptions);

    return {
      localization: {
        timeFormatter: (ts) => tooltipFormatter.format(new Date(ts * 1000)),
      },
      timeScale: {
        tickMarkFormatter: (ts, tickMarkType) => {
          const parts = partsFormatter.formatToParts(new Date(ts * 1000));
          const get = (type) => parts.find((part) => part.type === type)?.value;
          const year = get("year");
          const month = get("month");
          const day = get("day");
          const hour = get("hour");
          const min = get("minute");
          const sec = get("second");

          switch (tickMarkType) {
            case 0:
              return year;
            case 1:
              return `${month} '${year.slice(-2)}`;
            case 2:
              return `${day} ${month}`;
            case 3:
              return showSeconds ? `${hour}:${min}:${sec}` : `${hour}:${min}`;
            case 4:
              return `${hour}:${min}:${sec}`;
            default:
              return `${day} ${month}`;
          }
        },
      },
    };
  } catch {
    return {};
  }
}

export function buildCrosshairOptions(visible = true) {
  return {
    mode: 0,
    vertLine: {
      color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
      labelBackgroundColor: "#3b82f6",
      visible,
      labelVisible: visible,
    },
    horzLine: {
      color: "rgba(59, 130, 246, 0.4)", width: 1, style: 2,
      labelBackgroundColor: "#3b82f6",
      visible,
      labelVisible: visible,
    },
  };
}

function getPaneThemeColors({ theme, customBg }) {
  return {
    bgColor: theme === "light" ? "#ffffff" : (theme === "custom" ? customBg : "#0a0e17"),
    textColor: theme === "light" ? "#1e293b" : "#94a3b8",
    gridColor: theme === "light" ? "rgba(0,0,0,0.05)" : "rgba(30, 41, 59, 0.5)",
    borderColor: theme === "light" ? "#e2e8f0" : "#1e293b",
  };
}

export function buildChartPaneOptions({
  container,
  theme,
  customBg,
  timezone,
  interval,
  showTimeScale,
}) {
  const loc = buildLocalizationOptions(timezone, interval);
  const { bgColor, textColor, gridColor, borderColor } = getPaneThemeColors({ theme, customBg });

  return {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { color: bgColor },
      textColor,
      fontFamily: "'Inter', sans-serif",
      fontSize: 12,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: gridColor },
      horzLines: { color: gridColor },
    },
    crosshair: buildCrosshairOptions(true),
    rightPriceScale: {
      alignLabels: false,
      entireTextOnly: true,
      borderColor,
      scaleMargins: { top: 0.05, bottom: 0.05 },
      autoScale: true,
      minimumWidth: 80,
    },
    ...(loc.localization ? { localization: loc.localization } : {}),
    timeScale: {
      borderColor,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
      visible: showTimeScale,
      ...(loc.timeScale ? { tickMarkFormatter: loc.timeScale.tickMarkFormatter } : {}),
    },
    handleScroll: { vertTouchDrag: false },
  };
}

export function applyChartPaneAppearance(chart, { theme, customBg, timezone, interval }) {
  const loc = buildLocalizationOptions(timezone, interval);
  const { bgColor, textColor, gridColor, borderColor } = getPaneThemeColors({ theme, customBg });
  chart.applyOptions({
    layout: { background: { color: bgColor }, textColor },
    grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
    rightPriceScale: { borderColor },
    timeScale: { borderColor },
    ...(loc.localization ? { localization: loc.localization } : {}),
    ...(loc.timeScale ? { timeScale: { tickMarkFormatter: loc.timeScale.tickMarkFormatter } } : {}),
  });
}

export function createChartPaneLifecycle({
  container,
  paneId,
  paneType,
  theme,
  customBg,
  timezone,
  interval,
  showTimeScale,
  upColor,
  downColor,
  chartAdapter,
  refs,
  handlers,
}) {
  const chart = createChartInstance(container, buildChartPaneOptions({
    container,
    theme,
    customBg,
    timezone,
    interval,
    showTimeScale,
  }));

  let mainSeries = null;
  if (paneType === "main") {
    mainSeries = createMainSeries(chart, { upColor, downColor });
    refs.mainSeriesRef.current = mainSeries;
  }

  if (paneType === "sub") {
    refs.alignmentSeriesRef.current = createAlignmentSeries(chart);
    refs.drawingAnchorSeriesRef.current = null;
  }

  const handleCrosshairMove = (param) => {
    if (refs.isSyncingRef.current) return;

    handlers.onCrosshairSync?.({
      paneId,
      time: param.time || null,
      point: param.point || null,
      logical: param.logical,
    });

    if (paneType === "main" && handlers.onCrosshairMoveExternal && mainSeries) {
      if (!param.time || !param.seriesData) {
        handlers.onCrosshairMoveExternal(null);
        return;
      }
      const cd = param.seriesData.get(mainSeries);
      if (!cd || cd.open == null || cd.high == null || cd.low == null || cd.close == null) {
        handlers.onCrosshairMoveExternal(null);
        return;
      }
      handlers.onCrosshairMoveExternal({
        time: param.time,
        open: cd.open,
        high: cd.high,
        low: cd.low,
        close: cd.close,
      });
    }
  };

  const handleVisibleLogicalRangeChange = (range) => {
    if (refs.isSyncingRef.current) return;
    if (range) handlers.onVisibleLogicalRangeChange?.({ paneId, range });
  };

  chart.subscribeCrosshairMove(handleCrosshairMove);
  chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
  refs.chartRef.current = chart;

  handlers.onChartCreated?.({ chartAdapter });
  handlers.setSeriesReady?.((prev) => prev + 1);

  const resizeObserver = new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    if (width > 0 && height > 0) {
      chart.applyOptions({ width, height });
    }
  });
  resizeObserver.observe(container);

  let priceScaleDragStartY = null;
  let isPriceScaleDragging = false;

  const handleMouseDown = (event) => {
    const rect = container.getBoundingClientRect();
    if (event.clientX >= rect.right - 80) {
      priceScaleDragStartY = event.clientY;
      isPriceScaleDragging = false;
    }
  };

  const handleMouseMove = (event) => {
    if (priceScaleDragStartY !== null && Math.abs(event.clientY - priceScaleDragStartY) > 3) {
      isPriceScaleDragging = true;
    }
  };

  const handleMouseUp = () => {
    if (isPriceScaleDragging && refs.autoScaleRef.current) {
      refs.autoScaleRef.current = false;
      handlers.setIsAutoScale?.(false);
    }
    priceScaleDragStartY = null;
    isPriceScaleDragging = false;
  };

  const handleDblClick = (event) => {
    const rect = container.getBoundingClientRect();
    if (event.clientX >= rect.right - 80) {
      chart.priceScale("right").applyOptions({ autoScale: true });
      refs.autoScaleRef.current = true;
      handlers.setIsAutoScale?.(true);
    }
  };

  const handleContextMenu = (event) => {
    if (paneType !== "main") return;
    const rect = container.getBoundingClientRect();
    if (event.clientX < rect.right - 80) return;
    event.preventDefault();
    event.stopPropagation();

    let x = event.clientX - rect.left;
    let y = event.clientY - rect.top;
    const menuWidth = 180;
    const menuHeight = 220;

    if (x + menuWidth > rect.width) {
      x = rect.width - menuWidth - 4;
    }
    if (y + menuHeight > rect.height) {
      y = Math.max(0, rect.height - menuHeight - 4);
    }

    handlers.setContextMenu?.({ x, y });
  };

  container.addEventListener("mousedown", handleMouseDown);
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);
  container.addEventListener("dblclick", handleDblClick);
  container.addEventListener("contextmenu", handleContextMenu);

  return {
    chart,
    dispose: () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("contextmenu", handleContextMenu);
      resizeObserver.disconnect();
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      } catch {
        // Older lightweight-charts versions tolerate missing unsubscription.
      }
      try {
        chart.unsubscribeCrosshairMove(handleCrosshairMove);
      } catch {
        // Cleanup remains best-effort across chart-library versions.
      }
      chart.remove();
      refs.chartRef.current = null;
      refs.mainSeriesRef.current = null;
      refs.alignmentSeriesRef.current = null;
      refs.drawingAnchorSeriesRef.current = null;
      refs.indicatorSeriesRef.current = [];
    },
  };
}
