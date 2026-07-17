import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DRAWING_STORAGE_CHARS } from "../drawingPersistence.js";
import {
  drawingCommandsForTextEdit,
  restoreRejectedNewTextDraft,
} from "../drawingTextEditController.js";
import { TextDrawingPrimitive } from "../primitives/TextDrawingPrimitive.js";

test("over-budget existing text is rejected before mutating its renderer draft", () => {
  const primitive = new TextDrawingPrimitive({
    id: "existing-text",
    dataPoint: { time: 1, price: 2 },
    text: "original",
  });
  assert.equal(
    drawingCommandsForTextEdit(primitive, "x".repeat(MAX_DRAWING_STORAGE_CHARS + 1), false),
    null,
  );
  assert.equal(primitive.text, "original");
  assert.equal(primitive.isUnconfirmedText, false);
});

test("over-budget new text retains its cancellable unconfirmed credential", () => {
  const primitive = new TextDrawingPrimitive({
    id: "new-text",
    dataPoint: { time: 1, price: 2 },
    text: "",
  });
  primitive.markUnconfirmedText();
  assert.equal(
    drawingCommandsForTextEdit(primitive, "x".repeat(MAX_DRAWING_STORAGE_CHARS + 1), true),
    null,
  );
  assert.equal(primitive.text, "");
  assert.equal(primitive.isUnconfirmedText, true);
});

test("rejected new-text create restores an attached unconfirmed retry draft", () => {
  const primitive = new TextDrawingPrimitive({
    id: "new-text-retry",
    dataPoint: { time: 1, price: 2 },
    text: "candidate",
  });
  primitive.confirmText();
  const primitives: TextDrawingPrimitive[] = [];
  let attached = 0;

  assert.equal(restoreRejectedNewTextDraft({
    attachPrim(candidate) {
      attached += 1;
      assert.equal(candidate, primitive);
      assert.equal(primitive.text, "");
      assert.equal(primitive.isUnconfirmedText, true);
      return true;
    },
    originalIndex: 0,
    originalText: "",
    originalUnconfirmed: true,
    primitive,
    primitives,
  }), true);
  assert.equal(attached, 1);
  assert.deepEqual(primitives, [primitive]);
  assert.equal(primitive.isUnconfirmedText, true);
});

test("rejected new-text create reports failed reattach without an orphan registry id", () => {
  const primitive = new TextDrawingPrimitive({
    id: "new-text-close",
    dataPoint: { time: 1, price: 2 },
    text: "candidate",
  });
  primitive.confirmText();
  const primitives: TextDrawingPrimitive[] = [];

  assert.equal(restoreRejectedNewTextDraft({
    attachPrim: () => false,
    originalIndex: 0,
    originalText: "",
    originalUnconfirmed: true,
    primitive,
    primitives,
  }), false);
  assert.deepEqual(primitives, []);
  assert.equal(primitive.text, "");
  assert.equal(primitive.isUnconfirmedText, true);
});
