import type {
  BrowserHeapPressure,
  BrowserRuntimePressure,
  BrowserStoragePressure,
} from "./cacheGcTypes.js";

interface ExtendedPerformance extends Performance {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes?: unknown }>;
  memory?: {
    usedJSHeapSize?: unknown;
    totalJSHeapSize?: unknown;
    jsHeapSizeLimit?: unknown;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectBrowserRuntimePressure({
  estimatedBytes = 0,
}: { estimatedBytes?: number } = {}): Promise<BrowserRuntimePressure> {
  const heap = await browserHeapPressure(estimatedBytes);
  const storage = await browserStoragePressure();
  return {
    browserHeap: heap,
    browserStorage: storage,
  };
}

async function browserHeapPressure(estimatedBytes: number): Promise<BrowserHeapPressure> {
  try {
    const perf = globalThis.performance as ExtendedPerformance;
    if (perf?.measureUserAgentSpecificMemory) {
      const result = await perf.measureUserAgentSpecificMemory();
      return {
        available: true,
        source: "measureUserAgentSpecificMemory",
        usedJSHeapSize: Number(result?.bytes || 0),
        estimatedBytes,
      };
    }
  } catch (err) {
    return fallbackHeap(estimatedBytes, "measureUserAgentSpecificMemory-error", err);
  }
  const memory = (globalThis.performance as ExtendedPerformance | undefined)?.memory;
  if (memory) {
    return {
      available: true,
      source: "performance.memory",
      usedJSHeapSize: Number(memory.usedJSHeapSize || 0),
      totalJSHeapSize: Number(memory.totalJSHeapSize || 0),
      jsHeapSizeLimit: Number(memory.jsHeapSizeLimit || 0),
      estimatedBytes,
    };
  }
  return fallbackHeap(estimatedBytes, "estimated-cache-bytes");
}

async function browserStoragePressure(): Promise<BrowserStoragePressure> {
  try {
    const nav = globalThis.navigator;
    if (nav?.storage?.estimate) {
      const estimate = await nav.storage.estimate();
      const quota = Number(estimate?.quota || 0);
      const usage = Number(estimate?.usage || 0);
      return {
        available: true,
        source: "navigator.storage.estimate",
        usageBytes: usage,
        quotaBytes: quota,
        usageRatio: quota > 0 ? usage / quota : 0,
      };
    }
  } catch (err) {
    return {
      available: false,
      source: "navigator.storage.estimate-error",
      error: errorMessage(err),
    };
  }
  return {
    available: false,
    source: "unavailable",
  };
}

function fallbackHeap(
  estimatedBytes: number,
  source: string,
  error: unknown = null,
): BrowserHeapPressure {
  return {
    available: false,
    source,
    estimatedBytes: Number(estimatedBytes || 0),
    error: error == null ? undefined : errorMessage(error),
  };
}
