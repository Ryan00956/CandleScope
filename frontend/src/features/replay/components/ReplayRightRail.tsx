import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

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
const WORKBENCH_TABS = [
  ["positions", "持仓"],
  ["open-orders", "当前"],
  ["order-history", "历史"],
  ["fills", "成交"],
  ["assets", "资产"],
  ["risk", "风险"],
] as const;
const MARKET_TABS = [
  ["book", "盘口"],
  ["flow", "订单流"],
  ["indicators", "指标"],
] as const;

type WorkbenchTab = typeof WORKBENCH_TABS[number][0];
type MarketTab = typeof MARKET_TABS[number][0];
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

const ORDER_TYPE_LABELS: Readonly<Record<string, string>> = {
  MARKET: "市价",
  LIMIT: "限价",
  STOP_MARKET: "止损市价",
  TAKE_PROFIT_MARKET: "止盈市价",
};
const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  OPEN: "等待成交",
  ACCEPTED: "已受理",
  PARTIALLY_FILLED: "部分成交",
  FILLED: "已成交",
  CANCELED: "已撤销",
  REJECTED: "已拒绝",
  EXPIRED: "已失效",
};

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
  return new Intl.NumberFormat("zh-CN", {
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
  return value === "BUY" ? "买入" : value === "SELL" ? "卖出" : value;
}

function orderTypeLabel(value: string): string {
  return ORDER_TYPE_LABELS[value] ?? value;
}

function orderStatusLabel(value: string): string {
  return ORDER_STATUS_LABELS[value] ?? value;
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
    recordText(order, "limit_price", recordText(order, "stop_price", "市价")),
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
        ? "下单尺寸超过当前账户可用保证金"
        : `下单尺寸超过当前可用保证金（可用 ${formatDecimal(available, 4)}）`;
    }
    if (error.code === "RISK_LIMIT_EXCEEDED") return `当前风控上限不允许此订单：${error.message}`;
    if (error.code === "ORDER_REJECTED") return `订单参数未通过校验：${error.message}`;
  }
  return error instanceof Error ? error.message : "命令提交失败，请等待状态收敛后重试";
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
  tabs: readonly (readonly [T, string])[],
  current: T,
  setCurrent: (value: T) => void,
  attribute: string,
) {
  const currentIndex = tabs.findIndex(([tab]) => tab === current);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const next = tabs[nextIndex]?.[0];
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
  const previewKey = JSON.stringify([
    selectedTrackId,
    store.revision,
    store.sourceSequence,
    store.virtualTimeMs,
    previewPositionIntent,
    clientOrderId,
    previewSide,
    orderType,
    quantity,
    reduceOnly,
    price,
    leverage,
    tradePlanDraft,
  ]);
  const maxQuantityContextKey = JSON.stringify([
    selectedTrackId,
    store.revision,
    store.sourceSequence,
    store.virtualTimeMs,
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
      || store.virtualTimeMs === null
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
    capacityScheduler.schedule(maxQuantityContextKey, () => {
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
      if (!settled) capacityScheduler.forget(maxQuantityContextKey);
    };
  }, [
    capacityScheduler,
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
    sizingAvailableEquity,
    store.connectionState,
    store.state,
    store.virtualTimeMs,
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
  const estimatedMaxQuantity = capacity?.max_quantity
    ?? (maxQuantitySnapshot?.key === maxQuantityContextKey
      ? maxQuantitySnapshot.value
      : rebasedMaxQuantity === null
        ? null
        : quantityForStep(rebasedMaxQuantity, quantityStep));
  const sizingAvailability = replayOrderSizingAvailability(estimatedMaxQuantity, quantity);
  const quantityExceedsCapacity = sizingAvailability.quantityExceedsCapacity;
  useEffect(() => {
    if (
      !viewerReady
      || store.connectionState !== "connected"
      || store.state !== "PAUSED"
      || store.virtualTimeMs === null
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
    previewScheduler.schedule(previewKey, () => {
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
      if (!settled) previewScheduler.forget(previewKey);
    };
  }, [
    clientOrderId,
    capacityReadyKey,
    leverage,
    orderType,
    positionMode,
    activePositionSide,
    previewOrder,
    previewPositionIntent,
    price,
    previewScheduler,
    previewKey,
    quantity,
    reduceOnly,
    riskValue,
    selectedTrackId,
    previewSide,
    store.connectionState,
    store.revision,
    store.sourceSequence,
    store.state,
    store.virtualTimeMs,
    targetPrice,
    tradePlanDraft,
    tradeReason,
    tradeValidationSide,
    invalidationPrice,
    maxQuantityContextKey,
    maxQuantitySizingKey,
    quantityExceedsCapacity,
    sizingAvailableEquity,
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
    ? `输入尺寸超过当前上限；最多可下 ${formatDecimal(estimatedMaxQuantity, 8)} ${quantityAsset}`
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
    ? "商品数量"
    : sizeMode === "MARGIN"
      ? "保证金"
      : "名义金额";

  const ctaEnabled = (nextSide: "BUY" | "SELL"): { enabled: boolean; title: string } => {
    if (positionMode === "HEDGE") {
      if (!reduceOnly) return { enabled: true, title: "" };
      const targetSide = nextSide === "BUY" ? "SHORT" : "LONG";
      const target = portfolio?.positions.find((item) => (
        item.track_id === selectedTrackId && item.position_side === targetSide
      ));
      return target === undefined
        ? { enabled: false, title: targetSide === "LONG" ? "无多仓可平" : "无空仓可平" }
        : { enabled: true, title: "" };
    }
    if (reduceOnly) {
      if (positionSide === "flat") {
        return { enabled: false, title: "无持仓可平" };
      }
      if (positionSide === "long") {
        return nextSide === "SELL"
          ? { enabled: true, title: "" }
          : { enabled: false, title: "多仓仅可卖出平多" };
      }
      return nextSide === "BUY"
        ? { enabled: true, title: "" }
        : { enabled: false, title: "空仓仅可买入平空" };
    }
    if (positionSide === "long" && nextSide === "SELL") {
      return { enabled: false, title: "已有多仓：反向请用仓位·反手或先平仓" };
    }
    if (positionSide === "short" && nextSide === "BUY") {
      return { enabled: false, title: "已有空仓：反向请用仓位·反手或先平仓" };
    }
    return { enabled: true, title: "" };
  };

  const ctaLabel = (nextSide: "BUY" | "SELL"): string => {
    if (reduceOnly) {
      return nextSide === "BUY" ? "买入平空" : "卖出平多";
    }
    if (isSpot) {
      return nextSide === "BUY" ? `买入 ${quantityAsset}` : `卖出 ${quantityAsset}`;
    }
    return nextSide === "BUY" ? `开多 ${leverage}x` : `开空 ${leverage}x`;
  };

  const placeOrderWithSide = async (nextSide: "BUY" | "SELL") => {
    const gate = ctaEnabled(nextSide);
    if (
      !gate.enabled
      || !commandReady
      || tradeValidationControllerRef.current !== null
    ) return;
    if (!quantity.trim() || (orderType !== "MARKET" && !price.trim())) {
      setNotice({ tone: "error", message: "请填写有效尺寸与价格后再提交" });
      return;
    }
    if (leverage < 1 || leverage > maxLeverage) {
      setNotice({ tone: "error", message: `杠杆须在 1–${maxLeverage}x 之间` });
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
        new DOMException("下单校验超时，请重试", "TimeoutError"),
      );
    }, REPLAY_ORDER_VALIDATION_TIMEOUT_MS);
    setNotice({ tone: "pending", message: "正在获取同侧可下上限…" });
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
          message: `输入尺寸超过当前上限；最多可下 ${formatDecimal(sideCapacity.max_quantity, 8)} ${quantityAsset}`,
        });
        return;
      }
      setNotice({ tone: "pending", message: "正在校验同侧预览…" });
      const sidePreview = await previewOrder(
        order,
        intent,
        planForSide,
        validationController.signal,
      );
      if (sidePreview.order.side !== nextSide) {
        setNotice({ tone: "error", message: "预览方向与提交方向不一致，已取消提交" });
        return;
      }
      if (
        sidePreview.cursor.revision !== store.revision
        || sidePreview.cursor.source_sequence !== store.sourceSequence
        || sidePreview.cursor.virtual_time_ms !== store.virtualTimeMs
      ) {
        setNotice({ tone: "error", message: "行情游标已变化，请重试提交" });
        return;
      }
      setNotice({ tone: "pending", message: "正在提交纸面委托…" });
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
      setNotice({ tone: "success", message: "委托命令已受理，账户与交易记录已刷新" });
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
  const submitting = viewer.viewerPending || tradeValidationSide !== null;
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
          <small>{symbol} · {isSpot ? "现货" : "合约回放"}</small>
          <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 4)} {settlementAsset}</strong>
        </div>
        <div className="replay-ticket-locks" aria-label="保证金与杠杆">
          <span>{positionMode === "HEDGE" ? "双向" : "单向"}</span>
          <span>{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"}</span>
          <label className="replay-leverage-control">
            <span className="sr-only">杠杆</span>
            <select
              value={String(leverage)}
              aria-label={`杠杆，最高 ${maxLeverage}x`}
              onChange={(event) => setLeverage(Math.min(maxLeverage, Math.max(1, Number(event.target.value) || 1)))}
            >
              {leverageOptions.map((value) => (
                <option key={value} value={value}>{value}x</option>
              ))}
            </select>
          </label>
          <span title="本局最高杠杆上限">≤{maxLeverage}x</span>
        </div>
      </header>

      <section className="replay-compact-ticket" data-replay-panel="order-ticket">
        <div className="replay-mode-toggle" role="group" aria-label="开仓或平仓">
          <button
            type="button"
            data-mode="open"
            className={!reduceOnly ? "active" : ""}
            onClick={() => setReduceOnly(false)}
          >开仓</button>
          <button
            type="button"
            data-mode="close"
            className={reduceOnly ? "active" : ""}
            onClick={() => setReduceOnly(true)}
          >平仓</button>
        </div>

        <div className="replay-order-fidelity-row">
          <span data-fidelity={contract?.execution_fidelity ?? "LOADING"}>
            {contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE"
              ? "历史 L2 辅助 · 无队列"
              : "近似成交 · 无盘口排队"}
          </span>
          <small>可用 {formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 4)} {settlementAsset}</small>
        </div>

        <label className="replay-ticket-type">委托类型
          <select value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}>
            <option value="MARKET">市价委托</option>
            <option value="LIMIT">限价委托</option>
            <option value="STOP_MARKET">止损市价</option>
            <option value="TAKE_PROFIT_MARKET">止盈市价</option>
          </select>
        </label>

        <div className="replay-size-mode" role="group" aria-label="下单尺寸口径">
          {([
            ["QUANTITY", "数量"],
            ["MARGIN", "保证金"],
            ["NOTIONAL", "名义"],
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
            <label>{orderType === "LIMIT" ? "委托价格" : "触发价格"}
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
            ≈ 数量 {quantity || "--"} {quantityAsset}
            {refForSize !== null ? ` · 参考价 ${formatDecimal(refForSize, 6)}` : ""}
          </small>
        )}

        <div
          className="replay-size-slider"
          aria-label="仓位比例"
          style={{ ["--replay-size-pct" as string]: `${displaySizeShare}%` }}
        >
          <input
            type="range"
            aria-label="下单金额快速选择"
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
              参考可下 {maxSizeValue === null ? "--" : formatDecimal(maxSizeValue, sizeMode === "QUANTITY" ? 8 : 2)} {sizeUnit}
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
              按风险计划反算
            </label>
          </summary>
          {tradePlanEnabled && tradePlanEligible && (
            <div className="replay-trade-plan-fields">
              <label>风险口径
                <select
                  value={riskSizingMode}
                  onChange={(event) => setRiskSizingMode(event.target.value as typeof riskSizingMode)}
                >
                  <option value="ACCOUNT_RISK_PERCENT">账户风险百分比</option>
                  <option value="RISK_AMOUNT">最大亏损金额</option>
                </select>
              </label>
              <label>{riskSizingMode === "RISK_AMOUNT" ? "最大亏损" : "账户风险"}
                <span>
                  <input value={riskValue} inputMode="decimal" onChange={(event) => setRiskValue(event.target.value)} />
                  <b>{riskSizingMode === "RISK_AMOUNT" ? settlementAsset : "%"}</b>
                </span>
              </label>
              <label>失效价
                <span><input value={invalidationPrice} inputMode="decimal" onChange={(event) => setInvalidationPrice(event.target.value)} /><b>{settlementAsset}</b></span>
              </label>
              <label>目标价
                <span><input value={targetPrice} inputMode="decimal" onChange={(event) => setTargetPrice(event.target.value)} /><b>{settlementAsset}</b></span>
              </label>
              <label className="replay-trade-plan-reason">交易理由
                <textarea value={tradeReason} maxLength={500} onChange={(event) => setTradeReason(event.target.value)} placeholder="入场依据与失效条件" />
              </label>
              <dl className="replay-order-preview" aria-label="交易计划预览">
                <div><dt>反算数量</dt><dd>{preview?.trade_plan?.quantity ?? "--"} {quantityAsset}</dd></div>
                <div><dt>计划风险</dt><dd>{preview?.trade_plan?.risk_amount ?? "--"} {settlementAsset}</dd></div>
                <div><dt>预期 R:R</dt><dd>{preview?.trade_plan?.reward_risk_ratio ?? "--"}</dd></div>
              </dl>
              <small>订单受理后，计划快照与哈希写入不可变复盘日志。</small>
            </div>
          )}
        </details>

        <dl className="replay-order-preview" aria-label="订单参考预览">
          <div><dt>名义价值</dt><dd>{previewPending ? "校验中…" : `${formatDecimal(preview?.estimated_notional, 2)} ${settlementAsset}`}</dd></div>
          <div><dt>保证金</dt><dd>{formatDecimal(preview?.reserved_margin, 2)} {settlementAsset}</dd></div>
          <div><dt>手续费上限</dt><dd>{formatDecimal(preview?.estimated_fee, 4)} {settlementAsset}</dd></div>
        </dl>

        <div className="replay-dual-cta">
          <button
            type="button"
            className="replay-submit-order"
            data-side="BUY"
            data-replay-action="place-order"
            title={buyGate.title || undefined}
            disabled={!commandReady || submitting || capacityPending || quantityExceedsCapacity || !buyGate.enabled || !quantity.trim() || (orderType !== "MARKET" && !price.trim())}
            onClick={() => void placeOrderWithSide("BUY")}
          >{submitting && (side === "BUY" || tradeValidationSide === "BUY") ? "提交中…" : ctaLabel("BUY")}</button>
          <button
            type="button"
            className="replay-submit-order"
            data-side="SELL"
            data-replay-action="place-order"
            title={sellGate.title || undefined}
            disabled={!commandReady || submitting || capacityPending || quantityExceedsCapacity || !sellGate.enabled || !quantity.trim() || (orderType !== "MARKET" && !price.trim())}
            onClick={() => void placeOrderWithSide("SELL")}
          >{submitting && (side === "SELL" || tradeValidationSide === "SELL") ? "提交中…" : ctaLabel("SELL")}</button>
        </div>

        <div id="replay-order-size-feedback" className="replay-trade-notice" role={notice?.tone === "error" || capacityValidationError !== null || reduceOnlyUnavailableMessage !== null ? "alert" : "status"} aria-live="polite" data-tone={notice?.tone ?? (capacityValidationError !== null || capacityError !== null || reduceOnlyUnavailableMessage !== null ? "error" : "idle")}>
          {notice?.message ?? reduceOnlyUnavailableMessage ?? capacityValidationError ?? capacityError ?? previewError ?? viewer.error ?? "提交前会按点击方向重新校验游标、保证金与数量上限。"}
        </div>
      </section>
    </div>
    </div>
  );
}

