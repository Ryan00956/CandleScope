const STRUCTURAL_VIEWPORT_DELTAS = new Set([
  "prepend",
  "mid-merge",
  "trim-left",
  "trim-right",
]);

function hasTrim(delta) {
  return (Number(delta?.trimmedLeft) || 0) > 0
    || (Number(delta?.trimmedRight) || 0) > 0;
}

export function shouldPreserveProjectionViewport(delta, {
  hasDisplay = false,
  userInteracted = false,
} = {}) {
  if (!hasDisplay) return false;

  const type = delta?.type;
  if (type === "replace") return userInteracted;
  if (STRUCTURAL_VIEWPORT_DELTAS.has(type)) return true;

  return (type === "tick" || type === "append") && hasTrim(delta);
}
