export const DRAWING_LOD_SELECTED_EDIT_TOLERANCE_CSS_PX = 0.35;
export const DRAWING_LOD_NORMAL_STATIC_TOLERANCE_CSS_PX = 0.75;
export const DRAWING_LOD_CONTINUOUS_VIEWPORT_TOLERANCE_CSS_PX = 1.25;
export const DRAWING_LOD_SETTLED_EXACT_TOLERANCE_CSS_PX = 0.5;

export const DRAWING_LOD_TOLERANCE_CSS_PX = Object.freeze({
  selectedEdit: DRAWING_LOD_SELECTED_EDIT_TOLERANCE_CSS_PX,
  normalStatic: DRAWING_LOD_NORMAL_STATIC_TOLERANCE_CSS_PX,
  continuousViewport: DRAWING_LOD_CONTINUOUS_VIEWPORT_TOLERANCE_CSS_PX,
  settledExact: DRAWING_LOD_SETTLED_EXACT_TOLERANCE_CSS_PX,
} as const);

export type DrawingLodToleranceClass = keyof typeof DRAWING_LOD_TOLERANCE_CSS_PX;

export const DRAWING_LOD_MIN_VERTICES_PER_CSS_PX = 2;
export const DRAWING_LOD_MAX_VERTICES_PER_CSS_PX = 3;
export const DRAWING_LOD_DEFAULT_MAX_VERTICES_PER_CSS_PX = 3;

export const DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
export const DRAWING_LOD_MAX_CACHE_BUDGET_BYTES = 96 * 1024 * 1024;

export interface DrawingLodPathHierarchy {
  /** First finite source point in this continuous path. */
  readonly startPointIndex: number;
  /** Exclusive source point end. */
  readonly endPointIndex: number;
  readonly pointCount: number;
}

export interface DrawingLodHierarchy {
  readonly pointCount: number;
  readonly finitePointCount: number;
  readonly gapPointCount: number;
  readonly paths: readonly DrawingLodPathHierarchy[];
  /**
   * Effective nested RDP importance in CSS pixels. Path endpoints are
   * Infinity and gap entries are NaN. A point selected at tolerance T remains
   * selected for every smaller tolerance.
   */
  readonly importanceCssPx: Readonly<Float64Array>;
  /** Deterministic construction-work evidence for adversarial paths. */
  readonly distanceCheckCount: number;
  /** Estimated retained bytes; the caller-owned raw coordinate buffer is not retained. */
  readonly estimatedByteSize: number;
}

export interface DrawingLodHierarchyOptions {
  /**
   * Stop refining once a nested segment cannot exceed this selection
   * tolerance. Callers must not use the resulting hierarchy below this floor.
   * The default zero retains the complete reusable hierarchy.
   */
  readonly minimumImportanceCssPx?: number;
  /** Internal scratch reuse; ownership transfers to the returned hierarchy. */
  readonly importanceBuffer?: Float64Array;
}

export interface DrawingLodSelectedPath {
  readonly sourceStartPointIndex: number;
  readonly sourceEndPointIndex: number;
  readonly selectedIndexOffset: number;
  readonly selectedIndexCount: number;
}

export interface DrawingLodSelectionOptions {
  readonly toleranceClass: DrawingLodToleranceClass;
  readonly visibleWidthCssPx: number;
  /** Optional conservative share of the class error budget used by RDP. */
  readonly simplificationToleranceCssPx?: number;
  /** Must remain in the documented 2-3 vertices/CSS-pixel range. */
  readonly maxVerticesPerCssPx?: number;
}

export interface DrawingLodSelection {
  readonly toleranceClass: DrawingLodToleranceClass;
  readonly baseToleranceCssPx: number;
  readonly effectiveToleranceCssPx: number;
  readonly visibleWidthCssPx: number;
  readonly maxVerticesPerCssPx: number;
  readonly vertexBudget: number;
  readonly capSatisfied: boolean;
  readonly selectedPointCount: number;
  /** Source indexes, ordered by path and then by source position. */
  readonly pointIndexes: Readonly<Uint32Array>;
  /** Offsets into pointIndexes at which every path after the first starts. */
  readonly pathBreaks: Readonly<Uint32Array>;
  readonly paths: readonly DrawingLodSelectedPath[];
}

