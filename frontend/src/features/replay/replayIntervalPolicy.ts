import {
  buildSortedIntervals,
  getNativeIntervals,
} from "../chart-session/exchangeCatalogRuntime.js";
import type {
  ExchangeCatalog,
  GroupedAvailableIntervals,
  NativeInterval,
} from "../chart-session/chartSessionTypes.js";
import {
  canonicalizeIntervalValue,
  intervalTiles,
} from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import { t } from "../../i18n/index.js";


export interface ReplayIntervalCatalog {
  readonly nativeIntervals: NativeInterval[];
  readonly intervalGroups: GroupedAvailableIntervals;
}

export function buildReplayIntervalCatalog(options: {
  readonly exchange: unknown;
  readonly marketType: unknown;
  readonly exchangeCatalog?: ExchangeCatalog | null;
  readonly savedCustomIntervals: readonly IntervalString[];
}): ReplayIntervalCatalog {
  const {
    exchange,
    marketType,
    exchangeCatalog = null,
    savedCustomIntervals,
  } = options;
  return {
    nativeIntervals: getNativeIntervals(
      exchange,
      exchangeCatalog,
      marketType,
      "history",
    ),
    intervalGroups: buildSortedIntervals(
      savedCustomIntervals,
      exchange,
      exchangeCatalog,
      marketType,
    ),
  };
}

export function canProjectReplayDisplayInterval(
  baseInterval: unknown,
  displayInterval: unknown,
): boolean {
  const base = canonicalizeIntervalValue(baseInterval);
  const display = canonicalizeIntervalValue(displayInterval);
  return base !== "" && display !== "" && intervalTiles(base, display);
}

export function replayIntervalUnavailableMessage(
  baseInterval: unknown,
  displayInterval: unknown,
): string {
  const base = canonicalizeIntervalValue(baseInterval) || String(baseInterval || "--");
  const display = canonicalizeIntervalValue(displayInterval) || String(displayInterval || "--");
  return t("replay.interval.unsupportedExact", { base, display });
}
