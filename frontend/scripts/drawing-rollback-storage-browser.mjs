import crypto from "node:crypto";

import {
  captureDrillBuildAuthority,
  commonArtifact,
  performFreehandGesture,
  runtimeCurrent,
  runtimeSignature,
  waitForSample,
} from "./drawing-rollback-worker-browser.mjs";

const DRILL_ID = "indexeddb-quota-blocked";
const DATABASE_NAME = "candlescope-drawings-v2";
const STORE_NAME = "documents";
const MANIFEST_PREFIX = "candlescope-drawings-v2-manifest";
const VARIANTS = Object.freeze(["quota", "blocked"]);

const isoNow = () => new Date().toISOString();

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return Array.from(value, canonicalize);
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested !== undefined) output[key] = canonicalize(nested);
  }
  return output;
}

function digestJson(value) {
  const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function digestUtf8(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function prefixedSha256(value) {
  if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value;
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`;
  throw new Error(`controlled IndexedDB authority digest is invalid: ${value}`);
}

function assertRecord(record, description) {
  if (!record
    || record.documentSchemaVersion !== 1
    || typeof record.scopeKey !== "string"
    || !record.scopeKey
    || !Number.isSafeInteger(record.documentRevision)
    || record.documentRevision <= 0
    || !Array.isArray(record.entities)
    || record.entities.length <= 0) {
    throw new Error(`${description} is invalid: ${JSON.stringify(record)}`);
  }
}

export function canonicalRecordReceipt(record) {
  assertRecord(record, "canonical drawing record");
  const normalizedDocument = { ...record, updatedAt: 0 };
  return Object.freeze({
    kind: "canonical-structured-clone-record",
    documentSchemaVersion: record.documentSchemaVersion,
    scopeKey: record.scopeKey,
    documentRevision: record.documentRevision,
    entityCount: record.entities.length,
    canonicalBytesDigest: digestJson(record),
    documentDigest: digestJson(normalizedDocument),
  });
}

export function manifestReceipt(scopeKey, raw) {
  if (typeof raw !== "string" || !raw) {
    throw new Error(`drawing manifest bytes are missing for ${scopeKey}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`drawing manifest JSON is invalid for ${scopeKey}`, { cause: error });
  }
  const manifestKeys = parsed && typeof parsed === "object"
    ? Object.keys(parsed).sort()
    : [];
  if (!parsed
    || JSON.stringify(manifestKeys) !== JSON.stringify([
      "count",
      "manifestSchemaVersion",
      "revision",
      "scopeKey",
    ])
    || parsed.manifestSchemaVersion !== 1
    || parsed.scopeKey !== scopeKey
    || !Number.isSafeInteger(parsed.revision)
    || parsed.revision <= 0
    || !Number.isSafeInteger(parsed.count)
    || parsed.count <= 0) {
    throw new Error(`drawing manifest is invalid for ${scopeKey}: ${raw}`);
  }
  return Object.freeze({
    kind: "drawing-document-manifest",
    manifestSchemaVersion: parsed.manifestSchemaVersion,
    scopeKey: parsed.scopeKey,
    revision: parsed.revision,
    count: parsed.count,
    rawBytesDigest: digestUtf8(raw),
  });
}

function documentIdentity(record) {
  const receipt = canonicalRecordReceipt(record);
  return Object.freeze({
    scopeKey: receipt.scopeKey,
    documentRevision: receipt.documentRevision,
    entityCount: receipt.entityCount,
    documentDigest: receipt.documentDigest,
  });
}

function sameDocumentIdentity(left, right) {
  return left?.scopeKey === right?.scopeKey
    && left?.documentRevision === right?.documentRevision
    && left?.entityCount === right?.entityCount
    && left?.documentDigest === right?.documentDigest;
}

function sameRecordReceipt(left, right) {
  return sameDocumentIdentity(left, right)
    && left?.canonicalBytesDigest === right?.canonicalBytesDigest
    && left?.documentSchemaVersion === right?.documentSchemaVersion;
}

