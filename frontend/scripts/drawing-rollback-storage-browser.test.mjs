import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedNativeReceipt,
  canonicalRecordReceipt,
  manifestReceipt,
  pendingDrawingAccepted,
  quotaNativeReceipt,
  retryAttemptedAt,
  storageBaselineAccepted,
  storageInjectionReceipt,
} from "./drawing-rollback-storage-browser.mjs";

function record(updatedAt = 10) {
  return {
    documentSchemaVersion: 1,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 2,
    updatedAt,
    entities: [{ id: "freehand-2", points: [1, 2, 3] }],
  };
}

function baselineSample(persistence) {
  const activeRecord = record(0);
  const stamp = {
    scopeKey: activeRecord.scopeKey,
    documentRevision: activeRecord.documentRevision,
    surfaceGeneration: 1,
    dataRevision: 1,
    projectionRevision: 1,
    lineageIndexRevision: 1,
    viewportRevision: 1,
    themeRevision: 1,
    widthCssPx: 1440,
    heightCssPx: 900,
    dpr: 1,
  };
  return {
    record: activeRecord,
    summary: { entityCount: activeRecord.entities.length },
    runtime: {
      inFlightCurrent: 0,
      lastPaintedStamp: stamp,
      lastPublishedStamp: stamp,
      lastRequestedStamp: stamp,
      paintReceipt: {
        kind: "drawing-scene-bridge-paint-ack",
        paintSequence: 1,
        stamp,
      },
      persistence,
      persistenceRestoreSource: "v2",
      queueDepthCurrent: 0,
    },
  };
}

test("clean v2 restore is a settled baseline before the coordinator owns a scope", () => {
  const activeRecord = record(0);
  const beforeDocument = {
    scopeKey: activeRecord.scopeKey,
    documentRevision: activeRecord.documentRevision,
    entityCount: activeRecord.entities.length,
  };
  assert.equal(storageBaselineAccepted(baselineSample(null), beforeDocument), true);
  const settledPersistence = {
    queueDepth: 0,
    inFlightRevision: null,
    pendingRevision: null,
    dirtyRevision: null,
    lastError: null,
    lastErrorName: null,
  };
  assert.equal(storageBaselineAccepted(baselineSample(settledPersistence), beforeDocument), true);
  assert.equal(storageBaselineAccepted(baselineSample({
    ...settledPersistence,
    queueDepth: 1,
    dirtyRevision: 2,
  }), beforeDocument), false);
  assert.equal(storageBaselineAccepted(baselineSample({
    ...settledPersistence,
    lastErrorName: "QuotaExceededError",
  }), beforeDocument), false);
});

test("pending drawing requires a newer dirty document with an added entity", () => {
  const oldIdentity = {
    scopeKey: record().scopeKey,
    documentRevision: 1,
    entityCount: 1,
  };
  const nextRecord = {
    ...record(0),
    entities: [...record(0).entities, { id: "freehand-3", points: [4, 5] }],
  };
  const sample = {
    record: nextRecord,
    runtime: { persistence: { dirtyRevision: 2 } },
  };
  assert.equal(pendingDrawingAccepted(sample, oldIdentity), true);
  assert.equal(pendingDrawingAccepted({
    ...sample,
    runtime: { persistence: { dirtyRevision: null } },
  }, oldIdentity), false);
  assert.equal(pendingDrawingAccepted({
    ...sample,
    record: { ...nextRecord, entities: nextRecord.entities.slice(0, 1) },
  }, oldIdentity), false);
});

test("storage injection summary derives armed and observed from both native fault bindings", () => {
  const variant = (kind) => ({
    kind,
    transactionId: `${kind}-transaction`,
    faultBinding: { faultId: `${kind}-fault` },
    nativeReceipt: {
      receiptId: `${kind}-native`,
      faultId: `${kind}-fault`,
      productErrorReceiptId: `${kind}-product-error`,
      transactionId: `${kind}-transaction`,
      variant: kind,
    },
    errorReceipt: {
      receiptId: `${kind}-product-error`,
      nativeReceiptId: `${kind}-native`,
      caughtByProduct: true,
    },
  });
  const variants = [variant("quota"), variant("blocked")];
  assert.deepEqual(storageInjectionReceipt(variants, true), {
    kind: "indexeddb-quota-and-blocked",
    variants: ["quota", "blocked"],
    armed: true,
    observed: true,
    buildAuthorityCurrent: true,
  });

  const unobserved = structuredClone(variants);
  unobserved[1].errorReceipt.caughtByProduct = false;
  assert.equal(storageInjectionReceipt(unobserved, true).armed, true);
  assert.equal(storageInjectionReceipt(unobserved, true).observed, false);
  assert.equal(storageInjectionReceipt([variants[0]], true).armed, false);
  assert.equal(storageInjectionReceipt(variants, false).buildAuthorityCurrent, false);
});

