import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingCommand } from "../../core/drawingCommands.js";
import type {
  DrawingToolId,
  SavedDrawing,
  SavedTextDrawing,
} from "../../drawingTypes.js";
import {
  createDrawingEntityTextEditController,
  drawingCommandsForEntityTextEdit,
  type DrawingEntityTextEditControllerOptions,
} from "../useDrawingEntityTextEdit.js";

function savedText(overrides: Partial<SavedTextDrawing> = {}): SavedTextDrawing {
  return {
    type: "text",
    id: "text-1",
    dataPoint: { time: 100, price: 42 },
    text: "before",
    color: "#112233",
    fontSize: 14,
    ...overrides,
  };
}

interface Harness {
  readonly activeSceneIds: Array<string | null>;
  readonly deselections: string[];
  readonly persisted: Array<readonly DrawingCommand[]>;
  readonly refreshed: Array<string | null | undefined>;
  readonly selections: string[];
  readonly toolChanges: Array<DrawingToolId | null>;
  activeTool: DrawingToolId | null;
  beforeTerminalResult: boolean;
  persistResult: boolean;
  saved: SavedDrawing | null;
  selectedId: string | null;
}

function createHarness(
  overrides: Partial<DrawingEntityTextEditControllerOptions> = {},
): {
  harness: Harness;
  options: DrawingEntityTextEditControllerOptions;
} {
  const harness: Harness = {
    activeSceneIds: [],
    activeTool: "text",
    beforeTerminalResult: true,
    deselections: [],
    persisted: [],
    persistResult: true,
    refreshed: [],
    saved: savedText(),
    selectedId: null,
    selections: [],
    toolChanges: [],
  };
  const options: DrawingEntityTextEditControllerOptions = {
    beforeTerminalMutation: () => harness.beforeTerminalResult,
    dataToScreen: (point) => ({ x: Number(point.time) + 1, y: point.price + 2 }),
    deselectAll: () => {
      harness.selectedId = null;
      harness.deselections.push("all");
    },
    getActiveTool: () => harness.activeTool,
    getSavedDrawingById: (id) => harness.saved?.id === id ? harness.saved : null,
    getSelectedDrawingId: () => harness.selectedId,
    onToolChange: (tool) => {
      harness.activeTool = tool;
      harness.toolChanges.push(tool);
    },
    persistSceneCommands: (commands) => {
      harness.persisted.push(commands);
      return harness.persistResult;
    },
    refreshSelectedTextUi: (id) => harness.refreshed.push(id),
    selectDrawing: (id) => {
      harness.selectedId = id;
      harness.selections.push(id);
    },
    setActiveSceneEntityId: (id) => harness.activeSceneIds.push(id),
    ...overrides,
  };
  return { harness, options };
}

test("entity text command planner emits update/create/delete and a new-empty no-op", () => {
  const drawing = savedText();
  const update = drawingCommandsForEntityTextEdit(drawing, "changed  \n", false);
  assert.equal(update?.length, 1);
  assert.equal(update?.[0]?.type, "update-style");
  if (update?.[0]?.type === "update-style") {
    assert.equal(update[0].id, "text-1");
    assert.equal(update[0].patch.text, "changed");
  }

  const create = drawingCommandsForEntityTextEdit(drawing, "new", true);
  assert.equal(create?.length, 1);
  assert.equal(create?.[0]?.type, "create");
  if (create?.[0]?.type === "create") {
    assert.equal(create[0].entity.id, "text-1");
    assert.equal(create[0].entity.kind, "text");
    assert.equal(create[0].entity.style.kind === "text"
      ? create[0].entity.style.text
      : undefined, "new");
  }

  assert.deepEqual(drawingCommandsForEntityTextEdit(drawing, " \n", false), [
    { type: "delete", id: "text-1" },
  ]);
  assert.deepEqual(drawingCommandsForEntityTextEdit(drawing, " \n", true), []);
  assert.equal(drawingCommandsForEntityTextEdit({ type: "text" }, "x", false), null);
});

