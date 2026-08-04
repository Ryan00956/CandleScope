import { TickMarkType } from "../../chart-adapter/chartAdapterTypes.js";
import type { ReplayV2TimeDisclosurePolicy } from "./replayV2Types.js";

export interface ReplayPublicTimeFormatterOptions {
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly originMs: number | null;
  readonly timelineOriginMs?: number | null;
  readonly labels: ReadonlyMap<number, string>;
}

/**
 * Lightweight Charts otherwise budgets for eight characters when deciding how
 * many horizontal-axis marks fit. Most compact replay labels need the normal
 * eight-character budget; relative-hour/minute labels can reach 12 characters
 * within the supported 30-day horizon (for example `T+719h 59:59`). Supplying
 * the policy-specific bound lets mark density fall as the user zooms out
 * without making the shorter disclosure modes unnecessarily sparse.
 */
export function replayTimeAxisMaxCharacterLength(
  policy: ReplayV2TimeDisclosurePolicy,
): number {
  return policy === "HIDE_HOUR" || policy === "HIDE_MINUTE" ? 12 : 8;
}

function compactClock(
  hour: string,
  minute: string,
  second: string,
  tickMarkType: TickMarkType,
): string | null {
  if (tickMarkType === TickMarkType.Time) return `${hour}:${minute}`;
  if (tickMarkType === TickMarkType.TimeWithSeconds) {
    return `${hour}:${minute}:${second}`;
  }
  return null;
}

/**
 * Reduce an authoritative public-time label according to the semantic weight
 * selected by Lightweight Charts. The complete label remains available through
 * `timeFormatter` for the crosshair; only persistent axis marks are compacted.
 *
 * This function only slices server-produced public labels. It never rebuilds a
 * hidden calendar unit from the synthetic client timeline.
 */
export function formatReplayTimeAxisLabel(
  policy: ReplayV2TimeDisclosurePolicy,
  label: string,
  tickMarkType: TickMarkType,
): string {
  const fallbackRelative = /^(D[+-]\d+) (\d{2}):(\d{2}):(\d{2})$/.exec(label);
  if (policy !== "NONE" && fallbackRelative !== null) {
    return compactClock(
      fallbackRelative[2]!,
      fallbackRelative[3]!,
      fallbackRelative[4]!,
      tickMarkType,
    ) ?? fallbackRelative[1]!;
  }

  if (policy === "NONE") {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(label);
    if (match === null) return label;
    const clock = compactClock(match[4]!, match[5]!, match[6]!, tickMarkType);
    if (clock !== null) return clock;
    if (tickMarkType === TickMarkType.Year) return match[1]!;
    if (tickMarkType === TickMarkType.Month) return `${match[1]}-${match[2]}`;
    if (tickMarkType === TickMarkType.DayOfMonth) return `${match[2]}-${match[3]}`;
    return label;
  }

  if (policy === "HIDE_YEAR") {
    const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(label);
    if (match === null) return label;
    const clock = compactClock(match[3]!, match[4]!, match[5]!, tickMarkType);
    if (clock !== null) return clock;
    if (tickMarkType === TickMarkType.DayOfMonth) return `${match[1]}-${match[2]}`;
    if (tickMarkType === TickMarkType.Year || tickMarkType === TickMarkType.Month) {
      return match[1]!;
    }
    return label;
  }

  if (policy === "HIDE_MONTH") {
    const match = /^(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(label);
    if (match === null) return label;
    return compactClock(match[2]!, match[3]!, match[4]!, tickMarkType)
      ?? (tickMarkType <= TickMarkType.DayOfMonth ? match[1]! : label);
  }

  if (policy === "HIDE_DAY") {
    // The server form is identical to the safe relative cache-miss form handled
    // above, so reaching here means the label contract changed unexpectedly.
    return label;
  }

  if (policy === "HIDE_HOUR") {
    const match = /^(T[+-]\d+h) (\d{2}):(\d{2})$/.exec(label);
    if (match === null) return label;
    if (tickMarkType === TickMarkType.Time) return `${match[1]} ${match[2]}`;
    if (tickMarkType === TickMarkType.TimeWithSeconds) return label;
    return tickMarkType <= TickMarkType.DayOfMonth ? match[1]! : label;
  }

  if (policy === "HIDE_MINUTE") {
    const match = /^(T[+-]\d+m) (\d{2})$/.exec(label);
    if (match === null) return label;
    if (tickMarkType === TickMarkType.TimeWithSeconds) return label;
    return tickMarkType <= TickMarkType.Time ? match[1]! : label;
  }

  const match = /^(D[+-]\d+) T\+(\d{2}):(\d{2}):(\d{2})$/.exec(label);
  if (match === null) return label;
  return compactClock(match[2]!, match[3]!, match[4]!, tickMarkType)
    ?? (tickMarkType <= TickMarkType.DayOfMonth ? match[1]! : label);
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
