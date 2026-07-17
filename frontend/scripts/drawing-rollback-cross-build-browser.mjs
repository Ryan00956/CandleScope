import crypto from "node:crypto";

import {
  captureDrillBuildAuthority,
  runtimeCurrent,
  runtimeSignature,
  waitForSample,
} from "./drawing-rollback-worker-browser.mjs";

export const CANARY_TO_LEGACY_DRILL_ID = "canary-to-legacy-snapshot";
export const CANARY_TO_LEGACY_DRAWING_KINDS = Object.freeze([
  "line",
  "axis-line",
  "angle-measure",
  "text",
  "fibonacci",
  "position",
  "shape",
  "freehand",
  "highlighter",
]);

const DATABASE_NAME = "candlescope-drawings-v2";
const STORE_NAME = "documents";
const LEGACY_STORAGE_PREFIX = "candlescope-drawings";
const MANIFEST_PREFIX = "candlescope-drawings-v2-manifest";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const LINE_TOOL_SELECTOR = [
  "line-segment",
  "line-ray",
  "line-infinite",
  "line-horizontal",
  "line-vertical",
  "line-cross",
  "angle-measure",
].map((tool) => `[data-drawing-tool="${tool}"]`).join(",");
const FREEHAND_TOOL_SELECTOR = ["pen", "highlighter"]
  .map((tool) => `[data-drawing-tool="${tool}"]`).join(",");
const SHAPE_TOOL_SELECTOR = ["shape-rectangle", "shape-ellipse"]
  .map((tool) => `[data-drawing-tool="${tool}"]`).join(",");
const POSITION_TOOL_SELECTOR = ["position-long", "position-short"]
  .map((tool) => `[data-drawing-tool="${tool}"]`).join(",");

export const CANARY_TO_LEGACY_TOOL_PLAN = Object.freeze([
  Object.freeze({ kind: "line", tool: "line-segment", groupSelector: LINE_TOOL_SELECTOR, gesture: "two-point", points: [[0.16, 0.18], [0.31, 0.30]] }),
  Object.freeze({ kind: "axis-line", tool: "line-horizontal", groupSelector: LINE_TOOL_SELECTOR, gesture: "single-point", points: [[0.43, 0.22]] }),
  Object.freeze({ kind: "angle-measure", tool: "angle-measure", groupSelector: LINE_TOOL_SELECTOR, gesture: "two-point", points: [[0.51, 0.18], [0.64, 0.34]] }),
  Object.freeze({ kind: "text", tool: "text", gesture: "text", points: [[0.18, 0.45]] }),
  Object.freeze({ kind: "fibonacci", tool: "fibonacci", gesture: "two-point", points: [[0.34, 0.43], [0.49, 0.61]] }),
  Object.freeze({ kind: "position", tool: "position-long", groupSelector: POSITION_TOOL_SELECTOR, gesture: "single-point", points: [[0.62, 0.48]] }),
  Object.freeze({ kind: "shape", tool: "shape-rectangle", groupSelector: SHAPE_TOOL_SELECTOR, gesture: "two-point", points: [[0.70, 0.18], [0.84, 0.34]] }),
  Object.freeze({ kind: "highlighter", tool: "highlighter", groupSelector: FREEHAND_TOOL_SELECTOR, gesture: "stroke", points: [[0.18, 0.72], [0.39, 0.65]] }),
  Object.freeze({ kind: "freehand", tool: "pen", groupSelector: FREEHAND_TOOL_SELECTOR, gesture: "stroke", points: [[0.57, 0.72], [0.80, 0.62]] }),
]);

const CANONICAL_COMPATIBILITY_FIELDS = Object.freeze({
  line: Object.freeze({
    geometry: Object.freeze(["lineType", "dataPoints"]),
    style: Object.freeze(["color", "lineWidth"]),
  }),
  "axis-line": Object.freeze({
    geometry: Object.freeze(["axisLineType", "dataPoint"]),
    style: Object.freeze(["color", "lineWidth"]),
  }),
  "angle-measure": Object.freeze({
    geometry: Object.freeze(["dataPoints"]),
    style: Object.freeze(["color", "lineWidth"]),
  }),
  text: Object.freeze({
    geometry: Object.freeze(["dataPoint"]),
    style: Object.freeze([
      "text", "color", "fontSize", "fontFamily", "bold", "italic", "underline", "align",
      "bgColor", "borderColor", "borderWidth", "widthPx", "padding",
    ]),
  }),
  fibonacci: Object.freeze({
    geometry: Object.freeze(["dataPoints", "inverted"]),
    style: Object.freeze(["color", "lineWidth", "levels"]),
  }),
  position: Object.freeze({
    geometry: Object.freeze(["direction", "entryPrice", "tpPrice", "slPrice", "timeRange"]),
    style: Object.freeze(["positionSize", "infoPanelOffset"]),
  }),
  shape: Object.freeze({
    geometry: Object.freeze(["shapeType", "dataPoints"]),
    style: Object.freeze(["color", "lineWidth", "fillColor", "fillOpacity", "lineStyle"]),
  }),
  freehand: Object.freeze({
    geometry: Object.freeze(["stroke", "dataPoints"]),
    style: Object.freeze(["color", "lineWidth"]),
  }),
  highlighter: Object.freeze({
    geometry: Object.freeze(["stroke", "dataPoints"]),
    style: Object.freeze([
      "color", "lineWidth", "opacity", "compositeOperation", "brushShape",
    ]),
  }),
});

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

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

function digestUtf8(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digestJson(value) {
  return digestUtf8(JSON.stringify(canonicalize(value)));
}

function typeCountsFromItems(items) {
  const counts = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return Object.freeze(counts);
}

function exactKindCoverage(typeCounts) {
  return CANARY_TO_LEGACY_DRAWING_KINDS.every((kind) => (
    Number.isSafeInteger(typeCounts?.[kind]) && typeCounts[kind] > 0
  ));
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => nonEmptyString(value) && value === right[index]);
}

function sameTypeCounts(left, right) {
  return objectValue(left) !== null
    && objectValue(right) !== null
    && CANARY_TO_LEGACY_DRAWING_KINDS.every((kind) => left[kind] === right[kind])
    && Object.keys(left).every((kind) => CANARY_TO_LEGACY_DRAWING_KINDS.includes(kind))
    && Object.keys(right).every((kind) => CANARY_TO_LEGACY_DRAWING_KINDS.includes(kind));
}