test("existing SavedTextDrawing starts at data coordinates and commits through update-style", () => {
  const { harness, options } = createHarness();
  const controller = createDrawingEntityTextEditController(options);
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  assert.equal(controller.startTextEditing(savedText()), true);
  assert.deepEqual(controller.getSnapshot(), {
    editingTextId: "text-1",
    editingTextPos: { x: 101, y: 44 },
    editingTextValue: "before",
  });
  assert.equal(controller.editingTextIdRef.current, "text-1");
  assert.deepEqual(harness.activeSceneIds, ["text-1"]);
  assert.deepEqual(harness.selections, ["text-1"]);

  controller.setEditingTextValue("after   ");
  assert.equal(controller.commitTextEditing(), true);
  assert.equal(harness.persisted.length, 1);
  assert.equal(harness.persisted[0]?.[0]?.type, "update-style");
  assert.deepEqual(harness.activeSceneIds, ["text-1", null]);
  assert.deepEqual(harness.selections, ["text-1", "text-1"]);
  assert.deepEqual(harness.refreshed, ["text-1"]);
  assert.deepEqual(harness.toolChanges, [null]);
  assert.strictEqual(controller.getSnapshot(), controller.getSnapshot());
  assert.deepEqual(controller.getSnapshot(), {
    editingTextId: null,
    editingTextPos: null,
    editingTextValue: "",
  });
  assert.equal(controller.editingTextIdRef.current, null);
  assert.equal(controller.commitTextEditing(), false);
  assert.equal(notifications, 3);
  unsubscribe();
});

test("continuous drawing keeps the text tool active after committing a new annotation", () => {
  const { harness, options } = createHarness({
    isContinuousDrawingEnabled: () => true,
  });
  const controller = createDrawingEntityTextEditController(options);
  assert.equal(controller.startTextEditing(savedText({ id: "new-text", text: "" }), {
    isNew: true,
  }), true);
  controller.setEditingTextValue("keep placing");

  assert.equal(controller.commitTextEditing(), true);
  assert.equal(harness.persisted.length, 1);
  assert.deepEqual(harness.toolChanges, []);
  assert.equal(harness.activeTool, "text");
});

test("persistence rejection retains the hidden, retryable editor state", () => {
  const { harness, options } = createHarness();
  const controller = createDrawingEntityTextEditController(options);
  assert.equal(controller.startTextEditing(savedText()), true);
  controller.setEditingTextValue("retry me");
  harness.persistResult = false;

  assert.equal(controller.commitTextEditing(), false);
  assert.deepEqual(controller.getSnapshot(), {
    editingTextId: "text-1",
    editingTextPos: { x: 101, y: 44 },
    editingTextValue: "retry me",
  });
  assert.equal(controller.editingTextIdRef.current, "text-1");
  assert.deepEqual(harness.activeSceneIds, ["text-1", null, "text-1"]);
  assert.deepEqual(harness.toolChanges, []);

  harness.persistResult = true;
  assert.equal(controller.commitTextEditing({ exitTool: false }), true);
  assert.equal(harness.persisted.length, 2);
  assert.deepEqual(harness.activeSceneIds, ["text-1", null, "text-1", null]);
  assert.deepEqual(harness.toolChanges, []);
});

test("empty existing text deletes while an empty new draft closes without persistence", () => {
  const existingHarness = createHarness();
  const existing = createDrawingEntityTextEditController(existingHarness.options);
  assert.equal(existing.startTextEditing(savedText()), true);
  existing.setEditingTextValue(" \n");
  assert.equal(existing.commitTextEditing({ exitTool: false }), true);
  assert.deepEqual(existingHarness.harness.persisted[0], [
    { type: "delete", id: "text-1" },
  ]);
  assert.deepEqual(existingHarness.harness.deselections, ["all"]);

  const newHarness = createHarness();
  const draft = createDrawingEntityTextEditController(newHarness.options);
  assert.equal(draft.startTextEditing(savedText({ id: "new-text", text: "" }), {
    isNew: true,
  }), true);
  assert.equal(draft.commitTextEditing({ exitTool: false }), true);
  assert.equal(newHarness.harness.persisted.length, 0);
  assert.deepEqual(newHarness.harness.deselections, ["all"]);
  assert.deepEqual(newHarness.harness.activeSceneIds, ["new-text", null]);
});

