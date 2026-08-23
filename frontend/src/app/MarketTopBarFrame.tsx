import type { ReactNode } from "react";
import BrandMark, { BrandWordmark } from "../components/brand/BrandMark.js";

export interface MarketTopBarFrameProps {
  readonly source?: "live" | "replay" | "local";
  readonly className?: string;
  readonly brandIcon?: ReactNode;
  readonly brandText?: ReactNode;
  readonly navigation?: ReactNode;
  readonly identity?: ReactNode;
  readonly controls?: ReactNode;
  readonly quote?: ReactNode;
  readonly marketMetrics?: ReactNode;
  readonly ohlcv?: ReactNode;
  readonly trailing?: ReactNode;
}

/** Shared top-bar ownership and slot order for live and replay market pages. */
export default function MarketTopBarFrame({
  source = "live",
  className = "",
  brandIcon,
  brandText,
  navigation = null,
  identity = null,
  controls = null,
  quote = null,
  marketMetrics = null,
  ohlcv = null,
  trailing = null,
}: MarketTopBarFrameProps) {
  return (
    <header
      className={`top-bar ${className}`.trim()}
      id="top-bar"
      data-runtime-source={source}
      data-market-shell-owner="top-bar"
    >
      <div className="logo">
        <div className="logo-icon">
          {brandIcon === undefined ? <BrandMark size={24} /> : brandIcon}
        </div>
        {brandText === undefined
          ? <BrandWordmark />
          : <span className="logo-text">{brandText}</span>}
      </div>
      {navigation}
      {identity}
      {controls}
      {quote}
      {marketMetrics}
      {ohlcv}
      {trailing}
    </header>
  );
}
