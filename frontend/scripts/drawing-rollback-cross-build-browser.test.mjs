import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANARY_TO_LEGACY_DRAWING_KINDS,
  CANARY_TO_LEGACY_TOOL_PLAN,
  canaryCompatibilityStateAccepted,
  canonicalCompatibilityReceipt,
  clearCanaryDrawingInteractionBoundary,
  compatibilitySnapshotReceipt,
  drawingDocumentManifestReceipt,
  exactCanonicalKindIncrement,
  legacyCompatibilityStateAccepted,
  normalizeCrossBuildTransition,
} from "./drawing-rollback-cross-build-browser.mjs";

function canaryRetirement(profileId, profileDirectorySha256 = "a".repeat(64)) {
  return {
    kind: "controlled-canary-retirement",
    schemaVersion: "candlescope-controlled-canary-retirement/v1",
    complete: true,
    processCount: 3,
    allProcessesExited: true,
    diagnosticsClosed: true,
    portCount: 3,
    allOwnedPortsClosed: true,
    profileRetained: true,
    storageFaultCleanupComplete: true,
    profileId,
    profileDirectorySha256,
    failures: [],
  };
}

function savedDrawings() {
  return CANARY_TO_LEGACY_DRAWING_KINDS.map((type, index) => ({
    type,
    id: `phase9-${index + 1}-${type}`,
  }));
}

function stamp(scopeKey, documentRevision) {
  return {
    scopeKey,
    documentRevision,
    surfaceGeneration: 2,
    dataRevision: 3,
    projectionRevision: 4,
    lineageIndexRevision: 5,
    viewportRevision: 6,
    themeRevision: 7,
    widthCssPx: 1200,
    heightCssPx: 700,
    dpr: 1,
  };
}

function canaryState() {
  const scopeKey = "binance:spot:BTCUSDT__main";
  const documentRevision = 12;
  const items = savedDrawings();
  const record = {
    documentSchemaVersion: 1,
    scopeKey,
    documentRevision,
    updatedAt: 0,
    entities: items.map((item) => ({
      id: item.id,
      kind: item.type,
      geometryRevision: 1,
      styleRevision: 1,
      geometry: { kind: item.type },
      style: { kind: item.type },
      bounds: { kind: "deferred" },
    })),
  };
  const currentStamp = stamp(scopeKey, documentRevision);
  const typeCounts = Object.fromEntries(CANARY_TO_LEGACY_DRAWING_KINDS.map((kind) => [kind, 1]));
  const legacyRaw = JSON.stringify(items);
  return {
    record,
    durableRecord: {
      ...record,
      updatedAt: 123456,
      entities: record.entities.map((entity) => ({ ...entity })),
    },
    legacyRaw,
    manifestRaw: JSON.stringify({
      manifestSchemaVersion: 1,
      scopeKey,
      count: items.length,
      revision: documentRevision,
    }),
    compatibilitySnapshot: {
      scopeKey,
      raw: legacyRaw,
      normalizedRaw: legacyRaw,
      record: {
        ...record,
        documentRevision: 0,
        entities: record.entities.map((entity) => ({ ...entity })),
      },
    },
    summary: {
      effectiveEngineMode: "scene-canary",
      scenePublicationReady: true,
      entityCount: items.length,
      typeCounts,
    },
    runtime: {
      queueDepthCurrent: 0,
      inFlightCurrent: 0,
      lastRequestedStamp: currentStamp,
      lastPublishedStamp: { ...currentStamp },
      lastPaintedStamp: { ...currentStamp },
      paintReceipt: {
        kind: "drawing-scene-bridge-paint-ack",
        stamp: { ...currentStamp },
        paintSequence: 4,
      },
      persistence: {
        scopeKey,
        queueDepth: 0,
        inFlightRevision: null,
        pendingRevision: null,
        dirtyRevision: null,
        lastPersistedRevision: documentRevision,
        legacySnapshotRevision: documentRevision,
        lastError: null,
        lastErrorName: null,
        legacySnapshotError: null,
      },
    },
  };
}