export function compatibilitySnapshotReceipt(raw, { scopeKey, documentRevision = null } = {}) {
  if (!nonEmptyString(scopeKey) || !nonEmptyString(raw)) {
    throw new TypeError("compatibility snapshot scope/raw bytes are missing");
  }
  let items;
  try { items = JSON.parse(raw); } catch (error) {
    throw new TypeError("compatibility snapshot is not JSON", { cause: error });
  }
  if (!Array.isArray(items) || items.length < CANARY_TO_LEGACY_DRAWING_KINDS.length) {
    throw new TypeError("compatibility snapshot does not contain the nine drawing kinds");
  }
  const ids = [];
  const seenIds = new Set();
  for (const item of items) {
    if (!objectValue(item)
      || !CANARY_TO_LEGACY_DRAWING_KINDS.includes(item.type)
      || !nonEmptyString(item.id)
      || seenIds.has(item.id)) {
      throw new TypeError(`compatibility snapshot item is invalid: ${JSON.stringify(item)}`);
    }
    seenIds.add(item.id);
    ids.push(item.id);
  }
  const typeCounts = typeCountsFromItems(items);
  if (!exactKindCoverage(typeCounts)) {
    throw new TypeError(`compatibility snapshot kind coverage is incomplete: ${JSON.stringify(typeCounts)}`);
  }
  if (documentRevision !== null
    && (!Number.isSafeInteger(documentRevision) || documentRevision <= 0)) {
    throw new TypeError("compatibility snapshot document revision is invalid");
  }
  return Object.freeze({
    kind: "strict-saved-drawing-array",
    scopeKey,
    storageKey: `${LEGACY_STORAGE_PREFIX}-${scopeKey}`,
    documentRevision,
    entityCount: items.length,
    entityIds: Object.freeze(ids),
    zOrder: Object.freeze([...ids]),
    renderedKinds: CANARY_TO_LEGACY_DRAWING_KINDS,
    typeCounts,
    sourceBytesDigest: digestUtf8(raw),
    documentDigest: digestJson(items),
    sourceBytesLength: raw.length,
  });
}

function canonicalCompatibilityItem(entity) {
  const source = objectValue(entity);
  const kind = source?.kind;
  const fields = CANONICAL_COMPATIBILITY_FIELDS[kind];
  const geometry = objectValue(source?.geometry);
  const style = objectValue(source?.style);
  if (!source
    || !fields
    || !nonEmptyString(source.id)
    || !Number.isSafeInteger(source.geometryRevision)
    || source.geometryRevision < 0
    || !Number.isSafeInteger(source.styleRevision)
    || source.styleRevision < 0
    || !geometry
    || !style
    || geometry.kind !== kind
    || style.kind !== kind) return null;
  const allowedGeometry = new Set(["kind", ...fields.geometry]);
  const allowedStyle = new Set(["kind", ...fields.style]);
  if (Object.keys(geometry).some((key) => !allowedGeometry.has(key))
    || Object.keys(style).some((key) => !allowedStyle.has(key))
    || ((kind === "freehand" || kind === "highlighter")
      && geometry.stroke !== undefined
      && geometry.dataPoints !== undefined)) return null;
  const item = { type: kind, id: source.id };
  for (const key of fields.geometry) {
    if (geometry[key] !== undefined) item[key] = geometry[key];
  }
  for (const key of fields.style) {
    if (style[key] !== undefined) item[key] = style[key];
  }
  return Object.freeze(item);
}

/**
 * Independently project the persisted canonical record through the production
 * SavedDrawing field contract. Revisions/bounds remain part of recordDigest,
 * while compatibilityDigest contains exactly the semantics the legacy wire
 * format is capable of preserving.
 */
function compatibilitySemanticReceipt(record) {
  if (!objectValue(record)
    || !nonEmptyString(record.scopeKey)
    || !Number.isSafeInteger(record.documentRevision)
    || record.documentRevision < 0
    || !Array.isArray(record.entities)) {
    throw new TypeError("canonical compatibility record is invalid");
  }
  const items = [];
  const ids = new Set();
  for (const entity of record.entities) {
    const item = canonicalCompatibilityItem(entity);
    if (!item || ids.has(item.id)) {
      throw new TypeError("canonical compatibility entity is invalid or duplicated");
    }
    ids.add(item.id);
    items.push(item);
  }
  const typeCounts = typeCountsFromItems(items);
  if (!exactKindCoverage(typeCounts)) {
    throw new TypeError("canonical compatibility kind coverage is incomplete");
  }
  const entityIds = Object.freeze(items.map((item) => item.id));
  return Object.freeze({
    scopeKey: record.scopeKey,
    documentRevision: record.documentRevision,
    entityCount: items.length,
    entityIds,
    canonicalEntityDigests: Object.freeze(record.entities.map((entity) => digestJson(entity))),
    zOrder: Object.freeze([...entityIds]),
    typeCounts,
    compatibilityDigest: digestJson(items),
  });
}

export function canonicalCompatibilityReceipt(record) {
  const identity = recordIdentity(record);
  if (!identity) throw new TypeError("canonical compatibility record is invalid");
  const semantic = compatibilitySemanticReceipt(record);
  return Object.freeze({
    kind: "canonical-compatibility-projection",
    ...semantic,
    canonicalRecordDigest: identity.digest,
  });
}

export function drawingDocumentManifestReceipt(raw, { scopeKey = null } = {}) {
  if (!nonEmptyString(raw)) throw new TypeError("drawing document manifest bytes are missing");
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    throw new TypeError("drawing document manifest is not JSON", { cause: error });
  }
  const manifest = objectValue(value);
  const keys = manifest ? Object.keys(manifest).sort() : [];
  if (!manifest
    || JSON.stringify(keys) !== JSON.stringify([
      "count", "manifestSchemaVersion", "revision", "scopeKey",
    ])
    || manifest.manifestSchemaVersion !== 1
    || !nonEmptyString(manifest.scopeKey)
    || (scopeKey !== null && manifest.scopeKey !== scopeKey)
    || !Number.isSafeInteger(manifest.count)
    || manifest.count < 0
    || !Number.isSafeInteger(manifest.revision)
    || manifest.revision < 0) {
    throw new TypeError("drawing document manifest is invalid");
  }
  return Object.freeze({
    kind: "drawing-document-manifest",
    manifestSchemaVersion: 1,
    scopeKey: manifest.scopeKey,
    revision: manifest.revision,
    count: manifest.count,
    rawBytesDigest: digestUtf8(raw),
    rawBytesLength: raw.length,
  });
}

function recordKinds(record) {
  const entities = Array.isArray(record?.entities) ? record.entities : [];
  return new Set(entities.map((entity) => entity?.kind).filter(nonEmptyString));
}

function recordIdentity(record) {
  if (!objectValue(record)
    || !nonEmptyString(record.scopeKey)
    || !Number.isSafeInteger(record.documentRevision)
    || record.documentRevision <= 0
    || !Array.isArray(record.entities)) return null;
  return Object.freeze({
    scopeKey: record.scopeKey,
    documentRevision: record.documentRevision,
    entityCount: record.entities.length,
    digest: digestJson({ ...record, updatedAt: 0 }),
  });
}

function sameRecordIdentity(left, right) {
  const a = recordIdentity(left);
  const b = recordIdentity(right);
  return a !== null && b !== null
    && a.scopeKey === b.scopeKey
    && a.documentRevision === b.documentRevision
    && a.entityCount === b.entityCount
    && a.digest === b.digest;
}

function compatibilitySnapshotMatchesCanonical(snapshot, canonical) {
  return snapshot?.scopeKey === canonical?.scopeKey
    && snapshot?.documentRevision === canonical?.documentRevision
    && snapshot?.entityCount === canonical?.entityCount
    && snapshot?.documentDigest === canonical?.compatibilityDigest
    && sameStringArray(snapshot?.entityIds, canonical?.entityIds)
    && sameStringArray(snapshot?.zOrder, canonical?.zOrder)
    && sameTypeCounts(snapshot?.typeCounts, canonical?.typeCounts);
}