test("canonical storage receipts distinguish physical bytes from document identity", () => {
  const first = canonicalRecordReceipt(record(10));
  const second = canonicalRecordReceipt(record(20));
  assert.equal(first.kind, "canonical-structured-clone-record");
  assert.equal(first.documentSchemaVersion, 1);
  assert.equal(first.documentRevision, 2);
  assert.equal(first.entityCount, 1);
  assert.match(first.canonicalBytesDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.documentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first.canonicalBytesDigest, second.canonicalBytesDigest);
  assert.equal(first.documentDigest, second.documentDigest);
});

test("manifest receipt hashes exact raw bytes and decodes exact identity", () => {
  const scopeKey = "binance:spot:BTCUSDT__main";
  const raw = JSON.stringify({
    manifestSchemaVersion: 1,
    scopeKey,
    revision: 2,
    count: 1,
  });
  const receipt = manifestReceipt(scopeKey, raw);
  assert.deepEqual({
    kind: receipt.kind,
    manifestSchemaVersion: receipt.manifestSchemaVersion,
    scopeKey: receipt.scopeKey,
    revision: receipt.revision,
    count: receipt.count,
  }, {
    kind: "drawing-document-manifest",
    manifestSchemaVersion: 1,
    scopeKey,
    revision: 2,
    count: 1,
  });
  assert.match(receipt.rawBytesDigest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => manifestReceipt(scopeKey, `${raw}x`), /manifest JSON is invalid/);
});

test("quota receipt maps the native cache-expiry probe and explicit cleanup lifecycle", () => {
  const runId = "phase9-run";
  const faultId = "11111111-1111-4111-8111-111111111111";
  const origin = "http://127.0.0.1:4173";
  const databaseName = `candlescope-rollback-quota-${runId}-${faultId}`;
  const fields = {
    runId,
    faultId,
    authorityTokenSha256: `sha256:${"a".repeat(64)}`,
    variant: "quota",
    transactionId: "quota-transaction",
  };
  const usage = (quotaBytes, overrideActive, observedAt) => ({
    method: "Storage.getUsageAndQuota",
    origin,
    usageBytes: 4_096,
    quotaBytes,
    overrideActive,
    observedAt,
  });
  const afterCacheExpiry = usage(1, true, "2026-07-16T08:00:54.960Z");
  const receipt = quotaNativeReceipt({
    receiptId: "quota-receipt",
    origin,
    before: usage(10_000_000, false, "2026-07-16T08:00:19.600Z"),
    overridden: usage(1, true, "2026-07-16T08:00:19.900Z"),
    restored: usage(10_000_000, false, "2026-07-16T08:00:55.600Z"),
    quotaPlan: {
      kind: "nonzero-below-existing-usage",
      quotaSizeBytes: 1,
      baselineUsageBytes: 4_096,
      baselineUsageExceedsQuota: true,
    },
    overrideCommand: { quotaSize: 1, observedAt: "2026-07-16T08:00:19.800Z" },
    clearCommand: { observedAt: "2026-07-16T08:00:55.400Z" },
    overrideCleared: true,
    releaseAccepted: true,
    forcedCleanup: false,
    cacheExpiryGuard: {
      kind: "indexeddb-bucket-space-cache-expiry",
      cacheTimeLimitMs: 30_000,
      guardMs: 5_000,
      requestedWaitMs: 35_000,
      elapsedMs: 35_000,
      startedAt: "2026-07-16T08:00:19.950Z",
      completedAt: "2026-07-16T08:00:54.950Z",
      verification: afterCacheExpiry,
    },
    preparationSnapshot: {
      storage: {
        quotaPreparation: {
          prepared: true,
          databaseName,
          storeName: "quota-probe",
          baselineKey: "baseline",
          baselineCommitted: true,
          connectionKeptOpen: true,
          preparedAt: "2026-07-16T08:00:19.500Z",
        },
      },
    },
    probeSnapshot: {
      storage: {
        quotaProbe: {
          attempted: true,
          attemptedAt: "2026-07-16T08:00:55.000Z",
          databaseName,
          storeName: "quota-probe",
          transactionMode: "readwrite",
          settled: "abort",
          requestError: { name: "AbortError" },
          transactionError: {
            name: "QuotaExceededError",
            observedAt: "2026-07-16T08:00:55.020Z",
          },
          abortEvent: {
            type: "abort",
            isTrusted: true,
            observedAt: "2026-07-16T08:00:55.030Z",
          },
          nativeQuotaExceeded: true,
          observedAt: "2026-07-16T08:00:55.040Z",
        },
      },
    },
    releaseSnapshot: {
      storage: {
        quotaRelease: {
          databaseName,
          storeName: "quota-probe",
          connectionClosed: true,
          deletion: { status: "success" },
          databaseStillPresent: false,
          forcedCleanup: false,
          completed: true,
          completedAt: "2026-07-16T08:00:55.500Z",
        },
      },
    },
  }, fields, "product-error");

  assert.equal(receipt.sacrificialDbName, databaseName);
  assert.equal(receipt.overrideActive, true);
  assert.equal(receipt.releaseAccepted, true);
  assert.equal(receipt.forcedCleanup, false);
  assert.deepEqual(receipt.quotaPlan, {
    kind: "nonzero-below-existing-usage",
    quotaSizeBytes: 1,
    baselineUsageBytes: 4_096,
    baselineUsageExceedsQuota: true,
  });
  assert.equal(receipt.preparation.baselineCommitted, true);
  assert.deepEqual(receipt.cacheExpiryGuard.verification, afterCacheExpiry);
  assert.equal(receipt.probe.transactionError.name, "QuotaExceededError");
  assert.equal(receipt.probe.settled, "abort");
  assert.equal(receipt.probe.abortEvent.isTrusted, true);
  assert.equal(receipt.cleanup.storeName, "quota-probe");
  assert.equal(receipt.cleanup.databaseStillPresent, false);
  assert.deepEqual(Object.keys(receipt.usageAndQuota), [
    "before",
    "overridden",
    "afterCacheExpiry",
    "restored",
  ]);
});

