import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaceBootstrap } from "./multi-chart-capacity.mjs";
import { evaluateFlagRollback } from "./multi-chart-flag-rollback.mjs";

test("flag rollback requires a four-cell projection while preserving all sixteen v6 cells", () => {
  const inputRecord = buildWorkspaceBootstrap({ cells: 16, scenario: "S1", now: 1 }).record;
  const result = evaluateFlagRollback({
    inputRecord,
    v1Record: structuredClone(inputRecord),
    v6Record: structuredClone(inputRecord),
    browser: {
      visibleCellIds: ["cell-1", "cell-2", "cell-3", "cell-4"],
      layoutOptions: ["单图", "左右双图", "上下双图", "主图与确认图", "四图"],
      errors: [],
    },
  });
  assert.equal(result.result, "pass");
});

test("flag rollback fails closed when persisted v6 layout is truncated", () => {
  const inputRecord = buildWorkspaceBootstrap({ cells: 16, scenario: "S1", now: 1 }).record;
  const v6Record = structuredClone(inputRecord);
  delete v6Record.document.cells["cell-16"];
  const result = evaluateFlagRollback({
    inputRecord,
    v1Record: structuredClone(inputRecord),
    v6Record,
    browser: {
      visibleCellIds: ["cell-1", "cell-2", "cell-3", "cell-4"],
      layoutOptions: ["单图", "四图"],
      errors: [],
    },
  });
  assert.equal(result.result, "fail");
  assert.equal(result.checks.v6DocumentPreserved.passed, false);
});