function sameManifestReceipt(left, right) {
  return left?.scopeKey === right?.scopeKey
    && left?.revision === right?.revision
    && left?.count === right?.count
    && left?.rawBytesDigest === right?.rawBytesDigest
    && left?.manifestSchemaVersion === right?.manifestSchemaVersion;
}

async function readActivePersistenceState(session) {
  return session.cdp.evaluateJson(`(() => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    return {
      runtime: handle && typeof handle.readPhase6Runtime === 'function'
        ? handle.readPhase6Runtime()
        : null,
      summary: handle && typeof handle.readRuntimeSummary === 'function'
        ? handle.readRuntimeSummary()
        : null,
      record: handle && typeof handle.readActivePersistenceDocumentRecord === 'function'
        ? handle.readActivePersistenceDocumentRecord()
        : null
    };
  })()`);
}

async function readDurableStorage(session, scopeKey) {
  const value = await session.cdp.evaluateJson(`(async () => {
    const scopeKey = ${JSON.stringify(scopeKey)};
    const request = indexedDB.open(${JSON.stringify(DATABASE_NAME)});
    const database = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('drawing database open failed'));
      request.onblocked = () => reject(new Error('drawing database open blocked'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (!database.objectStoreNames.contains(${JSON.stringify(STORE_NAME)})) {
        throw new Error('drawing document store is missing');
      }
      const transaction = database.transaction(${JSON.stringify(STORE_NAME)}, 'readonly');
      const get = transaction.objectStore(${JSON.stringify(STORE_NAME)}).get(scopeKey);
      const record = await new Promise((resolve, reject) => {
        get.onerror = () => reject(get.error || new Error('drawing record read failed'));
        get.onsuccess = () => resolve(get.result || null);
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('drawing read failed'));
        transaction.onabort = () => reject(transaction.error || new Error('drawing read aborted'));
      });
      const manifestKey = ${JSON.stringify(`${MANIFEST_PREFIX}-`)} + encodeURIComponent(scopeKey);
      return { record, manifestRaw: localStorage.getItem(manifestKey) };
    } finally {
      database.close();
    }
  })()`);
  return Object.freeze({
    record: canonicalRecordReceipt(value?.record),
    manifest: manifestReceipt(scopeKey, value?.manifestRaw),
  });
}

function faultFields(navigation, transactionId, variant) {
  return Object.freeze({
    runId: navigation.runId,
    faultId: navigation.faultId,
    authorityTokenSha256: prefixedSha256(navigation.authorityTokenSha256),
    variant,
    transactionId,
  });
}

function stateReceipt(stage, fields, sample, observedAt) {
  const identity = documentIdentity(sample.record);
  const persistence = sample.runtime?.persistence;
  return Object.freeze({
    stage,
    ...fields,
    observedAt,
    ...identity,
    dirty: persistence?.dirtyRevision === identity.documentRevision,
  });
}

export function storageBaselineAccepted(sample, beforeDocument) {
  const persistence = sample?.runtime?.persistence;
  const persistenceSettled = cleanPersistenceState(persistence);
  if (!sample?.runtime
    || sample.runtime.persistenceRestoreSource !== "v2"
    || !runtimeCurrent(sample.runtime)
    || !persistenceSettled
    || sample.summary?.entityCount !== beforeDocument.entityCount) return false;
  try {
    const identity = documentIdentity(sample.record);
    return identity.scopeKey === beforeDocument.scopeKey
      && identity.documentRevision === beforeDocument.documentRevision
      && identity.entityCount === beforeDocument.entityCount;
  } catch {
    return false;
  }
}

function cleanPersistenceState(persistence) {
  return persistence === null
    || (persistence?.queueDepth === 0
      && persistence?.inFlightRevision === null
      && persistence?.pendingRevision === null
      && persistence?.dirtyRevision === null
      && persistence?.lastError === null
      && persistence?.lastErrorName === null);
}

