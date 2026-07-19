import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  FullOutputLimit,
  OrderBookConnectionStatus,
  OrderBookRuntime,
  OrderBookUpdateIntervalMs,
  PartialDepthLevel,
  PriceGrouping,
} from "./orderBookTypes.js";
import {
  groupingPriceStep,
  orderBookPresentation,
} from "./orderBookAggregation.js";
import { buildOrderBookRows } from "./orderBookRows.js";
import type { DisplayOrderBookLevel } from "./orderBookRows.js";
import { fixedRowWindow } from "./orderBookVirtualization.js";
import {
  FULL_OUTPUT_LIMITS,
  FULL_PRICE_GROUPINGS,
  PARTIAL_DEPTH_LEVELS,
  PARTIAL_PRICE_GROUPINGS,
  UPDATE_INTERVALS_MS,
} from "./orderBookTypes.js";

export interface OrderBookDockProps {
  runtime: OrderBookRuntime;
  height: number;
  onOpenTradeFlow?(): void;
}

const STATUS_LABELS: Record<OrderBookConnectionStatus, string> = {
  idle: "已暂停",
  unsupported: "不可用",
  connecting: "连接中",
  reconnecting: "重连中",
  live: "实时",
  stale: "重同步",
  error: "错误",
};

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const decimals = value >= 1_000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return trimZeros(value.toFixed(decimals));
}

function formatQuantity(value: number): string {
  if (value >= 1_000_000) return `${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${trimZeros((value / 1_000).toFixed(2))}K`;
  if (value >= 1) return trimZeros(value.toFixed(4));
  return trimZeros(value.toFixed(6));
}

function formatSpread(value: number | null, bps: number | null): string {
  if (value === null) return "等待双边报价";
  return `${formatPrice(value)}${bps === null ? "" : `  ·  ${trimZeros(bps.toFixed(2))} bps`}`;
}

function groupingLabel(
  grouping: PriceGrouping,
  runtimeMode: "partial" | "full",
  book: Parameters<typeof groupingPriceStep>[0],
): string {
  const step = groupingPriceStep(book, runtimeMode, grouping);
  if (grouping === "auto") return step === null ? "自动" : `自动 ${formatPrice(step)}`;
  if (grouping === "raw") return step === null ? "原始" : `原始 ${formatPrice(step)}`;
  return step === null ? `${grouping}×` : formatPrice(step);
}

const ORDER_BOOK_ROW_HEIGHT = 22;
const ORDER_BOOK_ROW_OVERSCAN = 4;

const BookRow = React.memo(function BookRow({
  row,
  side,
  maxCumulative,
  offsetPx,
}: {
  row: DisplayOrderBookLevel;
  side: "ask" | "bid";
  maxCumulative: number;
  offsetPx: number;
}) {
  const width = maxCumulative > 0 ? Math.min(100, row.cumulative / maxCumulative * 100) : 0;
  return (
    <div className={`ob-level-row ob-${side}`} style={{ transform: `translateY(${offsetPx}px)` }}>
      <span className="ob-depth-bar" style={{ width: `${width}%` }} aria-hidden="true" />
      <span className="ob-price">{formatPrice(row.price)}</span>
      <span>{formatQuantity(row.quantity)}</span>
      <span>{formatQuantity(row.cumulative)}</span>
    </div>
  );
}, (previous, next) => (
  previous.side === next.side
  && previous.offsetPx === next.offsetPx
  && previous.maxCumulative === next.maxCumulative
  && previous.row.price === next.row.price
  && previous.row.quantity === next.row.quantity
  && previous.row.cumulative === next.row.cumulative
));

