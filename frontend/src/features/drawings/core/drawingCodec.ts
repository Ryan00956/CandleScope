import {
  createDrawingDocument,
  createDrawingEntity,
  isCanonicalDrawingEntity,
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "./drawingDocument.js";
import type {
  CanonicalDrawingGeometry,
  DrawingDocument,
  DrawingEntity,
  DrawingStyle,
} from "./drawingDocument.js";
import { observeDrawingId } from "../drawingModel.js";
import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
  normalizeSavedDrawingItemStrict,
} from "../drawingPersistence.js";
import type { DrawingKind, SavedDrawing } from "../drawingTypes.js";

const ID_PREFIX: Readonly<Record<DrawingKind, string>> = Object.freeze({
  line: "ln",
  "axis-line": "ax",
  "angle-measure": "ang",
  text: "tx",
  fibonacci: "fib",
  position: "pos",
  shape: "sh",
  freehand: "fh",
  highlighter: "hl",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : null;
  } catch {
    return null;
  }
}

function declaredFreehandPayloadCounts(item: unknown): { points: number; spans: number } {
  if (!isRecord(item)
    || (item.type !== "freehand" && item.type !== "highlighter")) {
    return { points: 0, spans: 0 };
  }
  const stroke = isRecord(item.stroke) ? item.stroke : null;
  return {
    points: (Array.isArray(item.dataPoints) ? item.dataPoints.length : 0)
      + (Array.isArray(stroke?.points) ? stroke.points.length : 0),
    spans: Array.isArray(stroke?.spans) ? stroke.spans.length : 0,
  };
}

function normalizedFreehandPayloadCounts(item: SavedDrawing): { points: number; spans: number } {
  if (item.type !== "freehand" && item.type !== "highlighter") {
    return { points: 0, spans: 0 };
  }
  if (item.stroke !== undefined) {
    return { points: item.stroke.points.length, spans: item.stroke.spans.length };
  }
  return { points: item.dataPoints.length, spans: 0 };
}

function withinAggregateBudgets(
  items: readonly unknown[],
  count: (item: unknown) => { points: number; spans: number },
): boolean {
  let totalPoints = 0;
  let totalSpans = 0;
  for (const item of items) {
    const payload = count(item);
    totalPoints += payload.points;
    totalSpans += payload.spans;
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS
      || totalSpans > MAX_SAVED_FREEHAND_SPANS) {
      return false;
    }
  }
  return true;
}

function nextAvailableId(
  kind: DrawingKind,
  usedIds: ReadonlySet<string>,
  counters: Map<string, number>,
): string {
  const prefix = ID_PREFIX[kind];
  let counter = counters.get(prefix) ?? 0;
  let candidate = "";
  do {
    counter += 1;
    candidate = `${prefix}_${counter}`;
  } while (usedIds.has(candidate));
  counters.set(prefix, counter);
  return candidate;
}

