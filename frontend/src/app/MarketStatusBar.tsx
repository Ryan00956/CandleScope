import type { HTMLAttributes, ReactNode } from "react";


export interface MarketStatusBarProps {
  readonly source?: "live" | "replay";
  readonly className?: string;
  readonly connectionStatus: string;
  readonly left: ReactNode;
  readonly right: ReactNode;
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string | number | boolean>>;
}

/** Shared status-bar DOM owner; adapters provide source-specific truthful labels. */
export default function MarketStatusBar({
  source = "live",
  className = "",
  connectionStatus,
  left,
  right,
  dataAttributes = {},
}: MarketStatusBarProps) {
  const attributes = Object.fromEntries(
    Object.entries(dataAttributes).map(([key, value]) => [key, String(value)]),
  ) as HTMLAttributes<HTMLElement>;
  return (
    <footer
      className={`status-bar ${className}`.trim()}
      id="status-bar"
      data-runtime-source={source}
      data-connection-status={connectionStatus}
      data-market-shell-owner="status-bar"
      {...attributes}
    >
      <div className="status-left">{left}</div>
      <div className="status-right">{right}</div>
    </footer>
  );
}
