import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { DrawingCommand } from "../core/drawingCommands.js";
import { drawingCommandsForSavedDrawing } from "../core/drawingDocumentRuntime.js";
import type {
  DrawingDataPoint,
  DrawingDataToScreen,
  DrawingToolId,
  SavedDrawing,
  SavedTextDrawing,
  ScreenPoint,
} from "../drawingTypes.js";

export interface DrawingEntityTextEditingOptions {
  readonly clearSelection?: boolean;
  readonly exitTool?: boolean;
}

export interface StartDrawingEntityTextEditOptions {
  /** A new draft has an id and geometry, but is not in the document yet. */
  readonly isNew?: boolean;
  /** Exact pointer-space placement for a new draft before its first scene projection. */
  readonly screenPoint?: ScreenPoint | null;
}

export interface DrawingEntityTextEditSnapshot {
  readonly editingTextId: string | null;
  readonly editingTextPos: ScreenPoint | null;
  readonly editingTextValue: string;
}

export interface DrawingEntityTextCommitReceipt {
  readonly committed: boolean;
  readonly changed: boolean;
  readonly ticket: Readonly<{
    readonly scopeKey: string;
    readonly documentRevision: number;
    readonly surfaceGeneration: number;
    readonly viewportRevision: number;
  }> | null;
}

export interface DrawingEntityTextEditControllerOptions {
  readonly beforeTerminalMutation: () => boolean;
  readonly dataToScreen: DrawingDataToScreen;
  readonly deselectAll: () => void;
  readonly getActiveTool: () => DrawingToolId | null;
  /** Allows a completed text edit to keep the text tool active for repeated placement. */
  readonly isContinuousDrawingEnabled?: () => boolean;
  readonly getSavedDrawingById: (id: string) => SavedDrawing | null;
  readonly getSelectedDrawingId: () => string | null;
  readonly onToolChange: (tool: DrawingToolId | null) => void;
  readonly persistSceneCommands: (
    commands: readonly DrawingCommand[],
  ) => boolean | void | DrawingEntityTextCommitReceipt | null;
  /**
   * Keep the textarea as the exact visible owner until the committed static
   * scene paint is acknowledged. Returning a disposer means completion is
   * deferred; returning null completes synchronously.
   */
  readonly deferCommittedScenePaint?: (
    receipt: DrawingEntityTextCommitReceipt,
    complete: () => void,
  ) => (() => void) | null;
  readonly refreshSelectedTextUi: (id?: string | null) => void;
  readonly selectDrawing: (id: string) => void;
  /** The scene projector omits this entity while the textarea owns its pixels. */
  readonly setActiveSceneEntityId: (id: string | null) => void;
}

export interface DrawingEntityTextEditController {
  readonly editingTextIdRef: MutableRefObject<string | null>;
  cancelTextEditing(options?: DrawingEntityTextEditingOptions): boolean;
  commitTextEditing(options?: DrawingEntityTextEditingOptions): boolean;
  completeSurfaceDispose(): void;
  getSnapshot(): DrawingEntityTextEditSnapshot;
  setEditingTextPos(value: ScreenPoint | null): void;
  setEditingTextValue(value: string): void;
  setOptions(options: DrawingEntityTextEditControllerOptions): void;
  startTextEditing(
    drawing: SavedTextDrawing,
    options?: StartDrawingEntityTextEditOptions,
  ): boolean;
  subscribe(listener: () => void): () => void;
}

export interface DrawingEntityTextEditRuntime extends DrawingEntityTextEditSnapshot {
  readonly editingTextIdRef: MutableRefObject<string | null>;
  readonly editInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly setEditingTextPos: Dispatch<SetStateAction<ScreenPoint | null>>;
  readonly setEditingTextValue: Dispatch<SetStateAction<string>>;
  cancelTextEditing(options?: DrawingEntityTextEditingOptions): boolean;
  commitTextEditing(options?: DrawingEntityTextEditingOptions): boolean;
  completeSurfaceDispose(): void;
  startTextEditing(
    drawing: SavedTextDrawing,
    options?: StartDrawingEntityTextEditOptions,
  ): boolean;
}

