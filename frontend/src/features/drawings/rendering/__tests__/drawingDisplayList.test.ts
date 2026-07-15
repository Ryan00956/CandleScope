import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  createDrawingScreenDisplayList,
  drawingDisplayEntityScreenHandles,
  drawingDisplayEntityScreenBox,
  hitTestDrawingScreenDisplayList,
  type ProjectedDrawingEntity,
} from "../drawingDisplayList.js";

const stamp: DrawingRenderRevisionStamp = Object.freeze({
  scopeKey: "scope",
  documentRevision: 3,
  surfaceGeneration: 1,
  dataRevision: 2,
  projectionRevision: 4,
  lineageIndexRevision: 5,
  viewportRevision: 6,
  themeRevision: 7,
  widthCssPx: 800,
  heightCssPx: 400,
  dpr: 1.5,
});

function line(id: string, y: number): ProjectedDrawingEntity {
  return {
    id,
    kind: "line",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "line", color: "#fff", lineWidth: 2 },
    points: new Float64Array([10, y, 100, y]),
    bbox: [10, y, 100, y],
    handles: new Float64Array([10, y, 100, y]),
    handleNames: ["start", "end"],
    hitZones: [{ kind: "polyline", pointOffset: 0, pointCount: 2, tolerance: 5 }],
  };
}

function shape(
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
  clippedBbox: readonly [number, number, number, number],
): ProjectedDrawingEntity {
  const middleY = (top + bottom) / 2;
  return {
    id,
    kind: "shape",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "shape", color: "#fff", lineWidth: 2 },
    renderSpec: {
      op: "shape",
      shapeType: "rectangle",
      strokeColor: "#fff",
      fillPaintColor: null,
      lineWidthCssPx: 2,
      lineStyle: "solid",
      selected: true,
      boxPointOffset: 0,
    },
    points: new Float64Array([left, top, right, bottom]),
    bbox: clippedBbox,
    handles: new Float64Array([right, middleY, left, middleY]),
    handleNames: ["r", "l"],
    handleResults: [
      { zone: "r", handle: "r", pointIndex: -1 },
      { zone: "l", handle: "l", pointIndex: -1 },
    ],
    hitZones: [{
      kind: "box",
      pointOffset: 0,
      pointCount: 2,
      tolerance: 4,
      result: { zone: "body", pointIndex: -1 },
    }],
  };
}

test("display list concatenates copy-owned typed buffers and entity offsets", () => {
  const first = line("first", 20);
  const {
    handles: _handles,
    handleNames: _handleNames,
    ...secondBase
  } = line("second", 40);
  const second: ProjectedDrawingEntity = {
    ...secondBase,
    kind: "freehand",
    style: { kind: "freehand", color: "#f00", lineWidth: 3 },
    points: new Float64Array([0, 40, 10, 40, Number.NaN, Number.NaN, 30, 40]),
    bbox: [0, 40, 30, 40],
    pathBreaks: new Uint32Array([2]),
    unresolvedSourcePointIndexes: new Uint32Array([20]),
  };
  const list = createDrawingScreenDisplayList(stamp, [first, second]);
  assert.equal(list.points instanceof Float64Array, true);
  assert.equal(list.pointOffsets instanceof Uint32Array, true);
  assert.deepEqual([...list.pointOffsets], [0, 2]);
  assert.deepEqual([...list.pointCounts], [2, 4]);
  assert.deepEqual([...list.pathBreaks], [4]);
  assert.deepEqual([...list.unresolvedSourcePointIndexes], [20]);
  assert.deepEqual([...list.unresolvedGapOffsets], [0, 0]);
  assert.deepEqual([...list.unresolvedGapCounts], [0, 1]);
  assert.equal(list.unresolvedGapCount, 1);
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list.entities), true);
  first.points[0] = 999;
  assert.equal(list.points[0], 10);
});

