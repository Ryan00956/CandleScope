export type KlineOrderFlowIndicatorId =
  | "trade-flow:cvd"
  | "trade-flow:delta";
export type KlineOrderFlowIndicatorKey = "cvd" | "delta";

export const KLINE_ORDER_FLOW_INDICATOR_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "trade-flow:cvd" as const,
    key: "cvd" as const,
    category: "volume" as const,
    name: "CVD（累计成交量差）",
    description: "基于 K 线主动买卖量构建的连续前缀和；与右侧实时订单流独立。",
  }),
  Object.freeze({
    id: "trade-flow:delta" as const,
    key: "delta" as const,
    category: "volume" as const,
    name: "Volume Delta（成交量差）",
    description: "逐根 K 线展示主动买量、主动卖量及其差值；与右侧实时订单流独立。",
  }),
]);

export function isKlineOrderFlowIndicatorId(
  value: unknown,
): value is KlineOrderFlowIndicatorId {
  return KLINE_ORDER_FLOW_INDICATOR_DEFINITIONS.some(
    (definition) => definition.id === value,
  );
}

export function klineOrderFlowIndicatorKey(
  id: KlineOrderFlowIndicatorId,
): KlineOrderFlowIndicatorKey {
  return id === "trade-flow:cvd" ? "cvd" : "delta";
}
