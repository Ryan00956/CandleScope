import assert from "node:assert/strict";
import test from "node:test";

import { awaitControlledSeriesRebuildExportCapture } from "../controlledExportRollbackCheckpoint.js";
import type { DrawingExportLifecycleTransaction } from "../drawingExportLifecycle.js";

const WINDOW_KEY = "window";
const HANDLE_KEY = "__CANDLESCOPE_CONTROLLED_ROLLBACK_DRILL__";
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, WINDOW_KEY);

const authority = Object.freeze({
  runId: "run-1",
  authorityTokenSha256: "a".repeat(64),
  authorityAccepted: true,
  tokenRemoved: true,
  drillId: "series-rebuild-before-export",
  variant: null,
  documentInstanceId: "document-1",
  faultId: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
});

const transaction = Object.freeze({
  transactionId: "drawing-export-1-lease-7",
  leaseId: 7,
  scopeKey: "binance:spot:BTCUSDT__main",
  documentRevision: 5,
  hideDrawings: false,
  surfaceGeneration: 3,
  sceneStamp: Object.freeze({ surfaceGeneration: 3 }),
  sceneKind: "settled-exact",
  drawableEntityCount: 1,
  drawingBounds: Object.freeze([]),
}) as unknown as DrawingExportLifecycleTransaction;

function setWindow(value: Record<string, unknown>): void {
  Object.defineProperty(globalThis, WINDOW_KEY, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, WINDOW_KEY, originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, WINDOW_KEY);
  }
}

test.afterEach(restoreWindow);

test("ordinary pages and unrelated authorities are strict no-ops", async () => {
  restoreWindow();
  assert.equal(await awaitControlledSeriesRebuildExportCapture(
    transaction,
    new AbortController().signal,
  ), null);

  setWindow({
    [HANDLE_KEY]: Object.freeze({
      snapshot: () => ({ ...authority, drillId: "active-gesture-chart-boundary" }),
    }),
  });
  assert.equal(await awaitControlledSeriesRebuildExportCapture(
    transaction,
    new AbortController().signal,
  ), null);

  setWindow({
    [HANDLE_KEY]: Object.freeze({
      snapshot: () => { throw new Error("untrusted debug handle"); },
    }),
  });
  assert.equal(await awaitControlledSeriesRebuildExportCapture(
    transaction,
    new AbortController().signal,
  ), null);
});

test("exact controlled authority receives copied scalar identity and returns a bound receipt", async () => {
  const signal = new AbortController().signal;
  let received: Record<string, unknown> | null = null;
  setWindow({
    [HANDLE_KEY]: Object.freeze({
      snapshot: () => authority,
      awaitSeriesRebuildExportCapture: async (input: Record<string, unknown>) => {
        received = input;
        return Object.freeze({
          accepted: true,
          checkpointId: `${authority.faultId}:export:1`,
          paused: true,
          ...authority,
          transactionId: transaction.transactionId,
          leaseId: transaction.leaseId,
        });
      },
    }),
  });

  const receipt = await awaitControlledSeriesRebuildExportCapture(transaction, signal);
  assert.deepEqual(received, {
    transactionId: transaction.transactionId,
    leaseId: transaction.leaseId,
    scopeKey: transaction.scopeKey,
    documentRevision: transaction.documentRevision,
    surfaceGeneration: transaction.surfaceGeneration,
    hideDrawings: transaction.hideDrawings,
    signal,
  });
  assert.ok(Object.isFrozen(received));
  assert.equal(receipt?.accepted, true);
  assert.equal(receipt?.paused, true);
  assert.equal(receipt?.faultId, authority.faultId);
});

test("exact authority fails closed when the gate or receipt is unavailable", async () => {
  setWindow({
    [HANDLE_KEY]: Object.freeze({ snapshot: () => authority }),
  });
  await assert.rejects(
    awaitControlledSeriesRebuildExportCapture(transaction, new AbortController().signal),
    /checkpoint is unavailable/,
  );

  setWindow({
    [HANDLE_KEY]: Object.freeze({
      snapshot: () => authority,
      awaitSeriesRebuildExportCapture: async () => ({
        accepted: true,
        checkpointId: "detached-checkpoint",
        paused: true,
        ...authority,
        faultId: "22222222-2222-4222-8222-222222222222",
        transactionId: transaction.transactionId,
        leaseId: transaction.leaseId,
      }),
    }),
  });
  await assert.rejects(
    awaitControlledSeriesRebuildExportCapture(transaction, new AbortController().signal),
    /checkpoint receipt is invalid/,
  );
});

test("product-side abort and timeout retire a non-settling exact gate", async () => {
  let gateCallCount = 0;
  setWindow({
    [HANDLE_KEY]: Object.freeze({
      snapshot: () => authority,
      awaitSeriesRebuildExportCapture: async () => {
        gateCallCount += 1;
        return new Promise(() => {});
      },
    }),
  });
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  await assert.rejects(
    awaitControlledSeriesRebuildExportCapture(transaction, preAbortedController.signal),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(gateCallCount, 0);

  const controller = new AbortController();
  const aborted = awaitControlledSeriesRebuildExportCapture(transaction, controller.signal);
  controller.abort();
  await assert.rejects(aborted, (error) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  assert.equal(gateCallCount, 1);

  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  try {
    globalThis.setTimeout = ((callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;
    await assert.rejects(
      awaitControlledSeriesRebuildExportCapture(transaction, new AbortController().signal),
      /checkpoint timed out/,
    );
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});
