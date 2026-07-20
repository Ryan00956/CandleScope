import { canonicalizeIntervalValue } from "../../utils/intervals.js";

export function buildRealtimeTrackedIntervals(
  interval: unknown,
  fallbackInterval: unknown = "1m",
): string[] {
  const desired = [interval, fallbackInterval]
    .map((value) => canonicalizeIntervalValue(value))
    .filter(Boolean);
  return Array.from(new Set(desired));
}
