import React from "react";
import ReplayControlBar from "./ReplayControlBar.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";


export interface ReplayBottomControlDockProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
}

function ReplayBottomControlDock({ runtime, viewer }: ReplayBottomControlDockProps) {
  return (
    <div
      className="replay-bottom-control-dock"
      data-replay-control-location="bottom"
      aria-label="回放底部控制坞"
    >
      <ReplayControlBar runtime={runtime} viewer={viewer} />
    </div>
  );
}

export default React.memo(ReplayBottomControlDock);
