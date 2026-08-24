import React from "react";
import SingleChartPanes from "../components/SingleChartPanes.js";
import { combineExternalMarkerSources } from "../chart-adapter/externalMarkerSource.js";
import type { ExternalMarkerSource } from "../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayerSource } from "../features/plugins/pluginChartLayerSource.js";
import { useAdvancedMarketPanes } from "../features/advanced-market-data/useAdvancedMarketPanes.js";
import { useTradeFlowPanes } from "../features/trade-flow/useTradeFlowPanes.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import MarketChartSurface from "../features/market-chart-platform/MarketChartSurface.js";
import type { MarketChartSourceRuntime } from "../features/market-chart-platform/marketChartSourceRuntime.js";
import { ChartErrorBoundary } from "./AppProviders.js";
import { drawingToolWhenInteractionReady } from "./drawingInteractionReadiness.js";
import type { ChartWorkspaceChartModel } from "./ChartWorkspace.js";
import type { ComponentType, PropsWithChildren } from "react";
import { t } from "../i18n/index.js";
import { useLocale } from "../i18n/useLocale.js";

export interface ChartCellCanvasProps {
  chart: ChartWorkspaceChartModel;
  source?: MarketChartSourceRuntime;
  tradeFlow: TradeFlowRuntime;
  strategyMarkerSource?: ExternalMarkerSource | null;
  pluginMarkerSource?: ExternalMarkerSource | null;
  pluginChartLayerSource?: PluginChartLayerSource | null;
  errorBoundary?: ComponentType<PropsWithChildren>;
  drawingInteractionReady?: boolean;
  onDrawingInteractionReadyChange?: (ready: boolean) => void;
  paused?: boolean;
}

function ChartCellCanvas({
  chart,
  source,
  tradeFlow,
  strategyMarkerSource = null,
  pluginMarkerSource = null,
  pluginChartLayerSource = null,
  errorBoundary = ChartErrorBoundary,
  drawingInteractionReady = false,
  onDrawingInteractionReadyChange,
  paused = false,
}: ChartCellCanvasProps) {
  useLocale();
  const Boundary = errorBoundary;
  const advancedPanes = useAdvancedMarketPanes(chart.advancedMarketData);
  const tradeFlowPanes = useTradeFlowPanes(tradeFlow, chart.chartProps.seriesStore);
  const markerSource = React.useMemo(
    () => combineExternalMarkerSources([
      tradeFlow.view.markerSource,
      pluginMarkerSource,
      strategyMarkerSource,
    ]),
    [pluginMarkerSource, strategyMarkerSource, tradeFlow.view.markerSource],
  );
  const upstreamDrawingInteractionReadyChange =
    chart.chartProps.onDrawingInteractionReadyChange;
  const handleDrawingInteractionReadyChange = React.useCallback((ready: boolean) => {
    onDrawingInteractionReadyChange?.(ready);
    upstreamDrawingInteractionReadyChange?.(ready);
  }, [onDrawingInteractionReadyChange, upstreamDrawingInteractionReadyChange]);
  const sourceNeutralChartProps = React.useMemo(() => ({
    ...chart.chartProps,
    drawingTool: drawingToolWhenInteractionReady(
      chart.chartProps.drawingTool,
      drawingInteractionReady,
    ),
    onDrawingInteractionReadyChange: handleDrawingInteractionReadyChange,
  }), [
    chart.chartProps,
    drawingInteractionReady,
    handleDrawingInteractionReadyChange,
  ]);
  const supplementalPanes = React.useMemo(
    () => [...tradeFlowPanes, ...advancedPanes],
    [advancedPanes, tradeFlowPanes],
  );
  const markerSources = React.useMemo(
    () => [tradeFlow.view.markerSource, pluginMarkerSource, strategyMarkerSource],
    [pluginMarkerSource, strategyMarkerSource, tradeFlow.view.markerSource],
  );

  if (chart.error) {
    return (
      <div className="chart-area">
        <div className="error-overlay">
          <div className="error-icon">!</div>
          <div className="error-message">
            <strong>{t("chart.dataLoadFailed")}</strong>
            <br />
            {t("chart.dataLoadDetail")}
            <br />
            <small style={{ color: "var(--text-muted)", marginTop: 8, display: "block" }}>
              {t("chart.backendHint")}
            </small>
          </div>
          <button className="retry-btn" onClick={chart.onRetryLoad} id="retry-btn">
            {t("shell.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (source) {
    return (
      <MarketChartSurface
        source={source}
        chartProps={sourceNeutralChartProps}
        markerSources={markerSources}
        chartLayerSource={pluginChartLayerSource}
        supplementalPanes={supplementalPanes}
        errorBoundary={Boundary}
        paused={paused}
      />
    );
  }

  return (
    <Boundary>
      <SingleChartPanes
        {...sourceNeutralChartProps}
        externalMarkerSource={markerSource}
        pluginChartLayerSource={pluginChartLayerSource}
        subPanes={[
          ...supplementalPanes,
          ...(sourceNeutralChartProps.subPanes || []),
        ]}
        suspended={paused}
      />
    </Boundary>
  );
}

export default React.memo(ChartCellCanvas);
