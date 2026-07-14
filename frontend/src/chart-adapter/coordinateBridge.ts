import {
  DrawingLineageIndex,
  createDrawingLineageIndex,
  isDrawingLineageIndexForSeries,
} from "../features/chart-representation/drawingLineageIndex.js";
import type {
  DisplayRow,
  OrdinalAxisTime,
} from "../features/chart-representation/chartRepresentationTypes.js";
import {
  createFutureIntervalBasis,
  futureIntervalDistanceFromTime,
  futureTimeFromIntervalDistance,
} from "../utils/intervalTimeline.js";
import type { FutureIntervalBasis } from "../utils/intervalTimeline.js";
import {
  createDrawingCoordinateIndex,
  DrawingCoordinateIndex,
} from "./drawingCoordinateIndex.js";
import type { NumericTimeSearchResult } from "./drawingCoordinateIndex.js";
import {
  isDrawingFrameSnapshot,
} from "./drawingFrameSnapshot.js";
import type { DrawingFrameSnapshot } from "./drawingFrameSnapshot.js";

const PROJECTION_METADATA_KEY = "chartProjection";
type ValueProvider<T = unknown> = (() => T) | null;

export interface DrawingAnchor extends CoordinateDataPoint {
  time: number;
  sourceOrdinal?: number;
  sourceProjection?: string;
  sourceProjectionConfig?: string;
}

interface SourceOrdinalAnchor extends DrawingAnchor {
  sourceOrdinal: number;
}

interface DrawingCoordinateSnapshot {
  coordinateIndex?: DrawingCoordinateIndex;
  lineageIndexRevision?: number | null;
  seriesData?: DisplayRow[];
  ordinalSeriesIndex?: DrawingLineageIndex | null;
  indexRevision?: number | null;
  sourceTimeHorizon?: unknown;
  sourceInterval?: unknown;
  sourceIntervalSeconds?: unknown;
  drawingProjectionConfig?: unknown;
}

export interface DrawingCoordinateContext extends Record<string, unknown> {
  drawingCoordinateIndex?: DrawingCoordinateIndex;
  drawingCoordinateProjectorMode?: DrawingCoordinateProjectorMode;
  drawingFrameSnapshot?: DrawingFrameSnapshot;
  seriesData?: DisplayRow[];
  drawingOrdinalSeriesData?: DisplayRow[];
  drawingOrdinalSeriesIndex?: DrawingLineageIndex | null;
  drawingOrdinalSeriesIndexRevision?: number | null;
  drawingProjectionConfig?: unknown;
  projectionConfig?: unknown;
  sourceTimeHorizon?: unknown;
  sourceInterval?: unknown;
  sourceIntervalSeconds?: unknown;
}

export type DrawingCoordinateProjectorMode = "batch" | "parity" | "scalar";

export type DrawingSourceAnchorResolution =
  | Readonly<{
      kind: "numeric-time";
      search: NumericTimeSearchResult;
    }>
  | Readonly<{
      kind: "ordinal-row";
      row: DisplayRow;
    }>
  | Readonly<{
      intervalDistance: number;
      kind: "ordinal-future";
      tailRow: DisplayRow;
    }>;

export type DrawingCoordinateResolution = DrawingSourceAnchorResolution
  | Readonly<{
      kind: "logical";
      logical: number;
    }>;

export interface DrawingSourceLineageSpanResolution {
  readonly envelope: Readonly<{
    left: DrawingCoordinateResolution;
    leftRatio: number;
    right: DrawingCoordinateResolution;
    rightRatio: number;
  }> | null;
  readonly exact: Readonly<{
    left: DrawingCoordinateResolution;
    right: DrawingCoordinateResolution;
  }> | null;
}

export interface DrawingSeriesProviders {
  seriesDataProvider?: ValueProvider<unknown>;
  sourceTimeHorizonProvider?: ValueProvider<unknown>;
  sourceIntervalProvider?: ValueProvider<unknown>;
  sourceIntervalSecondsProvider?: ValueProvider<unknown>;
  projectionConfigProvider?: ValueProvider<unknown>;
  ordinalSeriesIndexProvider?: ValueProvider<unknown>;
  coordinateSnapshotProvider?: ValueProvider<unknown>;
}

interface DrawingSeriesRegistration {
  seriesDataProvider: ValueProvider<unknown>;
  sourceTimeHorizonProvider: ValueProvider<unknown>;
  sourceIntervalProvider: ValueProvider<unknown>;
  sourceIntervalSecondsProvider: ValueProvider<unknown>;
  projectionConfigProvider: ValueProvider<unknown>;
  ordinalSeriesIndexProvider: ValueProvider<unknown>;
  coordinateSnapshotProvider: ValueProvider<unknown>;
}

interface OrdinalFutureCoordinateBasis extends FutureIntervalBasis {
  cellWidth: number;
  index: DrawingLineageIndex;
  tailRow: DisplayRow;
  tailX: number;
}

export interface ScreenPoint {
  x?: unknown;
  y?: unknown;
}

export interface SourceLineageSpan {
  exact: Readonly<{
    left: Readonly<DrawingAnchor>;
    right: Readonly<DrawingAnchor>;
  }>;
  fallback: Readonly<{
    fromTime: number;
    toTime: number;
    leftRatio: number;
    rightRatio: number;
  }>;
}

export interface SourceLineageFreehandCapture extends Record<string, unknown> {
  anchor?: Readonly<DrawingAnchor>;
  price: number;
  ratio?: number;
  screen: Readonly<{ x: number; y: number }>;
  span?: Readonly<SourceLineageSpan>;
  time?: number;
}

export interface SourceLineageSpanInput {
  sourceProjection?: unknown;
  sourceProjectionConfig?: unknown;
  exact?: {
    left?: Readonly<{
      time?: unknown;
      sourceOrdinal?: unknown;
      sourceProjection?: unknown;
      sourceProjectionConfig?: unknown;
    }>;
    right?: Readonly<{
      time?: unknown;
      sourceOrdinal?: unknown;
      sourceProjection?: unknown;
      sourceProjectionConfig?: unknown;
    }>;
  };
  fallback?: {
    fromTime?: unknown;
    toTime?: unknown;
    leftRatio?: unknown;
    rightRatio?: unknown;
  };
}

export interface CoordinateDataPoint extends Record<string, unknown> {
  time?: unknown;
  logical?: unknown;
}

export interface InterpolatedCoordinateAdapter {
  isReady?(): boolean;
  coordinateToLogical?(coordinate: number): number | null | undefined;
  coordinateToTime?(coordinate: number): unknown;
  logicalToCoordinate?(logical: number): number | null | undefined;
  getSeriesIndexByTime?(time: number): unknown;
  getSeriesData?(): DisplayRow[];
  timeToCoordinate?(time: number): number | null | undefined;
}

export interface TimeScaleBridge {
  coordinateToLogical?(coordinate: number): number | null;
  coordinateToTime?(coordinate: number): unknown;
  logicalToCoordinate?(logical: number): number | null;
  options?(): { barSpacing?: unknown };
  timeToCoordinate(time: unknown): number | null;
  width?(): number;
}

export interface CoordinateChartBridge {
  timeScale(): TimeScaleBridge;
}

export interface CoordinateSeriesBridge {
  coordinateToPrice?(coordinate: number): number | null;
  data?(): unknown;
}

interface NumericSeriesBounds {
  firstTime: number;
  lastTime: number;
}

interface CoordinateIndexCacheEntry {
  firstRow: DisplayRow | null;
  firstTime: DisplayRow["time"] | undefined;
  index: DrawingCoordinateIndex;
  lastRow: DisplayRow | null;
  lastTime: DisplayRow["time"] | undefined;
  length: number;
  lineageIndex: DrawingLineageIndex | null;
  lineageRevision: number | null;
}

interface OrdinalFutureProjectionCacheEntry {
  cellWidth: number | null;
  tailRow: DisplayRow;
  tailX: number | null;
  timeScale: TimeScaleBridge;
}

interface OrdinalSeriesIndexCacheEntry {
  firstRow: DisplayRow | null;
  firstTime: DisplayRow["time"] | undefined;
  index: DrawingLineageIndex;
  lastRow: DisplayRow | null;
  lastTime: DisplayRow["time"] | undefined;
  length: number;
}

const ordinalSeriesIndexCache = new WeakMap<DisplayRow[], OrdinalSeriesIndexCacheEntry>();
const coordinateIndexCache = new WeakMap<DisplayRow[], CoordinateIndexCacheEntry>();
const drawingSeriesContextRegistry = new WeakMap<object, DrawingSeriesRegistration>();
const hydratedCoordinateSnapshotContexts = new WeakMap<object, boolean>();
const ordinalFutureProjectionContexts = new WeakMap<object, OrdinalFutureProjectionCacheEntry>();
const ordinalFutureProjectionTransactions = new WeakSet<object>();
const MAX_FREEHAND_CAPTURE_BATCH_POINTS = 4_096;
function configuredDrawingCoordinateProjectorMode(): DrawingCoordinateProjectorMode {
  const meta = import.meta as { readonly env?: Readonly<Record<string, unknown>> };
  const configured = meta.env?.["VITE_DRAWING_COORDINATE_PROJECTOR"];
  return configured === "scalar" || configured === "parity" || configured === "batch"
    ? configured
    : "batch";
}

let defaultDrawingCoordinateProjectorMode: DrawingCoordinateProjectorMode =
  configuredDrawingCoordinateProjectorMode();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRegistryKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeProviderValue<T>(provider: ValueProvider<T> | undefined, fallback: T): T {
  if (typeof provider !== "function") return fallback;
  try {
    return provider();
  } catch {
    return fallback;
  }
}

