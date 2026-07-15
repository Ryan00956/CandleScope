import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingEntity,
} from "../../core/drawingDocument.js";
import type { DrawingEntity } from "../../core/drawingDocument.js";
import { savedDrawingFromEntity } from "../../core/drawingCodec.js";
import { createPrimitiveFromSavedDrawing } from "../../drawingPrimitiveFactory.js";
import {
  DEFAULT_DRAWING_RENDER_COLOR,
  DEFAULT_DRAWING_RENDER_LINE_WIDTH,
  DEFAULT_FIBONACCI_RENDER_COLOR,
  DEFAULT_FIBONACCI_RENDER_LEVELS,
  DEFAULT_HIGHLIGHTER_RENDER_OPACITY,
  DEFAULT_POSITION_RENDER_SIZE,
  DEFAULT_SHAPE_RENDER_FILL_OPACITY,
  DEFAULT_TEXT_RENDER_COLOR,
  DEFAULT_TEXT_RENDER_FONT_FAMILY,
  DEFAULT_TEXT_RENDER_FONT_SIZE,
  normalizeDrawingEntityForRender,
} from "../drawingRenderDefaults.js";
import type { DrawingRenderEntity } from "../drawingRenderDefaults.js";

const FREEHAND_POINTS = Object.freeze([
  Object.freeze({ time: 1, price: 2 }),
  Object.freeze({ time: 2, price: 3 }),
]);

function defaultEntities(): readonly DrawingEntity[] {
  return Object.freeze([
    createDrawingEntity({
      id: "line-defaults",
      kind: "line",
      geometry: { kind: "line" },
      style: { kind: "line" },
    }),
    createDrawingEntity({
      id: "axis-defaults",
      kind: "axis-line",
      geometry: { kind: "axis-line" },
      style: { kind: "axis-line" },
    }),
    createDrawingEntity({
      id: "angle-defaults",
      kind: "angle-measure",
      geometry: { kind: "angle-measure" },
      style: { kind: "angle-measure" },
    }),
    createDrawingEntity({
      id: "text-defaults",
      kind: "text",
      geometry: { kind: "text" },
      style: { kind: "text" },
    }),
    createDrawingEntity({
      id: "fib-defaults",
      kind: "fibonacci",
      geometry: { kind: "fibonacci" },
      style: { kind: "fibonacci" },
    }),
    createDrawingEntity({
      id: "position-defaults",
      kind: "position",
      geometry: { kind: "position", entryPrice: 10 },
      style: { kind: "position" },
    }),
    createDrawingEntity({
      id: "shape-defaults",
      kind: "shape",
      geometry: { kind: "shape" },
      style: { kind: "shape" },
    }),
    createDrawingEntity({
      id: "freehand-defaults",
      kind: "freehand",
      geometry: { kind: "freehand", dataPoints: FREEHAND_POINTS },
      style: { kind: "freehand" },
    }),
    createDrawingEntity({
      id: "highlighter-defaults",
      kind: "highlighter",
      geometry: { kind: "highlighter", dataPoints: FREEHAND_POINTS },
      style: { kind: "highlighter" },
    }),
  ]);
}

function renderDefaultsByKind(): ReadonlyMap<DrawingEntity["kind"], DrawingRenderEntity> {
  const entries = defaultEntities().map((entity) => {
    const normalized = normalizeDrawingEntityForRender(entity);
    assert.ok(normalized, entity.kind);
    return [entity.kind, normalized] as const;
  });
  return new Map(entries);
}

