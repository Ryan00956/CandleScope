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
    saveDrawings(symbolRef.current, primitivesRef.current);
  }, [primitivesRef, symbolRef]);

  useEffect(() => {
    const adapter = getChartAdapter();
    if (!adapter?.hasSeries?.() || !symbol || !seriesReady) return;

    const prevSymbol = prevSymbolRef.current;
    const symbolChanged = prevSymbol && prevSymbol !== symbol;

    if (symbolChanged) {
      if (primitivesRef.current.length > 0) {
        saveDrawings(prevSymbol, primitivesRef.current);
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
