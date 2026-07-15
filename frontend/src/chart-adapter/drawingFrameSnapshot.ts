import {
  createDrawingCoordinateIndex,
  DrawingCoordinateIndex,
} from "./drawingCoordinateIndex.js";
import type { DrawingLineageIndex } from "../features/chart-representation/drawingLineageIndex.js";
import type { DisplayRow } from "../features/chart-representation/chartRepresentationTypes.js";

export type DrawingAxisKind = "derived-ordinal" | "time";

export interface DrawingFrameViewport {
  readonly horizontalDomain: "logical" | "time";
  readonly minHorizontal: number;
  readonly maxHorizontal: number;
  readonly minPrice: number;
  readonly maxPrice: number;
}

/**
 * One immutable, adapter-owned view of every input needed by drawing
 * coordinate work for a frame. The data/index references are main-thread only;
 * worker messages must copy the serializable revision fields instead.
 */
export interface DrawingFrameSnapshot {
  readonly axisKind: DrawingAxisKind;
  readonly barSpacing: number;
  readonly coordinateIndex: DrawingCoordinateIndex;
  readonly coordinateKey: string;
  readonly dataRevision: number;
  readonly dpr: number;
  readonly drawingProjectionConfig: unknown;
  /** Atomic data-space viewport used only for fail-open scene culling. */
  readonly drawingViewport: DrawingFrameViewport | null;
  readonly heightCssPx: number;
  readonly lineageIndexRevision: number;
  readonly ordinalSeriesIndex: DrawingLineageIndex | null;
  readonly projectionRevision: number;
  readonly seriesData: DisplayRow[];
  readonly sourceInterval: unknown;
  readonly sourceIntervalSeconds: unknown;
  readonly sourceTimeHorizon: unknown;
  readonly surfaceGeneration: number;
  readonly themeRevision: number;
  readonly viewportRevision: number;
  readonly widthCssPx: number;
  /** Cache key for pure source-anchor work. Deliberately excludes viewport. */
  readonly worldRevisionKey: string;
}

export interface DrawingFrameSnapshotInput {
  axisKind: DrawingAxisKind;
  barSpacing?: unknown;
  coordinateKey: string;
  dpr?: unknown;
  drawingProjectionConfig?: unknown;
  drawingViewport?: DrawingFrameViewport | null;
  heightCssPx?: unknown;
  ordinalSeriesIndex?: DrawingLineageIndex | null;
  projectionKey?: unknown;
  seriesData: DisplayRow[];
  sourceInterval?: unknown;
  sourceIntervalSeconds?: unknown;
  sourceTimeHorizon?: unknown;
  surfaceToken?: unknown;
  themeKey?: unknown;
  viewportKey?: unknown;
  widthCssPx?: unknown;
}

export interface DrawingFrameSnapshotFactory {
  capture(input: DrawingFrameSnapshotInput): DrawingFrameSnapshot;
  reset(): void;
}

export interface DrawingViewportSignatureInput {
  barSpacing: unknown;
  heightCssPx: unknown;
  logicalRange: Readonly<{ from: unknown; to: unknown }> | null;
  priceAtBottom: unknown;
  priceAtMiddle: unknown;
  priceAtTop: unknown;
  priceProjectionKey: unknown;
  scrollPosition: unknown;
}

interface FactoryState {
  dataRevision: number;
  lastCoordinateKey: string | null;
  lastData: DisplayRow[] | null;
  lastDpr: number | null;
  lastHeight: number | null;
  lastLineageIndex: DrawingLineageIndex | null;
  lastLineageRevision: number;
  lastProjectionKey: unknown;
  lastSourceInterval: unknown;
  lastSourceIntervalSeconds: unknown;
  lastSourceTimeHorizon: unknown;
  lastSurfaceToken: unknown;
  lastThemeKey: unknown;
  lastViewportKey: unknown;
  lastWidth: number | null;
  projectionRevision: number;
  snapshot: DrawingFrameSnapshot | null;
  surfaceGeneration: number;
  themeRevision: number;
  viewportRevision: number;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizedDpr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedBarSpacing(value: unknown): number {
  return finiteNumber(value) && value > 0 ? value : 1;
}

function normalizedDrawingViewport(value: unknown): DrawingFrameViewport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DrawingFrameViewport>;
  if ((candidate.horizontalDomain !== "logical" && candidate.horizontalDomain !== "time")
    || !finiteNumber(candidate.minHorizontal)
    || !finiteNumber(candidate.maxHorizontal)
    || !finiteNumber(candidate.minPrice)
    || !finiteNumber(candidate.maxPrice)
    || candidate.minHorizontal > candidate.maxHorizontal
    || candidate.minPrice > candidate.maxPrice) return null;
  return Object.freeze({
    horizontalDomain: candidate.horizontalDomain,
    minHorizontal: candidate.minHorizontal,
    maxHorizontal: candidate.maxHorizontal,
    minPrice: candidate.minPrice,
    maxPrice: candidate.maxPrice,
  });
}