test("tool plan covers each canonical kind once and leaves freehand last", () => {
  assert.deepEqual(
    CANARY_TO_LEGACY_TOOL_PLAN.map((operation) => operation.kind).sort(),
    [...CANARY_TO_LEGACY_DRAWING_KINDS].sort(),
  );
  assert.equal(new Set(CANARY_TO_LEGACY_TOOL_PLAN.map((operation) => operation.kind)).size, 9);
  assert.equal(CANARY_TO_LEGACY_TOOL_PLAN.at(-1).kind, "freehand");
  assert.equal(CANARY_TO_LEGACY_TOOL_PLAN.find((operation) => operation.kind === "text").gesture, "text");
  assert.equal(CANARY_TO_LEGACY_TOOL_PLAN.find((operation) => operation.kind === "axis-line").tool, "line-horizontal");
});

test("tool-operation boundary sends two trusted Escape presses before the next gesture", async () => {
  const sends = [];
  const receipt = await clearCanaryDrawingInteractionBoundary({
    cdp: { send: async (method, params) => { sends.push({ method, params }); } },
  });
  assert.equal(receipt.kind, "trusted-escape-selection-boundary");
  assert.equal(receipt.pressCount, 2);
  assert.deepEqual(sends.map((entry) => entry.method), Array(4).fill("Input.dispatchKeyEvent"));
  assert.deepEqual(sends.map((entry) => entry.params.type), ["keyDown", "keyUp", "keyDown", "keyUp"]);
  assert.equal(sends.every((entry) => entry.params.key === "Escape"), true);
});

test("snapshot receipt binds exact bytes, semantic document, ids, order, and all kinds", () => {
  const raw = JSON.stringify(savedDrawings());
  const receipt = compatibilitySnapshotReceipt(raw, {
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 12,
  });
  assert.match(receipt.sourceBytesDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.documentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.entityCount, 9);
  assert.deepEqual(receipt.entityIds, savedDrawings().map((item) => item.id));
  assert.deepEqual(receipt.zOrder, receipt.entityIds);
  assert.deepEqual(receipt.renderedKinds, CANARY_TO_LEGACY_DRAWING_KINDS);
  assert.equal(Object.values(receipt.typeCounts).every((count) => count === 1), true);
});

test("snapshot receipt fails closed for incomplete kinds and duplicate ids", () => {
  assert.throws(
    () => compatibilitySnapshotReceipt(JSON.stringify(savedDrawings().slice(0, 8)), {
      scopeKey: "scope",
    }),
    /nine drawing kinds/,
  );
  const duplicate = savedDrawings();
  duplicate[8].id = duplicate[0].id;
  assert.throws(
    () => compatibilitySnapshotReceipt(JSON.stringify(duplicate), { scopeKey: "scope" }),
    /item is invalid/,
  );
});

test("canonical compatibility projection and manifest bind exact nine-kind semantics", () => {
  const state = canaryState();
  const projection = canonicalCompatibilityReceipt(state.record);
  const snapshot = compatibilitySnapshotReceipt(state.legacyRaw, {
    scopeKey: state.record.scopeKey,
    documentRevision: state.record.documentRevision,
  });
  const manifest = drawingDocumentManifestReceipt(state.manifestRaw, {
    scopeKey: state.record.scopeKey,
  });
  assert.equal(projection.compatibilityDigest, snapshot.documentDigest);
  assert.deepEqual(projection.entityIds, snapshot.entityIds);
  assert.equal(projection.canonicalEntityDigests.length, snapshot.entityCount);
  assert.equal(projection.canonicalEntityDigests.every(
    (value) => /^sha256:[a-f0-9]{64}$/.test(value),
  ), true);
  assert.deepEqual(projection.zOrder, snapshot.zOrder);
  assert.deepEqual(projection.typeCounts, snapshot.typeCounts);
  assert.equal(manifest.revision, state.record.documentRevision);
  assert.equal(manifest.count, state.record.entities.length);
  assert.match(manifest.rawBytesDigest, /^sha256:[a-f0-9]{64}$/);
});