function createEntityFromSavedDrawing(item: SavedDrawing, id: string): DrawingEntity {
  let geometry: CanonicalDrawingGeometry;
  let style: DrawingStyle;

  switch (item.type) {
    case "line":
      geometry = {
        kind: "line",
        ...(item.lineType === undefined ? {} : { lineType: item.lineType }),
        ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      };
      style = {
        kind: "line",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      };
      break;
    case "axis-line":
      geometry = {
        kind: "axis-line",
        ...(item.axisLineType === undefined ? {} : { axisLineType: item.axisLineType }),
        ...(item.dataPoint === undefined ? {} : { dataPoint: item.dataPoint }),
      };
      style = {
        kind: "axis-line",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      };
      break;
    case "angle-measure":
      geometry = {
        kind: "angle-measure",
        ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      };
      style = {
        kind: "angle-measure",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      };
      break;
    case "text":
      geometry = {
        kind: "text",
        ...(item.dataPoint === undefined ? {} : { dataPoint: item.dataPoint }),
      };
      style = {
        kind: "text",
        ...(item.text === undefined ? {} : { text: item.text }),
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.fontSize === undefined ? {} : { fontSize: item.fontSize }),
        ...(item.fontFamily === undefined ? {} : { fontFamily: item.fontFamily }),
        ...(item.bold === undefined ? {} : { bold: item.bold }),
        ...(item.italic === undefined ? {} : { italic: item.italic }),
        ...(item.underline === undefined ? {} : { underline: item.underline }),
        ...(item.align === undefined ? {} : { align: item.align }),
        ...(item.bgColor === undefined ? {} : { bgColor: item.bgColor }),
        ...(item.borderColor === undefined ? {} : { borderColor: item.borderColor }),
        ...(item.borderWidth === undefined ? {} : { borderWidth: item.borderWidth }),
        ...(item.widthPx === undefined ? {} : { widthPx: item.widthPx }),
        ...(item.padding === undefined ? {} : { padding: item.padding }),
      };
      break;
    case "fibonacci":
      geometry = {
        kind: "fibonacci",
        ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
        ...(item.inverted === undefined ? {} : { inverted: item.inverted }),
      };
      style = {
        kind: "fibonacci",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
        ...(item.levels === undefined ? {} : { levels: item.levels }),
      };
      break;
    case "position":
      geometry = {
        kind: "position",
        ...(item.direction === undefined ? {} : { direction: item.direction }),
        ...(item.entryPrice === undefined ? {} : { entryPrice: item.entryPrice }),
        ...(item.tpPrice === undefined ? {} : { tpPrice: item.tpPrice }),
        ...(item.slPrice === undefined ? {} : { slPrice: item.slPrice }),
        ...(item.timeRange === undefined ? {} : { timeRange: item.timeRange }),
      };
      style = {
        kind: "position",
        ...(item.positionSize === undefined ? {} : { positionSize: item.positionSize }),
        ...(item.infoPanelOffset === undefined ? {} : { infoPanelOffset: item.infoPanelOffset }),
      };
      break;
    case "shape":
      geometry = {
        kind: "shape",
        ...(item.shapeType === undefined ? {} : { shapeType: item.shapeType }),
        ...(item.dataPoints === undefined ? {} : { dataPoints: item.dataPoints }),
      };
      style = {
        kind: "shape",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
        ...(item.fillColor === undefined ? {} : { fillColor: item.fillColor }),
        ...(item.fillOpacity === undefined ? {} : { fillOpacity: item.fillOpacity }),
        ...(item.lineStyle === undefined ? {} : { lineStyle: item.lineStyle }),
      };
      break;
    case "freehand":
      geometry = item.stroke !== undefined
        ? { kind: "freehand", stroke: item.stroke }
        : { kind: "freehand", dataPoints: item.dataPoints };
      style = {
        kind: "freehand",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
      };
      break;
    case "highlighter":
      geometry = item.stroke !== undefined
        ? { kind: "highlighter", stroke: item.stroke }
        : { kind: "highlighter", dataPoints: item.dataPoints };
      style = {
        kind: "highlighter",
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.lineWidth === undefined ? {} : { lineWidth: item.lineWidth }),
        ...(item.opacity === undefined ? {} : { opacity: item.opacity }),
        ...(item.compositeOperation === undefined
          ? {}
          : { compositeOperation: item.compositeOperation }),
        ...(item.brushShape === undefined ? {} : { brushShape: item.brushShape }),
      };
      break;
  }

  return createDrawingEntity({ id, kind: item.type, geometry, style });
}

function copyDefinedFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

/** Convert one canonical entity back into the legacy-compatible wire contract. */
export function savedDrawingFromEntity(entity: DrawingEntity): SavedDrawing | null {
  try {
    const canonical = isCanonicalDrawingEntity(entity)
      ? entity
      : createDrawingEntity(entity);
    if (canonical.geometry.kind !== canonical.kind || canonical.style.kind !== canonical.kind) {
      return null;
    }
    const geometry = canonical.geometry as unknown as Record<string, unknown>;
    const style = canonical.style as unknown as Record<string, unknown>;
    const candidate: Record<string, unknown> = { type: canonical.kind, id: canonical.id };

    switch (canonical.kind) {
      case "line":
        copyDefinedFields(candidate, geometry, ["lineType", "dataPoints"]);
        copyDefinedFields(candidate, style, ["color", "lineWidth"]);
        break;
      case "axis-line":
        copyDefinedFields(candidate, geometry, ["axisLineType", "dataPoint"]);
        copyDefinedFields(candidate, style, ["color", "lineWidth"]);
        break;
      case "angle-measure":
        copyDefinedFields(candidate, geometry, ["dataPoints"]);
        copyDefinedFields(candidate, style, ["color", "lineWidth"]);
        break;
      case "text":
        copyDefinedFields(candidate, geometry, ["dataPoint"]);
        copyDefinedFields(candidate, style, [
          "text",
          "color",
          "fontSize",
          "fontFamily",
          "bold",
          "italic",
          "underline",
          "align",
          "bgColor",
          "borderColor",
          "borderWidth",
          "widthPx",
          "padding",
        ]);
        break;
      case "fibonacci":
        copyDefinedFields(candidate, geometry, ["dataPoints", "inverted"]);
        copyDefinedFields(candidate, style, ["color", "lineWidth", "levels"]);
        break;
      case "position":
        copyDefinedFields(candidate, geometry, [
          "direction",
          "entryPrice",
          "tpPrice",
          "slPrice",
          "timeRange",
        ]);
        copyDefinedFields(candidate, style, ["positionSize", "infoPanelOffset"]);
        break;
      case "shape":
        copyDefinedFields(candidate, geometry, ["shapeType", "dataPoints"]);
        copyDefinedFields(candidate, style, [
          "color",
          "lineWidth",
          "fillColor",
          "fillOpacity",
          "lineStyle",
        ]);
        break;
      case "freehand":
        copyDefinedFields(candidate, geometry, ["stroke", "dataPoints"]);
        copyDefinedFields(candidate, style, ["color", "lineWidth"]);
        break;
      case "highlighter":
        copyDefinedFields(candidate, geometry, ["stroke", "dataPoints"]);
        copyDefinedFields(candidate, style, [
          "color",
          "lineWidth",
          "opacity",
          "compositeOperation",
          "brushShape",
        ]);
        break;
    }
    return normalizeSavedDrawingItemStrict(candidate);
  } catch {
    return null;
  }
}

