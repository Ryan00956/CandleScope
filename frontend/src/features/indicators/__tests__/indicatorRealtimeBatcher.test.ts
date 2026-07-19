import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndicatorRealtimeConfigSignature,
  createIndicatorRealtimeValueBatcher,
  type IndicatorRealtimeFrameScheduler,
  type IndicatorRealtimeValueUpdate,
} from "../indicatorRealtimeBatcher.js";

function manualScheduler() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: IndicatorRealtimeFrameScheduler = {
    request(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    get pendingCount() { return callbacks.size; },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

function update(
  barTime: number,
  value: number,
  isFinal = false,
  indicatorId = "vol",
  indicatorConfigSignature = "config-a",
): IndicatorRealtimeValueUpdate {
  return {
    barTime,
    contextKey: "binance|futures|BTCUSDT|1m",
    indicatorId,
    indicatorConfigSignature,
    isFinal,
    payload: null,
    values: { volume: value },
  };
}

test("realtime config signatures distinguish params and scripts but ignore hydrated lines", () => {
  const context = {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "1m",
  };
  const base = {
    id: "custom-1",
    script: "plot(close)",
    params: { length: 5 },
    lines: [{ data: [], outputName: "close", type: "line" as const }],
  };
  const signature = buildIndicatorRealtimeConfigSignature(base, context);
  assert.notEqual(
    signature,
    buildIndicatorRealtimeConfigSignature({ ...base, params: { length: 8 } }, context),
  );
  assert.notEqual(
    signature,
    buildIndicatorRealtimeConfigSignature({ ...base, script: "plot(open)" }, context),
  );
  assert.equal(
    signature,
    buildIndicatorRealtimeConfigSignature({
      ...base,
      lines: [{ data: [], outputName: "open", type: "line" }],
    }, context),
  );
});

test("a preview queued for an old same-id config is discarded before flush", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  let currentSignature = "config-a";
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    isUpdateCurrent: (candidate) => candidate.indicatorConfigSignature === currentSignature,
    onFlush: (updates) => batches.push(updates),
  });

  batcher.enqueue(update(100, 1, false, "vol", "config-a"));
  currentSignature = "config-b";
  frame.flush();

  assert.deepEqual(batches, []);
});

test("a queued value cannot cross a runtime context generation", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  let currentContextKey = "session-a|binance|futures|BTCUSDT|1m";
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    isUpdateCurrent: (candidate) => candidate.contextKey === currentContextKey,
    onFlush: (updates) => batches.push(updates),
  });

  batcher.enqueue({
    ...update(100, 1),
    contextKey: currentContextKey,
  });
  currentContextKey = "session-b|binance|futures|BTCUSDT|1m";
  frame.flush();

  assert.deepEqual(batches, []);
});

test("the wire source signature survives the layout-to-passive gap at flush", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  const currentSignature = "config-b";
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    isUpdateCurrent: (candidate) => candidate.indicatorConfigSignature === currentSignature,
    onFlush: (updates) => batches.push(updates),
  });

  // React has committed config B, while the old connection can still deliver
  // one config-A frame before the passive subscription effect restarts it.
  batcher.enqueue(update(100, 10, false, "vol", "config-a"));
  batcher.enqueue(update(100, 20, false, "vol", "config-b"));
  frame.flush();

  assert.deepEqual(batches[0]?.map((candidate) => [
    candidate.values.volume,
    candidate.indicatorConfigSignature,
  ]), [[20, "config-b"]]);
});

test("an old-config final cannot dominate a new-config preview at the same timestamp", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  let currentSignature = "config-a";
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    isUpdateCurrent: (candidate) => candidate.indicatorConfigSignature === currentSignature,
    onFlush: (updates) => batches.push(updates),
  });

  batcher.enqueue(update(100, 10, true, "vol", "config-a"));
  currentSignature = "config-b";
  batcher.enqueue(update(100, 20, false, "vol", "config-b"));
  frame.flush();

  assert.deepEqual(batches[0]?.map((candidate) => [
    candidate.values.volume,
    candidate.isFinal,
    candidate.indicatorConfigSignature,
  ]), [[20, false, "config-b"]]);
});

test("indicator previews are latest-only and flush once per browser frame", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    onFlush: (updates) => batches.push(updates),
  });

  batcher.enqueue(update(100, 1));
  batcher.enqueue(update(100, 2));
  batcher.enqueue(update(200, 3));
  batcher.enqueue(update(150, 4));

  assert.equal(frame.pendingCount, 1);
  assert.equal(batches.length, 0);
  frame.flush();
  assert.deepEqual(batches[0]?.map((item) => [item.barTime, item.values.volume]), [
    [200, 3],
  ]);
});

test("final values survive the next bar preview and dominate their own timestamp", () => {
  const frame = manualScheduler();
  const batches: Array<readonly IndicatorRealtimeValueUpdate[]> = [];
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    onFlush: (updates) => batches.push(updates),
  });

  batcher.enqueue(update(100, 10, false));
  batcher.enqueue(update(100, 11, true));
  batcher.enqueue(update(100, 12, false));
  batcher.enqueue(update(200, 20, false));
  frame.flush();

  assert.deepEqual(batches[0]?.map((item) => [item.barTime, item.values.volume, item.isFinal]), [
    [100, 11, true],
    [200, 20, false],
  ]);
});

test("clearing a realtime batch cancels its pending frame", () => {
  const frame = manualScheduler();
  let flushes = 0;
  const batcher = createIndicatorRealtimeValueBatcher({
    scheduler: frame.scheduler,
    onFlush: () => { flushes += 1; },
  });
  batcher.enqueue(update(100, 1));
  batcher.clear();
  frame.flush();
  assert.equal(flushes, 0);
});
