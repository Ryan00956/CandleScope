import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
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
} from "./orderBookTypes.js";

export interface OrderBookDockProps {
  runtime: OrderBookRuntime;
  height: number;
  /** Collapses this rail accordion view. */
  onRequestClose?(): void;
}

const ORDER_BOOK_STATUS_KEYS = {
  idle: "orderBook.status.idle",
  unsupported: "orderBook.status.unsupported",
  connecting: "orderBook.status.connecting",
  reconnecting: "orderBook.status.reconnecting",
  live: "orderBook.status.live",
  stale: "orderBook.status.stale",
  error: "orderBook.status.error",
} as const satisfies Record<OrderBookConnectionStatus, string>;

function orderBookStatusLabel(status: OrderBookConnectionStatus): string {
  return t(ORDER_BOOK_STATUS_KEYS[status]);
}

function snapshotDeliveryLabel(
  mode: "partial" | "full",
  snapshotMode: "live_snapshot" | "polling_snapshot" | null,
): string {
  if (mode === "full") return t("orderBook.delivery.strictContinuous");
  return snapshotMode === "polling_snapshot"
    ? t("orderBook.delivery.pollingSnapshot")
    : t("orderBook.delivery.liveSnapshot");
}

function orderBookStatusDetail(
  status: OrderBookConnectionStatus,
  hostMessage: string | null = null,
): string {
  if (status === "unsupported" || status === "idle") {
    return hostMessage || t("orderBook.waitingBook");
  }
  if (status === "stale") return t("orderBook.rt.staleSnapshot");
  if (status === "reconnecting") return t("orderBook.rt.disconnected");
  if (status === "error") return t("orderBook.rt.unavailable");
  return t("orderBook.waitingBook");
}

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
  if (value === null) return t("orderBook.waitingSpread");
  return `${formatPrice(value)}${bps === null ? "" : `  ·  ${trimZeros(bps.toFixed(2))} bps`}`;
}

function groupingLabel(
  grouping: PriceGrouping,
  runtimeMode: "partial" | "full",
  book: Parameters<typeof groupingPriceStep>[0],
): string {
  const step = groupingPriceStep(book, runtimeMode, grouping);
  if (grouping === "auto") {
    return step === null ? t("orderBook.grouping.auto") : t("orderBook.grouping.autoStep", { step: formatPrice(step) });
  }
  if (grouping === "raw") {
    return step === null ? t("orderBook.grouping.raw") : t("orderBook.grouping.rawStep", { step: formatPrice(step) });
  }
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
  onRetry,
}: {
  status: OrderBookConnectionStatus;
  message: string | null;
  onRetry(): void;
}) {
  const canRetry = status === "error" || status === "reconnecting" || status === "stale";
  return (
    <div className={`ob-empty-state ob-empty-${status}`}>
      <span className="ob-empty-glyph" aria-hidden="true">
        {status === "stale" ? "↻" : status === "unsupported" ? "—" : "⋯"}
      </span>
      <strong>{orderBookStatusLabel(status)}</strong>
      <span>{orderBookStatusDetail(status, message)}</span>
      {canRetry && <button type="button" onClick={onRetry}>{t("orderBook.retry")}</button>}
    </div>
  );
}

