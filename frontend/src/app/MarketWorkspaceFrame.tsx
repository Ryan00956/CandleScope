import type { ReactNode } from "react";

export interface MarketWorkspaceFrameProps {
  toolbar: ReactNode;
  exportOverlay: ReactNode;
  chart: ReactNode;
  bottomPanel?: ReactNode;
  rightRail: ReactNode;
}

/** Source-neutral chart workspace slots; runtime ownership stays in callers. */
export default function MarketWorkspaceFrame({
  toolbar,
  exportOverlay,
  chart,
  bottomPanel = null,
  rightRail,
}: MarketWorkspaceFrameProps) {
  return (
    <div className="main-content-area">
      <div className="chart-with-toolbar">
        {toolbar}
        <div className="market-workspace-content">
          {exportOverlay}
          {chart}
          {bottomPanel}
        </div>
      </div>
      {rightRail}
    </div>
  );
}
