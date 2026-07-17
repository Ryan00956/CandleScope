import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingExportLease } from "../../drawingInteractionController.js";
import {
  beginDrawingExportLifecycle,
  readDrawingExportLifecycle,
  recordDrawingExportCaptureSourceFixed,
  recordDrawingExportImageEncoded,
  recordDrawingExportLeaseRestored,
  recordDrawingExportPostCaptureRevalidate,
  recordDrawingExportPreviewPublished,
  resetDrawingExportLifecycle,
} from "../drawingExportLifecycle.js";
import { resetDrawingPerfCounters } from "../../performance/drawingPerfCounters.js";

function exactLease(leaseId = 7): Readonly<{
  lease: DrawingExportLease;
  bboxes: Float32Array;
}> {
  const bboxes = new Float32Array([10, 20, 30, 40]);
  const lease = Object.freeze({
    leaseId,
    receipt: Object.freeze({
      leaseId,
      scopeKey: "binance:spot:BTCUSDT__main",
      documentRevision: 5,
      persistence: Object.freeze({ persistedRevision: 5, writePerformed: false }),
      scene: Object.freeze({
        plan: Object.freeze({
          entities: Object.freeze([Object.freeze({
            id: "freehand-1",
            kind: "freehand",
            renderSpec: Object.freeze({ lineWidthCssPx: 3 }),
          })]),
          bboxes,
        }),
        stamp: Object.freeze({
          scopeKey: "binance:spot:BTCUSDT__main",
          documentRevision: 5,
          surfaceGeneration: 3,
          viewportRevision: 11,
        }),
        sceneEpoch: 19,
        lodToleranceClass: "settledExact",
        attachmentRevision: 23,
        paintSequence: 29,
      }),
      paint: 31,
    }),
    revalidate: async () => true,
    restore: async () => {},
  }) as unknown as DrawingExportLease;
  return Object.freeze({ lease, bboxes });
}

function hiddenLease(leaseId: number): DrawingExportLease {
  return Object.freeze({
    leaseId,
    receipt: Object.freeze({
      leaseId,
      scopeKey: "binance:spot:BTCUSDT__main",
      documentRevision: 5,
      persistence: Object.freeze({ persistedRevision: 5, writePerformed: true }),
      scene: Object.freeze({
        kind: "hidden-frame",
        scopeKey: "binance:spot:BTCUSDT__main",
        documentRevision: 5,
        document: Object.freeze({}),
        sceneEpoch: 20,
        attachmentRevision: 24,
        paintSequence: 30,
      }),
      paint: 32,
    }),
    revalidate: async () => true,
    restore: async () => {},
  }) as unknown as DrawingExportLease;
}

test.afterEach(() => resetDrawingExportLifecycle());

test("records a bounded product-owned export transaction in real lifecycle order", () => {
  const fixture = exactLease();
  const transaction = beginDrawingExportLifecycle(fixture.lease, false);
  fixture.bboxes.fill(999);

  recordDrawingExportCaptureSourceFixed(transaction);
  recordDrawingExportPostCaptureRevalidate(transaction, true);
  recordDrawingExportLeaseRestored(transaction);
  recordDrawingExportImageEncoded(transaction, {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    width: 100,
    height: 80,
    mimeType: "image/png",
    optionsKey: "chart:png:1",
  });
  recordDrawingExportPreviewPublished(transaction);

  // Duplicate callbacks can race with finally, but must not forge extra events.
  recordDrawingExportLeaseRestored(transaction);
  recordDrawingExportPreviewPublished(transaction);

  const snapshot = readDrawingExportLifecycle();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.transactions));
  assert.equal(snapshot.transactionCount, 1);
  assert.deepEqual(snapshot.transactions[0], {
    transactionId: "drawing-export-1-lease-7",
    transactionSequence: 1,
    leaseId: 7,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 5,
    hideDrawings: false,
    persistence: { persistedRevision: 5, writePerformed: false },
    sceneKind: "settled-exact",
    sceneStamp: {
      scopeKey: "binance:spot:BTCUSDT__main",
      documentRevision: 5,
      surfaceGeneration: 3,
      viewportRevision: 11,
    },
    surfaceGeneration: 3,
    sceneEpoch: 19,
    attachmentRevision: 23,
    paintSequence: 29,
    barrierFrame: 31,
    drawableEntityCount: 1,
    drawingBounds: [{
      entityId: "freehand-1",
      kind: "freehand",
      leftCssPx: 10,
      topCssPx: 20,
      rightCssPx: 30,
      bottomCssPx: 40,
      paddingCssPx: 10,
    }],
    events: [
      { eventSequence: 1, type: "lease-prepared", observedAt: snapshot.transactions[0]?.events[0]?.observedAt },
      { eventSequence: 2, type: "capture-source-fixed", observedAt: snapshot.transactions[0]?.events[1]?.observedAt },
      { eventSequence: 3, type: "post-capture-revalidate", observedAt: snapshot.transactions[0]?.events[2]?.observedAt, valid: true },
      { eventSequence: 4, type: "lease-restored", observedAt: snapshot.transactions[0]?.events[3]?.observedAt },
      {
        eventSequence: 5,
        type: "image-encoded",
        observedAt: snapshot.transactions[0]?.events[4]?.observedAt,
        bytes: 4,
        widthPx: 100,
        heightPx: 80,
        mimeType: "image/png",
        optionsKey: "chart:png:1",
      },
      { eventSequence: 6, type: "preview-published", observedAt: snapshot.transactions[0]?.events[5]?.observedAt },
    ],
  });
  assert.ok(snapshot.transactions[0]?.events.every((event) => (
    Number.isFinite(Date.parse(event.observedAt)) && Object.isFrozen(event)
  )));
});