test("blocked receipt maps only the native seam lifecycle fields", () => {
  const runId = "phase9-run";
  const faultId = "11111111-1111-4111-8111-111111111111";
  const databaseName = `candlescope-rollback-blocked-${runId}-${faultId}`;
  const fields = {
    runId,
    faultId,
    authorityTokenSha256: `sha256:${"a".repeat(64)}`,
    variant: "blocked",
    transactionId: "blocked-transaction",
  };
  const receipt = blockedNativeReceipt({
    receiptId: "blocked-receipt",
    snapshot: {
      storage: {
        blockedPreparation: {
          faultDatabaseName: databaseName,
          keeperConnectionId: "keeper-connection",
          keeperVersion: 1,
          keeperOpenedAt: "2026-07-16T08:00:19.900Z",
        },
        blockedRoute: {
          requestId: "upgrade-request",
          routedDatabaseName: databaseName,
          routedVersion: 2,
          startedAt: "2026-07-16T08:00:20.100Z",
          settled: "success-after-keeper-close",
          settledAt: "2026-07-16T08:00:22.300Z",
        },
        blockedEvent: {
          type: "blocked",
          isTrusted: true,
          databaseName,
          oldVersion: 1,
          newVersion: 2,
          observedAt: "2026-07-16T08:00:20.150Z",
        },
        blockedRelease: {
          keeperClosedAt: "2026-07-16T08:00:22.200Z",
          deletion: { status: "success" },
          databaseStillPresent: false,
          databaseName,
          completedAt: "2026-07-16T08:00:22.600Z",
        },
      },
    },
  }, fields, "product-error");
  assert.equal(receipt.sacrificialDbName, databaseName);
  assert.equal(receipt.upgradeOpenRequest.blockedEvent.isTrusted, true);
  assert.equal(receipt.upgradeOpenRequest.settled, "success-after-keeper-close");
  assert.deepEqual(receipt.cleanup, {
    keeperClosed: true,
    upgradeRequestSettled: true,
    deleteRequested: true,
    deleteSucceeded: true,
    databaseAbsent: true,
    databaseName,
    completedAt: "2026-07-16T08:00:22.600Z",
  });
});

test("retry attempt is bound to the browser trigger timestamp after native cleanup", () => {
  const cleanupCompletedAt = "2026-07-16T08:00:22.600Z";
  const requestedAt = "2026-07-16T08:00:22.601Z";
  assert.equal(retryAttemptedAt({ clicked: true, requestedAt }, cleanupCompletedAt), requestedAt);
});

test("retry attempt fails closed without an exact browser trigger timestamp", () => {
  const cleanupCompletedAt = "2026-07-16T08:00:22.600Z";
  for (const trigger of [
    null,
    {},
    { requestedAt: "2026-07-16 08:00:22.601Z" },
    { requestedAt: "not-a-timestamp" },
  ]) {
    assert.throws(
      () => retryAttemptedAt(trigger, cleanupCompletedAt),
      /retry browser trigger timestamp is invalid/,
    );
  }
});

test("retry attempt fails closed when browser trigger predates native cleanup", () => {
  assert.throws(
    () => retryAttemptedAt(
      { requestedAt: "2026-07-16T08:00:22.599Z" },
      "2026-07-16T08:00:22.600Z",
    ),
    /retry browser trigger predates native cleanup/,
  );
  assert.throws(
    () => retryAttemptedAt(
      { requestedAt: "2026-07-16T08:00:22.601Z" },
      undefined,
    ),
    /native cleanup timestamp is invalid/,
  );
});
