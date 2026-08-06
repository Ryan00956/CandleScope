import React from "react";
import SingleChartPanes from "../components/SingleChartPanes.js";
import { combineExternalMarkerSources } from "../chart-adapter/externalMarkerSource.js";
import type { ExternalMarkerSource } from "../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayerSource } from "../features/plugins/pluginChartLayerSource.js";
import { useAdvancedMarketPanes } from "../features/advanced-market-data/useAdvancedMarketPanes.js";
import { useTradeFlowPanes } from "../features/trade-flow/useTradeFlowPanes.js";
import type { TradeFlowRuntime } from "../features/trade-flow/tradeFlowTypes.js";
import { ChartErrorBoundary } from "./AppProviders.js";
import { drawingToolWhenInteractionReady } from "./drawingInteractionReadiness.js";
import type { ChartWorkspaceChartModel } from "./ChartWorkspace.js";
import type { ComponentType, PropsWithChildren } from "react";

export interface ChartCellCanvasProps {
  chart: ChartWorkspaceChartModel;
  tradeFlow: TradeFlowRuntime;
  pluginMarkerSource?: ExternalMarkerSource | null;
  pluginChartLayerSource?: PluginChartLayerSource | null;
  errorBoundary?: ComponentType<PropsWithChildren>;
  drawingInteractionReady?: boolean;
  onDrawingInteractionReadyChange?: (ready: boolean) => void;
}

function ChartCellCanvas({
  chart,
  tradeFlow,
  pluginMarkerSource = null,
  pluginChartLayerSource = null,
  errorBoundary = ChartErrorBoundary,
  drawingInteractionReady = false,
  onDrawingInteractionReadyChange,
}: ChartCellCanvasProps) {
  const Boundary = errorBoundary;
  const advancedPanes = useAdvancedMarketPanes(chart.advancedMarketData);
  const tradeFlowPanes = useTradeFlowPanes(tradeFlow, chart.chartProps.seriesStore);
  const markerSource = React.useMemo(
    () => combineExternalMarkerSources([tradeFlow.view.markerSource, pluginMarkerSource]),
    [pluginMarkerSource, tradeFlow.view.markerSource],
  );
  const upstreamDrawingInteractionReadyChange =
    chart.chartProps.onDrawingInteractionReadyChange;
  const handleDrawingInteractionReadyChange = React.useCallback((ready: boolean) => {
    onDrawingInteractionReadyChange?.(ready);
    upstreamDrawingInteractionReadyChange?.(ready);
  }, [onDrawingInteractionReadyChange, upstreamDrawingInteractionReadyChange]);
  const chartProps = React.useMemo(() => ({
    ...chart.chartProps,
    drawingTool: drawingToolWhenInteractionReady(
      chart.chartProps.drawingTool,
      drawingInteractionReady,
    ),
    onDrawingInteractionReadyChange: handleDrawingInteractionReadyChange,
    externalMarkerSource: markerSource,
    pluginChartLayerSource,
    subPanes: [
      ...tradeFlowPanes,
      ...advancedPanes,
      ...(chart.chartProps.subPanes || []),
    ],
  }), [
    advancedPanes,
    chart.chartProps,
    drawingInteractionReady,
    handleDrawingInteractionReadyChange,
    markerSource,
    pluginChartLayerSource,
    tradeFlowPanes,
  ]);

  if (chart.error) {
    return (
      <div className="chart-area">
        <div className="error-overlay">
          <div className="error-icon">!</div>
          <div className="error-message">
            <strong>Data load failed</strong>
            <br />
            {chart.error}
            <br />
            <small style={{ color: "var(--text-muted)", marginTop: 8, display: "block" }}>
              Ensure backend is running: `uvicorn app.main:app --reload`
            </small>
          </div>
          <button className="retry-btn" onClick={chart.onRetryLoad} id="retry-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <Boundary>
      <SingleChartPanes {...chartProps} />
    </Boundary>
  );
}

export default React.memo(ChartCellCanvas);
