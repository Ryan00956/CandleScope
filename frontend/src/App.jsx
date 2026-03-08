import React, { useCallback, useEffect, useRef, useState } from "react";
import MultiPaneChart from "./components/MultiPaneChart";
import DrawingToolbar from "./components/DrawingToolbar";
import SettingsModal from "./components/SettingsModal";
import IndicatorPanel from "./components/IndicatorPanel";
import { useIndicators } from "./hooks/useIndicators";
import {
  fetchKlinesBefore,
  fetchKlinesHistory,
  fetchLatestKlines,
  getMultiStreamUrl,
  resolveInterval,
} from "./services/api";
import "./index.css";

// ---------- Custom interval helpers ----------
const CUSTOM_INTERVAL_RE = /^(\d+)([smhdwM])$/;
function parseIntervalSeconds(intv) {
  const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
  const m = CUSTOM_INTERVAL_RE.exec(intv);
  if (!m) return null;
  return parseInt(m[1], 10) * (units[m[2]] || 60);
}
function isCustomInterval(intv) {
  const NATIVE = new Set(["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);
  return !NATIVE.has(intv);
}
/**
 * Aggregate an incoming base candle into a custom-period candle being formed.
 *
 * The tricky part: Binance WS pushes the *same* base candle (e.g. 1m)
 * multiple times before it closes.  Each push contains the *total* volume
 * of that base candle so far — NOT an incremental delta.  Naively doing
 * `c.volume += incoming.volume` would accumulate duplicates.
 *
 * We solve this by tracking the per-base-candle contribution inside
 * `_baseParts` (keyed by base candle time).  When the same base candle
 * arrives again we *replace* its contribution instead of adding again.
 *
 * `_baseParts` is stored directly on the candle object and stripped
 * before feeding into the chart (it's harmless if left — chart ignores
 * unknown keys).
 */
function aggregateRealtimeCandle(currentCandle, incoming, bucketWidth) {
  const bucketStart = Math.floor(incoming.time / bucketWidth) * bucketWidth;

  // ── New bucket → brand-new candle ──
  if (!currentCandle || bucketStart !== currentCandle.time) {
    const parts = {};
    parts[incoming.time] = {
      open: incoming.open,
      high: incoming.high,
      low: incoming.low,
      close: incoming.close,
      volume: incoming.volume,
    };
    return {
      candle: {
        time: bucketStart,
        open: incoming.open,
        high: incoming.high,
        low: incoming.low,
        close: incoming.close,
        volume: incoming.volume,
        _baseParts: parts,
      },
      isNew: true,
    };
  }

  // ── Same bucket → upsert base candle contribution ──
  const parts = { ...(currentCandle._baseParts || {}) };

  // If currentCandle was loaded from cache/HTTP (no _baseParts),
  // `parts` is empty.  We need to preserve the historical aggregate
  // OHLCV for base candles we haven't seen via WS yet.  We do this
  // by storing the cached aggregate in a special `_prior` key that
  // is excluded from volume summation once real base parts arrive
  // and is used only for OHLC bounds that real parts can't override.
  if (!currentCandle._baseParts) {
    parts._prior = {
      open: currentCandle.open,
      high: currentCandle.high,
      low: currentCandle.low,
      close: currentCandle.close,
      volume: currentCandle.volume,
    };
  }

  parts[incoming.time] = {
    open: incoming.open,
    high: incoming.high,
    low: incoming.low,
    close: incoming.close,
    volume: incoming.volume,
  };

  // Rebuild aggregate OHLCV from all real base parts
  let aggOpen = null;
  let aggHigh = -Infinity;
  let aggLow = Infinity;
  let aggClose = null;
  let aggVolume = 0;
  const sortedTimes = Object.keys(parts)
    .filter((k) => k !== "_prior")
    .map(Number)
    .sort((a, b) => a - b);

  for (const t of sortedTimes) {
    const p = parts[t];
    if (aggOpen === null) aggOpen = p.open;
    aggHigh = Math.max(aggHigh, p.high);
    aggLow = Math.min(aggLow, p.low);
    aggClose = p.close;   // last part's close
    aggVolume += p.volume;
  }

  // If we have a _prior (from cache), blend in its contribution
  // for candles we haven't seen live yet:
  //  - OHLC: expand bounds with prior's high/low, keep prior's open
  //    if it's earlier than any live part
  //  - Volume: keep prior's volume as baseline, but we must NOT
  //    double-count the incoming base candle's volume which is
  //    already in both _prior.volume and parts[incoming.time].volume.
  //    Unfortunately we can't decompose _prior.volume per-base-candle.
  //    So once live parts start arriving, we accept the _prior volume
  //    as the "frozen" total for all prior base candles, and only ADD
  //    volume from base candles not yet seen.
  if (parts._prior) {
    const prior = parts._prior;
    // For the very first live tick in this bucket, _prior.volume
    // already includes this base candle's old volume.  We subtract
    // nothing because the live tick replaces whatever _prior had for
    // this time slot — but since _prior is an aggregate, we can't
    // perfectly decompose.  The pragmatic fix: use _prior.volume for
    // all base candles EXCEPT those we now track individually.
    // Since we only have 1 live part so far (the incoming one),
    // _prior.volume ≈ total - incoming's old contribution.
    // Best approximation: prior.volume stays as-is, live parts'
    // volumes are already counted, so we just use the larger of
    // (prior.volume) vs (sum of live parts) to avoid under-counting
    // on first tick, then as more live ticks arrive the live sum
    // naturally overtakes and _prior becomes irrelevant.
    //
    // Simplest correct approach: once we have _prior, treat volume
    // as max(prior.volume, liveSum) until _prior is dropped.
    aggVolume = Math.max(prior.volume, aggVolume);

    // OHLC: use prior's open (it was set when the bucket started
    // and is likely earlier than any live base candle)
    aggOpen = prior.open;
    aggHigh = Math.max(aggHigh, prior.high);
    aggLow = Math.min(aggLow, prior.low);
    // close: keep the latest live part's close (already set)
  }

  return {
    candle: {
      time: bucketStart,
      open: aggOpen,
      high: aggHigh,
      low: aggLow,
      close: aggClose,
      volume: aggVolume,
      _baseParts: parts,
    },
    isNew: false,
  };
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

// Native intervals
const NATIVE_INTERVALS = [
  { value: "1m", label: "1m", seconds: 60 },
  { value: "3m", label: "3m", seconds: 180 },
  { value: "5m", label: "5m", seconds: 300 },
  { value: "15m", label: "15m", seconds: 900 },
  { value: "30m", label: "30m", seconds: 1800 },
  { value: "1h", label: "1H", seconds: 3600 },
  { value: "2h", label: "2H", seconds: 7200 },
  { value: "4h", label: "4H", seconds: 14400 },
  { value: "1d", label: "1D", seconds: 86400 },
  { value: "1w", label: "1W", seconds: 604800 },
  { value: "1M", label: "1M", seconds: 2592000 },
];

// Intervals to subscribe via WebSocket for background updates
const WS_SUBSCRIBE_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];

function buildSortedIntervals(savedCustom) {
  const all = NATIVE_INTERVALS.map((i) => ({ ...i, isCustom: false }));
  for (const intv of savedCustom) {
    const secs = parseIntervalSeconds(intv);
    if (secs && !all.some((a) => a.value === intv)) {
      all.push({ value: intv, label: intv, seconds: secs, isCustom: true });
    }
  }
  all.sort((a, b) => a.seconds - b.seconds);

  const minutes = all.filter((i) => i.seconds < 3600);
  const hours = all.filter((i) => i.seconds >= 3600 && i.seconds < 86400);
  const days = all.filter((i) => i.seconds >= 86400);
  return [
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

const INTERVAL_DAYS = {
  "1m": 1, "3m": 2, "5m": 3, "15m": 7, "30m": 14,
  "1h": 30, "2h": 60, "4h": 90, "1d": 365, "1w": 365, "1M": 365,
};

function getIntervalDays(intv) {
  if (INTERVAL_DAYS[intv]) return INTERVAL_DAYS[intv];
  const secs = parseIntervalSeconds(intv);
  if (!secs) return 7;
  if (secs <= 60) return 1;
  if (secs <= 300) return 3;
  if (secs <= 900) return 7;
  if (secs <= 1800) return 14;
  if (secs <= 3600) return 30;
  if (secs <= 14400) return 90;
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
  const [symbol] = useState("BTCUSDT");
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
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    computeAll: recomputeIndicators,
    recompute: recomputeIndicatorsWithUI,
    mainOverlayLines,
    subPanes,
  } = useIndicators({
    chartRef: indicatorChartRefRef,
    seriesRef: indicatorSeriesRefRef,
    chartData,
    datasetKey: `${symbol}-${interval}-${datasetKey}`,
    seriesReady: indicatorSeriesReady,
  });

  // --- Custom interval state ---
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState(null);
  const customCandleRef = useRef(null);
  const baseIntervalRef = useRef(null);
  const customSecondsRef = useRef(null);

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
      // Build a display object that keeps OHLCV from the active interval's
      // last candle but overrides "close" with the most recent real-time price
      // when available, so the header always shows one consistent price.
      const rtPrice = realtimePriceRef.current;
      if (rtPrice != null && intv === intervalRef.current) {
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
  const intervalGroups = buildSortedIntervals(savedCustomIntervals);

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

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem("candlescope-settings");
    return saved
      ? JSON.parse(saved)
      : {
        theme: "dark",
        customBg: "#0f172a",
        upColor: "#22c55e",
        downColor: "#ef4444",
      };
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
    customCandleRef.current = null;

    // Resolve custom interval info
    const custom = isCustomInterval(intv);
    if (custom) {
      try {
        const info = await resolveInterval(intv);
        baseIntervalRef.current = info.base_interval;
        customSecondsRef.current = info.custom_seconds;
      } catch {
        baseIntervalRef.current = null;
        customSecondsRef.current = parseIntervalSeconds(intv);
      }
    } else {
      baseIntervalRef.current = null;
      customSecondsRef.current = null;
    }

    if (hasCacheHit && custom) {
      customCandleRef.current = { ...cached[cached.length - 1] };
    }

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
      if (custom) customCandleRef.current = { ...latestTick };

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
      if (custom) {
        customCandleRef.current = { ...latest };
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

  useEffect(() => {
    loadData(symbol, interval);
  }, [symbol, interval, loadData]);

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

        socket.onopen = () => {
          if (!active) return;
          // Reset reconnect state on successful connection
          reconnectDelay = WS_RECONNECT_BASE_DELAY;
          reconnectAttempts = 0;

          // Subscribe to ALL native intervals at once
          socket.send(JSON.stringify({
            action: "subscribe",
            intervals: WS_SUBSCRIBE_INTERVALS,
          }));
          setWsStatus("live");

          // Stop polling fallback — WS is live
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }

          // Start heartbeat ping
          startPing();
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
                    const latest = result.data[result.data.length - 1];
                    updateLastPrice(latest, bfInterval);
                    setError(null);
                    setConnectionStatus("connected");
                    setLoading(false);
                    setDatasetKey((v) => v + 1);
                  }
                })
                .catch((err) => {
                  console.warn(`Failed to reload after backfill for ${bfInterval}:`, err);
                });

              // ALSO seamlessly pull in the missing historical (left-side) data if present
              const key = cacheKey(bfSymbol, bfInterval);
              const historicCache = chartDataCacheRef.current.get(key) || [];
              if (historicCache.length > 0) {
                const oldest = historicCache[0].time;
                fetchKlinesBefore(bfSymbol, bfInterval, oldest, 500)
                  .then((res) => {
                    if (!res?.data?.length) return;
                    const cCache = chartDataCacheRef.current.get(key) || [];
                    const cMerged = mergeByTime(res.data, cCache);
                    chartDataCacheRef.current.set(key, cMerged);

                    if (bfInterval === intervalRef.current) {
                      setChartData((prev) => {
                        const nextUi = mergeByTime(res.data, prev);
                        saveToCache(bfSymbol, bfInterval, nextUi);
                        return nextUi;
                      });
                      if (typeof res.has_more === "boolean") {
                        setHasMoreLeft(res.has_more);
                      }
                    }
                  })
                  .catch((err) => console.warn("Failed backfill fetchBefore:", err));
              }

              return;
            }


            if (msg.type !== "kline" || !msg.data) return;

            const msgInterval = msg.interval;
            const tick = msg.data;
            const currentIntv = intervalRef.current;
            const isCurrentInterval = msgInterval === currentIntv;
            const isCurrentCustomBase = isCustomInterval(currentIntv) &&
              baseIntervalRef.current === msgInterval;

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
            if (isCurrentInterval) {
              setChartData((prev) => {
                const next = deduplicateByTime(upsertRealtimeKline(prev, tick));
                saveToCache(symbol, currentIntv, next);
                return next;
              });
              updateLastPrice(tick, currentIntv);
            }

            // ── Handle custom interval aggregation ──
            if (isCurrentCustomBase && customSecondsRef.current) {
              const { candle, isNew } = aggregateRealtimeCandle(
                customCandleRef.current, tick, customSecondsRef.current
              );
              customCandleRef.current = candle;

              if (isNew) {
                setChartData((prev) => {
                  const next = deduplicateByTime([...prev, candle]);
                  saveToCache(symbol, currentIntv, next);
                  return next;
                });
              } else {
                setChartData((prev) => {
                  const next = deduplicateByTime(upsertRealtimeKline(prev, candle));
                  saveToCache(symbol, currentIntv, next);
                  return next;
                });
              }
              updateLastPrice(candle, currentIntv);
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
    };
  }, [symbol, saveToCache, updateLastPrice, updateRealtimePrice]); // NOTE: no `interval` dep — WS is persistent across switches

  // ---------- Background prefetch: load history for ALL intervals ----------
  useEffect(() => {
    let cancelled = false;
    const prefetch = async () => {
      // Fire-and-forget: load history for all native intervals into cache
      // so switching is instant
      for (const intv of WS_SUBSCRIBE_INTERVALS) {
        if (cancelled) break;
        const key = cacheKey(symbol, intv);
        if (chartDataCacheRef.current.has(key)) continue; // already cached

        const days = INTERVAL_DAYS[intv] || 7;
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
  }, [symbol]);

  // ============================================================
  //  GAP DETECTION & AUTO-FILL
  //  Periodically checks chartData for interior gaps (missing bars)
  //  and automatically fetches the missing data from the backend.
  //  This is the last line of defense against K-line gaps.
  // ============================================================
  const gapFillInFlightRef = useRef(new Set()); // track in-flight gap fills to avoid duplicates

  useEffect(() => {
    if (!chartData || chartData.length < 3 || loading || dataSource === "mock") return;

    // Determine interval seconds
    const intvSecs = customSecondsRef.current || parseIntervalSeconds(interval);
    if (!intvSecs || intvSecs <= 0) return;

    // Debounce: wait a bit after data changes before scanning
    const timer = setTimeout(async () => {
      const gaps = detectGaps(chartData, intvSecs);
      if (gaps.length === 0) return;

      // Only fill the first few gaps per cycle to avoid request storms
      const MAX_GAPS_PER_CYCLE = 3;
      const gapsToFill = gaps.slice(0, MAX_GAPS_PER_CYCLE);

      for (const gap of gapsToFill) {
        // Create a unique key for this gap to prevent duplicate requests
        const gapKey = `${symbol}-${interval}-${gap.from}-${gap.to}`;
        if (gapFillInFlightRef.current.has(gapKey)) continue;
        gapFillInFlightRef.current.add(gapKey);

        console.log(
          `[GapFill] Detected gap: ${gap.missingBars} bars missing between ` +
          `${new Date(gap.from * 1000).toISOString()} and ${new Date(gap.to * 1000).toISOString()}`
        );

        try {
          // Fetch data covering the gap range
          // Use gap.to as "before" timestamp and request enough bars
          const barsNeeded = Math.min(gap.missingBars + 2, 1000);
          const result = await fetchKlinesBefore(symbol, interval, gap.to, barsNeeded);

          if (result?.data?.length > 0) {
            setChartData((prev) => {
              const merged = mergeByTime(result.data, prev);
              saveToCache(symbol, interval, merged);
              return merged;
            });
            console.log(`[GapFill] Filled ${result.data.length} bars for gap at ${new Date(gap.from * 1000).toISOString()}`);
          }
        } catch (err) {
          console.warn(`[GapFill] Failed to fill gap:`, err);
        } finally {
          // Remove from in-flight after a delay to prevent immediate re-trigger
          setTimeout(() => {
            gapFillInFlightRef.current.delete(gapKey);
          }, 10000);
        }
      }
    }, 2000); // 2s debounce after data changes

    return () => clearTimeout(timer);
  }, [chartData, interval, symbol, loading, dataSource, saveToCache]);

  // ---- handle load more left ----
  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime) => {
      if (loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") return;
      if (!chartData.length) return;

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
        }

        if (typeof result.has_more === "boolean") {
          setHasMoreLeft(result.has_more);
        } else if (older.length === 0) {
          setHasMoreLeft(false);
        }
      } catch (err) {
        console.error("Load older data failed:", err);
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
      customCandleRef.current = null;
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

        <div className="symbol-selector" id="symbol-selector">
          <span className="symbol-name">{symbol}</span>
          <span className="symbol-exchange">Binance</span>
        </div>

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
              onChartReady={handleChartReady}
              mainOverlayLines={mainOverlayLines}
              subPanes={subPanes}
              invertScale={invertScale}
              onInvertScaleChange={handleInvertScaleChange}
              priceScaleMode={priceScaleMode}
              onPriceScaleModeChange={handlePriceScaleModeChange}
            />
          </ErrorBoundary>
        )}
      </div>

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
