import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiPaneChart from "./components/MultiPaneChart";
import DrawingToolbar from "./components/DrawingToolbar";
import ExportPanel from "./components/ExportPanel";
import SettingsModal from "./components/SettingsModal";
import IndicatorPanel from "./components/IndicatorPanel";
import AlertsPanel from "./components/alerts/AlertsPanel";
import IntervalSelector from "./components/IntervalSelector";
import SymbolSearch from "./components/SymbolSearch";
import WatchlistSidebar from "./components/WatchlistSidebar";
import { useCustomIntervals } from "./hooks/useCustomIntervals";
import { useExportPreview } from "./hooks/useExportPreview";
import { useIndicators } from "./hooks/useIndicators";
import { useBackfillCompletionRuntime } from "./runtime/useBackfillCompletionRuntime";
import { useCacheLimitsSync } from "./runtime/useCacheLimitsSync";
import { useChartBackgroundPrefetch } from "./runtime/useChartBackgroundPrefetch";
import { useChartGapRecovery } from "./runtime/useChartGapRecovery";
import { useChartInitialLoad } from "./runtime/useChartInitialLoad";
import { useChartLoadMoreLeft } from "./runtime/useChartLoadMoreLeft";
import { useChartDataRuntime } from "./runtime/useChartDataRuntime";
import { useKlineStreamRuntime } from "./runtime/useKlineStreamRuntime";
import { useWatchlistRuntime } from "./runtime/useWatchlistRuntime";
import { parseIntervalSeconds } from "./utils/intervals";
import { inferExchangeFromSymbol } from "./utils/symbolKey";
import {
  buildRenderableChartData,
} from "./runtime/chartDataRuntime";
import {
  buildSortedIntervals,
  getBaseWsIntervals,
  getExchangeConfig,
  getIntervalDays,
  getNativeIntervals,
  isNativeIntervalSupported,
  useExchangeCatalog,
} from "./runtime/exchangeCatalogRuntime";
import {
  getVisibleRangeForInterval,
  saveVisibleRangeForInterval,
} from "./runtime/viewportController";
import {
  updateSubscriptionTier,
} from "./services/api";
import { clearSavedDrawings } from "./services/drawingStorage";
import { buildExportOptionsKey, DEFAULT_EXPORT_OPTIONS, downloadBlob } from "./services/exportService";
import { loadWatchlists, saveWatchlists } from "./services/watchlistStorage";
import "./index.css";
// ---------- ErrorBoundary ----------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 16,
          color: "#94a3b8", padding: 32,
        }}>
          <div style={{ fontSize: 48 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>
            Chart rendering error
          </div>
          <div style={{ fontSize: 13, maxWidth: 400, textAlign: "center" }}>
            {this.state.error?.message || "Unknown error"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 24px", background: "#3b82f6", color: "#fff",
              border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------- User preference persistence ----------
const USER_PREFS_KEY = "candlescope-user-prefs";
const DEFAULT_CURSOR_TOOL = "cursor-default";
const CURSOR_TOOL_IDS = new Set([
  DEFAULT_CURSOR_TOOL,
  "cursor-crosshair",
  "cursor-dot",
  "cursor-highlighter",
  "cursor-plain",
]);

function loadUserPrefs() {
  try {
    const raw = localStorage.getItem(USER_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveUserPrefs(prefs) {
  localStorage.setItem(USER_PREFS_KEY, JSON.stringify(prefs));
}
function updateUserPref(key, value) {
  const prefs = loadUserPrefs();
  prefs[key] = value;
  saveUserPrefs(prefs);
}

function getSystemTheme() {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [symbol, setSymbol] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastSymbol || "BTCUSDT";
  });
  const [exchange, setExchange] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastExchange || inferExchangeFromSymbol(prefs.lastSymbol || "BTCUSDT", "binance");
  });
  const [marketType, setMarketType] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastMarketType || "spot";
  });
  const [interval, setInterval_] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastInterval || "1h";
  });
  const { exchangeCatalog, exchangeCatalogStatus } = useExchangeCatalog();
  const [datasetKey, setDatasetKey] = useState(0);

  const {
    chartData,
    chartDataMeta,
    pendingInitialHistoryRef,
    cacheKey,
    getFromCache,
    getCache,
    setCache,
    hasCache,
    clearCache,
    mergeCacheData,
    patchCacheTick,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
  } = useChartDataRuntime({ exchange, marketType, symbol, interval });
  const renderChartData = useMemo(
    () => buildRenderableChartData(chartData, parseIntervalSeconds(interval)),
    [chartData, interval],
  );
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const [error, setError] = useState(null);

  const [crosshairData, setCrosshairData] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState(null);

  const [wsStatus, setWsStatus] = useState("idle");
  const chartWidgetRef = useRef(null);
  const pageExportRef = useRef(null);

  // --- Drawing tool state ---
  const [drawingTool, setDrawingToolState] = useState(DEFAULT_CURSOR_TOOL);
  const lastCursorToolRef = useRef(DEFAULT_CURSOR_TOOL);
  const setDrawingTool = useCallback((nextTool) => {
    const normalizedTool = nextTool || lastCursorToolRef.current || DEFAULT_CURSOR_TOOL;
    if (CURSOR_TOOL_IDS.has(normalizedTool)) {
      lastCursorToolRef.current = normalizedTool;
    }
    setDrawingToolState(normalizedTool);
  }, []);
  const [penColor, setPenColor] = useState("#f59e0b");
  const [penSize, setPenSize] = useState(2);
  const [textFontSize, setTextFontSize] = useState(14);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);

  // --- Fibonacci tool settings ---
  const [fibLevels, setFibLevels] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-fib-levels");
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return null; // null = use DEFAULT_FIB_LEVELS
  });
  const [fibInverted, setFibInverted] = useState(() => {
    try {
      return localStorage.getItem("candlescope-fib-inverted") === "true";
    } catch { return false; }
  });
  const handleFibLevelsChange = useCallback((levels) => {
    setFibLevels(levels);
    try { localStorage.setItem("candlescope-fib-levels", JSON.stringify(levels)); } catch { /* ignore */ }
  }, []);
  const handleFibInvertedChange = useCallback((v) => {
    setFibInverted(v);
    try { localStorage.setItem("candlescope-fib-inverted", String(v)); } catch { /* ignore */ }
  }, []);

  // --- Position tool settings ---
  const [positionSize, setPositionSize] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-position-size");
      if (saved) return Number(saved);
    } catch { /* ignore */ }
    return 1000;
  });
  const handlePositionSizeChange = useCallback((size) => {
    setPositionSize(size);
    try { localStorage.setItem("candlescope-position-size", String(size)); } catch { /* ignore */ }
  }, []);

  // --- Invert price scale state ---
  const [invertScale, setInvertScale] = useState(() => {
    const prefs = loadUserPrefs();
    return !!prefs.invertScale;
  });
  const handleInvertScaleChange = useCallback((val) => {
    setInvertScale(val);
    updateUserPref("invertScale", val);
  }, []);

  // --- Price scale mode state (0=Normal, 1=Logarithmic, 2=Percentage, 3=IndexedTo100) ---
  const [priceScaleMode, setPriceScaleMode] = useState(() => {
    const prefs = loadUserPrefs();
    return typeof prefs.priceScaleMode === "number" ? prefs.priceScaleMode : 0;
  });
  const handlePriceScaleModeChange = useCallback((mode) => {
    setPriceScaleMode(mode);
    updateUserPref("priceScaleMode", mode);
  }, []);

  const handleClearDrawing = useCallback(() => {
    chartWidgetRef.current?.clearAllDrawings();
  }, []);

  // Toggle hide/show all drawings across panes (does not delete them).
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const handleToggleDrawingsHidden = useCallback(() => {
    setDrawingsHidden((prev) => !prev);
  }, []);
  useEffect(() => {
    chartWidgetRef.current?.setDrawingsHidden?.(drawingsHidden);
  }, [drawingsHidden]);

  // Toggle magnet snapping for drawing tools (pen always stays freehand).
  const [drawingSnapEnabled, setDrawingSnapEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem("candlescope-drawing-snap-enabled");
      return saved == null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const handleDrawingSnapEnabledChange = useCallback((enabled) => {
    setDrawingSnapEnabled(enabled);
    try { localStorage.setItem("candlescope-drawing-snap-enabled", String(enabled)); } catch { /* ignore */ }
  }, []);

  // Currently selected drawing on the chart (line/freehand/fibonacci).
  // When selection changes, mirror its stroke style into the toolbar's single
  // color/width controls so editing existing drawings and creating new ones
  // use the same visible state.
  const [selectedDrawing, setSelectedDrawing] = useState(null);
  useEffect(() => {
    if (!selectedDrawing) return;
    if (selectedDrawing.color) setPenColor(selectedDrawing.color);
    if (typeof selectedDrawing.lineWidth === "number") setPenSize(selectedDrawing.lineWidth);
  }, [selectedDrawing]);
  const handleSelectedDrawingStyleChange = useCallback((patch) => {
    chartWidgetRef.current?.updateSelectedDrawingStyle?.(patch);
  }, []);

  // --- Settings state (must be before useIndicators which needs settings.upColor/downColor) ---
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem("candlescope-settings");
    const defaults = {
      theme: "dark",
      customBg: "#0f172a",
      upColor: "#22c55e",
      downColor: "#ef4444",
      cachePreset: "standard",
      cacheLimits: { minutes: 200000, hours: 50000, daily: 0 },
      ephemeralCacheBars: 86400,
    };
    if (saved) {
      return { ...defaults, ...JSON.parse(saved) };
    }
    return defaults;
  });
  const [systemTheme, setSystemTheme] = useState(getSystemTheme);
  const resolvedTheme = settings.theme === "system" ? systemTheme : settings.theme;

  // --- Chart export state ---
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exportOptions, setExportOptions] = useState(() => {
    const prefs = loadUserPrefs();
    return { ...DEFAULT_EXPORT_OPTIONS, ...(prefs.chartExportOptions || {}) };
  });
  const [exportInProgress, setExportInProgress] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemThemeChange = (event) => {
      setSystemTheme(event.matches ? "light" : "dark");
    };

    setSystemTheme(mediaQuery.matches ? "light" : "dark");
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
    }

    mediaQuery.addListener(handleSystemThemeChange);
    return () => mediaQuery.removeListener(handleSystemThemeChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolvedTheme);
    if (settings.theme === "custom") {
      root.style.setProperty("--bg-primary", settings.customBg);
      root.style.setProperty("--bg-secondary", settings.customBg);
    } else {
      root.style.removeProperty("--bg-primary");
      root.style.removeProperty("--bg-secondary");
    }
    root.style.setProperty("--candle-up", settings.upColor);
    root.style.setProperty("--candle-down", settings.downColor);
    localStorage.setItem("candlescope-settings", JSON.stringify(settings));
  }, [resolvedTheme, settings]);

  // --- Indicator state ---
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  // Store the actual ref objects from ChartWidget (not copies of .current)
  // so useIndicators always reads the live chart/series instances.
  const indicatorChartRefRef = useRef(null);   // ref-to-ref: points to ChartWidget's chartRef
  const indicatorSeriesRefRef = useRef(null);  // ref-to-ref: points to ChartWidget's seriesRef
  const [indicatorSeriesReady, setIndicatorSeriesReady] = useState(0);

  const handleChartReady = useCallback(({ chartRef: cRef, seriesRef: sRef }) => {
    indicatorChartRefRef.current = cRef;    // store the REF object, not .current
    indicatorSeriesRefRef.current = sRef;   // store the REF object, not .current
    setIndicatorSeriesReady((prev) => prev + 1);
  }, []);

  const {
    activeIndicators,
    computing: indicatorComputing,
    addIndicator,
    removeIndicator: rawRemoveIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    recompute: recomputeIndicatorsWithUI,
    requestIndicatorRange,
    mainOverlayLines,
    subPanes,
    // Extended output types (Pyne drawing API)
    markers: indicatorMarkers,
    fills: indicatorFills,
    hlines: indicatorHlines,
    bgcolors: indicatorBgcolors,
    barcolors: indicatorBarcolors,
    paramSchemas: indicatorParamSchemas,
  } = useIndicators({
    chartRef: indicatorChartRefRef,
    seriesRef: indicatorSeriesRefRef,
    chartData,
    chartDataMeta,
    datasetKey: `${exchange}-${marketType}-${symbol}-${interval}-${datasetKey}`,
    seriesReady: indicatorSeriesReady,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
    symbol,
    interval,
    marketType,
    exchange,
  });
  const chartStorageKeyBase = `${exchange}:${marketType}:${symbol}`;

  const exportMetadata = useMemo(() => ({
    exchange,
    marketType,
    symbol,
    interval,
    theme: resolvedTheme,
  }), [exchange, interval, marketType, resolvedTheme, symbol]);

  const exportPreview = useExportPreview({
    isOpen: showExportPanel,
    options: exportOptions,
    metadata: exportMetadata,
    chartWidgetRef,
    pageExportRef,
    drawingsHidden,
    setDrawingsHidden,
  });

  const handleExportOptionsChange = useCallback((nextOptions) => {
    setExportOptions(nextOptions);
    setExportError(null);
    setExportNotice(null);
    updateUserPref("chartExportOptions", nextOptions);
  }, []);

  const handleToggleExportPanel = useCallback(() => {
    setExportError(null);
    setExportNotice(null);
    setShowExportPanel((prev) => !prev);
  }, []);

  const handleCloseExportPanel = useCallback(() => {
    if (exportInProgress) return;
    setShowExportPanel(false);
  }, [exportInProgress]);

  const handleExportChart = useCallback(async (requestedOptions = exportOptions) => {
    if (exportInProgress) return;

    const finalOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      ...exportOptions,
      ...requestedOptions,
      metadata: exportMetadata,
    };
    const finalOptionsKey = buildExportOptionsKey(finalOptions);
    const previewReady = exportPreview.blob && exportPreview.optionsKey === finalOptionsKey;

    setExportInProgress(true);
    setExportError(null);
    setExportNotice(null);

    try {
      if (!previewReady) {
        throw new Error("当前配置的预览还未生成完成，请等待右侧预览更新后再保存。 ");
      }

      downloadBlob(exportPreview.blob, exportPreview.filename);
      setExportNotice(`已保存 ${exportPreview.filename}`);
    } catch (err) {
      setExportError(err?.message || "保存失败，请稍后重试。 ");
    } finally {
      setExportInProgress(false);
    }
  }, [exportInProgress, exportMetadata, exportOptions, exportPreview.blob, exportPreview.filename, exportPreview.optionsKey]);

  const removeIndicator = useCallback((indicatorId) => {
    rawRemoveIndicator(indicatorId);
    clearSavedDrawings(`${chartStorageKeyBase}-separate-${indicatorId}`);
    clearSavedDrawings(`${chartStorageKeyBase}-volume-${indicatorId}`);
  }, [chartStorageKeyBase, rawRemoveIndicator]);

  // Current interval ref for WS message routing
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  // Canonical real-time price — always derived from the fastest (1m) stream
  // so all intervals display the same "current price" in the header.
  const realtimePriceRef = useRef(null);

  const updateLastPrice = useCallback((candidate, intv) => {
    setLastPrice((prev) => {
      if (!candidate || candidate.time == null) return prev;
      // Guard: only accept OHLCV from the currently active interval.
      // Without this, backfill events or stale fetches for non-current
      // intervals would overwrite the header with wrong data.
      if (intv !== intervalRef.current) return prev;
      // Build a display object that keeps OHLCV from the active interval's
      // last candle but overrides "close" with the most recent real-time price
      // when available, so the header always shows one consistent price.
      const rtPrice = realtimePriceRef.current;
      if (rtPrice != null) {
        return { ...candidate, close: rtPrice };
      }
      return candidate;
    });
  }, []);

  /** Update the canonical real-time price (called from WS tick handler). */
  const updateRealtimePrice = useCallback((closePrice) => {
    realtimePriceRef.current = closePrice;
    // Also push it into the displayed lastPrice immediately so the header
    // updates in real-time even when the active interval's candle hasn't changed.
    setLastPrice((prev) => {
      if (!prev) return prev;
      if (prev.close === closePrice) return prev;
      return { ...prev, close: closePrice };
    });
  }, []);

  // --- Saved custom intervals ---
  const {
    customIntervalRecords,
    savedCustomIntervals,
    addCustomInterval,
    markIntervalUsed,
    removeCustomInterval,
    restoreCustomInterval,
    togglePinCustomInterval,
    clearCustomIntervals,
  } = useCustomIntervals();
  const [intervalNotice, setIntervalNotice] = useState(null);
  const lastRemovedIntervalRef = useRef(null);
  const intervalNoticeTimerRef = useRef(null);
  const exchangeConfig = useMemo(
    () => getExchangeConfig(exchange, exchangeCatalog),
    [exchange, exchangeCatalog],
  );
  const exchangeMarketTypes = useMemo(
    () => exchangeConfig.markets.map((market) => market.market_type).filter(Boolean),
    [exchangeConfig],
  );
  const exchangeLimitations = exchangeConfig.knownLimitations || [];
  const nativeIntervals = useMemo(() => getNativeIntervals(exchange, exchangeCatalog), [exchange, exchangeCatalog]);
  const intervalGroups = useMemo(
    () => buildSortedIntervals(savedCustomIntervals, exchange, exchangeCatalog),
    [exchange, exchangeCatalog, savedCustomIntervals],
  );
  const baseWsIntervals = useMemo(() => getBaseWsIntervals(exchange, exchangeCatalog), [exchange, exchangeCatalog]);
  const trackedIntervals = useMemo(
    () => Array.from(new Set([...baseWsIntervals, ...savedCustomIntervals, interval])),
    [interval, savedCustomIntervals, baseWsIntervals],
  );
  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return;
    if (exchangeMarketTypes.length === 0 || exchangeMarketTypes.includes(marketType)) return;
    const nextMarketType = exchangeMarketTypes[0] || "spot";
    setMarketType(nextMarketType);
    updateUserPref("lastMarketType", nextMarketType);
  }, [exchangeCatalogStatus, exchangeMarketTypes, marketType]);
  useEffect(() => {
    if (exchangeCatalogStatus === "loading") return;
    if (savedCustomIntervals.includes(interval)) return;
    if (isNativeIntervalSupported(exchange, interval, exchangeCatalog)) return;
    const nextInterval = nativeIntervals.find((item) => item.value === "1h")?.value
      || nativeIntervals[0]?.value
      || "1h";
    setInterval_(nextInterval);
    updateUserPref("lastInterval", nextInterval);
  }, [exchange, exchangeCatalog, exchangeCatalogStatus, interval, nativeIntervals, savedCustomIntervals]);
  const trackedIntervalsRef = useRef(trackedIntervals);
  trackedIntervalsRef.current = trackedIntervals;

  // --- Watchlist state (shared between sidebar and search modal) ---
  const [watchlists, setWatchlists] = useState(loadWatchlists);
  const handleAddToWatchlist = useCallback((watchlistId, symbol) => {
    setWatchlists((prev) => {
      const next = prev.map((wl) => {
        if (wl.id === watchlistId && !wl.symbols.includes(symbol)) {
          return { ...wl, symbols: [...wl.symbols, symbol] };
        }
        return wl;
      });
      saveWatchlists(next);
      return next;
    });
  }, []);

  const {
    subscriptionTiers,
    setSubscriptionTiers,
    symbolPrices,
  } = useWatchlistRuntime({ watchlists });

  // Handle tier change from WatchlistSidebar context menu
  // sym is a composite key like "spot:BTCUSDT" or "futures:ETHUSDT"
  const handleTierChange = useCallback((sym, tier) => {
    const prevTier = subscriptionTiers[sym] || "none";
    setSubscriptionTiers((prev) => ({ ...prev, [sym]: tier }));
    updateSubscriptionTier(sym, tier).catch((err) => {
      console.warn("Failed to update tier:", err);
      setSubscriptionTiers((prev) => ({ ...prev, [sym]: prevTier }));
    });
  }, [setSubscriptionTiers, subscriptionTiers]);


  // Sync cache limits to backend when they change
  const { cacheLimits, ephemeralCacheBars } = settings;
  useCacheLimitsSync({ cacheLimits, ephemeralCacheBars });

  const {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    pendingLoadMoreLeftRef,
    handleNeedMoreLeft,
  } = useChartLoadMoreLeft({
    symbol,
    exchange,
    marketType,
    interval,
    chartData,
    loading,
    dataSource,
    cacheKey,
    commitMergedChartData,
    requestIndicatorRange,
  });

  const loadData = useChartInitialLoad({
    exchange,
    marketType,
    getIntervalDays,
    getFromCache,
    replaceChartData,
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
    pendingInitialHistoryRef,
    updateLastPrice,
    setConnectionStatus,
    setDatasetKey,
    setLoading,
    setError,
    setLoadingMoreLeft,
    setHasMoreLeft,
    setCrosshairData,
    setDataSource,
  });

  // ── Symbol switching handler ──
  const handleSymbolChange = useCallback((newSymbolOrObj) => {
    // Accept either a string symbol or { symbol, marketType } object
    let newSymbol, newMarketType, newExchange;
    if (typeof newSymbolOrObj === "object" && newSymbolOrObj !== null) {
      newSymbol = newSymbolOrObj.symbol;
      newMarketType = newSymbolOrObj.marketType || "spot";
      newExchange = newSymbolOrObj.exchange || "binance";
    } else {
      newSymbol = newSymbolOrObj;
      newMarketType = marketType;
      newExchange = exchange;
    }
    if (newSymbol === symbol && newMarketType === marketType && newExchange === exchange) return;

    // Persist choice
    const nextInterval = (
      savedCustomIntervals.includes(interval) || isNativeIntervalSupported(newExchange, interval, exchangeCatalog)
    ) ? interval : "1h";

    updateUserPref("lastSymbol", newSymbol);
    updateUserPref("lastMarketType", newMarketType);
    updateUserPref("lastExchange", newExchange);
    updateUserPref("lastInterval", nextInterval);

    // Clear in-memory caches for old symbol
    clearCache();
    realtimePriceRef.current = null;

    // Reset chart state
    clearChartData("symbol-switch-clear", newSymbol, nextInterval);
    setLastPrice(null);
    setCrosshairData(null);
    setLoading(true);
    setError(null);
    setHasMoreLeft(true);
    setDatasetKey((v) => v + 1);

    setExchange(newExchange);
    setMarketType(newMarketType);
    setSymbol(newSymbol);
    setInterval_(nextInterval);
  }, [clearCache, clearChartData, exchange, exchangeCatalog, interval, marketType, savedCustomIntervals, setHasMoreLeft, symbol]);

  useEffect(() => {
    loadData(symbol, interval, marketType, exchange);
  }, [symbol, interval, marketType, exchange, loadData]);

  const handleBackfillCompleted = useBackfillCompletionRuntime({
    symbol,
    exchange,
    marketType,
    intervalRef,
    loadingRef,
    pendingInitialHistoryRef,
    pendingLoadMoreLeftRef,
    cacheKey,
    getIntervalDays,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    setLastPrice,
    setError,
    setConnectionStatus,
    setLoading,
    setDatasetKey,
  });

  useKlineStreamRuntime({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    trackedIntervalsRef,
    intervalRef,
    getIntervalDays,
    commitMergedChartData,
    commitPatchedChartData,
    patchCacheTick,
    updateLastPrice,
    updateRealtimePrice,
    handleBackfillCompleted,
    setWsStatus,
  });

  useChartBackgroundPrefetch({
    symbol,
    exchange,
    marketType,
    trackedIntervals,
    hasCache,
    setCache,
  });

  const { resetGapRecovery } = useChartGapRecovery({
    loading,
    dataSource,
    symbol,
    exchange,
    marketType,
    intervalRef,
    trackedIntervalsRef,
    getIntervalDays,
    getCache,
    mergeCacheData,
    commitMergedChartData,
    requestIndicatorRange,
    updateLastPrice,
  });

  // Save visible range when switching away from current interval
  const saveCurrentVisibleRange = useCallback(() => {
    if (chartWidgetRef.current?.getVisibleRange) {
      const range = chartWidgetRef.current.getVisibleRange();
      if (range) {
        saveVisibleRangeForInterval(symbol, interval, range, marketType, exchange, chartDataMeta);
      }
    }
  }, [chartDataMeta, exchange, interval, marketType, symbol]);

  // Save visible range on page close/refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentVisibleRange();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentVisibleRange]);

  useEffect(() => () => {
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
  }, []);

  const showIntervalNotice = useCallback((notice) => {
    setIntervalNotice(notice);
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
    intervalNoticeTimerRef.current = setTimeout(() => {
      setIntervalNotice(null);
      intervalNoticeTimerRef.current = null;
    }, notice?.duration || 4200);
  }, []);

  const getFallbackIntervalAfterRemove = useCallback((removedInterval) => {
    const recentCustom = customIntervalRecords
      .filter((record) => record.value !== removedInterval)
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
    if (recentCustom) return recentCustom.value;

    const removedSeconds = parseIntervalSeconds(removedInterval);
    if (!removedSeconds) return isNativeIntervalSupported(exchange, "1h") ? "1h" : nativeIntervals[0]?.value || "1m";

    return [...nativeIntervals]
      .filter((item) => item.value !== removedInterval)
      .sort((a, b) => Math.abs(a.seconds - removedSeconds) - Math.abs(b.seconds - removedSeconds))[0]?.value || "1h";
  }, [customIntervalRecords, exchange, nativeIntervals]);

  const handleIntervalChange = (newInterval) => {
    if (newInterval !== interval) {
      saveCurrentVisibleRange();
      setCrosshairData(null);
      realtimePriceRef.current = null;
      setLastPrice(null);
      resetGapRecovery();
      setInterval_(newInterval);
      markIntervalUsed(newInterval);
      updateUserPref("lastInterval", newInterval);
    }
  };

  const handleCreateCustomInterval = (newInterval) => {
    if (isNativeIntervalSupported(exchange, newInterval)) {
      handleIntervalChange(newInterval);
      return { ok: true, added: false };
    }
    const result = addCustomInterval(newInterval, { markUsed: true });
    if (!result.ok) return { ok: false, message: "周期格式无效" };
    handleIntervalChange(result.value);
    showIntervalNotice({ type: "success", text: `${result.value} 已添加并切换` });
    return { ok: true, added: result.added };
  };

  const handleRemoveCustomInterval = (removedInterval) => {
    const removed = removeCustomInterval(removedInterval);
    if (!removed) return;
    lastRemovedIntervalRef.current = removed;
    if (interval === removedInterval) {
      handleIntervalChange(getFallbackIntervalAfterRemove(removedInterval));
    }
    showIntervalNotice({
      type: "warning",
      text: `${removedInterval} 已删除`,
      actionLabel: "撤销",
      duration: 6500,
    });
  };

  const handleRestoreCustomInterval = () => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (!restored) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: `${restored.value} 已恢复` });
  };

  const handleClearCustomIntervals = () => {
    const removed = clearCustomIntervals();
    if (removed.length === 0) return;
    const currentWasRemoved = removed.some((record) => record.value === interval);
    lastRemovedIntervalRef.current = removed[removed.length - 1] || null;
    if (currentWasRemoved) {
      const currentSeconds = parseIntervalSeconds(interval);
      const fallback = currentSeconds
        ? [...nativeIntervals].sort((a, b) => Math.abs(a.seconds - currentSeconds) - Math.abs(b.seconds - currentSeconds))[0]?.value
        : null;
      handleIntervalChange(fallback || "1h");
    }
    showIntervalNotice({
      type: "warning",
      text: `已清空 ${removed.length} 个自定义周期，最近一项可撤销`,
      actionLabel: "撤销最近一项",
      duration: 6500,
    });
  };

  const displayData = crosshairData || lastPrice;
  const priceChange = displayData ? ((displayData.close - displayData.open) / displayData.open) * 100 : 0;
  const isUp = priceChange >= 0;

  const formatPrice = (price) => {
    if (price == null) return "--";
    if (price >= 1000) {
      return price.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(8);
  };

  const formatPriceDiff = (diff) => {
    if (diff == null) return "--";
    const abs = Math.abs(diff);
    let raw;
    if (abs >= 1000) raw = abs.toFixed(2);
    else if (abs >= 1) raw = abs.toFixed(4);
    else raw = abs.toFixed(8);
    return parseFloat(raw).toString();
  };

  const formatVolume = (vol) => {
    if (vol == null) return "--";
    if (vol >= 1_000_000_000) return `${(vol / 1_000_000_000).toFixed(2)}B`;
    if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`;
    if (vol >= 1_000) return `${(vol / 1_000).toFixed(2)}K`;
    return vol.toFixed(2);
  };

  const wsStatusLabel = {
    idle: "Realtime idle",
    loading: "Realtime waiting",
    connecting: "Connecting WS...",
    live: "Live (WebSocket)",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    fallback: "Live (Polling fallback)",
    mock: "Mock mode",
  }[wsStatus] || "Unknown";
  const exchangeLabel = exchangeConfig.label || (
    exchange ? `${exchange.charAt(0).toUpperCase()}${exchange.slice(1)}` : "Unknown"
  );
  const marketLabel = exchangeConfig.markets.find((item) => item.market_type === marketType)?.label
    || (marketType === "futures" ? "Futures" : "Spot");

  return (
    <div className="app-layout" ref={pageExportRef}>
      <header className="top-bar" id="top-bar">
        <div className="logo">
          <div className="logo-icon">📈</div>
          <span className="logo-text">CandleScope</span>
        </div>

        <SymbolSearch
          currentSymbol={symbol}
          currentMarketType={marketType}
          currentExchange={exchange}
          exchangeCatalog={exchangeCatalog}
          onSelect={handleSymbolChange}
          watchlists={watchlists}
          onAddToWatchlist={handleAddToWatchlist}
        />

        <button
          className="settings-btn"
          onClick={() => setShowSettings(true)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "18px",
            padding: "4px",
            display: "flex",
          }}
        >
          ⚙️
        </button>

        <button
          className={`indicator-toggle-btn ${showIndicatorPanel ? "active" : ""}`}
          onClick={() => setShowIndicatorPanel((p) => !p)}
          title="指标 (Indicators)"
        >
          📊
          {activeIndicators.length > 0 && (
            <span className="indicator-badge">{activeIndicators.length}</span>
          )}
        </button>

        <button
          className={`indicator-toggle-btn alert-toggle-btn ${showAlertsPanel ? "active" : ""}`}
          onClick={() => setShowAlertsPanel((p) => !p)}
          title="警报 (Alerts)"
        >
          🔔
        </button>

        {displayData && (
          <div className="price-info">
            <span className={`current-price ${isUp ? "price-up" : "price-down"}`}>
              {formatPrice(displayData.close)}
            </span>
            <span className={`price-change ${isUp ? "change-positive" : "change-negative"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(priceChange).toFixed(2)}%
            </span>
          </div>
        )}

        {displayData && (
          <div className="ohlcv-bar">
            <div className="ohlcv-item">
              <span className="ohlcv-label">O</span>
              <span className="ohlcv-value">{formatPrice(displayData.open)}</span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">H</span>
              <span className="ohlcv-value" style={{ color: "var(--candle-up)" }}>
                {formatPrice(displayData.high)}
              </span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">L</span>
              <span className="ohlcv-value" style={{ color: "var(--candle-down)" }}>
                {formatPrice(displayData.low)}
              </span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">C</span>
              <span className={`ohlcv-value ${isUp ? "price-up" : "price-down"}`}>
                {formatPrice(displayData.close)}
              </span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">Vol</span>
              <span className="ohlcv-value">{formatVolume(displayData.volume)}</span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">涨跌</span>
              <span className="ohlcv-value" style={{ color: isUp ? "var(--candle-up)" : "var(--candle-down)" }}>
                {isUp ? "+" : "-"}{formatPriceDiff(displayData.close - displayData.open)} / {isUp ? "+" : ""}{priceChange.toFixed(2)}%
              </span>
            </div>
            <div className="ohlcv-item">
              <span className="ohlcv-label">振幅</span>
              <span className="ohlcv-value">
                {displayData.open ? ((displayData.high - displayData.low) / displayData.open * 100).toFixed(2) : "0.00"}%
              </span>
            </div>
          </div>
        )}
      </header>

      <IntervalSelector
        interval={interval}
        nativeIntervals={nativeIntervals}
        intervalGroups={intervalGroups}
        customIntervalRecords={customIntervalRecords}
        savedCustomIntervals={savedCustomIntervals}
        onSelectInterval={handleIntervalChange}
        onCreateCustomInterval={handleCreateCustomInterval}
        onRemoveCustomInterval={handleRemoveCustomInterval}
        onRestoreCustomInterval={handleRestoreCustomInterval}
        onTogglePinCustomInterval={togglePinCustomInterval}
        onClearCustomIntervals={handleClearCustomIntervals}
        intervalNotice={intervalNotice}
      />

      <div className="main-content-area">
      <div className="chart-with-toolbar">
        <DrawingToolbar
          activeTool={drawingTool}
          onToolChange={setDrawingTool}
          penColor={penColor}
          onPenColorChange={setPenColor}
          penSize={penSize}
          onPenSizeChange={setPenSize}
          onClearAll={handleClearDrawing}
          drawingsHidden={drawingsHidden}
          onToggleDrawingsHidden={handleToggleDrawingsHidden}
          drawingSnapEnabled={drawingSnapEnabled}
          onDrawingSnapEnabledChange={handleDrawingSnapEnabledChange}
          textFontSize={textFontSize}
          onTextFontSizeChange={setTextFontSize}
          textBold={textBold}
          onTextBoldChange={setTextBold}
          textItalic={textItalic}
          onTextItalicChange={setTextItalic}
          fibLevels={fibLevels}
          onFibLevelsChange={handleFibLevelsChange}
          fibInverted={fibInverted}
          onFibInvertedChange={handleFibInvertedChange}
          positionSize={positionSize}
          onPositionSizeChange={handlePositionSizeChange}
          selectedDrawing={selectedDrawing}
          onSelectedDrawingStyleChange={handleSelectedDrawingStyleChange}
          exportPanelOpen={showExportPanel}
          exportInProgress={exportInProgress}
          onToggleExportPanel={handleToggleExportPanel}
        />

        <ExportPanel
          isOpen={showExportPanel}
          options={exportOptions}
          onOptionsChange={handleExportOptionsChange}
          onExport={handleExportChart}
          onClose={handleCloseExportPanel}
          inProgress={exportInProgress}
          error={exportError}
          notice={exportNotice}
          metadata={exportMetadata}
          loading={loading || loadingMoreLeft}
          indicatorComputing={indicatorComputing}
          preview={exportPreview}
        />

        {error ? (
          <div className="chart-area">
            <div className="error-overlay">
              <div className="error-icon">⚠️</div>
              <div className="error-message">
                <strong>Data load failed</strong>
                <br />
                {error}
                <br />
                <small style={{ color: "var(--text-muted)", marginTop: 8, display: "block" }}>
                  Ensure backend is running: `uvicorn app.main:app --reload`
                </small>
              </div>
              <button className="retry-btn" onClick={() => loadData(symbol, interval)} id="retry-btn">
                Retry
              </button>
            </div>
          </div>
        ) : (
          <ErrorBoundary>
            <MultiPaneChart
              ref={chartWidgetRef}
              data={renderChartData}
              symbol={symbol}
              drawingKeyBase={chartStorageKeyBase}
              interval={interval}
              loading={loading}
              onCrosshairMove={setCrosshairData}
              onNeedMoreLeft={handleNeedMoreLeft}
              canLoadMoreLeft={hasMoreLeft && !loadingMoreLeft && !loading}
              datasetKey={`${exchange}-${marketType}-${symbol}-${interval}-${datasetKey}`}
              upColor={settings.upColor}
              downColor={settings.downColor}
              theme={resolvedTheme}
              customBg={settings.customBg}
              timezone={settings.timezone}
              savedVisibleRange={getVisibleRangeForInterval(symbol, interval, marketType, exchange)}
              dataMeta={chartDataMeta}
              onVisibleRangeChange={(range) => saveVisibleRangeForInterval(symbol, interval, range, marketType, exchange, chartDataMeta)}
              drawingTool={drawingTool}
              onDrawingToolChange={setDrawingTool}
              penColor={penColor}
              penSize={penSize}
              textFontSize={textFontSize}
              textBold={textBold}
              textItalic={textItalic}
              fibLevels={fibLevels}
              fibInverted={fibInverted}
              positionSize={positionSize}
              drawingSnapEnabled={drawingSnapEnabled}
              onSelectedDrawingChange={setSelectedDrawing}
              onChartReady={handleChartReady}
              mainOverlayLines={mainOverlayLines}
              subPanes={subPanes}
              indicatorMarkers={indicatorMarkers}
              indicatorFills={indicatorFills}
              indicatorHlines={indicatorHlines}
              indicatorBgcolors={indicatorBgcolors}
              indicatorBarcolors={indicatorBarcolors}
              invertScale={invertScale}
              onInvertScaleChange={handleInvertScaleChange}
              priceScaleMode={priceScaleMode}
              onPriceScaleModeChange={handlePriceScaleModeChange}
            />
          </ErrorBoundary>
        )}
      </div>

      <WatchlistSidebar
        currentSymbol={symbol}
        currentMarketType={marketType}
        currentExchange={exchange}
        onSelectSymbol={handleSymbolChange}
        watchlists={watchlists}
        onWatchlistsChange={(next) => { setWatchlists(next); saveWatchlists(next); }}
        prices={symbolPrices}
        subscriptionTiers={subscriptionTiers}
        onTierChange={handleTierChange}
        upColor={settings.upColor}
        downColor={settings.downColor}
      />

      </div> {/* end main-content-area */}

      {/* Indicator Panel — slides in from the right */}
      <IndicatorPanel
        isOpen={showIndicatorPanel}
        onClose={() => setShowIndicatorPanel(false)}
        activeIndicators={activeIndicators}
        paramSchemas={indicatorParamSchemas}
        computing={indicatorComputing}
        onAddIndicator={addIndicator}
        onRemoveIndicator={removeIndicator}
        onToggleVisibility={toggleVisibility}
        onUpdateParams={updateIndicatorParams}
        onUpdateScript={updateIndicatorScript}
        onRecompute={recomputeIndicatorsWithUI}
      />

      <AlertsPanel
        isOpen={showAlertsPanel}
        onClose={() => setShowAlertsPanel(false)}
        currentSymbol={symbol}
        currentMarketType={marketType}
        currentExchange={exchange}
        currentInterval={interval}
        displayPrice={displayData?.close ?? lastPrice?.close}
        wsStatus={wsStatus}
        watchlists={watchlists}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onUpdate={setSettings}
        currentSymbol={symbol}
        currentMarketType={marketType}
        currentExchange={exchange}
        watchlists={watchlists}
      />

      <footer className="status-bar" id="status-bar">
        <div className="status-left">
          <span>
            <span className={`status-dot ${connectionStatus}`} />
            {connectionStatus === "connected" && `Connected to ${exchangeLabel}`}
            {connectionStatus === "loading" && (dataSource === "mock" ? "Mock data mode" : "Loading...")}
            {connectionStatus === "disconnected" && "Disconnected"}
          </span>
          <span>{chartData.length} bars</span>
          {loadingMoreLeft && <span style={{ color: "#3b82f6" }}>Loading older data...</span>}
          {!hasMoreLeft && !loadingMoreLeft && <span style={{ color: "#94a3b8" }}>No more history</span>}
          {dataSource === "mock" && (
            <span style={{ color: "#f59e0b" }}>
              {exchangeLabel} unavailable, using mock data
            </span>
          )}
          {exchangeCatalogStatus === "fallback" && (
            <span style={{ color: "#f59e0b" }}>Exchange capabilities fallback</span>
          )}
          {exchangeLimitations.length > 0 && (
            <span title={exchangeLimitations.join(" | ")} style={{ color: "#94a3b8" }}>
              {exchangeLimitations.length} exchange limitation{exchangeLimitations.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="status-right">
          <span>{dataSource === "mock" ? "Demo Mode" : `${exchangeLabel} ${marketLabel}`}</span>
          <span>{wsStatusLabel}</span>
          <span>CandleScope v0.2.0</span>
        </div>
      </footer>
    </div>
  );
}
