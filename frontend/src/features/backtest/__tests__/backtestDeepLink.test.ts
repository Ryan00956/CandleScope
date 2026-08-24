import assert from "node:assert/strict";
import test from "node:test";

import { backtestRunIdFromSearch } from "../backtestDeepLink.js";

test("advanced research accepts only a bounded backtest Run deep link", () => {
  assert.equal(
    backtestRunIdFromSearch("?run=bt_result_12345678"),
    "bt_result_12345678",
  );
  assert.equal(backtestRunIdFromSearch("?run=study_12345678"), null);
  assert.equal(backtestRunIdFromSearch("?run=bt_x"), null);
  assert.equal(backtestRunIdFromSearch("?run=bt_bad%20id12345678"), null);
});
