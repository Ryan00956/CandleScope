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
import type { DrawingCommand } from "./core/drawingCommands.js";

export interface UseDrawingKeyboardOptions {
  active: boolean;
  anchorDataRef: MutableRefObject<unknown | null>;
  beforeTerminalMutation(): boolean;
  selectedIdRef: MutableRefObject<string | null>;
  editingTextIdRef: MutableRefObject<string | null>;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  removePreview(): boolean;
  deselectAll(): void;
  detachPrim(primitive: DrawingPrimitive): boolean | void;
  persistDrawings(commands: readonly DrawingCommand[]): boolean | void;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
  hasActiveFreehandStroke?: (() => boolean) | null;
  cancelActiveFreehandStroke?: (() => boolean) | null;
}

export function handleDrawingEscape({
  hasActiveFreehandStroke,
  cancelActiveFreehandStroke,
  hasAnchor,
  hasSelection,
  removePreview,
  deselectAll,
  preventDefault,
}: Readonly<{
  hasActiveFreehandStroke: boolean;
  cancelActiveFreehandStroke(): boolean;
  hasAnchor: boolean;
  hasSelection: boolean;
  removePreview(): void;
  deselectAll(): void;
  preventDefault(): void;
}>): void {
  if (hasActiveFreehandStroke) {
    cancelActiveFreehandStroke();
    preventDefault();
    return;
  }
  if (hasAnchor) removePreview();
  else if (hasSelection) deselectAll();
}

export function useDrawingKeyboard({
  active,
  anchorDataRef,
  beforeTerminalMutation,
  selectedIdRef,
  editingTextIdRef,
  primitivesRef,
  removePreview,
  deselectAll,
  detachPrim,
  persistDrawings,
  setSelectedPrimId,
  setSelectedTextUi,
  hasActiveFreehandStroke = null,
  cancelActiveFreehandStroke = null,
}: UseDrawingKeyboardOptions): void {
  useEffect(() => {
    if (!active) return undefined;

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't intercept if editing text
      if (editingTextIdRef.current) return;

      if (e.key === "Escape") {
        handleDrawingEscape({
          hasActiveFreehandStroke: hasActiveFreehandStroke?.() === true,
          cancelActiveFreehandStroke: () => cancelActiveFreehandStroke?.() !== false,
          hasAnchor: anchorDataRef.current !== null,
          hasSelection: selectedIdRef.current !== null,
          removePreview,
          deselectAll,
          preventDefault: () => e.preventDefault(),
        });
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        // Don't delete if focused on an input
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
        // This terminal barrier retires transient credentials and verifies the
        // rendered symbol owns the active document before detach can happen.
        if (!beforeTerminalMutation()) return;

        const id = selectedIdRef.current;
        const idx = primitivesRef.current.findIndex((p) => p.id === id);
        if (idx >= 0) {
          const primitive = primitivesRef.current[idx];
          if (!primitive) return;
          if (detachPrim(primitive) === false) return;
          primitivesRef.current.splice(idx, 1);
          if (persistDrawings([Object.freeze({ type: "delete", id })]) === false) return;
        }
        selectedIdRef.current = null;
        setSelectedPrimId(null);
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, anchorDataRef, beforeTerminalMutation, selectedIdRef, editingTextIdRef, primitivesRef, removePreview, deselectAll, detachPrim, persistDrawings, setSelectedPrimId, setSelectedTextUi, hasActiveFreehandStroke, cancelActiveFreehandStroke]);
}

export default useDrawingKeyboard;