test("render normalization fills every optional default for all nine kinds", () => {
  const defaults = renderDefaultsByKind();
  assert.equal(defaults.size, 9);

  const line = defaults.get("line");
  assert.equal(line?.kind, "line");
  if (line?.kind === "line") {
    assert.deepEqual(line.geometry, { kind: "line", lineType: "line-segment", dataPoints: [] });
    assert.deepEqual(line.style, {
      kind: "line",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
    });
  }

  const axis = defaults.get("axis-line");
  assert.equal(axis?.kind, "axis-line");
  if (axis?.kind === "axis-line") {
    assert.deepEqual(axis.geometry, { kind: "axis-line", axisLineType: "horizontal", dataPoint: null });
    assert.deepEqual(axis.style, {
      kind: "axis-line",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
    });
  }

  const angle = defaults.get("angle-measure");
  assert.equal(angle?.kind, "angle-measure");
  if (angle?.kind === "angle-measure") {
    assert.deepEqual(angle.geometry, { kind: "angle-measure", dataPoints: [] });
    assert.deepEqual(angle.style, {
      kind: "angle-measure",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
    });
  }

  const text = defaults.get("text");
  assert.equal(text?.kind, "text");
  if (text?.kind === "text") {
    assert.deepEqual(text.geometry, { kind: "text", dataPoint: { logical: 0, price: 0 } });
    assert.deepEqual(text.style, {
      kind: "text",
      text: "Text",
      color: DEFAULT_TEXT_RENDER_COLOR,
      fontSize: DEFAULT_TEXT_RENDER_FONT_SIZE,
      fontFamily: DEFAULT_TEXT_RENDER_FONT_FAMILY,
      bold: false,
      italic: false,
      underline: false,
      align: "left",
      bgColor: null,
      borderColor: null,
      borderWidth: 1,
      widthPx: null,
      padding: 6,
    });
  }

  const fibonacci = defaults.get("fibonacci");
  assert.equal(fibonacci?.kind, "fibonacci");
  if (fibonacci?.kind === "fibonacci") {
    assert.deepEqual(fibonacci.geometry, { kind: "fibonacci", dataPoints: [], inverted: false });
    assert.deepEqual(fibonacci.style, {
      kind: "fibonacci",
      color: DEFAULT_FIBONACCI_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
      levels: DEFAULT_FIBONACCI_RENDER_LEVELS,
    });
  }

  const position = defaults.get("position");
  assert.equal(position?.kind, "position");
  if (position?.kind === "position") {
    assert.deepEqual(position.geometry, {
      kind: "position",
      direction: "long",
      entryPrice: 10,
      tpPrice: null,
      slPrice: null,
      timeRange: { start: null, end: null },
    });
    assert.deepEqual(position.style, {
      kind: "position",
      positionSize: DEFAULT_POSITION_RENDER_SIZE,
      infoPanelOffset: { x: 0, y: 0 },
    });
  }

  const shape = defaults.get("shape");
  assert.equal(shape?.kind, "shape");
  if (shape?.kind === "shape") {
    assert.deepEqual(shape.geometry, { kind: "shape", shapeType: "rectangle", dataPoints: [] });
    assert.deepEqual(shape.style, {
      kind: "shape",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
      fillColor: DEFAULT_DRAWING_RENDER_COLOR,
      fillOpacity: DEFAULT_SHAPE_RENDER_FILL_OPACITY,
      lineStyle: "solid",
    });
  }

  const freehand = defaults.get("freehand");
  assert.equal(freehand?.kind, "freehand");
  if (freehand?.kind === "freehand" || freehand?.kind === "highlighter") {
    assert.equal(freehand.kind, "freehand");
    assert.deepEqual(freehand.geometry, {
      kind: "freehand",
      dataPoints: FREEHAND_POINTS,
      stroke: null,
    });
    assert.deepEqual(freehand.style, {
      kind: "freehand",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
      opacity: 1,
      compositeOperation: "source-over",
      brushShape: "round",
    });
  }

  const highlighter = defaults.get("highlighter");
  assert.equal(highlighter?.kind, "highlighter");
  if (highlighter?.kind === "highlighter") {
    assert.equal(highlighter.kind, "highlighter");
    assert.deepEqual(highlighter.style, {
      kind: "highlighter",
      color: DEFAULT_DRAWING_RENDER_COLOR,
      lineWidth: DEFAULT_DRAWING_RENDER_LINE_WIDTH,
      opacity: DEFAULT_HIGHLIGHTER_RENDER_OPACITY,
      compositeOperation: "multiply",
      brushShape: "square",
    });
  }
});

