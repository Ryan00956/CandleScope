import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaneHeightPlan,
  movePaneInOrder,
  reconcilePaneOrder,
} from "../paneControlModel.js";

test("pane order retains user ordering, removes stale panes, and appends new panes", () => {
  assert.deepEqual(
    reconcilePaneOrder(["macd", "rsi", "stale"], ["rsi", "macd", "vol"]),
    ["macd", "rsi", "vol"],
  );
  assert.deepEqual(reconcilePaneOrder([], ["rsi", "macd"]), ["rsi", "macd"]);
});

test("pane movement swaps only the requested adjacent pane, including main", () => {
  assert.deepEqual(movePaneInOrder(["main", "rsi", "vol"], "rsi", "up"), ["rsi", "main", "vol"]);
  assert.deepEqual(movePaneInOrder(["main", "rsi", "vol"], "rsi", "down"), ["main", "vol", "rsi"]);
  assert.deepEqual(movePaneInOrder(["rsi", "main"], "main", "up"), ["main", "rsi"]);
  assert.deepEqual(movePaneInOrder(["main", "rsi"], "main", "up"), ["main", "rsi"]);
});

test("collapsed pane height plan keeps expanded ratios and the current total height", () => {
  const plan = buildPaneHeightPlan({
    paneIds: ["main", "rsi", "macd"],
    currentHeights: [360, 120, 120],
    expandedHeights: new Map([["main", 360], ["rsi", 120], ["macd", 120]]),
    collapsedPaneIds: ["rsi"],
  });
  assert.ok(plan);
  assert.equal(Math.round(plan.reduce((sum, height) => sum + height, 0)), 600);
  assert.equal(plan[1], 36);
  assert.ok((plan[0] ?? 0) > (plan[2] ?? 0));
});

test("maximized pane receives the available height and leaves usable control strips", () => {
  assert.deepEqual(buildPaneHeightPlan({
    paneIds: ["main", "rsi", "macd"],
    currentHeights: [360, 120, 120],
    maximizedPaneId: "rsi",
  }), [36, 528, 36]);
});

test("stale all-collapsed state fails safe by keeping the reordered main pane expanded", () => {
  const plan = buildPaneHeightPlan({
    paneIds: ["rsi", "main"],
    currentHeights: [200, 400],
    collapsedPaneIds: ["main", "rsi"],
  });
  assert.ok(plan);
  assert.equal(plan[0], 36);
  assert.ok((plan[1] ?? 0) > 36);
});
