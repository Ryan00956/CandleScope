import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  MARKET_DOCK_COLLAPSED_HEIGHT,
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_MAX_WIDTH,
  MARKET_RAIL_MIN_SIDEBAR_HEIGHT,
  MARKET_RAIL_MIN_WIDTH,
} from "../shared/marketRailLayout.js";


type RailCssVars = CSSProperties & Record<`--${string}`, string | number>;

export interface MarketRightRailLayout {
  readonly width: number;
  readonly collapsed: boolean;
  readonly onWidthChange?: (value: number) => void;
}

export interface MarketRightRailDockLayout {
  readonly height: number;
  readonly collapsed: boolean;
  readonly onHeightChange: (value: number) => void;
}

export interface MarketRightRailFrameProps {
  readonly source?: "live" | "replay";
  readonly sidebar: ReactNode;
  readonly renderDock: (height: number) => ReactNode;
  readonly layout: MarketRightRailLayout;
  readonly dockLayout: MarketRightRailDockLayout;
  readonly upColor?: string;
  readonly downColor?: string;
  readonly ariaLabel?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Shared resizable right-rail owner for live feeds and replay-local surfaces. */
export default function MarketRightRailFrame({
  source = "live",
  sidebar,
  renderDock,
  layout,
  dockLayout,
  upColor = "#22c55e",
  downColor = "#ef4444",
  ariaLabel = "市场侧栏",
}: MarketRightRailFrameProps) {
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
  const maximumDockHeight = railHeight > 0
    ? clamp(railHeight - MARKET_RAIL_MIN_SIDEBAR_HEIGHT - 8, MARKET_DOCK_MIN_HEIGHT, MARKET_DOCK_MAX_HEIGHT)
    : MARKET_DOCK_MAX_HEIGHT;
  const expandedDockHeight = clamp(
    transientHeight ?? dockLayout.height,
    MARKET_DOCK_MIN_HEIGHT,
    maximumDockHeight,
  );
  const dockHeight = dockLayout.collapsed ? MARKET_DOCK_COLLAPSED_HEIGHT : expandedDockHeight;
  const width = transientWidth ?? layout.width;
  const colorVars = useMemo<RailCssVars>(() => ({
    "--wl-up-color": upColor,
    "--wl-down-color": downColor,
  }), [downColor, upColor]);

  useEffect(() => {
    const element = railRef.current;
    if (!element) return undefined;
    const update = () => setRailHeight(element.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout.collapsed]);

  useEffect(() => {
    if (!widthResizing) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = widthStartRef.current;
      if (!start) return;
      const next = clamp(start.width - (event.clientX - start.x), MARKET_RAIL_MIN_WIDTH, MARKET_RAIL_MAX_WIDTH);
      transientWidthRef.current = next;
      setTransientWidth(next);
    };
    const onUp = () => {
      setWidthResizing(false);
      if (transientWidthRef.current !== null) layout.onWidthChange?.(transientWidthRef.current);
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
  }, [layout, widthResizing]);

  useEffect(() => {
    if (!heightResizing) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = heightStartRef.current;
      if (!start) return;
      const next = clamp(start.height - (event.clientY - start.y), MARKET_DOCK_MIN_HEIGHT, maximumDockHeight);
      transientHeightRef.current = next;
      setTransientHeight(next);
    };
    const onUp = () => {
      setHeightResizing(false);
      if (transientHeightRef.current !== null) dockLayout.onHeightChange(transientHeightRef.current);
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
  }, [dockLayout, heightResizing, maximumDockHeight]);

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
    dockLayout.onHeightChange(clamp(height, MARKET_DOCK_MIN_HEIGHT, maximumDockHeight));
  }, [dockLayout, maximumDockHeight]);
  const handleSeparatorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = expandedDockHeight + 20;
    if (event.key === "ArrowDown") next = expandedDockHeight - 20;
    if (event.key === "Home") next = MARKET_DOCK_MIN_HEIGHT;
    if (event.key === "End") next = maximumDockHeight;
    if (next === null) return;
    event.preventDefault();
    setDockHeight(next);
  }, [expandedDockHeight, maximumDockHeight, setDockHeight]);

  return (
    <>
      {!layout.collapsed && (
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
        className={`watchlist-sidebar right-market-rail ${layout.collapsed ? "collapsed" : ""} ${widthResizing ? "resizing" : ""}`}
        style={{ width: layout.collapsed ? 40 : width, ...colorVars }}
        aria-label={ariaLabel}
        data-runtime-source={source}
        data-market-shell-owner="right-rail"
      >
        {sidebar}
        {!layout.collapsed && (
          <>
            {!dockLayout.collapsed && (
              <div
                className={`market-rail-splitter ${heightResizing ? "active" : ""}`}
                onPointerDown={startHeightResize}
                onDoubleClick={() => setDockHeight(MARKET_DOCK_DEFAULT_HEIGHT)}
                onKeyDown={handleSeparatorKeyDown}
                role="separator"
                tabIndex={0}
                aria-label="调整自选与市场面板高度"
                aria-orientation="horizontal"
                aria-valuemin={MARKET_DOCK_MIN_HEIGHT}
                aria-valuemax={maximumDockHeight}
                aria-valuenow={expandedDockHeight}
              ><span aria-hidden="true" /></div>
            )}
            {renderDock(dockHeight)}
          </>
        )}
      </aside>
    </>
  );
}
