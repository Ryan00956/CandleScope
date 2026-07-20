import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { markPerfOnce } from "../../runtime/performance/perfMarks";
import { parseSymbolKey } from "../../utils/symbolKey";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SetStateAction,
} from "react";
import type { SymbolSelection } from "../symbol-search/useSymbolSearchRuntime.js";
import type { WatchlistRuntime } from "./useWatchlistRuntime.js";
import type { WatchlistPriceStore } from "./watchlistPriceStore.js";
import type { SubscriptionTier, WatchlistGroup } from "./watchlistTypes.js";
import {
  createWatchlistId,
  WATCHLIST_COLORS,
} from "./watchlistStore";

/** Remove trailing zeros after decimal point: "1.2000" → "1.2", "3.00" → "3" */
function stripZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/** Format price with appropriate decimal places, trailing zeros removed */
function formatPrice(p: number): string {
  let s;
  if (p >= 1000) s = p.toFixed(2);
  else if (p >= 1) s = p.toFixed(4);
  else if (p >= 0.01) s = p.toFixed(6);
  else s = p.toFixed(8);
  return stripZeros(s);
}

/** Format change absolute value, trailing zeros removed */
function formatChange(change: number): string {
  const abs = Math.abs(change);
  let s;
  if (abs >= 1000) s = change.toFixed(2);
  else if (abs >= 1) s = change.toFixed(4);
  else if (abs >= 0.01) s = change.toFixed(6);
  else s = change.toFixed(8);
  return stripZeros(s);
}

/** Format percentage, trailing zeros removed */
function formatPct(pct: number): string {
  return stripZeros(pct.toFixed(2));
}

const TIER_OPTIONS: ReadonlyArray<{
  value: SubscriptionTier;
  label: string;
  desc: string;
  title: string;
}> = [
  { value: "none", label: "不订阅", desc: "不消耗行情资源", title: "不订阅：不保活 ticker 或 K 线" },
  { value: "price", label: "仅价格", desc: "保活价格列", title: "仅价格：保活价格列" },
  { value: "full", label: "完全订阅", desc: "价格 + K线快切", title: "完全订阅：保活价格和可切换周期 K 线" },
];

const EMPTY_COLLAPSED_LISTS: string[] = [];
const noopAction = (...args: unknown[]): void => {
  void args;
};

type WatchlistLayout = WatchlistRuntime["view"]["layout"];
type WatchlistActions = WatchlistRuntime["actions"];
type SubscriptionResourceSummaries = WatchlistRuntime["view"]["subscriptionResourceSummaries"];
type DragType = "list" | "symbol";
type DropPosition = "above" | "below";
type DropTarget =
  | { type: "list"; listId: string; position: DropPosition }
  | { type: "symbol"; listId: string; index: number; position: DropPosition }
  | { type: "list-header"; listId: string };
type WatchlistContextMenu =
  | { type: "list"; x: number; y: number; listId: string }
  | { type?: "symbol"; x: number; y: number; symbol: string; listId: string };
type PriceFlashDirection = "up" | "down";
type WatchlistCssVars = CSSProperties & Record<`--${string}`, string | number>;

function watchlistColorStyle(color: string): WatchlistCssVars {
  return { "--wl-color": color || "#3b82f6" };
}

const emptyUnsubscribe = (): void => {};

interface WatchlistSymbolLiveColumnsProps {
  compositeKey: string;
  symbol: string;
  marketType: string;
  exchange: string;
  priceStore: WatchlistPriceStore | undefined;
  tierKnown: boolean;
  subscriptionTier: SubscriptionTier | undefined;
  fullTierTitle: string | undefined;
}