test("canonical compatibility projection preserves every nine-kind geometry/style family", () => {
  const state = canaryState();
  const fields = [
    {
      saved: { lineType: "line-segment", dataPoints: [{ time: 1, value: 2 }], color: "#111", lineWidth: 2 },
      geometry: { lineType: "line-segment", dataPoints: [{ time: 1, value: 2 }] },
      style: { color: "#111", lineWidth: 2 },
    },
    {
      saved: { axisLineType: "horizontal", dataPoint: { time: 2, value: 3 }, color: "#222", lineWidth: 3 },
      geometry: { axisLineType: "horizontal", dataPoint: { time: 2, value: 3 } },
      style: { color: "#222", lineWidth: 3 },
    },
    {
      saved: { dataPoints: [{ time: 3, value: 4 }], color: "#333", lineWidth: 4 },
      geometry: { dataPoints: [{ time: 3, value: 4 }] },
      style: { color: "#333", lineWidth: 4 },
    },
    {
      saved: { dataPoint: { time: 4, value: 5 }, text: "phase9", color: "#444", fontSize: 16, bold: true },
      geometry: { dataPoint: { time: 4, value: 5 } },
      style: { text: "phase9", color: "#444", fontSize: 16, bold: true },
    },
    {
      saved: { dataPoints: [{ time: 5, value: 6 }], inverted: true, color: "#555", lineWidth: 1, levels: [0.5] },
      geometry: { dataPoints: [{ time: 5, value: 6 }], inverted: true },
      style: { color: "#555", lineWidth: 1, levels: [0.5] },
    },
    {
      saved: { direction: "long", entryPrice: 7, tpPrice: 8, slPrice: 6, timeRange: { start: 5, end: 6 }, positionSize: 2, infoPanelOffset: { x: 1, y: 2 } },
      geometry: { direction: "long", entryPrice: 7, tpPrice: 8, slPrice: 6, timeRange: { start: 5, end: 6 } },
      style: { positionSize: 2, infoPanelOffset: { x: 1, y: 2 } },
    },
    {
      saved: { shapeType: "rectangle", dataPoints: [{ time: 7, value: 8 }], color: "#777", lineWidth: 2, fillColor: "#778", fillOpacity: 0.5, lineStyle: "solid" },
      geometry: { shapeType: "rectangle", dataPoints: [{ time: 7, value: 8 }] },
      style: { color: "#777", lineWidth: 2, fillColor: "#778", fillOpacity: 0.5, lineStyle: "solid" },
    },
    {
      saved: { dataPoints: [{ time: 8, value: 9 }], color: "#888", lineWidth: 2 },
      geometry: { dataPoints: [{ time: 8, value: 9 }] },
      style: { color: "#888", lineWidth: 2 },
    },
    {
      saved: { dataPoints: [{ time: 9, value: 10 }], color: "#999", lineWidth: 8, opacity: 0.4, compositeOperation: "source-over", brushShape: "round" },
      geometry: { dataPoints: [{ time: 9, value: 10 }] },
      style: { color: "#999", lineWidth: 8, opacity: 0.4, compositeOperation: "source-over", brushShape: "round" },
    },
  ];
  const items = savedDrawings().map((item, index) => ({ ...item, ...fields[index].saved }));
  const entities = state.record.entities.map((entity, index) => ({
    ...entity,
    geometry: { kind: entity.kind, ...fields[index].geometry },
    style: { kind: entity.kind, ...fields[index].style },
  }));
  const raw = JSON.stringify(items);
  state.record.entities = structuredClone(entities);
  state.durableRecord.entities = structuredClone(entities);
  state.legacyRaw = raw;
  state.compatibilitySnapshot.raw = raw;
  state.compatibilitySnapshot.normalizedRaw = raw;
  state.compatibilitySnapshot.record.entities = structuredClone(entities);
  assert.equal(canaryCompatibilityStateAccepted(state), true);
  assert.equal(
    canonicalCompatibilityReceipt(state.record).compatibilityDigest,
    compatibilitySnapshotReceipt(raw, {
      scopeKey: state.record.scopeKey,
      documentRevision: state.record.documentRevision,
    }).documentDigest,
  );
});

