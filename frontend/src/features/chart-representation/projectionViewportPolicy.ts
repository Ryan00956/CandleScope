const STRUCTURAL_VIEWPORT_DELTAS = new Set([
  "prepend",
  "mid-merge",
  "trim-left",
  "trim-right",
]);

function hasTrim(delta: ProjectionSourceDelta | null | undefined): boolean {
  return (Number(delta?.trimmedLeft) || 0) > 0
    || (Number(delta?.trimmedRight) || 0) > 0;
}

export function shouldPreserveProjectionViewport(delta: ProjectionSourceDelta | null | undefined, {
  hasDisplay = false,
  userInteracted = false,
}: {
  hasDisplay?: boolean;
  userInteracted?: boolean;
} = {}): boolean {
  if (!hasDisplay) return false;

  const type = delta?.type;
  if (type === "replace") return userInteracted;
  if (typeof type === "string" && STRUCTURAL_VIEWPORT_DELTAS.has(type)) return true;

  return (type === "tick" || type === "append") && hasTrim(delta);
}
import type { ProjectionSourceDelta } from "./chartRepresentationTypes.js";