test("display list exposes an immutable accepted screen box for detached scene interaction proxies", () => {
  const list = createDrawingScreenDisplayList(stamp, [line("shape-proxy", 20)]);
  assert.deepEqual(drawingDisplayEntityScreenBox(list, "shape-proxy"), {
    x: 10,
    y: 20,
    width: 90,
    height: 0,
  });
  assert.deepEqual(drawingDisplayEntityScreenHandles(list, "shape-proxy"), [
    { x: 10, y: 20 },
    { x: 100, y: 20 },
  ]);
  assert.equal(Object.isFrozen(drawingDisplayEntityScreenHandles(list, "shape-proxy")), true);
  assert.equal(drawingDisplayEntityScreenBox(list, "missing"), null);
  assert.equal(drawingDisplayEntityScreenHandles(list, "missing"), null);
});

test("partly offscreen shape interaction keeps raw box anchors instead of clipped bboxes", () => {
  const leftList = createDrawingScreenDisplayList(stamp, [
    shape("left-offscreen", -40, 20, 80, 90, [0, 20, 80, 90]),
  ]);
  const leftBox = drawingDisplayEntityScreenBox(leftList, "left-offscreen");
  assert.deepEqual(leftBox, { x: -40, y: 20, width: 120, height: 70 });
  assert.equal(Object.isFrozen(leftBox), true);
  assert.deepEqual(hitTestDrawingScreenDisplayList(leftList, 80, 55, "left-offscreen"), {
    entityId: "left-offscreen",
    kind: "shape",
    zone: "r",
    handle: "r",
    pointIndex: -1,
  });

  const rightList = createDrawingScreenDisplayList(stamp, [
    shape("right-offscreen", 20, 20, 140, 90, [20, 20, 100, 90]),
  ]);
  assert.deepEqual(drawingDisplayEntityScreenBox(rightList, "right-offscreen"), {
    x: 20,
    y: 20,
    width: 120,
    height: 70,
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(rightList, 20, 55, "right-offscreen"), {
    entityId: "right-offscreen",
    kind: "shape",
    zone: "l",
    handle: "l",
    pointIndex: -1,
  });
});

test("reverse-z hit queries preserve handle and named-zone metadata", () => {
  const list = createDrawingScreenDisplayList(stamp, [line("bottom", 20), line("top", 20)]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 50, 22), {
    entityId: "top",
    kind: "line",
    body: true,
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 10, 20, "top"), {
    entityId: "top",
    kind: "line",
    handle: "start",
    pointIndex: 0,
  });
  const position: ProjectedDrawingEntity = {
    id: "position",
    kind: "position",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "position", positionSize: 1000 },
    points: new Float64Array([10, 10, 100, 10]),
    bbox: [10, 10, 100, 10],
    hitZones: [{ kind: "polyline", name: "entry", pointOffset: 0, pointCount: 2, tolerance: 8 }],
  };
  const positionList = createDrawingScreenDisplayList(stamp, [position]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(positionList, 50, 12), {
    entityId: "position",
    kind: "position",
    zone: "entry",
  });
});

test("zone broad phase keeps tolerance-edge hits and selected handles outside geometry", () => {
  const broadPhaseLine = line("broad-phase", 20);
  const list = createDrawingScreenDisplayList(stamp, [broadPhaseLine]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 50, 25), {
    entityId: "broad-phase",
    kind: "line",
    body: true,
  });
  assert.equal(hitTestDrawingScreenDisplayList(list, 50, 26), null);

  const handleOutsideGeometry: ProjectedDrawingEntity = {
    ...line("outside-handle", 20),
    bbox: [20, 20, 100, 20],
  };
  const handleList = createDrawingScreenDisplayList(stamp, [handleOutsideGeometry]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(handleList, 10, 20, "outside-handle"), {
    entityId: "outside-handle",
    kind: "line",
    handle: "start",
    pointIndex: 0,
  });
});