test("exact kind increment rejects a stale wrong tool even when freehand already exists", () => {
  const before = {
    documentSchemaVersion: 1,
    scopeKey: "scope",
    documentRevision: 7,
    updatedAt: 1,
    entities: [{ id: "existing-freehand", kind: "freehand", payload: { x: 1 } }],
  };
  const correct = {
    ...structuredClone(before),
    documentRevision: 8,
    updatedAt: 2,
    entities: [
      ...structuredClone(before.entities),
      { id: "new-freehand", kind: "freehand", payload: { x: 2 } },
    ],
  };
  const increment = exactCanonicalKindIncrement(before, correct, "freehand");
  assert.equal(increment?.committedEntityId, "new-freehand");
  assert.equal(increment?.beforeKindCount, 1);
  assert.equal(increment?.afterKindCount, 2);

  const wrongKind = structuredClone(correct);
  wrongKind.entities.at(-1).kind = "highlighter";
  assert.equal(exactCanonicalKindIncrement(before, wrongKind, "freehand"), null);

  const mutatedExisting = structuredClone(correct);
  mutatedExisting.entities[0].payload.x = 99;
  assert.equal(exactCanonicalKindIncrement(before, mutatedExisting, "freehand"), null);

  const twoNewEntities = structuredClone(correct);
  twoNewEntities.entities.push({ id: "another-freehand", kind: "freehand" });
  assert.equal(exactCanonicalKindIncrement(before, twoNewEntities, "freehand"), null);
});

test("canary acceptance binds IDB, decoded compatibility semantics, manifest, and revision", () => {
  const state = canaryState();
  assert.equal(canaryCompatibilityStateAccepted(state), true);

  const idleSnapshotLag = structuredClone(state);
  idleSnapshotLag.runtime.persistence.legacySnapshotRevision -= 1;
  assert.equal(canaryCompatibilityStateAccepted(idleSnapshotLag), false);

  const dirty = structuredClone(state);
  dirty.runtime.persistence.dirtyRevision = dirty.record.documentRevision;
  assert.equal(canaryCompatibilityStateAccepted(dirty), false);

  const durableMismatch = structuredClone(state);
  durableMismatch.durableRecord.entities[0].kind = "shape";
  assert.equal(canaryCompatibilityStateAccepted(durableMismatch), false);

  const geometryMismatch = structuredClone(state);
  geometryMismatch.record.entities[0].geometry.dataPoints = [{ time: 1, value: 2 }];
  geometryMismatch.durableRecord.entities[0].geometry.dataPoints = [{ time: 1, value: 2 }];
  assert.equal(canaryCompatibilityStateAccepted(geometryMismatch), false);

  const decodedStyleMismatch = structuredClone(state);
  decodedStyleMismatch.compatibilitySnapshot.record.entities[0].style.color = "#f00";
  assert.equal(canaryCompatibilityStateAccepted(decodedStyleMismatch), false);

  const decodedIdMismatch = structuredClone(state);
  decodedIdMismatch.compatibilitySnapshot.record.entities[0].id = "wrong-id";
  assert.equal(canaryCompatibilityStateAccepted(decodedIdMismatch), false);

  const decodedOrderMismatch = structuredClone(state);
  decodedOrderMismatch.compatibilitySnapshot.record.entities.reverse();
  assert.equal(canaryCompatibilityStateAccepted(decodedOrderMismatch), false);

  const manifestMismatch = structuredClone(state);
  manifestMismatch.manifestRaw = JSON.stringify({
    manifestSchemaVersion: 1,
    scopeKey: state.record.scopeKey,
    count: state.record.entities.length,
    revision: state.record.documentRevision - 1,
  });
  assert.equal(canaryCompatibilityStateAccepted(manifestMismatch), false);

  const manifestExtraField = structuredClone(state);
  manifestExtraField.manifestRaw = JSON.stringify({
    ...JSON.parse(state.manifestRaw),
    digest: "not-a-production-manifest-field",
  });
  assert.equal(canaryCompatibilityStateAccepted(manifestExtraField), false);
});

test("legacy acceptance requires exact bytes, nine runtime kinds, instances, and attachments", () => {
  const canary = canaryState();
  const expected = compatibilitySnapshotReceipt(canary.legacyRaw, {
    scopeKey: canary.record.scopeKey,
    documentRevision: canary.record.documentRevision,
  });
  const expectedCanonical = canonicalCompatibilityReceipt(canary.record);
  const legacy = {
    legacyRaw: canary.legacyRaw,
    compatibilitySnapshot: structuredClone(canary.compatibilitySnapshot),
    summary: {
      effectiveEngineMode: "legacy",
      entityCount: 9,
      typeCounts: { ...canary.summary.typeCounts },
    },
    legacyEvidence: {
      registryKind: "legacy-compatible",
      instanceCount: 9,
      attachedCount: 9,
    },
  };
  assert.equal(legacyCompatibilityStateAccepted(legacy, expected, expectedCanonical), true);

  const untrustedAttachment = structuredClone(legacy);
  untrustedAttachment.legacyEvidence.attachedCount = 0;
  assert.equal(legacyCompatibilityStateAccepted(
    untrustedAttachment,
    expected,
    expectedCanonical,
  ), false);

  const rewritten = structuredClone(legacy);
  rewritten.legacyRaw = `${legacy.legacyRaw} `;
  assert.equal(legacyCompatibilityStateAccepted(rewritten, expected, expectedCanonical), false);

  const semanticMismatch = structuredClone(legacy);
  semanticMismatch.compatibilitySnapshot.record.entities[1].style.color = "#123456";
  assert.equal(legacyCompatibilityStateAccepted(
    semanticMismatch,
    expected,
    expectedCanonical,
  ), false);
});

