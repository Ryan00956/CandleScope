import { useCallback, useEffect, useRef, useState, useMemo } from "react";

// ── LocalStorage keys ──
const WATCHLISTS_KEY = "candlescope-watchlists";
const SIDEBAR_WIDTH_KEY = "candlescope-sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "candlescope-sidebar-collapsed";
const COLLAPSED_LISTS_KEY = "candlescope-collapsed-lists";

// ── Defaults ──
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 260;
const MAX_WIDTH = 520;

// ── Load/save helpers ──
function loadWatchlists() {
  try {
    const raw = localStorage.getItem(WATCHLISTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return [{ id: "default", name: "自选列表", symbols: [], color: "#3b82f6" }];
}
function saveWatchlists(lists) {
  localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(lists));
}
function loadSidebarWidth() {
  try {
    const w = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10) || DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
  }
  catch { return DEFAULT_WIDTH; }
}
function loadSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"; }
  catch { return false; }
}
function loadCollapsedLists() {
  try {
    const raw = localStorage.getItem(COLLAPSED_LISTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveCollapsedLists(ids) {
  localStorage.setItem(COLLAPSED_LISTS_KEY, JSON.stringify(ids));
}

let _nextId = Date.now();
function genId() { return `wl_${_nextId++}`; }

const WATCHLIST_COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#22c55e", "#f59e0b",
  "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
];

/** Format price with appropriate decimal places */
function formatPrice(p) {
  if (p >= 10000) return p.toFixed(2);
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
}

/** Format change absolute value */
function formatChange(change) {
  const abs = Math.abs(change);
  if (abs >= 1000) return change.toFixed(2);
  if (abs >= 1) return change.toFixed(4);
  if (abs >= 0.01) return change.toFixed(6);
  return change.toFixed(8);
}

const TIER_OPTIONS = [
  { value: "full", label: "完全订阅", desc: "自动同步所有K线" },
  { value: "price", label: "仅价格", desc: "只推送最新价格" },
  { value: "none", label: "仅收藏", desc: "不消耗后端资源" },
];

// ═══════════════════════════════════════════════════════════════
//  WatchlistSidebar — accordion layout with DnD + table-style price display
// ═══════════════════════════════════════════════════════════════
export default function WatchlistSidebar({
  currentSymbol, onSelectSymbol,
  watchlists: externalWatchlists, onWatchlistsChange,
  prices, subscriptionTiers, onTierChange,
  upColor, downColor,
}) {
  const [internalWatchlists, setInternalWatchlists] = useState(loadWatchlists);
  const watchlists = externalWatchlists || internalWatchlists;

  const setWatchlists = useCallback((updater) => {
    const doUpdate = (prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveWatchlists(next);
      return next;
    };
    if (externalWatchlists && onWatchlistsChange) {
      onWatchlistsChange(doUpdate(externalWatchlists));
    } else {
      setInternalWatchlists((prev) => doUpdate(prev));
    }
  }, [externalWatchlists, onWatchlistsChange]);

  const [width, setWidth] = useState(loadSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [collapsedLists, setCollapsedLists] = useState(loadCollapsedLists);
  const [isResizing, setIsResizing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [contextMenu, setContextMenu] = useState(null);

  // ── DnD state ──
  const [dragType, setDragType] = useState(null);       // "list" | "symbol"
  const [dragListId, setDragListId] = useState(null);
  const [dragSymbol, setDragSymbol] = useState(null);
  const [dragSourceListId, setDragSourceListId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);    // { type, listId, index, position }

  // ── Price flash tracking ──
  const prevPricesRef = useRef({});

  // Track which symbols are currently flashing and their direction
  const [flashStates, setFlashStates] = useState({});
  const flashTimersRef = useRef({});

  // Detect price changes and trigger flash animation
  useEffect(() => {
    if (!prices) return;
    const prev = prevPricesRef.current;
    const newFlashes = {};

    for (const [sym, tick] of Object.entries(prices)) {
      const prevTick = prev[sym];
      if (prevTick && tick.price !== prevTick.price) {
        const direction = tick.price > prevTick.price ? "up" : "down";
        newFlashes[sym] = direction;

        // Clear existing timer
        if (flashTimersRef.current[sym]) {
          clearTimeout(flashTimersRef.current[sym]);
        }

        // Set timer to clear flash (color only, no animation)
        flashTimersRef.current[sym] = setTimeout(() => {
          setFlashStates((prev) => {
            const next = { ...prev };
            delete next[sym];
            return next;
          });
          delete flashTimersRef.current[sym];
        }, 1200);
      }
    }

    if (Object.keys(newFlashes).length > 0) {
      setFlashStates((prev) => ({ ...prev, ...newFlashes }));
    }

    prevPricesRef.current = { ...prices };
  }, [prices]);

  // Cleanup flash timers on unmount
  useEffect(() => {
    return () => {
      for (const t of Object.values(flashTimersRef.current)) {
        clearTimeout(t);
      }
    };
  }, []);

  const sidebarRef = useRef(null);
  const resizeStartRef = useRef(null);
  const editInputRef = useRef(null);
  const newInputRef = useRef(null);

  // ── Color CSS vars ──
  const colorVars = useMemo(() => ({
    "--wl-up-color": upColor || "#22c55e",
    "--wl-down-color": downColor || "#ef4444",
  }), [upColor, downColor]);

  // ── Persist ──
  useEffect(() => { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); }, [width]);
  useEffect(() => { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { saveCollapsedLists(collapsedLists); }, [collapsedLists]);

  // ── Resize ──
  const handleResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = { x: e.clientX, w: width };
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e) => {
      const dx = e.clientX - resizeStartRef.current.x;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeStartRef.current.w - dx)));
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  // ── Collapse / Expand lists ──
  const toggleListCollapse = useCallback((id) => {
    setCollapsedLists((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      return next;
    });
  }, []);

  const isListCollapsed = useCallback((id) => collapsedLists.includes(id), [collapsedLists]);

  // ── CRUD ──
  const addWatchlist = useCallback(() => {
    setCreatingNew(true);
    setNewName("");
    setTimeout(() => newInputRef.current?.focus(), 60);
  }, []);

  const confirmNewWatchlist = useCallback(() => {
    const name = newName.trim() || `列表 ${watchlists.length + 1}`;
    const colorIdx = watchlists.length % WATCHLIST_COLORS.length;
    const newWl = { id: genId(), name, symbols: [], color: WATCHLIST_COLORS[colorIdx] };
    setWatchlists((prev) => [...prev, newWl]);
    setCreatingNew(false);
    setNewName("");
  }, [newName, watchlists.length, setWatchlists]);

  const cancelNew = useCallback(() => {
    setCreatingNew(false);
    setNewName("");
  }, []);

  const deleteWatchlist = useCallback((id) => {
    if (watchlists.length <= 1) return;
    setWatchlists((prev) => prev.filter((w) => w.id !== id));
    setCollapsedLists((prev) => prev.filter((x) => x !== id));
  }, [watchlists.length, setWatchlists]);

  const renameWatchlist = useCallback((id) => {
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

  const removeSymbol = useCallback((wlId, sym) => {
    setWatchlists((prev) =>
      prev.map((w) => w.id === wlId ? { ...w, symbols: w.symbols.filter((s) => s !== sym) } : w)
    );
  }, [setWatchlists]);

  // ═══════════════════════════════════════════════════════════
  //  DRAG & DROP — Lists reorder + Symbols reorder/cross-move
  // ═══════════════════════════════════════════════════════════

  // -- List DnD --
  const handleListDragStart = useCallback((e, listId) => {
    setDragType("list");
    setDragListId(listId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", listId);
    requestAnimationFrame(() => {
      const el = e.target;
      if (el) el.style.opacity = "0.4";
    });
  }, []);

  const handleListDragEnd = useCallback((e) => {
    e.target.style.opacity = "";
    setDragType(null);
    setDragListId(null);
    setDropTarget(null);
  }, []);

  const handleListDragOver = useCallback((e, targetListId) => {
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

  const handleListDrop = useCallback((e, targetListId) => {
    e.preventDefault();
    if (dragType !== "list" || !dragListId || dragListId === targetListId) return;
    setWatchlists((prev) => {
      const fromIdx = prev.findIndex((w) => w.id === dragListId);
      const toIdx = prev.findIndex((w) => w.id === targetListId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      const insertIdx = next.findIndex((w) => w.id === targetListId);
      const pos = dropTarget?.position === "above" ? insertIdx : insertIdx + 1;
      next.splice(pos, 0, moved);
      return next;
    });
    setDragType(null);
    setDragListId(null);
    setDropTarget(null);
  }, [dragType, dragListId, dropTarget, setWatchlists]);

  // -- Symbol DnD --
  const handleSymbolDragStart = useCallback((e, sym, listId) => {
    e.stopPropagation();
    setDragType("symbol");
    setDragSymbol(sym);
    setDragSourceListId(listId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sym);
    requestAnimationFrame(() => {
      e.target.style.opacity = "0.4";
    });
  }, []);

  const handleSymbolDragEnd = useCallback((e) => {
    e.target.style.opacity = "";
    setDragType(null);
    setDragSymbol(null);
    setDragSourceListId(null);
    setDropTarget(null);
  }, []);

  const handleSymbolDragOver = useCallback((e, listId, index) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragType !== "symbol") return;
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const position = y < rect.height / 2 ? "above" : "below";
    setDropTarget({ type: "symbol", listId, index, position });
  }, [dragType]);

  const handleListHeaderDragOver = useCallback((e, listId) => {
    e.preventDefault();
    if (dragType === "symbol") {
      e.dataTransfer.dropEffect = "move";
      setDropTarget({ type: "list-header", listId });
    }
  }, [dragType]);

  const handleSymbolDrop = useCallback((e, targetListId, targetIndex) => {
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
          if (dropTarget?.position === "below") insertAt += 1;
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
          if (dropTarget?.position === "below") insertAt += 1;
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

  const handleListHeaderDrop = useCallback((e, targetListId) => {
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
  }, [dragType, dragSymbol, dragSourceListId, setWatchlists]);

  // ── Context menu ──
  const handleContextMenu = useCallback((e, sym, listId) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, symbol: sym, listId });
  }, []);

  const handleListContextMenu = useCallback((e, listId) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: "list", listId });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e) => {
      if (e.target?.closest?.(".wl-context-menu")) return;
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
  const toggleSidebarCollapse = useCallback(() => setSidebarCollapsed((p) => !p), []);

  // ── isDrop target helpers ──
  const isListDropTarget = (id, pos) =>
    dropTarget?.type === "list" && dropTarget.listId === id && dropTarget.position === pos;
  const isSymbolDropTarget = (listId, idx, pos) =>
    dropTarget?.type === "symbol" && dropTarget.listId === listId && dropTarget.index === idx && dropTarget.position === pos;
  const isListHeaderDropTarget = (listId) =>
    dropTarget?.type === "list-header" && dropTarget.listId === listId;

  // ── Render helper for price columns ──
  const renderSymbolRow = (sym, wl, idx) => {
    const isActive = sym === currentSymbol;
    const isDragged = dragType === "symbol" && dragSymbol === sym && dragSourceListId === wl.id;
    const tick = prices?.[sym];
    const tierVal = subscriptionTiers?.[sym] || "none";
    const tierDot = tierVal === "full" ? "wl-tier-full" : tierVal === "price" ? "wl-tier-price" : "";
    const flashDir = flashStates[sym]; // "up" | "down" | undefined

    // Use daily (1D) change data from backend (matches 1D chart)
    const hasPrice = tick && tierVal !== "none";
    const change = hasPrice ? (tick.daily_change ?? (tick.price - tick.open)) : null;
    const changePct = hasPrice ? (tick.daily_change_pct ?? tick.change_pct) : null;
    const isUp = change !== null ? change >= 0 : null;
    
    // Determine price color: flash color on update, otherwise default
    const priceColorClass = flashDir ? `wl-flash-${flashDir}` : "";

    return (
      <div key={sym} className="wl-sym-wrapper">
        {isSymbolDropTarget(wl.id, idx, "above") && <div className="wl-drop-bar"/>}
        <div
          className={`wl-sym-row ${isActive ? "active" : ""} ${isDragged ? "dragging" : ""}`}
          draggable
          onDragStart={(e) => handleSymbolDragStart(e, sym, wl.id)}
          onDragEnd={handleSymbolDragEnd}
          onDragOver={(e) => handleSymbolDragOver(e, wl.id, idx)}
          onDrop={(e) => handleSymbolDrop(e, wl.id, idx)}
          onDragLeave={() => {
            if (dropTarget?.listId === wl.id && dropTarget?.index === idx) setDropTarget(null);
          }}
          onClick={() => onSelectSymbol(sym)}
          onContextMenu={(e) => handleContextMenu(e, sym, wl.id)}
        >
          {/* Drag grip */}
          <span className="wl-sym-grip">
            <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
              <circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/>
              <circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/>
            </svg>
          </span>

          {/* Tier dot */}
          {tierDot && <span className={`wl-tier-dot ${tierDot}`} title={tierVal === "full" ? "完全订阅" : "仅价格"}/>}

          {/* Symbol name */}
          <span className="wl-sym-name">{sym}</span>

          {/* Price columns — only if not "仅收藏" */}
          {hasPrice ? (
            <>
              {/* Latest price */}
              <span className={`wl-col-price ${priceColorClass}`}>
                {formatPrice(tick.price)}
              </span>

              {/* Change (absolute) */}
              <span className={`wl-col-change ${isUp ? "wl-val-up" : "wl-val-down"}`}>
                {isUp ? "+" : ""}{formatChange(change)}
              </span>

              {/* Change % */}
              <span className={`wl-col-changepct ${isUp ? "wl-val-up" : "wl-val-down"}`}>
                {isUp ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            </>
          ) : (
            <>
              <span className="wl-col-price wl-col-empty">—</span>
              <span className="wl-col-change wl-col-empty">—</span>
              <span className="wl-col-changepct wl-col-empty">—</span>
            </>
          )}

          {/* Delete button */}
          <button className="wl-sym-del" onClick={(e) => { e.stopPropagation(); removeSymbol(wl.id, sym); }} title="移除">
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
      {/* ── Resize handle (left edge of right sidebar) ── */}
      {!sidebarCollapsed && (
        <div className={`wl-resize-handle ${isResizing ? "active" : ""}`}
          onMouseDown={handleResizeMouseDown}/>
      )}

      <div
        className={`watchlist-sidebar ${sidebarCollapsed ? "collapsed" : ""} ${isResizing ? "resizing" : ""}`}
        style={{ width: sidebarCollapsed ? 40 : width, ...colorVars }}
        ref={sidebarRef}
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
                style={{ "--wl-color": wl.color || "#3b82f6" }}
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
                    style={{ "--wl-color": wl.color || "#3b82f6" }}
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
                <div className="wl-list-header wl-list-header-new" style={{ "--wl-color": WATCHLIST_COLORS[watchlists.length % WATCHLIST_COLORS.length] }}>
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
          ) : (
            <>
              <div className="wl-ctx-header">{contextMenu.symbol}</div>
              {/* Tier selection */}
              {onTierChange && (
                <>
                  <div className="wl-ctx-sub-header">订阅级别</div>
                  {TIER_OPTIONS.map((opt) => {
                    const currentTier = subscriptionTiers?.[contextMenu.symbol] || "none";
                    return (
                      <button key={opt.value} className={`wl-ctx-item ${currentTier === opt.value ? "wl-ctx-item-selected" : ""}`}
                        onClick={() => { onTierChange(contextMenu.symbol, opt.value); setContextMenu(null); }}>
                        <span className={`wl-tier-dot ${opt.value === "full" ? "wl-tier-full" : opt.value === "price" ? "wl-tier-price" : ""}`}/>
                        <span>{opt.label}</span>
                        <span className="wl-ctx-item-desc">{opt.desc}</span>
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
          )}
        </div>
      )}
    </>
  );
}

export { loadWatchlists, saveWatchlists, WATCHLISTS_KEY };