test("new off-screen drafts remain cancelable and disposal restores scene ownership", () => {
  const newHarness = createHarness({ dataToScreen: () => null });
  const draft = createDrawingEntityTextEditController(newHarness.options);
  assert.equal(draft.startTextEditing(savedText({ id: "new-text", text: "Text" }), {
    isNew: true,
  }), false);
  assert.deepEqual(draft.getSnapshot(), {
    editingTextId: "new-text",
    editingTextPos: null,
    editingTextValue: "",
  });
  assert.equal(draft.cancelTextEditing(), true);
  assert.deepEqual(newHarness.harness.activeSceneIds, ["new-text", null]);
  assert.deepEqual(newHarness.harness.deselections, ["all"]);
  assert.deepEqual(newHarness.harness.toolChanges, [null]);

  const existingHarness = createHarness();
  const existing = createDrawingEntityTextEditController(existingHarness.options);
  assert.equal(existing.startTextEditing(savedText()), true);
  existing.completeSurfaceDispose();
  assert.deepEqual(existingHarness.harness.activeSceneIds, ["text-1", null]);
  assert.deepEqual(existingHarness.harness.deselections, []);
  assert.deepEqual(existingHarness.harness.toolChanges, []);
  assert.deepEqual(existingHarness.harness.refreshed, ["text-1"]);
  assert.equal(existing.getSnapshot().editingTextId, null);
});

test("new text uses its exact pointer-space placement before first scene projection", () => {
  const { options } = createHarness({ dataToScreen: () => null });
  const controller = createDrawingEntityTextEditController(options);

  assert.equal(controller.startTextEditing(savedText({ id: "new-text", text: "" }), {
    isNew: true,
    screenPoint: { x: 240, y: 180 },
  }), true);
  assert.deepEqual(controller.getSnapshot(), {
    editingTextId: "new-text",
    editingTextPos: { x: 240, y: 180 },
    editingTextValue: "",
  });
});

test("terminal barrier failure and missing canonical source preserve the active edit", () => {
  const { harness, options } = createHarness();
  const controller = createDrawingEntityTextEditController(options);
  assert.equal(controller.startTextEditing(savedText()), true);
  controller.setEditingTextValue("pending");

  harness.beforeTerminalResult = false;
  assert.equal(controller.commitTextEditing(), false);
  assert.equal(harness.persisted.length, 0);
  assert.equal(controller.getSnapshot().editingTextValue, "pending");

  harness.beforeTerminalResult = true;
  harness.saved = null;
  assert.equal(controller.commitTextEditing(), false);
  assert.equal(harness.persisted.length, 0);
  assert.equal(controller.getSnapshot().editingTextId, "text-1");
  assert.deepEqual(harness.activeSceneIds, ["text-1"]);
});

test("committed text keeps textarea ownership until the exact scene paint handoff", () => {
  let finishPaint: (() => void) | null = null;
  let disposed = 0;
  const { harness, options } = createHarness({
    persistSceneCommands: (commands) => {
      harness.persisted.push(commands);
      return {
        committed: true,
        changed: true,
        ticket: {
          scopeKey: "BTCUSDT",
          documentRevision: 2,
          surfaceGeneration: 3,
          viewportRevision: 4,
        },
      };
    },
    deferCommittedScenePaint: (_receipt, complete) => {
      finishPaint = complete;
      return () => { disposed += 1; };
    },
  });
  const controller = createDrawingEntityTextEditController(options);
  assert.equal(controller.startTextEditing(savedText()), true);
  controller.setEditingTextValue("after paint");

  assert.equal(controller.commitTextEditing(), true);
  assert.equal(controller.getSnapshot().editingTextId, "text-1");
  assert.equal(controller.getSnapshot().editingTextValue, "after paint");
  assert.deepEqual(harness.activeSceneIds, ["text-1", null]);
  assert.deepEqual(harness.refreshed, []);
  assert.deepEqual(harness.toolChanges, []);
  controller.setEditingTextValue("must be ignored");
  assert.equal(controller.getSnapshot().editingTextValue, "after paint");
  assert.equal(controller.commitTextEditing(), true, "a repeated blur observes the pending commit");

  assert.ok(finishPaint);
  (finishPaint as () => void)();
  assert.equal(controller.getSnapshot().editingTextId, null);
  assert.deepEqual(harness.refreshed, ["text-1"]);
  assert.deepEqual(harness.toolChanges, [null]);
  assert.equal(disposed, 0, "the acknowledged handoff already owns its cleanup");
});
