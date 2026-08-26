import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const drawerFiles = [
  "components/alerts/AlertsPanel.tsx",
  "features/indicators/IndicatorPanel.tsx",
  "features/chart-workspace/WorkspacePanel.tsx",
];

test("right drawers share resize handles and do not close from backdrop clicks", () => {
  for (const relativePath of drawerFiles) {
    const source = fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
    assert.match(source, /className="right-drawer-resize-handle"/);
    assert.doesNotMatch(source, /panel-overlay[^>]*onClick=\{onClose\}/);
  }
});

test("workspace Escape handling only cancels an active rename", () => {
  const source = fs.readFileSync(
    path.join(srcRoot, "features/chart-workspace/WorkspacePanel.tsx"),
    "utf8",
  );
  assert.match(source, /event\.key !== "Escape" \|\| !editingName/);
  assert.doesNotMatch(source, /event\.key !== "Escape"\) return;[\s\S]{0,260}onClose\(\)/);
});
