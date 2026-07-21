import MarketWorkspaceFrame from "./MarketWorkspaceFrame.js";
import type { MarketWorkspaceFrameProps } from "./MarketWorkspaceFrame.js";


export type MarketChartWorkspaceProps = MarketWorkspaceFrameProps;

/** Shared source-neutral chart/toolbar/rail ownership for live and replay. */
export default function MarketChartWorkspace(props: MarketChartWorkspaceProps) {
  return <MarketWorkspaceFrame {...props} />;
}
