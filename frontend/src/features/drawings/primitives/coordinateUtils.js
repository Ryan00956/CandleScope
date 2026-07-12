import {
  resolveSourceLineageSpanToCoordinates,
} from "../../../chart-adapter/coordinateBridge.js";
import { resolveFreehandStrokeV2Points } from "../freehandStrokeModel.js";

export {
  dataPointToCoordinate,
  logicalToCoordinateInterpolated,
  timeToCoordinateInterpolated,
} from "../../../chart-adapter/coordinateBridge.js";

export function freehandStrokeV2ToCoordinates(chart, series, stroke, context = null) {
  const coordinateContext = context || {};
  return resolveFreehandStrokeV2Points(
    stroke,
    (span, _index, normalizedStroke) => resolveSourceLineageSpanToCoordinates(
      chart,
      series,
      {
        ...span,
        sourceProjection: normalizedStroke.sourceProjection,
        sourceProjectionConfig: normalizedStroke.sourceProjectionConfig,
      },
      coordinateContext,
    ),
  );
}
