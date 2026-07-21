import React from "react";
import ReplayControlBar from "./ReplayControlBar.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";


export interface ReplayBottomControlDockProps {
  readonly runtime: ReplayRuntime;
}

function ReplayBottomControlDock({ runtime }: ReplayBottomControlDockProps) {
  return (
    <div
      className="replay-bottom-control-dock"
      data-replay-control-location="bottom"
      aria-label="回放底部控制坞"
    >
      <ReplayControlBar runtime={runtime} />
    </div>
  );
}

export default React.memo(ReplayBottomControlDock);
