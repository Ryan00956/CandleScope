import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";
import type { DrawingPrimitive, MutableRef } from "./drawingTypes.js";

interface EraseDrawingHit {
  prim: DrawingPrimitive;
}

interface EraseDrawingOptions {
  detachPrim: (primitive: DrawingPrimitive) => void;
  hit: EraseDrawingHit | null;
  persistDrawings: () => void;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  selectedIdRef: MutableRef<string | null>;
  setSelectedPrimId: (id: string | null) => void;
  setSelectedTextUi: (value: typeof EMPTY_SELECTED_TEXT_UI) => void;
}

export function eraseDrawingAtPointer({
  detachPrim,
  hit,
  persistDrawings,
  primitivesRef,
  selectedIdRef,
  setSelectedPrimId,
  setSelectedTextUi,
}: EraseDrawingOptions): boolean {
  if (!hit) return false;
  const idx = primitivesRef.current.indexOf(hit.prim);
  if (idx < 0) return false;

  detachPrim(hit.prim);
  primitivesRef.current.splice(idx, 1);
  if (selectedIdRef.current === hit.prim.id) {
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
  }
  persistDrawings();
  return true;
}
