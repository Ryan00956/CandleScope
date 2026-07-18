import type { IndicatorDefinition, IndicatorLine } from "./indicatorTypes.js";

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

export interface IndicatorSubPane {
  id: string;
  label: string;
  lines: IndicatorLine[];
  owner?: {
    kind: "indicator" | "market-study";
    id: string;
  };
  dataMarketPane?: "funding-rate" | "open-interest" | "liquidations";
  legendItems?: readonly IndicatorPaneLegendItem[];
  pointMetadata?: readonly IndicatorPanePointMetadata[];
  pointMetadataFallback?: "latest" | "none";
  missingPointText?: string;
  statusText?: string | null;
}

export interface IndicatorPaneData {
  mainOverlayLines: IndicatorLine[];
  subPanes: IndicatorSubPane[];
}

export function buildIndicatorPaneData(
  indicators: IndicatorDefinition[] = [],
): IndicatorPaneData {
  const overlayLines: IndicatorLine[] = [];
  const paneMap = new Map<string, IndicatorSubPane>();

  for (const indicator of indicators) {
    if (!indicator.visible || !indicator.lines || indicator.lines.length === 0) continue;

    for (const line of indicator.lines) {
      const pane = line.pane || "main";
      const lineWithId = { ...line, indicatorId: indicator.id };

      if (pane === "main") {
        overlayLines.push(lineWithId);
        continue;
      }

      const paneId = `${pane}-${indicator.id}`;
      if (!paneMap.has(paneId)) {
        paneMap.set(paneId, {
          id: paneId,
          label: indicator.name || indicator.id,
          lines: [],
          owner: { kind: "indicator", id: indicator.id },
        });
      }
      paneMap.get(paneId)?.lines.push(lineWithId);
    }
  }

  return {
    mainOverlayLines: overlayLines,
    subPanes: Array.from(paneMap.values()),
  };
}
