import assert from "node:assert/strict";
import test from "node:test";

import { StrategyResearchRunEffectGuard } from "../strategyResearchRunLifecycle.js";

test("StrictMode rehearsal keeps the tester live and real unmount disposes it", () => {
  const queued: Array<() => void> = [];
  const guard = new StrategyResearchRunEffectGuard((callback) => queued.push(callback));
  let disposals = 0;
  const runtime = { dispose: () => { disposals += 1; } };

  const rehearsalCleanup = guard.mount(runtime);
  rehearsalCleanup();
  const mountedCleanup = guard.mount(runtime);
  queued.shift()?.();
  assert.equal(disposals, 0);

  mountedCleanup();
  mountedCleanup();
  queued.shift()?.();
  assert.equal(disposals, 1);
});

test("default scheduler disposes on the next microtask", async () => {
  const guard = new StrategyResearchRunEffectGuard();
  let disposed = false;
  guard.mount({ dispose: () => { disposed = true; } })();
  assert.equal(disposed, false);
  await new Promise<void>((resolve) => { globalThis.queueMicrotask(resolve); });
  assert.equal(disposed, true);
});