function manifestMatchesCanonical(manifest, canonical) {
  return manifest?.scopeKey === canonical?.scopeKey
    && manifest?.revision === canonical?.documentRevision
    && manifest?.count === canonical?.entityCount;
}

function decodedCompatibilityMatchesCanonical(state, canonical) {
  const decoded = state?.compatibilitySnapshot;
  if (!objectValue(decoded)
    || decoded.scopeKey !== canonical?.scopeKey
    || decoded.raw !== state?.legacyRaw
    || decoded.normalizedRaw !== state?.legacyRaw) return false;
  try {
    const semantic = compatibilitySemanticReceipt(decoded.record);
    return semantic.scopeKey === canonical.scopeKey
      && semantic.entityCount === canonical.entityCount
      && semantic.compatibilityDigest === canonical.compatibilityDigest
      && sameStringArray(semantic.entityIds, canonical.entityIds)
      && sameStringArray(semantic.zOrder, canonical.zOrder)
      && sameTypeCounts(semantic.typeCounts, canonical.typeCounts);
  } catch {
    return false;
  }
}

export function exactCanonicalKindIncrement(beforeRecord, afterRecord, expectedKind) {
  const beforeIdentity = recordIdentity(beforeRecord);
  const afterIdentity = recordIdentity(afterRecord);
  if (!beforeIdentity
    || !afterIdentity
    || !CANARY_TO_LEGACY_DRAWING_KINDS.includes(expectedKind)
    || beforeIdentity.scopeKey !== afterIdentity.scopeKey
    || afterIdentity.documentRevision <= beforeIdentity.documentRevision
    || afterIdentity.entityCount !== beforeIdentity.entityCount + 1) return null;
  const beforeEntities = beforeRecord.entities;
  const afterEntities = afterRecord.entities;
  const beforeById = new Map();
  const afterById = new Map();
  for (const entity of beforeEntities) {
    if (!objectValue(entity)
      || !nonEmptyString(entity.id)
      || !CANARY_TO_LEGACY_DRAWING_KINDS.includes(entity.kind)
      || beforeById.has(entity.id)) return null;
    beforeById.set(entity.id, entity);
  }
  for (const entity of afterEntities) {
    if (!objectValue(entity)
      || !nonEmptyString(entity.id)
      || !CANARY_TO_LEGACY_DRAWING_KINDS.includes(entity.kind)
      || afterById.has(entity.id)) return null;
    afterById.set(entity.id, entity);
  }
  const committed = afterEntities.filter((entity) => !beforeById.has(entity.id));
  if (committed.length !== 1 || committed[0].kind !== expectedKind) return null;
  const preservedAfterOrder = afterEntities
    .filter((entity) => beforeById.has(entity.id))
    .map((entity) => entity.id);
  if (!sameStringArray(preservedAfterOrder, beforeEntities.map((entity) => entity.id))) return null;
  for (const [id, entity] of beforeById) {
    if (digestJson(entity) !== digestJson(afterById.get(id))) return null;
  }
  const beforeCounts = typeCountsFromItems(beforeEntities.map((entity) => ({ type: entity.kind })));
  const afterCounts = typeCountsFromItems(afterEntities.map((entity) => ({ type: entity.kind })));
  if (!CANARY_TO_LEGACY_DRAWING_KINDS.every((kind) => (
    (afterCounts[kind] ?? 0)
      === (beforeCounts[kind] ?? 0) + (kind === expectedKind ? 1 : 0)
  ))) return null;
  const committedEntity = committed[0];
  return Object.freeze({
    kind: "exact-canonical-kind-increment",
    expectedKind,
    scopeKey: beforeIdentity.scopeKey,
    beforeEntityCount: beforeIdentity.entityCount,
    afterEntityCount: afterIdentity.entityCount,
    beforeKindCount: beforeCounts[expectedKind] ?? 0,
    afterKindCount: afterCounts[expectedKind] ?? 0,
    beforeDocumentRevision: beforeIdentity.documentRevision,
    afterDocumentRevision: afterIdentity.documentRevision,
    beforeRecordDigest: beforeIdentity.digest,
    afterRecordDigest: afterIdentity.digest,
    committedEntityId: committedEntity.id,
    committedEntityKind: committedEntity.kind,
    committedEntityDigest: digestJson(committedEntity),
  });
}

export function canaryCompatibilityStateAccepted(state) {
  const record = state?.record;
  const durableRecord = state?.durableRecord;
  const identity = recordIdentity(record);
  const persistence = state?.runtime?.persistence;
  if (!identity || !sameRecordIdentity(record, durableRecord)) return false;
  let snapshot;
  let canonical;
  let manifest;
  try {
    canonical = canonicalCompatibilityReceipt(record);
    snapshot = compatibilitySnapshotReceipt(state?.legacyRaw, {
      scopeKey: identity.scopeKey,
      documentRevision: identity.documentRevision,
    });
    manifest = drawingDocumentManifestReceipt(state?.manifestRaw, {
      scopeKey: identity.scopeKey,
    });
  } catch {
    return false;
  }
  return state?.summary?.effectiveEngineMode === "scene-canary"
    && state.summary.scenePublicationReady === true
    && state.summary.entityCount === identity.entityCount
    && exactKindCoverage(state.summary.typeCounts)
    && runtimeCurrent(state.runtime)
    && state.runtime.lastRequestedStamp?.scopeKey === identity.scopeKey
    && state.runtime.lastRequestedStamp?.documentRevision === identity.documentRevision
    && persistence?.scopeKey === identity.scopeKey
    && persistence?.queueDepth === 0
    && persistence?.inFlightRevision === null
    && persistence?.pendingRevision === null
    && persistence?.dirtyRevision === null
    && persistence?.lastPersistedRevision === identity.documentRevision
    && persistence?.legacySnapshotRevision === identity.documentRevision
    && persistence?.lastError === null
    && persistence?.lastErrorName === null
    && persistence?.legacySnapshotError === null
    && compatibilitySnapshotMatchesCanonical(snapshot, canonical)
    && decodedCompatibilityMatchesCanonical(state, canonical)
    && manifestMatchesCanonical(manifest, canonical);
}

export function legacyCompatibilityStateAccepted(state, expectedSnapshot, expectedCanonical = null) {
  if (!expectedSnapshot || !SHA256_PATTERN.test(expectedSnapshot.sourceBytesDigest)) return false;
  let actual;
  try {
    actual = compatibilitySnapshotReceipt(state?.legacyRaw, {
      scopeKey: expectedSnapshot.scopeKey,
    });
  } catch {
    return false;
  }
  const evidence = state?.legacyEvidence;
  return actual.sourceBytesDigest === expectedSnapshot.sourceBytesDigest
    && actual.documentDigest === expectedSnapshot.documentDigest
    && actual.entityCount === expectedSnapshot.entityCount
    && JSON.stringify(actual.entityIds) === JSON.stringify(expectedSnapshot.entityIds)
    && state?.summary?.effectiveEngineMode === "legacy"
    && state.summary.entityCount === expectedSnapshot.entityCount
    && exactKindCoverage(state.summary.typeCounts)
    && evidence?.registryKind === "legacy-compatible"
    && evidence?.instanceCount === expectedSnapshot.entityCount
    && evidence?.attachedCount === expectedSnapshot.entityCount
    && (expectedCanonical === null
      || decodedCompatibilityMatchesCanonical(state, expectedCanonical));
}

