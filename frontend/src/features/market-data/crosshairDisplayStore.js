let snapshot = null;
let pendingSnapshot = null;
let frameId = 0;

const listeners = new Set();

function sameCrosshairData(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.time === b.time
    && a.open === b.open
    && a.high === b.high
    && a.low === b.low
    && a.close === b.close
    && a.volume === b.volume;
}

function flushPendingSnapshot() {
  frameId = 0;
  if (sameCrosshairData(snapshot, pendingSnapshot)) return;
  snapshot = pendingSnapshot;
  for (const listener of listeners) listener();
}

export function publishCrosshairData(data) {
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

export function subscribeCrosshairData(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCrosshairSnapshot() {
  return snapshot;
}