export function pendingDrawingAccepted(sample, oldIdentity) {
  try {
    const identity = documentIdentity(sample?.record);
    return identity.scopeKey === oldIdentity.scopeKey
      && identity.documentRevision > oldIdentity.documentRevision
      && identity.entityCount > oldIdentity.entityCount
      && sample?.runtime?.persistence?.dirtyRevision === identity.documentRevision;
  } catch {
    return false;
  }
}

async function waitForBaseline(session, beforeDocument, timeoutMs, variant) {
  return waitForSample(
    () => readActivePersistenceState(session),
    (sample) => storageBaselineAccepted(sample, beforeDocument),
    {
      timeoutMs,
      description: `${variant} v2 persistence baseline`,
      stableMs: 120,
      signature: (sample) => `${runtimeSignature(sample)}:${sample?.record?.documentRevision}`,
    },
  );
}

export function quotaNativeReceipt(released, fields, productErrorReceiptId) {
  const preparation = released?.preparationSnapshot?.storage?.quotaPreparation;
  const probe = released?.probeSnapshot?.storage?.quotaProbe;
  const cleanup = released?.releaseSnapshot?.storage?.quotaRelease;
  const cacheExpiryGuard = released?.cacheExpiryGuard;
  return Object.freeze({
    kind: "cdp-storage-quota-override",
    receiptId: released.receiptId,
    ...fields,
    origin: released.origin,
    overrideActive: released.overridden?.overrideActive === true
      && cacheExpiryGuard?.verification?.overrideActive === true,
    overrideCleared: released.overrideCleared === true,
    releaseAccepted: released.releaseAccepted === true,
    forcedCleanup: released.forcedCleanup === true,
    productErrorReceiptId,
    quotaPlan: Object.freeze({ ...released.quotaPlan }),
    sacrificialDbName: preparation?.databaseName,
    preparation: Object.freeze({ ...preparation }),
    cacheExpiryGuard: Object.freeze({
      ...cacheExpiryGuard,
      verification: Object.freeze({ ...cacheExpiryGuard?.verification }),
    }),
    probe: Object.freeze({
      ...probe,
      requestError: probe?.requestError === null
        ? null
        : Object.freeze({ ...probe?.requestError }),
      transactionError: probe?.transactionError === null
        ? null
        : Object.freeze({ ...probe?.transactionError }),
      abortEvent: Object.freeze({ ...probe?.abortEvent }),
    }),
    cleanup: Object.freeze({
      ...cleanup,
      deletion: cleanup?.deletion === null
        ? null
        : Object.freeze({ ...cleanup?.deletion }),
    }),
    overrideCommand: released.overrideCommand,
    clearCommand: released.clearCommand,
    usageAndQuota: Object.freeze({
      before: released.before,
      overridden: released.overridden,
      afterCacheExpiry: cacheExpiryGuard?.verification,
      restored: released.restored,
    }),
  });
}

export function blockedNativeReceipt(released, fields, productErrorReceiptId) {
  const storage = released?.snapshot?.storage;
  const preparation = storage?.blockedPreparation;
  const route = storage?.blockedRoute;
  const event = storage?.blockedEvent;
  const cleanup = storage?.blockedRelease;
  const sacrificialDbName = preparation?.faultDatabaseName;
  return Object.freeze({
    kind: "native-indexeddb-blocked-event",
    receiptId: released.receiptId,
    ...fields,
    sacrificialDbName,
    productErrorReceiptId,
    keeperConnection: Object.freeze({
      connectionId: preparation?.keeperConnectionId,
      databaseName: sacrificialDbName,
      openedVersion: preparation?.keeperVersion,
      openedAt: preparation?.keeperOpenedAt,
      closedAt: cleanup?.keeperClosedAt,
    }),
    upgradeOpenRequest: Object.freeze({
      requestId: route?.requestId,
      databaseName: route?.routedDatabaseName,
      requestedVersion: route?.routedVersion,
      startedAt: route?.startedAt,
      settled: route?.settled,
      settledAt: route?.settledAt,
      blockedEvent: Object.freeze({ ...event }),
    }),
    cleanup: Object.freeze({
      keeperClosed: typeof cleanup?.keeperClosedAt === "string",
      upgradeRequestSettled: route?.settled === "success-after-keeper-close",
      deleteRequested: cleanup?.deletion !== null,
      deleteSucceeded: cleanup?.deletion?.status === "success",
      databaseAbsent: cleanup?.databaseStillPresent === false,
      databaseName: cleanup?.databaseName,
      completedAt: cleanup?.completedAt,
    }),
  });
}

