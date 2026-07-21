import type { ReplayEntry } from "./replayEntry.js";

export type ReplayProduct = "v1" | "hub";

export function resolveReplayProduct(
  v2Enabled: boolean,
  entry: ReplayEntry,
): ReplayProduct {
  return v2Enabled && entry.kind === "configure" ? "hub" : "v1";
}
