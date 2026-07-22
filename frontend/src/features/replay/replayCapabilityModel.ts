export type ReplayCapabilityState =
  | "AVAILABLE_EXACT"
  | "AVAILABLE_APPROX"
  | "UNSUPPORTED_NO_HISTORY"
  | "UNSUPPORTED_SOURCE"
  | "UNSUPPORTED_NO_PROVIDER"
  | "LOADING"
  | "DEGRADED";

export type ReplayCapabilityId =
  | "OHLCV"
  | "INDICATORS"
  | "SIMULATED_LIQUIDATION"
  | "AGG_TRADE_TAPE"
  | "ORDER_FLOW"
  | "OPEN_INTEREST"
  | "MARK_PRICE"
  | "INDEX_PRICE"
  | "BASIS"
  | "FUNDING"
  | "MARKET_LIQUIDATION"
  | "ORDER_BOOK"
  | "HOSTED_INDICATORS"
  | "ALERTS";

export interface ReplayCapabilityItem {
  readonly label: string;
  readonly state: ReplayCapabilityState;
  readonly value: string;
  readonly detail: string;
}

export type ReplayCapabilityModel = Readonly<Record<ReplayCapabilityId, ReplayCapabilityItem>>;

function item(
  label: string,
  state: ReplayCapabilityState,
  detail: string,
  value = "--",
): ReplayCapabilityItem {
  return { label, state, value, detail };
}

export function buildReplayCapabilityModel(sourceKind: "BAR" | "AGG_TRADE" | "bar" | "agg_trade"): ReplayCapabilityModel {
  const tape = sourceKind === "AGG_TRADE" || sourceKind === "agg_trade";
  return {
    OHLCV: item("OHLCV", "AVAILABLE_EXACT", "冻结快照；仅已揭示前缀", "EXACT"),
    INDICATORS: item("Local indicators", "AVAILABLE_EXACT", "仅以已揭示 bars 本地计算", "LOCAL"),
    SIMULATED_LIQUIDATION: item("Paper liquidation", "AVAILABLE_APPROX", "训练经纪商合成结果", "APPROX"),
    AGG_TRADE_TAPE: tape
      ? item("Agg trade tape", "AVAILABLE_EXACT", "冻结逐笔归档", "EXACT")
      : item("Agg trade tape", "UNSUPPORTED_SOURCE", "BAR run 不含逐笔源"),
    ORDER_FLOW: tape
      ? item("Order flow", "AVAILABLE_APPROX", "由已揭示逐笔聚合", "APPROX")
      : item("Order flow", "UNSUPPORTED_SOURCE", "BAR run 无法精确重建主动方向"),
    OPEN_INTEREST: item("Open interest", "UNSUPPORTED_NO_HISTORY", "冻结 run 未绑定 OI 历史"),
    MARK_PRICE: item("Mark", "UNSUPPORTED_NO_HISTORY", "冻结 run 未绑定 mark 历史"),
    INDEX_PRICE: item("Index", "UNSUPPORTED_NO_HISTORY", "冻结 run 未绑定 index 历史"),
    BASIS: item("Basis", "UNSUPPORTED_NO_HISTORY", "缺少 mark/index 同步历史"),
    FUNDING: item("Funding", "UNSUPPORTED_NO_HISTORY", "未绑定交易所历史 funding/mark；Sandbox 固定资金费只属于近似账户模拟"),
    MARKET_LIQUIDATION: item("Market liquidations", "UNSUPPORTED_NO_HISTORY", "未绑定市场爆仓归档"),
    ORDER_BOOK: item("Order book", "UNSUPPORTED_NO_HISTORY", "未绑定历史盘口快照与增量"),
    HOSTED_INDICATORS: item("Hosted indicators", "UNSUPPORTED_NO_PROVIDER", "range/security provider 未启用"),
    ALERTS: item("Alerts", "UNSUPPORTED_NO_PROVIDER", "回放告警 provider 未启用"),
  };
}
