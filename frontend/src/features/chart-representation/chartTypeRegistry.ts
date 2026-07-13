export const CHART_AXIS_MODES = Object.freeze({
  TIME: "time",
  DERIVED_ORDINAL: "derived-ordinal",
});

export const CHART_DRAWING_ANCHOR_MODES = Object.freeze({
  SOURCE_TIME: "source-time",
  SOURCE_LINEAGE: "source-lineage",
});

export const CHART_PROJECTION_IDS = Object.freeze({
  IDENTITY: "identity",
  HEIKIN_ASHI: "heikin-ashi",
  RENKO: "renko",
  POINT_AND_FIGURE: "point-and-figure",
  KAGI: "kagi",
  LINE_BREAK: "line-break",
});

export const DEFAULT_CHART_TYPE_DESCRIPTORS = Object.freeze(([
  { id: "candlestick", axisMode: "time", projectionId: "identity", rendererId: "candlestick", drawingAnchorMode: "source-time" },
  { id: "hollow-candlestick", axisMode: "time", projectionId: "identity", rendererId: "candlestick", drawingAnchorMode: "source-time" },
  { id: "heikin-ashi", axisMode: "time", projectionId: "heikin-ashi", rendererId: "candlestick", drawingAnchorMode: "source-time" },
  { id: "bar", axisMode: "time", projectionId: "identity", rendererId: "bar", drawingAnchorMode: "source-time" },
  { id: "high-low", axisMode: "time", projectionId: "identity", rendererId: "high-low", drawingAnchorMode: "source-time" },
  { id: "line", axisMode: "time", projectionId: "identity", rendererId: "line", drawingAnchorMode: "source-time" },
  { id: "line-with-markers", axisMode: "time", projectionId: "identity", rendererId: "line", drawingAnchorMode: "source-time" },
  { id: "step-line", axisMode: "time", projectionId: "identity", rendererId: "line", drawingAnchorMode: "source-time" },
  { id: "area", axisMode: "time", projectionId: "identity", rendererId: "area", drawingAnchorMode: "source-time" },
  { id: "baseline", axisMode: "time", projectionId: "identity", rendererId: "baseline", drawingAnchorMode: "source-time" },
  { id: "histogram", axisMode: "time", projectionId: "identity", rendererId: "histogram", drawingAnchorMode: "source-time" },
  { id: "renko", axisMode: "derived-ordinal", projectionId: "renko", rendererId: "candlestick", drawingAnchorMode: "source-lineage" },
  { id: "point-and-figure", axisMode: "derived-ordinal", projectionId: "point-and-figure", rendererId: "point-and-figure", drawingAnchorMode: "source-lineage" },
  { id: "kagi", axisMode: "derived-ordinal", projectionId: "kagi", rendererId: "kagi", drawingAnchorMode: "source-lineage" },
  { id: "line-break", axisMode: "derived-ordinal", projectionId: "line-break", rendererId: "candlestick", drawingAnchorMode: "source-lineage" },
] satisfies ChartTypeDescriptor[]).map((descriptor) => Object.freeze(descriptor)));

function normalizeDescriptor(descriptor: unknown): Readonly<ChartTypeDescriptor> {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("chart type descriptor must be an object");
  }
  const record = descriptor as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const axisMode = String(record.axisMode || "").trim();
  const projectionId = String(record.projectionId || "").trim();
  const rendererId = String(record.rendererId || "").trim();
  const drawingAnchorMode = record.drawingAnchorMode == null
    ? null
    : String(record.drawingAnchorMode).trim();
  if (!id || !axisMode || !projectionId || !rendererId) {
    throw new TypeError("chart type descriptor requires id, axisMode, projectionId and rendererId");
  }
  if (drawingAnchorMode !== null
    && !Object.values<string>(CHART_DRAWING_ANCHOR_MODES).includes(drawingAnchorMode)) {
    throw new TypeError(`unsupported chart drawing anchor mode: ${drawingAnchorMode}`);
  }
  return Object.freeze({
    ...record,
    id,
    axisMode,
    projectionId,
    rendererId,
    drawingAnchorMode: drawingAnchorMode as ChartDrawingAnchorMode | null,
  } satisfies ChartTypeDescriptor);
}

export class ChartTypeRegistry {
  _descriptors: Map<string, Readonly<ChartTypeDescriptor>>;

  constructor(descriptors: readonly unknown[] = []) {
    this._descriptors = new Map();
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(
    descriptor: unknown,
    { replace = false }: { replace?: boolean } = {},
  ): Readonly<ChartTypeDescriptor> {
    const normalized = normalizeDescriptor(descriptor);
    if (!replace && this._descriptors.has(normalized.id)) {
      throw new Error(`chart type descriptor already registered: ${normalized.id}`);
    }
    this._descriptors.set(normalized.id, normalized);
    return normalized;
  }

  has(id: string): boolean {
    return this._descriptors.has(id);
  }

  get(id: string): Readonly<ChartTypeDescriptor> | null {
    return this._descriptors.get(id) || null;
  }

  require(id: string): Readonly<ChartTypeDescriptor> {
    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`unknown chart type: ${id}`);
    return descriptor;
  }

  list(): Readonly<ChartTypeDescriptor>[] {
    return Array.from(this._descriptors.values());
  }
}

export function createDefaultChartTypeRegistry(): ChartTypeRegistry {
  return new ChartTypeRegistry(DEFAULT_CHART_TYPE_DESCRIPTORS);
}

export const chartTypeRegistry = createDefaultChartTypeRegistry();

export function getChartTypeDescriptor(
  id: string,
  fallbackId = "candlestick",
): Readonly<ChartTypeDescriptor> {
  return chartTypeRegistry.get(id) || chartTypeRegistry.require(fallbackId);
}
import type {
  ChartDrawingAnchorMode,
  ChartTypeDescriptor,
} from "./chartRepresentationTypes.js";
