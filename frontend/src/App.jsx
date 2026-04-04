import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiPaneChart from "./components/MultiPaneChart";
import DrawingToolbar from "./components/DrawingToolbar";
import SettingsModal from "./components/SettingsModal";
import IndicatorPanel from "./components/IndicatorPanel";
import SymbolSearch from "./components/SymbolSearch";
import WatchlistSidebar, { loadWatchlists, saveWatchlists } from "./components/WatchlistSidebar";
import { useIndicators } from "./hooks/useIndicators";
import {
  fetchKlinesBefore,
  fetchKlinesHistory,
  fetchLatestKlines,
  getMultiStreamUrl,
} from "./services/api";
import { clearSavedDrawings } from "./services/drawingStorage";
import "./index.css";

// ---------- Custom interval helpers ----------
const CUSTOM_INTERVAL_RE = /^(\d+)([smhdwM])$/;
function parseIntervalSeconds(intv) {
  const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
  const m = CUSTOM_INTERVAL_RE.exec(intv);
  if (!m) return null;
  return parseInt(m[1], 10) * (units[m[2]] || 60);
}
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

// ═══════════════════════════════════════════════════════════════
//  Exchange-specific interval configuration
//  Each exchange defines its own native intervals and default
//  history days. Adding a new exchange is as simple as adding
//  an entry here.
// ═══════════════════════════════════════════════════════════════
const EXCHANGE_INTERVALS = {
  binance: {
    label: "Binance",
    intervals: [
      { value: "1s",  label: "1s",  seconds: 1 },
      { value: "1m",  label: "1m",  seconds: 60 },
      { value: "3m",  label: "3m",  seconds: 180 },
      { value: "5m",  label: "5m",  seconds: 300 },
      { value: "15m", label: "15m", seconds: 900 },
      { value: "30m", label: "30m", seconds: 1800 },
      { value: "1h",  label: "1H",  seconds: 3600 },
      { value: "2h",  label: "2H",  seconds: 7200 },
      { value: "4h",  label: "4H",  seconds: 14400 },
      { value: "6h",  label: "6H",  seconds: 21600 },
      { value: "8h",  label: "8H",  seconds: 28800 },
      { value: "12h", label: "12H", seconds: 43200 },
      { value: "1d",  label: "1D",  seconds: 86400 },
      { value: "3d",  label: "3D",  seconds: 259200 },
      { value: "1w",  label: "1W",  seconds: 604800 },
      { value: "1M",  label: "1M",  seconds: 2592000 },
    ],
    // Default history depth per interval
    intervalDays: {
      "1s": 0.04, "1m": 1, "3m": 2, "5m": 3, "15m": 7, "30m": 14,
      "1h": 30, "2h": 60, "4h": 90, "6h": 120, "8h": 180, "12h": 180,
      "1d": 365, "3d": 730, "1w": 1095, "1M": 1095,
    },
  },
  // Future exchanges can be added here, e.g.:
  // okx: {
  //   label: "OKX",
  //   intervals: [
  //     { value: "1m", label: "1m", seconds: 60 },
  //     { value: "3m", label: "3m", seconds: 180 },
  //     { value: "5m", label: "5m", seconds: 300 },
  //     { value: "15m", label: "15m", seconds: 900 },
  //     { value: "30m", label: "30m", seconds: 1800 },
  //     { value: "1H", label: "1H", seconds: 3600 },
  //     { value: "2H", label: "2H", seconds: 7200 },
  //     { value: "4H", label: "4H", seconds: 14400 },
  //     { value: "6H", label: "6H", seconds: 21600 },
  //     { value: "12H", label: "12H", seconds: 43200 },
  //     { value: "1D", label: "1D", seconds: 86400 },
  //     { value: "1W", label: "1W", seconds: 604800 },
  //     { value: "1M", label: "1M", seconds: 2592000 },
  //   ],
  //   intervalDays: { ... },
  // },
};

/** Get native intervals for the current exchange */
function getNativeIntervals(exchange) {
  return EXCHANGE_INTERVALS[exchange]?.intervals || EXCHANGE_INTERVALS.binance.intervals;
}

/** Get WebSocket intervals to subscribe for the current exchange */
function getBaseWsIntervals(exchange) {
  return getNativeIntervals(exchange).map((i) => i.value);
}

function buildSortedIntervals(savedCustom, exchange = "binance") {
  const native = getNativeIntervals(exchange);
  const all = native.map((i) => ({ ...i, isCustom: false }));
  for (const intv of savedCustom) {
    const secs = parseIntervalSeconds(intv);
    if (secs && !all.some((a) => a.value === intv)) {
      all.push({ value: intv, label: intv, seconds: secs, isCustom: true });
    }
  }
  all.sort((a, b) => a.seconds - b.seconds);

  const seconds = all.filter((i) => i.seconds < 60);
  const minutes = all.filter((i) => i.seconds >= 60 && i.seconds < 3600);
  const hours = all.filter((i) => i.seconds >= 3600 && i.seconds < 86400);
  const days = all.filter((i) => i.seconds >= 86400);
  return [
    { label: "Seconds", items: seconds },
    { label: "Minutes", items: minutes },
    { label: "Hours", items: hours },
    { label: "Days", items: days },
  ].filter((g) => g.items.length > 0);
}

