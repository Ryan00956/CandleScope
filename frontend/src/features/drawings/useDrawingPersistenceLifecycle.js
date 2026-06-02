import { useCallback, useEffect } from "react";
import { createPrimitiveFromSavedDrawing } from "./drawingPrimitiveFactory";
import { loadDrawings, saveDrawings } from "./drawingPersistence";
import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController";

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
}) {
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

  return { persistDrawings };
}
