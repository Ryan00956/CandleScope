import type {
  AxisLineType,
  BasicLineToolId,
  BrushShape,
  DrawingDataPoint,
  DrawingKind,
  FibonacciLevel,
  FreehandStroke,
  PositionDirection,
  PositionInfoPanelOffset,
  PositionTimeRange,
  ShapeLineStyle,
  ShapeType,
  TextAlign,
} from "../drawingTypes.js";

export const DRAWING_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_DRAWING_DOCUMENT_ENTITIES = 512;

export type CanonicalBounds =
  | Readonly<{ kind: "deferred" }>
  | Readonly<{ kind: "unbounded"; axis: "horizontal" | "vertical" | "both" }>
  | Readonly<{
      kind: "bounded";
      minTime: number;
      maxTime: number;
      minPrice: number;
      maxPrice: number;
    }>;

export type CanonicalDrawingGeometry =
  | Readonly<{
      kind: "line";
      lineType?: BasicLineToolId;
      dataPoints?: readonly DrawingDataPoint[];
    }>
  | Readonly<{
      kind: "axis-line";
      axisLineType?: AxisLineType;
      dataPoint?: DrawingDataPoint;
    }>
  | Readonly<{
      kind: "angle-measure";
      dataPoints?: readonly DrawingDataPoint[];
    }>
  | Readonly<{
      kind: "text";
      dataPoint?: DrawingDataPoint;
    }>
  | Readonly<{
      kind: "fibonacci";
      dataPoints?: readonly DrawingDataPoint[];
      inverted?: boolean;
    }>
  | Readonly<{
      kind: "position";
      direction?: PositionDirection;
      entryPrice?: number;
      tpPrice?: number | null;
      slPrice?: number | null;
      timeRange?: PositionTimeRange;
    }>
  | Readonly<{
      kind: "shape";
      shapeType?: ShapeType;
      dataPoints?: readonly DrawingDataPoint[];
    }>
  | Readonly<{
      kind: "freehand" | "highlighter";
      stroke?: FreehandStroke;
      dataPoints?: readonly DrawingDataPoint[];
    }>;

export type DrawingStyle =
  | Readonly<{
      kind: "line" | "axis-line" | "angle-measure";
      color?: string;
      lineWidth?: number;
    }>
  | Readonly<{
      kind: "text";
      text?: string;
      color?: string;
      fontSize?: number;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      align?: TextAlign;
      bgColor?: string | null;
      borderColor?: string | null;
      borderWidth?: number;
      widthPx?: number | null;
      padding?: number;
    }>
  | Readonly<{
      kind: "fibonacci";
      color?: string;
      lineWidth?: number;
      levels?: readonly FibonacciLevel[];
    }>
  | Readonly<{
      kind: "position";
      positionSize?: number;
      infoPanelOffset?: PositionInfoPanelOffset;
    }>
  | Readonly<{
      kind: "shape";
      color?: string;
      lineWidth?: number;
      fillColor?: string;
      fillOpacity?: number;
      lineStyle?: ShapeLineStyle;
    }>
  | Readonly<{
      kind: "freehand";
      color?: string;
      lineWidth?: number;
    }>
  | Readonly<{
      kind: "highlighter";
      color?: string;
      lineWidth?: number;
      opacity?: number;
      compositeOperation?: GlobalCompositeOperation;
      brushShape?: BrushShape;
    }>;

export interface DrawingEntity {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly geometry: CanonicalDrawingGeometry;
  readonly style: DrawingStyle;
  readonly bounds: CanonicalBounds;
}

export interface DrawingDocument {
  readonly schemaVersion: typeof DRAWING_DOCUMENT_SCHEMA_VERSION;
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly entities: ReadonlyMap<string, DrawingEntity>;
  readonly zOrder: readonly string[];
}

export interface DrawingEntityInput {
  id: string;
  kind: DrawingKind;
  geometry: CanonicalDrawingGeometry;
  style: DrawingStyle;
  geometryRevision?: number;
  styleRevision?: number;
  bounds?: CanonicalBounds;
}

export interface DrawingDocumentInput {
  scopeKey: string;
  entities?: Iterable<readonly [string, DrawingEntity]> | readonly DrawingEntity[];
  zOrder?: readonly string[];
  documentRevision?: number;
}

class FrozenReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #source: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#source = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#source.size; }
  get(key: K): V | undefined { return this.#source.get(key); }
  has(key: K): boolean { return this.#source.has(key); }
  entries(): MapIterator<[K, V]> { return this.#source.entries(); }
  keys(): MapIterator<K> { return this.#source.keys(); }
  values(): MapIterator<V> { return this.#source.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#source) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#source[Symbol.iterator](); }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreezeCanonical<T>(value: T, seen = new WeakSet<object>()): T {
  if (Array.isArray(value)) {
    const values = value as readonly unknown[];
    if (seen.has(values)) throw new TypeError("Drawing document values must not be cyclic");
    seen.add(values);
    const clone = values.map((entry) => cloneAndFreezeCanonical(entry, seen));
    seen.delete(values);
    return Object.freeze(clone) as T;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError("Drawing document values must not be cyclic");
    seen.add(value);
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneAndFreezeCanonical(entry, seen);
    }
    seen.delete(value);
    return Object.freeze(clone) as T;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Drawing document numbers must be finite");
  }
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return value;
  }
  throw new TypeError("Drawing document values must be plain serializable data");
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validEntityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "__preview__";
}

function matchingKind(
  kind: DrawingKind,
  geometry: CanonicalDrawingGeometry,
  style: DrawingStyle,
): boolean {
  if (geometry.kind !== kind || style.kind !== kind) return false;
  const geometryKeys: Record<DrawingKind, readonly string[]> = {
    "angle-measure": ["dataPoints", "kind"],
    "axis-line": ["axisLineType", "dataPoint", "kind"],
    fibonacci: ["dataPoints", "inverted", "kind"],
    freehand: ["dataPoints", "kind", "stroke"],
    highlighter: ["dataPoints", "kind", "stroke"],
    line: ["dataPoints", "kind", "lineType"],
    position: ["direction", "entryPrice", "kind", "slPrice", "timeRange", "tpPrice"],
    shape: ["dataPoints", "kind", "shapeType"],
    text: ["dataPoint", "kind"],
  };
  const styleKeys: Record<DrawingKind, readonly string[]> = {
    "angle-measure": ["color", "kind", "lineWidth"],
    "axis-line": ["color", "kind", "lineWidth"],
    fibonacci: ["color", "kind", "levels", "lineWidth"],
    freehand: ["color", "kind", "lineWidth"],
    highlighter: ["brushShape", "color", "compositeOperation", "kind", "lineWidth", "opacity"],
    line: ["color", "kind", "lineWidth"],
    position: ["infoPanelOffset", "kind", "positionSize"],
    shape: ["color", "fillColor", "fillOpacity", "kind", "lineStyle", "lineWidth"],
    text: [
      "align", "bgColor", "bold", "borderColor", "borderWidth", "color", "fontFamily",
      "fontSize", "italic", "kind", "padding", "text", "underline", "widthPx",
    ],
  };
  const geometryAllowed = new Set(geometryKeys[kind]);
  const styleAllowed = new Set(styleKeys[kind]);
  if (Object.keys(geometry).some((key) => !geometryAllowed.has(key))
    || Object.keys(style).some((key) => !styleAllowed.has(key))) return false;
  const geometryRecord = geometry as Readonly<Record<string, unknown>>;
  if ((kind === "freehand" || kind === "highlighter")
    && geometryRecord.stroke !== undefined
    && geometryRecord.dataPoints !== undefined) return false;
  return true;
}

export function canonicalDrawingValueEquals(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length
      && first.every((value, index) => canonicalDrawingValueEquals(value, second[index]));
  }
  if (!isPlainObject(first) || !isPlainObject(second)) return false;
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  return firstKeys.length === secondKeys.length
    && firstKeys.every((key) => Object.hasOwn(second, key)
      && canonicalDrawingValueEquals(first[key], second[key]));
}

export function createDrawingEntity(input: DrawingEntityInput): DrawingEntity {
  const geometryRevision = input.geometryRevision ?? 1;
  const styleRevision = input.styleRevision ?? 1;
  if (!validEntityId(input.id)) throw new TypeError("Drawing entity id is invalid");
  if (!validRevision(geometryRevision) || !validRevision(styleRevision)) {
    throw new TypeError("Drawing entity revisions are invalid");
  }
  if (!isPlainObject(input.geometry) || !isPlainObject(input.style)
    || !matchingKind(input.kind, input.geometry, input.style)) {
    throw new TypeError("Drawing entity kind does not match geometry/style");
  }
  const bounds = input.bounds ?? { kind: "deferred" as const };
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    geometryRevision,
    styleRevision,
    geometry: cloneAndFreezeCanonical(input.geometry),
    style: cloneAndFreezeCanonical(input.style),
    bounds: cloneAndFreezeCanonical(bounds),
  });
}