const EMPTY_SNAPSHOT: DrawingEntityTextEditSnapshot = Object.freeze({
  editingTextId: null,
  editingTextPos: null,
  editingTextValue: "",
});

const EMPTY_COMMANDS: readonly DrawingCommand[] = Object.freeze([]);

interface ActiveTextEdit {
  readonly drawing: SavedTextDrawing & {
    readonly dataPoint: DrawingDataPoint;
    readonly id: string;
  };
  readonly isNew: boolean;
}

function isFiniteScreenPoint(point: ScreenPoint | null): point is ScreenPoint {
  return point !== null
    && Number.isFinite(point.x)
    && Number.isFinite(point.y);
}

function editableTextDrawing(
  drawing: SavedTextDrawing | null | undefined,
): drawing is SavedTextDrawing & { dataPoint: DrawingDataPoint; id: string } {
  return drawing?.type === "text"
    && typeof drawing.id === "string"
    && drawing.id.length > 0
    && typeof drawing.dataPoint === "object"
    && drawing.dataPoint !== null;
}

function trailingTrim(value: string): string {
  return value.replace(/\s+$/g, "");
}

function invokeSafely(callback: () => void): void {
  try {
    callback();
  } catch {
    // Persistence already owns the canonical outcome. A toolbar/selection
    // notification must not turn a successful document commit into a retry.
  }
}

/**
 * Build the one terminal command batch for a text edit without constructing a
 * renderer object. `[]` is the intentional no-op for an empty, unpersisted
 * draft; `null` means the candidate failed canonical validation.
 */
export function drawingCommandsForEntityTextEdit(
  drawing: SavedTextDrawing,
  value: string,
  isNew: boolean,
): readonly DrawingCommand[] | null {
  if (!editableTextDrawing(drawing)) return null;
  const text = trailingTrim(value);
  if (!text) {
    return isNew
      ? EMPTY_COMMANDS
      : Object.freeze([Object.freeze({ type: "delete", id: drawing.id })]);
  }
  try {
    return drawingCommandsForSavedDrawing(
      { ...drawing, text },
      { type: isNew ? "create" : "update-style" },
    );
  } catch {
    return null;
  }
}

/**
 * Headless entity text editor. The React hook below is a thin subscription
 * adapter; keeping the transaction here makes failure/retry behavior directly
 * testable and keeps the scene path free of renderer primitives.
 */
