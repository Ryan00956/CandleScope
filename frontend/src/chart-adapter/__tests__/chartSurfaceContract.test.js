import assert from "node:assert/strict";
import test from "node:test";

import { callChartSurface } from "../chartSurfaceContract.js";

test("callChartSurface invokes a surface method with its receiver and arguments", () => {
  const surface = {
    prefix: "chart",
    describe(suffix) {
      return `${this.prefix}-${suffix}`;
    },
  };

  assert.equal(callChartSurface({ current: surface }, "describe", null, "ready"), "chart-ready");
});

test("callChartSurface returns the fallback when the surface or method is unavailable", () => {
  const fallback = { status: "unavailable" };

  assert.strictEqual(callChartSurface(null, "getVisibleRange", fallback), fallback);
  assert.strictEqual(callChartSurface({ current: null }, "getVisibleRange", fallback), fallback);
  assert.strictEqual(callChartSurface({ current: {} }, "getVisibleRange", fallback), fallback);
});

test("callChartSurface contains errors thrown while resolving or invoking a surface method", () => {
  const fallback = { status: "unstable" };
  const throwingRef = Object.defineProperty({}, "current", {
    get() {
      throw new Error("unmounted");
    },
  });
  const throwingSurface = {
    getVisibleRange() {
      throw new Error("Value is null");
    },
  };

  assert.strictEqual(callChartSurface(throwingRef, "getVisibleRange", fallback), fallback);
  assert.strictEqual(
    callChartSurface({ current: throwingSurface }, "getVisibleRange", fallback),
    fallback,
  );
});