async function openExportPanelForRetry(session) {
  const receipt = await session.cdp.evaluateJson(`(() => {
    const button = document.querySelector('[data-drawing-action="export"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return { clicked: false, reason: 'button-unavailable' };
    }
    if (button.classList.contains('active')) {
      return { clicked: false, reason: 'panel-already-open' };
    }
    button.click();
    return { clicked: true, requestedAt: new Date().toISOString() };
  })()`);
  if (receipt?.clicked !== true) {
    throw new Error(`controlled IndexedDB retry could not open export panel: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function retryAttemptedAt(retryTrigger, cleanupCompletedAt) {
  const requestedAt = retryTrigger?.requestedAt;
  if (!exactIsoTimestamp(requestedAt)) {
    throw new Error(`controlled IndexedDB retry browser trigger timestamp is invalid: ${requestedAt}`);
  }
  if (!exactIsoTimestamp(cleanupCompletedAt)) {
    throw new Error(`controlled IndexedDB native cleanup timestamp is invalid: ${cleanupCompletedAt}`);
  }
  if (Date.parse(requestedAt) < Date.parse(cleanupCompletedAt)) {
    throw new Error(
      `controlled IndexedDB retry browser trigger predates native cleanup: ${requestedAt} < ${cleanupCompletedAt}`,
    );
  }
  return requestedAt;
}

async function runVariant(session, variant, beforeDocument, timeoutMs) {
  const transactionId = crypto.randomUUID();
  const navigation = await session.navigateRollbackDrill(DRILL_ID, { variant });
  const fields = faultFields(navigation, transactionId, variant);
  const baseline = await waitForBaseline(session, beforeDocument, timeoutMs, variant);
  const oldIdentity = documentIdentity(baseline.value.record);
  const durableBefore = await readDurableStorage(session, oldIdentity.scopeKey);
  if (!sameDocumentIdentity(durableBefore.record, oldIdentity)
    || durableBefore.manifest.revision !== oldIdentity.documentRevision
    || durableBefore.manifest.count !== oldIdentity.entityCount) {
    throw new Error(`${variant} durable baseline does not match restored v2 document`);
  }

  const failureMetricBefore = variant === "quota"
    ? baseline.value.runtime.persistenceQuotaFailureCount
    : baseline.value.runtime.persistenceOtherFailureCount;
  let nativePrepared;
  if (variant === "quota") {
    nativePrepared = await session.prepareIndexedDbQuotaFault({
      faultId: navigation.faultId,
      transactionId,
    });
  } else {
    nativePrepared = await session.prepareIndexedDbBlockedFault({
      faultId: navigation.faultId,
      transactionId,
    });
  }

  const gestureAttempts = [await performFreehandGesture(session, timeoutMs)];
  const pendingReader = () => readActivePersistenceState(session);
  let pending = null;
  const readinessDescription = `${variant} pending drawing readiness probe`;
  try {
    pending = await waitForSample(
      pendingReader,
      (sample) => pendingDrawingAccepted(sample, oldIdentity),
      {
        timeoutMs: Math.min(timeoutMs, 900),
        description: readinessDescription,
        signature: (sample) => `${sample?.record?.documentRevision}:${sample?.runtime?.persistence?.phase}`,
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(`${readinessDescription} timed out:`)) {
      throw error;
    }
  }
  if (pending === null) {
    gestureAttempts.push(await performFreehandGesture(session, timeoutMs));
  }
  pending ??= await waitForSample(
    pendingReader,
    (sample) => pendingDrawingAccepted(sample, oldIdentity),
    {
      timeoutMs: Math.min(timeoutMs, 5_000),
      description: `${variant} pending drawing document`,
      signature: (sample) => `${sample?.record?.documentRevision}:${sample?.runtime?.persistence?.phase}`,
    },
  );
  const beforeWrite = stateReceipt(
    "before-write",
    fields,
    pending.value,
    gestureAttempts.at(-1).committedAt,
  );

  const failure = await waitForSample(
    () => readActivePersistenceState(session),
    (sample) => {
      let identity;
      try { identity = documentIdentity(sample.record); } catch { return false; }
      const persistence = sample.runtime?.persistence;
      const metric = variant === "quota"
        ? sample.runtime?.persistenceQuotaFailureCount
        : sample.runtime?.persistenceOtherFailureCount;
      return sameDocumentIdentity(identity, beforeWrite)
        && persistence?.phase === "error"
        && persistence?.pendingRevision === beforeWrite.documentRevision
        && persistence?.dirtyRevision === beforeWrite.documentRevision
        && persistence?.lastErrorName === (variant === "quota" ? "QuotaExceededError" : "Error")
        && (variant !== "blocked"
          || persistence?.lastError === "drawing IndexedDB upgrade is blocked")
        && metric > failureMetricBefore;
    },
    {
      timeoutMs,
      description: `${variant} native persistence failure`,
      stableMs: 80,
      signature: (sample) => `${sample?.runtime?.persistence?.phase}:${sample?.runtime?.persistenceFailureCount}`,
    },
  );
  const afterFailure = stateReceipt("after-failure", fields, failure.value, failure.observedAt);
  const durableAfter = await readDurableStorage(session, oldIdentity.scopeKey);
  if (!sameRecordReceipt(durableBefore.record, durableAfter.record)
    || !sameManifestReceipt(durableBefore.manifest, durableAfter.manifest)) {
    throw new Error(`${variant} failure changed the previous durable record or manifest`);
  }

  const nativeReceiptId = nativePrepared.receiptId;
  const productErrorReceiptId = crypto.randomUUID();
  const errorReceipt = Object.freeze({
    receiptId: productErrorReceiptId,
    ...fields,
    nativeReceiptId,
    operation: variant === "quota" ? "transaction-write" : "database-open",
    name: failure.value.runtime.persistence.lastErrorName,
    message: failure.value.runtime.persistence.lastError,
    source: "drawing-persistence-flush",
    caughtByProduct: true,
    observedAt: failure.observedAt,
  });

  let released;
  if (variant === "quota") {
    released = await session.releaseIndexedDbQuotaFault({
      faultId: navigation.faultId,
      transactionId,
    });
  } else {
    released = await session.releaseIndexedDbBlockedFault({
      faultId: navigation.faultId,
      transactionId,
    });
  }
  const nativeReceipt = variant === "quota"
    ? quotaNativeReceipt(released, fields, productErrorReceiptId)
    : blockedNativeReceipt(released, fields, productErrorReceiptId);

  const retryTrigger = await openExportPanelForRetry(session);
  const attemptedAt = retryAttemptedAt(retryTrigger, nativeReceipt.cleanup?.completedAt);
  const retry = await waitForSample(
    () => readActivePersistenceState(session),
    (sample) => {
      let identity;
      try { identity = documentIdentity(sample.record); } catch { return false; }
      const persistence = sample.runtime?.persistence;
      return sameDocumentIdentity(identity, beforeWrite)
        && persistence?.phase === "persisted"
        && persistence?.queueDepth === 0
        && persistence?.pendingRevision === null
        && persistence?.inFlightRevision === null
        && persistence?.dirtyRevision === null
        && persistence?.lastPersistedRevision === beforeWrite.documentRevision
        && persistence?.lastError === null
        && persistence?.lastErrorName === null;
    },
    {
      timeoutMs,
      description: `${variant} export-bound persistence retry`,
      stableMs: 120,
      signature: (sample) => `${sample?.runtime?.persistence?.phase}:${sample?.runtime?.persistence?.lastPersistedRevision}`,
    },
  );
  const durableRetry = await readDurableStorage(session, oldIdentity.scopeKey);
  const afterRetrySample = await readActivePersistenceState(session);
  const afterRetry = stateReceipt("after-retry", fields, afterRetrySample, isoNow());
  if (!sameDocumentIdentity(afterRetry, beforeWrite)
    || !sameDocumentIdentity(durableRetry.record, beforeWrite)
    || durableRetry.manifest.revision !== beforeWrite.documentRevision
    || durableRetry.manifest.count !== beforeWrite.entityCount) {
    throw new Error(`${variant} retry did not commit the exact retained pending document`);
  }
  const retryReceipt = Object.freeze({
    kind: "retry-commit",
    ...fields,
    receiptId: crypto.randomUUID(),
    attemptedAt,
    committedAt: retry.observedAt,
    trigger: retryTrigger,
    durableRecord: durableRetry.record,
    manifest: durableRetry.manifest,
  });

  const buildAuthorityBeforeReload = await captureDrillBuildAuthority(session, DRILL_ID);
  const reload = await session.reloadManagedDocument({
    variant,
    faultId: navigation.faultId,
    transactionId,
  });
  const cold = await waitForSample(
    () => readActivePersistenceState(session),
    (sample) => {
      let identity;
      try { identity = documentIdentity(sample.record); } catch { return false; }
      const persistence = sample.runtime?.persistence;
      return sameDocumentIdentity(identity, beforeWrite)
        && sample.runtime?.persistenceRestoreSource === "v2"
        && cleanPersistenceState(persistence)
        && runtimeCurrent(sample.runtime);
    },
    {
      timeoutMs,
      description: `${variant} cold v2 restore`,
      stableMs: 160,
      signature: (sample) => `${runtimeSignature(sample)}:${sample?.runtime?.persistenceRestoreSource}`,
    },
  );
  const durableCold = await readDurableStorage(session, oldIdentity.scopeKey);
  const restoredDocument = documentIdentity(cold.value.record);
  if (!sameDocumentIdentity(restoredDocument, beforeWrite)
    || !sameRecordReceipt(durableCold.record, durableRetry.record)
    || !sameManifestReceipt(durableCold.manifest, durableRetry.manifest)) {
    throw new Error(`${variant} cold reload did not restore the exact retry record and manifest`);
  }
  const buildAuthorityAfterReload = await captureDrillBuildAuthority(session, DRILL_ID);
  const coldReloadReceipt = Object.freeze({
    kind: "cold-reload",
    ...fields,
    sourceTransactionId: transactionId,
    receiptId: crypto.randomUUID(),
    beforeDocumentInstanceId: reload.beforeDocumentInstanceId,
    afterDocumentInstanceId: reload.afterDocumentInstanceId,
    restoreSource: cold.value.runtime.persistenceRestoreSource,
    observedAt: isoNow(),
    restoredDocument,
    durableRecord: durableCold.record,
    manifest: durableCold.manifest,
    queueDepthCurrent: cold.value.runtime.persistence?.queueDepth ?? 0,
    dirty: cold.value.runtime.persistence?.dirtyRevision != null,
    lastRequestedStamp: cold.value.runtime.lastRequestedStamp,
    lastPublishedStamp: cold.value.runtime.lastPublishedStamp,
    lastPaintedStamp: cold.value.runtime.lastPaintedStamp,
    paintReceipt: cold.value.runtime.paintReceipt,
  });

  return Object.freeze({
    kind: variant,
    transactionId,
    faultBinding: Object.freeze({
      kind: "controlled-indexeddb-fault-binding",
      runId: fields.runId,
      faultId: fields.faultId,
      authorityTokenSha256: fields.authorityTokenSha256,
      variant,
    }),
    nativeReceipt,
    errorReceipt,
    durableRecord: Object.freeze({
      beforeFailure: durableBefore.record,
      afterFailure: durableAfter.record,
    }),
    manifest: Object.freeze({
      beforeFailure: durableBefore.manifest,
      afterFailure: durableAfter.manifest,
    }),
    stateReceipts: Object.freeze([beforeWrite, afterFailure, afterRetry]),
    retryReceipt,
    coldReloadReceipt,
    failureMetrics: Object.freeze({
      before: failureMetricBefore,
      after: variant === "quota"
        ? failure.value.runtime.persistenceQuotaFailureCount
        : failure.value.runtime.persistenceOtherFailureCount,
    }),
    buildAuthorityBeforeReload,
    buildAuthorityAfterReload,
  });
}

export function storageInjectionReceipt(variants, buildAuthorityCurrent) {
  const values = Array.isArray(variants) ? variants : [];
  const exactVariants = values.length === VARIANTS.length
    && VARIANTS.every((kind) => values.filter((variant) => variant?.kind === kind).length === 1);
  const armed = exactVariants && values.every((variant) => (
    typeof variant?.nativeReceipt?.receiptId === "string"
      && variant.nativeReceipt.receiptId.length > 0
      && variant.nativeReceipt.variant === variant.kind
      && variant.nativeReceipt.transactionId === variant.transactionId
      && variant.nativeReceipt.faultId === variant.faultBinding?.faultId
  ));
  const observed = armed && values.every((variant) => (
    variant?.errorReceipt?.caughtByProduct === true
      && variant.errorReceipt.nativeReceiptId === variant.nativeReceipt.receiptId
      && variant.nativeReceipt.productErrorReceiptId === variant.errorReceipt.receiptId
  ));
  return Object.freeze({
    kind: "indexeddb-quota-and-blocked",
    variants: VARIANTS,
    armed,
    observed,
    buildAuthorityCurrent: buildAuthorityCurrent === true,
  });
}

export async function runControlledStorageRollbackDrills(
  session,
  { timeoutMs = 45_000, beforeDocument } = {},
) {
  if (!beforeDocument
    || typeof beforeDocument.scopeKey !== "string"
    || !Number.isSafeInteger(beforeDocument.documentRevision)
    || !Number.isSafeInteger(beforeDocument.entityCount)) {
    throw new TypeError("controlled storage rollback requires a persisted beforeDocument");
  }
  const startedAt = isoNow();
  const variants = [];
  let currentDocument = beforeDocument;
  for (const variant of VARIANTS) {
    const result = await runVariant(session, variant, currentDocument, timeoutMs);
    variants.push(result);
    const restored = result.coldReloadReceipt.restoredDocument;
    currentDocument = Object.freeze({
      scopeKey: restored.scopeKey,
      documentRevision: restored.documentRevision,
      entityCount: restored.entityCount,
      digest: result.coldReloadReceipt.durableRecord.canonicalBytesDigest,
    });
  }
  const windowEvidence = await session.verifyWindow();
  const buildAuthority = await captureDrillBuildAuthority(session, DRILL_ID);
  const artifact = commonArtifact(
    session,
    DRILL_ID,
    startedAt,
    windowEvidence,
    buildAuthority,
    storageInjectionReceipt(variants, buildAuthority.authoritative),
    { variants: Object.freeze(variants) },
  );
  return Object.freeze({
    drills: Object.freeze([artifact]),
    finalDocument: currentDocument,
  });
}
