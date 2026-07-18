import type { ReactNode, Ref } from "react";

export interface MarketPageFrameProps {
  rootRef?: Ref<HTMLDivElement>;
  topBar: ReactNode;
  intervalSelector: ReactNode;
  workspace: ReactNode;
  featureSurfaces: ReactNode;
  statusBar: ReactNode;
}

/** Source-neutral outer market-page layout. */
export default function MarketPageFrame({
  rootRef,
  topBar,
  intervalSelector,
  workspace,
  featureSurfaces,
  statusBar,
}: MarketPageFrameProps) {
  return (
    <div className="app-layout" ref={rootRef}>
      {topBar}
      {intervalSelector}
      {workspace}
      {featureSurfaces}
      {statusBar}
    </div>
  );
}
