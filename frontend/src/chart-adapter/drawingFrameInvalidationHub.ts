export interface DrawingFrameInvalidationTimeScale {
  subscribeSizeChange?(handler: (width: number, height: number) => void): void;
  subscribeVisibleLogicalRangeChange?(
    handler: (range: { from: number; to: number } | null) => void,
  ): void;
  unsubscribeSizeChange?(handler: (width: number, height: number) => void): void;
  unsubscribeVisibleLogicalRangeChange?(
    handler: (range: { from: number; to: number } | null) => void,
  ): void;
}

export type SharedDrawingFrameInvalidationSource = "dpr" | "size" | "visible-range";

type SharedDrawingFrameInvalidationListener = (
  source: SharedDrawingFrameInvalidationSource,
) => void;

interface ListenerRegistration {
  readonly listener: SharedDrawingFrameInvalidationListener;
}

interface DrawingFrameInvalidationHub {
  readonly timeScale: DrawingFrameInvalidationTimeScale;
  readonly registrations: Set<ListenerRegistration>;
  readonly notifyVisibleRange: () => void;
  readonly notifySize: () => void;
  active: boolean;
  dprMediaQuery: MediaQueryList | null;
  dprMediaQueryListener: (() => void) | null;
  dprPollTimer: number | null;
  observedDpr: number;
}

const invalidationHubs = new WeakMap<object, DrawingFrameInvalidationHub>();

function currentDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio;
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function safeCall(callback: () => void): void {
  try {
    callback();
  } catch {
    // A missing or partially disposed chart API must not break the other
    // drawing surfaces sharing this native subscription.
  }
}

function notifyHub(
  hub: DrawingFrameInvalidationHub,
  source: SharedDrawingFrameInvalidationSource,
): void {
  if (!hub.active) return;
  for (const registration of [...hub.registrations]) {
    safeCall(() => registration.listener(source));
  }
}

function removeDprMediaQueryListener(hub: DrawingFrameInvalidationHub): void {
  if (!hub.dprMediaQuery || !hub.dprMediaQueryListener) return;
  if (typeof hub.dprMediaQuery.removeEventListener === "function") {
    hub.dprMediaQuery.removeEventListener("change", hub.dprMediaQueryListener);
  } else {
    hub.dprMediaQuery.removeListener?.(hub.dprMediaQueryListener);
  }
  hub.dprMediaQuery = null;
  hub.dprMediaQueryListener = null;
}

function armDprMediaQuery(hub: DrawingFrameInvalidationHub): void {
  removeDprMediaQueryListener(hub);
  if (!hub.active
    || typeof window === "undefined"
    || typeof window.matchMedia !== "function") return;
  hub.observedDpr = currentDevicePixelRatio();
  hub.dprMediaQuery = window.matchMedia(`(resolution: ${hub.observedDpr}dppx)`);
  hub.dprMediaQueryListener = () => detectDprChange(hub);
  if (typeof hub.dprMediaQuery.addEventListener === "function") {
    hub.dprMediaQuery.addEventListener("change", hub.dprMediaQueryListener);
  } else {
    hub.dprMediaQuery.addListener?.(hub.dprMediaQueryListener);
  }
}

function detectDprChange(hub: DrawingFrameInvalidationHub): void {
  if (!hub.active) return;
  const nextDpr = currentDevicePixelRatio();
  if (nextDpr === hub.observedDpr) return;
  hub.observedDpr = nextDpr;
  notifyHub(hub, "dpr");
  armDprMediaQuery(hub);
}

function attachHub(hub: DrawingFrameInvalidationHub): void {
  if (hub.active) return;
  hub.active = true;
  safeCall(() => hub.timeScale.subscribeVisibleLogicalRangeChange?.(hub.notifyVisibleRange));
  safeCall(() => hub.timeScale.subscribeSizeChange?.(hub.notifySize));
  armDprMediaQuery(hub);
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    // One fallback poll per chart time scale covers every pane adapter. This
    // retains device-metrics/monitor-change support without multiplying timers
    // as drawing hosts are restored in additional panes.
    hub.dprPollTimer = window.setInterval(() => detectDprChange(hub), 250);
  }
}

function detachHub(hub: DrawingFrameInvalidationHub): void {
  if (!hub.active) return;
  hub.active = false;
  safeCall(() => hub.timeScale.unsubscribeVisibleLogicalRangeChange?.(hub.notifyVisibleRange));
  safeCall(() => hub.timeScale.unsubscribeSizeChange?.(hub.notifySize));
  if (hub.dprPollTimer !== null && typeof window !== "undefined") {
    window.clearInterval(hub.dprPollTimer);
    hub.dprPollTimer = null;
  }
  removeDprMediaQueryListener(hub);
}

function getOrCreateHub(
  timeScale: DrawingFrameInvalidationTimeScale,
): DrawingFrameInvalidationHub {
  const key = timeScale as object;
  const existing = invalidationHubs.get(key);
  if (existing) return existing;
  const hub: DrawingFrameInvalidationHub = {
    timeScale,
    registrations: new Set(),
    notifyVisibleRange: () => {},
    notifySize: () => {},
    active: false,
    dprMediaQuery: null,
    dprMediaQueryListener: null,
    dprPollTimer: null,
    observedDpr: currentDevicePixelRatio(),
  };
  // The native callbacks are stable for the full shared-hub lifetime, so the
  // final adapter can reliably remove the exact functions first subscribed.
  Object.assign(hub, {
    notifyVisibleRange: () => notifyHub(hub, "visible-range"),
    notifySize: () => notifyHub(hub, "size"),
  });
  invalidationHubs.set(key, hub);
  return hub;
}

/**
 * Share LWC range/size and DPR invalidation sources between pane adapters that
 * reference the same chart time scale. Delivery stays synchronous: every
 * runtime observes the native LWC invalidation before the current callback
 * returns, preserving the chart pre-paint synchronization contract.
 */
export function subscribeSharedDrawingFrameInvalidation(
  timeScale: DrawingFrameInvalidationTimeScale | null | undefined,
  listener: SharedDrawingFrameInvalidationListener,
): () => void {
  if (!timeScale || typeof listener !== "function") return () => {};
  const hub = getOrCreateHub(timeScale);
  const registration = Object.freeze({ listener });
  hub.registrations.add(registration);
  if (hub.registrations.size === 1) attachHub(hub);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    hub.registrations.delete(registration);
    if (hub.registrations.size > 0) return;
    detachHub(hub);
    invalidationHubs.delete(timeScale as object);
  };
}