function browserStateExpression(scopeKey = null) {
  return `(async () => {
    const requestedScope = ${JSON.stringify(scopeKey)};
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const runtime = handle && typeof handle.readPhase6Runtime === 'function'
      ? handle.readPhase6Runtime()
      : null;
    const summary = handle && typeof handle.readRuntimeSummary === 'function'
      ? handle.readRuntimeSummary()
      : null;
    const record = handle && typeof handle.readActivePersistenceDocumentRecord === 'function'
      ? handle.readActivePersistenceDocumentRecord()
      : null;
    const compatibilitySnapshot = handle
      && typeof handle.readActiveLegacyCompatibilitySnapshot === 'function'
      ? handle.readActiveLegacyCompatibilitySnapshot()
      : null;
    const scope = requestedScope || record?.scopeKey || runtime?.lastRequestedStamp?.scopeKey || null;
    let durableRecord = null;
    if (scope && typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      if (databases.some((database) => database?.name === ${JSON.stringify(DATABASE_NAME)})) {
        const request = indexedDB.open(${JSON.stringify(DATABASE_NAME)});
        const database = await new Promise((resolve, reject) => {
          request.onerror = () => reject(request.error || new Error('drawing database open failed'));
          request.onblocked = () => reject(new Error('drawing database open blocked'));
          request.onsuccess = () => resolve(request.result);
        });
        try {
          if (database.objectStoreNames.contains(${JSON.stringify(STORE_NAME)})) {
            const transaction = database.transaction(${JSON.stringify(STORE_NAME)}, 'readonly');
            const get = transaction.objectStore(${JSON.stringify(STORE_NAME)}).get(scope);
            durableRecord = await new Promise((resolve, reject) => {
              get.onerror = () => reject(get.error || new Error('drawing record read failed'));
              get.onsuccess = () => resolve(get.result || null);
            });
            await new Promise((resolve, reject) => {
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error || new Error('drawing read failed'));
              transaction.onabort = () => reject(transaction.error || new Error('drawing read aborted'));
            });
          }
        } finally {
          database.close();
        }
      }
    }
    const registry = document.querySelector('[data-drawing-registry-kind]');
    const numberAttribute = (name) => {
      const raw = registry?.getAttribute(name);
      if (raw === null || raw === '') return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const liveLegacy = summary?.effectiveEngineMode === 'legacy';
    const summaryInstanceCount = Number.isSafeInteger(summary?.entityCount)
      && summary.entityCount >= 0 ? summary.entityCount : null;
    const summaryAttachedCount = Number.isSafeInteger(summary?.attachedPrimitiveCount)
      && summary.attachedPrimitiveCount >= 0 ? summary.attachedPrimitiveCount : null;
    const legacyRaw = scope
      ? localStorage.getItem(${JSON.stringify(`${LEGACY_STORAGE_PREFIX}-`)} + scope)
      : null;
    const manifestRaw = scope
      ? localStorage.getItem(${JSON.stringify(`${MANIFEST_PREFIX}-`)} + encodeURIComponent(scope))
      : null;
    return {
      observedAt: new Date().toISOString(),
      origin: location.origin,
      href: location.href,
      scopeKey: scope,
      runtime,
      summary,
      record,
      durableRecord,
      compatibilitySnapshot,
      legacyRaw,
      manifestRaw,
      legacyEvidence: {
        registryKind: liveLegacy
          ? 'legacy-compatible'
          : registry?.getAttribute('data-drawing-registry-kind') || null,
        instanceCount: liveLegacy
          ? summaryInstanceCount
          : numberAttribute('data-drawing-legacy-instances'),
        attachedCount: liveLegacy
          ? summaryAttachedCount
          : numberAttribute('data-drawing-legacy-attached'),
        zeroLegacy: registry?.getAttribute('data-drawing-zero-legacy') || null,
        source: liveLegacy ? 'runtime-summary' : 'rendered-attributes'
      },
      textEditorPresent: Boolean(document.querySelector('.text-edit-input'))
    };
  })()`;
}

export async function readCanaryToLegacyBrowserState(session, scopeKey = null) {
  return session.cdp.evaluateJson(browserStateExpression(scopeKey));
}

async function readElementCenter(session, selector) {
  return session.cdp.evaluateJson(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.hidden) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      disabled: element instanceof HTMLButtonElement ? element.disabled : false
    };
  })()`);
}

async function dispatchTrustedClick(session, selector, { button = "left" } = {}) {
  const center = await readElementCenter(session, selector);
  if (!center || center.disabled) {
    throw new Error(`drawing rollback UI element is unavailable: ${selector}`);
  }
  const buttons = button === "right" ? 2 : 1;
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: center.x, y: center.y, button: "none", buttons: 0,
  });
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: center.x, y: center.y, button, buttons, clickCount: 1,
  });
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: center.x, y: center.y, button, buttons: 0, clickCount: 1,
  });
  return Object.freeze({ selector, button, x: center.x, y: center.y, observedAt: new Date().toISOString() });
}

async function waitForExpression(session, expression, timeoutMs, description) {
  const result = await waitForSample(
    () => session.cdp.evaluate(expression),
    (value) => value === true,
    { timeoutMs: Math.min(timeoutMs, 5_000), description },
  );
  return result.value;
}

async function activateTool(session, operation, timeoutMs) {
  const targetSelector = `[data-drawing-tool="${operation.tool}"]`;
  if (operation.groupSelector) {
    const selectedAlready = await session.cdp.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(targetSelector)}))`,
    );
    if (!selectedAlready) {
      await dispatchTrustedClick(session, operation.groupSelector, { button: "right" });
      const variantSelector = `[data-tool-variant="${operation.tool}"]`;
      await waitForExpression(
        session,
        `Boolean(document.querySelector(${JSON.stringify(variantSelector)}))`,
        timeoutMs,
        `${operation.tool} flyout variant`,
      );
      await dispatchTrustedClick(session, variantSelector);
    }
  }
  const active = await session.cdp.evaluate(
    `Boolean(document.querySelector(${JSON.stringify(`${targetSelector}.active`)}))`,
  );
  if (!active) await dispatchTrustedClick(session, targetSelector);
  await waitForExpression(
    session,
    `Boolean(document.querySelector(${JSON.stringify(`${targetSelector}.active`)}))`,
    timeoutMs,
    `${operation.tool} activation`,
  );
  return Object.freeze({ kind: operation.kind, tool: operation.tool, activatedAt: new Date().toISOString() });
}