function normalizeProjectionConfig(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectionConfigFromContext(context: DrawingCoordinateContext | null): string | null {
  return normalizeProjectionConfig(
    context?.drawingProjectionConfig ?? context?.projectionConfig,
  );
}

/**
 * Create a short-lived context for resolving one primitive path. The frame
 * snapshot and pure coordinate index are retained; viewport results are not.
 */
export function createDrawingCoordinateTransactionContext(
  context: DrawingCoordinateContext | null = null,
): DrawingCoordinateContext {
  const transaction: DrawingCoordinateContext = context ? { ...context } : {};
  ordinalFutureProjectionTransactions.add(transaction);
  return transaction;
}

/**
 * Temporary rollout switch used by parity tests and emergency rollback. The
 * returned function restores the previous process-local mode.
 */
export function setDrawingCoordinateProjectorModeForTests(
  mode: DrawingCoordinateProjectorMode,
): () => void {
  if (mode !== "batch" && mode !== "parity" && mode !== "scalar") {
    throw new TypeError("invalid drawing coordinate projector mode");
  }
  const previous = defaultDrawingCoordinateProjectorMode;
  defaultDrawingCoordinateProjectorMode = mode;
  return () => {
    defaultDrawingCoordinateProjectorMode = previous;
  };
}

export function getDrawingCoordinateProjectorMode(
  context: DrawingCoordinateContext | null = null,
): DrawingCoordinateProjectorMode {
  const mode = context?.drawingCoordinateProjectorMode;
  return mode === "batch" || mode === "parity" || mode === "scalar"
    ? mode
    : defaultDrawingCoordinateProjectorMode;
}

function coordinateIndexFor(
  seriesData: DisplayRow[],
  context: DrawingCoordinateContext | null,
): DrawingCoordinateIndex {
  const snapshot = context?.drawingFrameSnapshot;
  if (isDrawingFrameSnapshot(snapshot) && snapshot.seriesData === seriesData) {
    if (context) context.drawingCoordinateIndex = snapshot.coordinateIndex;
    return snapshot.coordinateIndex;
  }

  const contextIndex = context?.drawingCoordinateIndex;
  if (contextIndex?.seriesData === seriesData) {
    const lineageIsCurrent = contextIndex.mode !== "ordinal"
      || (contextIndex.lineageRevision !== null
        && contextIndex.lineageRevision === context?.drawingOrdinalSeriesIndex?.revision);
    if (lineageIsCurrent) return contextIndex;
  }

  const firstRow = seriesData[0] || null;
  const lastRow = seriesData[seriesData.length - 1] || null;
  const cached = coordinateIndexCache.get(seriesData);
  if (cached
    && cached.length === seriesData.length
    && cached.firstRow === firstRow
    && cached.firstTime === firstRow?.time
    && cached.lastRow === lastRow
    && cached.lastTime === lastRow?.time
    && (cached.lineageIndex === null
      || cached.lineageRevision === cached.lineageIndex.revision)) {
    if (context) context.drawingCoordinateIndex = cached.index;
    return cached.index;
  }

  const lineageIndex = isOrdinalAxisTime(firstRow?.time)
    ? getOrdinalSeriesIndex(seriesData, context)
    : null;
  const lineageRevision = lineageIndex?.revision ?? null;
  const index = createDrawingCoordinateIndex(seriesData, { lineageIndex });
  coordinateIndexCache.set(seriesData, {
    firstRow,
    firstTime: firstRow?.time,
    index,
    lastRow,
    lastTime: lastRow?.time,
    length: seriesData.length,
    lineageIndex,
    lineageRevision,
  });
  if (context) context.drawingCoordinateIndex = index;
  return index;
}

function lineageIndexForCoordinateIndex(
  seriesData: DisplayRow[],
  coordinateIndex: DrawingCoordinateIndex,
  context: DrawingCoordinateContext | null,
): DrawingLineageIndex | null {
  const snapshot = context?.drawingFrameSnapshot;
  if (isDrawingFrameSnapshot(snapshot)
    && snapshot.seriesData === seriesData
    && snapshot.coordinateIndex === coordinateIndex
    && snapshot.ordinalSeriesIndex?.revision === snapshot.lineageIndexRevision) {
    return snapshot.ordinalSeriesIndex;
  }
  const contextLineage = context?.drawingOrdinalSeriesIndex;
  if (contextLineage
    && contextLineage.seriesData === seriesData
    && contextLineage.revision === coordinateIndex.lineageRevision) {
    return contextLineage;
  }
  const cached = coordinateIndexCache.get(seriesData);
  return cached?.index === coordinateIndex
    && cached.lineageIndex?.revision === cached.lineageRevision
    ? cached.lineageIndex
    : null;
}

function numericSeriesBounds(
  seriesData: DisplayRow[],
  context: DrawingCoordinateContext | null,
): NumericSeriesBounds | null {
  if (!Array.isArray(seriesData)) return null;
  const index = coordinateIndexFor(seriesData, context);
  const times = index.numericTimes;
  const firstTime = times?.[0];
  const lastTime = times?.[times.length - 1];
  return index.mode === "numeric"
    && isFiniteNumber(firstTime)
    && isFiniteNumber(lastTime)
    && firstTime <= lastTime
    ? { firstTime, lastTime }
    : null;
}

/**
 * Associate a Lightweight Charts series with the stable display data and
 * source-domain metadata used by drawing primitives. Primitives only receive
 * the series instance from Lightweight Charts, so this registry is the bridge
 * back to the adapter-owned refs without coupling primitives to React state.
 */
export function registerDrawingSeriesContext(series: unknown, {
  seriesDataProvider = null,
  sourceTimeHorizonProvider = null,
  sourceIntervalProvider = null,
  sourceIntervalSecondsProvider = null,
  projectionConfigProvider = null,
  ordinalSeriesIndexProvider = null,
  coordinateSnapshotProvider = null,
}: DrawingSeriesProviders = {}): boolean {
  if (!isRegistryKey(series)) return false;
  drawingSeriesContextRegistry.set(series, {
    projectionConfigProvider: typeof projectionConfigProvider === "function"
      ? projectionConfigProvider
      : null,
    ordinalSeriesIndexProvider: typeof ordinalSeriesIndexProvider === "function"
      ? ordinalSeriesIndexProvider
      : null,
    coordinateSnapshotProvider: typeof coordinateSnapshotProvider === "function"
      ? coordinateSnapshotProvider
      : null,
    seriesDataProvider: typeof seriesDataProvider === "function" ? seriesDataProvider : null,
    sourceIntervalProvider: typeof sourceIntervalProvider === "function"
      ? sourceIntervalProvider
      : null,
    sourceIntervalSecondsProvider: typeof sourceIntervalSecondsProvider === "function"
      ? sourceIntervalSecondsProvider
      : null,
    sourceTimeHorizonProvider: typeof sourceTimeHorizonProvider === "function"
      ? sourceTimeHorizonProvider
      : null,
  });
  return true;
}

function hydrateCoordinateContext(
  series: unknown,
  context: DrawingCoordinateContext | null,
): DrawingSeriesRegistration | null {
  const registration = isRegistryKey(series)
    ? drawingSeriesContextRegistry.get(series) || null
    : null;
  if (!context || typeof context !== "object" || !registration) return registration;

  const owns = (field: string) => Object.prototype.hasOwnProperty.call(context, field);
  const hasOwnCoordinateSnapshot = owns("drawingFrameSnapshot")
    || owns("seriesData")
    || owns("drawingOrdinalSeriesIndex")
    || owns("drawingOrdinalSeriesIndexRevision");
  let hasCoordinateSnapshot = hasOwnCoordinateSnapshot
    || hydratedCoordinateSnapshotContexts.get(context) === true;
  if (registration.coordinateSnapshotProvider
    && !hasOwnCoordinateSnapshot
    && !hydratedCoordinateSnapshotContexts.has(context)) {
    const snapshotValue = safeProviderValue(registration.coordinateSnapshotProvider, null);
    const snapshot = snapshotValue && typeof snapshotValue === "object"
      ? snapshotValue as DrawingCoordinateSnapshot
      : null;
    if (Array.isArray(snapshot?.seriesData)) {
      hasCoordinateSnapshot = true;
      if (isDrawingFrameSnapshot(snapshotValue)) {
        context.drawingFrameSnapshot = snapshotValue;
        context.drawingCoordinateIndex = snapshotValue.coordinateIndex;
      } else if (snapshot.coordinateIndex instanceof DrawingCoordinateIndex
        && snapshot.coordinateIndex.seriesData === snapshot.seriesData) {
        context.drawingCoordinateIndex = snapshot.coordinateIndex;
      }
      context.seriesData = snapshot.seriesData;
      context.drawingOrdinalSeriesIndex = snapshot.ordinalSeriesIndex || null;
      context.drawingOrdinalSeriesIndexRevision = snapshot.lineageIndexRevision
        ?? snapshot.indexRevision
        ?? null;
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceTimeHorizon")) {
        context.sourceTimeHorizon = snapshot.sourceTimeHorizon;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceInterval")) {
        context.sourceInterval = snapshot.sourceInterval;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "sourceIntervalSeconds")) {
        context.sourceIntervalSeconds = snapshot.sourceIntervalSeconds;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "drawingProjectionConfig")) {
        context.drawingProjectionConfig = snapshot.drawingProjectionConfig;
      }
    }
    hydratedCoordinateSnapshotContexts.set(context, hasCoordinateSnapshot);
  }
  if (registration.sourceTimeHorizonProvider && !owns("sourceTimeHorizon")) {
    context.sourceTimeHorizon = safeProviderValue(
      registration.sourceTimeHorizonProvider,
      null,
    );
  }
  if (registration.sourceIntervalSecondsProvider && !owns("sourceIntervalSeconds")) {
    context.sourceIntervalSeconds = safeProviderValue(
      registration.sourceIntervalSecondsProvider,
      null,
    );
  }
  if (registration.sourceIntervalProvider && !owns("sourceInterval")) {
    context.sourceInterval = safeProviderValue(
      registration.sourceIntervalProvider,
      null,
    );
  }
  if (registration.projectionConfigProvider && !owns("drawingProjectionConfig")) {
    context.drawingProjectionConfig = safeProviderValue(
      registration.projectionConfigProvider,
      null,
    );
  }
  if (!hasCoordinateSnapshot
    && !owns("drawingOrdinalSeriesIndex")
    && registration.ordinalSeriesIndexProvider) {
    const providedIndex = safeProviderValue(
      registration.ordinalSeriesIndexProvider,
      null,
    );
    context.drawingOrdinalSeriesIndex = providedIndex instanceof DrawingLineageIndex
      ? providedIndex
      : null;
    delete context.drawingOrdinalSeriesIndexRevision;
  }
  return registration;
}