const WatchlistSymbolLiveColumns = memo(function WatchlistSymbolLiveColumns({
  compositeKey,
  symbol,
  marketType,
  exchange,
  priceStore,
  tierKnown,
  subscriptionTier,
  fullTierTitle,
}: WatchlistSymbolLiveColumnsProps) {
  const subscribe = useCallback((listener: () => void) => (
    priceStore?.subscribeSymbol(compositeKey, listener) ?? emptyUnsubscribe
  ), [compositeKey, priceStore]);
  const getSnapshot = useCallback(
    () => priceStore?.getSymbolSnapshot(compositeKey),
    [compositeKey, priceStore],
  );
  const tick = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const price = tick?.price;
  const previousPriceRef = useRef<number | undefined>(undefined);
  const [flashDirection, setFlashDirection] = useState<PriceFlashDirection | undefined>();

  useEffect(() => {
    const previousPrice = previousPriceRef.current;
    previousPriceRef.current = price;
    if (price === undefined || previousPrice === undefined || price === previousPrice) return undefined;
    const publishTimer = setTimeout(() => {
      setFlashDirection(price > previousPrice ? "up" : "down");
    }, 0);
    const clearTimer = setTimeout(() => setFlashDirection(undefined), 1_200);
    return () => {
      clearTimeout(publishTimer);
      clearTimeout(clearTimer);
    };
  }, [price]);

  const tier = tierKnown ? (subscriptionTier ?? "none") : (tick ? "price" : "none");
  const tierDot = tier === "full" ? "wl-tier-full" : tier === "price" ? "wl-tier-price" : "";
  const tierTitle = tier === "full"
    ? fullTierTitle || "完全订阅：保活价格和可切换周期 K 线"
    : "仅价格：保活价格列";
  const hasPrice = typeof price === "number" && tier !== "none";
  const change = hasPrice
    ? (tick?.daily_change ?? (price - (tick?.open ?? price)))
    : null;
  const changePct = hasPrice ? (tick?.daily_change_pct ?? tick?.change_pct ?? 0) : null;
  const isUp = change !== null ? change >= 0 : null;

  return (
    <>
      {tierDot && <span className={`wl-tier-dot ${tierDot}`} title={tierTitle}/>}
      <span className="wl-sym-name">
        {symbol}
        {marketType === "futures" && <span className="wl-market-badge futures">合约</span>}
        <span className={`wl-exchange-badge ${exchange}`}>
          {exchange === "okx" ? "OKX" : exchange === "binance" ? "币安" : exchange.toUpperCase()}
        </span>
      </span>
      {hasPrice ? (
        <>
          <span className={`wl-col-price ${flashDirection ? `wl-flash-${flashDirection}` : ""}`}>
            {formatPrice(price)}
          </span>
          <span className={`wl-col-change ${isUp ? "wl-val-up" : "wl-val-down"}`}>
            {isUp ? "+" : ""}{formatChange(change ?? 0)}
          </span>
          <span className={`wl-col-changepct ${isUp ? "wl-val-up" : "wl-val-down"}`}>
            {isUp ? "+" : ""}{formatPct(changePct ?? 0)}%
          </span>
        </>
      ) : (
        <>
          <span className="wl-col-price wl-col-empty">—</span>
          <span className="wl-col-change wl-col-empty">—</span>
          <span className="wl-col-changepct wl-col-empty">—</span>
        </>
      )}
    </>
  );
});

export interface WatchlistSidebarProps {
  currentSymbol: string;
  currentMarketType?: string | null;
  currentExchange?: string;
  onSelectSymbol(selection: SymbolSelection): void;
  watchlists?: WatchlistGroup[];
  onWatchlistsChange?: (watchlists: WatchlistGroup[]) => void;
  layout?: WatchlistLayout;
  actions?: Partial<WatchlistActions>;
  priceStore?: WatchlistPriceStore;
  subscriptionTiers?: Record<string, SubscriptionTier>;
  subscriptionResourceSummaries?: SubscriptionResourceSummaries;
  onTierChange?: (symbol: string, tier: SubscriptionTier) => void;
  upColor?: string;
  downColor?: string;
}