export async function clearCanaryDrawingInteractionBoundary(session) {
  const requestedAt = new Date().toISOString();
  for (let press = 0; press < 2; press += 1) {
    for (const type of ["keyDown", "keyUp"]) {
      await session.cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
  }
  return Object.freeze({
    kind: "trusted-escape-selection-boundary",
    pressCount: 2,
    requestedAt,
    completedAt: new Date().toISOString(),
  });
}

async function settleActivatedTool(session, operation, timeoutMs) {
  const targetSelector = `[data-drawing-tool="${operation.tool}"].active`;
  const requestedAt = new Date().toISOString();
  await session.cdp.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
  );
  await waitForExpression(
    session,
    `Boolean(document.querySelector(${JSON.stringify(targetSelector)}))`,
    timeoutMs,
    `${operation.tool} post-selection activation`,
  );
  return Object.freeze({
    kind: "drawing-tool-effect-settlement",
    tool: operation.tool,
    requestedAt,
    settledAt: new Date().toISOString(),
    activeSelector: targetSelector,
  });
}

async function readPlotRect(session) {
  const rect = await session.cdp.evaluateJson(`(() => {
    const chart = document.querySelector(
      '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]'
    );
    if (!(chart instanceof HTMLElement)) return null;
    const value = chart.getBoundingClientRect();
    return value.width > 300 && value.height > 200
      ? { x: value.x, y: value.y, width: value.width, height: value.height }
      : null;
  })()`);
  if (!rect) throw new Error("canary-to-legacy chart plot is unavailable");
  return rect;
}

function plotPoint(rect, fraction) {
  return Object.freeze({
    x: Math.round(rect.x + rect.width * fraction[0]),
    y: Math.round(rect.y + rect.height * fraction[1]),
  });
}

async function dispatchPlotClick(session, point) {
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0,
  });
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
  });
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function dispatchStroke(session, start, end) {
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: start.x, y: start.y, button: "none", buttons: 0,
  });
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 10; step += 1) {
    await session.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(start.x + ((end.x - start.x) * step) / 10),
      y: Math.round(start.y + ((end.y - start.y) * step) / 10),
      button: "none",
      buttons: 1,
    });
  }
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function commitText(session, marker, timeoutMs) {
  await waitForExpression(
    session,
    "Boolean(document.querySelector('.text-edit-input'))",
    timeoutMs,
    "drawing text editor",
  );
  await dispatchTrustedClick(session, ".text-edit-input");
  await session.cdp.send("Input.insertText", { text: marker });
  await session.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 2,
  });
  await session.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 2,
  });
  await waitForExpression(
    session,
    "!document.querySelector('.text-edit-input')",
    timeoutMs,
    "drawing text commit",
  );
}

async function waitForKindIncrement(session, kind, beforeRecord, timeoutMs) {
  const result = await waitForSample(
    () => readCanaryToLegacyBrowserState(session),
    (state) => {
      return exactCanonicalKindIncrement(beforeRecord, state?.record, kind) !== null
        && state?.summary?.effectiveEngineMode === "scene-canary"
        && runtimeCurrent(state?.runtime);
    },
    {
      timeoutMs,
      description: `${kind} canonical scene commit`,
      stableMs: 80,
      signature: (state) => `${state?.record?.documentRevision}:${runtimeSignature(state)}`,
    },
  );
  const increment = exactCanonicalKindIncrement(beforeRecord, result.value?.record, kind);
  if (!increment) throw new Error(`${kind} canonical scene commit lost its exact increment`);
  return Object.freeze({ state: result.value, increment });
}

async function performToolOperation(session, operation, timeoutMs, marker) {
  const before = await readCanaryToLegacyBrowserState(session);
  if (!recordIdentity(before?.record)) {
    throw new Error(`${operation.kind} has no active canonical document`);
  }
  const selectionBoundary = await clearCanaryDrawingInteractionBoundary(session);
  const activation = await activateTool(session, operation, timeoutMs);
  const activationSettlement = await settleActivatedTool(
    session,
    operation,
    timeoutMs,
  );
  const rect = await readPlotRect(session);
  const points = operation.points.map((fraction) => plotPoint(rect, fraction));
  if (operation.gesture === "stroke") {
    await dispatchStroke(session, points[0], points[1]);
  } else if (operation.gesture === "two-point") {
    await dispatchPlotClick(session, points[0]);
    await wait(80);
    await dispatchPlotClick(session, points[1]);
  } else {
    await dispatchPlotClick(session, points[0]);
    if (operation.gesture === "text") await commitText(session, marker, timeoutMs);
  }
  const committed = await waitForKindIncrement(session, operation.kind, before.record, timeoutMs);
  const increment = committed.increment;
  return Object.freeze({
    kind: operation.kind,
    tool: operation.tool,
    gesture: operation.gesture,
    activation,
    selectionBoundary,
    activationSettlement,
    points: Object.freeze(points),
    incrementKind: increment.kind,
    beforeEntityCount: increment.beforeEntityCount,
    afterEntityCount: increment.afterEntityCount,
    beforeKindCount: increment.beforeKindCount,
    afterKindCount: increment.afterKindCount,
    beforeDocumentRevision: increment.beforeDocumentRevision,
    documentRevision: increment.afterDocumentRevision,
    beforeRecordDigest: increment.beforeRecordDigest,
    afterRecordDigest: increment.afterRecordDigest,
    committedEntityId: increment.committedEntityId,
    committedEntityKind: increment.committedEntityKind,
    committedEntityDigest: increment.committedEntityDigest,
    committedAt: new Date().toISOString(),
  });
}

export async function completeCanaryNineKindDocument(session, { timeoutMs = 45_000 } = {}) {
  const initial = await readCanaryToLegacyBrowserState(session);
  const initialIdentity = recordIdentity(initial?.record);
  if (!initialIdentity) {
    throw new Error(`canary-to-legacy active document is unavailable: ${JSON.stringify(initial)}`);
  }
  const operations = [];
  for (const operation of CANARY_TO_LEGACY_TOOL_PLAN) {
    operations.push(await performToolOperation(
      session,
      operation,
      timeoutMs,
      `phase9-canary-legacy-${session.runId}`,
    ));
  }
  const finalOperation = operations.at(-1);
  const finalFreehandMutationObserved = finalOperation?.kind === "freehand"
    && finalOperation?.incrementKind === "exact-canonical-kind-increment"
    && finalOperation?.committedEntityKind === "freehand"
    && finalOperation?.afterEntityCount === finalOperation?.beforeEntityCount + 1
    && finalOperation?.afterKindCount === finalOperation?.beforeKindCount + 1;
  return Object.freeze({
    initialEntityCount: initial.record.entities.length,
    initialEntityIds: Object.freeze(initial.record.entities.map((entity) => entity.id)),
    initialEntityDigests: Object.freeze(initial.record.entities.map((entity) => digestJson(entity))),
    initialRecordDigest: initialIdentity.digest,
    initialKinds: Object.freeze([...recordKinds(initial.record)].sort()),
    operations: Object.freeze(operations),
    finalEntityCount: operations.at(-1)?.afterEntityCount ?? initial.record.entities.length,
    finalFreehandMutationObserved,
  });
}

