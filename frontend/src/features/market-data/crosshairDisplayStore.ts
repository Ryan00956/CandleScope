import type { CrosshairData } from "./klineContracts.js";

let snapshot: CrosshairData | null = null;
let pendingSnapshot: CrosshairData | null = null;
let frameId = 0;

const listeners = new Set<() => void>();

function sameCrosshairData(
  a: CrosshairData | null,
  b: CrosshairData | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.time === b.time
    && a.open === b.open
    && a.high === b.high
    && a.low === b.low
    && a.close === b.close
    && a.volume === b.volume;
}
function flushPendingSnapshot(): void {
  frameId = 0;
  if (sameCrosshairData(snapshot, pendingSnapshot)) return;
  snapshot = pendingSnapshot;
  for (const listener of listeners) listener();
}

export function publishCrosshairData(data: CrosshairData | null | undefined): void {
  pendingSnapshot = data || null;
  if (sameCrosshairData(snapshot, pendingSnapshot)) return;

  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    flushPendingSnapshot();
    return;
  }

  if (!frameId) {
    frameId = window.requestAnimationFrame(flushPendingSnapshot);
  }
}

export function subscribeCrosshairData(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCrosshairSnapshot(): CrosshairData | null {
  return snapshot;
}
