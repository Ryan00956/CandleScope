export const CHART_AXIS_MODES = Object.freeze({
  TIME: "time",
  DERIVED_ORDINAL: "derived-ordinal",
});

export const CHART_PROJECTION_IDS = Object.freeze({
  IDENTITY: "identity",
  HEIKIN_ASHI: "heikin-ashi",
  RENKO: "renko",
  POINT_AND_FIGURE: "point-and-figure",
  KAGI: "kagi",
  LINE_BREAK: "line-break",
});

export const DEFAULT_CHART_TYPE_DESCRIPTORS = Object.freeze([
  { id: "candlestick", axisMode: "time", projectionId: "identity", rendererId: "candlestick" },
  { id: "hollow-candlestick", axisMode: "time", projectionId: "identity", rendererId: "candlestick" },
  { id: "heikin-ashi", axisMode: "time", projectionId: "heikin-ashi", rendererId: "candlestick" },
  { id: "bar", axisMode: "time", projectionId: "identity", rendererId: "bar" },
  { id: "high-low", axisMode: "time", projectionId: "identity", rendererId: "high-low" },
  { id: "line", axisMode: "time", projectionId: "identity", rendererId: "line" },
  { id: "line-with-markers", axisMode: "time", projectionId: "identity", rendererId: "line" },
  { id: "step-line", axisMode: "time", projectionId: "identity", rendererId: "line" },
  { id: "area", axisMode: "time", projectionId: "identity", rendererId: "area" },
  { id: "baseline", axisMode: "time", projectionId: "identity", rendererId: "baseline" },
  { id: "histogram", axisMode: "time", projectionId: "identity", rendererId: "histogram" },
  { id: "renko", axisMode: "derived-ordinal", projectionId: "renko", rendererId: "candlestick" },
  { id: "point-and-figure", axisMode: "derived-ordinal", projectionId: "point-and-figure", rendererId: "point-and-figure" },
  { id: "kagi", axisMode: "derived-ordinal", projectionId: "kagi", rendererId: "kagi" },
  { id: "line-break", axisMode: "derived-ordinal", projectionId: "line-break", rendererId: "candlestick" },
].map((descriptor) => Object.freeze(descriptor)));

function normalizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("chart type descriptor must be an object");
  }
  const id = String(descriptor.id || "").trim();
  const axisMode = String(descriptor.axisMode || "").trim();
  const projectionId = String(descriptor.projectionId || "").trim();
  const rendererId = String(descriptor.rendererId || "").trim();
  if (!id || !axisMode || !projectionId || !rendererId) {
    throw new TypeError("chart type descriptor requires id, axisMode, projectionId and rendererId");
  }
  return Object.freeze({ ...descriptor, id, axisMode, projectionId, rendererId });
}

export class ChartTypeRegistry {
  constructor(descriptors = []) {
    this._descriptors = new Map();
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor, { replace = false } = {}) {
    const normalized = normalizeDescriptor(descriptor);
    if (!replace && this._descriptors.has(normalized.id)) {
      throw new Error(`chart type descriptor already registered: ${normalized.id}`);
    }
    this._descriptors.set(normalized.id, normalized);
    return normalized;
  }

  has(id) {
    return this._descriptors.has(id);
  }

  get(id) {
    return this._descriptors.get(id) || null;
  }

  require(id) {
    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`unknown chart type: ${id}`);
    return descriptor;
  }

  list() {
    return Array.from(this._descriptors.values());
  }
}

export function createDefaultChartTypeRegistry() {
  return new ChartTypeRegistry(DEFAULT_CHART_TYPE_DESCRIPTORS);
}

export const chartTypeRegistry = createDefaultChartTypeRegistry();

export function getChartTypeDescriptor(id, fallbackId = "candlestick") {
  return chartTypeRegistry.get(id) || chartTypeRegistry.require(fallbackId);
}