test("exact zone and selected-handle results preserve legacy hit payloads", () => {
  const exact: ProjectedDrawingEntity = {
    ...line("exact", 30),
    handleResults: [{ pointIndex: 0 }, null],
    handleTolerance: 9,
    hitZones: [
      {
        kind: "point",
        pointOffset: 1,
        pointCount: 1,
        tolerance: 9,
        result: { pointIndex: 1, zone: "end" },
      },
      {
        kind: "polyline",
        pointOffset: 0,
        pointCount: 2,
        tolerance: 5,
        result: { pointIndex: -1 },
      },
    ],
  };
  const list = createDrawingScreenDisplayList(stamp, [exact]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 10, 30, "exact"), {
    entityId: "exact",
    kind: "line",
    pointIndex: 0,
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 100, 30, "exact"), {
    entityId: "exact",
    kind: "line",
    pointIndex: 1,
    zone: "end",
  });
  assert.deepEqual(hitTestDrawingScreenDisplayList(list, 50, 33), {
    entityId: "exact",
    kind: "line",
    pointIndex: -1,
  });
  assert.equal(Object.isFrozen(list.entities[0]?.handleResults?.[0]), true);
  assert.equal(Object.isFrozen(list.entities[0]?.hitZones[0]?.result), true);
});

test("native arc and ellipse zones avoid polyline and bbox hit approximations", () => {
  const arc: ProjectedDrawingEntity = {
    id: "arc",
    kind: "angle-measure",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "angle-measure", color: "#fff", lineWidth: 2 },
    points: new Float64Array([50, 50]),
    bbox: [30, 30, 70, 70],
    hitZones: [{
      kind: "arc",
      pointOffset: 0,
      pointCount: 1,
      tolerance: 2,
      startAngle: 0,
      angleDelta: Math.PI / 2,
      radius: 20,
      angleTolerance: 0.08,
      result: { pointIndex: -1, zone: "arc" },
    }],
  };
  const ellipse: ProjectedDrawingEntity = {
    id: "ellipse",
    kind: "shape",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "shape", color: "#fff", lineWidth: 2 },
    points: new Float64Array([10, 10, 90, 50]),
    bbox: [10, 10, 90, 50],
    hitZones: [{
      kind: "ellipse",
      pointOffset: 0,
      pointCount: 2,
      tolerance: 0,
      result: { zone: "body", pointIndex: -1 },
    }],
  };
  const arcList = createDrawingScreenDisplayList(stamp, [arc]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(
    arcList,
    50 + Math.cos(Math.PI / 4) * 20,
    50 + Math.sin(Math.PI / 4) * 20,
  ), { entityId: "arc", kind: "angle-measure", pointIndex: -1, zone: "arc" });
  assert.equal(hitTestDrawingScreenDisplayList(arcList, 50, 30), null);

  const ellipseList = createDrawingScreenDisplayList(stamp, [ellipse]);
  assert.deepEqual(hitTestDrawingScreenDisplayList(ellipseList, 50, 30), {
    entityId: "ellipse", kind: "shape", zone: "body", pointIndex: -1,
  });
  assert.equal(hitTestDrawingScreenDisplayList(ellipseList, 10, 10), null);
});

test("malformed partial gaps, handles, bboxes, and zones fail closed", () => {
  assert.throws(() => createDrawingScreenDisplayList(stamp, [{
    ...line("bad-gap", 10),
    points: new Float64Array([Number.NaN, 1]),
  }]));
  assert.throws(() => createDrawingScreenDisplayList(stamp, [{
    ...line("bad-handles", 10),
    handleNames: ["one"],
  }]));
  assert.throws(() => createDrawingScreenDisplayList(stamp, [{
    ...line("bad-bbox", 10),
    bbox: [100, 10, 10, 20],
  }]));
  assert.throws(() => createDrawingScreenDisplayList(stamp, [{
    ...line("bad-zone", 10),
    hitZones: [{ kind: "polyline", pointOffset: 1, pointCount: 3, tolerance: 1 }],
  }]));
  assert.throws(() => createDrawingScreenDisplayList(stamp, [{
    ...line("bad-gap-owner", 10),
    canonicalGapCoverageComplete: true,
  }]));
});
