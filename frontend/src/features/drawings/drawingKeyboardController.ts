/**
 * drawingKeyboardController — keyboard lifecycle for drawings.
 *
 * Handles the global Escape / Delete / Backspace shortcuts for the active
 * drawing tools and the current selection. Extracted from the main interaction
 * controller so keyboard handling is not interleaved with pointer drawing.
 *
 * Escape cancels an in-progress placement or clears the current selection;
 * Delete / Backspace removes the selected drawing (unless an input is focused).
 * Text-edit keystrokes are intentionally not intercepted here — while a text
 * editor is active (editingTextIdRef set) this handler bails out early.
 */
import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";
import type { SelectedTextUi } from "./drawingSelectionController.js";
import type { DrawingPrimitive } from "./drawingTypes.js";

export interface UseDrawingKeyboardOptions {
  active: boolean;
  anchorDataRef: MutableRefObject<unknown | null>;
  selectedIdRef: MutableRefObject<string | null>;
  editingTextIdRef: MutableRefObject<string | null>;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  removePreview(): void;
  deselectAll(): void;
  detachPrim(primitive: DrawingPrimitive): void;
  persistDrawings(): void;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
  cancelActiveFreehandStroke?: (() => boolean) | null;
}

export function useDrawingKeyboard({
  active,
  anchorDataRef,
  selectedIdRef,
  editingTextIdRef,
  primitivesRef,
  removePreview,
  deselectAll,
  detachPrim,
  persistDrawings,
  setSelectedPrimId,
  setSelectedTextUi,
  cancelActiveFreehandStroke = null,
}: UseDrawingKeyboardOptions): void {
  useEffect(() => {
    if (!active) return undefined;

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't intercept if editing text
      if (editingTextIdRef.current) return;

      if (e.key === "Escape") {
        if (cancelActiveFreehandStroke?.()) {
          e.preventDefault();
          return;
        }
        if (anchorDataRef.current) {
          removePreview();
        } else if (selectedIdRef.current) {
          deselectAll();
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        // Don't delete if focused on an input
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;

        const id = selectedIdRef.current;
        const idx = primitivesRef.current.findIndex((p) => p.id === id);
        if (idx >= 0) {
          const primitive = primitivesRef.current[idx];
          if (!primitive) return;
          detachPrim(primitive);
          primitivesRef.current.splice(idx, 1);
          persistDrawings();
        }
        selectedIdRef.current = null;
        setSelectedPrimId(null);
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, anchorDataRef, selectedIdRef, editingTextIdRef, primitivesRef, removePreview, deselectAll, detachPrim, persistDrawings, setSelectedPrimId, setSelectedTextUi, cancelActiveFreehandStroke]);
}

export default useDrawingKeyboard;
