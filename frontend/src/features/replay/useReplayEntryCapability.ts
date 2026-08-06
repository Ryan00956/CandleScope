import { useEffect, useState } from "react";
import { defaultReplayApi } from "./replayApi.js";
import type { ReplayApiClient } from "./replayApi.js";

export type ReplayEntryCapabilityView =
  | { readonly state: "checking"; readonly href: "/replay.html"; readonly reason: string }
  | { readonly state: "enabled"; readonly href: "/replay.html"; readonly reason: null }
  | { readonly state: "disabled"; readonly href: "/replay.html"; readonly reason: string };

export interface ReplayEntryCapabilityOptions {
  readonly api?: Pick<ReplayApiClient, "capabilities">;
}

export function replayEntryCapabilityFromPayload(
  capability: Awaited<ReturnType<ReplayApiClient["capabilities"]>>,
): ReplayEntryCapabilityView {
  if (capability.enabled && capability.available) {
    return { state: "enabled", href: "/replay.html", reason: null };
  }
  const reason = capability.persistence.degraded_reason
    ?? capability.reason
    ?? "Replay capability is unavailable";
  return { state: "disabled", href: "/replay.html", reason };
}

export function useReplayEntryCapability({
  api = defaultReplayApi,
}: ReplayEntryCapabilityOptions = {}): ReplayEntryCapabilityView {
  const [view, setView] = useState<ReplayEntryCapabilityView>({
    state: "checking",
    href: "/replay.html",
    reason: "Checking replay capability…",
  });

  useEffect(() => {
    const controller = new AbortController();
    void api.capabilities(controller.signal).then(
      (capability) => {
        if (!controller.signal.aborted) setView(replayEntryCapabilityFromPayload(capability));
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setView({
          state: "disabled",
          href: "/replay.html",
          reason: error instanceof Error ? error.message : "Replay capability check failed",
        });
      },
    );
    return () => controller.abort();
  }, [api]);

  return view;
}
