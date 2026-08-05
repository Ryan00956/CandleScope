import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  MARKET_ACTIVITY_BAR_WIDTH,
  MARKET_DOCK_DEFAULT_HEIGHT,
  MARKET_DOCK_MAX_HEIGHT,
  MARKET_DOCK_MIN_HEIGHT,
  MARKET_RAIL_MAX_WIDTH,
  MARKET_RAIL_MIN_WIDTH,
  MARKET_RAIL_SPLITTER_HEIGHT,
} from "../shared/marketRailLayout.js";
import {
  allocateRailViewHeights,
  orderedOpenViews,
} from "./marketRailOpenState.js";
import type { MarketRailViewDescriptor } from "./marketRailTypes.js";

type RailCssVars = CSSProperties & Record<`--${string}`, string | number>;

export interface MarketRightRailLayout {
  readonly width: number;
  readonly onWidthChange?: (value: number) => void;
}

export interface MarketRightRailFrameProps {
  readonly source?: "live" | "replay";
  readonly views: readonly MarketRailViewDescriptor[];
  readonly openViewIds: readonly string[];
  readonly onToggleView: (viewId: string) => void;
  readonly renderView: (viewId: string, height: number) => ReactNode;
  readonly layout: MarketRightRailLayout;
  readonly viewHeights?: Readonly<Record<string, number>>;
  readonly onViewHeightChange?: (viewId: string, height: number) => void;
  readonly upColor?: string;
  readonly downColor?: string;
  readonly ariaLabel?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** VS Code-style right rail: activity bar + optional stacked multi-view panel. */
export default function MarketRightRailFrame({
  source = "live",
  views,
  openViewIds,
  onToggleView,
  renderView,
  layout,
  viewHeights = {},
  onViewHeightChange,
  upColor = "#22c55e",
  downColor = "#ef4444",
  ariaLabel = "市场侧栏",
}: MarketRightRailFrameProps) {
  const railRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const widthStartRef = useRef<{ x: number; width: number } | null>(null);
  const heightStartRef = useRef<{
    y: number;
    aboveId: string;
    belowId: string;
    aboveHeight: number;
    belowHeight: number;
  } | null>(null);
  const transientWidthRef = useRef<number | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [widthResizing, setWidthResizing] = useState(false);
  const [heightResizing, setHeightResizing] = useState(false);
  const [transientWidth, setTransientWidth] = useState<number | null>(null);
  const [transientHeights, setTransientHeights] = useState<Record<string, number> | null>(null);

  const openViews = useMemo(
    () => orderedOpenViews(views, openViewIds),
    [openViewIds, views],
  );
  const panelOpen = openViews.length > 0;
  const width = transientWidth ?? layout.width;
  const effectiveHeights = transientHeights ?? viewHeights;

  const allocatedHeights = useMemo(
    () => allocateRailViewHeights(openViews, panelHeight, effectiveHeights),
    [effectiveHeights, openViews, panelHeight],
  );

  const colorVars = useMemo<RailCssVars>(() => ({
    "--wl-up-color": upColor,
    "--wl-down-color": downColor,
    "--market-activity-bar-width": `${MARKET_ACTIVITY_BAR_WIDTH}px`,
  }), [downColor, upColor]);

  useEffect(() => {
    const element = panelRef.current;
    if (!element || !panelOpen) return undefined;
    const update = () => setPanelHeight(element.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panelOpen, openViews.length]);

  useEffect(() => {
    if (!widthResizing) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = widthStartRef.current;
      if (!start) return;
      const next = clamp(
        start.width - (event.clientX - start.x),
        MARKET_RAIL_MIN_WIDTH,
        MARKET_RAIL_MAX_WIDTH,
      );
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
      const delta = event.clientY - start.y;
      const aboveView = openViews.find((view) => view.id === start.aboveId);
      const belowView = openViews.find((view) => view.id === start.belowId);
      const aboveMin = aboveView?.minHeight
        ?? (aboveView?.sizing === "flex" ? 120 : MARKET_DOCK_MIN_HEIGHT);
      const belowMin = belowView?.minHeight
        ?? (belowView?.sizing === "flex" ? 120 : MARKET_DOCK_MIN_HEIGHT);
      const aboveMax = aboveView?.maxHeight ?? MARKET_DOCK_MAX_HEIGHT;
      const belowMax = belowView?.maxHeight ?? MARKET_DOCK_MAX_HEIGHT;
      const pairTotal = start.aboveHeight + start.belowHeight;
      let nextAbove = clamp(start.aboveHeight + delta, aboveMin, Math.min(aboveMax, pairTotal - belowMin));
      let nextBelow = pairTotal - nextAbove;
      if (nextBelow > belowMax) {
        nextBelow = belowMax;
        nextAbove = pairTotal - nextBelow;
      }
      setTransientHeights({
        ...viewHeights,
        [start.aboveId]: Math.round(nextAbove),
        [start.belowId]: Math.round(nextBelow),
      });
    };
    const onUp = () => {
      setHeightResizing(false);
      setTransientHeights((current) => {
        if (current && onViewHeightChange) {
          const start = heightStartRef.current;
          if (start) {
            if (current[start.aboveId] !== undefined) {
              onViewHeightChange(start.aboveId, current[start.aboveId]!);
            }
            if (current[start.belowId] !== undefined) {
              onViewHeightChange(start.belowId, current[start.belowId]!);
            }
          }
        }
        heightStartRef.current = null;
        return null;
      });
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
  }, [heightResizing, onViewHeightChange, openViews, viewHeights]);

  const startWidthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    widthStartRef.current = { x: event.clientX, width };
    setWidthResizing(true);
  }, [width]);

