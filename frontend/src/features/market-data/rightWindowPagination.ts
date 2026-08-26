import type { KlineFetchResult } from "./klineContracts.js";
import type { KlineBar } from "./marketDataTypes.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";

export const RIGHT_WINDOW_PAGE_SIZE = 500;

export interface RightWindowPagePlan {
  start: number;
  end: number;
  bars: number;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function planRightWindowPage(
  interval: string,
  lastLoadedTime: unknown,
  bars = RIGHT_WINDOW_PAGE_SIZE,
): RightWindowPagePlan | null {
  const timeline = createIntervalTimeline(interval);
  const last = finiteNumber(lastLoadedTime);
  const pageBars = Math.floor(Number(bars));
  if (!timeline || last == null || !Number.isSafeInteger(pageBars) || pageBars <= 0) return null;

  const start = timeline.next(last);
  if (start == null) return null;
  let end = start;
  for (let index = 1; index < pageBars; index += 1) {
    const next = timeline.next(end);
    if (next == null || next <= end) return null;
    end = next;
  }
  return { start, end, bars: pageBars };
}

export function rightWindowPageReachedLatest(
  result: KlineFetchResult | null | undefined,
  plan: RightWindowPagePlan | null | undefined,
): boolean {
  if (!result || !plan) return false;
  if (result.reached_latest_closed_bar === true) return true;
  if (result.reached_latest_closed_bar === false) return false;
  const effectiveEndMs = finiteNumber(result.effective_end_ms);
  return effectiveEndMs != null && effectiveEndMs < plan.end * 1_000;
}

export function rightWindowPageRowsAreBounded(
  rows: readonly KlineBar[] | null | undefined,
  plan: RightWindowPagePlan | null | undefined,
): boolean {
  if (!plan || !rows) return false;
  let previousTime: number | null = null;
  for (const row of rows) {
    const time = finiteNumber(row?.time);
    if (
      time == null
      || time < plan.start
      || time > plan.end
      || (previousTime != null && time <= previousTime)
    ) return false;
    previousTime = time;
  }
  return true;
}
