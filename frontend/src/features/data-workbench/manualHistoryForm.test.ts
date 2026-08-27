import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isGreenCompleteState,
  isPlanFirstReady,
  parentStateTone,
} from "./manualHistoryForm.js";

test("public form model has no end time field", () => {
  const form = createEmptyManualHistoryForm();
  assert.equal(formHasEndTime(form), false);
  assert.equal("endMs" in form, false);
  assert.equal("end_ms" in form, false);
});

test("start is plan-first and requires symbols, intervals, and startMs", () => {
  const form = createEmptyManualHistoryForm();
  assert.equal(isPlanFirstReady(form), false);
  form.symbols = ["BTCUSDT"];
  form.intervals = ["1m"];
  form.startMs = 1_700_000_000_000;
  assert.equal(isPlanFirstReady(form), true);
  assert.equal(canStartDownload(null), false);
  assert.equal(canStartDownload({ can_start: false }), false);
  assert.equal(canStartDownload({ can_start: true }), true);
});

test("PARTIAL FAILED and BLOCKED are not rendered as green complete", () => {
  assert.equal(isGreenCompleteState("SUCCEEDED"), true);
  assert.equal(isGreenCompleteState("PARTIAL"), false);
  assert.equal(isGreenCompleteState("FAILED"), false);
  assert.equal(isGreenCompleteState("BLOCKED_STORAGE"), false);
  assert.equal(parentStateTone("PARTIAL"), "warning");
  assert.equal(parentStateTone("FAILED"), "danger");
  assert.equal(parentStateTone("BLOCKED_STORAGE"), "warning");
  assert.equal(parentStateTone("SUCCEEDED"), "success");
});
