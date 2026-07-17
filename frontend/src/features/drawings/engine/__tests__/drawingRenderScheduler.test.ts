import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingRenderScheduler,
  drawingRenderRevisionKey,
  type DrawingRenderRevisionStamp,
} from "../drawingRenderScheduler.js";

function stamp(documentRevision: number): DrawingRenderRevisionStamp {
  return Object.freeze({
    scopeKey: "scope",
    documentRevision,
    surfaceGeneration: 1,
    dataRevision: 1,
    projectionRevision: 1,
    lineageIndexRevision: 1,
    viewportRevision: 1,
    themeRevision: 1,
    widthCssPx: 800,
    heightCssPx: 400,
    dpr: 1,
  });
}

test("revision keys include every render-plan invalidation boundary", () => {
  const base = stamp(1);
  const keys = Object.keys(base) as Array<keyof DrawingRenderRevisionStamp>;
  for (const key of keys) {
    const value = base[key];
    const changed = {
      ...base,
      [key]: typeof value === "string" ? `${value}-next` : Number(value) + 1,
    } as DrawingRenderRevisionStamp;
    assert.notEqual(drawingRenderRevisionKey(base), drawingRenderRevisionKey(changed), key);
  }
});

test("multiple invalidations coalesce into one frame and one immutable reason batch", () => {
  let input = { stamp: stamp(1) };
  const frames: Array<() => void> = [];
  const published: Array<{ revision: number; reasons: readonly string[] }> = [];
  const scheduler = createDrawingRenderScheduler({
    readInput: () => input,
    buildPlan: (value) => ({ stamp: value.stamp }),
    publish: (plan, reasons) => published.push({
      revision: plan.stamp.documentRevision,
      reasons,
    }),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
  });
  assert.equal(scheduler.invalidate("document"), true);
  assert.equal(scheduler.invalidate("viewport"), true);
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(published, [{ revision: 1, reasons: ["document", "viewport"] }]);
  assert.equal(Object.isFrozen(published[0]?.reasons), true);
  input = { stamp: stamp(2) };
  assert.equal(scheduler.invalidate("document"), true);
  assert.equal(frames.length, 1);
});

test("shadow debounce restarts pending work and ignores a cancelled stale callback", () => {
  const frames: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const published: string[][] = [];
  const scheduler = createDrawingRenderScheduler({
    readInput: () => ({ stamp: stamp(1) }),
    buildPlan: (value) => ({ stamp: value.stamp }),
    publish: (_plan, reasons) => published.push([...reasons]),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: (handle) => { cancelled.push(handle); },
    restartPendingFrameOnInvalidate: true,
  });

  scheduler.invalidate("document");
  scheduler.invalidate("viewport");
  assert.equal(frames.length, 2);
  assert.equal(cancelled.length, 1);
  frames[0]?.();
  assert.deepEqual(published, []);
  frames[1]?.();
  assert.deepEqual(published, [["document", "viewport"]]);
  scheduler.dispose();
});

test("a plan is discarded and the latest input is rescheduled when build becomes stale", () => {
  let input = { stamp: stamp(1) };
  const frames: Array<() => void> = [];
  const discarded: number[] = [];
  const published: number[] = [];
  const scheduler = createDrawingRenderScheduler({
    readInput: () => input,
    buildPlan: (value) => {
      if (value.stamp.documentRevision === 1) input = { stamp: stamp(2) };
      return { stamp: value.stamp };
    },
    publish: (plan) => published.push(plan.stamp.documentRevision),
    onDiscard: (plan) => discarded.push(plan.stamp.documentRevision),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
  });
  scheduler.invalidate("document");
  frames.shift()?.();
  assert.deepEqual(discarded, [1]);
  assert.deepEqual(published, []);
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(published, [2]);
});

test("an invalidation raised during build discards the plan even when revisions are unchanged", () => {
  const frames: Array<() => void> = [];
  const discarded: string[] = [];
  const published: string[][] = [];
  let first = true;
  const scheduler = createDrawingRenderScheduler({
    readInput: () => ({ stamp: stamp(1) }),
    buildPlan: (value) => {
      if (first) {
        first = false;
        scheduler.invalidate("hidden-state");
      }
      return { stamp: value.stamp };
    },
    publish: (_plan, reasons) => published.push([...reasons]),
    onDiscard: (_plan, reason) => discarded.push(reason),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
  });
  scheduler.invalidate("document");
  frames.shift()?.();
  assert.deepEqual(discarded, ["stale"]);
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(published, [["hidden-state", "stale-retry"]]);
});

test("an invalidation raised during an atomic null build schedules its follow-up", () => {
  const frames: Array<() => void> = [];
  const published: string[][] = [];
  let first = true;
  const scheduler = createDrawingRenderScheduler({
    readInput: () => ({ stamp: stamp(1) }),
    buildPlan: (value) => {
      if (!first) return { stamp: value.stamp };
      first = false;
      scheduler.invalidate("projection-session-stale");
      return null;
    },
    publish: (_plan, reasons) => published.push([...reasons]),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
  });

  scheduler.invalidate("document");
  frames.shift()?.();
  assert.deepEqual(published, []);
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(published, [["projection-session-stale", "follow-up"]]);
});

test("build failures stay fail-closed, retain reasons, and retry on the next invalidation", () => {
  const frames: Array<() => void> = [];
  const errors: unknown[] = [];
  const published: string[][] = [];
  let fail = true;
  const scheduler = createDrawingRenderScheduler({
    readInput: () => ({ stamp: stamp(1) }),
    buildPlan: (value) => {
      if (fail) throw new Error("projection failed");
      return { stamp: value.stamp };
    },
    publish: (_plan, reasons) => published.push([...reasons]),
    onError: (error) => errors.push(error),
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: () => {},
  });
  scheduler.invalidate("document");
  assert.doesNotThrow(() => frames.shift()?.());
  assert.equal(errors.length, 1);
  assert.deepEqual(published, []);
  fail = false;
  scheduler.invalidate("retry");
  frames.shift()?.();
  assert.deepEqual(published, [["document", "retry"]]);
});

test("dispose cancels pending work and permanently rejects new invalidation", () => {
  const frames: Array<() => void> = [];
  const cancelled: unknown[] = [];
  let published = 0;
  const scheduler = createDrawingRenderScheduler({
    readInput: () => ({ stamp: stamp(1) }),
    buildPlan: (value) => ({ stamp: value.stamp }),
    publish: () => { published += 1; },
    requestFrame: (callback) => { frames.push(callback); return callback; },
    cancelFrame: (handle) => { cancelled.push(handle); },
  });
  scheduler.invalidate("document");
  scheduler.dispose();
  assert.equal(scheduler.disposed, true);
  assert.equal(cancelled.length, 1);
  frames.shift()?.();
  assert.equal(published, 0);
  assert.equal(scheduler.invalidate("late"), false);
  assert.equal(scheduler.flushNow(), false);
});