function finiteCoordinatePair(coordinates: Float64Array, pointIndex: number): boolean {
  const offset = pointIndex * 2;
  return Number.isFinite(coordinates[offset]) && Number.isFinite(coordinates[offset + 1]);
}

function pointSegmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) {
    const pointDx = px - ax;
    const pointDy = py - ay;
    return pointDx * pointDx + pointDy * pointDy;
  }
  const projection = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const nearestX = ax + projection * dx;
  const nearestY = ay + projection * dy;
  const pointDx = px - nearestX;
  const pointDy = py - nearestY;
  return pointDx * pointDx + pointDy * pointDy;
}

function assignNestedRdpImportance(
  coordinates: Float64Array,
  importanceCssPx: Float64Array,
  path: DrawingLodPathHierarchy,
  minimumImportanceCssPx: number,
): number {
  let distanceCheckCount = 0;
  const firstPointIndex = path.startPointIndex;
  const lastPointIndex = path.endPointIndex - 1;
  importanceCssPx[firstPointIndex] = Number.POSITIVE_INFINITY;
  importanceCssPx[lastPointIndex] = Number.POSITIVE_INFINITY;
  if (lastPointIndex - firstPointIndex <= 1) return distanceCheckCount;

  // Interleave start/end/parent in one primitive-number stack. Dense paths can
  // visit hundreds of hierarchy segments; avoiding one object per pending
  // segment keeps viewport LOD construction off the young-generation GC path.
  const pending = [firstPointIndex, lastPointIndex, Number.POSITIVE_INFINITY];

  while (pending.length >= 3) {
    const parentImportanceCssPx = Number(pending.pop());
    const endPointIndex = Number(pending.pop());
    const startPointIndex = Number(pending.pop());
    if (endPointIndex - startPointIndex <= 1) continue;
    const startOffset = startPointIndex * 2;
    const endOffset = endPointIndex * 2;
    const ax = coordinates[startOffset];
    const ay = coordinates[startOffset + 1];
    const bx = coordinates[endOffset];
    const by = coordinates[endOffset + 1];
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;

    const pivotPointIndex = Math.floor(
      (startPointIndex + endPointIndex) / 2,
    );
    let maximumDistanceSquared = -1;
    for (
      let pointIndex = startPointIndex + 1;
      pointIndex < endPointIndex;
      pointIndex += 1
    ) {
      distanceCheckCount += 1;
      const offset = pointIndex * 2;
      const px = coordinates[offset];
      const py = coordinates[offset + 1];
      if (px === undefined || py === undefined) continue;
      const distanceSquared = pointSegmentDistanceSquared(px, py, ax, ay, bx, by);
      if (distanceSquared > maximumDistanceSquared) {
        maximumDistanceSquared = distanceSquared;
      }
    }
    if (maximumDistanceSquared <= 0) continue;

    // Split at the source midpoint, while assigning the segment's true maximum
    // error to that split. This remains a nested screen-error hierarchy but
    // gives construction a deterministic O(n log n) work bound instead of the
    // single-point peeling/O(n^2) worst case of maximum-point RDP.
    const localImportanceCssPx = Math.sqrt(maximumDistanceSquared);
    const effectiveImportanceCssPx = Math.min(
      parentImportanceCssPx,
      localImportanceCssPx,
    );
    importanceCssPx[pivotPointIndex] = effectiveImportanceCssPx;
    if (effectiveImportanceCssPx <= minimumImportanceCssPx) continue;
    pending.push(
      pivotPointIndex,
      endPointIndex,
      effectiveImportanceCssPx,
      startPointIndex,
      pivotPointIndex,
      effectiveImportanceCssPx,
    );
  }
  return distanceCheckCount;
}

function createContinuousPaths(coordinates: Float64Array): readonly DrawingLodPathHierarchy[] {
  const pointCount = coordinates.length / 2;
  const paths: DrawingLodPathHierarchy[] = [];
  let pointIndex = 0;
  while (pointIndex < pointCount) {
    while (pointIndex < pointCount && !finiteCoordinatePair(coordinates, pointIndex)) pointIndex += 1;
    if (pointIndex >= pointCount) break;
    const startPointIndex = pointIndex;
    while (pointIndex < pointCount && finiteCoordinatePair(coordinates, pointIndex)) pointIndex += 1;
    const endPointIndex = pointIndex;
    paths.push(Object.freeze({
      startPointIndex,
      endPointIndex,
      pointCount: endPointIndex - startPointIndex,
    }));
  }
  return Object.freeze(paths);
}

