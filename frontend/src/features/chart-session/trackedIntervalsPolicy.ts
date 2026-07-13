export function buildRealtimeTrackedIntervals(
  interval: unknown,
  fallbackInterval: unknown = "1m",
): string[] {
  const desired = [interval, fallbackInterval]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(desired));
}
