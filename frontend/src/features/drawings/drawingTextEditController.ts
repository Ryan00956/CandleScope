/**
 * drawingTextEditController — text annotation edit lifecycle.
 *
 * Extracted from the main drawing interaction controller so that the
 * inline-text editing flow (create / commit / cancel / double-click edit /
 * commit-before-export) lives in one place instead of being interleaved with
 * pointer, selection and persistence handling.
 *
 * The host controller still owns the primitive list, selection state and
 * persistence; this hook receives the capabilities it needs (primitive lookup,
 * attach/detach, persist, coordinate conversion, active-tool/onToolChange refs,
 * and the selection setters) as parameters and never imports them directly.
 *
 * Serialization format is unchanged: committed text is written back onto the
 * existing TextDrawingPrimitive, so on-disk drawing schema is untouched.
 */
import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";
import type { SelectedTextUi } from "./drawingSelectionController.js";
import type {
  DrawingDataToScreen,
  DrawingPrimitive,
  DrawingToolId,
  ScreenPoint,
} from "./drawingTypes.js";
import {
  drawingCommandsForSavedDrawing,
} from "./core/drawingDocumentRuntime.js";
import type { DrawingCommand } from "./core/drawingCommands.js";
import { serializeDrawingPrimitive } from "./drawingPersistence.js";
import type { PersistableDrawingPrimitive } from "./drawingTypes.js";

export interface TextEditingOptions {
  clearSelection?: boolean;
  exitTool?: boolean;
}

export interface UseDrawingTextEditOptions {
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  selectedIdRef: MutableRefObject<string | null>;
  getPrimitiveById(id: string): DrawingPrimitive | null;
  attachPrim(primitive: DrawingPrimitive): boolean | void;
  detachPrim(primitive: DrawingPrimitive): boolean | void;
  deselectAll(): void;
  selectPrimitive(id: string): void;
  refreshSelectedTextUi(id?: string | null): void;
  beforeTerminalMutation(): boolean;
  persistDrawings(commands: readonly DrawingCommand[]): boolean | void;
  dataToScreen: DrawingDataToScreen;
  activeToolRef: MutableRefObject<DrawingToolId | null>;
  onToolChangeRef: MutableRefObject<((tool: DrawingToolId | null) => void) | null | undefined>;
  drawingContinuousEnabledRef: MutableRefObject<boolean>;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
}

export interface DrawingTextEditRuntime {
  editingTextId: string | null;
  editingTextValue: string;
  editingTextPos: ScreenPoint | null;
  editingTextIdRef: MutableRefObject<string | null>;
  editInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  setEditingTextValue: Dispatch<SetStateAction<string>>;
  setEditingTextPos: Dispatch<SetStateAction<ScreenPoint | null>>;
  startTextEditing(primitive: DrawingPrimitive): boolean;
  commitTextEditing(options?: TextEditingOptions): boolean;
  cancelTextEditing(options?: TextEditingOptions): boolean;
  completeSurfaceDispose(): void;
}

/** Validate the complete text payload before changing the mutable renderer draft. */
export function drawingCommandsForTextEdit(
  primitive: TextDrawingPrimitive,
  text: string,
  wasNew: boolean,
): readonly DrawingCommand[] | null {
  const saved = serializeDrawingPrimitive(
    primitive as unknown as PersistableDrawingPrimitive,
  );
  if (!saved || saved.type !== "text") return null;
  return drawingCommandsForSavedDrawing(
    { ...saved, text },
    { type: wasNew ? "create" : "update-style" },
  );
}

export function restoreRejectedNewTextDraft({
  attachPrim,
  originalIndex,
  originalText,
  originalUnconfirmed,
  primitive,
  primitives,
}: Readonly<{
  attachPrim(primitive: DrawingPrimitive): boolean | void;
  originalIndex: number;
  originalText: string;
  originalUnconfirmed: boolean;
  primitive: TextDrawingPrimitive;
  primitives: DrawingPrimitive[];
}>): boolean {
  primitive.setText(originalText);
  if (originalUnconfirmed) primitive.markUnconfirmedText();
  else primitive.confirmText();
  let reattached = false;
  try {
    reattached = attachPrim(primitive) !== false;
  } catch {
    return false;
  }
  if (!reattached) return false;
  const index = Math.max(0, Math.min(originalIndex, primitives.length));
  primitives.splice(index, 0, primitive);
  return true;
}

