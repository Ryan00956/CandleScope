import {
  createDrawingCoordinateTransactionContext,
  dataPointToCoordinate,
  resolveSourceLineageSpanToCoordinates,
} from "../../../chart-adapter/coordinateBridge.js";
import type {
  CoordinateChartBridge,
  CoordinateSeriesBridge,
  DrawingCoordinateContext,
} from "../../../chart-adapter/coordinateBridge.js";
import { resolveFreehandStrokePoints } from "../freehandStrokeModel.js";
import type { ResolvedFreehandPoint } from "../drawingTypes.js";

export {
  logicalToCoordinateInterpolated,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";
export { dataPointToCoordinate };

export function freehandStrokeToCoordinates(
  chart: CoordinateChartBridge,
  series: CoordinateSeriesBridge,
  stroke: unknown,
  context: DrawingCoordinateContext | null = null,
): Array<ResolvedFreehandPoint | null> {
  const coordinateContext = createDrawingCoordinateTransactionContext(context);
  return resolveFreehandStrokePoints(stroke, {
    resolveAnchor: (anchor, _index, _point, normalizedStroke) => dataPointToCoordinate(
      chart,
      series,
      {
        ...anchor,
        sourceProjection: normalizedStroke.sourceProjection,
        sourceProjectionConfig: normalizedStroke.sourceProjectionConfig,
      },
      coordinateContext,
    ),
    resolveSpan: (span, _index, normalizedStroke) => resolveSourceLineageSpanToCoordinates(
      chart,
      series,
      {
        ...span,
        sourceProjection: normalizedStroke.sourceProjection,
        sourceProjectionConfig: normalizedStroke.sourceProjectionConfig,
      },
      coordinateContext,
    ),
    resolveTime: (time) => dataPointToCoordinate(
      chart,
      series,
      { time },
      coordinateContext,
    ),
  });
}

// Keep the narrow export for callers compiled against the v2-only bridge.
export const freehandStrokeV2ToCoordinates = freehandStrokeToCoordinates;