const CUSTOM_INTERVALS_KEY = "candlescope-custom-intervals";
function loadSavedCustomIntervals() {
  try {
    const raw = localStorage.getItem(CUSTOM_INTERVALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveSavedCustomIntervals(list) {
  localStorage.setItem(CUSTOM_INTERVALS_KEY, JSON.stringify(list));
}

// ---------- User preference persistence ----------
const USER_PREFS_KEY = "candlescope-user-prefs";
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

// Visible range persistence per symbol + interval
const VISIBLE_RANGE_KEY = "candlescope-visible-ranges";
function loadVisibleRanges() {
  try {
    const raw = localStorage.getItem(VISIBLE_RANGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function buildVisibleRangeStorageKey(symbol, interval) {
  return `${symbol}::${interval}`;
}
function normalizeVisibleRange(range) {
  if (!range || typeof range !== "object") return null;
  const normalized = {};
  if (range.logical && Number.isFinite(range.logical.from) && Number.isFinite(range.logical.to)) {
    normalized.logical = {
      from: range.logical.from,
      to: range.logical.to,
    };
  }
  if (range.time && Number.isFinite(range.time.from) && Number.isFinite(range.time.to)) {
    normalized.time = {
      from: range.time.from,
      to: range.time.to,
    };
  }
  if (Number.isFinite(range.barSpacing)) {
    normalized.barSpacing = range.barSpacing;
  }
  if (Number.isFinite(range.scrollPosition)) {
    normalized.scrollPosition = range.scrollPosition;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}
function saveVisibleRangeForInterval(symbol, interval, range) {
  const normalized = normalizeVisibleRange(range);
  if (!symbol || !interval || !normalized) return;
  const ranges = loadVisibleRanges();
  ranges[buildVisibleRangeStorageKey(symbol, interval)] = normalized;
  localStorage.setItem(VISIBLE_RANGE_KEY, JSON.stringify(ranges));
}
function getVisibleRangeForInterval(symbol, interval) {
  if (!symbol || !interval) return null;
  const ranges = loadVisibleRanges();
  return (
    normalizeVisibleRange(ranges[buildVisibleRangeStorageKey(symbol, interval)]) ||
    normalizeVisibleRange(ranges[interval]) ||
    null
  );
}

function getIntervalDays(intv, exchange = "binance") {
  const config = EXCHANGE_INTERVALS[exchange] || EXCHANGE_INTERVALS.binance;
  if (config.intervalDays[intv]) return config.intervalDays[intv];
  const secs = parseIntervalSeconds(intv);
  if (!secs) return 7;
  if (secs <= 1) return 1;
  if (secs <= 60) return 1;
  if (secs <= 300) return 3;
  if (secs <= 900) return 7;
  if (secs <= 1800) return 14;
  if (secs <= 3600) return 30;
  if (secs <= 14400) return 90;
  if (secs <= 43200) return 180;
  return 365;
}

function mergeByTime(older, current) {
  const merged = [...older, ...current];
  const uniq = new Map();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

function deduplicateByTime(data) {
  if (!data || data.length <= 1) return data;
  const seen = new Map();
  for (const item of data) {
    seen.set(item.time, item);
  }
  return Array.from(seen.values()).sort((a, b) => a.time - b.time);
}

/**
 * Detect gaps in a sorted K-line array.
 * Returns an array of { from, to } objects representing gap boundaries (unix seconds).
 * A gap is detected when the time difference between consecutive bars exceeds
 * 1.5× the expected interval (to allow for minor timing jitter).
 */
function detectGaps(data, intervalSeconds) {
  if (!data || data.length < 2 || !intervalSeconds || intervalSeconds <= 0) return [];
  const gaps = [];
  const threshold = intervalSeconds * 1.5;

  // Interior gaps: missing bars between consecutive entries
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].time - data[i - 1].time;
    if (diff > threshold) {
      gaps.push({
        from: data[i - 1].time,
        to: data[i].time,
        missingBars: Math.round(diff / intervalSeconds) - 1,
      });
    }
  }

  // Tail gap: latest bar is far behind current time
  // This catches the "app was offline / WS died" scenario where chart
  // shows continuous old data but no recent bars.
  const nowSecs = Math.floor(Date.now() / 1000);
  const latestBarTime = data[data.length - 1].time;
  const tailGap = nowSecs - latestBarTime;
  if (tailGap > intervalSeconds * 3) {
    gaps.push({
      from: latestBarTime,
      to: nowSecs,
      missingBars: Math.floor(tailGap / intervalSeconds),
      isTailGap: true,
    });
  }

  return gaps;
}

function upsertRealtimeKline(current, incoming) {
  if (!current || current.length === 0) return current;
  if (!incoming || incoming.time == null) return current;
  const next = { ...incoming };

  const firstTime = current[0].time;
  const lastIndex = current.length - 1;
  const lastTime = current[lastIndex].time;

  if (next.time < firstTime) return current;
  if (next.time === lastTime) {
    const updated = [...current];
    updated[lastIndex] = next;
    return updated;
  }
  if (next.time > lastTime) {
    return [...current, next];
  }

  const idx = current.findIndex((item) => item.time === next.time);
  if (idx === -1) return current;
  const updated = [...current];
  updated[idx] = next;
  return updated;
}

export default function App() {
  const [symbol, setSymbol] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastSymbol || "BTCUSDT";
  });
  const [exchange] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastExchange || "binance";
  });
  const [interval, setInterval_] = useState(() => {
    const prefs = loadUserPrefs();
    return prefs.lastInterval || "1h";
  });
  const [datasetKey, setDatasetKey] = useState(0);

  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMoreLeft, setLoadingMoreLeft] = useState(false);
  const [hasMoreLeft, setHasMoreLeft] = useState(true);
  const [error, setError] = useState(null);

  const [crosshairData, setCrosshairData] = useState(null);
  const [lastPrice, setLastPrice] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("loading");
  const [dataSource, setDataSource] = useState(null);

  const [wsStatus, setWsStatus] = useState("idle");
  const chartWidgetRef = useRef(null);

  // --- Drawing tool state ---
  const [drawingTool, setDrawingTool] = useState(null);
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

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", settings.theme);
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
  }, [settings]);

  // --- Indicator state ---
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
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
    computeAll: recomputeIndicators,
    recompute: recomputeIndicatorsWithUI,
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
    datasetKey: `${symbol}-${interval}-${datasetKey}`,
    seriesReady: indicatorSeriesReady,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
  });

  const removeIndicator = useCallback((indicatorId) => {
    rawRemoveIndicator(indicatorId);
    clearSavedDrawings(`${symbol}-separate-${indicatorId}`);
    clearSavedDrawings(`${symbol}-volume-${indicatorId}`);
  }, [rawRemoveIndicator, symbol]);

  // --- Custom interval state ---
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState(null);

  // --- Cross-interval data cache for instant switching ---
  const chartDataCacheRef = useRef(new Map());
  const cacheKey = (sym, intv) => `${sym}-${intv}`;
  const saveToCache = useCallback((sym, intv, data) => {
    chartDataCacheRef.current.set(cacheKey(sym, intv), data);
  }, []);
  const getFromCache = (sym, intv) => chartDataCacheRef.current.get(cacheKey(sym, intv));

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
  const [savedCustomIntervals, setSavedCustomIntervals] = useState(loadSavedCustomIntervals);
  const [showIntervalManager, setShowIntervalManager] = useState(false);
  const intervalGroups = buildSortedIntervals(savedCustomIntervals, exchange);
  const baseWsIntervals = useMemo(() => getBaseWsIntervals(exchange), [exchange]);
  const trackedIntervals = useMemo(
    () => Array.from(new Set([...baseWsIntervals, ...savedCustomIntervals, interval])),
    [interval, savedCustomIntervals, baseWsIntervals],
  );
  const trackedIntervalsRef = useRef(trackedIntervals);
  trackedIntervalsRef.current = trackedIntervals;
  const socketRef = useRef(null);
  const liveSubscribedIntervalsRef = useRef(new Set());

  const addCustomInterval = (intv) => {
    setSavedCustomIntervals((prev) => {
      if (prev.includes(intv)) return prev;
      const next = [...prev, intv];
      saveSavedCustomIntervals(next);
      return next;
    });
  };
  const removeCustomInterval = (intv) => {
    setSavedCustomIntervals((prev) => {
      const next = prev.filter((i) => i !== intv);
      saveSavedCustomIntervals(next);
      return next;
    });
    if (interval === intv) handleIntervalChange("1h");
  };

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


  // Sync cache limits to backend when they change
  useEffect(() => {
    const { cacheLimits, ephemeralCacheBars } = settings;
    if (!cacheLimits) return;
    fetch("/api/v1/settings/cache-limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        db_limits: cacheLimits,
        ephemeral_bars: ephemeralCacheBars ?? 86400,
      }),
    }).catch(() => {}); // fire-and-forget
  }, [settings.cacheLimits, settings.ephemeralCacheBars]);

  const abortRef = useRef(null);

  // ============================================================
  //  LOAD DATA — optimized for speed
  //  NOTE: When no cache exists, we keep loading=true until full
  //  history arrives (or backfill completes via WS).  This avoids
  //  showing an incorrect chart with only a few real-time bars
  //  before gap-fill is done.
  // ============================================================
  const loadData = useCallback(async (sym, intv) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // --- INSTANT SWITCH: show cached data immediately ---
    const cached = getFromCache(sym, intv);
    const hasCacheHit = cached && cached.length > 0;
    let shownInitialData = false;

    if (hasCacheHit) {
      setChartData(cached);
      updateLastPrice(cached[cached.length - 1], intv);
      setConnectionStatus("connected");
      setDatasetKey((v) => v + 1);
      setLoading(false);
      setError(null);
      shownInitialData = true;
    } else {
      setChartData([]);  // Clear old interval data to prevent cross-interval merging
      setLoading(true);
      setError(null);
      setConnectionStatus("loading");
    }
    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setCrosshairData(null);

    // ── PARALLEL FETCH: quick tail + full history simultaneously ──
    const days = getIntervalDays(intv);
    const [quickResult, historyResult] = await Promise.all([
      fetchLatestKlines(sym, intv, 5).catch(() => null),
      fetchKlinesHistory(sym, intv, days).catch(() => null),
    ]);

    if (controller.signal.aborted) return;

    // Process QUICK result — silently stage data behind loading overlay.
    // Do NOT clear loading here when no cache hit; we wait for full
    // history or backfill completion to ensure the chart is correct.
    if (quickResult?.data?.length) {
      setChartData((prev) => {
        if (prev.length === 0) {
          saveToCache(sym, intv, quickResult.data);
          return quickResult.data;
        }
        let updated = prev;
        quickResult.data.forEach((tick) => {
          updated = upsertRealtimeKline(updated, tick);
        });
        const deduped = deduplicateByTime(updated);
        saveToCache(sym, intv, deduped);
        return deduped;
      });
      const latestTick = quickResult.data[quickResult.data.length - 1];
      updateLastPrice(latestTick, intv);
      setDataSource(quickResult.source || "unknown");

      // Only clear loading immediately if we already had a cache hit
      // (data is already reliable).  Otherwise keep loading overlay.
      if (shownInitialData) {
        // Cache was already shown; quickResult just refreshes it — no-op.
      }
    }

    // Process FULL HISTORY result — this is the "correct" dataset.
    if (historyResult?.data?.length) {
      setChartData((prev) => {
        const merged = mergeByTime(historyResult.data, prev);
        saveToCache(sym, intv, merged);
        return merged;
      });
      const latest = historyResult.data[historyResult.data.length - 1];
      updateLastPrice(latest, intv);
      setDataSource(historyResult.source || "unknown");
      setConnectionStatus(historyResult.source === "mock" ? "loading" : "connected");

      if (!shownInitialData) {
        setDatasetKey((v) => v + 1);
        shownInitialData = true;
      }
      // History arrived — data is reliable, clear loading.
      setLoading(false);
    } else if (!shownInitialData) {
      // No history available yet — backfill is likely in progress.
      // Keep loading=true; the backfill_completed WS handler will
      // call setLoading(false) + setDatasetKey() once data arrives.
      // Set a safety timeout so we don't get stuck forever if
      // backfill fails or takes too long.
      setConnectionStatus("loading");

      const BACKFILL_TIMEOUT_MS = 30_000;
      const safetyTimer = setTimeout(() => {
        if (controller.signal.aborted) return;
        // Force-show whatever we have after timeout
        setLoading(false);
        if (!shownInitialData) {
          setDatasetKey((v) => v + 1);
        }
      }, BACKFILL_TIMEOUT_MS);
      // If the component is unmounted / interval changes, cancel the timer
      controller.signal.addEventListener("abort", () => clearTimeout(safetyTimer));
    }

    // Only clear loading if history provided data (handled above)
    // or cache was hit (handled at the top).  Do NOT unconditionally
    // setLoading(false) here — that was the old bug.
    if (shownInitialData) {
      setLoading(false);
    }
  }, [saveToCache, updateLastPrice]);

  // ── Symbol switching handler ──
  const handleSymbolChange = useCallback((newSymbol) => {
    if (newSymbol === symbol) return;

    // Persist choice
    updateUserPref("lastSymbol", newSymbol);

    // Clear in-memory caches for old symbol
    chartDataCacheRef.current.clear();
    realtimePriceRef.current = null;

    // Reset chart state
    setChartData([]);
    setLastPrice(null);
    setCrosshairData(null);
    setLoading(true);
    setError(null);
    setHasMoreLeft(true);
    setDatasetKey((v) => v + 1);

    // Trigger symbol change — this causes the WS useEffect to
    // reconnect and loadData to re-fetch for the new symbol.
    setSymbol(newSymbol);
  }, [symbol]);

  useEffect(() => {
    loadData(symbol, interval);
  }, [symbol, interval, loadData]);

  const syncSocketSubscriptions = useCallback((socket, desiredIntervals) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const desired = new Set(desiredIntervals);
    const active = liveSubscribedIntervalsRef.current;
    const toSubscribe = desiredIntervals.filter((intv) => !active.has(intv));
    const toUnsubscribe = Array.from(active).filter((intv) => !desired.has(intv));

    if (toSubscribe.length > 0) {
      socket.send(JSON.stringify({
        action: "subscribe",
        intervals: toSubscribe,
      }));
      toSubscribe.forEach((intv) => active.add(intv));
    }

    if (toUnsubscribe.length > 0) {
      socket.send(JSON.stringify({
        action: "unsubscribe",
        intervals: toUnsubscribe,
      }));
      toUnsubscribe.forEach((intv) => active.delete(intv));
    }
  }, []);

  // ============================================================
  //  SINGLE PERSISTENT MULTI-INTERVAL WEBSOCKET
  //  Connects once, subscribes to ALL intervals, updates all caches
  //  Features: exponential backoff, heartbeat ping, max retry limit
  // ============================================================
  useEffect(() => {
    let active = true;
    let socket = null;
    let reconnectTimer = null;
    let pingTimer = null;
    let pollInterval = null;
    let pollingInFlight = false;

    // --- Reconnect state ---
    const WS_RECONNECT_BASE_DELAY = 2000;   // start at 2s
    const WS_RECONNECT_MAX_DELAY = 60000;   // cap at 60s
    const WS_MAX_RECONNECT_ATTEMPTS = 20;   // after 20 failures, stay on polling
    const WS_PING_INTERVAL = 30000;         // heartbeat every 30s
    let reconnectDelay = WS_RECONNECT_BASE_DELAY;
    let reconnectAttempts = 0;

    const stopPing = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          try { socket.send("ping"); } catch { /* ignore */ }
        }
      }, WS_PING_INTERVAL);
    };

    const startPolling = () => {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (!active) return;
        if (pollingInFlight) return;
        pollingInFlight = true;
        try {
          const currentIntv = intervalRef.current;
          const result = await fetchLatestKlines(symbol, currentIntv, 2);
          if (!result?.data?.length) return;

          setChartData((prev) => {
            let updated = prev;
            result.data.forEach((tick) => {
              updated = upsertRealtimeKline(updated, tick);
            });
            const deduped = deduplicateByTime(updated);
            saveToCache(symbol, currentIntv, deduped);
            return deduped;
          });
          const latestTick = result.data[result.data.length - 1];
          updateLastPrice(latestTick, currentIntv);
          setWsStatus((prev) => (prev === "live" ? prev : "fallback"));
        } catch (pollErr) {
          console.warn("Polling fallback failed:", pollErr);
        } finally {
          pollingInFlight = false;
        }
      }, 1000);
    };

    const scheduleReconnect = () => {
      // Clear any existing reconnect timer to prevent duplicates
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      reconnectAttempts += 1;
      if (reconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
        console.warn(`WS: exceeded ${WS_MAX_RECONNECT_ATTEMPTS} reconnect attempts, staying on polling fallback`);
        setWsStatus("fallback");
        return;
      }

      console.log(`WS: scheduling reconnect #${reconnectAttempts} in ${reconnectDelay}ms`);
      setWsStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);

      // Exponential backoff: 2s → 4s → 8s → ... → 60s cap
      reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_DELAY);
    };

    const connect = () => {
      if (!active) return;
      setWsStatus("connecting");

      // Close any lingering old socket
      if (socket) {
        try { socket.close(); } catch { /* */ }
        socket = null;
      }

      try {
        const url = getMultiStreamUrl(symbol);
        socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) return;

          // Track whether this is a RE-connection (not the first connect)
          const isReconnection = reconnectAttempts > 0;

          // Reset reconnect state on successful connection
          reconnectDelay = WS_RECONNECT_BASE_DELAY;
          reconnectAttempts = 0;

          liveSubscribedIntervalsRef.current = new Set();
          syncSocketSubscriptions(socket, trackedIntervalsRef.current);
          setWsStatus("live");

          // Stop polling fallback — WS is live
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }

          // Start heartbeat ping
          startPing();

          // ── Recovery after WS reconnection ──
          // During WS downtime, some kline updates may have been missed.
          // Fetch recent bars for the active interval to fill the gap.
          if (isReconnection) {
            const currentIntv = intervalRef.current;
            const days = getIntervalDays(currentIntv);
            console.log(`[WS-Recovery] Reconnected, reloading full history for ${symbol}@${currentIntv}`);
            fetchKlinesHistory(symbol, currentIntv, days)
              .then((result) => {
                if (!active || !result?.data?.length) return;
                setChartData((prev) => {
                  const merged = mergeByTime(result.data, prev);
                  saveToCache(symbol, currentIntv, merged);
                  return merged;
                });
                const latest = result.data[result.data.length - 1];
                updateLastPrice(latest, currentIntv);
                console.log(`[WS-Recovery] Reloaded ${result.data.length} bars after reconnect`);
              })
              .catch((err) => {
                console.warn("[WS-Recovery] Failed to recover after reconnect:", err);
              });
          }
        };

        socket.onmessage = (event) => {
          if (!active) return;
          try {
            // Ignore pong text responses from heartbeat
            if (event.data === "pong") return;

            const msg = JSON.parse(event.data);

            if (msg.type === "stream_status") {
              // Only update status display for the currently active interval
              if (msg.interval === intervalRef.current) {
                if (msg.status === "live") setWsStatus("live");
                if (msg.status === "reconnecting") setWsStatus("reconnecting");
              }
              return;
            }

            if (msg.type === "subscribed" || msg.type === "connected" ||
              msg.type === "warning" || msg.type === "error") {
              return;
            }

            // ── Handle backfill completion: reload history for that interval ──
            if (msg.type === "backfill_completed") {
              const bfInterval = msg.interval;
              const bfSymbol = msg.symbol || symbol;

              // ── Dedup: skip if a reload for this interval is already in-flight or on cooldown ──
              const bfDedupeKey = `${bfSymbol}-${bfInterval}`;
              if (backfillReloadInFlightRef.current.has(bfDedupeKey)) {
                console.log(`[Backfill] Skipping duplicate reload for ${bfDedupeKey} (already in-flight/cooldown)`);
                return;
              }
              backfillReloadInFlightRef.current.add(bfDedupeKey);

              console.log(`Backfill completed for ${bfSymbol}@${bfInterval}, reloading data...`);
              const days = getIntervalDays(bfInterval);
              fetchKlinesHistory(bfSymbol, bfInterval, days)
                .then((result) => {
                  if (!result?.data?.length) return;
                  const currentIntv = intervalRef.current;
                  const key = cacheKey(bfSymbol, bfInterval);
                  const existingCache = chartDataCacheRef.current.get(key);
                  if (existingCache && existingCache.length > 0) {
                    const merged = mergeByTime(result.data, existingCache);
                    chartDataCacheRef.current.set(key, merged);
                  } else {
                    chartDataCacheRef.current.set(key, result.data);
                  }
                  if (bfInterval === currentIntv) {
                    setChartData((prev) => {
                      const merged = mergeByTime(result.data, prev);
                      saveToCache(bfSymbol, bfInterval, merged);
                      return merged;
                    });
                    // Only set lastPrice from backfill if no live price exists yet.
                    // Otherwise we'd overwrite the real-time WS price with stale
                    // history data, causing the header OHLCV to "jump" between
                    // live ticks and snapshot values from each backfill fetch.
                    setLastPrice((prev) => {
                      if (prev) return prev; // live price already flowing — keep it
                      const latest = result.data[result.data.length - 1];
                      return latest || prev;
                    });
                    setError(null);
                    setConnectionStatus("connected");
                    setLoading(false);
                    setDatasetKey((v) => v + 1);
                  }
                })
                .catch((err) => {
                  console.warn(`Failed to reload after backfill for ${bfInterval}:`, err);
                })
                .finally(() => {
                  // Release the dedup lock after cooldown
                  setTimeout(() => {
                    backfillReloadInFlightRef.current.delete(bfDedupeKey);
                  }, BACKFILL_RELOAD_COOLDOWN_MS);
                });

              // NOTE: Removed the redundant fetchKlinesBefore() call that was here.
              // The fetchKlinesHistory above already covers the full data range.
              // The extra fetchKlinesBefore was causing a request storm loop:
              //   backfill_completed → fetchHistory → triggers backfill → backfill_completed → ...
              // Left-side data loading is handled by handleNeedMoreLeft when the user scrolls.

              return;
            }


            if (msg.type !== "kline" || !msg.data) return;

            const msgInterval = msg.interval;
            const tick = msg.data;
            const currentIntv = intervalRef.current;
            const isCurrentInterval = msgInterval === currentIntv;

            // ── Use 1m stream as the canonical real-time price source ──
            // The 1m stream updates most frequently and always reflects
            // the latest trade price, ensuring all intervals show the
            // same "current price" in the header.
            if (msgInterval === "1m") {
              updateRealtimePrice(tick.close);
            }

            // ── Always update the background cache for this interval ──
            const key = cacheKey(symbol, msgInterval);
            const existingCache = chartDataCacheRef.current.get(key);
            if (existingCache && existingCache.length > 0) {
              const updatedCache = deduplicateByTime(
                upsertRealtimeKline(existingCache, tick)
              );
              chartDataCacheRef.current.set(key, updatedCache);
            }

            // ── Update active chart if this is the current interval ──
            // When the backend DataManager is active and sending aggregated
            // custom-interval K-lines directly (isCurrentInterval=true for
            // custom intervals like "7m"), we use those directly and skip
            // the client-side aggregation below to avoid double-update
            // conflicts on the last two bars.
            if (isCurrentInterval) {
              setChartData((prev) => {
                const next = deduplicateByTime(upsertRealtimeKline(prev, tick));
                saveToCache(symbol, currentIntv, next);
                return next;
              });
              updateLastPrice(tick, currentIntv);
            }
          } catch (parseErr) {
            console.error("WS parse failed:", parseErr);
          }
        };

        socket.onerror = () => {
          if (!active) return;
          // onerror is always followed by onclose, so just start polling here
          // and let onclose handle the reconnect scheduling
          startPolling();
        };

        socket.onclose = () => {
          if (!active) return;
          stopPing();
          startPolling();
          scheduleReconnect();
        };
      } catch (connectErr) {
        console.warn("WS initialization failed:", connectErr);
        startPolling();
        scheduleReconnect();
      }
    };

    // Start immediately — don't wait for data load
    connect();

    const initialFallbackTimer = setTimeout(() => {
      if (active && !pollInterval && (!socket || socket.readyState !== WebSocket.OPEN)) {
        startPolling();
      }
    }, 4000);

    return () => {
      active = false;
      clearTimeout(initialFallbackTimer);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      stopPing();
      if (pollInterval) clearInterval(pollInterval);
      if (socket) {
        try { socket.close(); } catch { /* */ }
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      liveSubscribedIntervalsRef.current = new Set();
    };
  }, [symbol, saveToCache, syncSocketSubscriptions, updateLastPrice, updateRealtimePrice]); // NOTE: no `interval` dep — WS is persistent across switches

  useEffect(() => {
    syncSocketSubscriptions(socketRef.current, trackedIntervals);
  }, [syncSocketSubscriptions, trackedIntervals]);

  // ---------- Background prefetch: load history for ALL intervals ----------
  useEffect(() => {
    let cancelled = false;
    const prefetch = async () => {
      // Fire-and-forget: load history for all tracked intervals into cache
      // so switching is instant
      for (const intv of trackedIntervals) {
        if (cancelled) break;
        const key = cacheKey(symbol, intv);
        if (chartDataCacheRef.current.has(key)) continue; // already cached

        const days = getIntervalDays(intv);
        try {
          const result = await fetchKlinesHistory(symbol, intv, days);
          if (cancelled) break;
          if (result?.data?.length) {
            chartDataCacheRef.current.set(key, result.data);
          }
        } catch {
          // Non-critical, continue
        }
        // Small delay to avoid hammering the backend
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    // Start prefetching after a short delay so the active interval loads first
    const timer = setTimeout(prefetch, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbol, trackedIntervals]);

  // ============================================================
  //  GAP DETECTION & AUTO-FILL
  //  Periodically checks chartData for interior gaps (missing bars)
  //  and automatically fetches the missing data from the backend.
  //  This is the last line of defense against K-line gaps.
  // ============================================================
  const gapFillInFlightRef = useRef(new Set()); // track in-flight gap fills to avoid duplicates
  const gapFillRetryCountRef = useRef(new Map()); // track retry count per interval
  const GAP_FILL_MAX_RETRIES = 3; // max consecutive gap-fill attempts per interval
  const GAP_FILL_COOLDOWN_MS = 30_000; // cooldown between gap-fill attempts
  const recoverGapsRef = useRef(null); // stable ref for use in WS effect

  // Backfill-completed dedup: prevent multiple rapid reloads for same interval
  const backfillReloadInFlightRef = useRef(new Set());
  const BACKFILL_RELOAD_COOLDOWN_MS = 10_000;

  // handleNeedMoreLeft cooldown
  const needMoreLeftCooldownRef = useRef(new Map()); // interval → timestamp
  const NEED_MORE_LEFT_COOLDOWN_MS = 3_000;

  // ============================================================
  //  SHARED GAP RECOVERY FUNCTION
  //  Scans chartData for interior gaps (missing bars) and fetches
  //  the missing data from the backend. Called from:
  //    1. chartData change effect (passive detection)
  //    2. visibilitychange handler (active recovery on tab focus)
  //    3. WS reconnect handler (recovery after reconnection)
  // ============================================================
  const recoverGaps = useCallback(async (currentData, sym, intv) => {
    if (!currentData || currentData.length < 3) return;

    const intvSecs = parseIntervalSeconds(intv);
    if (!intvSecs || intvSecs <= 0) return;

    const gaps = detectGaps(currentData, intvSecs);
    if (gaps.length === 0) return;

    // Use a single dedupe key per interval to avoid concurrent full-reloads
    const reloadKey = `${sym}-${intv}-fullreload`;
    if (gapFillInFlightRef.current.has(reloadKey)) return;
    gapFillInFlightRef.current.add(reloadKey);

    const totalMissing = gaps.reduce((sum, g) => sum + g.missingBars, 0);
    console.log(
      `[GapFill] Detected ${gaps.length} gap(s), ~${totalMissing} bars missing. ` +
      `Reloading full history for ${sym}@${intv}...`
    );

    try {
      // Strategy: reload full history — this is the most reliable way to
      // fill ANY gap (middle, tail, or multiple scattered gaps at once).
      const days = getIntervalDays(intv);
      const result = await fetchKlinesHistory(sym, intv, days);

      if (result?.data?.length > 0) {
        setChartData((prev) => {
          const merged = mergeByTime(result.data, prev);
          saveToCache(sym, intv, merged);
          // Verify gaps are actually fixed
          const remaining = detectGaps(merged, intvSecs);
          if (remaining.length > 0) {
            console.warn(`[GapFill] ${remaining.length} gap(s) remain after history reload`);
          } else {
            console.log(`[GapFill] All gaps filled successfully (${merged.length} total bars)`);
          }
          return merged;
        });
      }
    } catch (err) {
      console.warn(`[GapFill] Failed to reload history:`, err);
    } finally {
      // Cooldown: don't retry for 10s to avoid hammering
      setTimeout(() => {
        gapFillInFlightRef.current.delete(reloadKey);
      }, 10000);
    }
  }, [saveToCache]);

  // Keep recoverGapsRef in sync so closures (WS onopen) always call latest version
  recoverGapsRef.current = recoverGaps;

  // ── Passive gap detection: Periodic cache scan ──
  // Every 5s, scan the current cached data for gaps. By reading from
  // chartDataCacheRef, we avoid React state updater async issues and 
  // debounce cancellations from high-frequency real-time updates.
  useEffect(() => {
    if (loading || dataSource === "mock") return;

    const periodicTimer = setInterval(() => {
      if (!recoverGapsRef.current) return;

      const currentIntv = intervalRef.current;
      // Build cache key manually to avoid effect dependency on cacheKey function
      const currentCacheKey = `${symbol}-${currentIntv}`;
      const currentCache = chartDataCacheRef.current.get(currentCacheKey);

      if (currentCache && currentCache.length >= 3) {
        recoverGapsRef.current(currentCache, symbol, currentIntv);
      }
    }, 5000);

    return () => clearInterval(periodicTimer);
  }, [symbol, loading, dataSource]);

  // ============================================================
  //  VISIBILITY CHANGE — ACTIVE RECOVERY ON TAB FOCUS
  //  When the user switches back to this tab, immediately fetch
  //  recent klines to fill any gaps that accumulated while the
  //  browser throttled WS message processing in the background.
  // ============================================================
  const lastVisibleTimeRef = useRef(Date.now());
  const visibilityRecoveryInFlightRef = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "hidden") {
        // Record when the tab went to background
        lastVisibleTimeRef.current = Date.now();
        return;
      }

      // Tab is now visible again
      const hiddenDurationMs = Date.now() - lastVisibleTimeRef.current;
      const currentIntv = intervalRef.current;
      const intvSecs = parseIntervalSeconds(currentIntv);

      // If we were hidden for more than 5 seconds, trigger recovery unconditionally.
      // Browsers aggressively throttle WS messages when tabs are inactive.
      if (hiddenDurationMs < 5000) return;

      // Prevent concurrent recovery
      if (visibilityRecoveryInFlightRef.current) return;
      visibilityRecoveryInFlightRef.current = true;

      console.log(
        `[TabRecovery] Tab was hidden for ${(hiddenDurationMs / 1000).toFixed(1)}s, ` +
        `recovering data for ${symbol}@${currentIntv}...`
      );

      try {
        // Strategy: reload FULL history for the active interval.
        // This is the most reliable approach — it covers any gap
        // (middle, tail, or multiple scattered gaps) in one shot.
        const days = getIntervalDays(currentIntv);
        const historyResult = await fetchKlinesHistory(symbol, currentIntv, days);

        if (historyResult?.data?.length > 0) {
          setChartData((prev) => {
            const merged = mergeByTime(historyResult.data, prev);
            saveToCache(symbol, currentIntv, merged);

            // Verify gaps are gone
            const remaining = detectGaps(merged, intvSecs);
            if (remaining.length > 0) {
              console.warn(`[TabRecovery] ${remaining.length} gap(s) remain after history reload`);
            } else {
              console.log(`[TabRecovery] All gaps filled (${merged.length} total bars)`);
            }
            return merged;
          });
          const latest = historyResult.data[historyResult.data.length - 1];
          updateLastPrice(latest, currentIntv);
          console.log(`[TabRecovery] Reloaded ${historyResult.data.length} bars of full history`);
        }

        // Also refresh background caches for other intervals
        for (const bgIntv of trackedIntervalsRef.current) {
          if (bgIntv === currentIntv) continue;
          const bgKey = cacheKey(symbol, bgIntv);
          const bgCache = chartDataCacheRef.current.get(bgKey);
          if (!bgCache || bgCache.length === 0) continue;

          try {
            const bgResult = await fetchLatestKlines(symbol, bgIntv, 10);
            if (bgResult?.data?.length > 0) {
              const bgMerged = mergeByTime(bgResult.data, bgCache);
              chartDataCacheRef.current.set(bgKey, bgMerged);
            }
          } catch {
            // Non-critical — background cache refresh
          }
        }
      } catch (err) {
        console.warn("[TabRecovery] Recovery failed:", err);
      } finally {
        visibilityRecoveryInFlightRef.current = false;
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [symbol, saveToCache, updateLastPrice, recoverGaps]);

  // ---- handle load more left ----
  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime) => {
      if (loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") return;
      if (!chartData.length) return;

      // ── Cooldown: prevent rapid repeated calls ──
      // Uses adaptive cooldown: longer when backend is backfilling (0 bars returned)
      const cooldownKey = interval;
      const lastCall = needMoreLeftCooldownRef.current.get(cooldownKey) || 0;
      if (Date.now() - lastCall < NEED_MORE_LEFT_COOLDOWN_MS) return;

      const before = oldestLoadedTime || chartData[0].time;
      setLoadingMoreLeft(true);
      try {
        const result = await fetchKlinesBefore(symbol, interval, before, 500);
        const older = result.data || [];

        if (older.length > 0) {
          setChartData((prev) => {
            const merged = mergeByTime(older, prev);
            saveToCache(symbol, interval, merged);
            return merged;
          });
          // Normal cooldown on successful fetch
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now());
        } else if (result.has_more) {
          // Backend returned 0 bars but says there's more (backfill in progress).
          // Use a longer cooldown to avoid hammering the server while backfill runs.
          // The backfill_completed WS handler will also reload data independently.
          console.log(`[LoadMoreLeft] 0 bars returned for ${interval}, backfill likely in progress — will retry in 5s`);
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now() + 2_000); // effective 5s cooldown (3s base + 2s extra)
        } else {
          // Normal cooldown
          needMoreLeftCooldownRef.current.set(cooldownKey, Date.now());
        }

        if (typeof result.has_more === "boolean") {
          setHasMoreLeft(result.has_more);
        } else if (older.length === 0) {
          setHasMoreLeft(false);
        }
      } catch (err) {
        console.error("Load older data failed:", err);
        // On error, use a longer cooldown before retrying
        needMoreLeftCooldownRef.current.set(cooldownKey, Date.now() + 2_000);
      } finally {
        setLoadingMoreLeft(false);
      }
    },
    [chartData.length, dataSource, hasMoreLeft, interval, loading, loadingMoreLeft, saveToCache, symbol],
  );

  // Save visible range when switching away from current interval
  const saveCurrentVisibleRange = useCallback(() => {
    if (chartWidgetRef.current?.getVisibleRange) {
      const range = chartWidgetRef.current.getVisibleRange();
      if (range) {
        saveVisibleRangeForInterval(symbol, interval, range);
      }
    }
  }, [interval, symbol]);

  // Save visible range on page close/refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentVisibleRange();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveCurrentVisibleRange]);

  const handleIntervalChange = (newInterval) => {
    if (newInterval !== interval) {
      saveCurrentVisibleRange();
      setCrosshairData(null);
      setCustomInput("");
      setCustomError(null);
      realtimePriceRef.current = null;
      setLastPrice(null);
      gapFillInFlightRef.current.clear(); // Reset gap fill tracking on interval change
      setInterval_(newInterval);
      updateUserPref("lastInterval", newInterval);
    }
  };

  const handleCustomSubmit = (e) => {
    e.preventDefault();
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (!CUSTOM_INTERVAL_RE.test(trimmed)) {
      setCustomError("格式: 数字+单位 (s/m/h/d/w/M), 如 7m, 45m, 3h");
      return;
    }
    setCustomError(null);
    addCustomInterval(trimmed);
    setCustomInput("");
    handleIntervalChange(trimmed);
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

  return (
    <div className="app-layout">
      <header className="top-bar" id="top-bar">
        <div className="logo">
          <div className="logo-icon">📈</div>
          <span className="logo-text">CandleScope</span>
        </div>

        <SymbolSearch
          currentSymbol={symbol}
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

      <nav className="toolbar" id="toolbar">
        {intervalGroups.map((group, gi) => (
          <div key={gi} style={{ display: "flex", alignItems: "center" }}>
            {gi > 0 && <div className="toolbar-divider" />}
            <div className="toolbar-group">
              {group.items.map((item) => (
                <button
                  key={item.value}
                  id={`interval-${item.value}`}
                  className={`interval-btn ${interval === item.value ? "active" : ""}${item.isCustom ? " custom-interval-btn" : ""}`}
                  onClick={() => handleIntervalChange(item.value)}
                  title={item.isCustom ? `自定义: ${item.value}` : item.value}
                  style={item.isCustom ? { fontStyle: "italic", position: "relative" } : {}}
                >
                  {item.isCustom ? `★${item.label}` : item.label}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="toolbar-divider" />

        <form
          className="custom-interval-form"
          onSubmit={handleCustomSubmit}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <input
            id="custom-interval-input"
            type="text"
            className="custom-interval-input"
            placeholder="添加 如7m"
            value={customInput}
            onChange={(e) => { setCustomInput(e.target.value); setCustomError(null); }}
            style={{
              width: 80,
              padding: "4px 8px",
              fontSize: 12,
              background: "var(--bg-tertiary)",
              border: customError ? "1px solid #ef4444" : "1px solid var(--border-color)",
              borderRadius: 4,
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
          <button
            type="submit"
            className="interval-btn"
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            +
          </button>
          {savedCustomIntervals.length > 0 && (
            <button
              type="button"
              className={`interval-btn ${showIntervalManager ? "active" : ""}`}
              onClick={() => setShowIntervalManager((p) => !p)}
              style={{ fontSize: 12, padding: "4px 8px" }}
              title="管理自定义周期"
            >
              ✎
            </button>
          )}
        </form>
        {customError && (
          <span style={{ color: "#ef4444", fontSize: 11, marginLeft: 4 }}>{customError}</span>
        )}
      </nav>

      {showIntervalManager && (
        <div className="interval-manager" style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          padding: "12px 16px",
          margin: "0 8px",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 4 }}>自定义周期:</span>
          {savedCustomIntervals.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>暂无，在上方输入框添加</span>
          )}
          {savedCustomIntervals
            .map((intv) => ({ intv, secs: parseIntervalSeconds(intv) || 0 }))
            .sort((a, b) => a.secs - b.secs)
            .map(({ intv }) => (
              <div key={intv} style={{
                display: "flex", alignItems: "center", gap: 4,
                background: "var(--bg-tertiary)",
                border: interval === intv ? "1px solid var(--accent-blue)" : "1px solid var(--border-color)",
                borderRadius: 6, padding: "3px 8px",
              }}>
                <span
                  style={{ fontSize: 12, color: "var(--text-primary)", cursor: "pointer" }}
                  onClick={() => { handleIntervalChange(intv); setShowIntervalManager(false); }}
                >
                  ★ {intv}
                </span>
                <button
                  onClick={() => removeCustomInterval(intv)}
                  style={{
                    background: "none", border: "none", color: "#ef4444",
                    cursor: "pointer", fontSize: 14, padding: "0 2px",
                    lineHeight: 1,
                  }}
                  title={`删除 ${intv}`}
                >
                  ×
                </button>
              </div>
            ))}
          <button
            onClick={() => setShowIntervalManager(false)}
            style={{
              background: "none", border: "none", color: "var(--text-muted)",
              cursor: "pointer", fontSize: 11, marginLeft: "auto",
            }}
          >
            收起
          </button>
        </div>
      )}

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
              data={chartData}
              symbol={symbol}
              interval={interval}
              loading={loading}
              onCrosshairMove={setCrosshairData}
              onNeedMoreLeft={handleNeedMoreLeft}
              canLoadMoreLeft={hasMoreLeft && !loadingMoreLeft && !loading}
              datasetKey={`${symbol}-${interval}-${datasetKey}`}
              upColor={settings.upColor}
              downColor={settings.downColor}
              theme={settings.theme}
              customBg={settings.customBg}
              timezone={settings.timezone}
              savedVisibleRange={getVisibleRangeForInterval(symbol, interval)}
              onVisibleRangeChange={(range) => saveVisibleRangeForInterval(symbol, interval, range)}
              drawingTool={drawingTool}
              penColor={penColor}
              penSize={penSize}
              textFontSize={textFontSize}
              textBold={textBold}
              textItalic={textItalic}
              fibLevels={fibLevels}
              fibInverted={fibInverted}
              positionSize={positionSize}
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
        onSelectSymbol={handleSymbolChange}
        watchlists={watchlists}
        onWatchlistsChange={(next) => { setWatchlists(next); saveWatchlists(next); }}
      />

      </div> {/* end main-content-area */}

      {/* Indicator Panel — slides in from the right */}
      <IndicatorPanel
        isOpen={showIndicatorPanel}
        onClose={() => setShowIndicatorPanel(false)}
        activeIndicators={activeIndicators}
        computing={indicatorComputing}
        onAddIndicator={addIndicator}
        onRemoveIndicator={removeIndicator}
        onToggleVisibility={toggleVisibility}
        onUpdateParams={updateIndicatorParams}
        onUpdateScript={updateIndicatorScript}
        onRecompute={recomputeIndicatorsWithUI}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onUpdate={setSettings}
      />

      <footer className="status-bar" id="status-bar">
        <div className="status-left">
          <span>
            <span className={`status-dot ${connectionStatus}`} />
            {connectionStatus === "connected" && "Connected to Binance"}
            {connectionStatus === "loading" && (dataSource === "mock" ? "Mock data mode" : "Loading...")}
            {connectionStatus === "disconnected" && "Disconnected"}
          </span>
          <span>{chartData.length} bars</span>
          {loadingMoreLeft && <span style={{ color: "#3b82f6" }}>Loading older data...</span>}
          {!hasMoreLeft && !loadingMoreLeft && <span style={{ color: "#94a3b8" }}>No more history</span>}
          {dataSource === "mock" && (
            <span style={{ color: "#f59e0b" }}>
              Binance unavailable, using mock data
            </span>
          )}
        </div>
        <div className="status-right">
          <span>{dataSource === "mock" ? "Demo Mode" : "Binance Spot"}</span>
          <span>{wsStatusLabel}</span>
          <span>CandleScope v0.2.0</span>
        </div>
      </footer>
    </div>
  );
}