/**
 * Build a screen-space hierarchy without retaining or mutating the caller's
 * raw Float64 coordinates. Non-finite pairs split paths and are never sampled.
 */
export function createDrawingLodHierarchy(
  coordinates: Float64Array,
  options: DrawingLodHierarchyOptions = {},
): DrawingLodHierarchy {
  if (!(coordinates instanceof Float64Array) || coordinates.length % 2 !== 0) {
    throw new TypeError("drawing LOD coordinates must be an interleaved Float64Array");
  }
  const minimumImportanceCssPx = options.minimumImportanceCssPx ?? 0;
  if (!Number.isFinite(minimumImportanceCssPx) || minimumImportanceCssPx < 0) {
    throw new RangeError("drawing LOD minimum importance must be finite and non-negative");
  }
  const pointCount = coordinates.length / 2;
  const paths = createContinuousPaths(coordinates);
  const importanceCssPx = options.importanceBuffer ?? new Float64Array(pointCount);
  if (!(importanceCssPx instanceof Float64Array) || importanceCssPx.length !== pointCount) {
    throw new RangeError("drawing LOD importance buffer length must match its point count");
  }
  importanceCssPx.fill(Number.NaN);
  let finitePointCount = 0;
  let distanceCheckCount = 0;
  for (const path of paths) {
    finitePointCount += path.pointCount;
    for (let pointIndex = path.startPointIndex; pointIndex < path.endPointIndex; pointIndex += 1) {
      importanceCssPx[pointIndex] = 0;
    }
    distanceCheckCount += assignNestedRdpImportance(
      coordinates,
      importanceCssPx,
      path,
      minimumImportanceCssPx,
    );
  }
  const estimatedByteSize = importanceCssPx.byteLength
    + paths.length * 3 * Float64Array.BYTES_PER_ELEMENT;
  return Object.freeze({
    pointCount,
    finitePointCount,
    gapPointCount: pointCount - finitePointCount,
    paths,
    importanceCssPx,
    distanceCheckCount,
    estimatedByteSize,
  });
}

function toleranceForClass(toleranceClass: DrawingLodToleranceClass): number {
  const tolerance = DRAWING_LOD_TOLERANCE_CSS_PX[toleranceClass];
  if (tolerance === undefined) throw new TypeError("drawing LOD tolerance class is invalid");
  return tolerance;
}

function normalizedVisibleWidth(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("drawing LOD visible width must be finite and non-negative");
  }
  return value;
}

function normalizedVerticesPerCssPx(value: number | undefined): number {
  const normalized = value ?? DRAWING_LOD_DEFAULT_MAX_VERTICES_PER_CSS_PX;
  if (!Number.isFinite(normalized)
    || normalized < DRAWING_LOD_MIN_VERTICES_PER_CSS_PX
    || normalized > DRAWING_LOD_MAX_VERTICES_PER_CSS_PX) {
    throw new RangeError("drawing LOD vertex density must stay between 2 and 3 per CSS pixel");
  }
  return normalized;
}

function normalizedSimplificationTolerance(
  value: number | undefined,
  classToleranceCssPx: number,
): number {
  if (value === undefined) return classToleranceCssPx;
  if (!Number.isFinite(value) || value < 0 || value > classToleranceCssPx) {
    throw new RangeError("drawing LOD simplification tolerance must fit its class error budget");
  }
  return value;
}

function finiteImportanceAbove(
  hierarchy: DrawingLodHierarchy,
  toleranceCssPx: number,
): number[] {
  const values: number[] = [];
  for (let pointIndex = 0; pointIndex < hierarchy.pointCount; pointIndex += 1) {
    const importance = hierarchy.importanceCssPx[pointIndex];
    if (importance !== undefined && Number.isFinite(importance) && importance > toleranceCssPx) {
      values.push(importance);
    }
  }
  return values;
}

function forcedPointCount(hierarchy: DrawingLodHierarchy): number {
  let count = 0;
  for (let pointIndex = 0; pointIndex < hierarchy.pointCount; pointIndex += 1) {
    if (hierarchy.importanceCssPx[pointIndex] === Number.POSITIVE_INFINITY) count += 1;
  }
  return count;
}