/**
 * Decode the existing SavedDrawing JSON-array format into the canonical store.
 * Invalid entries are never skipped: one corrupt/duplicate/over-budget item
 * rejects the whole payload so a caller can preserve the last known-good state.
 */
export function importSavedDrawings(scopeKey: string, value: unknown): DrawingDocument | null {
  if (typeof scopeKey !== "string" || scopeKey.length === 0 || !Array.isArray(value)) return null;
  if (value.length > MAX_SAVED_DRAWINGS || value.length > MAX_DRAWING_DOCUMENT_ENTITIES) return null;
  const length = serializedLength(value);
  if (length === null || length > MAX_DRAWING_STORAGE_CHARS) return null;
  if (!withinAggregateBudgets(value, declaredFreehandPayloadCounts)) return null;

  const normalized: SavedDrawing[] = [];
  for (const candidate of value) {
    const item = normalizeSavedDrawingItemStrict(candidate);
    if (!item) return null;
    normalized.push(item);
  }
  if (!withinAggregateBudgets(normalized, (item) => normalizedFreehandPayloadCounts(item as SavedDrawing))) {
    return null;
  }

  const usedIds = new Set<string>();
  for (const item of normalized) {
    if (!item.id) continue;
    if (usedIds.has(item.id)) return null;
    usedIds.add(item.id);
  }

  const counters = new Map<string, number>();
  const entities: DrawingEntity[] = [];
  try {
    for (const item of normalized) {
      const id = item.id || nextAvailableId(item.type, usedIds, counters);
      usedIds.add(id);
      entities.push(createEntityFromSavedDrawing(item, id));
    }
    const document = createDrawingDocument({
      scopeKey,
      entities,
      zOrder: entities.map((entity) => entity.id),
    });
    for (const entity of entities) observeDrawingId(entity.id);
    return document;
  } catch {
    return null;
  }
}

/** Export a canonical snapshot in stable z-order using the old JSON wire format. */
export function exportDrawingDocument(document: DrawingDocument): SavedDrawing[] | null {
  try {
    if (!document || document.schemaVersion !== DRAWING_DOCUMENT_SCHEMA_VERSION
      || typeof document.scopeKey !== "string"
      || !Number.isSafeInteger(document.documentRevision)
      || document.documentRevision < 0
      || document.entities.size > MAX_SAVED_DRAWINGS
      || document.entities.size > MAX_DRAWING_DOCUMENT_ENTITIES) {
      return null;
    }
    if (document.zOrder.length !== document.entities.size
      || new Set(document.zOrder).size !== document.zOrder.length) {
      return null;
    }
    const items: SavedDrawing[] = [];
    for (const id of document.zOrder) {
      const entity = document.entities.get(id);
      if (!entity || entity.id !== id) return null;
      const item = savedDrawingFromEntity(entity);
      if (!item) return null;
      items.push(item);
    }
    if (!withinAggregateBudgets(items, (item) => normalizedFreehandPayloadCounts(item as SavedDrawing))) {
      return null;
    }
    const length = serializedLength(items);
    return length !== null && length <= MAX_DRAWING_STORAGE_CHARS ? items : null;
  } catch {
    return null;
  }
}