export async function captureCrossBuildAuthority(session, stage) {
  if (stage !== "canary" && stage !== "legacy") throw new TypeError(`invalid cross-build stage: ${stage}`);
  const captured = await captureDrillBuildAuthority(
    session,
    CANARY_TO_LEGACY_DRILL_ID,
    { requireActiveWorkers: stage === "canary" },
  );
  const expected = stage === "canary"
    ? Object.freeze({ documentAuthority: "document", engineMode: "scene-canary" })
    : Object.freeze({ documentAuthority: "legacy", engineMode: "legacy" });
  const configurationAccepted = captured.documentAuthority === expected.documentAuthority
    && captured.engineMode === expected.engineMode;
  const authority = Object.freeze({
    ...captured,
    stage,
    configurationAccepted,
    authoritative: captured.authoritative && configurationAccepted,
  });
  if (!authority.authoritative) {
    throw new Error(`${stage} cross-build authority failed: ${JSON.stringify(authority)}`);
  }
  return authority;
}

function restartReceipt(transition, kind) {
  const receipts = transition?.restartReceipts ?? transition?.restarts ?? {};
  return receipts?.[kind]
    ?? transition?.[`${kind}Restart`]
    ?? transition?.[`${kind}RestartReceipt`]
    ?? null;
}

export function normalizeCrossBuildTransition(transition) {
  const nativeBrowser = restartReceipt(transition, "browser");
  const nativeServer = restartReceipt(transition, "server");
  if (!['browser', 'browser-restart'].includes(nativeBrowser?.kind)
    || !['server', 'server-restart'].includes(nativeServer?.kind)) {
    throw new TypeError("cross-build browser/server restart receipts are missing");
  }
  const browser = Object.freeze({ ...nativeBrowser });
  const server = Object.freeze({ ...nativeServer });
  const profileId = transition?.profileId ?? browser.profileId ?? server.profileId;
  const origin = transition?.origin
    ?? transition?.managedOrigin
    ?? transition?.builds?.legacy?.origin
    ?? transition?.builds?.canary?.origin;
  const canaryRetirement = transition?.canaryRetirement ?? null;
  if (!nonEmptyString(profileId)
    || browser.profileId !== profileId
    || server.profileId !== profileId
    || !nonEmptyString(origin)
    || !nonEmptyString(browser.beforeInstanceId)
    || !nonEmptyString(browser.afterInstanceId)
    || browser.beforeInstanceId === browser.afterInstanceId
    || !nonEmptyString(server.beforeInstanceId)
    || !nonEmptyString(server.afterInstanceId)
    || server.beforeInstanceId === server.afterInstanceId
    || !Number.isFinite(Date.parse(browser.stoppedAt))
    || !Number.isFinite(Date.parse(browser.startedAt))
    || Date.parse(browser.startedAt) < Date.parse(browser.stoppedAt)
    || !Number.isFinite(Date.parse(server.stoppedAt))
    || !Number.isFinite(Date.parse(server.startedAt))
    || Date.parse(server.startedAt) < Date.parse(server.stoppedAt)
    || canaryRetirement?.kind !== "controlled-canary-retirement"
    || canaryRetirement?.schemaVersion !== "candlescope-controlled-canary-retirement/v1"
    || canaryRetirement?.complete !== true
    || canaryRetirement?.processCount !== 3
    || canaryRetirement?.allProcessesExited !== true
    || canaryRetirement?.diagnosticsClosed !== true
    || canaryRetirement?.portCount !== 3
    || canaryRetirement?.allOwnedPortsClosed !== true
    || canaryRetirement?.profileRetained !== true
    || canaryRetirement?.storageFaultCleanupComplete !== true
    || canaryRetirement?.profileId !== profileId
    || canaryRetirement?.profileDirectorySha256 !== browser.profileDirectorySha256
    || !Array.isArray(canaryRetirement?.failures)
    || canaryRetirement.failures.length !== 0) {
    throw new TypeError(`cross-build restart receipt is invalid: ${JSON.stringify(transition)}`);
  }
  return Object.freeze({
    profileId,
    origin,
    browser: Object.freeze({ ...browser }),
    server: Object.freeze({ ...server }),
    canaryRetirement: Object.freeze({ ...canaryRetirement }),
    canaryBuildReceipt: transition?.builds?.canary
      ?? transition?.canaryBuildReceipt
      ?? transition?.canaryBuild
      ?? null,
    legacyBuildReceipt: transition?.builds?.legacy
      ?? transition?.legacyBuildReceipt
      ?? transition?.legacyBuild
      ?? null,
    processReceipts: Object.freeze({ ...(transition?.processReceipts ?? transition?.processes ?? {}) }),
  });
}

function diagnosticsSnapshot(session) {
  const page = session.diagnostics()?.pageAndWorker ?? {};
  return diagnosticsSnapshotFromPage(page);
}

function diagnosticsSnapshotFromPage(page) {
  return Object.freeze({
    crashCount: Number.isSafeInteger(page.crashCount) ? page.crashCount : -1,
    runtimeExceptions: Object.freeze([...(page.runtimeExceptions ?? [])]),
    unhandledRejections: Object.freeze([...(page.unhandledRejections ?? [])]),
    unexpectedConsoleErrors: Object.freeze([...(page.unexpectedConsoleErrors ?? [])]),
  });
}

function diagnosticsClean(value) {
  return value?.crashCount === 0
    && value.runtimeExceptions?.length === 0
    && value.unhandledRejections?.length === 0
    && value.unexpectedConsoleErrors?.length === 0;
}

function combinedDiagnostics(canary, retirement, legacy) {
  return Object.freeze({
    crashCount: canary.crashCount + retirement.crashCount + legacy.crashCount,
    runtimeExceptions: Object.freeze([
      ...canary.runtimeExceptions,
      ...retirement.runtimeExceptions,
      ...legacy.runtimeExceptions,
    ]),
    unhandledRejections: Object.freeze([
      ...canary.unhandledRejections,
      ...retirement.unhandledRejections,
      ...legacy.unhandledRejections,
    ]),
    unexpectedConsoleErrors: Object.freeze([
      ...canary.unexpectedConsoleErrors,
      ...retirement.unexpectedConsoleErrors,
      ...legacy.unexpectedConsoleErrors,
    ]),
    stages: Object.freeze({ canary, retirement, legacy }),
  });
}

function buildDescriptor(authority, stage, transition) {
  const before = stage === "canary";
  return Object.freeze({
    mode: before ? "scene-canary" : "legacy",
    documentAuthority: authority.documentAuthority,
    engineMode: authority.engineMode,
    interactionSurfaceMode: authority.interactionSurfaceMode,
    rasterBackend: authority.rasterBackend,
    productionBuild: authority.authoritative,
    sourceRevision: authority.gitRevision,
    gitRevision: authority.gitRevision,
    rolloutEnvironment: before ? "controlled-scene-canary-rollout" : "controlled-legacy-rollout",
    buildId: authority.buildId,
    buildFingerprint: authority.buildFingerprint,
    assetDigest: authority.assetDigest,
    buildInputDigest: authority.buildInputDigest,
    origin: transition.origin,
    profileId: transition.profileId,
    browserInstanceId: before
      ? transition.browser.beforeInstanceId
      : transition.browser.afterInstanceId,
    serverInstanceId: before
      ? transition.server.beforeInstanceId
      : transition.server.afterInstanceId,
  });
}

