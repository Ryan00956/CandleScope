export async function collectBrowserRuntimePressure({ estimatedBytes = 0 } = {}) {
  const heap = await browserHeapPressure(estimatedBytes);
  const storage = await browserStoragePressure();
  return {
    browserHeap: heap,
    browserStorage: storage,
  };
}

async function browserHeapPressure(estimatedBytes) {
  try {
    const perf = globalThis.performance;
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
  const memory = globalThis.performance?.memory;
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

async function browserStoragePressure() {
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
      error: err?.message || String(err),
    };
  }
  return {
    available: false,
    source: "unavailable",
  };
}

function fallbackHeap(estimatedBytes, source, err = null) {
  return {
    available: false,
    source,
    estimatedBytes: Number(estimatedBytes || 0),
    error: err?.message || undefined,
  };
}
