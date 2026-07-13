import type {
  WindowDelta,
  WindowDeltaDetail,
  WindowDeltaType,
} from "../klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../klineContracts.js";

export { WINDOW_DELTA_TYPES };

function assertNever(value: never): never {
  throw new Error(`Unsupported window delta type: ${String(value)}`);
}
function windowDeltaChanged(type: WindowDeltaType): boolean {
  switch (type) {
    case WINDOW_DELTA_TYPES.NOOP:
      return false;
    case WINDOW_DELTA_TYPES.TICK:
    case WINDOW_DELTA_TYPES.APPEND:
    case WINDOW_DELTA_TYPES.PREPEND:
    case WINDOW_DELTA_TYPES.MID_MERGE:
    case WINDOW_DELTA_TYPES.REPLACE:
    case WINDOW_DELTA_TYPES.CLEAR:
    case WINDOW_DELTA_TYPES.TRIM_LEFT:
    case WINDOW_DELTA_TYPES.TRIM_RIGHT:
      return true;
    default:
      return assertNever(type);
  }
}

export function createWindowDelta(
  type: WindowDeltaType,
  detail: WindowDeltaDetail = {},
): WindowDelta {
  return {
    type,
    changed: windowDeltaChanged(type),
    ...detail,
  } as WindowDelta;
}
