import React from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import ReplayControlBar from "./ReplayControlBar.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";
import type { ReplayViewerRuntime } from "../useReplayViewerRuntime.js";


export interface ReplayBottomControlDockProps {
  readonly runtime: ReplayRuntime;
  readonly viewer: ReplayViewerRuntime;
  readonly publicTimeLabel?: string | undefined;
}

function ReplayBottomControlDock({ runtime, viewer, publicTimeLabel }: ReplayBottomControlDockProps) {
  useLocale();
  return (
    <div
      className="replay-bottom-control-dock"
      data-replay-control-location="bottom"
      aria-label={t("replay.control.dock")}
    >
      <ReplayControlBar runtime={runtime} viewer={viewer} publicTimeLabel={publicTimeLabel} />
    </div>
  );
}

export default React.memo(ReplayBottomControlDock);