// ═══════════════════════════════════════════════════════════════
//  WatchlistSidebar — accordion layout with DnD + table-style price display
// ═══════════════════════════════════════════════════════════════
export default function WatchlistSidebar({
  currentSymbol, currentMarketType, currentExchange = "binance", onSelectSymbol,
  watchlists = [], onWatchlistsChange,
  layout,
  actions,
  priceStore, subscriptionTiers, subscriptionResourceSummaries, onTierChange,
}: WatchlistSidebarProps) {
  const setWatchlists = useCallback((updater: SetStateAction<WatchlistGroup[]>) => {
    if (actions?.setWatchlists) {
      actions.setWatchlists(updater);
      return;
    }
    if (onWatchlistsChange) {
      onWatchlistsChange(typeof updater === "function" ? updater(watchlists) : updater);
    }
  }, [actions, onWatchlistsChange, watchlists]);

  const sidebarCollapsed = layout?.sidebarCollapsed ?? false;
  const collapsedLists = layout?.collapsedLists ?? EMPTY_COLLAPSED_LISTS;
  const setSidebarCollapsed = actions?.setSidebarCollapsed ?? noopAction;
  const setCollapsedLists = actions?.setCollapsedLists ?? noopAction;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [contextMenu, setContextMenu] = useState<WatchlistContextMenu | null>(null);

  // ── DnD state ──
  const [dragType, setDragType] = useState<DragType | null>(null);
  const [dragListId, setDragListId] = useState<string | null>(null);
  const [dragSymbol, setDragSymbol] = useState<string | null>(null);
  const [dragSourceListId, setDragSourceListId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useEffect(() => {
    markPerfOnce("lazy.watchlist.ready");
  }, []);

  const editInputRef = useRef<HTMLInputElement | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);

  // ── Collapse / Expand lists ──
  const toggleListCollapse = useCallback((id: string) => {
    setCollapsedLists((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      return next;
    });
  }, [setCollapsedLists]);

  const isListCollapsed = useCallback((id: string) => collapsedLists.includes(id), [collapsedLists]);

  // ── CRUD ──
  const addWatchlist = useCallback(() => {
    setCreatingNew(true);
    setNewName("");
    setTimeout(() => newInputRef.current?.focus(), 60);
  }, []);

  const confirmNewWatchlist = useCallback(() => {
    const name = newName.trim() || `列表 ${watchlists.length + 1}`;
    const colorIdx = watchlists.length % WATCHLIST_COLORS.length;
    const newWl: WatchlistGroup = {
      id: createWatchlistId(),
      name,
      symbols: [],
      color: WATCHLIST_COLORS[colorIdx] ?? WATCHLIST_COLORS[0],
    };
    setWatchlists((prev) => [...prev, newWl]);
    setCreatingNew(false);
    setNewName("");
  }, [newName, watchlists.length, setWatchlists]);

  const cancelNew = useCallback(() => {
    setCreatingNew(false);
    setNewName("");
  }, []);

  const deleteWatchlist = useCallback((id: string) => {
    if (watchlists.length <= 1) return;
    setWatchlists((prev) => prev.filter((w) => w.id !== id));
    setCollapsedLists((prev) => prev.filter((x) => x !== id));
  }, [setCollapsedLists, watchlists.length, setWatchlists]);

  const renameWatchlist = useCallback((id: string) => {
    const wl = watchlists.find((w) => w.id === id);
    if (!wl) return;
    setEditingId(id);
    setEditingName(wl.name);
    setTimeout(() => editInputRef.current?.focus(), 60);
  }, [watchlists]);

  const confirmRename = useCallback(() => {
    if (!editingId) return;
    const name = editingName.trim();
    if (name) {
      setWatchlists((prev) => prev.map((w) => w.id === editingId ? { ...w, name } : w));
    }
    setEditingId(null);
  }, [editingId, editingName, setWatchlists]);

  const removeSymbol = useCallback((wlId: string, sym: string) => {
    setWatchlists((prev) =>
      prev.map((w) => w.id === wlId ? { ...w, symbols: w.symbols.filter((s) => s !== sym) } : w)
    );
  }, [setWatchlists]);

  // ═══════════════════════════════════════════════════════════
  //  DRAG & DROP — Lists reorder + Symbols reorder/cross-move
  // ═══════════════════════════════════════════════════════════

  // -- List DnD --
  const handleListDragStart = useCallback((e: ReactDragEvent<HTMLDivElement>, listId: string) => {
    setDragType("list");
    setDragListId(listId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", listId);
    const target = e.currentTarget;
    requestAnimationFrame(() => {
      target.style.opacity = "0.4";
    });
  }, []);

  const handleListDragEnd = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    e.currentTarget.style.opacity = "";
    setDragType(null);
    setDragListId(null);
    setDropTarget(null);
  }, []);

  const handleListDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, targetListId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragType !== "list") return;
    if (targetListId === dragListId) {
      setDropTarget(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const position = y < rect.height / 2 ? "above" : "below";
    setDropTarget({ type: "list", listId: targetListId, position });
  }, [dragType, dragListId]);

  const handleListDrop = useCallback((e: ReactDragEvent<HTMLDivElement>, targetListId: string) => {
    e.preventDefault();
    if (dragType !== "list" || !dragListId || dragListId === targetListId) return;
    setWatchlists((prev) => {
      const fromIdx = prev.findIndex((w) => w.id === dragListId);
      const toIdx = prev.findIndex((w) => w.id === targetListId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return prev;
      const insertIdx = next.findIndex((w) => w.id === targetListId);
      const pos = dropTarget?.type === "list" && dropTarget.position === "above"
        ? insertIdx
        : insertIdx + 1;
      next.splice(pos, 0, moved);
      return next;
    });
    setDragType(null);
    setDragListId(null);
    setDropTarget(null);
  }, [dragType, dragListId, dropTarget, setWatchlists]);

  // -- Symbol DnD --
  const handleSymbolDragStart = useCallback((
    e: ReactDragEvent<HTMLDivElement>,
    sym: string,
    listId: string,
  ) => {
    e.stopPropagation();
    setDragType("symbol");
    setDragSymbol(sym);
    setDragSourceListId(listId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sym);
    const target = e.currentTarget;
    requestAnimationFrame(() => {
      target.style.opacity = "0.4";
    });
  }, []);

  const handleSymbolDragEnd = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    e.currentTarget.style.opacity = "";
    setDragType(null);
    setDragSymbol(null);
    setDragSourceListId(null);
    setDropTarget(null);
  }, []);

  const handleSymbolDragOver = useCallback((
    e: ReactDragEvent<HTMLDivElement>,
    listId: string,
    index: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragType !== "symbol") return;
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const position = y < rect.height / 2 ? "above" : "below";
    setDropTarget({ type: "symbol", listId, index, position });
  }, [dragType]);

  const handleListHeaderDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, listId: string) => {
    e.preventDefault();
    if (dragType === "symbol") {
      e.dataTransfer.dropEffect = "move";
      setDropTarget({ type: "list-header", listId });
    }
  }, [dragType]);

  const handleSymbolDrop = useCallback((
    e: ReactDragEvent<HTMLDivElement>,
    targetListId: string,
    targetIndex: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragType !== "symbol" || !dragSymbol) return;

    setWatchlists((prev) => {
      return prev.map((wl) => {
        if (wl.id === dragSourceListId && wl.id === targetListId) {
          const syms = [...wl.symbols];
          const fromIdx = syms.indexOf(dragSymbol);
          if (fromIdx === -1) return wl;
          syms.splice(fromIdx, 1);
          let insertAt = targetIndex;
          if (dropTarget?.type === "symbol" && dropTarget.position === "below") insertAt += 1;
          if (fromIdx < insertAt) insertAt -= 1;
          insertAt = Math.max(0, Math.min(syms.length, insertAt));
          syms.splice(insertAt, 0, dragSymbol);
          return { ...wl, symbols: syms };
        }
        if (wl.id === dragSourceListId) {
          return { ...wl, symbols: wl.symbols.filter((s) => s !== dragSymbol) };
        }
        if (wl.id === targetListId) {
          if (wl.symbols.includes(dragSymbol)) return wl;
          const syms = [...wl.symbols];
          let insertAt = targetIndex;
          if (dropTarget?.type === "symbol" && dropTarget.position === "below") insertAt += 1;
          insertAt = Math.max(0, Math.min(syms.length, insertAt));
          syms.splice(insertAt, 0, dragSymbol);
          return { ...wl, symbols: syms };
        }
        return wl;
      });
    });

    setDragType(null);
    setDragSymbol(null);
    setDragSourceListId(null);
    setDropTarget(null);
  }, [dragType, dragSymbol, dragSourceListId, dropTarget, setWatchlists]);

  const handleListHeaderDrop = useCallback((e: ReactDragEvent<HTMLDivElement>, targetListId: string) => {
    e.preventDefault();
    if (dragType !== "symbol" || !dragSymbol) return;

    setWatchlists((prev) => {
      return prev.map((wl) => {
        if (wl.id === dragSourceListId && wl.id !== targetListId) {
          return { ...wl, symbols: wl.symbols.filter((s) => s !== dragSymbol) };
        }
        if (wl.id === targetListId) {
          if (wl.symbols.includes(dragSymbol)) return wl;
          return { ...wl, symbols: [...wl.symbols, dragSymbol] };
        }
        return wl;
      });
    });

    setCollapsedLists((prev) => prev.filter((x) => x !== targetListId));

    setDragType(null);
    setDragSymbol(null);
    setDragSourceListId(null);
    setDropTarget(null);
  }, [dragType, dragSymbol, dragSourceListId, setCollapsedLists, setWatchlists]);

  // ── Context menu ──
  const handleContextMenu = useCallback((
    e: ReactMouseEvent<HTMLDivElement>,
    sym: string,
    listId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, symbol: sym, listId });
  }, []);

  const handleListContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, listId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: "list", listId });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".wl-context-menu")) return;
      setContextMenu(null);
    };
    const timer = setTimeout(() => {
      window.addEventListener("click", dismiss);
      window.addEventListener("contextmenu", dismiss);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [contextMenu]);

  // ── Toggle sidebar collapse ──
  const toggleSidebarCollapse = useCallback(() => setSidebarCollapsed((p) => !p), [setSidebarCollapsed]);

  // ── isDrop target helpers ──
  const isListDropTarget = (id: string, pos: DropPosition): boolean =>
    dropTarget?.type === "list" && dropTarget.listId === id && dropTarget.position === pos;
  const isSymbolDropTarget = (listId: string, idx: number, pos: DropPosition): boolean =>
    dropTarget?.type === "symbol" && dropTarget.listId === listId && dropTarget.index === idx && dropTarget.position === pos;
  const isListHeaderDropTarget = (listId: string): boolean =>
    dropTarget?.type === "list-header" && dropTarget.listId === listId;

  // ── Render helper for price columns ──
  const renderSymbolRow = (compositeKey: string, wl: WatchlistGroup, idx: number): ReactNode => {
    const { symbol: sym, marketType: mt, exchange: ex } = parseSymbolKey(compositeKey);
    const isActive = (
      sym === currentSymbol
      && mt === (currentMarketType || "spot")
      && ex === (currentExchange || "binance")
    );
    const isDragged = dragType === "symbol" && dragSymbol === compositeKey && dragSourceListId === wl.id;
    const tierKnown = Object.prototype.hasOwnProperty.call(subscriptionTiers || {}, compositeKey);

    return (
      <div key={compositeKey} className="wl-sym-wrapper">
        {isSymbolDropTarget(wl.id, idx, "above") && <div className="wl-drop-bar"/>}
        <div
          className={`wl-sym-row ${isActive ? "active" : ""} ${isDragged ? "dragging" : ""}`}
          draggable
          onDragStart={(e) => handleSymbolDragStart(e, compositeKey, wl.id)}
          onDragEnd={handleSymbolDragEnd}
          onDragOver={(e) => handleSymbolDragOver(e, wl.id, idx)}
          onDrop={(e) => handleSymbolDrop(e, wl.id, idx)}
          onDragLeave={() => {
            if (dropTarget?.type === "symbol" && dropTarget.listId === wl.id && dropTarget.index === idx) setDropTarget(null);
          }}
          onClick={() => onSelectSymbol({ symbol: sym, marketType: mt, exchange: ex })}
          onContextMenu={(e) => handleContextMenu(e, compositeKey, wl.id)}
        >
          {/* Drag grip */}
          <span className="wl-sym-grip">
            <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
              <circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/>
              <circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/>
            </svg>
          </span>

          <WatchlistSymbolLiveColumns
            compositeKey={compositeKey}
            symbol={sym}
            marketType={mt}
            exchange={ex}
            priceStore={priceStore}
            tierKnown={tierKnown}
            subscriptionTier={subscriptionTiers?.[compositeKey]}
            fullTierTitle={subscriptionResourceSummaries?.[compositeKey]?.tooltip}
          />

          {/* Delete button */}
          <button className="wl-sym-del" onClick={(e) => { e.stopPropagation(); removeSymbol(wl.id, compositeKey); }} title="移除">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        {isSymbolDropTarget(wl.id, idx, "below") && <div className="wl-drop-bar"/>}
      </div>
    );
  };

  return (
    <>
      <div
        className={`watchlist-pane ${sidebarCollapsed ? "collapsed" : ""}`}
      >
        {/* ── Header ── */}
        <div className="wl-header">
          <button className="wl-collapse-btn" onClick={toggleSidebarCollapse}
            title={sidebarCollapsed ? "展开自选" : "收起自选"}>
            {sidebarCollapsed ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            )}
          </button>
          {!sidebarCollapsed && (
            <>
              <span className="wl-header-title">自选</span>
              <button className="wl-add-list-btn" onClick={addWatchlist} title="新建列表">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            </>
          )}
        </div>

        {/* ── Column header row (table header) ── */}
        {!sidebarCollapsed && (
          <div className="wl-table-header">
            <span className="wl-th-name">商品</span>
            <span className="wl-th-price">最新价</span>
            <span className="wl-th-change">涨跌</span>
            <span className="wl-th-changepct">涨跌%</span>
            <span className="wl-th-actions"></span>
          </div>
        )}

        {/* ── Collapsed view ── */}
        {sidebarCollapsed && (
          <div className="wl-collapsed-icons">
            <div className="wl-collapsed-icon" title="展开自选" onClick={toggleSidebarCollapse}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </div>
            {watchlists.map((wl) => (
              <div key={wl.id} className="wl-collapsed-tab"
                style={watchlistColorStyle(wl.color)}
                onClick={() => setSidebarCollapsed(false)}
                title={`${wl.name} (${wl.symbols.length})`}>
                <span className="wl-collapsed-dot"/>
                <span className="wl-collapsed-count">{wl.symbols.length}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Expanded: all lists accordion ── */}
        {!sidebarCollapsed && (
          <div className="wl-accordion-scroll">
            {watchlists.map((wl) => {
              const isCollapsed = isListCollapsed(wl.id);
              const isDraggedList = dragType === "list" && dragListId === wl.id;

              return (
                <div
                  key={wl.id}
                  className={`wl-list-block ${isDraggedList ? "dragging" : ""}`}
                >
                  {/* Drop indicator above */}
                  {isListDropTarget(wl.id, "above") && <div className="wl-drop-bar wl-drop-bar-list"/>}

                  {/* ── List header (draggable) ── */}
                  <div
                    className={`wl-list-header ${isListHeaderDropTarget(wl.id) ? "drop-highlight" : ""}`}
                    style={watchlistColorStyle(wl.color)}
                    draggable
                    onDragStart={(e) => handleListDragStart(e, wl.id)}
                    onDragEnd={handleListDragEnd}
                    onDragOver={(e) => {
                      handleListDragOver(e, wl.id);
                      handleListHeaderDragOver(e, wl.id);
                    }}
                    onDrop={(e) => {
                      if (dragType === "list") handleListDrop(e, wl.id);
                      else if (dragType === "symbol") handleListHeaderDrop(e, wl.id);
                    }}
                    onDragLeave={() => {
                      if (dropTarget?.listId === wl.id) setDropTarget(null);
                    }}
                    onContextMenu={(e) => handleListContextMenu(e, wl.id)}
                  >
                    {/* Drag grip */}
                    <span className="wl-list-grip" title="拖拽排序">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                        <circle cx="3" cy="2" r="1"/><circle cx="7" cy="2" r="1"/>
                        <circle cx="3" cy="5" r="1"/><circle cx="7" cy="5" r="1"/>
                        <circle cx="3" cy="8" r="1"/><circle cx="7" cy="8" r="1"/>
                      </svg>
                    </span>

                    {/* Collapse toggle */}
                    <button
                      className="wl-list-toggle"
                      onClick={(e) => { e.stopPropagation(); toggleListCollapse(wl.id); }}
                      title={isCollapsed ? "展开" : "收起"}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        {isCollapsed
                          ? <polyline points="9 18 15 12 9 6"/>
                          : <polyline points="6 9 12 15 18 9"/>}
                      </svg>
                    </button>

                    {/* Name or edit input */}
                    {editingId === wl.id ? (
                      <input
                        ref={editInputRef}
                        className="wl-list-name-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={confirmRename}
                        onKeyDown={(e) => { if (e.key === "Enter") confirmRename(); if (e.key === "Escape") setEditingId(null); }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="wl-list-name" onDoubleClick={() => renameWatchlist(wl.id)}>
                        <span className="wl-list-dot" />
                        {wl.name}
                      </span>
                    )}

                    <span className="wl-list-count">{wl.symbols.length}</span>
                  </div>

                  {/* ── List body (symbols) ── */}
                  <div className={`wl-list-body ${isCollapsed ? "collapsed" : ""}`}>
                    {!isCollapsed && wl.symbols.length === 0 && (
                      <div className="wl-list-empty"
                        onDragOver={(e) => { e.preventDefault(); if (dragType === "symbol") setDropTarget({ type: "list-header", listId: wl.id }); }}
                        onDrop={(e) => handleListHeaderDrop(e, wl.id)}
                      >
                        <span className="wl-list-empty-text">拖入或右键添加</span>
                      </div>
                    )}
                    {!isCollapsed && wl.symbols.map((sym, idx) => renderSymbolRow(sym, wl, idx))}
                  </div>

                  {/* Drop indicator below */}
                  {isListDropTarget(wl.id, "below") && <div className="wl-drop-bar wl-drop-bar-list"/>}
                </div>
              );
            })}

            {/* ── New watchlist input ── */}
            {creatingNew && (
              <div className="wl-list-block">
                <div className="wl-list-header wl-list-header-new" style={watchlistColorStyle(WATCHLIST_COLORS[watchlists.length % WATCHLIST_COLORS.length] ?? WATCHLIST_COLORS[0])}>
                  <span className="wl-list-dot"/>
                  <input
                    ref={newInputRef}
                    className="wl-list-name-input"
                    placeholder="输入列表名称..."
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onBlur={() => { if (newName.trim()) confirmNewWatchlist(); else cancelNew(); }}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmNewWatchlist(); if (e.key === "Escape") cancelNew(); }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div className="wl-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}>
          {contextMenu.type === "list" ? (
            <>
              <div className="wl-ctx-header">{watchlists.find((w) => w.id === contextMenu.listId)?.name || "列表"}</div>
              <button className="wl-ctx-item" onClick={() => { renameWatchlist(contextMenu.listId); setContextMenu(null); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                重命名
              </button>
              {watchlists.length > 1 && (
                <button className="wl-ctx-item wl-ctx-item-danger" onClick={() => { deleteWatchlist(contextMenu.listId); setContextMenu(null); }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  删除列表
                </button>
              )}
            </>
          ) : (() => {
              const { symbol: ctxSym } = parseSymbolKey(contextMenu.symbol);
              const ctxCompositeKey = contextMenu.symbol;
              const fullSummary = subscriptionResourceSummaries?.[ctxCompositeKey];
              return (
            <>
              <div className="wl-ctx-header">{ctxSym}</div>
              {/* Tier selection */}
              {onTierChange && (
                <>
                  <div className="wl-ctx-sub-header">订阅级别</div>
                  {TIER_OPTIONS.map((opt) => {
                    const currentTier = subscriptionTiers?.[ctxCompositeKey] || "none";
                    const desc = opt.value === "full" && fullSummary ? fullSummary.shortText : opt.desc;
                    const title = opt.value === "full" && fullSummary ? fullSummary.tooltip : opt.title;
                    return (
                      <button key={opt.value} className={`wl-ctx-item ${currentTier === opt.value ? "wl-ctx-item-selected" : ""}`}
                        title={title}
                        onClick={() => { onTierChange(ctxCompositeKey, opt.value); setContextMenu(null); }}>
                        <span className={`wl-tier-dot ${opt.value === "full" ? "wl-tier-full" : opt.value === "price" ? "wl-tier-price" : ""}`}/>
                        <span>{opt.label}</span>
                        <span className="wl-ctx-item-desc">{desc}</span>
                      </button>
                    );
                  })}
                  <div className="wl-ctx-divider"/>
                </>
              )}
              {/* Move to other lists */}
              {watchlists.filter((w) => w.id !== contextMenu.listId).map((wl) => (
                <button key={wl.id} className="wl-ctx-item" onClick={() => {
                  setWatchlists((prev) => prev.map((w) => {
                    if (w.id === contextMenu.listId) return { ...w, symbols: w.symbols.filter((s) => s !== contextMenu.symbol) };
                    if (w.id === wl.id && !w.symbols.includes(contextMenu.symbol)) return { ...w, symbols: [...w.symbols, contextMenu.symbol] };
                    return w;
                  }));
                  setContextMenu(null);
                }}>
                  <span className="wl-ctx-dot" style={{ background: wl.color }}/>
                  移至「{wl.name}」
                </button>
              ))}
              <div className="wl-ctx-divider"/>
              <button className="wl-ctx-item wl-ctx-item-danger" onClick={() => { removeSymbol(contextMenu.listId, contextMenu.symbol); setContextMenu(null); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
                移除
              </button>
            </>
              );
          })()}
        </div>
      )}
    </>
  );
}
