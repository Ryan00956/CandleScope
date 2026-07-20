import { memo, useMemo, useSyncExternalStore } from "react";
import type {
  IndicatorPanePointMetadata,
  IndicatorSubPane,
} from "../features/indicators/indicatorPaneProjection.js";
import type { PaneCrosshairStore } from "./paneCrosshairStore.js";

interface MarketPaneLabelsProps {
  panes: readonly IndicatorSubPane[];
  collapsedPaneIds: readonly string[];
  crosshairStore: PaneCrosshairStore;
}

interface MarketPaneLabelProps {
  pane: IndicatorSubPane;
  collapsed: boolean;
  crosshairStore: PaneCrosshairStore;
}

const MarketPaneLabel = memo(function MarketPaneLabel({
  pane,
  collapsed,
  crosshairStore,
}: MarketPaneLabelProps) {
  const crosshairTime = useSyncExternalStore(
    crosshairStore.subscribe,
    crosshairStore.getSnapshot,
    crosshairStore.getSnapshot,
  );
  const metadataByTime = useMemo<ReadonlyMap<number, IndicatorPanePointMetadata>>(
    () => new Map((pane.pointMetadata || []).map((point) => [point.time, point])),
    [pane.pointMetadata],
  );
  const latestMetadata = pane.pointMetadata?.at(-1) ?? null;
  const exactPoint = crosshairTime === null
    ? null
    : metadataByTime.get(crosshairTime) ?? null;
  const displayPoint = exactPoint ?? (
    crosshairTime === null || pane.pointMetadataFallback !== "none"
      ? latestMetadata
      : null
  );
  const auxiliaryText = displayPoint
    ? null
    : crosshairTime !== null
      ? pane.missingPointText ?? pane.statusText ?? null
      : pane.statusText ?? null;

  return (
    <div
      className="chart-pane-label advanced-market-pane-label pane-overlay-anchor"
      data-market-pane={pane.dataMarketPane}
      data-pane-id={pane.id}
      data-pane-collapsed={collapsed ? "true" : "false"}
      role="group"
      aria-label={displayPoint?.accessibilityLabel ?? auxiliaryText ?? pane.label}
    >
      <span className="advanced-market-pane-heading">{pane.label}</span>
      {displayPoint && (
        <span
          className="advanced-market-pane-value"
          data-appearance={displayPoint.appearance}
        >
          <span>{displayPoint.valueLabel}</span>
          <span className="advanced-market-pane-source">
            {`${displayPoint.sourceLabel} · ${displayPoint.qualityLabel}`}
          </span>
        </span>
      )}
      {auxiliaryText && (
        <span className="advanced-market-pane-status">{auxiliaryText}</span>
      )}
      {pane.legendItems && pane.legendItems.length > 0 && (
        <span className="advanced-market-pane-legend" aria-hidden="true">
          {pane.legendItems.map((item) => (
            <span key={item.id} className="advanced-market-pane-legend-item" title={item.description}>
              <span
                className="advanced-market-pane-legend-swatch"
                data-appearance={item.appearance}
                style={item.color ? { background: item.color } : undefined}
              />
              <span>{item.label}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
});

function MarketPaneLabels({
  panes,
  collapsedPaneIds,
  crosshairStore,
}: MarketPaneLabelsProps) {
  const marketPanes = useMemo(
    () => panes.filter((pane) => Boolean(pane.dataMarketPane)),
    [panes],
  );
  const collapsedIds = useMemo(() => new Set(collapsedPaneIds), [collapsedPaneIds]);

  return marketPanes.map((pane) => (
    <MarketPaneLabel
      key={pane.id}
      pane={pane}
      collapsed={collapsedIds.has(pane.id)}
      crosshairStore={crosshairStore}
    />
  ));
}

export default memo(MarketPaneLabels);
