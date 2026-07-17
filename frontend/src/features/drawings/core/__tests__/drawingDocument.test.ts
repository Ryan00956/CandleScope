import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DRAWING_DOCUMENT_ENTITIES,
  cloneDrawingDocument,
  createDrawingDocument,
  createDrawingEntity,
  drawingDocumentEntitiesInOrder,
} from "../drawingDocument.js";
import type {
  DrawingEntityInput,
} from "../drawingDocument.js";
import type { DrawingDataPoint, FreehandStrokeV3 } from "../../drawingTypes.js";
import { malformedFixture, mustBeDefined } from "../../../../test/testHelpers.js";

function point(time: number, price: number): DrawingDataPoint {
  return { time, price };
}

function entityInputs(): DrawingEntityInput[] {
  const first = point(100.125, 10.25);
  const second = point(200.875, 20.75);
  const stroke: FreehandStrokeV3 = {
    version: 3,
    sourceProjection: "time",
    sourceProjectionConfig: "dataset-a:time:1m",
    spans: [],
    points: [{ time: 100.125, price: 10.25 }, { time: 200.875, price: 20.75 }],
  };
  return [
    {
      id: "line",
      kind: "line",
      geometry: { kind: "line", lineType: "line-segment", dataPoints: [first, second] },
      style: { kind: "line", color: "#fff", lineWidth: 2 },
    },
    {
      id: "axis",
      kind: "axis-line",
      geometry: { kind: "axis-line", axisLineType: "cross", dataPoint: first },
      style: { kind: "axis-line", color: "#fff", lineWidth: 2 },
    },
    {
      id: "angle",
      kind: "angle-measure",
      geometry: { kind: "angle-measure", dataPoints: [first, second] },
      style: { kind: "angle-measure", color: "#fff", lineWidth: 2 },
    },
    {
      id: "text",
      kind: "text",
      geometry: { kind: "text", dataPoint: first },
      style: {
        kind: "text",
        text: "note",
        color: "#fff",
        fontSize: 14,
        fontFamily: "sans-serif",
        bold: false,
        italic: false,
        underline: false,
        align: "left",
        bgColor: null,
        borderColor: null,
        borderWidth: 0,
        widthPx: null,
        padding: 4,
      },
    },
    {
      id: "fib",
      kind: "fibonacci",
      geometry: { kind: "fibonacci", dataPoints: [first, second], inverted: true },
      style: {
        kind: "fibonacci",
        color: "#fff",
        lineWidth: 2,
        levels: [{ level: 0.618, color: "#abc", enabled: true }],
      },
    },
    {
      id: "position",
      kind: "position",
      geometry: {
        kind: "position",
        direction: "long",
        entryPrice: 10.25,
        tpPrice: 20.75,
        slPrice: null,
        timeRange: { start: { time: 100.125 }, end: { time: 200.875 } },
      },
      style: { kind: "position", positionSize: 1_000, infoPanelOffset: { x: 3.5, y: -2.25 } },
    },
    {
      id: "shape",
      kind: "shape",
      geometry: { kind: "shape", shapeType: "rectangle", dataPoints: [first, second] },
      style: {
        kind: "shape",
        color: "#fff",
        lineWidth: 2,
        fillColor: "#000",
        fillOpacity: 0.25,
        lineStyle: "dashed",
      },
    },
    {
      id: "freehand",
      kind: "freehand",
      geometry: { kind: "freehand", stroke },
      style: { kind: "freehand", color: "#fff", lineWidth: 2 },
    },
    {
      id: "highlighter",
      kind: "highlighter",
      geometry: { kind: "highlighter", dataPoints: [first, second] },
      style: {
        kind: "highlighter",
        color: "#ff0",
        lineWidth: 8,
        opacity: 0.35,
        compositeOperation: "multiply",
        brushShape: "square",
      },
    },
  ];
}

