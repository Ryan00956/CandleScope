const ASYNC_LANES = new Set([
  "active-hydration",
  "indicator-range",
  "initial-history",
  "load-more",
  "prefetch",
]);

export class AppWorkBudgetHub {
  constructor({ maxConcurrent = 16, maxPerWindow = 6, maxPreviewLanes = 4 } = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.maxPerWindow = Math.max(1, Math.min(this.maxConcurrent, Math.floor(maxPerWindow)));
    this.maxPreviewLanes = Math.max(1, Math.floor(maxPreviewLanes));
    this.queueByWindow = new Map();
    this.activeLeases = new Map();
    this.activeByWindow = new Map();
    this.previewLanes = new Map();
    this.lastWindow = null;
    this.nextLease = 0;
    this.counts = { acquired: 0, released: 0, rejectedPreview: 0, reclaimed: 0 };
  }

  acquire({ windowId, cellId, lane }) {
    if (!windowId || !cellId || !ASYNC_LANES.has(lane)) {
      return Promise.reject(new TypeError("App work request is invalid"));
    }
    return new Promise((resolve, reject) => {
      const queue = this.queueByWindow.get(windowId) || [];
      queue.push({ windowId, cellId, lane, resolve, reject });
      this.queueByWindow.set(windowId, queue);
      this.drain();
    });
  }

  release(leaseId) {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;
    this.activeLeases.delete(leaseId);
    this.activeByWindow.set(lease.windowId, Math.max(0, (this.activeByWindow.get(lease.windowId) || 0) - 1));
    this.counts.released += 1;
    this.drain();
    return true;
  }

  requestPreview({ windowId, cellId, pinned = false }) {
    if (!windowId || !cellId) return { ok: false, code: "INVALID_PREVIEW_LANE" };
    const key = `${windowId}\u0000${cellId}`;
    if (this.previewLanes.has(key)) return { ok: true, ...this.previewLanes.get(key), idempotent: true };
    if (this.previewLanes.size >= this.maxPreviewLanes) {
      this.counts.rejectedPreview += 1;
      return {
        ok: false,
        code: "PREVIEW_LANE_LIMIT",
        message: `All ${this.maxPreviewLanes} app preview lanes are in use; unpin another Cell first`,
        limit: this.maxPreviewLanes,
      };
    }
    const lease = { windowId, cellId, pinned: pinned === true };
    this.previewLanes.set(key, lease);
    return { ok: true, ...lease, idempotent: false };
  }

  releasePreview({ windowId, cellId }) {
    return this.previewLanes.delete(`${windowId}\u0000${cellId}`);
  }

  releaseWindow(windowId) {
    const queue = this.queueByWindow.get(windowId) || [];
    this.queueByWindow.delete(windowId);
    queue.forEach((request) => request.resolve({ released: true, windowId }));
    for (const [leaseId, lease] of [...this.activeLeases]) {
      if (lease.windowId !== windowId) continue;
      this.activeLeases.delete(leaseId);
      this.counts.reclaimed += 1;
    }
    this.activeByWindow.delete(windowId);
    for (const [key, lease] of [...this.previewLanes]) {
      if (lease.windowId === windowId) this.previewLanes.delete(key);
    }
    this.drain();
  }

  diagnostics() {
    return {
      maxConcurrent: this.maxConcurrent,
      maxPerWindow: this.maxPerWindow,
      maxPreviewLanes: this.maxPreviewLanes,
      active: this.activeLeases.size,
      activeByWindow: Object.fromEntries(this.activeByWindow),
      pendingByWindow: Object.fromEntries([...this.queueByWindow].map(([id, queue]) => [id, queue.length])),
      previewLanes: [...this.previewLanes.values()].map((lease) => ({ ...lease })),
      counts: { ...this.counts },
    };
  }

  drain() {
    while (this.activeLeases.size < this.maxConcurrent) {
      const windows = [...this.queueByWindow.keys()].filter((windowId) => (
        (this.queueByWindow.get(windowId)?.length || 0) > 0
        && (this.activeByWindow.get(windowId) || 0) < this.maxPerWindow
      ));
      if (windows.length === 0) return;
      windows.sort();
      const lastIndex = this.lastWindow ? windows.indexOf(this.lastWindow) : -1;
      const windowId = windows[(lastIndex + 1) % windows.length];
      const queue = this.queueByWindow.get(windowId);
      const request = queue?.shift();
      if (!request) {
        this.queueByWindow.delete(windowId);
        continue;
      }
      if (queue.length === 0) this.queueByWindow.delete(windowId);
      const leaseId = `work-${++this.nextLease}`;
      const lease = { leaseId, windowId, cellId: request.cellId, lane: request.lane };
      this.activeLeases.set(leaseId, lease);
      this.activeByWindow.set(windowId, (this.activeByWindow.get(windowId) || 0) + 1);
      this.lastWindow = windowId;
      this.counts.acquired += 1;
      request.resolve({ ...lease });
    }
  }
}
