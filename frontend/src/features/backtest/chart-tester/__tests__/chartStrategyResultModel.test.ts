import assert from "node:assert/strict";
import test from "node:test";

import {
  chartStrategyResultIncludedInExportScope,
  chartStrategyTradeFocusTimeMs,
  chartStrategyVirtualTradeWindow,
} from "../chartStrategyResultModel.js";

test("100k trade virtualization keeps the rendered window bounded", () => {
  const first = chartStrategyVirtualTradeWindow({
    count: 100_000,
    scrollTop: 0,
    viewportHeight: 304,
  });
  const middle = chartStrategyVirtualTradeWindow({
    count: 100_000,
    scrollTop: 1_900_000,
    viewportHeight: 304,
  });
  assert.equal(first.totalHeight, 3_800_000);
  assert.ok(first.end - first.start <= 20);
  assert.ok(middle.end - middle.start <= 20);
  assert.ok(middle.start > 49_000);
});

test("trade focus uses entry time and screenshot export includes results only for page scope", () => {
  assert.equal(chartStrategyTradeFocusTimeMs({ entry_time_ms: "1700000000123" }), 1_700_000_000_123);
  assert.equal(chartStrategyTradeFocusTimeMs({ entry_time_ms: "invalid" }), null);
  assert.equal(chartStrategyResultIncludedInExportScope("chart"), false);
  assert.equal(chartStrategyResultIncludedInExportScope("main-pane"), false);
  assert.equal(chartStrategyResultIncludedInExportScope("page"), true);
});
