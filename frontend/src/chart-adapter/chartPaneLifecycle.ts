import type {
  ChartOptionsImpl,
  CrosshairOptions,
  DeepPartial,
  HorzScaleOptions,
  IChartApiBase,
  TickMarkType,
} from "lightweight-charts";
import type { ChartTime } from "./chartAdapterTypes.js";

type AdapterTickMarkFormatter = (
  time: ChartTime,
  tickMarkType: TickMarkType,
  locale?: string,
) => string;

interface LocalizationBundle {
  localization?: {
    timeFormatter: (time: ChartTime) => string;
  };
  timeScale?: {
    tickMarkFormatter: AdapterTickMarkFormatter;
  };
}

interface PaneAppearanceOptions {
  theme?: string;
  customBg?: string;
  timezone?: string;
  interval?: string;
  timeFormatter?: (timeSeconds: number) => string;
  tickMarkFormatter?: (timeSeconds: number, tickMarkType: TickMarkType) => string;
}

function hasProperty<K extends PropertyKey>(
  value: object,
  key: K,
): value is object & Record<K, unknown> {
  return key in value;
}

function readUnknownProperty(value: object, key: PropertyKey): unknown {
  return hasProperty(value, key) ? value[key] : undefined;
}

type AdapterChartOptions = DeepPartial<ChartOptionsImpl<ChartTime>> & {
  timeScale?: DeepPartial<HorzScaleOptions> & {
    tickMarkFormatter?: AdapterTickMarkFormatter;
  };
};

function formatterSourceTime(value: unknown): number {
  const candidate = value !== null && typeof value === "object"
    ? readUnknownProperty(value, "sourceTime")
      ?? readUnknownProperty(value, "_ordinal_sourceTime")
      ?? value
    : value;
  const numeric = Number(candidate);
  return numeric;
}

export function buildLocalizationOptions(
  timezone = "Local",
  interval = "1h",
): LocalizationBundle {
  const timeZoneOpt = timezone && timezone !== "Local" ? timezone : undefined;
  try {
    const showSeconds = /^\d+s$/.test(String(interval));
    const tooltipFormatOptions: Intl.DateTimeFormatOptions = {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    };
    const datePartsOptions: Intl.DateTimeFormatOptions = {
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
        timeFormatter: (ts: ChartTime) => tooltipFormatter.format(
          new Date(formatterSourceTime(ts) * 1000),
        ),
      },
      timeScale: {
        tickMarkFormatter: (ts: ChartTime, tickMarkType: TickMarkType) => {
          const parts = partsFormatter.formatToParts(
            new Date(formatterSourceTime(ts) * 1000),
          );
          const get = (type: Intl.DateTimeFormatPartTypes): string => (
            parts.find((part) => part.type === type)?.value || ""
          );
          const year = get("year");
          const month = get("month");
          const day = get("day");
          const hour = get("hour");
          const min = get("minute");
          const sec = get("second");

          switch (Number(tickMarkType)) {
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

export function buildCrosshairOptions(visible = true): DeepPartial<CrosshairOptions> {
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

function getPaneThemeColors({ theme, customBg }: PaneAppearanceOptions): {
  bgColor: string;
  textColor: string;
  gridColor: string;
  borderColor: string;
} {
  return {
    bgColor: theme === "light"
      ? "#ffffff"
      : (theme === "custom" ? customBg || "#0a0e17" : "#0a0e17"),
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
  timeFormatter,
  tickMarkFormatter,
}: PaneAppearanceOptions & {
  container: HTMLElement;
  showTimeScale?: boolean;
}): AdapterChartOptions {
  const loc = buildLocalizationOptions(timezone, interval);
  const { bgColor, textColor, gridColor, borderColor } = getPaneThemeColors({
    ...(theme !== undefined ? { theme } : {}),
    ...(customBg !== undefined ? { customBg } : {}),
  });

  return {
    width: container.clientWidth,
    height: container.clientHeight,
    autoSize: true,
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
    ...(timeFormatter
      ? { localization: { timeFormatter: (time: ChartTime) => timeFormatter(formatterSourceTime(time)) } }
      : loc.localization ? { localization: loc.localization } : {}),
    timeScale: {
      borderColor,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
      ...(showTimeScale !== undefined ? { visible: showTimeScale } : {}),
      ...(tickMarkFormatter
        ? { tickMarkFormatter: (time: ChartTime, type: TickMarkType) => tickMarkFormatter(formatterSourceTime(time), type) }
        : loc.timeScale ? { tickMarkFormatter: loc.timeScale.tickMarkFormatter } : {}),
    },
    handleScroll: { vertTouchDrag: false },
  };
}

export function applyChartPaneAppearance(
  chart: IChartApiBase<ChartTime>,
  { theme, customBg, timezone, interval, timeFormatter, tickMarkFormatter }: PaneAppearanceOptions,
): void {
  const loc = buildLocalizationOptions(timezone, interval);
  const { bgColor, textColor, gridColor, borderColor } = getPaneThemeColors({
    ...(theme !== undefined ? { theme } : {}),
    ...(customBg !== undefined ? { customBg } : {}),
  });
  const appearanceOptions: AdapterChartOptions = {
    layout: { background: { color: bgColor }, textColor },
    grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
    rightPriceScale: { borderColor },
    timeScale: { borderColor },
    ...(timeFormatter
      ? { localization: { timeFormatter: (time: ChartTime) => timeFormatter(formatterSourceTime(time)) } }
      : loc.localization ? { localization: loc.localization } : {}),
    ...(tickMarkFormatter
      ? { timeScale: { tickMarkFormatter: (time: ChartTime, type: TickMarkType) => tickMarkFormatter(formatterSourceTime(time), type) } }
      : loc.timeScale ? { timeScale: { tickMarkFormatter: loc.timeScale.tickMarkFormatter } } : {}),
  };
  chart.applyOptions(appearanceOptions);
}
