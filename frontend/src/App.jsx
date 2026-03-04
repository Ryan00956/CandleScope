import { useCallback, useEffect, useState } from "react";
import ChartWidget from "./components/ChartWidget";
import SettingsModal from "./components/SettingsModal";
import { fetchKlinesBefore, fetchKlinesHistory } from "./services/api";
import "./index.css";

const INTERVAL_GROUPS = [
  {
    label: "Minutes",
    items: [
      { value: "1m", label: "1m" },
      { value: "3m", label: "3m" },
      { value: "5m", label: "5m" },
      { value: "15m", label: "15m" },
      { value: "30m", label: "30m" },
    ],
  },
  {
    label: "Hours",
    items: [
      { value: "1h", label: "1H" },
      { value: "2h", label: "2H" },
      { value: "4h", label: "4H" },
    ],
  },
  {
    label: "Days",
    items: [
      { value: "1d", label: "1D" },
      { value: "1w", label: "1W" },
      { value: "1M", label: "1M" },
    ],
  },
];

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

function mergeByTime(older, current) {
  const merged = [...older, ...current];
  const uniq = new Map();
  for (const item of merged) {
    uniq.set(item.time, item);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
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

  const loadData = useCallback(async (sym, intv) => {
    setLoading(true);
    setError(null);
    setConnectionStatus("loading");
    setLoadingMoreLeft(false);
    setHasMoreLeft(true);

    try {
      const days = INTERVAL_DAYS[intv] || 7;
      const result = await fetchKlinesHistory(sym, intv, days);

      if (result.data && result.data.length > 0) {
        const nextData = result.data;
        const latest = nextData[nextData.length - 1];

        setChartData(nextData);
        setLastPrice(latest);
        setDataSource(result.source || "unknown");
        setConnectionStatus(result.source === "mock" ? "loading" : "connected");
        setDatasetKey((v) => v + 1);
      } else {
        setError("No data returned");
        setConnectionStatus("disconnected");
      }
    } catch (err) {
      console.error("Data load failed:", err);
      setError(err.message || "Network error");
      setConnectionStatus("disconnected");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(symbol, interval);
  }, [symbol, interval, loadData]);

  const handleNeedMoreLeft = useCallback(
    async (oldestLoadedTime) => {
      if (loading || loadingMoreLeft || !hasMoreLeft || dataSource === "mock") {
        return;
      }
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
      setInterval_(newInterval);
    }
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

  return (
    <div className="app-layout">
      <header className="top-bar" id="top-bar">
        <div className="logo">
          <div className="logo-icon">📳</div>
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
        {INTERVAL_GROUPS.map((group, gi) => (
          <div key={gi} style={{ display: "flex", alignItems: "center" }}>
            {gi > 0 && <div className="toolbar-divider" />}
            <div className="toolbar-group">
              {group.items.map((item) => (
                <button
                  key={item.value}
                  id={`interval-${item.value}`}
                  className={`interval-btn ${interval === item.value ? "active" : ""}`}
                  onClick={() => handleIntervalChange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

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
        />
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
          <span>CandleScope v0.2.0</span>
        </div>
      </footer>
    </div>
  );
}
