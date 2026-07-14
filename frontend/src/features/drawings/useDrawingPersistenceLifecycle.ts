import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createPrimitiveFromSavedDrawing } from "./drawingPrimitiveFactory.js";
import { loadDrawings, saveDrawings } from "./drawingPersistence.js";
import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";
import type { SelectedTextUi } from "./drawingSelectionController.js";
import type {
  DrawingPrimitive,
} from "./drawingTypes.js";
import type { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import {
  drawingPerfCounters,
  registerDrawingPerfRuntimeSummaryProvider,
} from "./performance/drawingPerfCounters.js";
import type { DrawingPerfRuntimeSummary } from "./performance/drawingPerfCounters.js";

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function runtimeArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function runtimePrimitiveType(record: Record<string, unknown>): string {
  if (typeof record._lineType === "string" || typeof record.lineType === "string") return "line";
  if (typeof record._shapeType === "string" || typeof record.shapeType === "string") return "shape";
  const type = record.type ?? record._type;
  if (typeof type === "string" && type.trim()) return type.trim();
  const constructorRecord = runtimeRecord(record.constructor);
  const constructorName = constructorRecord?.name;
  return typeof constructorName === "string" && constructorName.trim()
    ? constructorName.trim()
    : "unknown";
}

function runtimePrimitivePointCount(record: Record<string, unknown>): number {
  const stroke = runtimeRecord(record.stroke ?? record._stroke);
  const strokePointCount = runtimeArrayLength(stroke?.points);
  if (strokePointCount !== null) return strokePointCount;
  const dataPointCount = runtimeArrayLength(record.dataPoints ?? record._dataPoints);
  if (dataPointCount !== null) return dataPointCount;
  return record.dataPoint !== undefined || record._dataPoint !== undefined ? 1 : 0;
}

export function summarizeDrawingRuntimePrimitives(
  primitives: readonly unknown[],
): DrawingPerfRuntimeSummary {
  let entityCount = 0;
  let pointCount = 0;
  const typeCounts: Record<string, number> = {};
  for (const primitive of primitives) {
    const record = runtimeRecord(primitive);
    if (!record) continue;
    entityCount += 1;
    const type = runtimePrimitiveType(record);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    pointCount += runtimePrimitivePointCount(record);
  }
  return {
    entityCount,
    pointCount,
    typeCounts,
  };
}

function persistAndMeasure(symbol: string, primitives: readonly DrawingPrimitive[]): void {
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  try {
    saveDrawings(symbol, primitives);
  } finally {
    const endedAt = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    const durationMs = Math.max(0, endedAt - startedAt);
    drawingPerfCounters.recordPersistenceDuration(durationMs);
  }
}

export interface DrawingPersistenceAdapter {
  hasSeries?(): boolean;
  attachPrimitive?(primitive: DrawingPrimitive): unknown;
  detachPrimitive?(primitive: DrawingPrimitive): unknown;
}

export interface UseDrawingPersistenceLifecycleOptions {
  currentFreehandRef: MutableRefObject<FreehandDrawingPrimitive | null>;
  draggingRef: MutableRefObject<unknown | null>;
  getChartAdapter(): DrawingPersistenceAdapter | null;
  hiddenRef: MutableRefObject<boolean>;
  isDrawingFreehandRef: MutableRefObject<boolean>;
  prevSymbolRef: MutableRefObject<string | null>;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  selectedIdRef: MutableRefObject<string | null>;
  seriesReady: number;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
  symbol: string;
  symbolRef: MutableRefObject<string>;
}

export function useDrawingPersistenceLifecycle({
  currentFreehandRef,
  draggingRef,
  getChartAdapter,
  hiddenRef,
  isDrawingFreehandRef,
  prevSymbolRef,
  primitivesRef,
  selectedIdRef,
  seriesReady,
  setSelectedPrimId,
  setSelectedTextUi,
  symbol,
  symbolRef,
}: UseDrawingPersistenceLifecycleOptions): { persistDrawings(): void } {
  const persistDrawings = useCallback(() => {
    persistAndMeasure(symbolRef.current, primitivesRef.current);
  }, [primitivesRef, symbolRef]);

  useEffect(() => registerDrawingPerfRuntimeSummaryProvider(
    () => summarizeDrawingRuntimePrimitives(primitivesRef.current),
  ), [primitivesRef]);

  useEffect(() => {
    const adapter = getChartAdapter();
    if (!adapter?.hasSeries?.() || !symbol || !seriesReady) return;

    const prevSymbol = prevSymbolRef.current;
    const symbolChanged = prevSymbol && prevSymbol !== symbol;

    if (symbolChanged) {
      if (primitivesRef.current.length > 0) {
        persistAndMeasure(prevSymbol, primitivesRef.current);
      }

      for (const prim of primitivesRef.current) {
        adapter.detachPrimitive?.(prim);
      }

      primitivesRef.current = [];
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      draggingRef.current = null;
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
      prevSymbolRef.current = symbol;
    }

    if (!symbolChanged && primitivesRef.current.length > 0) {
      for (const prim of primitivesRef.current) {
        try {
          adapter.detachPrimitive?.(prim);
          prim.setHidden?.(hiddenRef.current, false);
          adapter.attachPrimitive?.(prim);
        } catch (err) {
          console.warn("Failed to re-attach drawing:", err);
        }
      }
      prevSymbolRef.current = symbol;
      return;
    }

    const saved = loadDrawings(symbol);
    if (!saved || saved.length === 0) {
      prevSymbolRef.current = symbol;
      return;
    }

    for (const item of saved) {
      let prim = null;
      try {
        prim = createPrimitiveFromSavedDrawing(item);
      } catch (err) {
        console.warn("Failed to restore drawing:", err, item);
      }
      if (prim) {
        prim.setHidden?.(hiddenRef.current, false);
        adapter.attachPrimitive?.(prim);
        primitivesRef.current.push(prim);
      }
    }
    drawingPerfCounters.setGauge("visibleEntities", primitivesRef.current.length);

    prevSymbolRef.current = symbol;
  }, [
    currentFreehandRef,
    draggingRef,
    getChartAdapter,
    hiddenRef,
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
  ]);

  useEffect(() => () => {
    const adapter = getChartAdapter();
    for (const prim of primitivesRef.current) {
      try {
        adapter?.detachPrimitive?.(prim);
      } catch {
        // Best-effort teardown. The owning chart may already be disposing.
      }
    }
  }, [getChartAdapter, primitivesRef]);

  return { persistDrawings };
}
