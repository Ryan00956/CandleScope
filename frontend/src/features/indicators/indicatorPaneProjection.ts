import type {
  IndicatorBgColor,
  IndicatorDefinition,
  IndicatorFill,
  IndicatorHLine,
  IndicatorLine,
  IndicatorMarker,
} from "./indicatorTypes.js";

export interface IndicatorPaneLegendItem {
  id: string;
  label: string;
  appearance: "solid" | "estimated" | "realtime" | "carried";
  description: string;
  color?: string;
}

export interface IndicatorPanePointMetadata {
  time: number;
  value: number;
  valueLabel: string;
  sourceLabel: string;
  qualityLabel: string;
  appearance: IndicatorPaneLegendItem["appearance"];
  accessibilityLabel: string;
}

export interface IndicatorPaneLiveCountdown {
  label: string;
  targetTimeMs: number;
}

export interface IndicatorSubPane {
  id: string;
  label: string;
  lines: IndicatorLine[];
  owner?: {
    kind: "indicator" | "market-study" | "trade-flow";
    id: string;
  };
  dataMarketPane?:
    | "funding-rate"
    | "open-interest"
    | "liquidations"
    | "order-flow-cvd"
    | "order-flow-delta";
  legendItems?: readonly IndicatorPaneLegendItem[];
  pointMetadata?: readonly IndicatorPanePointMetadata[];
  liveCountdown?: IndicatorPaneLiveCountdown;
  pointMetadataFallback?: "latest" | "none";
  missingPointText?: string;
  statusText?: string | null;
}

export interface IndicatorPaneData {
  mainOverlayLines: IndicatorLine[];
  subPanes: IndicatorSubPane[];
}

export interface IndicatorPaneAuxiliaryData {
  markers?: readonly IndicatorMarker[];
  fills?: readonly IndicatorFill[];
  hlines?: readonly IndicatorHLine[];
  bgcolors?: readonly IndicatorBgColor[];
}

function itemBelongsToIndicatorPane(
  item: { indicatorId?: string; pane?: string },
  indicatorId: string,
  pane: string,
): boolean {
  return item.indicatorId === indicatorId && (item.pane || "main") === pane;
}

function paneHasVisibleAuxiliaryOutput(
  auxiliary: IndicatorPaneAuxiliaryData,
  indicatorId: string,
  pane: string,
  lines: readonly IndicatorLine[],
): boolean {
  if (auxiliary.markers?.some((item) =>
    itemBelongsToIndicatorPane(item, indicatorId, pane))) {
    return true;
  }
  if (auxiliary.hlines?.some((item) =>
    itemBelongsToIndicatorPane(item, indicatorId, pane))) {
    return true;
  }
  if (auxiliary.bgcolors?.some((item) =>
    itemBelongsToIndicatorPane(item, indicatorId, pane))) {
    return true;
  }

  const lineIds = new Set(lines.flatMap((line) => line.id ? [line.id] : []));
  return auxiliary.fills?.some((fill) => (
    fill.indicatorId === indicatorId
    && typeof fill.plot1_id === "string"
    && typeof fill.plot2_id === "string"
    && lineIds.has(fill.plot1_id)
    && lineIds.has(fill.plot2_id)
  )) ?? false;
}

function auxiliaryPanesForIndicator(
  auxiliary: IndicatorPaneAuxiliaryData,
  indicatorId: string,
): Set<string> {
  const panes = new Set<string>();
  for (const items of [
    auxiliary.markers,
    auxiliary.hlines,
    auxiliary.bgcolors,
  ]) {
    for (const item of items || []) {
      if (item.indicatorId !== indicatorId) continue;
      const pane = item.pane || "main";
      if (pane !== "main") panes.add(pane);
    }
  }
  return panes;
}

export function buildIndicatorPaneData(
  indicators: IndicatorDefinition[] = [],
  auxiliary: IndicatorPaneAuxiliaryData = {},
): IndicatorPaneData {
  const overlayLines: IndicatorLine[] = [];
  const paneMap = new Map<string, IndicatorSubPane>();

  for (const indicator of indicators) {
    if (indicator.visible === false) continue;

    const linesByPane = new Map<string, IndicatorLine[]>();
    for (const line of indicator.lines || []) {
      const pane = line.pane || "main";
      const lineWithId = { ...line, indicatorId: indicator.id };

      if (pane === "main") {
        overlayLines.push(lineWithId);
        continue;
      }

      const paneLines = linesByPane.get(pane) || [];
      paneLines.push(lineWithId);
      linesByPane.set(pane, paneLines);
    }
    for (const pane of auxiliaryPanesForIndicator(auxiliary, indicator.id)) {
      if (!linesByPane.has(pane)) linesByPane.set(pane, []);
    }

    for (const [pane, lines] of linesByPane) {
      const hasVisibleSeries = lines.some((line) => line.visible !== false);
      if (
        !hasVisibleSeries
        && !paneHasVisibleAuxiliaryOutput(
          auxiliary,
          indicator.id,
          pane,
          lines,
        )
      ) {
        continue;
      }

      const paneId = `${pane}-${indicator.id}`;
      paneMap.set(paneId, {
        id: paneId,
        label: indicator.name || indicator.id,
        lines,
        owner: { kind: "indicator", id: indicator.id },
      });
    }
  }

  return {
    mainOverlayLines: overlayLines,
    subPanes: Array.from(paneMap.values()),
  };
}
