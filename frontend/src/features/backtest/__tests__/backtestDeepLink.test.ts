import assert from "node:assert/strict";
import test from "node:test";

import {
  backtestCompareRunIdFromSearch,
  backtestRunIdFromSearch,
  parseBacktestResearchEntry,
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

test("research entry accepts exactly one opaque authoritative object id", () => {
  assert.deepEqual(parseBacktestResearchEntry(""), { kind: "home" });
  assert.deepEqual(
    parseBacktestResearchEntry("?context=brc_context_12345678"),
    { kind: "context", contextId: "brc_context_12345678" },
  );
  assert.deepEqual(
    parseBacktestResearchEntry("?run=bt_result_12345678&compare=bt_old_12345678"),
    { kind: "run", runId: "bt_result_12345678" },
  );
  assert.deepEqual(
    parseBacktestResearchEntry("?study=st_study_12345678"),
    { kind: "study", studyId: "st_study_12345678" },
  );
  assert.equal(
    parseBacktestResearchEntry("?run=bt_result_12345678&study=st_study_12345678").kind,
    "invalid",
  );
  assert.equal(parseBacktestResearchEntry("?context=brc_bad%20id").kind, "invalid");
});
