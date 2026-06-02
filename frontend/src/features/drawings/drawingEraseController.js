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

export function updateEraserHoverState(primitives, x, y) {
  let hitId = null;
  for (let index = primitives.length - 1; index >= 0; index -= 1) {
    const prim = primitives[index];
    let isHit = false;
    if (typeof prim.hitTest === "function") {
      const hit = prim.hitTest(x, y);
      isHit = hit != null && hit !== false;
    }
    if (isHit && !hitId) {
      hitId = prim.id;
      prim.setHovered(true);
    } else {
      prim.setHovered(false);
    }
  }
  return hitId;
}