export function cloneDrawingEntity(
  entity: DrawingEntity,
  patch: Partial<Omit<DrawingEntityInput, "id" | "kind">> = {},
): DrawingEntity {
  return createDrawingEntity({
    id: entity.id,
    kind: entity.kind,
    geometry: patch.geometry ?? entity.geometry,
    style: patch.style ?? entity.style,
    geometryRevision: patch.geometryRevision ?? entity.geometryRevision,
    styleRevision: patch.styleRevision ?? entity.styleRevision,
    bounds: patch.bounds ?? entity.bounds,
  });
}

function entityEntries(
  source: DrawingDocumentInput["entities"],
): Array<readonly [string, DrawingEntity]> {
  if (!source) return [];
  if (Array.isArray(source)) {
    if (source.length === 0) return [];
    if (Array.isArray(source[0])) {
      return source as unknown as Array<readonly [string, DrawingEntity]>;
    }
    return (source as readonly DrawingEntity[]).map((entity) => [entity.id, entity] as const);
  }
  return Array.from(source as Iterable<readonly [string, DrawingEntity]>);
}

export function createDrawingDocument(input: DrawingDocumentInput): DrawingDocument {
  const revision = input.documentRevision ?? 0;
  if (typeof input.scopeKey !== "string" || !validRevision(revision)) {
    throw new TypeError("Drawing document scope/revision is invalid");
  }
  const entries = entityEntries(input.entities);
  if (entries.length > MAX_DRAWING_DOCUMENT_ENTITIES) {
    throw new RangeError("Drawing document entity budget exceeded");
  }
  const mutable = new Map<string, DrawingEntity>();
  for (const [key, entity] of entries) {
    if (key !== entity.id || mutable.has(key)) {
      throw new TypeError("Drawing document contains duplicate or mismatched ids");
    }
    mutable.set(key, createDrawingEntity(entity));
  }
  const zOrder = input.zOrder ? [...input.zOrder] : [...mutable.keys()];
  if (zOrder.length !== mutable.size || new Set(zOrder).size !== zOrder.length
    || zOrder.some((id) => !mutable.has(id))) {
    throw new TypeError("Drawing document z-order is not a bijection");
  }
  return Object.freeze({
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION,
    scopeKey: input.scopeKey,
    documentRevision: revision,
    entities: new FrozenReadonlyMap(mutable),
    zOrder: Object.freeze(zOrder),
  });
}

/**
 * Commit a command-owned draft without deep-cloning every unchanged entity.
 * The command reducer may call this only with values taken from an existing
 * immutable document or produced by createDrawingEntity/cloneDrawingEntity.
 */
export function commitDrawingDocumentDraft(
  document: DrawingDocument,
  entities: ReadonlyMap<string, DrawingEntity>,
  zOrderInput: readonly string[],
): DrawingDocument {
  const nextRevision = document.documentRevision + 1;
  if (document.schemaVersion !== DRAWING_DOCUMENT_SCHEMA_VERSION
    || !validRevision(nextRevision)
    || entities.size > MAX_DRAWING_DOCUMENT_ENTITIES) {
    throw new TypeError("Drawing document command draft is invalid");
  }
  const zOrder = [...zOrderInput];
  if (zOrder.length !== entities.size
    || new Set(zOrder).size !== zOrder.length
    || zOrder.some((id) => !entities.has(id))) {
    throw new TypeError("Drawing document command z-order is not a bijection");
  }
  for (const [id, entity] of entities) {
    if (id !== entity.id || !Object.isFrozen(entity)) {
      throw new TypeError("Drawing document command entity is not canonical");
    }
  }
  return Object.freeze({
    schemaVersion: DRAWING_DOCUMENT_SCHEMA_VERSION,
    scopeKey: document.scopeKey,
    documentRevision: nextRevision,
    entities: new FrozenReadonlyMap(entities),
    zOrder: Object.freeze(zOrder),
  });
}

export function createEmptyDrawingDocument(scopeKey: string): DrawingDocument {
  return createDrawingDocument({ scopeKey });
}

export function cloneDrawingDocument(document: DrawingDocument): DrawingDocument {
  return createDrawingDocument({
    documentRevision: document.documentRevision,
    entities: [...document.entities.values()],
    scopeKey: document.scopeKey,
    zOrder: document.zOrder,
  });
}

export function tryCreateDrawingDocument(input: DrawingDocumentInput): DrawingDocument | null {
  try {
    return createDrawingDocument(input);
  } catch {
    return null;
  }
}

export function drawingDocumentEntitiesInOrder(
  document: DrawingDocument,
): readonly DrawingEntity[] {
  return Object.freeze(document.zOrder.map((id) => {
    const entity = document.entities.get(id);
    if (!entity) throw new TypeError("Drawing document z-order is corrupt");
    return entity;
  }));
}
