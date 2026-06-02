import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController";

export function eraseDrawingAtPointer({
  detachPrim,
  hit,
  persistDrawings,
  primitivesRef,
  selectedIdRef,
  setSelectedPrimId,
  setSelectedTextUi,
}) {
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
