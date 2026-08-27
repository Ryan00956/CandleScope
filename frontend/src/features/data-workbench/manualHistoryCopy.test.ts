import assert from "node:assert/strict";
import test from "node:test";
import { MANUAL_HISTORY_COPY, manualHistoryText } from "./manualHistoryCopy.js";

test("manual history copy keeps matching English and Chinese keys", () => {
  assert.deepEqual(
    Object.keys(MANUAL_HISTORY_COPY.en).sort(),
    Object.keys(MANUAL_HISTORY_COPY["zh-CN"]).sort(),
  );
});

test("manual history copy interpolates job state", () => {
  assert.equal(manualHistoryText("en", "jobState", { state: "RUNNING" }), "Job RUNNING");
  assert.equal(manualHistoryText("zh-CN", "succeeded"), "下载已成功");
});