test("controlled restart receipt preserves native contract and process evidence", () => {
  const transition = normalizeCrossBuildTransition({
    profileId: "controlled-profile",
    origin: "http://127.0.0.1:15173",
    canaryRetirement: canaryRetirement("controlled-profile"),
    restartReceipts: {
      browser: {
        kind: "browser-restart",
        profileId: "controlled-profile",
        profileDirectorySha256: "a".repeat(64),
        beforeInstanceId: "headed-chrome:100",
        afterInstanceId: "headed-chrome:200",
        stoppedAt: "2026-07-17T02:00:00.000Z",
        startedAt: "2026-07-17T02:00:02.000Z",
        beforeProcess: { pid: 100, exited: true },
        afterProcess: { pid: 200, running: true },
      },
      server: {
        kind: "server-restart",
        profileId: "controlled-profile",
        beforeInstanceId: "managed-servers:101:102",
        afterInstanceId: "managed-servers:201:202",
        stoppedAt: "2026-07-17T02:00:01.000Z",
        startedAt: "2026-07-17T02:00:03.000Z",
        beforeProcess: { exited: true },
        afterProcess: { running: true },
      },
    },
  });
  assert.equal(transition.browser.kind, "browser-restart");
  assert.equal(transition.browser.beforeProcess.exited, true);
  assert.equal(transition.server.kind, "server-restart");
  assert.equal(transition.server.afterProcess.running, true);
});

test("restart receipt rejects changed profile, reused process, or reversed time", () => {
  const valid = {
    profileId: "profile",
    origin: "http://127.0.0.1:15173",
    canaryRetirement: canaryRetirement("profile"),
    restartReceipts: {
      browser: {
        kind: "browser-restart",
        profileId: "profile",
        profileDirectorySha256: "a".repeat(64),
        beforeInstanceId: "browser-a",
        afterInstanceId: "browser-b",
        stoppedAt: "2026-07-17T02:00:00.000Z",
        startedAt: "2026-07-17T02:00:01.000Z",
      },
      server: {
        kind: "server-restart",
        profileId: "profile",
        beforeInstanceId: "server-a",
        afterInstanceId: "server-b",
        stoppedAt: "2026-07-17T02:00:00.000Z",
        startedAt: "2026-07-17T02:00:01.000Z",
      },
    },
  };
  const changedProfile = structuredClone(valid);
  changedProfile.restartReceipts.server.profileId = "other";
  assert.throws(() => normalizeCrossBuildTransition(changedProfile), /invalid/);

  const reusedBrowser = structuredClone(valid);
  reusedBrowser.restartReceipts.browser.afterInstanceId = "browser-a";
  assert.throws(() => normalizeCrossBuildTransition(reusedBrowser), /invalid/);

  const reversed = structuredClone(valid);
  reversed.restartReceipts.server.startedAt = "2026-07-17T01:59:59.000Z";
  assert.throws(() => normalizeCrossBuildTransition(reversed), /invalid/);
});

test("producer contains no storage mutation or database deletion escape hatch", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("./drawing-rollback-cross-build-browser.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /localStorage\s*\.\s*setItem\s*\(/);
  assert.doesNotMatch(source, /indexedDB\s*\.\s*deleteDatabase\s*\(/);
  assert.doesNotMatch(source, /objectStore\s*\.\s*(?:delete|clear)\s*\(/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /Input\.insertText/);
  assert.match(source, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(source, /restartWithLegacyBuild\(\{\s*scopeKey:/);
});
