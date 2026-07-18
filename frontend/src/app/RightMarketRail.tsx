import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import OrderBookDock from "../features/order-book/OrderBookDock.js";
import {
  COLLAPSED_ORDER_BOOK_HEIGHT,
  DEFAULT_ORDER_BOOK_HEIGHT,
  MAX_ORDER_BOOK_HEIGHT,
  MIN_ORDER_BOOK_HEIGHT,
  MIN_WATCHLIST_PANE_HEIGHT,
} from "../features/order-book/orderBookPreferencesStore.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import WatchlistSidebar from "../features/watchlist/WatchlistSidebar.js";
import type { WatchlistSidebarProps } from "../features/watchlist/WatchlistSidebar.js";
import {
  DEFAULT_WATCHLIST_WIDTH,
  MAX_WATCHLIST_WIDTH,
  MIN_WATCHLIST_WIDTH,
} from "../features/watchlist/watchlistStore.js";

type RailCssVars = CSSProperties & Record<`--${string}`, string | number>;

export interface RightMarketRailProps {
  watchlist: WatchlistSidebarProps;
  orderBook: OrderBookRuntime;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function RightMarketRail({ watchlist, orderBook }: RightMarketRailProps) {
  const railRef = useRef<HTMLElement | null>(null);
  const widthStartRef = useRef<{ x: number; width: number } | null>(null);
  const heightStartRef = useRef<{ y: number; height: number } | null>(null);
  const transientWidthRef = useRef<number | null>(null);
  const transientHeightRef = useRef<number | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const [widthResizing, setWidthResizing] = useState(false);
  const [heightResizing, setHeightResizing] = useState(false);
  const [transientWidth, setTransientWidth] = useState<number | null>(null);
  const [transientHeight, setTransientHeight] = useState<number | null>(null);
  const sidebarCollapsed = watchlist.layout?.sidebarCollapsed ?? false;
  const persistedWidth = watchlist.layout?.width ?? DEFAULT_WATCHLIST_WIDTH;
  const setWidth = watchlist.actions?.setWidth;
  const maximumDockHeight = railHeight > 0
    ? clamp(railHeight - MIN_WATCHLIST_PANE_HEIGHT - 8, MIN_ORDER_BOOK_HEIGHT, MAX_ORDER_BOOK_HEIGHT)
    : MAX_ORDER_BOOK_HEIGHT;
  const expandedDockHeight = clamp(
    transientHeight ?? orderBook.view.preferences.height,
    MIN_ORDER_BOOK_HEIGHT,
    maximumDockHeight,
  );
  const dockHeight = orderBook.view.preferences.collapsed
    ? COLLAPSED_ORDER_BOOK_HEIGHT
    : expandedDockHeight;
  const width = transientWidth ?? persistedWidth;
  const colorVars = useMemo<RailCssVars>(() => ({
    "--wl-up-color": watchlist.upColor || "#22c55e",
    "--wl-down-color": watchlist.downColor || "#ef4444",
  }), [watchlist.downColor, watchlist.upColor]);

  useEffect(() => {
    const element = railRef.current;
    if (!element) return undefined;
    const update = () => setRailHeight(element.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!widthResizing) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = widthStartRef.current;
      if (!start) return;
      const next = clamp(start.width - (event.clientX - start.x), MIN_WATCHLIST_WIDTH, MAX_WATCHLIST_WIDTH);
      transientWidthRef.current = next;
      setTransientWidth(next);
    };
    const onUp = () => {
      setWidthResizing(false);
      if (transientWidthRef.current !== null) setWidth?.(transientWidthRef.current);
      transientWidthRef.current = null;
      setTransientWidth(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onUp, { once: true });
    window.addEventListener("blur", onUp, { once: true });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [setWidth, widthResizing]);

  useEffect(() => {
    if (!heightResizing) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = heightStartRef.current;
      if (!start) return;
      const next = clamp(
        start.height - (event.clientY - start.y),
        MIN_ORDER_BOOK_HEIGHT,
        maximumDockHeight,
      );
      transientHeightRef.current = next;
      setTransientHeight(next);
    };
    const onUp = () => {
      setHeightResizing(false);
      if (transientHeightRef.current !== null) orderBook.actions.setHeight(transientHeightRef.current);
      transientHeightRef.current = null;
      setTransientHeight(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onUp, { once: true });
    window.addEventListener("blur", onUp, { once: true });
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [heightResizing, maximumDockHeight, orderBook.actions]);

  const startWidthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    widthStartRef.current = { x: event.clientX, width };
    setWidthResizing(true);
  }, [width]);

  const startHeightResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    heightStartRef.current = { y: event.clientY, height: expandedDockHeight };
    setHeightResizing(true);
  }, [expandedDockHeight]);

  const setDockHeight = useCallback((height: number) => {
    orderBook.actions.setHeight(clamp(height, MIN_ORDER_BOOK_HEIGHT, maximumDockHeight));
  }, [maximumDockHeight, orderBook.actions]);

  const handleSeparatorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = expandedDockHeight + 20;
    if (event.key === "ArrowDown") next = expandedDockHeight - 20;
    if (event.key === "Home") next = MIN_ORDER_BOOK_HEIGHT;
    if (event.key === "End") next = maximumDockHeight;
    if (next === null) return;
    event.preventDefault();
    setDockHeight(next);
  }, [expandedDockHeight, maximumDockHeight, setDockHeight]);

  return (
    <>
      {!sidebarCollapsed && (
        <div
          className={`wl-resize-handle ${widthResizing ? "active" : ""}`}
          onPointerDown={startWidthResize}
          role="separator"
          aria-label="调整右侧栏宽度"
          aria-orientation="vertical"
        />
      )}
      <aside
        ref={railRef}
        className={`watchlist-sidebar right-market-rail ${sidebarCollapsed ? "collapsed" : ""} ${widthResizing ? "resizing" : ""}`}
        style={{ width: sidebarCollapsed ? 40 : width, ...colorVars }}
        aria-label="市场侧栏"
      >
        <WatchlistSidebar {...watchlist} />
        {!sidebarCollapsed && (
          <>
            {!orderBook.view.preferences.collapsed && (
              <div
                className={`market-rail-splitter ${heightResizing ? "active" : ""}`}
                onPointerDown={startHeightResize}
                onDoubleClick={() => setDockHeight(DEFAULT_ORDER_BOOK_HEIGHT)}
                onKeyDown={handleSeparatorKeyDown}
                role="separator"
                tabIndex={0}
                aria-label="调整自选与订单簿高度"
                aria-orientation="horizontal"
                aria-valuemin={MIN_ORDER_BOOK_HEIGHT}
                aria-valuemax={maximumDockHeight}
                aria-valuenow={expandedDockHeight}
              >
                <span aria-hidden="true" />
              </div>
            )}
            <OrderBookDock runtime={orderBook} height={dockHeight} />
          </>
        )}
      </aside>
    </>
  );
}

export default React.memo(RightMarketRail);
