import type { ReactNode } from "react";

export interface MarketWorkspaceFrameProps {
  toolbar: ReactNode;
  exportOverlay: ReactNode;
  chart: ReactNode;
  rightRail: ReactNode;
}

/** Source-neutral chart workspace slots; runtime ownership stays in callers. */
export default function MarketWorkspaceFrame({
  toolbar,
  exportOverlay,
  chart,
  rightRail,
}: MarketWorkspaceFrameProps) {
  return (
    <div className="main-content-area">
      <div className="chart-with-toolbar">
        {toolbar}
        {exportOverlay}
        {chart}
      </div>
      {rightRail}
    </div>
  );
}
