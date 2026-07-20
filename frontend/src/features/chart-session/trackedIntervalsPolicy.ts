import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
} from "../../utils/intervals.js";

export function buildRealtimeTrackedIntervals(
  interval: unknown,
  realtimeNativeIntervals: readonly unknown[],
  fallbackInterval: unknown = "1m",
): string[] {
  const desired = [interval, fallbackInterval]
    .map((value) => canonicalizeIntervalValue(value))
    .filter((value) => (
      Boolean(value)
      && canResolveIntervalFromNativeValues(value, realtimeNativeIntervals)
    ));
  return Array.from(new Set(desired));
}