export function isOrdinalAxisTime(value: unknown): value is OrdinalAxisTime {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<OrdinalAxisTime>;
  return Number.isSafeInteger(candidate.order)
    && isFiniteNumber(candidate.sourceTime)
    && Number.isSafeInteger(candidate.sourceOrdinal)
    && Number(candidate.sourceOrdinal) >= 0;
}

function projectionMetadataFromRow(row: DisplayRow | null | undefined): Record<string, unknown> | null {
  const metadata = row?.customValues?.[PROJECTION_METADATA_KEY];
  return metadata && typeof metadata === "object" ? metadata : null;
}

function projectorIdFromRow(row: DisplayRow | null | undefined): string | null {
  const projectorId = projectionMetadataFromRow(row)?.projectorId;
  return typeof projectorId === "string" && projectorId.length > 0
    ? projectorId
    : null;
}

function sourceOrdinalFromRow(row: DisplayRow | null | undefined): number | null {
  if (isOrdinalAxisTime(row?.time)) return row.time.sourceOrdinal;
  const ordinal = projectionMetadataFromRow(row)?.sourceOrdinal;
  return isFiniteNumber(ordinal) && Number.isSafeInteger(ordinal) && ordinal >= 0
    ? ordinal
    : null;
}

function exactOrdinalRow(
  ordinalIndex: DrawingLineageIndex | null | undefined,
  anchor: unknown,
  coordinateIndex: DrawingCoordinateIndex | null = null,
): DisplayRow | null {
  if (anchor === null || typeof anchor !== "object") return null;
  const candidate = anchor as Record<string, unknown>;
  const anchorTime = candidate.time;
  const sourceOrdinal = candidate.sourceOrdinal;
  if (!isFiniteNumber(anchorTime)
    || !Number.isSafeInteger(sourceOrdinal)
    || sourceOrdinal == null
    || Number(sourceOrdinal) < 0) {
    return null;
  }
  if (coordinateIndex?.mode === "ordinal") {
    return coordinateIndex.findExactOrdinalRow(anchorTime, sourceOrdinal);
  }
  for (const row of ordinalIndex?.exactRowsBySourceTime?.get(anchorTime) || []) {
    if (sourceOrdinalFromRow(row) === sourceOrdinal) return row;
  }
  return null;
}

function compareSourceAnchors(left: SourceOrdinalAnchor, right: SourceOrdinalAnchor): number {
  if (left.time !== right.time) return left.time < right.time ? -1 : 1;
  if (left.sourceOrdinal === right.sourceOrdinal) return 0;
  return left.sourceOrdinal < right.sourceOrdinal ? -1 : 1;
}

function persistenceSafeProjectionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function persistenceSafeProjectionConfig(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function firstSeriesTime(seriesData: DisplayRow[]): DisplayRow["time"] | null {
  if (!Array.isArray(seriesData)) return null;
  for (const row of seriesData) {
    if (row?.time != null) return row.time;
  }
  return null;
}

function firstOrdinalRow(seriesData: DisplayRow[]): DisplayRow | null {
  if (!Array.isArray(seriesData)) return null;
  for (const row of seriesData) {
    if (row?.time != null) return isOrdinalAxisTime(row.time) ? row : null;
  }
  return null;
}

function usesOrdinalSeriesData(seriesData: DisplayRow[]): boolean {
  return isOrdinalAxisTime(firstSeriesTime(seriesData));
}

function firstRangeIndexWithToAtLeast(
  rowRanges: DrawingLineageIndex["rowRanges"],
  target: number,
): number {
  let lo = 0;
  let hi = rowRanges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const entry = rowRanges[mid];
    if (!entry) return rowRanges.length;
    if (entry.range.to < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstRangeIndexWithToGreaterThan(
  rowRanges: DrawingLineageIndex["rowRanges"],
  target: number,
  lo = 0,
): number {
  let left = lo;
  let right = rowRanges.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    const entry = rowRanges[mid];
    if (!entry) return rowRanges.length;
    if (entry.range.to <= target) left = mid + 1;
    else right = mid;
  }
  return left;
}

function firstRangeIndexWithFromGreaterThan(
  rowRanges: DrawingLineageIndex["rowRanges"],
  target: number,
  lo = 0,
  hi = rowRanges.length,
): number {
  let left = lo;
  let right = hi;
  while (left < right) {
    const mid = (left + right) >> 1;
    const entry = rowRanges[mid];
    if (!entry) return right;
    if (entry.range.from <= target) left = mid + 1;
    else right = mid;
  }
  return left;
}

function resolveMonotonicSourceRange(
  rowRanges: DrawingLineageIndex["rowRanges"],
  target: number,
): DisplayRow | null {
  if (rowRanges.length === 0) return null;

  const firstToAtLeastTarget = firstRangeIndexWithToAtLeast(rowRanges, target);
  const containingEntry = rowRanges[firstToAtLeastTarget];
  if (containingEntry && containingEntry.range.from <= target) {
    const containingTo = containingEntry.range.to;
    const endOfContainingTo = firstRangeIndexWithToGreaterThan(
      rowRanges,
      containingTo,
      firstToAtLeastTarget,
    );
    const firstFromAfterTarget = firstRangeIndexWithFromGreaterThan(
      rowRanges,
      target,
      firstToAtLeastTarget,
      endOfContainingTo,
    );
    // Match the legacy scan's tie-breaking: smallest containing `to`, then
    // greatest `from`, then the last row for an identical range.
    return rowRanges[firstFromAfterTarget - 1]?.row || null;
  }

  // The legacy scan prefers any predecessor over a future successor and uses
  // the last row when multiple ranges share the same predecessor `to`.
  if (firstToAtLeastTarget > 0) return rowRanges[firstToAtLeastTarget - 1]?.row ?? null;
  return null;
}

function resolveUnorderedSourceRange(
  rowRanges: DrawingLineageIndex["rowRanges"],
  target: number,
): DisplayRow | null {
  let containingRow = null;
  let containingTo = Number.POSITIVE_INFINITY;
  let containingFrom = Number.NEGATIVE_INFINITY;
  let predecessorRow = null;
  let predecessorTime = Number.NEGATIVE_INFINITY;

  for (const { row, range } of rowRanges) {
    if (range.from <= target && target <= range.to) {
      if (range.to < containingTo
        || (range.to === containingTo && range.from > containingFrom)
        || (range.to === containingTo && range.from === containingFrom)) {
        containingTo = range.to;
        containingFrom = range.from;
        containingRow = row;
      }
      continue;
    }
    if (range.to < target && range.to >= predecessorTime) {
      predecessorTime = range.to;
      predecessorRow = row;
    }
  }

  return containingRow || predecessorRow;
}

function getOrdinalSeriesIndex(
  seriesData: DisplayRow[],
  context: DrawingCoordinateContext | null = null,
): DrawingLineageIndex | null {
  if (!usesOrdinalSeriesData(seriesData)) return null;
  const frameSnapshot = context?.drawingFrameSnapshot;
  if (isDrawingFrameSnapshot(frameSnapshot)
    && frameSnapshot.seriesData === seriesData
    && isDrawingLineageIndexForSeries(frameSnapshot.ordinalSeriesIndex, seriesData)
    && frameSnapshot.lineageIndexRevision === frameSnapshot.ordinalSeriesIndex.revision) {
    if (context) {
      context.drawingOrdinalSeriesData = seriesData;
      context.drawingOrdinalSeriesIndex = frameSnapshot.ordinalSeriesIndex;
      context.drawingOrdinalSeriesIndexRevision = frameSnapshot.lineageIndexRevision;
      context.drawingCoordinateIndex = frameSnapshot.coordinateIndex;
    }
    return frameSnapshot.ordinalSeriesIndex;
  }
  const contextIndex = context?.drawingOrdinalSeriesIndex;
  const contextRevisionMatches = !Object.prototype.hasOwnProperty.call(
    context || {},
    "drawingOrdinalSeriesIndexRevision",
  ) || context?.drawingOrdinalSeriesIndexRevision === contextIndex?.revision;
  if (isDrawingLineageIndexForSeries(
    contextIndex,
    seriesData,
  ) && contextRevisionMatches) {
    if (context) context.drawingOrdinalSeriesData = seriesData;
    return contextIndex;
  }
  if (context?.drawingOrdinalSeriesData === seriesData
    && isDrawingLineageIndexForSeries(contextIndex, seriesData)
    && contextRevisionMatches) {
    return contextIndex;
  }

  const firstRow = seriesData[0] || null;
  const lastRow = seriesData[seriesData.length - 1] || null;
  const cached = ordinalSeriesIndexCache.get(seriesData);
  if (cached
    && cached.length === seriesData.length
    && cached.firstRow === firstRow
    && cached.firstTime === firstRow?.time
    && cached.lastRow === lastRow
    && cached.lastTime === lastRow?.time) {
    if (context) {
      context.drawingOrdinalSeriesData = seriesData;
      context.drawingOrdinalSeriesIndex = cached.index;
      delete context.drawingOrdinalSeriesIndexRevision;
    }
    return cached.index;
  }

  const index = createDrawingLineageIndex(seriesData);
  // ProjectionStore replaces the display array for structural and tail
  // changes; its provisional overlay also changes the array edge. Keep a
  // first/last identity guard for callers that retain the same array object.
  ordinalSeriesIndexCache.set(seriesData, {
    firstRow,
    firstTime: firstRow?.time,
    index,
    lastRow,
    lastTime: lastRow?.time,
    length: seriesData.length,
  });
  if (context) {
    context.drawingOrdinalSeriesData = seriesData;
    context.drawingOrdinalSeriesIndex = index;
    delete context.drawingOrdinalSeriesIndexRevision;
  }
  return index;
}

/**
 * Convert a chart-library axis item into a persistence-safe drawing anchor.
 * Projection-local `order` is deliberately discarded because structural
 * reprojections may assign that coordinate to different source lineage.
 */
export function drawingAnchorFromAxisTime(
  axisTime: unknown,
  seriesData: DisplayRow[] = [],
  context: DrawingCoordinateContext | null = null,
): DrawingAnchor | null {
  if (isFiniteNumber(axisTime)) return { time: axisTime };
  if (!isOrdinalAxisTime(axisTime)) return null;

  const anchor: DrawingAnchor = {
    time: axisTime.sourceTime,
    sourceOrdinal: axisTime.sourceOrdinal,
  };
  const projectorId = projectorIdFromRow(firstOrdinalRow(seriesData));
  if (projectorId) anchor.sourceProjection = projectorId;
  const projectionConfig = projectionConfigFromContext(context);
  if (projectionConfig) anchor.sourceProjectionConfig = projectionConfig;
  return anchor;
}

function isSafeTimeMagnitude(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function ordinalCellWidth(timeScale: TimeScaleBridge, tailX: number): number | null {
  let logical = null;
  try {
    logical = timeScale.coordinateToLogical?.(tailX);
  } catch {
    logical = null;
  }
  if (isFiniteNumber(logical)) {
    let center = null;
    let next = null;
    let previous = null;
    try {
      center = timeScale.logicalToCoordinate?.(logical);
      next = timeScale.logicalToCoordinate?.(logical + 1);
      previous = timeScale.logicalToCoordinate?.(logical - 1);
    } catch {
      center = null;
      next = null;
      previous = null;
    }
    const rightWidth = isFiniteNumber(center) && isFiniteNumber(next)
      ? next - center
      : null;
    if (isFiniteNumber(rightWidth) && rightWidth > 0) return rightWidth;
    const leftWidth = isFiniteNumber(center) && isFiniteNumber(previous)
      ? center - previous
      : null;
    if (isFiniteNumber(leftWidth) && leftWidth > 0) return leftWidth;
  }

  let barSpacing = null;
  try {
    barSpacing = timeScale.options?.().barSpacing;
  } catch {
    barSpacing = null;
  }
  return isFiniteNumber(barSpacing) && barSpacing > 0 ? barSpacing : null;
}

function ordinalFutureCoordinateBasis(
  timeScale: TimeScaleBridge,
  seriesData: DisplayRow[],
  context: DrawingCoordinateContext,
  ordinalIndex: DrawingLineageIndex | null = null,
): OrdinalFutureCoordinateBasis | null {
  const index = ordinalIndex || getOrdinalSeriesIndex(seriesData, context);
  if (!index) return null;
  const tailRow = index?.ordinalRows?.[index.ordinalRows.length - 1] || null;
  const intervalBasis = createFutureIntervalBasis({
    horizon: context?.sourceTimeHorizon,
    sourceInterval: context?.sourceInterval,
    sourceIntervalSeconds: context?.sourceIntervalSeconds,
  });
  if (!tailRow || !intervalBasis) return null;

  let tailX = null;
  try {
    tailX = timeScale.timeToCoordinate(tailRow.time);
  } catch {
    tailX = null;
  }
  if (!isFiniteNumber(tailX)) return null;
  const cellWidth = ordinalCellWidth(timeScale, tailX);
  return isFiniteNumber(cellWidth) && cellWidth > 0
    ? {
        ...intervalBasis,
        cellWidth,
        index,
        tailRow,
        tailX,
      }
    : null;
}

/**
 * Capture a persistence-safe drawing anchor directly from a chart coordinate.
 * Existing ordinal cells retain complete source lineage; right-side whitespace
 * becomes an absolute source time with no projection-local order/logical data.
 */
export function drawingAnchorFromCoordinate(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  x: unknown,
  context: DrawingCoordinateContext | null = null,
): DrawingAnchor | null {
  if (!chart || !series || !isFiniteNumber(x)) return null;
  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  if (!Array.isArray(seriesData) || seriesData.length === 0) return null;

  const timeScale = chart.timeScale?.();
  if (!timeScale) return null;
  const ordinalIndex = getOrdinalSeriesIndex(seriesData, coordinateContext);
  if (!ordinalIndex) {
    let axisTime = null;
    try {
      axisTime = timeScale.coordinateToTime?.(x);
    } catch {
      axisTime = null;
    }
    return isFiniteNumber(axisTime) ? { time: axisTime } : null;
  }

  const tailRow = ordinalIndex.ordinalRows[ordinalIndex.ordinalRows.length - 1] || null;
  let tailX = null;
  try {
    tailX = timeScale.timeToCoordinate(tailRow?.time);
  } catch {
    tailX = null;
  }
  if (isFiniteNumber(tailX) && x > tailX) {
    const basis = ordinalFutureCoordinateBasis(
      timeScale,
      seriesData,
      coordinateContext,
      ordinalIndex,
    );
    if (!basis) return null;
    const delta = x - basis.tailX;
    const bars = delta / basis.cellWidth;
    const time = futureTimeFromIntervalDistance(basis, bars);
    return isFiniteNumber(delta)
      && delta > 0
      && isFiniteNumber(bars)
      && bars > 0
      && time !== null
      ? { time }
      : null;
  }

  let axisTime = null;
  try {
    axisTime = timeScale.coordinateToTime?.(x);
  } catch {
    axisTime = null;
  }
  if (!isOrdinalAxisTime(axisTime)) return null;
  const exactRow = exactOrdinalRow(ordinalIndex, {
    time: axisTime.sourceTime,
    sourceOrdinal: axisTime.sourceOrdinal,
  }, coordinateIndexFor(seriesData, coordinateContext));
  if (!isOrdinalAxisTime(exactRow?.time) || exactRow.time.order !== axisTime.order) return null;
  const anchor = drawingAnchorFromAxisTime(axisTime, seriesData, coordinateContext);
  return anchor?.sourceProjection && anchor?.sourceProjectionConfig
    ? anchor
    : null;
}

function normalizeDrawingAnchor(
  anchor: unknown,
  seriesData: DisplayRow[],
  context: DrawingCoordinateContext | null,
): DrawingAnchor | null {
  if (!anchor || typeof anchor !== "object") return null;
  const candidate = anchor as Record<string, unknown>;
  if (isOrdinalAxisTime(candidate.time)) {
    return drawingAnchorFromAxisTime(candidate.time, seriesData, context);
  }
  if (!isFiniteNumber(candidate.time)) return null;
  return {
    time: candidate.time,
    ...(Number.isSafeInteger(candidate.sourceOrdinal) && Number(candidate.sourceOrdinal) >= 0
      ? { sourceOrdinal: Number(candidate.sourceOrdinal) }
      : {}),
    ...(typeof candidate.sourceProjection === "string" && candidate.sourceProjection.length > 0
      ? { sourceProjection: candidate.sourceProjection }
      : {}),
    ...(normalizeProjectionConfig(candidate.sourceProjectionConfig)
      ? { sourceProjectionConfig: String(candidate.sourceProjectionConfig) }
      : {}),
  };
}

function resolveNormalizedOrdinalAnchorToRow(
  normalized: DrawingAnchor,
  ordinalIndex: DrawingLineageIndex,
  coordinateIndex: DrawingCoordinateIndex,
  context: DrawingCoordinateContext | null,
): DisplayRow | null {
  const {
    currentProjection,
    exactRowsBySourceTime,
    latestLineage,
    rowRanges,
    rowRangesMonotonic,
  } = ordinalIndex;
  const sourceTimeHorizon = isFiniteNumber(context?.sourceTimeHorizon)
    ? context.sourceTimeHorizon
    : null;
  if (sourceTimeHorizon !== null) {
    if (normalized.time > sourceTimeHorizon) return null;
  } else if (!Number.isFinite(latestLineage) || normalized.time > latestLineage) {
    // Without a raw-source horizon, keep the conservative historical behavior:
    // display lineage is the only evidence that this source time exists.
    return null;
  }

  const canUseSourceOrdinal = Number.isSafeInteger(normalized.sourceOrdinal)
    && normalized.sourceProjection === currentProjection
    && normalizeProjectionConfig(normalized.sourceProjectionConfig) !== null
    && normalized.sourceProjectionConfig
      === projectionConfigFromContext(context);
  const targetSourceOrdinal = canUseSourceOrdinal ? normalized.sourceOrdinal : null;

  if (targetSourceOrdinal !== null) {
    const exact = coordinateIndex.findExactOrdinalRow(
      normalized.time,
      targetSourceOrdinal,
    );
    if (exact) return exact;
  }

  let lastExactSourceRow = null;
  let exactOrdinalRow = null;
  let exactOrdinalMatches = 0;
  let predecessorOrdinalRow = null;
  let predecessorOrdinal = Number.NEGATIVE_INFINITY;
  let successorOrdinalRow = null;
  let successorOrdinal = Number.POSITIVE_INFINITY;

  for (const row of exactRowsBySourceTime.get(normalized.time) || []) {
    lastExactSourceRow = row;
    if (targetSourceOrdinal == null) continue;

    const rowOrdinal = sourceOrdinalFromRow(row);
    if (rowOrdinal === null) continue;
    if (rowOrdinal === targetSourceOrdinal) {
      exactOrdinalRow = row;
      exactOrdinalMatches += 1;
    } else if (rowOrdinal < targetSourceOrdinal && rowOrdinal >= predecessorOrdinal) {
      predecessorOrdinal = rowOrdinal;
      predecessorOrdinalRow = row;
    } else if (rowOrdinal > targetSourceOrdinal && rowOrdinal < successorOrdinal) {
      successorOrdinal = rowOrdinal;
      successorOrdinalRow = row;
    }
  }

  // Duplicate canonical ordinals are corrupt lineage. The coordinate index
  // intentionally reports them as ambiguous, so do not reintroduce a
  // last-row-wins answer while applying predecessor/successor compatibility.
  if (exactOrdinalMatches > 1) return null;
  if (exactOrdinalRow) return exactOrdinalRow;
  if (predecessorOrdinalRow) return predecessorOrdinalRow;
  if (successorOrdinalRow) return successorOrdinalRow;
  if (lastExactSourceRow) return lastExactSourceRow;

  return rowRangesMonotonic
    ? resolveMonotonicSourceRange(rowRanges, normalized.time)
    : resolveUnorderedSourceRange(rowRanges, normalized.time);
}

function resolveOrdinalSourceAnchor(
  normalized: DrawingAnchor,
  ordinalIndex: DrawingLineageIndex,
  coordinateIndex: DrawingCoordinateIndex,
  context: DrawingCoordinateContext | null,
): DrawingSourceAnchorResolution | null {
  const sourceTimeHorizon = isSafeTimeMagnitude(context?.sourceTimeHorizon)
    ? context.sourceTimeHorizon
    : null;
  if (sourceTimeHorizon !== null && normalized.time > sourceTimeHorizon) {
    if (!isSafeTimeMagnitude(normalized.time)) return null;
    const intervalBasis = createFutureIntervalBasis({
      horizon: sourceTimeHorizon,
      sourceInterval: context?.sourceInterval,
      sourceIntervalSeconds: context?.sourceIntervalSeconds,
    });
    const tailRow = ordinalIndex.ordinalRows[ordinalIndex.ordinalRows.length - 1] || null;
    if (!intervalBasis || !tailRow) return null;
    const intervalDistance = futureIntervalDistanceFromTime(intervalBasis, normalized.time);
    return isFiniteNumber(intervalDistance) && intervalDistance > 0
      ? { intervalDistance, kind: "ordinal-future", tailRow }
      : null;
  }

  const row = resolveNormalizedOrdinalAnchorToRow(
    normalized,
    ordinalIndex,
    coordinateIndex,
    context,
  );
  return row ? { kind: "ordinal-row", row } : null;
}

function resolveDrawingSourceAnchorsWithStrategy(
  seriesData: DisplayRow[],
  anchors: readonly unknown[],
  context: DrawingCoordinateContext | null,
  strategy: "batch" | "scalar",
): Array<DrawingSourceAnchorResolution | null> {
  const unresolved = () => anchors.map(() => null);
  if (!Array.isArray(seriesData) || seriesData.length === 0) return unresolved();
  const coordinateIndex = coordinateIndexFor(seriesData, context);
  if (!coordinateIndex.valid || coordinateIndex.mode === "empty") return unresolved();
  const normalized = anchors.map((anchor) => normalizeDrawingAnchor(anchor, seriesData, context));

  if (coordinateIndex.mode === "numeric") {
    const searches = strategy === "batch"
      ? coordinateIndex.resolveNumericBatch(normalized.map((anchor) => anchor?.time))
      : normalized.map((anchor) => coordinateIndex.searchNumericTime(anchor?.time));
    return searches.map((search, index) => normalized[index] && search
      ? { kind: "numeric-time", search }
      : null);
  }

  const ordinalIndex = lineageIndexForCoordinateIndex(
    seriesData,
    coordinateIndex,
    context,
  );
  if (!ordinalIndex
    || coordinateIndex.mode !== "ordinal"
    || coordinateIndex.lineageRevision !== ordinalIndex.revision) {
    return unresolved();
  }
  return normalized.map((anchor) => anchor
      ? resolveOrdinalSourceAnchor(
        anchor,
        ordinalIndex,
        coordinateIndex,
        context,
      )
    : null);
}

function sameSourceResolution(
  left: DrawingSourceAnchorResolution | null,
  right: DrawingSourceAnchorResolution | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "ordinal-row" && right.kind === "ordinal-row") {
    return left.row === right.row;
  }
  if (left.kind === "ordinal-future" && right.kind === "ordinal-future") {
    return left.tailRow === right.tailRow
      && left.intervalDistance === right.intervalDistance;
  }
  if (left.kind === "numeric-time" && right.kind === "numeric-time") {
    const a = left.search;
    const b = right.search;
    return a.exactIndex === b.exactIndex
      && a.leftIndex === b.leftIndex
      && a.leftTime === b.leftTime
      && a.position === b.position
      && a.ratio === b.ratio
      && a.rightIndex === b.rightIndex
      && a.rightTime === b.rightTime
      && a.targetTime === b.targetTime;
  }
  return false;
}

/**
 * Resolve source anchors without reading any viewport or Lightweight Charts
 * coordinate. Numeric ordered batches use the coordinate index merge-walk;
 * parity mode fails closed on a canonical mismatch and never hides it by
 * falling back to either implementation.
 */
export function resolveDrawingSourceAnchors(
  seriesData: DisplayRow[],
  anchors: readonly unknown[],
  context: DrawingCoordinateContext | null = null,
): Array<DrawingSourceAnchorResolution | null> {
  if (!Array.isArray(anchors)) return [];
  const mode = getDrawingCoordinateProjectorMode(context);
  if (mode !== "parity") {
    return resolveDrawingSourceAnchorsWithStrategy(seriesData, anchors, context, mode);
  }
  const batch = resolveDrawingSourceAnchorsWithStrategy(seriesData, anchors, context, "batch");
  const scalar = resolveDrawingSourceAnchorsWithStrategy(seriesData, anchors, context, "scalar");
  return batch.map((resolution, index) => (
    sameSourceResolution(resolution, scalar[index] ?? null) ? resolution : null
  ));
}

function safeTimeToCoordinate(
  timeScale: TimeScaleBridge,
  time: unknown,
): number | null {
  try {
    const coordinate = timeScale.timeToCoordinate(time);
    return isFiniteNumber(coordinate) ? coordinate : null;
  } catch {
    return null;
  }
}

function ordinalFutureProjectionBasis(
  timeScale: TimeScaleBridge,
  tailRow: DisplayRow,
  context: DrawingCoordinateContext | null,
): Readonly<{ cellWidth: number | null; tailX: number | null }> {
  const cacheable = context !== null
    && typeof context === "object"
    && ordinalFutureProjectionTransactions.has(context);
  const cached = cacheable ? ordinalFutureProjectionContexts.get(context) : null;
  if (cached?.timeScale === timeScale && cached.tailRow === tailRow) {
    return cached;
  }
  const tailX = safeTimeToCoordinate(timeScale, tailRow.time);
  const cellWidth = tailX === null ? null : ordinalCellWidth(timeScale, tailX);
  const basis = { cellWidth, tailRow, tailX, timeScale };
  if (cacheable) ordinalFutureProjectionContexts.set(context, basis);
  return basis;
}

/** Final viewport projection for one already-resolved source anchor/logical. */
export function projectDrawingCoordinateResolution(
  timeScale: TimeScaleBridge | null | undefined,
  resolution: DrawingCoordinateResolution | null | undefined,
  context: DrawingCoordinateContext | null = null,
): number | null {
  if (!timeScale || !resolution) return null;
  if (resolution.kind === "logical") {
    return logicalToCoordinateInterpolated(timeScale, resolution.logical);
  }
  if (resolution.kind === "ordinal-row") {
    return safeTimeToCoordinate(timeScale, resolution.row.time);
  }
  if (resolution.kind === "ordinal-future") {
    const { cellWidth, tailX } = ordinalFutureProjectionBasis(
      timeScale,
      resolution.tailRow,
      context,
    );
    if (tailX === null) return null;
    const x = cellWidth === null
      ? null
      : tailX + resolution.intervalDistance * cellWidth;
    return isFiniteNumber(x) ? x : null;
  }

  const { leftTime, rightTime, ratio, targetTime } = resolution.search;
  const exactTargetX = safeTimeToCoordinate(timeScale, targetTime);
  if (exactTargetX !== null) return exactTargetX;
  const leftX = safeTimeToCoordinate(timeScale, leftTime);
  if (leftX === null) return null;
  if (leftTime === rightTime || ratio === 0) return leftX;
  const rightX = safeTimeToCoordinate(timeScale, rightTime);
  if (rightX === null) return null;
  const x = leftX + ratio * (rightX - leftX);
  return isFiniteNumber(x) ? x : null;
}

/** Final viewport projection for a positional source-resolution batch. */
export function projectDrawingCoordinateResolutions(
  timeScale: TimeScaleBridge | null | undefined,
  resolutions: readonly (DrawingCoordinateResolution | null)[],
  context: DrawingCoordinateContext | null = null,
): Array<number | null> {
  if (!Array.isArray(resolutions)) return [];
  const resolutionBatch = resolutions as readonly (DrawingCoordinateResolution | null)[];
  return resolutionBatch.map((resolution) => (
    projectDrawingCoordinateResolution(timeScale, resolution, context)
  ));
}

/**
 * Resolve and project a positional drawing-point batch. A present `time` is
 * authoritative over legacy `logical`; unresolved time never falls through to
 * a stale logical coordinate.
 */
export function resolveDrawingDataPointsToCoordinates(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  dataPoints: readonly (CoordinateDataPoint | null | undefined)[],
  context: DrawingCoordinateContext | null = null,
): Array<number | null> {
  if (!Array.isArray(dataPoints)) return [];
  const points = dataPoints as readonly (CoordinateDataPoint | null | undefined)[];
  if (!chart || !series) return points.map(() => null);
  const prepared = prepareDrawingCoordinateContext(series, context);
  const seriesData = prepared.seriesData || [];
  const sourceResolutions = resolveDrawingSourceAnchors(seriesData, points, prepared);
  const resolutions: Array<DrawingCoordinateResolution | null> = points.map((point, index) => {
    if (!point) return null;
    if (point.time !== null && point.time !== undefined) {
      return sourceResolutions[index] ?? null;
    }
    return isFiniteNumber(point.logical)
      ? { kind: "logical", logical: point.logical }
      : null;
  });
  let timeScale = null;
  try {
    timeScale = chart.timeScale();
  } catch {
    timeScale = null;
  }
  return projectDrawingCoordinateResolutions(timeScale, resolutions, prepared);
}

/**
 * Resolve a stable source drawing anchor against the current derived display.
 * This compatibility API returns rows only for materialized exact/derived
 * anchors; fractional numeric and absolute-future resolutions have no row.
 */
export function resolveDrawingAnchorToDisplayRow(
  seriesData: DisplayRow[],
  anchor: unknown,
  context: DrawingCoordinateContext | null = null,
): DisplayRow | null {
  const resolution = resolveDrawingSourceAnchors(seriesData, [anchor], context)[0] ?? null;
  if (resolution?.kind === "ordinal-row") return resolution.row;
  if (resolution?.kind !== "numeric-time") return null;
  const exactIndex = resolution.search.exactIndex;
  return exactIndex === null ? null : seriesData[exactIndex] ?? null;
}

/**
 * Atomically convert one coalesced pointer batch into portable synthetic-chart
 * freehand captures. Materialized cells retain source-lineage spans while
 * right-side whitespace becomes an absolute source-time point. Axis-local
 * order is used only for chart lookup and is never persisted.
 */
export function captureSourceLineageFreehandStrokeBatch(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  screenPoints: ScreenPoint[],
  context: DrawingCoordinateContext | null = null,
): Readonly<{
  sourceProjection: string;
  sourceProjectionConfig: string;
  captures: readonly Readonly<SourceLineageFreehandCapture>[];
}> | null {
  if (!chart
    || !series
    || !Array.isArray(screenPoints)
    || screenPoints.length === 0
    || screenPoints.length > MAX_FREEHAND_CAPTURE_BATCH_POINTS) {
    return null;
  }

  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  const suppliedIndex = coordinateContext.drawingOrdinalSeriesIndex;
  const hasSuppliedIndex = Object.prototype.hasOwnProperty.call(
    coordinateContext,
    "drawingOrdinalSeriesIndex",
  );
  if (hasSuppliedIndex && !isDrawingLineageIndexForSeries(suppliedIndex, seriesData)) {
    return null;
  }
  const ordinalIndex = hasSuppliedIndex
    ? suppliedIndex
    : getOrdinalSeriesIndex(seriesData, coordinateContext);
  if (!ordinalIndex
    || !ordinalIndex.rowRangesMonotonic
    || ordinalIndex.ordinalRows.length < 1
    || ordinalIndex.rowRanges.length !== ordinalIndex.ordinalRows.length) {
    return null;
  }

  const expectedRevision = ordinalIndex.revision;
  if (Object.prototype.hasOwnProperty.call(
    coordinateContext,
    "drawingOrdinalSeriesIndexRevision",
  ) && coordinateContext.drawingOrdinalSeriesIndexRevision !== expectedRevision) {
    return null;
  }
  const sourceProjection = ordinalIndex.currentProjection;
  const sourceProjectionConfig = projectionConfigFromContext(coordinateContext);
  const sourceTimeHorizon = coordinateContext.sourceTimeHorizon;
  if (!persistenceSafeProjectionId(sourceProjection)
    || !persistenceSafeProjectionConfig(sourceProjectionConfig)
    || !isFiniteNumber(sourceTimeHorizon)
    || ordinalIndex.latestLineage > sourceTimeHorizon) {
    return null;
  }

  const timeScale = chart.timeScale?.();
  if (!timeScale) return null;

  const rows = ordinalIndex.ordinalRows;
  const ranges = ordinalIndex.rowRanges;
  const originalLength = seriesData.length;
  const originalFirst = seriesData[0];
  const originalLast = seriesData[originalLength - 1];
  const coordinateCache = new Map<number, number | null>();
  const coordinateAt = (index: number): number | null => {
    if (coordinateCache.has(index)) return coordinateCache.get(index) ?? null;
    let coordinate = null;
    try {
      coordinate = timeScale.timeToCoordinate(rows[index]?.time);
    } catch {
      coordinate = null;
    }
    const normalized = isFiniteNumber(coordinate) ? coordinate : null;
    coordinateCache.set(index, normalized);
    return normalized;
  };
  const tailX = coordinateAt(rows.length - 1);
  let drawableWidth = null;
  try {
    drawableWidth = timeScale.width?.();
  } catch {
    drawableWidth = null;
  }
  if (!isFiniteNumber(drawableWidth) || drawableWidth <= 0) drawableWidth = null;
  let futureBasis: OrdinalFutureCoordinateBasis | null = null;
  let futureBasisResolved = false;
  const getFutureBasis = () => {
    if (!futureBasisResolved) {
      futureBasis = ordinalFutureCoordinateBasis(
        timeScale,
        seriesData,
        coordinateContext,
        ordinalIndex,
      );
      futureBasisResolved = true;
    }
    return futureBasis;
  };

  const pairForCoordinate = (x: number): number | null => {
    let snappedTime = null;
    try {
      snappedTime = timeScale.coordinateToTime?.(x);
    } catch {
      snappedTime = null;
    }
    if (!isOrdinalAxisTime(snappedTime)) return null;

    let left = 0;
    let right = rows.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      const rowTime = rows[middle]?.time;
      const order = isOrdinalAxisTime(rowTime) ? rowTime.order : null;
      if (order === null || !Number.isSafeInteger(order)) return null;
      if (order < snappedTime.order) left = middle + 1;
      else right = middle;
    }
    const snappedRow = rows[left];
    if (!isOrdinalAxisTime(snappedRow?.time)
      || snappedRow.time.order !== snappedTime.order
      || snappedRow.time.sourceTime !== snappedTime.sourceTime
      || snappedRow.time.sourceOrdinal !== snappedTime.sourceOrdinal) {
      return null;
    }
    const center = coordinateAt(left);
    if (center === null) return null;
    if (x < center) return left > 0 ? left - 1 : null;
    if (x > center) return left < rows.length - 1 ? left : null;
    return left < rows.length - 1 ? left : (left > 0 ? left - 1 : null);
  };

  const spanCache = new Map<number, SourceLineageSpan | null>();
  const spanForPair = (pairIndex: number): SourceLineageSpan | null => {
    if (spanCache.has(pairIndex)) return spanCache.get(pairIndex) ?? null;
    const leftRow = rows[pairIndex];
    const rightRow = rows[pairIndex + 1];
    const leftEntry = ranges[pairIndex];
    const rightEntry = ranges[pairIndex + 1];
    if (!leftRow
      || !rightRow
      || !leftEntry
      || !rightEntry
      || leftEntry.row !== leftRow
      || rightEntry.row !== rightRow
      || leftEntry.coverageGroup !== rightEntry.coverageGroup
      || projectorIdFromRow(leftRow) !== sourceProjection
      || projectorIdFromRow(rightRow) !== sourceProjection) {
      return null;
    }
    if (!isOrdinalAxisTime(leftRow.time) || !isOrdinalAxisTime(rightRow.time)) return null;
    const exact = {
      left: {
        time: leftRow.time.sourceTime,
        sourceOrdinal: leftRow.time.sourceOrdinal,
      },
      right: {
        time: rightRow.time.sourceTime,
        sourceOrdinal: rightRow.time.sourceOrdinal,
      },
    };
    const fromTime = leftEntry.range?.from;
    const toTime = rightEntry.range?.to;
    if (compareSourceAnchors(exact.left, exact.right) >= 0
      || !isFiniteNumber(fromTime)
      || !isFiniteNumber(toTime)
      || fromTime > toTime
      || exact.left.time < fromTime
      || exact.left.time > toTime
      || exact.right.time < fromTime
      || exact.right.time > toTime
      || toTime > sourceTimeHorizon) {
      return null;
    }

    const overlapFirst = firstRangeIndexWithToAtLeast(ranges, fromTime);
    const overlapEnd = firstRangeIndexWithFromGreaterThan(ranges, toTime, overlapFirst);
    const firstOverlap = ranges[overlapFirst];
    const lastOverlap = ranges[overlapEnd - 1];
    if (overlapFirst > pairIndex
      || overlapEnd <= pairIndex + 1
      || overlapFirst >= overlapEnd
      || !firstOverlap
      || !lastOverlap
      || firstOverlap.coverageGroup !== lastOverlap.coverageGroup) {
      return null;
    }
    const leftCenter = coordinateAt(pairIndex);
    const rightCenter = coordinateAt(pairIndex + 1);
    if (leftCenter === null
      || rightCenter === null
      || leftCenter >= rightCenter) {
      return null;
    }
    const cellCount = overlapEnd - overlapFirst;
    const leftRatio = (pairIndex - overlapFirst + 0.5) / cellCount;
    const rightRatio = (pairIndex - overlapFirst + 1.5) / cellCount;
    if (!Number.isSafeInteger(cellCount)
      || cellCount <= 0
      || !isFiniteNumber(leftRatio)
      || !isFiniteNumber(rightRatio)
      || leftRatio < 0
      || rightRatio > 1
      || leftRatio >= rightRatio) {
      return null;
    }
    const span: SourceLineageSpan = Object.freeze({
      exact: Object.freeze({
        left: Object.freeze(exact.left),
        right: Object.freeze(exact.right),
      }),
      fallback: Object.freeze({ fromTime, toTime, leftRatio, rightRatio }),
    });
    spanCache.set(pairIndex, span);
    return span;
  };

  const captures: Readonly<SourceLineageFreehandCapture>[] = [];
  for (const point of screenPoints) {
    const x = point?.x;
    const y = point?.y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (drawableWidth !== null && (x < 0 || x >= drawableWidth)) return null;
    let price = null;
    try {
      price = series.coordinateToPrice?.(y);
    } catch {
      price = null;
    }
    if (!isFiniteNumber(price)) return null;

    if (tailX !== null && x > tailX) {
      const basis = getFutureBasis();
      if (!basis) return null;
      const cellDistance = (x - basis.tailX) / basis.cellWidth;
      const time = futureTimeFromIntervalDistance(basis, cellDistance);
      if (!isFiniteNumber(cellDistance)
        || cellDistance <= 0
        || time === null
        || time <= sourceTimeHorizon) {
        return null;
      }
      captures.push(Object.freeze({
        time,
        price,
        screen: Object.freeze({ x, y }),
      }));
      continue;
    }

    if (rows.length === 1 && tailX !== null) {
      const cellWidth = getFutureBasis()?.cellWidth ?? ordinalCellWidth(timeScale, tailX);
      const tailAxisTime = rows[0]?.time;
      const tailTime = isOrdinalAxisTime(tailAxisTime) ? tailAxisTime.sourceTime : null;
      if (!isOrdinalAxisTime(tailAxisTime)
        || !isFiniteNumber(cellWidth)
        || cellWidth <= 0
        || x < tailX - cellWidth / 2
        || x > tailX
        || !isSafeTimeMagnitude(tailTime)) {
        return null;
      }
      captures.push(Object.freeze({
        anchor: Object.freeze({
          time: tailTime,
          sourceOrdinal: tailAxisTime.sourceOrdinal,
        }),
        price,
        screen: Object.freeze({ x, y }),
      }));
      continue;
    }

    const pairIndex = pairForCoordinate(x);
    if (pairIndex === null) return null;
    const left = coordinateAt(pairIndex);
    const right = coordinateAt(pairIndex + 1);
    const span = spanForPair(pairIndex);
    if (!span || left === null || right === null || left >= right) {
      return null;
    }
    const ratio = (x - left) / (right - left);
    if (!isFiniteNumber(ratio) || ratio < 0 || ratio > 1) return null;
    captures.push(Object.freeze({
      span,
      ratio,
      price,
      screen: Object.freeze({ x, y }),
    }));
  }

  if (ordinalIndex.revision !== expectedRevision
    || ordinalIndex.seriesData !== seriesData
    || seriesData.length !== originalLength
    || seriesData[0] !== originalFirst
    || seriesData[originalLength - 1] !== originalLast) {
    return null;
  }
  return Object.freeze({
    sourceProjection,
    sourceProjectionConfig,
    captures: Object.freeze(captures),
  });
}

/** Resolve the viewport-independent rows/times for one lineage span. */
export function resolveSourceLineageSpan(
  series: CoordinateSeriesBridge | null | undefined,
  {
    sourceProjection,
    sourceProjectionConfig,
    exact,
    fallback,
  }: SourceLineageSpanInput = {},
  context: DrawingCoordinateContext | null = null,
): DrawingSourceLineageSpanResolution | null {
  if (!series) return null;
  const coordinateContext = context || {};
  const seriesData = getCachedSeriesData(series, coordinateContext);
  const fromTime = isFiniteNumber(fallback?.fromTime) ? fallback.fromTime : null;
  const toTime = isFiniteNumber(fallback?.toTime) ? fallback.toTime : null;
  const leftRatio = isFiniteNumber(fallback?.leftRatio) ? fallback.leftRatio : null;
  const rightRatio = isFiniteNumber(fallback?.rightRatio) ? fallback.rightRatio : null;
  if (fromTime === null
    || toTime === null
    || fromTime > toTime
    || leftRatio === null
    || rightRatio === null
    || leftRatio < 0
    || rightRatio > 1
    || leftRatio >= rightRatio) {
    return null;
  }

  const coordinateIndex = coordinateIndexFor(seriesData, coordinateContext);
  const ordinalIndex = getOrdinalSeriesIndex(seriesData, coordinateContext);
  const exactContextMatches = ordinalIndex
    && sourceProjection === ordinalIndex.currentProjection
    && normalizeProjectionConfig(sourceProjectionConfig) !== null
    && sourceProjectionConfig === projectionConfigFromContext(coordinateContext);
  let exactResolution: DrawingSourceLineageSpanResolution["exact"] = null;
  if (exactContextMatches) {
    const left = exactOrdinalRow(ordinalIndex, exact?.left, coordinateIndex);
    const right = exactOrdinalRow(ordinalIndex, exact?.right, coordinateIndex);
    if (left && right) {
      exactResolution = {
        left: { kind: "ordinal-row", row: left },
        right: { kind: "ordinal-row", row: right },
      };
    }
  }

  let envelopeResolution: DrawingSourceLineageSpanResolution["envelope"] = null;
  if (!ordinalIndex) {
    const bounds = numericSeriesBounds(seriesData, coordinateContext);
    if (bounds && fromTime >= bounds.firstTime && toTime <= bounds.lastTime) {
      const left = coordinateIndex.searchNumericTime(fromTime);
      const right = coordinateIndex.searchNumericTime(toTime);
      if (left && right) {
        envelopeResolution = {
          left: { kind: "numeric-time", search: left },
          leftRatio,
          right: { kind: "numeric-time", search: right },
          rightRatio,
        };
      }
    }
    return exactResolution || envelopeResolution
      ? { envelope: envelopeResolution, exact: exactResolution }
      : null;
  }

  const sourceTimeHorizon = isFiniteNumber(coordinateContext.sourceTimeHorizon)
    ? coordinateContext.sourceTimeHorizon
    : null;
  if (!((sourceTimeHorizon !== null && toTime > sourceTimeHorizon)
    || (sourceTimeHorizon === null
      && (!Number.isFinite(ordinalIndex.latestLineage)
        || toTime > ordinalIndex.latestLineage)))) {
    const overlap = ordinalIndex.rowsOverlappingSourceEnvelope({ fromTime, toTime });
    if (overlap) {
      envelopeResolution = {
        left: { kind: "ordinal-row", row: overlap.first },
        leftRatio,
        right: { kind: "ordinal-row", row: overlap.last },
        rightRatio,
      };
    }
  }
  return exactResolution || envelopeResolution
    ? { envelope: envelopeResolution, exact: exactResolution }
    : null;
}

/** Final viewport projection for one already-resolved lineage span. */
export function projectSourceLineageSpan(
  timeScale: TimeScaleBridge | null | undefined,
  resolution: DrawingSourceLineageSpanResolution | null | undefined,
  context: DrawingCoordinateContext | null = null,
): { left: number; right: number } | null {
  if (!timeScale || !resolution) return null;
  const exactLeft = projectDrawingCoordinateResolution(timeScale, resolution.exact?.left, context);
  const exactRight = projectDrawingCoordinateResolution(timeScale, resolution.exact?.right, context);
  if (exactLeft !== null && exactRight !== null && exactLeft < exactRight) {
    return { left: exactLeft, right: exactRight };
  }

  const envelope = resolution.envelope;
  if (!envelope) return null;
  let barSpacing = null;
  try {
    barSpacing = timeScale.options?.().barSpacing;
  } catch {
    barSpacing = null;
  }
  if (!isFiniteNumber(barSpacing) || barSpacing <= 0) return null;
  const firstCenter = projectDrawingCoordinateResolution(timeScale, envelope.left, context);
  const lastCenter = projectDrawingCoordinateResolution(timeScale, envelope.right, context);
  if (firstCenter === null || lastCenter === null || firstCenter > lastCenter) return null;

  const envelopeLeft = firstCenter - barSpacing / 2;
  const envelopeRight = lastCenter + barSpacing / 2;
  return {
    left: envelopeLeft + (envelopeRight - envelopeLeft) * envelope.leftRatio,
    right: envelopeLeft + (envelopeRight - envelopeLeft) * envelope.rightRatio,
  };
}

/**
 * Resolve one freehand lineage span to CSS-pixel x coordinates. Exact ordinal
 * row centers win for an unchanged projector; otherwise the source envelope
 * maps to the target cell envelope.
 */
export function resolveSourceLineageSpanToCoordinates(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  span: SourceLineageSpanInput = {},
  context: DrawingCoordinateContext | null = null,
): { left: number; right: number } | null {
  if (!chart || !series) return null;
  let timeScale = null;
  try {
    timeScale = chart.timeScale();
  } catch {
    timeScale = null;
  }
  return projectSourceLineageSpan(
    timeScale,
    resolveSourceLineageSpan(series, span, context),
    context,
  );
}

function getCachedSeriesData(
  series: CoordinateSeriesBridge,
  context: DrawingCoordinateContext,
): DisplayRow[] {
  const registration = hydrateCoordinateContext(series, context);
  if (context && Object.prototype.hasOwnProperty.call(context, "seriesData")) {
    return Array.isArray(context.seriesData) ? context.seriesData : [];
  }

  let data: unknown = safeProviderValue(registration?.seriesDataProvider, null);
  if (!Array.isArray(data)) {
    try {
      data = series.data?.() || [];
    } catch {
      data = [];
    }
  }

  const rows = Array.isArray(data) ? data as DisplayRow[] : [];
  context.seriesData = rows;

  return rows;
}

/**
 * Hydrate the public drawing context from the adapter registry exactly once.
 * Batch callers use this before caching pure source resolutions so they never
 * need access to the private series-provider registry.
 */
export function prepareDrawingCoordinateContext(
  series: CoordinateSeriesBridge | null | undefined,
  context: DrawingCoordinateContext | null = null,
): DrawingCoordinateContext {
  const prepared = context || {};
  if (!series) {
    prepared.seriesData = [];
    prepared.drawingCoordinateIndex = coordinateIndexFor([], prepared);
    return prepared;
  }
  const seriesData = getCachedSeriesData(series, prepared);
  coordinateIndexFor(seriesData, prepared);
  return prepared;
}

export function timeToCoordinateInterpolated(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  timestamp: unknown,
  context: DrawingCoordinateContext | null = null,
): number | null {
  if (timestamp == null) return null;
  return resolveDrawingDataPointsToCoordinates(
    chart,
    series,
    [{ time: timestamp }],
    context,
  )[0] ?? null;
}

export function dataPointToCoordinate(
  chart: CoordinateChartBridge | null | undefined,
  series: CoordinateSeriesBridge | null | undefined,
  dataPoint: CoordinateDataPoint | null | undefined,
  context: DrawingCoordinateContext | null = null,
): number | null {
  if (!dataPoint) return null;
  return resolveDrawingDataPointsToCoordinates(
    chart,
    series,
    [dataPoint],
    context,
  )[0] ?? null;
}

export function coordinateToFractionalLogical(
  adapter: InterpolatedCoordinateAdapter | null | undefined,
  x: number,
): number | null {
  if (!adapter?.isReady?.()) return null;

  const intLogical = adapter.coordinateToLogical?.(x);
  if (intLogical == null || !isFinite(intLogical)) return null;

  let fracLogical = intLogical;
  const x0 = adapter.logicalToCoordinate?.(intLogical);
  if (x0 != null && isFinite(x0)) {
    const xRight = adapter.logicalToCoordinate?.(intLogical + 1);
    if (xRight != null && isFinite(xRight) && xRight !== x0) {
      fracLogical = intLogical + (x - x0) / (xRight - x0);
    }
  }

  return fracLogical;
}

/**
 * Resolve a screen coordinate to continuous source time on an ordinary time
 * axis. Lightweight Charts can return a bar-snapped timestamp in right-side
 * whitespace, so prefer logical-axis extrapolation whenever that timestamp
 * cannot be interpolated against a real series row.
 */
export function coordinateToInterpolatedSeriesTime(
  adapter: InterpolatedCoordinateAdapter | null | undefined,
  x: number,
  logicalIndex: number | null = coordinateToFractionalLogical(adapter, x),
): number | null {
  if (!adapter?.isReady?.()
    || !isFiniteNumber(x)
    || !isFiniteNumber(logicalIndex)) {
    return null;
  }

  let snappedTime: number | null = null;
  try {
    const candidate = adapter.coordinateToTime?.(x);
    snappedTime = isFiniteNumber(candidate) ? candidate : null;
  } catch {
    snappedTime = null;
  }

  if (snappedTime !== null) {
    let snappedIndex = -1;
    let snappedX: number | null = null;
    try {
      const candidateIndex = adapter.getSeriesIndexByTime?.(snappedTime);
      snappedIndex = typeof candidateIndex === "number" ? candidateIndex : -1;
      const candidateX = adapter.timeToCoordinate?.(snappedTime);
      snappedX = isFiniteNumber(candidateX) ? candidateX : null;
    } catch {
      snappedIndex = -1;
      snappedX = null;
    }

    if (snappedIndex >= 0 && snappedX !== null) {
      const seriesData = adapter.getSeriesData?.() || [];
      const neighborIndex = x >= snappedX ? snappedIndex + 1 : snappedIndex - 1;
      const neighborTime = seriesData[neighborIndex]?.time;
      let neighborX: number | null = null;
      if (isFiniteNumber(neighborTime)) {
        try {
          const candidateX = adapter.timeToCoordinate?.(neighborTime);
          neighborX = isFiniteNumber(candidateX) ? candidateX : null;
        } catch {
          neighborX = null;
        }
      }
      if (isFiniteNumber(neighborTime)
        && neighborX !== null
        && neighborX !== snappedX) {
        const ratio = (x - snappedX) / (neighborX - snappedX);
        const time = snappedTime + ratio * (neighborTime - snappedTime);
        if (isFiniteNumber(time)) return time;
      }
    }
  }

  const logicalTime = logicalToInterpolatedSeriesTime(adapter, logicalIndex);
  return isFiniteNumber(logicalTime) ? logicalTime : snappedTime;
}

export function logicalToInterpolatedSeriesTime(
  adapter: InterpolatedCoordinateAdapter | null | undefined,
  logicalIndex: number | null | undefined,
): number | null {
  if (!adapter?.isReady?.() || logicalIndex == null || !isFinite(logicalIndex)) return null;

  const seriesData = adapter.getSeriesData?.();
  if (!seriesData || seriesData.length === 0) return null;
  if (usesOrdinalSeriesData(seriesData)) return null;
  const coordinateIndex = coordinateIndexFor(seriesData, null);
  const numericTimes = coordinateIndex.numericTimes;
  if (coordinateIndex.mode !== "numeric" || !numericTimes || numericTimes.length === 0) {
    return null;
  }
  const firstTime = numericTimes[0];
  const lastTime = numericTimes[numericTimes.length - 1];
  if (!isFiniteNumber(firstTime) || !isFiniteNumber(lastTime)) return null;

  let dataIndex = logicalIndex;
  const firstCoord = adapter.timeToCoordinate?.(firstTime);
  const firstLogical = firstCoord == null || !isFinite(firstCoord)
    ? null
    : adapter.coordinateToLogical?.(firstCoord);
  if (firstLogical != null && isFinite(firstLogical)) {
    dataIndex = logicalIndex - firstLogical;
  }

  const floorIdx = Math.floor(dataIndex);
  const frac = dataIndex - floorIdx;

  if (floorIdx < 0) {
    if (numericTimes.length >= 2) {
      const secondTime = numericTimes[1];
      if (!isFiniteNumber(secondTime)) return null;
      const dt = secondTime - firstTime;
      return firstTime + dataIndex * dt;
    }
    return firstTime;
  }

  if (floorIdx >= numericTimes.length - 1) {
    if (numericTimes.length >= 2) {
      const previousTime = numericTimes[numericTimes.length - 2];
      if (!isFiniteNumber(previousTime)) return null;
      const dt = lastTime - previousTime;
      return lastTime
        + (dataIndex - (numericTimes.length - 1)) * dt;
    }
    return lastTime;
  }

  const tA = numericTimes[floorIdx];
  const tB = numericTimes[floorIdx + 1];
  if (!isFiniteNumber(tA) || !isFiniteNumber(tB)) return null;
  return tA + frac * (tB - tA);
}

export function logicalToCoordinateInterpolated(
  timeScale: Pick<TimeScaleBridge, "logicalToCoordinate"> | null | undefined,
  logical: number | null | undefined,
): number | null {
  if (!timeScale || logical == null || !isFinite(logical)) return null;
  if (!timeScale.logicalToCoordinate) return null;

  const leftLogical = Math.floor(logical);
  const fraction = logical - leftLogical;

  const xLeft = timeScale.logicalToCoordinate(leftLogical);
  if (xLeft == null || !isFinite(xLeft)) return null;
  if (fraction === 0) return xLeft;

  const xRight = timeScale.logicalToCoordinate(leftLogical + 1);
  if (xRight == null || !isFinite(xRight)) return null;

  return xLeft + fraction * (xRight - xLeft);
}