function OrderBookDock({ runtime, height, onRequestClose }: OrderBookDockProps) {
  useLocale();
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
  const symbol = view.identity.symbol.replace(/USDT$|USDC$/, "");
  const deliveryLabel = snapshotDeliveryLabel(view.preferences.mode, view.snapshotMode);

  return (
    <section
      className="order-book-dock"
      style={{ height }}
      aria-label={t("orderBook.aria")}
    >
      <header className="ob-header">
        {onRequestClose && (
          <button
            type="button"
            className="ob-collapse-button"
            onClick={onRequestClose}
            title={t("orderBook.collapse")}
            aria-label={t("orderBook.collapse")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        <span className="ob-title">{t("orderBook.title")}</span>
        <span className="ob-symbol">{symbol || view.identity.symbol}</span>
        <span className="ob-delivery-mode" title={t("orderBook.delivery.title")}>
          {deliveryLabel}
        </span>
        <span
          className={`ob-status ob-status-${snapshot.status}`}
          title={orderBookStatusDetail(snapshot.status, view.supportMessage)}
        >
          <span className="ob-status-dot" aria-hidden="true" />
          {orderBookStatusLabel(snapshot.status)}
        </span>
      </header>

      <>
          <div className="ob-controls">
            <div className="ob-mode-switch" role="group" aria-label={t("orderBook.mode")}>
              <button
                type="button"
                className={view.preferences.mode === "partial" ? "active" : ""}
                onClick={() => actions.setMode("partial")}
                title={view.snapshotMode === "polling_snapshot"
                  ? t("orderBook.snapshotPollingTitle")
                  : t("orderBook.snapshotTitle")}
              >
                {t("orderBook.snapshot")}
              </button>
              <button
                type="button"
                className={view.preferences.mode === "full" ? "active" : ""}
                onClick={() => actions.setMode("full")}
                disabled={!view.fullModeSupported}
                title={view.fullModeSupported
                  ? t("orderBook.continuousTitle")
                  : t("orderBook.continuousUnsupported")}
              >
                {t("orderBook.continuous")}
              </button>
            </div>
            <label>
              <span className="sr-only">{t("orderBook.levels")}</span>
              {view.preferences.mode === "partial" ? (
                <select
                  aria-label={t("orderBook.snapshotLevels")}
                  value={view.preferences.partialDepth}
                  onChange={(event) => actions.setPartialDepth(Number(event.target.value) as PartialDepthLevel)}
                >
                  {PARTIAL_DEPTH_LEVELS.map((depth) => <option key={depth} value={depth}>{t("orderBook.levelsOption", { n: depth })}</option>)}
                </select>
              ) : (
                <select
                  aria-label={t("orderBook.fullLevels")}
                  value={view.preferences.fullOutputLimit}
                  onChange={(event) => actions.setFullOutputLimit(Number(event.target.value) as FullOutputLimit)}
                >
                  {FULL_OUTPUT_LIMITS.map((limit) => <option key={limit} value={limit}>{t("orderBook.levelsOption", { n: limit })}</option>)}
                </select>
              )}
            </label>
            <label title={view.preferences.mode === "partial"
              ? t("orderBook.groupingPartial")
              : t("orderBook.groupingFull")}
            >
              <span className="sr-only">{t("orderBook.grouping")}</span>
              <select
                aria-label={t("orderBook.groupingAria")}
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
              <span className="sr-only">{t("orderBook.frequency")}</span>
              <select
                aria-label={t("orderBook.frequency")}
                value={view.updateIntervalMs}
                onChange={(event) => actions.setUpdateIntervalMs(Number(event.target.value) as OrderBookUpdateIntervalMs)}
              >
                {view.updateIntervalsMs.map((interval) => <option key={interval} value={interval}>{interval} ms</option>)}
              </select>
            </label>
          </div>

          <div className="ob-column-header" aria-hidden="true">
            <span>
              {t("orderBook.price")}{presentation?.priceStep ? ` · ${formatPrice(presentation.priceStep)}` : ""}
            </span>
            <span>{t("orderBook.qty")}</span>
            <span>{t("orderBook.cumulative")}</span>
          </div>

          {snapshot.book && presentation && rows ? (
            <div className="ob-book-scroll">
              <BookLevels rows={rows.asks} side="ask" maxCumulative={rows.maxCumulative} />
              <div className="ob-spread-row">
                <span className="ob-mid-price">{formatPrice(snapshot.book.midPrice)}</span>
                <span>{formatSpread(snapshot.book.spread, snapshot.book.spreadBps)}</span>
                {snapshot.book.mode === "partial" && snapshot.book.notionalImbalance !== null && (
                  <span title={t("orderBook.imbalance")}>
                    {t("orderBook.skew")} {snapshot.book.notionalImbalance >= 0 ? "+" : ""}
                    {trimZeros((snapshot.book.notionalImbalance * 100).toFixed(1))}%
                  </span>
                )}
                {snapshot.book.mode === "full" && presentation.aggregationApplied && (
                  <span>{t("orderBook.aggregated", { step: formatPrice(presentation.priceStep) })}</span>
                )}
              </div>
              <BookLevels rows={rows.bids} side="bid" maxCumulative={rows.maxCumulative} />
            </div>
          ) : (
            <EmptyState
              status={snapshot.status}
              message={view.supportMessage}
              onRetry={actions.retry}
            />
          )}
      </>
    </section>
  );
}

export default React.memo(OrderBookDock);
