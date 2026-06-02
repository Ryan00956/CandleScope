import SymbolSearch from "../features/symbol-search/SymbolSearch";
import { markPerf } from "../runtime/performance/perfMarks";
import { loadSettingsModal } from "./lazySurfaceLoaders";
import {
  formatPrice,
  formatPriceDiff,
  formatVolume,
} from "../features/market-data/marketDataView";

export default function TopBar({ symbolSearch, controls, marketSummary }) {
  const {
    currentSymbol,
    currentMarketType,
    currentExchange,
    exchangeCatalog,
    onSelectSymbol,
    watchlists,
    onAddToWatchlist,
  } = symbolSearch;
  const {
    onOpenSettings,
    indicatorPanelOpen,
    onToggleIndicatorPanel,
    alertPanelOpen,
    onToggleAlertPanel,
    activeIndicatorCount,
  } = controls;
  const { displayData, isUp, priceChange, amplitude } = marketSummary;

  return (
    <header className="top-bar" id="top-bar">
      <div className="logo">
        <div className="logo-icon">📈</div>
        <span className="logo-text">CandleScope</span>
      </div>

      <SymbolSearch
        currentSymbol={currentSymbol}
        currentMarketType={currentMarketType}
        currentExchange={currentExchange}
        exchangeCatalog={exchangeCatalog}
        onSelect={onSelectSymbol}
        watchlists={watchlists}
        onAddToWatchlist={onAddToWatchlist}
      />

      <button
        className="settings-btn"
        onPointerEnter={loadSettingsModal}
        onMouseOver={loadSettingsModal}
        onMouseEnter={loadSettingsModal}
        onFocus={loadSettingsModal}
        onClick={() => {
          markPerf("lazy.settings.open.start", { trigger: "button" });
          onOpenSettings();
        }}
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
        className={`indicator-toggle-btn ${indicatorPanelOpen ? "active" : ""}`}
        onClick={onToggleIndicatorPanel}
        title="指标 (Indicators)"
      >
        📊
        {activeIndicatorCount > 0 && (
          <span className="indicator-badge">{activeIndicatorCount}</span>
        )}
      </button>

      <button
        className={`indicator-toggle-btn alert-toggle-btn ${alertPanelOpen ? "active" : ""}`}
        onClick={onToggleAlertPanel}
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
            <span
              className="ohlcv-value"
              style={{ color: isUp ? "var(--candle-up)" : "var(--candle-down)" }}
            >
              {isUp ? "+" : "-"}{formatPriceDiff(displayData.close - displayData.open)} / {isUp ? "+" : ""}{priceChange.toFixed(2)}%
            </span>
          </div>
          <div className="ohlcv-item">
            <span className="ohlcv-label">振幅</span>
            <span className="ohlcv-value">{amplitude}%</span>
          </div>
        </div>
      )}
    </header>
  );
}