  const startHeightResize = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    aboveId: string,
    belowId: string,
  ) => {
    event.preventDefault();
    heightStartRef.current = {
      y: event.clientY,
      aboveId,
      belowId,
      aboveHeight: allocatedHeights[aboveId] ?? MARKET_DOCK_DEFAULT_HEIGHT,
      belowHeight: allocatedHeights[belowId] ?? MARKET_DOCK_DEFAULT_HEIGHT,
    };
    setHeightResizing(true);
  }, [allocatedHeights]);

  const handleSplitterKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
    aboveId: string,
    belowId: string,
  ) => {
    const above = allocatedHeights[aboveId] ?? MARKET_DOCK_DEFAULT_HEIGHT;
    const below = allocatedHeights[belowId] ?? MARKET_DOCK_DEFAULT_HEIGHT;
    let delta = 0;
    if (event.key === "ArrowUp") delta = -20;
    if (event.key === "ArrowDown") delta = 20;
    if (event.key === "Home") delta = MARKET_DOCK_MIN_HEIGHT - above;
    if (event.key === "End") delta = above - MARKET_DOCK_MIN_HEIGHT;
    if (delta === 0) return;
    event.preventDefault();
    const pairTotal = above + below;
    const nextAbove = clamp(above + delta, MARKET_DOCK_MIN_HEIGHT, pairTotal - MARKET_DOCK_MIN_HEIGHT);
    const nextBelow = pairTotal - nextAbove;
    onViewHeightChange?.(aboveId, nextAbove);
    onViewHeightChange?.(belowId, nextBelow);
  }, [allocatedHeights, onViewHeightChange]);

  const sortedViews = useMemo(
    () => views.slice().sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    [views],
  );

  return (
    <aside
      ref={railRef}
      className={`right-market-rail ${panelOpen ? "" : "panel-collapsed"} ${widthResizing ? "resizing" : ""}`}
      style={colorVars}
      aria-label={ariaLabel}
      data-runtime-source={source}
      data-market-shell-owner="right-rail"
      data-panel-open={panelOpen ? "true" : "false"}
    >
      {panelOpen && (
        <>
          <div
            className={`wl-resize-handle ${widthResizing ? "active" : ""}`}
            onPointerDown={startWidthResize}
            role="separator"
            aria-label="调整右侧栏宽度"
            aria-orientation="vertical"
          />
          <div
            ref={panelRef}
            className="market-rail-panel"
            style={{ width }}
            data-market-shell-owner="right-rail-panel"
          >
            {openViews.map((view, index) => {
              const height = allocatedHeights[view.id] ?? 0;
              const next = openViews[index + 1];
              return (
                <div key={view.id} className="market-rail-stack-slot" data-rail-view={view.id}>
                  <div
                    className="market-rail-view-host"
                    style={{ height: height > 0 ? height : undefined, flex: height > 0 ? undefined : 1 }}
                    data-slot={index === 0 ? "sidebar" : index === openViews.length - 1 ? "dock" : `view-${view.id}`}
                  >
                    {renderView(view.id, height)}
                  </div>
                  {next && (
                    <div
                      className={`market-rail-splitter ${heightResizing ? "active" : ""}`}
                      style={{ height: MARKET_RAIL_SPLITTER_HEIGHT }}
                      onPointerDown={(event) => startHeightResize(event, view.id, next.id)}
                      onDoubleClick={() => {
                        onViewHeightChange?.(
                          next.sizing === "fixed" ? next.id : view.id,
                          next.defaultHeight ?? view.defaultHeight ?? MARKET_DOCK_DEFAULT_HEIGHT,
                        );
                      }}
                      onKeyDown={(event) => handleSplitterKeyDown(event, view.id, next.id)}
                      role="separator"
                      tabIndex={0}
                      aria-label={`调整 ${view.title} 与 ${next.title} 高度`}
                      aria-orientation="horizontal"
                    >
                      <span aria-hidden="true" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <nav
        className="market-activity-bar"
        aria-label="右侧工具栏"
        data-market-shell-owner="activity-bar"
      >
        {sortedViews.map((view) => {
          const active = openViewIds.includes(view.id);
          return (
            <button
              key={view.id}
              type="button"
              className={`market-activity-item ${active ? "active" : ""}`}
              title={view.title}
              aria-label={view.ariaLabel ?? view.title}
              aria-pressed={active}
              data-rail-view={view.id}
              onClick={() => onToggleView(view.id)}
            >
              <span className="market-activity-icon" aria-hidden="true">{view.icon}</span>
              {view.badge != null && view.badge !== "" && (
                <span className="market-activity-badge">{view.badge}</span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
