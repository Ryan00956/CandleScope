import assert from "node:assert/strict";
import test from "node:test";

import { exportDrawingDocument, importSavedDrawings } from "../../core/drawingCodec.js";
import { createDrawingScreenDisplayList } from "../../rendering/drawingDisplayList.js";
import type { DrawingRenderRevisionStamp } from "../drawingRenderScheduler.js";
import { compareDrawingShadowParity } from "../drawingShadowParity.js";

const stamp: DrawingRenderRevisionStamp = Object.freeze({
  scopeKey: "parity",
  documentRevision: 0,
  surfaceGeneration: 1,
  dataRevision: 1,
  projectionRevision: 1,
  lineageIndexRevision: 0,
  viewportRevision: 1,
  themeRevision: 1,
  widthCssPx: 800,
  heightCssPx: 400,
  dpr: 1,
});

function fixture() {
  const document = importSavedDrawings("parity", [{
    type: "line",
    id: "line",
    lineType: "line-segment",
    dataPoints: [{ time: 1, price: 10 }, { time: 2, price: 20 }],
    color: "#fff",
    lineWidth: 2,
  }]);
  if (!document) throw new Error("invalid parity fixture");
  const serializedDrawings = exportDrawingDocument(document);
  if (!serializedDrawings) throw new Error("invalid serialized fixture");
  const plan = createDrawingScreenDisplayList(stamp, [{
    id: "line",
    kind: "line",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "line", color: "#fff", lineWidth: 2 },
    points: new Float64Array([10, 10, 20, 20]),
    bbox: [10, 10, 20, 20],
    handles: new Float64Array([10, 10, 20, 20]),
    handleNames: ["start", "end"],
    pathBreaks: new Uint32Array([1]),
    unresolvedSourcePointIndexes: new Uint32Array([130]),
    hitZones: [{ kind: "polyline", pointOffset: 0, pointCount: 2, tolerance: 8 }],
  }]);
  const layouts = [{
    entityId: "line",
    kind: "line" as const,
    visible: true,
    bbox: [10, 10, 20, 20] as const,
    handles: new Float64Array([10, 10, 20, 20]),
    handleNames: ["start", "end"],
    unresolvedGapIndexes: [130],
  }];
  return { document, serializedDrawings, plan, layouts };
}

test("strict shadow parity accepts matching order, layout, hits, gaps, and serialization", () => {
  const { document, serializedDrawings, plan, layouts } = fixture();
  const result = compareDrawingShadowParity({
    document,
    plan,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: serializedDrawings,
    legacyLayouts: layouts,
    hitProbes: [{
      x: 15,
      y: 15,
      selectedId: null,
      legacy: { entityId: "line", kind: "line", hit: { body: true } },
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.comparedEntityCount, 1);
  assert.equal(result.comparedHitCount, 1);
  assert.deepEqual(result.mismatches, []);
});

test("strict gap parity can use the low-frequency full-source stroke sample", () => {
  const { document, serializedDrawings, plan, layouts } = fixture();
  const fullLayouts = layouts.map((layout) => ({
    ...layout,
    unresolvedGapIndexes: [130, 270],
  }));
  const result = compareDrawingShadowParity({
    document,
    plan,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: serializedDrawings,
    legacyLayouts: fullLayouts,
    sceneCanonicalGapIndexes: new Map([["line", new Uint32Array([130, 270])]]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("shadow parity reports each independently observable mismatch", () => {
  const { document, serializedDrawings, plan } = fixture();
  const result = compareDrawingShadowParity({
    document,
    plan,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: serializedDrawings,
    legacyLayouts: [{
      entityId: "line",
      kind: "line",
      visible: true,
      bbox: [10, 10, 21, 20],
      handles: new Float64Array([10, 10, 21, 20]),
      handleNames: ["start", "end"],
      unresolvedGapIndexes: [1],
    }],
    hitProbes: [{ x: 15, y: 15, selectedId: null, legacy: null }],
  });
  assert.equal(result.ok, false);
  const kinds = new Set(result.mismatches.map((mismatch) => mismatch.kind));
  assert.equal(kinds.has("bbox"), true);
  assert.equal(kinds.has("handles"), true);
  assert.equal(kinds.has("unresolved-gap"), true);
  assert.equal(kinds.has("hit"), true);
});

test("missing or reordered legacy layouts fail closed", () => {
  const { document, serializedDrawings, plan } = fixture();
  const result = compareDrawingShadowParity({
    document,
    plan,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: serializedDrawings,
    legacyLayouts: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.mismatches.map((mismatch) => mismatch.kind),
    ["visible-set", "missing-probe"],
  );
});

test("canonical order compares the full scene registry rather than the culled display list", () => {
  const { document, serializedDrawings, plan } = fixture();
  const culled = createDrawingScreenDisplayList(plan.stamp, []);
  const result = compareDrawingShadowParity({
    document,
    plan: culled,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: serializedDrawings,
    legacyLayouts: [{
      entityId: "line",
      kind: "line",
      visible: false,
      bbox: null,
      handles: new Float64Array(),
      handleNames: [],
      unresolvedGapIndexes: [],
    }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("modified legacy serialization fails both order and serialized parity", () => {
  const { document, serializedDrawings, plan, layouts } = fixture();
  const first = serializedDrawings[0];
  assert.ok(first);
  const modified = Object.freeze([{ ...first, id: "different-id" }]);
  const result = compareDrawingShadowParity({
    document,
    plan,
    sceneCanonicalIds: document.zOrder,
    legacySerializedDrawings: modified,
    legacyLayouts: layouts,
  });
  assert.equal(result.ok, false);
  const kinds = result.mismatches.map((mismatch) => mismatch.kind);
  assert.equal(kinds.includes("legacy-order"), true);
  assert.equal(kinds.includes("serialized"), true);
});
