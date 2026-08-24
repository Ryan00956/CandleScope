import assert from "node:assert/strict";
import test from "node:test";

import {
  backtestCompareRunIdFromSearch,
  backtestRunIdFromSearch,
} from "../backtestDeepLink.js";

test("advanced research accepts only a bounded backtest Run deep link", () => {
  assert.equal(
    backtestRunIdFromSearch("?run=bt_result_12345678"),
    "bt_result_12345678",
  );
  assert.equal(backtestRunIdFromSearch("?run=study_12345678"), null);
  assert.equal(backtestRunIdFromSearch("?run=bt_x"), null);
  assert.equal(backtestRunIdFromSearch("?run=bt_bad%20id12345678"), null);
});

test("advanced research accepts an independently validated comparison Run", () => {
  assert.equal(
    backtestCompareRunIdFromSearch("?run=bt_current_12345678&compare=bt_baseline_12345678"),
    "bt_baseline_12345678",
  );
  assert.equal(backtestCompareRunIdFromSearch("?compare=study_12345678"), null);
});
