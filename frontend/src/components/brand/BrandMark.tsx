export interface BrandMarkProps {
  readonly size?: number;
  readonly label?: string;
  readonly className?: string;
  readonly variant?: "compact" | "full";
}

/** Canonical CandleScope mark. Compact is tuned for app chrome and favicons. */
export default function BrandMark({
  size = 24,
  label = "",
  className = "",
  variant = "compact",
}: BrandMarkProps) {
  const source = variant === "compact"
    ? "/brand/candlescope-mark-compact.svg"
    : "/brand/candlescope-mark-on-dark.svg";

  return (
    <img
      src={source}
      width={size}
      height={size}
      className={`brand-mark ${className}`.trim()}
      alt={label}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  );
}

export function BrandWordmark() {
  return (
    <span className="logo-text brand-wordmark" aria-label="CandleScope">
      <span className="brand-wordmark-candle" aria-hidden="true">Candle</span>
      <span className="brand-wordmark-scope" aria-hidden="true">Scope</span>
    </span>
  );
}