export function ReplayTradingWorkbench({ runtime, viewer, formatTime }: ReplayRightRailProps) {
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
      setNotice({ tone: "error", message: `已平仓记录同步失败：${commandErrorMessage(error)}` });
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
      "正在原子替换委托…",
      "委托已替换；旧单已进入历史",
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
    handleTabKeyDown(event, WORKBENCH_TABS, value, setActiveTab, "data-replay-rail-tab");
  };

  return (
    <section className="replay-trading-workbench" data-replay-workbench="rail" aria-label="回放交易账户">
      <header className="replay-workbench-header">
        <div className="replay-workbench-summary">
          <span>
            <small>账户权益</small>
            <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 2)} {settlementAsset}</strong>
          </span>
          <span>
            <small>可用</small>
            <strong>{formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 2)}</strong>
          </span>
          {warningCount > 0 && <span data-tone="warning">执行警告 {warningCount}</span>}
        </div>
        <nav className="replay-workbench-tabs" aria-label="训练账户记录" role="tablist">
          {WORKBENCH_TABS.map(([value, label]) => (
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
              {label}
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
                当前交易品种
              </label>
              <small>{selectedSymbol}</small>
            </div>
            {portfolioPositions.length === 0 ? (
              <div className="replay-account-empty calm"><strong>暂无持仓</strong><small>开仓后会在这里显示方向、盈亏、保证金和快捷平仓。</small></div>
            ) : visiblePositions.length === 0 ? (
              <div className="replay-account-empty calm"><strong>当前品种无持仓</strong><small>取消「当前交易品种」可查看全部组合仓位。</small></div>
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
                ? "未声明维持保证金档位外推状态。"
                : maintenanceTierExtrapolated
                ? `仓位名义价值已超过固定规则的末档上限 ${item.maintenance_margin_proof?.last_tier_notional_cap ?? "--"}；当前维持保证金沿用末档费率和速算扣除数外推，不是交易所发布的额外档位。`
                : "维持保证金使用固定的版本化档位规则。";
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
                        <span className="replay-chip" data-side={positionSide}>{positionSide === "long" ? "多" : "空"}</span>
                        <span className="replay-chip">{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"}</span>
                        <span className="replay-chip" title="逐腿有效杠杆">{item.leverage ?? config?.max_leverage ?? "--"}x</span>
                      </div>
                    </div>
                    <div className="replay-position-pnl">
                      <small>收益额 ({settlementAsset})</small>
                      <b data-value-tone={uPnl >= 0 ? "positive" : "negative"}>{formatDecimal(item.position.unrealized_pnl, 4)}</b>
                    </div>
                  </header>
                  <dl className="replay-metric-flat">
                     <div><dt>持仓量 ({itemQtyAsset})</dt><dd>{formatDecimal(Math.abs(quantityValue))}</dd></div>
                     <div><dt>初始保证金</dt><dd>{formatDecimal(item.initial_margin, 4)}</dd></div>
                     <div title={maintenanceProofTitle}><dt>维持保证金{maintenanceTierExtrapolated ? "（末档外推≈）" : ""}</dt><dd>{formatDecimal(item.maintenance_margin, 4)}</dd></div>
                     <div><dt>风险覆盖</dt><dd>{item.risk_ratio == null ? "--" : `${formatDecimal(item.risk_ratio, 2)}×`}</dd></div>
                     <div><dt>开仓均价</dt><dd>{formatDecimal(item.position.entry_price, 6)}</dd></div>
                     <div>
                       <dt title={item.mark_fidelity ?? "未声明标记价格来源"}>标记价格（{replayMarkFidelityLabel(item.mark_fidelity)}）</dt>
                       <dd>{formatDecimal(replayPositiveModelPrice(item.position.mark_price), 6)}</dd>
                     </div>
                     <div><dt>逐腿杠杆</dt><dd>{formatDecimal(item.leverage, 2)}x</dd></div>
                     <div title={liquidationTierExtrapolated
                       ? `强平价搜索超过固定规则的末档上限 ${item.maintenance_margin_proof?.last_tier_notional_cap ?? "--"}；越界候选价沿用末档费率和速算扣除数外推。`
                       : "模拟账户风险模型；不是历史交易所精确值"}><dt>强平价格（模拟≈{liquidationTierExtrapolated ? "，末档外推" : ""}）</dt><dd>{formatDecimal(replayPositiveModelPrice(item.liquidation_price), 6)}</dd></div>
                     <div title="模拟账户风险模型；不是历史交易所精确值"><dt>破产价格（模拟≈）</dt><dd>{formatDecimal(replayPositiveModelPrice(item.bankruptcy_price), 6)}</dd></div>
                     <div><dt>累计资金费</dt><dd>{formatDecimal(item.accumulated_funding, 8)}</dd></div>
                     <div className="wide"><dt>保护单</dt><dd>{protectionOrders.length === 0
                       ? "无"
                       : protectionOrders.map((order) => `${order.order_type === "STOP_MARKET" ? "止损" : "止盈"} ${formatDecimal(order.stop_price, 6)}`).join(" · ")}</dd></div>
                    {marginLabel !== null && (
                      <div className="wide"><dt>保证金权益</dt><dd>{formatDecimal(marginLabel, 4)} {settlementAsset}</dd></div>
                    )}
                  </dl>
                  {!selected && (
                    <button type="button" disabled={viewer.viewerPending} onClick={() => void viewer.actions.selectTrack(item.track_id).catch(() => undefined)}>
                      切换到该轨道管理
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
                          >调杠杆</button>
                        )}
                        <button
                          type="button"
                          className={`replay-pill-btn${showProtection ? " active" : ""}`}
                          aria-expanded={showProtection}
                          onClick={() => togglePositionPanel(item.track_id, "protection", hedgePositionSide)}
                        >止盈止损</button>
                        <button
                          type="button"
                          className={`replay-pill-btn${showClose ? " active" : ""}`}
                          aria-expanded={showClose}
                          onClick={() => togglePositionPanel(item.track_id, "close", hedgePositionSide)}
                        >平仓</button>
                        <button
                          type="button"
                          className="replay-pill-btn"
                          data-variant="danger"
                          data-replay-action="close-position"
                          disabled={!commandReady}
                          onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: null, ...legPayload }, "正在提交全部平仓命令…", "全部平仓命令已受理")}
                        >市价全平</button>
                      </div>
                      {showClose && (
                        <section className="replay-position-actions">
                          <header><strong>平仓数量</strong><small>确认后按已揭示参考价提交</small></header>
                          <label>数量 <span><input ref={closeQtyInputRef} value={itemCloseQuantity} inputMode="decimal" onChange={(event) => setCloseDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), value: event.target.value })} aria-label="平仓数量" /><b>{itemQtyAsset}</b></span></label>
                          <div>{[0.25, 0.5, 1].map((share) => <button type="button" key={share} onClick={() => setCloseDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), value: quantityForStep(Math.abs(quantityValue) * share, quantityStep) })}>{share * 100}%</button>)}</div>
                          <button
                            type="button"
                            data-replay-action="close-partial"
                            disabled={!commandReady || !itemCloseQuantity.trim()}
                            onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: itemCloseQuantity, ...legPayload }, "正在提交平仓命令…", "平仓命令已受理，组合已刷新")}
                          >确认平仓</button>
                        </section>
                      )}
                      {showLeverage && hedgePositionSide !== undefined && (
                        <section className="replay-position-actions">
                          <header><strong>逐腿杠杆</strong><small>{hedgePositionSide} 独立生效</small></header>
                          <label>杠杆 <span><input value={itemLeverage} inputMode="decimal" onChange={(event) => setLeverageDraft({ trackId: item.track_id, positionSide: hedgePositionSide, value: event.target.value })} aria-label="逐腿杠杆" /><b>x</b></span></label>
                          <button
                            type="button"
                            data-replay-action="set-position-leverage"
                            disabled={!commandReady || !itemLeverage.trim()}
                            onClick={() => void runTrade(
                              "set_position_leverage",
                              { position_side: hedgePositionSide, leverage: itemLeverage },
                              `正在调整 ${hedgePositionSide} 杠杆…`,
                              `${hedgePositionSide} 杠杆已更新`,
                            )}
                          >确认调整</button>
                        </section>
                      )}
                      {showProtection && (
                        <section className="replay-position-actions">
                          <header><strong>仓位保护</strong><small>止盈止损价格</small></header>
                          <label>止损价 <span><input value={itemStopLossPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), stopLoss: event.target.value, takeProfit: itemTakeProfitPrice })} aria-label="止损价格" /><b>{settlementAsset}</b></span></label>
                          <label>止盈价 <span><input value={itemTakeProfitPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, ...(hedgePositionSide === undefined ? {} : { positionSide: hedgePositionSide }), stopLoss: itemStopLossPrice, takeProfit: event.target.value })} aria-label="止盈价格" /><b>{settlementAsset}</b></span></label>
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
                              "正在原子替换止盈止损…",
                              "仓位保护已更新",
                            )}
                          >设置止盈止损</button>
                          <button
                            type="button"
                            data-replay-action="clear-position-protection"
                            disabled={!commandReady}
                            onClick={() => void runTrade(
                              "set_position_protection",
                              { quantity: null, stop_loss_price: null, take_profit_price: null, ...legPayload },
                              "正在清除仓位保护…",
                              "仓位保护已清除",
                            )}
                          >清除止盈止损</button>
                        </section>
                      )}
                      {contract?.position_mode !== "HEDGE" && <details className="replay-position-disclosure">
                        <summary>更多操作</summary>
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
                              "正在原子平仓并反向开仓…",
                              "反手命令已完成，组合已刷新",
                            )}
                          >反手为{selectedPositionSignedQuantity > 0 ? "空" : "多"}</button>
                        </section>
                      </details>}
                    </>
                  )}
                </article>
              );
            })}

            <section className="replay-asset-strip" data-replay-panel="account-assets" aria-label="账户资产">
              <header>
                <strong><span className="replay-asset-icon" aria-hidden="true">{settlementAsset.slice(0, 1) || "U"}</span>{settlementAsset || "资产"}</strong>
                <small>训练账户</small>
              </header>
              <dl className="replay-metric-flat">
                <div><dt>币种权益</dt><dd>{formatDecimal(portfolio?.equity ?? store.account?.equity, 4)}</dd></div>
                <div><dt>占用</dt><dd>{formatDecimal(portfolio?.margin_used, 4)}</dd></div>
                <div><dt>可用</dt><dd>{formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 4)}</dd></div>
                <div><dt>浮动收益</dt><dd data-value-tone={(finiteNumber(portfolio?.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(portfolio?.unrealized_pnl, 4)}</dd></div>
                <div><dt>风险覆盖</dt><dd>{contract?.risk_ratio == null ? "--" : `${formatDecimal(contract.risk_ratio, 2)}×`}</dd></div>
                <div><dt>杠杆上限</dt><dd>{config?.max_leverage ?? "--"}x</dd></div>
                <div className="wide"><dt>余额</dt><dd>{formatDecimal(portfolio?.cash_balance ?? store.account?.cash_balance, 4)} {settlementAsset}</dd></div>
              </dl>
            </section>

            <details className="replay-closed-trades">
              <summary>
                <strong>最近已平仓</strong>
                <span>{closedTrades.length}</span>
                {reportState === "loading" && <small>同步中…</small>}
              </summary>
              <div className="replay-rail-record-list">
                {recentClosedTrades.length === 0 ? <div className="replay-account-empty compact calm">暂无已平仓交易</div> : recentClosedTrades.map((item) => (
                  <article className="replay-compact-record" key={item.trade_id}>
                    <header><span data-order-side={item.side}>{sideLabel(item.side)} · {formatDecimal(item.quantity)}</span><strong data-value-tone={(finiteNumber(item.realized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(item.realized_pnl, 4)} {settlementAsset}</strong></header>
                    <dl className="replay-metric-flat"><div><dt>开仓</dt><dd>{formatDecimal(item.entry_price, 6)}</dd></div><div><dt>平仓</dt><dd>{formatDecimal(item.exit_price, 6)}</dd></div></dl>
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
                <section className="replay-order-batch-actions" aria-label="批量撤单">
                  <button
                    type="button"
                    disabled={!commandReady || selectedOrderIds.length === 0}
                    onClick={() => void runTrade(
                      "cancel_orders",
                      { scope: "ORDER_IDS", order_ids: [...selectedOrderIds] },
                      `正在批量撤销 ${selectedOrderIds.length} 笔委托…`,
                      `${selectedOrderIds.length} 笔委托已原子撤销`,
                    )}
                  >撤销已选（{selectedOrderIds.length}）</button>
                  <button
                    type="button"
                    disabled={!commandReady}
                    onClick={() => void runTrade(
                      "cancel_orders",
                      { scope: "SELECTED_TRACK", order_ids: [] },
                      `正在撤销 ${selectedSymbol} 全部当前委托…`,
                      `${selectedSymbol} 当前委托已全部撤销`,
                    )}
                  >撤销当前品种全部</button>
                </section>
              )}
              {page?.loading === true && <div className="replay-account-empty calm">正在读取历史委托…</div>}
              {page?.error !== null && page !== null && <div className="replay-account-empty calm" role="alert">历史委托读取失败：{page.error}</div>}
              {!page?.loading && orders.length === 0 ? <div className="replay-account-empty calm"><strong>{activeTab === "open-orders" ? "暂无委托" : "暂无历史委托"}</strong><small>{activeTab === "open-orders" ? "限价单提交后会显示在这里。" : "已撤销与已成交委托会出现在这里。"}</small></div> : orders.map((order, index) => {
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
                        {editable && <input type="checkbox" aria-label={`选择委托 ${orderId}`} checked={selectedOrderIds.includes(orderId)} onChange={(event) => toggleSelectedOrder(orderId, event.target.checked)} />}
                        <strong>{symbolForTrack(trackId)}</strong>
                        <div className="replay-badge-row">
                          <span className="replay-chip">{orderTypeLabel(orderTypeValue)}</span>
                          <span className="replay-chip" data-side={orderSide}>{orderSide === "BUY" ? (recordBoolean(order, "reduce_only") ? "平空" : "开多") : (recordBoolean(order, "reduce_only") ? "平多" : "开空")}</span>
                          <span className="replay-chip">{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"}</span>
                          <span className="replay-chip">{config?.max_leverage ?? "--"}x</span>
                          {timestamp !== null && <span className="replay-chip">{time(timestamp)}</span>}
                        </div>
                      </div>
                      <span className="replay-order-status" data-status={status}>{orderStatusLabel(status)}</span>
                    </header>
                    <dl className="replay-metric-flat">
                      <div><dt>委托数量</dt><dd>{formatDecimal(recordText(order, "quantity"))}</dd></div>
                      <div><dt>已成交</dt><dd>{formatDecimal(recordText(order, "filled_quantity", "0"))}</dd></div>
                      <div><dt>委托价格</dt><dd>{formatDecimal(orderPrice(order), 6)}</dd></div>
                    </dl>
                    {editing && replaceDraft !== null && (
                      <div className="replay-order-replace-form">
                        <label>剩余委托量<input inputMode="decimal" value={replaceDraft.quantity} onChange={(event) => setReplaceDraft({ ...replaceDraft, quantity: event.target.value })} /></label>
                        {orderTypeValue !== "MARKET" && <label>新委托价<input inputMode="decimal" value={replaceDraft.price} onChange={(event) => setReplaceDraft({ ...replaceDraft, price: event.target.value })} /></label>}
                        <button type="button" disabled={!commandReady || !replaceDraft.quantity.trim() || (orderTypeValue !== "MARKET" && !replaceDraft.price.trim())} onClick={() => replaceOrder(order)}>确认改单</button>
                        <button type="button" onClick={() => setReplaceDraft(null)}>取消</button>
                      </div>
                    )}
                    {editable && (
                      <div className="replay-order-card-actions">
                        {!editing && (
                          <button type="button" disabled={!commandReady} onClick={() => setReplaceDraft({ trackId, orderId, quantity: recordText(order, "remaining_quantity", recordText(order, "quantity")), price: recordText(order, "limit_price", recordText(order, "stop_price", "")) })}>改单</button>
                        )}
                        <button type="button" data-variant="danger" disabled={!commandReady} onClick={() => void runTrade("cancel_order", { order_id: orderId }, "正在撤销委托…", "委托已撤销并移入历史")}>撤单</button>
                      </div>
                    )}
                  </article>
                );
              })}
              {page?.nextCursor !== null && page !== null && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? "加载中…" : `加载更多（已显示 ${page.items.length}/${page.totalCount}）`}</button>}
            </div>
          );
        })()}

        {activeTab === "fills" && (
          <div className="replay-rail-account-scroll replay-rail-record-list" data-replay-panel="fills">
            {fillPages.loading && contract !== null && <div className="replay-account-empty calm">正在读取成交记录…</div>}
            {fillPages.error !== null && contract !== null && <div className="replay-account-empty calm" role="alert">成交记录读取失败：{fillPages.error}</div>}
            {!fillPages.loading && visibleFills.length === 0 ? <div className="replay-account-empty calm"><strong>暂无成交</strong><small>成交后会显示价格、数量与手续费。</small></div> : visibleFills.map((fill, index) => {
              const timestamp = eventTime(fill);
              return (
                <article className="replay-compact-record" key={recordText(fill, "fill_id", `fill-${index}`)}>
                  <header><div><strong>{symbolForTrack(recordText(fill, "track_id", selectedTrackId))}</strong><small title={recordText(fill, "reason")}>{recordText(fill, "fill_id", "--")}</small></div><span data-order-side={recordText(fill, "side")}>{sideLabel(recordText(fill, "side"))}</span></header>
                  <div className="replay-record-primary"><b>{formatDecimal(recordText(fill, "quantity"))}</b><small>@ {formatDecimal(recordText(fill, "price"), 6)} · {recordText(fill, "liquidity") === "MAKER" ? "挂单" : "吃单"}</small></div>
                  <dl className="replay-metric-flat"><div><dt>手续费</dt><dd>{formatDecimal(recordText(fill, "configured_fee", recordText(fill, "fee")), 6)} {settlementAsset}</dd></div><div><dt>时间</dt><dd>{timestamp === null ? "--" : time(timestamp)}</dd></div></dl>
                </article>
              );
            })}
            {contract !== null && fillPages.nextCursor !== null && <button type="button" disabled={fillPages.loadingMore} onClick={() => void fillPages.loadMore()}>{fillPages.loadingMore ? "加载中…" : `加载更多（已显示 ${fillPages.items.length}/${fillPages.totalCount}）`}</button>}
          </div>
        )}

        {activeTab === "assets" && (
          <div className="replay-rail-account-scroll" data-replay-panel="account-assets">
            <section className="replay-asset-strip">
              <header>
                <strong><span className="replay-asset-icon" aria-hidden="true">{settlementAsset.slice(0, 1) || "U"}</span>{settlementAsset || "资产"}</strong>
                <small>初始 {formatDecimal(portfolio?.initial_equity, 2)}</small>
              </header>
              <dl className="replay-metric-flat">
                <div><dt>币种权益</dt><dd>{formatDecimal(portfolio?.equity, 4)}</dd></div>
                <div><dt>占用</dt><dd>{formatDecimal(portfolio?.margin_used, 4)}</dd></div>
                <div><dt>可用</dt><dd>{formatDecimal(portfolio?.available_equity, 4)}</dd></div>
                <div><dt>浮动收益</dt><dd data-value-tone={(finiteNumber(portfolio?.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(portfolio?.unrealized_pnl, 4)}</dd></div>
                <div><dt>已实现</dt><dd>{formatDecimal(portfolio?.realized_pnl, 4)}</dd></div>
                <div><dt>累计手续费</dt><dd>{formatDecimal(portfolio?.fees_paid, 6)}</dd></div>
                <div><dt>维持保证金</dt><dd>{formatDecimal(contract?.maintenance_margin, 4)}</dd></div>
                <div><dt>风险覆盖</dt><dd>{contract?.risk_ratio == null ? "--" : `${formatDecimal(contract.risk_ratio, 2)}×`}</dd></div>
                <div><dt>资金费</dt><dd>{formatDecimal(contract?.funding_cashflow, 6)}</dd></div>
              </dl>
            </section>
          </div>
        )}

        {activeTab === "risk" && (
          <div className="replay-risk-dashboard replay-rail-account-scroll" data-replay-panel="account-risk">
            <section className="replay-risk-card">
              <header><strong>账户规则</strong><span className="replay-chip">{contract?.status ?? "加载中"}</span></header>
              <dl className="replay-metric-flat">
                <div><dt>保证金模式</dt><dd>{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"}</dd></div>
                <div><dt>执行模型</dt><dd>{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? "L2 辅助" : "触价近似"}</dd></div>
                <div><dt>账本差异</dt><dd>{contract === null ? "--" : recordText(contract.ledger, "reconciliation_delta")}</dd></div>
                <div className="wide"><dt>历史账户输入</dt><dd>{contract?.account_history.mode === "HISTORICAL_EXACT" ? "已固定历史归档" : "已揭示价格代理"}</dd></div>
              </dl>
            </section>
            <section className="replay-risk-card replay-fidelity-panel">
              <header><strong>精度边界</strong><span className="replay-chip">{contract?.account_history.auditor.status ?? "NOT_RUN"}</span></header>
              <p>当前模型{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? "使用连续历史盘口辅助，但仍不含真实队列位置。" : "不含盘口排队，并按已揭示价格保守模拟成交。"}</p>
              <p>Mark：{contract === null ? "--" : recordText(contract.fidelity, "mark")}</p>
              <p>维持保证金：{contract === null
                ? "--"
                : recordText(contract.fidelity, "maintenance_margin") === "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED"
                  ? "存在仓位超过历史末档，按末档费率和速算扣除数外推≈"
                  : recordText(contract.fidelity, "maintenance_margin") === "VERSIONED_MAINTENANCE_TIER_APPLIED"
                    ? "全部仓位位于固定规则档位内"
                    : "未声明档位外推状态"}</p>
              <p>强平投影：{contract === null
                ? "--"
                : recordText(contract.fidelity, "liquidation_projection") === "LAST_MAINTENANCE_TIER_RATE_DEDUCTION_EXTRAPOLATED"
                  ? "至少一个候选强平价越过历史末档，末档外推≈"
                  : recordText(contract.fidelity, "liquidation_projection") === "VERSIONED_MAINTENANCE_TIER_APPLIED"
                    ? "候选强平价位于固定规则档位内"
                    : "未声明档位外推状态"}</p>
              <button type="button" className="replay-pill-btn" data-replay-action="audit-account" disabled={viewer.viewerPending} onClick={() => void viewer.actions.auditAccount().catch(() => undefined)}>重新运行独立账户审计</button>
            </section>
            {contract !== null && (
              <details className="replay-risk-card replay-ledger-records" open={contract.history.ledger_entries_total > 0}>
                <summary>
                  <strong>账本记录</strong>
                  <span>{contract.history.ledger_entries_total}</span>
                </summary>
                {ledgerPages.loading && <p>正在读取账本…</p>}
                {ledgerPages.error !== null && <p role="alert">账本读取失败：{ledgerPages.error}</p>}
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
                {ledgerPages.nextCursor !== null && <button type="button" className="replay-pill-btn" disabled={ledgerPages.loadingMore} onClick={() => void ledgerPages.loadMore()}>{ledgerPages.loadingMore ? "加载中…" : `加载更多（已显示 ${ledgerPages.items.length}/${ledgerPages.totalCount}）`}</button>}
              </details>
            )}
            {contract?.margin_mode === "ISOLATED" && (
              <section className="replay-risk-card replay-isolated-allocation">
                <header><strong>逐仓分配</strong><small>{selectedSymbol}</small></header>
                {contract.position_mode === "HEDGE" && (
                  <label>仓位腿
                    <select value={isolatedSide} onChange={(event) => setIsolatedSide(event.target.value as "LONG" | "SHORT")}>
                      <option value="LONG">LONG</option>
                      <option value="SHORT">SHORT</option>
                    </select>
                  </label>
                )}
                <label>分配金额
                  <span>
                    <input value={isolatedAmount} inputMode="decimal" onChange={(event) => setIsolatedAmount(event.target.value)} />
                    <b>{settlementAsset}</b>
                  </span>
                </label>
                <button type="button" className="replay-pill-btn" disabled={!commandReady || !isolatedAmount.trim()} onClick={() => void viewer.actions.submitTrade("allocate_isolated_margin", { track_id: selectedTrackId, position_side: contract.position_mode === "HEDGE" ? isolatedSide : null, amount: isolatedAmount }).catch(() => undefined)}>设置分配</button>
                <small>当前：{String(contract.isolated_allocations[contract.position_mode === "HEDGE" ? `${selectedTrackId}:${isolatedSide}` : selectedTrackId] ?? "0")} {settlementAsset}</small>
              </section>
            )}
            <section className="replay-risk-card replay-capability-boundary" data-replay-panel="historical-market-liquidations" data-replay-domain="historical-market-liquidation">
              <header><strong>历史市场爆仓</strong><span className="replay-chip">{contract?.liquidation_channels.historical_market.fidelity ?? "UNSUPPORTED_NO_HISTORY"}</span></header>
              <p>独立市场数据域，不用训练账户事件冒充。</p>
            </section>
            <section className="replay-risk-card" data-replay-panel="simulated-liquidations" data-replay-domain="simulated-account-liquidation">
              <header><strong>模拟账户强平</strong><span className="replay-chip">{contract?.liquidations.length ?? 0}</span></header>
              <p>交易所规则级确定性模拟，与「历史市场爆仓」严格分域；insurance/ADL 不代表历史交易所私有账本。</p>
              <ReplayLiquidationTimeline
                cases={contract?.liquidations ?? []}
                formatVirtualTime={time}
              />
              {(contract?.liquidation_recoveries.length ?? 0) > 0 && (
                <details className="replay-liquidation-recoveries">
                  <summary>撤单后恢复 · {contract?.liquidation_recoveries.length}</summary>
                  <ReplayLiquidationTimeline
                    cases={contract?.liquidation_recoveries ?? []}
                    formatVirtualTime={time}
                    emptyLabel="暂无恢复 case"
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
    handleTabKeyDown(event, MARKET_TABS, value, setActiveTab, "data-replay-market-tab");
  };
  return (
    <div className="replay-paper-trading replay-market-context" data-replay-paper-surface="market-data">
      <nav className="replay-market-context-tabs" role="tablist" aria-label="回放市场数据视图">
        {MARKET_TABS.map(([value, label]) => <button key={value} type="button" role="tab" className={activeTab === value ? "active" : ""} aria-selected={activeTab === value} tabIndex={activeTab === value ? 0 : -1} data-replay-market-tab={value} onClick={() => setActiveTab(value)} onKeyDown={(event) => handleMarketTabKeyDown(event, value)}>{label}</button>)}
      </nav>
      <div className="replay-market-context-body" role="tabpanel">
        {activeTab === "book" && (
          <section className="replay-rail-section replay-historical-book" data-replay-panel="historical-book" data-replay-book-status={historicalBook?.status ?? "OFF"}>
            <h2>历史 L2 · {selectedTrack?.symbol ?? "--"}</h2>
            {historicalBook === null || historicalBook.status === "OFF" ? <div className="replay-capability-boundary" role="status"><strong>未启用历史盘口</strong><p>本 Run 使用 TOUCH_OR_TAPE_V2，明确不含盘口排队。</p></div> : historicalBook.status !== "READY" ? <div className="replay-capability-boundary" role="alert"><strong>{historicalBook.status} · 已清空旧盘口</strong><p>{historicalBook.message}</p><button type="button" data-replay-action="resync-historical-book" disabled={viewer.viewerPending || viewer.marketTracks?.global_clock?.state !== "PAUSED"} onClick={() => void viewer.actions.resyncHistoricalBook().catch(() => undefined)}>重新校验并同步</button></div> : <><small>历史 L2 连续性已验证 · 不含真实队列位置</small><div className="replay-book-columns"><div><h3>买盘</h3>{historicalBook.bids.map(([levelPrice, levelQuantity]) => <span key={`bid:${levelPrice}`} data-book-side="bid"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div><div><h3>卖盘</h3>{historicalBook.asks.map(([levelPrice, levelQuantity]) => <span key={`ask:${levelPrice}`} data-book-side="ask"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div></div></>}
          </section>
        )}
        {activeTab === "flow" && (
          <section className="replay-rail-section replay-trade-flow" data-replay-panel="trade-flow" data-replay-trade-flow-state={tradeFlow.state}>
            <h2>聚合成交与窗口 CVD</h2>
            {tradeFlow.state === "UNSUPPORTED_SOURCE_MODE" && <div className="replay-capability-boundary" role="status"><strong>当前来源不支持订单流</strong><p>BAR 归档没有聚合成交序列，缺失历史不会显示成 0。</p></div>}
            {tradeFlow.state === "LOADING" && <p className="replay-empty">正在读取已揭示的有界聚合成交页…</p>}
            {tradeFlow.state === "DEGRADED" && <div className="replay-capability-boundary" role="alert"><strong>连续性失败 · 已清空</strong><p>{tradeFlow.error ?? "订单流连续性校验失败"}</p></div>}
            {tradeFlow.state === "CONTIGUOUS" && <><dl className="replay-metrics-grid"><div><dt>窗口 CVD</dt><dd>{formatDecimal(tradeFlow.cvd)}</dd></div><div><dt>本页 Delta</dt><dd>{formatDecimal(tradeFlow.pageDelta)}</dd></div></dl><small>聚合成交精确 · 主动方近似 · {tradeFlow.fidelity}</small><div className="replay-trade-flow-list">{[...tradeFlow.tape].reverse().map((item) => <article key={item.source_sequence} data-aggressor-side={item.aggressor_side}><strong>{sideLabel(item.aggressor_side)} {formatDecimal(item.quantity)} @ {formatDecimal(item.price, 6)}</strong><span>Δ {formatDecimal(item.cvd_delta)} · agg #{item.agg_trade_id}</span><small>{time(item.trade_time_ms)} · {item.raw_trade_count} 笔原始成交聚合</small></article>)}</div></>}
          </section>
        )}
        {activeTab === "indicators" && <section className="replay-rail-section replay-indicator-boundary" data-replay-panel="indicators"><h2>本地指标</h2><p>SMA 20 · 仅 {indicatorStatus.sourceBarCount} 根已揭示 K 线。</p><p>Hosted、range 与 security 指标保持禁用，不请求未来窗口。</p></section>}
      </div>
    </div>
  );
}

export default function ReplayRightRail(props: ReplayRightRailProps) {
  return <aside className="replay-right-rail" aria-label="回放纸面下单"><ReplayPaperTradingDock {...props} /></aside>;
}
