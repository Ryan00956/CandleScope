import assert from "node:assert/strict";
import test from "node:test";

import { AppWorkBudgetHub } from "./app-work-budget-hub.mjs";

test("app work leases enforce global and per-window bounds with window fairness", async () => {
  const hub = new AppWorkBudgetHub({ maxConcurrent: 2, maxPerWindow: 1 });
  const first = await hub.acquire({ windowId: "w1", cellId: "c1", lane: "initial-history" });
  let secondW1 = false;
  const queuedW1 = hub.acquire({ windowId: "w1", cellId: "c2", lane: "initial-history" })
    .then((lease) => { secondW1 = true; return lease; });
  const firstW2 = await hub.acquire({ windowId: "w2", cellId: "c3", lane: "initial-history" });
  assert.equal(secondW1, false);
  assert.deepEqual(hub.diagnostics().activeByWindow, { w1: 1, w2: 1 });
  hub.release(first.leaseId);
  const second = await queuedW1;
  assert.equal(second.windowId, "w1");
  hub.release(firstW2.leaseId);
  hub.release(second.leaseId);
  assert.equal(hub.diagnostics().active, 0);
});

test("preview lanes reject a fifth pin and require an explicit release", () => {
  const hub = new AppWorkBudgetHub({ maxPreviewLanes: 4 });
  for (let index = 1; index <= 4; index += 1) {
    assert.equal(hub.requestPreview({ windowId: `w${index}`, cellId: `c${index}`, pinned: true }).ok, true);
  }
  const rejected = hub.requestPreview({ windowId: "w1", cellId: "c5", pinned: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "PREVIEW_LANE_LIMIT");
  assert.equal(hub.releasePreview({ windowId: "w2", cellId: "c2" }), true);
  assert.equal(hub.requestPreview({ windowId: "w1", cellId: "c5", pinned: true }).ok, true);
});

test("window crash reclaims async and preview leases without touching peers", async () => {
  const hub = new AppWorkBudgetHub({ maxConcurrent: 4, maxPerWindow: 2 });
  const w1 = await hub.acquire({ windowId: "w1", cellId: "c1", lane: "load-more" });
  const w2 = await hub.acquire({ windowId: "w2", cellId: "c2", lane: "load-more" });
  hub.requestPreview({ windowId: "w1", cellId: "c1", pinned: true });
  hub.requestPreview({ windowId: "w2", cellId: "c2", pinned: true });
  hub.releaseWindow("w1");
  const diagnostics = hub.diagnostics();
  assert.equal(diagnostics.active, 1);
  assert.deepEqual(diagnostics.previewLanes.map((lane) => lane.windowId), ["w2"]);
  assert.equal(hub.release(w1.leaseId), false);
  assert.equal(hub.release(w2.leaseId), true);
});
