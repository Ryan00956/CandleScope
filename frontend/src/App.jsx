import React, { useCallback, useEffect, useRef, useState } from "react";
import ChartWidget from "./components/ChartWidget";
import SettingsModal from "./components/SettingsModal";
import {
  fetchKlinesBefore,
  fetchKlinesHistory,
  fetchLatestKlines,
  getKlineStreamUrl,
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

// ---------- ErrorBoundary: 防止任何子组件崩溃导致白屏 ----------
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

// Native intervals with their seconds for sorting
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

/** Build merged & sorted interval list with custom intervals inserted */
function buildSortedIntervals(savedCustom) {
  const all = NATIVE_INTERVALS.map((i) => ({ ...i, isCustom: false }));
  for (const intv of savedCustom) {
    const secs = parseIntervalSeconds(intv);
    if (secs && !all.some((a) => a.value === intv)) {
      all.push({ value: intv, label: intv, seconds: secs, isCustom: true });
    }
  }
  all.sort((a, b) => a.seconds - b.seconds);

  // Group into Minutes / Hours / Days+
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

const INTERVAL_DAYS = {
  "1m": 1,
  "3m": 2,
  "5m": 3,
  "15m": 7,
  "30m": 14,
  "1h": 30,
  "2h": 60,
  "4h": 90,
  "1d": 365,
  "1w": 365,
  "1M": 365,
};

/** Calculate default days for a custom interval */
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

// Adjacent intervals for prefetching (left neighbor, right neighbor)
const ALL_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
function getAdjacentIntervals(intv) {
  const idx = ALL_INTERVALS.indexOf(intv);
  if (idx === -1) return [];
  const neighbors = [];
  if (idx > 0) neighbors.push(ALL_INTERVALS[idx - 1]);
  if (idx < ALL_INTERVALS.length - 1) neighbors.push(ALL_INTERVALS[idx + 1]);
  return neighbors;
}

/** 合并并去重（按 time 去重，后来者覆盖前者） */
function mergeByTime(older, current) {
  const merged = [...older, ...current];
  const uniq = new Map();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

/** 确保 data 按 time 严格递增且无重复（lightweight-charts 要求） */
function deduplicateByTime(data) {
  if (!data || data.length <= 1) return data;
  const seen = new Map();
  for (const item of data) {
    seen.set(item.time, item); // 同 time 后覆盖前
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
  const [interval, setInterval_] = useState("1h");
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
  const wsRef = useRef(null);

  // --- Custom interval state ---
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState(null);
  const customCandleRef = useRef(null);
  const baseIntervalRef = useRef(null);
  const customSecondsRef = useRef(null);

  // --- Saved custom intervals (persisted in localStorage) ---
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
    // If currently viewing this interval, switch to 1h
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

  const loadData = useCallback(async (sym, intv) => {
    // Cancel any previous in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setConnectionStatus("loading");
    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setCrosshairData(null);
    customCandleRef.current = null;

    // Resolve custom interval info from backend
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

    try {
      const days = getIntervalDays(intv);
      const result = await fetchKlinesHistory(sym, intv, days);

      // If this request was superseded by a newer one, discard
      if (controller.signal.aborted) return;

      if (result.data && result.data.length > 0) {
        const nextData = result.data;
        const latest = nextData[nextData.length - 1];

        setChartData(nextData);
        setLastPrice(latest);
        setDataSource(result.source || "unknown");
        setConnectionStatus(result.source === "mock" ? "loading" : "connected");
        setDatasetKey((v) => v + 1);

        // For custom intervals, seed the forming candle ref with the last bar
        if (custom) {
          customCandleRef.current = { ...latest };
        }
      } else {
        setError("No data returned");
        setConnectionStatus("disconnected");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("Data load failed:", err);
      setError(err.message || "Network error");
      setConnectionStatus("disconnected");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }

    // Prefetch adjacent intervals in background (fire-and-forget)
    if (!controller.signal.aborted && !custom) {
      const neighbors = getAdjacentIntervals(intv);
      neighbors.forEach((adj) => {
        const adjDays = INTERVAL_DAYS[adj] || 7;
        fetchKlinesHistory(sym, adj, adjDays).catch(() => { });
      });
    }
  }, []);

  useEffect(() => {
    loadData(symbol, interval);
  }, [symbol, interval, loadData]);

  useEffect(() => {
    if (loading || error || dataSource === "mock" || datasetKey === 0) {
      if (dataSource === "mock") setWsStatus("mock");
      else if (loading) setWsStatus("loading");
      else setWsStatus("idle");
      return;
    }

    let active = true;
    let reconnectTimer = null;
    let socket = null;
    let pollInterval = null;
    let pollingInFlight = false;

    const startPolling = () => {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        if (!active) return;
        if (pollingInFlight) return;
        pollingInFlight = true;
        try {
          // For custom intervals, poll with the custom interval string;
          // the backend handles aggregation.
          const result = await fetchLatestKlines(symbol, interval, 2);
          if (!result?.data?.length) return;

          setChartData((prev) => {
            let updated = prev;
            result.data.forEach((tick) => {
              updated = upsertRealtimeKline(updated, tick);
            });
            return deduplicateByTime(updated);
          });
          setLastPrice(result.data[result.data.length - 1]);
          setWsStatus((prev) => (prev === "live" ? prev : "fallback"));
        } catch (pollErr) {
          console.warn("Polling fallback failed:", pollErr);
        } finally {
          pollingInFlight = false;
        }
      }, 1000);
    };

    // Determine WS stream interval: for custom intervals, subscribe to the base interval
    const isCustom = isCustomInterval(interval);
    const wsInterval = isCustom && baseIntervalRef.current ? baseIntervalRef.current : interval;
    const customSecs = customSecondsRef.current;

    const connect = () => {
      if (!active) return;
      setWsStatus("connecting");

      try {
        const url = getKlineStreamUrl(symbol, wsInterval);
        socket = new WebSocket(url);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!active) return;
          setWsStatus("live");
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        };

        socket.onmessage = (event) => {
          if (!active) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "stream_status") {
              if (msg.status === "live") setWsStatus("live");
              if (msg.status === "reconnecting") setWsStatus("reconnecting");
              return;
            }

            if (msg.type !== "kline" || !msg.data) return;

            if (isCustom && customSecs) {
              // --- Custom interval: aggregate base candle into custom bucket ---
              const { candle, isNew } = aggregateRealtimeCandle(
                customCandleRef.current, msg.data, customSecs
              );
              customCandleRef.current = candle;

              if (isNew) {
                // A new custom candle started — append it
                setChartData((prev) => {
                  const next = [...prev, candle];
                  return deduplicateByTime(next);
                });
              } else {
                // Update the last candle in-place
                setChartData((prev) => {
                  const next = upsertRealtimeKline(prev, candle);
                  return deduplicateByTime(next);
                });
              }
              setLastPrice(candle);
            } else {
              // --- Native interval: direct upsert ---
              setChartData((prev) => {
                const next = upsertRealtimeKline(prev, msg.data);
                return deduplicateByTime(next);
              });
              setLastPrice(msg.data);
            }
          } catch (parseErr) {
            console.error("WS parse failed:", parseErr);
          }
        };

        socket.onerror = () => {
          if (!active) return;
          setWsStatus("reconnecting");
          startPolling();
        };

        socket.onclose = () => {
          if (!active) return;
          setWsStatus("disconnected");
          startPolling();
          reconnectTimer = setTimeout(connect, 5000);
        };
      } catch (connectErr) {
        console.warn("WS initialization failed:", connectErr);
        startPolling();
      }
    };

    connect();

    const initialFallbackTimer = setTimeout(() => {
      if (
        active &&
        !pollInterval &&
        (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      ) {
        startPolling();
      }
    }, 4000);

    return () => {
      active = false;
      clearTimeout(initialFallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollInterval) clearInterval(pollInterval);
      if (socket) {
        try {
          socket.close();
        } catch (closeErr) {
          console.error("WS close failed:", closeErr);
        }
      }
      wsRef.current = null;
    };
  }, [dataSource, datasetKey, error, interval, loading, symbol]);

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
          setChartData((prev) => mergeByTime(older, prev));
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
    [chartData.length, dataSource, hasMoreLeft, interval, loading, loadingMoreLeft, symbol],
  );

  const handleIntervalChange = (newInterval) => {
    if (newInterval !== interval) {
      setCrosshairData(null);
      setCustomInput("");
      setCustomError(null);
      customCandleRef.current = null;
      setInterval_(newInterval);
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
          />
        </ErrorBoundary>
      )}

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
