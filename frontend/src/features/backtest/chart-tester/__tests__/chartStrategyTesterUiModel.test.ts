import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_STRATEGY_TEMPLATES,
  chartStrategyEntryState,
  diagnoseChartStrategyDraft,
} from "../chartStrategyTesterUiModel.js";
import {
  createChartStrategyDraftId,
  strategyDraftContentRevision,
} from "../chartStrategyTesterDrafts.js";

test("ordinary mode exposes exactly three editable templates without internal object fields", () => {
  assert.deepEqual(CHART_STRATEGY_TEMPLATES.map((template) => template.id), [
    "SMA_CROSS",
    "RSI_REVERSAL",
    "DONCHIAN_BREAKOUT",
  ]);
  const visibleTemplateCopy = JSON.stringify(CHART_STRATEGY_TEMPLATES);
  assert.doesNotMatch(visibleTemplateCopy, /dataset_id|snapshot_hash|run_id|revision_id/i);
});

test("lightweight diagnostics locate the approved undeclared target and delimiters", () => {
  const source = [
    'strategy("SMA Cross")',
    "fast = sma(close, 3)",
    "slow = sma(close, 5)",
    "",
    "if crossover(fast, slow)",
    "  target_position(1)",
    "else if crossunder(fast, slow)",
    "  target_position(targetQty)",
  ].join("\n");
  assert.deepEqual(diagnoseChartStrategyDraft(source), [{
    code: "UNDECLARED_TARGET",
    line: 8,
    column: 19,
    endColumn: 28,
    variable: "targetQty",
  }]);
  assert.equal(diagnoseChartStrategyDraft("strategy(\"x\"")[0]?.code, "UNBALANCED_DELIMITER");
  assert.equal(diagnoseChartStrategyDraft("", { requireSource: true })[0]?.code, "EMPTY_SOURCE");
  assert.deepEqual(diagnoseChartStrategyDraft(""), []);
});

test("lightweight diagnostics ignore strategy-like text and delimiters in strings or comments", () => {
  const source = [
    'strategy("Literal ) target_position(missing)")',
    'note = "escaped \\" bracket ]"',
    "# target_position(commentOnly)",
    "// target_position(otherComment)",
    'details = """multiline ( target_position(hidden)"""',
    "target = 1",
    "target_position(target)",
  ].join("\n");
  assert.deepEqual(diagnoseChartStrategyDraft(source), []);
});

test("entry status and draft ids stay user-facing and bounded", () => {
  assert.equal(chartStrategyEntryState(null, "error"), "unattached");
  assert.equal(chartStrategyEntryState({} as never, "idle"), "editing");
  assert.equal(chartStrategyEntryState({} as never, "saving"), "saving");
  assert.equal(createChartStrategyDraftId("abc"), "draft-abc00000");
  assert.match(createChartStrategyDraftId("unsafe value!"), /^draft-[A-Za-z0-9_-]{8,152}$/);
  assert.equal(strategyDraftContentRevision("same source"), strategyDraftContentRevision("same source"));
  assert.notEqual(strategyDraftContentRevision("same source"), strategyDraftContentRevision("changed source"));
});
