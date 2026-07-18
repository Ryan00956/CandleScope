import assert from "node:assert/strict";
import test from "node:test";

import { collectBrowserRuntimePressure } from "../browserPressure.js";

test("browser pressure falls back to estimated cache bytes", async () => {
  const originalNavigator = globalThis.navigator;
  const originalPerformance = globalThis.performance;
  try {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "performance", { value: {}, configurable: true });

    const pressure = await collectBrowserRuntimePressure({ estimatedBytes: 1234 });

    assert.equal(pressure.browserHeap.available, false);
    assert.equal(pressure.browserHeap.estimatedBytes, 1234);
    assert.equal(pressure.browserStorage.available, false);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});

test("browser pressure uses performance.memory when present", async () => {
  const originalPerformance = globalThis.performance;
  try {
    Object.defineProperty(globalThis, "performance", {
      value: {
        memory: {
          usedJSHeapSize: 10,
          totalJSHeapSize: 20,
          jsHeapSizeLimit: 100,
        },
      },
      configurable: true,
    });

    const pressure = await collectBrowserRuntimePressure();

    assert.equal(pressure.browserHeap.available, true);
    assert.equal(pressure.browserHeap.source, "performance.memory");
    assert.equal(pressure.browserHeap.usedJSHeapSize, 10);
    assert.equal(pressure.browserHeap.usageRatio, 0.1);
    assert.equal(pressure.browserHeap.headroomBytes, 90);
  } finally {
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});

test("browser pressure falls through to performance.memory when the primary probe rejects", async () => {
  const originalPerformance = globalThis.performance;
  try {
    Object.defineProperty(globalThis, "performance", {
      value: {
        measureUserAgentSpecificMemory: async () => {
          throw new Error("permission denied");
        },
        memory: {
          usedJSHeapSize: 50,
          totalJSHeapSize: 75,
          jsHeapSizeLimit: 100,
        },
      },
      configurable: true,
    });

    const pressure = await collectBrowserRuntimePressure();

    assert.equal(pressure.browserHeap.available, true);
    assert.equal(pressure.browserHeap.source, "performance.memory");
    assert.equal(pressure.browserHeap.usageRatio, 0.5);
    assert.equal(pressure.browserHeap.headroomBytes, 50);
    assert.equal(
      pressure.browserHeap.fallbackFrom,
      "measureUserAgentSpecificMemory-error",
    );
    assert.equal(
      pressure.browserHeap.measureUserAgentSpecificMemoryError,
      "permission denied",
    );
  } finally {
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});

test("browser pressure does not invent a heap ratio when the successful probe has no limit", async () => {
  const originalPerformance = globalThis.performance;
  try {
    Object.defineProperty(globalThis, "performance", {
      value: {
        measureUserAgentSpecificMemory: async () => ({ bytes: 90 }),
        memory: {
          usedJSHeapSize: 10,
          totalJSHeapSize: 20,
          jsHeapSizeLimit: 100,
        },
      },
      configurable: true,
    });

    const pressure = await collectBrowserRuntimePressure();

    assert.equal(pressure.browserHeap.available, true);
    assert.equal(pressure.browserHeap.source, "measureUserAgentSpecificMemory");
    assert.equal(pressure.browserHeap.usedJSHeapSize, 90);
    assert.equal("jsHeapSizeLimit" in pressure.browserHeap, false);
    assert.equal("usageRatio" in pressure.browserHeap, false);
    assert.equal("headroomBytes" in pressure.browserHeap, false);
  } finally {
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});

test("performance.memory without a heap limit omits ratio and headroom", async () => {
  const originalPerformance = globalThis.performance;
  try {
    Object.defineProperty(globalThis, "performance", {
      value: {
        memory: {
          usedJSHeapSize: 10,
          totalJSHeapSize: 20,
        },
      },
      configurable: true,
    });

    const pressure = await collectBrowserRuntimePressure();

    assert.equal(pressure.browserHeap.source, "performance.memory");
    assert.equal(pressure.browserHeap.jsHeapSizeLimit, 0);
    assert.equal("usageRatio" in pressure.browserHeap, false);
    assert.equal("headroomBytes" in pressure.browserHeap, false);
  } finally {
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});
