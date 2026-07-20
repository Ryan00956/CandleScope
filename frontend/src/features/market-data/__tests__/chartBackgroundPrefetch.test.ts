import assert from "node:assert/strict";
import test from "node:test";

import { shouldSkipChartBackgroundPrefetch } from "../useChartBackgroundPrefetch.js";

test("background prefetch yields to the active chart, memory cache, full cache, and inflight owner", () => {
  const base = {
    activeInterval: "45m",
    fullCacheRows: 0,
    fullCacheStatus: null,
    hasMemoryCache: false,
    inFlight: false,
    interval: "1h",
  } as const;

  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, interval: "45m" }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, hasMemoryCache: true }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, inFlight: true }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({ ...base, fullCacheStatus: "loading" }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch({
    ...base,
    fullCacheRows: 500,
    fullCacheStatus: "warm",
  }), true);
  assert.equal(shouldSkipChartBackgroundPrefetch(base), false);
});