export function createDrawingEntityTextEditController(
  initialOptions: DrawingEntityTextEditControllerOptions,
): DrawingEntityTextEditController {
  let options = initialOptions;
  let activeEdit: ActiveTextEdit | null = null;
  let commitPending = false;
  let pendingCommitDisposer: (() => void) | null = null;
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  const editingTextIdRef: MutableRefObject<string | null> = { current: null };

  const publish = (next: DrawingEntityTextEditSnapshot): void => {
    snapshot = Object.freeze({
      ...next,
      editingTextPos: next.editingTextPos
        ? Object.freeze({ ...next.editingTextPos })
        : null,
    });
    for (const listener of listeners) listener();
  };

  const clearState = (cancelPendingCommit = true): void => {
    if (cancelPendingCommit) pendingCommitDisposer?.();
    pendingCommitDisposer = null;
    commitPending = false;
    activeEdit = null;
    editingTextIdRef.current = null;
    publish(EMPTY_SNAPSHOT);
  };

  const exitTextTool = (shouldExit: boolean): void => {
    if (shouldExit
      && options.isContinuousDrawingEnabled?.() !== true
      && options.getActiveTool() === "text") {
      invokeSafely(() => options.onToolChange(null));
    }
  };

  const cancelTextEditing = (
    editOptions: DrawingEntityTextEditingOptions = {},
  ): boolean => {
    const { clearSelection = false, exitTool = true } = editOptions;
    const edit = activeEdit;
    if (!edit) return false;
    if (commitPending) return false;

    const selectedDraft = edit.isNew
      && options.getSelectedDrawingId() === edit.drawing.id;
    invokeSafely(() => options.setActiveSceneEntityId(null));
    clearState();
    if (clearSelection || selectedDraft) {
      invokeSafely(options.deselectAll);
      invokeSafely(() => options.refreshSelectedTextUi(null));
    } else {
      invokeSafely(() => options.refreshSelectedTextUi(edit.drawing.id));
    }
    exitTextTool(exitTool);
    return true;
  };

  const commitTextEditing = (
    editOptions: DrawingEntityTextEditingOptions = {},
  ): boolean => {
    const { clearSelection = false, exitTool = true } = editOptions;
    const edit = activeEdit;
    if (!edit) return false;
    if (commitPending) return true;
    try {
      if (!options.beforeTerminalMutation()) return false;
    } catch {
      return false;
    }

    const source = edit.isNew
      ? edit.drawing
      : options.getSavedDrawingById(edit.drawing.id);
    if (!source || source.type !== "text" || source.id !== edit.drawing.id) {
      return false;
    }

    const text = trailingTrim(snapshot.editingTextValue);
    const commands = drawingCommandsForEntityTextEdit(source, text, edit.isNew);
    if (!commands) return false;

    let receipt: DrawingEntityTextCommitReceipt | null = null;
    if (commands.length > 0) {
      // The static projector must include the committed entity before the
      // lifecycle captures its exact paint ticket. On failure the textarea
      // keeps ownership and the exclusion is restored for a safe retry.
      invokeSafely(() => options.setActiveSceneEntityId(null));
      try {
        const result = options.persistSceneCommands(commands);
        const resultIsReceipt = result !== null && typeof result === "object";
        const failed = result === false
          || result === null
          || (resultIsReceipt && result.committed !== true);
        if (failed) {
          invokeSafely(() => options.setActiveSceneEntityId(edit.drawing.id));
          return false;
        }
        if (resultIsReceipt) receipt = result;
      } catch {
        invokeSafely(() => options.setActiveSceneEntityId(edit.drawing.id));
        return false;
      }
    } else {
      invokeSafely(() => options.setActiveSceneEntityId(null));
    }

    const removed = text.length === 0;
    const complete = (): void => {
      if (activeEdit !== edit) return;
      clearState(false);
      if (clearSelection || removed) {
        invokeSafely(options.deselectAll);
        invokeSafely(() => options.refreshSelectedTextUi(null));
      } else {
        invokeSafely(() => options.selectDrawing(edit.drawing.id));
        invokeSafely(() => options.refreshSelectedTextUi(edit.drawing.id));
      }
      exitTextTool(exitTool);
    };
    if (!removed && receipt && options.deferCommittedScenePaint) {
      commitPending = true;
      let completedSynchronously = false;
      const completeOnce = (): void => {
        if (!commitPending || activeEdit !== edit) return;
        completedSynchronously = true;
        complete();
      };
      let disposer: (() => void) | null = null;
      try {
        disposer = options.deferCommittedScenePaint(receipt, completeOnce);
      } catch {
        // The document is already committed. If the presentation handoff
        // cannot subscribe, finish the editor state instead of trapping a
        // permanently pending textarea over canonical content.
        complete();
        return true;
      }
      if (!completedSynchronously && commitPending && activeEdit === edit && disposer) {
        pendingCommitDisposer = disposer;
        return true;
      }
      if (!completedSynchronously && commitPending && activeEdit === edit) complete();
    } else {
      complete();
    }
    return true;
  };

  const completeSurfaceDispose = (): void => {
    const edit = activeEdit;
    if (!edit) return;
    const selectedDraft = edit.isNew
      && options.getSelectedDrawingId() === edit.drawing.id;
    invokeSafely(() => options.setActiveSceneEntityId(null));
    clearState();
    if (selectedDraft) invokeSafely(options.deselectAll);
    invokeSafely(() => options.refreshSelectedTextUi(selectedDraft ? null : edit.drawing.id));
  };

  const startTextEditing = (
    drawing: SavedTextDrawing,
    startOptions: StartDrawingEntityTextEditOptions = {},
  ): boolean => {
    if (!editableTextDrawing(drawing)) return false;
    if (commitPending) return false;
    const isNew = startOptions.isNew === true;
    let projected = isFiniteScreenPoint(startOptions.screenPoint ?? null)
      ? startOptions.screenPoint ?? null
      : null;
    if (!projected) {
      try {
        projected = options.dataToScreen(drawing.dataPoint);
      } catch {
        projected = null;
      }
    }
    if (!isFiniteScreenPoint(projected) && !isNew) return false;

    if (activeEdit) invokeSafely(() => options.setActiveSceneEntityId(null));
    const retainedDrawing = Object.freeze({
      ...drawing,
      dataPoint: drawing.dataPoint
        ? Object.freeze({ ...drawing.dataPoint })
        : drawing.dataPoint,
    }) as SavedTextDrawing & {
      readonly dataPoint: DrawingDataPoint;
      readonly id: string;
    };
    activeEdit = Object.freeze({ drawing: retainedDrawing, isNew });
    editingTextIdRef.current = drawing.id;
    publish({
      editingTextId: drawing.id,
      editingTextPos: isFiniteScreenPoint(projected)
        ? { x: projected.x, y: projected.y }
        : null,
      editingTextValue: drawing.text === "Text" ? "" : drawing.text ?? "",
    });
    invokeSafely(() => options.setActiveSceneEntityId(drawing.id));
    invokeSafely(() => options.selectDrawing(drawing.id));
    return isFiniteScreenPoint(projected);
  };

  return Object.freeze({
    editingTextIdRef,
    cancelTextEditing,
    commitTextEditing,
    completeSurfaceDispose,
    getSnapshot: () => snapshot,
    setEditingTextPos(value: ScreenPoint | null): void {
      if (!activeEdit) return;
      publish({ ...snapshot, editingTextPos: value });
    },
    setEditingTextValue(value: string): void {
      if (!activeEdit || commitPending || value === snapshot.editingTextValue) return;
      publish({ ...snapshot, editingTextValue: value });
    },
    setOptions(nextOptions: DrawingEntityTextEditControllerOptions): void {
      options = nextOptions;
    },
    startTextEditing,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/** React adapter with the same overlay-facing state shape as the legacy hook. */
export function useDrawingEntityTextEdit(
  options: DrawingEntityTextEditControllerOptions,
): DrawingEntityTextEditRuntime {
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [controller] = useState(() => createDrawingEntityTextEditController(options));
  useLayoutEffect(() => {
    controller.setOptions(options);
  }, [controller, options]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const startTextEditing = useCallback((
    drawing: SavedTextDrawing,
    startOptions?: StartDrawingEntityTextEditOptions,
  ): boolean => {
    const started = controller.startTextEditing(drawing, startOptions);
    if (started) {
      setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 30);
    }
    return started;
  }, [controller]);

  const setEditingTextValue = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    const previous = controller.getSnapshot().editingTextValue;
    controller.setEditingTextValue(typeof next === "function" ? next(previous) : next);
  }, [controller]);

  const setEditingTextPos = useCallback<Dispatch<SetStateAction<ScreenPoint | null>>>((next) => {
    const previous = controller.getSnapshot().editingTextPos;
    controller.setEditingTextPos(typeof next === "function" ? next(previous) : next);
  }, [controller]);

  return {
    ...snapshot,
    editingTextIdRef: controller.editingTextIdRef,
    editInputRef,
    setEditingTextPos,
    setEditingTextValue,
    startTextEditing,
    cancelTextEditing: controller.cancelTextEditing,
    commitTextEditing: controller.commitTextEditing,
    completeSurfaceDispose: controller.completeSurfaceDispose,
  };
}

export default useDrawingEntityTextEdit;