function adaptiveTolerance(
  hierarchy: DrawingLodHierarchy,
  baseToleranceCssPx: number,
  vertexBudget: number,
): number {
  const forced = forcedPointCount(hierarchy);
  if (forced > vertexBudget) return Number.POSITIVE_INFINITY;
  const candidates = finiteImportanceAbove(hierarchy, baseToleranceCssPx);
  const allowedFinite = Math.max(0, vertexBudget - forced);
  if (candidates.length <= allowedFinite) return baseToleranceCssPx;
  candidates.sort((left, right) => right - left);
  const firstExcludedImportance = candidates[allowedFinite];
  return firstExcludedImportance === undefined
    ? baseToleranceCssPx
    : Math.max(baseToleranceCssPx, firstExcludedImportance);
}

function pointSelected(importanceCssPx: number | undefined, toleranceCssPx: number): boolean {
  return importanceCssPx === Number.POSITIVE_INFINITY
    || (importanceCssPx !== undefined
      && Number.isFinite(importanceCssPx)
      && importanceCssPx > toleranceCssPx);
}

/** Select nested source indexes. Density pressure raises tolerance; it never samples every Nth point. */
export function selectDrawingLod(
  hierarchy: DrawingLodHierarchy,
  options: DrawingLodSelectionOptions,
): DrawingLodSelection {
  if (!hierarchy || !(hierarchy.importanceCssPx instanceof Float64Array)
    || hierarchy.importanceCssPx.length !== hierarchy.pointCount) {
    throw new TypeError("drawing LOD hierarchy is invalid");
  }
  const classToleranceCssPx = toleranceForClass(options.toleranceClass);
  const baseToleranceCssPx = normalizedSimplificationTolerance(
    options.simplificationToleranceCssPx,
    classToleranceCssPx,
  );
  const visibleWidthCssPx = normalizedVisibleWidth(options.visibleWidthCssPx);
  const maxVerticesPerCssPx = normalizedVerticesPerCssPx(options.maxVerticesPerCssPx);
  const vertexBudget = Math.max(0, Math.floor(visibleWidthCssPx * maxVerticesPerCssPx));
  // When every finite source point already fits, density pressure cannot
  // raise the tolerance: forced endpoints plus every finite-importance point
  // are bounded by finitePointCount. Skip adaptiveTolerance's two full
  // importance scans on this common 64 x 512 viewport path.
  const effectiveToleranceCssPx = hierarchy.finitePointCount <= vertexBudget
    ? baseToleranceCssPx
    : adaptiveTolerance(
        hierarchy,
        baseToleranceCssPx,
        vertexBudget,
      );
  const selectedIndexes: number[] = [];
  const pathBreaks: number[] = [];
  const selectedPaths: DrawingLodSelectedPath[] = [];

  for (const path of hierarchy.paths) {
    const selectedIndexOffset = selectedIndexes.length;
    for (let pointIndex = path.startPointIndex; pointIndex < path.endPointIndex; pointIndex += 1) {
      if (pointSelected(hierarchy.importanceCssPx[pointIndex], effectiveToleranceCssPx)) {
        selectedIndexes.push(pointIndex);
      }
    }
    const selectedIndexCount = selectedIndexes.length - selectedIndexOffset;
    if (selectedIndexCount === 0) continue;
    if (selectedPaths.length > 0) pathBreaks.push(selectedIndexOffset);
    selectedPaths.push(Object.freeze({
      sourceStartPointIndex: path.startPointIndex,
      sourceEndPointIndex: path.endPointIndex,
      selectedIndexOffset,
      selectedIndexCount,
    }));
  }

  const pointIndexes = new Uint32Array(selectedIndexes);
  return Object.freeze({
    toleranceClass: options.toleranceClass,
    baseToleranceCssPx,
    effectiveToleranceCssPx,
    visibleWidthCssPx,
    maxVerticesPerCssPx,
    vertexBudget,
    capSatisfied: pointIndexes.length <= vertexBudget,
    selectedPointCount: pointIndexes.length,
    pointIndexes,
    pathBreaks: new Uint32Array(pathBreaks),
    paths: Object.freeze(selectedPaths),
  });
}

export type DrawingByteLruRemovalReason =
  | "budget"
  | "replace"
  | "delete"
  | "clear"
  | "oversize"
  | "dispose";

