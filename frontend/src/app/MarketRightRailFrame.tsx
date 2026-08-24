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
import { t } from "../i18n/index.js";
import { useLocale } from "../i18n/useLocale.js";
import type { MarketRailViewDescriptor } from "./marketRailTypes.js";

type RailCssVars = CSSProperties & Record<`--${string}`, string | number>;

export interface MarketRightRailLayout {
  readonly width: number;
  readonly onWidthChange?: (value: number) => void;
}

export interface MarketRightRailFrameProps {
  readonly source?: "live" | "replay";
  readonly views: readonly MarketRailViewDescriptor[];
  /** Independently expanded accordion views. */
  readonly openViewIds: readonly string[];
  /** Hide the complete accordion without clearing expanded views. */
  readonly panelCollapsed?: boolean;
  readonly onToggleView: (viewId: string) => void;
  readonly onTogglePanelCollapsed?: () => void;
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

function minViewHeight(view: MarketRailViewDescriptor): number {
  return view.minHeight ?? (view.sizing === "flex" ? 120 : MARKET_DOCK_MIN_HEIGHT);
}

function maxViewHeight(view: MarketRailViewDescriptor): number {
  return view.maxHeight ?? MARKET_DOCK_MAX_HEIGHT;
}

function preferredViewHeight(
  view: MarketRailViewDescriptor,
  heights: Readonly<Record<string, number>>,
): number {
  const preferred = heights[view.id]
    ?? view.defaultHeight
    ?? (view.sizing === "flex" ? 260 : MARKET_DOCK_DEFAULT_HEIGHT);
  return clamp(Math.round(preferred), minViewHeight(view), maxViewHeight(view));
}

function PanelCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {collapsed ? (
        <path
          d="M6.5 3.5 11 8l-4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M9.5 3.5 5 8l4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** One shared free multi-open scroll accordion for live and replay runtimes. */
export default function MarketRightRailFrame({
  source = "live",
  views,
  openViewIds,
  panelCollapsed = false,
  onToggleView,
  onTogglePanelCollapsed,
  renderView,
  layout,
  viewHeights = {},
  onViewHeightChange,
  upColor = "#22c55e",
  downColor = "#ef4444",
  ariaLabel,
}: MarketRightRailFrameProps) {
  useLocale();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const pendingRevealRef = useRef<string | null>(null);
  const widthStartRef = useRef<{ x: number; width: number } | null>(null);
  const heightStartRef = useRef<{ y: number; viewId: string; height: number } | null>(null);
  const transientWidthRef = useRef<number | null>(null);
  const transientHeightsRef = useRef<Record<string, number> | null>(null);
  const [widthResizing, setWidthResizing] = useState(false);
  const [heightResizingViewId, setHeightResizingViewId] = useState<string | null>(null);
  const [transientWidth, setTransientWidth] = useState<number | null>(null);
  const [transientHeights, setTransientHeights] = useState<Record<string, number> | null>(null);

  const sortedViews = useMemo(
    () => views.slice().sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    [views],
  );
  const panelOpen = sortedViews.length > 0 && !panelCollapsed;
  const width = transientWidth ?? layout.width;
  const effectiveHeights = transientHeights ?? viewHeights;

  const colorVars = useMemo<RailCssVars>(() => ({
    "--wl-up-color": upColor,
    "--wl-down-color": downColor,
    "--market-activity-bar-width": `${MARKET_ACTIVITY_BAR_WIDTH}px`,
  }), [downColor, upColor]);

  useEffect(() => {
    if (panelCollapsed || pendingRevealRef.current === null) return undefined;
    const viewId = pendingRevealRef.current;
    if (!openViewIds.includes(viewId)) return undefined;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const section = sectionRefs.current.get(viewId);
      if (!panel || !section) return;
      const top = Math.max(0, section.offsetTop - 6);
      const bottom = section.offsetTop + section.offsetHeight;
      if (top < panel.scrollTop || bottom > panel.scrollTop + panel.clientHeight) {
        panel.scrollTo({ top, behavior: "smooth" });
      }
      pendingRevealRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [openViewIds, panelCollapsed]);

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
    if (heightResizingViewId === null) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = heightStartRef.current;
      if (!start) return;
      const view = sortedViews.find((candidate) => candidate.id === start.viewId);
      if (!view) return;
      const next = clamp(
        start.height + event.clientY - start.y,
        minViewHeight(view),
        maxViewHeight(view),
      );
      const nextHeights = {
        ...viewHeights,
        [start.viewId]: Math.round(next),
      };
      transientHeightsRef.current = nextHeights;
      setTransientHeights(nextHeights);
    };
    const onUp = () => {
      const start = heightStartRef.current;
      const committed = transientHeightsRef.current;
      setHeightResizingViewId(null);
      setTransientHeights(null);
      if (committed && onViewHeightChange && start) {
        const next = committed[start.viewId];
        if (next !== undefined) onViewHeightChange(start.viewId, next);
      }
      transientHeightsRef.current = null;
      heightStartRef.current = null;
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
  }, [heightResizingViewId, onViewHeightChange, sortedViews, viewHeights]);

  const startWidthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    widthStartRef.current = { x: event.clientX, width };
    setWidthResizing(true);
  }, [width]);

