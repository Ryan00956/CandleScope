import { memo, useSyncExternalStore } from "react";
import SymbolSearch from "../features/symbol-search/SymbolSearch.js";
import { markPerf } from "../runtime/performance/perfMarks";
import {
  loadReplayLauncherDialog,
  loadSettingsModal,
} from "./lazySurfaceLoaders.js";
import {
  getCrosshairSnapshot,
  subscribeCrosshairData,
} from "../features/market-data/crosshairDisplayStore";
import {
  buildMarketSummary,
  formatPrice,
  formatPriceDiff,
  formatVolume,
} from "../features/market-data/marketDataView";
import type { CrosshairData, MarketSummary } from "../features/market-data/klineContracts.js";
import type { MarketDisplayData } from "../features/market-data/marketDataView.js";
import type { SymbolSearchProps } from "../features/symbol-search/SymbolSearch.js";
import type { AdvancedMarketRuntimeView } from "../features/advanced-market-data/advancedMarketDataTypes.js";
import type { ReplayEntryCapabilityView } from "../features/replay/useReplayEntryCapability.js";
import { useAdvancedMarketSummary } from "../features/advanced-market-data/useAdvancedMarketSnapshots.js";
import MarketTopBarFrame from "./MarketTopBarFrame.js";

export interface TopBarSymbolSearchModel extends Omit<SymbolSearchProps, "onSelect"> {
  onSelectSymbol: SymbolSearchProps["onSelect"];
}

export interface TopBarControlsModel {
  onOpenSettings(): void;
  indicatorPanelOpen: boolean;
  onToggleIndicatorPanel(): void;
  alertPanelOpen: boolean;
  onToggleAlertPanel(): void;
  activeIndicatorCount: number;
}

export interface TopBarProps {
  symbolSearch: TopBarSymbolSearchModel;
  controls: TopBarControlsModel;
  marketSummary: Omit<MarketSummary, "displayData"> & {
    displayData: MarketDisplayData | null;
  };
  advancedMarketData: AdvancedMarketRuntimeView;
  replayEntry: ReplayEntryCapabilityView;
  onOpenReplayLauncher(): void;
}

function isCompleteMarketDisplayData(
  value: CrosshairData | null,
): value is CrosshairData & MarketDisplayData {
  return value != null
    && typeof value.open === "number"
    && typeof value.high === "number"
    && typeof value.low === "number"
    && typeof value.close === "number";
}

function TopBar({
  symbolSearch,
  controls,
  marketSummary,
  advancedMarketData,
  replayEntry,
  onOpenReplayLauncher,
}: TopBarProps) {
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
  const crosshairData = useSyncExternalStore(
    subscribeCrosshairData,
    getCrosshairSnapshot,
    getCrosshairSnapshot,
  );
  const { displayData, isUp, priceChange, amplitude } = buildMarketSummary(
    isCompleteMarketDisplayData(crosshairData) ? crosshairData : marketSummary.displayData,
  );
  const advancedSummary = useAdvancedMarketSummary(advancedMarketData);
  const basisText = advancedSummary.basis == null
    ? "--"
    : `${advancedSummary.basis >= 0 ? "+" : "-"}${formatPrice(Math.abs(advancedSummary.basis))}`;

  return (
    <MarketTopBarFrame
      source="live"
      navigation={<>
        {replayEntry.state === "enabled" && (
        <button
          className="replay-entry-link"
          data-replay-entry="enabled"
          type="button"
          onPointerEnter={loadReplayLauncherDialog}
          onMouseEnter={loadReplayLauncherDialog}
          onFocus={loadReplayLauncherDialog}
          onClick={onOpenReplayLauncher}
        >
          K 线回放
        </button>
        )}
        {(replayEntry.state === "checking" || replayEntry.state === "disabled") && (
        <button
          className="replay-entry-link replay-entry-disabled"
          data-replay-entry={replayEntry.state}
          type="button"
          disabled
          title={replayEntry.reason}
        >
          K 线回放
        </button>
        )}
      </>}
      identity={<SymbolSearch
        currentSymbol={currentSymbol}
        onSelect={onSelectSymbol}
        {...(currentMarketType === undefined ? {} : { currentMarketType })}
        {...(currentExchange === undefined ? {} : { currentExchange })}
        {...(exchangeCatalog === undefined ? {} : { exchangeCatalog })}
        {...(watchlists === undefined ? {} : { watchlists })}
        {...(onAddToWatchlist === undefined ? {} : { onAddToWatchlist })}
      />}
      controls={<>
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
      </>}
      quote={displayData && (
        <div className="price-info">
          <span className={`current-price ${isUp ? "price-up" : "price-down"}`}>
            {formatPrice(displayData.close)}
          </span>
          <span className={`price-change ${isUp ? "change-positive" : "change-negative"}`}>
            {isUp ? "▲" : "▼"} {Math.abs(priceChange).toFixed(2)}%
          </span>
        </div>
      )}
      marketMetrics={advancedMarketData.summaryEnabled && (
        <div
          className={`advanced-market-summary advanced-market-summary-${advancedSummary.connectionStatus}`}
          aria-label="Derivatives market summary"
        >
          <div className="advanced-market-chip" data-market-metric="mark-price">
            <span className="advanced-market-chip-label">Mark</span>
            <span className="advanced-market-chip-value">{formatPrice(advancedSummary.markPrice)}</span>
          </div>
          <div className="advanced-market-chip" data-market-metric="index-price">
            <span className="advanced-market-chip-label">Index</span>
            <span className="advanced-market-chip-value">{formatPrice(advancedSummary.indexPrice)}</span>
          </div>
          <div className="advanced-market-chip" data-market-metric="basis">
            <span className="advanced-market-chip-label">Basis</span>
            <span className="advanced-market-chip-value">{basisText}</span>
            {advancedSummary.basisBps != null && (
              <span className="advanced-market-chip-suffix">
                {advancedSummary.basisBps >= 0 ? "+" : ""}{advancedSummary.basisBps.toFixed(2)} bps
              </span>
            )}
          </div>
        </div>
      )}
      ohlcv={displayData && (
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
    />
  );
}

export default memo(TopBar);