export interface DrawingByteWeightedLruOptions<K, V> {
  readonly budgetBytes?: number;
  readonly onRemove?: (
    value: V,
    key: K,
    reason: DrawingByteLruRemovalReason,
  ) => void;
}

export interface DrawingByteWeightedLruSnapshot<K> {
  readonly budgetBytes: number;
  readonly hardLimitBytes: number;
  readonly totalBytes: number;
  readonly entryCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly budgetEvictionCount: number;
  readonly disposed: boolean;
  readonly keysOldestFirst: readonly K[];
}

interface DrawingByteWeightedLruEntry<V> {
  readonly value: V;
  readonly byteSize: number;
}

function normalizedCacheBudget(value: number | undefined): number {
  const requested = value ?? DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new RangeError("drawing LOD cache budget must be a positive safe integer");
  }
  return Math.min(requested, DRAWING_LOD_MAX_CACHE_BUDGET_BYTES);
}

function normalizedEntryByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("drawing LOD cache entry size must be a non-negative safe integer");
  }
  return value;
}

/** Byte-budgeted LRU with deterministic cleanup for bitmap/cache resource owners. */
export class DrawingByteWeightedLruCache<K, V> {
  readonly #budgetBytes: number;
  readonly #onRemove: ((value: V, key: K, reason: DrawingByteLruRemovalReason) => void) | null;
  readonly #entries = new Map<K, DrawingByteWeightedLruEntry<V>>();
  #totalBytes = 0;
  #hitCount = 0;
  #missCount = 0;
  #budgetEvictionCount = 0;
  #disposed = false;

  constructor(options: DrawingByteWeightedLruOptions<K, V> = {}) {
    this.#budgetBytes = normalizedCacheBudget(options.budgetBytes);
    this.#onRemove = options.onRemove ?? null;
  }

  #notifyRemoved(
    value: V,
    key: K,
    reason: DrawingByteLruRemovalReason,
  ): void {
    try {
      this.#onRemove?.(value, key, reason);
    } catch {
      // Resource cleanup cannot corrupt cache accounting or eviction order.
    }
  }

  #remove(key: K, reason: DrawingByteLruRemovalReason): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#totalBytes = Math.max(0, this.#totalBytes - entry.byteSize);
    this.#notifyRemoved(entry.value, key, reason);
    return true;
  }

  #evictToBudget(): void {
    while (this.#totalBytes > this.#budgetBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      if (!this.#remove(oldest.value, "budget")) break;
      this.#budgetEvictionCount += 1;
    }
  }

  get(key: K): V | undefined {
    if (this.#disposed) {
      this.#missCount += 1;
      return undefined;
    }
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#missCount += 1;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hitCount += 1;
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.#disposed ? undefined : this.#entries.get(key)?.value;
  }

  has(key: K): boolean {
    return !this.#disposed && this.#entries.has(key);
  }

  set(key: K, value: V, byteSize: number): boolean {
    const normalizedByteSize = normalizedEntryByteSize(byteSize);
    if (this.#disposed) {
      this.#notifyRemoved(value, key, "dispose");
      return false;
    }
    this.#remove(key, "replace");
    if (normalizedByteSize > this.#budgetBytes) {
      this.#notifyRemoved(value, key, "oversize");
      return false;
    }
    this.#entries.set(key, Object.freeze({ value, byteSize: normalizedByteSize }));
    this.#totalBytes += normalizedByteSize;
    this.#evictToBudget();
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    return !this.#disposed && this.#remove(key, "delete");
  }

  clear(): void {
    if (this.#disposed) return;
    for (const key of Array.from(this.#entries.keys())) this.#remove(key, "clear");
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const key of Array.from(this.#entries.keys())) this.#remove(key, "dispose");
    this.#disposed = true;
  }

  totalBytes(): number {
    return this.#totalBytes;
  }

  snapshot(): DrawingByteWeightedLruSnapshot<K> {
    return Object.freeze({
      budgetBytes: this.#budgetBytes,
      hardLimitBytes: DRAWING_LOD_MAX_CACHE_BUDGET_BYTES,
      totalBytes: this.#totalBytes,
      entryCount: this.#entries.size,
      hitCount: this.#hitCount,
      missCount: this.#missCount,
      budgetEvictionCount: this.#budgetEvictionCount,
      disposed: this.#disposed,
      keysOldestFirst: Object.freeze(Array.from(this.#entries.keys())),
    });
  }
}
