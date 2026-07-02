export const WINDOW_DELTA_TYPES = Object.freeze({
  NOOP: "noop",
  TICK: "tick",
  APPEND: "append",
  PREPEND: "prepend",
  MID_MERGE: "mid-merge",
  REPLACE: "replace",
  CLEAR: "clear",
  TRIM_LEFT: "trim-left",
  TRIM_RIGHT: "trim-right",
});

export function createWindowDelta(type, detail = {}) {
  return {
    type,
    changed: type !== WINDOW_DELTA_TYPES.NOOP,
    ...detail,
  };
}