  const startHeightResize = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    view: MarketRailViewDescriptor,
    height: number,
  ) => {
    event.preventDefault();
    heightStartRef.current = { y: event.clientY, viewId: view.id, height };
    setHeightResizingViewId(view.id);
  }, []);

  const handleResizeKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
    view: MarketRailViewDescriptor,
    height: number,
  ) => {
    const min = minViewHeight(view);
    const max = maxViewHeight(view);
    let next: number | null = null;
    if (event.key === "ArrowUp") next = height - 20;
    if (event.key === "ArrowDown") next = height + 20;
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    onViewHeightChange?.(view.id, clamp(next, min, max));
  }, [onViewHeightChange]);

  const toggleView = useCallback((viewId: string) => {
    if (!openViewIds.includes(viewId) || panelCollapsed) {
      pendingRevealRef.current = viewId;
    }
    onToggleView(viewId);
  }, [onToggleView, openViewIds, panelCollapsed]);

  const collapseLabel = panelCollapsed ? t("rail.showPanel") : t("rail.hidePanel");
  const resolvedAriaLabel = ariaLabel ?? t("rail.ariaLabel");

  return (
    <aside
      className={`right-market-rail ${panelOpen ? "" : "panel-collapsed"} ${widthResizing ? "resizing" : ""}`}
      style={colorVars}
      aria-label={resolvedAriaLabel}
      data-runtime-source={source}
      data-layout-mode="scroll-accordion"
      data-market-shell-owner="right-rail"
      data-panel-open={panelOpen ? "true" : "false"}
      data-panel-collapsed={panelCollapsed ? "true" : "false"}
    >
      {sortedViews.length > 0 && (
        <>
          {panelOpen && (
            <div
              className={`wl-resize-handle ${widthResizing ? "active" : ""}`}
              onPointerDown={startWidthResize}
              role="separator"
              aria-label={t("rail.resizeWidth")}
              aria-orientation="vertical"
            />
          )}
          <div
            ref={panelRef}
            className="market-rail-panel"
            style={{ width, display: panelOpen ? undefined : "none" }}
            data-market-shell-owner="right-rail-panel"
            aria-hidden={panelOpen ? undefined : true}
          >
            {sortedViews.map((view, index) => {
              const expanded = openViewIds.includes(view.id);
              const height = preferredViewHeight(view, effectiveHeights);
              return (
                <section
                  key={view.id}
                  ref={(element) => {
                    if (element) sectionRefs.current.set(view.id, element);
                    else sectionRefs.current.delete(view.id);
                  }}
                  className={`market-rail-accordion-section ${expanded ? "expanded" : "collapsed"}`}
                  data-rail-view={view.id}
                  data-expanded={expanded ? "true" : "false"}
                >
                  {expanded ? (
                    <>
                      <div
                        id={`market-rail-view-${source}-${view.id}`}
                        className="market-rail-view-host"
                        style={{ height }}
                        data-slot={index === 0 ? "sidebar" : `view-${view.id}`}
                      >
                        {renderView(view.id, height)}
                      </div>
                      <div
                        className={`market-rail-splitter market-rail-view-resizer ${heightResizingViewId === view.id ? "active" : ""}`}
                        style={{ height: MARKET_RAIL_SPLITTER_HEIGHT }}
                        onPointerDown={(event) => startHeightResize(event, view, height)}
                        onDoubleClick={() => onViewHeightChange?.(
                          view.id,
                          view.defaultHeight ?? (view.sizing === "flex" ? 260 : MARKET_DOCK_DEFAULT_HEIGHT),
                        )}
                        onKeyDown={(event) => handleResizeKeyDown(event, view, height)}
                        role="separator"
                        tabIndex={0}
                        aria-label={t("rail.resizeHeight", { title: view.title })}
                        aria-orientation="horizontal"
                        aria-valuemin={minViewHeight(view)}
                        aria-valuemax={maxViewHeight(view)}
                        aria-valuenow={height}
                      >
                        <span aria-hidden="true" />
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="market-rail-accordion-trigger"
                      aria-expanded="false"
                      aria-label={t("rail.expandView", { title: view.title })}
                      onClick={() => toggleView(view.id)}
                    >
                      <span className="market-rail-accordion-chevron" aria-hidden="true">
                        <PanelCollapseIcon collapsed />
                      </span>
                      <strong>{view.title}</strong>
                      {view.collapsedSummary != null && (
                        <span className="market-rail-accordion-summary">{view.collapsedSummary}</span>
                      )}
                      {view.badge != null && view.badge !== "" && (
                        <span className="market-rail-accordion-badge">{view.badge}</span>
                      )}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <nav
        className="market-activity-bar"
        aria-label={t("rail.activityBar")}
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
              aria-expanded={active && !panelCollapsed}
              data-rail-view={view.id}
              onClick={() => toggleView(view.id)}
            >
              <span className="market-activity-icon" aria-hidden="true">{view.icon}</span>
              <span className="market-activity-label" aria-hidden="true">{view.title}</span>
              {view.badge != null && view.badge !== "" && (
                <span className="market-activity-badge">{view.badge}</span>
              )}
            </button>
          );
        })}
        {onTogglePanelCollapsed && (
          <button
            type="button"
            className={`market-activity-item market-activity-collapse ${panelCollapsed ? "active" : ""}`}
            title={collapseLabel}
            aria-label={collapseLabel}
            aria-pressed={panelCollapsed}
            data-rail-action="toggle-panel"
            disabled={sortedViews.length === 0}
            onClick={onTogglePanelCollapsed}
          >
            <span className="market-activity-icon" aria-hidden="true">
              <PanelCollapseIcon collapsed={panelCollapsed} />
            </span>
            <span className="market-activity-label" aria-hidden="true">
              {panelCollapsed ? t("rail.show") : t("rail.collapse")}
            </span>
          </button>
        )}
      </nav>
    </aside>
  );
}
