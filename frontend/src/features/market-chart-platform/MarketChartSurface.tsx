import React, { type ComponentType, type PropsWithChildren, type ReactNode } from "react";
import { combineExternalMarkerSources } from "../../chart-adapter/externalMarkerSource.js";
import type { ExternalMarkerSource } from "../../chart-adapter/externalMarkerSource.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import type { SingleChartPanesProps } from "../../components/SingleChartPanes.js";
import type { MarketChartSourceRuntime } from "./marketChartSourceRuntime.js";
import {
  bindMarketChartSurfaceProps,
  type MarketChartSurfaceChartProps,
} from "./marketChartSurfaceModel.js";

function Passthrough({ children }: PropsWithChildren) {
  return <>{children}</>;
}

export interface MarketChartSurfaceProps {
  source: MarketChartSourceRuntime;
  chartProps: MarketChartSurfaceChartProps;
  markerSources?: readonly (ExternalMarkerSource | null | undefined)[];
  chartLayerSource?: SingleChartPanesProps["pluginChartLayerSource"];
  supplementalPanes?: NonNullable<SingleChartPanesProps["subPanes"]>;
  error?: unknown;
  errorFallback?: ReactNode;
  errorBoundary?: ComponentType<PropsWithChildren>;
  paused?: boolean;
}

function MarketChartSurface({
  source,
  chartProps,
  markerSources = [],
  chartLayerSource = null,
  supplementalPanes = [],
  error = null,
  errorFallback = null,
  errorBoundary = Passthrough,
  paused = false,
}: MarketChartSurfaceProps) {
  const Boundary = errorBoundary;
  const markerSource = React.useMemo(
    () => combineExternalMarkerSources(markerSources),
    [markerSources],
  );
  const boundProps = React.useMemo(() => ({
    ...bindMarketChartSurfaceProps({ source, chartProps, supplementalPanes, paused }),
    externalMarkerSource: markerSource,
    pluginChartLayerSource: chartLayerSource,
  }), [
    chartLayerSource,
    chartProps,
    markerSource,
    paused,
    source,
    supplementalPanes,
  ]);

  if (error || source.lifecycle === "DISPOSED") return <>{errorFallback}</>;
  return (
    <Boundary>
      <SingleChartPanes {...boundProps} />
    </Boundary>
  );
}

export default React.memo(MarketChartSurface);
