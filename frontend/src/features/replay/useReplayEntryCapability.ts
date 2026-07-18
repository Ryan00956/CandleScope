import { useEffect, useState } from "react";
import { defaultReplayApi } from "./replayApi.js";
import type { ReplayApiClient } from "./replayApi.js";

export type ReplayEntryCapabilityView =
  | { readonly state: "hidden"; readonly href: "/replay.html"; readonly reason: string }
  | { readonly state: "checking"; readonly href: "/replay.html"; readonly reason: string }
  | { readonly state: "enabled"; readonly href: "/replay.html"; readonly reason: null }
  | { readonly state: "disabled"; readonly href: "/replay.html"; readonly reason: string };

export interface ReplayEntryCapabilityOptions {
  readonly flag?: string | boolean | undefined;
  readonly api?: Pick<ReplayApiClient, "capabilities">;
}

const replayEntryEnvironmentFlag: unknown = (import.meta as {
  readonly env?: { readonly VITE_REPLAY_ENTRY_ENABLED?: unknown };
}).env?.VITE_REPLAY_ENTRY_ENABLED;

export function replayEntryFlagEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true";
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
  flag = typeof replayEntryEnvironmentFlag === "string" ? replayEntryEnvironmentFlag : undefined,
  api = defaultReplayApi,
}: ReplayEntryCapabilityOptions = {}): ReplayEntryCapabilityView {
  const enabledByFlag = replayEntryFlagEnabled(flag);
  const [view, setView] = useState<ReplayEntryCapabilityView>(() => enabledByFlag
    ? { state: "checking", href: "/replay.html", reason: "Checking replay capability…" }
    : { state: "hidden", href: "/replay.html", reason: "VITE_REPLAY_ENTRY_ENABLED is disabled" });

  useEffect(() => {
    if (!enabledByFlag) {
      setView({ state: "hidden", href: "/replay.html", reason: "VITE_REPLAY_ENTRY_ENABLED is disabled" });
      return undefined;
    }
    const controller = new AbortController();
    setView({ state: "checking", href: "/replay.html", reason: "Checking replay capability…" });
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
  }, [api, enabledByFlag]);

  return view;
}