test("render defaults match actual legacy primitive construction", () => {
  for (const entity of defaultEntities()) {
    const normalized = normalizeDrawingEntityForRender(entity);
    const saved = savedDrawingFromEntity(entity);
    assert.ok(normalized, entity.kind);
    assert.ok(saved, entity.kind);
    const primitive = createPrimitiveFromSavedDrawing(saved);
    assert.ok(primitive, entity.kind);
    const actual = primitive as unknown as Record<string, unknown>;

    switch (normalized.kind) {
      case "line":
        assert.equal(actual._lineType, normalized.geometry.lineType);
        assert.deepEqual(actual._dataPoints, normalized.geometry.dataPoints);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        break;
      case "axis-line":
        assert.equal(actual._axisLineType, normalized.geometry.axisLineType);
        assert.deepEqual(actual._dataPoint, normalized.geometry.dataPoint);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        break;
      case "angle-measure":
        assert.deepEqual(actual._dataPoints, normalized.geometry.dataPoints);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        break;
      case "text":
        assert.deepEqual(actual._dataPoint, normalized.geometry.dataPoint);
        assert.equal(actual._text, normalized.style.text);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._fontSize, normalized.style.fontSize);
        assert.equal(actual._fontFamily, normalized.style.fontFamily);
        assert.equal(actual._bold, normalized.style.bold);
        assert.equal(actual._italic, normalized.style.italic);
        assert.equal(actual._underline, normalized.style.underline);
        assert.equal(actual._align, normalized.style.align);
        assert.equal(actual._bgColor, normalized.style.bgColor);
        assert.equal(actual._borderColor, normalized.style.borderColor);
        assert.equal(actual._borderWidth, normalized.style.borderWidth);
        assert.equal(actual._widthPx, normalized.style.widthPx);
        assert.equal(actual._padding, normalized.style.padding);
        break;
      case "fibonacci":
        assert.deepEqual(actual._dataPoints, normalized.geometry.dataPoints);
        assert.equal(actual._inverted, normalized.geometry.inverted);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        assert.deepEqual(actual._levels, normalized.style.levels);
        break;
      case "position":
        assert.equal(actual._direction, normalized.geometry.direction);
        assert.equal(actual._entryPrice, normalized.geometry.entryPrice);
        assert.equal(actual._tpPrice, normalized.geometry.tpPrice);
        assert.equal(actual._slPrice, normalized.geometry.slPrice);
        assert.deepEqual(actual._timeRange, normalized.geometry.timeRange);
        assert.equal(actual._positionSize, normalized.style.positionSize);
        assert.deepEqual(actual._infoPanelOffset, normalized.style.infoPanelOffset);
        break;
      case "shape":
        assert.equal(actual._shapeType, normalized.geometry.shapeType);
        assert.deepEqual(actual._dataPoints, normalized.geometry.dataPoints);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        assert.equal(actual._fillColor, normalized.style.fillColor);
        assert.equal(actual._fillOpacity, normalized.style.fillOpacity);
        assert.equal(actual._lineStyle, normalized.style.lineStyle);
        break;
      case "freehand":
      case "highlighter":
        assert.equal(actual._type, normalized.kind);
        assert.deepEqual(actual._dataPoints, normalized.geometry.dataPoints);
        assert.deepEqual(actual._stroke, normalized.geometry.stroke);
        assert.equal(actual._color, normalized.style.color);
        assert.equal(actual._lineWidth, normalized.style.lineWidth);
        assert.equal(actual._opacity, normalized.style.opacity);
        assert.equal(actual._compositeOperation, normalized.style.compositeOperation);
        assert.equal(actual._brushShape, normalized.style.brushShape);
        break;
    }
  }
});

test("render normalization is pure, frozen, and rejects legacy-unrenderable payloads", () => {
  const source = defaultEntities()[0];
  assert.ok(source);
  const geometry = source.geometry;
  const style = source.style;
  const normalized = normalizeDrawingEntityForRender(source);
  assert.ok(normalized);
  assert.strictEqual(source.geometry, geometry);
  assert.strictEqual(source.style, style);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.geometry), true);
  assert.equal(Object.isFrozen(normalized.style), true);

  const incompletePosition = createDrawingEntity({
    id: "position-incomplete",
    kind: "position",
    geometry: { kind: "position" },
    style: { kind: "position" },
  });
  const incompleteFreehand = createDrawingEntity({
    id: "freehand-incomplete",
    kind: "freehand",
    geometry: { kind: "freehand" },
    style: { kind: "freehand" },
  });
  assert.equal(normalizeDrawingEntityForRender(incompletePosition), null);
  assert.equal(normalizeDrawingEntityForRender(incompleteFreehand), null);
});

test("an explicit round highlighter brush is preserved", () => {
  const normalized = normalizeDrawingEntityForRender(createDrawingEntity({
    id: "highlighter-round",
    kind: "highlighter",
    geometry: { kind: "highlighter", dataPoints: FREEHAND_POINTS },
    style: {
      kind: "highlighter",
      brushShape: "round",
      compositeOperation: "source-over",
      opacity: 0.2,
    },
  }));
  assert.ok(normalized);
  assert.equal(normalized.kind, "highlighter");
  if (normalized.kind === "highlighter") {
    assert.equal(normalized.style.brushShape, "round");
    assert.equal(normalized.style.compositeOperation, "source-over");
    assert.equal(normalized.style.opacity, 0.2);
  }
});
