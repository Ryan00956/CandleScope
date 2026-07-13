import type {
  PerformanceEntryRecord,
  PerformanceMarkName,
  PerformanceReport,
  PerformanceStore,
} from "./performanceTypes.js";

const PERF_NAMESPACE = "__CANDLESCOPE_PERF__";
const MAX_EVENTS = 240;

const TIMING_PAIRS: Record<string, readonly [PerformanceMarkName, PerformanceMarkName]> = {
  appBootToRootRequestedMs: ["app.boot.start", "app.root.render.requested"],
  latestRequestMs: ["chart.initialLoad.latest.request", "chart.initialLoad.latest.response"],
  latestCommitMs: ["chart.initialLoad.start", "chart.initialLoad.latest.commit"],
  historyRequestMs: ["chart.initialLoad.history.request", "chart.initialLoad.history.response"],
  historyCommitMs: ["chart.initialLoad.start", "chart.initialLoad.history.commit"],
  firstBarsMs: ["app.boot.start", "chart.firstBars"],
  chartReadyMs: ["app.boot.start", "chart.ready"],
  wsOpenMs: ["app.boot.start", "ws.kline.open"],
  wsLiveReadyMs: ["app.boot.start", "ws.kline.live"],
  firstRealtimeTickMs: ["app.boot.start", "ws.kline.firstTick"],
  indicatorComputeMs: ["indicator.compute.start", "indicator.compute.end"],
  indicatorHostedOpenMs: ["app.boot.start", "indicator.ws.open"],
  indicatorHostedSnapshotMs: ["app.boot.start", "indicator.ws.snapshot"],
  settingsOpenMs: ["lazy.settings.open.start", "lazy.settings.ready"],
  symbolSearchOpenMs: ["lazy.symbolSearch.open.start", "lazy.symbolSearch.ready"],
  watchlistReadyMs: ["app.boot.start", "lazy.watchlist.ready"],
  drawingToolbarReadyMs: ["app.boot.start", "lazy.drawingToolbar.ready"],
};

interface PerformanceWindow extends Window {
  __CANDLESCOPE_PERF__?: PerformanceStore;
}

function canUseWindow(): boolean {
  return typeof window !== "undefined";
}

function now(): number {
  if (canUseWindow() && window.performance?.now) return window.performance.now();
  return Date.now();
}

function safeDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== "object") return detail ?? null;
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return null;
  }
}

function getStore(): PerformanceStore | null {
  if (!canUseWindow()) return null;
  const perfWindow = window as PerformanceWindow;
  if (perfWindow.__CANDLESCOPE_PERF__) return perfWindow.__CANDLESCOPE_PERF__;

  const createdAt = now();
  const store: PerformanceStore = {
    createdAt,
    marks: {},
    events: [],
    mark(name, detail) {
      return markPerf(name, detail);
    },
    markOnce(name, detail) {
      return markPerfOnce(name, detail);
    },
    event(name, detail) {
      return recordPerfEvent(name, detail);
    },
    measure(name, startName, endName) {
      return measurePerf(name, startName, endName);
    },
    report() {
      return buildPerfReport();
    },
  };
  perfWindow.__CANDLESCOPE_PERF__ = store;
  return store;
}

function performanceMark(name: PerformanceMarkName, detail: unknown): void {
  if (!canUseWindow() || !window.performance?.mark) return;
  try {
    window.performance.mark(name, detail ? { detail } : undefined);
  } catch {
    try {
      window.performance.mark(name);
    } catch {
      // Ignore unsupported performance APIs.
    }
  }
}

export function markPerf(
  name: PerformanceMarkName,
  detail: unknown = null,
): PerformanceEntryRecord | null {
  const store = getStore();
  if (!store || !name) return null;
  const at = now();
  const normalizedDetail = safeDetail(detail);
  const entry = {
    name,
    at,
    sinceStoreMs: Math.round(at - store.createdAt),
    detail: normalizedDetail,
  };
  store.marks[name] = entry;
  performanceMark(name, normalizedDetail);
  recordPerfEvent(name, normalizedDetail, at);
  return entry;
}

export function markPerfOnce(
  name: PerformanceMarkName,
  detail: unknown = null,
): PerformanceEntryRecord | null {
  const store = getStore();
  if (!store || store.marks[name]) return store?.marks?.[name] || null;
  return markPerf(name, detail);
}

export function recordPerfEvent(
  name: PerformanceMarkName,
  detail: unknown = null,
  at = now(),
): PerformanceEntryRecord | null {
  const store = getStore();
  if (!store || !name) return null;
  const event = {
    name,
    at,
    sinceStoreMs: Math.round(at - store.createdAt),
    detail: safeDetail(detail),
  };
  store.events.push(event);
  if (store.events.length > MAX_EVENTS) {
    store.events.splice(0, store.events.length - MAX_EVENTS);
  }
  return event;
}

export function measurePerf(
  name: string,
  startName: PerformanceMarkName,
  endName: PerformanceMarkName,
): number | null {
  const store = getStore();
  const start = store?.marks?.[startName];
  const end = store?.marks?.[endName];
  if (!start || !end) return null;
  const durationMs = Math.max(0, Math.round(end.at - start.at));
  if (canUseWindow() && window.performance?.measure) {
    try {
      window.performance.measure(name, startName, endName);
    } catch {
      // Browser may reject repeated names or missing marks; local report still has the value.
    }
  }
  return durationMs;
}

function buildTimings(
  marks: Record<string, PerformanceEntryRecord>,
): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(TIMING_PAIRS)
      .map(([key, [startName, endName]]) => {
        const start = marks[startName];
        const end = marks[endName];
        if (!start || !end) return [key, null];
        return [key, Math.max(0, Math.round(end.at - start.at))];
      }),
  );
}

export function buildPerfReport(): PerformanceReport | null {
  const store = getStore();
  if (!store) return null;
  const marks = Object.fromEntries(
    Object.entries(store.marks).map(([name, entry]) => [
      name,
      {
        atMs: Math.round(entry.at),
        sinceStoreMs: entry.sinceStoreMs,
        detail: entry.detail,
      },
    ]),
  );
  return {
    namespace: PERF_NAMESPACE,
    createdAtMs: Math.round(store.createdAt),
    timings: buildTimings(store.marks),
    marks,
    events: store.events.map((event) => ({
      name: event.name,
      atMs: Math.round(event.at),
      sinceStoreMs: event.sinceStoreMs,
      detail: event.detail,
    })),
  };
}

getStore();