function pairedBuildAuthority(canary, legacy, transition, binding) {
  const canaryBuild = binding.canaryBuild;
  const legacyBuild = binding.legacyBuild;
  const crossBuild = Object.freeze({
    kind: "controlled-cross-build-authority",
    authoritative: canary.authoritative && legacy.authoritative,
    canary,
    legacy,
    profile: Object.freeze({
      kind: "controlled-shared-browser-profile",
      ownership: "controlled-temporary-profile",
      retainedAcrossRestart: true,
      canaryObserved: true,
      legacyObserved: true,
      profileId: transition.profileId,
      profileDirectorySha256: transition.browser.profileDirectorySha256
        ?? transition.server.profileDirectorySha256
        ?? null,
      canaryBrowserInstanceId: canaryBuild.browserInstanceId,
      legacyBrowserInstanceId: legacyBuild.browserInstanceId,
    }),
    origin: Object.freeze({
      kind: "controlled-cross-build-same-origin-authority",
      sameOriginStorageRetained: true,
      managedOrigin: transition.origin,
      canaryObservedOrigin: canary.observedOrigin,
      legacyObservedOrigin: legacy.observedOrigin,
    }),
    browserRestartReceiptId: transition.browser.receiptId,
    serverRestartReceiptId: transition.server.receiptId,
    writeReceiptId: binding.writeReceiptId,
    readReceiptId: binding.readReceiptId,
    scopeKey: binding.snapshot.scopeKey,
    documentDigest: binding.snapshot.documentDigest,
    canonicalRecordDigest: binding.canonical.canonicalRecordDigest,
    canonicalCompatibilityDigest: binding.canonical.compatibilityDigest,
    manifestBytesDigest: binding.manifest.rawBytesDigest,
    sourceBytesDigest: binding.snapshot.sourceBytesDigest,
  });
  return Object.freeze({
    ...legacy,
    authoritative: canary.authoritative && legacy.authoritative,
    pairKind: "controlled-canary-to-legacy-build-authority",
    canary,
    legacy,
    crossBuild,
    sharedOrigin: transition.origin,
    sharedProfileId: transition.profileId,
    restartReceipts: Object.freeze({ browser: transition.browser, server: transition.server }),
  });
}