/**
 * Build the opaque viewport key used by the frame factory. Price samples make
 * vertical scale changes observable even when Lightweight Charts leaves the
 * logical range untouched. Invalid or half-ready transforms fail closed.
 */
export function createDrawingViewportSignature({
  barSpacing,
  heightCssPx,
  logicalRange,
  priceAtBottom,
  priceAtMiddle,
  priceAtTop,
  priceProjectionKey,
  scrollPosition,
}: DrawingViewportSignatureInput): string | null {
  if (!finiteNumber(heightCssPx) || heightCssPx <= 0
    || !finiteNumber(barSpacing) || barSpacing <= 0
    || !finiteNumber(scrollPosition)
    || !finiteNumber(priceAtTop)
    || !finiteNumber(priceAtMiddle)
    || !finiteNumber(priceAtBottom)) {
    return null;
  }
  if (logicalRange !== null
    && (!finiteNumber(logicalRange.from) || !finiteNumber(logicalRange.to))) {
    return null;
  }
  return JSON.stringify([
    logicalRange?.from ?? null,
    logicalRange?.to ?? null,
    barSpacing,
    scrollPosition,
    priceProjectionKey,
    heightCssPx,
    priceAtTop,
    priceAtMiddle,
    priceAtBottom,
  ]);
}

