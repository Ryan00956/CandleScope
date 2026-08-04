import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  formatReplayPublicTime,
  recentReplayActivity,
  REPLAY_ACTIVITY_VIEW_LIMIT,
  replayOwnsController,
} from "../replayUiModel.js";
import { defaultReplayV2Api } from "../replayV2Api.js";
import type { ReplayClosedTrade } from "../replayTypes.js";
import type {
  ReplayOrderPreview,
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

const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
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
  | "set_position_protection";
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
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET">("MARKET");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
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
  const [notice, setNotice] = useState<TradeNotice>(null);
  useTradeNoticeAutoDismiss(notice, setNotice);
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
  const symbol = selectedTrack?.symbol ?? config?.symbol ?? "--";
  const quantityAsset = baseAsset(symbol, settlementAsset);
  const rule = selectedRule(contract, selectedTrackId);
  const leverage = Math.max(1, finiteNumber(config?.max_leverage) ?? 1);
  const quantityStep = recordText(rule ?? {}, "quantity_step", "0.00000001");
  const draftOrder = useMemo<ReplayOrderRequest>(() => ({
    client_order_id: clientOrderId,
    side,
    order_type: orderType,
    quantity,
    reduce_only: reduceOnly,
    limit_price: orderType === "LIMIT" ? price : null,
    stop_price: orderType === "STOP_MARKET" || orderType === "TAKE_PROFIT_MARKET"
      ? price
      : null,
  }), [clientOrderId, orderType, price, quantity, reduceOnly, side]);
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
  const previewPositionIntent = orderType === "MARKET" && !reduceOnly ? "OPEN" : "NET";
  const previewKey = JSON.stringify([
    selectedTrackId,
    store.revision,
    store.sourceSequence,
    store.virtualTimeMs,
    previewPositionIntent,
    draftOrder,
    tradePlanDraft,
  ]);
  useEffect(() => {
    if (
      viewer.viewerState === null
      || store.connectionState !== "connected"
      || store.virtualTimeMs === null
      || !quantity.trim()
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
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      setPreviewState({
        key: previewKey,
        status: "pending",
        result: null,
        error: null,
      });
      void previewOrder(
        draftOrder,
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
      });
    }, 180);
    return () => {
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [
    draftOrder,
    orderType,
    previewOrder,
    previewPositionIntent,
    price,
    previewKey,
    quantity,
    riskValue,
    selectedTrackId,
    store.connectionState,
    store.revision,
    store.sourceSequence,
    store.virtualTimeMs,
    targetPrice,
    tradePlanDraft,
    tradeReason,
    invalidationPrice,
    viewer.viewerState,
  ]);
  const currentPreviewState = previewState?.key === previewKey ? previewState : null;
  const preview = currentPreviewState?.status === "ready"
    ? currentPreviewState.result
    : null;
  const previewPending = currentPreviewState?.status === "pending";
  const previewError = currentPreviewState?.status === "error"
    ? currentPreviewState.error
    : null;
  const estimatedMaxQuantity = preview?.max_quantity ?? null;
  const isSpot = config?.market_type.toLowerCase().includes("spot") ?? false;
  const actionLabel = reduceOnly
    ? `${side === "BUY" ? "买入" : "卖出"}减仓`
    : isSpot
      ? `${sideLabel(side)} ${quantityAsset}`
      : side === "BUY" ? `买入 / 做多 ${leverage}x` : `卖出 / 做空 ${leverage}x`;

  const setQuantityShare = (share: number) => {
    const maximum = finiteNumber(estimatedMaxQuantity);
    if (maximum === null) return;
    setQuantity(quantityForStep(maximum * share, quantityStep));
  };
  const placeOrder = async () => {
    if (
      preview === null
      || preview.cursor.revision !== store.revision
      || preview.cursor.source_sequence !== store.sourceSequence
      || preview.cursor.virtual_time_ms !== store.virtualTimeMs
    ) {
      setNotice({ tone: "error", message: "行情游标已变化，等待服务端重新预览后再提交" });
      return;
    }
    setNotice({ tone: "pending", message: "正在提交纸面委托…" });
    try {
      const planned = preview.trade_plan;
      if (planned !== null && tradePlanDraft !== null) {
        await viewer.actions.submitTrade("place_order", {
          ...draftOrder,
          quantity: planned.quantity,
          trade_plan: { ...tradePlanDraft },
        });
      } else if (orderType === "MARKET" && !reduceOnly) {
        await viewer.actions.submitTrade("execute_position_intent", {
          intent: "OPEN",
          side,
          quantity,
        });
      } else {
        await viewer.actions.submitTrade("place_order", { ...draftOrder });
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
      setNotice({ tone: "error", message: commandErrorMessage(error) });
    }
  };

  return (
    <div className="replay-paper-trading" data-replay-paper-surface="order-ticket">
    <div className="replay-order-surface">
      <header className="replay-ticket-account">
        <div>
          <small>{symbol} · {isSpot ? "现货" : "合约回放"}</small>
          <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 4)} {settlementAsset}</strong>
        </div>
        <div className="replay-ticket-locks" aria-label="训练账户固定规则">
          <span>{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"}</span>
          <span>{leverage}x</span>
          <span>已锁定</span>
        </div>
      </header>

      <section className="replay-compact-ticket" data-replay-panel="order-ticket">
        <div className="replay-order-fidelity-row">
          <span data-fidelity={contract?.execution_fidelity ?? "LOADING"}>
            {contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE"
              ? "历史 L2 辅助 · 无队列"
              : "近似成交 · 无盘口排队"}
          </span>
          <small>可用 {formatDecimal(portfolio?.available_equity ?? store.account?.available_equity, 4)} {settlementAsset}</small>
        </div>

        <div className="replay-segmented replay-side-switch" aria-label="委托方向">
          <button type="button" className={side === "BUY" ? "active" : ""} onClick={() => setSide("BUY")}>买入 / 做多</button>
          <button type="button" className={side === "SELL" ? "active" : ""} onClick={() => setSide("SELL")}>卖出 / 做空</button>
        </div>

        <label className="replay-ticket-type">委托类型
          <select value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}>
            <option value="MARKET">市价委托</option>
            <option value="LIMIT">限价委托</option>
            <option value="STOP_MARKET">止损市价</option>
            <option value="TAKE_PROFIT_MARKET">止盈市价</option>
          </select>
        </label>

        <div className="replay-ticket-fields">
          {orderType !== "MARKET" && (
            <label>{orderType === "LIMIT" ? "委托价格" : "触发价格"}
              <span><input data-replay-field="order-price" value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} /><b>{settlementAsset}</b></span>
            </label>
          )}
          <label>数量
            <span><input data-replay-field="order-quantity" value={quantity} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} /><b>{quantityAsset}</b></span>
          </label>
        </div>

        <div className="replay-size-presets" aria-label="快捷仓位比例">
          {[0.25, 0.5, 0.75, 1].map((share) => (
            <button key={share} type="button" disabled={estimatedMaxQuantity === null} onClick={() => setQuantityShare(share)}>{share * 100}%</button>
          ))}
          <small>参考可下 {estimatedMaxQuantity === null ? "--" : formatDecimal(estimatedMaxQuantity)} {quantityAsset}</small>
        </div>

        <fieldset className="replay-trade-plan" disabled={!tradePlanEligible}>
          <legend>
            <label>
              <input
                type="checkbox"
                checked={tradePlanEnabled && tradePlanEligible}
                onChange={(event) => setTradePlanEnabled(event.target.checked)}
              />
              按风险计划反算仓位
            </label>
          </legend>
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
        </fieldset>

        <label className="replay-checkbox-field"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} />只减仓</label>

        <dl className="replay-order-preview" aria-label="订单参考预览">
          <div><dt>名义价值</dt><dd>{previewPending ? "校验中…" : `${formatDecimal(preview?.estimated_notional, 2)} ${settlementAsset}`}</dd></div>
          <div><dt>保证金</dt><dd>{formatDecimal(preview?.reserved_margin, 2)} {settlementAsset}</dd></div>
          <div><dt>手续费上限</dt><dd>{formatDecimal(preview?.estimated_fee, 4)} {settlementAsset}</dd></div>
        </dl>

        <button
          type="button"
          className="replay-submit-order"
          data-side={side}
          data-replay-action="place-order"
          disabled={!commandReady || previewPending || preview === null || previewError !== null}
          onClick={() => void placeOrder()}
        >{viewer.viewerPending ? "提交中…" : actionLabel}</button>

        <div className="replay-trade-notice" role={notice?.tone === "error" ? "alert" : "status"} aria-live="polite" data-tone={notice?.tone ?? "idle"}>
          {notice?.message ?? previewError ?? viewer.error ?? "提交前由服务端按当前游标校验价格、保证金、手续费和数量上限。"}
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
  const [closeDraft, setCloseDraft] = useState<Readonly<{ trackId: string; value: string }> | null>(null);
  const [protectionDraft, setProtectionDraft] = useState<Readonly<{
    trackId: string;
    stopLoss: string;
    takeProfit: string;
  }> | null>(null);
  const [isolatedAmount, setIsolatedAmount] = useState("0");
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
  const quantityAsset = baseAsset(selectedSymbol, settlementAsset);
  const portfolioPositions = portfolio?.positions ?? [];
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
  const stopLossPrice = protectionDraft?.trackId === selectedTrackId
    ? protectionDraft.stopLoss
    : "";
  const takeProfitPrice = protectionDraft?.trackId === selectedTrackId
    ? protectionDraft.takeProfit
    : "";
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

  const setCloseShare = (share: number) => {
    if (selectedPositionQuantity <= 0) return;
    setCloseDraft({
      trackId: selectedTrackId,
      value: quantityForStep(selectedPositionQuantity * share, quantityStep),
    });
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
          <span>账户权益 <strong>{formatDecimal(portfolio?.equity ?? store.account?.equity, 2)} {settlementAsset}</strong></span>
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
            {portfolioPositions.length === 0 ? (
              <div className="replay-account-empty"><strong>当前组合为空仓</strong><small>开仓后会在这里显示方向、盈亏、保证金和快捷平仓。</small></div>
            ) : portfolioPositions.map((item) => {
              const quantityValue = finiteNumber(item.position.quantity) ?? 0;
              const positionSide = quantityValue >= 0 ? "long" : "short";
              const selected = item.track_id === selectedTrackId;
              return (
                <article className="replay-position-card" key={item.track_id} data-position-side={positionSide} data-selected-track={selected}>
                  <header>
                    <div><strong>{item.symbol}</strong><small>{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"} · {config?.max_leverage ?? "--"}x</small></div>
                    <div><span className="replay-side-tag">{positionSide === "long" ? "多" : "空"}</span><b>{formatDecimal(Math.abs(quantityValue))}</b></div>
                  </header>
                  <dl className="replay-rail-metric-grid">
                    <div><dt>开仓均价</dt><dd>{formatDecimal(item.position.entry_price, 6)}</dd></div>
                    <div><dt>标记价格</dt><dd>{formatDecimal(item.position.mark_price, 6)}</dd></div>
                    <div><dt>未实现盈亏</dt><dd data-value-tone={(finiteNumber(item.position.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(item.position.unrealized_pnl, 4)} {settlementAsset}</dd></div>
                    <div><dt>保证金 / 风险</dt><dd>{formatDecimal(item.maintenance_margin, 4)} {settlementAsset}<small>覆盖 {formatDecimal(item.risk_ratio, 2)}×</small></dd></div>
                  </dl>
                  {!selected && <button type="button" disabled={viewer.viewerPending} onClick={() => void viewer.actions.selectTrack(item.track_id).catch(() => undefined)}>切换到该轨道管理</button>}
                </article>
              );
            })}

            {selectedPosition !== null && (
              <section className="replay-position-actions">
                <header><strong>{selectedPosition.symbol} 仓位操作</strong><small>按当前已揭示参考价</small></header>
                <label>数量 <span><input value={closeQuantity} inputMode="decimal" onChange={(event) => setCloseDraft({ trackId: selectedTrackId, value: event.target.value })} aria-label="平仓数量" /><b>{quantityAsset}</b></span></label>
                <div>{[0.25, 0.5, 1].map((share) => <button type="button" key={share} onClick={() => setCloseShare(share)}>{share * 100}%</button>)}</div>
                <button
                  type="button"
                  data-replay-action="close-partial"
                  disabled={!commandReady || !closeQuantity.trim()}
                  onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: closeQuantity }, "正在提交平仓命令…", "平仓命令已受理，组合已刷新")}
                >部分平仓</button>
                <button
                  type="button"
                  data-replay-action="close-position"
                  disabled={!commandReady}
                  onClick={() => void runTrade("execute_position_intent", { intent: "CLOSE", side: null, quantity: null }, "正在提交全部平仓命令…", "全部平仓命令已受理")}
                >市价全平</button>
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

                <label>止损价 <span><input value={stopLossPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, stopLoss: event.target.value, takeProfit: takeProfitPrice })} aria-label="止损价格" /><b>{settlementAsset}</b></span></label>
                <label>止盈价 <span><input value={takeProfitPrice} inputMode="decimal" onChange={(event) => setProtectionDraft({ trackId: selectedTrackId, stopLoss: stopLossPrice, takeProfit: event.target.value })} aria-label="止盈价格" /><b>{settlementAsset}</b></span></label>
                <button
                  type="button"
                  data-replay-action="set-position-protection"
                  disabled={!commandReady || (!stopLossPrice.trim() && !takeProfitPrice.trim())}
                  onClick={() => void runTrade(
                    "set_position_protection",
                    {
                      quantity: null,
                      stop_loss_price: stopLossPrice.trim() || null,
                      take_profit_price: takeProfitPrice.trim() || null,
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
                    { quantity: null, stop_loss_price: null, take_profit_price: null },
                    "正在清除仓位保护…",
                    "仓位保护已清除",
                  )}
                >清除止盈止损</button>
              </section>
            )}

            <section className="replay-closed-trades">
              <header><strong>最近已平仓</strong><span>{closedTrades.length}</span>{reportState === "loading" && <small>同步中…</small>}</header>
              <div className="replay-rail-record-list">
                {recentClosedTrades.length === 0 ? <div className="replay-account-empty compact">暂无已平仓交易</div> : recentClosedTrades.map((item) => (
                  <article className="replay-compact-record" key={item.trade_id}>
                    <header><span data-order-side={item.side}>{sideLabel(item.side)} · {formatDecimal(item.quantity)}</span><strong data-value-tone={(finiteNumber(item.realized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(item.realized_pnl, 4)} {settlementAsset}</strong></header>
                    <dl><div><dt>开仓</dt><dd>{formatDecimal(item.entry_price, 6)}</dd></div><div><dt>平仓</dt><dd>{formatDecimal(item.exit_price, 6)}</dd></div></dl>
                  </article>
                ))}
              </div>
            </section>
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
              {page?.loading === true && <div className="replay-account-empty">正在读取历史委托…</div>}
              {page?.error !== null && page !== null && <div className="replay-account-empty" role="alert">历史委托读取失败：{page.error}</div>}
              {!page?.loading && orders.length === 0 ? <div className="replay-account-empty">{activeTab === "open-orders" ? "暂无当前委托" : "暂无历史委托"}</div> : orders.map((order, index) => {
                const orderId = recordText(order, "order_id", `order-${index}`);
                const trackId = recordText(order, "track_id", selectedTrackId);
                const status = recordText(order, "status", "OPEN");
                const timestamp = eventTime(order);
                const editable = !TERMINAL_ORDER_STATES.has(status) && trackId === selectedTrackId;
                const editing = replaceDraft?.trackId === trackId && replaceDraft.orderId === orderId;
                const orderTypeValue = recordText(order, "order_type");
                return (
                  <article className="replay-compact-record" key={`${trackId}:${orderId}`} data-order-status={status}>
                    <header>
                      <div>
                        {editable && <input type="checkbox" aria-label={`选择委托 ${orderId}`} checked={selectedOrderIds.includes(orderId)} onChange={(event) => toggleSelectedOrder(orderId, event.target.checked)} />}
                        <strong>{symbolForTrack(trackId)}</strong><small>{orderId}</small>
                      </div>
                      <span className="replay-order-status" data-status={status}>{orderStatusLabel(status)}</span>
                    </header>
                    <div className="replay-record-primary"><span data-order-side={recordText(order, "side")}>{sideLabel(recordText(order, "side"))}</span><b>{formatDecimal(recordText(order, "quantity"))}</b><small>{orderTypeLabel(recordText(order, "order_type"))}{recordBoolean(order, "reduce_only") ? " · 只减仓" : ""}</small></div>
                    <dl className="replay-rail-metric-grid"><div><dt>委托价</dt><dd>{formatDecimal(orderPrice(order), 6)}</dd></div><div><dt>已成交</dt><dd>{formatDecimal(recordText(order, "filled_quantity", "0"))}</dd></div><div className="wide"><dt>时间</dt><dd>{timestamp === null ? "--" : time(timestamp)}</dd></div></dl>
                    {editing && replaceDraft !== null && (
                      <div className="replay-order-replace-form">
                        <label>剩余委托量<input inputMode="decimal" value={replaceDraft.quantity} onChange={(event) => setReplaceDraft({ ...replaceDraft, quantity: event.target.value })} /></label>
                        {orderTypeValue !== "MARKET" && <label>新委托价<input inputMode="decimal" value={replaceDraft.price} onChange={(event) => setReplaceDraft({ ...replaceDraft, price: event.target.value })} /></label>}
                        <button type="button" disabled={!commandReady || !replaceDraft.quantity.trim() || (orderTypeValue !== "MARKET" && !replaceDraft.price.trim())} onClick={() => replaceOrder(order)}>确认改单</button>
                        <button type="button" onClick={() => setReplaceDraft(null)}>取消</button>
                      </div>
                    )}
                    {editable && !editing && <button type="button" disabled={!commandReady} onClick={() => setReplaceDraft({ trackId, orderId, quantity: recordText(order, "remaining_quantity", recordText(order, "quantity")), price: recordText(order, "limit_price", recordText(order, "stop_price", "")) })}>改单</button>}
                    {editable && <button type="button" disabled={!commandReady} onClick={() => void runTrade("cancel_order", { order_id: orderId }, "正在撤销委托…", "委托已撤销并移入历史")}>撤单</button>}
                  </article>
                );
              })}
              {page?.nextCursor !== null && page !== null && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? "加载中…" : `加载更多（已显示 ${page.items.length}/${page.totalCount}）`}</button>}
            </div>
          );
        })()}

        {activeTab === "fills" && (
          <div className="replay-rail-account-scroll replay-rail-record-list" data-replay-panel="fills">
            {fillPages.loading && contract !== null && <div className="replay-account-empty">正在读取成交记录…</div>}
            {fillPages.error !== null && contract !== null && <div className="replay-account-empty" role="alert">成交记录读取失败：{fillPages.error}</div>}
            {!fillPages.loading && visibleFills.length === 0 ? <div className="replay-account-empty">暂无成交</div> : visibleFills.map((fill, index) => {
              const timestamp = eventTime(fill);
              return (
                <article className="replay-compact-record" key={recordText(fill, "fill_id", `fill-${index}`)}>
                  <header><div><strong>{symbolForTrack(recordText(fill, "track_id", selectedTrackId))}</strong><small title={recordText(fill, "reason")}>{recordText(fill, "fill_id", "--")}</small></div><span data-order-side={recordText(fill, "side")}>{sideLabel(recordText(fill, "side"))}</span></header>
                  <div className="replay-record-primary"><b>{formatDecimal(recordText(fill, "quantity"))}</b><small>@ {formatDecimal(recordText(fill, "price"), 6)} · {recordText(fill, "liquidity") === "MAKER" ? "挂单" : "吃单"}</small></div>
                  <dl className="replay-rail-metric-grid"><div><dt>手续费</dt><dd>{formatDecimal(recordText(fill, "configured_fee", recordText(fill, "fee")), 6)} {settlementAsset}</dd></div><div><dt>时间</dt><dd>{timestamp === null ? "--" : time(timestamp)}</dd></div></dl>
                </article>
              );
            })}
            {contract !== null && fillPages.nextCursor !== null && <button type="button" disabled={fillPages.loadingMore} onClick={() => void fillPages.loadMore()}>{fillPages.loadingMore ? "加载中…" : `加载更多（已显示 ${fillPages.items.length}/${fillPages.totalCount}）`}</button>}
          </div>
        )}

        {activeTab === "assets" && (
          <div className="replay-account-dashboard" data-replay-panel="account-assets">
              <article><span>账户权益</span><strong>{formatDecimal(portfolio?.equity, 4)} {settlementAsset}</strong><small>初始 {formatDecimal(portfolio?.initial_equity, 2)}</small></article>
              <article><span>可用权益</span><strong>{formatDecimal(portfolio?.available_equity, 4)} {settlementAsset}</strong><small>占用 {formatDecimal(portfolio?.margin_used, 4)}</small></article>
              <article><span>浮动盈亏</span><strong data-value-tone={(finiteNumber(portfolio?.unrealized_pnl) ?? 0) >= 0 ? "positive" : "negative"}>{formatDecimal(portfolio?.unrealized_pnl, 4)} {settlementAsset}</strong><small>已实现 {formatDecimal(portfolio?.realized_pnl, 4)}</small></article>
              <article><span>累计手续费</span><strong>{formatDecimal(portfolio?.fees_paid, 6)} {settlementAsset}</strong><small>预留 {formatDecimal(portfolio?.reserved_margin, 4)}</small></article>
              <article><span>维持保证金</span><strong>{formatDecimal(contract?.maintenance_margin, 4)} {settlementAsset}</strong><small>风险覆盖 {formatDecimal(contract?.risk_ratio, 2)}×</small></article>
              <article><span>资金费现金流</span><strong>{formatDecimal(contract?.funding_cashflow, 6)} {settlementAsset}</strong><small>{contract?.funding_mode === "OFF" ? "本 Run 未启用" : contract?.funding_mode ?? "--"}</small></article>
          </div>
        )}

        {activeTab === "risk" && (
          <div className="replay-risk-dashboard" data-replay-panel="account-risk">
              <section>
                <header><strong>账户规则</strong><span>{contract?.status ?? "加载中"}</span></header>
                <dl><div><dt>保证金模式</dt><dd>{contract?.margin_mode === "ISOLATED" ? "逐仓" : "全仓"} · 运行中锁定</dd></div><div><dt>执行模型</dt><dd>{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? "历史 L2 连续性校验" : "触价 / 成交带近似"}</dd></div><div><dt>账本重算差异</dt><dd>{contract === null ? "--" : recordText(contract.ledger, "reconciliation_delta")}</dd></div><div><dt>历史账户输入</dt><dd>{contract?.account_history.mode === "HISTORICAL_EXACT" ? "已固定历史归档" : "已揭示价格代理"}</dd></div></dl>
              </section>
              <section className="replay-fidelity-panel">
                <header><strong>精度边界</strong><span>{contract?.account_history.auditor.status ?? "NOT_RUN"}</span></header>
                <p>当前模型{contract?.execution_fidelity === "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE" ? "使用连续历史盘口辅助，但仍不含真实队列位置。" : "不含盘口排队，并按已揭示价格保守模拟成交。"}</p>
                <p>Mark：{contract === null ? "--" : recordText(contract.fidelity, "mark")}</p>
                <button type="button" data-replay-action="audit-account" disabled={viewer.viewerPending} onClick={() => void viewer.actions.auditAccount().catch(() => undefined)}>重新运行独立账户审计</button>
              </section>
              {contract !== null && (
                <section className="replay-ledger-records">
                  <header><strong>账本记录</strong><span>{contract.history.ledger_entries_total}</span></header>
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
                  {ledgerPages.nextCursor !== null && <button type="button" disabled={ledgerPages.loadingMore} onClick={() => void ledgerPages.loadMore()}>{ledgerPages.loadingMore ? "加载中…" : `加载更多（已显示 ${ledgerPages.items.length}/${ledgerPages.totalCount}）`}</button>}
                </section>
              )}
              {contract?.margin_mode === "ISOLATED" && (
                <section className="replay-isolated-allocation">
                  <label>选中轨道逐仓分配<input value={isolatedAmount} inputMode="decimal" onChange={(event) => setIsolatedAmount(event.target.value)} /></label>
                  <button type="button" disabled={!commandReady || !isolatedAmount.trim()} onClick={() => void viewer.actions.submitTrade("allocate_isolated_margin", { track_id: selectedTrackId, amount: isolatedAmount }).catch(() => undefined)}>设置分配</button>
                  <small>当前：{String(contract.isolated_allocations[selectedTrackId] ?? "0")} {settlementAsset}</small>
                </section>
              )}
              <section className="replay-capability-boundary" data-replay-panel="historical-market-liquidations" data-replay-domain="historical-market-liquidation">
                <strong>历史市场爆仓</strong><span>{contract?.liquidation_channels.historical_market.fidelity ?? "UNSUPPORTED_NO_HISTORY"}</span><p>独立市场数据域，不用训练账户事件冒充。</p>
              </section>
              <section data-replay-panel="simulated-liquidations" data-replay-domain="simulated-account-liquidation">
                <header><strong>模拟账户强平</strong><span>{contract?.liquidations.length ?? 0}</span></header><p>与“历史市场爆仓”严格分域。</p>
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
            {historicalBook === null || historicalBook.status === "OFF" ? <div className="replay-capability-boundary" role="status"><strong>未启用历史盘口</strong><p>本 Run 使用 TOUCH_OR_TAPE_V2，明确不含盘口排队。</p></div> : historicalBook.status !== "READY" ? <div className="replay-capability-boundary" role="alert"><strong>{historicalBook.status} · 已清空旧盘口</strong><p>{historicalBook.message}</p><button type="button" data-replay-action="resync-historical-book" disabled={viewer.viewerPending || viewer.marketTracks?.global_clock.state !== "PAUSED"} onClick={() => void viewer.actions.resyncHistoricalBook().catch(() => undefined)}>重新校验并同步</button></div> : <><small>历史 L2 连续性已验证 · 不含真实队列位置</small><div className="replay-book-columns"><div><h3>买盘</h3>{historicalBook.bids.map(([levelPrice, levelQuantity]) => <span key={`bid:${levelPrice}`} data-book-side="bid"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div><div><h3>卖盘</h3>{historicalBook.asks.map(([levelPrice, levelQuantity]) => <span key={`ask:${levelPrice}`} data-book-side="ask"><strong>{formatDecimal(levelPrice, 6)}</strong><small>{formatDecimal(levelQuantity)}</small></span>)}</div></div></>}
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
