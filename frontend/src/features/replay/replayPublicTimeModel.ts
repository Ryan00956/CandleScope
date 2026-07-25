import type { ReplayV2TimeDisclosurePolicy } from "./replayV2Types.js";

export interface ReplayPublicTimeFormatterOptions {
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly originMs: number | null;
  readonly timelineOriginMs?: number | null;
  readonly labels: ReadonlyMap<number, string>;
}

function relativeLabel(valueMs: number, originMs: number | null): string {
  if (!Number.isSafeInteger(valueMs)
    || originMs === null
    || !Number.isSafeInteger(originMs)) {
    return "D+? --:--:--";
  }
  const delta = valueMs - originMs;
  const sign = delta >= 0 ? "+" : "-";
  const absolute = Math.abs(delta);
  const day = Math.floor(absolute / 86_400_000) + 1;
  const withinDay = absolute % 86_400_000;
  const hours = Math.floor(withinDay / 3_600_000);
  const minutes = Math.floor((withinDay % 3_600_000) / 60_000);
  const seconds = Math.floor((withinDay % 60_000) / 1_000);
  return `D${sign}${day} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function utcLabel(valueMs: number): string {
  if (!Number.isSafeInteger(valueMs) || valueMs < 0) return "--";
  try {
    return new Date(valueMs).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "--";
  }
}

/**
 * Formats only server-projected labels for partially hidden clocks.
 *
 * Cache misses deliberately fall back to a fully relative label. The browser
 * never reconstructs calendar units from the synthetic year-2000 timeline.
 */
export function createReplayPublicTimeFormatter({
  policy,
  originMs,
  timelineOriginMs = originMs,
  labels,
}: ReplayPublicTimeFormatterOptions): (valueMs: number) => string {
  return (valueMs: number): string => {
    const serverLabel = labels.get(valueMs);
    if (serverLabel !== undefined) return serverLabel;
    return policy === "NONE"
      ? utcLabel(
        originMs !== null && timelineOriginMs !== null
          ? originMs + valueMs - timelineOriginMs
          : valueMs,
      )
      : relativeLabel(valueMs, originMs);
  };
}