test("document models every drawing kind as frozen canonical geometry and style", () => {
  const inputs = entityInputs();
  const document = createDrawingDocument({ scopeKey: "scope-a", entities: inputs.map(createDrawingEntity) });

  assert.equal(document.entities.size, 9);
  assert.deepEqual(document.zOrder, inputs.map((input) => input.id));
  assert.deepEqual(drawingDocumentEntitiesInOrder(document).map((entity) => entity.kind), [
    "line", "axis-line", "angle-measure", "text", "fibonacci",
    "position", "shape", "freehand", "highlighter",
  ]);
  assert.equal(Object.isFrozen(document), true);
  assert.equal(Object.isFrozen(document.zOrder), true);
  assert.equal(Object.isFrozen(document.entities), true);
  assert.equal(typeof (document.entities as unknown as { set?: unknown }).set, "undefined");
  for (const entity of document.entities.values()) {
    assert.equal(Object.isFrozen(entity), true, entity.id);
    assert.equal(Object.isFrozen(entity.geometry), true, entity.id);
    assert.equal(Object.isFrozen(entity.style), true, entity.id);
    assert.equal(entity.geometryRevision, 1);
    assert.equal(entity.styleRevision, 1);
  }
  const line = mustBeDefined(document.entities.get("line"));
  if (line.geometry.kind !== "line") throw new Error("Expected line geometry");
  assert.equal(mustBeDefined(line.geometry.dataPoints)[0]?.time, 100.125);
  assert.equal(mustBeDefined(line.geometry.dataPoints)[1]?.price, 20.75);
});

test("document snapshots deep-copy inputs and clones do not expose mutable aliases", () => {
  const mutablePoints = [point(100, 10), point(200, 20)];
  const mutableStyle = { kind: "line" as const, color: "#fff", lineWidth: 2 };
  const input: DrawingEntityInput = {
    id: "line",
    kind: "line",
    geometry: { kind: "line", lineType: "line-segment", dataPoints: mutablePoints },
    style: mutableStyle,
  };
  const document = createDrawingDocument({
    scopeKey: "scope-a",
    entities: [createDrawingEntity(input)],
  });
  mutablePoints[0] = point(999, 999);
  mutableStyle.color = "#000";

  const line = mustBeDefined(document.entities.get("line"));
  if (line.geometry.kind !== "line" || line.style.kind !== "line") throw new Error("Expected line");
  assert.equal(mustBeDefined(line.geometry.dataPoints)[0]?.time, 100);
  assert.equal(line.style.color, "#fff");

  const cloned = cloneDrawingDocument(document);
  assert.notStrictEqual(cloned, document);
  assert.notStrictEqual(cloned.entities, document.entities);
  assert.notStrictEqual(cloned.entities.get("line"), line);
  assert.deepEqual(cloned.zOrder, document.zOrder);
});

test("document construction rejects corrupt ids, revisions, kinds, values, and z-order", () => {
  const line = entityInputs()[0] as DrawingEntityInput;
  assert.throws(() => createDrawingEntity({ ...line, id: "__preview__" }));
  assert.throws(() => createDrawingEntity({ ...line, geometryRevision: -1 }));
  assert.throws(() => createDrawingEntity(malformedFixture<DrawingEntityInput>({
    ...line,
    style: { kind: "shape", color: "#fff" },
  })));
  assert.throws(() => createDrawingEntity(malformedFixture<DrawingEntityInput>({
    ...line,
    geometry: { ...line.geometry, chart: {} },
  })));
  assert.throws(() => createDrawingEntity(malformedFixture<DrawingEntityInput>({
    ...line,
    geometry: { kind: "line", dataPoints: [{ time: 100, price: Number.NaN }] },
  })));
  const cyclic: Record<string, unknown> = { kind: "line" };
  cyclic.self = cyclic;
  assert.throws(() => createDrawingEntity(malformedFixture<DrawingEntityInput>({
    ...line,
    geometry: cyclic,
  })));

  const entity = createDrawingEntity(line);
  assert.throws(() => createDrawingDocument({ scopeKey: "scope", entities: [entity, entity] }));
  assert.throws(() => createDrawingDocument({
    scopeKey: "scope",
    entities: [entity],
    zOrder: ["missing"],
  }));
  assert.throws(() => createDrawingDocument({
    scopeKey: "scope",
    entities: Array.from({ length: MAX_DRAWING_DOCUMENT_ENTITIES + 1 }, (_, index) => (
      createDrawingEntity({ ...line, id: `line-${index}` })
    )),
  }));
});
