import assert from "node:assert/strict";
import test from "node:test";
import {
  subscribeSharedDrawingDocumentEvent,
} from "../sharedDrawingDocumentEventHub.js";

test("drawing panes share one native document listener per event type", () => {
  let nativeListener: EventListener | null = null;
  let added = 0;
  let removed = 0;
  const documentRef = {
    addEventListener(type: string, listener: EventListener, capture: boolean) {
      assert.equal(type, "pointermove");
      assert.equal(capture, true);
      added += 1;
      nativeListener = listener;
    },
    removeEventListener(type: string, listener: EventListener, capture: boolean) {
      assert.equal(type, "pointermove");
      assert.equal(capture, true);
      assert.strictEqual(listener, nativeListener);
      removed += 1;
      nativeListener = null;
    },
  } as unknown as Document;
  const deliveries: string[] = [];
  const unsubscribeA = subscribeSharedDrawingDocumentEvent(
    documentRef,
    "pointermove",
    () => deliveries.push("a"),
  );
  const unsubscribeB = subscribeSharedDrawingDocumentEvent(
    documentRef,
    "pointermove",
    () => deliveries.push("b"),
  );

  assert.equal(added, 1);
  assert.ok(nativeListener);
  (nativeListener as EventListener)(new Event("pointermove"));
  assert.deepEqual(deliveries, ["a", "b"]);

  unsubscribeA();
  assert.equal(removed, 0);
  (nativeListener as EventListener)(new Event("pointermove"));
  assert.deepEqual(deliveries, ["a", "b", "b"]);

  unsubscribeB();
  unsubscribeB();
  assert.equal(removed, 1);
  assert.equal(nativeListener, null);
});
