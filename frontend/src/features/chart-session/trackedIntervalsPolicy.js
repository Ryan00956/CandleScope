export function buildRealtimeTrackedIntervals(interval, fallbackInterval = "1m") {
  const desired = [interval, fallbackInterval]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(desired));
}
