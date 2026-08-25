import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../../../i18n/index.js";
import { getLocale } from "../../../i18n/locale.js";
import { useLocale } from "../../../i18n/useLocale.js";

import {
  formatReplayPublicTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayOwnsController,
} from "../replayUiModel.js";
import { defaultReplayV2Api, ReplayV2ApiError } from "../replayV2Api.js";
import {
  rebaseReplayMaxQuantity,
  replayOrderContextSide,
  replayOrderSizingAvailability,
  replayReduceOnlyUnavailableMessage,
} from "../replayOrderSizing.js";
import { replayOrderCtaState } from "../replayOrderCtaState.js";
import { createReplayOrderAdvisoryScheduler } from "../replayOrderAdvisoryScheduler.js";
import {
  replayMarkFidelityLabel,
  replayPositiveModelPrice,
} from "../replayPositionHlines.js";
import type { ReplayClosedTrade } from "../replayTypes.js";
import type {
  ReplayOrderPreview,
  ReplayOrderCapacity,
  ReplayOrderCapacityContext,
  ReplayOrderRequest,
  ReplayTradePlanDraft,
  ReplayAccountOrderScope,
  ReplayAccountRecordType,
  ReplayTrainingContractPortfolio,
  ReplayV2Json,
} from "../replayV2Types.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import { useReplayTradeFlow } from "../useReplayTradeFlow.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";
import ReplayLiquidationTimeline from "./ReplayLiquidationTimeline.js";

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const REPLAY_ORDER_VALIDATION_TIMEOUT_MS = 15_000;
const WORKBENCH_TAB_IDS = [
  "positions",
  "open-orders",
  "order-history",
  "fills",
  "assets",
  "risk",
] as const;
const MARKET_TAB_IDS = [
  "book",
  "flow",
  "indicators",
] as const;

type WorkbenchTab = typeof WORKBENCH_TAB_IDS[number];
type MarketTab = typeof MARKET_TAB_IDS[number];

function workbenchTabLabel(id: WorkbenchTab): string {
  switch (id) {
    case "positions": return t("replay.wb.positions");
    case "open-orders": return t("replay.wb.openOrders");
    case "order-history": return t("replay.wb.orderHistory");
    case "fills": return t("replay.wb.fills");
    case "assets": return t("replay.wb.assets");
    case "risk": return t("replay.wb.risk");
  }
}

function marketTabLabel(id: MarketTab): string {
  switch (id) {
    case "book": return t("replay.dock.book");
    case "flow": return t("replay.dock.flow");
    case "indicators": return t("replay.dock.indicators");
  }
}
type JsonRecord = Readonly<Record<string, ReplayV2Json>>;
type TradeType =
  | "place_order"
  | "replace_order"
  | "cancel_order"
  | "cancel_orders"
  | "close_position"
  | "execute_position_intent"
  | "set_position_protection"
  | "set_position_leverage";
type TradeNotice = Readonly<{
  tone: "pending" | "success" | "error";
  message: string;
}> | null;

interface AccountRecordPageState {
  readonly key: string;
  readonly items: readonly JsonRecord[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
}

function useAccountRecordPages({
  runId,
  recordType,
  orderScope,
  enabled,
  revision,
}: {
  readonly runId: string | null;
  readonly recordType: ReplayAccountRecordType;
  readonly orderScope: ReplayAccountOrderScope;
  readonly enabled: boolean;
  readonly revision: number;
}) {
  const key = `${runId ?? "none"}:${recordType}:${orderScope}:${revision}`;
  const [state, setState] = useState<AccountRecordPageState>({
    key,
    items: [],
    totalCount: 0,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
  });
  useEffect(() => {
    if (!enabled || runId === null) return undefined;
    const controller = new AbortController();
    setState({
      key,
      items: [],
      totalCount: 0,
      nextCursor: null,
      loading: true,
      loadingMore: false,
      error: null,
    });
    void defaultReplayV2Api.accountRecordsRun(runId, {
      recordType,
      orderScope,
      limit: 50,
    }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setState({
        key,
        items: page.items,
        totalCount: page.total_count,
        nextCursor: page.next_cursor,
        loading: false,
        loadingMore: false,
        error: null,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        key,
        items: [],
        totalCount: 0,
        nextCursor: null,
        loading: false,
        loadingMore: false,
        error: commandErrorMessage(error),
      });
    });
    return () => controller.abort();
  }, [enabled, key, orderScope, recordType, runId]);
  const loadMore = useCallback(async (): Promise<void> => {
    if (runId === null || state.key !== key || state.nextCursor === null
      || state.loading || state.loadingMore) return;
    const cursor = state.nextCursor;
    setState((current) => current.key === key
      ? { ...current, loadingMore: true, error: null }
      : current);
    try {
      const page = await defaultReplayV2Api.accountRecordsRun(runId, {
        recordType,
        orderScope,
        cursor,
        limit: 50,
      });
      setState((current) => current.key === key && current.nextCursor === cursor
        ? {
            ...current,
            items: [...current.items, ...page.items],
            totalCount: page.total_count,
            nextCursor: page.next_cursor,
            loadingMore: false,
          }
        : current);
    } catch (error) {
      setState((current) => current.key === key
        ? { ...current, loadingMore: false, error: commandErrorMessage(error) }
        : current);
    }
  }, [key, orderScope, recordType, runId, state]);
  const visible = state.key === key ? state : {
    key,
    items: [],
    totalCount: 0,
    nextCursor: null,
    loading: enabled && runId !== null,
    loadingMore: false,
    error: null,
  };
  return { ...visible, loadMore };
}

function orderTypeLabel(value: string): string {
  switch (value) {
    case "MARKET": return t("replay.paper.typeMarket");
    case "LIMIT": return t("replay.paper.typeLimit");
    case "STOP_MARKET": return t("replay.paper.stopMkt");
    case "TAKE_PROFIT_MARKET": return t("replay.paper.tpMkt");
    default: return value;
  }
}

function orderStatusLabel(value: string): string {
  switch (value) {
    case "OPEN": return t("replay.paper.statusOpen");
    case "ACCEPTED": return t("replay.paper.statusAccepted");
    case "PARTIALLY_FILLED": return t("replay.paper.statusPartial");
    case "FILLED": return t("replay.paper.statusFilled");
    case "CANCELED": return t("replay.paper.statusCanceled");
    case "REJECTED": return t("replay.paper.statusRejected");
    case "EXPIRED": return t("replay.paper.statusExpired");
    default: return value;
  }
}