test("records hidden-frame receipts without exposing scene objects", () => {
  beginDrawingExportLifecycle(hiddenLease(8), true);
  const transaction = readDrawingExportLifecycle().transactions[0];
  assert.equal(transaction?.sceneKind, "hidden-frame");
  assert.equal(transaction?.surfaceGeneration, null);
  assert.equal(transaction?.drawableEntityCount, 0);
  assert.deepEqual(transaction?.drawingBounds, []);
  assert.equal("scene" in (transaction ?? {}), false);
});

test("rejects late or out-of-order evidence after restore and stale revalidation", () => {
  const encoded = {
    blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    width: 1,
    height: 1,
    mimeType: "image/png",
    optionsKey: "options",
  };
  const restoredBeforeCapture = beginDrawingExportLifecycle(exactLease(1).lease, false);
  recordDrawingExportLeaseRestored(restoredBeforeCapture);
  recordDrawingExportCaptureSourceFixed(restoredBeforeCapture);
  recordDrawingExportPostCaptureRevalidate(restoredBeforeCapture, true);
  recordDrawingExportImageEncoded(restoredBeforeCapture, encoded);
  recordDrawingExportPreviewPublished(restoredBeforeCapture);

  const stale = beginDrawingExportLifecycle(exactLease(2).lease, false);
  recordDrawingExportCaptureSourceFixed(stale);
  recordDrawingExportPostCaptureRevalidate(stale, false);
  recordDrawingExportLeaseRestored(stale);
  recordDrawingExportImageEncoded(stale, encoded);
  recordDrawingExportPreviewPublished(stale);

  const transactions = readDrawingExportLifecycle().transactions;
  assert.deepEqual(transactions[0]?.events.map((event) => event.type), [
    "lease-prepared",
    "lease-restored",
  ]);
  assert.deepEqual(transactions[1]?.events.map((event) => event.type), [
    "lease-prepared",
    "capture-source-fixed",
    "post-capture-revalidate",
    "lease-restored",
  ]);
});

test("retains only the newest eight transactions and reset clears sequence authority", () => {
  for (let leaseId = 1; leaseId <= 9; leaseId += 1) {
    beginDrawingExportLifecycle(exactLease(leaseId).lease, false);
  }
  const bounded = readDrawingExportLifecycle();
  assert.equal(bounded.transactionCount, 8);
  assert.equal(bounded.transactions[0]?.transactionSequence, 2);
  assert.equal(bounded.transactions.at(-1)?.transactionSequence, 9);

  resetDrawingExportLifecycle();
  assert.deepEqual(readDrawingExportLifecycle(), {
    schemaVersion: 1,
    transactionCount: 0,
    transactions: [],
  });
  assert.equal(beginDrawingExportLifecycle(exactLease(10).lease, false).transactionId, "drawing-export-1-lease-10");
});

test("the shared performance reset also retires export lifecycle evidence", () => {
  beginDrawingExportLifecycle(exactLease().lease, false);
  assert.equal(readDrawingExportLifecycle().transactionCount, 1);
  resetDrawingPerfCounters();
  assert.equal(readDrawingExportLifecycle().transactionCount, 0);
});
