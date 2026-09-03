import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import TrainingHubDialog from "../replay/components/TrainingHubDialog.js";
import type { ReplayLaunchContext } from "../replay/replayV2Types.js";
import {
  useTrainingHub,
  type TrainingHubRuntime,
} from "../replay/useTrainingHub.js";

export interface ReplayLauncherDialogProps {
  readonly launchContext: ReplayLaunchContext;
  readonly onRequestClose: () => void;
}

function replayRunUrl(runId: string): string {
  return `/replay.html?run=${encodeURIComponent(runId)}`;
}

export default function ReplayLauncherDialog({
  launchContext,
  onRequestClose,
}: ReplayLauncherDialogProps) {
  useLocale();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pendingReplayWindowRef = useRef<Window | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const reserveReplayWindow = useCallback(() => {
    setBlockedUrl(null);
    if (window.candlescopeDesktop?.openAppPage) return;
    const previous = pendingReplayWindowRef.current;
    pendingReplayWindowRef.current = null;
    if (previous !== null && !previous.closed) previous.close();
    const child = window.open("about:blank", "_blank");
    if (child === null) return;
    child.opener = null;
    child.document.title = t("replay.launcher.preparing");
    pendingReplayWindowRef.current = child;
  }, []);
  const closeUnusedReplayWindow = useCallback(() => {
    const orphan = pendingReplayWindowRef.current;
    pendingReplayWindowRef.current = null;
    if (orphan !== null && !orphan.closed) orphan.close();
  }, []);
  const navigateToRun = useCallback((runId: string) => {
    const url = replayRunUrl(runId);
    if (window.candlescopeDesktop?.openAppPage) {
      void window.candlescopeDesktop.openAppPage(url)
        .then(onRequestClose, () => setBlockedUrl(url));
      return;
    }
    const reserved = pendingReplayWindowRef.current;
    pendingReplayWindowRef.current = null;
    if (reserved !== null && !reserved.closed) {
      reserved.location.replace(url);
      onRequestClose();
      return;
    }
    const child = window.open("about:blank", "_blank");
    if (child === null) {
      setBlockedUrl(url);
      return;
    }
    child.opener = null;
    child.location.replace(url);
    onRequestClose();
  }, [onRequestClose]);
  const runtime = useTrainingHub({ launchContext, navigateToRun });
  const launcherRuntime = useMemo<TrainingHubRuntime>(() => ({
    ...runtime,
    actions: {
      ...runtime.actions,
      createRun: async (draft) => {
        reserveReplayWindow();
        await runtime.actions.createRun(draft);
        closeUnusedReplayWindow();
      },
    },
  }), [closeUnusedReplayWindow, reserveReplayWindow, runtime]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = "hidden";
    overlayRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const pending = pendingReplayWindowRef.current;
      pendingReplayWindowRef.current = null;
      if (pending !== null && !pending.closed) pending.close();
      previousFocus?.focus();
    };
  }, []);

  const launchLabel = t("replay.launcher.context", {
    identity: `${launchContext.exchange} · ${launchContext.market_type} · ${launchContext.symbol}`,
    interval: launchContext.display_interval,
    count: launchContext.watchlist_snapshot.groups.length,
  });

  return (
    <div
      ref={overlayRef}
      className="replay-launcher-overlay"
      data-replay-launcher="live-modal"
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onRequestClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onRequestClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), "
            + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
          ),
        );
        if (focusable.length === 0) {
          event.preventDefault();
          event.currentTarget.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {blockedUrl !== null && (
        <div className="replay-launcher-popup-blocked" role="alert">
          <span>{t("replay.launcher.blocked")}</span>
          <a href={blockedUrl} target="_blank" rel="noopener noreferrer">
            {t("replay.launcher.open")}
          </a>
        </div>
      )}
      <TrainingHubDialog
        runtime={launcherRuntime}
        presentation="modal"
        launchLabel={launchLabel}
        onRequestClose={onRequestClose}
      />
    </div>
  );
}