function orderClientId(): string {
  return `ticket-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.trunc(Math.random() * 1_000_000)}`}`;
}

function jsonRecord(value: ReplayV2Json | undefined): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function recordText(record: JsonRecord, key: string, fallback = "--"): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function recordBoolean(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

function recordNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function contractPortfolio(value: unknown): ReplayTrainingContractPortfolio | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly schema_version?: unknown };
  return candidate.schema_version === "replay.training.portfolio.v2"
    ? value as ReplayTrainingContractPortfolio
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDecimal(value: unknown, maximumFractionDigits = 8): string {
  if (value === null || value === undefined || value === "") return "--";
  const parsed = finiteNumber(value);
  if (parsed === null) return String(value);
  return new Intl.NumberFormat(getLocale() === "en" ? "en-US" : "zh-CN", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(parsed);
}

function decimalPlaces(step: string): number {
  const normalized = step.toLowerCase();
  if (normalized.includes("e-")) return Number(normalized.split("e-")[1] ?? 0);
  return normalized.includes(".") ? normalized.replace(/0+$/, "").split(".")[1]?.length ?? 0 : 0;
}

function quantityForStep(value: number, stepText: string): string {
  const step = finiteNumber(stepText) ?? 0;
  const digits = Math.min(12, decimalPlaces(stepText));
  const floored = step > 0 ? Math.floor((value + step * 1e-8) / step) * step : value;
  return floored.toFixed(digits).replace(/\.?0+$/, "") || "0";
}

function sideLabel(value: string): string {
  return value === "BUY" ? t("replay.paper.buy") : value === "SELL" ? t("replay.paper.sell") : value;
}

function baseAsset(symbol: string, settlementAsset: string): string {
  return settlementAsset && symbol.endsWith(settlementAsset)
    ? symbol.slice(0, -settlementAsset.length)
    : symbol;
}

function selectedRule(
  contract: ReplayTrainingContractPortfolio | null,
  trackId: string,
): JsonRecord | null {
  const entry = contract?.instrument_rules.find((item) => recordText(item, "track_id") === trackId);
  return entry === undefined ? null : jsonRecord(entry.rule);
}

function orderPrice(order: JsonRecord): string {
  return recordText(
    order,
    "average_fill_price",
    recordText(order, "limit_price", recordText(order, "stop_price", t("replay.paper.typeMarket"))),
  );
}

function eventTime(record: JsonRecord): number | null {
  return recordNumber(record, "event_time_ms") ?? recordNumber(record, "created_time_ms");
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof ReplayV2ApiError) {
    if (error.code === "RUN_ACCOUNT_MARGIN_EXCEEDED") {
      const available = finiteNumber(error.details.available_equity);
      return available === null
        ? t("replay.paper.marginExceeded")
        : t("replay.paper.marginAvail", { available: formatDecimal(available, 4) });
    }
    if (error.code === "RISK_LIMIT_EXCEEDED") return t("replay.paper.riskLimit", { message: error.message });
    if (error.code === "ORDER_REJECTED") return t("replay.paper.rejected", { message: error.message });
  }
  return error instanceof Error ? error.message : t("replay.paper.submitFailed");
}

function useTradeNoticeAutoDismiss(
  notice: TradeNotice,
  setNotice: (value: TradeNotice) => void,
) {
  useEffect(() => {
    if (notice === null || notice.tone === "pending") return undefined;
    const timer = globalThis.setTimeout(() => setNotice(null), 4_000);
    return () => globalThis.clearTimeout(timer);
  }, [notice, setNotice]);
}

function handleTabKeyDown<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  tabs: readonly T[],
  current: T,
  setCurrent: (value: T) => void,
  attribute: string,
) {
  const currentIndex = tabs.indexOf(current);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const next = tabs[nextIndex];
  if (next === undefined) return;
  setCurrent(next);
  event.currentTarget
    .closest('[role="tablist"]')
    ?.querySelector<HTMLButtonElement>(`[${attribute}="${next}"]`)
    ?.focus();
}

export interface ReplayRightRailProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
  readonly indicatorStatus: {
    readonly mode: string;
    readonly sourceBarCount: number;
    readonly disabledCapabilities: readonly string[];
  };
  readonly formatTime?: (valueMs: number) => string;
}

export function ReplayPaperTradingDock({ runtime, viewer }: ReplayRightRailProps) {
  useLocale();
  type SizeMode = "QUANTITY" | "MARGIN" | "NOTIONAL";
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET">("MARKET");
  const [sizeMode, setSizeMode] = useState<SizeMode>("QUANTITY");
  const [sizeInput, setSizeInput] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [sliderDragging, setSliderDragging] = useState(false);
  const [sliderPct, setSliderPct] = useState(0);
  const [sizeShareIntent, setSizeShareIntent] = useState<number | null>(null);
  const [tradePlanEnabled, setTradePlanEnabled] = useState(false);
  const [riskSizingMode, setRiskSizingMode] = useState<"RISK_AMOUNT" | "ACCOUNT_RISK_PERCENT">(
    "ACCOUNT_RISK_PERCENT",
  );
  const [riskValue, setRiskValue] = useState("1");
  const [invalidationPrice, setInvalidationPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [tradeReason, setTradeReason] = useState("");
  const [clientOrderId, setClientOrderId] = useState(orderClientId);
  const [previewState, setPreviewState] = useState<Readonly<{
    key: string;
    status: "pending" | "ready" | "error";
    result: ReplayOrderPreview | null;
    error: string | null;
  }> | null>(null);
  const [capacityState, setCapacityState] = useState<Readonly<{
    key: string;
    status: "pending" | "ready" | "error";
    result: ReplayOrderCapacity | null;
    error: string | null;
  }> | null>(null);
  const [maxQuantitySnapshot, setMaxQuantitySnapshot] = useState<Readonly<{
    key: string;
    sizingKey: string;
    value: string;
    referencePrice: number | null;
    availableEquity: number | null;
    leverage: number;
  }> | null>(null);
  const [notice, setNotice] = useState<TradeNotice>(null);
  const [tradeValidationSide, setTradeValidationSide] = useState<"BUY" | "SELL" | null>(null);
  const tradeValidationControllerRef = useRef<AbortController | null>(null);
  const tradeValidationMountedRef = useRef(true);
  const capacityAdvisoryControllerRef = useRef<AbortController | null>(null);
  const previewAdvisoryControllerRef = useRef<AbortController | null>(null);
  const capacityScheduler = useMemo(createReplayOrderAdvisoryScheduler, []);
  const previewScheduler = useMemo(createReplayOrderAdvisoryScheduler, []);
  useEffect(() => {
    tradeValidationMountedRef.current = true;
    return () => {
      tradeValidationMountedRef.current = false;
      capacityScheduler.cancel();
      previewScheduler.cancel();
      capacityAdvisoryControllerRef.current?.abort();
      previewAdvisoryControllerRef.current?.abort();
      tradeValidationControllerRef.current?.abort();
      capacityAdvisoryControllerRef.current = null;
      previewAdvisoryControllerRef.current = null;
      tradeValidationControllerRef.current = null;
    };
  }, [capacityScheduler, previewScheduler]);
  useTradeNoticeAutoDismiss(notice, setNotice);
  const store = runtime.store;
  const viewerReady = viewer.viewerState !== null;
  const config = store.sessionConfig;
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const commandAvailable = ownsController
    && store.connectionState === "connected"
    && store.state !== "ENDED";
  const commandReady = commandAvailable
    && runtime.pendingCommand === null
    && !viewer.viewerPending;
  const portfolio = viewer.marketTracks?.portfolio ?? null;
  const contract = contractPortfolio(portfolio);
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? "track-1";
  const selectedTrack = viewer.marketTracks?.tracks.find((item) => item.track_id === selectedTrackId) ?? null;
  const settlementAsset = selectedTrack?.settlement_asset ?? store.account?.quote_asset ?? "";
  const symbol = selectedTrack?.symbol ?? config?.symbol ?? "--";
  const quantityAsset = baseAsset(symbol, settlementAsset);
  const rule = selectedRule(contract, selectedTrackId);
  const positionMode = portfolio?.position_mode ?? "ONE_WAY";
  const activePositionSide: "LONG" | "SHORT" = reduceOnly
    ? side === "BUY" ? "SHORT" : "LONG"
    : side === "BUY" ? "LONG" : "SHORT";
  const selectedPosition = portfolio?.positions.find((item) => (
    item.track_id === selectedTrackId
    && (positionMode !== "HEDGE" || item.position_side === activePositionSide)
  )) ?? null;
  const positionQty = finiteNumber(selectedPosition?.position.quantity) ?? 0;
  const reduceOnlyUnavailableMessage = replayReduceOnlyUnavailableMessage({
    reduceOnly,
    positionQuantity: positionQty,
    positionMode,
    targetPositionSide: activePositionSide,
  });
  const previewSide = replayOrderContextSide(positionQty, side, reduceOnly);
  const maxLeverage = Math.max(1, finiteNumber(config?.max_leverage) ?? 1);
  const [selectedLeverage, setLeverage] = useState(maxLeverage);
  const leverage = Math.min(Math.max(1, selectedLeverage), maxLeverage);
  const quantityStep = recordText(rule ?? {}, "quantity_step", "0.00000001");
  const quoteStep = recordText(rule ?? {}, "quote_step", "0.01");
  const markPrice = useMemo(() => {
    const fromTrack = finiteNumber(selectedTrack?.public_price);
    if (fromTrack !== null && fromTrack > 0) return fromTrack;
    const pos = portfolio?.positions.find((item) => item.track_id === selectedTrackId);
    const fromPos = finiteNumber(pos?.position.mark_price);
    return fromPos !== null && fromPos > 0 ? fromPos : null;
  }, [portfolio?.positions, selectedTrack?.public_price, selectedTrackId]);
  const referencePrice = useMemo(() => {
    if (orderType === "LIMIT" || orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET") {
      return finiteNumber(price);
    }
    return markPrice;
  }, [markPrice, orderType, price]);
  const sizingAvailableEquity = finiteNumber(
    contract?.margin_mode === "ISOLATED"
      ? recordText(selectedTrack?.account ?? {}, "available_equity", "")
      : portfolio?.available_equity,
  );
  const maxQuantitySizingKey = JSON.stringify([
    selectedTrackId,
    previewSide,
    orderType,
    reduceOnly,
    reduceOnly ? positionQty : null,
  ]);
  const rebasedMaxQuantity = maxQuantitySnapshot?.sizingKey === maxQuantitySizingKey
    ? rebaseReplayMaxQuantity({
      previousMaxQuantity: finiteNumber(maxQuantitySnapshot.value),
      previousReferencePrice: maxQuantitySnapshot.referencePrice,
      nextReferencePrice: referencePrice,
      previousAvailableEquity: maxQuantitySnapshot.availableEquity,
      nextAvailableEquity: sizingAvailableEquity,
      previousLeverage: maxQuantitySnapshot.leverage,
      nextLeverage: leverage,
      reduceOnly,
    })
    : null;
  const intendedMaxSizeValue = (() => {
    if (rebasedMaxQuantity === null || rebasedMaxQuantity <= 0) return null;
    if (sizeMode === "QUANTITY") return rebasedMaxQuantity;
    if (referencePrice === null || referencePrice <= 0) return null;
    if (sizeMode === "NOTIONAL") return rebasedMaxQuantity * referencePrice;
    return (rebasedMaxQuantity * referencePrice) / Math.max(1, leverage);
  })();
  const resolvedSizeInput = sizeShareIntent !== null && intendedMaxSizeValue !== null
    ? quantityForStep(
      intendedMaxSizeValue * sizeShareIntent,
      sizeMode === "QUANTITY" ? quantityStep : quoteStep,
    )
    : sizeInput;
  const quantity = (() => {
    const input = finiteNumber(resolvedSizeInput);
    if (input === null || input <= 0) return "";
    if (sizeMode === "QUANTITY") return quantityForStep(input, quantityStep);
    if (referencePrice === null || referencePrice <= 0) return "";
    if (sizeMode === "NOTIONAL") return quantityForStep(input / referencePrice, quantityStep);
    return quantityForStep((input * leverage) / referencePrice, quantityStep);
  })();
  const tradePlanEligible = !reduceOnly && (orderType === "MARKET" || orderType === "LIMIT");
  const tradePlanDraft = useMemo<ReplayTradePlanDraft | null>(() => (
    tradePlanEnabled && tradePlanEligible
      ? {
        sizing_mode: riskSizingMode,
        risk_amount: riskSizingMode === "RISK_AMOUNT" ? riskValue : null,
        risk_percent: riskSizingMode === "ACCOUNT_RISK_PERCENT" ? riskValue : null,
        invalidation_price: invalidationPrice,
        target_price: targetPrice,
        reason: tradeReason,
      }
      : null
  ), [
    invalidationPrice,
    riskSizingMode,
    riskValue,
    targetPrice,
    tradePlanEligible,
    tradePlanEnabled,
    tradeReason,
  ]);
  const previewOrder = viewer.actions.previewOrder;
  const orderCapacity = viewer.actions.orderCapacity;
  const previewPositionIntent = orderType === "MARKET" && !reduceOnly ? "OPEN" : "NET";
  const cursorReady = store.virtualTimeMs !== null;
  const cursorAdvisoryEpoch = JSON.stringify([
    store.revision,
    store.sourceSequence,
    store.virtualTimeMs,
  ]);
  const previewKey = JSON.stringify([
    selectedTrackId,
    previewPositionIntent,
    clientOrderId,
    previewSide,
    orderType,
    sizeMode,
    sizeInput,
    sizeShareIntent,
    reduceOnly,
    price,
    leverage,
    tradePlanDraft,
  ]);
  const maxQuantityContextKey = JSON.stringify([
    selectedTrackId,
    previewSide,
    orderType,
    reduceOnly,
    price,
    leverage,
  ]);
  useEffect(() => {
    if (
      !viewerReady
      || store.connectionState !== "connected"
      || store.state !== "PAUSED"
      || !cursorReady
      || tradeValidationSide !== null
      || reduceOnlyUnavailableMessage !== null
      || (orderType !== "MARKET" && !price.trim())
    ) {
      return undefined;
    }
    capacityAdvisoryControllerRef.current?.abort();
    const controller = new AbortController();
    capacityAdvisoryControllerRef.current = controller;
    let settled = false;
    const scheduled = capacityScheduler.schedule(maxQuantityContextKey, () => {
      const context: ReplayOrderCapacityContext = {
        side: previewSide,
        order_type: orderType,
        reduce_only: reduceOnly,
        limit_price: orderType === "LIMIT" ? price : null,
        stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET"
          ? price
          : null,
        leverage: String(leverage),
        ...(positionMode === "HEDGE" ? { position_side: activePositionSide } : {}),
      };
      setCapacityState({
        key: maxQuantityContextKey,
        status: "pending",
        result: null,
        error: null,
      });
      void orderCapacity(
        context,
        previewPositionIntent,
        controller.signal,
      ).then((result) => {
        if (controller.signal.aborted) return;
        setMaxQuantitySnapshot({
          key: maxQuantityContextKey,
          sizingKey: maxQuantitySizingKey,
          value: result.max_quantity,
          referencePrice: finiteNumber(result.reference_price),
          availableEquity: sizingAvailableEquity,
          leverage,
        });
        setCapacityState({
          key: maxQuantityContextKey,
          status: "ready",
          result,
          error: null,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCapacityState({
          key: maxQuantityContextKey,
          status: "error",
          result: null,
          error: commandErrorMessage(error),
        });
      }).finally(() => {
        settled = true;
        if (capacityAdvisoryControllerRef.current === controller) {
          capacityAdvisoryControllerRef.current = null;
        }
      });
    });
    return () => {
      capacityScheduler.cancel();
      controller.abort();
      if (capacityAdvisoryControllerRef.current === controller) {
        capacityAdvisoryControllerRef.current = null;
      }
      if (scheduled && !settled) capacityScheduler.forget(maxQuantityContextKey);
    };
  // Cursor-driven equity is deliberately sampled only when this draft context
  // changes. The cached cap is conservatively rebased between those requests.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    capacityScheduler,
    cursorReady,
    leverage,
    maxQuantityContextKey,
    maxQuantitySizingKey,
    orderCapacity,
    orderType,
    positionMode,
    activePositionSide,
    previewSide,
    previewPositionIntent,
    price,
    reduceOnly,
    reduceOnlyUnavailableMessage,
    store.connectionState,
    store.state,
    tradeValidationSide,
    viewerReady,
  ]);
  const currentCapacityState = capacityState?.key === maxQuantityContextKey
    ? capacityState
    : null;
  const capacity = currentCapacityState?.status === "ready"
    ? currentCapacityState.result
    : null;
  const capacityPending = currentCapacityState?.status === "pending";
  const capacityError = currentCapacityState?.status === "error"
    ? currentCapacityState.error
    : null;
  const capacityReadyKey = currentCapacityState?.status === "ready"
    ? currentCapacityState.key
    : null;
  const estimatedMaxQuantity = rebasedMaxQuantity !== null
    ? quantityForStep(rebasedMaxQuantity, quantityStep)
    : capacity?.max_quantity
      ?? (maxQuantitySnapshot?.key === maxQuantityContextKey
        ? maxQuantitySnapshot.value
        : null);
  const sizingAvailability = replayOrderSizingAvailability(estimatedMaxQuantity, quantity);
  const quantityExceedsCapacity = sizingAvailability.quantityExceedsCapacity;
  useEffect(() => {
    // A server preview describes one exact replay boundary. Keep the
    // conservative, locally rebased capacity estimate, but never display a
    // stale fill/margin preview after the cursor moves. Editing the draft will
    // request a new advisory; submission always revalidates the exact cursor.
    setPreviewState((current) => current === null ? current : null);
  }, [cursorAdvisoryEpoch]);
  useEffect(() => {
    if (
      !viewerReady
      || store.connectionState !== "connected"
      || store.state !== "PAUSED"
      || !cursorReady
      || tradeValidationSide !== null
      || capacityReadyKey !== maxQuantityContextKey
      || !quantity.trim()
      || quantityExceedsCapacity
      || (orderType !== "MARKET" && !price.trim())
      || (tradePlanDraft !== null && (
        !riskValue.trim()
        || !invalidationPrice.trim()
        || !targetPrice.trim()
        || !tradeReason.trim()
      ))
    ) {
      return undefined;
    }
    previewAdvisoryControllerRef.current?.abort();
    const controller = new AbortController();
    previewAdvisoryControllerRef.current = controller;
    let settled = false;
    const scheduled = previewScheduler.schedule(previewKey, () => {
      const previewDraftOrder: ReplayOrderRequest = {
        client_order_id: clientOrderId,
        side: previewSide,
        order_type: orderType,
        quantity: quantity.trim() || "0",
        reduce_only: reduceOnly,
        limit_price: orderType === "LIMIT" ? price : null,
        stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET"
          ? price
          : null,
        leverage: String(leverage),
        ...(positionMode === "HEDGE" ? { position_side: activePositionSide } : {}),
      };
      setPreviewState({
        key: previewKey,
        status: "pending",
        result: null,
        error: null,
      });
      void previewOrder(
        previewDraftOrder,
        previewPositionIntent,
        tradePlanDraft,
        controller.signal,
      ).then((result) => {
        if (controller.signal.aborted) return;
        setPreviewState({
          key: previewKey,
          status: "ready",
          result,
          error: null,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewState({
          key: previewKey,
          status: "error",
          result: null,
          error: commandErrorMessage(error),
        });
      }).finally(() => {
        settled = true;
        if (previewAdvisoryControllerRef.current === controller) {
          previewAdvisoryControllerRef.current = null;
        }
      });
    });
    return () => {
      previewScheduler.cancel();
      controller.abort();
      if (previewAdvisoryControllerRef.current === controller) {
        previewAdvisoryControllerRef.current = null;
      }
      if (scheduled && !settled) previewScheduler.forget(previewKey);
    };
  // `quantity` may move with a market-priced size intent while the cursor
  // advances. That movement clears the preview above, but intentionally does
  // not create a new HTTP advisory until the user changes the draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clientOrderId,
    capacityReadyKey,
    cursorReady,
    leverage,
    orderType,
    positionMode,
    activePositionSide,
    previewOrder,
    previewPositionIntent,
    price,
    previewScheduler,
    previewKey,
    reduceOnly,
    riskValue,
    selectedTrackId,
    previewSide,
    store.connectionState,
    store.state,
    targetPrice,
    tradePlanDraft,
    tradeReason,
    tradeValidationSide,
    invalidationPrice,
    maxQuantityContextKey,
    maxQuantitySizingKey,
    quantityExceedsCapacity,
    viewerReady,
  ]);
  const currentPreviewState = previewState?.key === previewKey ? previewState : null;
  const preview = currentPreviewState?.status === "ready"
    ? currentPreviewState.result
    : null;
  const previewPending = currentPreviewState?.status === "pending";
  const previewError = currentPreviewState?.status === "error"
    ? currentPreviewState.error
    : null;
  const capacityValidationError = quantityExceedsCapacity
    ? t("replay.paper.overCap", { qty: formatDecimal(estimatedMaxQuantity, 8), asset: quantityAsset })
    : null;
  const isSpot = config?.market_type.toLowerCase().includes("spot") ?? false;
  const positionSide: "flat" | "long" | "short" = positionQty > 0
    ? "long"
    : positionQty < 0
      ? "short"
      : "flat";
  const refForSize = referencePrice ?? finiteNumber(preview?.estimated_fill_price) ?? finiteNumber(preview?.reference_price);
  const maxSizeValue = useMemo(() => {
    const maxQty = finiteNumber(estimatedMaxQuantity);
    if (maxQty === null || maxQty <= 0) return null;
    if (sizeMode === "QUANTITY") return maxQty;
    if (refForSize === null || refForSize <= 0) return null;
    if (sizeMode === "NOTIONAL") return maxQty * refForSize;
    // MARGIN
    return (maxQty * refForSize) / Math.max(1, leverage);
  }, [estimatedMaxQuantity, leverage, refForSize, sizeMode]);
  const derivedSizeShare = useMemo(() => {
    const maximum = maxSizeValue;
    const current = finiteNumber(resolvedSizeInput);
    if (maximum === null || maximum <= 0 || current === null) return 0;
    return Math.max(0, Math.min(100, Math.round((current / maximum) * 100)));
  }, [maxSizeValue, resolvedSizeInput]);
  const displaySizeShare = sliderDragging
    ? sliderPct
    : sizeShareIntent === null
      ? derivedSizeShare
      : Math.round(sizeShareIntent * 100);
  const displaySizeShareLabel = quantityExceedsCapacity ? ">100" : String(displaySizeShare);

  const setSizeShare = (share: number) => {
    const maximum = maxSizeValue;
    if (maximum === null) return;
    const normalizedShare = Math.max(0, Math.min(1, share));
    setSizeShareIntent(normalizedShare);
    const raw = maximum * normalizedShare;
    if (sizeMode === "QUANTITY") {
      setSizeInput(quantityForStep(raw, quantityStep));
      return;
    }
    setSizeInput(quantityForStep(raw, quoteStep));
  };

  const sizeUnit = sizeMode === "QUANTITY" ? quantityAsset : settlementAsset;
  const sizeModeLabel = sizeMode === "QUANTITY"
    ? t("replay.paper.qtyAsset")
    : sizeMode === "MARGIN"
      ? t("replay.paper.marginAmt")
      : t("replay.paper.notionalAmt");

  const ctaEnabled = (nextSide: "BUY" | "SELL"): { enabled: boolean; title: string } => {
    if (positionMode === "HEDGE") {
      if (!reduceOnly) return { enabled: true, title: "" };
      const targetSide = nextSide === "BUY" ? "SHORT" : "LONG";
      const target = portfolio?.positions.find((item) => (
        item.track_id === selectedTrackId && item.position_side === targetSide
      ));
      return target === undefined
        ? { enabled: false, title: targetSide === "LONG" ? t("replay.paper.noLong") : t("replay.paper.noShort") }
        : { enabled: true, title: "" };
    }
    if (reduceOnly) {
      if (positionSide === "flat") {
        return { enabled: false, title: t("replay.paper.noPos") };
      }
      if (positionSide === "long") {
        return nextSide === "SELL"
          ? { enabled: true, title: "" }
          : { enabled: false, title: t("replay.paper.longSellOnly") };
      }
      return nextSide === "BUY"
        ? { enabled: true, title: "" }
        : { enabled: false, title: t("replay.paper.shortBuyOnly") };
    }
    if (positionSide === "long" && nextSide === "SELL") {
      return { enabled: false, title: t("replay.paper.hasLong") };
    }
    if (positionSide === "short" && nextSide === "BUY") {
      return { enabled: false, title: t("replay.paper.hasShort") };
    }
    return { enabled: true, title: "" };
  };

  const ctaLabel = (nextSide: "BUY" | "SELL"): string => {
    if (reduceOnly) {
      return nextSide === "BUY" ? t("replay.paper.buyCloseShort") : t("replay.paper.sellCloseLong");
    }
    if (isSpot) {
      return nextSide === "BUY" ? t("replay.paper.buyAsset", { asset: quantityAsset }) : t("replay.paper.sellAsset", { asset: quantityAsset });
    }
    return nextSide === "BUY" ? t("replay.paper.openLongX", { lev: leverage }) : t("replay.paper.openShortX", { lev: leverage });
  };

  const placeOrderWithSide = async (nextSide: "BUY" | "SELL") => {
    const gate = ctaEnabled(nextSide);
    if (
      !gate.enabled
      || !commandReady
      || capacityPending
      || tradeValidationControllerRef.current !== null
    ) return;
    if (!quantity.trim() || (orderType !== "MARKET" && !price.trim())) {
      setNotice({ tone: "error", message: t("replay.paper.invalidInput") });
      return;
    }
    if (leverage < 1 || leverage > maxLeverage) {
      setNotice({ tone: "error", message: t("replay.paper.levRange", { max: maxLeverage }) });
      return;
    }
    const targetPositionSide: "LONG" | "SHORT" = reduceOnly
      ? nextSide === "BUY" ? "SHORT" : "LONG"
      : nextSide === "BUY" ? "LONG" : "SHORT";
    const order: ReplayOrderRequest = {
      client_order_id: clientOrderId,
      side: nextSide,
      order_type: orderType,
      quantity,
      reduce_only: reduceOnly,
      limit_price: orderType === "LIMIT" ? price : null,
      stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET" ? price : null,
      leverage: String(leverage),
      ...(positionMode === "HEDGE" ? { position_side: targetPositionSide } : {}),
    };
    const intent = orderType === "MARKET" && !reduceOnly ? "OPEN" : "NET";
    const planForSide = tradePlanEnabled && tradePlanEligible && !reduceOnly
      ? tradePlanDraft
      : null;
    const sideForContext = positionMode === "HEDGE"
      ? nextSide
      : replayOrderContextSide(positionQty, nextSide, reduceOnly);
    const sideContext: ReplayOrderCapacityContext = {
      side: sideForContext,
      order_type: orderType,
      reduce_only: reduceOnly,
      limit_price: orderType === "LIMIT" ? price : null,
      stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET"
        ? price
        : null,
      leverage: String(leverage),
      ...(positionMode === "HEDGE" ? { position_side: targetPositionSide } : {}),
    };
    const sideSizingKey = JSON.stringify([
      selectedTrackId,
      sideForContext,
      orderType,
      reduceOnly,
      reduceOnly ? positionQty : null,
    ]);
    const sideContextKey = JSON.stringify([
      selectedTrackId,
      store.revision,
      store.sourceSequence,
      store.virtualTimeMs,
      sideForContext,
      orderType,
      reduceOnly,
      price,
      leverage,
    ]);
    capacityScheduler.cancel();
    previewScheduler.cancel();
    capacityAdvisoryControllerRef.current?.abort();
    previewAdvisoryControllerRef.current?.abort();
    capacityAdvisoryControllerRef.current = null;
    previewAdvisoryControllerRef.current = null;
    const validationController = new AbortController();
    tradeValidationControllerRef.current = validationController;
    setTradeValidationSide(nextSide);
    const validationTimeout = globalThis.setTimeout(() => {
      validationController.abort(
        new DOMException(t("replay.paper.timeout"), "TimeoutError"),
      );
    }, REPLAY_ORDER_VALIDATION_TIMEOUT_MS);
    setNotice({ tone: "pending", message: t("replay.paper.fetchingCap") });
    try {
      const sideCapacity = await orderCapacity(
        sideContext,
        intent,
        validationController.signal,
      );
      setCapacityState({
        key: sideContextKey,
        status: "ready",
        result: sideCapacity,
        error: null,
      });
      setMaxQuantitySnapshot({
        key: sideContextKey,
        sizingKey: sideSizingKey,
        value: sideCapacity.max_quantity,
        referencePrice: finiteNumber(sideCapacity.reference_price),
        availableEquity: sizingAvailableEquity,
        leverage,
      });
      setSide(nextSide);
      const requestedQuantity = finiteNumber(order.quantity);
      const maximumQuantity = finiteNumber(sideCapacity.max_quantity);
      if (
        requestedQuantity === null
        || maximumQuantity === null
        || requestedQuantity > maximumQuantity
      ) {
        setNotice({
          tone: "error",
          message: t("replay.paper.overCap", { qty: formatDecimal(sideCapacity.max_quantity, 8), asset: quantityAsset }),
        });
        return;
      }
      setNotice({ tone: "pending", message: t("replay.paper.previewing") });
      const sidePreview = await previewOrder(
        order,
        intent,
        planForSide,
        validationController.signal,
      );
      if (sidePreview.order.side !== nextSide) {
        setNotice({ tone: "error", message: t("replay.paper.sideMismatch") });
        return;
      }
      if (
        sidePreview.cursor.revision !== store.revision
        || sidePreview.cursor.source_sequence !== store.sourceSequence
        || sidePreview.cursor.virtual_time_ms !== store.virtualTimeMs
      ) {
        setNotice({ tone: "error", message: t("replay.paper.cursorChanged") });
        return;
      }
      setNotice({ tone: "pending", message: t("replay.paper.submittingOrder") });
      const planned = sidePreview.trade_plan;
      if (planned !== null && planForSide !== null) {
        await viewer.actions.submitTrade("place_order", {
          ...order,
          quantity: planned.quantity,
          trade_plan: { ...planForSide },
        });
      } else if (orderType === "MARKET" && !reduceOnly) {
        await viewer.actions.submitTrade("execute_position_intent", {
          intent: "OPEN",
          side: nextSide,
          quantity,
          leverage: String(leverage),
          ...(positionMode === "HEDGE" ? { position_side: targetPositionSide } : {}),
        });
      } else {
        await viewer.actions.submitTrade("place_order", { ...order });
      }
      setClientOrderId(orderClientId());
      if (planned !== null) {
        setInvalidationPrice("");
        setTargetPrice("");
        setTradeReason("");
      }
      setPreviewState(null);
      setNotice({ tone: "success", message: t("replay.paper.accepted") });
    } catch (error) {
      if (tradeValidationMountedRef.current) {
        setNotice({ tone: "error", message: commandErrorMessage(error) });
      }
    } finally {
      globalThis.clearTimeout(validationTimeout);
      if (tradeValidationControllerRef.current === validationController) {
        tradeValidationControllerRef.current = null;
        if (tradeValidationMountedRef.current) setTradeValidationSide(null);
      }
    }
  };

  const buyGate = ctaEnabled("BUY");
  const sellGate = ctaEnabled("SELL");
  const orderSubmitting = tradeValidationSide !== null;
  const transientOrderBlock = !commandReady || capacityPending;
  const commonPermanentOrderBlock = !commandAvailable
    || quantityExceedsCapacity
    || !quantity.trim()
    || (orderType !== "MARKET" && !price.trim());
  const buyCtaState = replayOrderCtaState({
    permanentlyUnavailable: commonPermanentOrderBlock || !buyGate.enabled,
    transientlyBlocked: transientOrderBlock,
    submitting: orderSubmitting,
  });
  const sellCtaState = replayOrderCtaState({
    permanentlyUnavailable: commonPermanentOrderBlock || !sellGate.enabled,
    transientlyBlocked: transientOrderBlock,
    submitting: orderSubmitting,
  });
  const leverageOptions = useMemo(() => {
    const presets = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125].filter((value) => value <= maxLeverage);
    if (!presets.includes(Math.trunc(maxLeverage)) && maxLeverage >= 1) {
      presets.push(Math.trunc(maxLeverage));
    }
    if (!presets.includes(leverage) && leverage >= 1 && leverage <= maxLeverage) {
      presets.push(leverage);
    }
    return [...new Set(presets)].sort((a, b) => a - b);
  }, [leverage, maxLeverage]);

  return (
    <div className="replay-paper-trading" data-replay-paper-surface="order-ticket">
    <div className="replay-order-surface">
      <header className="replay-ticket-account">
        <div>
          <small>{symbol} · {isSpot ? t("replay.paper.spot") : t("replay.paper.futures")}</small>
          <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 4)} {settlementAsset}</strong>
        </div>
        <div className="replay-ticket-locks" aria-label={t("replay.paper.marginLev")}>
          <span>{positionMode === "HEDGE" ? t("replay.paper.hedge") : t("replay.paper.oneWay")}</span>
          <span>{contract?.margin_mode === "ISOLATED" ? t("replay.wb.isolated") : t("replay.wb.cross")}</span>
          <label className="replay-leverage-control">
            <span className="sr-only">{t("replay.paper.leverage")}</span>
            <select
              value={String(leverage)}
              aria-label={t("replay.paper.leverageMax", { max: maxLeverage })}
              onChange={(event) => setLeverage(Math.min(maxLeverage, Math.max(1, Number(event.target.value) || 1)))}
            >
              {leverageOptions.map((value) => (
                <option key={value} value={value}>{value}x</option>
              ))}
            </select>
          </label>
          <span title={t("replay.paper.levCap")}>≤{maxLeverage}x</span>
        </div>
      </header>

      <section className="replay-compact-ticket" data-replay-panel="order-ticket">
        <div className="replay-mode-toggle" role="group" aria-label={t("replay.paper.openClose")}>
          <button
            type="button"
            data-mode="open"
            className={!reduceOnly ? "active" : ""}
            onClick={() => setReduceOnly(false)}
          >{t("replay.paper.open")}</button>
          <button
            type="button"
            data-mode="close"
            className={reduceOnly ? "active" : ""}
            onClick={() => setReduceOnly(true)}
          >{t("replay.paper.close")}</button>
        </div>

        <div className="replay-order-fidelity-row">
          <span data-fidelity={contract?.execution_fidelity ?? "LOADING"}>
            {contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE"
              ? t("replay.paper.l2Assist")
              : t("replay.paper.approxFill")}
          </span>
          <small>{t("replay.paper.available", { value: formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 4), asset: settlementAsset })}</small>
        </div>

        <label className="replay-ticket-type">{t("replay.paper.orderType")}
          <select value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}>
            <option value="MARKET">{t("replay.paper.market")}</option>
            <option value="LIMIT">{t("replay.paper.limit")}</option>
            <option value="STOP_MARKET">{t("replay.paper.stopMkt")}</option>
            <option value="TAKE_PROFIT_MARKET">{t("replay.paper.tpMkt")}</option>
          </select>
        </label>

        <div className="replay-size-mode" role="group" aria-label={t("replay.paper.sizeMode")}>
          {([
            ["QUANTITY", t("replay.paper.qty")],
            ["MARGIN", t("replay.paper.margin")],
            ["NOTIONAL", t("replay.paper.notional")],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={sizeMode === mode ? "active" : ""}
              onClick={() => setSizeMode(mode)}
            >{label}</button>
          ))}
        </div>

        <div className="replay-ticket-fields">
          {orderType !== "MARKET" && (
            <label>{orderType === "LIMIT" ? t("replay.paper.limitPrice") : t("replay.paper.triggerPrice")}
              <span><input data-replay-field="order-price" value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} /><b>{settlementAsset}</b></span>
            </label>
          )}
          <label>{sizeModeLabel}
            <span>
                 <input
                   data-replay-field="order-quantity"
                   value={resolvedSizeInput}
                   inputMode="decimal"
                   aria-invalid={quantityExceedsCapacity || undefined}
                   aria-describedby="replay-order-size-feedback"
                 onChange={(event) => {
                   setSizeShareIntent(null);
                   setSizeInput(event.target.value);
                 }}
              />
              <b>{sizeUnit}</b>
            </span>
          </label>
        </div>
        {sizeMode !== "QUANTITY" && (
          <small className="replay-size-converted">
            {t("replay.paper.approxQty", { qty: quantity || "--", asset: quantityAsset })}
            {refForSize !== null ? t("replay.paper.refPrice", { price: formatDecimal(refForSize, 6) }) : ""}
          </small>
        )}

        <div
          className="replay-size-slider"
          aria-label={t("replay.paper.posShare")}
          style={{ ["--replay-size-pct" as string]: `${displaySizeShare}%` }}
        >
          <input
            type="range"
            aria-label={t("replay.paper.sizeQuick")}
            min={0}
            max={100}
            step={1}
            value={displaySizeShare}
            disabled={sizingAvailability.sliderDisabled || maxSizeValue === null}
            onPointerDown={() => {
              setSliderDragging(true);
              setSliderPct(displaySizeShare);
            }}
            onPointerUp={() => setSliderDragging(false)}
            onPointerCancel={() => setSliderDragging(false)}
            onLostPointerCapture={() => setSliderDragging(false)}
            onBlur={() => setSliderDragging(false)}
            onKeyUp={() => setSliderDragging(false)}
            onInput={(event) => {
              const pct = Number((event.target as HTMLInputElement).value);
              setSliderDragging(true);
              setSliderPct(pct);
              setSizeShare(pct / 100);
            }}
            onChange={(event) => {
              const pct = Number(event.target.value);
              setSliderPct(pct);
              setSizeShare(pct / 100);
            }}
          />
          <div className="replay-size-slider-ticks">
            {[0, 0.25, 0.5, 0.75, 1].map((share) => (
              <button
                key={share}
                type="button"
                disabled={sizingAvailability.sliderDisabled || maxSizeValue === null}
                onClick={() => setSizeShare(share)}
              >{share * 100}%</button>
            ))}
          </div>
          <div className="replay-size-slider-meta">
            <span>
              {t("replay.paper.refMax", {
                value: maxSizeValue === null ? "--" : formatDecimal(maxSizeValue, sizeMode === "QUANTITY" ? 8 : 2),
                unit: sizeUnit,
              })}
              {sizeMode !== "QUANTITY" && estimatedMaxQuantity !== null
                ? ` · ${formatDecimal(estimatedMaxQuantity)} ${quantityAsset}`
                : ""}
            </span>
            <span>{displaySizeShareLabel}%</span>
          </div>
        </div>

        <details className="replay-trade-plan replay-disclosure" open={tradePlanEnabled && tradePlanEligible}>
          <summary>
            <label onClick={(event) => event.stopPropagation()}>
              <input
                type="checkbox"
                checked={tradePlanEnabled && tradePlanEligible}
                disabled={!tradePlanEligible}
                onChange={(event) => setTradePlanEnabled(event.target.checked)}
              />
              {t("replay.paper.riskPlan")}
            </label>
          </summary>
          {tradePlanEnabled && tradePlanEligible && (
            <div className="replay-trade-plan-fields">
              <label>{t("replay.paper.riskMode")}
                <select
                  value={riskSizingMode}
                  onChange={(event) => setRiskSizingMode(event.target.value as typeof riskSizingMode)}
                >
                  <option value="ACCOUNT_RISK_PERCENT">{t("replay.paper.accountRiskPct")}</option>
                  <option value="RISK_AMOUNT">{t("replay.paper.riskAmt")}</option>
                </select>
              </label>
              <label>{riskSizingMode === "RISK_AMOUNT" ? t("replay.paper.maxLoss") : t("replay.paper.accountRisk")}
                <span>
                  <input value={riskValue} inputMode="decimal" onChange={(event) => setRiskValue(event.target.value)} />
                  <b>{riskSizingMode === "RISK_AMOUNT" ? settlementAsset : "%"}</b>
                </span>
              </label>
              <label>{t("replay.paper.invalidPx")}
                <span><input value={invalidationPrice} inputMode="decimal" onChange={(event) => setInvalidationPrice(event.target.value)} /><b>{settlementAsset}</b></span>
              </label>
              <label>{t("replay.paper.targetPx")}
                <span><input value={targetPrice} inputMode="decimal" onChange={(event) => setTargetPrice(event.target.value)} /><b>{settlementAsset}</b></span>
              </label>
              <label className="replay-trade-plan-reason">{t("replay.paper.reason")}
                <textarea value={tradeReason} maxLength={500} onChange={(event) => setTradeReason(event.target.value)} placeholder={t("replay.paper.reasonPh")} />
              </label>
              <dl className="replay-order-preview" aria-label={t("replay.paper.planPreview")}>
                <div><dt>{t("replay.paper.planQty")}</dt><dd>{preview?.trade_plan?.quantity ?? "--"} {quantityAsset}</dd></div>
                <div><dt>{t("replay.paper.planRisk")}</dt><dd>{preview?.trade_plan?.risk_amount ?? "--"} {settlementAsset}</dd></div>
                <div><dt>{t("replay.paper.planRR")}</dt><dd>{preview?.trade_plan?.reward_risk_ratio ?? "--"}</dd></div>
              </dl>
              <small>{t("replay.paper.planHint")}</small>
            </div>
          )}
        </details>

        <dl className="replay-order-preview" aria-label={t("replay.paper.orderPreview")}>
          <div><dt>{t("replay.paper.notionalVal")}</dt><dd>{previewPending ? t("replay.paper.checking") : `${formatDecimal(preview?.estimated_notional, 2)} ${settlementAsset}`}</dd></div>
          <div><dt>{t("replay.paper.marginAmt")}</dt><dd>{formatDecimal(preview?.reserved_margin, 2)} {settlementAsset}</dd></div>
          <div><dt>{t("replay.paper.feeCap")}</dt><dd>{formatDecimal(preview?.estimated_fee, 4)} {settlementAsset}</dd></div>
        </dl>

        <div className="replay-dual-cta">
          <button
            type="button"
            className="replay-submit-order"
            data-side="BUY"
            data-replay-action="place-order"
            data-replay-transient-blocked={transientOrderBlock ? "true" : "false"}
            title={buyGate.title || undefined}
            disabled={buyCtaState.disabled}
            aria-disabled={buyCtaState.ariaDisabled}
            onClick={() => void placeOrderWithSide("BUY")}
          >{tradeValidationSide === "BUY" ? t("replay.paper.submitting") : ctaLabel("BUY")}</button>
          <button
            type="button"
            className="replay-submit-order"
            data-side="SELL"
            data-replay-action="place-order"
            data-replay-transient-blocked={transientOrderBlock ? "true" : "false"}
            title={sellGate.title || undefined}
            disabled={sellCtaState.disabled}
            aria-disabled={sellCtaState.ariaDisabled}
            onClick={() => void placeOrderWithSide("SELL")}
          >{tradeValidationSide === "SELL" ? t("replay.paper.submitting") : ctaLabel("SELL")}</button>
        </div>

        <div id="replay-order-size-feedback" className="replay-trade-notice" role={notice?.tone === "error" || capacityValidationError !== null || reduceOnlyUnavailableMessage !== null ? "alert" : "status"} aria-live="polite" data-tone={notice?.tone ?? (capacityValidationError !== null || capacityError !== null || reduceOnlyUnavailableMessage !== null ? "error" : "idle")}>
          {notice?.message ?? reduceOnlyUnavailableMessage ?? capacityValidationError ?? capacityError ?? previewError ?? viewer.error ?? t("replay.paper.submitHint")}
        </div>
      </section>
    </div>
    </div>
  );
}

export function ReplayTradingWorkbench({ runtime, viewer, formatTime }: ReplayRightRailProps) {
  useLocale();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("positions");
  const [orderSelection, setOrderSelection] = useState<Readonly<{
    trackId: string;
    orderIds: readonly string[];
  }>>({ trackId: "", orderIds: [] });
  const [replaceDraft, setReplaceDraft] = useState<Readonly<{
    trackId: string;
    orderId: string;
    quantity: string;
    price: string;
  }> | null>(null);
  const [closeDraft, setCloseDraft] = useState<Readonly<{
    trackId: string;
    positionSide?: "LONG" | "SHORT";
    value: string;
  }> | null>(null);
  const [protectionDraft, setProtectionDraft] = useState<Readonly<{
    trackId: string;
    positionSide?: "LONG" | "SHORT";
    stopLoss: string;
    takeProfit: string;
  }> | null>(null);
  const [leverageDraft, setLeverageDraft] = useState<Readonly<{
    trackId: string;
    positionSide: "LONG" | "SHORT";
    value: string;
  }> | null>(null);
  const [positionPanel, setPositionPanel] = useState<Readonly<{
    trackId: string;
    positionSide?: "LONG" | "SHORT";
    kind: "close" | "protection" | "leverage";
  }> | null>(null);
  const [filterSelectedTrackOnly, setFilterSelectedTrackOnly] = useState(false);
  const closeQtyInputRef = useRef<HTMLInputElement | null>(null);
  const [isolatedAmount, setIsolatedAmount] = useState("0");
  const [isolatedSide, setIsolatedSide] = useState<"LONG" | "SHORT">("LONG");
  const [notice, setNotice] = useState<TradeNotice>(null);
  useTradeNoticeAutoDismiss(notice, setNotice);
  const [reportSnapshot, setReportSnapshot] = useState<Readonly<{
    runId: string;
    state: "loaded" | "error";
    trades: readonly ReplayClosedTrade[];
  }> | null>(null);
  const store = runtime.store;
  const config = store.sessionConfig;
  const ownsController = replayOwnsController(store, runtime.clientInstanceId);
  const commandReady = ownsController
    && store.connectionState === "connected"
    && runtime.pendingCommand === null
    && !viewer.viewerPending
    && store.state !== "ENDED";
  const portfolio = viewer.marketTracks?.portfolio ?? null;
  const contract = contractPortfolio(portfolio);
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? "track-1";
  const selectedTrack = viewer.marketTracks?.tracks.find((item) => item.track_id === selectedTrackId) ?? null;
  const settlementAsset = selectedTrack?.settlement_asset ?? store.account?.quote_asset ?? "";
  const selectedSymbol = selectedTrack?.symbol ?? config?.symbol ?? "--";
  const portfolioPositions = portfolio?.positions ?? [];
  const visiblePositions = filterSelectedTrackOnly
    ? portfolioPositions.filter((item) => item.track_id === selectedTrackId)
    : portfolioPositions;
  const selectedPosition = portfolioPositions.find((item) => item.track_id === selectedTrackId) ?? null;
  const structuredOrders: readonly JsonRecord[] = useMemo(() => contract?.orders
    ?? store.orders.map((order) => order as unknown as JsonRecord), [contract, store.orders]);
  const structuredFills: readonly JsonRecord[] = useMemo(() => contract?.fills
    ?? store.fills.map((fill) => fill as unknown as JsonRecord), [contract, store.fills]);
  const openOrders = useMemo(() => structuredOrders.filter((order) => (
    !TERMINAL_ORDER_STATES.has(recordText(order, "status", "OPEN"))
  )), [structuredOrders]);
  const selectedOrderIds = orderSelection.trackId === selectedTrackId
    ? orderSelection.orderIds.filter((orderId) => openOrders.some((order) => (
        recordText(order, "order_id") === orderId
        && recordText(order, "track_id", selectedTrackId) === selectedTrackId
      )))
    : [];
  const fallbackHistoricalOrders = useMemo(() => structuredOrders.filter((order) => (
    TERMINAL_ORDER_STATES.has(recordText(order, "status", "OPEN"))
  )), [structuredOrders]);
  const runId = viewer.viewerState?.run_id ?? null;
  const historicalOrderPages = useAccountRecordPages({
    runId,
    recordType: "ORDERS",
    orderScope: "HISTORY",
    enabled: contract !== null && activeTab === "order-history",
    revision: contract?.history.historical_orders ?? 0,
  });
  const fillPages = useAccountRecordPages({
    runId,
    recordType: "FILLS",
    orderScope: "ALL",
    enabled: contract !== null && activeTab === "fills",
    revision: contract?.history.fills_total ?? 0,
  });
  const ledgerPages = useAccountRecordPages({
    runId,
    recordType: "LEDGER",
    orderScope: "ALL",
    enabled: contract !== null && activeTab === "risk",
    revision: contract?.history.ledger_entries_total ?? 0,
  });
  const historicalOrders = contract === null
    ? [...fallbackHistoricalOrders].reverse()
    : historicalOrderPages.items;
  const visibleFills = contract === null
    ? [...structuredFills].slice(-REPLAY_ACTIVITY_VIEW_LIMIT).reverse()
    : fillPages.items;
  const fallbackClosedTrades = runtime.report?.report.closed_trades ?? store.closedTrades;
  const currentReport = reportSnapshot?.runId === runId ? reportSnapshot : null;
  const reportState = runId === null ? "idle" : currentReport?.state ?? "loading";
  const reportClosedTrades = currentReport?.trades ?? [];
  const closedTrades = reportState === "loaded" ? reportClosedTrades : fallbackClosedTrades;
  const recentClosedTrades = useMemo(() => recentReplayActivity(closedTrades), [closedTrades]);
  const rule = selectedRule(contract, selectedTrackId);
  const quantityStep = recordText(rule ?? {}, "quantity_step", "0.00000001");
  const selectedPositionSignedQuantity = finiteNumber(selectedPosition?.position.quantity) ?? 0;
  const selectedPositionQuantity = Math.abs(selectedPositionSignedQuantity);
  const defaultCloseQuantity = selectedPositionQuantity > 0
    ? quantityForStep(selectedPositionQuantity, quantityStep)
    : "";
  const closeQuantity = closeDraft?.trackId === selectedTrackId
    ? closeDraft.value
    : defaultCloseQuantity;
  const warningCount = store.warnings.length;

  const time = (value: number) => formatTime?.(value)
    ?? formatReplayPublicTime(value, {
      blindMode: config?.blind_mode ?? true,
      originMs: store.replayStartMs,
    });

  useEffect(() => {
    if (runId === null) return undefined;
    const controller = new AbortController();
    void defaultReplayV2Api.reportRun(runId, controller.signal).then((response) => {
      setReportSnapshot({ runId, state: "loaded", trades: response.report.closed_trades });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setReportSnapshot({ runId, state: "error", trades: [] });
      setNotice({ tone: "error", message: t("replay.paper.closedSyncFailed", { error: commandErrorMessage(error) }) });
    });
    return () => controller.abort();
  }, [contract?.history.fills_total, runId, structuredFills.length]);

  useEffect(() => {
    if (positionPanel?.kind !== "close" || positionPanel.trackId !== selectedTrackId) return;
    const timer = globalThis.setTimeout(() => {
      closeQtyInputRef.current?.focus();
      closeQtyInputRef.current?.select();
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [positionPanel, selectedTrackId]);

  const togglePositionPanel = (
    trackId: string,
    kind: "close" | "protection" | "leverage",
    positionSide?: "LONG" | "SHORT",
  ) => {
    setPositionPanel((current) => (
      current?.trackId === trackId
        && current.kind === kind
        && current.positionSide === positionSide
        ? null
        : { trackId, kind, ...(positionSide === undefined ? {} : { positionSide }) }
    ));
  };

  const runTrade = async (
    type: TradeType,
    payload: Readonly<Record<string, ReplayV2Json>>,
    pendingMessage: string,
    successMessage: string,
  ) => {
    setNotice({ tone: "pending", message: pendingMessage });
    try {
      await viewer.actions.submitTrade(type, payload);
      setNotice({ tone: "success", message: successMessage });
      if (type === "close_position" || payload.intent === "CLOSE") setCloseDraft(null);
      if (type === "replace_order") setReplaceDraft(null);
      if (type === "cancel_order" || type === "cancel_orders") {
        setOrderSelection({ trackId: selectedTrackId, orderIds: [] });
      }
    } catch (error) {
      setNotice({ tone: "error", message: commandErrorMessage(error) });
    }
  };

  const selectedTrackOpenOrders = openOrders.filter((order) => (
    recordText(order, "track_id", selectedTrackId) === selectedTrackId
  ));
  const toggleSelectedOrder = (orderId: string, checked: boolean) => {
    setOrderSelection((current) => {
      const orderIds = current.trackId === selectedTrackId ? current.orderIds : [];
      return {
        trackId: selectedTrackId,
        orderIds: checked
          ? orderIds.includes(orderId) ? orderIds : [...orderIds, orderId]
          : orderIds.filter((value) => value !== orderId),
      };
    });
  };
  const replaceOrder = (order: JsonRecord) => {
    const orderId = recordText(order, "order_id");
    const orderTypeValue = recordText(order, "order_type");
    const draft = replaceDraft?.trackId === selectedTrackId
      && replaceDraft.orderId === orderId
      ? replaceDraft
      : null;
    if (draft === null) return;
    void runTrade(
      "replace_order",
      {
        order_id: orderId,
        client_order_id: orderClientId().replace(/^ticket-/, "replace-"),
        quantity: draft.quantity,
        limit_price: orderTypeValue === "LIMIT" ? draft.price : null,
        stop_price: orderTypeValue === "STOP_MARKET" || orderTypeValue === "TAKE_PROFIT_MARKET"
          ? draft.price
          : null,
      },
      t("replay.paper.replacing"),
      t("replay.paper.replaced"),
    );
  };

  const symbolForTrack = (trackId: string) => viewer.marketTracks?.tracks.find((track) => track.track_id === trackId)?.symbol ?? trackId;
  const tabCounts: Readonly<Partial<Record<WorkbenchTab, number>>> = {
    positions: portfolioPositions.length,
    "open-orders": openOrders.length,
    "order-history": contract?.history.historical_orders ?? historicalOrders.length,
    fills: contract?.history.fills_total ?? structuredFills.length,
  };
  const handleRailTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, value: WorkbenchTab) => {
    handleTabKeyDown(event, WORKBENCH_TAB_IDS, value, setActiveTab, "data-replay-rail-tab");
  };

  return (
    <section className="replay-trading-workbench" data-replay-workbench="rail" aria-label={t("replay.wb.accountAria")}>
      <header className="replay-workbench-header">
        <div className="replay-workbench-summary">
          <span>
            <small>{t("replay.wb.equity")}</small>
            <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 2)} {settlementAsset}</strong>
          </span>
          <span>
            <small>{t("replay.wb.available")}</small>
            <strong>{formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 2)}</strong>
          </span>
          {warningCount > 0 && <span data-tone="warning">{t("replay.wb.execWarnings", { count: warningCount })}</span>}
        </div>
        <nav className="replay-workbench-tabs" aria-label={t("replay.wb.recordsAria")} role="tablist">
          {WORKBENCH_TAB_IDS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`replay-workbench-tab-${value}`}
              className={activeTab === value ? "active" : ""}
              aria-selected={activeTab === value}
              aria-controls="replay-workbench-panel"
              tabIndex={activeTab === value ? 0 : -1}
              data-replay-rail-tab={value}
              onClick={() => setActiveTab(value)}
              onKeyDown={(event) => handleRailTabKeyDown(event, value)}
            >
              {workbenchTabLabel(value)}
              {tabCounts[value] !== undefined && <span>{tabCounts[value]}</span>}
            </button>
          ))}
        </nav>
      </header>

      <div
        id="replay-workbench-panel"
        className="replay-workbench-panel"
        role="tabpanel"
        aria-labelledby={`replay-workbench-tab-${activeTab}`}
      >
        {notice !== null && <div className="replay-workbench-notice" role={notice.tone === "error" ? "alert" : "status"} aria-live="polite" data-tone={notice.tone}>{notice.message}</div>}

        {activeTab === "positions" && (
          <div className="replay-rail-account-scroll" data-replay-panel="positions">
            <div className="replay-account-toolbar">
              <label className="replay-checkbox-field">
                <input
                  type="checkbox"
                  checked={filterSelectedTrackOnly}
                  onChange={(event) => setFilterSelectedTrackOnly(event.target.checked)}
                />
                {t("replay.wb.currentSymbol")}
              </label>
              <small>{selectedSymbol}</small>
            </div>
            {portfolioPositions.length === 0 ? (
              <div className="replay-account-empty calm"><strong>{t("replay.wb.noPos")}</strong><small>{t("replay.wb.noPosHint")}</small></div>
            ) : visiblePositions.length === 0 ? (
              <div className="replay-account-empty calm"><strong>{t("replay.wb.noPosSymbol")}</strong><small>{t("replay.wb.noPosSymbolHint")}</small></div>
            ) : visiblePositions.map((item) => {
              const quantityValue = finiteNumber(item.position.quantity) ?? 0;
              const positionSide = quantityValue >= 0 ? "long" : "short";
              const hedgePositionSide = item.position_side;
              const selected = item.track_id === selectedTrackId;
              const samePanelLeg = positionPanel?.positionSide === hedgePositionSide;
              const showClose = selected && positionPanel?.trackId === item.track_id && samePanelLeg && positionPanel.kind === "close";
              const showProtection = selected && positionPanel?.trackId === item.track_id && samePanelLeg && positionPanel.kind === "protection";
              const showLeverage = selected && positionPanel?.trackId === item.track_id && samePanelLeg && positionPanel.kind === "leverage";
              const uPnl = finiteNumber(item.position.unrealized_pnl) ?? 0;
              const maintenanceTierExtrapolated = (
                item.maintenance_margin_proof?.position_tier_extrapolated === true
              );
              const liquidationTierExtrapolated = (
                item.maintenance_margin_proof?.liquidation_tier_extrapolated === true
              );
              const maintenanceProofTitle = item.maintenance_margin_proof === undefined
                ? t("replay.wb.mmUndeclaredShort")
                : maintenanceTierExtrapolated
                ? t("replay.wb.mmOverCap", { cap: item.maintenance_margin_proof?.last_tier_notional_cap ?? "--" })
                : t("replay.wb.mmVersioned");
              const marginLabel = item.margin_equity ?? item.isolated_margin ?? null;
              const protectionOrders = item.protection?.orders ?? [];
              const itemQtyAsset = baseAsset(item.symbol, settlementAsset);
              const itemCloseQuantity = closeDraft?.trackId === item.track_id
                && closeDraft.positionSide === hedgePositionSide
                ? closeDraft.value
                : quantityForStep(Math.abs(quantityValue), quantityStep);
              const itemStopLossPrice = protectionDraft?.trackId === item.track_id
                && protectionDraft.positionSide === hedgePositionSide
                ? protectionDraft.stopLoss
                : "";
              const itemTakeProfitPrice = protectionDraft?.trackId === item.track_id
                && protectionDraft.positionSide === hedgePositionSide
                ? protectionDraft.takeProfit
                : "";
              const itemLeverage = leverageDraft?.trackId === item.track_id
                && leverageDraft.positionSide === hedgePositionSide
                ? leverageDraft.value
                : String(item.leverage ?? config?.max_leverage ?? "");
              const legPayload = hedgePositionSide === undefined
                ? {}
                : { position_side: hedgePositionSide };
              return (
                <article className="replay-position-card" key={`${item.track_id}:${hedgePositionSide ?? "NET"}`} data-position-side={positionSide} data-selected-track={selected ? "true" : "false"}>
                  <header>
                    <div>
                      <strong>{item.symbol}</strong>
                      <div className="replay-badge-row">
                        <span className="replay-chip" data-side={positionSide}>{positionSide === "long" ? t("replay.wb.long") : t("replay.wb.short")}</span>
                        <span className="replay-chip">{contract?.margin_mode === "ISOLATED" ? t("replay.wb.isolated") : t("replay.wb.cross")}</span>
                        <span className="replay-chip" title={t("replay.wb.legLev")}>{item.leverage ?? config?.max_leverage ?? "--"}x</span>
                      </div>
                    </div>
                    <div className="replay-position-pnl">
                      <small>{t("replay.wb.pnl", { asset: settlementAsset })}</small>
                      <b data-value-tone={uPnl >= 0 ? "positive" : "negative"}>{formatDecimal(item.position.unrealized_pnl, 4)}</b>
                    </div>
                  </header>
                  <dl className="replay-metric-flat">
                     <div><dt>{t("replay.wb.qty", { asset: itemQtyAsset })}</dt><dd>{formatDecimal(Math.abs(quantityValue))}</dd></div>
                     <div><dt>{t("replay.wb.im")}</dt><dd>{formatDecimal(item.initial_margin, 4)}</dd></div>
                     <div title={maintenanceProofTitle}><dt>{t("replay.wb.mm")}{maintenanceTierExtrapolated ? t("replay.wb.mmExtrap") : ""}</dt><dd>{formatDecimal(item.maintenance_margin, 4)}</dd></div>
                     <div><dt>{t("replay.wb.riskCover")}</dt><dd>{item.risk_ratio == null ? "--" : `${formatDecimal(item.risk_ratio, 2)}×`}</dd></div>
                     <div><dt>{t("replay.wb.entry")}</dt><dd>{formatDecimal(item.position.entry_price, 6)}</dd></div>
                     <div>
                       <dt title={item.mark_fidelity ?? t("replay.wb.markUndeclared")}>{t("replay.wb.mark", { fidelity: replayMarkFidelityLabel(item.mark_fidelity) })}</dt>
                       <dd>{formatDecimal(replayPositiveModelPrice(item.position.mark_price), 6)}</dd>
                     </div>
                     <div><dt>{t("replay.wb.lev")}</dt><dd>{formatDecimal(item.leverage, 2)}x</dd></div>
                     <div title={liquidationTierExtrapolated
                       ? t("replay.wb.liqSearchOver", { cap: item.maintenance_margin_proof?.last_tier_notional_cap ?? "--" })
                       : t("replay.wb.simRisk")}><dt>{t("replay.wb.liqPrice", { extra: liquidationTierExtrapolated ? t("replay.wb.liqExtrap") : "" })}</dt><dd>{formatDecimal(replayPositiveModelPrice(item.liquidation_price), 6)}</dd></div>
                     <div title={t("replay.wb.simRisk")}><dt>{t("replay.wb.bankruptcy")}</dt><dd>{formatDecimal(replayPositiveModelPrice(item.bankruptcy_price), 6)}</dd></div>
                     <div><dt>{t("replay.wb.fundingAcc")}</dt><dd>{formatDecimal(item.accumulated_funding, 8)}</dd></div>
                     <div className="wide"><dt>{t("replay.wb.protection")}</dt><dd>{protectionOrders.length === 0
                       ? t("replay.wb.none")
                       : protectionOrders.map((order) => `${order.order_type === "STOP_MARKET" ? t("replay.wb.stop") : t("replay.wb.tp")} ${formatDecimal(order.stop_price, 6)}`).join(" · ")}</dd></div>
                    {marginLabel !== null && (
                      <div className="wide"><dt>{t("replay.wb.marginEquity")}</dt><dd>{formatDecimal(marginLabel, 4)} {settlementAsset}</dd></div>
                    )}
                  </dl>
                  {!selected && (
                    <button type="button" disabled={viewer.viewerPending} onClick={() => void viewer.actions.selectTrack(item.track_id).catch(() => undefined)}>
                      {t("replay.wb.switchTrack")}
                    </button>
                  )}
                  {selected && (
                    <>
                      <div className="replay-position-primary-actions">
                        {hedgePositionSide !== undefined && (
                          <button
                            type="button"
                            className={`replay-pill-btn${showLeverage ? " active" : ""}`}
                            aria-expanded={showLeverage}
                            onClick={() => togglePositionPanel(item.track_id, "leverage", hedgePositionSide)}
                          >{t("replay.wb.setLev")}</button>
                        )}
                        <button
                          type="button"
                          className={`replay-pill-btn${showProtection ? " active" : ""}`}
                          aria-expanded={showProtection}
                          onClick={() => togglePositionPanel(item.track_id, "protection", hedgePositionSide)}
                        >{t("replay.wb.setProtect")}</button>
                        <button
                          type="button"
                          className={`replay-pill-btn${showClose ? " active" : ""}`}
                          aria-expanded={showClose}
                          onClick={() => togglePositionPanel(item.track_id, "close", hedgePositionSide)}
                        >{t("replay.wb.close")}</button>
                        <button
                          type="button"
                          className="replay-pill-btn"
                          data-variant="danger"
                          data-replay-action="close-position"
                          disabled={!commandReady}
                          onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: null, ...legPayload }, t("replay.paper.closeAllPending"), t("replay.paper.closeAllOk"))}
                        >{t("replay.wb.closeAll")}</button>
                      </div>
                      {showClose && (
                        <section className="replay-position-actions">
                          <header><strong>{t("replay.wb.closeQty")}</strong><small>{t("replay.wb.closeHint")}</small></header>
                          <label>{t("replay.wb.qtyLabel")} <span><input ref={closeQtyInputRef} value={itemCloseQuantity} inputMode="decimal" onChange={(event) => setCloseDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), value: event.target.value })} aria-label={t("replay.wb.closeQty")} /><b>{itemQtyAsset}</b></span></label>
                          <div>{[0.25, 0.5, 1].map((share) => <button type="button" key={share} onClick={() => setCloseDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), value: quantityForStep(Math.abs(quantityValue) * share, quantityStep) })}>{share * 100}%</button>)}</div>
                          <button
                            type="button"
                            data-replay-action="close-partial"
                            disabled={!commandReady || !itemCloseQuantity.trim()}
                            onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: itemCloseQuantity, ...legPayload }, t("replay.paper.closePending"), t("replay.paper.closeOk"))}
                          >{t("replay.wb.confirmClose")}</button>
                        </section>
                      )}
                      {showLeverage && hedgePositionSide !== undefined && (
                        <section className="replay-position-actions">
                          <header><strong>{t("replay.wb.levHeader")}</strong><small>{t("replay.wb.levIndependent", { side: hedgePositionSide })}</small></header>
                          <label>{t("replay.paper.leverage")} <span><input value={itemLeverage} inputMode="decimal" onChange={(event) => setLeverageDraft({ trackId: item.track_id, positionSide: hedgePositionSide, value: event.target.value })} aria-label={t("replay.wb.lev")} /><b>x</b></span></label>
                          <button
                            type="button"
                            data-replay-action="set-position-leverage"
                            disabled={!commandReady || !itemLeverage.trim()}
                            onClick={() => void runTrade(
                              "set_position_leverage",
                              { position_side: hedgePositionSide, leverage: itemLeverage },
                              t("replay.paper.levPending", { side: hedgePositionSide }),
                              t("replay.paper.levOk", { side: hedgePositionSide }),
                            )}
                          >{t("replay.wb.confirmLev")}</button>
                        </section>
                      )}
                      {showProtection && (
                        <section className="replay-position-actions">
                          <header><strong>{t("replay.wb.protectHeader")}</strong><small>{t("replay.wb.protectHint")}</small></header>
                          <label>{t("replay.wb.slPrice")} <span><input value={itemStopLossPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), stopLoss: event.target.value, takeProfit: itemTakeProfitPrice })} aria-label={t("replay.wb.slPrice")} /><b>{settlementAsset}</b></span></label>
                          <label>{t("replay.wb.tpPrice")} <span><input value={itemTakeProfitPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), stopLoss: itemStopLossPrice, takeProfit: event.target.value })} aria-label={t("replay.wb.tpPrice")} /><b>{settlementAsset}</b></span></label>
                          <button
                            type="button"
                            data-replay-action="set-position-protection"
                            disabled={!commandReady || (!itemStopLossPrice.trim() && !itemTakeProfitPrice.trim())}
                            onClick={() => void runTrade(
                              "set_position_protection",
                              {
                                quantity: null,
                                stop_loss_price: itemStopLossPrice.trim() || null,
                                take_profit_price: itemTakeProfitPrice.trim() || null,
                                ...legPayload,
                              },
                              t("replay.paper.protectPending"),
                              t("replay.paper.protectOk"),
                            )}
                          >{t("replay.wb.setProtectBtn")}</button>
                          <button
                            type="button"
                            data-replay-action="clear-position-protection"
                            disabled={!commandReady}
                            onClick={() => void runTrade(
                              "set_position_protection",
                              { quantity: null, stop_loss_price: null, take_profit_price: null, ...legPayload },
                              t("replay.paper.clearPending"),
                              t("replay.paper.clearOk"),
                            )}
                          >{t("replay.wb.clearProtect")}</button>
                        </section>
                      )}
                      {contract?.position_mode !== "HEDGE" && <details className="replay-position-disclosure">
                        <summary>{t("replay.wb.more")}</summary>
                        <section className="replay-position-actions">
                          <button
                            type="button"
                            data-replay-action="reverse-position"
                            disabled={!commandReady || !closeQuantity.trim()}
                            onClick={() => void runTrade(
                              "execute_position_intent",
                              {
                                intent: "REVERSE",
                                side: selectedPositionSignedQuantity > 0 ? "SELL" : "BUY",
                                quantity: closeQuantity,
                              },
                              t("replay.paper.reversePending"),
                              t("replay.paper.reverseOk"),
                            )}
                          >{t("replay.wb.reverseTo", { side: selectedPositionSignedQuantity > 0 ? t("replay.wb.short") : t("replay.wb.long") })}</button>
                        </section>
                      </details>}
                    </>
                  )}
                </article>
              );
            })}

            <section className="replay-asset-strip" data-replay-panel="account-assets" aria-label={t("replay.wb.accountAssets")}>
              <header>
                <strong><span className="replay-asset-icon" aria-hidden="true">{settlementAsset.slice(0, 1) || "U"}</span>{settlementAsset || t("replay.wb.assetFallback")}</strong>
                <small>{t("replay.wb.trainAccount")}</small>
              </header>
              <dl className="replay-metric-flat">
                <div><dt>{t("replay.wb.coinEquity")}</dt><dd>{formatDecimal(portfolio?.equity ?? store.account?.equity, 4)}</dd></div>
                <div><dt>{t("replay.wb.used")}</dt><dd>{formatDecimal(portfolio?.margin_used, 4)}</dd></div>
                <div><dt>{t("replay.wb.available")}</dt><dd>{formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 4)}</dd></div>
                <div><dt>{t("replay.wb.floatPnl")}</dt><dd data-value-tone={(finiteNumber(portfolio?.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(portfolio?.unrealized_pnl, 4)}</dd></div>
                <div><dt>{t("replay.wb.riskCover")}</dt><dd>{contract?.risk_ratio == null ? "--" : `${formatDecimal(contract.risk_ratio, 2)}×`}</dd></div>
                <div><dt>{t("replay.wb.levCap")}</dt><dd>{config?.max_leverage ?? "--"}x</dd></div>
                <div className="wide"><dt>{t("replay.wb.balance")}</dt><dd>{formatDecimal(portfolio?.cash_balance ?? store.account?.cash_balance, 4)} {settlementAsset}</dd></div>
              </dl>
            </section>

            <details className="replay-closed-trades">
              <summary>
                <strong>{t("replay.wb.recentClosed")}</strong>
                <span>{closedTrades.length}</span>
                {reportState === "loading" && <small>{t("replay.wb.syncing")}</small>}
              </summary>
              <div className="replay-rail-record-list">
                {recentClosedTrades.length === 0 ? <div className="replay-account-empty compact calm">{t("replay.wb.noClosed")}</div> : recentClosedTrades.map((item) => (
                  <article className="replay-compact-record" key={item.trade_id}>
                    <header><span data-order-side={item.side}>{sideLabel(item.side)} · {formatDecimal(item.quantity)}</span><strong data-value-tone={(finiteNumber(item.realized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(item.realized_pnl, 4)} {settlementAsset}</strong></header>
                    <dl className="replay-metric-flat"><div><dt>{t("replay.wb.openPx")}</dt><dd>{formatDecimal(item.entry_price, 6)}</dd></div><div><dt>{t("replay.wb.closePx")}</dt><dd>{formatDecimal(item.exit_price, 6)}</dd></div></dl>
                  </article>
                ))}
              </div>
            </details>
          </div>
        )}

        {(activeTab === "open-orders" || activeTab === "order-history") && (() => {
          const orders = activeTab === "open-orders" ? openOrders : historicalOrders;
          const page = activeTab === "order-history" && contract !== null
            ? historicalOrderPages
            : null;
          return (
            <div className="replay-rail-account-scroll replay-rail-record-list" data-replay-panel={activeTab}>
              {activeTab === "open-orders" && selectedTrackOpenOrders.length > 0 && (
                <section className="replay-order-batch-actions" aria-label={t("replay.wb.batchCancel")}>
                  <button
                    type="button"
                    disabled={!commandReady || selectedOrderIds.length === 0}
                    onClick={() => void runTrade(
                      "cancel_orders",
                      { scope: "ORDER_IDS", order_ids: [...selectedOrderIds] },
                      t("replay.paper.cancelSelectedPending", { count: selectedOrderIds.length }),
                      t("replay.paper.cancelSelectedOk", { count: selectedOrderIds.length }),
                    )}
                  >{t("replay.wb.cancelSelected", { count: selectedOrderIds.length })}</button>
                  <button
                    type="button"
                    disabled={!commandReady}
                    onClick={() => void runTrade(
                      "cancel_orders",
                      { scope: "SELECTED_TRACK", order_ids: [] },
                      t("replay.paper.cancelSymbolPending", { symbol: selectedSymbol }),
                      t("replay.paper.cancelSymbolOk", { symbol: selectedSymbol }),
                    )}
                  >{t("replay.wb.cancelSymbol")}</button>
                </section>
              )}
              {page?.loading === true && <div className="replay-account-empty calm">{t("replay.wb.loadingHistory")}</div>}
              {page?.error !== null && page !== null && <div className="replay-account-empty calm" role="alert">{t("replay.wb.historyFailed", { error: page.error })}</div>}
              {!page?.loading && orders.length === 0 ? <div className="replay-account-empty calm"><strong>{activeTab === "open-orders" ? t("replay.wb.noOrders") : t("replay.wb.noHistory")}</strong><small>{activeTab === "open-orders" ? t("replay.wb.noOrdersHint") : t("replay.wb.noHistoryHint")}</small></div> : orders.map((order, index) => {
                const orderId = recordText(order, "order_id", `order-${index}`);
                const trackId = recordText(order, "track_id", selectedTrackId);
                const status = recordText(order, "status", "OPEN");
                const timestamp = eventTime(order);
                const editable = !TERMINAL_ORDER_STATES.has(status) && trackId === selectedTrackId;
                const editing = replaceDraft?.trackId === trackId && replaceDraft.orderId === orderId;
                const orderTypeValue = recordText(order, "order_type");
                const orderSide = recordText(order, "side");
                return (
                  <article className="replay-compact-record" key={`${trackId}:${orderId}`} data-order-status={status}>
                    <header>
                      <div>
                        {editable && <input type="checkbox" aria-label={t("replay.wb.selectOrder", { id: orderId })} checked={selectedOrderIds.includes(orderId)} onChange={(event) => toggleSelectedOrder(orderId, event.target.checked)} />}
                        <strong>{symbolForTrack(trackId)}</strong>
                        <div className="replay-badge-row">
                          <span className="replay-chip">{orderTypeLabel(orderTypeValue)}</span>
                          <span className="replay-chip" data-side={orderSide}>{orderSide === "BUY" ? (recordBoolean(order, "reduce_only") ? t("replay.wb.closeShort") : t("replay.wb.openLong")) : (recordBoolean(order, "reduce_only") ? t("replay.wb.closeLong") : t("replay.wb.openShort"))}</span>
                          <span className="replay-chip">{contract?.margin_mode === "ISOLATED" ? t("replay.wb.isolated") : t("replay.wb.cross")}</span>
                          <span className="replay-chip">{config?.max_leverage ?? "--"}x</span>
                          {timestamp !== null && <span className="replay-chip">{time(timestamp)}</span>}
                        </div>
                      </div>
                      <span className="replay-order-status" data-status={status}>{orderStatusLabel(status)}</span>
                    </header>
                    <dl className="replay-metric-flat">
                      <div><dt>{t("replay.wb.orderQty")}</dt><dd>{formatDecimal(recordText(order, "quantity"))}</dd></div>
                      <div><dt>{t("replay.wb.filled")}</dt><dd>{formatDecimal(recordText(order, "filled_quantity", "0"))}</dd></div>
                      <div><dt>{t("replay.wb.orderPrice")}</dt><dd>{formatDecimal(orderPrice(order), 6)}</dd></div>
                    </dl>
                    {editing && replaceDraft !== null && (
                      <div className="replay-order-replace-form">
                        <label>{t("replay.wb.remainQty")}<input inputMode="decimal" value={replaceDraft.quantity} onChange={(event) => setReplaceDraft({ ...replaceDraft, quantity: event.target.value })} /></label>
                        {orderTypeValue !== "MARKET" && <label>{t("replay.wb.newPrice")}<input inputMode="decimal" value={replaceDraft.price} onChange={(event) => setReplaceDraft({ ...replaceDraft, price: event.target.value })} /></label>}
                        <button type="button" disabled={!commandReady || !replaceDraft.quantity.trim() || (orderTypeValue !== "MARKET" && !replaceDraft.price.trim())} onClick={() => replaceOrder(order)}>{t("replay.wb.confirmReplace")}</button>
                        <button type="button" onClick={() => setReplaceDraft(null)}>{t("replay.wb.cancel")}</button>
                      </div>
                    )}
                    {editable && (
                      <div className="replay-order-card-actions">
                        {!editing && (
                          <button type="button" disabled={!commandReady} onClick={() => setReplaceDraft({ trackId, orderId, quantity: recordText(order, "remaining_quantity", recordText(order, "quantity")), price: recordText(order, "limit_price", recordText(order, "stop_price", "")) })}>{t("replay.wb.replace")}</button>
                        )}
                        <button type="button" data-variant="danger" disabled={!commandReady} onClick={() => void runTrade("cancel_order", { order_id: orderId }, t("replay.paper.cancelPending"), t("replay.paper.cancelOk"))}>{t("replay.wb.cancelOrder")}</button>
                      </div>
                    )}
                  </article>
                );
              })}
              {page?.nextCursor !== null && page !== null && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? t("replay.wb.loading") : t("replay.wb.loadMore", { shown: page.items.length, total: page.totalCount })}</button>}
            </div>
          );
        })()}

        {activeTab === "fills" && (
          <div className="replay-rail-account-scroll replay-rail-record-list" data-replay-panel="fills">
            {fillPages.loading && contract !== null && <div className="replay-account-empty calm">{t("replay.wb.loadingFills")}</div>}
            {fillPages.error !== null && contract !== null && <div className="replay-account-empty calm" role="alert">{t("replay.wb.fillsFailed", { error: fillPages.error })}</div>}
            {!fillPages.loading && visibleFills.length === 0 ? <div className="replay-account-empty calm"><strong>{t("replay.wb.noFills")}</strong><small>{t("replay.wb.noFillsHint")}</small></div> : visibleFills.map((fill, index) => {
              const timestamp = eventTime(fill);
              return (
                <article className="replay-compact-record" key={recordText(fill, "fill_id", `fill-${index}`)}>
                  <header><div><strong>{symbolForTrack(recordText(fill, "track_id", selectedTrackId))}</strong><small title={recordText(fill, "reason")}>{recordText(fill, "fill_id", "--")}</small></div><span data-order-side={recordText(fill, "side")}>{sideLabel(recordText(fill, "side"))}</span></header>
                  <div className="replay-record-primary"><b>{formatDecimal(recordText(fill, "quantity"))}</b><small>@ {formatDecimal(recordText(fill, "price"), 6)} · {recordText(fill, "liquidity") === "MAKER" ? t("replay.wb.maker") : t("replay.wb.taker")}</small></div>
                  <dl className="replay-metric-flat"><div><dt>{t("replay.wb.fee")}</dt><dd>{formatDecimal(recordText(fill, "configured_fee", recordText(fill, "fee")), 6)} {settlementAsset}</dd></div><div><dt>{t("replay.wb.time")}</dt><dd>{timestamp === null ? "--" : time(timestamp)}</dd></div></dl>
                </article>
              );
            })}
            {contract !== null && fillPages.nextCursor !== null && <button type="button" disabled={fillPages.loadingMore} onClick={() => void fillPages.loadMore()}>{fillPages.loadingMore ? t("replay.wb.loading") : t("replay.wb.loadMore", { shown: fillPages.items.length, total: fillPages.totalCount })}</button>}
          </div>
        )}

        {activeTab === "assets" && (
          <div className="replay-rail-account-scroll" data-replay-panel="account-assets">
            <section className="replay-asset-strip">
              <header>
                <strong><span className="replay-asset-icon" aria-hidden="true">{settlementAsset.slice(0, 1) || "U"}</span>{settlementAsset || t("replay.wb.assetFallback")}</strong>
                <small>{t("replay.wb.initial", { value: formatDecimal(portfolio?.initial_equity, 2) })}</small>
              </header>
              <dl className="replay-metric-flat">
                <div><dt>{t("replay.wb.coinEquity")}</dt><dd>{formatDecimal(portfolio?.equity, 4)}</dd></div>
                <div><dt>{t("replay.wb.used")}</dt><dd>{formatDecimal(portfolio?.margin_used, 4)}</dd></div>
                <div><dt>{t("replay.wb.available")}</dt><dd>{formatDecimal(portfolio?.available_equity, 4)}</dd></div>
                <div><dt>{t("replay.wb.floatPnl")}</dt><dd data-value-tone={(finiteNumber(portfolio?.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(portfolio?.unrealized_pnl, 4)}</dd></div>
                <div><dt>{t("replay.wb.realized")}</dt><dd>{formatDecimal(portfolio?.realized_pnl, 4)}</dd></div>
                <div><dt>{t("replay.wb.feesPaid")}</dt><dd>{formatDecimal(portfolio?.fees_paid, 6)}</dd></div>
                <div><dt>{t("replay.wb.mm")}</dt><dd>{formatDecimal(contract?.maintenance_margin, 4)}</dd></div>
                <div><dt>{t("replay.wb.riskCover")}</dt><dd>{contract?.risk_ratio == null ? "--" : `${formatDecimal(contract.risk_ratio, 2)}×`}</dd></div>
                <div><dt>{t("replay.hub.funding")}</dt><dd>{formatDecimal(contract?.funding_cashflow, 6)}</dd></div>
              </dl>
            </section>
          </div>
        )}

        {activeTab === "risk" && (
          <div className="replay-risk-dashboard replay-rail-account-scroll" data-replay-panel="account-risk">
            <section className="replay-risk-card">
              <header><strong>{t("replay.wb.rules")}</strong><span className="replay-chip">{contract?.status ?? t("replay.wb.loadingStatus")}</span></header>
              <dl className="replay-metric-flat">
                <div><dt>{t("replay.wb.marginMode")}</dt><dd>{contract?.margin_mode === "ISOLATED" ? t("replay.wb.isolated") : t("replay.wb.cross")}</dd></div>
                <div><dt>{t("replay.wb.execModel")}</dt><dd>{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? t("replay.wb.l2Assist") : t("replay.wb.touchApprox")}</dd></div>
                <div><dt>{t("replay.wb.ledgerDelta")}</dt><dd>{contract === null ? "--" : recordText(contract.ledger, "reconciliation_delta")}</dd></div>
                <div className="wide"><dt>{t("replay.wb.histAccount")}</dt><dd>{contract?.account_history.mode === "HISTORICAL_EXACT" ? t("replay.wb.histExact") : t("replay.wb.priceProxy")}</dd></div>
              </dl>
            </section>
            <section className="replay-risk-card replay-fidelity-panel">
              <header><strong>{t("replay.wb.fidelityBound")}</strong><span className="replay-chip">{contract?.account_history.auditor.status ?? "NOT_RUN"}</span></header>
              <p>{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? t("replay.wb.modelL2") : t("replay.wb.modelNoQueue")}</p>
              <p>{t("replay.wb.markLabel", { value: contract === null ? "--" : recordText(contract.fidelity, "mark") })}</p>
              <p>{t("replay.wb.mmLabel", { value: contract === null
                ? "--"
                : recordText(contract.fidelity, "maintenance_margin") === "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED"
                  ? t("replay.wb.mmLastTier")
                  : recordText(contract.fidelity, "maintenance_margin") === "VERSIONED_MAINTENANCE_TIER_APPLIED"
                    ? t("replay.wb.mmInTier")
                    : t("replay.wb.mmUndeclared") })}</p>
              <p>{t("replay.wb.liqLabel", { value: contract === null
                ? "--"
                : recordText(contract.fidelity, "liquidation_projection") === "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED"
                  ? t("replay.wb.liqLastTier")
                  : recordText(contract.fidelity, "liquidation_projection") === "VERSIONED_MAINTENANCE_TIER_APPLIED"
                    ? t("replay.wb.liqInTier")
                    : t("replay.wb.mmUndeclared") })}</p>
              <button type="button" className="replay-pill-btn" data-replay-action="audit-account" disabled={viewer.viewerPending} onClick={() => void viewer.actions.auditAccount().catch(() => undefined)}>{t("replay.wb.audit")}</button>
            </section>
            {contract !== null && (
              <details className="replay-risk-card replay-ledger-records" open={contract.history.ledger_entries_total > 0}>
                <summary>
                  <strong>{t("replay.wb.ledger")}</strong>
                  <span>{contract.history.ledger_entries_total}</span>
                </summary>
                {ledgerPages.loading && <p>{t("replay.wb.loadingLedger")}</p>}
                {ledgerPages.error !== null && <p role="alert">{t("replay.wb.ledgerFailed", { error: ledgerPages.error })}</p>}
                <div className="replay-rail-record-list">
                  {ledgerPages.items.map((entry, index) => {
                    const timestamp = eventTime(entry) ?? recordNumber(entry, "virtual_time_ms");
                    return (
                      <article className="replay-compact-record" key={recordText(entry, "posting_id", `ledger-${index}`)}>
                        <header><strong>{recordText(entry, "kind")}</strong><span data-value-tone={(finiteNumber(entry.cash_delta) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(entry.cash_delta, 8)} {recordText(entry, "asset", settlementAsset)}</span></header>
                        <small>{recordText(entry, "reference_type")} · {recordText(entry, "reference_id")}</small>
                        <small>{timestamp === null ? "--" : time(timestamp)}</small>
                      </article>
                    );
                  })}
                </div>
                {ledgerPages.nextCursor !== null && <button type="button" className="replay-pill-btn" disabled={ledgerPages.loadingMore} onClick={() => void ledgerPages.loadMore()}>{ledgerPages.loadingMore ? t("replay.wb.loading") : t("replay.wb.loadMore", { shown: ledgerPages.items.length, total: ledgerPages.totalCount })}</button>}
              </details>
            )}
            {contract?.margin_mode === "ISOLATED" && (
              <section className="replay-risk-card replay-isolated-allocation">
                <header><strong>{t("replay.wb.isolatedAlloc")}</strong><small>{selectedSymbol}</small></header>
                {contract.position_mode === "HEDGE" && (
                  <label>{t("replay.wb.posLeg")}
                    <select value={isolatedSide} onChange={(event) => setIsolatedSide(event.target.value as "LONG" | "SHORT")}>
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                  </label>
                )}
                <label>{t("replay.wb.allocAmt")}
                  <span>
                    <input value={isolatedAmount} inputMode="decimal" onChange={(event) => setIsolatedAmount(event.target.value)} />
                    <b>{settlementAsset}</b>
                  </span>
                </label>
                <button type="button" className="replay-pill-btn" disabled={!commandReady || !isolatedAmount.trim()} onClick={() => void viewer.actions.submitTrade("allocate_isolated_margin", { track_id: selectedTrackId, position_side: contract.position_mode === "HEDGE" ? isolatedSide : null, amount: isolatedAmount }).catch(() => undefined)}>{t("replay.wb.setAlloc")}</button>
                <small>{t("replay.wb.current", { value: String(contract.isolated_allocations[contract.position_mode === "HEDGE" ? `${selectedTrackId}:${isolatedSide}` : selectedTrackId] ?? "0"), asset: settlementAsset })}</small>
              </section>
            )}
            <section className="replay-risk-card replay-capability-boundary" data-replay-panel="historical-market-liquidations" data-replay-domain="historical-market-liquidation">
              <header><strong>{t("replay.wb.mktLiq")}</strong><span className="replay-chip">{contract?.liquidation_channels.historical_market.fidelity ?? "UNSUPPORTED_NO_HISTORY"}</span></header>
              <p>{t("replay.wb.mktLiqHint")}</p>
            </section>
            <section className="replay-risk-card" data-replay-panel="simulated-liquidations" data-replay-domain="simulated-account-liquidation">
              <header><strong>{t("replay.wb.simLiq")}</strong><span className="replay-chip">{contract?.liquidations.length ?? 0}</span></header>
              <p>{t("replay.wb.simLiqHint")}</p>
              <ReplayLiquidationTimeline
                cases={contract?.liquidations ?? []}
                formatVirtualTime={time}
              />
              {(contract?.liquidation_recoveries.length ?? 0) > 0 && (
                <details className="replay-liquidation-recoveries">
                  <summary>{t("replay.wb.recoveries", { count: contract?.liquidation_recoveries.length ?? 0 })}</summary>
                  <ReplayLiquidationTimeline
                    cases={contract?.liquidation_recoveries ?? []}
                    formatVirtualTime={time}
                    emptyLabel={t("replay.wb.recoverEmpty")}
                  />
                </details>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}

export function ReplayMarketDataDock({ runtime, viewer, indicatorStatus, formatTime }: ReplayRightRailProps) {
  useLocale();
  const [activeTab, setActiveTab] = useState<MarketTab>("book");
  const store = runtime.store;
  const config = store.sessionConfig;
  const selectedTrackId = viewer.viewerState?.selected_track_id ?? "track-1";
  const selectedTrack = viewer.marketTracks?.tracks.find((item) => item.track_id === selectedTrackId);
  const historicalBook = selectedTrack?.historical_book ?? null;
  const tradeFlow = useReplayTradeFlow({
    runId: viewer.viewerState?.run_id ?? null,
    trackId: selectedTrackId,
    sourceKind: config?.source_kind ?? null,
    revealedSequence: store.sourceSequence,
  });
  const time = (value: number) => formatTime?.(value)
    ?? formatReplayPublicTime(value, { blindMode: config?.blind_mode ?? true, originMs: store.replayStartMs });
  const handleMarketTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, value: MarketTab) => {
    handleTabKeyDown(event, MARKET_TAB_IDS, value, setActiveTab, "data-replay-market-tab");
  };
  return (
    <div className="replay-paper-trading replay-market-context" data-replay-paper-surface="market-data">
      <nav className="replay-market-context-tabs" role="tablist" aria-label={t("replay.dock.marketAria")}>
        {MARKET_TAB_IDS.map((value) => <button key={value} type="button" role="tab" className={activeTab === value ? "active" : ""} aria-selected={activeTab === value} tabIndex={activeTab === value ? 0 : -1} data-replay-market-tab={value} onClick={() => setActiveTab(value)} onKeyDown={(event) => handleMarketTabKeyDown(event, value)}>{marketTabLabel(value)}</button>)}
      </nav>
      <div className="replay-market-context-body" role="tabpanel">
        {activeTab === "book" && (
          <section className="replay-rail-section replay-historical-book" data-replay-panel="historical-book" data-replay-book-status={historicalBook?.status ?? "OFF"}>
            <h2>{t("replay.dock.histL2", { symbol: selectedTrack?.symbol ?? "--" })}</h2>
            {historicalBook === null || historicalBook.status === "OFF" ? <div className="replay-capability-boundary" role="status"><strong>{t("replay.dock.bookOff")}</strong><p>{t("replay.dock.bookOffHint")}</p></div> : historicalBook.status !== "READY" ? <div className="replay-capability-boundary" role="alert"><strong>{t("replay.dock.bookCleared", { status: historicalBook.status })}</strong><p>{historicalBook.message}</p><button type="button" data-replay-action="resync-historical-book" disabled={viewer.viewerPending || viewer.marketTracks?.global_clock?.state !== "PAUSED"} onClick={() => void viewer.actions.resyncHistoricalBook().catch(() => undefined)}>{t("replay.dock.resync")}</button></div> : <><small>{t("replay.dock.l2Ready")}</small><div className="replay-book-columns"><div><h3>{t("replay.dock.bids")}</h3>{historicalBook.bids.map(([levelPrice, levelQuantity]) => <span key={`bid:${levelPrice}`} data-book-side="bid"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div><div><h3>{t("replay.dock.asks")}</h3>{historicalBook.asks.map(([levelPrice, levelQuantity]) => <span key={`ask:${levelPrice}`} data-book-side="ask"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div></div></>}
          </section>
        )}
        {activeTab === "flow" && (
          <section className="replay-rail-section replay-trade-flow" data-replay-panel="trade-flow" data-replay-trade-flow-state={tradeFlow.state}>
            <h2>{t("replay.dock.tapeTitle")}</h2>
            {tradeFlow.state === "UNSUPPORTED_SOURCE_MODE" && <div className="replay-capability-boundary" role="status"><strong>{t("replay.dock.flowOff")}</strong><p>{t("replay.dock.flowOffHint")}</p></div>}
            {tradeFlow.state === "LOADING" && <p className="replay-empty">{t("replay.dock.flowLoading")}</p>}
            {tradeFlow.state === "DEGRADED" && <div className="replay-capability-boundary" role="alert"><strong>{t("replay.dock.flowDegraded")}</strong><p>{tradeFlow.error ?? t("replay.dock.flowFail")}</p></div>}
            {tradeFlow.state === "CONTIGUOUS" && <><dl className="replay-metrics-grid"><div><dt>{t("replay.dock.windowCvd")}</dt><dd>{formatDecimal(tradeFlow.cvd)}</dd></div><div><dt>{t("replay.dock.pageDelta")}</dt><dd>{formatDecimal(tradeFlow.pageDelta)}</dd></div></dl><small>{t("replay.dock.tapeHint", { fidelity: tradeFlow.fidelity })}</small><div className="replay-trade-flow-list">{[...tradeFlow.tape].reverse().map((item) => <article key={item.source_sequence} data-aggressor-side={item.aggressor_side}><strong>{sideLabel(item.aggressor_side)} {formatDecimal(item.quantity)} @ {formatDecimal(item.price, 6)}</strong><span>Δ {formatDecimal(item.cvd_delta)} · agg #{item.agg_trade_id}</span><small>{time(item.trade_time_ms)} · {t("replay.dock.rawAgg", { count: item.raw_trade_count })}</small></article>)}</div></>}
          </section>
        )}
        {activeTab === "indicators" && <section className="replay-rail-section replay-indicator-boundary" data-replay-panel="indicators"><h2>{t("replay.dock.localInd")}</h2><p>{t("replay.dock.localIndHint", { count: indicatorStatus.sourceBarCount })}</p><p>{t("replay.dock.hostedOff")}</p></section>}
      </div>
    </div>
  );
}

export default function ReplayRightRail(props: ReplayRightRailProps) {
  useLocale();
  return <aside className="replay-right-rail" aria-label={t("replay.dock.paperAria")}><ReplayPaperTradingDock {...props} /></aside>;
}
