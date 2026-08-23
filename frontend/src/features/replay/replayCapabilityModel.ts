import { t } from "../../i18n/index.js";
import type { ReplayHistoricalBookProjection } from "./replayV2Types.js";

export type ReplayCapabilityState =
  | "AVAILABLE_EXACT"
  | "AVAILABLE_APPROX"
  | "UNSUPPORTED_NO_HISTORY"
  | "UNSUPPORTED_SOURCE_MODE"
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

export function buildReplayCapabilityModel(
  sourceKind: "BAR" | "AGG_TRADE" | "bar" | "agg_trade",
  historicalBook: ReplayHistoricalBookProjection | null = null,
): ReplayCapabilityModel {
  const tape = sourceKind === "AGG_TRADE" || sourceKind === "agg_trade";
  const orderBook = historicalBook?.status === "READY"
    ? item(
      "Order book",
      "AVAILABLE_EXACT",
      t("replay.cap.bookExact"),
      "EXACT_L2",
    )
    : historicalBook !== null && historicalBook.status !== "OFF"
      ? item(
        "Order book",
        "DEGRADED",
        t("replay.cap.bookDegraded"),
      )
      : item("Order book", "UNSUPPORTED_NO_HISTORY", t("replay.cap.bookNone"));
  return {
    OHLCV: item(
      "OHLCV",
      tape ? "AVAILABLE_APPROX" : "AVAILABLE_EXACT",
      tape
        ? t("replay.cap.ohlcvTape")
        : t("replay.cap.ohlcvBar"),
      tape ? "APPROX_AGGREGATE" : "EXACT",
    ),
    INDICATORS: item(
      "Local indicators",
      tape ? "AVAILABLE_APPROX" : "AVAILABLE_EXACT",
      tape ? t("replay.cap.indTape") : t("replay.cap.indBar"),
      tape ? "LOCAL_APPROX_BARS" : "LOCAL",
    ),
    SIMULATED_LIQUIDATION: item("Paper liquidation", "AVAILABLE_APPROX", t("replay.cap.simLiq"), "APPROX"),
    AGG_TRADE_TAPE: tape
      ? item("Agg trade tape", "AVAILABLE_EXACT", t("replay.cap.tapeExact"), "EXACT_AGGREGATE")
      : item("Agg trade tape", "UNSUPPORTED_SOURCE_MODE", t("replay.cap.tapeNone")),
    ORDER_FLOW: tape
      ? item("Order flow", "AVAILABLE_APPROX", t("replay.cap.flowTape"), "APPROX_AGGRESSOR")
      : item(
        "Order flow",
        "AVAILABLE_APPROX",
        t("replay.cap.flowBar"),
        "KLINE_TAKER_PROXY",
      ),
    OPEN_INTEREST: item("Open interest", "UNSUPPORTED_NO_HISTORY", t("replay.cap.oi")),
    MARK_PRICE: item("Mark", "UNSUPPORTED_NO_HISTORY", t("replay.cap.mark")),
    INDEX_PRICE: item("Index", "UNSUPPORTED_NO_HISTORY", t("replay.cap.index")),
    BASIS: item("Basis", "UNSUPPORTED_NO_HISTORY", t("replay.cap.basis")),
    FUNDING: item("Funding", "UNSUPPORTED_NO_HISTORY", t("replay.cap.funding")),
    MARKET_LIQUIDATION: item("Market liquidations", "UNSUPPORTED_NO_HISTORY", t("replay.cap.mktLiq")),
    ORDER_BOOK: orderBook,
    HOSTED_INDICATORS: item("Hosted indicators", "UNSUPPORTED_NO_PROVIDER", t("replay.cap.hosted")),
    ALERTS: item("Alerts", "UNSUPPORTED_NO_PROVIDER", t("replay.cap.alerts")),
  };
}