export async function runControlledCrossBuildRollbackDrill(
  session,
  { timeoutMs = 45_000 } = {},
) {
  if (!session || typeof session.restartWithLegacyBuild !== "function") {
    throw new TypeError("controlled session does not provide restartWithLegacyBuild()");
  }
  const startedAt = new Date().toISOString();
  const canaryNavigation = await session.navigateRollbackDrill(CANARY_TO_LEGACY_DRILL_ID);
  const canaryWindow = await session.verifyWindow();
  const ui = await completeCanaryNineKindDocument(session, { timeoutMs });
  if (!ui.finalFreehandMutationObserved) {
    throw new Error("canary-to-legacy did not finish with a trusted freehand mutation");
  }
  const settledCanary = await waitForSample(
    () => readCanaryToLegacyBrowserState(session),
    canaryCompatibilityStateAccepted,
    {
      timeoutMs,
      description: "latest canary IDB and legacy compatibility snapshot",
      stableMs: 160,
      signature: (state) => `${runtimeSignature(state)}:${state?.runtime?.persistence?.legacySnapshotRevision}:${digestUtf8(state?.legacyRaw ?? "")}`,
    },
  );
  const canaryState = settledCanary.value;
  const canaryIdentity = recordIdentity(canaryState.record);
  const canarySnapshot = compatibilitySnapshotReceipt(canaryState.legacyRaw, {
    scopeKey: canaryIdentity.scopeKey,
    documentRevision: canaryIdentity.documentRevision,
  });
  const canonicalCompatibility = canonicalCompatibilityReceipt(canaryState.record);
  const canaryManifest = drawingDocumentManifestReceipt(canaryState.manifestRaw, {
    scopeKey: canaryIdentity.scopeKey,
  });
  if (!compatibilitySnapshotMatchesCanonical(canarySnapshot, canonicalCompatibility)
    || !manifestMatchesCanonical(canaryManifest, canonicalCompatibility)) {
    throw new Error("canary compatibility snapshot/manifest lost canonical document semantics");
  }
  const canaryAuthority = await captureCrossBuildAuthority(session, "canary");
  const canaryDiagnostics = diagnosticsSnapshot(session);
  if (!diagnosticsClean(canaryDiagnostics)) {
    throw new Error(`canary diagnostics are not clean: ${JSON.stringify(canaryDiagnostics)}`);
  }

  const transition = normalizeCrossBuildTransition(await session.restartWithLegacyBuild({
    scopeKey: canarySnapshot.scopeKey,
  }));
  const retirementDiagnostics = diagnosticsSnapshotFromPage(
    transition.browser.beforeProcess?.finalDiagnostics ?? {},
  );
  if (!diagnosticsClean(retirementDiagnostics)) {
    throw new Error(`canary retirement diagnostics are not clean: ${JSON.stringify(
      retirementDiagnostics,
    )}`);
  }
  if (canaryAuthority.managedOrigin !== transition.origin) {
    throw new Error("cross-build transition changed the canary managed origin");
  }
  const legacyRawBeforeNavigation = await readCanaryToLegacyBrowserState(session, canarySnapshot.scopeKey);
  const beforeReceipt = compatibilitySnapshotReceipt(legacyRawBeforeNavigation?.legacyRaw, {
    scopeKey: canarySnapshot.scopeKey,
  });
  if (beforeReceipt.sourceBytesDigest !== canarySnapshot.sourceBytesDigest) {
    throw new Error("legacy profile bytes changed during build/browser/server restart");
  }
  const legacyNavigation = await session.navigateRollbackDrill(CANARY_TO_LEGACY_DRILL_ID);
  const legacyWindow = await session.verifyWindow();
  const settledLegacy = await waitForSample(
    () => readCanaryToLegacyBrowserState(session, canarySnapshot.scopeKey),
    (state) => legacyCompatibilityStateAccepted(
      state,
      canarySnapshot,
      canonicalCompatibility,
    ),
    {
      timeoutMs,
      description: "legacy build compatibility snapshot restore",
      stableMs: 160,
      signature: (state) => JSON.stringify({
        mode: state?.summary?.effectiveEngineMode,
        count: state?.summary?.entityCount,
        types: state?.summary?.typeCounts,
        registry: state?.legacyEvidence,
        bytes: digestUtf8(state?.legacyRaw ?? ""),
      }),
    },
  );
  const legacyState = settledLegacy.value;
  const legacySnapshot = compatibilitySnapshotReceipt(legacyState.legacyRaw, {
    scopeKey: canarySnapshot.scopeKey,
  });
  const legacyCompatibility = compatibilitySemanticReceipt(
    legacyState.compatibilitySnapshot.record,
  );
  const legacyAuthority = await captureCrossBuildAuthority(session, "legacy");
  if (legacyAuthority.managedOrigin !== transition.origin
    || legacyAuthority.buildFingerprint === canaryAuthority.buildFingerprint
    || legacyAuthority.assetDigest === canaryAuthority.assetDigest) {
    throw new Error("cross-build legacy asset authority/origin is invalid");
  }
  const legacyDiagnostics = diagnosticsSnapshot(session);
  if (!diagnosticsClean(legacyDiagnostics)) {
    throw new Error(`legacy diagnostics are not clean: ${JSON.stringify(legacyDiagnostics)}`);
  }
  const diagnostics = combinedDiagnostics(canaryDiagnostics, retirementDiagnostics, legacyDiagnostics);
  const canaryBuild = buildDescriptor(canaryAuthority, "canary", transition);
  const legacyBuild = buildDescriptor(legacyAuthority, "legacy", transition);
  const writeReceiptId = crypto.randomUUID();
  const readReceiptId = crypto.randomUUID();
  const buildAuthority = pairedBuildAuthority(canaryAuthority, legacyAuthority, transition, {
    canaryBuild,
    legacyBuild,
    writeReceiptId,
    readReceiptId,
    snapshot: canarySnapshot,
    canonical: canonicalCompatibility,
    manifest: canaryManifest,
  });
  const observedAt = new Date().toISOString();
  const artifact = Object.freeze({
    schemaVersion: "drawing-rollback-drill/v2",
    drillId: CANARY_TO_LEGACY_DRILL_ID,
    environment: Object.freeze({
      productionBuild: canaryAuthority.authoritative && legacyAuthority.authoritative,
      headed: canaryWindow?.headed === true && legacyWindow?.headed === true,
      visibilityState: legacyWindow?.visibilityState ?? null,
      windowState: legacyWindow?.windowState ?? null,
      browserVersion: legacyWindow?.browserProduct ?? session.browserVersion?.product ?? "",
      stages: Object.freeze({ canary: canaryWindow, legacy: legacyWindow }),
    }),
    provenance: Object.freeze({
      buildRevision: legacyAuthority.gitRevision,
      runId: session.runId,
      startedAt,
      completedAt: observedAt,
    }),
    buildAuthority,
    injection: Object.freeze({
      kind: "canary-build-to-legacy-build",
      armed: canaryNavigation?.bootstrap?.armed === true
        && legacyNavigation?.bootstrap?.armed === true,
      observed: true,
      canaryFaultId: canaryNavigation?.faultId ?? null,
      legacyFaultId: legacyNavigation?.faultId ?? null,
      uiOperationCount: ui.operations.length,
      finalFreehandMutationObserved: ui.finalFreehandMutationObserved,
      buildAuthorityCurrent: buildAuthority.authoritative,
    }),
    diagnostics,
    builds: Object.freeze({ canary: canaryBuild, legacy: legacyBuild }),
    restartReceipts: Object.freeze({
      browser: transition.browser,
      server: transition.server,
    }),
    retirement: transition.canaryRetirement,
    snapshot: Object.freeze({
      writeReceipt: Object.freeze({
        kind: "compatibility-write",
        receiptId: writeReceiptId,
        observedAt: settledCanary.observedAt,
        documentAuthority: canaryBuild.documentAuthority,
        buildId: canaryBuild.buildId,
        buildFingerprint: canaryBuild.buildFingerprint,
        assetDigest: canaryBuild.assetDigest,
        buildInputDigest: canaryBuild.buildInputDigest,
        gitRevision: canaryBuild.gitRevision,
        profileId: transition.profileId,
        origin: canaryBuild.origin,
        scopeKey: canarySnapshot.scopeKey,
        storageKey: canarySnapshot.storageKey,
        documentRevision: canarySnapshot.documentRevision,
        documentDigest: canarySnapshot.documentDigest,
        canonicalRecordDigest: canonicalCompatibility.canonicalRecordDigest,
        canonicalCompatibilityDigest: canonicalCompatibility.compatibilityDigest,
        sourceBytesDigest: canarySnapshot.sourceBytesDigest,
        sourceBytesLength: canarySnapshot.sourceBytesLength,
        entityCount: canarySnapshot.entityCount,
        entityIds: canarySnapshot.entityIds,
        zOrder: canarySnapshot.zOrder,
        kindCounts: canarySnapshot.typeCounts,
        canonicalEntityIds: canonicalCompatibility.entityIds,
        canonicalEntityDigests: canonicalCompatibility.canonicalEntityDigests,
        canonicalZOrder: canonicalCompatibility.zOrder,
        canonicalKindCounts: canonicalCompatibility.typeCounts,
        manifest: canaryManifest,
        persistence: Object.freeze({ ...canaryState.runtime.persistence }),
      }),
      readReceipt: Object.freeze({
        kind: "legacy-read",
        receiptId: readReceiptId,
        observedAt: settledLegacy.observedAt,
        documentAuthority: legacyBuild.documentAuthority,
        buildId: legacyBuild.buildId,
        buildFingerprint: legacyBuild.buildFingerprint,
        assetDigest: legacyBuild.assetDigest,
        buildInputDigest: legacyBuild.buildInputDigest,
        gitRevision: legacyBuild.gitRevision,
        profileId: transition.profileId,
        origin: legacyBuild.origin,
        scopeKey: legacySnapshot.scopeKey,
        storageKey: legacySnapshot.storageKey,
        documentDigest: legacySnapshot.documentDigest,
        canonicalCompatibilityDigest: legacyCompatibility.compatibilityDigest,
        entityCount: legacySnapshot.entityCount,
        entityIds: legacySnapshot.entityIds,
        zOrder: legacySnapshot.zOrder,
        visibleEntityCount: legacyState.legacyEvidence.attachedCount,
        renderedKinds: CANARY_TO_LEGACY_DRAWING_KINDS,
        kindCounts: legacySnapshot.typeCounts,
        sourceBytesDigestBefore: beforeReceipt.sourceBytesDigest,
        sourceBytesDigestAfter: legacySnapshot.sourceBytesDigest,
        legacyEvidence: Object.freeze({ ...legacyState.legacyEvidence }),
      }),
    }),
    observations: Object.freeze({
      ui,
      canary: Object.freeze({
        scopeKey: canarySnapshot.scopeKey,
        documentRevision: canarySnapshot.documentRevision,
        runtime: canaryState.runtime,
        summary: canaryState.summary,
      }),
      legacy: Object.freeze({
        runtime: legacyState.runtime,
        summary: legacyState.summary,
        legacyEvidence: legacyState.legacyEvidence,
      }),
      processReceipts: transition.processReceipts,
    }),
  });
  return Object.freeze({
    artifact,
    document: Object.freeze({ ...canaryIdentity }),
    finalDocument: Object.freeze({ ...canaryIdentity }),
    transition,
  });
}

export async function runControlledCrossBuildRollbackDrills(session, options = {}) {
  const result = await runControlledCrossBuildRollbackDrill(session, options);
  return Object.freeze({
    drills: Object.freeze([result.artifact]),
    finalDocument: result.finalDocument,
    transition: result.transition,
  });
}
