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
  } finally {
    Object.defineProperty(globalThis, "performance", { value: originalPerformance, configurable: true });
  }
});
