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
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { EMPTY_SELECTED_TEXT_UI } from "./drawingSelectionController.js";

export function useDrawingTextEdit({
  primitivesRef,
  selectedIdRef,
  getPrimitiveById,
  detachPrim,
  deselectAll,
  selectPrimitive,
  refreshSelectedTextUi,
  persistDrawings,
  dataToScreen,
  activeToolRef,
  onToolChangeRef,
  setSelectedPrimId,
  setSelectedTextUi,
}) {
  // ── Text editing state ──
  const [editingTextId, setEditingTextId] = useState(null);
  // Mirror of editingTextId for use inside event handlers (avoids stale
  // React state during the same mousedown frame that just blurred the editor).
  const editingTextIdRef = useRef(null);
  const [editingTextValue, setEditingTextValue] = useState("");
  const [editingTextPos, setEditingTextPos] = useState(null); // { x, y } screen coords
  const editInputRef = useRef(null);

  // ── Cancel text editing ──

  const cancelTextEditing = useCallback((opts = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const wasEditing = editingTextIdRef.current;
    if (wasEditing) {
      // If text was newly created and never confirmed, drop it.
      const prim = getPrimitiveById(wasEditing);
      if (prim && prim instanceof TextDrawingPrimitive) {
        // Make the underlying canvas text visible again.
        prim.setHidden(false);
        if (!prim.text || !prim.text.trim()) {
          const idx = primitivesRef.current.indexOf(prim);
          if (idx >= 0) {
            detachPrim(prim);
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
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection) {
      deselectAll();
    }
    // PPT behavior: leaving text edit mode also leaves the text *tool*.
    if (exitTool && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    refreshSelectedTextUi();
  }, [primitivesRef, selectedIdRef, getPrimitiveById, detachPrim, deselectAll, refreshSelectedTextUi, activeToolRef, onToolChangeRef, setSelectedPrimId, setSelectedTextUi]);

  // ── Commit text editing ──

  const commitTextEditing = useCallback((opts = {}) => {
    const { clearSelection = false, exitTool = true } = opts || {};
    const editingId = editingTextIdRef.current;
    if (!editingId) return false;
    const prim = getPrimitiveById(editingId);
    let removed = false;
    if (prim && prim instanceof TextDrawingPrimitive) {
      // Restore canvas rendering of the underlying text.
      prim.setHidden(false);
      const value = editingTextValue;
      const trimmed = value.replace(/\s+$/g, "");
      if (trimmed) {
        prim.setText(trimmed);
      } else {
        // Empty text → delete the annotation
        const idx = primitivesRef.current.indexOf(prim);
        if (idx >= 0) {
          detachPrim(prim);
          primitivesRef.current.splice(idx, 1);
          removed = true;
        }
      }
    }
    editingTextIdRef.current = null;
    setEditingTextId(null);
    setEditingTextValue("");
    setEditingTextPos(null);
    if (clearSelection || removed) {
      deselectAll();
    } else if (prim && !removed) {
      selectPrimitive(prim.id);
    }
    if (exitTool && activeToolRef.current === "text") {
      onToolChangeRef.current?.(null);
    }
    persistDrawings();
    refreshSelectedTextUi();
    return true;
  }, [primitivesRef, editingTextValue, getPrimitiveById, detachPrim, deselectAll, selectPrimitive, persistDrawings, refreshSelectedTextUi, activeToolRef, onToolChangeRef]);

  // ── Start text editing for a specific text primitive ──

  const startTextEditing = useCallback(
    (prim) => {
      if (!(prim instanceof TextDrawingPrimitive)) return;
      const screenPos = dataToScreen(prim.dataPoint);
      if (!screenPos) return;

      editingTextIdRef.current = prim.id;
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
    },
    [dataToScreen, selectPrimitive],
  );

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
  };
}

export default useDrawingTextEdit;