function BookLevels({
  rows,
  side,
  maxCumulative,
}: {
  rows: readonly DisplayOrderBookLevel[];
  side: "ask" | "bid";
  maxCumulative: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const stickToEdgeRef = useRef(side === "ask");
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });
  const displayRows = useMemo(
    () => side === "ask" ? [...rows].reverse() : rows,
    [rows, side],
  );
  const requestedScrollTop = side === "ask" && viewport.height === 0
    ? Number.POSITIVE_INFINITY
    : viewport.scrollTop;
  const window = fixedRowWindow({
    rowCount: displayRows.length,
    rowHeight: ORDER_BOOK_ROW_HEIGHT,
    viewportHeight: viewport.height,
    scrollTop: requestedScrollTop,
    overscan: ORDER_BOOK_ROW_OVERSCAN,
  });

  const publishViewport = useCallback((element: HTMLDivElement) => {
    const height = element.clientHeight;
    const scrollTop = element.scrollTop;
    setViewport((previous) => previous.height === height && previous.scrollTop === scrollTop
      ? previous
      : { height, scrollTop });
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    publishViewport(element);
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => publishViewport(element))
      : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [publishViewport]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || side !== "ask" || !stickToEdgeRef.current) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    publishViewport(element);
  }, [displayRows.length, publishViewport, side, viewport.height]);

  useLayoutEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    if (side === "ask") {
      stickToEdgeRef.current = element.scrollHeight - element.clientHeight - element.scrollTop
        <= ORDER_BOOK_ROW_HEIGHT * 2;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const current = containerRef.current;
      if (current) publishViewport(current);
    });
  }, [publishViewport, side]);

  return (
    <div
      ref={containerRef}
      className={`ob-levels ob-${side === "ask" ? "asks" : "bids"}`}
      onScroll={handleScroll}
    >
      <div className="ob-levels-window" style={{ height: window.totalHeight }}>
        {displayRows.slice(window.start, window.end).map((row, localIndex) => {
          const index = window.start + localIndex;
          return (
            <BookRow
              key={`${side}-slot-${row.slot}`}
              row={row}
              side={side}
              maxCumulative={maxCumulative}
              offsetPx={index * ORDER_BOOK_ROW_HEIGHT}
            />
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({
  status,
  message,
  error,
  onRetry,
}: {
  status: OrderBookConnectionStatus;
  message: string | null;
  error: string | null;
  onRetry(): void;
}) {
  const canRetry = status === "error" || status === "reconnecting" || status === "stale";
  return (
    <div className={`ob-empty-state ob-empty-${status}`}>
      <span className="ob-empty-glyph" aria-hidden="true">
        {status === "stale" ? "↻" : status === "unsupported" ? "—" : "⋯"}
      </span>
      <strong>{STATUS_LABELS[status]}</strong>
      <span>{message || error || "正在等待第一份有效盘口"}</span>
      {canRetry && <button type="button" onClick={onRetry}>立即重试</button>}
    </div>
  );
}

function OrderBookDock({ runtime, height, onOpenTradeFlow }: OrderBookDockProps) {
  const { view, actions } = runtime;
  const snapshot = useSyncExternalStore(
    view.store.subscribe,
    view.store.getSnapshot,
    view.store.getServerSnapshot,
  );
  const activeGrouping = view.preferences.mode === "partial"
    ? view.preferences.partialPriceGrouping
    : view.preferences.fullPriceGrouping;
  const presentation = useMemo(() => (
    snapshot.book ? orderBookPresentation(snapshot.book, activeGrouping) : null
  ), [activeGrouping, snapshot.book]);
  const rows = useMemo(() => (
    presentation ? buildOrderBookRows(presentation.bids, presentation.asks) : null
  ), [presentation]);
  const groupingOptions = view.preferences.mode === "partial"
    ? PARTIAL_PRICE_GROUPINGS
    : FULL_PRICE_GROUPINGS;
  const collapsed = view.preferences.collapsed;
  const symbol = view.identity.symbol.replace(/USDT$|USDC$/, "");

  return (
    <section
      className={`order-book-dock ${collapsed ? "collapsed" : ""}`}
      style={{ height }}
      aria-label="订单簿"
    >
      <header className="ob-header">
        <button
          type="button"
          className="ob-collapse-button"
          onClick={() => actions.setCollapsed(!collapsed)}
          title={collapsed ? "展开订单簿" : "折叠订单簿"}
          aria-expanded={!collapsed}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            {collapsed ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        </button>
        {onOpenTradeFlow ? (
          <div className="market-dock-tabs" role="tablist" aria-label="市场微观结构视图">
            <button type="button" role="tab" aria-selected className="active">盘口</button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              onClick={onOpenTradeFlow}
            >成交</button>
          </div>
        ) : <span className="ob-title">订单簿</span>}
        {!collapsed && <span className="ob-symbol">{symbol || view.identity.symbol}</span>}
        <span className={`ob-status ob-status-${snapshot.status}`} title={snapshot.message || snapshot.error || STATUS_LABELS[snapshot.status]}>
          <span className="ob-status-dot" aria-hidden="true" />
          {!collapsed && STATUS_LABELS[snapshot.status]}
        </span>
      </header>

      {!collapsed && (
        <>
          <div className="ob-controls">
            <div className="ob-mode-switch" role="group" aria-label="订单簿模式">
              <button
                type="button"
                className={view.preferences.mode === "partial" ? "active" : ""}
                onClick={() => actions.setMode("partial")}
                title="交易所推送的 Top-N 可替换快照"
              >
                快照
              </button>
              <button
                type="button"
                className={view.preferences.mode === "full" ? "active" : ""}
                onClick={() => actions.setMode("full")}
                title="后端校验序列并重建的连续本地订单簿"
              >
                连续
              </button>
            </div>
            <label>
              <span className="sr-only">显示档位</span>
              {view.preferences.mode === "partial" ? (
                <select
                  aria-label="快照档位"
                  value={view.preferences.partialDepth}
                  onChange={(event) => actions.setPartialDepth(Number(event.target.value) as PartialDepthLevel)}
                >
                  {PARTIAL_DEPTH_LEVELS.map((depth) => <option key={depth} value={depth}>{depth} 档</option>)}
                </select>
              ) : (
                <select
                  aria-label="连续订单簿显示档位"
                  value={view.preferences.fullOutputLimit}
                  onChange={(event) => actions.setFullOutputLimit(Number(event.target.value) as FullOutputLimit)}
                >
                  {FULL_OUTPUT_LIMITS.map((limit) => <option key={limit} value={limit}>{limit} 档</option>)}
                </select>
              )}
            </label>
            <label title={view.preferences.mode === "partial"
              ? "价格聚合单位；快照模式仅支持小范围聚合"
              : "价格聚合单位；连续模式先在完整本地盘口聚合，再截取显示档位"}
            >
              <span className="sr-only">价格聚合单位</span>
              <select
                aria-label="订单簿价格聚合单位"
                value={activeGrouping}
                onChange={(event) => actions.setPriceGrouping(
                  view.preferences.mode,
                  event.target.value as PriceGrouping,
                )}
              >
                {groupingOptions.map((grouping) => (
                  <option
                    key={grouping}
                    value={grouping}
                    disabled={grouping !== "auto" && grouping !== "raw" && !snapshot.book?.priceTickSize}
                  >
                    {groupingLabel(grouping, view.preferences.mode, snapshot.book)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">更新频率</span>
              <select
                aria-label="订单簿更新频率"
                value={view.preferences.updateIntervalMs}
                onChange={(event) => actions.setUpdateIntervalMs(Number(event.target.value) as OrderBookUpdateIntervalMs)}
              >
                {UPDATE_INTERVALS_MS.map((interval) => <option key={interval} value={interval}>{interval} ms</option>)}
              </select>
            </label>
          </div>

          <div className="ob-column-header" aria-hidden="true">
            <span>
              价格{presentation?.priceStep ? ` · ${formatPrice(presentation.priceStep)}` : ""}
            </span>
            <span>数量</span>
            <span>累计</span>
          </div>

          {snapshot.book && presentation && rows ? (
            <div className="ob-book-scroll">
              <BookLevels rows={rows.asks} side="ask" maxCumulative={rows.maxCumulative} />
              <div className="ob-spread-row">
                <span className="ob-mid-price">{formatPrice(snapshot.book.midPrice)}</span>
                <span>{formatSpread(snapshot.book.spread, snapshot.book.spreadBps)}</span>
                {snapshot.book.mode === "partial" && snapshot.book.notionalImbalance !== null && (
                  <span title="前 N 档名义价值不平衡">
                    偏斜 {snapshot.book.notionalImbalance >= 0 ? "+" : ""}
                    {trimZeros((snapshot.book.notionalImbalance * 100).toFixed(1))}%
                  </span>
                )}
                {snapshot.book.mode === "full" && presentation.aggregationApplied && (
                  <span>聚合 {formatPrice(presentation.priceStep)}</span>
                )}
              </div>
              <BookLevels rows={rows.bids} side="bid" maxCumulative={rows.maxCumulative} />
            </div>
          ) : (
            <EmptyState
              status={snapshot.status}
              message={view.supportMessage || snapshot.message}
              error={snapshot.error}
              onRetry={actions.retry}
            />
          )}
        </>
      )}
    </section>
  );
}

export default React.memo(OrderBookDock);
