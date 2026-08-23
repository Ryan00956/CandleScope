import type { MessageKey } from "../../i18n/index.js";

export type KlineOrderFlowIndicatorId =
  | "trade-flow:cvd"
  | "trade-flow:delta";
export type KlineOrderFlowIndicatorKey = "cvd" | "delta";

export const KLINE_ORDER_FLOW_INDICATOR_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "trade-flow:cvd" as const,
    key: "cvd" as const,
    category: "volume" as const,
    nameKey: "study.cvd" as const satisfies MessageKey,
    descriptionKey: "study.cvdDesc" as const satisfies MessageKey,
  }),
  Object.freeze({
    id: "trade-flow:delta" as const,
    key: "delta" as const,
    category: "volume" as const,
    nameKey: "study.delta" as const satisfies MessageKey,
    descriptionKey: "study.deltaDesc" as const satisfies MessageKey,
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
