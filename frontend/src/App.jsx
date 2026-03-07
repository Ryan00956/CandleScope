import React, { useCallback, useEffect, useRef, useState } from "react";
import ChartWidget from "./components/ChartWidget";
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
/** Aggregate an incoming base candle into a custom-period candle being formed */
function aggregateRealtimeCandle(currentCandle, incoming, bucketWidth) {
  const bucketStart = Math.floor(incoming.time / bucketWidth) * bucketWidth;
  if (!currentCandle || bucketStart !== currentCandle.time) {
    return { candle: { time: bucketStart, open: incoming.open, high: incoming.high, low: incoming.low, close: incoming.close, volume: incoming.volume }, isNew: true };
  }
  const c = { ...currentCandle };
  c.high = Math.max(c.high, incoming.high);
  c.low = Math.min(c.low, incoming.low);
  c.close = incoming.close;
  c.volume = c.volume + incoming.volume;
  return { candle: c, isNew: false };
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

// Visible range persistence per interval
const VISIBLE_RANGE_KEY = "candlescope-visible-ranges";
function loadVisibleRanges() {
  try {
    const raw = localStorage.getItem(VISIBLE_RANGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveVisibleRangeForInterval(interval, range) {
  const ranges = loadVisibleRanges();
  ranges[interval] = range;
  localStorage.setItem(VISIBLE_RANGE_KEY, JSON.stringify(ranges));
}
function getVisibleRangeForInterval(interval) {
  const ranges = loadVisibleRanges();
  return ranges[interval] || null;
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

    // Process QUICK result
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

      if (!shownInitialData) {
        setConnectionStatus("connected");
        setDatasetKey((v) => v + 1);
        setLoading(false);
        shownInitialData = true;
      }
    }

    // Process FULL HISTORY result
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
    } else if (!shownInitialData) {
      // Don't show error immediately — backfill may be in progress.
      // The QueryEngine auto-triggers backfill when storage is empty,
      // and we'll receive a backfill_completed event via WS once data arrives.
      setConnectionStatus("loading");
      setLoading(false);
    }

    setLoading(false);
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
        saveVisibleRangeForInterval(interval, range);
      }
    }
  }, [interval]);

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
            <ChartWidget
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
              savedVisibleRange={getVisibleRangeForInterval(interval)}
              onVisibleRangeChange={(range) => saveVisibleRangeForInterval(interval, range)}
              drawingTool={drawingTool}
              penColor={penColor}
              penSize={penSize}
              textFontSize={textFontSize}
              textBold={textBold}
              textItalic={textItalic}
              onChartReady={handleChartReady}
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
        onRecompute={recomputeIndicators}
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