function createState(): FactoryState {
  return {
    dataRevision: 0,
    lastCoordinateKey: null,
    lastData: null,
    lastDpr: null,
    lastHeight: null,
    lastLineageIndex: null,
    lastLineageRevision: -1,
    lastProjectionKey: null,
    lastSourceInterval: null,
    lastSourceIntervalSeconds: null,
    lastSourceTimeHorizon: null,
    lastSurfaceToken: null,
    lastThemeKey: null,
    lastViewportKey: null,
    lastWidth: null,
    projectionRevision: 0,
    snapshot: null,
    surfaceGeneration: 0,
    themeRevision: 0,
    viewportRevision: 0,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

/**
 * Stateful revision allocator. A factory belongs to one chart surface.
 * Repeated captures with unchanged inputs return the same frozen snapshot.
 */
export function createDrawingFrameSnapshotFactory(): DrawingFrameSnapshotFactory {
  let state = createState();

  return {
    capture(input): DrawingFrameSnapshot {
      const seriesData = Array.isArray(input.seriesData) ? input.seriesData : [];
      const coordinateKey = typeof input.coordinateKey === "string"
        ? input.coordinateKey
        : "";
      const ordinalSeriesIndex = input.ordinalSeriesIndex ?? null;
      const lineageRevision = ordinalSeriesIndex?.revision ?? 0;
      const widthCssPx = finiteNonNegative(input.widthCssPx, 0);
      const heightCssPx = finiteNonNegative(input.heightCssPx, 0);
      const dpr = normalizedDpr(input.dpr);
      const barSpacing = normalizedBarSpacing(input.barSpacing);
      const drawingViewport = normalizedDrawingViewport(input.drawingViewport);
      const projectionKey = input.projectionKey ?? input.drawingProjectionConfig ?? input.axisKind;
      const viewportKey = JSON.stringify([
        input.viewportKey ?? null,
        barSpacing,
        drawingViewport?.horizontalDomain ?? null,
        drawingViewport?.minHorizontal ?? null,
        drawingViewport?.maxHorizontal ?? null,
        drawingViewport?.minPrice ?? null,
        drawingViewport?.maxPrice ?? null,
      ]);
      const themeKey = input.themeKey ?? null;
      const surfaceToken = input.surfaceToken ?? null;

      const surfaceChanged = state.snapshot === null
        || !sameValue(surfaceToken, state.lastSurfaceToken);
      const dataChanged = state.snapshot === null
        || seriesData !== state.lastData
        || !sameValue(input.sourceTimeHorizon, state.lastSourceTimeHorizon)
        || !sameValue(input.sourceInterval, state.lastSourceInterval)
        || !sameValue(input.sourceIntervalSeconds, state.lastSourceIntervalSeconds);
      const projectionChanged = state.snapshot === null
        || !sameValue(projectionKey, state.lastProjectionKey)
        || coordinateKey !== state.lastCoordinateKey
        || input.axisKind !== state.snapshot?.axisKind;
      const lineageChanged = state.snapshot === null
        || ordinalSeriesIndex !== state.lastLineageIndex
        || lineageRevision !== state.lastLineageRevision;
      const viewportChanged = state.snapshot === null
        || !sameValue(viewportKey, state.lastViewportKey)
        || widthCssPx !== state.lastWidth
        || heightCssPx !== state.lastHeight
        || dpr !== state.lastDpr;
      const themeChanged = state.snapshot === null
        || !sameValue(themeKey, state.lastThemeKey);

      if (surfaceChanged) state.surfaceGeneration += 1;
      if (dataChanged) state.dataRevision += 1;
      if (projectionChanged) state.projectionRevision += 1;
      if (viewportChanged) state.viewportRevision += 1;
      if (themeChanged) state.themeRevision += 1;

      if (!surfaceChanged
        && !dataChanged
        && !projectionChanged
        && !lineageChanged
        && !viewportChanged
        && !themeChanged
        && state.snapshot) {
        return state.snapshot;
      }

      const coordinateIndex = !dataChanged && !lineageChanged && state.snapshot
        ? state.snapshot.coordinateIndex
        : createDrawingCoordinateIndex(seriesData, { lineageIndex: ordinalSeriesIndex });
      const worldRevisionKey = [
        state.surfaceGeneration,
        coordinateKey,
        state.dataRevision,
        state.projectionRevision,
        lineageRevision,
      ].join(":");
      const snapshot: DrawingFrameSnapshot = Object.freeze({
        axisKind: input.axisKind,
        barSpacing,
        coordinateIndex,
        coordinateKey,
        dataRevision: state.dataRevision,
        dpr,
        drawingProjectionConfig: input.drawingProjectionConfig,
        drawingViewport,
        heightCssPx,
        lineageIndexRevision: lineageRevision,
        ordinalSeriesIndex,
        projectionRevision: state.projectionRevision,
        seriesData,
        sourceInterval: input.sourceInterval,
        sourceIntervalSeconds: input.sourceIntervalSeconds,
        sourceTimeHorizon: input.sourceTimeHorizon,
        surfaceGeneration: state.surfaceGeneration,
        themeRevision: state.themeRevision,
        viewportRevision: state.viewportRevision,
        widthCssPx,
        worldRevisionKey,
      });

      state = {
        ...state,
        lastCoordinateKey: coordinateKey,
        lastData: seriesData,
        lastDpr: dpr,
        lastHeight: heightCssPx,
        lastLineageIndex: ordinalSeriesIndex,
        lastLineageRevision: lineageRevision,
        lastProjectionKey: projectionKey,
        lastSourceInterval: input.sourceInterval,
        lastSourceIntervalSeconds: input.sourceIntervalSeconds,
        lastSourceTimeHorizon: input.sourceTimeHorizon,
        lastSurfaceToken: surfaceToken,
        lastThemeKey: themeKey,
        lastViewportKey: viewportKey,
        lastWidth: widthCssPx,
        snapshot,
      };
      return snapshot;
    },
    reset(): void {
      state = createState();
    },
  };
}

export function isDrawingFrameSnapshot(value: unknown): value is DrawingFrameSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DrawingFrameSnapshot>;
  return (candidate.axisKind === "time" || candidate.axisKind === "derived-ordinal")
    && finiteNumber(candidate.barSpacing)
    && candidate.barSpacing > 0
    && typeof candidate.coordinateKey === "string"
    && Number.isSafeInteger(candidate.dataRevision)
    && Number.isSafeInteger(candidate.projectionRevision)
    && Number.isSafeInteger(candidate.lineageIndexRevision)
    && Number.isSafeInteger(candidate.viewportRevision)
    && Number.isSafeInteger(candidate.themeRevision)
    && Number.isSafeInteger(candidate.surfaceGeneration)
    && finiteNumber(candidate.widthCssPx)
    && candidate.widthCssPx >= 0
    && finiteNumber(candidate.heightCssPx)
    && candidate.heightCssPx >= 0
    && finiteNumber(candidate.dpr)
    && candidate.dpr > 0
    && typeof candidate.worldRevisionKey === "string"
    && (candidate.drawingViewport === null
      || normalizedDrawingViewport(candidate.drawingViewport) !== null)
    && Array.isArray(candidate.seriesData)
    && candidate.coordinateIndex instanceof DrawingCoordinateIndex;
}

/** Serializable frame generation equality; object identity is checked by the adapter. */
export function drawingFrameRevisionsEqual(
  left: unknown,
  right: unknown,
): left is DrawingFrameSnapshot {
  if (!isDrawingFrameSnapshot(left) || !isDrawingFrameSnapshot(right)) return false;
  return left.axisKind === right.axisKind
    && left.barSpacing === right.barSpacing
    && left.coordinateKey === right.coordinateKey
    && left.dataRevision === right.dataRevision
    && left.projectionRevision === right.projectionRevision
    && left.lineageIndexRevision === right.lineageIndexRevision
    && left.viewportRevision === right.viewportRevision
    && left.themeRevision === right.themeRevision
    && left.surfaceGeneration === right.surfaceGeneration
    && left.widthCssPx === right.widthCssPx
    && left.heightCssPx === right.heightCssPx
    && left.dpr === right.dpr
    && JSON.stringify(left.drawingViewport) === JSON.stringify(right.drawingViewport)
    && left.worldRevisionKey === right.worldRevisionKey;
}
