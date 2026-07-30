import { memo } from "react";
import type { ReactNode } from "react";
import MarketStatusBar from "./MarketStatusBar.js";

export type ConnectionStatus = "connected" | "loading" | "disconnected" | string;

export interface StatusBarModel {
  connectionStatus: ConnectionStatus;
  dataSource: string;
  exchangeLabel: string;
  marketLabel: string;
  wsStatusLabel: string;
  barCount: number;
  loadingMoreLeft: boolean;
  hasMoreLeft: boolean;
  exchangeCatalogStatus: string;
  exchangeLimitations?: string[];
}

export interface StatusBarProps {
  status: StatusBarModel;
  extensions?: ReactNode;
}

function StatusBar({ status, extensions }: StatusBarProps) {
  const {
    connectionStatus,
    dataSource,
    exchangeLabel,
    marketLabel,
    wsStatusLabel,
    barCount,
    loadingMoreLeft,
    hasMoreLeft,
    exchangeCatalogStatus,
    exchangeLimitations = [],
  } = status;

  return (
    <MarketStatusBar
      source="live"
      connectionStatus={connectionStatus}
      left={<>
        <span>
          <span className={`status-dot ${connectionStatus}`} />
          {connectionStatus === "connected" && `Connected to ${exchangeLabel}`}
          {connectionStatus === "loading" && (dataSource === "mock" ? "Mock data mode" : "Loading...")}
          {connectionStatus === "disconnected" && "Disconnected"}
        </span>
        <span>{barCount} bars</span>
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
      </>}
      right={<>
        {extensions}
        <span>{dataSource === "mock" ? "Demo Mode" : `${exchangeLabel} ${marketLabel}`}</span>
        <span>{wsStatusLabel}</span>
        <span>CandleScope v0.2.0</span>
      </>}
    />
  );
}

export default memo(StatusBar);
