import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";
import type { DrawingPrimitive, MutableRef } from "./drawingTypes.js";
import type { DrawingCommand } from "./core/drawingCommands.js";

interface EraseDrawingHit {
  prim: DrawingPrimitive;
}

interface EraseDrawingOptions {
  detachPrim: (primitive: DrawingPrimitive) => boolean | void;
  hit: EraseDrawingHit | null;
  persistDrawings: (commands: readonly DrawingCommand[]) => boolean | void;
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

  if (detachPrim(hit.prim) === false) return false;
  primitivesRef.current.splice(idx, 1);
  if (persistDrawings([Object.freeze({ type: "delete", id: hit.prim.id })]) === false) return false;
  if (selectedIdRef.current === hit.prim.id) {
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
  }
  return true;
}
