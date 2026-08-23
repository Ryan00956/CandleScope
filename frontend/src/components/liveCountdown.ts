import { t } from "../i18n/index.js";

let snapshotMs = Date.now();
let scheduledTick: ReturnType<typeof globalThis.setTimeout> | null = null;
const listeners = new Set<() => void>();

function scheduleNextTick(): void {
  if (scheduledTick !== null || listeners.size === 0) return;

  const delayMs = Math.max(1, 1_000 - (snapshotMs % 1_000));
  scheduledTick = globalThis.setTimeout(() => {
    scheduledTick = null;
    snapshotMs = Date.now();
    for (const listener of listeners) listener();
    scheduleNextTick();
  }, delayMs);
}

export function subscribeLiveCountdown(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) snapshotMs = Date.now();
  scheduleNextTick();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && scheduledTick !== null) {
      globalThis.clearTimeout(scheduledTick);
      scheduledTick = null;
    }
  };
}

export function getLiveCountdownNowMs(): number {
  return snapshotMs;
}

export function formatLiveCountdown(
  targetTimeMs: number | null | undefined,
  nowMs: number,
): string | null {
  if (typeof targetTimeMs !== "number" || !Number.isFinite(targetTimeMs) || !Number.isFinite(nowMs)) {
    return null;
  }

  const remainingSeconds = Math.ceil((targetTimeMs - nowMs) / 1_000);
  if (remainingSeconds <= 0) return null;

  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  const clock = [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return days > 0 ? t("countdown.days", { days, clock }) : clock;
}
