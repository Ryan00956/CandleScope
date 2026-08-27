import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canStartDownload,
  createEmptyManualHistoryForm,
  formHasEndTime,
  isGreenCompleteState,
  isPlanFirstReady,
  parentStateTone,
  parseSymbolList,
  toggleInterval,
} from "./manualHistoryForm.js";

test("workbench modal mounts download panel with plan-first multi-select and cancel", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const modal = fs.readFileSync(path.join(dir, "DataWorkbenchModal.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(dir, "ManualHistoryDownloadPanel.tsx"), "utf8");
  assert.match(modal, /ManualHistoryDownloadPanel/);
  assert.doesNotMatch(panel, /\bend_ms\b|\bendMs\b/);
  assert.match(panel, /data-testid="manual-history-symbols"/);
  assert.match(panel, /data-testid="manual-history-intervals"/);
  assert.match(panel, /data-testid="manual-history-plan"/);
  assert.match(panel, /data-testid="manual-history-start-download"/);
  assert.match(panel, /data-testid="manual-history-cancel"/);
  assert.match(panel, /getManualHistoryJob/);
  assert.match(panel, /disabled=\{!startEnabled\}/);
});

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

test("symbol list parser accepts comma-separated multi-select", () => {
  assert.deepEqual(parseSymbolList("btcusdt, ETHUSDT  solusdt"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
});

test("interval toggle is additive multi-select", () => {
  assert.deepEqual(toggleInterval(["1m"], "1h"), ["1m", "1h"]);
  assert.deepEqual(toggleInterval(["1m", "1h"], "1m"), ["1h"]);
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
