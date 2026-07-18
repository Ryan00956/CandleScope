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

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
  let memoryProbeError: unknown = null;
  try {
    const perf = globalThis.performance as ExtendedPerformance;
    if (perf?.measureUserAgentSpecificMemory) {
      const result = await perf.measureUserAgentSpecificMemory();
      return {
        available: true,
        source: "measureUserAgentSpecificMemory",
        usedJSHeapSize: finiteNonNegative(result?.bytes),
        estimatedBytes: finiteNonNegative(estimatedBytes),
      };
    }
  } catch (err) {
    memoryProbeError = err;
  }
  const memory = (globalThis.performance as ExtendedPerformance | undefined)?.memory;
  if (memory) {
    const used = finiteNonNegative(memory.usedJSHeapSize);
    const total = finiteNonNegative(memory.totalJSHeapSize);
    const limit = finiteNonNegative(memory.jsHeapSizeLimit);
    return {
      available: true,
      source: "performance.memory",
      usedJSHeapSize: used,
      totalJSHeapSize: total,
      jsHeapSizeLimit: limit,
      ...(limit > 0
        ? {
            usageRatio: Math.max(0, used / limit),
            headroomBytes: Math.max(0, limit - used),
          }
        : {}),
      estimatedBytes: finiteNonNegative(estimatedBytes),
      ...(memoryProbeError == null
        ? {}
        : {
            fallbackFrom: "measureUserAgentSpecificMemory-error",
            measureUserAgentSpecificMemoryError: errorMessage(memoryProbeError),
          }),
    };
  }
  if (memoryProbeError != null) {
    return fallbackHeap(
      estimatedBytes,
      "measureUserAgentSpecificMemory-error",
      memoryProbeError,
    );
  }
  return fallbackHeap(estimatedBytes, "estimated-cache-bytes");
}

async function browserStoragePressure(): Promise<BrowserStoragePressure> {
  try {
    const nav = globalThis.navigator;
    if (nav?.storage?.estimate) {
      const estimate = await nav.storage.estimate();
      const quota = finiteNonNegative(estimate?.quota);
      const usage = finiteNonNegative(estimate?.usage);
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
    estimatedBytes: finiteNonNegative(estimatedBytes),
    ...(error == null ? {} : { error: errorMessage(error) }),
  };
}