export function useDrawingTextEdit({
  primitivesRef,
  selectedIdRef,
  getPrimitiveById,
  attachPrim,
  detachPrim,
  deselectAll,
  selectPrimitive,
  refreshSelectedTextUi,
  beforeTerminalMutation,
  persistDrawings,
  dataToScreen,
  activeToolRef,
  onToolChangeRef,
  drawingContinuousEnabledRef,
  setSelectedPrimId,
  setSelectedTextUi,
}: UseDrawingTextEditOptions): DrawingTextEditRuntime {
  // ── Text editing state ──
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  // Mirror of editingTextId for use inside event handlers (avoids stale
  // React state during the same mousedown frame that just blurred the editor).
  const editingTextIdRef = useRef<string | null>(null);
  const editingTextWasNewRef = useRef(false);
  const [editingTextValue, setEditingTextValue] = useState("");
  const [editingTextPos, setEditingTextPos] = useState<ScreenPoint | null>(null); // { x, y } screen coords
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Cancel text editing ──

  const cancelTextEditing = useCallback((opts: TextEditingOptions = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const wasEditing = editingTextIdRef.current;
    if (wasEditing) {
      // If text was newly created and never confirmed, drop it.
      const prim = getPrimitiveById(wasEditing);
      if (prim && prim instanceof TextDrawingPrimitive) {
        // Make the underlying canvas text visible again.
        prim.setHidden(false);
        if (prim.isUnconfirmedText) {
          const idx = primitivesRef.current.indexOf(prim);
          if (idx >= 0) {
            if (detachPrim(prim) === false) {
              prim.setHidden(true);
              return false;
            }
            primitivesRef.current.splice(idx, 1);
          }
          if (selectedIdRef.current === wasEditing) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
        }
      }
    }
    editingTextIdRef.current = null;
    editingTextWasNewRef.current = false;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection) {
      deselectAll();
    }
    // Unless continuous drawing is enabled, leaving text edit mode also
    // restores the passive cursor.
    if (exitTool && !drawingContinuousEnabledRef.current && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    refreshSelectedTextUi();
    return true;
  }, [primitivesRef, selectedIdRef, getPrimitiveById, detachPrim, deselectAll, refreshSelectedTextUi, activeToolRef, onToolChangeRef, drawingContinuousEnabledRef, setSelectedPrimId, setSelectedTextUi]);

  // ── Commit text editing ──

  const commitTextEditing = useCallback((opts: TextEditingOptions = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const editingId = editingTextIdRef.current;
    if (!editingId) return false;
    if (!beforeTerminalMutation()) return false;
    const prim = getPrimitiveById(editingId);
    const wasNew = editingTextWasNewRef.current;
    let removed = false;
    let removedIndex = -1;
    let commands: readonly DrawingCommand[] | null = null;
    let originalText: string | null = null;
    let originalUnconfirmed = false;
    let originalIndex = -1;
    let updatedText = false;
    if (prim && prim instanceof TextDrawingPrimitive) {
      originalIndex = primitivesRef.current.indexOf(prim);
      // Restore canvas rendering of the underlying text.
      prim.setHidden(false);
      const value = editingTextValue;
      const trimmed = value.replace(/\s+$/g, "");
      if (trimmed) {
        originalText = prim.text;
        originalUnconfirmed = prim.isUnconfirmedText;
        commands = drawingCommandsForTextEdit(prim, trimmed, wasNew);
        if (!commands) return false;
        prim.setText(trimmed);
        if (prim.isUnconfirmedText) prim.confirmText();
        updatedText = true;
      } else {
        // Empty text → delete the annotation
        const idx = primitivesRef.current.indexOf(prim);
        if (idx >= 0) {
          if (detachPrim(prim) === false) return false;
          primitivesRef.current.splice(idx, 1);
          removed = true;
          removedIndex = idx;
          if (!wasNew) commands = Object.freeze([
            Object.freeze({ type: "delete", id: prim.id }),
          ]);
        }
      }
    }
    let persisted = true;
    if (commands) {
      try {
        persisted = persistDrawings(commands) !== false;
      } catch {
        persisted = false;
      }
    }
    if (!persisted) {
      let current = getPrimitiveById(editingId);
      if (!current
        && wasNew
        && updatedText
        && prim instanceof TextDrawingPrimitive
        && originalText !== null) {
        if (restoreRejectedNewTextDraft({
          attachPrim,
          originalIndex,
          originalText,
          originalUnconfirmed,
          primitive: prim,
          primitives: primitivesRef.current,
        })) {
          current = prim;
        } else {
          // The canonical document never accepted this new entity and checked
          // reattach also failed. Close the orphaned editor explicitly instead
          // of retaining an id that no registry can resolve.
          editingTextIdRef.current = null;
          editingTextWasNewRef.current = false;
          setEditingTextId(null);
          setEditingTextValue("");
          setEditingTextPos(null);
          if (selectedIdRef.current === editingId) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
          refreshSelectedTextUi();
          return false;
        }
      }
      if (!current && removed && prim instanceof TextDrawingPrimitive) {
        // A production document rejection normally restores a fresh canonical
        // primitive. If an injected/exceptional boundary did not, reinsert the
        // original only after a checked surface reattach. On attach failure it
        // stays absent: the next lifecycle delta stage then drops the renderer's
        // old credential and restores the still-authoritative document entity.
        let reattached = false;
        try { reattached = attachPrim(prim) !== false; } catch { /* retry via document */ }
        if (reattached) {
          const index = Math.max(0, Math.min(removedIndex, primitivesRef.current.length));
          primitivesRef.current.splice(index, 0, prim);
          current = prim;
        }
      }
      if (updatedText
        && current instanceof TextDrawingPrimitive
        && current === prim
        && originalText !== null) {
        current.setText(originalText);
        if (originalUnconfirmed) current.markUnconfirmedText();
        else current.confirmText();
      }
      if (current instanceof TextDrawingPrimitive) current.setHidden(true);
      return false;
    }
    editingTextIdRef.current = null;
    editingTextWasNewRef.current = false;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection || removed) {
      deselectAll();
    } else if (prim && !removed) {
      selectPrimitive(prim.id);
    }
    if (exitTool && !drawingContinuousEnabledRef.current && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    refreshSelectedTextUi();
    return persisted;
  }, [primitivesRef, selectedIdRef, editingTextValue, getPrimitiveById, attachPrim, detachPrim, deselectAll, selectPrimitive, beforeTerminalMutation, persistDrawings, refreshSelectedTextUi, activeToolRef, onToolChangeRef, drawingContinuousEnabledRef, setSelectedPrimId, setSelectedTextUi]);

  // ── Start text editing for a specific text primitive ──

  const startTextEditing = useCallback(
    (prim: DrawingPrimitive) => {
      if (!(prim instanceof TextDrawingPrimitive)) return false;
      const screenPos = dataToScreen(prim.dataPoint);
      if (!screenPos) {
        // A newly attached text draft still needs an explicit owner when its
        // projected coordinate is temporarily unavailable. The creation
        // controller immediately calls cancelTextEditing: successful detach
        // clears this state, while failed detach leaves a hidden, retryable
        // credential for the next scope/teardown barrier.
        if (prim.isUnconfirmedText) {
          editingTextIdRef.current = prim.id;
          editingTextWasNewRef.current = true;
          setEditingTextId(prim.id);
          setEditingTextValue(prim.text === "Text" ? "" : prim.text);
          setEditingTextPos(null);
          prim.setHidden(true);
          selectPrimitive(prim.id);
        }
        return false;
      }

      editingTextIdRef.current = prim.id;
      editingTextWasNewRef.current = prim.isUnconfirmedText;
      setEditingTextId(prim.id);
      setEditingTextValue(prim.text === "Text" ? "" : prim.text);
      setEditingTextPos({ x: screenPos.x, y: screenPos.y });
      // Hide the canvas-rendered text so the editable textarea doesn't
      // appear duplicated on top of it.
      prim.setHidden(true);
      selectPrimitive(prim.id);

      // Focus the input after render
      setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 30);
      return true;
    },
    [dataToScreen, selectPrimitive],
  );

  const completeSurfaceDispose = useCallback((): void => {
    const editingId = editingTextIdRef.current;
    if (editingId) {
      const primitive = getPrimitiveById(editingId);
      if (primitive instanceof TextDrawingPrimitive) {
        primitive.setHidden(false, false);
        if (primitive.isUnconfirmedText) {
          primitivesRef.current = primitivesRef.current.filter(
            (candidate) => candidate !== primitive,
          );
          if (selectedIdRef.current === editingId) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
        }
      }
    }
    editingTextIdRef.current = null;
    editingTextWasNewRef.current = false;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    refreshSelectedTextUi();
  }, [getPrimitiveById, primitivesRef, refreshSelectedTextUi, selectedIdRef, setSelectedPrimId, setSelectedTextUi]);

  return {
    editingTextId,
    editingTextValue,
    editingTextPos,
    editingTextIdRef,
    editInputRef,
    setEditingTextValue,
    setEditingTextPos,
    startTextEditing,
    commitTextEditing,
    cancelTextEditing,
    completeSurfaceDispose,
  };
}

export default useDrawingTextEdit;
