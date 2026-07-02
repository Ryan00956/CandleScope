import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_SERIES_BARS,
  assertWindowBudget,
  isWindowBudgetAssertEnabled,
} from "../windowBudgetAssert.js";

test("window budget assertion stays disabled unless explicitly enabled", () => {
  assert.equal(isWindowBudgetAssertEnabled({ env: { DEV: true } }), false);
  assert.equal(
    isWindowBudgetAssertEnabled({
      env: { DEV: true, VITE_CANDLESCOPE_WINDOW_BUDGET_ASSERT: "1" },
    }),
    true,
  );
});

test("window budget assertion records ok and error reports when enabled", () => {
  const globalRef = {};
  const errors = [];
  const fakeConsole = { error: (...args) => errors.push(args) };

  const ok = assertWindowBudget(
    { seriesKey: "binance-spot-BTCUSDT-1m", bars: DEFAULT_MAX_SERIES_BARS },
    { enabled: true, globalRef, console: fakeConsole },
  );
  const over = assertWindowBudget(
    { seriesKey: "binance-spot-BTCUSDT-1m", bars: DEFAULT_MAX_SERIES_BARS + 5 },
    { enabled: true, globalRef, console: fakeConsole },
  );

  assert.equal(ok.level, "ok");
  assert.equal(over.level, "error");
  assert.equal(over.overBy, 5);
  assert.equal(errors.length, 1);
  assert.equal(globalRef.__CANDLESCOPE_WINDOW_BUDGET_REPORTS__.length, 2);
});
